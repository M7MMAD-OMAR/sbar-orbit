import { OrbitError } from "../errors";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

export type DesktopEntry = Record<string, string>;

// Desktop Entry string decoding precedes the separate Exec quoting rules.
function desktopString(value: string): string {
  const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") { result += character; continue; }
    const next = value[++index];
    const decoded = next === undefined ? undefined : escapes[next];
    if (decoded === undefined) refuse("Unsupported desktop string escape");
    result += decoded;
  }
  return result;
}

// A deliberately bounded Desktop Entry grammar. No shell is evaluated.
export function parseDesktopExec(value: string): string[] {
  const result: string[] = []; let current = "", quoted = false, started = false, closedQuote = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === undefined) break;
    if (closedQuote && char !== " ") refuse("Unsupported desktop Exec quote concatenation");
    if (char === '"') {
      if (!quoted && started) refuse("Unsupported desktop Exec quote concatenation");
      if (quoted && current.includes("%")) refuse("Desktop field codes inside quoted arguments are undefined");
      closedQuote = quoted; quoted = !quoted; started = true; continue;
    }
    if (char === "\\") {
      if (!quoted) refuse("Unquoted desktop Exec escape is unsupported");
      const next = value[++i];
      if (next === undefined || !['"', "\\", "$", "`"].includes(next)) refuse("Unsupported desktop Exec escape");
      current += next; started = true; continue;
    }
    if (/[\r\n\0]/.test(char) || (!quoted && char === "\t") || /[$`;|&<>']/.test(char)) refuse("Unsupported desktop Exec expression");
    if (!quoted && /[~*?#()]/.test(char)) refuse("Unquoted desktop Exec reserved character");
    if (!quoted && char === " ") { if (started) result.push(current); current = ""; started = false; closedQuote = false; }
    else { current += char; started = true; }
  }
  if (quoted) refuse("Unterminated desktop Exec quote");
  if (started) result.push(current);
  return result;
}

export function parseDesktopEntry(content: string): DesktopEntry {
  const fields: Record<string, string> = {}; let inside = false;
  for (const line of content.split(/\r?\n/)) {
    const value = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (value.startsWith("[")) { if (inside) break; inside = value === "[Desktop Entry]"; continue; }
    if (!inside || !value || value.startsWith("#")) continue;
    const separator = value.indexOf("="); if (separator < 1) continue;
    const key = value.slice(0, separator);
    if (key in fields) refuse("Application registration contains duplicate keys");
    const raw = value.slice(separator + 1);
    fields[key] = ["Exec", "Name", "Icon", "Path", "TryExec"].includes(key) ? desktopString(raw) : raw;
  }
  return fields;
}

export function expandDesktopArguments(args: string[], fields: DesktopEntry, applicationId: string, registration: string): string[] {
  const argv: string[] = [];
  for (const arg of args) {
    if (/^%[fFuU]$/.test(arg)) continue;
    if (arg === "%c") { argv.push(fields.Name ?? applicationId); continue; }
    if (arg === "%k") { argv.push(registration); continue; }
    if (arg === "%i") { if (fields.Icon) argv.push("--icon", fields.Icon); continue; }
    if (/%(?!%)/.test(arg.replaceAll("%%", ""))) refuse("Unsupported desktop Exec field code");
    argv.push(arg.replaceAll("%%", "%"));
  }
  return argv;
}

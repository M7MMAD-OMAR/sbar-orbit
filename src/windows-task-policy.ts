/** Strict semantic task policy. Live qualification is private, local and bound to the queried definition. */
import { boundedCommand } from "./lifecycle-command";
type Node = { name: string; attributes: Record<string, string>; text: string; children: Node[] };
const defaults: Record<string, string> = { AllowHardTerminate: "true", AllowStartOnDemand: "true", Enabled: "true", StartWhenAvailable: "false", RunOnlyIfNetworkAvailable: "false" };
const xsdDefaults: Record<string, string> = { ...defaults, Hidden: "false", RunOnlyIfIdle: "false", WakeToRun: "false", Priority: "7" };
type Live = { xml: string; sid: string; taskName: string; references: string[]; runLevel: number; settings: Record<string, boolean> };
const capabilities = new WeakMap<object, Live>();
function deny(): never { throw new Error("Task definition is not qualified"); }
function scalar(point: number) { return point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff; }
function decode(text: string) {
  let output = "", cursor = 0;
  for (const match of text.matchAll(/&([^;]+);/g)) {
    const start = match.index!; if (text.slice(cursor, start).includes("&")) deny(); output += text.slice(cursor, start);
    const token = match[1]!, named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, token)) output += named[token];
    else if (/^#(?:[0-9]+|x[0-9A-Fa-f]+)$/.test(token)) { const point = token[1] === "x" ? parseInt(token.slice(2), 16) : Number(token.slice(1)); if (!scalar(point)) deny(); output += String.fromCodePoint(point); }
    else deny(); cursor = start + match[0].length;
  }
  if (text.slice(cursor).includes("&")) deny(); return output + text.slice(cursor);
}
function parse(input: string): Node {
  if (!input || input.length > 131072 || [...input].some(character => !scalar(character.codePointAt(0)!))) deny();
  let text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  text = text.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'](?:UTF-8|UTF-16)["'])?\s*\?>\s*/i, "");
  const stack: Node[] = []; let root: Node | undefined, consumed = 0, count = 0;
  for (const token of text.matchAll(/<[^<>]*>|[^<]+/g)) {
    if (token.index !== consumed) deny(); const raw = token[0]; consumed += raw.length;
    if (!raw.startsWith("<")) { const value = decode(raw); if (!stack.length) { if (value.trim()) deny(); } else stack.at(-1)!.text += value; continue; }
    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(raw);
    if (closing) { if (stack.pop()?.name !== closing[1]) deny(); continue; }
    const open = /^<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_][A-Za-z0-9_-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>$/.exec(raw);
    if (!open || ++count > 2048 || stack.length > 32) deny();
    const attributes: Record<string, string> = Object.create(null);
    for (const item of open[2]!.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) { const key = item[1]!; if (Object.hasOwn(attributes, key)) deny(); attributes[key] = decode(item[2] ?? item[3] ?? ""); }
    const node: Node = { name: open[1]!, attributes, text: "", children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else { if (root) deny(); root = node; }
    if (open[3] !== "/") stack.push(node);
  }
  if (consumed !== text.length || stack.length || !root || root.name !== "Task" || root.attributes.version !== "1.4" || root.attributes.xmlns !== "http://schemas.microsoft.com/windows/2004/02/mit/task" || Object.keys(root.attributes).length !== 2) deny();
  return root;
}
function children(node: Node, name: string) { return node.children.filter(child => child.name === name); }
function one(node: Node, name: string) { const result = children(node, name); if (result.length !== 1) deny(); return result[0]!; }
function leaf(name: string, text: string): Node { return { name, text, attributes: {}, children: [] }; }
function canonical(node: Node, sid: string, live?: Live, path = ""): unknown {
  const current = path ? path + "/" + node.name : node.name;
  if (node.children.length && node.text.trim()) deny();
  if (node.name === "UserId") {
    if (!["Task/Principals/Principal/UserId", "Task/Triggers/LogonTrigger/UserId"].includes(current) || node.children.length || Object.keys(node.attributes).length) deny();
    if (node.text !== sid) { if (!live || !live.references.includes(node.text)) deny(); node.text = sid; }
  }
  if (current === "Task/Principals/Principal") {
    const levels = children(node, "RunLevel"); if (levels.length > 1) deny();
    if (!levels.length) { if (!live || live.runLevel !== 0) deny(); node.children.push(leaf("RunLevel", "LeastPrivilege")); }
  }
  if (current === "Task/Settings") {
    for (const [name, value] of Object.entries(xsdDefaults)) {
      const existing = children(node, name); if (existing.length > 1) deny();
      if (!existing.length) { if (!live || Object.hasOwn(defaults, name) && live.settings[name] !== (value === "true")) deny(); node.children.push(leaf(name, value)); }
    }
  }
  if (current === "Task/RegistrationInfo") {
    const uris = children(node, "URI"); if (uris.length > 1) deny();
    if (uris.length) { const uri = uris[0]!; if (!live || uri.children.length || Object.keys(uri.attributes).length || uri.text !== "\\" + live.taskName) deny(); node.children = node.children.filter(child => child !== uri); }
  }
  const names = new Set<string>(); for (const child of node.children) { if (names.has(child.name)) deny(); names.add(child.name); }
  // Only the explicit template permits repeated trigger types; current templates use unique trigger names.
  return { name: node.name, attributes: Object.entries(node.attributes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), text: node.children.length ? "" : node.text,
    children: node.children.map(child => canonical(child, sid, live, current)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
function key(xml: string, sid: string, live?: Live) { const root = parse(xml); one(one(root, "Principals"), "Principal"); one(one(root, "Actions"), "Exec"); one(root, "Triggers"); one(root, "Settings"); return JSON.stringify(canonical(root, sid, live)); }
export function taskPolicyMatches(actual: string, expected: string, sid: string): boolean {
  try { return key(actual, sid) === key(expected, sid); } catch { return false; }
}
async function acquire(sid: string, taskName: string): Promise<object | null> {
  if (!/^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(sid) || !["SbarOrbitBroker-" + sid, "SbarOrbitBroker-" + sid + "-Update"].includes(taskName)) return null;
  const code = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$sid='" + sid + "';if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $sid){throw 'identity'};$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder([string][char]92).GetTask('" + taskName + "');$d=$t.Definition;[xml]$x=$t.Xml;$refs=@($x.SelectNodes('//*[local-name()=\"UserId\"]')|ForEach-Object{$_.InnerText});if($refs.Count -ne 2){throw 'refs'};foreach($v in $refs){try{$r=(New-Object Security.Principal.SecurityIdentifier($v)).Value}catch{$r=(New-Object Security.Principal.NTAccount($v)).Translate([Security.Principal.SecurityIdentifier]).Value};if($r -cne $sid){throw 'reference'}};$level=$d.Principal.RunLevel;if($null -eq $level -or $level -isnot [int] -or $level -ne 0){throw 'level'};$m=@{};foreach($pair in @(@('AllowHardTerminate','AllowHardTerminate'),@('AllowStartOnDemand','AllowDemandStart'),@('Enabled','Enabled'),@('StartWhenAvailable','StartWhenAvailable'),@('RunOnlyIfNetworkAvailable','RunOnlyIfNetworkAvailable'))){$v=$d.Settings.($pair[1]);if($null -eq $v -or $v -isnot [bool]){throw 'setting'};$m[$pair[0]]=$v};[pscustomobject]@{schema=1;xml=[string]$t.Xml;references=$refs;runLevel=$level;settings=$m}|ConvertTo-Json -Compress -Depth 5}catch{exit 1}";
  const result = await boundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], 10000);
  if (!result.ok || result.output.length > 262144) return null;
  try {
    const data: unknown = JSON.parse(result.output); if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>; if (Object.keys(d).sort().join() !== "references,runLevel,schema,settings,xml" || d.schema !== 1 || typeof d.xml !== "string" || d.runLevel !== 0 || !Array.isArray(d.references) || d.references.length !== 2 || !d.references.every(v => typeof v === "string" && v.length > 0 && v.length <= 1024) || !d.settings || typeof d.settings !== "object" || Array.isArray(d.settings)) return null;
    const values = d.settings as Record<string, unknown>; if (Object.keys(values).sort().join() !== Object.keys(defaults).sort().join() || !Object.values(values).every(v => typeof v === "boolean")) return null;
    const settings: Record<string, boolean> = {}; for (const name of Object.keys(defaults)) settings[name] = values[name] === true;
    const live: Live = { xml: d.xml, sid, taskName, references: d.references, runLevel: 0, settings }; key(live.xml, sid, live);
    const capability = Object.freeze({}); capabilities.set(capability, live); return capability;
  } catch { return null; }
}
/** Fresh built-in OS read only. No caller-provided runner, alias boolean or serialized capability. */
export async function qualifiedTaskPolicyMatches(actual: string, expected: string, sid: string, taskName: string): Promise<boolean> {
  if (taskPolicyMatches(actual, expected, sid)) return true;
  const capability = await acquire(sid, taskName), live = capability && capabilities.get(capability); if (!live) return false;
  try {
    const requested = one(parse(expected), "Settings");
    for (const name of Object.keys(defaults)) { const value = one(requested, name).text; if (!["true", "false"].includes(value) || live.settings[name] !== (value === "true")) return false; }
    return key(actual, sid, live) === key(live.xml, sid, live) && key(actual, sid, live) === key(expected, sid, live);
  } catch { return false; }
}

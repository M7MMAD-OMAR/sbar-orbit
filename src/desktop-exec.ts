/** Tokenize registered desktop Exec metadata without starting an application. */
export function parseExec(line: string): string[] {
  const parts: string[] = [];
  let current = "", quote = "", started = false;
  for (let index = 0; index < line.length; index++) {
    const character = line.charAt(index);
    if (quote) {
      if (character === "\\" && index + 1 < line.length) { current += line[++index]; continue; }
      if (character === quote) { quote = ""; continue; }
      current += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === " ") { if (started) parts.push(current); current = ""; started = false; }
    else { current += character; started = true; }
  }
  if (started) parts.push(current);
  return parts.filter(part => !/^%[fFuUdDnNickvm]$/.test(part) && part !== "@@" && part !== "@@u" && part !== "@@U");
}

/** Inspect index blobs, not the working tree, so the exact staged publication is checked. */
const git = async (...args: string[]) => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const data = await new Response(child.stdout).arrayBuffer();
  if (await child.exited) throw new Error("Cannot inspect the Git index");
  return Buffer.from(data);
};
const files = (await git("ls-files", "--cached", "-z")).toString().split("\0").filter(Boolean);
if (!files.length) throw new Error("Stage the intended public files before auditing");
const findings: { file: string; rule: string }[] = [];
for (const file of files) {
  if (/(^|\/)(output|node_modules|\.private|\.runtime|\.secrets|__pycache__)(\/|$)|^docs\/(evidence|superpowers)\/|(^|\/)\.env(?:\.|$)|\.(?:pem|key|log|pyc|tar\.gz)$/.test(file) && !file.endsWith(".env.example"))
    findings.push({ file, rule: "private-or-generated-path" });
  const bytes = await git("show", `:${file}`);
  if (bytes.includes(0)) { findings.push({ file, rule: "binary-needs-explicit-publication-review" }); continue; }
  const content = bytes.toString("utf8");
  const rules: [string, RegExp][] = [
    ["personal-home-path", /\/(?:home|Users)\/[a-zA-Z0-9._-]+\//],
    ["windows-user-path", /[A-Z]:\\Users\\[^\\\s]+\\/i],
    ["private-task-link", /thread:\/\/|\?hostId=[l]ocal/],
    ["private-network-address", /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
    ["private-key-material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ];
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push({ file, rule });
  for (const email of content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []) {
    if (!/@(?:example\.(?:com|org|invalid)|users\.noreply\.github\.com)$/.test(email)) findings.push({ file, rule: "email-needs-publication-review" });
  }
}
console.log(JSON.stringify({ filesChecked: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;

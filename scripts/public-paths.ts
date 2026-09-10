/** Shared by index auditing and packaging. Examples never bypass private directories. */
export function isPublicSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return false;
  const privateDirectories = new Set([".git", "output", "node_modules", ".private", ".runtime", ".secrets", "__pycache__"]);
  if (parts.some(part => privateDirectories.has(part))) return false;
  if (/^docs\/(evidence|superpowers)(\/|$)/.test(value) || /\.(pem|key|log|pyc|tar\.gz)$/.test(value)) return false;
  return parts.every(part => !(part === ".env" || part.startsWith(".env.")) || part === ".env.example");
}

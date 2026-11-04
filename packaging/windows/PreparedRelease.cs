// Shared native pre-execution seal checker, compiled into GUI and stable launcher.
// Integrity within admitted per-user state is not independent publisher authentication.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;

namespace Orbit.Shared
{
    internal sealed class PreparedSeal
    {
        internal int Schema;
        internal string Version = "", ReleaseDigest = "", Runtime = "", RuntimeDigest = "";
    }
    internal static class PreparedRelease
    {
        private static readonly string[] Inputs = { "package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE" };
        internal static PreparedSeal Attest(string root, string directory, string version, Func<string, PreparedSeal> parse)
        {
            if (!Regex.IsMatch(version, @"^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$")) throw new Exception("Invalid prepared version");
            NoRedirect(root); NoRedirect(directory);
            var expected = Path.Combine(root, "versions", version);
            if (!String.Equals(expected, directory, StringComparison.OrdinalIgnoreCase)) throw new Exception("Version escaped admitted root");
            var pointerPath = Path.Combine(root, "current.txt");
            var pointer = ReadSmall(pointerPath, 32768);
            if (pointer.EndsWith("\r\n", StringComparison.Ordinal)) pointer = pointer.Substring(0, pointer.Length - 2);
            else if (pointer.EndsWith("\n", StringComparison.Ordinal)) pointer = pointer.Substring(0, pointer.Length - 1);
            if (!String.Equals(pointer, directory, StringComparison.OrdinalIgnoreCase)) throw new Exception("Prepared version is not current");
            var seal = parse(ReadSmall(Path.Combine(directory, "orbit-release-identity.json"), 65536));
            if (seal.Schema != 1 || seal.Version != version || !Regex.IsMatch(seal.ReleaseDigest, "^[a-f0-9]{64}$") ||
                !Regex.IsMatch(seal.RuntimeDigest, "^[a-f0-9]{64}$") ||
                !String.Equals(seal.Runtime, Path.Combine(directory, "runtime", "bun.exe"), StringComparison.OrdinalIgnoreCase))
                throw new Exception("Prepared runtime/source seal is invalid");
            NoRedirect(seal.Runtime);
            if (HashFile(seal.Runtime) != seal.RuntimeDigest) throw new Exception("Prepared runtime bytes changed");
            foreach (var required in new[] { "package.json", "bun.lock", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "src/cli.ts", "src/mcp.ts", "scripts/limited.ts" })
            { var path = Path.Combine(directory, required.Replace('/', Path.DirectorySeparatorChar)); NoRedirect(path); if (!File.Exists(path)) throw new Exception("Prepared source incomplete"); }
            if (SourceDigest(directory, false) != seal.ReleaseDigest) throw new Exception("Prepared source bytes changed");
            VerifyDependencies(directory);
            return seal;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation info);
        [StructLayout(LayoutKind.Sequential)] private struct FileInformation
        { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
        private static void SingleLink(FileStream file)
        { FileInformation info; if (!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(), out info) || info.Links != 1) throw new Exception("Dependency hard link refused"); }
        internal const string DependencyInventory = "desktop/windows-app/dependency-files.tsv";
        private static string DependencyPath(string path)
        {
            if (path.Length > 240 || !path.StartsWith("node_modules/", StringComparison.Ordinal) || path.Split('/').Length > 32 || path.Any(character => character < 32 || character > 126 || "<>:\"\\|?*".IndexOf(character) >= 0)) throw new Exception("Dependency path invalid");
            var parts = path.Split('/');
            for (var index = 0; index < parts.Length; index++)
            {
                var part = parts[index]; var npmScope = index > 0 && parts[index - 1] == "node_modules" && Regex.IsMatch(part, @"\A@[A-Za-z0-9][A-Za-z0-9_.-]*\z");
                if (part.Length == 0 || part == "." || part == ".." || (!npmScope && !Regex.IsMatch(part, @"\A[A-Za-z0-9_. -]+\z")) || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || Regex.IsMatch(part, @"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) throw new Exception("Dependency path invalid");
            }
            return path;
        }
        internal static void VerifyDependencies(string directory)
        {
            var inventory = Path.Combine(directory, DependencyInventory.Replace('/', Path.DirectorySeparatorChar)); NoRedirect(inventory);
            string text;
            using (var file = new FileStream(inventory, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                SingleLink(file);
                if (file.Length == 0 || file.Length > 2097152) throw new Exception("Dependency inventory byte bound exceeded");
                using (var reader = new StreamReader(file, new UTF8Encoding(false, true), false))
                {
                    var output = new StringBuilder(); var buffer = new char[4096]; int count;
                    while ((count = reader.Read(buffer, 0, buffer.Length)) != 0) { if (output.Length + count > 2097152) throw new Exception("Dependency inventory grew beyond bound"); output.Append(buffer, 0, count); }
                    text = output.ToString();
                }
            }
            if (!text.EndsWith("\n", StringComparison.Ordinal) || text.Any(character => character > 126 || (character < 32 && character != '\t' && character != '\n'))) throw new Exception("Dependency inventory is not canonical ASCII TSV");
            var lines = text.Substring(0, text.Length - 1).Split('\n'); if (lines.Length == 0 || lines.Length > 8192) throw new Exception("Dependency file count exceeded");
            var files = new Dictionary<string, string>(StringComparer.Ordinal); var folded = new HashSet<string>(StringComparer.OrdinalIgnoreCase); string previous = "";
            foreach (var line in lines)
            {
                var fields = line.Split('\t');
                if (fields.Length != 2 || !Regex.IsMatch(fields[0], @"\A[a-f0-9]{64}\z")) throw new Exception("Dependency row invalid");
                var path = DependencyPath(fields[1]);
                if ((previous.Length != 0 && StringComparer.Ordinal.Compare(previous, path) >= 0) || !folded.Add(path)) throw new Exception("Dependency ordering or case collision");
                files.Add(path, fields[0]); previous = path;
            }
            if (!files.ContainsKey("node_modules/@modelcontextprotocol/sdk/package.json")) throw new Exception("Required SDK dependency missing");
            var directories = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { "node_modules", "node_modules" } };
            foreach (var path in files.Keys)
            {
                var parent = path.Substring(0, path.LastIndexOf('/'));
                while (true)
                {
                    if (folded.Contains(parent) || (directories.ContainsKey(parent) && directories[parent] != parent)) throw new Exception("Dependency file/directory case collision");
                    if (!directories.ContainsKey(parent)) directories.Add(parent, parent);
                    if (parent == "node_modules") break; parent = parent.Substring(0, parent.LastIndexOf('/'));
                }
            }
            var seen = new HashSet<string>(StringComparer.Ordinal); long bytes = 0; var entries = 0;
            VisitDependencies(directory, "node_modules", files, directories, seen, ref bytes, ref entries);
            if (seen.Count != files.Count) throw new Exception("Dependency file missing");
        }
        private static void VisitDependencies(string root, string relative, Dictionary<string, string> files, Dictionary<string, string> directories, HashSet<string> seen, ref long bytes, ref int entries)
        {
            if (++entries > 20000 || relative.Length > 240 || relative.Split('/').Length > 32) throw new Exception("Dependency entry bound exceeded");
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)); NoRedirect(path);
            if (Directory.Exists(path))
            {
                if (!directories.ContainsKey(relative) || directories[relative] != relative) throw new Exception("Unknown or empty dependency directory");
                foreach (var child in Directory.GetFileSystemEntries(path).OrderBy(value => value, StringComparer.Ordinal)) VisitDependencies(root, relative + "/" + Name(child), files, directories, seen, ref bytes, ref entries);
            }
            else
            {
                if (!File.Exists(path) || !files.ContainsKey(relative) || !seen.Add(relative)) throw new Exception("Unknown dependency file");
                var size = new FileInfo(path).Length; bytes += size; if (size > 67108864 || bytes > 268435456 || HashFile(path, 67108864, true) != files[relative]) throw new Exception("Dependency bytes changed");
            }
        }
        internal static string SourceDigest(string directory, bool publicSource)
        {
            NoRedirect(directory); var entries = new List<string>(); long bytes = 0;
            var names = new HashSet<string>(Directory.GetFileSystemEntries(directory).Select(Name), StringComparer.Ordinal);
            foreach (var name in Inputs) if (names.Contains(name)) Visit(directory, name, entries, ref bytes, 0, publicSource);
            using (var hash = SHA256.Create()) return Hex(hash.ComputeHash(Encoding.UTF8.GetBytes("[" + String.Join(",", entries) + "]")));
        }
        private static void Visit(string root, string relative, List<string> entries, ref long bytes, int depth, bool publicSource)
        {
            if (publicSource && relative == "desktop/windows-app") return;
            if (depth > 64 || entries.Count > 20000) throw new Exception("Prepared source bound exceeded");
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            NoRedirect(path);
            if (Directory.Exists(path))
            {
                var names = Directory.GetFileSystemEntries(path).Select(Name).ToArray();
                Array.Sort(names, StringComparer.Ordinal);
                foreach (var name in names) Visit(root, relative + "/" + name, entries, ref bytes, depth + 1, publicSource);
            }
            else
            {
                var size = new FileInfo(path).Length;
                bytes += size;
                if (size > 256L * 1024 * 1024 || bytes > 1536L * 1024 * 1024) throw new Exception("Prepared byte bound exceeded");
                entries.Add("[" + Quote(relative) + "," + Quote(HashFile(path)) + "]");
            }
        }
        internal static void NoRedirect(string path)
        {
            if (!Path.IsPathRooted(path) || !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase)) throw new Exception("Noncanonical path");
            var current = Path.GetPathRoot(path) ?? "";
            if (current.Length == 0) throw new Exception("Missing path root");
            foreach (var part in path.Substring(current.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, part);
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new Exception("Redirected prepared path");
            }
        }
        internal static string ReadSmall(string path, int bound)
        {
            NoRedirect(path);
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (file.Length > bound) throw new Exception("Prepared metadata bound exceeded");
                using (var reader = new StreamReader(file, Encoding.UTF8, true))
                {
                    var output = new StringBuilder(); var buffer = new char[4096]; int count;
                    while ((count = reader.Read(buffer, 0, buffer.Length)) != 0)
                    { if (output.Length + count > bound) throw new Exception("Prepared metadata bound exceeded"); output.Append(buffer, 0, count); }
                    return output.ToString();
                }
            }
        }
        private static string Name(string path)
        { var name = Path.GetFileName(path); if (String.IsNullOrEmpty(name)) throw new Exception("Missing prepared name"); return name; }
        private static string HashFile(string path, long maximum = 256L * 1024 * 1024, bool singleLink = false)
        {
            using (var hash = SHA256.Create()) using (var input = File.OpenRead(path))
            {
                if (singleLink) SingleLink(input);
                if (input.Length > maximum) throw new Exception("Prepared file bound exceeded");
                var buffer = new byte[81920]; int count; long total = 0;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                {
                    total += count; if (total > maximum) throw new Exception("Prepared file grew beyond bound");
                    hash.TransformBlock(buffer, 0, count, buffer, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                return Hex(hash.Hash ?? new byte[0]);
            }
        }
        private static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
        private static string Quote(string value)
        {
            var result = new StringBuilder("\"");
            foreach (char character in value)
            {
                if (character == '"') result.Append("\\\"");
                else if (character == '\\') result.Append("\\\\");
                else if (character < 32) result.Append("\\u" + ((int)character).ToString("x4"));
                else result.Append(character);
            }
            result.Append('"'); return result.ToString();
        }
    }
}

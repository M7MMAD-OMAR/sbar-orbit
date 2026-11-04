// Shared native pre-execution seal checker, compiled into GUI and stable launcher.
// Integrity within admitted per-user state is not independent publisher authentication.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

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
            var entries = new List<string>(); long bytes = 0;
            var rootNames = new HashSet<string>(Directory.GetFileSystemEntries(directory).Select(Name), StringComparer.Ordinal);
            foreach (var name in Inputs) if (rootNames.Contains(name)) Visit(directory, name, entries, ref bytes, 0);
            var value = "[" + String.Join(",", entries) + "]";
            using (var hash = SHA256.Create())
                if (Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(value))) != seal.ReleaseDigest) throw new Exception("Prepared source bytes changed");
            return seal;
        }
        private static void Visit(string root, string relative, List<string> entries, ref long bytes, int depth)
        {
            if (depth > 64 || entries.Count > 20000) throw new Exception("Prepared source bound exceeded");
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            NoRedirect(path);
            if (Directory.Exists(path))
            {
                var names = Directory.GetFileSystemEntries(path).Select(Name).ToArray();
                Array.Sort(names, StringComparer.Ordinal);
                foreach (var name in names) Visit(root, relative + "/" + name, entries, ref bytes, depth + 1);
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
        private static string HashFile(string path)
        {
            using (var hash = SHA256.Create()) using (var input = File.OpenRead(path))
            {
                if (input.Length > 256L * 1024 * 1024) throw new Exception("Prepared file bound exceeded");
                var buffer = new byte[81920]; int count; long total = 0;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                {
                    total += count; if (total > 256L * 1024 * 1024) throw new Exception("Prepared file grew beyond bound");
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

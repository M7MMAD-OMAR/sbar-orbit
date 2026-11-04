// Shared protocol-2 descriptor policy. No normal launcher/GUI path performs acquisition.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
#if NETFRAMEWORK
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
#endif
namespace Orbit.Shared
{
    internal sealed class RuntimeDescriptor
    {
        internal string Version = "", Url = "", ArchiveSha256 = "", ExecutableSha256 = "", LicenseUrl = "", LicenseSha256 = "";
        internal long ArchiveBytes, ExecutableBytes;
        internal const string Entry = "bun-windows-x64/bun.exe", Executable = "runtime/bun.exe", Notice = "desktop/windows-app/notices/bun/LICENSE.md";
        internal static IDictionary<string, object> Object(object value)
        { var result = value as IDictionary<string, object>; if (result == null) throw new Exception("Expected strict runtime object"); return result; }
        internal static void Keys(IDictionary<string, object> value, string expected)
        { if (String.Join(",", value.Keys.OrderBy(key => key, StringComparer.Ordinal)) != expected) throw new Exception("Runtime fields differ"); }
        internal static string Text(IDictionary<string, object> value, string key)
        { object item; if (!value.TryGetValue(key, out item) || !(item is string)) throw new Exception("Runtime string missing"); return (string)item; }
        internal static long Integer(IDictionary<string, object> value, string key, long maximum)
        { object item; if (!value.TryGetValue(key, out item) || (!(item is int) && !(item is long))) throw new Exception("Runtime integer missing"); var number = Convert.ToInt64(item, CultureInfo.InvariantCulture); if (number <= 0 || number > maximum) throw new Exception("Runtime integer out of bounds"); return number; }
        internal static void Digest(string value) { if (!Regex.IsMatch(value, @"\A[a-f0-9]{64}\z")) throw new Exception("Runtime digest invalid"); }
        internal static RuntimeDescriptor Parse(object input)
        {
            var value = Object(input);
            Keys(value, "arch,archiveBytes,archiveEntry,archiveSha256,executableBytes,executablePath,executableSha256,kind,license,platform,url,version");
            var result = new RuntimeDescriptor { Version = Text(value, "version"), Url = Text(value, "url"), ArchiveSha256 = Text(value, "archiveSha256"),
                ExecutableSha256 = Text(value, "executableSha256"), ArchiveBytes = Integer(value, "archiveBytes", 134217728), ExecutableBytes = Integer(value, "executableBytes", 268435456) };
            if (!Regex.IsMatch(result.Version, @"\A[0-9]+[.][0-9]+[.][0-9]+\z") || Text(value, "kind") != "bun-official-zip" || Text(value, "platform") != "win32" || Text(value, "arch") != "x64" ||
                Text(value, "archiveEntry") != Entry || Text(value, "executablePath") != Executable || result.Url != "https://github.com/oven-sh/bun/releases/download/bun-v" + result.Version + "/bun-windows-x64.zip") throw new Exception("Runtime source is not the fixed official release");
            var license = Object(value["license"]); Keys(license, "sha256,url");
            result.LicenseUrl = Text(license, "url"); result.LicenseSha256 = Text(license, "sha256");
            if (result.LicenseUrl != "https://raw.githubusercontent.com/oven-sh/bun/bun-v" + result.Version + "/LICENSE.md") throw new Exception("Runtime license source differs");
            Digest(result.ArchiveSha256); Digest(result.ExecutableSha256); Digest(result.LicenseSha256); return result;
        }
        internal string Id()
        {
            var fields = new[] { "bun-official-zip", Version, "win32", "x64", Url, ArchiveSha256, ArchiveBytes.ToString(CultureInfo.InvariantCulture), Entry,
                Executable, ExecutableSha256, ExecutableBytes.ToString(CultureInfo.InvariantCulture), LicenseUrl, LicenseSha256 };
            using (var bytes = new MemoryStream())
            {
                foreach (var field in fields) { var encoded = Encoding.UTF8.GetBytes(field); var prefix = Encoding.ASCII.GetBytes(encoded.Length.ToString(CultureInfo.InvariantCulture) + ":"); bytes.Write(prefix, 0, prefix.Length); bytes.Write(encoded, 0, encoded.Length); }
                bytes.Position = 0; using (var digest = SHA256.Create()) return Hex(digest.ComputeHash(bytes));
            }
        }
        internal static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
        internal static string FileHash(string path, long maximum)
        {
            PreparedRelease.NoRedirect(path);
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var hash = SHA256.Create())
            {
                if (file.Length > maximum) throw new Exception("Runtime file bound exceeded"); var buffer = new byte[81920]; int count; long total = 0;
                while ((count = file.Read(buffer, 0, buffer.Length)) != 0) { total += count; if (total > maximum) throw new Exception("Runtime file grew beyond bound"); hash.TransformBlock(buffer, 0, count, buffer, 0); }
                hash.TransformFinalBlock(new byte[0], 0, 0); return Hex(hash.Hash ?? new byte[0]);
            }
        }
        internal Dictionary<string, object> Receipt(string orbitVersion, string acquisition)
        {
            return new Dictionary<string, object> { { "schema", 2 }, { "descriptorId", Id() }, { "orbitVersion", orbitVersion }, { "runtimeVersion", Version },
                { "executablePath", Executable }, { "executableSha256", ExecutableSha256 }, { "executableBytes", ExecutableBytes },
                { "archiveSha256", ArchiveSha256 }, { "archiveBytes", ArchiveBytes }, { "sourceUrl", Url }, { "archiveEntry", Entry },
                { "acquisition", acquisition }, { "cacheOriginVersion", null } };
        }
        internal void VerifyReceipt(object input, string orbitVersion)
        {
            var value = Object(input); Keys(value, "acquisition,archiveBytes,archiveEntry,archiveSha256,cacheOriginVersion,descriptorId,executableBytes,executablePath,executableSha256,orbitVersion,runtimeVersion,schema,sourceUrl");
            var acquisition = Text(value, "acquisition");
            if (Integer(value, "schema", 2) != 2 || Text(value, "descriptorId") != Id() || Text(value, "orbitVersion") != orbitVersion || Text(value, "runtimeVersion") != Version ||
                Text(value, "executablePath") != Executable || Text(value, "executableSha256") != ExecutableSha256 || Integer(value, "executableBytes", 268435456) != ExecutableBytes ||
                Text(value, "archiveSha256") != ArchiveSha256 || Integer(value, "archiveBytes", 134217728) != ArchiveBytes || Text(value, "sourceUrl") != Url || Text(value, "archiveEntry") != Entry ||
                !new[] { "upstream-download", "provided-archive", "verified-cache-copy" }.Contains(acquisition)) throw new Exception("Private runtime receipt differs");
            if (acquisition == "verified-cache-copy") { var version = Text(value, "cacheOriginVersion"); if (!Regex.IsMatch(version, @"\A[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9.-]+)?\z")) throw new Exception("Private cache origin invalid"); }
            else if (value["cacheOriginVersion"] != null) throw new Exception("Unexpected cache origin");
        }
    }
    internal static class DesktopPayload
    {
        internal static string Safe(string path)
        {
            if (String.IsNullOrEmpty(path) || path.Length > 240 || path.Contains("\\") || path.Contains(":")) throw new Exception("Desktop path invalid");
            var parts = path.Split('/');
            for (var index = 0; index < parts.Length; index++)
            {
                var part = parts[index]; var npmScope = index > 0 && parts[index - 1] == "node_modules" && Regex.IsMatch(part, @"\A@[A-Za-z0-9][A-Za-z0-9_.-]*\z");
                if (part.Length == 0 || part == "." || part == ".." || (!npmScope && !Regex.IsMatch(part, @"\A[A-Za-z0-9_. -]+\z")) || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || Regex.IsMatch(part, @"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) throw new Exception("Desktop path invalid");
            }
            return path;
        }
        internal static string[] Files(string root, string relative)
        {
            var output = new List<string>(); Walk(root, relative, output, 0); return output.ToArray();
        }
        private static void Walk(string root, string relative, List<string> output, int depth)
        {
            if (depth > 32 || output.Count >= 20000) throw new Exception("Desktop tree bound exceeded");
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)); PreparedRelease.NoRedirect(path);
            if (Directory.Exists(path)) foreach (var child in Directory.GetFileSystemEntries(path).OrderBy(item => item, StringComparer.Ordinal)) Walk(root, relative.Length == 0 ? Path.GetFileName(child) : relative + "/" + Path.GetFileName(child), output, depth + 1);
            else { if (!File.Exists(path)) throw new Exception("Desktop regular file missing"); output.Add(relative); }
        }
        internal static RuntimeDescriptor Verify(string directory, bool publicOnly, Func<string, IDictionary<string, object>> parse)
        {
            PreparedRelease.NoRedirect(directory);
            var roots = new HashSet<string>(new[] { "package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "skills", "experiments", "node_modules", "desktop-manifest.json", "SOURCE-COMMIT", "SOURCE-COMMIT.json", "orbit-source-manifest.json", "AGENTS.md", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md" }, StringComparer.Ordinal);
            if (!publicOnly) foreach (var name in new[] { "runtime", "runtime-source-receipt.json", "orbit-release-identity.json", "windows-release-files.json", "CI-FIXTURE.json", "maintenance-copy.json" }) roots.Add(name);
            if (Directory.GetFileSystemEntries(directory).Any(path => !roots.Contains(Path.GetFileName(path)))) throw new Exception("Unrecognized or private payload input");
            var manifest = parse(PreparedRelease.ReadSmall(Path.Combine(directory, "desktop-manifest.json"), 1048576));
            RuntimeDescriptor.Keys(manifest, "arch,bootstrapProtocol,files,platform,runtimeSource,schema,sourceDigest,sourceRevision,version");
            var version = RuntimeDescriptor.Text(manifest, "version"); var descriptor = RuntimeDescriptor.Parse(manifest["runtimeSource"]);
            var package = parse(PreparedRelease.ReadSmall(Path.Combine(directory, "package.json"), 1048576));
            if (RuntimeDescriptor.Integer(manifest, "schema", 2) != 2 || RuntimeDescriptor.Integer(manifest, "bootstrapProtocol", 2) != 2 || RuntimeDescriptor.Text(manifest, "platform") != "win32" || RuntimeDescriptor.Text(manifest, "arch") != "x64" ||
                RuntimeDescriptor.Text(package, "name") != "sbar-orbit" || RuntimeDescriptor.Text(package, "version") != version || !Regex.IsMatch(version, @"\A[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9.-]+)?\z") ||
                !Regex.IsMatch(RuntimeDescriptor.Text(manifest, "sourceRevision"), @"\A[a-f0-9]{40}\z")) throw new Exception("Desktop protocol or package identity differs");
            var sourceReceipt = Path.Combine(directory, "SOURCE-COMMIT.json");
            if (Directory.GetFileSystemEntries(directory).Any(path => String.Equals(Path.GetFileName(path), "SOURCE-COMMIT.json", StringComparison.OrdinalIgnoreCase)))
            {
                var receipt = parse(PreparedRelease.ReadSmall(sourceReceipt, 1048576));
                if (RuntimeDescriptor.Integer(receipt, "schema", 1) != 1 || RuntimeDescriptor.Text(receipt, "version") != version || RuntimeDescriptor.Text(receipt, "sourceCommit") != RuntimeDescriptor.Text(manifest, "sourceRevision"))
                    throw new Exception("Source publisher annotation and desktop revision differ");
            }
            var sourceDigest = RuntimeDescriptor.Text(manifest, "sourceDigest"); RuntimeDescriptor.Digest(sourceDigest);
            if (PreparedRelease.SourceDigest(directory, true) != sourceDigest) throw new Exception("Public source bytes differ");
            var entries = manifest["files"] as object[]; if (entries == null || entries.Length < 4 || entries.Length > 4096) throw new Exception("Desktop files invalid");
            var expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); long total = 0;
            foreach (var item in entries)
            {
                var file = RuntimeDescriptor.Object(item); RuntimeDescriptor.Keys(file, "path,sha256"); var path = Safe(RuntimeDescriptor.Text(file, "path")); var digest = RuntimeDescriptor.Text(file, "sha256"); RuntimeDescriptor.Digest(digest);
                if ((!path.StartsWith("desktop/windows-app/", StringComparison.Ordinal) && path != RuntimeDescriptor.Executable) || expected.ContainsKey(path)) throw new Exception("Desktop file collision"); expected.Add(path, digest);
                if (path == RuntimeDescriptor.Executable && publicOnly) continue;
                var full = Path.Combine(directory, path.Replace('/', Path.DirectorySeparatorChar)); var size = new FileInfo(full).Length; total += size;
                if (total > 805306368 || RuntimeDescriptor.FileHash(full, 268435456) != digest) throw new Exception("Desktop bytes differ");
            }
            foreach (var required in new[] { "desktop/windows-app/Orbit.Desktop.exe", "desktop/windows-app/Orbit.Launcher.exe", RuntimeDescriptor.Executable, RuntimeDescriptor.Notice, PreparedRelease.DependencyInventory }) if (!expected.ContainsKey(required)) throw new Exception("Desktop component missing");
            if (expected[RuntimeDescriptor.Executable] != descriptor.ExecutableSha256 || expected[RuntimeDescriptor.Notice] != descriptor.LicenseSha256) throw new Exception("Descriptor runtime/notice differs");
            PreparedRelease.VerifyDependencies(directory);
            var actual = Files(directory, "desktop/windows-app");
            var actualSet = new HashSet<string>(actual, StringComparer.OrdinalIgnoreCase);
            if (actualSet.Count != actual.Length || actualSet.Count != expected.Count - 1 || actual.Any(path => !expected.ContainsKey(path))) throw new Exception("Desktop file set differs");
            if (publicOnly)
            {
                if (Directory.GetFileSystemEntries(directory).Any(path => String.Equals(Path.GetFileName(path), "runtime", StringComparison.OrdinalIgnoreCase)) || File.Exists(Path.Combine(directory, "runtime-source-receipt.json"))) throw new Exception("Public package contains private runtime state");
                long publicBytes = 0; foreach (var path in Files(directory, "")) { var full = Path.Combine(directory, path); publicBytes += new FileInfo(full).Length; if (publicBytes > 1073741824) throw new Exception("Public payload byte bound exceeded"); var digest = RuntimeDescriptor.FileHash(full, 268435456); if (digest == descriptor.ExecutableSha256 || digest == descriptor.ArchiveSha256) throw new Exception("Public payload contains renamed Bun bytes"); }
            }
            else
            {
                if (!Files(directory, "runtime").SequenceEqual(new[] { RuntimeDescriptor.Executable })) throw new Exception("Private runtime file set differs");
                if (new FileInfo(Path.Combine(directory, RuntimeDescriptor.Executable.Replace('/', Path.DirectorySeparatorChar))).Length != descriptor.ExecutableBytes) throw new Exception("Private runtime size differs");
                descriptor.VerifyReceipt(parse(PreparedRelease.ReadSmall(Path.Combine(directory, "runtime-source-receipt.json"), 65536)), version);
            }
            return descriptor;
        }
    }
#if NETFRAMEWORK
    internal static class RuntimeBootstrap
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 32 };
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectory(string path, IntPtr attributes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref MemoryStatus value);
        [StructLayout(LayoutKind.Sequential)] private struct MemoryStatus { public uint Length, Load; public ulong TotalPhysical, AvailablePhysical, TotalPage, AvailablePage, TotalVirtual, AvailableVirtual, Extended; }
        private sealed class ZipMember { internal string Name = ""; internal long Offset, End, Compressed, Expanded; internal uint Crc; }
        internal static IDictionary<string, object> Parse(string text) { return RuntimeDescriptor.Object(Json.DeserializeObject(text)); }
        private static string Required(IDictionary<string, string> args, string name) { string value; if (!args.TryGetValue(name, out value) || String.IsNullOrEmpty(value)) throw new Exception("Missing bootstrap argument"); return value; }
        private static void Reserve(string path)
        {
            var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf(typeof(MemoryStatus)) };
            if (!GlobalMemoryStatusEx(ref memory) || memory.AvailablePhysical < 536870912 || memory.Load > 90) throw new Exception("Runtime acquisition memory reserve unavailable");
            var drive = new DriveInfo(Path.GetPathRoot(path)); if (drive.AvailableFreeSpace < 2147483648) throw new Exception("Runtime acquisition disk reserve unavailable");
        }
        private static int Remaining(Stopwatch deadline)
        { var left = 300000 - (int)deadline.ElapsedMilliseconds; if (left <= 0) throw new Exception("Runtime acquisition deadline exceeded"); return left; }
        private static string FreshStage()
        {
            var parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar); PreparedRelease.NoRedirect(parent); Reserve(parent);
            var stage = Path.Combine(parent, "orbit-runtime-" + Guid.NewGuid().ToString("N"));
            if (!CreateDirectory(stage, IntPtr.Zero)) throw new Exception("Exclusive private stage creation failed");
            var sid = WindowsIdentity.GetCurrent().User; if (sid == null) throw new Exception("Runtime staging owner unknown");
            var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(sid);
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(stage, acl); PreparedRelease.NoRedirect(stage); return stage;
        }
        private static void CopyPublic(string source, string target)
        {
            Directory.CreateDirectory(target); PreparedRelease.NoRedirect(target); long total = 0;
            foreach (var relative in DesktopPayload.Files(source, ""))
            {
                var input = Path.Combine(source, relative.Replace('/', Path.DirectorySeparatorChar)); var output = Path.Combine(target, relative.Replace('/', Path.DirectorySeparatorChar));
                total += new FileInfo(input).Length; if (total > 1073741824) throw new Exception("Offline source copy bound exceeded");
                Directory.CreateDirectory(Path.GetDirectoryName(output)); PreparedRelease.NoRedirect(Path.GetDirectoryName(output)); File.Copy(input, output, false);
            }
        }
        private static void CopyArchive(string source, string archive, RuntimeDescriptor descriptor, Stopwatch deadline)
        {
            PreparedRelease.NoRedirect(source);
            using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var hash = SHA256.Create())
            {
                if (input.Length != descriptor.ArchiveBytes) throw new Exception("Supplied archive length differs"); var buffer = new byte[81920]; long total = 0; int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0) { Remaining(deadline); total += count; if (total > descriptor.ArchiveBytes) throw new Exception("Supplied archive exceeded pin"); hash.TransformBlock(buffer, 0, count, buffer, 0); output.Write(buffer, 0, count); }
                hash.TransformFinalBlock(new byte[0], 0, 0); if (total != descriptor.ArchiveBytes || RuntimeDescriptor.Hex(hash.Hash) != descriptor.ArchiveSha256) throw new Exception("Supplied archive digest differs");
            }
        }
        private static void Download(RuntimeDescriptor descriptor, string archive, Stopwatch deadline)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var address = new Uri(descriptor.Url); var hosts = new HashSet<string>(new[] { "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com" }, StringComparer.OrdinalIgnoreCase);
            for (var redirects = 0; redirects < 4; redirects++)
            {
                if (address.Scheme != "https" || !address.IsDefaultPort || !String.IsNullOrEmpty(address.UserInfo) || !String.IsNullOrEmpty(address.Fragment) || !hosts.Contains(address.Host)) throw new Exception("Runtime redirect is not official HTTPS");
                var request = (HttpWebRequest)WebRequest.Create(address); request.AllowAutoRedirect = false; request.Timeout = Remaining(deadline); request.ReadWriteTimeout = Remaining(deadline); request.UserAgent = "sbar-orbit-runtime-bootstrap/2";
                using (var abort = new System.Threading.Timer(state => { try { request.Abort(); } catch (ObjectDisposedException) { } }, null, Remaining(deadline), System.Threading.Timeout.Infinite))
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    var code = (int)response.StatusCode;
                    if (new[] { 301, 302, 303, 307, 308 }.Contains(code)) { var location = response.Headers["Location"]; if (String.IsNullOrEmpty(location)) throw new Exception("Runtime redirect missing"); address = new Uri(address, location); continue; }
                    if (code != 200 || (response.ContentLength >= 0 && response.ContentLength != descriptor.ArchiveBytes)) throw new Exception("Runtime archive response size differs");
                    using (var input = response.GetResponseStream()) using (var output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var hash = SHA256.Create())
                    {
                        if (input == null) throw new Exception("Runtime archive stream missing"); var buffer = new byte[81920]; long total = 0; int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0) { Remaining(deadline); total += count; if (total > descriptor.ArchiveBytes) throw new Exception("Runtime download exceeded pin"); hash.TransformBlock(buffer, 0, count, buffer, 0); output.Write(buffer, 0, count); }
                        hash.TransformFinalBlock(new byte[0], 0, 0);
                        if (total != descriptor.ArchiveBytes || RuntimeDescriptor.Hex(hash.Hash) != descriptor.ArchiveSha256) throw new Exception("Official runtime archive digest differs");
                    }
                    return;
                }
            }
            throw new Exception("Runtime redirect bound exceeded");
        }
        private static byte[] Bytes(BinaryReader reader, int count)
        { var bytes = reader.ReadBytes(count); if (bytes.Length != count) throw new Exception("Runtime ZIP is truncated"); return bytes; }
        private static List<ZipMember> ZipIndex(FileStream stream)
        {
            if (stream.Length < 22) throw new Exception("Runtime ZIP is truncated");
            var tailSize = (int)Math.Min(stream.Length, 65557); stream.Position = stream.Length - tailSize;
            var tail = new byte[tailSize]; if (stream.Read(tail, 0, tail.Length) != tail.Length) throw new Exception("Runtime ZIP tail missing");
            var end = -1; for (var i = tail.Length - 22; i >= 0; i--) if (BitConverter.ToUInt32(tail, i) == 0x06054b50 && i + 22 + BitConverter.ToUInt16(tail, i + 20) == tail.Length) { end = i; break; }
            if (end < 0 || BitConverter.ToUInt16(tail, end + 4) != 0 || BitConverter.ToUInt16(tail, end + 6) != 0) throw new Exception("Runtime ZIP disks unsupported");
            var count = BitConverter.ToUInt16(tail, end + 10); var size = BitConverter.ToUInt32(tail, end + 12); var offset = BitConverter.ToUInt32(tail, end + 16);
            if (count == 0 || count > 32 || BitConverter.ToUInt16(tail, end + 8) != count || size > 1048576 || (long)offset + size != stream.Length - tail.Length + end) throw new Exception("Runtime ZIP central bounds differ");
            var records = new List<ZipMember>(); var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long expanded = 0;
            using (var reader = new BinaryReader(stream, Encoding.UTF8, true))
            {
                stream.Position = offset;
                for (var i = 0; i < count; i++)
                {
                    if (reader.ReadUInt32() != 0x02014b50) throw new Exception("Runtime ZIP central record invalid");
                    reader.ReadUInt16(); reader.ReadUInt16(); var flags = reader.ReadUInt16(); var method = reader.ReadUInt16(); reader.ReadUInt32();
                    var crc = reader.ReadUInt32(); var compressed = reader.ReadUInt32(); var unpacked = reader.ReadUInt32();
                    var nameSize = reader.ReadUInt16(); var extra = reader.ReadUInt16(); var comment = reader.ReadUInt16(); var disk = reader.ReadUInt16(); reader.ReadUInt16(); var attributes = reader.ReadUInt32(); var local = reader.ReadUInt32();
                    if (nameSize == 0 || nameSize > 240 || disk != 0 || (flags & ~0x080e) != 0 || (method != 0 && method != 8) || compressed > 134217728 || unpacked > 268435456 || (attributes & 1024) != 0) throw new Exception("Runtime ZIP entry unsupported");
                    var mode = (attributes >> 16) & 0xf000; if (mode != 0 && mode != 0x8000 && mode != 0x4000) throw new Exception("Runtime ZIP link refused");
                    var nameBytes = Bytes(reader, nameSize); if (nameBytes.Any(value => value < 32 || value > 126)) throw new Exception("Runtime ZIP names must be fixed ASCII");
                    var name = Encoding.ASCII.GetString(nameBytes); var normalized = name.EndsWith("/", StringComparison.Ordinal) ? name.Substring(0, name.Length - 1) : name; DesktopPayload.Safe(normalized); if (normalized.Split('/').Length > 8) throw new Exception("Runtime ZIP depth exceeded");
                    if (!name.StartsWith("bun-windows-x64/", StringComparison.Ordinal) || !names.Add(name) || (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && name != RuntimeDescriptor.Entry)) throw new Exception("Runtime ZIP member differs");
                    expanded += unpacked; if (expanded > 268435456 || (name.EndsWith("/", StringComparison.Ordinal) && (unpacked != 0 || compressed != 0))) throw new Exception("Runtime ZIP expanded bound exceeded");
                    stream.Position += extra + comment; var next = stream.Position; if (next > (long)offset + size) throw new Exception("Runtime ZIP metadata overlap");
                    stream.Position = local; if (reader.ReadUInt32() != 0x04034b50) throw new Exception("Runtime ZIP local header missing");
                    reader.ReadUInt16(); var localFlags = reader.ReadUInt16(); var localMethod = reader.ReadUInt16(); reader.ReadUInt32(); var localCrc = reader.ReadUInt32(); var localCompressed = reader.ReadUInt32(); var localSize = reader.ReadUInt32(); var localName = reader.ReadUInt16(); var localExtra = reader.ReadUInt16();
                    if (localFlags != flags || localMethod != method || localName != nameSize || !Bytes(reader, localName).SequenceEqual(nameBytes)) throw new Exception("Runtime ZIP header discrepancy");
                    var dataEnd = stream.Position + localExtra + compressed; if (dataEnd > offset) throw new Exception("Runtime ZIP data overlaps metadata"); stream.Position = dataEnd;
                    if ((flags & 8) != 0) { if ((localCrc != 0 && localCrc != crc) || (localCompressed != 0 && localCompressed != compressed) || (localSize != 0 && localSize != unpacked)) throw new Exception("Runtime ZIP local descriptor fields differ"); var value = reader.ReadUInt32(); if (value == 0x08074b50) value = reader.ReadUInt32(); if (value != crc || reader.ReadUInt32() != compressed || reader.ReadUInt32() != unpacked) throw new Exception("Runtime ZIP descriptor differs"); }
                    else if (localCrc != crc || localCompressed != compressed || localSize != unpacked) throw new Exception("Runtime ZIP local size differs");
                    if (stream.Position > offset) throw new Exception("Runtime ZIP member overlap");
                    records.Add(new ZipMember { Name = name, Offset = local, End = stream.Position, Compressed = compressed, Expanded = unpacked, Crc = crc }); stream.Position = next;
                }
                if (stream.Position != (long)offset + size) throw new Exception("Runtime ZIP central size differs");
            }
            var ordered = records.OrderBy(record => record.Offset).ToArray(); for (var i = 1; i < ordered.Length; i++) if (ordered[i].Offset < ordered[i - 1].End) throw new Exception("Runtime ZIP member overlap");
            if (records.Count(record => record.Name == RuntimeDescriptor.Entry) != 1) throw new Exception("Official executable member missing"); return records;
        }
        private static uint[] CrcTable()
        { var table = new uint[256]; for (uint i = 0; i < 256; i++) { var value = i; for (var j = 0; j < 8; j++) value = (value & 1) != 0 ? 0xedb88320 ^ (value >> 1) : value >> 1; table[i] = value; } return table; }
        private static void Extract(string archive, string target, RuntimeDescriptor descriptor, Stopwatch deadline)
        {
            if (new FileInfo(archive).Length != descriptor.ArchiveBytes || RuntimeDescriptor.FileHash(archive, 134217728) != descriptor.ArchiveSha256) throw new Exception("Runtime archive integrity differs");
            using (var file = new FileStream(archive, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var record = ZipIndex(file).Single(item => item.Name == RuntimeDescriptor.Entry); if (record.Expanded != descriptor.ExecutableBytes) throw new Exception("Runtime executable size differs");
                file.Position = 0; using (var zip = new ZipArchive(file, ZipArchiveMode.Read, true)) using (var input = zip.GetEntry(RuntimeDescriptor.Entry).Open())
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var hash = SHA256.Create())
                {
                    var buffer = new byte[81920]; var table = CrcTable(); uint crc = 0xffffffff; long total = 0; int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) != 0) { Remaining(deadline); total += count; if (total > descriptor.ExecutableBytes) throw new Exception("Runtime expanded size exceeded"); for (var i = 0; i < count; i++) crc = table[(crc ^ buffer[i]) & 255] ^ (crc >> 8); hash.TransformBlock(buffer, 0, count, buffer, 0); output.Write(buffer, 0, count); }
                    hash.TransformFinalBlock(new byte[0], 0, 0); if (total != descriptor.ExecutableBytes || (crc ^ 0xffffffff) != record.Crc || RuntimeDescriptor.Hex(hash.Hash) != descriptor.ExecutableSha256) throw new Exception("Runtime executable digest/CRC differs");
                }
            }
        }
        [STAThread] private static int Main(string[] argv)
        {
            string owned = null; HashSet<string> ownedFiles = null;
            try
            {
                if (argv.Length == 2 && argv[0] == "--conformance-dependencies") { PreparedRelease.VerifyDependencies(Path.GetFullPath(argv[1])); Console.Out.WriteLine("{\"ok\":true}"); return 0; }
                if (argv.Length == 2 && argv[0] == "--conformance") { var vector = Parse(PreparedRelease.ReadSmall(Path.GetFullPath(argv[1]), 65536)); var descriptor = RuntimeDescriptor.Parse(vector.ContainsKey("runtimeSource") ? vector["runtimeSource"] : vector); if (vector.ContainsKey("receipt")) { var receipt = RuntimeDescriptor.Object(vector["receipt"]); descriptor.VerifyReceipt(receipt, RuntimeDescriptor.Text(receipt, "orbitVersion")); } Console.Out.WriteLine(descriptor.Id()); return 0; }
                if (argv.Length < 3 || (argv[0] != "install" && argv[0] != "hydrate")) throw new Exception("Invalid bootstrap mode");
                var args = new Dictionary<string, string>(StringComparer.Ordinal); for (var i = 1; i < argv.Length; i += 2) { if (i + 1 >= argv.Length || args.ContainsKey(argv[i]) || !new[] { "--payload", "--root", "--automatic-updates", "--archive", "--download-consent", "--destination" }.Contains(argv[i])) throw new Exception("Invalid bootstrap options"); args.Add(argv[i], argv[i + 1]); }
                var source = Path.GetFullPath(Required(args, "--payload")); var descriptorSource = DesktopPayload.Verify(source, true, Parse);
                string provided; var supplied = args.TryGetValue("--archive", out provided); string consent;
                if (!supplied && (!args.TryGetValue("--download-consent", out consent) || consent != "accepted")) throw new Exception("Explicit upstream download consent or an exact official archive is required");
                owned = FreshStage(); var payload = Path.Combine(owned, "payload"); CopyPublic(source, payload); DesktopPayload.Verify(payload, true, Parse);
                ownedFiles = new HashSet<string>(DesktopPayload.Files(owned, ""), StringComparer.Ordinal); ownedFiles.Add("bun-official.zip"); ownedFiles.Add("payload/runtime/bun.exe"); ownedFiles.Add("payload/runtime-source-receipt.json");
                var archive = Path.Combine(owned, "bun-official.zip"); var deadline = Stopwatch.StartNew();
                if (supplied) CopyArchive(Path.GetFullPath(provided), archive, descriptorSource, deadline);
                else Download(descriptorSource, archive, deadline);
                Directory.CreateDirectory(Path.Combine(payload, "runtime")); Extract(archive, Path.Combine(payload, RuntimeDescriptor.Executable.Replace('/', Path.DirectorySeparatorChar)), descriptorSource, deadline);
                var package = Parse(PreparedRelease.ReadSmall(Path.Combine(payload, "package.json"), 1048576)); var version = RuntimeDescriptor.Text(package, "version");
                using (var output = new StreamWriter(new FileStream(Path.Combine(payload, "runtime-source-receipt.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None), new UTF8Encoding(false))) output.Write(Json.Serialize(descriptorSource.Receipt(version, supplied ? "provided-archive" : "upstream-download")));
                DesktopPayload.Verify(payload, false, Parse);
                if (argv[0] == "hydrate")
                {
                    var destination = Path.GetFullPath(Required(args, "--destination")); PreparedRelease.NoRedirect(Path.GetDirectoryName(destination));
                    if (!CreateDirectory(destination, IntPtr.Zero)) throw new Exception("Hydrated fixture destination exists");
                    var sid = WindowsIdentity.GetCurrent().User; if (sid == null) throw new Exception("Hydration owner missing");
                    var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(sid); acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow)); Directory.SetAccessControl(destination, acl);
                    CopyPublic(payload, destination); DesktopPayload.Verify(destination, false, Parse); Console.Out.WriteLine(Json.Serialize(new { ok = true, payload = destination })); return 0;
                }
                var root = Path.GetFullPath(Required(args, "--root")); var automatic = Required(args, "--automatic-updates"); if (automatic != "on" && automatic != "off") throw new Exception("Explicit update preference required");
                var runtime = Path.Combine(payload, RuntimeDescriptor.Executable.Replace('/', Path.DirectorySeparatorChar)); var entry = Path.Combine(payload, "src", "windows-managed-install.ts");
                var start = new ProcessStartInfo(runtime, Arguments(new[] { entry, "install", "--payload", payload, "--root", root, "--automatic-updates", automatic })) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = payload };
                start.EnvironmentVariables["ORBIT_BUN"] = runtime;
                using (var child = Process.Start(start))
                {
                    if (child == null) throw new Exception("Central bootstrap did not start");
                    try
                    {
                        var stdout = System.Threading.Tasks.Task.Run(() => ReadBounded(child.StandardOutput)); var stderr = System.Threading.Tasks.Task.Run(() => ReadBounded(child.StandardError));
                        if (!child.WaitForExit(120000)) throw new Exception("Central bootstrap deadline exceeded");
                        if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { stdout, stderr }, 3000) || child.ExitCode != 0 || !Parse(stdout.Result).ContainsKey("ok") || !Object.Equals(Parse(stdout.Result)["ok"], true)) throw new Exception("Central managed admission refused");
                    }
                    finally { if (!child.HasExited) global::OrbitLauncher.KillOwnedVerifierTree(child); }
                }
                Console.Out.WriteLine("{\"ok\":true}"); return 0;
            }
            catch (Exception) { Console.Error.WriteLine("Orbit runtime bootstrap refused or failed; no independent current/task changes were attempted. Inspect the fixed upstream pin, consent and resource prerequisites."); return 2; }
            finally { if (owned != null && ownedFiles != null) { try { PreparedRelease.NoRedirect(owned); if (DesktopPayload.Files(owned, "").Any(path => !ownedFiles.Contains(path))) throw new Exception("Unknown private stage input"); Directory.Delete(owned, true); } catch { /* Preserve a private stage with unconfirmed entries rather than delete foreign state. */ } } }
        }
        private static string ReadBounded(StreamReader input)
        { var output = new StringBuilder(); var buffer = new char[4096]; int count; while ((count = input.Read(buffer, 0, buffer.Length)) != 0) { if (output.Length + count > 65536) throw new Exception("Bootstrap output bound exceeded"); output.Append(buffer, 0, count); } return output.ToString(); }
        private static string Arguments(IEnumerable<string> values)
        { return String.Join(" ", values.Select(value => { var output = new StringBuilder("\""); var slashes = 0; foreach (var character in value) { if (character == '\\') { slashes++; continue; } if (character == '"') { output.Append('\\', slashes * 2 + 1); output.Append('"'); } else { output.Append('\\', slashes); output.Append(character); } slashes = 0; } output.Append('\\', slashes * 2); output.Append('"'); return output.ToString(); })); }
    }
#endif
}

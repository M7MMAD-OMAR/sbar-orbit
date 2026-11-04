// Thin stable launcher, compiled with the Windows .NET Framework compiler.
// No GUI/source payload is embedded here. Every invocation resolves the admitted current version.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Orbit.Shared;

internal static class OrbitLauncher
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0) args = new[] { "--launch-current", Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..")) };
        bool cli = args.Length >= 2 && args[0] == "--cli";
        bool maintenance = args.Length == 2 && args[0] == "--prepare-uninstall";
        try
        {
            if (args.Length < 2 || (!cli && !maintenance && (args[0] != "--launch-current" || args.Length != 2))) throw new Exception("Invalid launcher arguments");
            string root = Canonical(args[1]);
            NoRedirect(root);
            string pointerPath = Path.Combine(root, "current.txt"); NoRedirect(pointerPath);
            if (new FileInfo(pointerPath).Length > 32768) throw new Exception("Invalid managed pointer");
            string selected = PreparedRelease.ReadSmall(pointerPath, 32768).TrimEnd('\r', '\n');
            if (selected.IndexOfAny(new[] { '\r', '\n' }) >= 0 || Canonical(selected) != selected) throw new Exception("Invalid managed pointer");
            string versions = Path.Combine(root, "versions"); NoRedirect(versions);
            if (!String.Equals(Path.GetDirectoryName(selected), versions, StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(selected), @"^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$")) throw new Exception("Managed pointer is outside its versions directory");
            NoRedirect(selected);
            var seal = PreparedRelease.Attest(root, selected, Path.GetFileName(selected), ParseSeal);
            string runtime = seal.Runtime;
            string entry = Path.Combine(selected, "src", "windows-managed-install.ts");
            NoRedirect(Path.Combine(selected, "src")); NoRedirect(entry);
            bool brokerStartup = cli && args.Length == 4 && args[2] == "serve" && args[3] == "--managed-socket";
            var verified = Verify(runtime, entry, root, selected, "verify-current", brokerStartup);
            string desktop = Path.Combine(selected, "desktop", "windows-app", "Orbit.Desktop.exe");
            string cliPath = Path.Combine(selected, "src", "cli.ts");
            if (Text(verified, "version") != Path.GetFileName(selected) ||
                !String.Equals(Text(verified, "root"), root, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "directory"), selected, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "mcpPath"), Path.Combine(selected, "src", "mcp.ts"), StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "connectorPath"), Path.Combine(selected, "src", "connector-config.ts"), StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "runtime"), runtime, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "desktopPath"), desktop, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Text(verified, "cliPath"), cliPath, StringComparison.OrdinalIgnoreCase)) throw new Exception("Verified launch paths differ");
            if (!verified.ContainsKey("bootstrapProtocol") || Convert.ToInt32(verified["bootstrapProtocol"]) != 1) throw new Exception("Bootstrap protocol is incompatible");
            if (maintenance)
            {
                Console.Out.WriteLine(Json.Serialize(Verify(runtime, entry, root, selected, "prepare-uninstall")));
                return 0; // External maintenance starts only after this launcher releases its executable.
            }
            if (!cli)
            {
                Start(desktop, new string[0], selected, runtime, root, true).Dispose();
                return 0; // Updating a payload never calls this interactive entry automatically.
            }
            var forwarded = args.Skip(2).ToArray();
            string command = forwarded.Length == 0 ? "help" : forwarded[0];
            string[] rest = forwarded.Skip(1).ToArray();
            var argv = new List<string>();
            if (command == "mcp" || command == "connector-config") { argv.Add(Path.Combine(selected, "src", command + ".ts")); argv.AddRange(rest); }
            else if (command == "preflight") { argv.Add(Path.Combine(selected, "scripts", "preflight.ts")); argv.AddRange(rest); }
            else if (command == "status" && rest.Contains("--watch")) { argv.Add(Path.Combine(selected, "src", "status.ts")); argv.Add("--watch"); }
            else if (command == "serve" || command == "install")
            {
                argv.Add(Path.Combine(selected, "scripts", "limited.ts")); argv.Add(runtime); argv.Add("run");
                argv.Add(Path.Combine(selected, command == "install" ? "scripts" : "src", command == "install" ? "install.ts" : "cli.ts"));
                if (command == "serve") argv.Add("serve"); argv.AddRange(rest);
            }
            else if (command == "panel" || command == "settings" || command == "config")
            { Start(desktop, new string[0], selected, runtime, root, true).Dispose(); return 0; }
            else if (command == "desktop" || command == "native" || command == "service") throw new Exception("Native application control is unsupported on Windows");
            else { argv.Add(cliPath); argv.AddRange(forwarded.Length == 0 ? new[] { "help" } : forwarded); }
            using (var child = Start(runtime, argv, selected, runtime, root, false)) { child.WaitForExit(); return child.ExitCode; }
        }
        catch (Exception)
        {
            const string message = "Orbit could not verify the complete current installation. Open the installer or inspect managed update diagnostics. No alternate runtime or partial release was launched.";
            if (cli || maintenance) Console.Error.WriteLine(message); else MessageBox.Show(message, "Orbit", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }
    }

    private static IDictionary<string, object> Verify(string runtime, string entry, string root, string selected, string verb = "verify-current", bool brokerStartup = false)
    {
        var argv = new List<string> { entry, verb, "--root", root };
        if (brokerStartup && verb == "verify-current") { argv.Add("--broker-startup"); argv.Add("true"); }
        var start = new ProcessStartInfo(runtime, Arguments(argv)) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = selected
        };
        start.EnvironmentVariables["ORBIT_BUN"] = runtime;
        using (var child = Process.Start(start))
        {
            if (child == null) throw new Exception("Verifier did not start");
            try
            {
                var stdout = Task.Run(() => ReadBounded(child.StandardOutput, 65536));
                var stderr = Task.Run(() => ReadBounded(child.StandardError, 16384));
                if (!child.WaitForExit(30000)) throw new Exception("Verifier deadline exceeded");
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 3000) || child.ExitCode != 0) throw new Exception("Verifier failed");
                var answer = Object(stdout.Result);
                if (!answer.ContainsKey("ok") || !(answer["ok"] is bool) || !(bool)answer["ok"]) throw new Exception("Verifier refused");
                return answer;
            }
            finally { if (!child.HasExited) KillOwnedVerifierTree(child); }
        }
    }

    private static void KillOwnedVerifierTree(Process child)
    {
        var deadline = Stopwatch.StartNew();
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"),
            "/PID " + child.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) + " /T /F") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var killer = Process.Start(start))
        {
            if (killer == null) throw new Exception("Owned verifier cleanup did not start");
            var stdout = Task.Run(() => ReadBounded(killer.StandardOutput, 8192));
            var stderr = Task.Run(() => ReadBounded(killer.StandardError, 8192));
            if (!killer.WaitForExit(Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds)))
            { killer.Kill(); killer.WaitForExit(1); throw new Exception("Owned verifier cleanup deadline exceeded"); }
            if (!child.WaitForExit(Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds)) || killer.ExitCode != 0)
                throw new Exception("Owned verifier tree cleanup was not confirmed");
            if (!Task.WaitAll(new Task[] { stdout, stderr }, Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds)))
                throw new Exception("Owned verifier cleanup streams did not finish");
        }
    }
    private static Process Start(string path, IEnumerable<string> args, string directory, string runtime, string root, bool hidden)
    {
        var start = new ProcessStartInfo(path, Arguments(args)) { UseShellExecute = false, CreateNoWindow = hidden, WorkingDirectory = directory };
        start.EnvironmentVariables["ORBIT_BUN"] = runtime;
        start.EnvironmentVariables["ORBIT_LAUNCHER"] = Path.Combine(root, "bin", "sbar-orbit.cmd");
        var child = Process.Start(start);
        if (child == null) throw new Exception("Owned child did not start");
        return child;
    }
    private static PreparedSeal ParseSeal(string text)
    {
        var identity = Object(text);
        if (String.Join(",", identity.Keys.OrderBy(key => key, StringComparer.Ordinal)) != "archiveIntegrity,releaseDigest,runtime,runtimeDigest,schema,version" ||
            !(identity["schema"] is int) || (identity["archiveIntegrity"] != null && (!(identity["archiveIntegrity"] is string) ||
            !Regex.IsMatch((string)identity["archiveIntegrity"], "^sha512-[A-Za-z0-9+/]+={0,2}$")))) throw new Exception("Invalid prepared identity shape");
        return new PreparedSeal { Schema = (int)identity["schema"], Version = Text(identity, "version"),
            ReleaseDigest = Text(identity, "releaseDigest"), Runtime = Text(identity, "runtime"), RuntimeDigest = Text(identity, "runtimeDigest") };
    }
    private static string Canonical(string path) { if (!Path.IsPathRooted(path)) throw new Exception("Absolute path required"); return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar); }
    private static void NoRedirect(string path) { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Redirected installation refused"); }
    private static IDictionary<string, object> Object(string value) { var result = Json.DeserializeObject(value) as IDictionary<string, object>; if (result == null) throw new Exception("Invalid verifier JSON"); return result; }
    private static string Text(IDictionary<string, object> value, string key) { object entry; if (!value.TryGetValue(key, out entry) || !(entry is string)) throw new Exception("Missing verifier field"); return (string)entry; }
    private static string Digest(string path) { using (var hash = SHA256.Create()) using (var file = File.OpenRead(path)) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    private static string ReadBounded(StreamReader stream, int bound) { var output = new StringBuilder(); var buffer = new char[4096]; int read; while ((read = stream.Read(buffer, 0, buffer.Length)) != 0) { if (output.Length + read > bound) throw new Exception("Verifier output bound exceeded"); output.Append(buffer, 0, read); } return output.ToString(); }
    private static string Arguments(IEnumerable<string> args) { return String.Join(" ", args.Select(Quote)); }
    private static string Quote(string value)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) { if (c == '\\') { slashes++; continue; } if (c == '\"') { result.Append('\\', slashes * 2 + 1); result.Append(c); } else { result.Append('\\', slashes); result.Append(c); } slashes = 0; }
        result.Append('\\', slashes * 2); result.Append('\"'); return result.ToString();
    }
}

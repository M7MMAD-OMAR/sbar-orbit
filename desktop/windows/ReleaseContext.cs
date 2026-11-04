using System.Diagnostics;
using Orbit.Shared;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Orbit.Desktop;

internal sealed record ReleaseContext(string SourceRoot, string Runtime, string ManagedRoot, string Version, bool Managed)
{
    internal static ReleaseContext Load()
    {
        // Published host lives at VERSION/desktop/windows-app/Orbit.Desktop.exe.
        var source = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));
        PreparedRelease.NoRedirect(source);
        var packagePath = Path.Combine(source, "package.json");
        using var package = JsonDocument.Parse(ReadSmallFile(packagePath));
        var version = package.RootElement.GetProperty("version").GetString() ?? throw new InvalidOperationException("Release version missing");
        if (package.RootElement.GetProperty("name").GetString() != "sbar-orbit" || !Regex.IsMatch(version, @"^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$"))
            throw new InvalidOperationException("Release identity invalid");
        var parent = Directory.GetParent(source);
        var managedRoot = parent?.Name == "versions" ? parent.Parent?.FullName : null;
        var managed = managedRoot is not null && Path.GetFileName(source) == version;
        var runtime = Path.Combine(source, "runtime", "bun.exe");
        if (!File.Exists(runtime)) throw new InvalidOperationException("Release runtime missing");
        foreach (var path in new[] { source, packagePath, runtime })
            PreparedRelease.NoRedirect(path);
        using var manifest = JsonDocument.Parse(ReadSmallFile(Path.Combine(source, "desktop-manifest.json")));
        var root = manifest.RootElement;
        if (root.GetProperty("schema").GetInt32() != 1 || root.GetProperty("bootstrapProtocol").GetInt32() != 1 || root.GetProperty("version").GetString() != version ||
            root.GetProperty("platform").GetString() != "win32" || root.GetProperty("arch").GetString() != "x64")
            throw new InvalidOperationException("Desktop payload identity invalid");
        var runtimeEntry = root.GetProperty("files").EnumerateArray().Single(entry => entry.GetProperty("path").GetString() == "runtime/bun.exe");
        using var stream = File.OpenRead(runtime);
        if (Convert.ToHexStringLower(SHA256.HashData(stream)) != runtimeEntry.GetProperty("sha256").GetString())
            throw new InvalidOperationException("Desktop runtime integrity differs");
        return new(source, runtime, managedRoot ?? "", version, managed);
    }

    private static string ReadSmallFile(string path)
    {
        return PreparedRelease.ReadSmall(path, 1024 * 1024);
    }

    internal async Task VerifyAsync(CancellationToken cancellation = default)
    {
        if (!Managed) throw new InvalidOperationException("Complete the managed installation first");
        PreparedRelease.Attest(ManagedRoot, SourceRoot, Version, ParseSeal);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var start = new ProcessStartInfo(Runtime) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = SourceRoot };
        start.ArgumentList.Add(Path.Combine(SourceRoot, "src", "windows-managed-install.ts"));
        start.ArgumentList.Add("verify-current"); start.ArgumentList.Add("--root"); start.ArgumentList.Add(ManagedRoot);
        start.Environment["ORBIT_BUN"] = Runtime;
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Managed verifier did not start");
        try
        {
            var stdout = DesktopBridge.ReadBoundedAsync(child.StandardOutput, 65536, timeout.Token);
            var stderr = DesktopBridge.ReadBoundedAsync(child.StandardError, 16384, timeout.Token);
            await Task.WhenAll(stdout, stderr, child.WaitForExitAsync(timeout.Token));
            if (child.ExitCode != 0) throw new InvalidOperationException("Managed verifier refused");
            using var response = JsonDocument.Parse(await stdout);
            var answer = response.RootElement;
            if (!answer.GetProperty("ok").GetBoolean() || answer.GetProperty("bootstrapProtocol").GetInt32() != 1 ||
                answer.GetProperty("version").GetString() != Version ||
                !SamePath(answer, "root", ManagedRoot) || !SamePath(answer, "directory", SourceRoot) ||
                !SamePath(answer, "runtime", Runtime) || !SamePath(answer, "cliPath", Path.Combine(SourceRoot, "src", "cli.ts")) ||
                !SamePath(answer, "desktopPath", Path.Combine(SourceRoot, "desktop", "windows-app", "Orbit.Desktop.exe")))
                throw new InvalidOperationException("Current release changed; reopen Orbit before another action");
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await child.WaitForExitAsync(cleanup.Token);
            }
        }
    }

    private static PreparedSeal ParseSeal(string text)
    {
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            string.Join(",", root.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal)) != "archiveIntegrity,releaseDigest,runtime,runtimeDigest,schema,version")
            throw new InvalidOperationException("Prepared identity shape differs");
        var archive = root.GetProperty("archiveIntegrity");
        if (archive.ValueKind != JsonValueKind.Null && (archive.ValueKind != JsonValueKind.String ||
            !Regex.IsMatch(archive.GetString() ?? "", "^sha512-[A-Za-z0-9+/]+={0,2}$"))) throw new InvalidOperationException("Prepared source integrity differs");
        return new PreparedSeal { Schema = root.GetProperty("schema").GetInt32(),
            Version = root.GetProperty("version").GetString() ?? "", ReleaseDigest = root.GetProperty("releaseDigest").GetString() ?? "",
            Runtime = root.GetProperty("runtime").GetString() ?? "", RuntimeDigest = root.GetProperty("runtimeDigest").GetString() ?? "" };
    }

    private static bool SamePath(JsonElement answer, string key, string expected) =>
        answer.GetProperty(key).ValueKind == JsonValueKind.String &&
        string.Equals(answer.GetProperty(key).GetString(), expected, StringComparison.OrdinalIgnoreCase);
}

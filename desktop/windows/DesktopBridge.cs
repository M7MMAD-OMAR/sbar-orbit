using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Orbit.Desktop;

internal sealed class DesktopBridge(ReleaseContext release) : IDisposable
{
    internal static readonly string[] Commands = ["version", "status", "doctor", "update-status", "update-check", "updates-on", "updates-off", "connector-config"];
    private readonly CancellationTokenSource lifetime = new();
    private Process? owned;

    internal async Task<object> RunAsync(string command)
    {
        if (!Commands.Contains(command)) throw new InvalidOperationException("Unknown desktop command");
        if (command == "version") return new { version = release.Version, platform = "windows-x64",
            nativeApplicationControl = "unsupported", signing = "unsigned", managed = release.Managed };
        await release.VerifyAsync(lifetime.Token);
        if (!release.Managed) throw new InvalidOperationException("Complete the managed installation first");
        var arguments = command switch
        {
            "status" => new[] { "status" }, "doctor" => ["doctor"], "update-status" => ["update", "status"],
            "update-check" => ["update", "check"], "updates-on" => ["update", "on"], "updates-off" => ["update", "off"],
            "connector-config" => Array.Empty<string>(),
            _ => throw new InvalidOperationException("Unknown desktop command")
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        var start = new ProcessStartInfo(release.Runtime) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8,
            WorkingDirectory = release.SourceRoot };
        start.ArgumentList.Add(Path.Combine(release.SourceRoot, "scripts", "limited.ts"));
        start.ArgumentList.Add(release.Runtime);
        start.ArgumentList.Add(Path.Combine(release.SourceRoot, "src", command == "connector-config" ? "connector-config.ts" : "cli.ts"));
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment["ORBIT_BUN"] = release.Runtime;
        start.Environment["ORBIT_LAUNCHER"] = Path.Combine(release.ManagedRoot, "bin", "sbar-orbit.cmd");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Local action did not start");
        owned = process;
        try
        {
            var stdout = ReadBoundedAsync(process.StandardOutput, 1024 * 1024, timeout.Token);
            var stderr = ReadBoundedAsync(process.StandardError, 16384, timeout.Token);
            await Task.WhenAll(stdout, stderr, process.WaitForExitAsync(timeout.Token));
            if (process.ExitCode != 0) throw new InvalidOperationException("Local action failed");
            using var result = JsonDocument.Parse(await stdout);
            return result.RootElement.Clone();
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true); // Only the action this GUI started.
            owned = null;
        }
    }

    internal static async Task<string> ReadBoundedAsync(StreamReader reader, int maximum, CancellationToken cancellation)
    {
        var result = new StringBuilder(); var buffer = new char[4096];
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellation);
            if (count == 0) return result.ToString();
            if (result.Length + count > maximum) throw new InvalidOperationException("Local action output exceeded its bound");
            result.Append(buffer, 0, count);
        }
    }

    public void Dispose()
    {
        lifetime.Cancel();
        try { if (owned is { HasExited: false }) owned.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        lifetime.Dispose();
    }
}

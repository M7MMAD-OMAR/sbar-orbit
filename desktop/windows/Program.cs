using Microsoft.Web.WebView2.Core;

namespace Orbit.Desktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string? smoke = null;
        if (args.Length != 0)
        {
            if (args.Length != 2 || args[0] != "--smoke-output" || !Path.IsPathFullyQualified(args[1])) return 2;
            smoke = Path.GetFullPath(args[1]);
        }
        try
        {
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
            var release = ReleaseContext.Load();
            release.VerifyAsync().GetAwaiter().GetResult();
            Application.Run(new MainForm(release, smoke));
            return Environment.ExitCode;
        }
        catch (Exception)
        {
            if (smoke is not null)
            {
                Directory.CreateDirectory(smoke);
                File.WriteAllText(Path.Combine(smoke, "failure.json"), "{\"ok\":false,\"reason\":\"Windows GUI prerequisites or release identity unavailable\"}");
            }
            else MessageBox.Show("Orbit needs a complete verified Windows desktop installation and Microsoft Edge WebView2 Evergreen Runtime. Install WebView2 explicitly from Microsoft if it is missing. This unsigned build may display a Windows SmartScreen warning; Orbit does not claim a verified publisher.", "Orbit", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 3;
        }
    }
}

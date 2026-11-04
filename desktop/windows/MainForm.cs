using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Orbit.Desktop;

internal sealed class MainForm : Form
{
    private const string AppOrigin = "https://orbit.invalid/";
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon tray;
    private readonly DesktopBridge bridge;
    private readonly string? smokeOutput;
    private bool exiting;
    private bool busy;

    internal MainForm(ReleaseContext release, string? smokeOutput)
    {
        this.smokeOutput = smokeOutput;
        bridge = new DesktopBridge(release);
        Text = "Orbit";
        Width = 1040; Height = 900; MinimumSize = new Size(680, 560);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;
        Controls.Add(view);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Orbit", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Exit Orbit", null, (_, _) => { exiting = true; Close(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Orbit", ContextMenuStrip = menu, Visible = smokeOutput is null };
        tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        Shown += async (_, _) => await InitializeAsync(release);
        FormClosing += (_, args) =>
        {
            if (!exiting && smokeOutput is null && args.CloseReason == CloseReason.UserClosing)
            { args.Cancel = true; Hide(); }
        };
        FormClosed += (_, _) => { tray.Visible = false; tray.Dispose(); bridge.Dispose(); view.Dispose(); };
    }

    private async Task InitializeAsync(ReleaseContext release)
    {
        try
        {
            var state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "sbar-orbit", "desktop-webview2");
            // This is this app's own state, never an original browser's profile or an automation backend.
            var environment = await CoreWebView2Environment.CreateAsync(null, state);
            await view.EnsureCoreWebView2Async(environment);
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.SetVirtualHostNameToFolderMapping("orbit.invalid", Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += (_, args) => { if (!IsAppUri(args.Uri)) args.Cancel = true; };
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.DownloadStarting += (_, args) => args.Cancel = true;
            core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, args) =>
            {
                if (!IsAppUri(args.Request.Uri))
                    args.Response = environment.CreateWebResourceResponse(Stream.Null, 403, "Blocked", "Content-Type: text/plain");
            };
            core.WebMessageReceived += async (_, args) => await ReceiveAsync(args);
            var loaded = new TaskCompletionSource<bool>();
            core.NavigationCompleted += (_, args) => loaded.TrySetResult(args.IsSuccess);
            core.Navigate(AppOrigin + "index.html");
            if (!await loaded.Task.WaitAsync(TimeSpan.FromSeconds(20))) throw new InvalidOperationException("Local application page failed to load");
            if (smokeOutput is not null)
            {
                var title = JsonSerializer.Deserialize<string>(await core.ExecuteScriptAsync("document.title"));
                if (title != "Orbit" || !Visible || Handle == IntPtr.Zero) throw new InvalidOperationException("Native window smoke did not become visible");
                Directory.CreateDirectory(smokeOutput);
                using (var image = new FileStream(Path.Combine(smokeOutput, "orbit-window.png"), FileMode.CreateNew, FileAccess.Write))
                    await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                var report = JsonSerializer.Serialize(new { schema = 1, nativeWindow = true, visible = Visible,
                    title, version = release.Version, webView2 = core.Environment.BrowserVersionString,
                    desktopControl = "unsupported", signing = "unsigned", bridgeCommands = DesktopBridge.Commands }, new JsonSerializerOptions { WriteIndented = true });
                await File.WriteAllTextAsync(Path.Combine(smokeOutput, "smoke.json"), report);
                exiting = true; Close();
            }
        }
        catch (Exception)
        {
            Environment.ExitCode = 3;
            if (smokeOutput is not null)
            {
                Directory.CreateDirectory(smokeOutput);
                await File.WriteAllTextAsync(Path.Combine(smokeOutput, "failure.json"), "{\"ok\":false,\"reason\":\"Windows GUI initialization failed\"}");
            }
            else MessageBox.Show(this, "Orbit could not start its local window. Microsoft Edge WebView2 Evergreen Runtime is required. Install it explicitly from Microsoft, then reopen Orbit. No runtime was downloaded or installed by this application.", "Orbit", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            exiting = true; Close();
        }
    }

    private static bool IsAppUri(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == "orbit.invalid" && uri.Port == 443 && string.IsNullOrEmpty(uri.UserInfo);

    private async Task ReceiveAsync(CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (busy || args.Source != AppOrigin + "index.html" || args.WebMessageAsJson.Length > 2048) return;
        string? id = null;
        string? command = null;
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2) return;
            id = root.GetProperty("id").GetString(); command = root.GetProperty("command").GetString();
            if (id is null || id.Length is < 1 or > 32 || !id.All(char.IsAsciiDigit) || command is null || !DesktopBridge.Commands.Contains(command)) return;
            busy = true;
            var result = await bridge.RunAsync(command);
            if (!IsDisposed) view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, command, ok = true, result }));
        }
        catch (Exception)
        {
            if (!IsDisposed && id is not null && command is not null)
                view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, command, ok = false, error = "Orbit could not complete this bounded local action. Inspect installation status and diagnostics." }));
        }
        finally { busy = false; }
    }
}

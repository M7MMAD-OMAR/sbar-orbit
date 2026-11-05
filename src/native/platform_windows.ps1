param([string]$Directory, [string]$ControlDirectory, [string]$PlanPath)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Windows.Forms
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Threading;

public sealed class OrbitNativeFailure : Exception {
    public string Code;
    public OrbitNativeFailure(string code) : base(code) { Code = code; }
}
public static class OrbitWindowsNative {
    // This window is owned by this helper, never by the selected application.
    // Its independent STA loop remains responsive while the framed reader waits.
    sealed class ActivityForm : Form {
        public readonly string Address,Stable;
        public volatile bool Paused,Painted,Current,Revoked;
        public long Updated;
        public System.Drawing.Point? Pointer;
        readonly System.Windows.Forms.Timer timer;
        readonly WinEventCallback lifetime;
        readonly IntPtr hook;
        public readonly ManualResetEvent Ready=new ManualResetEvent(false);
        public ActivityForm(string address,string stable) {
            Address=address; Stable=stable; Text="Orbit"; FormBorderStyle=FormBorderStyle.None;
            ShowInTaskbar=false; TopMost=true; StartPosition=FormStartPosition.Manual;
            BackColor=Color.Magenta; TransparencyKey=Color.Magenta; DoubleBuffered=true;
            var target=OrbitWindowsNative.Handle(address);
            lifetime=delegate(IntPtr source,uint kind,IntPtr window,int objectId,int childId,uint thread,uint time) {
                if(window==target && objectId==0 && childId==0) { Revoked=true; Current=false; Hide(); }
            };
            hook=SetWinEventHook(0x8001,0x8001,IntPtr.Zero,lifetime,0,0,2);
            if(hook==IntPtr.Zero) Fail("INDICATOR_UNAVAILABLE");
            timer=new System.Windows.Forms.Timer(); timer.Interval=100;
            timer.Tick+=delegate { RefreshTarget(); }; timer.Start(); RefreshTarget();
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var value=base.CreateParams; value.ExStyle|=0x08000000|0x00000020|0x00000080; return value; }
        }
        public void RefreshTarget() {
            try {
                var row=OrbitWindowsNative.Describe(OrbitWindowsNative.Handle(Address));
                if((string)row["stableId"]!=Stable || Paused || Revoked) { Current=false; Hide(); return; }
                Bounds=new Rectangle((int)row["x"],(int)row["y"],(int)row["width"],(int)row["height"]);
                if(!Visible) Show(); Invalidate(); Current=Visible;
                Interlocked.Exchange(ref Updated,Stopwatch.GetTimestamp());
            } catch { Current=false; Hide(); }
        }
        protected override void OnPaint(PaintEventArgs args) {
            base.OnPaint(args);
            using(var pen=new Pen(Color.FromArgb(37,95,206),4)) args.Graphics.DrawRectangle(pen,2,2,Math.Max(0,Width-5),Math.Max(0,Height-5));
            using(var fill=new SolidBrush(Color.FromArgb(12,25,50))) args.Graphics.FillRectangle(fill,4,4,70,24);
            using(var brush=new SolidBrush(Color.White)) args.Graphics.DrawString("Orbit",SystemFonts.MessageBoxFont,brush,12,8);
            if(Pointer.HasValue) {
                var point=Pointer.Value;
                using(var pen=new Pen(Color.FromArgb(37,95,206),3)) args.Graphics.DrawEllipse(pen,point.X-12,point.Y-12,24,24);
                var arrow=new System.Drawing.Point[]{point,new System.Drawing.Point(point.X+5,point.Y+17),new System.Drawing.Point(point.X+9,point.Y+11),new System.Drawing.Point(point.X+16,point.Y+9)};
                using(var fill=new SolidBrush(Color.FromArgb(37,95,206))) args.Graphics.FillPolygon(fill,arrow);
                using(var pen=new Pen(Color.White,2)) args.Graphics.DrawPolygon(pen,arrow);
            }
            Painted=true; Ready.Set();
        }
        protected override void Dispose(bool disposing) { if(disposing) { timer.Dispose(); if(hook!=IntPtr.Zero) UnhookWinEvent(hook); } base.Dispose(disposing); }
    }
    static ActivityForm activity;
    static Thread activityThread;
    static Mutex targetLease;
    const uint CREATE_BREAKAWAY_FROM_JOB=0x01000000, CREATE_NEW_PROCESS_GROUP=0x00000200;
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct INPUTINFO { public uint Size,Time; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved,desktop,title; public int x,y,width,height,xchars,ychars,fill,flags;
        public short show,reserved2; public IntPtr reservedPointer,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr Process,Thread; public int Pid,Tid; }
    delegate bool WindowCallback(IntPtr window,IntPtr parameter);
    delegate void WinEventCallback(IntPtr hook,uint kind,IntPtr window,int objectId,int childId,uint thread,uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,WinEventCallback callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out int pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref INPUTINFO info);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int w,int h,uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out int value,int size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESSINFO process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    public static void Initialize() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {} }
    public static bool StartActivity(string address,string stable) {
        if(activity!=null || targetLease!=null) Fail("APPLICATION_BUSY");
        string sid=WindowsIdentity.GetCurrent().User.Value;
        var lease=new Mutex(false,"Local\\OrbitNativeWindow-"+Digest(sid+":"+address+":"+stable));
        bool held=false;
        try { try { held=lease.WaitOne(0); } catch(AbandonedMutexException) { held=true; }
            if(!held) { lease.Dispose(); Fail("APPLICATION_BUSY"); }
            targetLease=lease;
            var created=new ManualResetEvent(false);
            activityThread=new Thread(delegate() {
                try { activity=new ActivityForm(address,stable); created.Set(); Application.Run(activity); }
                catch { created.Set(); }
                finally { if(activity!=null) { activity.Current=false; activity.Dispose(); } }
            });
            activityThread.IsBackground=true; activityThread.SetApartmentState(ApartmentState.STA); activityThread.Start();
            if(!created.WaitOne(2000) || activity==null || !activity.Ready.WaitOne(2000) || !ActivityCurrent()) { StopActivity(); Fail("INDICATOR_UNAVAILABLE"); }
            return true;
        } catch { if(targetLease==null && held) { try { lease.ReleaseMutex(); } catch {} lease.Dispose(); } throw; }
    }
    public static bool ActivityCurrent() {
        var current=activity;
        return targetLease!=null && current!=null && current.Painted && current.Current && !current.Paused && !current.Revoked
            && Stopwatch.GetTimestamp()-Interlocked.Read(ref current.Updated)<Stopwatch.Frequency/2;
    }
    public static void PauseActivity(bool paused) {
        var current=activity; if(current==null) return;
        current.Paused=paused; current.Current=false;
        try { current.BeginInvoke(new Action(current.RefreshTarget)); } catch { }
    }
    public static void MarkSemanticTarget(AutomationElement element) {
        var current=activity;
        if(!ActivityCurrent()) Fail("INDICATOR_UNAVAILABLE");
        var bounds=element.Current.BoundingRectangle;
        var row=Describe(Handle(current.Address));
        int x=(int)Math.Round(bounds.X+bounds.Width/2)-(int)row["x"],y=(int)Math.Round(bounds.Y+bounds.Height/2)-(int)row["y"];
        if(x<0 || y<0 || x>=(int)row["width"] || y>=(int)row["height"]) Fail("SEMANTIC_UNSUPPORTED");
        var painted=new ManualResetEvent(false);
        try {
            current.BeginInvoke(new Action(delegate { try { current.Pointer=new System.Drawing.Point(x,y); current.Invalidate(); current.Update(); } finally { painted.Set(); } }));
            if(!painted.WaitOne(500)) Fail("INDICATOR_UNAVAILABLE");
            painted.Dispose();
            if(!ActivityCurrent()) Fail("INDICATOR_UNAVAILABLE");
        } catch(OrbitNativeFailure) { throw; } catch { Fail("INDICATOR_UNAVAILABLE"); }
    }
    public static void StopActivity() {
        var current=activity; if(current!=null) {
            current.Paused=true; current.Current=false;
            try { current.BeginInvoke(new Action(current.Close)); } catch { }
        }
        var thread=activityThread; if(thread!=null && thread!=Thread.CurrentThread) thread.Join(2000);
        activity=null; activityThread=null;
        var lease=targetLease; targetLease=null;
        if(lease!=null) { try { lease.ReleaseMutex(); } finally { lease.Dispose(); } }
    }
    static void Fail(string code) { throw new OrbitNativeFailure(code); }
    public static string Digest(string text) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant(); }
    public static string ReadLine() {
        var value=new StringBuilder(); int next;
        while((next=Console.In.Read())!=-1) { if(next==10) return value.ToString(); if(value.Length>=65536) Fail("LIMIT_REACHED"); value.Append((char)next); }
        if(value.Length!=0) Fail("INVALID_REQUEST"); return null;
    }
    public static string Birth(int pid) {
        using(var process=Process.GetProcessById(pid)) {
            if(process.SessionId!=Process.GetCurrentProcess().SessionId) Fail("NATIVE_PERMISSION_REQUIRED");
            IntPtr token;
            if(!OpenProcessToken(process.Handle,8,out token)) Fail("NATIVE_PERMISSION_REQUIRED");
            try { using(var owner=new WindowsIdentity(token)) using(var current=WindowsIdentity.GetCurrent()) { if(!owner.User.Equals(current.User)) Fail("NATIVE_PERMISSION_REQUIRED"); } }
            finally { CloseHandle(token); }
            return process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }
    public static IntPtr Handle(string address) {
        long value;
        if(address==null || !address.StartsWith("0x") || address.Length>18 || !long.TryParse(address.Substring(2),System.Globalization.NumberStyles.HexNumber,null,out value) || value==0) { Fail("INVALID_REQUEST"); return IntPtr.Zero; }
        return new IntPtr(value);
    }
    public static Dictionary<string,object> Describe(IntPtr window) {
        int pid,cloaked=0; RECT rect;
        if(!IsWindow(window) || !IsWindowVisible(window) || IsIconic(window) || GetWindowThreadProcessId(window,out pid)==0 || !GetWindowRect(window,out rect)) { Fail("TARGET_CLOSED"); return null; }
        try { DwmGetWindowAttribute(window,14,out cloaked,4); } catch (DllNotFoundException) {}
        if(cloaked!=0 || rect.Right<=rect.Left || rect.Bottom<=rect.Top || rect.Right-rect.Left>8192 || rect.Bottom-rect.Top>8192) { Fail("TARGET_CLOSED"); return null; }
        string birth=Birth(pid); var title=new StringBuilder(513); GetWindowText(window,title,title.Capacity);
        return new Dictionary<string,object> { {"address","0x"+window.ToInt64().ToString("x")}, {"stableId",Digest(pid+":"+birth+":"+window.ToInt64()).Substring(0,32)}, {"pid",pid}, {"birth",birth}, {"title",title.ToString()}, {"width",rect.Right-rect.Left}, {"height",rect.Bottom-rect.Top}, {"x",rect.Left}, {"y",rect.Top}, {"workspace",1}, {"windowProtocol","win32"} };
    }
    public static List<Dictionary<string,object>> Windows() {
        var rows=new List<Dictionary<string,object>>(); bool overflow=false;
        EnumWindows(delegate(IntPtr window,IntPtr unused) {
            try { if(rows.Count>=256) { overflow=true; return false; } var row=Describe(window); if((int)row["pid"]!=Process.GetCurrentProcess().Id) rows.Add(row); }
            catch(OrbitNativeFailure) {} catch(InvalidOperationException) {} catch(System.ComponentModel.Win32Exception) {}
            return true;
        },IntPtr.Zero);
        if(overflow) Fail("LIMIT_REACHED"); return rows;
    }
    public static AutomationElement Bind(string address,string stable) {
        IntPtr window=Handle(address); var row=Describe(window);
        if((string)row["stableId"]!=stable) Fail("TARGET_CLOSED");
        var root=AutomationElement.FromHandle(window);
        if(root==null || root.Current.NativeWindowHandle!=window.ToInt32() || root.Current.ProcessId!=(int)row["pid"]) Fail("TARGET_CLOSED");
        root.GetRuntimeId(); return root;
    }
    public static bool RefCurrent(AutomationElement root,AutomationElement element,int pid) {
        try {
            if(element.Current.ProcessId!=pid || element.Current.IsOffscreen) return false;
            var current=element;
            for(int depth=0;current!=null && depth<32;depth++) { if(Automation.Compare(current,root)) return true; current=TreeWalker.RawViewWalker.GetParent(current); }
        } catch(ElementNotAvailableException) {} catch(InvalidOperationException) {}
        return false;
    }
    public static bool OwnerInputRecent() {
        var info=new INPUTINFO(); info.Size=(uint)Marshal.SizeOf(typeof(INPUTINFO));
        if(!GetLastInputInfo(ref info)) return true;
        return unchecked((uint)Environment.TickCount-info.Time)<2000;
    }
    public static Dictionary<string,object> Tree(AutomationElement root,Dictionary<string,object> row) {
        var nodes=new List<Dictionary<string,object>>(); var handles=new List<AutomationElement>(); var pending=new Stack<Tuple<AutomationElement,int>>(); pending.Push(Tuple.Create(root,0));
        string truncated=null; var timer=Stopwatch.StartNew();
        while(pending.Count>0 && nodes.Count<256 && timer.ElapsedMilliseconds<1000) {
            var item=pending.Pop(); var element=item.Item1;
            try {
                var data=element.Current;
                if(data.ProcessId!=(int)row["pid"] || data.IsOffscreen) continue;
                var bounds=data.BoundingRectangle;
                if(bounds.Width>0 && bounds.Height>0) {
                    var node=new Dictionary<string,object> { {"role",data.ControlType.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant()}, {"box",new double[]{bounds.X-(int)row["x"],bounds.Y-(int)row["y"],bounds.Width,bounds.Height}} };
                    if(!data.IsPassword) {
                        if(!String.IsNullOrEmpty(data.Name)) node["name"]=data.Name.Substring(0,Math.Min(180,data.Name.Length));
                        object value; if(element.TryGetCurrentPattern(ValuePattern.Pattern,out value)) {
                            string text=((ValuePattern)value).Current.Value; if(!String.IsNullOrEmpty(text)) node["text"]=text.Substring(0,Math.Min(120,text.Length));
                        }
                    }
                    nodes.Add(node); handles.Add(element);
                }
                if(data.IsPassword) continue;
                var children=new List<AutomationElement>(); var child=TreeWalker.ControlViewWalker.GetFirstChild(element);
                if(item.Item2>=10) { if(child!=null) truncated="depth"; continue; }
                while(child!=null && children.Count<256 && timer.ElapsedMilliseconds<1000) { children.Add(child); child=TreeWalker.ControlViewWalker.GetNextSibling(child); }
                if(child!=null) truncated="children";
                for(int index=children.Count-1;index>=0;index--) pending.Push(Tuple.Create(children[index],item.Item2+1));
            } catch(ElementNotAvailableException) { truncated="unreadable"; }
        }
        if(pending.Count>0) truncated=truncated??(timer.ElapsedMilliseconds>=1000?"time":"nodes");
        return new Dictionary<string,object> { {"nodes",nodes}, {"handles",handles}, {"truncated",truncated} };
    }
    public static void Invoke(AutomationElement root,AutomationElement element,int pid) {
        if(!RefCurrent(root,element,pid)) Fail("STALE_REF");
        object pattern;
        if(!element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) Fail("UNSUPPORTED");
        try { ((InvokePattern)pattern).Invoke(); } catch { Fail("NATIVE_DELIVERY_UNCERTAIN"); }
    }
    public static void ValidateSemantic(AutomationElement root,AutomationElement element,int pid,string verb) {
        if(!RefCurrent(root,element,pid)) Fail("STALE_REF");
        object pattern;
        if(verb=="invoke-ref") { if(!element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) Fail("SEMANTIC_UNSUPPORTED"); }
        else if(verb=="edit-ref") { if(element.Current.IsPassword || !element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) Fail("SEMANTIC_UNSUPPORTED"); }
        else Fail("SEMANTIC_UNSUPPORTED");
    }
    public static void SetValue(AutomationElement root,AutomationElement element,int pid,string text) {
        if(!RefCurrent(root,element,pid)) Fail("STALE_REF");
        if(element.Current.IsPassword) Fail("UNSUPPORTED");
        object pattern;
        if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) Fail("UNSUPPORTED");
        try { ((ValuePattern)pattern).SetValue(text); } catch { Fail("NATIVE_DELIVERY_UNCERTAIN"); }
    }
    public static void CloseWindow(AutomationElement root) {
        object pattern; if(!root.TryGetCurrentPattern(WindowPattern.Pattern,out pattern)) Fail("UNSUPPORTED");
        try { ((WindowPattern)pattern).Close(); } catch { Fail("NATIVE_DELIVERY_UNCERTAIN"); }
    }
    public static byte[] Capture(string address,string stable) {
        IntPtr window=Handle(address); var before=Describe(window);
        if((string)before["stableId"]!=stable) Fail("TARGET_CLOSED");
        int width=(int)before["width"],height=(int)before["height"];
        if((long)width*height>16000000) Fail("CAPTURE_UNAVAILABLE");
        using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
            using(var graphics=Graphics.FromImage(bitmap)) { IntPtr dc=graphics.GetHdc(); try { if(!PrintWindow(window,dc,2)) Fail("CAPTURE_UNAVAILABLE"); } finally { graphics.ReleaseHdc(dc); } }
            var after=Describe(window);
            if((string)after["stableId"]!=stable) Fail("TARGET_CLOSED");
            if((int)after["width"]!=width || (int)after["height"]!=height) Fail("CAPTURE_GEOMETRY_CHANGED");
            using(var output=new MemoryStream()) { bitmap.Save(output,ImageFormat.Png); if(output.Length>16*1024*1024) Fail("CAPTURE_UNAVAILABLE"); return output.ToArray(); }
        }
    }
    public static int StartOriginal(string executable) {
        if(!Path.IsPathRooted(executable) || !executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase) || !File.Exists(executable) || executable.IndexOf('"')>=0) { Fail("INVALID_REQUEST"); return 0; }
        var startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(typeof(STARTUPINFO)); startup.flags=1; startup.show=4; PROCESSINFO process;
        // A broker Job must not own the normal application's lifetime. A denied
        // breakaway is a refusal, never a retry inside that Job or another profile.
        if(!CreateProcess(executable,new StringBuilder("\""+executable+"\""),IntPtr.Zero,IntPtr.Zero,false,CREATE_BREAKAWAY_FROM_JOB|CREATE_NEW_PROCESS_GROUP,IntPtr.Zero,null,ref startup,out process)) { Fail("UNSUPPORTED"); return 0; }
        CloseHandle(process.Thread); CloseHandle(process.Process); return process.Pid;
    }
    public static void Place(IntPtr window,int requestedWidth,int requestedHeight) {
        var work=Screen.FromHandle(window).WorkingArea; int w=Math.Min(requestedWidth,work.Width),h=Math.Min(requestedHeight,work.Height);
        if(w<200 || h<150) Fail("UNSUPPORTED");
        if(!SetWindowPos(window,IntPtr.Zero,work.X+(work.Width-w)/2,work.Y+(work.Height-h)/2,w,h,0x0214)) Fail("OPENING_UNCERTAIN");
    }
    public static object[] Monitors() {
        var result=new List<object>(); string current=Screen.FromHandle(GetForegroundWindow()).DeviceName;
        foreach(var screen in Screen.AllScreens) result.Add(new Dictionary<string,object>{{"name",screen.DeviceName},{"focused",screen.DeviceName==current},{"workspace",1}});
        return result.ToArray();
    }
}
'@
$references=@([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.AutomationPattern].Assembly.Location,[System.Windows.Rect].Assembly.Location,[System.Drawing.Bitmap].Assembly.Location,[System.Windows.Forms.Screen].Assembly.Location,[System.Diagnostics.Process].Assembly.Location)
Add-Type -TypeDefinition $source -ReferencedAssemblies $references
[OrbitWindowsNative]::Initialize()
$script:target = $null
$script:root = $null
$script:appId = $null
$script:windowId = $null
$script:paused = $false
$script:closed = $false
$script:snapshots = @{}
$script:indicatorReady = $false
$script:prepared = @{}
# Experimental native writes stay unreachable until HWND lifetime attribution,
# native compilation and original-application acceptance are measured together.
Set-Variable -Scope Script -Name mutationQualified -Value $false -Option Constant
Set-Variable -Scope Script -Name windowLifetimeQualified -Value $false -Option Constant

function Refuse([string]$code) { throw [OrbitNativeFailure]::new($code) }
function Fields($value, [string[]]$allowed, [string[]]$required = @()) {
    if ($null -eq $value -or $value -isnot [pscustomobject]) { Refuse 'INVALID_REQUEST' }
    foreach ($name in $value.PSObject.Properties.Name) { if ($allowed -cnotcontains $name) { Refuse 'INVALID_REQUEST' } }
    foreach ($name in $required) { if ($value.PSObject.Properties.Name -cnotcontains $name) { Refuse 'INVALID_REQUEST' } }
}
function Workspace($value) { if ($value -isnot [int] -and $value -isnot [long]) { Refuse 'INVALID_REQUEST' }; if ($value -ne 1) { Refuse 'UNSUPPORTED' } }
function Target($value) {
    if ($script:closed -or $null -eq $script:target) { Refuse 'SESSION_CLOSED' }
    if ($value.appId -cne $script:appId -or $value.windowId -cne $script:windowId) { Refuse 'INVALID_REQUEST' }
    $current = [OrbitWindowsNative]::Describe([OrbitWindowsNative]::Handle($script:target.address))
    if ($current.stableId -cne $script:target.stableId -or $script:root.Current.ProcessId -ne $script:target.pid) { $script:snapshots.Clear(); Refuse 'TARGET_CLOSED' }
    $script:target = $current
    return $current
}
function WindowRows {
    $current = Target ([pscustomobject]@{appId=$script:appId;windowId=$script:windowId})
    return ,@(@{appId=$script:appId;windowId=$script:windowId;title=$current.title;width=$current.width;height=$current.height})
}
function VerifyReadTarget($value, $before) {
    $after = Target $value
    foreach ($key in @('x','y','width','height')) {
        if ($after[$key] -ne $before[$key]) { Refuse 'CAPTURE_GEOMETRY_CHANGED' }
    }
    return $after
}
function PrivatePath([string]$path, [bool]$directory) {
    if (-not [IO.Path]::IsPathRooted($path)) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
    $security = Get-Acl -LiteralPath $path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
    foreach ($rule in $security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
    }
}
function Controlled($value, [scriptblock]$operation) {
    if ($script:paused) { Refuse 'SESSION_PAUSED' }
    PrivatePath $ControlDirectory $true
    $lock = [IO.File]::Open((Join-Path $ControlDirectory 'lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $settingsPath = Join-Path $ControlDirectory 'settings.json'
        $settings = [pscustomobject]@{mode='protected';approval=$null}
        if ([IO.File]::Exists($settingsPath)) { PrivatePath $settingsPath $false; if((Get-Item -LiteralPath $settingsPath).Length -gt 65536) { Refuse 'LIMIT_REACHED' }; $settings = [IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json }
        if ($settings.mode -cnotin @('full','protected')) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
        $name = 'platform-action ' + [OrbitWindowsNative]::Digest(($value | ConvertTo-Json -Compress -Depth 12))
        $fingerprint = [OrbitWindowsNative]::Digest($name)
        $phase = 'begin'
        if ($settings.mode -ceq 'protected' -and $settings.approval -cne $fingerprint) { $phase='denied' }
        $event = @{id=[guid]::NewGuid().ToString('N');phase=$phase;kind='action';fingerprint=$fingerprint;epochMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
        $journalPath = Join-Path $ControlDirectory 'actions.jsonl'
        if ([IO.File]::Exists($journalPath)) { PrivatePath $journalPath $false; if ((Get-Item -LiteralPath $journalPath).Length -gt 10485760) { Refuse 'LIMIT_REACHED' } }
        $journal = [IO.FileStream]::new($journalPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try { [void]$journal.Seek(0,[IO.SeekOrigin]::End); $bytes=[Text.Encoding]::UTF8.GetBytes(($event|ConvertTo-Json -Compress)+"`n"); $journal.Write($bytes,0,$bytes.Length); $journal.Flush($true) } finally { $journal.Dispose() }
        if ($phase -eq 'denied') { Refuse 'APPROVAL_REQUIRED' }
        if ($settings.mode -ceq 'protected') {
            $temporary = Join-Path $ControlDirectory ('settings-'+[guid]::NewGuid().ToString('N')+'.tmp')
            try { [IO.File]::WriteAllText($temporary,'{"mode":"protected","approval":null}'); [IO.File]::Replace($temporary,$settingsPath,$null) } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
        }
    } finally { $lock.Dispose() }
    if ($script:paused) { Refuse 'SESSION_PAUSED' }
    if ([OrbitWindowsNative]::OwnerInputRecent()) { Refuse 'OWNER_BUSY' }
    try {
        $result = & $operation
        WriteOutcome $event.id 'success'
        return $result
    } catch {
        WriteOutcome $event.id 'error'
        throw
    }
}
function WriteOutcome([string]$id,[string]$outcome) {
    $lock=[IO.File]::Open((Join-Path $ControlDirectory 'lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $path=Join-Path $ControlDirectory 'actions.jsonl';PrivatePath $path $false
        $event=@{id=$id;phase='finish';outcome=$outcome;epochMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
        $stream=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try { [void]$stream.Seek(0,[IO.SeekOrigin]::End);$bytes=[Text.Encoding]::UTF8.GetBytes(($event|ConvertTo-Json -Compress)+"`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    } finally { $lock.Dispose() }
}
function ResolveRef([string]$value) {
    if ($value -cnotmatch '^@([0-9a-f]{32}):e([0-9]{1,3})$') { Refuse 'INVALID_REQUEST' }
    $snapshot=$script:snapshots[$Matches[1]]; $index=[int]$Matches[2]
    if ($null -eq $snapshot -or [Diagnostics.Stopwatch]::GetTimestamp() -ge $snapshot.expires -or $index -ge $snapshot.handles.Count) { Refuse 'STALE_REF' }
    $element=$snapshot.handles[$index]
    if (-not [OrbitWindowsNative]::RefCurrent($script:root,$element,$script:target.pid)) { $script:snapshots.Clear(); Refuse 'STALE_REF' }
    return $element
}
function SemanticAction($action) {
    if($action.type -ceq 'invoke-ref') {
        Fields $action @('type','appId','windowId','ref','index') @('type','appId','windowId','ref','index')
        if($action.index -isnot [int] -or $action.index -ne 0) { Refuse 'SEMANTIC_UNSUPPORTED' }
    } elseif($action.type -ceq 'edit-ref') {
        Fields $action @('type','appId','windowId','ref','text') @('type','appId','windowId','ref','text')
        if($action.text -isnot [string] -or $action.text.Contains([char]0) -or [Text.Encoding]::UTF8.GetByteCount($action.text) -gt 16000) { Refuse 'INVALID_REQUEST' }
    } else { Refuse 'SEMANTIC_UNSUPPORTED' }
    [void](Target $action)
    $element=ResolveRef $action.ref
    [OrbitWindowsNative]::ValidateSemantic($script:root,$element,$script:target.pid,$action.type)
    return $element
}
function RegisteredExecutable($registration) {
    $id=$registration.applicationId
    if($id -isnot [string] -or $registration.executable -isnot [string] -or $id.Length -gt 255 -or [IO.Path]::GetFileName($id) -cne $id -or -not $id.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase)) { Refuse 'INVALID_REQUEST' }
    $entry=$null
    foreach($hive in @('HKCU:\','HKLM:\')) {
        $path=Join-Path $hive ('Software\Microsoft\Windows\CurrentVersion\App Paths\'+$id)
        if(Test-Path -LiteralPath $path) { $entry=Get-Item -LiteralPath $path;break }
    }
    if($null -eq $entry) { Refuse 'INVALID_REQUEST' }
    try {
        $original=$entry.GetValue('')
        if($original -isnot [string]) { Refuse 'INVALID_REQUEST' }
        $original=[Environment]::ExpandEnvironmentVariables($original.Trim('"'))
        if(-not [String]::Equals([IO.Path]::GetFullPath($original),[IO.Path]::GetFullPath($registration.executable),[StringComparison]::OrdinalIgnoreCase)) { Refuse 'INVALID_REQUEST' }
        # Do not silently discard additional ShellExecute environment semantics.
        $extra=$entry.GetValue('Path')
        if($null -ne $extra -and [string]$extra -ne '') { Refuse 'UNSUPPORTED' }
        return $original
    } finally { $entry.Close() }
}
function Request([string]$method,$value) {
    if ($script:closed) { Refuse 'SESSION_CLOSED' }
    if($method -ceq 'claim' -and -not $script:windowLifetimeQualified) { Refuse 'UNSUPPORTED' }
    if(-not $script:mutationQualified -and ($method -cin @('open','semantic-prepare','semantic-send') -or ($method -ceq 'act' -and $value.type -ceq 'close-window'))) { Refuse 'UNSUPPORTED' }
    if ($method -ceq 'status') {
        Fields $value @()
        if(-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Refuse 'NATIVE_PERMISSION_REQUIRED' }
        $capabilities=@('windows','state','observe','close-application','pause','resume','stop')
        $indicator='not-qualified'
        if($script:mutationQualified -and $script:indicatorReady -and [OrbitWindowsNative]::ActivityCurrent()) { $capabilities+=@('invoke-ref','edit-ref','close-window');$indicator='selected-window-overlay' }
        return @{ready=$true;platform='win32';scope='selected-platform-window';workspaceKind='current-visible-desktop';clipboard='not-accessed';capabilities=$capabilities;pointerInput=$false;keyInput=$false;indicator=$indicator;nativeAcceptance='unmeasured'}
    }
    if ($method -ceq 'candidates' -or $method -ceq 'claim') {
        Fields $value @('workspace','address','stableId') @('workspace'); Workspace $value.workspace
        $rows=@([OrbitWindowsNative]::Windows() | Where-Object { ($null -eq $value.address -or $_.address -ceq $value.address) -and ($null -eq $value.stableId -or $_.stableId -ceq $value.stableId) })
        if ($method -ceq 'candidates') { return @{workspace=1;workspaceKind='current-visible-desktop';candidates=$rows} }
        if ($null -ne $script:target) { Refuse 'APPLICATION_BUSY' }
        if ($null -eq $value.address -or $null -eq $value.stableId -or $rows.Count -ne 1) { Refuse 'TARGET_CLOSED' }
        $script:root=[OrbitWindowsNative]::Bind($rows[0].address,$rows[0].stableId); $script:target=$rows[0]
        $script:appId=[guid]::NewGuid().ToString('N'); $script:windowId=[guid]::NewGuid().ToString('N')
        if($script:mutationQualified) {
            $foreground=[OrbitWindowsNative]::GetForegroundWindow()
            try {
                $script:indicatorReady=[OrbitWindowsNative]::StartActivity($script:target.address,$script:target.stableId)
                if([OrbitWindowsNative]::GetForegroundWindow() -ne $foreground) { Refuse 'INDICATOR_UNAVAILABLE' }
            } catch { [OrbitWindowsNative]::StopActivity();$script:indicatorReady=$false;throw }
        }
        return @{appId=$script:appId;selectedWindowId=$script:windowId;scope='selected-platform-window';clipboard='not-accessed';windowEnrollment='selected-window';pointer=$null;windows=(WindowRows)}
    }
    if ($method -cin @('pause','resume')) { Fields $value @(); $script:paused=$method -ceq 'pause';$script:snapshots.Clear();$script:prepared.Clear();[OrbitWindowsNative]::PauseActivity($script:paused);return @{paused=$script:paused} }
    if ($method -ceq 'semantic-cancel') {
        Fields $value @('token') @('token')
        if($value.token -isnot [string] -or $value.token -cnotmatch '^[0-9a-f]{32}$') { Refuse 'INVALID_REQUEST' }
        $script:prepared.Remove($value.token);return @{cancelled=$true}
    }
    if ($method -ceq 'semantic-prepare') {
        Fields $value @('action') @('action')
        if($script:paused) { Refuse 'SESSION_PAUSED' }
        if(-not $script:indicatorReady -or -not [OrbitWindowsNative]::ActivityCurrent()) { Refuse 'INDICATOR_UNAVAILABLE' }
        $now=[Diagnostics.Stopwatch]::GetTimestamp()
        foreach($key in @($script:prepared.Keys)) { if($script:prepared[$key].expires -le $now) { $script:prepared.Remove($key) } }
        if($script:prepared.Count -ge 8) { Refuse 'LIMIT_REACHED' }
        $element=SemanticAction $value.action
        $token=[guid]::NewGuid().ToString('N')
        $script:prepared[$token]=@{element=$element;fingerprint=[OrbitWindowsNative]::Digest(($value.action|ConvertTo-Json -Compress -Depth 12));expires=$now+5*[Diagnostics.Stopwatch]::Frequency}
        return @{token=$token}
    }
    if ($method -ceq 'semantic-send') {
        Fields $value @('token','action') @('token','action')
        if($value.token -isnot [string] -or $value.token -cnotmatch '^[0-9a-f]{32}$') { Refuse 'INVALID_REQUEST' }
        $prepared=$script:prepared[$value.token];$script:prepared.Remove($value.token)
        if($null -eq $prepared -or $prepared.expires -le [Diagnostics.Stopwatch]::GetTimestamp() -or $prepared.fingerprint -cne [OrbitWindowsNative]::Digest(($value.action|ConvertTo-Json -Compress -Depth 12))) { Refuse 'SEMANTIC_PREPARATION_REQUIRED' }
        return Controlled $value.action {
            if(-not $script:indicatorReady -or -not [OrbitWindowsNative]::ActivityCurrent()) { Refuse 'INDICATOR_UNAVAILABLE' }
            $element=SemanticAction $value.action
            if(-not [object]::ReferenceEquals($element,$prepared.element)) { Refuse 'STALE_REF' }
            [OrbitWindowsNative]::MarkSemanticTarget($element)
            if([OrbitWindowsNative]::OwnerInputRecent()) { Refuse 'OWNER_BUSY' }
            $script:snapshots.Clear()
            if($value.action.type -ceq 'invoke-ref') { [OrbitWindowsNative]::Invoke($script:root,$element,$script:target.pid) }
            else { [OrbitWindowsNative]::SetValue($script:root,$element,$script:target.pid,$value.action.text) }
            return @{delivered=$true;mechanism='native-semantic';disposition=@{delivery='delivered';retry='unsafe'};suggestion='observe-before-retry'}
        }
    }
    if ($method -ceq 'monitors') { Fields $value @(); return @{monitors=[OrbitWindowsNative]::Monitors();workspaceKind='current-visible-desktop';presentation='unsupported';sampled='native-monitor-metadata'} }
    if ($method -ceq 'present') { Refuse 'UNSUPPORTED' }
    if ($method -ceq 'open') {
        Fields $value @('workspace','registration','window') @('workspace','registration'); Workspace $value.workspace
        Fields $value.registration @('applicationId','executable') @('applicationId','executable')
        $registeredExecutable=RegisteredExecutable $value.registration
        $width=960;$height=640
        if($null -ne $value.window) { Fields $value.window @('width','height') @('width','height');if($value.window.width -isnot [int] -or $value.window.height -isnot [int]) { Refuse 'INVALID_REQUEST' };$width=$value.window.width;$height=$value.window.height;if($width -lt 200 -or $width -gt 8192 -or $height -lt 200 -or $height -gt 8192) { Refuse 'INVALID_REQUEST' } }
        return Controlled $value {
            $before=@{}; foreach($row in [OrbitWindowsNative]::Windows()) { $before[$row.address+':'+$row.stableId]=$true }
            $owner=[OrbitWindowsNative]::GetForegroundWindow();$pidNew=[OrbitWindowsNative]::StartOriginal($registeredExecutable);$timer=[Diagnostics.Stopwatch]::StartNew()
            while($timer.ElapsedMilliseconds -lt 10000) {
                $rows=@([OrbitWindowsNative]::Windows() | Where-Object { $_.pid -eq $pidNew -and -not $before.ContainsKey($_.address+':'+$_.stableId) })
                if($rows.Count -gt 1) { break }
                if($rows.Count -eq 1) {
                    $row=$rows[0];$native=[OrbitWindowsNative]::Handle($row.address)
                    if([OrbitWindowsNative]::GetForegroundWindow() -ne $owner) { return @{opened=$false;openingStatus='uncertain';candidateReason='owner-input';workspace=1;workspaceKind='current-visible-desktop';candidates=$rows} }
                    [OrbitWindowsNative]::Place($native,$width,$height);$current=[OrbitWindowsNative]::Describe($native)
                    if($current.stableId -cne $row.stableId -or [OrbitWindowsNative]::GetForegroundWindow() -ne $owner) { Refuse 'OPENING_UNCERTAIN' }
                    return @{opened=$true;openingStatus='opened';identityEvidence='live-new-process-window';workspace=1;workspaceKind='current-visible-desktop';address=$current.address;stableId=$current.stableId;pid=$current.pid;title=$current.title;windowProtocol='win32';applicationLifetime='owner';window=@{width=$current.width;height=$current.height;x=$current.x;y=$current.y};requestedWindow=@{width=$width;height=$height}}
                }
                Start-Sleep -Milliseconds 50
            }
            return @{opened=$false;openingStatus='uncertain';workspace=1;workspaceKind='current-visible-desktop';candidateReason='launch-window-identity-unproven';candidates=@([OrbitWindowsNative]::Windows() | Where-Object { -not $before.ContainsKey($_.address+':'+$_.stableId) })}
        }
    }
    if ($method -ceq 'close-application') { Fields $value @('appId') @('appId');if($value.appId -cne $script:appId) { Refuse 'INVALID_REQUEST' };$script:snapshots.Clear();$script:prepared.Clear();[OrbitWindowsNative]::StopActivity();$script:indicatorReady=$false;$script:root=$null;$script:closed=$true;return @{handedBack=$true} }
    if ($method -cne 'act') { Refuse 'UNSUPPORTED' }
    $allowed=@{windows=@('type','appId');state=@('type','appId','windowId');observe=@('type','appId','windowId','format','refs','digestOnly','observationTimeoutMs');'close-window'=@('type','appId','windowId')}
    if (-not $allowed.ContainsKey($value.type)) { Refuse 'UNSUPPORTED' }
    Fields $value $allowed[$value.type] @('type','appId')
    if($value.type -ceq 'windows') { if($value.appId -cne $script:appId) { Refuse 'INVALID_REQUEST' };return @{windows=(WindowRows)} }
    $current=Target $value
    if($value.type -ceq 'state') { return @{visible=$true;title=$current.title;size=@($current.width,$current.height)} }
    if($value.type -ceq 'close-window') { if(-not $script:indicatorReady) { Refuse 'UNSUPPORTED' };return Controlled $value { [void](Target $value);if(-not [OrbitWindowsNative]::ActivityCurrent()) { Refuse 'INDICATOR_UNAVAILABLE' };[OrbitWindowsNative]::CloseWindow($script:root);return @{closeRequested=$true} } }
    $format='image';if($null -ne $value.format) { $format=$value.format };if($format -cnotin @('image','text','both') -or ($null -ne $value.refs -and $value.refs -isnot [bool])) { Refuse 'INVALID_REQUEST' }
    $frame=@{appId=$script:appId;windowId=$script:windowId;width=$current.width;height=$current.height;surfaceWidth=$current.width;surfaceHeight=$current.height;capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pointer=$null;cursorVariant=0;windows=(WindowRows)}
    if($format -cne 'image') {
        $tree=[OrbitWindowsNative]::Tree($script:root,$current);$snapshot=[guid]::NewGuid().ToString('N')
        if($value.refs) { for($index=0;$index -lt $tree.nodes.Count;$index++) { $tree.nodes[$index]['ref']='@'+$snapshot+':e'+$index } }
        while($tree.nodes.Count -gt 0 -and [Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject @($tree.nodes) -Compress -Depth 8)) -gt 16000) { $tree.nodes.RemoveAt($tree.nodes.Count-1);$tree.handles.RemoveAt($tree.handles.Count-1);$tree.truncated='bytes' }
        if($value.refs -and $tree.nodes.Count -gt 0) { if($script:snapshots.Count -ge 4) { $old=@($script:snapshots.GetEnumerator()|Sort-Object {$_.Value.expires}|Select-Object -First 1)[0];$script:snapshots.Remove($old.Key) };$script:snapshots[$snapshot]=@{expires=[Diagnostics.Stopwatch]::GetTimestamp()+30*[Diagnostics.Stopwatch]::Frequency;handles=$tree.handles} }
        $frame.tree=@{status='ok';toolkit='UIAutomation';nodes=@($tree.nodes);truncated=$tree.truncated;complete=$null -eq $tree.truncated}
        if($tree.nodes.Count -eq 0) { $frame.tree=@{status='unavailable';reason='native accessibility tree unavailable'} }
        [void](VerifyReadTarget $value $current)
        if($format -ceq 'text' -and $tree.nodes.Count -gt 0) { $frame.mimeType='text/x-orbit-a11y';return $frame }
    }
    $png=[OrbitWindowsNative]::Capture($current.address,$current.stableId)
    [void](VerifyReadTarget $value $current)
    if($value.digestOnly) { $hash=[Security.Cryptography.SHA256]::Create();try{return @{sha256=([BitConverter]::ToString($hash.ComputeHash($png))).Replace('-','').ToLowerInvariant()}}finally{$hash.Dispose()} }
    $frame.mimeType='image/png';$frame.image=[Convert]::ToBase64String($png);return $frame
}

$cache=@{};$cacheBytes=0;$lastImageRequest=$null
try {
    while($null -ne ($line=[OrbitWindowsNative]::ReadLine())) {
        $requestId=$null;$fingerprint=$null
        try {
            $request=$line|ConvertFrom-Json;Fields $request @('requestId','method','params') @('requestId','method','params')
            $requestId=$request.requestId;if($requestId -isnot [string] -or $requestId -cnotmatch '^[0-9a-f]{32}$') { break }
            $fingerprint=[OrbitWindowsNative]::Digest((ConvertTo-Json -InputObject @($request.method,$request.params) -Compress -Depth 16))
            if($cache.ContainsKey($requestId)) {
                if($cache[$requestId].fingerprint -cne $fingerprint) { Refuse 'INVALID_REQUEST' }
                $reply=$cache[$requestId].response
            } else {
                if($cache.Count -ge 1024 -or $cacheBytes -gt 4128768) { Refuse 'LIMIT_REACHED' }
                $result=Request $request.method $request.params
                $reply=@{requestId=$requestId;ok=$true;result=$result}
                if($null -ne $result.image) {
                    if($null -ne $lastImageRequest) { $cache[$lastImageRequest].response=@{requestId=$lastImageRequest;ok=$false;error=@{code='REPLAY_EXPIRED';message='Older capture reply expired'}} }
                    $lastImageRequest=$requestId
                }
            }
        } catch {
            $errorObject=$_.Exception;$code='BACKEND_ERROR'
            for($depth=0;$null -ne $errorObject -and $depth -lt 8;$depth++) { if($errorObject -is [OrbitNativeFailure]) { $code=$errorObject.Code;break };$errorObject=$errorObject.InnerException }
            $reply=@{requestId=$requestId;ok=$false;error=@{code=$code;message='Native platform request refused'}}
        }
        if($null -ne $fingerprint -and -not $cache.ContainsKey($requestId) -and $cache.Count -lt 1024) {
            $cache[$requestId]=@{fingerprint=$fingerprint;response=$reply}
            $metadata=$reply
            if($null -ne $reply.result.image) { $body=@{};foreach($key in $reply.result.Keys) { if($key -cne 'image') { $body[$key]=$reply.result[$key] } };$metadata=@{requestId=$requestId;ok=$true;result=$body} }
            $cacheBytes+=[Text.Encoding]::UTF8.GetByteCount(($metadata|ConvertTo-Json -Compress -Depth 20))
        }
        $encoded=$reply|ConvertTo-Json -Compress -Depth 20
        if([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 25165824) { break }
        [Console]::Out.WriteLine($encoded);[Console]::Out.Flush()
    }
} finally { $script:snapshots.Clear();$script:prepared.Clear();[OrbitWindowsNative]::StopActivity();$script:root=$null;$script:target=$null }

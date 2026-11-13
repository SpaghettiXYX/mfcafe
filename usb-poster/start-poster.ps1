param(
    [string]$Url = "",
    [string]$Browser = ""
)

# Work in real pixels so the monitor rectangles are not DPI-scaled.
try {
    Add-Type -Namespace Post -Name Dpi -MemberDefinition @'
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
'@ -ErrorAction Stop
    [Post.Dpi]::SetProcessDpiAwareness(2) | Out-Null
} catch {
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ScreenInfo
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc cb, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO mi);

    public static List<int[]> Get()
    {
        var list = new List<int[]>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d)
        {
            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(h, ref mi))
            {
                bool primary = (mi.dwFlags & 1) != 0;
                list.Add(new int[] {
                    mi.rcMonitor.Left, mi.rcMonitor.Top,
                    mi.rcMonitor.Right - mi.rcMonitor.Left,
                    mi.rcMonitor.Bottom - mi.rcMonitor.Top,
                    primary ? 1 : 0
                });
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@

$monitors = [ScreenInfo]::Get()
# Prefer the largest non-primary display (that is the USB panel).
$target = $monitors | Where-Object { $_[4] -eq 0 } | Sort-Object { $_[2] * $_[3] } -Descending | Select-Object -First 1
if (-not $target) { $target = $monitors | Select-Object -First 1 }
if (-not $target) { Write-Error "No display detected"; exit 1 }

$x = $target[0]; $y = $target[1]; $w = $target[2]; $h = $target[3]
Write-Host ("Target display: {0}x{1} at {2},{3}" -f $w, $h, $x, $y)

if (-not $Url) {
    $candidates = @("$PSScriptRoot\poster.html", "$PSScriptRoot\..\poster.html")
    $Url = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Url) { Write-Error "poster.html not found (put it next to this script)"; exit 1 }
}
$uri = ([System.Uri]$Url).AbsoluteUri

if (-not $Browser) {
    $Browser = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Browser) { Write-Error "Edge or Chrome not found"; exit 1 }

$profileDir = Join-Path $env:TEMP "usb-poster-profile"
$argList = @(
    "--app=$uri",
    "--window-position=$x,$y",
    "--window-size=$w,$h",
    "--user-data-dir=$profileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,msEdgeTranslate",
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1"
)

Start-Process -FilePath $Browser -ArgumentList $argList

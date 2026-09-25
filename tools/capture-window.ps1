param(
  [string]$ProcessName = "shotcut",
  [string]$Out = "window.png",
  [string]$TitleLike,    # optional: prefer a window whose title matches
  [int[]]$Crop,          # optional: x,y,w,h inside the window
  [double]$Scale = 1.0
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct RECT { public int L, T, R, B; }
public class WC {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@ -ErrorAction SilentlyContinue

# Without this the shell is a scaled (DPI-unaware) process: GetWindowRect reports
# virtualised coordinates and PrintWindow silently renders a top-left crop of the
# real window.
[WC]::SetProcessDPIAware() | Out-Null

$procIds = (Get-Process $ProcessName -ErrorAction Stop).Id
if (-not $procIds) { throw "no process named $ProcessName" }

# Electron and Qt apps spread windows across helper processes, and MainWindowHandle
# often points at an off-screen helper, so enumerate every top-level window instead.
$cands = New-Object System.Collections.ArrayList
$cb = [WC+EnumProc]{
  param($h, $p)
  $wpid = 0
  [WC]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  if ($procIds -contains $wpid -and [WC]::IsWindowVisible($h)) {
    $r = New-Object RECT
    [WC]::GetWindowRect($h, [ref]$r) | Out-Null
    $sb = New-Object System.Text.StringBuilder 512
    [WC]::GetWindowText($h, $sb, 512) | Out-Null
    $null = $cands.Add([pscustomobject]@{
      H = $h; Title = $sb.ToString(); W = $r.R - $r.L; T = $r.B - $r.T
    })
  }
  return $true
}
[WC]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($cands.Count -eq 0) { throw "no visible window for $ProcessName" }

$pick = $null
if ($TitleLike) {
  $pick = $cands | Where-Object { $_.Title -like $TitleLike } |
          Sort-Object { $_.W * $_.T } -Descending | Select-Object -First 1
}
if (-not $pick) { $pick = $cands | Sort-Object { $_.W * $_.T } -Descending | Select-Object -First 1 }

$hwnd = $pick.H
$w = $pick.W; $h = $pick.T
if ($w -lt 50 -or $h -lt 50) { throw "window too small ($w x $h), still starting? title='$($pick.Title)'" }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT, needed for composited/DWM windows
[WC]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()

$final = $bmp
if ($Crop -and $Crop.Count -eq 4) {
  $rect = New-Object System.Drawing.Rectangle($Crop[0], $Crop[1], $Crop[2], $Crop[3])
  $final = $bmp.Clone($rect, $bmp.PixelFormat)
}
if ($Scale -ne 1.0) {
  $sw = [int]($final.Width * $Scale); $sh = [int]($final.Height * $Scale)
  $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g2.DrawImage($final, 0, 0, $sw, $sh)
  $g2.Dispose()
  $final = $scaled
}
$final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "saved $Out  window=${w}x${h}  title='$($pick.Title)'"

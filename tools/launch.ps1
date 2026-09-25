param(
  [string]$Qss  = "C:\Users\Gavl\Desktop\my project\VIDEO EDITHOR\theme\capcut.qss",
  [switch]$NoQss,
  [int]$Wait = 12
)
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r);
}
"@ -ErrorAction SilentlyContinue

Get-Process shotcut -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$exe = "$env:LOCALAPPDATA\Programs\Shotcut\shotcut.exe"
if ($NoQss) {
  Start-Process $exe
} else {
  Start-Process $exe -ArgumentList "-stylesheet", $Qss
}
Start-Sleep -Seconds $Wait

$p = Get-Process shotcut -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [Win32]::ShowWindow($p.MainWindowHandle, 3) | Out-Null   # SW_MAXIMIZE
  [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Seconds 3
  Write-Output "OK pid=$($p.Id) title=$($p.MainWindowTitle)"
} else {
  Write-Output "NO WINDOW"
}

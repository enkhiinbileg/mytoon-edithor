param(
  [Parameter(Mandatory=$true)][string]$Action,   # click | drag
  [int]$X, [int]$Y, [int]$X2, [int]$Y2
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  public const uint DOWN = 0x0002, UP = 0x0004;
}
"@ -ErrorAction SilentlyContinue

switch ($Action) {
  "click" {
    [M]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 250
    [M]::mouse_event([M]::DOWN,0,0,0,0); Start-Sleep -Milliseconds 60
    [M]::mouse_event([M]::UP,0,0,0,0)
  }
  "drag" {
    [M]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 300
    [M]::mouse_event([M]::DOWN,0,0,0,0); Start-Sleep -Milliseconds 200
    # move in steps so Qt tracks the drag
    $steps = 24
    for ($i = 1; $i -le $steps; $i++) {
      $cx = [int]($X + ($X2 - $X) * $i / $steps)
      $cy = [int]($Y + ($Y2 - $Y) * $i / $steps)
      [M]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 200
    [M]::mouse_event([M]::UP,0,0,0,0)
  }
}
Start-Sleep -Milliseconds 600
Write-Output "$Action done"

param([string]$OutputPath = "docs/screenshots/desktop-home.png")
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowBounds {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect bounds);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
}
'@

$appProcess = Get-Process athenas-agent -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $appProcess) { throw 'Janela do Athenas Agent não encontrada.' }
$bounds = New-Object WindowBounds+Rect
if (-not [WindowBounds]::GetWindowRect($appProcess.MainWindowHandle, [ref]$bounds)) { throw 'Falha ao obter limites da janela.' }
$width = $bounds.Right - $bounds.Left
$height = $bounds.Bottom - $bounds.Top
if ($width -lt 200 -or $height -lt 200) { throw 'Janela pequena demais para capturar.' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $dc = $graphics.GetHdc()
    try {
        if (-not [WindowBounds]::PrintWindow($appProcess.MainWindowHandle, $dc, 2)) { throw 'PrintWindow falhou.' }
    } finally { $graphics.ReleaseHdc($dc) }
    $visiblePixels = 0
    for ($y = 0; $y -lt $height; $y += 20) {
        for ($x = 0; $x -lt $width; $x += 20) {
            $pixel = $bitmap.GetPixel($x, $y)
            if ($pixel.R -gt 45 -or $pixel.G -gt 45 -or $pixel.B -gt 45) { $visiblePixels++ }
        }
    }
    if ($visiblePixels -lt 10) { throw 'A captura veio preta; a sessão Windows não expôs a WebView.' }
    $bitmap.Save((Join-Path (Get-Location) $OutputPath), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

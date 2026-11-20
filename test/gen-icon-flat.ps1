param([string]$OutDir = (Join-Path $PSScriptRoot "..\public\icons"))
Add-Type -AssemblyName System.Drawing

$radii = @(1.00, 0.74, 0.88, 0.68, 1.02, 0.78, 0.92, 0.70, 0.98, 0.80, 0.90, 0.76)
$drops = @(@(150,108,17), @(388,148,12), @(398,330,20), @(128,330,10), @(268,62,9))
$INK = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)   # #8b5cf6
$BG  = [System.Drawing.Color]::FromArgb(255, 15, 15, 19)     # #0f0f13

function New-Icon($size, $path, $maskable) {
  $scale = $size / 512.0
  $cx = 256 * $scale; $cy = 256 * $scale; $R = 118 * $scale
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'

  if ($maskable) {
    $g.Clear($BG)
  } else {
    $g.Clear([System.Drawing.Color]::Transparent)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 112 * $scale
    $d = 2 * $r
    $bgPath.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $bgPath.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $bgPath.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $bgPath.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $bgPath.CloseFigure()
    $bgBrush = New-Object System.Drawing.SolidBrush($BG)
    $g.FillPath($bgBrush, $bgPath)
  }

  $pts = New-Object 'System.Drawing.PointF[]' $radii.Length
  for ($i = 0; $i -lt $radii.Length; $i++) {
    $a = ($i * 30 - 90) * [Math]::PI / 180
    $rr = $R * $radii[$i]
    $pts[$i] = New-Object System.Drawing.PointF([single]($cx + [Math]::Cos($a) * $rr), [single]($cy + [Math]::Sin($a) * $rr))
  }
  $blob = New-Object System.Drawing.Drawing2D.GraphicsPath
  $blob.AddClosedCurve($pts, 0.9)
  $ink = New-Object System.Drawing.SolidBrush($INK)
  $g.FillPath($ink, $blob)

  foreach ($d in $drops) {
    $dx = [single]($d[0] * $scale); $dy = [single]($d[1] * $scale); $dr = [single]($d[2] * $scale)
    $g.FillEllipse($ink, $dx - $dr, $dy - $dr, 2 * $dr, 2 * $dr)
  }

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $path"
}

New-Icon 192 (Join-Path $OutDir 'icon-192.png') $false
New-Icon 512 (Join-Path $OutDir 'icon-512.png') $false
New-Icon 512 (Join-Path $OutDir 'icon-maskable-512.png') $true

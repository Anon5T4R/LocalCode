Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot "icon.png"
$dir = $PSScriptRoot

if (!(Test-Path $src)) { Write-Error "icon.png not found"; exit 1 }

$img = [System.Drawing.Image]::FromFile($src)
$sizes = @(16, 24, 32, 48, 64, 96, 128, 256)

# Build ICO: header + directory entries + PNG data
$icoHeader = New-Object byte[] 6
[System.IO.MemoryStream]::new() | ForEach-Object { $_.Close() }
$icoDataStream = [System.IO.MemoryStream]::new()
$icoDirStream = [System.IO.MemoryStream]::new()

$icoHeader[0] = 0; $icoHeader[1] = 0  # reserved
$icoHeader[2] = 1; $icoHeader[3] = 0  # ICO type
$icoHeader[4] = [byte]$sizes.Count; $icoHeader[5] = 0  # count

$dataOffset = 6 + $sizes.Count * 16
$entries = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()

    # Save per-size PNGs for Tauri
    if ($size -eq 32) { $bmp.Save((Join-Path $dir "icon_32x32.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
    if ($size -eq 128) { $bmp.Save((Join-Path $dir "icon_128x128.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
    if ($size -eq 256) { $bmp.Save((Join-Path $dir "icon_128x128@2x.png"), [System.Drawing.Imaging.ImageFormat]::Png) }

    # Save PNG bytes into memory for ICO
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()

    $entryStream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($entryStream)
    $w = if ($size -ge 256) { 0 } else { $size }
    $h = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$w)  # width
    $writer.Write([byte]$h)  # height
    $writer.Write([byte]0)   # colors
    $writer.Write([byte]0)   # reserved
    $writer.Write([uint16]1) # planes
    $writer.Write([uint16]32) # bpp
    $writer.Write([uint32]$pngBytes.Length)  # size
    $writer.Write([uint32]$dataOffset)       # offset
    $writer.Flush()
    $entries += $entryStream.ToArray()
    $writer.Close()
    $entryStream.Close()

    $icoDataStream.Write($pngBytes, 0, $pngBytes.Length)
    $dataOffset += $pngBytes.Length
}

# Write ICO file
$icoStream = [System.IO.File]::Open((Join-Path $dir "icon.ico"), [System.IO.FileMode]::Create)
$icoStream.Write($icoHeader, 0, 6)
foreach ($entry in $entries) { $icoStream.Write($entry, 0, $entry.Length) }
$icoDataStream.Position = 0
$icoDataStream.CopyTo($icoStream)
$icoStream.Close()
$icoDataStream.Close()

# ICNS: just copy the 256x256 PNG (macOS will accept it)
Copy-Item (Join-Path $dir "icon_128x128@2x.png") (Join-Path $dir "icon.icns") -Force

$img.Dispose()
Write-Output "Icons regenerated from $src"

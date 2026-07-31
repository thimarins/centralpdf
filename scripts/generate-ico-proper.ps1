Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePng = Join-Path $scriptDir "..\build\icon.png"
$outputIco = Join-Path $scriptDir "..\build\icon.ico"
$outputPng = Join-Path $scriptDir "..\build\icon.png"

if (-not (Test-Path -LiteralPath $sourcePng)) {
    Write-Error "PNG fonte nao encontrado em: $sourcePng"
    exit 1
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$sourceImg = [System.Drawing.Image]::FromFile($sourcePng)

# Save 512x512 PNG for reference
$png512 = New-Object System.Drawing.Bitmap(512, 512)
$g = [System.Drawing.Graphics]::FromImage($png512)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($sourceImg, 0, 0, 512, 512)
$g.Dispose()
$png512.Save($outputPng, [System.Drawing.Imaging.ImageFormat]::Png)
$png512.Dispose()
Write-Host "icon.png 512x512 saved"

# Buffers to store generated image data for ICO
$imageBuffers = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($sourceImg, 0, 0, $size, $size)
    $g.Dispose()

    if ($size -eq 256) {
        # Save 256x256 as PNG
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
        $ms.Dispose()
        $imageBuffers += ,$bytes
        Write-Host "Frame 256x256 (PNG) generated"
    } else {
        # Save smaller sizes as uncompressed 32-bit BMP (DIB)
        $ms = New-Object System.IO.MemoryStream
        
        # DIB Header (BITMAPINFOHEADER) - 40 bytes
        $ms.Write([BitConverter]::GetBytes([uint32]40), 0, 4)     # biSize
        $ms.Write([BitConverter]::GetBytes([int32]$size), 0, 4)    # biWidth
        $ms.Write([BitConverter]::GetBytes([int32]($size * 2)), 0, 4) # biHeight (XOR + AND mask height)
        $ms.Write([BitConverter]::GetBytes([uint16]1), 0, 2)      # biPlanes
        $ms.Write([BitConverter]::GetBytes([uint16]32), 0, 2)     # biBitCount (32-bit BGRA)
        $ms.Write([BitConverter]::GetBytes([uint32]0), 0, 4)      # biCompression (0 = BI_RGB)
        
        $xorSize = $size * $size * 4
        # Calculate AND mask row size (1 bit per pixel, padded to 4-byte boundaries)
        $andRowSize = [math]::Ceiling($size / 32) * 4
        $andSize = $andRowSize * $size
        
        $ms.Write([BitConverter]::GetBytes([uint32]($xorSize + $andSize)), 0, 4) # biSizeImage
        $ms.Write([BitConverter]::GetBytes([int32]0), 0, 4)       # biXPelsPerMeter
        $ms.Write([BitConverter]::GetBytes([int32]0), 0, 4)       # biYPelsPerMeter
        $ms.Write([BitConverter]::GetBytes([uint32]0), 0, 4)      # biClrUsed
        $ms.Write([BitConverter]::GetBytes([uint32]0), 0, 4)      # biClrImportant

        # XOR Mask (BGRA pixel bytes)
        # BMP pixels are stored bottom-to-top, left-to-right
        for ($y = $size - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $size; $x++) {
                $color = $bmp.GetPixel($x, $y)
                $ms.WriteByte($color.B)
                $ms.WriteByte($color.G)
                $ms.WriteByte($color.R)
                $ms.WriteByte($color.A)
            }
        }

        # AND Mask (1 bit per pixel transparency mask)
        # 0 = opaque, 1 = transparent. Padded to 4-byte boundary per row.
        for ($y = $size - 1; $y -ge 0; $y--) {
            $rowBytes = New-Object byte[] $andRowSize
            for ($x = 0; $x -lt $size; $x++) {
                $color = $bmp.GetPixel($x, $y)
                # If transparent, set bit to 1
                if ($color.A -lt 128) {
                    $byteIdx = [math]::Floor($x / 8)
                    $bitIdx = 7 - ($x % 8)
                    $rowBytes[$byteIdx] = $rowBytes[$byteIdx] -bor (1 -shl $bitIdx)
                }
            }
            $ms.Write($rowBytes, 0, $andRowSize)
        }

        $bytes = $ms.ToArray()
        $ms.Dispose()
        $imageBuffers += ,$bytes
        Write-Host "Frame ${size}x${size} (BMP/DIB) generated"
    }
    $bmp.Dispose()
}
$sourceImg.Dispose()

# Build ICO File Header and Directory Entries
$count = $sizes.Count
$headerSize = 6
$dirEntrySize = 16
$dataOffset = $headerSize + ($dirEntrySize * $count)

$ms = New-Object System.IO.MemoryStream

# ICO Header
$ms.Write([byte[]](0, 0, 1, 0, $count, 0), 0, 6)

# Calculate Offsets
$offsets = @()
$currentOffset = $dataOffset
for ($i = 0; $i -lt $count; $i++) {
    $offsets += $currentOffset
    $currentOffset += $imageBuffers[$i].Length
}

# Write Directory Entries
for ($i = 0; $i -lt $count; $i++) {
    $size = $sizes[$i]
    $w = if ($size -eq 256) { 0 } else { $size }
    $h = if ($size -eq 256) { 0 } else { $size }
    
    $ms.WriteByte($w) # width
    $ms.WriteByte($h) # height
    $ms.WriteByte(0)  # color count (0 for 256+ colors)
    $ms.WriteByte(0)  # reserved
    $ms.Write([BitConverter]::GetBytes([uint16]1), 0, 2)  # planes
    $ms.Write([BitConverter]::GetBytes([uint16]32), 0, 2) # bit count
    $ms.Write([BitConverter]::GetBytes([uint32]$imageBuffers[$i].Length), 0, 4) # size of data
    $ms.Write([BitConverter]::GetBytes([uint32]$offsets[$i]), 0, 4)             # offset
}

# Write Image Data
for ($i = 0; $i -lt $count; $i++) {
    $ms.Write($imageBuffers[$i], 0, $imageBuffers[$i].Length)
}

[System.IO.File]::WriteAllBytes($outputIco, $ms.ToArray())
$ms.Dispose()

$finalSize = (Get-Item $outputIco).Length
Write-Host "Valid icon.ico created successfully - $finalSize bytes"

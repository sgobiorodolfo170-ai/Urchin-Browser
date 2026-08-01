Add-Type -AssemblyName System.Drawing

$src = "G:\pj\pj--ing\111111\Urchin-Browser\apps\desktop\ico\61c359892bac24a7500ece0e10a807e6.jpg"
$buildDir = "G:\pj\pj--ing\111111\Urchin-Browser\apps\desktop\build"
$icoDir = "G:\pj\pj--ing\111111\Urchin-Browser\apps\desktop\ico"
if(!(Test-Path $buildDir)){ New-Item -ItemType Directory -Path $buildDir | Out-Null }

# 加载
$bmp = New-Object System.Drawing.Bitmap($src)
"Source: $($bmp.Width)x$($bmp.Height) PixelFormat=$($bmp.PixelFormat)"

# 动态采样四角背景色（取均值）
$corners = @(
  $bmp.GetPixel(2,2),
  $bmp.GetPixel($bmp.Width-3,2),
  $bmp.GetPixel(2,$bmp.Height-3),
  $bmp.GetPixel($bmp.Width-3,$bmp.Height-3)
)
$bgR = [int](($corners[0].R + $corners[1].R + $corners[2].R + $corners[3].R) / 4)
$bgG = [int](($corners[0].G + $corners[1].G + $corners[2].G + $corners[3].G) / 4)
$bgB = [int](($corners[0].B + $corners[1].B + $corners[2].B + $corners[3].B) / 4)
"Background sampled: R=$bgR G=$bgG B=$bgB"
$p00 = $bmp.GetPixel(0,0)
"Pixel(0,0): R=$($p00.R) G=$($p00.G) B=$($p00.B)"

# 边界框（基于精确扫描结果硬编码：JPG 压缩噪点会干扰动态检测）
# 之前步长4精确扫描得到：BBox (224,208)-(1220,1244)，中心 (722,726)，边长 997
$cx = 722; $cy = 726; $side = 1005
$x0 = $cx - [int]($side/2); $y0 = $cy - [int]($side/2)
"cropFrom=($x0,$y0) side=$side"

# 裁剪：用 DrawImage（Clone 重载在 PS 里不稳）
$cropped = New-Object System.Drawing.Bitmap($side, $side)
$g = [System.Drawing.Graphics]::FromImage($cropped)
$g.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0,0,$side,$side)), $x0, $y0, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $bmp.Dispose()
"Cropped: $($cropped.Width)x$($cropped.Height)"

# 圆角透明 PNG 生成
function New-RoundedBitmap($srcBmp, $size, $radiusRatio){
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $out.SetResolution(96,96)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $radius = [int]($size * $radiusRatio)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = $radius
  $path.AddArc(0,0,$r,$r,180,90)
  $path.AddArc($size-$r,0,$r,$r,270,90)
  $path.AddArc($size-$r,$size-$r,$r,$r,0,90)
  $path.AddArc(0,$size-$r,$r,$r,90,90)
  $path.CloseFigure()
  $rgn = New-Object System.Drawing.Region($path)
  $g.SetClip($rgn, [System.Drawing.Drawing2D.CombineMode]::Replace)
  $g.DrawImage($srcBmp, (New-Object System.Drawing.Rectangle(0,0,$size,$size)), (New-Object System.Drawing.Rectangle(0,0,$srcBmp.Width,$srcBmp.Height)), [System.Drawing.GraphicsUnit]::Pixel)
  $g.ResetClip()
  $g.Dispose(); $path.Dispose(); $rgn.Dispose()
  return $out
}

# 多尺寸 PNG
$sizes = @(16,32,48,64,128,256,512)
$pngBytes = @{}
foreach($s in $sizes){
  $rounded = New-RoundedBitmap $cropped $s 0.22
  $p = Join-Path $icoDir "icon-$s.png"
  $rounded.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $ms = New-Object System.IO.MemoryStream
  $rounded.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes[$s] = $ms.ToArray()
  $ms.Dispose(); $rounded.Dispose()
  "Saved icon-$s.png"
}

# build/icon.png（512）
Copy-Item (Join-Path $icoDir "icon-512.png") (Join-Path $buildDir "icon.png") -Force
"Copied build/icon.png"

# 多尺寸 ICO（直接流式写入文件，避免 PS 数组展开问题）
$icoSizes = @(16,32,48,64,128,256)
$icoPath = Join-Path $buildDir "icon.ico"
# 先收集各尺寸文件字节长度
$meta = @()
foreach($s in $icoSizes){
  $f = Join-Path $icoDir "icon-$s.png"
  $fi = Get-Item $f
  $meta += [pscustomobject]@{ Size=$s; File=$f; Len=$fi.Length }
}
$headerSize = 6 + 16 * $meta.Count
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
# ICONDIR
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$meta.Count)
# ICONDIRENTRY
$dataOffset = $headerSize
foreach($m in $meta){
  $w = if($m.Size -ge 256){[byte]0}else{[byte]$m.Size}
  $bw.Write($w)
  $bw.Write($w)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$m.Len)
  $bw.Write([uint32]$dataOffset)
  $dataOffset += $m.Len
}
# 图像数据
foreach($m in $meta){
  $bytes = [System.IO.File]::ReadAllBytes($m.File)
  $bw.Write($bytes)
}
$bw.Flush()
$bw.Dispose(); $fs.Dispose()
"Saved build/icon.ico ($($meta.Count) sizes: $($icoSizes -join ','))"

$cropped.Dispose()
"DONE"

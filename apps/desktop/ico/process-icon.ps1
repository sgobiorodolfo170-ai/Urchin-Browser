# 应用图标生成：单张源图 → 多尺寸 PNG + Windows ICO + 渲染层品牌图标
#
# 依据：AGENTS.md §七（注释记录设计理由）与 electron-builder.yml extraResources。
# 设计理由：
# - 源图为带透明通道的圆形球体，按 alpha 包围盒自动裁切并居中补透明边距；
#   不套圆角矩形遮罩——球体本身即圆角轮廓，遮罩只会无谓裁掉边缘像素。
# - 尺寸集合覆盖 Windows 任务栏（16/32）、文件资源管理器（48/64/128）与
#   ICO 最大尺寸（256）；512 PNG 供 electron-builder 与非 Windows 窗口图标使用。
# - 输出路径固定为 build/icon.ico（安装包/EXE/窗口图标）与
#   src/renderer/public/browser-icon.png（标题栏/标签页/新标签页占位）。

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$icoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path (Split-Path -Parent $icoDir) 'build'
$src = Join-Path $icoDir 'icon-source.png'
$rendererIcon = Join-Path (Split-Path -Parent $icoDir) 'src\renderer\public\browser-icon.png'

if (!(Test-Path -LiteralPath $src)) {
  throw "Source image not found: $src"
}
if (!(Test-Path -LiteralPath $buildDir)) {
  New-Item -ItemType Directory -Path $buildDir | Out-Null
}

# 1) 读取源图并按 alpha 包围盒定位内容（阈值 16 过滤 JPEG/抗锯齿噪点）
$bmp = New-Object System.Drawing.Bitmap($src)
"Source: $($bmp.Width)x$($bmp.Height) PixelFormat=$($bmp.PixelFormat)"

$minX = $bmp.Width
$minY = $bmp.Height
$maxX = -1
$maxY = -1
for ($y = 0; $y -lt $bmp.Height; $y++) {
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    if ($bmp.GetPixel($x, $y).A -ge 16) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0 -or $maxY -lt 0) {
  $bmp.Dispose()
  throw 'Source image contains no visible pixels'
}

$contentW = $maxX - $minX + 1
$contentH = $maxY - $minY + 1
# 6% 总留白（每边 3%）：让球体在任务栏/资源管理器小尺寸下不顶满边缘
$side = [int][Math]::Ceiling([Math]::Max($contentW, $contentH) * 1.06)
$cx = ($minX + $maxX) / 2.0
$cy = ($minY + $maxY) / 2.0
$offsetX = [int][Math]::Round($cx - $side / 2.0)
$offsetY = [int][Math]::Round($cy - $side / 2.0)
"Content bbox=($minX,$minY)-($maxX,$maxY) size=${contentW}x${contentH}; square=$side offset=($offsetX,$offsetY)"

# 2) 生成方形透明画布（源图整体平移到居中位置，避免源矩形越界）
$square = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$square.SetResolution(96, 96)
$g = [System.Drawing.Graphics]::FromImage($square)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($bmp, (New-Object System.Drawing.Rectangle(-$offsetX, -$offsetY, $bmp.Width, $bmp.Height)))
$g.Dispose()
$bmp.Dispose()

# 3) 缩放生成各尺寸 PNG（SourceCopy 保证透明像素不被预乘/串色）
$sizes = @(16, 32, 48, 64, 128, 256, 512)
foreach ($s in $sizes) {
  $out = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $out.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $destRect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $g.DrawImage($square, $destRect, 0, 0, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $out.Save((Join-Path $icoDir "icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "Saved icon-$s.png"
}

# 4) 512 PNG 同时作为 electron-builder 后备图标与非 Windows 窗口图标
Copy-Item (Join-Path $icoDir 'icon-512.png') (Join-Path $buildDir 'icon.png') -Force
"Copied build/icon.png"

# 5) 128 PNG 作为渲染层品牌图标（标题栏/标签页占位/新标签页）
if (!(Test-Path -LiteralPath (Split-Path -Parent $rendererIcon))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $rendererIcon) | Out-Null
}
Copy-Item (Join-Path $icoDir 'icon-128.png') $rendererIcon -Force
"Copied src/renderer/public/browser-icon.png"

# 6) 多尺寸 ICO（PNG 嵌入，Vista+ 支持；256 的宽高字段写 0）
$icoSizes = @(16, 32, 48, 64, 128, 256)
$meta = @()
foreach ($s in $icoSizes) {
  $file = Join-Path $icoDir "icon-$s.png"
  $meta += [pscustomobject]@{ Size = $s; File = $file; Len = (Get-Item $file).Length }
}
$headerSize = 6 + 16 * $meta.Count
$icoPath = Join-Path $buildDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$meta.Count)
$dataOffset = $headerSize
foreach ($m in $meta) {
  $w = if ($m.Size -ge 256) { [byte]0 } else { [byte]$m.Size }
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
foreach ($m in $meta) {
  $bw.Write([System.IO.File]::ReadAllBytes($m.File))
}
$bw.Flush()
$bw.Dispose()
$fs.Dispose()
"Saved build/icon.ico ($($meta.Count) sizes: $($icoSizes -join ','))"

$square.Dispose()
"DONE"

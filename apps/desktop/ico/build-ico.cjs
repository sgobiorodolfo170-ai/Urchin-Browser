// 从已生成的各尺寸 PNG 构建 multi-size ICO（PNG 嵌入，Vista+ 支持）
const fs = require('fs');
const path = require('path');

const icoDir = __dirname;
const buildDir = path.join(__dirname, '..', 'build');
const sizes = [16, 32, 48, 64, 128, 256];

// 读取各尺寸 PNG 字节
const entries = sizes.map((s) => {
  const file = path.join(icoDir, `icon-${s}.png`);
  const data = fs.readFileSync(file);
  return { size: s, data };
});

const headerSize = 6 + 16 * entries.length;
const totalSize = headerSize + entries.reduce((sum, e) => sum + e.data.length, 0);
const buf = Buffer.alloc(totalSize);
let offset = 0;

// ICONDIR
buf.writeUInt16LE(0, offset);
offset += 2; // reserved
buf.writeUInt16LE(1, offset);
offset += 2; // type=icon
buf.writeUInt16LE(entries.length, offset);
offset += 2; // count

// ICONDIRENTRY
let dataOffset = headerSize;
for (const e of entries) {
  const w = e.size >= 256 ? 0 : e.size;
  buf.writeUInt8(w, offset);
  offset += 1; // width
  buf.writeUInt8(w, offset);
  offset += 1; // height
  buf.writeUInt8(0, offset);
  offset += 1; // colorCount
  buf.writeUInt8(0, offset);
  offset += 1; // reserved
  buf.writeUInt16LE(1, offset);
  offset += 2; // planes
  buf.writeUInt16LE(32, offset);
  offset += 2; // bitCount
  buf.writeUInt32LE(e.data.length, offset);
  offset += 4; // bytesInRes
  buf.writeUInt32LE(dataOffset, offset);
  offset += 4; // imageOffset
  dataOffset += e.data.length;
}

// 图像数据
for (const e of entries) {
  e.data.copy(buf, offset);
  offset += e.data.length;
}

if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
const icoPath = path.join(buildDir, 'icon.ico');
fs.writeFileSync(icoPath, buf);
console.log(
  `Saved ${icoPath} (${entries.length} sizes: ${sizes.join(',')}, ${(buf.length / 1024).toFixed(1)} KB)`,
);

// 同时复制 512 PNG 作为 build/icon.png（electron-builder 后备）
const pngSrc = path.join(icoDir, 'icon-512.png');
const pngDst = path.join(buildDir, 'icon.png');
fs.copyFileSync(pngSrc, pngDst);
console.log(`Copied ${pngDst}`);

/**
 * GenOffice 嵌入构建脚本（阶段 1：md 打样）
 *
 * 职责：把 vendor/genoffice 里的编辑器构建产物与宿主嵌入包产出到磁盘，
 * 供 Urchin 主进程运行时加载（开发态直接读 vendor 路径；打包态经
 * electron-builder extraResources 复制到 resources/genoffice）。
 *
 * 步骤：
 * 1. 确保 vendor/genoffice/node_modules 存在（缺失时执行 npm ci；首次或
 *    上游依赖变更后需联网）
 * 2. 构建目标编辑器（默认 markdown）的 main/preload/renderer 产物
 *    （main 产物本脚本不使用——宿主只加载 embed 包；但 electron-vite 一次
 *    构建三目标，无法只选 preload/renderer，全建代价可接受）
 * 3. 构建 @genoffice/urchin-embed → out/main/index.js（宿主唯一运行时入口）
 * 3.5 从嵌入包抽取 scheme-privileges.json（宿主启动早期只读的轻量常量，
 *     见 genoffice-extract-scheme-privileges.mjs）
 * 4. 校验全部产物路径存在，缺失即非零退出（CI/打包前置门禁）
 *
 * 用法：node scripts/genoffice-build.mjs [app...]   # 默认构建全部受支持 app
 *       node scripts/genoffice-build.mjs --check-only  # 只校验产物齐全（不构建）
 *
 * --check-only 的用途（2026-11-10）：CI 缓存命中时跳过构建（首次热构建本机实测
 * 已超 8 分钟），但仍必须校验产物齐全——否则缓存损坏会让 genoffice E2E 静默回到
 * skip，CI 依旧全绿但覆盖已经丢了。产物清单只在本文件维护一份。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSchemePrivileges } from './genoffice-extract-scheme-privileges.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const vendorRoot = join(repoRoot, 'vendor', 'genoffice');

/** 支持的编辑器 app（npm workspace 名后缀）。shell = 上游 Home 前端（阶段 4.6）。
 *  slides = PowerPoint 演示文档（阶段 5）；sheets = Excel 表格（阶段 5，需 Rust sidecar）。 */
const SUPPORTED = ['markdown', 'pdf', 'html', 'docs', 'slides', 'sheets', 'shell'];
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const checkOnly = process.argv.includes('--check-only');
const apps = requested.length > 0 ? requested : [...SUPPORTED];
for (const app of apps) {
  if (!SUPPORTED.includes(app)) {
    console.error(`[genoffice] 不支持的 app: ${app}（可用: ${SUPPORTED.join(', ')}）`);
    process.exit(1);
  }
}

/** 执行 npm 命令（vendor 目录，继承 stdio；失败即退出）。
 *  注意：Windows 下 npm 是 .cmd，必须经 shell 执行；参数均为脚本内常量
 *  （app 名已过 SUPPORTED 白名单），无注入面——整串传入规避 DEP0190。 */
function npm(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // 无镜像时默认走 npmmirror：本机/国内网络对 github.com releases 直连不稳
  if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  const command = `npm ${args.join(' ')}`;
  console.log(`[genoffice] $ ${command}`);
  const res = spawnSync(command, { cwd: vendorRoot, stdio: 'inherit', env, shell: true });
  if (res.status !== 0) {
    console.error(`[genoffice] 失败: ${command} (exit ${res.status ?? 'null'})`);
    process.exit(res.status ?? 1);
  }
}

if (!existsSync(join(vendorRoot, 'package.json'))) {
  console.error('[genoffice] vendor/genoffice 不存在（源码未入库？）');
  process.exit(1);
}

if (!checkOnly) {
  if (!existsSync(join(vendorRoot, 'node_modules'))) {
    console.log('[genoffice] node_modules 缺失，先执行 npm ci（首次较慢，需联网）');
    npm(['ci', '--no-audit', '--no-fund']);
  }

  for (const app of apps) {
    npm(['run', 'build', '-w', `@genoffice/${app}`]);
  }
  npm(['run', 'build', '-w', '@genoffice/urchin-embed']);

  // 3.5 抽取宿主启动所需的轻量 scheme 常量 JSON（启动优化；失败即抛错门禁）
  extractSchemePrivileges();

  // 3.55 模块类型标记（2026-11-07 dev.158 修复）：
  // 打包后 embed/index.js 复制到 resources/genoffice/embed/，该目录及安装目录向上
  // 都没有 package.json 时，Node 按「最近祖先前 package.json」判定 .js 的模块类型。
  // 从仓库内 apps/desktop/release-*/win-unpacked 启动会命中 apps/desktop/package.json
  // 的 "type": "module"，使 CJS 的嵌入包被当 ESM 执行 →
  // `ReferenceError: exports is not defined in ES module scope` → GenOffice 整体降级
  // （安装版表现为「GenOffice 无法启动」）。就近写入 commonjs 标记后，模块类型与
  // 宿主/安装位置解耦；electron-builder 把它复制为 resources/genoffice/embed/package.json。
  const embedMarkerPath = join(vendorRoot, 'apps', 'urchin-embed', 'out', 'main', 'package.json');
  writeFileSync(embedMarkerPath, '{"type":"commonjs"}\n');

  // 3.6 生成第三方许可声明 THIRD-PARTY-NOTICES.txt（Apache-2.0 NOTICE 传播合规）。
  //      gen-third-party-notices.mjs 产出到 apps/shell/build/，但 electron-builder.yml
  //      的 extraResources 从 vendor 根读取（见 electron-builder.yml 许可合规段注释）。
  //      此前 genoffice-build.mjs 漏跑此步骤，导致打包时 electron-builder 报
  //      "file source doesn't exist" warning 且安装包缺少第三方声明文件。
  //      缺 cargo 时 Rust crate 段回退到 Cargo.lock 文本（脚本内 catch 不阻塞）。
  npm(['run', 'notices']);
  const noticesSrc = join(vendorRoot, 'apps', 'shell', 'build', 'THIRD-PARTY-NOTICES.txt');
  const noticesDst = join(vendorRoot, 'THIRD-PARTY-NOTICES.txt');
  copyFileSync(noticesSrc, noticesDst);
  console.log(`[genoffice] copied THIRD-PARTY-NOTICES.txt -> ${relative(vendorRoot, noticesDst)}`);
}

/** 产物清单（宿主运行时的相对路径；缺失即失败）。 */
const artifacts = [
  join(vendorRoot, 'apps', 'urchin-embed', 'out', 'main', 'index.js'),
  // 宿主 ready 前注册特权 scheme 用的轻量常量（避免加载整个嵌入包）
  join(vendorRoot, 'apps', 'urchin-embed', 'out', 'main', 'scheme-privileges.json'),
  // 模块类型标记（见 3.55）：打包为 resources/genoffice/embed/package.json，
  // 防止嵌入包在含 "type": "module" 祖先目录下被按 ESM 执行
  join(vendorRoot, 'apps', 'urchin-embed', 'out', 'main', 'package.json'),
  // 第三方许可声明（3.6 步骤生成并复制到 vendor 根；electron-builder
  // extraResources 从此路径打包到 resources/genoffice/THIRD-PARTY-NOTICES.txt）
  join(vendorRoot, 'THIRD-PARTY-NOTICES.txt'),
  ...apps.flatMap((app) => [
    join(vendorRoot, 'apps', app, 'out', 'renderer', 'index.html'),
    // shell Home 由宿主自有 preload 承载，不需要上游 preload 产物
    ...(app === 'shell' ? [] : [join(vendorRoot, 'apps', app, 'out', 'preload', 'index.js')]),
  ]),
  // PDF 文本编辑运行时 wasm（打包时经 electron-builder extraResources 复制到
  // resources/wasm/；开发态由 pdf-main 的 require.resolve 直接命中）
  ...(apps.includes('pdf')
    ? [
        join(vendorRoot, 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'),
        join(vendorRoot, 'apps', 'pdf', 'node_modules', 'harfbuzzjs', 'hb-subset.wasm'),
      ]
    : []),
  // Sheets Rust xlsx-sidecar 二进制（由 sheets 的 npm run build → native:build
  // 产出；打包时经 electron-builder extraResources 复制到 resources/native/）
  ...(apps.includes('sheets')
    ? [
        join(
          vendorRoot,
          'apps',
          'sheets',
          'native',
          'xlsx-engine',
          'target',
          'release',
          process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar',
        ),
      ]
    : []),
];

let failed = false;
for (const file of artifacts) {
  const ok = existsSync(file);
  console.log(`[genoffice] ${ok ? 'OK  ' : 'MISS'} ${file}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error('[genoffice] 产物缺失，构建失败');
  process.exit(1);
}
console.log('[genoffice] 构建完成');

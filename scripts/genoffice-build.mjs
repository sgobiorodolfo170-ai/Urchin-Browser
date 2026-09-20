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
 * 4. 校验全部产物路径存在，缺失即非零退出（CI/打包前置门禁）
 *
 * 用法：node scripts/genoffice-build.mjs [app...]   # 默认 markdown
 * 后续阶段：pdf / html / docs 逐个加入 APPS 常量即可。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const vendorRoot = join(repoRoot, 'vendor', 'genoffice');

/** 支持的编辑器 app（npm workspace 名后缀）。shell = 上游 Home 前端（阶段 4.6）。 */
const SUPPORTED = ['markdown', 'pdf', 'html', 'docs', 'shell'];
const requested = process.argv.slice(2);
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

if (!existsSync(join(vendorRoot, 'node_modules'))) {
  console.log('[genoffice] node_modules 缺失，先执行 npm ci（首次较慢，需联网）');
  npm(['ci', '--no-audit', '--no-fund']);
}

for (const app of apps) {
  npm(['run', 'build', '-w', `@genoffice/${app}`]);
}
npm(['run', 'build', '-w', '@genoffice/urchin-embed']);

/** 产物清单（宿主运行时的相对路径；缺失即失败）。 */
const artifacts = [
  join(vendorRoot, 'apps', 'urchin-embed', 'out', 'main', 'index.js'),
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

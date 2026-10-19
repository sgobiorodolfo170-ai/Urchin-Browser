/**
 * GenOffice 特权 scheme 常量抽取（Urchin 启动优化前置步骤）
 *
 * 用途：把 vendor 嵌入包中「宿主 app ready 前需要」的静态常量
 * （GENOFFICE_SCHEME_PRIVILEGES）在构建期单独打成极小 JSON 产物
 * （apps/urchin-embed/out/main/scheme-privileges.json）。Urchin 主进程启动时
 * 只读该 JSON——不再为 4 条静态配置 require 整个嵌入包（慢盘上省约 7.76MB
 * 冷读及解析；详见 vendor 侧 scheme-privileges.ts 头注释）。
 *
 * 实现：以 vendor 的 esbuild 把 scheme-privileges.ts（纯 TS、零 Electron
 * 运行时依赖）bundle 成 CJS 临时文件 → 普通 Node require 取出常量并校验
 * 形状 → 落盘 JSON → 删除临时文件。
 *
 * 校验失败即抛错非零退出（构建门禁）：防止宿主拿到空/坏常量导致
 * genoffice-app:// 等页面失去特权而白屏。
 *
 * 用法：node scripts/genoffice-extract-scheme-privileges.mjs
 *       （scripts/genoffice-build.mjs 在嵌入包构建后自动调用本步骤）
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VENDOR_ROOT = join(REPO_ROOT, 'vendor', 'genoffice');

/** 校验抽取结果形状：非空数组，且每项为 { scheme: string, privileges: object }。 */
function assertPrivilegesShape(privileges) {
  if (!Array.isArray(privileges) || privileges.length === 0) {
    throw new Error(
      '[genoffice] scheme-privileges 抽取结果为空数组——宿主将无法注册 GenOffice 特权 scheme',
    );
  }
  const seen = new Set();
  for (const item of privileges) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.scheme !== 'string' ||
      item.scheme.length === 0 ||
      typeof item.privileges !== 'object' ||
      item.privileges === null
    ) {
      throw new Error(`[genoffice] scheme-privileges 条目形状异常: ${JSON.stringify(item)}`);
    }
    if (seen.has(item.scheme)) {
      throw new Error(`[genoffice] scheme-privileges 存在重复 scheme: ${item.scheme}`);
    }
    seen.add(item.scheme);
  }
}

/**
 * 执行抽取并落盘 JSON。
 * @returns {string} 生成的 scheme-privileges.json 绝对路径
 */
export function extractSchemePrivileges({ log = console.log } = {}) {
  const embedDir = join(VENDOR_ROOT, 'apps', 'urchin-embed');
  const entry = join(embedDir, 'src', 'main', 'scheme-privileges.ts');
  const outMain = join(embedDir, 'out', 'main');
  const tmpFile = join(outMain, '.scheme-privileges.tmp.cjs');
  const jsonFile = join(outMain, 'scheme-privileges.json');

  if (!existsSync(entry)) {
    throw new Error(`[genoffice] scheme-privileges 入口缺失: ${entry}（vendor 源码不完整？）`);
  }
  // 直接用 node 跑 esbuild 的 JS bin：规避 Windows .cmd 的 shell 引号问题
  const esbuildBin = join(VENDOR_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (!existsSync(esbuildBin)) {
    throw new Error(`[genoffice] esbuild 缺失: ${esbuildBin}（先执行 vendor npm ci）`);
  }

  mkdirSync(outMain, { recursive: true });

  // external:electron 仅防御（入口为 type-only import，实际会被抹除）；
  // 若依赖链被误引入 Electron 运行时依赖，require 阶段会因 electron 桩而失败——
  // 这正是不变量门禁（scheme-privileges.ts 头注释）。
  const res = spawnSync(
    process.execPath,
    [
      esbuildBin,
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node20',
      '--external:electron',
      `--outfile=${tmpFile}`,
    ],
    { cwd: VENDOR_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (res.status !== 0) {
    throw new Error(
      `[genoffice] esbuild 打包 scheme-privileges 失败 (exit ${res.status ?? 'null'})`,
    );
  }

  let privileges;
  try {
    const req = createRequire(join(VENDOR_ROOT, 'package.json'));
    privileges = req(tmpFile).GENOFFICE_SCHEME_PRIVILEGES;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* 临时文件清理失败不阻断构建 */
    }
  }

  assertPrivilegesShape(privileges);
  writeFileSync(jsonFile, `${JSON.stringify(privileges, null, 2)}\n`, 'utf8');

  // 自校验：重新解析落盘 JSON，确保宿主读到的内容与校验对象一致
  const reparsed = JSON.parse(readFileSync(jsonFile, 'utf8'));
  assertPrivilegesShape(reparsed);

  log(
    `[genoffice] scheme-privileges.json 已生成: ${jsonFile} ` +
      `(${privileges.length} schemes: ${privileges.map((p) => p.scheme).join(', ')})`,
  );
  return jsonFile;
}

// 直接运行时执行（被 genoffice-build.mjs import 时不自动执行）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    extractSchemePrivileges();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

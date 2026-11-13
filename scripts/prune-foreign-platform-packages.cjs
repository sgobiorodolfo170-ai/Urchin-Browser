/**
 * 清理 .pnpm 中面向非 Windows x64 平台的包实体目录。
 *
 * 与配置/打包规则同口径：置以 manifest 的 os / cpu 字段为准（npm 语义，
 * `!` 前缀为排除），只处理 @deepseek-ai / @img / @vscode / @koromix / sherpa-onnx
 * 这几组按平台拆分的包，其余包一律不动。
 *
 * 只删除「包实体」目录（lstat 非 symlink），且要求目录名与包名对应，
 * 避免顺着符号链接误删仍被引用的包。
 *
 * 用法：node scripts/prune-foreign-platform-packages.cjs [--dry-run]
 */
const { readdirSync, readFileSync, lstatSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const PNPM_DIR = join(REPO_ROOT, 'node_modules', '.pnpm');
const DRY_RUN = process.argv.includes('--dry-run');

/** 参与平台裁剪的包作用域 / 名称前缀（与打包规则一致）。 */
const TARGET_SCOPES = ['@deepseek-ai', '@img', '@vscode', '@koromix'];
const TARGET_PREFIXES = ['sherpa-onnx-', 'node-addon-require-builtin-'];

const accepts = (list, wanted) => {
  if (!Array.isArray(list) || list.length === 0) return true;
  const values = list.filter((v) => typeof v === 'string');
  if (values.includes(`!${wanted}`)) return false;
  const positives = values.filter((v) => !v.startsWith('!'));
  return positives.length === 0 || positives.includes(wanted);
};

const targetsThisPlatform = (manifest) =>
  accepts(manifest.os, 'win32') && accepts(manifest.cpu, 'x64');

/**
 * 从 .pnpm 目录名解析包名：`@scope+name@1.2.3_peerhash` → `@scope/name`
 * （scoped 的 `+` 换成 `/`，再去掉尾部 `@version...`）。
 */
const packageNameFromDir = (dirName) => {
  const unescaped = dirName.replace(/\+/g, '/');
  const at = unescaped.lastIndexOf('@');
  if (at <= 0) return null;
  return unescaped.slice(0, at);
};

const isTarget = (name) => {
  if (!name) return false;
  const scope = name.split('/')[0];
  if (name.startsWith('@') && TARGET_SCOPES.includes(scope)) return true;
  return TARGET_PREFIXES.some((prefix) => name.startsWith(prefix));
};

if (!existsSync(PNPM_DIR)) {
  console.error(`[prune] 找不到 ${PNPM_DIR}`);
  process.exit(1);
}

const removed = [];
const errors = [];
const scanned = [];

for (const dirName of readdirSync(PNPM_DIR)) {
  const name = packageNameFromDir(dirName);
  if (!isTarget(name)) continue;
  const pkgDir = join(PNPM_DIR, dirName, 'node_modules', ...name.split('/'));
  let stat;
  try {
    stat = lstatSync(pkgDir);
  } catch {
    continue; // 该变体目录里没有此包的实体（只剩符号链接或已被清）
  }
  if (stat.isSymbolicLink()) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  scanned.push(manifest.name);
  if (targetsThisPlatform(manifest)) continue;
  removed.push({ dir: dirName, name: manifest.name, version: manifest.version, os: manifest.os });
  if (!DRY_RUN) {
    try {
      rmSync(join(PNPM_DIR, dirName), { recursive: true, force: true });
    } catch (error) {
      errors.push(`${dirName}: ${error.message}`);
    }
  }
}

for (const item of removed) {
  console.log(
    `[prune] ${DRY_RUN ? '将删除' : '已删除'} ${item.name}@${item.version} (os=${JSON.stringify(item.os)}) ← ${item.dir}`,
  );
}
console.log(
  `[prune] 扫描 ${scanned.length} 个平台相关包实体，${DRY_RUN ? '待删除' : '已删除'} ${removed.length} 个，失败 ${errors.length} 个`,
);
if (errors.length > 0) {
  for (const line of errors) console.error(`[prune] ✗ ${line}`);
  process.exit(1);
}

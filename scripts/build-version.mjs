/**
 * 构建版本解析（dev.114 自动更新落地，用户指令「设置页更新按钮接入发布版更新路径」）
 *
 * 背景：
 * apps/desktop/package.json 的版本号在开发期恒为 0.1.0，而发布以 CHANGELOG.md
 * 表尾最新一行的 v0.1.0-dev.NNN 标记（git tag / GitHub release 同名）。
 * electron-updater 靠 semver 比较 app 版本与 release 清单里的版本号判断
 * 「有无新版本」（0.1.0-dev.114 > 0.1.0-dev.113），因此打包时必须把 CHANGELOG
 * 版本「盖章」进产物：package-win.mjs 以 `--config.extraMetadata.version=<版本>`
 * 覆盖 package.json 的 version 字段（不修改工作区文件，保持可重复打包、
 * 工作区始终干净）。
 *
 * 版本来源优先级：
 * 1. 环境变量 URCHIN_BUILD_VERSION（测试构建用：可人为指定一个较低版本号，
 *    用于在安装版上验证升级链；正式发布构建不使用）；
 * 2. CHANGELOG.md 表尾最新的 `| v0.1.0-dev.NNN | ...` 行。
 *
 * 解析失败直接抛错——版本号是自动更新的比对基准，宁可打包失败也不能产出
 * 无版本 / 错版本的产物（有意的门禁）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 项目版本命名：主版本.次版本.修订号（-dev.NNN 预发布段可选）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 解析本次构建版本号。
 * @returns {string} 如 "0.1.0-dev.113"
 */
export function resolveBuildVersion() {
  const override = process.env.URCHIN_BUILD_VERSION?.trim();
  if (override) {
    if (!SEMVER_RE.test(override)) {
      throw new Error(`[build-version] URCHIN_BUILD_VERSION 不是合法 semver: ${override}`);
    }
    return override;
  }

  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  // 表按时序追加（最新在表尾），取最后一个版本行
  const rows = [...changelog.matchAll(/^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|/gm)];
  const last = rows[rows.length - 1];
  if (!last?.[1]) {
    throw new Error(
      `[build-version] 无法从 ${changelogPath} 解析版本行（期望表尾有 | v0.1.0-dev.NNN | ... |）`,
    );
  }
  return last[1];
}

// 直接 `node scripts/build-version.mjs` 运行时打印版本（调试 / 发布流程引用）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(resolveBuildVersion());
}

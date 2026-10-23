/**
 * 构建版本解析（dev.114 自动更新落地，dev.115 双通道治理）
 *
 * 背景：
 * apps/desktop/package.json 的版本号在开发期恒为 0.1.0，而发布以 CHANGELOG.md
 * 表尾最新一行的 `vX.Y.Z[-dev.NNN]` 标记（git tag / GitHub release 同名）。
 * electron-updater 靠 semver 比较 app 版本与 release 清单里的版本号判断
 * 「有无新版本」，因此打包时必须把 CHANGELOG 版本「盖章」进产物：
 * package-win.mjs 以 `--config.extraMetadata.version=<版本>` 覆盖 package.json
 * 的 version 字段（不修改工作区文件，保持可重复打包、工作区始终干净）。
 *
 * 双通道规则（ADR-012）：
 * - dev 预发布（如 0.2.0-dev.115）→ channel=dev、allowPrerelease=true、
 *   releaseType=prerelease，electron-builder 生成 dev.yml；
 * - 正式版（如 0.2.0）→ channel=latest、allowPrerelease=false、
 *   releaseType=release，electron-builder 生成 latest.yml。
 * 通道由版本形态派生，避免打包脚本与运行时分头硬编码后漂移。
 *
 * 版本来源优先级：
 * 1. 环境变量 URCHIN_BUILD_VERSION（测试构建用：可人为指定一个较低版本号，
 *    用于在安装版上验证升级链；正式发布构建不使用）；
 * 2. CHANGELOG.md 表尾最新的 `| vX.Y.Z[-dev.NNN] | ...` 行。
 *
 * 基线门禁：正式发布时，dev 基础版本必须严格大于「最近一条 stable 行」，
 * stable 必须严格大于「上一条 stable 行」——防止 0.1.0-dev.115 这类低于/等于
 * 既有 stable 的版本流出，导致 electron-updater 永远认为没有更新。
 * URCHIN_BUILD_VERSION 覆盖仅用于测试构建，明确跳过该门禁并告警。
 *
 * 解析失败直接抛错——版本号是自动更新的比对基准，宁可打包失败也不能产出
 * 无版本 / 错版本的产物（有意的门禁）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 项目版本命名：主版本.次版本.修订号（-dev.NNN 预发布段可选）。 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 正式版更新通道（electron-builder 生成 latest.yml，electron-updater 对应 latest）。 */
export const STABLE_CHANNEL = 'latest';

/** 解析版本为可比较的数字段；非法版本返回 null。 */
function parseVersion(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** 比较主/次/修订号（忽略预发布段，用于基线门禁）。 */
function compareBaseVersion(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

/**
 * 从版本号派生更新通道与发布类型。
 * - 预发布段首段即通道（dev.115 → dev；beta.1 → beta）；
 * - 无预发布段 → latest / release。
 * @param {string} version
 * @returns {{ version: string, channel: string, isPrerelease: boolean, allowPrerelease: boolean, releaseType: 'prerelease' | 'release' }}
 */
export function deriveBuildInfo(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`[build-version] 不是合法 semver: ${version}`);
  }
  const prereleaseChannel = parsed.prerelease?.split('.')[0] ?? null;
  const isPrerelease = prereleaseChannel !== null;
  return {
    version,
    channel: prereleaseChannel ?? STABLE_CHANNEL,
    isPrerelease,
    allowPrerelease: isPrerelease,
    releaseType: isPrerelease ? 'prerelease' : 'release',
  };
}

/** 读取 CHANGELOG 中所有版本行（保留表内位置用于找「上一条 stable」）。 */
function readVersionRows(changelog) {
  return [...changelog.matchAll(/^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|/gm)].map(
    (match) => ({ version: match[1], index: match.index ?? 0 }),
  );
}

/**
 * 基线门禁：当前版本必须严格大于表内最近一条 stable（对 stable 自身则取上一条）。
 * @param {{ version: string, index: number }[]} rows
 */
function assertVersionBaseline(rows) {
  const last = rows[rows.length - 1];
  const current = parseVersion(last.version);
  if (!current) {
    throw new Error(`[build-version] CHANGELOG 表尾版本非法: ${last.version}`);
  }
  const previousStable = [...rows]
    .reverse()
    .find((row) => row.index < last.index && parseVersion(row.version)?.prerelease === null);
  if (!previousStable) return;

  const baseline = parseVersion(previousStable.version);
  if (compareBaseVersion(current, baseline) <= 0) {
    throw new Error(
      `[build-version] 版本基线门禁失败：${last.version} 必须严格大于最近 stable ` +
        `${previousStable.version}（否则更新器会认为没有新版本）`,
    );
  }
}

/**
 * 解析本次构建的完整信息（版本 + 通道 + 发布类型）。
 * @returns {{ version: string, channel: string, isPrerelease: boolean, allowPrerelease: boolean, releaseType: 'prerelease' | 'release' }}
 */
export function resolveBuildInfo() {
  const override = process.env.URCHIN_BUILD_VERSION?.trim();
  if (override) {
    const info = deriveBuildInfo(override);
    console.warn(
      `[build-version] URCHIN_BUILD_VERSION 覆盖生效，跳过 CHANGELOG 基线门禁: ${info.version}`,
    );
    return info;
  }

  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const rows = readVersionRows(changelog);
  const last = rows[rows.length - 1];
  if (!last) {
    throw new Error(
      `[build-version] 无法从 ${changelogPath} 解析版本行（期望表尾有 | vX.Y.Z[-dev.NNN] | ... |）`,
    );
  }
  assertVersionBaseline(rows);
  return deriveBuildInfo(last.version);
}

/**
 * 仅解析版本号（兼容旧调用）。
 * @returns {string} 如 "0.2.0-dev.115"
 */
export function resolveBuildVersion() {
  return resolveBuildInfo().version;
}

// 直接 `node scripts/build-version.mjs` 运行时打印版本（调试 / 发布流程引用）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(resolveBuildVersion());
}

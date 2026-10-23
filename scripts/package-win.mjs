/**
 * Electron 打包包装脚本（electron-builder --win --x64）
 *
 * 背景（2026-10-16，dev.109 打包失败排查）：
 * electron-builder 26.x 的依赖树收集器按「包管理器」选择实现。pnpm 分支执行
 * `pnpm list --prod --json --depth Infinity`，其嵌套 JSON 对每个共享子树按依赖边
 * 重复展开——实测本仓库输出量按层数约 ×4 膨胀：depth 3/4/5 = 2.9/12.5/43 MB，
 * depth 9+ 超过 8 GB → 子进程 OOM（exit 134），打包无法完成（@deepseek-ai/dsh
 * 依赖闭包过深触发；dsh 加入前树较浅未触发）。
 *
 * 对策：把 electron-builder 的包管理器检测伪装为 "traversal"——app-builder-lib
 * 内置的目录遍历收集器（上游供 bun / corepack 回退场景使用）：沿 dependencies/
 * optionalDependencies 用 Node 解析规则遍历 node_modules（pnpm realpath 可穿透），
 * 按 realpath 去重（天然免疫循环与指数膨胀），不执行任何外部命令。
 *
 * 生效路径：detectPackageManager 对 apps/desktop 找不到 lockfile（lock 在仓库根），
 * 字段检测不命中 → 落入「环境检测」分支读取 npm_config_user_agent。仅覆盖本进程
 * 环境，不影响其他工具。（不能改用 package.json 的 packageManager 字段：pnpm 对
 * 未知 PM 名直接报错——"Unsupported package manager specification (traversal@…)"。）
 *
 * 后续若 electron-builder 修复 pnpm 收集器在该树形上的指数膨胀，可移除本包装
 * 直接调用 electron-builder。
 *
 * dev.114 自动更新落地（用户指令：设置页更新按钮接入发布版更新路径）：
 * - 版本盖章：`--config.extraMetadata.version=<版本>` 注入 CHANGELOG 派生版本
 *   （build-version.mjs），不改工作区 package.json；产物名与 app.getVersion()
 *   同步——electron-updater 的 semver 比较以此为基准。
 * - `--publish never`：只在本地产出更新清单（dev.yml / latest.yml / 包内
 *   app-update.yml），上传由发布流程用 gh release 显式执行，本机不触发任何上传。
 *
 * dev.115 双通道治理（ADR-012）：
 * - 由 build-version 同时派生 channel / releaseType，经 `--config.publish.*`
 *   覆盖 electron-builder.yml 的 dev 默认值：dev → dev/prerelease（dev.yml），
 *   stable → latest/release（latest.yml）。
 * - 打包后强校验 yml 文件名、app-update.yml 的 channel/releaseType、exe/blockmap
 *   文件名，任一不符直接失败——避免「通道配错但安装包看似成功」的静默事故。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildInfo } from './build-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
// 直接以 node 运行本脚本（不经 pnpm 脚本）时 PATH 不含 .bin，显式补齐
// （electron-builder 是 apps/desktop 的 devDependency，bin 在其 .bin 下）。
const binDirs = [
  resolve(desktopDir, 'node_modules', '.bin'),
  resolve(repoRoot, 'node_modules', '.bin'),
];
const env = {
  ...process.env,
  npm_config_user_agent: 'traversal/1.0.0',
  PATH: [...binDirs, process.env.PATH ?? ''].join(delimiter),
};

/** 读取 electron-builder 生成的简单单值 YAML 字段（避免为校验引入 YAML 依赖）。 */
function readYamlScalar(text, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
}

/** 打包后校验：通道、清单、产物名必须与 build info 一致。 */
function validateArtifacts(info) {
  const releaseDirs = readdirSync(desktopDir)
    .filter((name) => name.startsWith('release-'))
    .map((name) => resolve(desktopDir, name))
    .filter((path) => existsSync(join(path, 'win-unpacked')));

  const exeName = `Urchin-Browser-${info.version}-x64.exe`;
  const releaseDir = releaseDirs.find((path) => existsSync(join(path, exeName))) ?? releaseDirs[0];
  if (!releaseDir) {
    throw new Error('[package-win] 未找到 release-* 产物目录');
  }

  const expectedYml = `${info.channel}.yml`;
  const otherYml = info.channel === 'dev' ? 'latest.yml' : 'dev.yml';
  for (const file of [exeName, `${exeName}.blockmap`, expectedYml]) {
    if (!existsSync(join(releaseDir, file))) {
      throw new Error(`[package-win] 缺少预期产物: ${join(releaseDir, file)}`);
    }
  }
  if (existsSync(join(releaseDir, otherYml))) {
    throw new Error(`[package-win] 通道产物冲突: ${otherYml} 不应出现在 ${info.channel} 构建中`);
  }

  const appUpdatePath = join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml');
  if (!existsSync(appUpdatePath)) {
    throw new Error(`[package-win] 缺少 app-update.yml: ${appUpdatePath}`);
  }
  const appUpdate = readFileSync(appUpdatePath, 'utf8');
  const actual = {
    provider: readYamlScalar(appUpdate, 'provider'),
    channel: readYamlScalar(appUpdate, 'channel'),
    releaseType: readYamlScalar(appUpdate, 'releaseType'),
  };
  if (
    actual.provider !== 'github' ||
    actual.channel !== info.channel ||
    actual.releaseType !== info.releaseType
  ) {
    throw new Error(
      `[package-win] app-update.yml 与构建通道不一致: ${JSON.stringify(actual)} ` +
        `(期望 provider=github, channel=${info.channel}, releaseType=${info.releaseType})`,
    );
  }

  console.log(
    `[package-win] validated: version=${info.version} channel=${info.channel} ` +
      `releaseType=${info.releaseType} manifest=${expectedYml}`,
  );
}

// shell: true —— Windows 下经 cmd 解析 node_modules/.bin 中的 electron-builder.cmd
// （PATH 已由 pnpm 脚本环境注入）；stdio: inherit 保持日志直通。
const info = resolveBuildInfo();
console.log(
  `[package-win] build version: ${info.version} ` +
    `(channel=${info.channel}, releaseType=${info.releaseType})`,
);

const result = spawnSync(
  'electron-builder',
  [
    '--win',
    '--x64',
    '--publish',
    'never',
    `--config.extraMetadata.version=${info.version}`,
    `--config.publish.channel=${info.channel}`,
    `--config.publish.releaseType=${info.releaseType}`,
  ],
  {
    stdio: 'inherit',
    env,
    shell: true,
  },
);

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

try {
  validateArtifacts(info);
} catch (error) {
  console.error(`[package-win] artifact validation failed: ${error.message}`);
  process.exit(1);
}

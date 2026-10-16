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
 */
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 直接以 node 运行本脚本（不经 pnpm 脚本）时 PATH 不含 .bin，显式补齐
// （electron-builder 是 apps/desktop 的 devDependency，bin 在其 .bin 下）。
const binDirs = [
  resolve(repoRoot, 'apps', 'desktop', 'node_modules', '.bin'),
  resolve(repoRoot, 'node_modules', '.bin'),
];
const env = {
  ...process.env,
  npm_config_user_agent: 'traversal/1.0.0',
  PATH: [...binDirs, process.env.PATH ?? ''].join(delimiter),
};

// shell: true —— Windows 下经 cmd 解析 node_modules/.bin 中的 electron-builder.cmd
// （PATH 已由 pnpm 脚本环境注入）；stdio: inherit 保持日志直通。
const result = spawnSync('electron-builder', ['--win', '--x64'], {
  stdio: 'inherit',
  env,
  shell: true,
});

process.exit(result.status ?? 1);

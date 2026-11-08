/**
 * electron-builder afterPack 钩子：补齐「仅以 peerDependency 出现」的运行时依赖。
 *
 * 背景（2026-11-07 dev.158 打包实测）：
 * - 打包器用 traversal 收集器（见 scripts/package-win.mjs 头部注释），它只沿
 *   package.json 的 dependencies / optionalDependencies 建图；pnpm 的 peerDependency
 *   解析结果（存放在 .pnpm/<pkg>@<ver>_<peerhash>/node_modules/ 的兄弟目录）不在
 *   依赖边里，因此被系统性漏打。
 * - 症状：安装版点击 DeepSeek Harness 报
 *   `dsh 启动即退出（code=1）`；便携 node 直跑 bin.js 的真实错误是
 *   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'`。
 * - 因为 dsh 由外部纯 Node 进程直读 app.asar.unpacked（不经过 asar 虚拟层），
 *   在 afterPack 阶段把缺失包平铺进 app.asar.unpacked/node_modules 即可被解析；
 *   NSIS 在 afterPack 之后生成，新增文件会一并进安装包。
 *
 * 算法：从应用生产依赖出发，沿 dependencies ∪ optionalDependencies ∪ peerDependencies
 * 用 Node 解析规则遍历（可穿透 pnpm 的 realpath 与 peer 变体目录），把打包产物
 * 里缺失的包按 realpath 平铺复制。@types/* 属纯类型包，跳过。
 */
const { existsSync, readFileSync, readdirSync, realpathSync, cpSync } = require('node:fs');
const { dirname, join, resolve, basename } = require('node:path');
const { createRequire } = require('node:module');

/** 读取并校验包目录的 package.json */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 用 Node 解析规则定位包目录（从 base 目录向上查找 node_modules） */
function resolvePkgDir(name, base) {
  const req = createRequire(join(base, 'noop.js'));
  try {
    return realpathSync(dirname(req.resolve(`${name}/package.json`)));
  } catch {
    return null;
  }
}

/** 产物 node_modules 里已存在的包名集合（顶层 + @scope） */
function listPackaged(snapshotDir) {
  const names = new Set();
  if (!existsSync(snapshotDir)) return names;
  for (const entry of readdirSync(snapshotDir)) {
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(snapshotDir, entry))) names.add(`${entry}/${sub}`);
    } else {
      names.add(entry);
    }
  }
  return names;
}

exports.default = async function afterPack(context) {
  const appDir = context.appOutDir;
  const resourcesDir = join(appDir, 'resources');
  const unpackedModules = join(resourcesDir, 'app.asar.unpacked', 'node_modules');
  const projectDir = context.packager.projectDir; // apps/desktop
  const desktopManifest = readManifest(projectDir);
  if (!desktopManifest) {
    throw new Error(`[after-pack] 无法读取 ${join(projectDir, 'package.json')}`);
  }

  // 生产依赖根集合（electron-builder 用它建图，这里与之保持一致）
  const roots = Object.keys(desktopManifest.dependencies ?? {});

  /** realpath 去重，避免同一包的不同 peer 变体重复遍历 */
  const seenRealpaths = new Set();
  /** name -> realpath（首次命中优先，与平铺复制语义一致） */
  const resolved = new Map();
  const queue = [];

  for (const name of roots) {
    const dir = resolvePkgDir(name, projectDir);
    if (dir) queue.push(dir);
  }

  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir || seenRealpaths.has(dir)) continue;
    seenRealpaths.add(dir);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    resolved.set(manifest.name, dir);
    const edges = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    for (const edge of edges) {
      const child = resolvePkgDir(edge, dir);
      if (child && !seenRealpaths.has(child)) queue.push(child);
    }
  }

  const packaged = listPackaged(unpackedModules);
  const copied = [];
  for (const [name, dir] of resolved) {
    if (packaged.has(name) || name.startsWith('@types/')) continue;
    const target = join(unpackedModules, name);
    try {
      cpSync(dir, target, { recursive: true, dereference: true, force: true });
      copied.push(name);
    } catch (error) {
      throw new Error(`[after-pack] 复制 ${name} 失败（${dir} → ${target}）: ${error.message}`);
    }
  }

  console.log(
    `[after-pack] 生产依赖闭包 ${resolved.size} 个，产物已含 ${packaged.size} 个，` +
      `补齐 peer-only 依赖 ${copied.length} 个`,
  );
  for (const name of copied.sort()) console.log(`[after-pack]   + ${name}`);
};

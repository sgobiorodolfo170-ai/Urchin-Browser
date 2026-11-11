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
 * 里缺失的包按 realpath 平铺复制。@types/* 属纯类型包跳过；renderer-only
 * 有意排除清单（INTENTIONALLY_EXCLUDED，与 yml files B1 规则同口径）同样跳过，
 * 防止「漏打检测」把 files 有意排除的包复制回来（dev.192）。
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
  // B1 有意排除清单（2026-11-12 dev.192）：与 electron-builder.yml files 的
  // renderer-only 排除规则同口径。这些包 vite 已打进 asar（dist 产物无
  // require/import 字面量，dsh 依赖闭包实测不含），files 排除后产物缺失属
  // 预期，不得被下方「闭包内有、产物内没有 = 漏打」检测复制回来——dev.192
  // 首打实测：缺少本清单时 lucide-react / react / react-dom / marked /
  // turndown / csstype 共 6 包 2,255 文件被补回，B1 收益被抵消殆尽。
  // csstype 为纯类型包（仅 .d.ts/.flow/LICENSE，运行时无 .js），一并排除。
  const INTENTIONALLY_EXCLUDED = new Set([
    'react',
    'react-dom',
    'lucide-react',
    'marked',
    'turndown',
    'clsx',
    'tailwind-merge',
    'defuddle',
    'csstype',
  ]);
  const EXCLUDED_SCOPES = ['@radix-ui'];
  const isIntentionallyExcluded = (name) =>
    INTENTIONALLY_EXCLUDED.has(name) ||
    EXCLUDED_SCOPES.some((scope) => name === scope || name.startsWith(`${scope}/`));
  const skippedByExclusion = [];
  // 与 electron-builder.yml 的 files 排除规则保持同口径（2026-11-11 dev.191）：
  // 本钩子的 cpSync 是文件级复制，不经过 files 过滤，若不过滤会把 peer-only
  // 包内的类型声明 / TS 源码 / .md 文档一并带进产物（dev.190 基线实测 25 个
  // 包共 148 个）。asar 在 afterPack 之前已生成，这些包只被外部 Node 直读、
  // 不在 asar 索引里，剪掉不会留下「目录可见、打开报 ENOENT」的幽灵条目；
  // 与 files 排除的区别仅在于作用阶段（组装期 vs 补齐期）。
  const NON_RUNTIME_RE = /\.(?:ts|cts|mts|md|map)$/i;
  let filteredFiles = 0;
  for (const [name, dir] of resolved) {
    if (packaged.has(name) || name.startsWith('@types/')) continue;
    if (isIntentionallyExcluded(name)) {
      skippedByExclusion.push(name);
      continue;
    }
    const target = join(unpackedModules, name);
    try {
      cpSync(dir, target, {
        recursive: true,
        dereference: true,
        force: true,
        filter: (src) => {
          if (NON_RUNTIME_RE.test(src)) {
            filteredFiles++;
            return false;
          }
          return true;
        },
      });
      copied.push(name);
    } catch (error) {
      throw new Error(`[after-pack] 复制 ${name} 失败（${dir} → ${target}）: ${error.message}`);
    }
  }

  console.log(
    `[after-pack] 生产依赖闭包 ${resolved.size} 个，产物已含 ${packaged.size} 个，` +
      `补齐 peer-only 依赖 ${copied.length} 个，` +
      `有意排除 ${skippedByExclusion.length} 个（B1 renderer-only），` +
      `过滤非运行时文件 ${filteredFiles} 个`,
  );
  for (const name of copied.sort()) console.log(`[after-pack]   + ${name}`);
  for (const name of skippedByExclusion.sort()) {
    console.log(`[after-pack]   ⊘ ${name}`);
  }

  pruneLongPaths(appDir);
};

/**
 * MAX_PATH 剪除（2026-11-10 dev.175 自动更新失败事故根源修复）。
 *
 * 背景：electron-builder NSIS 卸载器在 --updated 语义下把安装目录文件逐个
 * Rename 到 %TEMP%\nsX.tmp\old-install 暂存区（uninstaller.nsh atomicRMDir，
 * 事务式卸载：任一文件失败即整体还原 + Abort，卸载器退出码 2，安装器显示
 * 「Failed to uninstall old application files ... : 2」）。NSIS 不感知
 * longPathAware，目标路径 >259 字符即 MoveFile 失败并被误报为 "File is busy"。
 *
 * dev.159/175 实测踩雷文件：@deepseek-ai/dsh-experimental-inspector 内的
 * Chromium DevTools issue 描述文档（genericFormInputAssignedAutocompleteValueToIdOrNameAttributeError.md
 * 等 4-5 个，相对路径 195~206 字符，暂存目标 264~269）。这些 .md 只在实验性
 * inspector 的 devtools 前端展示弃用告警时读取，运行主链路不依赖。
 *
 * 阈值推导（与 src/main/update/long-path-guard.ts 同一公式，双重保险）：
 * - 安装目录前缀最坏情形 C:\Users\<20 字符用户名>\AppData\Local\Programs\@urchindesktop ≈ 64
 * - 暂存前缀最坏情形 C:\Users\<20>\AppData\Local\Temp + \nsXXXXXX.tmp\old-install ≈ 71
 * - 源路径 ≤259 才能安装成功 → rel ≤ 195；更新时暂存目标 ≤259 → rel ≤ 188
 * 剪除 >188 的文件（当前唯一命中即上述 devtools 文档），并在剪除后断言无
 * rel >195 的残余（>195 连安装都会失败，必须让打包失败而不是发货）。
 */
function pruneLongPaths(appOutDir) {
  const PRUNE_REL_LIMIT = 188; // 相对 appOutDir 的路径长度阈值
  const FAIL_REL_LIMIT = 195; // 残余超过此值直接让打包失败
  const pruned = [];
  const remaining = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = full.slice(appOutDir.length); // 含前导分隔符
        if (rel.length > PRUNE_REL_LIMIT) {
          try {
            require('node:fs').rmSync(full, { force: true });
            pruned.push(rel);
          } catch (error) {
            remaining.push(`${rel}（删除失败: ${error.message}）`);
          }
        }
      }
    }
  };
  walk(appOutDir);

  const overFail = remaining.filter((r) => r.split('（')[0].length > FAIL_REL_LIMIT);
  console.log(
    `[after-pack] MAX_PATH 剪除 ${pruned.length} 个超长路径文件（阈值 ${PRUNE_REL_LIMIT}）`,
  );
  for (const rel of pruned) console.log(`[after-pack]   - ${rel}`);
  if (overFail.length > 0) {
    throw new Error(
      `[after-pack] 仍有 ${overFail.length} 个文件相对路径 >${FAIL_REL_LIMIT}（安装/更新必败）:\n` +
        overFail.join('\n'),
    );
  }
}

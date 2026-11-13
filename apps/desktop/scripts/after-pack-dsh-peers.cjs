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
const { existsSync, readFileSync, readdirSync, realpathSync, cpSync, rmSync } = require('node:fs');
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
  /**
   * name -> 所有出现的版本候选 [{ dir, version }]。
   *
   * dev.193 事故整改（2026-11-12）：原实现用 `resolved.set(name, dir)` 按名字
   * 单值覆盖，BFS 顺序决定谁最后写入——上游 0.2.2-rc.2 的部分包（如
   * dsh-cua / dsh-ptc-runtime-node / dsh-workspace）仍显式依赖 0.2.0-rc.2 的
   * 公共库，导致平铺产物里 dsh-sandbox / dsh-fs / dsh-scope 等被旧版顶替，
   * 新版插件因缺 `SandboxPreparationError` 等具名导出而 19 个激活失败。
   * 平铺目录同名只能留一个版本，因此这里显式按版本择优：
   *   ① 与主包版本一致者优先；② 否则取版本号最高者。
   */
  const candidates = new Map();
  const queue = [];

  for (const name of roots) {
    const dir = resolvePkgDir(name, projectDir);
    if (dir) queue.push(dir);
  }

  /** 简单版本比较：仅用于 0.2.x-rc.N 这类上游版本，按数字段逐段比较。 */
  function compareVersions(a, b) {
    const pa = String(a)
      .split(/[.-]/)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : n));
    const pb = String(b)
      .split(/[.-]/)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : n));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i],
        y = pb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x).localeCompare(String(y));
    }
    return 0;
  }

  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir || seenRealpaths.has(dir)) continue;
    seenRealpaths.add(dir);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    if (!candidates.has(manifest.name)) candidates.set(manifest.name, []);
    candidates.get(manifest.name).push({ dir, version: manifest.version ?? '0.0.0' });
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

  /** 主包版本（唯一真源 = apps/desktop 的 @deepseek-ai/dsh）。 */
  const mainVersion =
    candidates.get('@deepseek-ai/dsh')?.[0]?.version ??
    desktopManifest.dependencies?.['@deepseek-ai/dsh'] ??
    '0.0.0';

  /**
   * 择优范围严格收窄到 `@deepseek-ai/dsh-*` 的 0.2.x 版本族，且必须存在
   * 与主包同版本的候选。
   *
   * 原因：闭包里大量第三方包本来就有多个合法版本（zod 3/4、node-pty、
   * negotiator、ms…），它们由各依赖方按 semver 自行解析，平铺时 electron-
   * builder 的首次命中版本就是正确选择。若对它们也「取最高版本」，会引入
   * major 升级（实测 zod 3.25.76 → 4.6.6、node-pty → 1.2.0-beta.15），
   * 属于超出事故范围的破坏性改动。
   */
  const needsPreference = (name, list) =>
    name.startsWith('@deepseek-ai/dsh') &&
    /^0\.2\./.test(mainVersion) &&
    list.some((c) => c.version === mainVersion) &&
    // 必须真的存在旧版本候选；单版本包无需择优，也不进 preferredNames。
    list.some((c) => /^0\.2\./.test(c.version) && c.version !== mainVersion);

  /** name -> 选定的 realpath；仅 needsPreference 命中时做版本择优。 */
  const resolved = new Map();
  /** 择优修正过的包（只有这些包才允许覆盖产物里已有的旧版）。 */
  const preferredNames = new Set();
  const downgraded = [];
  for (const [name, list] of candidates) {
    let best;
    if (needsPreference(name, list)) {
      best = list
        .filter((c) => c.version === mainVersion)
        .reduce((acc, cur) => (compareVersions(cur.version, acc.version) > 0 ? cur : acc));
      preferredNames.add(name);
      downgraded.push(
        `${name}: ${[...new Set(list.map((c) => c.version))].join(' / ')} → ${best.version}`,
      );
    } else {
      // 保持原有「首次命中优先」语义，不改动第三方包的版本选择。
      best = list[0];
    }
    resolved.set(name, best.dir);
  }
  if (downgraded.length > 0) {
    console.log(
      `[after-pack] dsh 0.2.x 同名多版本按主版本 ${mainVersion} 择优 ${downgraded.length} 个：`,
    );
    for (const line of downgraded.sort()) console.log(`[after-pack]   ⇄ ${line}`);
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
  /**
   * 非目标平台的可选依赖包（2026-11-12 dev.193 体积事故整改）。
   *
   * 本项目只发布 Windows x64，但依赖树里 5 组包把各平台变体写成
   * optionalDependencies。pnpm 若不限制平台会全部装进 .pnpm，traversal
   * 收集器再原样打进产物——实测占解压态约 1 GB（libreoffice-kit 5 平台
   * 837 MB，其中 win32-x64 仅 192 MB），安装包 295 MB → 646 MB。
   *
   * 治本开关是根 package.json 的 pnpm.supportedArchitectures；本清单是补位：
   * peer 补齐用的 cpSync 不经过 electron-builder 的 files 过滤，必须自己拦。
   * 与 electron-builder.yml 的 files 排除规则同口径，两处须同步维护。
   *
   * 用「前缀 + 保留后缀」而非单条正则：`@img/sharp-` 会把
   * `@img/sharp-libvips-win32-x64` 也吃掉，必须让更长的前缀先命中，故按
   * prefix 长度降序匹配。
   */
  const FOREIGN_PLATFORM_RULES = [
    { prefix: '@img/sharp-libvips-', keep: ['win32-x64'] },
    { prefix: '@img/sharp-', keep: ['win32-x64'] },
    { prefix: '@vscode/ripgrep-', keep: ['win32-x64'] },
    { prefix: '@deepseek-ai/libreoffice-kit-', keep: ['win32-x64'] },
    // sherpa-onnx-node 是不带平台后缀的同名主包，必须显式保留。
    { prefix: 'sherpa-onnx-', keep: ['win-x64'], keepExact: ['sherpa-onnx-node'] },
    { prefix: 'node-addon-require-builtin-', keep: ['win32-x64-msvc'] },
    { prefix: '@koromix/koffi-', keep: ['win32-x64'] },
    // node-addon-system 的 optionalDependencies 只声明 darwin/linux 变体（无
    // win32），Windows 走主包内置实现，故带平台后缀的子包一律剔除；主包名不以
    // '-' 结尾，不匹配本前缀，保留。安全性由打包后的 dsh 冒烟兜验。
    { prefix: '@deepseek-ai/node-addon-system-', keep: [] },
  ].sort((a, b) => b.prefix.length - a.prefix.length);

  const isForeignPlatformPackage = (name) => {
    for (const rule of FOREIGN_PLATFORM_RULES) {
      if (!name.startsWith(rule.prefix)) continue;
      if (rule.keepExact?.includes(name)) return false;
      return !rule.keep.includes(name.slice(rule.prefix.length));
    }
    return false;
  };

  /**
   * 精确排除的非目标平台包（2026-11-13 dev.193 收尾）。
   *
   * FOREIGN_PLATFORM_RULES 靠「包名前缀 + 平台后缀」识别，对**不带平台后缀**、
   * 仅靠 package.json `os` 字段声明平台限制的包无能为力。dev.193 上一轮清理
   * .pnpm 时的匹配词是 darwin / linux，而 @deepseek-ai/dsh-experimental-cua-macos
   * 用的是 macos，于是 3.6 MB 残留被打进产物（os: ["darwin"]，dsh-cua-bundle 的
   * optionalDependency，Windows 上无实现）。与 electron-builder.yml files 的
   * 精确排除规则同口径，两处须同步维护。
   */
  const EXPLICIT_FOREIGN_PACKAGES = new Set(['@deepseek-ai/dsh-experimental-cua-macos']);

  /**
   * 按 manifest 的 os / cpu 字段判断是否面向其他平台。
   *
   * npm 语义：`["darwin"]` 表示只装 darwin；`["!win32"]` 表示排除 win32；
   * 空数组或缺省表示不限。只对 @deepseek-ai/ 自有包启用——第三方包的 os 字段
   * 历史上有写错的先例，不宜一概自动剔除。实测当前产物内声明了 os/cpu 的仅
   * dsh-experimental-cua-macos（darwin，剔除）与 libreoffice-kit-win32-x64
   * （win32+x64，保留），无误伤。
   */
  const manifestTargetsOtherPlatform = (manifest) => {
    if (!manifest) return false;
    const accepts = (list, wanted) => {
      if (!Array.isArray(list) || list.length === 0) return true;
      const values = list.filter((v) => typeof v === 'string');
      if (values.includes(`!${wanted}`)) return false;
      const positives = values.filter((v) => !v.startsWith('!'));
      return positives.length === 0 || positives.includes(wanted);
    };
    return !accepts(manifest.os, 'win32') || !accepts(manifest.cpu, 'x64');
  };

  /** dir 为包实体目录；兜底扫描时由调用方按产物路径补上。 */
  const isForeignPackage = (name, dir) => {
    if (EXPLICIT_FOREIGN_PACKAGES.has(name)) return true;
    if (isForeignPlatformPackage(name)) return true;
    if (
      name.startsWith('@deepseek-ai/') &&
      dir &&
      manifestTargetsOtherPlatform(readManifest(dir))
    ) {
      return true;
    }
    return false;
  };

  const INTENTIONALLY_EXCLUDED = new Set([
    'react',
    'react-dom',
    'lucide-react',
    'marked',
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
  /** 被平台裁剪拦下的非目标平台包（独立统计，便于核对 §4.5 口径）。 */
  const skippedByPlatform = [];
  // 与 electron-builder.yml 的 files 排除规则保持同口径（2026-11-11 dev.191）：
  // 本钩子的 cpSync 是文件级复制，不经过 files 过滤，若不过滤会把 peer-only
  // 包内的类型声明 / TS 源码 / .md 文档一并带进产物（dev.190 基线实测 25 个
  // 包共 148 个）。asar 在 afterPack 之前已生成，这些包只被外部 Node 直读、
  // 不在 asar 索引里，剪掉不会留下「目录可见、打开报 ENOENT」的幽灵条目；
  // 与 files 排除的区别仅在于作用阶段（组装期 vs 补齐期）。
  const NON_RUNTIME_RE = /\.(?:ts|cts|mts|md|map)$/i;
  let filteredFiles = 0;
  let overridden = 0;
  for (const [name, dir] of resolved) {
    if (name.startsWith('@types/')) continue;
    // 非目标平台包优先判定：既不补齐、也不参与下方的版本覆盖，留给兜底裁剪删除。
    if (isForeignPackage(name, dir)) {
      skippedByPlatform.push(name);
      continue;
    }
    // dev.193 整改：产物里已有同名包时不能一律跳过——electron-builder 的
    // traversal 可能先写入旧版本（上游部分 0.2.2-rc.2 包仍依赖 0.2.0-rc.2
    // 公共库）。若已存在版本低于择优结果，必须用新版文件覆盖，否则
    // `3/19 entries did not activate` 会在安装版复现。
    if (packaged.has(name)) {
      // 仅对被 dsh 0.2.x 择优修正的包做覆盖；其余一律保持首次命中版本。
      if (!preferredNames.has(name)) continue;
      const existing = readManifest(join(unpackedModules, name));
      const selected = readManifest(dir);
      const oldV = existing?.version ?? '0.0.0';
      const newV = selected?.version ?? '0.0.0';
      if (compareVersions(newV, oldV) <= 0) continue;
      overridden++;
      console.log(`[after-pack]   ↑ 覆盖旧版 ${name}: ${oldV} → ${newV}`);
    }
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

  // 产物兜底裁剪（2026-11-12 dev.193 体积事故整改）：traversal 收集器在建图
  // 阶段可能已把非目标平台包落盘。files 规则（组装期不收）是主防线，这里在
  // NSIS 生成前再扫一遍实体目录——即使 app.asar 里残留同名索引条目也无害：
  // 这些包名带平台后缀，只有对应平台的 import 会命中，Windows x64 运行时
  // 永远不会 require 它们。
  const prunedPlatform = [];
  for (const name of listPackaged(unpackedModules)) {
    const packagedDir = join(unpackedModules, name);
    if (!isForeignPackage(name, packagedDir)) continue;
    try {
      rmSync(packagedDir, { recursive: true, force: true });
      prunedPlatform.push(name);
    } catch (error) {
      throw new Error(`[after-pack] 删除非目标平台包 ${name} 失败: ${error.message}`);
    }
  }
  if (prunedPlatform.length > 0) {
    console.log(
      `[after-pack] 产物兜底删除非目标平台包 ${prunedPlatform.length} 个（仅保留 Windows x64）：` +
        prunedPlatform.sort().join(', '),
    );
  }

  console.log(
    `[after-pack] 生产依赖闭包 ${resolved.size} 个，产物已含 ${packaged.size} 个，` +
      `补齐 peer-only 依赖 ${copied.length} 个，` +
      `覆盖旧版 ${overridden} 个，` +
      `有意排除 ${skippedByExclusion.length} 个（B1 renderer-only），` +
      `平台裁剪 ${skippedByPlatform.length} 个（非 win32-x64），` +
      `兜底删除 ${prunedPlatform.length} 个，` +
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

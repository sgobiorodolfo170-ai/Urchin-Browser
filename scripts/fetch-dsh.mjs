/**
 * vendor/deepseek-harness 同步脚本（P2-13 / ADR-016，幂等）
 *
 * 背景：dsh 上游整树（约 127MB / 16k 文件，dev 态运行源码）已于 2026-11-06
 * 移出版本控制——它只是外部上游代码，git 里保留会拖慢 clone / git status /
 * 全仓搜索，且每次 rc 升级都会制造万级文件 diff。打包态从未使用这棵树
 * （走 npm 依赖 @deepseek-ai/dsh 的 app.asar.unpacked 闭包）。
 *
 * 本脚本从上游 tag 拉取源码到 vendor/deepseek-harness/，并在 vendor 内安装依赖：
 *
 *   1. 版本唯一真源 = apps/desktop/package.json 的依赖 "@deepseek-ai/dsh"
 *      （精确 pin，无 ^~ 前缀）——锁文件与 vendor 都以它为准。
 *   2. vendor 版本匹配且依赖已安装 → 检查 Typert / Client 运行时出口，缺失则补建（幂等）。
 *   3. 版本不匹配 / 目录缺失 → 删除旧树（含 node_modules，约 2GB，可能较慢）
 *      后 `git clone --depth 1 --branch dsh-v<版本>`，再在 vendor 内安装依赖。
 *   4. 安装命令按 vendor 自身 package.json 的 packageManager 字段推导
 *      （上游用独立 pnpm 大版本，与本仓库 9.x 不兼容，必须经 npx 指定）。
 *
 * 用法（仓库根执行）：
 *   pnpm sync:dsh              # 常规同步（幂等）
 *   pnpm sync:dsh -- --force   # 忽略本地状态，强制重新拉取
 *
 * 可用环境变量：URCHIN_DSH_REPO 覆盖上游仓库 URL（默认 GitHub 官方仓库）。
 *
 * 已知 Windows 事项：vendor node_modules 约 1.96GB 且含 pnpm 符号链接树，
 * 删除可能耗时 1-2 分钟；如删除失败（文件被占用），请手动清理该目录后重跑。
 */
import { execFile, execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { missingRuntimeArtifacts, typertGeneratorArgs } from './lib/dsh-dev-artifacts.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopPkgPath = join(repoRoot, 'apps', 'desktop', 'package.json');
const vendorDir = join(repoRoot, 'vendor', 'deepseek-harness');
const stampFile = join(vendorDir, '.dsh-installed-version');
const FORCE = process.argv.includes('--force');

/** 默认上游仓库（dsh 的 GitHub tag 命名为 dsh-v<版本>） */
const dshRepoUrl =
  process.env.URCHIN_DSH_REPO ?? 'https://github.com/deepseek-ai/deepseek-harness.git';

function fail(msg) {
  console.error(`[fetch-dsh] ${msg}`);
  process.exit(1);
}

/** 从桌面包读版本真源；仅接受精确 pin（禁 ^/~ 前缀——三源一致的门禁前提） */
function readDesiredVersion() {
  const pkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
  const dep = pkg.dependencies?.['@deepseek-ai/dsh'];
  if (!dep) fail('apps/desktop/package.json 未声明 @deepseek-ai/dsh 依赖，无法确定 vendor 版本');
  if (!/^\d/.test(dep)) {
    fail(`@deepseek-ai/dsh 依赖必须为精确版本（当前 "${dep}" 含 ^/~ 前缀）——版本真源不明确`);
  }
  return dep;
}

/** vendor 当前版本（目录/package.json 不存在或无法解析时返回 null） */
function readVendorVersion() {
  try {
    return JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 依赖安装戳（上次成功 install 的版本；缺失视为需重装） */
function readInstalledStamp() {
  try {
    return readFileSync(stampFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** 删除旧树：含 ~2GB node_modules，Windows 下可能较慢；失败给出手工清理指引 */
function removeVendorTree() {
  console.log(
    '[fetch-dsh] 清理现有 vendor/deepseek-harness（含 ~2GB node_modules，可能耗时 1-2 分钟）…',
  );
  try {
    rmSync(vendorDir, { recursive: true, maxRetries: 3, retryDelay: 500 });
  } catch (err) {
    fail(
      `删除失败（${err.message}）。常见原因是文件被占用（编辑器 / 正在运行的 dsh）。` +
        '\n请手动清空 vendor/deepseek-harness 后重跑；dsh dev 进程运行中需先关闭浏览器。',
    );
  }
}

async function cloneTag(tag) {
  console.log(`[fetch-dsh] git clone --depth 1 --branch ${tag}（上游整树约 127MB，取决于网络）…`);
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--branch', tag, dshRepoUrl, vendorDir], {
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (err) {
    fail(`clone 失败：${err.stderr || err.message}\n可设 URCHIN_DSH_REPO 指向镜像仓库后重试`);
  }
}

function installDependencies() {
  let pm = 'pnpm@11.28.5';
  try {
    // 上游 package.json 的 packageManager 决定其 pnpm 大版本（history: 11.28.5），
    // 与本仓库 9.x 工程不兼容，必须经 npx 精确指定
    pm = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8')).packageManager ?? pm;
  } catch {
    /* 读不到就退回已知值 */
  }
  console.log(`[fetch-dsh] vendor 内安装依赖（${pm} install，首次 ~2GB，耐心等待）…`);
  execSync(`npx ${pm} install --no-frozen-lockfile`, {
    // workspace 探测按 cwd 定位：vendor 自身的 pnpm-workspace.yaml 生效，
    // 与本仓库工程互不干扰（已实测：vendor 内 "all 367 workspace projects"）
    cwd: vendorDir,
    stdio: 'inherit',
  });
  writeFileSync(stampFile, `${readVendorVersion()}\n`, 'utf8');
}

function prepareDevRuntime() {
  const nodePath = join(repoRoot, 'apps', 'desktop', 'build', 'node', 'node.exe');
  if (!existsSync(nodePath)) fail('缺少便携 Node v24，请先运行 node scripts/fetch-node.mjs');
  let state = missingRuntimeArtifacts(vendorDir);
  if (state.missing.length > 0) {
    console.log(`[fetch-dsh] 缺少 ${state.missing.length} 个 Typert 运行时文件，执行上游生成器 …`);
    execFileSync(nodePath, typertGeneratorArgs, { cwd: vendorDir, stdio: 'inherit' });
    state = missingRuntimeArtifacts(vendorDir);
    if (state.missing.length > 0) fail(`生成后仍缺少 Typert 文件：${state.missing.join(', ')}`);
  }
  console.log(`[fetch-dsh] Typert 运行时文件齐全（${state.contributors} 个 contributor）`);
  let client = missingRuntimeArtifacts(vendorDir, './client');
  if (client.missing.length > 0) {
    console.log(
      `[fetch-dsh] 缺少 ${client.missing.length} 个 Client bundle，编译 Host/Client 后打包 …`,
    );
    execFileSync(
      nodePath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '--eval',
        "import { referencedProjectsCompilerArgs } from './scripts/compile-referenced-projects.ts'; " +
          "import { spawnSync } from 'node:child_process'; " +
          "for (const face of ['host','client']) { const r = spawnSync(process.execPath, referencedProjectsCompilerArgs(process.cwd(), face), {stdio:'inherit'}); if (r.status !== 0) process.exit(r.status ?? 1); }",
      ],
      { cwd: vendorDir, stdio: 'inherit' },
    );
    execFileSync(
      nodePath,
      [
        'node_modules/tsdown/dist/run.mjs',
        '--config-loader',
        'native',
        '--env.DSH_BUILD_FACE',
        'client',
      ],
      { cwd: vendorDir, stdio: 'inherit' },
    );
    client = missingRuntimeArtifacts(vendorDir, './client');
    if (client.missing.length > 0) fail(`打包后仍缺少 Client bundle：${client.missing.join(', ')}`);
  }
  console.log(`[fetch-dsh] Client bundle 齐全（${client.contributors} 个包）`);
}

async function main() {
  const desired = readDesiredVersion();
  const tag = `dsh-v${desired}`;
  const vendorVersion = readVendorVersion();
  const installed = readInstalledStamp();

  if (FORCE) {
    console.log('[fetch-dsh] --force：忽略本地状态，重新拉取');
  } else if (vendorVersion === desired) {
    if (installed === desired) {
      prepareDevRuntime();
      console.log(
        `[fetch-dsh] vendor/${desired} 已就绪（版本、依赖与 Typert/Client 文件检查通过）。`,
      );
      return;
    }
    console.log(`[fetch-dsh] vendor 版本 ${desired} 已匹配，仅补装依赖 …`);
    installDependencies();
    prepareDevRuntime();
    console.log('[fetch-dsh] 完成：开发态依赖与 Typert/Client 运行时文件已就绪。');
    return;
  } else if (vendorVersion != null) {
    console.log(`[fetch-dsh] vendor 版本不匹配：本地 ${vendorVersion} → 目标 ${desired}，重建`);
  } else {
    console.log('[fetch-dsh] vendor/deepseek-harness 不存在（首次拉取或已被清理）');
  }

  if (existsSync(vendorDir)) removeVendorTree();
  await cloneTag(tag);
  // 防御性校验：tag 与真源必须一致，否则立即失败（打错 tag / 上游改名）
  const cloned = readVendorVersion();
  if (cloned !== desired) {
    fail(
      `clone 产物版本 ${cloned} ≠ 期望 ${desired}——检查 tag ${tag} 是否存在（上游 tag 命名为 dsh-v<版本>）`,
    );
  }
  installDependencies();
  prepareDevRuntime();
  console.log('[fetch-dsh] 完成：vendor/deepseek-harness 已就绪。');
}

main().catch((err) => {
  // 顶层兜底：任何未预期异常直接失败退出（脚本语义 = 同步必须可靠）
  fail(`未预期异常：${err.stack || err.message}`);
});

/**
 * 便携 Node 下载脚本（X4 打包前置步骤，幂等）
 *
 * 背景（2026-10-16 X4 决策）：打包态 dsh 启动器不能用 Electron 内置 Node——
 * dsh 依赖 node-addon-require-builtin 校验运行时指纹，拒绝 Electron V8
 * （unsupported Electron runtime fingerprint）。因此安装包需随附一个纯 Node
 * 运行时：本脚本从镜像下载官方 win-x64 zip，仅提取 node.exe 到
 * apps/desktop/build/node/（extraResources 打包为 resources/node/node.exe）。
 *
 * 幂等策略：目标 node.exe 已存在且 `--version` 与 NODE_VERSION 匹配时直接跳过
 * （打上 .node-version 戳避免每次执行都启动 90MB 二进制做校验）。
 *
 * 下载源：默认 npmmirror（本机既有镜像约定），失败自动回退 nodejs.org 官方源；
 * 亦可用环境变量 URCHIN_NODE_DIST_URL 指定完整 URL 覆盖。
 */
import { execFile } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

/** 便携 Node 版本（与 X4 冒烟验证所用版本一致，升级需重跑验证链） */
const NODE_VERSION = 'v24.22.0';
/** zip 内根目录名 */
const ZIP_ROOT = `node-${NODE_VERSION}-win-x64`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'apps', 'desktop', 'build', 'node');
const nodeExePath = join(outDir, 'node.exe');
const stampPath = join(outDir, '.node-version');

/** 候选下载地址：npmmirror → nodejs.org 官方（均可被 URCHIN_NODE_DIST_URL 覆盖） */
const DIST_URLS = [
  process.env.URCHIN_NODE_DIST_URL,
  `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/${ZIP_ROOT}.zip`,
  `https://nodejs.org/dist/${NODE_VERSION}/${ZIP_ROOT}.zip`,
].filter((u) => typeof u === 'string' && u.length > 0);

/** 目标 node.exe 的 `--version` 输出（失败返回空串） */
async function probeVersion(exePath) {
  try {
    const { stdout } = await execFileAsync(exePath, ['--version'], { windowsHide: true });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** 下载 URL 到本地文件（流式，带进度日志与总大小校验） */
async function download(url, destFile) {
  console.log('[fetch-node] downloading:', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastLogged = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (received - lastLogged >= 10 * 1024 * 1024) {
      lastLogged = received;
      const pct = total > 0 ? ` (${Math.round((received / total) * 100)}%)` : '';
      console.log(`[fetch-node]   ...${(received / 1024 / 1024).toFixed(1)}MB${pct}`);
    }
  });
  await pipeline(source, createWriteStream(destFile));
  if (total > 0 && received !== total) {
    throw new Error(`下载不完整：${received}/${total} 字节`);
  }
  return received;
}

/** 从 zip 提取 node.exe 到 destDir（Windows 自带 bsdtar 优先；失败回退 PowerShell Expand-Archive） */
async function extractNodeExe(zipPath, destDir) {
  try {
    // Windows 10+ 自带 bsdtar（System32\tar.exe），支持 zip 单成员提取
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir, `${ZIP_ROOT}/node.exe`], {
      windowsHide: true,
    });
    return;
  } catch (err) {
    console.warn(
      '[fetch-node] tar extraction failed, falling back to Expand-Archive:',
      err.message,
    );
  }
  if (zipPath.includes("'") || destDir.includes("'")) {
    throw new Error('临时路径包含单引号，无法安全传给 PowerShell');
  }
  await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { windowsHide: true },
  );
}

async function main() {
  // 幂等快捷路径：戳文件匹配即跳过（不启动二进制探测）
  if (existsSync(nodeExePath) && existsSync(stampPath)) {
    const stamped = readFileSync(stampPath, 'utf8').trim();
    if (stamped === NODE_VERSION) {
      console.log(`[fetch-node] node.exe ${NODE_VERSION} already present (stamp match), skipping`);
      return;
    }
  }
  // 已有 node.exe 但无戳（如早期手工放置）：验证版本相符则补戳跳过
  if (existsSync(nodeExePath)) {
    const version = await probeVersion(nodeExePath);
    if (version === NODE_VERSION) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(stampPath, `${NODE_VERSION}\n`);
      console.log(`[fetch-node] existing node.exe verified as ${version}, stamping and skipping`);
      return;
    }
    console.log(`[fetch-node] existing node.exe is ${version || 'unusable'}, re-downloading`);
  }

  mkdirSync(outDir, { recursive: true });
  const workDir = join(tmpdir(), `urchin-fetch-node-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const zipPath = join(workDir, `${ZIP_ROOT}.zip`);

  try {
    let downloaded = false;
    let lastError;
    for (const url of DIST_URLS) {
      try {
        await download(url, zipPath);
        downloaded = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[fetch-node] download failed from ${url}: ${err.message}`);
        rmSync(zipPath, { force: true });
      }
    }
    if (!downloaded) {
      throw new Error(`全部下载源失败，最后错误：${lastError?.message ?? 'unknown'}`);
    }

    await extractNodeExe(zipPath, workDir);
    const extracted = join(workDir, ZIP_ROOT, 'node.exe');
    if (!existsSync(extracted)) {
      throw new Error(`zip 内未找到 ${ZIP_ROOT}/node.exe`);
    }
    // 先落到目标目录再校验（rename 同盘原子；校验失败则删除避免脏产物）
    renameSync(extracted, nodeExePath);
    const version = await probeVersion(nodeExePath);
    if (version !== NODE_VERSION) {
      rmSync(nodeExePath, { force: true });
      throw new Error(
        `node.exe 版本校验失败：期望 ${NODE_VERSION}，实际 ${version || '(无法执行)'}`,
      );
    }
    writeFileSync(stampPath, `${NODE_VERSION}\n`);
    console.log(
      `[fetch-node] done: ${nodeExePath} (${readFileSizeMb(nodeExePath).toFixed(1)}MB, ${version})`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** 文件大小（MB，仅日志用） */
function readFileSizeMb(path) {
  try {
    return statSync(path).size / 1024 / 1024;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error('[fetch-node] FATAL:', err.message);
  process.exit(1);
});

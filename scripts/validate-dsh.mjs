/**
 * DSH 运行时门禁（2026-11-12 dev.193 事故整改 · R4）
 *
 * 背景：dev.193 的安装版能启动 dsh web、认证 URL 正常、页面 200，但
 * `3 entries did not activate`——打包产物里 22 个 `@deepseek-ai/*` 包停留在
 * `0.2.0-rc.2`、其余 273 个是 `0.2.1-rc.3`，peer 依赖解析到旧版导致 ESM
 * 具名导出缺失，DeepSeek LLM provider 与会话标题插件全部激活失败，无法创建会话。
 * 原门禁只断言 3 个文件「存在」，既不校验版本、也不启动冒烟，错误被一路放行。
 *
 * 本模块提供两条硬校验，由 scripts/package-win.mjs 在产物校验阶段调用：
 *   1. validateDshVersions —— `@deepseek-ai/dsh-*` 的 0.2.x 版本族必须与主包一致；
 *   2. smokeTestDsh       —— 用随包便携 Node + 临时 DSH_HOME 真跑一次 `dsh web`，
 *      必须捕获认证 URL，且 stderr 不得出现插件激活失败关键字。
 *
 * 冒烟使用**临时 DSH_HOME**，因此不受用户 DSH_HOME 里第三方插件
 * （如 @ebony-vinyl/dsh-our-free-model）的影响；第三方插件问题不在本项目范围。
 *
 * 稳定性（2026-11-12 最终打包复盘）：初版用 20000~50000 随机端口且只跑一次，
 * 在完整打包末尾偶发 `dsh 提前退出 (code=1)`，手动复跑 4 次均 stderr=0B 通过，
 * 属端口撞车 / 打包刚结束时的瞬时资源竞争。现改为让内核分配空闲端口，并对
 * 「未就绪」类失败最多重试 3 次；插件激活失败等致命特征一律立即失败、不重试。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 插件激活失败的致命特征（stderr 出现任一即判定冒烟失败，且不重试）。 */
const FATAL_STDERR_RE =
  /did not activate|does not provide an export named|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/i;

/** 认证 URL 特征：dsh web 就绪时向 stdout 打印 http://127.0.0.1:<port>/?token=... */
const AUTH_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=/i;

/**
 * 允许停留在旧版本的包（白名单）。
 *
 * 2026-11-12 dev.193 体积/残留事故复盘：这里原先放行 `dsh-invariants`，理由是
 * 「上游 registry 没有 0.2.2-rc.2」。但复查发现它在根 pnpm-lock.yaml、虚拟快照
 * `node_modules/.pnpm/lock.yaml`、`apps/desktop/node_modules` 里都是 **0 引用**，
 * 产物内也没有任何包 require 它——它只是升级前 `node_modules` 的残留，
 * 被打包器顺着 peer 变体目录的链接一起带进了产物。白名单等于给一个本不该存在
 * 的包发了通行证，同类问题会继续隐身。
 *
 * 现规定：**白名单必须为空**。确有上游未发布新版的真依赖时，须先证明它是真依赖
 * （lockfile 有引用 + 产物内有 require），逐条注明依据，并在冒烟通过后才允许加回。
 */
const ALLOWED_LEGACY = new Set();

function readVersion(pkgDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/** 产物内 @deepseek-ai 包根目录。 */
function dshRootOf(releaseDir) {
  return join(
    resolve(releaseDir),
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@deepseek-ai',
  );
}

/**
 * 版本单一性检查。
 *
 * 只约束 `dsh-*` 前缀中形如 `0.2.x` 的版本族：cordis / schemastery /
 * cordis-plugin-* 属于独立版本线（~4.1.0 / ~3.19.0 / 1.x），不在该前缀下或
 * 版本形态不同，一概不纳入，避免误报。ALLOWED_LEGACY 白名单见上文，
 * **当前为空**：任何 0.2.x 旧版本都必须让打包失败，不接受例外。
 */
export function validateDshVersions(releaseDir) {
  const root = dshRootOf(releaseDir);
  if (!existsSync(root)) {
    throw new Error(`[dsh-gate] 产物内缺少 @deepseek-ai 目录: ${root}`);
  }
  const main = readVersion(join(root, 'dsh'));
  if (!main) {
    throw new Error(`[dsh-gate] 无法读取 @deepseek-ai/dsh 版本: ${join(root, 'dsh')}`);
  }

  const histogram = new Map();
  const mismatched = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith('dsh')) continue;
    const version = readVersion(join(root, name));
    if (!version) continue;
    histogram.set(version, (histogram.get(version) ?? 0) + 1);
    if (/^0\.2\./.test(version) && version !== main && !ALLOWED_LEGACY.has(name)) {
      mismatched.push(`${name}@${version}`);
    }
  }

  const distribution = [...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => `${version}x${count}`)
    .join(', ');
  console.log(`[dsh-gate] 主版本 ${main}；dsh-* 版本分布: ${distribution}`);

  if (mismatched.length > 0) {
    throw new Error(
      `[dsh-gate] @deepseek-ai/dsh-* 版本错配（应全部为 ${main}）：${mismatched.join(', ')}`,
    );
  }
  return { main, histogram: Object.fromEntries(histogram) };
}

/** 让内核分配一个确定空闲的端口，避免随机端口撞上本机残留监听。 */
function pickFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error('[dsh-gate] 无法获取空闲端口'));
      });
    });
  });
}

/**
 * 单次启动冒烟：临时 DSH_HOME 起 dsh web，捕获认证 URL，校验 stderr。
 * 失败时抛出的 Error 带 retryable / stdout / stderr，供上层决定是否换端口重试。
 * @returns {Promise<{port:number, stderrBytes:number, authUrl:string}>}
 */
function runSmokeOnce(resources, port, timeoutMs) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const nodeExe = join(resources, 'node', 'node.exe');
    const cliEntry = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );

    // 临时 DSH_HOME：隔离用户 profile / 凭据 / 第三方插件，只验项目自带运行时。
    const home = mkdtempSync(join(tmpdir(), 'urchin-dsh-smoke-'));
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let authUrl = '';
    let timer = null;

    const child = spawn(nodeExe, [cliEntry, 'web', '--no-open', '--port', String(port)], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (failure, retryable = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响判定 */
      }

      const tail = `\n--- dsh stdout ---\n${stdout.slice(-1500)}\n--- dsh stderr ---\n${stderr.slice(-4000)}`;
      const fail = (reason, retryable) => {
        const error = new Error(`[dsh-gate] ${reason}${tail}`);
        error.retryable = retryable;
        error.stdout = stdout;
        error.stderr = stderr;
        rejectSmoke(error);
      };

      // 无论是否就绪，只要 stderr 出现插件激活失败特征就立即判死，绝不重试掩盖。
      if (FATAL_STDERR_RE.test(stderr)) {
        fail('dsh 冒烟 stderr 出现插件激活失败', false);
        return;
      }
      if (failure) {
        fail(failure, retryable);
        return;
      }
      if (!authUrl) {
        fail('未捕获 dsh web 认证 URL', true);
        return;
      }
      console.log(
        `[dsh-gate] 冒烟通过：port=${port} stderr=${Buffer.byteLength(stderr)}B authUrl=***`,
      );
      resolveSmoke({ port, stderrBytes: Buffer.byteLength(stderr), authUrl: '***REDACTED***' });
    };

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      const match = AUTH_URL_RE.exec(Buffer.concat(stdoutChunks).toString('utf8'));
      if (match && !authUrl) {
        authUrl = match[0];
        // 留一点时间让同一批插件激活错误刷到 stderr，再收口判定。
        setTimeout(() => finish(), 3000);
      }
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => finish(`启动 dsh 失败: ${error.message}`));
    child.on('exit', (code) => {
      if (!settled) finish(`dsh 提前退出 (code=${code})，未进入就绪状态`);
    });
    // 90 秒都未就绪说明不是端口/文件锁这类瞬时抖动，重试无益且会拖长发布链路。
    timer = setTimeout(() => finish(`冒烟超时 ${timeoutMs}ms`, false), timeoutMs);
  });
}

/**
 * 启动冒烟（带瞬时失败重试）。
 * 只有「提前退出 / 未捕获 URL / 启动失败 / 超时」这类可恢复失败才换端口重试；
 * stderr 命中 FATAL_STDERR_RE 时不可重试，直接抛错。
 */
export async function smokeTestDsh(releaseDir, { timeoutMs = 90000, attempts = 3 } = {}) {
  // 注意：路径必须在 Promise 外算好。Promise executor 的参数曾命名为 `resolve`，
  // 会遮蔽从 node:path 导入的同名函数，导致冒烟被静默跳过（2026-11-12 实测踩过）。
  const resources = join(resolve(releaseDir), 'win-unpacked', 'resources');
  const nodeExe = join(resources, 'node', 'node.exe');
  const cliEntry = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  for (const path of [nodeExe, cliEntry]) {
    if (!existsSync(path)) {
      throw new Error(`[dsh-gate] 冒烟前置文件缺失: ${path}`);
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await pickFreePort();
    try {
      return await runSmokeOnce(resources, port, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts) break;
      const stderrSummary = String(error.stderr ?? '')
        .slice(-600)
        .replace(/\r?\n/g, ' ⏎ ');
      console.error(
        `[dsh-gate] 第 ${attempt}/${attempts} 次冒烟未就绪（port=${port}），换端口重试；dsh stderr 摘要：${stderrSummary || '(空)'}`,
      );
    }
  }
  throw lastError;
}

/** 组合门禁。skipSmoke 用于排障（CLI 传 --skip-dsh-smoke）。 */
export async function validateDshRuntime(releaseDir, { skipSmoke = false, timeoutMs } = {}) {
  const versions = validateDshVersions(releaseDir);
  // Agent 预设工具在新建会话时才加载，启动冒烟无法发现它的依赖被裁掉。
  const resources = join(resolve(releaseDir), 'win-unpacked', 'resources');
  const toolEntry = join(dshRootOf(releaseDir), 'dsh-tool-web', 'lib', 'index.js');
  execFileSync(
    join(resources, 'node', 'node.exe'),
    [
      '--permission',
      `--allow-fs-read=${join(resolve(releaseDir), 'win-unpacked')}`,
      '--input-type=module',
      '--eval',
      'await import(process.argv[1]);',
      pathToFileURL(toolEntry).href,
    ],
    { timeout: 30000, stdio: 'pipe' },
  );
  console.log('[dsh-gate] Agent 预设工具 dsh-tool-web 导入通过（只允许读取产物目录）');
  if (skipSmoke) {
    console.log('[dsh-gate] 启动冒烟已跳过（--skip-dsh-smoke）');
    return { ...versions, smoke: 'skipped' };
  }
  const smoke = await smokeTestDsh(releaseDir, timeoutMs ? { timeoutMs } : {});
  return { ...versions, smoke };
}

/**
 * DeepSeek Harness 启动器 · Node 子进程生命周期管理（双模式，X4）
 *
 * 职责：
 * 1. 直启 dsh CLI（dsh web 子命令，Node 运行时）+ 捕获 stdout 解析认证 URL
 * 2. 随机空闲端口探测（--port CLI 旗标传递）
 * 3. 进程树终止（Windows taskkill /T /F；类 Unix kill 进程组）
 * 4. 状态机：stopped → starting → running / error，支持崩溃后重启
 *
 * 运行模式（2026-10-16 X4 决策，用户指令：新机器安装零额外下载）：
 * - 开发态：**便携 node.exe**（apps/desktop/build/node/node.exe，
 *   scripts/fetch-node.mjs 前置生成）+ tsx ESM loader 直启
 *   vendor/deepseek-harness 的 TypeScript 源码（apps/cli/src/bin.ts）；
 *   cwd=vendor 目录（tsx 从 cwd node_modules 解析依赖）。
 * - 打包态：**便携 node.exe**（extraResources → resources/node/node.exe）
 *   + npm 包 @deepseek-ai/dsh/lib/bin.js（app.asar.unpacked）。
 * - 为何两种模式都不用 Electron 内置 Node：dsh 依赖 node-addon-require-builtin
 *   校验运行时指纹，实探**双态均拒绝** Electron V8（unsupported Electron
 *   runtime fingerprint: …-electron.0；其支持表按精确 Electron 版本匹配，
 *   43.8.0 不在列），必须有独立纯 Node 运行时。保留 process.execPath +
 *   ELECTRON_RUN_AS_NODE=1 作为兜底路径（nodePath 缺省时启用），待其支持表
 *   覆盖现行 Electron 后可切回。
 * - 命令行等价：`<node> [--import tsx/esm] <cliEntry> web --no-open --port <port>`
 *   --no-open 禁止自动拉起系统浏览器（一律由 Urchin 打开标签页）
 *
 * 认证机制（与 piWeb 的关键差异）：
 * dsh web 在每次启动时生成 32 字节随机 token，附加到 URL 的 ?token= 参数
 * （43 字符 base64url）。token 输出到 stdout（格式：
 * `dsh web: http://127.0.0.1:<port>/?token=<43chars>`）。
 * 不存在 --no-auth 旗标或环境变量；必须捕获 stdout 解析完整认证 URL。
 * 首次访问该 URL 后服务端设置签名 cookie（30 天有效），后续请求无需 token。
 *
 * 数据目录：DSH_HOME 环境变量指向 userData/deepseek-harness。
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { createLogger } from '@urchin/logger';

const log = createLogger('dsh-launcher');

/** stdout URL 解析轮询间隔（与 healthPollIntervalMs 共用） */
const POLL_INTERVAL_MS = 1_000;
/** 启动超时：dsh 冷启动含 Cordis 插件加载 + tsx 转译，给足余量 */
const STARTUP_TIMEOUT_MS = 120_000;

/**
 * dsh web stdout 中认证 URL 行的正则（X4 分块加固）。
 *
 * stdout 按 chunk 到达，URL 行可能跨 chunk 切断：token 字符集为 base64url，
 * 若在 token 中途切断、缓冲末尾立即匹配，会捕获到**截断的不完整 token**
 * （首次访问 401，cookie 无法签发）。因此要求 token 之后必须已出现终止符
 * （空白或 ANSI 转义，两者都不属于 token 字符集）才接受匹配；尚未出现
 * 终止符 = token 未收完，继续等待下一 chunk。
 * 注意：不能用 `$`（缓冲末尾锚点）作可接受终止符——否则截断误判会复现。
 */
export const DSH_URL_LINE_RE =
  // eslint-disable-next-line no-control-regex -- \x1b（ANSI ESC）是刻意的 token 终止符（详见上方注释）
  /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?=[\s\x1b])/;

/** 子进程最小接口（测试可注入 mock） */
export interface ChildProcessLike {
  readonly pid?: number;
  readonly killed: boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
}

/** 进程工厂签名（node:child_process.spawn 的可注入子集） */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
) => ChildProcessLike;

/** 状态机状态 */
export type DshState = 'stopped' | 'starting' | 'running' | 'error';

/** 对外状态快照（与 ipc-contract deepseekHarnessStatusRes 对齐） */
export interface DshStatusSnapshot {
  readonly state: DshState;
  readonly url?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly lastError?: string;
}

/** 启动结果（认证 URL + 端口） */
export interface DshLaunchResult {
  readonly port: number;
  readonly url: string;
}

/** 启动器选项 */
export interface DshLauncherOptions {
  /**
   * 子进程工作目录。开发态传 vendor/deepseek-harness（tsx 从该目录的
   * node_modules 解析依赖）；打包态传数据目录即可（npm 产物按自身路径解析依赖）。
   */
  readonly cwdDir: string;
  /**
   * CLI 入口路径。开发态为相对 cwdDir 的 'apps/cli/src/bin.ts'（默认值）；
   * 打包态传 bin.js 绝对路径（app.asar.unpacked 内）。
   */
  readonly cliEntry?: string;
  /**
   * 运行时可执行文件绝对路径（开发态：apps/desktop/build/node/node.exe；
   * 打包态：resources/node/node.exe——均为便携 Node，fetch-node.mjs 产物）。
   * 不传 = process.execPath + ELECTRON_RUN_AS_NODE=1 兜底；注意现行
   * Electron 会被 node-addon-require-builtin 指纹拒绝（见文件头注释），
   * 双态均应显式传便携 node.exe。
   */
  readonly nodePath?: string;
  /**
   * 是否以 tsx ESM loader 启动 TypeScript 源码（默认 true = 开发态 vendor）。
   * false = npm 预编译产物模式（纯 node 直接执行 cliEntry，无 tsx、无
   * ELECTRON_RUN_AS_NODE）。
   */
  readonly usesTsxLoader?: boolean;
  readonly dataDir: string;
  readonly spawnFn?: SpawnFn;
  readonly killTreeFn?: (pid: number) => Promise<void>;
  readonly portPickerFn?: () => Promise<number>;
  readonly ensureDirFn?: (dir: string) => Promise<void>;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** 默认进程工厂：直启 node.exe，stdio pipe 捕获 stdout */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
): ChildProcessLike {
  return spawn(command, [...args], options);
}

/** 默认进程树终止：Windows 用 taskkill /T /F 杀整棵树 */
async function defaultKillTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
        if (err && !/not found|找不到|no running/i.test(String(err.message))) {
          reject(new Error(err.message));
        } else {
          resolve();
        }
      });
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 已退出：幂等成功
  }
}

/** 默认空闲端口探测：绑定 0 让 OS 分配，立即释放 */
function defaultPickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 默认目录确保存在：递归 mkdir */
async function defaultEnsureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * DeepSeek Harness Web 服务启动器。
 *
 * launch() 幂等（并发调用复用同一次启动）；stop() 终止子进程树；
 * dispose() 供 app 退出清理调用。
 */
export class DshLauncher {
  private readonly opts: DshLauncherOptions & {
    readonly cliEntry: string;
    readonly usesTsxLoader: boolean;
    readonly spawnFn: SpawnFn;
    readonly killTreeFn: (pid: number) => Promise<void>;
    readonly portPickerFn: () => Promise<number>;
    readonly ensureDirFn: (dir: string) => Promise<void>;
    readonly startupTimeoutMs: number;
    readonly pollIntervalMs: number;
  };
  private state: DshState = 'stopped';
  private port: number | undefined;
  private authenticatedUrl: string | undefined;
  private child: ChildProcessLike | undefined;
  private stopping = false;
  private lastError: string | undefined;
  private pendingLaunch: Promise<DshLaunchResult> | undefined;

  constructor(options: DshLauncherOptions) {
    this.opts = {
      ...options,
      cliEntry: options.cliEntry ?? 'apps/cli/src/bin.ts',
      usesTsxLoader: options.usesTsxLoader ?? true,
      spawnFn: options.spawnFn ?? defaultSpawn,
      killTreeFn: options.killTreeFn ?? defaultKillTree,
      portPickerFn: options.portPickerFn ?? defaultPickFreePort,
      ensureDirFn: options.ensureDirFn ?? defaultEnsureDir,
      startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    };
  }

  /** 当前状态快照 */
  status(): DshStatusSnapshot {
    return {
      state: this.state,
      url: this.state === 'running' ? this.authenticatedUrl : undefined,
      port: this.port,
      pid: this.child?.pid,
      lastError: this.lastError,
    };
  }

  /**
   * 启动（或复用）dsh web 服务。
   *
   * @returns 认证 URL + 端口
   * @throws 启动失败时抛 Error，状态置 error
   */
  async launch(): Promise<DshLaunchResult> {
    if (this.state === 'running' && this.authenticatedUrl && this.port) {
      return { port: this.port, url: this.authenticatedUrl };
    }
    this.pendingLaunch ??= this.startProcess().finally(() => {
      this.pendingLaunch = undefined;
    });
    return this.pendingLaunch;
  }

  /** 单次启动流程：确保目录 → 选端口 → spawn → 等待 stdout 认证 URL */
  private async startProcess(): Promise<DshLaunchResult> {
    this.stopping = false;
    this.lastError = undefined;
    this.authenticatedUrl = undefined;
    this.state = 'starting';

    try {
      await this.opts.ensureDirFn(this.opts.dataDir);
    } catch (e) {
      return this.failLaunch(`数据目录创建失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    let port: number;
    try {
      port = await this.opts.portPickerFn();
    } catch (e) {
      return this.failLaunch(`端口探测失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.port = port;

    log.info('spawning dsh web', {
      cwdDir: this.opts.cwdDir,
      cliEntry: this.opts.cliEntry,
      nodePath: this.opts.nodePath ?? '(electron built-in node)',
      usesTsxLoader: this.opts.usesTsxLoader,
      port,
      dataDir: this.opts.dataDir,
    });

    let exited = false;
    let exitCode: number | null = null;
    let stdoutBuffer = '';
    let resolvedUrl: string | undefined;

    // 双模式命令构造：开发态便携 node.exe + tsx ESM loader（vendor TS 源码）；
    // 打包态便携 node.exe 直执行 npm 预编译产物（无 tsx）
    const command = this.opts.nodePath ?? process.execPath;
    const args = this.opts.usesTsxLoader
      ? ['--import', 'tsx/esm', this.opts.cliEntry, 'web', '--no-open', '--port', String(port)]
      : [this.opts.cliEntry, 'web', '--no-open', '--port', String(port)];

    const child = this.opts.spawnFn(command, args, {
      env: {
        ...process.env,
        // 兜底路径（未传 nodePath）：让 Electron 二进制作为纯 Node.js 运行时；
        // 双态正常接线均显式传便携 node.exe，现状不会走到这里（见文件头注释）
        ...(this.opts.nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
        DSH_HOME: this.opts.dataDir,
      },
      cwd: this.opts.cwdDir,
      stdio: 'pipe',
    });
    this.child = child;

    // 捕获 stdout：dsh web 在服务就绪后输出 `dsh web: http://127.0.0.1:<port>/?token=...`
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuffer += text;
      // 逐行检查是否包含认证 URL
      if (resolvedUrl === undefined) {
        const match = DSH_URL_LINE_RE.exec(stdoutBuffer);
        if (match) {
          resolvedUrl = match[1];
          log.info('dsh web authenticated URL captured from stdout', { port });
        }
      }
      // 调试：记录关键 stdout 行（截断防刷屏）
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.includes('dsh web:') || line.includes('error') || line.includes('Error')) {
          log.debug('dsh stdout', { line: line.substring(0, 200) });
        }
      }
    });

    // 捕获 stderr：记录错误输出用于诊断
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          log.warn('dsh stderr', { line: line.substring(0, 200) });
        }
      }
    });

    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (this.stopping) return;
      const wasRunning = this.state === 'running';
      if (wasRunning || this.state === 'starting') {
        this.state = 'error';
        this.lastError = `dsh 进程意外退出（code=${String(code)}）`;
        log.error('dsh exited unexpectedly', { code, wasRunning });
      }
    });
    child.on('error', (err) => {
      exited = true;
      this.state = 'error';
      this.lastError = this.opts.usesTsxLoader
        ? `无法启动子进程（${err.message}）。Electron 内置 Node 应随安装包就绪，无需另装`
        : `无法启动子进程（${err.message}）。请检查便携 Node（resources/node/node.exe）是否随安装包就绪`;
      log.error('spawn node failed', { error: err.message });
    });

    // 等待 stdout 输出认证 URL（服务就绪信号）
    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        return this.failLaunch(
          this.opts.usesTsxLoader
            ? `dsh 启动即退出（code=${String(exitCode)}）。请检查 vendor/deepseek-harness 依赖安装（pnpm install）与构建（pnpm run build）`
            : `dsh 启动即退出（code=${String(exitCode)}）。请检查安装包完整性（resources/node/node.exe 与 app.asar.unpacked 内 @deepseek-ai/dsh）`,
        );
      }
      if (resolvedUrl !== undefined) {
        this.authenticatedUrl = resolvedUrl;
        this.state = 'running';
        log.info('dsh web ready', { port, url: resolvedUrl, pid: child.pid });
        return { port, url: resolvedUrl };
      }
      await sleep(this.opts.pollIntervalMs);
    }
    await this.killChild('启动超时');
    return this.failLaunch(
      `启动超时（${Math.round(this.opts.startupTimeoutMs / 1000)}s），未从 stdout 捕获到 dsh web 认证 URL`,
    );
  }

  /** 启动失败收尾：状态置 error 并抛出 */
  private failLaunch(message: string): never {
    this.state = 'error';
    this.lastError = message;
    log.error('dsh launch failed', { error: message });
    throw new Error(message);
  }

  /** 终止子进程树 */
  private async killChild(reason: string): Promise<void> {
    const pid = this.child?.pid;
    this.child = undefined;
    if (pid === undefined) return;
    this.stopping = true;
    try {
      await this.opts.killTreeFn(pid);
      log.info('dsh killed', { pid, reason });
    } catch (e) {
      log.error('kill dsh failed', { pid, error: String(e) });
    }
  }

  /** 停止服务（幂等） */
  async stop(): Promise<void> {
    this.pendingLaunch = undefined;
    await this.killChild('user stop');
    this.state = 'stopped';
    this.authenticatedUrl = undefined;
  }

  /** app 退出清理 */
  async dispose(): Promise<void> {
    await this.stop();
  }
}

/** 工厂 */
export function createDshLauncher(options: DshLauncherOptions): DshLauncher {
  return new DshLauncher(options);
}

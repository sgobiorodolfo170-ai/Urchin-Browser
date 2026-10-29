/**
 * pi 阶段 2 托管服务启动器 · Electron utilityProcess 生命周期管理
 *
 * 职责：
 * 1. `utilityProcess.fork` 拉起自研 pi-web-host（打包进 dist/main/pi-web-host.js）
 * 2. 捕获 stdout 解析认证 URL（`pi-web-host ready: <url>`，token 由服务端生成）
 * 3. 进程树终止（kill）；状态机 stopped → starting → running / error，支持崩溃重启
 *
 * 为什么要 utilityProcess 而非系统 Node 子进程（与 pi-web 阶段 1、dsh 区分）：
 * - pi-web-ui（阶段 1）可用 ELECTRON_RUN_AS_NODE（无指纹校验）；
 * - dsh 被迫用便携 node.exe（node-addon-require-builtin 拒绝 Electron V8）；
 * - 阶段 2 是自研代码 + 后续内嵌 vendored pi SDK（AgentSession，Node-only），
 *   直接跑在 Electron utilityProcess（本机已内置 Node，零额外体积），符合
 *   ADR-004 的「第三方/重逻辑不进主进程」隔离基线。
 *
 * 数据目录：数据落 userData/pi/self-host（DD1 对齐）。
 */
import { utilityProcess } from 'electron';
import { mkdir } from 'node:fs/promises';
import { createLogger } from '@urchin/logger';

export const HOST_URL_LINE_RE =
  // eslint-disable-next-line no-control-regex -- token 终止符（与 dsh 同法，防 chunk 截断）
  /pi-web-host ready: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?=[\s\x1b])/;

const log = createLogger('pi-web-host-launcher');

/** 启动超时：自研 host 冷启动为内嵌代码 + 静态服务，通常 ~1s；给足余量覆盖索引/杀软 */
const STARTUP_TIMEOUT_MS = 60_000;
/** stdout URL 轮询间隔 */
const POLL_INTERVAL_MS = 1_000;

/** utility 子进程最小接口（测试可注入 mock） */
export interface UtilityProcessLike {
  readonly pid?: number;
  readonly stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  };
  readonly stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  };
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'message', listener: (msg: unknown) => void): unknown;
  postMessage(msg: unknown): void;
  kill(): boolean;
}

/** fork 工厂签名（utilityProcess.fork 的可注入子集） */
export type HostForkFn = (
  modulePath: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
) => UtilityProcessLike;

/** 状态机状态（与 ipc-contract piWebHostStateSchema 对齐） */
export type PiWebHostState = 'stopped' | 'starting' | 'running' | 'error';

/** 对外状态快照（与 ipc-contract piWebHostStatusRes 对齐） */
export interface PiWebHostStatusSnapshot {
  readonly state: PiWebHostState;
  readonly url?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly lastError?: string;
}

/** 启动器选项 */
export interface PiWebHostLauncherOptions {
  /** utility 入口模块绝对路径（dist/main/pi-web-host.js；dev 与打包态同为 asar 内相对 __dirname） */
  readonly forkTarget: string;
  /** 前端静态根目录（apps/pi-web 构建产物：dist/pi-web） */
  readonly wwwDir: string;
  /** 数据目录（userData/pi/self-host；host 侧 mkdir 占位，M2B 会话落盘用） */
  readonly dataDir: string;
  /** fork 工厂（默认 utilityProcess.fork，测试注入 mock） */
  readonly forkFn?: HostForkFn;
  /** 数据目录确保存在（默认 mkdir recursive；测试注入 mock） */
  readonly ensureDirFn?: (dir: string) => Promise<void>;
  /** M2B：Agent 凭据提供器（主进程 agentConfigProvider 合并；fork 时异步解析，支持运行时变更） */
  readonly agentCredsProvider?: () => Promise<AgentCreds | null>;
  /** Phase 4：子进程→主进程消息回调（pi-web SettingsModal 配置变更写回 pi.* 键） */
  readonly onChildMessage?: (msg: unknown) => void;
  /** 启动超时（默认 60s，测试注入缩短） */
  readonly startupTimeoutMs?: number;
  /** stdout 轮询间隔（默认 1s，测试注入缩短） */
  readonly pollIntervalMs?: number;
}

/** M2B：Agent 凭据（主进程 agentConfigProvider 合并后传入） */
export interface AgentCreds {
  readonly apiKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  /** M2B-4：启用 coding 工具（utility 进程内安全，ADR-004 / PH7） */
  readonly enableTools?: boolean;
  /** M2B-4：工具工作目录 */
  readonly toolsCwd?: string;
}

/** 默认 fork 工厂：utilityProcess.fork（runs Electron 内置 Node 的 ESM/CJS 模块） */
function defaultFork(
  modulePath: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
): UtilityProcessLike {
  const proc = utilityProcess.fork(modulePath, [...args], options);
  return proc as unknown as UtilityProcessLike;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 归一化 process.env 为 Record<string,string>（剔除 undefined 值） */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 默认目录确保存在：递归 mkdir（幂等） */
const mkdirRecursive = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

/**
 * 自研 pi 托管服务启动器。
 *
 * launch() 幂等（并发调用复用同一次启动）；stop() 终止 utility 子进程；
 * dispose() 供 app 退出清理调用（语义同 stop）。
 */
export class PiWebHostLauncher {
  private readonly opts: PiWebHostLauncherOptions & {
    readonly forkFn: HostForkFn;
    readonly ensureDirFn: (dir: string) => Promise<void>;
    readonly startupTimeoutMs: number;
    readonly pollIntervalMs: number;
  };
  private state: PiWebHostState = 'stopped';
  private authenticatedUrl: string | undefined;
  private port: number | undefined;
  private child: UtilityProcessLike | undefined;
  private stopping = false;
  private lastError: string | undefined;
  private pendingLaunch: Promise<string | undefined> | undefined;

  constructor(options: PiWebHostLauncherOptions) {
    this.opts = {
      ...options,
      forkFn: options.forkFn ?? defaultFork,
      ensureDirFn: options.ensureDirFn ?? mkdirRecursive,
      startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    };
  }

  /** 当前状态快照 */
  status(): PiWebHostStatusSnapshot {
    return {
      state: this.state,
      url: this.state === 'running' ? this.authenticatedUrl : undefined,
      port: this.port,
      pid: this.child?.pid,
      lastError: this.lastError,
    };
  }

  /**
   * 启动（或复用）自研 pi 托管服务。
   *
   * @returns 就绪入口 URL（带 token）；失败抛 Error，状态置 error
   */
  async launch(): Promise<string> {
    if (this.state === 'running' && this.authenticatedUrl) return this.authenticatedUrl;
    this.pendingLaunch ??= this.startProcess().finally(() => {
      this.pendingLaunch = undefined;
    });
    const url = await this.pendingLaunch;
    if (!url) throw new Error(this.lastError ?? 'pi-web-host: no ready url');
    return url;
  }

  /** 单次启动流程：确保数据目录存在 → fork → 等待 stdout 认证 URL（服务就绪信号） */
  private async startProcess(): Promise<string | undefined> {
    this.stopping = false;
    this.lastError = undefined;
    this.authenticatedUrl = undefined;
    this.state = 'starting';

    // dev 教训：utilityProcess.fork 的 cwd 目录不存在时子进程会「静默挂起」——
    // 既不触发 error 也不触发 exit，只会拖到超时。必须先创建 dataDir。
    try {
      await this.opts.ensureDirFn(this.opts.dataDir);
    } catch (e) {
      return this.failLaunch(`数据目录创建失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    log.info('forking pi-web-host', {
      forkTarget: this.opts.forkTarget,
      wwwDir: this.opts.wwwDir,
      dataDir: this.opts.dataDir,
    });

    let exited = false;
    let exitCode: number | null = null;
    let stdoutBuffer = '';
    let resolvedUrl: string | undefined;

    // M2B：fork 时解析当前凭据（支持运行时变更；apiKey 经 env 注入避免 argv 泄漏）
    const creds = this.opts.agentCredsProvider ? await this.opts.agentCredsProvider() : undefined;

    const child = this.opts.forkFn(
      this.opts.forkTarget,
      [`--www-dir=${this.opts.wwwDir}`, `--cwd=${this.opts.dataDir}`],
      {
        // utilityProcess env 只接受 Record<string,string>：剔除 process.env 中的 undefined 键
        env: {
          ...filterEnv(process.env),
          ...(creds
            ? {
                PI_HOST_API_KEY: creds.apiKey,
                PI_HOST_PROVIDER: creds.providerId,
                PI_HOST_MODEL: creds.modelId,
                ...(creds.baseUrl ? { PI_HOST_BASE_URL: creds.baseUrl } : {}),
                ...(creds.systemPrompt ? { PI_HOST_SYSTEM_PROMPT: creds.systemPrompt } : {}),
                ...(creds.enableTools ? { PI_HOST_ENABLE_TOOLS: 'true' } : {}),
                ...(creds.toolsCwd ? { PI_HOST_TOOLS_CWD: creds.toolsCwd } : {}),
              }
            : {}),
        },
        cwd: this.opts.dataDir,
        stdio: 'pipe',
      },
    );
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuffer += text;
      if (resolvedUrl === undefined) {
        const match = HOST_URL_LINE_RE.exec(stdoutBuffer);
        if (match) {
          resolvedUrl = match[1];
          log.info('pi-web-host authenticated URL captured', { url: resolvedUrl });
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.trim().split('\n')) {
        if (line.trim()) log.warn('pi-web-host stderr', { line: line.substring(0, 240) });
      }
    });

    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (this.stopping) return;
      const wasRunning = this.state === 'running';
      if (wasRunning || this.state === 'starting') {
        this.state = 'error';
        this.lastError = `pi-web-host 进程意外退出（code=${String(code)}）`;
        log.error('pi-web-host exited unexpectedly', { code, wasRunning });
      }
    });

    child.on('error', (err) => {
      exited = true;
      this.state = 'error';
      this.lastError = `无法启动 pi-web-host 子进程（${err.message}）`;
      log.error('fork pi-web-host failed', { error: err.message });
    });

    // Phase 4：子进程→主进程消息（pi-web SettingsModal 配置变更写回 pi.* 键）
    child.on('message', (msg: unknown) => {
      if (this.opts.onChildMessage) {
        try {
          this.opts.onChildMessage(msg);
        } catch (e) {
          log.error('pi-web-host onChildMessage callback failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });

    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        return this.failLaunch(
          `pi-web-host 启动即退出（code=${String(exitCode)}）。请重新执行 pnpm run build:pi-web`,
        );
      }
      if (resolvedUrl !== undefined) {
        this.authenticatedUrl = resolvedUrl;
        const m = /:(\d+)\//.exec(resolvedUrl);
        this.port = m ? Number(m[1]) : undefined;
        this.state = 'running';
        log.info('pi-web-host ready', { pid: child.pid, port: this.port });
        return resolvedUrl;
      }
      await sleep(this.opts.pollIntervalMs);
    }

    this.kill();
    return this.failLaunch(
      `pi-web-host 启动超时（${Math.round(this.opts.startupTimeoutMs / 1000)}s），未捕获就绪 URL`,
    );
  }

  /** 启动失败收尾：状态置 error 并返回 undefined（调用方抛错统一文案） */
  private failLaunch(message: string): undefined {
    this.state = 'error';
    this.lastError = message;
    log.error('pi-web-host launch failed', { error: message });
    return undefined;
  }

  /** 向 utility 子进程发送消息（主进程→子进程，如 credsUpdate） */
  postMessage(msg: unknown): void {
    if (this.child) {
      try {
        this.child.postMessage(msg);
      } catch (e) {
        log.error('pi-web-host postMessage failed', { error: String(e) });
      }
    }
  }

  /** 终止 utility 子进程（幂等） */
  kill(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch (e) {
        log.error('kill pi-web-host failed', { error: String(e) });
      }
      this.child = undefined;
    }
  }

  /** 停止服务（幂等）：终止子进程，状态置 stopped */
  stop(): Promise<void> {
    this.pendingLaunch = undefined;
    this.stopping = true;
    this.kill();
    this.state = 'stopped';
    this.authenticatedUrl = undefined;
    this.port = undefined;
    return Promise.resolve();
  }

  /** app 退出清理：语义同 stop */
  dispose(): Promise<void> {
    return this.stop();
  }
}

/** 工厂：便于 main/index.ts 一行接线 */
export function createPiWebHostLauncher(options: PiWebHostLauncherOptions): PiWebHostLauncher {
  return new PiWebHostLauncher(options);
}

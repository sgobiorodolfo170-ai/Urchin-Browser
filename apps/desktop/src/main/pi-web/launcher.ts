/**
 * pi 网页版启动器（阶段 1）· 系统 Node 子进程生命周期管理
 *
 * 职责：
 * 1. 以系统 Node 直启 pi-web-ui CLI（依赖已在 pnpm install 时预装，运行时零下载）
 * 2. 随机空闲端口探测 + 健康检查轮询，就绪后返回入口 URL
 * 3. 进程树终止（Windows taskkill /T /F；类 Unix kill 进程组）
 * 4. 状态机：stopped → starting → running / error，支持崩溃后重启
 *
 * 启动方式（dev.39 用户决策）：
 * - 包 pi-web-ui 以精确版本钉在 apps/desktop dependencies（供应链单一真源），
 *   `--no-browser` 禁用其启动时自动拉起系统默认浏览器（本项目内一律由 Urchin 打开）
 * - spawn 系统 `node <cliPath>`，不走 npx（npx 会运行时下载依赖）
 *
 * 隔离设计（docs/pi-web-评估.md）：
 * - pi 及其 Web UI 全部运行在系统 Node 子进程，Electron 主进程零 pi 依赖
 * - 服务仅绑定 127.0.0.1；子进程崩溃不影响浏览器
 *
 * 数据目录（DD1 决策对齐）：pi 相关数据固定落 userData/pi，不随用户数据目录迁移。
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { createLogger } from '@urchin/logger';
import { ensureAuthPlaceholder } from './auth-placeholder';

const log = createLogger('pi-web-launcher');

/** 健康检查轮询间隔 */
const HEALTH_POLL_INTERVAL_MS = 1_000;
/**
 * 启动超时：依赖已预装（node_modules 内直启，无网络下载），冷启动通常数秒；
 * 给足余量覆盖首次初始化数据目录 / 杀软扫描等情况。
 */
const HEALTH_TIMEOUT_MS = 60_000;

/** 子进程最小接口（测试可注入 mock） */
export interface ChildProcessLike {
  readonly pid?: number;
  readonly killed: boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** 进程工厂签名（node:child_process.spawn 的可注入子集；node.exe 无需 shell） */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; stdio: 'ignore' },
) => ChildProcessLike;

/** 状态机状态 */
export type PiWebState = 'stopped' | 'starting' | 'running' | 'error';

/** 对外状态快照（与 ipc-contract piWebStatusRes 对齐） */
export interface PiWebStatusSnapshot {
  readonly state: PiWebState;
  readonly url?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly lastError?: string;
}

/** 启动器选项 */
export interface PiWebLauncherOptions {
  /** pi-web-ui CLI 入口脚本绝对路径（node_modules 内 bin/pi-web-ui.mjs；打包态指向 asar.unpacked） */
  readonly cliPath: string;
  /** pi-web-ui 数据目录（会话/配置落盘；建议 userData/pi/web-ui，DD1） */
  readonly dataDir: string;
  /** agent 工作目录（PI_WEB_CWD）。pi 会话管理器要求该目录真实存在（dev.41 教训） */
  readonly cwd: string;
  /**
   * pi agent 目录（PI_CODING_AGENT_DIR，官方环境变量）：会话库/agent 配置的根。
   * 不设则 pi 默认落全局 ~/.pi，污染用户主目录；建议 userData/pi/agent（DD1 对齐）。
   */
  readonly agentDir?: string;
  /**
   * npm 全局前缀沙箱（dev.42 用户原则：pi 依赖全部随本项目，禁止系统级全局安装）。
   * 注入 env npm_config_prefix 后，pi-web-ui 进程树内的一切 `npm i -g`
   * （如其「安装 pi agent」按钮）都落在此目录而非系统全局——卸载应用即随
   * userData 整体移除。建议 userData/pi/npm-global。
   */
  readonly npmGlobalPrefixDir?: string;
  /** 进程工厂（默认 node spawn，测试注入 mock） */
  readonly spawnFn?: SpawnFn;
  /** 进程树终止（默认 Windows taskkill /T /F，测试注入 mock） */
  readonly killTreeFn?: (pid: number) => Promise<void>;
  /** 空闲端口探测（默认 net.createServer 试探，测试注入 mock） */
  readonly portPickerFn?: () => Promise<number>;
  /** 健康检查（默认 HTTP GET /，测试注入 mock） */
  readonly healthCheckFn?: (port: number) => Promise<boolean>;
  /** 目录确保存在（默认 fs mkdir recursive，测试注入 mock；dev.41 修复的核心） */
  readonly ensureDirFn?: (dir: string) => Promise<void>;
  /**
   * auth.json 空白占位注入（默认 ensureAuthPlaceholder，测试注入 mock；dev.43）：
   * 无任何凭据时写入合法空白条目，隐藏 pi-web-ui 的「下载 pi agent」误导性引导。
   * 非致命——失败仅记日志，不阻塞启动。
   */
  readonly seedAuthFn?: (agentDir: string) => Promise<void>;
  /** 启动超时（默认 HEALTH_TIMEOUT_MS，测试注入缩短） */
  readonly healthTimeoutMs?: number;
  /** 健康检查轮询间隔（默认 HEALTH_POLL_INTERVAL_MS，测试注入缩短） */
  readonly healthPollIntervalMs?: number;
}

/** 默认进程工厂：直启 node.exe（经 PATH 解析，无需 shell——cliPath 含空格安全） */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; stdio: 'ignore' },
): ChildProcessLike {
  return spawn(command, [...args], options);
}

/** 默认进程树终止：Windows 用 taskkill /T /F 杀整棵树（npx.cmd → node → server） */
async function defaultKillTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
        // 进程已退出时 taskkill 报错（找不到进程）视为成功
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

/** 默认空闲端口探测：绑定 0 让 OS 分配，立即释放（存在极小竞争窗口，可接受） */
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

/** 默认健康检查：GET /，任意 <500 响应均视为服务就绪 */
function defaultHealthCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3_000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** 默认目录确保存在：递归 mkdir（幂等，已存在不报错；mkdir 返回首建路径，包一层归一为 void） */
async function defaultEnsureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * pi 网页服务启动器。
 *
 * 使用方式：launch() 幂等（并发调用复用同一次启动）；stop() 终止子进程树；
 * dispose() 供 app 退出清理调用（语义同 stop）。
 */
export class PiWebLauncher {
  private readonly opts: PiWebLauncherOptions & {
    readonly spawnFn: SpawnFn;
    readonly killTreeFn: (pid: number) => Promise<void>;
    readonly portPickerFn: () => Promise<number>;
    readonly healthCheckFn: (port: number) => Promise<boolean>;
    readonly ensureDirFn: (dir: string) => Promise<void>;
    readonly seedAuthFn: (agentDir: string) => Promise<void>;
    readonly healthTimeoutMs: number;
    readonly healthPollIntervalMs: number;
  };
  private state: PiWebState = 'stopped';
  private port: number | undefined;
  private child: ChildProcessLike | undefined;
  /** 用户主动 stop 的标志：区分「主动停止」与「意外退出」（后者进入 error） */
  private stopping = false;
  private lastError: string | undefined;
  /** 进行中的启动 Promise（并发 launch 复用） */
  private pendingLaunch: Promise<number> | undefined;

  constructor(options: PiWebLauncherOptions) {
    this.opts = {
      ...options,
      spawnFn: options.spawnFn ?? defaultSpawn,
      killTreeFn: options.killTreeFn ?? defaultKillTree,
      portPickerFn: options.portPickerFn ?? defaultPickFreePort,
      healthCheckFn: options.healthCheckFn ?? defaultHealthCheck,
      ensureDirFn: options.ensureDirFn ?? defaultEnsureDir,
      seedAuthFn: options.seedAuthFn ?? ensureAuthPlaceholder,
      healthTimeoutMs: options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
      healthPollIntervalMs: options.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS,
    };
  }

  /** 当前状态快照 */
  status(): PiWebStatusSnapshot {
    return {
      state: this.state,
      url: this.state === 'running' && this.port ? `http://127.0.0.1:${this.port}` : undefined,
      port: this.port,
      pid: this.child?.pid,
      lastError: this.lastError,
    };
  }

  /**
   * 启动（或复用）pi 网页服务。
   *
   * @returns 就绪端口（调用方据此拼接 URL；与 status().url 一致）
   * @throws 启动失败（健康检查超时 / 子进程即退）时抛 Error，状态置 error
   */
  async launch(): Promise<number> {
    if (this.state === 'running' && this.port) return this.port;
    this.pendingLaunch ??= this.startProcess().finally(() => {
      this.pendingLaunch = undefined;
    });
    return this.pendingLaunch;
  }

  /** 单次启动流程：确保目录存在 → 选端口 → spawn → 健康检查轮询 */
  private async startProcess(): Promise<number> {
    this.stopping = false;
    this.lastError = undefined;
    this.state = 'starting';

    // dev.41 修复：pi 会话管理器硬校验工作目录必须存在（此前报
    // "Stored session working directory does not exist"），spawn 前统一确保
    // dataDir / cwd / agentDir 均已创建
    const dirsToEnsure = [this.opts.dataDir, this.opts.cwd];
    if (this.opts.agentDir) dirsToEnsure.push(this.opts.agentDir);
    try {
      for (const dir of dirsToEnsure) {
        await this.opts.ensureDirFn(dir);
      }
    } catch (e) {
      return this.failLaunch(`数据目录创建失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // dev.43：auth.json 空白占位注入（无凭据时）——隐藏「下载 pi agent」误导性
    // 引导；非致命，失败仅记日志（最坏情况引导照旧出现，功能不受影响）
    if (this.opts.agentDir) {
      try {
        await this.opts.seedAuthFn(this.opts.agentDir);
      } catch (e) {
        log.warn('auth placeholder seeding failed (non-fatal)', {
          agentDir: this.opts.agentDir,
          error: String(e),
        });
      }
    }

    let port: number;
    try {
      port = await this.opts.portPickerFn();
    } catch (e) {
      return this.failLaunch(`端口探测失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.port = port;

    log.info('spawning pi-web-ui', {
      cliPath: this.opts.cliPath,
      port,
      dataDir: this.opts.dataDir,
      agentDir: this.opts.agentDir,
    });

    let exited = false;
    let exitCode: number | null = null;
    const child = this.opts.spawnFn('node', [this.opts.cliPath, '--no-browser'], {
      // 目录经环境变量传递（不经命令行，路径含空格安全）
      env: {
        ...process.env,
        PORT: String(port),
        PI_WEB_DATA_DIR: this.opts.dataDir,
        PI_WEB_CWD: this.opts.cwd,
        // 会话库/agent 配置根：未设则 pi 落全局 ~/.pi（污染用户主目录，DD1 不符）
        ...(this.opts.agentDir ? { PI_CODING_AGENT_DIR: this.opts.agentDir } : {}),
        // npm 沙箱（dev.42）：进程树内任何 -g 安装改落项目目录，杜绝写系统全局
        ...(this.opts.npmGlobalPrefixDir
          ? { npm_config_prefix: this.opts.npmGlobalPrefixDir }
          : {}),
      },
      stdio: 'ignore',
    });
    this.child = child;
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (this.stopping) return; // 主动停止：状态已由 stop() 置为 stopped
      const wasRunning = this.state === 'running';
      if (wasRunning || this.state === 'starting') {
        this.state = 'error';
        this.lastError = `pi-web-ui 进程意外退出（code=${String(code)}）`;
        log.error('pi-web-ui exited unexpectedly', { code, wasRunning });
      }
    });
    child.on('error', (err) => {
      exited = true;
      this.state = 'error';
      this.lastError = `无法启动 node（${err.message}）。请确认系统已安装 Node.js ≥22.19 并在 PATH 中`;
      log.error('spawn node failed', { error: err.message });
    });

    const deadline = Date.now() + this.opts.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        return this.failLaunch(
          `pi-web-ui 启动即退出（code=${String(exitCode)}）。请检查系统 Node 环境（需 ≥22.19，可用 node --version 验证）与依赖安装（pnpm install）`,
        );
      }
      if (await this.opts.healthCheckFn(port)) {
        this.state = 'running';
        log.info('pi-web-ui ready', { port, pid: child.pid });
        return port;
      }
      await sleep(this.opts.healthPollIntervalMs);
    }
    await this.killChild('健康检查超时');
    return this.failLaunch(
      `健康检查超时（${Math.round(this.opts.healthTimeoutMs / 1000)}s），pi-web-ui 未就绪`,
    );
  }

  /** 启动失败收尾：状态置 error 并抛出 */
  private failLaunch(message: string): never {
    this.state = 'error';
    this.lastError = message;
    log.error('pi-web launch failed', { error: message });
    throw new Error(message);
  }

  /** 终止子进程树（不改变 state，由调用方决定后续状态） */
  private async killChild(reason: string): Promise<void> {
    const pid = this.child?.pid;
    this.child = undefined;
    if (pid === undefined) return;
    this.stopping = true;
    try {
      await this.opts.killTreeFn(pid);
      log.info('pi-web-ui killed', { pid, reason });
    } catch (e) {
      log.error('kill pi-web-ui failed', { pid, error: String(e) });
    }
  }

  /** 停止服务（幂等）：终止子进程树，状态置 stopped */
  async stop(): Promise<void> {
    this.pendingLaunch = undefined;
    await this.killChild('user stop');
    this.state = 'stopped';
  }

  /** app 退出清理：语义同 stop（performCleanup 调用） */
  async dispose(): Promise<void> {
    await this.stop();
  }
}

/** 工厂：便于 main/index.ts 一行接线 */
export function createPiWebLauncher(options: PiWebLauncherOptions): PiWebLauncher {
  return new PiWebLauncher(options);
}

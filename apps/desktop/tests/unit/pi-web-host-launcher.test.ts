/**
 * PiWebHostLauncher 单元测试（阶段 2）
 *
 * 验证 utilityProcess 启动与就绪 URL 解析（全部依赖注入 mock，不真实 fork）：
 * - fork 命令行形状（--www-dir / --cwd）
 * - stdout 就绪行解析（含 chunk 截断加固：token 未收完不接受）
 * - 即退 → error；启动超时 → error + kill
 * - stop/dispose 幂等 + pendingLaunch 并发复用
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PiWebHostLauncher,
  HOST_URL_LINE_RE,
  type HostForkFn,
  type UtilityProcessLike,
} from '../../src/main/pi-web-host/launcher';

const READY_URL = 'http://127.0.0.1:41234/?token=abc_XYZ-123';

/** 可控 mock 子进程：捕获 fork 参数与监听器，允许测试主动触发 stdout/exit 事件 */
class MockChild implements UtilityProcessLike {
  readonly pid: number;
  killed = false;
  readonly forkArgs: readonly string[];
  readonly forkEnv: Record<string, string>;
  readonly forkCwd: string;
  private readonly listeners = new Map<string, (arg: never) => void>();
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly stderrCbs: ((chunk: Buffer) => void)[] = [];

  constructor(pid: number, args: readonly string[], env: Record<string, string>, cwd: string) {
    this.pid = pid;
    this.forkArgs = args;
    this.forkEnv = env;
    this.forkCwd = cwd;
  }

  on(event: string, listener: (...args: never[]) => void): unknown {
    this.listeners.set(event, listener);
    return undefined;
  }

  postMessage(): void {
    /* mock no-op */
  }

  readonly stdout = {
    on: (_event: string, listener: (chunk: Buffer) => void): unknown => {
      this.stdoutCbs.push(listener);
      return undefined;
    },
  };

  readonly stderr = {
    on: (_event: string, listener: (chunk: Buffer) => void): unknown => {
      this.stderrCbs.push(listener);
      return undefined;
    },
  };

  emitStdout(text: string): void {
    for (const cb of [...this.stdoutCbs]) cb(Buffer.from(text, 'utf8'));
  }

  emitExit(code: number | null): void {
    this.listeners.get('exit')?.(code as never);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Harness {
  launcher: PiWebHostLauncher;
  children: MockChild[];
}

/** launch() 中 ensureDirFn 是 async——fork 发生在微任务之后，需等待子进程产生 */
async function waitChild(h: Harness): Promise<MockChild> {
  for (let i = 0; i < 50; i++) {
    if (h.children.length > 0) return h.children[0]!;
    await pump(10);
  }
  throw new Error('no child forked');
}

async function pump(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('PiWebHostLauncher', () => {
  it('forks with --www-dir/--cwd and parses stdout ready URL', async () => {
    const h = mkLauncher();
    const p = h.launcher.launch();
    const child = await waitChild(h);
    expect(h.children).toHaveLength(1);
    expect(child.forkArgs[0]).toBe('--www-dir=/virtual/dist/pi-web');
    expect(child.forkArgs[1]).toBe('--cwd=/virtual/data');
    expect(child.forkEnv).toBeDefined();

    child.emitStdout(`\npi-web-host ready: ${READY_URL}\n`);
    const url = await p;
    expect(url).toBe(READY_URL);
    const st = h.launcher.status();
    expect(st.state).toBe('running');
    expect(st.url).toBe(READY_URL);
    expect(st.port).toBe(41234);
    expect(st.pid).toBe(100);
  });

  it('handles ready URL split across chunks (no truncation)', async () => {
    const h = mkLauncher();
    const p = h.launcher.launch();
    const child = await waitChild(h);
    // 第一块 token 不完整（无终止符）→ 不应被接受
    child.emitStdout('pi-web-host ready: http://127.0.0.1:41234/?token=abc_XYZ-');
    await pump(20);
    expect(h.launcher.status().state).toBe('starting');
    // 完整块到达（含换行终止符）→ 接受
    child.emitStdout('123\n');
    const url = await p;
    expect(url).toBe(READY_URL);
  });

  it('marks error and throws when child exits immediately', async () => {
    const h = mkLauncher();
    const p = h.launcher.launch();
    const child = await waitChild(h);
    child.emitExit(1);
    await expect(p).rejects.toThrow('启动即退出');
    expect(h.launcher.status().state).toBe('error');
    expect(h.launcher.status().lastError).toContain('启动即退出');
  });

  it('times out, kills child, and throws when no ready URL', async () => {
    const h = mkLauncher({ timeoutMs: 50 });
    const p = h.launcher.launch();
    const child = await waitChild(h);
    await expect(p).rejects.toThrow('启动超时');
    expect(h.launcher.status().state).toBe('error');
    expect(h.launcher.status().lastError).toContain('启动超时');
    expect(child.killed).toBe(true);
  });

  it('reuses pending launch on concurrent calls', async () => {
    const h = mkLauncher();
    const p1 = h.launcher.launch();
    const p2 = h.launcher.launch();
    const child = await waitChild(h);
    expect(h.children).toHaveLength(1);
    child.emitStdout(`pi-web-host ready: ${READY_URL}\n`);
    const [u1, u2] = await Promise.all([p1, p2]);
    expect(u1).toBe(READY_URL);
    expect(u2).toBe(READY_URL);
  });

  it('stop() is idempotent and resets state', async () => {
    const h = mkLauncher();
    const p = h.launcher.launch();
    const child = await waitChild(h);
    child.emitStdout(`pi-web-host ready: ${READY_URL}\n`);
    await p;
    await h.launcher.stop();
    expect(child.killed).toBe(true);
    expect(h.launcher.status().state).toBe('stopped');
    expect(h.launcher.status().url).toBeUndefined();
    await h.launcher.stop(); // 幂等
    expect(h.launcher.status().state).toBe('stopped');
  });

  it('dispose() aliases stop', async () => {
    const h = mkLauncher();
    const p = h.launcher.launch();
    const child = await waitChild(h);
    child.emitStdout(`pi-web-host ready: ${READY_URL}\n`);
    await p;
    await h.launcher.dispose();
    expect(h.launcher.status().state).toBe('stopped');
  });
});

function mkLauncher(overrides: { timeoutMs?: number; pollMs?: number } = {}): Harness {
  const children: MockChild[] = [];
  let nextId = 100;
  const forkFn: HostForkFn = (
    _modulePath: string,
    args: readonly string[],
    opts: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
  ): UtilityProcessLike => {
    const child = new MockChild(nextId++, args, opts.env, opts.cwd);
    children.push(child);
    return child;
  };
  const forkSpy = vi.fn(forkFn);
  const launcher = new PiWebHostLauncher({
    forkTarget: '/virtual/dist/main/pi-web-host.js',
    wwwDir: '/virtual/dist/pi-web',
    dataDir: '/virtual/data',
    forkFn: forkSpy,
    ensureDirFn: vi.fn(() => Promise.resolve()),
    startupTimeoutMs: overrides.timeoutMs ?? 60_000,
    pollIntervalMs: overrides.pollMs ?? 10,
  });
  return { launcher, children };
}

describe('HOST_URL_LINE_RE', () => {
  it('parses full line with newline terminator', () => {
    const m = HOST_URL_LINE_RE.exec(`pi-web-host ready: ${READY_URL}\n`);
    expect(m?.[1]).toBe(READY_URL);
  });
  it('accepts ANSI terminator', () => {
    const m = HOST_URL_LINE_RE.exec(`pi-web-host ready: ${READY_URL}\x1b[0m`);
    expect(m?.[1]).toBe(READY_URL);
  });
  it('rejects truncated token without terminator', () => {
    const m = HOST_URL_LINE_RE.exec('pi-web-host ready: http://127.0.0.1:1/?token=abc');
    expect(m).toBeNull();
  });
});

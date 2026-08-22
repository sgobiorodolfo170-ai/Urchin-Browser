/**
 * PiWebLauncher 单元测试
 *
 * 验证状态机与进程生命周期（全部依赖注入 mock，不真实 spawn）：
 * - launch 成功流：starting → running，URL 正确，env 注入 PORT/数据目录
 * - 并发 launch 复用同一次启动；running 时 launch 直接返回端口
 * - 子进程即退 → 抛错且状态 error
 * - 健康检查超时 → 杀进程树 + 状态 error
 * - stop/dispose：终止进程树、状态 stopped；意外退出 → 状态 error 可重启
 */
import { describe, it, expect, vi } from 'vitest';
import { PiWebLauncher, type ChildProcessLike } from '../../src/main/pi-web/launcher';

/** 可控的 mock 子进程：捕获 exit/error 监听器，允许测试主动触发生命周期事件 */
class MockChild implements ChildProcessLike {
  readonly pid: number;
  readonly killed = false;
  private readonly listeners = new Map<string, (arg: number | null | Error) => void>();
  readonly spawnArgs: readonly string[];
  readonly spawnEnv: Record<string, string>;

  constructor(pid: number, args: readonly string[], env: Record<string, string>) {
    this.pid = pid;
    this.spawnArgs = args;
    this.spawnEnv = env;
  }

  on(event: string, listener: (...args: never[]) => void): void {
    this.listeners.set(event, listener as (arg: number | null | Error) => void);
  }

  emitExit(code: number | null): void {
    this.listeners.get('exit')?.(code);
  }
}

interface Harness {
  launcher: PiWebLauncher;
  children: MockChild[];
  killTree: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

/** 构建全 mock 启动器（健康默认立即就绪；快轮询缩短测试耗时） */
function createHarness(overrides?: { health?: (port: number) => Promise<boolean> }): Harness {
  const children: MockChild[] = [];
  let pidSeq = 1000;
  const spawn = vi.fn(
    (
      _cmd: string,
      args: readonly string[],
      opts: { env: Record<string, string>; stdio: 'ignore' },
    ): ChildProcessLike => {
      const child = new MockChild(pidSeq++, args, opts.env);
      children.push(child);
      return child;
    },
  );
  const killTree = vi.fn(() => Promise.resolve(undefined));
  const launcher = new PiWebLauncher({
    cliPath: '/fake/node_modules/pi-web-ui/bin/pi-web-ui.mjs',
    dataDir: '/fake/userData/pi/web-ui',
    cwd: '/fake/userData/pi/web-ui',
    spawnFn: spawn,
    killTreeFn: killTree,
    portPickerFn: () => Promise.resolve(45001),
    healthCheckFn: overrides?.health ?? (() => Promise.resolve(true)),
    healthTimeoutMs: 500,
    healthPollIntervalMs: 10,
  });
  return { launcher, children, killTree, spawn, health: vi.fn() };
}

describe('PiWebLauncher', () => {
  it('launch should transition to running and return url/port with injected env', async () => {
    const h = createHarness();
    const port = await h.launcher.launch();

    expect(port).toBe(45001);
    // spawn 参数：系统 node 直启预装依赖的 CLI（无 shell、无 npx 运行时下载），
    // --no-browser 禁止 pi-web-ui 拉起系统默认浏览器（dev.39）
    expect(h.spawn).toHaveBeenCalledWith(
      'node',
      ['/fake/node_modules/pi-web-ui/bin/pi-web-ui.mjs', '--no-browser'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    // 目录经 env 注入（不经命令行）
    const env = h.children[0]!.spawnEnv;
    expect(env.PORT).toBe('45001');
    expect(env.PI_WEB_DATA_DIR).toBe('/fake/userData/pi/web-ui');
    expect(env.PI_WEB_CWD).toBe('/fake/userData/pi/web-ui');

    const s = h.launcher.status();
    expect(s.state).toBe('running');
    expect(s.url).toBe('http://127.0.0.1:45001');
    expect(s.pid).toBe(h.children[0]!.pid);
  });

  it('concurrent launch should reuse single start; running launch returns port directly', async () => {
    const h = createHarness({ health: () => Promise.resolve(true) });
    const [a, b] = await Promise.all([h.launcher.launch(), h.launcher.launch()]);
    expect(a).toBe(b);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    // 已 running：再 launch 不重新 spawn
    await h.launcher.launch();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('child exiting during startup should reject and set error state', async () => {
    const h = createHarness({
      health: () => Promise.resolve(false), // 永不就绪：轮询循环依赖每轮返回，等 exit 事件触发失败
    });
    const pending = h.launcher.launch();
    // spawn 发生在 portPicker 的微任务之后：等一拍再触发生命周期事件
    await new Promise((r) => setTimeout(r, 20));
    h.children[0]!.emitExit(1);
    await expect(pending).rejects.toThrow('启动即退出');
    expect(h.launcher.status().state).toBe('error');
    expect(h.launcher.status().lastError).toContain('code=1');
  });

  it('health timeout should kill process tree and set error state', async () => {
    const h = createHarness({ health: () => Promise.resolve(false) });
    await expect(h.launcher.launch()).rejects.toThrow('健康检查超时');
    expect(h.killTree).toHaveBeenCalledWith(h.children[0]!.pid);
    expect(h.launcher.status().state).toBe('error');
  });

  it('stop should kill tree, set stopped, and be idempotent', async () => {
    const h = createHarness();
    await h.launcher.launch();
    await h.launcher.stop();

    expect(h.killTree).toHaveBeenCalledTimes(1);
    expect(h.launcher.status().state).toBe('stopped');
    expect(h.launcher.status().url).toBeUndefined();

    // 幂等：再次 stop 不再杀
    await h.launcher.stop();
    expect(h.killTree).toHaveBeenCalledTimes(1);
  });

  it('unexpected exit after running should set error; relaunch spawns new child', async () => {
    const h = createHarness();
    await h.launcher.launch();
    h.children[0]!.emitExit(null);

    expect(h.launcher.status().state).toBe('error');
    expect(h.launcher.status().lastError).toContain('意外退出');

    // 重启：新子进程、状态回到 running
    const port = await h.launcher.launch();
    expect(port).toBe(45001);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.launcher.status().state).toBe('running');
  });

  it('dispose should behave like stop (app quit cleanup path)', async () => {
    const h = createHarness();
    await h.launcher.launch();
    await h.launcher.dispose();
    expect(h.killTree).toHaveBeenCalledTimes(1);
    expect(h.launcher.status().state).toBe('stopped');
  });
});

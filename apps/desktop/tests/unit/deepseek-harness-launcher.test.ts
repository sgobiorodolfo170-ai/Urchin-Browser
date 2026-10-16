/**
 * DshLauncher 单元测试（X4）
 *
 * 验证双模式启动与认证 URL 解析（全部依赖注入 mock，不真实 spawn）：
 * - 开发态：便携 node.exe + tsx ESM loader（vendor TypeScript 源码）
 * - 打包态：便携 node.exe 直执行 npm 预编译产物（无 tsx、无 ELECTRON_RUN_AS_NODE）
 * - 兜底：未传 nodePath 时 process.execPath + ELECTRON_RUN_AS_NODE=1（现状
 *   Electron 会被 dsh 指纹校验拒绝，仅覆盖命令行形状、不用于现行接线）
 * - 分块加固：URL 行跨 stdout chunk 切断时不得捕获截断 token（X4 正则加固）
 * - 子进程即退 / 启动超时 → 状态 error + 进程树终止
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DshLauncher,
  DSH_URL_LINE_RE,
  type ChildProcessLike,
} from '../../src/main/deepseek-harness/launcher';

/** 可控 mock 子进程：捕获 spawn 参数与监听器，允许测试主动触发 stdout/exit 事件 */
class MockChild implements ChildProcessLike {
  readonly pid: number;
  readonly killed = false;
  readonly spawnArgs: readonly string[];
  readonly spawnEnv: Record<string, string>;
  readonly spawnCwd: string;
  private readonly listeners = new Map<string, (arg: never) => void>();
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly stderrCbs: ((chunk: Buffer) => void)[] = [];

  constructor(pid: number, args: readonly string[], env: Record<string, string>, cwd: string) {
    this.pid = pid;
    this.spawnArgs = args;
    this.spawnEnv = env;
    this.spawnCwd = cwd;
  }

  on(event: string, listener: (...args: never[]) => void): unknown {
    this.listeners.set(event, listener);
    return undefined;
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
}

interface Harness {
  launcher: DshLauncher;
  children: MockChild[];
  spawn: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
}

/** 构建全 mock 启动器（快轮询缩短测试耗时） */
function createHarness(overrides?: {
  nodePath?: string;
  usesTsxLoader?: boolean;
  cliEntry?: string;
  startupTimeoutMs?: number;
}): Harness {
  const children: MockChild[] = [];
  let pidSeq = 3000;
  const spawn = vi.fn(
    (
      _cmd: string,
      args: readonly string[],
      opts: { env: Record<string, string>; cwd: string; stdio: 'pipe' },
    ): ChildProcessLike => {
      const child = new MockChild(pidSeq++, args, opts.env, opts.cwd);
      children.push(child);
      return child;
    },
  );
  const killTree = vi.fn(() => Promise.resolve(undefined));
  const launcher = new DshLauncher({
    cwdDir: '/fake/vendor/deepseek-harness',
    cliEntry: overrides?.cliEntry ?? 'apps/cli/src/bin.ts',
    ...(overrides?.nodePath ? { nodePath: overrides.nodePath } : {}),
    ...(overrides?.usesTsxLoader !== undefined ? { usesTsxLoader: overrides.usesTsxLoader } : {}),
    dataDir: '/fake/userData/deepseek-harness',
    spawnFn: spawn,
    killTreeFn: killTree,
    portPickerFn: () => Promise.resolve(47001),
    ensureDirFn: () => Promise.resolve(undefined),
    startupTimeoutMs: overrides?.startupTimeoutMs ?? 500,
    pollIntervalMs: 10,
  });
  return { launcher, children, spawn, killTree };
}

describe('DshLauncher（X4 双模式）', () => {
  it('dev mode should spawn portable node.exe with tsx loader and capture URL', async () => {
    const nodePath = 'C:\\fake\\build\\node\\node.exe';
    const h = createHarness({ nodePath, usesTsxLoader: true });
    const pending = h.launcher.launch();
    await vi.waitFor(() => expect(h.children.length).toBe(1));
    h.children[0]!.emitStdout(
      'dsh web: http://127.0.0.1:47001/?token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd\n',
    );
    const result = await pending;

    expect(result.port).toBe(47001);
    expect(result.url).toBe(
      'http://127.0.0.1:47001/?token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd',
    );
    // 开发态：便携 node.exe + tsx ESM loader 直启 vendor TypeScript 源码；
    // cwd = vendor 目录（tsx 从 cwd node_modules 解析依赖）
    expect(h.spawn).toHaveBeenCalledWith(
      nodePath,
      ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', '47001'],
      expect.objectContaining({ cwd: '/fake/vendor/deepseek-harness', stdio: 'pipe' }),
    );
    const env = h.children[0]!.spawnEnv;
    // 便携 node 是纯 Node 运行时，绝不能注入 ELECTRON_RUN_AS_NODE
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.DSH_HOME).toBe('/fake/userData/deepseek-harness');
    expect(h.launcher.status().state).toBe('running');
  });

  it('fallback (no nodePath) should spawn electron-as-node with ELECTRON_RUN_AS_NODE', async () => {
    const h = createHarness();
    const pending = h.launcher.launch();
    await vi.waitFor(() => expect(h.children.length).toBe(1));
    h.children[0]!.emitStdout(
      'dsh web: http://127.0.0.1:47001/?token=FallbackToken0123456789_abcdefghijklmnop\n',
    );
    await pending;

    // 兜底路径：process.execPath + ELECTRON_RUN_AS_NODE=1 + tsx。仅覆盖命令行
    // 形状——现行 Electron（43.x）会被 node-addon-require-builtin 指纹校验拒绝，
    // 正式接线（main/index.ts）双态均显式传便携 node.exe。
    expect(h.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', '47001'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(h.children[0]!.spawnEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('packaged mode should spawn portable node.exe directly (no tsx, no ELECTRON_RUN_AS_NODE)', async () => {
    const nodePath = 'C:\\fake\\resources\\node\\node.exe';
    const cliEntry = 'C:\\fake\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
    const h = createHarness({ nodePath, usesTsxLoader: false, cliEntry });
    const pending = h.launcher.launch();
    await vi.waitFor(() => expect(h.children.length).toBe(1));
    h.children[0]!.emitStdout(
      'dsh web: http://127.0.0.1:47001/?token=PackagedToken0123456789_abcdefghijklmnopqr\n',
    );
    await pending;

    // 打包态：纯 node.exe 直执行 npm 预编译产物（无 --import tsx/esm）
    expect(h.spawn).toHaveBeenCalledWith(
      nodePath,
      [cliEntry, 'web', '--no-open', '--port', '47001'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    // dsh 的 node-addon-require-builtin 拒绝 Electron V8 → 打包态绝不能注入
    // ELECTRON_RUN_AS_NODE
    expect(h.children[0]!.spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(h.children[0]!.spawnEnv.DSH_HOME).toBe('/fake/userData/deepseek-harness');
  });

  it('should NOT resolve with truncated token when URL line splits across stdout chunks', async () => {
    // 正则直接验证：无终止符的截断 token 不匹配；带换行的完整 token 匹配
    expect(DSH_URL_LINE_RE.test('dsh web: http://127.0.0.1:47001/?token=partialToken0123456')).toBe(
      false,
    );
    expect(DSH_URL_LINE_RE.test('dsh web: http://127.0.0.1:47001/?token=fullToken01234567\n')).toBe(
      true,
    );

    const h = createHarness();
    const pending = h.launcher.launch();
    await vi.waitFor(() => expect(h.children.length).toBe(1));
    const child = h.children[0]!;
    // 前半段在 token 中途切断——旧正则会立即捕获截断 token（首次访问 401 的根因）
    child.emitStdout('dsh web: http://127.0.0.1:47001/?token=AbCdEf0123456789');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 60)); // 跨多个轮询周期
    expect(settled).toBe(false); // 未误判为就绪

    child.emitStdout('XyZ-_Tail\n');
    const result = await pending;
    expect(result.url).toBe('http://127.0.0.1:47001/?token=AbCdEf0123456789XyZ-_Tail');
  });

  it('child exiting before URL should fail launch and set error state', async () => {
    const h = createHarness();
    const pending = h.launcher.launch();
    await vi.waitFor(() => expect(h.children.length).toBe(1));
    h.children[0]!.emitExit(1);
    await expect(pending).rejects.toThrow(/启动即退出/);
    expect(h.launcher.status().state).toBe('error');
  });

  it('startup timeout should kill process tree and set error state', async () => {
    const h = createHarness({ startupTimeoutMs: 100 });
    await expect(h.launcher.launch()).rejects.toThrow(/启动超时/);
    expect(h.killTree).toHaveBeenCalledWith(3000);
    expect(h.launcher.status().state).toBe('error');
  });
});

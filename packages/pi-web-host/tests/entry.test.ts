/**
 * entry.ts 单元测试（utilityProcess 入口）
 *
 * 入口模块在 import 时立即执行 main()，所以每个用例 resetModules 后重新导入，
 * 并通过 vi.mock 替换 server / auth，避免真起端口。
 *
 * 注意：`import { argv } from 'node:process'` 是模块初始化时的快照绑定，
 * 重新赋值 process.argv 不会反映到 entry 里——必须原地修改同一个数组。
 *
 * 覆盖：
 * - --www-dir 缺失 → console.error + exit(1)
 * - argv 参数映射到 startPiWebHostServer（port / agentDir / agent 凭据）
 * - 环境变量兜底与 enable-tools 仅 'true' 生效
 * - 凭据三元组不全 → 不建 agent
 * - 就绪行写入 stdout；SIGTERM/SIGINT 优雅关闭后 exit(0)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startMock, closeMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('../src/server', () => ({
  startPiWebHostServer: startMock,
}));

vi.mock('../src/auth', () => ({
  HOST_READY_PREFIX: 'pi-web-host ready: ',
}));

const PI_ENV_KEYS = [
  'PI_HOST_API_KEY',
  'PI_HOST_PROVIDER',
  'PI_HOST_MODEL',
  'PI_HOST_BASE_URL',
  'PI_HOST_SYSTEM_PROMPT',
  'PI_HOST_ENABLE_TOOLS',
  'PI_HOST_TOOLS_CWD',
] as const;

let argvBackup: string[];
let envBackup: NodeJS.ProcessEnv;
let tempDirs: string[] = [];
const exitSpy = vi.spyOn(process, 'exit');
const writeSpy = vi.spyOn(process.stdout, 'write');
const errorSpy = vi.spyOn(console, 'error');

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 原地改写 argv（保持 node:process 的 argv 绑定有效） */
function setArgv(next: readonly string[]): void {
  process.argv.length = 0;
  process.argv.push(...next);
}

/** 等待 main() 的异步链推进（浮动 promise，无法直接 await） */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  startMock.mockReset();
  closeMock.mockReset();
  closeMock.mockResolvedValue(undefined);
  startMock.mockResolvedValue({ url: 'http://127.0.0.1:1234/?token=t', close: closeMock });
  argvBackup = [...process.argv];
  envBackup = { ...process.env };
  for (const key of PI_ENV_KEYS) delete process.env[key];
  // 不能抛错：close().then(() => process.exit(0)) 的抛错会变成未处理拒绝；
  // 用例只通过 spy 断言退出码。
  exitSpy.mockReset().mockImplementation((() => undefined) as never);
  writeSpy.mockReset().mockImplementation(() => true);
  errorSpy.mockReset().mockImplementation(() => undefined);
});

afterEach(() => {
  setArgv(argvBackup);
  for (const key of PI_ENV_KEYS) {
    const original = envBackup[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

afterAll(() => {
  exitSpy.mockRestore();
  writeSpy.mockRestore();
  errorSpy.mockRestore();
});

async function importEntry(): Promise<void> {
  await import('../src/entry');
  await flush();
}

describe('entry main()', () => {
  it('should fail fast when --www-dir is missing', async () => {
    setArgv(['node', 'entry']);
    await importEntry();
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('--www-dir is required');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('should map argv into server options and write the ready line', async () => {
    const wwwDir = tempDir('piwh-entry-www-');
    const dataDir = tempDir('piwh-entry-data-');
    setArgv([
      'node',
      'entry',
      `--www-dir=${wwwDir}`,
      '--port=0',
      `--cwd=${dataDir}`,
      '--api-key=key-1',
      '--provider-id=anthropic',
      '--model=claude-sonnet-4',
      '--base-url=https://proxy.local/v1',
      '--system-prompt=be terse',
      '--enable-tools=true',
      '--tools-cwd=/work',
    ]);
    await importEntry();
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    expect(startMock).toHaveBeenCalledWith({
      wwwDir,
      port: 0,
      agentDir: dataDir,
      agent: {
        apiKey: 'key-1',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4',
        baseUrl: 'https://proxy.local/v1',
        systemPrompt: 'be terse',
        enableTools: true,
        toolsCwd: '/work',
      },
    });
    expect(
      writeSpy.mock.calls.some((call) =>
        String(call[0]).includes('pi-web-host ready: http://127.0.0.1:1234/?token=t'),
      ),
    ).toBe(true);
  });

  it('should fall back to PI_HOST_* environment variables', async () => {
    const wwwDir = tempDir('piwh-entry-www-');
    const envDataDir = tempDir('piwh-entry-data-');
    process.env.PI_HOST_API_KEY = 'env-key';
    process.env.PI_HOST_PROVIDER = 'openai';
    process.env.PI_HOST_MODEL = 'gpt-5';
    process.env.PI_HOST_BASE_URL = 'https://env.local';
    process.env.PI_HOST_ENABLE_TOOLS = 'false';
    setArgv(['node', 'entry', `--www-dir=${wwwDir}`, `--cwd=${envDataDir}`]);
    await importEntry();
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    const opts = startMock.mock.calls[0]?.[0] as {
      port: number;
      agent?: Record<string, unknown>;
    };
    expect(opts.port).toBe(0);
    expect(opts.agent).toMatchObject({
      apiKey: 'env-key',
      providerId: 'openai',
      modelId: 'gpt-5',
      baseUrl: 'https://env.local',
      enableTools: false,
    });
  });

  it('should skip the agent when the credential triple is incomplete', async () => {
    const wwwDir = tempDir('piwh-entry-www-');
    process.env.PI_HOST_API_KEY = 'only-key';
    setArgv(['node', 'entry', `--www-dir=${wwwDir}`]);
    await importEntry();
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect((startMock.mock.calls[0]?.[0] as { agent?: unknown }).agent).toBeUndefined();
  });

  it('should close the server on SIGTERM and exit 0', async () => {
    const wwwDir = tempDir('piwh-entry-www-');
    setArgv(['node', 'entry', `--www-dir=${wwwDir}`]);
    const before = new Set(process.listeners('SIGTERM'));
    await importEntry();
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    const added = process.listeners('SIGTERM').filter((l) => !before.has(l));
    expect(added.length).toBeGreaterThan(0);
    for (const listener of added) listener('SIGTERM');
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));

    for (const listener of added) process.removeListener('SIGTERM', listener);
  });

  it('should only shut down once on repeated signals', async () => {
    const wwwDir = tempDir('piwh-entry-www-');
    setArgv(['node', 'entry', `--www-dir=${wwwDir}`]);
    const before = new Set(process.listeners('SIGINT'));
    await importEntry();
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    const added = process.listeners('SIGINT').filter((l) => !before.has(l));
    for (const listener of added) listener('SIGINT');
    for (const listener of added) listener('SIGINT');
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(exitSpy).toHaveBeenCalledTimes(1);

    for (const listener of added) process.removeListener('SIGINT', listener);
  });
});

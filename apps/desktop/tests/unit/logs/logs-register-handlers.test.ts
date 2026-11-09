/**
 * 运行日志 IPC Handler 单元测试
 *
 * 验证：
 * - logs.read 返回读取结果（默认 limit 由 zod 填充），并做入参/出参双向校验；
 * - 非法入参（limit=0 / 未知级别）被契约层拦截为 VALIDATION 错误 payload；
 * - logs.info 返回日志目录与当前文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';
import { __resetLogFileForTest } from '../../../src/main/logs/log-store';
import { registerLogHandlers } from '../../../src/main/logs/register-handlers';
import type { IpcMainInvokeEvent } from 'electron';

type WrappedHandler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;

function createMockIpcMain() {
  const handlers = new Map<string, WrappedHandler>();
  return {
    handle(channel: string, fn: WrappedHandler) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null } as unknown as IpcMainInvokeEvent, req);
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'urchin-logs-ipc-'));
  __resetLogFileForTest();
});

afterEach(() => {
  __resetLogFileForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('registerLogHandlers', () => {
  it('logs.read should return entries and apply schema defaults', async () => {
    const ipcMain = createMockIpcMain();
    registerLogHandlers(ipcMain as never, { dir });
    createLogger('logs-ipc-test').error('boom', { code: 500 });

    const res = (await ipcMain.invoke('logs.read', {})) as {
      entries: { message: string; level: string }[];
      total: number;
      dir: string;
      currentFile: string;
    };
    expect(res.dir).toBe(dir);
    expect(res.currentFile).toMatch(/^app-.*\.log$/);
    expect(res.entries.some((e) => e.message === 'boom' && e.level === 'ERROR')).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(1);
  });

  it('logs.read should reject invalid request via contract validation', async () => {
    const ipcMain = createMockIpcMain();
    registerLogHandlers(ipcMain as never, { dir });

    const res = (await ipcMain.invoke('logs.read', { limit: 0 })) as { code?: string };
    expect(res.code).toBe('VALIDATION');
  });

  it('logs.info should report directory and files', async () => {
    const ipcMain = createMockIpcMain();
    registerLogHandlers(ipcMain as never, { dir });

    const res = (await ipcMain.invoke('logs.info', {})) as {
      dir: string;
      currentFile: string;
      files: { name: string }[];
    };
    expect(res.dir).toBe(dir);
    expect(res.files.some((f) => f.name === res.currentFile)).toBe(true);
  });

  it('logs.clientError should persist renderer errors into the log file', async () => {
    const ipcMain = createMockIpcMain();
    registerLogHandlers(ipcMain as never, { dir });

    const ack = (await ipcMain.invoke('logs.clientError', {
      message: 'renderer blew up',
      stack: 'Error: renderer blew up\n    at foo',
      source: 'app.js:1:2',
    })) as { ok: boolean };
    expect(ack.ok).toBe(true);

    const res = (await ipcMain.invoke('logs.read', { query: 'renderer blew up' })) as {
      entries: { level: string; module: string; meta?: Record<string, unknown> }[];
    };
    expect(res.entries[0]?.level).toBe('ERROR');
    expect(res.entries[0]?.module).toBe('renderer');
    expect(res.entries[0]?.meta?.source).toBe('app.js:1:2');
  });
});

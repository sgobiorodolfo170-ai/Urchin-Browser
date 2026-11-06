/**
 * Runtime 域便携 Node 探测单元测试
 *
 * 验证 runtime.portableNode 通道链路：
 * - resolvePortableNodeExePath：打包态 resources/node、开发态 build/node 两分支
 * - probePortableNode 判定：未安装 / 安装且可运行（版本提取）/ 安装但运行失败
 *   （错误透传）/ --version 空输出
 * - registerRuntimeHandlers：注册 'runtime.portableNode' 并透传探测结果
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

// 捕获 registerHandler 注册的通道与 handler，用于断言注册与透传
// （vi.hoisted：vi.mock 工厂在静态 import 执行期运行，普通模块级变量此时处于 TDZ）
const mocks = vi.hoisted(() => ({
  captured: new Map<string, (req: unknown, ctx: unknown) => unknown>(),
}));

vi.mock('@urchin/ipc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@urchin/ipc-contract')>();
  return {
    ...actual,
    registerHandler: (
      ipcMain: { handle: (channel: string, fn: unknown) => void },
      channel: string,
      fn: (req: unknown, ctx: unknown) => unknown,
    ) => {
      mocks.captured.set(channel, fn);
      ipcMain.handle(channel, (event: unknown, rawReq: unknown) => fn(rawReq, { event }));
    },
  };
});

import {
  probePortableNode,
  resolvePortableNodeExePath,
} from '../../src/main/runtime/portable-node';
import { registerRuntimeHandlers } from '../../src/main/runtime/register-handlers';

/** 确保「不存在」的路径：临时目录内必然无此文件 */
const MISSING_EXE = join(tmpdir(), `urchin-runtime-test-missing-${process.pid}`, 'node.exe');

function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handlers,
    handle: (
      channel: string,
      fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>,
    ) => {
      handlers.set(channel, fn);
    },
  };
}

describe('resolvePortableNodeExePath', () => {
  it('should resolve resources/node/node.exe in packaged mode', () => {
    // 期望值经 join 构造：Windows 下 join 会把 '/' 归一化为 '\'，跨平台一致
    expect(
      resolvePortableNodeExePath({
        isPackaged: true,
        resourcesPath: 'C:/app/resources',
        appPath: 'C:/app',
      }),
    ).toBe(join('C:/app/resources', 'node', 'node.exe'));
  });

  it('should resolve build/node/node.exe in dev mode', () => {
    expect(
      resolvePortableNodeExePath({
        isPackaged: false,
        resourcesPath: 'C:/app/resources',
        appPath: 'G:/repo/apps/desktop',
      }),
    ).toBe(join('G:/repo/apps/desktop', 'build', 'node', 'node.exe'));
  });
});

describe('probePortableNode', () => {
  it('should report not installed when file is missing', async () => {
    const probe = await probePortableNode({ exePath: MISSING_EXE, existsSync: () => false });
    expect(probe).toEqual({ path: MISSING_EXE, installed: false, runnable: false });
  });

  it('should report runnable with trimmed version', async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: 'v24.22.0\n' });
    const probe = await probePortableNode({
      exePath: 'C:/resources/node/node.exe',
      existsSync: () => true,
      execFileFn,
    });
    expect(probe).toEqual({
      path: 'C:/resources/node/node.exe',
      installed: true,
      runnable: true,
      version: 'v24.22.0',
    });
    expect(execFileFn).toHaveBeenCalledWith(
      'C:/resources/node/node.exe',
      ['--version'],
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
    );
  });

  it('should report not runnable with error when probe fails', async () => {
    const execFileFn = vi.fn().mockRejectedValue(new Error('spawn EACCES'));
    const probe = await probePortableNode({
      exePath: 'C:/resources/node/node.exe',
      existsSync: () => true,
      execFileFn,
    });
    expect(probe.installed).toBe(true);
    expect(probe.runnable).toBe(false);
    expect(probe.version).toBeUndefined();
    expect(probe.error).toContain('EACCES');
  });

  it('should report not runnable when --version output is empty', async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '  ' });
    const probe = await probePortableNode({
      exePath: 'C:/resources/node/node.exe',
      existsSync: () => true,
      execFileFn,
    });
    expect(probe.installed).toBe(true);
    expect(probe.runnable).toBe(false);
    expect(probe.error).toBe('--version 输出为空');
  });
});

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    mocks.captured.clear();
  });

  it('should register runtime.portableNode channel and pass through probe result', async () => {
    const ipcMain = createMockIpcMain();
    registerRuntimeHandlers(ipcMain as unknown as IpcMain, {
      portableNodeExePath: MISSING_EXE,
    });
    expect(mocks.captured.has('runtime.portableNode')).toBe(true);
    expect(ipcMain.handlers.has('runtime.portableNode')).toBe(true);
    const handler = ipcMain.handlers.get('runtime.portableNode');
    expect(handler).toBeDefined();
    const result = await handler!({} as IpcMainInvokeEvent, {});
    expect(result).toEqual({ path: MISSING_EXE, installed: false, runnable: false });
  });
});

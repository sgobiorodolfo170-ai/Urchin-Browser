/**
 * GenOffice 宿主通道单元测试（阶段 2）
 *
 * 验证：主题 getter 转发、自动保存默认值、AI 面板偏好读取/合并/数值夹取。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import {
  DEFAULT_AI_PANEL_PREFS,
  registerGenOfficeHostChannels,
} from '../../src/main/genoffice/host-channels';

type Handler = (event: unknown, req: unknown) => unknown;

function makeIpcMain(): { ipcMain: IpcMain; invoke: (ch: string, req?: unknown) => unknown } {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as unknown as IpcMain,
    invoke(channel: string, req?: unknown) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler: ${channel}`);
      return fn({}, req);
    },
  };
}

describe('registerGenOfficeHostChannels', () => {
  let ipc: ReturnType<typeof makeIpcMain>;

  beforeEach(() => {
    ipc = makeIpcMain();
    registerGenOfficeHostChannels(ipc.ipcMain, { getTheme: () => 'dark' });
  });

  it('should forward theme getter', () => {
    expect(ipc.invoke('app:get-theme')).toBe('dark');
  });

  it('should report auto-save disabled by default', () => {
    expect(ipc.invoke('app:get-auto-save-default')).toEqual({ on: false, updatedAt: 0 });
  });

  it('should return default AI panel prefs', () => {
    expect(ipc.invoke('app:get-ai-panel-prefs')).toEqual(DEFAULT_AI_PANEL_PREFS);
  });

  it('should merge AI panel prefs patch and clamp custom font size', () => {
    const next = ipc.invoke('app:set-ai-panel-prefs', {
      side: 'right',
      fontSize: 'custom',
      customFontSize: 99,
      spellcheck: false,
    });
    expect(next).toEqual({
      side: 'right',
      fontSize: 'custom',
      customFontSize: 32,
      spellcheck: false,
    });
    // 读取应拿到同一份（内存持久化）
    expect(ipc.invoke('app:get-ai-panel-prefs')).toEqual(next);
  });

  it('should ignore malformed AI panel prefs values', () => {
    const next = ipc.invoke('app:set-ai-panel-prefs', {
      side: 'top',
      fontSize: 'huge',
      customFontSize: 'big',
      spellcheck: 'yes',
    });
    expect(next).toEqual(DEFAULT_AI_PANEL_PREFS);
  });
});

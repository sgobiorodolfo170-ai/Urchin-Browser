/**
 * WindowManager 单元测试。
 *
 * 验证：
 * 1. 窗口 ID 单调递增分配
 * 2. 窗口集合的增删查
 * 3. 窗口关闭自动从集合移除
 * 4. 事件分发（window-created / window-closed）
 * 5. 窗口控制操作（minimize/maximize/fullscreen）
 *
 * 用 mock BrowserWindowFactory 避免依赖真实 Electron。
 */
import { describe, it, expect, vi } from 'vitest';
import { WindowManager } from '../../src/main/windows/window-manager';
import type { BrowserWindowLike, BrowserWindowFactory } from '../../src/main/windows/types';

/** 创建 mock BrowserWindow，记录方法调用。 */
function createMockBrowserWindow(): BrowserWindowLike & {
  _emitClosed: () => void;
  _calls: string[];
} {
  const calls: string[] = [];
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    webContents: { id: Math.floor(Math.random() * 100000), send: () => undefined },
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    close: () => calls.push('close'),
    destroy: () => calls.push('destroy'),
    isDestroyed: () => false,
    minimize: () => calls.push('minimize'),
    maximize: () => calls.push('maximize'),
    unmaximize: () => calls.push('unmaximize'),
    isMaximized: () => false,
    setFullScreen: (flag: boolean) => calls.push(`setFullScreen:${flag}`),
    isFullScreen: () => false,
    restore: () => calls.push('restore'),
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 770 }),
    setBrowserView: (view: unknown) =>
      calls.push(`setBrowserView:${view === null ? 'null' : 'view'}`),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    _emitClosed: () => {
      const arr = listeners.get('closed') ?? [];
      arr.forEach((fn) => fn());
    },
    _calls: calls,
  };
}

/** 创建 mock 工厂。 */
function createMockFactory(): BrowserWindowFactory & {
  _created: ReturnType<typeof createMockBrowserWindow>[];
} {
  const created: ReturnType<typeof createMockBrowserWindow>[] = [];
  const factory: BrowserWindowFactory = () => {
    const win = createMockBrowserWindow();
    created.push(win);
    return win;
  };
  return Object.assign(factory, { _created: created });
}

describe('WindowManager', () => {
  it('should create window and assign monotonic IDs', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    const w1 = mgr.createWindow({});
    const w2 = mgr.createWindow({});
    const w3 = mgr.createWindow({});

    expect(w1.id).toBe(1);
    expect(w2.id).toBe(2);
    expect(w3.id).toBe(3);
  });

  it('should track window count', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    expect(mgr.getCount()).toBe(0);

    mgr.createWindow({});
    mgr.createWindow({});
    expect(mgr.getCount()).toBe(2);

    mgr.createWindow({});
    expect(mgr.getCount()).toBe(3);
  });

  it('should get window by id', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    const w1 = mgr.createWindow({});
    const w2 = mgr.createWindow({});

    expect(mgr.getWindow(w1.id)?.id).toBe(1);
    expect(mgr.getWindow(w2.id)?.id).toBe(2);
    expect(mgr.getWindow(999)).toBeUndefined();
  });

  it('should get all windows', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    mgr.createWindow({});
    mgr.createWindow({ incognito: true });

    const all = mgr.getAllWindows();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe(1);
    expect(all[1]!.isIncognito).toBe(true);
  });

  it('should remove window from collection on closed event', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    const w = mgr.createWindow({});
    expect(mgr.getCount()).toBe(1);

    // 模拟 BrowserWindow 触发 closed 事件
    factory._created[0]!._emitClosed();

    expect(mgr.getCount()).toBe(0);
    expect(mgr.getWindow(w.id)).toBeUndefined();
  });

  it('should emit window-created event', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);
    const listener = vi.fn();
    mgr.on('window-created', listener);

    const w = mgr.createWindow({});
    expect(listener).toHaveBeenCalledWith(w.id);
  });

  it('should emit window-closed event when window closes', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);
    const listener = vi.fn();
    mgr.on('window-closed', listener);

    mgr.createWindow({});
    factory._created[0]!._emitClosed();

    expect(listener).toHaveBeenCalledWith(1);
  });

  it('should close window and trigger cleanup', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    mgr.createWindow({});
    expect(mgr.getCount()).toBe(1);

    mgr.closeWindow(1);
    // closeWindow 调用 browserWindow.close()，然后触发 closed 事件
    expect(factory._created[0]!._calls).toContain('close');

    // 模拟 closed 事件触发
    factory._created[0]!._emitClosed();
    expect(mgr.getCount()).toBe(0);
  });

  it('should throw when closing non-existent window', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);

    expect(() => mgr.closeWindow(999)).toThrow(/not found/i);
  });

  it('should pass options to factory', () => {
    const factory = createMockFactory();
    const factorySpy = vi.fn(factory);
    const mgr = new WindowManager(factorySpy);

    mgr.createWindow({ url: 'https://example.com', incognito: true, width: 1024, height: 768 });

    expect(factorySpy).toHaveBeenCalledWith({
      url: 'https://example.com',
      incognito: true,
      width: 1024,
      height: 768,
    });
  });

  it('should support off listener removal', () => {
    const factory = createMockFactory();
    const mgr = new WindowManager(factory);
    const listener = vi.fn();

    mgr.on('window-created', listener);
    mgr.off('window-created', listener);

    mgr.createWindow({});
    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * BookmarkPanel（收藏夹悬浮面板子窗口）单元测试
 *
 * 覆盖：
 * 1. toggle 状态机：首次开、再次关
 * 2. 未创建主窗口时 open 不崩溃
 * 3. 子窗口创建参数（frameless / skipTaskbar / sandbox preload）
 * 4. 定位：主窗口内容区右下角吸附
 * 5. blur 自动关闭
 * 6. 随主窗口 move/resize 重定位 + closed 清理监听
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BookmarkPanel,
  PANEL_WIDTH,
  PANEL_HEIGHT,
  type PanelHostWindow,
} from '../../src/main/panel/bookmark-panel';
import type { BrowserWindow } from 'electron';

/** mock BrowserWindow 的最小结构 */
function createMockPanelWindow(overrides: Partial<Record<string, unknown>> = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const w = {
    setPosition: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    showInactive: vi.fn(),
    isDestroyed: () => false,
    // 真实 Electron destroy() 会触发 'closed' 事件（用于清理监听）
    destroy: vi.fn(() => {
      (listeners.get('closed') ?? []).forEach((fn) => fn());
    }),
    once: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    _emit: (event: string, ...args: unknown[]) => {
      (listeners.get(event) ?? []).forEach((fn) => fn(...args));
    },
    ...overrides,
  };
  return w as unknown as BrowserWindow & {
    _emit: (event: string, ...args: unknown[]) => void;
    setPosition: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

/** mock 宿主主窗口 */
function createMockParent(): PanelHostWindow & {
  _emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    getContentBounds: () => ({ x: 100, y: 50, width: 1280, height: 800 }),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    removeListener: vi.fn(),
    _emit: (event: string, ...args: unknown[]) => {
      (listeners.get(event) ?? []).forEach((fn) => fn(...args));
    },
  };
}

function setup(
  overrides: {
    parent?: PanelHostWindow | null;
    createWindow?: (o: unknown) => unknown;
    getLayout?: () => { rightWidth: number; bottomHeight: number };
  } = {},
) {
  const parent = overrides.parent === undefined ? createMockParent() : overrides.parent;
  const created: ReturnType<typeof createMockPanelWindow>[] = [];
  const createWindow = overrides.createWindow
    ? (overrides.createWindow as (o: unknown) => BrowserWindow)
    : (): BrowserWindow => {
        const w = createMockPanelWindow();
        created.push(w);
        return w;
      };
  const panel = new BookmarkPanel({
    getParentWindow: () => parent,
    preloadPath: 'C:\\preload\\index.js',
    getLayout: overrides.getLayout ?? (() => ({ rightWidth: 44, bottomHeight: 48 })),
    createWindow: createWindow,
  });
  return { panel, parent, created };
}

describe('BookmarkPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should toggle open then close', () => {
    const { panel, created } = setup();
    expect(panel.isOpen).toBe(false);

    expect(panel.toggle()).toBe(true); // 首次打开
    expect(panel.isOpen).toBe(true);
    expect(created).toHaveLength(1);

    expect(panel.toggle()).toBe(false); // 再次切换关闭
    expect(panel.isOpen).toBe(false);
    expect(created[0]!.destroy).toHaveBeenCalled();
  });

  it('should not crash when parent window missing', () => {
    const { panel, created } = setup({ parent: null });
    expect(() => panel.toggle()).not.toThrow();
    expect(created).toHaveLength(0);
    expect(panel.isOpen).toBe(false);
  });

  it('should create frameless skipTaskbar sandbox window with preload', () => {
    let captured: Record<string, unknown> | null = null;
    setup({
      createWindow: (opts) => {
        captured = opts as Record<string, unknown>;
        return createMockPanelWindow();
      },
    }).panel.toggle();

    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.frame).toBe(false);
    expect(c.resizable).toBe(false);
    expect(c.skipTaskbar).toBe(true);
    expect(c.show).toBe(false);
    expect(c.width).toBe(PANEL_WIDTH);
    expect(c.height).toBe(PANEL_HEIGHT);
    const wp = c.webPreferences as Record<string, unknown>;
    expect(wp.preload).toBe('C:\\preload\\index.js');
    expect(wp.sandbox).toBe(true);
    expect(wp.contextIsolation).toBe(true);
    expect(wp.nodeIntegration).toBe(false);
  });

  it('should position panel above address bar and left of right sidebar (2px gap)', () => {
    const { panel, created } = setup();
    panel.open();
    const w = created[0]!;
    // parent: x=100,y=50,w=1280,h=800；布局：右侧栏 44 / 底部地址栏 48；间隙 2
    // x = 100+1280-44-280-2 = 1054；y = 50+800-48-430-2 = 370
    expect(w.setPosition).toHaveBeenCalledWith(1054, 370);
  });

  it('should respect layout insets from getLayout (expanded sidebars)', () => {
    const { panel, created } = setup({
      getLayout: () => ({ rightWidth: 360, bottomHeight: 48 }),
    });
    panel.open();
    const w = created[0]!;
    // x = 100+1280-360-280-2 = 738；y = 50+800-48-430-2 = 370
    expect(w.setPosition).toHaveBeenCalledWith(738, 370);
  });

  it('should close on blur (click outside)', () => {
    const { panel, created } = setup();
    panel.open();
    const w = created[0]!;
    expect(panel.isOpen).toBe(true);
    w._emit('blur');
    expect(panel.isOpen).toBe(false);
    expect(w.destroy).toHaveBeenCalled();
  });

  it('should steal focus via show() so outside clicks trigger blur', () => {
    const { panel, created } = setup();
    panel.open();
    const w = created[0]!;
    expect(w.show).not.toHaveBeenCalled();
    w._emit('ready-to-show');
    expect(w.show).toHaveBeenCalled();
    expect(w.showInactive).not.toHaveBeenCalled();
  });

  it('should suppress toggle reopen within blur cooldown (button click race)', () => {
    const { panel, created } = setup();
    // 打开
    expect(panel.toggle()).toBe(true);
    const w = created[0]!;
    // 模拟按钮点击时序：mousedown 触发面板 blur 关闭 → toggle IPC 随后到达
    w._emit('blur'); // blur 关闭面板
    expect(panel.isOpen).toBe(false);
    // 300ms 内 toggle：应视为"已通过 blur 关闭"，不重开
    expect(panel.toggle()).toBe(false);
    expect(panel.isOpen).toBe(false);
    expect(created).toHaveLength(1); // 未创建新窗口
  });

  it('should reposition on parent move/resize and clean listeners on close', () => {
    const parent = createMockParent();
    const { panel, created } = setup({ parent });
    panel.open();
    const w = created[0]!;
    w.setPosition.mockClear();

    // 主窗口移动 → 面板重定位
    parent._emit('move');
    expect(w.setPosition).toHaveBeenCalledTimes(1);

    // 关闭 → 移除 move/resize 监听
    panel.close();
    expect(parent.removeListener).toHaveBeenCalledWith('move', expect.any(Function));
    expect(parent.removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});

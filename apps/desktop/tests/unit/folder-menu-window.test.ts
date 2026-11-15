/**
 * FolderMenuWindow（收藏栏文件夹菜单子窗口）单元测试
 *
 * 覆盖：
 * 1. 子窗口创建参数（frameless / skipTaskbar / sandbox preload / 高度按子项数估算）
 * 2. 定位：按钮正下方（主流浏览器做法）
 * 3. 右缘翻转 / 下缘向上翻转
 * 4. blur 自动关闭
 * 5. 已开再 open：关旧开新
 * 6. 随主窗口 move 重定位 + closed 清理监听
 * 7. onLoad 失败销毁（无僵尸窗口）
 * 8. estimateFolderMenuHeight 上下限
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FolderMenuWindow,
  FOLDER_MENU_WIDTH,
  FOLDER_MENU_MAX_HEIGHT,
  FOLDER_MENU_MIN_HEIGHT,
  estimateFolderMenuHeight,
} from '../../src/main/bookmarks/folder-menu-window';
import type { PanelHostWindow } from '../../src/main/panel/bookmark-panel';
import type { BrowserWindow } from 'electron';

function createMockMenuWindow() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const w = {
    setPosition: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    isDestroyed: () => false,
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
  };
  return w as unknown as BrowserWindow & {
    _emit: (event: string, ...args: unknown[]) => void;
    setPosition: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

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

function setup(overrides: { parent?: PanelHostWindow | null; onLoad?: () => Promise<void> } = {}) {
  const parent = overrides.parent === undefined ? createMockParent() : overrides.parent;
  const created: ReturnType<typeof createMockMenuWindow>[] = [];
  const onLoad = overrides.onLoad ?? vi.fn().mockImplementation(() => Promise.resolve(undefined));
  const menu = new FolderMenuWindow({
    getParentWindow: () => parent,
    preloadPath: 'C:\\preload\\index.js',
    onLoad: onLoad as (win: BrowserWindow, folderId: string) => Promise<void>,
    createWindow: (): BrowserWindow => {
      const w = createMockMenuWindow();
      created.push(w);
      return w;
    },
  });
  return { menu, parent, created, onLoad };
}

describe('FolderMenuWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates frameless skipTaskbar sandbox window sized by child count', () => {
    let captured: Record<string, unknown> | null = null;
    const m = new FolderMenuWindow({
      getParentWindow: () => createMockParent(),
      preloadPath: 'C:\\preload\\index.js',
      onLoad: () => Promise.resolve(undefined),
      createWindow: (opts) => {
        captured = opts as Record<string, unknown>;
        return createMockMenuWindow();
      },
    });
    m.open('f1', { x: 300, y: 120 }, 3);
    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.frame).toBe(false);
    expect(c.skipTaskbar).toBe(true);
    expect(c.show).toBe(false);
    expect(c.width).toBe(FOLDER_MENU_WIDTH);
    expect(c.height).toBe(68 + 3 * 56);
    const wp = c.webPreferences as Record<string, unknown>;
    expect(wp.preload).toBe('C:\\preload\\index.js');
    expect(wp.sandbox).toBe(true);
  });

  it('positions below the anchor button (mainstream behavior)', () => {
    const { menu, created } = setup();
    menu.open('f1', { x: 300, y: 120 }, 3);
    const w = created[0]!;
    // 高度 = 68 + 3*56 = 236；y = 120 + 4 = 124；x 不溢出保持 300
    expect(w.setPosition).toHaveBeenCalledWith(300, 124);
  });

  it('flips left when anchor overflows right edge', () => {
    const { menu, created } = setup();
    menu.open('f1', { x: 1300, y: 120 }, 3);
    const w = created[0]!;
    // innerRight = 100 + 1280 - 8 = 1372 → x = 1372 - FOLDER_MENU_WIDTH
    expect(w.setPosition).toHaveBeenCalledWith(1372 - FOLDER_MENU_WIDTH, 124);
  });

  it('flips above the button when it would overflow bottom edge', () => {
    const { menu, created } = setup();
    menu.open('f1', { x: 300, y: 800 }, 3);
    const w = created[0]!;
    // y = 804，804 + 236 > 842（innerBottom）→ 向上翻转：800 - 236 - 4 = 560
    expect(w.setPosition).toHaveBeenCalledWith(300, 560);
  });

  it('closes on blur (click outside)', () => {
    const { menu, created } = setup();
    menu.open('f1', { x: 300, y: 120 }, 1);
    const w = created[0]!;
    expect(menu.isOpen).toBe(true);
    w._emit('blur');
    expect(menu.isOpen).toBe(false);
    expect(w.destroy).toHaveBeenCalled();
  });

  it('closes previous window when opening again', () => {
    const { menu, created, onLoad } = setup();
    menu.open('f1', { x: 300, y: 120 }, 1);
    menu.open('f2', { x: 400, y: 120 }, 2);
    expect(created).toHaveLength(2);
    expect(created[0]!.destroy).toHaveBeenCalled();
    expect(onLoad).toHaveBeenLastCalledWith(created[1]!, 'f2');
  });

  it('repositions on parent move and cleans listeners on close', () => {
    const parent = createMockParent();
    const { menu, created } = setup({ parent });
    menu.open('f1', { x: 300, y: 120 }, 1);
    const w = created[0]!;
    w.setPosition.mockClear();
    // 主窗口移动 → 菜单按最新 bounds 重定位（按钮相对内容区位置不变）
    parent._emit('move');
    expect(w.setPosition).toHaveBeenCalledTimes(1);
    // 关闭 → 移除 move/resize 监听
    w._emit('closed');
    expect(parent.removeListener).toHaveBeenCalledWith('move', expect.any(Function));
    expect(parent.removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('destroys menu when onLoad rejects (no zombie hidden window)', async () => {
    const { menu, created } = setup({
      onLoad: () => Promise.reject(new Error('dev server down')),
    });
    menu.open('f1', { x: 300, y: 120 }, 1);
    const w = created[0]!;
    await vi.waitFor(() => {
      expect(w.destroy).toHaveBeenCalled();
      expect(menu.isOpen).toBe(false);
    });
  });

  it('does not crash when parent window missing', () => {
    const { menu, created } = setup({ parent: null });
    expect(() => menu.open('f1', { x: 300, y: 120 }, 1)).not.toThrow();
    expect(created).toHaveLength(0);
  });

  it('estimateFolderMenuHeight respects min/max bounds', () => {
    expect(estimateFolderMenuHeight(0)).toBe(FOLDER_MENU_MIN_HEIGHT);
    expect(estimateFolderMenuHeight(1)).toBe(68 + 56);
    expect(estimateFolderMenuHeight(100)).toBe(FOLDER_MENU_MAX_HEIGHT);
  });
});

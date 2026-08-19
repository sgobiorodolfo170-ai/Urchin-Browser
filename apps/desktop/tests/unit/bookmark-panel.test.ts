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
  getBookmarkPanelHtml,
  getBookmarkPanelScript,
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

  it('should position panel clear of scrollbars and side bars (2px gap)', () => {
    const { panel, created } = setup();
    panel.open();
    const w = created[0]!;
    // parent: x=100,y=50,w=1280,h=800；布局：右侧栏 44 / 底部地址栏 48；
    // 滚动条 17 + 间隙 2
    // x = 100+1280-44-17-280-2 = 1037；y = 50+800-48-17-430-2 = 353
    expect(w.setPosition).toHaveBeenCalledWith(1037, 353);
  });

  it('should respect layout insets from getLayout (expanded sidebars)', () => {
    const { panel, created } = setup({
      getLayout: () => ({ rightWidth: 360, bottomHeight: 48 }),
    });
    panel.open();
    const w = created[0]!;
    // x = 100+1280-360-17-280-2 = 721；y = 50+800-48-17-430-2 = 353
    expect(w.setPosition).toHaveBeenCalledWith(721, 353);
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

describe('getBookmarkPanelHtml（面板模板）', () => {
  it('should bind pointer-drag that opens url in new window when dragged out', () => {
    const html = getBookmarkPanelHtml();

    // 书签拖出面板窗口 → 新浏览器窗口打开（自定义指针拖拽，非系统拖放）
    expect(html).toContain(
      "invoke('window.createWithUrl', { url: st.url, x: e.screenX, y: e.screenY })",
    );
    expect(html).toContain("contentEl.addEventListener('pointerdown'");
    expect(html).toContain("contentEl.addEventListener('pointermove'");
    // 不再使用系统拖放（防止拖到桌面生成快捷方式）
    expect(html).not.toContain("e.dataTransfer.setData('text/uri-list', url)");
    expect(html).not.toContain('draggable="true"');
  });
});

describe('getBookmarkPanelScript（面板交互，jsdom）', () => {
  /** 以真实面板 DOM + 脚本执行一次渲染，返回可查询的 content 容器与调用记录 */
  function setupPanel() {
    document.body.innerHTML = `
      <div class="tabs">
        <div class="tab active" data-tab="bookmarks">收藏夹</div>
        <div class="tab" data-tab="history">历史记录</div>
        <div class="tab" data-tab="downloads">下载列表</div>
      </div>
      <div class="content" id="content"><div class="empty">加载中…</div></div>
    `;
    const calls: { ch: string; req: Record<string, unknown> }[] = [];
    const invokeMock = vi.fn((ch: string, req: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ch, req });
      if (ch === 'bookmark.list') {
        return Promise.resolve({
          bookmarks: [
            {
              id: 'bm-1',
              type: 'bookmark',
              title: 'Example',
              url: 'https://example.com/A',
              parentId: null,
              position: 0,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'bm-2',
              type: 'bookmark',
              title: 'B Site',
              url: 'https://example.com/B',
              parentId: null,
              position: 1,
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        });
      }
      if (ch === 'tab.list') return Promise.resolve({ tabs: [{ id: 'tab-1', active: true }] });
      return Promise.resolve({});
    });
    (window as unknown as { urchin: { invoke: (...a: unknown[]) => Promise<unknown> } }).urchin = {
      invoke: invokeMock as unknown as (...a: unknown[]) => Promise<unknown>,
    };
    // jsdom runScripts=outside-only 下动态插入 <script> 不保证执行，改用 window.eval
    window.eval(getBookmarkPanelScript());
    return { calls };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should delete bookmark when star clicked, not open the url', async () => {
    const { calls } = setupPanel();
    // 等待首次 bookmark.list 渲染完成
    await vi.waitFor(() => expect(document.querySelectorAll('.item .star')).toHaveLength(2));

    // 真实点击序列：pointerdown（会触发面板的拖拽逻辑）→ pointerup → click
    const star = document.querySelectorAll<HTMLElement>('.item .star')[0]!;
    star.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    star.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    star.click();

    await vi.waitFor(() => {
      expect(calls.some((c) => c.ch === 'bookmark.delete')).toBe(true);
    });
    // 删除后刷新列表 → 重新拉取 bookmark.list
    const deletes = calls.filter((c) => c.ch === 'bookmark.delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.req).toEqual({ id: 'bm-1' });
    // 星标点击不得误触"打开网址"（tab.loadUrl）
    expect(calls.some((c) => c.ch === 'tab.loadUrl')).toBe(false);
  });

  it('should not start pointer drag on star (capture would hijack star click)', async () => {
    const { calls } = setupPanel();
    await vi.waitFor(() => expect(document.querySelectorAll('.item .star')).toHaveLength(2));

    // 根因回归护栏：pointerdown 落在星标上时，拖拽分支必须提前返回，不得对条目
    // 调用 setPointerCapture。真实 Chromium 中 setPointerCapture 会把随后的 click
    // 目标重定向到 .item，使星标删除点击被劫持为"打开网址"（本 bug 的直接成因）。
    const star = document.querySelectorAll<HTMLElement>('.item .star')[0]!;
    const item = star.closest<HTMLElement>('.item')!;
    item.setPointerCapture = vi.fn();
    star.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(item.setPointerCapture).not.toHaveBeenCalled();
    expect(calls.some((c) => c.ch === 'bookmark.delete')).toBe(false);
  });

  it('should start pointer drag on item body (capture for drag-out)', async () => {
    setupPanel();
    await vi.waitFor(() => expect(document.querySelectorAll('.item')).toHaveLength(2));

    // 条目主体仍保留拖拽能力：pointerdown 启动拖拽并捕获指针，供"拖出窗口打开"使用
    const item = document.querySelectorAll<HTMLElement>('.item')[0]!;
    item.setPointerCapture = vi.fn();
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(item.setPointerCapture).toHaveBeenCalled();
  });

  it('should open url in active tab when item body clicked (drag not started)', async () => {
    const { calls } = setupPanel();
    await vi.waitFor(() => expect(document.querySelectorAll('.item')).toHaveLength(2));

    // 点击条目主体（非星标）→ 打开网址；且不因 pointerdown 启动拖拽而改变 click 目标
    const item = document.querySelectorAll<HTMLElement>('.item')[1]!;
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    item.click();

    await vi.waitFor(() => {
      expect(calls.some((c) => c.ch === 'tab.loadUrl')).toBe(true);
    });
    const load = calls.find((c) => c.ch === 'tab.loadUrl');
    expect(load?.req).toEqual({ tabId: 'tab-1', url: 'https://example.com/B' });
    expect(calls.some((c) => c.ch === 'bookmark.delete')).toBe(false);
  });
});

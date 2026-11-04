/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/non-nullable-type-assertion-style
  -- 测试 mock（invoke mock 回调无 await / 返回 any）与 DOM 断言（closest 收窄）
*/
/**
 * 收藏夹面板 React 组件交互测试（P2 Session 4）
 *
 * 迁移自原 bookmark-panel.test.ts 的 jsdom 脚本执行测试（getBookmarkPanelScript），
 * 语义保持一致：星标删除不打开 URL、条目点击打开 URL、拖出窗口边界新建窗口、
 * picker 模式保存/取消、favicon 回退、重命名/新建文件夹/目录导航。
 * 另补历史分组折叠与下载操作/轮询（内联脚本时期未覆盖的路径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { Bookmark, DownloadItem, HistoryEntry } from '@urchin/ipc-contract';
import { BookmarkPanelApp } from '../../../src/renderer/panel/BookmarkPanelApp';

const DAY_MS = 24 * 60 * 60 * 1000;

const BM1: Bookmark = {
  id: 'bm-1',
  type: 'bookmark',
  title: 'Example',
  url: 'https://example.com/A',
  favicon: 'urchin://favicon/abc',
  parentId: null,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
const BM2: Bookmark = {
  id: 'bm-2',
  type: 'bookmark',
  title: 'B Site',
  url: 'https://example.com/B',
  parentId: null,
  position: 1,
  createdAt: 2,
  updatedAt: 2,
};
const FOLDER: Bookmark = {
  id: 'f-1',
  type: 'folder',
  title: '工作',
  parentId: null,
  position: 2,
  createdAt: 3,
  updatedAt: 3,
};

const invoke = vi.fn();

/** 在元素上派发携带坐标/pointerId 的指针事件（jsdom 无 PointerEvent，用 expando 注入） */
function firePointer(el: EventTarget, type: string, init: Record<string, unknown>): void {
  el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), init));
}

/** 书签行定位（按 title 文本找所属 .item 行） */
function bookmarkRow(title: string): HTMLElement {
  return screen.getByText(title).closest('.item') as HTMLElement;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, req: Record<string, unknown>) => {
    if (channel === 'bookmark.list') {
      return { bookmarks: [BM1, BM2] };
    }
    if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
    if (channel === 'history.list') return { entries: [], total: 0 };
    if (channel === 'download.list') return { downloads: [] };
    if (channel === 'ui.panel.getPickerContext') {
      return { url: 'https://current.example.com/', title: 'Current Page' };
    }
    if (channel === 'bookmark.create') return { bookmark: {} };
    if (channel === 'ui.panel.close') return { ok: true };
    void req;
    return {};
  });
  Object.defineProperty(window, 'urchin', {
    value: { invoke },
    writable: true,
    configurable: true,
  });
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BookmarkPanelApp · tab 切换与数据拉取', () => {
  it('should render three tab headers and lazy-load each tab on activation', async () => {
    render(<BookmarkPanelApp />);
    // 初始（bookmarks 激活）：只拉收藏夹
    await screen.findByText('Example');
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.list')).toBe(true);
    expect(invoke.mock.calls.some(([ch]) => ch === 'history.list')).toBe(false);
    expect(invoke.mock.calls.some(([ch]) => ch === 'download.list')).toBe(false);

    // 切历史 → history.list（limit 100 / offset 0，原 renderHistory 参数）
    fireEvent.click(screen.getByText('历史记录'));
    await waitFor(() => {
      expect(
        invoke.mock.calls.some(
          ([ch, req]) =>
            ch === 'history.list' && JSON.stringify(req) === '{"limit":100,"offset":0}',
        ),
      ).toBe(true);
    });

    // 切下载 → download.list
    fireEvent.click(screen.getByText('下载列表'));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'download.list')).toBe(true);
    });
    // 空下载列表显示空态
    expect(await screen.findByText('暂无下载记录')).toBeInTheDocument();
  });
});

describe('BookmarkPanelApp · 收藏夹交互', () => {
  it('should delete bookmark when star clicked, not open the url', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    const star = within(bookmarkRow('Example')).getByTitle('取消收藏');
    // 真实点击序列：pointerdown（拖拽逻辑必须提前返回）→ pointerup → click
    firePointer(star, 'pointerdown', { pointerId: 1 });
    firePointer(star, 'pointerup', { pointerId: 1 });
    fireEvent.click(star);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.delete')).toBe(true);
    });
    const deletes = invoke.mock.calls.filter(([ch]) => ch === 'bookmark.delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![1]).toEqual({ id: 'bm-1' });
    // 星标点击不得误触"打开网址"（tab.loadUrl）
    expect(invoke.mock.calls.some(([ch]) => ch === 'tab.loadUrl')).toBe(false);
  });

  it('should not start pointer drag on star (capture would hijack star click)', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    // 根因回归护栏：pointerdown 落在星标上时，拖拽分支必须提前返回，不得对条目
    // 调用 setPointerCapture。真实 Chromium 中 setPointerCapture 会把随后的 click
    // 目标重定向到 .item，使星标删除点击被劫持为"打开网址"。
    const star = within(bookmarkRow('Example')).getByTitle('取消收藏');
    const item = bookmarkRow('Example');
    item.setPointerCapture = vi.fn();
    firePointer(star, 'pointerdown', { pointerId: 1 });
    expect(item.setPointerCapture).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.delete')).toBe(false);
  });

  it('should start pointer drag on item body (capture for drag-out)', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    // 条目主体仍保留拖拽能力：pointerdown 启动拖拽并捕获指针，供"拖出窗口打开"使用
    const item = bookmarkRow('B Site');
    item.setPointerCapture = vi.fn();
    firePointer(item, 'pointerdown', { pointerId: 5 });
    expect(item.setPointerCapture).toHaveBeenCalledWith(5);
  });

  it('should open url in active tab when item body clicked (drag not started)', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    // 点击条目主体（非星标）→ 打开网址；且不因 pointerdown 启动拖拽而改变 click 目标
    const item = bookmarkRow('B Site');
    item.setPointerCapture = vi.fn();
    firePointer(item, 'pointerdown', { pointerId: 5 });
    firePointer(item, 'pointerup', { pointerId: 5 });
    fireEvent.click(item);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'tab.loadUrl')).toBe(true);
    });
    const load = invoke.mock.calls.find(([ch]) => ch === 'tab.loadUrl');
    expect(load![1]).toEqual({ tabId: 1, url: 'https://example.com/B' });
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.delete')).toBe(false);
  });

  it('should open url in new browser window when dragged out of panel bounds', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    const item = bookmarkRow('Example');
    item.setPointerCapture = vi.fn();
    item.releasePointerCapture = vi.fn();
    firePointer(item, 'pointerdown', { pointerId: 7, screenX: 100, screenY: 100 });
    // 指针移出面板窗口右边界（jsdom innerWidth 1024）
    firePointer(item, 'pointermove', {
      pointerId: 7,
      clientX: 1100,
      clientY: 10,
      screenX: 500,
      screenY: 300,
    });

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'window.createWithUrl')).toBe(true);
    });
    const create = invoke.mock.calls.find(([ch]) => ch === 'window.createWithUrl');
    // 定位到出界屏幕坐标（screenX/screenY），不重叠在面板窗口上
    expect(create![1]).toEqual({ url: 'https://example.com/A', x: 500, y: 300 });
    expect(item.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('should show emoji fallback when favicon image fails to load', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    const img = document.querySelector<HTMLImageElement>('#content img.favicon');
    expect(img?.getAttribute('src')).toBe('urchin://favicon/abc');
    expect(img?.getAttribute('alt')).toBe('');

    img!.dispatchEvent(new Event('error'));

    // 图片移除、emoji 回退展示（视觉结果与原 display 切换一致）
    await waitFor(() => {
      expect(document.querySelector('#content img.favicon')).toBeNull();
    });
    const slot = bookmarkRow('Example').querySelector('.favicon-slot')!;
    expect(slot.querySelector('.favicon-fallback')).not.toBeNull();
  });

  it('should rename bookmark inline on Enter (bookmark.update)', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(within(bookmarkRow('Example')).getByTitle('重命名'));
    const input = document.querySelector<HTMLInputElement>('#content .rename-input')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Example');

    fireEvent.change(input, { target: { value: '新名称' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const updates = invoke.mock.calls.filter(([ch]) => ch === 'bookmark.update');
      expect(updates).toHaveLength(1);
    });
    const update = invoke.mock.calls.find(([ch]) => ch === 'bookmark.update');
    expect(update![1]).toEqual({ id: 'bm-1', title: '新名称' });
  });

  it('should cancel inline rename on Escape without update', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(within(bookmarkRow('Example')).getByTitle('重命名'));
    const input = document.querySelector<HTMLInputElement>('#content .rename-input')!;
    fireEvent.change(input, { target: { value: '改了但不保存' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => {
      // Esc → 仅重渲染（重新拉取 bookmark.list），不得调用 bookmark.update
      expect(invoke.mock.calls.filter(([ch]) => ch === 'bookmark.list')).toHaveLength(2);
    });
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.update')).toBe(false);
  });

  it('should navigate into folder and back via breadcrumb', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'bookmark.list') return { bookmarks: [BM1, BM2, FOLDER] };
      if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
      return {};
    });
    render(<BookmarkPanelApp />);
    await screen.findByText('工作');

    // 进入文件夹 → 面包屑出现「工作」，列表显示空态
    fireEvent.click(screen.getByText('工作'));
    await waitFor(() => {
      expect(screen.getByText('此文件夹为空')).toBeInTheDocument();
    });
    expect(screen.getByText('工作', { selector: '.crumb' })).toBeInTheDocument();

    // 点「⌂ 收藏夹」回根级 → 子项恢复
    fireEvent.click(screen.getByText('⌂ 收藏夹'));
    await waitFor(() => {
      expect(screen.getByText('Example')).toBeInTheDocument();
    });
    expect(screen.queryByText('暂无书签')).toBeNull();
  });

  it('should delete folder after confirm', async () => {
    const confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'bookmark.list') return { bookmarks: [BM1, FOLDER] };
      if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
      return {};
    });
    render(<BookmarkPanelApp />);
    await screen.findByText('工作');

    fireEvent.click(within(bookmarkRow('工作')).getByTitle('删除'));

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.delete')).toBe(true);
    });
    // confirm 文案与原实现一致（级联删除提示）
    expect(confirmSpy).toHaveBeenCalledWith('删除文件夹「工作」及其全部内容？');
    const del = invoke.mock.calls.find(([ch]) => ch === 'bookmark.delete');
    expect(del![1]).toEqual({ id: 'f-1' });
  });

  it('should not delete folder when confirm dismissed', async () => {
    window.confirm = vi.fn(() => false);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'bookmark.list') return { bookmarks: [FOLDER] };
      if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
      return {};
    });
    render(<BookmarkPanelApp />);
    await screen.findByText('工作');

    fireEvent.click(within(bookmarkRow('工作')).getByTitle('删除'));
    // confirm 取消 → 不删除（留出微任务窗口验证无 delete 调用）
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.delete')).toBe(false);
  });

  it('should create folder via toolbar inline input on Enter', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('新建文件夹'));
    const input = document.querySelector<HTMLInputElement>('#content .new-folder-input')!;
    expect(input).not.toBeNull();

    fireEvent.change(input, { target: { value: '新目录' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const creates = invoke.mock.calls.filter(([ch]) => ch === 'bookmark.create');
      expect(creates).toHaveLength(1);
    });
    const create = invoke.mock.calls.find(([ch]) => ch === 'bookmark.create');
    expect(create![1]).toEqual({ title: '新目录', parentId: null, type: 'folder' });
  });
});

describe('BookmarkPanelApp · picker 模式（?mode=picker）', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?mode=picker');
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'bookmark.list') return { bookmarks: [FOLDER, BM1] };
      if (channel === 'ui.panel.getPickerContext') {
        return { url: 'https://current.example.com/', title: 'Current Page' };
      }
      if (channel === 'bookmark.create') return { bookmark: {} };
      if (channel === 'ui.panel.close') return { ok: true };
      return {};
    });
  });

  it('should render picker footer with save-into button on folder rows', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    // 底栏「保存到：根目录」+ 保存/取消按钮
    expect(screen.getByText(/保存到：根目录/)).toBeInTheDocument();
    expect(document.querySelector('[data-act="save-here"]')).not.toBeNull();
    expect(document.querySelector('[data-act="picker-cancel"]')).not.toBeNull();
    // 文件夹行有「保存到此处」按钮（data-act=save-into）
    expect(document.querySelector('.folder-item [data-act="save-into"]')).not.toBeNull();
  });

  it('should save to current (root) folder via footer button and close panel', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(document.querySelector('[data-act="save-here"]')!);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.create')).toBe(true);
    });
    const create = invoke.mock.calls.find(([ch]) => ch === 'bookmark.create')!;
    expect(create[1]).toEqual({
      url: 'https://current.example.com/',
      title: 'Current Page',
      parentId: null,
      type: 'bookmark',
    });
    expect(invoke.mock.calls.some(([ch]) => ch === 'ui.panel.close')).toBe(true);
  });

  it('should save into picked folder via row button (parentId=folder id)', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(document.querySelector('.folder-item [data-act="save-into"]')!);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.create')).toBe(true);
    });
    const create = invoke.mock.calls.find(([ch]) => ch === 'bookmark.create')!;
    expect(create[1]!.parentId).toBe('f-1');
    expect(create[1]!.url).toBe('https://current.example.com/');
  });

  it('should close panel via cancel button', async () => {
    render(<BookmarkPanelApp />);
    await screen.findByText('Example');

    fireEvent.click(document.querySelector('[data-act="picker-cancel"]')!);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'ui.panel.close')).toBe(true);
    });
    expect(invoke.mock.calls.some(([ch]) => ch === 'bookmark.create')).toBe(false);
  });
});

describe('BookmarkPanelApp · 历史分组', () => {
  it('should group by date with first group expanded and toggling works', async () => {
    const older = new Date(Date.now() - 3 * DAY_MS);
    const entries: HistoryEntry[] = [
      { id: 1, url: 'https://a.com/1', title: 'A1', visitedAt: Date.now(), visitCount: 1 },
      { id: 2, url: 'https://a.com/2', title: 'A2', visitedAt: Date.now(), visitCount: 1 },
      { id: 3, url: 'https://b.com/1', title: 'B1', visitedAt: Date.now() - DAY_MS, visitCount: 1 },
      {
        id: 4,
        url: 'https://c.com/1',
        title: 'C1',
        visitedAt: older.getTime(),
        visitCount: 1,
      },
    ];
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'history.list') return { entries, total: entries.length };
      return {};
    });
    render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('历史记录'));

    // 组标签：今天 / 昨天 / M月d日（动态日期）
    const olderLabel = `${older.getMonth() + 1}月${older.getDate()}日`;
    await screen.findByText('今天');
    expect(screen.getByText('昨天')).toBeInTheDocument();
    expect(screen.getByText(olderLabel)).toBeInTheDocument();

    // 默认最近一组（今天）展开、其余折叠
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.queryByText('B1')).toBeNull();
    expect(screen.queryByText('C1')).toBeNull();
    // 组计数徽标
    expect(screen.getByText('2', { selector: '.group-count' })).toBeInTheDocument();

    // 点击「昨天」组头展开（chevron ▸ → ▾）
    const yesterdayHeader = screen.getByText('昨天').closest('.group-header') as HTMLElement;
    expect(within(yesterdayHeader).getByText('▸')).toBeInTheDocument();
    fireEvent.click(yesterdayHeader);
    await waitFor(() => {
      expect(screen.getByText('B1')).toBeInTheDocument();
    });
    expect(within(yesterdayHeader).getByText('▾')).toBeInTheDocument();

    // 再点「今天」组头折叠
    fireEvent.click(screen.getByText('今天').closest('.group-header') as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText('A1')).toBeNull();
    });
  });

  it('should open history item url in active tab on click', async () => {
    const entries: HistoryEntry[] = [
      { id: 1, url: 'https://a.com/1', title: 'A1', visitedAt: Date.now(), visitCount: 1 },
    ];
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'history.list') return { entries, total: 1 };
      if (channel === 'tab.list') return { tabs: [{ id: 9, active: true }] };
      return {};
    });
    render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('历史记录'));

    await screen.findByText('A1');
    fireEvent.click(screen.getByText('A1'));

    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'tab.loadUrl')).toBe(true);
    });
    const load = invoke.mock.calls.find(([ch]) => ch === 'tab.loadUrl');
    expect(load![1]).toEqual({ tabId: 9, url: 'https://a.com/1' });
  });
});

describe('BookmarkPanelApp · 下载列表', () => {
  const DL_PROGRESS: DownloadItem = {
    id: 'dl-1',
    filename: 'setup.exe',
    url: 'https://dl.example.com/setup.exe',
    state: 'progressing',
    receivedBytes: 512 * 1024,
    totalBytes: 1024 * 1024,
    savePath: 'C:\\dl\\setup.exe',
    startTime: 1,
  };
  const DL_DONE: DownloadItem = {
    id: 'dl-2',
    filename: 'doc.pdf',
    url: 'https://dl.example.com/doc.pdf',
    state: 'completed',
    receivedBytes: 1024 * 1024,
    totalBytes: 1024 * 1024,
    savePath: 'C:\\dl\\doc.pdf',
    startTime: 1,
    endTime: 2,
  };

  it('should render rows with per-state meta and action buttons', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'download.list') return { downloads: [DL_PROGRESS, DL_DONE] };
      return {};
    });
    render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('下载列表'));

    await screen.findByText('setup.exe');
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();

    // progressing：大小 + 首轮速度采样为 0 → 显示 …；按钮 暂停/取消
    const progressRow = screen.getByText('setup.exe').closest('.dl-item')!;
    expect(progressRow.className).not.toContain('indeterminate');
    expect(
      within(progressRow as HTMLElement).getByText(/512.0 KB \/ 1.0 MB · …/),
    ).toBeInTheDocument();
    expect(within(progressRow as HTMLElement).getByText('暂停')).toBeInTheDocument();
    expect(within(progressRow as HTMLElement).getByText('取消')).toBeInTheDocument();

    // completed：已完成 · 大小；按钮 📂
    const doneRow = screen.getByText('doc.pdf').closest('.dl-item')!;
    expect(within(doneRow as HTMLElement).getByText('已完成 · 1.0 MB')).toBeInTheDocument();
    expect(within(doneRow as HTMLElement).getByTitle('在文件夹中显示')).toBeInTheDocument();

    // 进度条填充 50%（jsdom CSSOM 会把 50.0% 规范化为 50%，故用 parseFloat 比较）
    const fill = progressRow.querySelector('.progress-bar-fill') as HTMLElement;
    expect(Number.parseFloat(fill.style.width)).toBeCloseTo(50);
  });

  it('should show indeterminate bar for unknown total size', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'download.list') {
        return {
          downloads: [{ ...DL_PROGRESS, totalBytes: 0 }],
        };
      }
      return {};
    });
    render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('下载列表'));

    const row = (await screen.findByText('setup.exe')).closest('.dl-item')!;
    expect(row.className).toContain('indeterminate');
    const fill = row.querySelector('.progress-bar-fill') as HTMLElement;
    // 未知总量：不定进度动画（无内联宽度，宽度由 CSS !important 接管）
    expect(fill.style.width).toBe('');
  });

  it('should invoke pause/resume/show actions and clear', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'download.list') return { downloads: [DL_PROGRESS, DL_DONE] };
      return {};
    });
    render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('下载列表'));
    await screen.findByText('setup.exe');
    const listCallsAfterLoad = invoke.mock.calls.filter(([ch]) => ch === 'download.list').length;

    // 暂停 → download.pause + 刷新
    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'download.pause')).toBe(true);
    });
    const pause = invoke.mock.calls.find(([ch]) => ch === 'download.pause');
    expect(pause![1]).toEqual({ id: 'dl-1' });
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([ch]) => ch === 'download.list').length).toBeGreaterThan(
        listCallsAfterLoad,
      );
    });

    // 📂 在文件夹中显示 → download.showInFolder，且不触发刷新（原语义 act !== 'show'）
    const showCallsBefore = invoke.mock.calls.filter(([ch]) => ch === 'download.list').length;
    fireEvent.click(screen.getByTitle('在文件夹中显示'));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'download.showInFolder')).toBe(true);
    });
    expect(invoke.mock.calls.filter(([ch]) => ch === 'download.list').length).toBe(showCallsBefore);

    // 清空已结束的下载 → download.clear + 刷新
    fireEvent.click(screen.getByText('清空已结束的下载'));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([ch]) => ch === 'download.clear')).toBe(true);
    });
  });

  it('should poll download.list every 500ms while active and stop on unmount', async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'download.list') return { downloads: [DL_PROGRESS] };
      return {};
    });
    const { unmount } = render(<BookmarkPanelApp />);
    fireEvent.click(screen.getByText('下载列表'));
    // 冲刷首拉微任务（fake timers 下不用 findBy*：其内部依赖定时器）
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('setup.exe')).toBeInTheDocument();
    const afterLoad = invoke.mock.calls.filter(([ch]) => ch === 'download.list').length;

    // 500ms 轮询间隔（DOWNLOAD_POLL_MS，约束不变）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(invoke.mock.calls.filter(([ch]) => ch === 'download.list').length).toBe(afterLoad + 1);

    // 卸载 → 轮询停止（原 loadTab → stopDownloadPolling / 窗口销毁随进程回收）
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(invoke.mock.calls.filter(([ch]) => ch === 'download.list').length).toBe(afterLoad + 1);
  });
});

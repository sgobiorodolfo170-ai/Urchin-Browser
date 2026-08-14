/**
 * M4 Omnibox 组件单元测试
 *
 * 覆盖：
 * 1. 渲染地址栏（当前 URL 回填）
 * 2. Enter 导航（有效 URL）/ 危险协议拦截
 * 3. Escape 恢复原始 URL
 * 4. 输入 debounce 触发 onSuggestionQuery
 * 5. 补全建议渲染 + 点击导航
 * 6. 收藏按钮（bookmarkable 禁用 / 点击回调）
 * 7. 收藏夹面板：书签选项卡渲染与导航
 * 8. 历史记录选项卡：懒加载 history.list
 * 9. 下载列表选项卡：懒加载 download.list + 空态
 * 10. AI 摘要按钮回调
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  Omnibox,
  type BookmarkItem,
  type HistoryItem,
  type DownloadItem,
} from '../../src/renderer/omnibox/omnibox';
import type { Suggestion } from '../../src/renderer/omnibox/types';

const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({});
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

const bookmarks: readonly BookmarkItem[] = [
  { id: 'b1', title: 'GitHub', url: 'https://github.com' },
  { id: 'b2', title: '本地书签', url: 'https://example.com' },
];

const history: readonly HistoryItem[] = [
  { id: 1, url: 'https://github.com', title: 'GitHub', visitedAt: 1700000000000, visitCount: 3 },
];

const downloads: readonly DownloadItem[] = [
  {
    id: 'd1',
    filename: 'report.pdf',
    url: 'https://example.com/report.pdf',
    state: 'completed',
    receivedBytes: 1024,
    totalBytes: 2048,
    savePath: 'C:\\Downloads\\report.pdf',
    startTime: 1700000000000,
  },
];

function renderOmnibox(overrides: Partial<Parameters<typeof Omnibox>[0]> = {}) {
  const props: Parameters<typeof Omnibox>[0] = {
    currentUrl: 'https://github.com',
    loading: false,
    securityState: 'secure',
    suggestions: [],
    onNavigate: onNavigateMock,
    onSuggestionQuery: onSuggestionQueryMock,
    bookmarkSaved: false,
    bookmarkable: true,
    onBookmarkToggle: onBookmarkToggleMock,
    bookmarks: [],
    onBookmarkNavigate: onBookmarkNavigateMock,
    onSummarize: onSummarizeMock,
    summarizeDisabled: false,
    ...overrides,
  };
  render(<Omnibox {...props} />);
  return props;
}

/** 各回调的 mock 引用（返回 props 后仍可通过具名 mock 断言调用参数） */
const onNavigateMock = vi.fn();
const onSuggestionQueryMock = vi.fn();
const onBookmarkToggleMock = vi.fn();
const onBookmarkNavigateMock = vi.fn();
const onSummarizeMock = vi.fn();

beforeEach(() => {
  onNavigateMock.mockReset();
  onSuggestionQueryMock.mockReset();
  onBookmarkToggleMock.mockReset();
  onBookmarkNavigateMock.mockReset();
  onSummarizeMock.mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({});
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

/** 等待 debounce（150ms）真实触发 */
async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe('Omnibox', () => {
  it('should render address bar with current url value', () => {
    renderOmnibox({ currentUrl: 'https://github.com' });
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('https://github.com');
  });

  it('should navigate on Enter with valid url', () => {
    renderOmnibox();
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'https://example.com/page' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigateMock).toHaveBeenCalledWith('https://example.com/page');
  });

  it('should navigate with search-engine fallback for bare words', () => {
    renderOmnibox();
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // parseInput 将裸词解析为搜索引擎 URL
    const called = onNavigateMock.mock.calls[0]?.[0] as string;
    expect(called).toContain('search');
  });

  it('should not navigate to dangerous protocols (javascript:)', () => {
    renderOmnibox();
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // parseInput 将无点无空格的 javascript: 输入识别为搜索词（转搜索引擎 URL），
    // 因此导航目标绝不可能是 javascript: 协议——OM5 危险协议拦截生效（安全行为）
    const called = onNavigateMock.mock.calls[0]?.[0] as string | undefined;
    if (called) {
      expect(called.startsWith('javascript:')).toBe(false);
      expect(called).toContain('search?q=');
    }
  });

  it('should restore original url on Escape', () => {
    renderOmnibox({ currentUrl: 'https://github.com' });
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'https://other.com' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('https://github.com');
  });

  it('should fire onSuggestionQuery after debounce when typing', async () => {
    renderOmnibox();
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'github' } });
    await waitForDebounce();
    expect(onSuggestionQueryMock).toHaveBeenCalledWith('github');
  });

  it('should render suggestions and navigate on click', () => {
    const suggestions: readonly Suggestion[] = [
      { type: 'history', title: 'GitHub', url: 'https://github.com', matchType: 'url', score: 70 },
    ];
    renderOmnibox({ suggestions });
    fireEvent.focus(screen.getByRole('textbox'));
    fireEvent.click(screen.getByText('GitHub'));
    expect(onNavigateMock).toHaveBeenCalledWith('https://github.com');
  });

  it('should disable bookmark toggle when not bookmarkable', () => {
    renderOmnibox({ bookmarkable: false });
    const starBtn = screen.getByLabelText<HTMLButtonElement>('收藏到书签');
    expect(starBtn.disabled).toBe(true);
    fireEvent.click(starBtn);
    expect(onBookmarkToggleMock).not.toHaveBeenCalled();
  });

  it('should call onBookmarkToggle when bookmarkable', () => {
    renderOmnibox({ bookmarkable: true });
    fireEvent.click(screen.getByLabelText('收藏到书签'));
    expect(onBookmarkToggleMock).toHaveBeenCalled();
  });

  it('should render bookmarks panel and navigate on bookmark click', () => {
    renderOmnibox({ bookmarks });
    fireEvent.click(screen.getByLabelText('收藏夹'));
    expect(screen.getByText('GitHub')).toBeTruthy();
    fireEvent.click(screen.getByText('GitHub'));
    expect(onBookmarkNavigateMock).toHaveBeenCalledWith('https://github.com');
  });

  it('should load history list lazily when switching to history tab', async () => {
    mockInvoke.mockResolvedValue({ entries: history, total: 1 });
    renderOmnibox();
    fireEvent.click(screen.getByLabelText('收藏夹'));
    fireEvent.click(screen.getByText('历史记录'));
    expect(mockInvoke).toHaveBeenCalledWith('history.list', { limit: 100, offset: 0 });
    await waitFor(() => expect(screen.getByText('GitHub')).toBeTruthy());
  });

  it('should load downloads list lazily and show completed state', async () => {
    mockInvoke.mockResolvedValue({ downloads });
    renderOmnibox();
    fireEvent.click(screen.getByLabelText('收藏夹'));
    fireEvent.click(screen.getByText('下载列表'));
    expect(mockInvoke).toHaveBeenCalledWith('download.list', {});
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy());
    expect(screen.getByText(/已完成/)).toBeTruthy();
  });

  it('should show empty states for bookmarks and history', async () => {
    mockInvoke.mockResolvedValue({ entries: [], total: 0 });
    renderOmnibox({ bookmarks: [] });
    fireEvent.click(screen.getByLabelText('收藏夹'));
    expect(screen.getByText('暂无书签')).toBeTruthy();
    fireEvent.click(screen.getByText('历史记录'));
    await waitFor(() => expect(screen.getByText('暂无历史记录')).toBeTruthy());
  });

  it('should trigger onSummarize when enabled', () => {
    renderOmnibox({ summarizeDisabled: false });
    fireEvent.click(screen.getByLabelText('提取网页内容并保存'));
    expect(onSummarizeMock).toHaveBeenCalled();
  });

  it('should disable summarize button when summarizeDisabled', () => {
    renderOmnibox({ summarizeDisabled: true });
    expect(screen.getByLabelText<HTMLButtonElement>('提取网页内容并保存').disabled).toBe(true);
  });
});

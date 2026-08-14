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
 * 7. 收藏夹按钮：点击发送 ui.panel.toggle（悬浮面板由主进程 BookmarkPanel 子窗口管理）
 * 8. AI 摘要按钮回调
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Omnibox } from '../../src/renderer/omnibox/omnibox';
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
const onSummarizeMock = vi.fn();

beforeEach(() => {
  onNavigateMock.mockReset();
  onSuggestionQueryMock.mockReset();
  onBookmarkToggleMock.mockReset();
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

  it('should toggle floating bookmark panel via ui.panel.toggle on folder button click', () => {
    mockInvoke.mockResolvedValue({ open: true });
    renderOmnibox();
    fireEvent.click(screen.getByLabelText('收藏夹'));
    // 悬浮面板由主进程 BookmarkPanel 子窗口管理，渲染层仅发开关通知
    expect(mockInvoke).toHaveBeenCalledWith('ui.panel.toggle', {});
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

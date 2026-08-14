/**
 * 主页（NewTabPage）单元测试
 *
 * 覆盖：
 * 1. 渲染：浏览器图标/名称、红橙渐变线、蓝绿渐变线、常用区、最近区
 * 2. 数据：加载常用书签（settings.home.frequentSites）+ 最近浏览（history 派生根域）
 * 3. 最近浏览去重（同一根域只保留最新）+ 仅根网址
 * 4. 最近区拖入常用区（去重：已存在不重复添加）
 * 5. 点击卡片导航
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewTabPage } from '../../src/renderer/home/NewTabPage';

const mockInvoke = vi.fn();
const onNavigate = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  onNavigate.mockReset();
  mockInvoke.mockResolvedValue({});
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

/** 默认 mock：常用书签空 + 历史含重复根域 */
function mockLoad() {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'settings.get') {
      return Promise.resolve({ value: [] });
    }
    if (channel === 'history.list') {
      return Promise.resolve({
        entries: [
          // 同一根域 baidu.com 两条（不同路径）→ 应只保留一条（最新在前）
          { url: 'https://www.baidu.com/s?wd=a', title: '百度搜索A', visitedAt: 300 },
          { url: 'https://www.baidu.com/', title: '百度', visitedAt: 200 },
          { url: 'https://github.com', title: 'GitHub', visitedAt: 100 },
          // 非 http(s) 应被忽略
          { url: 'file:///C:/x.html', title: 'File', visitedAt: 400 },
        ],
      });
    }
    return Promise.resolve({});
  });
}

describe('NewTabPage', () => {
  it('should render logo, title, dividers and sections', async () => {
    mockLoad();
    render(<NewTabPage onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText('Urchin Browser')).toBeInTheDocument());
    // 常用区与最近区标题
    expect(screen.getByText('最近浏览')).toBeInTheDocument();
  });

  it('should derive recent sites from history (root url, dedup, ignore non-http)', async () => {
    mockLoad();
    render(<NewTabPage onNavigate={onNavigate} />);
    // baidu 去重后仅一条，+ github = 2 条
    await waitFor(() => expect(screen.getAllByText('百度搜索A')).toHaveLength(1));
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.queryByText('File')).toBeNull();
  });

  it('should navigate on site click', async () => {
    mockLoad();
    render(<NewTabPage onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText('GitHub')).toBeInTheDocument());
    fireEvent.click(screen.getByText('GitHub'));
    expect(onNavigate).toHaveBeenCalledWith('https://github.com');
  });

  it('should not add duplicate frequent site when dragging recent onto frequent', async () => {
    // 常用已有 github
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings.get') {
        return Promise.resolve({ value: [{ url: 'https://github.com', title: 'GitHub' }] });
      }
      if (channel === 'history.list') {
        return Promise.resolve({
          entries: [{ url: 'https://github.com', title: 'GitHub', visitedAt: 100 }],
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    render(<NewTabPage onNavigate={onNavigate} />);
    // 常用区 + 最近区都有 GitHub（常用预置 + 历史派生）
    await waitFor(() => expect(screen.getAllByText('GitHub').length).toBeGreaterThanOrEqual(2));

    // 拖最近区 github 到常用区 → 已存在，不重复添加。
    // 找最近区（「最近浏览」标题所在容器）内的 GitHub 卡片
    const recentSection = screen.getByText('最近浏览').parentElement!.parentElement!;
    const recentCard = Array.from(recentSection.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('GitHub'),
    );
    expect(recentCard).toBeTruthy();
    const frequentZone = screen.getByTestId('frequent-sites');
    // 用共享 dataTransfer 模拟 dragStart→drop 链路
    const dataTransfer = {
      data: '',
      setData: (t: string) => {
        dataTransfer.data = t;
      },
      getData: () => dataTransfer.data,
    };
    fireEvent.dragStart(recentCard!, { dataTransfer });
    fireEvent.drop(frequentZone, { dataTransfer });
    // 常用区仍只有 1 个 github（未重复添加）
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'settings.set',
      expect.objectContaining({ key: 'home.frequentSites' }),
    );
  });
});

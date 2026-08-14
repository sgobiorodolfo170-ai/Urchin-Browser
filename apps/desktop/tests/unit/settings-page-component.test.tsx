/**
 * 设置页 React 组件（renderer/settings/SettingsPage.tsx）单元测试
 *
 * 覆盖：
 * 1. 挂载时加载设置 + Provider 列表
 * 2. 选项卡切换（通用 / AI 助手 / 隐私 / 更新 / 关于 / 调试）
 * 3. 字段修改触发 800ms debounce 自动保存（settings.set + 事件广播 + toast）
 * 4. 重置默认（confirm 确认后写入 DEFAULTS）
 * 5. 加载失败错误分支
 * 6. 目录字段「浏览」按钮（dialog.selectDirectory）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/settings/SettingsPage';

const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke: mockInvoke,
      platform: 'win32',
      versions: { electron: '32.0.0', chrome: '128.0.0', node: '22.0.0' },
    },
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 真实等待 debounce（800ms）+ 保存 flush，避免 fake timers 冻结 waitFor 轮询 */
async function waitForDebouncedSave(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 900));
}

/** 默认 mock：设置加载成功 + 1 个 Provider */
function mockLoadSuccess() {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'settings.getAll') {
      return Promise.resolve({
        entries: [
          { key: 'theme', value: 'light' },
          { key: 'language', value: 'zh-CN' },
          { key: 'searchEngine', value: 'google' },
          { key: 'homepage', value: 'urchin://newtab' },
          { key: 'blockTrackers', value: true },
          { key: 'doNotTrack', value: true },
          { key: 'summary.model', value: 'gpt-4o-mini' },
          { key: 'debug.sidebarHoverDelay', value: 300 },
        ],
      });
    }
    if (channel === 'provider.rescan') return Promise.resolve({ count: 1, providers: [] });
    if (channel === 'provider.list') {
      return Promise.resolve({ providers: [{ id: 'openai', name: 'OpenAI', version: '1.0.0' }] });
    }
    if (channel === 'settings.set') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
}

/** 点击选项卡按钮（文本同时出现在内容区 h1，取第一个即导航按钮） */
function clickTab(label: string): void {
  fireEvent.click(screen.getAllByText(label)[0]!);
}

describe('SettingsPage', () => {
  it('should load settings and render general tab fields on mount', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);

    // 加载完成前显示 loading
    expect(screen.getByText('加载中…')).toBeTruthy();

    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));
    // 通用选项卡字段
    expect(screen.getByText('主题')).toBeTruthy();
    expect(screen.getByText('界面语言')).toBeTruthy();
    expect(screen.getByText('搜索引擎')).toBeTruthy();
    expect(screen.getByText('主页')).toBeTruthy();
    // 当前值回填（主题 select 是通用选项卡第一个下拉，值应为 light）
    const themeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(themeSelect.tagName).toBe('SELECT');
    expect(themeSelect.value).toBe('light');
    // 重置按钮存在
    expect(screen.getByText('重置默认')).toBeTruthy();
  });

  it('should switch tabs and render AI / privacy / update / about / debug content', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // AI 助手选项卡
    clickTab('AI 助手');
    expect(screen.getByText('默认 Provider')).toBeTruthy();
    expect(screen.getByText('API Key')).toBeTruthy();
    // provider-select 回填 Provider 列表
    expect(screen.getByText('OpenAI v1.0.0')).toBeTruthy();

    // 隐私与安全
    clickTab('隐私与安全');
    expect(screen.getByText('拦截追踪器')).toBeTruthy();
    expect(screen.getByText('请勿追踪')).toBeTruthy();

    // 更新
    clickTab('更新');
    expect(screen.getByText('当前版本')).toBeTruthy();
    expect(screen.getByText('v0.1.0')).toBeTruthy();
    expect(screen.getByText('立即检查')).toBeTruthy();

    // 关于
    clickTab('关于');
    expect(screen.getByText('Urchin Browser')).toBeTruthy();
    expect(screen.getByText('运行时信息')).toBeTruthy();
    expect(screen.getByText('32.0.0')).toBeTruthy();

    // 调试
    clickTab('调试');
    expect(screen.getByText('DEV')).toBeTruthy();
    expect(screen.getByText('配色方案')).toBeTruthy();
  });

  it('should auto-save field change after debounce (800ms)', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 修改主题 select → dark（通用选项卡第一个下拉）
    const themeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(themeSelect, { target: { value: 'dark' } });

    // debounce 窗口内不应立即保存
    expect(mockInvoke).not.toHaveBeenCalledWith('settings.set', expect.anything());

    // 等待 800ms debounce 触发 flushSave
    await waitForDebouncedSave();

    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'theme', value: 'dark' });
    // toast 显示
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('should batch multiple changes into one save round', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    const themeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(themeSelect, { target: { value: 'dark' } });
    // 搜索引擎（通用选项卡第三个下拉）→ bing
    fireEvent.change(screen.getAllByRole('combobox')[2] as HTMLSelectElement, {
      target: { value: 'bing' },
    });

    await waitForDebouncedSave();

    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'theme', value: 'dark' });
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'searchEngine', value: 'bing' });
  });

  it('should toggle boolean field and auto-save', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 切到隐私选项卡，点击拦截追踪器开关（初始 true）
    // 切到隐私选项卡，点击拦截追踪器开关（初始 true；两个开关中第一个）
    clickTab('隐私与安全');
    const switchBtn = screen.getAllByRole('switch')[0]!;
    expect(switchBtn.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(switchBtn);

    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'blockTrackers', value: false });
  });

  it('should reset all settings to defaults after confirm', async () => {
    mockLoadSuccess();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('重置默认'));

    // 等待重置循环完成（多个 await settings.set）
    await waitFor(() => expect(screen.getByText('已重置为默认值')).toBeTruthy());
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'theme', value: 'light' });
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'blockTrackers', value: true });
  });

  it('should show error state when settings load fails', async () => {
    mockInvoke.mockRejectedValue(new Error('db broken'));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
  });

  it('should pick directory via dialog.selectDirectory and auto-save', async () => {
    mockLoadSuccess();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'dialog.selectDirectory') {
        return Promise.resolve({ path: 'C:\\Users\\test\\Downloads' });
      }
      return Promise.resolve({ ok: true, entries: [], providers: [], count: 0 });
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 下载位置字段的「浏览」按钮
    const browseButtons = screen.getAllByText('浏览');
    fireEvent.click(browseButtons[0]!);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('dialog.selectDirectory', expect.anything()),
    );
    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'downloadsPath',
      value: 'C:\\Users\\test\\Downloads',
    });
  });
});

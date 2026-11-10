/**
 * 设置页 React 组件（renderer/settings/SettingsPage.tsx）单元测试
 *
 * 覆盖：
 * 1. 挂载时加载设置 + Provider 列表
 * 2. 选项卡切换（通用 / 操作 / AI 助手 / 隐私 / 建议与反馈 / 关于）
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
      on: vi.fn(() => () => undefined),
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

/** 默认 mock：设置加载成功 */
function mockLoadSuccess() {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'settings.getAll') {
      return Promise.resolve({
        entries: [
          { key: 'language', value: 'zh-CN' },
          { key: 'searchEngine', value: 'google' },
          { key: 'blockTrackers', value: true },
          { key: 'doNotTrack', value: true },
          { key: 'debug.sidebarHoverDelay', value: 300 },
        ],
      });
    }
    if (channel === 'settings.set') return Promise.resolve({ ok: true });
    // 更新选项卡 / 关于选项卡：状态快照（dev.114 起版本来自主进程）
    if (channel === 'update.getState' || channel === 'update.check') {
      return Promise.resolve({
        status: 'up-to-date',
        currentVersion: '0.1.0-dev.113',
        checkedAt: '2026-10-19T00:00:00.000Z',
      });
    }
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
    expect(screen.getByText('界面语言')).toBeTruthy();
    expect(screen.getByText('搜索引擎')).toBeTruthy();
    expect(screen.getByText('关闭窗口时最小化到系统托盘')).toBeTruthy();
    // 当前值回填（界面语言是通用选项卡第一个下拉，值应为 zh-CN）
    const langSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(langSelect.tagName).toBe('SELECT');
    expect(langSelect.value).toBe('zh-CN');
    // 重置按钮存在
    expect(screen.getByText('重置默认')).toBeTruthy();
  });

  it('should render browser import block under data tab instead of general', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 通用 tab 不再出现导入区块
    expect(screen.queryByText('从其他浏览器导入')).toBeNull();

    clickTab('数据');
    expect(screen.getByText('从其他浏览器导入')).toBeTruthy();
    expect(screen.getByText('同时导入 Cookie（登录状态）')).toBeTruthy();
    expect(screen.getByText('检测本机浏览器')).toBeTruthy();
  });

  it('should pass includeCookies=true when the cookie checkbox is checked', async () => {
    mockLoadSuccess();
    const browser = {
      id: 'firefox:C:\\FF',
      kind: 'firefox' as const,
      displayName: 'Mozilla Firefox',
      profileName: 'default',
      profileDir: 'C:\\FF',
      bookmarksSource: 'firefox-places' as const,
      cookiesSupport: 'full' as const,
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings.getAll') {
        return Promise.resolve({ entries: [{ key: 'language', value: 'zh-CN' }] });
      }
      if (channel === 'import.detectBrowsers') return Promise.resolve({ browsers: [browser] });
      if (channel === 'import.bookmarksFromBrowser') {
        return Promise.resolve({
          canceled: false,
          summary: {
            folders: 1,
            bookmarks: 1,
            skipped: 0,
            rootFolderId: 'r',
            rootFolderTitle: 'r',
          },
          cookies: { imported: 2, skipped: 0, failed: 0, encryptedSkipped: 0 },
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    clickTab('数据');
    fireEvent.click(screen.getByText('检测本机浏览器'));
    await waitFor(() => expect(screen.getByText('Mozilla Firefox')).toBeTruthy());

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('导入收藏夹'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('import.bookmarksFromBrowser', {
        id: 'firefox:C:\\FF',
        includeCookies: true,
      }),
    );
  });

  it('should switch tabs and render AI / privacy / about / ops content', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // AI 助手选项卡（占位）
    clickTab('AI 助手');
    expect(screen.getByText('AI 助手功能正在开发中，敬请期待。')).toBeTruthy();

    // 帮助手册选项卡（全部操作说明）
    clickTab('帮助手册');
    expect(screen.getByText('常用快捷键')).toBeTruthy();
    expect(screen.getByText('界面总览')).toBeTruthy();
    expect(screen.getByText('标签页与工作区')).toBeTruthy();
    expect(screen.getByText('帮助手册', { selector: 'h1' })).toBeTruthy();

    // 隐私与安全
    clickTab('隐私与安全');
    expect(screen.getByText('拦截追踪器')).toBeTruthy();
    expect(screen.getByText('请勿追踪')).toBeTruthy();

    // 建议与反馈选项卡（GitHub Issues / Discussions 入口）
    clickTab('建议与反馈');
    expect(screen.getByText('问题反馈（Issues）')).toBeTruthy();
    expect(screen.getByText('讨论区（Discussions）')).toBeTruthy();
    expect(screen.getByText('前往 Issues')).toBeTruthy();
    expect(screen.getByText('前往 Discussions')).toBeTruthy();

    // 关于（原「更新」内容已移入）
    clickTab('关于');
    expect(screen.getByText('Urchin Browser')).toBeTruthy();
    expect(screen.getByText('更新检查')).toBeTruthy();
    // 版本来自主进程 update.getState（真实 app.getVersion()）
    await waitFor(() => expect(screen.getByText('v0.1.0-dev.113')).toBeTruthy());
    expect(screen.getByText('立即检查')).toBeTruthy();
    expect(screen.getByText('运行时信息')).toBeTruthy();
    expect(screen.getByText('32.0.0')).toBeTruthy();

    // 操作选项卡：右侧边栏展开方式 + 悬停展开延迟（由调试选项卡迁入）
    clickTab('操作');
    expect(screen.getByText('右侧边栏展开方式')).toBeTruthy();
    expect(screen.getByText('左侧边栏悬停自动展开')).toBeTruthy();
    expect(screen.getByText('侧边栏悬停展开延迟')).toBeTruthy();
  });

  it('should auto-save field change after debounce (800ms)', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 修改界面语言 select → en-US（通用选项卡第一个下拉）
    const langSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(langSelect, { target: { value: 'en-US' } });

    // debounce 窗口内不应立即保存
    expect(mockInvoke).not.toHaveBeenCalledWith('settings.set', expect.anything());

    // 等待 800ms debounce 触发 flushSave
    await waitForDebouncedSave();

    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'language', value: 'en-US' });
    // toast 显示
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('should batch multiple changes into one save round', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    const langSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(langSelect, { target: { value: 'en-US' } });
    // 搜索引擎（通用选项卡第二个下拉）→ bing
    fireEvent.change(screen.getAllByRole('combobox')[1] as HTMLSelectElement, {
      target: { value: 'bing' },
    });

    await waitForDebouncedSave();

    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'language', value: 'en-US' });
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
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'language', value: 'zh-CN' });
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

    // 数据选项卡 directory 字段顺序：data.directory[0] / downloadsPath[1] /
    // clipper.saveDir[2]（2026-11-06 新增剪藏保存路径），浏览按钮同序。
    clickTab('数据');
    // 下载位置字段（第二个）的「浏览」按钮
    const browseButtons = screen.getAllByText('浏览');
    fireEvent.click(browseButtons[1]!);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('dialog.selectDirectory', expect.anything()),
    );
    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'downloadsPath',
      value: 'C:\\Users\\test\\Downloads',
    });
  });

  it('should pick data directory via dialog.selectDirectory and auto-save', async () => {
    mockLoadSuccess();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'dialog.selectDirectory') {
        return Promise.resolve({ path: 'D:\\urchin-data' });
      }
      return Promise.resolve({ ok: true, entries: [], providers: [], count: 0 });
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    // 数据选项卡：数据存储位置字段（第一个 directory 字段）的「浏览」按钮
    clickTab('数据');
    const browseButtons = screen.getAllByText('浏览');
    fireEvent.click(browseButtons[0]!);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('dialog.selectDirectory', expect.anything()),
    );
    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'data.directory',
      value: 'D:\\urchin-data',
    });
  });

  it('should render clipper tab between general and ops with format/template fields', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    clickTab('剪藏');
    expect(screen.getByText('默认保存格式')).toBeTruthy();
    expect(screen.getByText('快照默认正文清洗')).toBeTruthy();
    expect(screen.getByText('页面属性模板')).toBeTruthy();
    // 保存位置说明已移至「数据」选项卡（剪藏保存路径字段，2026-11-06 用户需求）
    expect(screen.queryByText('保存位置')).toBeNull();
  });

  it('should render clipper save path field in data tab (2026-11-06)', async () => {
    mockLoadSuccess();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));

    clickTab('数据');
    expect(screen.getByText('剪藏保存路径')).toBeTruthy();
    expect(screen.getByText('下载位置')).toBeTruthy();
    expect(screen.getByText('数据存储位置')).toBeTruthy();
  });
});

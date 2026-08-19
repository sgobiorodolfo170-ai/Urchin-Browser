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
          { key: 'summary.model', value: 'gpt-4o-mini' },
          { key: 'debug.sidebarHoverDelay', value: 300 },
        ],
      });
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
    expect(screen.getByText('界面语言')).toBeTruthy();
    expect(screen.getByText('搜索引擎')).toBeTruthy();
    // 当前值回填（界面语言是通用选项卡第一个下拉，值应为 zh-CN）
    const langSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(langSelect.tagName).toBe('SELECT');
    expect(langSelect.value).toBe('zh-CN');
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
    expect(screen.getByText('提供商名')).toBeTruthy();
    // 默认 Provider 为自定义下拉（按钮），无配置时空白
    expect(screen.getByRole('button', { name: '选择默认 Provider' })).toBeTruthy();

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

    // 通用选项卡 directory 字段顺序：data.directory[0] / downloadsPath[1]，浏览按钮同序。
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

    // 数据存储位置字段（第一个 directory 字段）的「浏览」按钮
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

  // ===== 命名提供商配置（ai.providerProfiles） =====

  it('should save named provider profile and show it in provider select', async () => {
    mockLoadSuccess();
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));
    clickTab('AI 助手');

    // AI 选项卡字段顺序：提供商名[0] / 模型[1] / API Key(password) / Base URL[2]
    const providerName = container.querySelector<HTMLInputElement>('input[placeholder*="配置名"]');
    const apiKeyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    );
    const model = textInputs[1];
    const baseUrl = textInputs[2];
    expect(providerName).not.toBeNull();
    expect(apiKeyInput).not.toBeNull();
    expect(model).toBeDefined();
    expect(baseUrl).toBeDefined();

    fireEvent.change(providerName!, { target: { value: '公司 OpenAI' } });
    fireEvent.change(model!, { target: { value: 'gpt-4o' } });
    fireEvent.change(apiKeyInput!, { target: { value: 'sk-test' } });
    fireEvent.change(baseUrl!, { target: { value: 'https://api.openai.com/v1' } });

    // 点击「保存配置」
    fireEvent.click(screen.getByText('保存配置'));
    // 立即显示「已保存配置」提示（后续会被自动保存的「已保存」覆盖）
    expect(await screen.findByText(/已保存配置/)).toBeTruthy();

    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'ai.providerProfiles',
      value: expect.arrayContaining([
        expect.objectContaining({ name: '公司 OpenAI', model: 'gpt-4o', apiKey: 'sk-test' }),
      ]) as readonly unknown[],
    });
  });

  it('should load profile config when selected in provider select', async () => {
    const profile = {
      id: 'profile-abc',
      name: '公司 OpenAI',
      model: 'gpt-4o',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com/v1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings.getAll') {
        return Promise.resolve({
          entries: [
            { key: 'language', value: 'zh-CN' },
            { key: 'summary.model', value: 'gpt-4o-mini' },
            { key: 'summary.apiKey', value: 'sk-old' },
            { key: 'summary.baseUrl', value: '' },
            { key: 'ai.providerProfiles', value: [profile] },
          ],
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));
    clickTab('AI 助手');

    // 收起态按钮空白（未选中任何配置）
    const trigger = screen.getByRole('button', { name: '选择默认 Provider' });
    expect(trigger.textContent).toBe('');

    // 展开下拉，点击配置名 → 自动回填模型 / Key / URL
    fireEvent.click(trigger);
    const option = screen.getByRole('button', { name: '公司 OpenAI' });
    fireEvent.click(option);

    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'summary.providerId',
      value: profile.id,
    });
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'summary.model',
      value: 'gpt-4o',
    });
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'summary.apiKey',
      value: 'sk-secret',
    });
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'summary.baseUrl',
      value: 'https://api.openai.com/v1',
    });
    // 选中后收起，按钮显示配置名
    expect(screen.getByRole('button', { name: '选择默认 Provider' }).textContent).toBe(
      '公司 OpenAI',
    );
  });

  it('should delete named profile via option item x button', async () => {
    const profile = {
      id: 'profile-abc',
      name: '公司 OpenAI',
      model: 'gpt-4o',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com/v1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings.getAll') {
        return Promise.resolve({
          entries: [
            { key: 'language', value: 'zh-CN' },
            { key: 'summary.providerId', value: 'profile-abc' },
            { key: 'ai.providerProfiles', value: [profile] },
          ],
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText('通用').length).toBeGreaterThan(0));
    clickTab('AI 助手');

    // 收起态按钮显示当前选中的配置名
    const trigger = screen.getByRole('button', { name: '选择默认 Provider' });
    expect(trigger.textContent).toBe('公司 OpenAI');

    // 展开下拉，点击配置项内的 × 删除
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '删除配置 公司 OpenAI' }));

    await waitForDebouncedSave();
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'ai.providerProfiles',
      value: [],
    });
    // 被删配置正被选中 → 默认 Provider 复位为空白
    expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
      key: 'summary.providerId',
      value: '',
    });
    // 下拉仍展开（删除不关闭），列表已空，显示空态
    expect(screen.getByText('暂无已保存配置')).toBeTruthy();
  });
});

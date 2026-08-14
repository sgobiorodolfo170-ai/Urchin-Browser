/**
 * pi 设置对话框组件单元测试
 *
 * 覆盖：
 * 1. open=false 渲染 null
 * 2. open=true 并行加载 pi.providers + settings.getAll 并回填
 * 3. 加载失败 toast 提示
 * 4. 保存成功（批量 settings.set + 事件广播 + toast + 延迟关闭）
 * 5. 保存失败 toast
 * 6. 切换自定义 provider（isCustom 分支：必填校验 / 常见端点按钮 / Ollama 快捷）
 * 7. 切换内置 provider 自动填充 baseUrl
 * 8. API Key 显示/隐藏切换
 * 9. 取消 / 关闭按钮 onClose
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PiSettingsDialog } from '../../src/renderer/omnibox/pi-settings-dialog';

const mockInvoke = vi.fn();
const onClose = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  onClose.mockReset();
  mockInvoke.mockResolvedValue({});
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

/** 默认加载成功 mock：2 个 pi 内置 provider + 已保存的 ai.* 设置 */
function mockLoadSuccess() {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'pi.providers') {
      return Promise.resolve({
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyEnvVar: 'OPENAI_API_KEY',
          },
          { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
        ],
        generatedAt: 123,
      });
    }
    if (channel === 'settings.getAll') {
      return Promise.resolve({
        entries: [
          { key: 'ai.providerId', value: 'openai' },
          { key: 'ai.apiKey', value: 'sk-test-123' },
          { key: 'ai.baseUrl', value: '' },
          { key: 'ai.model', value: 'gpt-4o-mini' },
        ],
      });
    }
    if (channel === 'settings.set') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
}

describe('PiSettingsDialog', () => {
  it('should render nothing when open=false', () => {
    render(<PiSettingsDialog open={false} onClose={onClose} />);
    expect(screen.queryByText('pi 设置')).toBeNull();
  });

  it('should load providers and settings when opened, and reflect saved values', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);

    expect(mockInvoke).toHaveBeenCalledWith('pi.providers', {});
    expect(mockInvoke).toHaveBeenCalledWith('settings.getAll', {});

    // provider select 回填 ai.providerId=openai
    await waitFor(() => {
      const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
      expect(select.value).toBe('openai');
    });
    // 内置 provider 选项渲染
    expect(screen.getByText('OpenAI（openai）')).toBeTruthy();
    expect(screen.getByText('Anthropic（anthropic）')).toBeTruthy();
    // apiKey / model 回填
    expect(screen.getByPlaceholderText<HTMLInputElement>(/OPENAI_API_KEY/).value).toBe(
      'sk-test-123',
    );
    // 内置 provider 显示推荐环境变量
    expect(screen.getByText('OPENAI_API_KEY')).toBeTruthy();
    // 保存按钮可用
    expect(screen.getByText<HTMLButtonElement>('保存').disabled).toBe(false);
  });

  it('should show error toast when loading fails', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'pi.providers') return Promise.reject(new Error('network down'));
      return Promise.resolve({});
    });
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
  });

  it('should save settings and dispatch changed event, then close after delay', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    const changedSpy = vi.fn();
    window.addEventListener('urchin:settings-changed', changedSpy as EventListener);

    fireEvent.click(screen.getByText<HTMLButtonElement>('保存'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
        key: 'ai.providerId',
        value: 'openai',
      });
      expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
        key: 'ai.apiKey',
        value: 'sk-test-123',
      });
      expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'ai.baseUrl', value: '' });
      expect(mockInvoke).toHaveBeenCalledWith('settings.set', {
        key: 'ai.model',
        value: 'gpt-4o-mini',
      });
    });

    // 事件广播含 4 个 keys
    const detail = changedSpy.mock.calls[0]?.[0] as CustomEvent<{ keys: string[] }>;
    expect(detail.detail.keys).toEqual(['ai.providerId', 'ai.apiKey', 'ai.baseUrl', 'ai.model']);

    // toast 已保存
    expect(screen.getByText('已保存')).toBeTruthy();
    // 600ms 后自动关闭
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    window.removeEventListener('urchin:settings-changed', changedSpy as EventListener);
  });

  it('should show error toast when save fails', async () => {
    mockLoadSuccess();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings.set') return Promise.reject(new Error('db error'));
      return Promise.resolve({});
    });
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    fireEvent.click(screen.getByText<HTMLButtonElement>('保存'));
    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeTruthy());
    // 保存失败不关闭
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should toggle custom provider mode with validation and endpoint shortcuts', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    // 切换到自定义 provider
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom-openai-compatible' } });

    // isCustom 分支 UI：使用说明 + 常见端点 + 必填标记
    expect(screen.getByText('使用说明')).toBeTruthy();
    expect(screen.getAllByText(/本地模型/).length).toBeGreaterThan(0);
    expect(screen.getByText<HTMLButtonElement>('保存').disabled).toBe(true);

    // 点击常见端点按钮填充 baseUrl（api.deepseek.com）
    fireEvent.click(screen.getByText('api.deepseek.com'));
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toContain('deepseek');

    // 点击 Ollama 快捷填充
    fireEvent.click(screen.getByText('Ollama'));
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe(
      'http://localhost:11434/v1',
    );

    // 填入 model 后保存可用
    const modelInput = screen.getByPlaceholderText<HTMLInputElement>(
      /gpt-4o-mini \/ deepseek-chat/,
    );
    fireEvent.change(modelInput, { target: { value: 'deepseek-chat' } });
    expect(screen.getByText<HTMLButtonElement>('保存').disabled).toBe(false);
  });

  it('should auto-fill baseUrl when switching to a builtin provider with default', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    // 先切到自定义（清空 baseUrl 场景），再切回内置 anthropic
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom-openai-compatible' } });
    fireEvent.change(select, { target: { value: 'anthropic' } });

    // anthropic 默认 baseUrl 自动填充
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('should toggle api key visibility', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    const keyInput = screen.getByPlaceholderText<HTMLInputElement>(/OPENAI_API_KEY/);
    expect(keyInput.type).toBe('password');

    fireEvent.click(screen.getByLabelText('显示 API Key'));
    expect(screen.getByPlaceholderText<HTMLInputElement>(/OPENAI_API_KEY/).type).toBe('text');

    fireEvent.click(screen.getByLabelText('隐藏 API Key'));
    expect(screen.getByPlaceholderText<HTMLInputElement>(/OPENAI_API_KEY/).type).toBe('password');
  });

  it('should close via cancel and close buttons', async () => {
    mockLoadSuccess();
    render(<PiSettingsDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('pi 设置')).toBeTruthy());

    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

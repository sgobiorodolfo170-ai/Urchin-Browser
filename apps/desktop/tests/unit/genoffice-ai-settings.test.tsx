/**
 * GenOffice 原生 AI 设置组件（renderer/settings/GenOfficeAiSettings.tsx）单元测试
 *
 * 覆盖（阶段 3 SettingsModal 移植）：
 * 1. 加载 AI 目录 + 设置后渲染服务商/模型/密钥字段
 * 2. 目录通道失败 → 显示不可用提示（不崩溃）
 * 3. 修改密钥后保存 → ai:set-settings 收到含密钥的完整设置
 * 4. 测试连接 → ai:chat（连通性探测）并展示结果
 * 5. 媒体与搜索卡片渲染（图像/图片分析/视频分析/联网搜索四块）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GenOfficeAiSettings } from '../../src/renderer/settings/GenOfficeAiSettings';

const mockInvoke = vi.fn();

const CATALOGS = {
  providers: [
    {
      id: 'anthropic',
      label: 'Claude',
      models: ['claude-sonnet-5', 'claude-haiku-5'],
      defaultModel: 'claude-sonnet-5',
      keyPlaceholder: 'sk-ant-...',
      defaultBaseUrl: '',
    },
    {
      id: 'genspark',
      label: 'Genspark',
      models: ['claude-sonnet-5'],
      defaultModel: 'claude-sonnet-5',
      keyPlaceholder: '',
      defaultBaseUrl: '',
    },
  ],
  mediaProviders: [
    {
      id: 'openai',
      label: 'OpenAI',
      keyPlaceholder: 'sk-...',
      defaultBaseUrl: 'https://api.openai.com/v1',
      imageProtocol: 'openai-images',
      imageModels: ['gpt-image-2'],
      defaultImageModel: 'gpt-image-2',
      analysisProtocol: 'openai-chat',
      analysisModels: ['gpt-5.6-luna'],
      defaultAnalysisModel: 'gpt-5.6-luna',
    },
    {
      id: 'genspark',
      label: 'Genspark',
      imageProtocol: 'openai-images',
      imageModels: [],
      defaultImageModel: '',
      analysisProtocol: 'openai-chat',
      analysisModels: [],
      defaultAnalysisModel: '',
    },
  ],
  searchProviders: [
    { id: 'serper', label: 'Serper', keyPlaceholder: 'API Key' },
    { id: 'tavily', label: 'Tavily', keyPlaceholder: 'tvly-...' },
  ],
};

function makeSettings() {
  return {
    provider: 'anthropic',
    providers: {
      anthropic: { apiKey: '', model: 'claude-sonnet-5' },
      genspark: { apiKey: '', model: 'claude-sonnet-5' },
    },
    media: {
      imageProvider: 'openai',
      analysisProvider: 'openai',
      videoAnalysisProvider: 'openai',
      providers: {
        openai: { apiKey: '', imageModel: 'gpt-image-2', analysisModel: 'gpt-5.6-luna' },
      },
    },
    search: { provider: 'serper', providers: { serper: { apiKey: '' }, tavily: { apiKey: '' } } },
    gskToolsEnabled: true,
    maxOutputTokens: 32768,
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchinGenoffice', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GenOfficeAiSettings', () => {
  it('should render provider/model/key fields after loading catalogs and settings', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'genoffice:ai-catalogs') return Promise.resolve(CATALOGS);
      if (channel === 'ai:get-settings') return Promise.resolve(makeSettings());
      return Promise.resolve({});
    });

    render(<GenOfficeAiSettings />);

    expect(await screen.findByLabelText('服务商')).toBeInTheDocument();
    expect(screen.getByLabelText('模型')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    // 媒体与搜索卡片四块
    expect(screen.getByText('图像生成')).toBeInTheDocument();
    expect(screen.getByText('图片分析')).toBeInTheDocument();
    expect(screen.getByText('视频分析')).toBeInTheDocument();
    expect(screen.getByText('联网搜索')).toBeInTheDocument();
  });

  it('should show an unavailable note when the catalogs channel fails', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'genoffice:ai-catalogs') return Promise.reject(new Error('产物缺失'));
      return Promise.resolve({});
    });

    render(<GenOfficeAiSettings />);

    expect(await screen.findByText('GenOffice AI 不可用')).toBeInTheDocument();
    expect(screen.getByText('产物缺失')).toBeInTheDocument();
  });

  it('should save settings with the edited API key', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'genoffice:ai-catalogs') return Promise.resolve(CATALOGS);
      if (channel === 'ai:get-settings') return Promise.resolve(makeSettings());
      return Promise.resolve({});
    });

    render(<GenOfficeAiSettings />);
    const keyInput = await screen.findByLabelText('API Key');
    fireEvent.change(keyInput, { target: { value: 'sk-ant-test' } });

    const saveButtons = screen.getAllByRole('button', { name: '保存' });
    fireEvent.click(saveButtons[0]!);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai:set-settings', expect.anything());
    });
    const calls = mockInvoke.mock.calls as unknown as [string, unknown][];
    const saved = calls.find((c) => c[0] === 'ai:set-settings')?.[1] as {
      provider: string;
      providers: Record<string, { apiKey: string }>;
    };
    expect(saved.provider).toBe('anthropic');
    expect(saved.providers.anthropic?.apiKey).toBe('sk-ant-test');
  });

  it('should test the connection through ai:chat and report the result', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'genoffice:ai-catalogs') return Promise.resolve(CATALOGS);
      if (channel === 'ai:get-settings') return Promise.resolve(makeSettings());
      if (channel === 'ai:chat') return Promise.resolve({ ok: true, content: 'OK' });
      return Promise.resolve({});
    });

    render(<GenOfficeAiSettings />);
    await screen.findByLabelText('API Key');
    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[0]!);

    expect(await screen.findByText('连接正常')).toBeInTheDocument();
    const calls = mockInvoke.mock.calls as unknown as [string, unknown][];
    const chat = calls.find((c) => c[0] === 'ai:chat')?.[1] as { system: string };
    expect(chat.system).toContain('connectivity test');
  });
});

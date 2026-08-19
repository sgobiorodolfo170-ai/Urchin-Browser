/**
 * 设置页「默认应用」选项卡（FilesTab）组件测试
 *
 * 覆盖：
 * 1. 挂载后调用 file-association.getStatus，渲染三组卡片（音视频/文档/图片）
 * 2. 显示每组注册状态（已关联 n/m）与扩展名清单
 * 3. 点击「设为默认打开方式」→ file-association.register 调用 + toast 提示 + 状态刷新
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/settings/SettingsPage';

const mockInvoke = vi.fn();

function mockSettingsLoad(): void {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'settings.getAll') {
      return Promise.resolve({ entries: [{ key: 'language', value: 'zh-CN' }] });
    }
    if (channel === 'provider.rescan') return Promise.resolve({ ok: true });
    if (channel === 'provider.list') return Promise.resolve({ providers: [] });
    if (channel === 'file-association.getStatus') {
      return Promise.resolve({
        groups: {
          media: { registered: 0, total: 18, extensions: ['mp3', 'mp4', 'wav'] },
          documents: { registered: 3, total: 20, extensions: ['pdf', 'md', 'json'] },
          images: { registered: 0, total: 9, extensions: ['png', 'jpg', 'svg'] },
        },
      });
    }
    if (channel === 'file-association.register') {
      return Promise.resolve({ ok: true, count: 18 });
    }
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke, platform: 'win32', versions: { electron: '32.0.0' } },
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

async function renderAndOpenFilesTab(): Promise<void> {
  mockSettingsLoad();
  render(<SettingsPage />);
  await waitFor(() => {
    fireEvent.click(screen.getByText('默认应用'));
  });
}

describe('FilesTab (默认应用)', () => {
  it('should render three group cards with status', async () => {
    await renderAndOpenFilesTab();

    await waitFor(() => {
      expect(screen.getByText('音视频')).toBeDefined();
      expect(screen.getByText('文档')).toBeDefined();
      expect(screen.getByText('图片')).toBeDefined();
      expect(screen.getByText('0/18 已关联')).toBeDefined();
      expect(screen.getByText('3/20 已关联')).toBeDefined();
    });
    // 扩展名清单渲染（.ext 前缀）
    await waitFor(() => {
      expect(screen.getByText(/\.mp3 \.mp4 \.wav/)).toBeDefined();
    });
  });

  it('should call register on button click and refresh status', async () => {
    await renderAndOpenFilesTab();

    await waitFor(() => {
      fireEvent.click(screen.getAllByText('设为默认打开方式')[0]!);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.register', { group: 'media' });
    });
    // toast 提示（注册后可去系统打开方式选择）
    await waitFor(() => {
      expect(screen.getByText(/已注册/)).toBeDefined();
    });
    // 刷新状态：getStatus 再次被调用
    const statusCalls = mockInvoke.mock.calls.filter(([c]) => c === 'file-association.getStatus');
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should show error toast when register fails', async () => {
    mockSettingsLoad();
    // 覆盖 register 为失败，其余分支走完整 mock（settings.getAll 等正常返回）
    const baseImpl = mockInvoke.getMockImplementation();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file-association.register') {
        return Promise.reject(new Error('Access denied'));
      }
      // baseImpl 返回 any，显式转为 Promise<unknown> 避免 unsafe 规则
      const r: unknown = baseImpl ? baseImpl(channel) : Promise.resolve({});
      return r as Promise<unknown>;
    });
    render(<SettingsPage />);
    await waitFor(() => {
      fireEvent.click(screen.getByText('默认应用'));
    });

    await waitFor(() => {
      fireEvent.click(screen.getAllByText('设为默认打开方式')[0]!);
    });

    await waitFor(() => {
      expect(screen.getByText(/注册失败/)).toBeDefined();
    });
  });
});

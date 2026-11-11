/**
 * 设置页「默认应用」选项卡（FilesTab）组件测试
 *
 * 覆盖：
 * 1. 挂载后调用 file-association.getStatus，渲染三组卡片（音视频/文档/图片）
 * 2. 三态登记徽标（未登记 / 部分登记 n/m / 已登记 n/m）
 * 3. 登记目标提示：dev 实例 / 指向旧位置 → 警示；提供「打开系统默认应用」
 * 4. 「设为默认打开方式」→ register 调用 + toast + 状态刷新；失败 → 错误 toast
 * 5. 「清除本应用关联」→ ConfirmDialog 确认 → unregister 调用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/settings/SettingsPage';

const mockInvoke = vi.fn();

interface StatusOverride {
  mediaRegistered?: number;
  mediaTotal?: number;
  documentsRegistered?: number;
  documentsTotal?: number;
  exePath?: string;
  devMode?: boolean;
  appRegistered?: boolean;
  exeMatches?: boolean;
}

function mockSettingsLoad(override: StatusOverride = {}): void {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'settings.getAll') {
      return Promise.resolve({ entries: [{ key: 'language', value: 'zh-CN' }] });
    }
    if (channel === 'provider.rescan') return Promise.resolve({ ok: true });
    if (channel === 'provider.list') return Promise.resolve({ providers: [] });
    if (channel === 'file-association.getStatus') {
      return Promise.resolve({
        groups: {
          media: {
            registered: override.mediaRegistered ?? 0,
            total: override.mediaTotal ?? 8,
            extensions: ['mp3', 'mp4', 'wav'],
          },
          documents: {
            registered: override.documentsRegistered ?? 3,
            total: override.documentsTotal ?? 20,
            extensions: ['pdf', 'md', 'json'],
          },
          images: { registered: 0, total: 9, extensions: ['png', 'jpg', 'svg'] },
        },
        exePath: override.exePath ?? 'C:\\apps\\urchin.exe',
        devMode: override.devMode ?? false,
        appRegistered: override.appRegistered ?? true,
        exeMatches: override.exeMatches ?? true,
      });
    }
    if (channel === 'file-association.register') {
      return Promise.resolve({ ok: true, count: 3 });
    }
    if (channel === 'file-association.unregister') {
      return Promise.resolve({ ok: true, removed: 6, attempted: 7 });
    }
    if (channel === 'file-association.openSettings') {
      return Promise.resolve({ ok: true });
    }
    if (channel === 'file-association.setDefaultBrowser') {
      return Promise.resolve({ ok: true, openedSettings: true });
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

async function renderAndOpenFilesTab(override: StatusOverride = {}): Promise<void> {
  mockSettingsLoad(override);
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
      // 三态徽标：0 → 未登记；部分 → 部分登记 n/m
      expect(screen.getAllByText('未登记')).toHaveLength(2); // media + images
      expect(screen.getByText('部分登记 3/20')).toBeDefined();
    });
    // 扩展名清单渲染（每个扩展名一个复选框）
    await waitFor(() => {
      expect(screen.getByText('.mp3')).toBeDefined();
      expect(screen.getByText('.mp4')).toBeDefined();
      expect(screen.getByText('.wav')).toBeDefined();
    });
  });

  it('should show 已登记 when every extension is registered', async () => {
    await renderAndOpenFilesTab({ mediaRegistered: 8, mediaTotal: 8 });

    await waitFor(() => {
      expect(screen.getByText('已登记 8/8')).toBeDefined();
    });
  });

  it('should surface the registration target path', async () => {
    await renderAndOpenFilesTab({ exePath: 'C:\\Program Files\\Urchin\\UrchinBrowser.exe' });

    await waitFor(() => {
      expect(screen.getByText('C:\\Program Files\\Urchin\\UrchinBrowser.exe')).toBeDefined();
    });
  });

  it('should warn when running the dev (unpackaged) binary', async () => {
    await renderAndOpenFilesTab({ devMode: true });

    await waitFor(() => {
      expect(screen.getByText(/当前是开发实例（未打包）/)).toBeDefined();
    });
  });

  it('should warn when registration points at a stale exe', async () => {
    await renderAndOpenFilesTab({ exeMatches: false });

    await waitFor(() => {
      expect(screen.getByText(/未检测到本应用的有效登记/)).toBeDefined();
    });
  });

  it('should open system default apps page without registering', async () => {
    await renderAndOpenFilesTab();

    const button = await screen.findByRole('button', { name: '打开系统默认应用' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.openSettings', {});
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'file-association.setDefaultBrowser',
      expect.anything(),
    );
  });

  it('should render default browser row and open system default apps', async () => {
    await renderAndOpenFilesTab();

    const button = await screen.findByRole('button', { name: '设为默认浏览器' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.setDefaultBrowser', {});
    });
    await waitFor(() => {
      expect(screen.getByText(/已登记默认浏览器/)).toBeDefined();
    });
  });

  it('should register all checked extensions by default', async () => {
    await renderAndOpenFilesTab();

    await waitFor(() => {
      fireEvent.click(screen.getAllByText(/设为默认打开方式/)[0]!);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.register', {
        group: 'media',
        extensions: ['mp3', 'mp4', 'wav'],
      });
    });
    // toast 提示（登记后可去系统打开方式选择）
    await waitFor(() => {
      expect(screen.getByText(/已登记 3 种格式/)).toBeDefined();
    });
    // 刷新状态：getStatus 再次被调用
    const statusCalls = mockInvoke.mock.calls.filter(([c]) => c === 'file-association.getStatus');
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should only register unchecked-out extensions', async () => {
    await renderAndOpenFilesTab();

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);

    await waitFor(() => {
      fireEvent.click(screen.getAllByText(/设为默认打开方式/)[0]!);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.register', {
        group: 'media',
        extensions: ['mp4', 'wav'],
      });
    });
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
      fireEvent.click(screen.getAllByText(/设为默认打开方式/)[0]!);
    });

    await waitFor(() => {
      expect(screen.getByText(/注册失败/)).toBeDefined();
    });
  });

  it('should clear this app associations after confirmation', async () => {
    await renderAndOpenFilesTab({ documentsRegistered: 3, documentsTotal: 20 });

    // 只有已登记的分组才有「清除本应用关联」
    const clearButtons = await screen.findAllByRole('button', { name: '清除本应用关联' });
    expect(clearButtons.length).toBeGreaterThan(0);
    fireEvent.click(clearButtons[0]!);

    // 确认弹窗
    await waitFor(() => {
      expect(screen.getByText(/清除「.*」的本应用关联？/)).toBeDefined();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('file-association.unregister', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: '清除' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('file-association.unregister', {
        scope: 'extensions',
        group: 'documents',
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/已清除本应用的 6 项登记/)).toBeDefined();
    });
  });

  it('should not offer clearing when the group is not registered at all', async () => {
    await renderAndOpenFilesTab();

    // media / images 均 0 → 只有 documents（3/20）一个清除按钮
    const clearButtons = screen.queryAllByRole('button', { name: '清除本应用关联' });
    expect(clearButtons).toHaveLength(1);
  });
});

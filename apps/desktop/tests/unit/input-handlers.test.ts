/**
 * M12 AI 输入 · input-handlers 单元测试
 *
 * 验证 registerAiInputHandlers 三个 IPC handler：
 * 1. ai.screenshot：截取主屏幕 → 解析 data URL 返回 base64
 * 2. ai.screenshot：无屏幕源 / 数据格式异常 → 抛错
 * 3. ai.uploadFile：选择文件 → 读取内容 + magic-byte MIME 嗅探
 * 4. ai.uploadFile：取消 → 空数组
 * 5. ai.setWorkdir：选择目录 → 读取条目数
 * 6. ai.setWorkdir：取消 / 目录不可读
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock electron：desktopCapturer / dialog / BrowserWindow ──
const mocks = vi.hoisted(() => ({
  desktopCapturerGetSources: vi.fn(),
  dialogShowOpenDialog: vi.fn(),
  getAllWindows: vi.fn(),
  registerHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {},
  desktopCapturer: { getSources: mocks.desktopCapturerGetSources },
  dialog: { showOpenDialog: mocks.dialogShowOpenDialog },
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));

vi.mock('@urchin/ipc-contract', () => ({
  registerHandler: mocks.registerHandler,
}));

// ── mock fs ──
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: fsMocks.readFile,
  stat: fsMocks.stat,
  readdir: fsMocks.readdir,
  default: {
    readFile: fsMocks.readFile,
    stat: fsMocks.stat,
    readdir: fsMocks.readdir,
  },
}));

import { registerAiInputHandlers } from '../../src/main/ai/input-handlers';

/** 从 registerHandler mock 中取出 handler 并调用 */
function invokeHandler(channel: string, req: unknown, ctx?: { sender: unknown }): Promise<unknown> {
  const calls = mocks.registerHandler.mock.calls as unknown[][];
  const call = calls.find((c) => c[1] === channel);
  if (!call) throw new Error(`no registered handler for ${channel}`);
  const handler = call[2] as (req: unknown, ctx: unknown) => Promise<unknown>;
  return handler(req, ctx ?? { sender: null });
}

describe('registerAiInputHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllWindows.mockReturnValue([{ isFocused: () => true }]);
    mocks.desktopCapturerGetSources.mockResolvedValue([
      {
        display_id: 'display-1',
        thumbnail: {
          toDataURL: () =>
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        } as never,
      },
    ]);
  });

  it('should register ai.screenshot / ai.uploadFile / ai.setWorkdir handlers', () => {
    registerAiInputHandlers({} as never);
    expect(mocks.registerHandler).toHaveBeenCalledTimes(3);
    const channels = mocks.registerHandler.mock.calls.map((c) => c[1] as string);
    expect(channels).toContain('ai.screenshot');
    expect(channels).toContain('ai.uploadFile');
    expect(channels).toContain('ai.setWorkdir');
  });

  it('ai.screenshot should capture primary screen and return base64', async () => {
    registerAiInputHandlers({} as never);
    const result = (await invokeHandler('ai.screenshot', {})) as {
      dataUri: string;
      mimeType: string;
      base64: string;
      displayId: string;
    };

    expect(mocks.desktopCapturerGetSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.base64.length).toBeGreaterThan(0);
    expect(result.displayId).toBe('display-1');
  });

  it('ai.screenshot should throw when no screen sources', async () => {
    mocks.desktopCapturerGetSources.mockResolvedValue([]);
    registerAiInputHandlers({} as never);

    await expect(invokeHandler('ai.screenshot', {})).rejects.toThrow('未找到可用的屏幕源');
  });

  it('ai.screenshot should throw when data URL malformed', async () => {
    mocks.desktopCapturerGetSources.mockResolvedValue([
      { display_id: 'd1', thumbnail: { toDataURL: () => 'not-a-data-url' } as never },
    ]);
    registerAiInputHandlers({} as never);

    await expect(invokeHandler('ai.screenshot', {})).rejects.toThrow('截图数据格式异常');
  });

  it('ai.uploadFile should read file and detect png mime', async () => {
    // PNG magic bytes
    fsMocks.readFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    fsMocks.stat.mockResolvedValue({ size: 1024 });
    mocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\pics\\shot.png'],
    });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.uploadFile', {
      filters: [],
      multiple: false,
      title: '选择图片',
    })) as { files: { name: string; mimeType: string; isImage: boolean; size: number }[] };

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe('shot.png');
    expect(result.files[0]!.mimeType).toBe('image/png');
    expect(result.files[0]!.isImage).toBe(true);
    expect(result.files[0]!.size).toBe(1024);
    expect(mocks.dialogShowOpenDialog).toHaveBeenCalled();
  });

  it('ai.uploadFile should return empty when canceled', async () => {
    mocks.dialogShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.uploadFile', {
      filters: ['png'],
      multiple: false,
    })) as { files: unknown[] };

    expect(result.files).toHaveLength(0);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('ai.uploadFile should fall back to octet-stream for unknown magic', async () => {
    fsMocks.readFile.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    fsMocks.stat.mockResolvedValue({ size: 4 });
    mocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\docs\\notes.md'],
    });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.uploadFile', {
      filters: [],
      multiple: false,
    })) as { files: { mimeType: string; isImage: boolean }[] };

    expect(result.files[0]!.mimeType).toBe('application/octet-stream');
    expect(result.files[0]!.isImage).toBe(false);
  });

  it('ai.setWorkdir should return entry count', async () => {
    fsMocks.readdir.mockResolvedValue(['a.txt', 'b.txt']);
    mocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\workdir'],
    });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.setWorkdir', {})) as {
      path: string;
      exists: boolean;
      entryCount: number;
    };

    expect(result.path).toBe('C:\\workdir');
    expect(result.exists).toBe(true);
    expect(result.entryCount).toBe(2);
  });

  it('ai.setWorkdir should return null when canceled', async () => {
    mocks.dialogShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.setWorkdir', {})) as {
      path: unknown;
      exists: boolean;
    };

    expect(result.path).toBeNull();
    expect(result.exists).toBe(false);
  });

  it('ai.setWorkdir should handle unreadable directory', async () => {
    fsMocks.readdir.mockRejectedValue(new Error('EACCES'));
    mocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\locked'],
    });
    registerAiInputHandlers({} as never);

    const result = (await invokeHandler('ai.setWorkdir', {})) as {
      path: string;
      exists: boolean;
    };

    expect(result.path).toBe('C:\\locked');
    expect(result.exists).toBe(false);
  });
});

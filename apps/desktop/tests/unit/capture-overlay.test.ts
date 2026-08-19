/**
 * 框选截图 · CaptureOverlay 单元测试
 *
 * 验证：
 * 1. start 截主屏并创建透明置顶覆盖窗口（配置断言）
 * 2. 已打开时不重复创建
 * 3. getImageData 返回截图 data URI
 * 4. confirm 裁剪保存 PNG 到 <数据目录>/screenshots/ 并关闭窗口
 * 5. cancel / 窗口 closed 事件清缓存
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureOverlay } from '../../src/main/screenshots/capture-overlay';

// ── Mock Electron ──────────────────────────────────────────────────────────

/** Mock NativeImage：记录 crop 调用，返回可序列化的伪 PNG */
class MockNativeImage {
  isEmpty() {
    return false;
  }
  crop(rect: unknown) {
    this.lastCrop = rect;
    return this;
  }
  toPNG() {
    return Buffer.from('fake-png-bytes');
  }
  toDataURL() {
    return 'data:image/png;base64,ZmFrZQ==';
  }
  lastCrop: unknown = null;
}

/** Mock 窗口：记录构造 opts / 加载 URL / 销毁，触发 closed 回调 */
class MockWindow {
  closedHandlers: (() => void)[] = [];
  blurHandlers: (() => void)[] = [];
  readyToShowHandler: (() => void) | null = null;
  beforeInputHandler: ((input: { key: string; type: string }) => void) | null = null;
  destroyed = false;
  visible = false;
  loadedUrl = '';
  constructor(readonly opts: Record<string, unknown>) {}
  on(event: string, handler: () => void) {
    if (event === 'closed') this.closedHandlers.push(handler);
    if (event === 'blur') this.blurHandlers.push(handler);
    if (event === 'ready-to-show') this.readyToShowHandler = handler;
  }
  once(event: string, handler: () => void) {
    this.on(event, handler);
  }
  webContents = {
    on: (
      event: string,
      handler: (_event: unknown, input: { key: string; type: string }) => void,
    ) => {
      if (event === 'before-input-event') {
        // 真实签名 (event, input)：Mock 把 input 作为第二参传给主进程 handler
        this.beforeInputHandler = (input) =>
          handler(undefined, { type: input.type, key: input.key });
      }
    },
  };
  loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
    return Promise.resolve();
  }
  show(): void {
    this.visible = true;
  }
  focus(): void {
    /* noop */
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    for (const h of this.closedHandlers) h();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  /** 模拟真实 Electron：窗口关闭时销毁 + 触发全部 closed 回调 */
  emitClosed() {
    this.destroy();
  }
}

// mock electron 模块（仅暴露 CaptureOverlay 用到的成员）
vi.mock('electron', () => {
  return {
    desktopCapturer: {
      getSources: vi.fn(),
    },
    screen: {
      getPrimaryDisplay: vi.fn(),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
  };
});
import { desktopCapturer, screen, shell } from 'electron';

// ── 测试 ───────────────────────────────────────────────────────────────────

describe('CaptureOverlay', () => {
  let dataDir: string;
  let overlay: CaptureOverlay;
  let lastWindow: MockWindow | null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-overlay-test-'));
    lastWindow = null;
    vi.mocked(desktopCapturer.getSources).mockReset();
    vi.mocked(screen.getPrimaryDisplay).mockReset();
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(screen.getPrimaryDisplay).mockReturnValue({
      size: { width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1.5,
    } as never);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { thumbnail: new MockNativeImage() } as never,
    ]);

    overlay = new CaptureOverlay({
      createWindow: ((opts: Record<string, unknown>) => {
        lastWindow = new MockWindow(opts);
        return lastWindow;
      }) as never,
      preloadPath: '/fake/preload.js',
      dataDir,
    });
  });

  afterEach(() => {
    overlay.cancel();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('start should capture primary screen at physical size and open transparent overlay', async () => {
    const started = await overlay.start();
    expect(started).toBe(true);
    expect(overlay.isOpen).toBe(true);

    // 截屏参数：types=['screen'] + 显示器物理尺寸（原始分辨率）
    expect(desktopCapturer.getSources).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      }),
    );

    // 覆盖窗口：透明 + 置顶 + 无边框 + 全屏 + preload
    expect(lastWindow?.loadedUrl).toBe('urchin://capture-overlay');
    const opts = lastWindow!.opts;
    expect(opts.transparent).toBe(true);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.frame).toBe(false);
    expect(opts.skipTaskbar).toBe(true);
    expect(opts.width).toBe(1920);
    expect(opts.height).toBe(1080);
    const webPrefs = opts.webPreferences as { preload?: string; sandbox?: boolean };
    expect(webPrefs.preload).toBe('/fake/preload.js');
    expect(webPrefs.sandbox).toBe(true);
  });

  it('start should not open twice when already open', async () => {
    await overlay.start();
    const again = await overlay.start();
    expect(again).toBe(false);
    expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
  });

  it('start should show window on ready-to-show (not before)', async () => {
    await overlay.start();
    // ready-to-show 前窗口不可见（等合成器就绪，避免透明窗口黑屏/卡死）
    expect(lastWindow?.visible).toBe(false);
    lastWindow?.readyToShowHandler?.();
    expect(lastWindow?.visible).toBe(true);
  });

  it('blur should close overlay and clear cache', async () => {
    vi.useFakeTimers();
    try {
      await overlay.start();
      lastWindow?.readyToShowHandler?.();
      // 跳过启动窗口期（300ms），blur 才生效
      vi.advanceTimersByTime(300);
      expect(overlay.isOpen).toBe(true);
      lastWindow?.blurHandlers.forEach((h) => h());
      expect(overlay.isOpen).toBe(false);
      expect(() => overlay.getImageData()).toThrow(/not started/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blur within startup window should not close', async () => {
    vi.useFakeTimers();
    try {
      await overlay.start();
      lastWindow?.readyToShowHandler?.();
      // 窗口期内 blur（系统抢焦点竞争）不应误关
      lastWindow?.blurHandlers.forEach((h) => h());
      expect(overlay.isOpen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape via before-input-event should close overlay (main-process fallback)', async () => {
    await overlay.start();
    lastWindow?.beforeInputHandler?.({ type: 'keyDown', key: 'Escape' });
    expect(overlay.isOpen).toBe(false);
    // 非 Esc 按键不应关闭
    await overlay.start();
    lastWindow?.beforeInputHandler?.({ type: 'keyDown', key: 'Enter' });
    expect(overlay.isOpen).toBe(true);
  });

  it('start should throw when no screen source available', async () => {
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);
    await expect(overlay.start()).rejects.toThrow(/No screen/);
  });

  it('getImageData should return screenshot data uri', async () => {
    await overlay.start();
    expect(overlay.getImageData()).toBe('data:image/png;base64,ZmFrZQ==');
  });

  it('confirm should crop, save png under dataDir/screenshots and close overlay', async () => {
    await overlay.start();
    const path = overlay.confirm({ x: 100, y: 200, width: 400, height: 300 });

    expect(path).toContain(join('screenshots'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('fake-png-bytes');
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
    expect(overlay.isOpen).toBe(false);
    // 缓存已清：getImageData 抛错
    expect(() => overlay.getImageData()).toThrow(/not started/i);
  });

  it('cancel should close overlay and clear cache', async () => {
    await overlay.start();
    overlay.cancel();
    expect(overlay.isOpen).toBe(false);
    expect(() => overlay.getImageData()).toThrow(/not started/i);
  });

  it('window closed event should clear state', async () => {
    await overlay.start();
    lastWindow?.emitClosed();
    expect(overlay.isOpen).toBe(false);
    expect(() => overlay.getImageData()).toThrow(/not started/i);
  });

  it('confirm without start should throw', () => {
    expect(() => overlay.confirm({ x: 0, y: 0, width: 10, height: 10 })).toThrow(/not started/i);
  });
});

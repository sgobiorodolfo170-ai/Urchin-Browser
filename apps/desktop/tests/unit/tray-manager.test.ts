/**
 * 系统托盘驻留（tray-manager）单元测试
 *
 * 覆盖：
 * 1. buildTrayMenuTemplate：菜单项顺序与动作绑定（显示主窗口 / 完全退出）
 * 2. shouldHideOnClose：开关 / 托盘可用 / 退出中 / 已被其他守卫接管的四条件真值表
 * 3. 托盘生命周期：设置开启创建、关闭销毁、重复 sync 不重建
 * 4. close 拦截：开启时 hide + preventDefault；关闭/退出中/脏文档已接管时不拦截
 * 5. 图标创建失败（空图标）时禁止隐藏，避免窗口失联
 * 6. 托盘点击/菜单动作唤回窗口；dispose 解绑监听并销毁托盘
 *
 * 设计说明：模块只依赖 BrowserWindowLike 结构化接口与 electron 的
 * Tray/Menu/nativeImage，故测试以最小窗口替身 + mock electron 验证行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindowLike } from '../../src/main/windows/types';

const electronMocks = vi.hoisted(() => {
  interface TrayLike {
    handlers: Map<string, () => void>;
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    icon: unknown;
  }
  const trayInstances: TrayLike[] = [];
  const buildFromTemplate = vi.fn(() => ({ menu: true }));
  const createFromPath = vi.fn<(path: string) => { isEmpty: () => boolean }>(() => ({
    isEmpty: () => false,
  }));
  const appMocks = {
    isPackaged: false,
    getAppPath: vi.fn(() => 'C:\\app'),
    resourcesPath: 'C:\\resources',
  };

  class TrayMock implements TrayLike {
    readonly handlers = new Map<string, () => void>();
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    readonly on = vi.fn((event: string, cb: () => void) => {
      this.handlers.set(event, cb);
    });
    readonly destroy = vi.fn();
    readonly isDestroyed = vi.fn(() => false);

    constructor(readonly icon: unknown) {
      trayInstances.push(this);
    }
  }

  return { trayInstances, TrayMock, buildFromTemplate, createFromPath, appMocks };
});

vi.mock('electron', () => ({
  Tray: electronMocks.TrayMock,
  Menu: { buildFromTemplate: electronMocks.buildFromTemplate },
  nativeImage: { createFromPath: electronMocks.createFromPath },
  app: {
    get isPackaged() {
      return electronMocks.appMocks.isPackaged;
    },
    getAppPath: electronMocks.appMocks.getAppPath,
    get resourcesPath() {
      return electronMocks.appMocks.resourcesPath;
    },
  },
}));

import {
  TrayManager,
  MINIMIZE_TO_TRAY_KEY,
  buildTrayMenuTemplate,
  shouldHideOnClose,
} from '../../src/main/tray/tray-manager';

/** close 事件替身（记录是否被 preventDefault）。 */
function makeCloseEvent(alreadyPrevented = false) {
  const event = {
    defaultPrevented: alreadyPrevented,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event;
}

/** 最小窗口替身：记录 close 监听、可见/最小化状态与调用记录。 */
class FakeWindow {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  visible = true;
  minimized = false;
  destroyed = false;
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  readonly restore = vi.fn(() => {
    this.minimized = false;
  });
  readonly focus = vi.fn();

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** 触发 close 并返回事件对象 */
  emitClose(event = makeCloseEvent()) {
    for (const handler of this.handlers.get('close') ?? []) handler(event);
    return event;
  }
}

function asWindow(win: FakeWindow): BrowserWindowLike {
  return win as unknown as BrowserWindowLike;
}

function makeManager(overrides: Partial<{ setting: unknown; windows: FakeWindow[] }> = {}) {
  const windows = overrides.windows ?? [new FakeWindow()];
  let setting: unknown = overrides.setting ?? false;
  const quit = vi.fn();
  const manager = new TrayManager({
    getSetting: (key) => (key === MINIMIZE_TO_TRAY_KEY ? setting : undefined),
    getWindows: () => windows.map(asWindow),
    quit,
    appName: '顽童浏览器',
  });
  return {
    manager,
    windows,
    quit,
    setSetting: (value: unknown) => {
      setting = value;
    },
  };
}

beforeEach(() => {
  electronMocks.trayInstances.length = 0;
  vi.clearAllMocks();
});

describe('buildTrayMenuTemplate', () => {
  it('should expose show-main-window and quit actions with a separator between them', () => {
    const showMainWindow = vi.fn();
    const quit = vi.fn();

    const template = buildTrayMenuTemplate({ showMainWindow, quit });

    expect(template).toHaveLength(3);
    expect(template[0]).toMatchObject({ label: '显示主窗口' });
    expect(template[1]).toMatchObject({ type: 'separator' });
    expect(template[2]).toMatchObject({ label: '完全退出' });

    template[0]?.click?.();
    template[2]?.click?.();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('shouldHideOnClose', () => {
  const base = {
    enabled: true,
    trayAvailable: true,
    quitting: false,
    defaultPrevented: false,
  };

  it('should hide only when every condition is satisfied', () => {
    expect(shouldHideOnClose(base)).toBe(true);
  });

  it('should not hide when the setting is disabled', () => {
    expect(shouldHideOnClose({ ...base, enabled: false })).toBe(false);
  });

  it('should not hide when the tray is unavailable', () => {
    expect(shouldHideOnClose({ ...base, trayAvailable: false })).toBe(false);
  });

  it('should not hide while the app is quitting', () => {
    expect(shouldHideOnClose({ ...base, quitting: true })).toBe(false);
  });

  it('should not hide when another guard already prevented the close', () => {
    expect(shouldHideOnClose({ ...base, defaultPrevented: true })).toBe(false);
  });
});

describe('TrayManager', () => {
  it('should create the tray only after the setting is enabled', () => {
    const { manager } = makeManager({ setting: false });

    manager.syncWithSetting();
    expect(electronMocks.trayInstances).toHaveLength(0);
    expect(manager.isEnabled()).toBe(false);
  });

  it('should create a tray icon with tooltip and context menu on sync when enabled', () => {
    const { manager } = makeManager({ setting: true });

    manager.syncWithSetting();

    const tray = electronMocks.trayInstances[0];
    expect(tray).toBeDefined();
    expect(tray?.setToolTip).toHaveBeenCalledWith('顽童浏览器');
    expect(tray?.setContextMenu).toHaveBeenCalledTimes(1);
    expect(electronMocks.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electronMocks.createFromPath).toHaveBeenCalledWith('C:\\app\\build\\icon.ico');
  });

  it('should not recreate the tray on repeated sync', () => {
    const { manager } = makeManager({ setting: true });

    manager.syncWithSetting();
    manager.syncWithSetting();

    expect(electronMocks.trayInstances).toHaveLength(1);
  });

  it('should hide the window and prevent the default close when enabled', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));

    const event = win.emitClose();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.visible).toBe(false);
  });

  it('should let the window close normally when the setting is disabled', () => {
    const { manager, windows } = makeManager({ setting: false });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));

    const event = win.emitClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(electronMocks.trayInstances).toHaveLength(0);
  });

  it('should not hide when a dirty-document guard already prevented the close', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));

    const event = win.emitClose(makeCloseEvent(true));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('should not hide while quitting', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));
    manager.markQuitting();

    const event = win.emitClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('should not hide when the tray icon is empty (safety fallback)', () => {
    electronMocks.createFromPath.mockReturnValueOnce({ isEmpty: () => true });
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));

    const event = win.emitClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('should show, restore and focus the main window when the tray is clicked', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    win.visible = false;
    win.minimized = true;
    manager.syncWithSetting();

    electronMocks.trayInstances[0]?.handlers.get('click')?.();

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('should quit through the injected callback from the tray menu', () => {
    const { manager, quit } = makeManager({ setting: true });
    manager.syncWithSetting();

    const template = (
      electronMocks.buildFromTemplate.mock.calls[0] as unknown as
        [{ label?: string; click?: () => void }[]] | undefined
    )?.[0];
    template?.[2]?.click?.();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('should destroy the tray when the setting is turned off', () => {
    const { manager, setSetting } = makeManager({ setting: true });
    manager.syncWithSetting();
    const tray = electronMocks.trayInstances[0]!;

    setSetting(false);
    manager.handleSettingChange(MINIMIZE_TO_TRAY_KEY);

    expect(tray.destroy).toHaveBeenCalledTimes(1);
  });

  it('should ignore unrelated setting changes', () => {
    const { manager } = makeManager({ setting: false });

    manager.handleSettingChange('language');

    expect(electronMocks.trayInstances).toHaveLength(0);
  });

  it('should show a hidden window before destroying the tray when disabling', () => {
    const { manager, windows, setSetting } = makeManager({ setting: true });
    const win = windows[0]!;
    win.visible = false;
    manager.syncWithSetting();

    setSetting(false);
    manager.syncWithSetting();

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(electronMocks.trayInstances[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('should remove close listeners and destroy the tray on dispose', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));
    manager.syncWithSetting();

    manager.dispose();

    expect(win.handlers.get('close')).toHaveLength(0);
    expect(electronMocks.trayInstances[0]?.destroy).toHaveBeenCalledTimes(1);

    const event = win.emitClose();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('should attach each window only once', () => {
    const { manager, windows } = makeManager({ setting: true });
    const win = windows[0]!;
    manager.attachWindow(asWindow(win));
    manager.attachWindow(asWindow(win));

    expect(win.handlers.get('close')).toHaveLength(1);
  });
});

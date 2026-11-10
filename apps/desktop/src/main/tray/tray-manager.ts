/**
 * 系统托盘 · 关闭窗口驻留托盘（2026-11-10 用户需求）
 *
 * 职责：
 * 1. 读取设置 `ui.minimizeToTray`（默认关闭），仅在开启时创建托盘图标；
 * 2. 拦截窗口 close：开启时隐藏窗口（进程继续运行），关闭时维持原退出行为；
 * 3. 托盘右键菜单提供「显示主窗口」与「完全退出」入口；
 * 4. 设置变更即时生效（无需重启）：开启即建托盘，关闭即销毁。
 *
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点）：
 * - 复用 BrowserWindowLike 结构化接口而非 Electron BrowserWindow，核心
 *   行为（拦截 / 隐藏 / 恢复）可在单测中以最小窗口替身验证；
 * - 只在托盘创建成功后才允许隐藏窗口——否则窗口隐藏后既无托盘入口、
 *   也无法再唤回，等于把进程锁死（安全兜底，见 shouldHideOnClose）；
 * - close 监听注册在 GenOffice 脏文档守卫之后（index.ts 中的安装顺序），
 *   并以 event.defaultPrevented 判定「已有守卫接管」，避免吞掉保存确认；
 * - 退出由调用方注入（index.ts 负责先确认脏文档再 app.quit），本模块不直接
 *   依赖 app 生命周期，保持可测。
 */
import { Menu, Tray, nativeImage } from 'electron';
import { createLogger } from '@urchin/logger';
import type { BrowserWindowLike } from '../windows/types';
import { resolveAppIconPath } from '../windows/app-icon';

const log = createLogger('tray');

/** 设置键：关闭窗口时最小化到系统托盘（默认关闭，见 SettingsManager DEFAULT_SETTINGS） */
export const MINIMIZE_TO_TRAY_KEY = 'ui.minimizeToTray';

/** 托盘菜单项（纯数据，便于单测与 Electron Menu 解耦）。 */
export interface TrayMenuTemplateItem {
  readonly label?: string;
  readonly type?: 'separator';
  readonly click?: () => void;
}

/**
 * 构建托盘右键菜单模板。
 *
 * 菜单语义：左键/双击托盘图标直接唤回窗口；右键菜单提供显式「完全退出」，
 * 避免用户只能通过任务管理器结束驻留进程。
 */
export function buildTrayMenuTemplate(actions: {
  readonly showMainWindow: () => void;
  readonly quit: () => void;
}): TrayMenuTemplateItem[] {
  return [
    { label: '显示主窗口', click: actions.showMainWindow },
    { type: 'separator' },
    { label: '完全退出', click: actions.quit },
  ];
}

/** 关闭拦截判定输入。 */
export interface CloseInterceptFlags {
  /** 设置 `ui.minimizeToTray` 是否为 true */
  readonly enabled: boolean;
  /** 托盘图标是否已就绪（创建失败时不允许隐藏，防止窗口失联） */
  readonly trayAvailable: boolean;
  /** 应用是否正在退出（退出流程必须放行，否则永远关不掉） */
  readonly quitting: boolean;
  /** 同一 close 事件是否已被其他守卫（如 GenOffice 脏文档确认）preventDefault */
  readonly defaultPrevented: boolean;
}

/**
 * 是否应把本次关闭转为「隐藏到托盘」。
 *
 * 四个条件全满足才拦截：开关开启 + 托盘可用 + 非退出中 + 未被其他守卫接管。
 */
export function shouldHideOnClose(flags: CloseInterceptFlags): boolean {
  return flags.enabled && flags.trayAvailable && !flags.quitting && !flags.defaultPrevented;
}

/** TrayManager 依赖（注入便于测试）。 */
export interface TrayManagerDeps {
  /** 读取设置值（每次关闭都重新读取，改设置无需重启） */
  readonly getSetting: (key: string) => unknown;
  /** 当前全部窗口（按 WindowManager 顺序，主窗口在前） */
  readonly getWindows: () => readonly BrowserWindowLike[];
  /** 完全退出（调用方负责脏文档确认 + app.quit） */
  readonly quit: () => void;
  /** 托盘提示文本（品牌名） */
  readonly appName: string;
  /** 图标路径覆盖（默认 resolveAppIconPath） */
  readonly iconPath?: string;
}

/** close 事件的最小形状（Electron Event 的结构化子集）。 */
interface CloseEventLike {
  readonly defaultPrevented?: boolean;
  preventDefault?: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;

  /** 应用退出中：置位后所有 close 放行，不再隐藏窗口 */
  private quitting = false;

  /** 已挂 close 监听（同窗口重复 attach 去重） */
  private readonly closeHandlers = new WeakMap<BrowserWindowLike, (...args: unknown[]) => void>();

  constructor(private readonly deps: TrayManagerDeps) {}

  /** 设置值是否开启驻留托盘。 */
  isEnabled(): boolean {
    return this.deps.getSetting(MINIMIZE_TO_TRAY_KEY) === true;
  }

  /**
   * 响应设置变更：仅处理本功能的键。
   *
   * 关闭开关时若所有窗口都处于隐藏态，先唤回主窗口再销毁托盘，
   * 否则窗口将失去唯一入口（防御性兜底）。
   */
  handleSettingChange(key: string): void {
    if (key !== MINIMIZE_TO_TRAY_KEY) return;
    this.syncWithSetting();
  }

  /** 让托盘状态与当前设置值对齐。 */
  syncWithSetting(): void {
    if (this.isEnabled()) {
      this.ensureTray();
      return;
    }
    if (this.tray) {
      const windows = this.deps.getWindows();
      const anyVisible = windows.some((w) => w.isVisible?.() === true);
      if (!anyVisible) this.showMainWindow();
      this.destroyTray();
    }
  }

  /**
   * 为窗口挂 close 拦截。
   *
   * 注意：必须在 GenOffice 脏文档守卫之后安装（index.ts 的注册顺序），
   * 以便通过 defaultPrevented 识别「本次关闭已被保存确认接管」。
   */
  attachWindow(win: BrowserWindowLike): void {
    if (this.closeHandlers.has(win)) return;
    const handler = (...args: unknown[]): void => {
      this.onWindowClose(win, args[0] as CloseEventLike | undefined);
    };
    this.closeHandlers.set(win, handler);
    win.on('close', handler);
  }

  /** 窗口 close 拦截逻辑。 */
  private onWindowClose(win: BrowserWindowLike, event: CloseEventLike | undefined): void {
    const enabled = this.isEnabled();
    // 仅在开关开启且非退出中时才尝试建托盘：避免「未启用却弹出托盘图标」，
    // 也避免退出阶段做无谓的图标 I/O。
    const trayAvailable = enabled && !this.quitting ? this.ensureTray() : false;
    const hide = shouldHideOnClose({
      enabled,
      trayAvailable,
      quitting: this.quitting,
      defaultPrevented: event?.defaultPrevented === true,
    });
    if (!hide) return;
    // 先 preventDefault 再 hide：hide 不会触发 closed 事件，
    // 因此 window-all-closed 不会执行，进程保持驻留。
    event?.preventDefault?.();
    win.hide();
    log.info('window hidden to tray');
  }

  /**
   * 确保托盘图标存在。
   *
   * @returns 托盘是否可用（创建成功或已存在）
   */
  private ensureTray(): boolean {
    if (this.tray && !this.tray.isDestroyed()) return true;
    if (this.tray) this.tray = null;
    try {
      const image = nativeImage.createFromPath(this.deps.iconPath ?? resolveAppIconPath());
      if (image.isEmpty()) {
        // 空图标会让 Tray 构造出不可见/空白图标，等同于无入口；
        // 视为失败，阻止窗口隐藏（宁可正常退出也不锁死进程）。
        log.error('tray icon is empty, skip hiding to tray');
        return false;
      }
      const tray = new Tray(image);
      tray.setToolTip(this.deps.appName);
      tray.setContextMenu(this.buildMenu());
      tray.on('click', () => this.showMainWindow());
      tray.on('double-click', () => this.showMainWindow());
      this.tray = tray;
      log.info('tray created');
      return true;
    } catch (err) {
      this.tray = null;
      log.error('failed to create tray', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** 构建 Electron 菜单（模板见 buildTrayMenuTemplate）。 */
  private buildMenu(): Menu {
    const template = buildTrayMenuTemplate({
      showMainWindow: () => this.showMainWindow(),
      quit: () => this.quitApp(),
    });
    return Menu.buildFromTemplate(template);
  }

  /** 唤回主窗口：恢复最小化 + 显示 + 聚焦。 */
  showMainWindow(): void {
    const windows = this.deps.getWindows();
    const win = windows.find((w) => !w.isDestroyed()) ?? windows[0];
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized?.() === true) win.restore();
    win.show();
    win.focus?.();
  }

  /** 标记退出中（before-quit 调用）：此后 close 一律放行。 */
  markQuitting(): void {
    this.quitting = true;
  }

  /** 托盘菜单「完全退出」：交给调用方执行真正退出（含脏文档确认）。 */
  quitApp(): void {
    this.deps.quit();
  }

  /** 销毁托盘并解除窗口监听（退出清理 / 关闭开关）。 */
  dispose(): void {
    for (const win of this.deps.getWindows()) {
      const handler = this.closeHandlers.get(win);
      if (handler) {
        win.removeListener?.('close', handler);
        this.closeHandlers.delete(win);
      }
    }
    this.destroyTray();
  }

  private destroyTray(): void {
    if (!this.tray) return;
    try {
      this.tray.destroy();
    } catch (err) {
      log.warn('failed to destroy tray', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.tray = null;
    log.info('tray destroyed');
  }
}

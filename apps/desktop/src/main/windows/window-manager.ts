/**
 * M1 Window Lifecycle · WindowManager
 *
 * 依据：02-架构设计 §1 进程模型 / §6 启动顺序 / 04-模块全景 M1
 * 职责：
 * 1. 管理多窗口集合（Map<windowId, ManagedWindow>）
 * 2. 分配单调递增的 Urchin 内部 windowId（与 Electron 的 BrowserWindow.id 解耦）
 * 3. 窗口创建/关闭/查询
 * 4. 监听 BrowserWindow 'closed' 事件自动清理集合
 * 5. 分发 window-created / window-closed 事件
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - 通过 BrowserWindowFactory 依赖注入，使核心逻辑可在单测中用 mock 验证
 * - windowId 单调递增且独立于 Electron 内部 id，保证重启后语义一致
 * - 窗口关闭自动清理，防止内存泄漏与僵尸引用
 */
import type {
  BrowserWindowFactory,
  CreateWindowOptions,
  ManagedWindow,
  WindowEvent,
  WindowEventListener,
} from './types';

export class WindowManager {
  /** 窗口集合：windowId → ManagedWindow */
  private readonly windows = new Map<number, ManagedWindow>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<WindowEvent, WindowEventListener[]>();

  /** 下一个分配的 windowId（单调递增，从 1 开始） */
  private nextId = 1;

  constructor(private readonly factory: BrowserWindowFactory) {}

  /**
   * 创建新窗口。
   *
   * @param opts 创建选项（url/incognito/width/height）
   * @returns 受管理的窗口实例
   */
  createWindow(opts: CreateWindowOptions): ManagedWindow {
    const id = this.nextId++;
    const browserWindow = this.factory(opts);

    const managed: ManagedWindow = {
      id,
      browserWindow,
      isIncognito: opts.incognito ?? false,
    };

    // 监听 closed 事件，自动从集合移除并分发事件
    browserWindow.on('closed', () => {
      if (this.windows.delete(id)) {
        this.emit('window-closed', id);
      }
    });

    this.windows.set(id, managed);
    this.emit('window-created', id);

    return managed;
  }

  /**
   * 关闭指定窗口。
   * 调用 BrowserWindow.close()，实际清理在 'closed' 事件回调中完成。
   *
   * @throws 若窗口不存在
   */
  closeWindow(windowId: number): void {
    const managed = this.windows.get(windowId);
    if (!managed) {
      throw new Error(`Window not found: ${windowId}`);
    }
    managed.browserWindow.close();
  }

  /** 按 id 获取窗口。 */
  getWindow(windowId: number): ManagedWindow | undefined {
    return this.windows.get(windowId);
  }

  /**
   * 按 webContents 反查所属窗口（IPC sender 定位用）。
   *
   * IPC handler 的 event.sender 是真实 Electron webContents，
   * 与 ManagedWindow.browserWindow.webContents 同一实例，按引用相等匹配。
   * 多窗口场景下渲染层不再硬编码 windowId=1，改经此反查自己的窗口。
   */
  getWindowByWebContents(wc: unknown): ManagedWindow | undefined {
    for (const managed of this.windows.values()) {
      if (managed.browserWindow.webContents === wc) return managed;
    }
    return undefined;
  }

  /** 获取所有窗口。 */
  getAllWindows(): ManagedWindow[] {
    return Array.from(this.windows.values());
  }

  /** 获取窗口数量。 */
  getCount(): number {
    return this.windows.size;
  }

  /** 注册事件监听。 */
  on(event: WindowEvent, listener: WindowEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: WindowEvent, listener: WindowEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  private emit(event: WindowEvent, windowId: number): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(windowId);
    }
  }
}

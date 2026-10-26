/**
 * M15 DevTools · CDP 客户端（webContents.debugger 薄封装）
 *
 * 依据：契约 G §3 / 实施规划 §6。
 * 职责：attach('1.3') / sendCommand / 消息事件路由 / detach 事件归一。
 * 设计理由（agents.md §七.2 + §六 进程隔离）：将 Electron debugger API
 * 抽象为 DebuggerLike 接口，使 DevtoolsManager 核心逻辑可在单测中用 mock
 * 验证（不依赖真实 Electron），与 TabManager/TranslateManager 的依赖注入
 * 惯例一致。
 */

/** CDP 消息事件处理函数（method + params）。 */
export type CdpMessageHandler = (method: string, params: unknown) => void;

/** detach 事件处理函数（reason：'target-removed' | 'canceled by user' | ...）。 */
export type CdpDetachHandler = (reason: string) => void;

/**
 * Electron webContents.debugger 的最小依赖接口（便于测试 mock）。
 * 真实 Electron.WebContents['debugger'] 满足此接口。
 */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on(event: 'message', handler: (event: unknown, method: string, params: unknown) => void): void;
  on(event: 'detach', handler: (event: unknown, reason: string) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** Electron debugger attach 协议版本（DT3 决策：1.3 成熟稳定）。 */
export const CDP_PROTOCOL_VERSION = '1.3';

/** 由 webContents 解析出 debugger 句柄的工厂（默认走真实 Electron；测试可注入 mock）。 */
export type DebuggerResolver = (wc: unknown) => DebuggerLike;

/** 默认解析器：从 webContents 取 .debugger 字段（Electron.WebContents 满足）。 */
export const defaultDebuggerResolver: DebuggerResolver = (wc) => {
  return (wc as { debugger: DebuggerLike }).debugger;
};

/**
 * 单个 tab 的 CDP 会话客户端。
 *
 * 一个实例对应一次 attach；detach 后不可复用（manager 重新 attach 时新建）。
 * 错误归一：attach 已附加 → 抛 Error('already-attached')；其余原生错误透传，
 * 由 manager 捕获映射为 unavailable(target-closed)。
 */
export class TabCdpClient {
  private readonly dbg: DebuggerLike;
  private messageHandler: CdpMessageHandler | null = null;
  private detachHandler: CdpDetachHandler | null = null;
  private readonly boundMessage: (...args: unknown[]) => void;
  private readonly boundDetach: (...args: unknown[]) => void;

  constructor(wc: unknown, resolveDebugger: DebuggerResolver = defaultDebuggerResolver) {
    this.dbg = resolveDebugger(wc);
    this.boundMessage = (...args: unknown[]) => {
      // Electron 'message' 事件签名：(event, method, params)
      this.messageHandler?.(args[1] as string, args[2]);
    };
    this.boundDetach = (...args: unknown[]) => {
      // Electron 'detach' 事件签名：(event, reason)
      this.detachHandler?.(args[1] as string);
    };
  }

  /** Electron debugger 是否已附加（可能被原生 DevTools 或其他客户端占用）。 */
  isAttached(): boolean {
    return this.dbg.isAttached();
  }

  /**
   * 同步 attach（Electron debugger.attach 为同步调用）。
   * @throws Error('already-attached') 若 debugger 已被占用
   * @throws 原生错误（webContents 已销毁等）
   */
  attach(): void {
    if (this.dbg.isAttached()) {
      throw new Error('already-attached');
    }
    this.dbg.attach(CDP_PROTOCOL_VERSION);
    this.dbg.on('message', this.boundMessage);
    this.dbg.on('detach', this.boundDetach);
  }

  /** 同步 detach。幂等——已 detach 不报错（防御目标已销毁场景）。 */
  detach(): void {
    try {
      this.dbg.removeListener?.('message', this.boundMessage);
      this.dbg.removeListener?.('detach', this.boundDetach);
    } catch {
      /* 忽略：目标可能已销毁 */
    }
    try {
      if (this.dbg.isAttached()) {
        this.dbg.detach();
      }
    } catch {
      /* 忽略：目标已销毁或已 detach */
    }
  }

  /** 发送 CDP 命令并等待结果。 */
  send<T = unknown>(method: string, params?: object): Promise<T> {
    return this.dbg.sendCommand(method, params) as Promise<T>;
  }

  /** 注册消息事件处理（仅一个；manager 统一路由）。 */
  onMessage(handler: CdpMessageHandler): void {
    this.messageHandler = handler;
  }

  /** 注册 detach 事件处理（外部抢占/目标崩溃时触发）。 */
  onDetach(handler: CdpDetachHandler): void {
    this.detachHandler = handler;
  }
}

/**
 * @urchin/provider-sdk · 类型定义
 *
 * 依据：契约 I §2 / 04-模块全景 M11/M12
 *
 * 抽象 Electron utility process 的 process.parentPort 与 MessagePort，
 * 让 SDK 核心逻辑可在无 Electron 环境下测试。
 */

/**
 * MessagePort 抽象（参考 Node.js MessagePort / Electron MessagePortMain 子集）。
 *
 * 用于在 Provider Child ↔ Orchestrator 之间传递结构化消息。
 */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  start(): void;
  close(): void;
}

/**
 * process.parentPort 接收的 message 事件结构。
 *
 * Electron utility process 中：
 * - event.data 是 Orchestrator 通过 proc.postMessage 发送的消息
 * - event.ports 是 transferred 的 MessagePort 列表
 */
export interface ParentPortMessageEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePortLike[];
}

/**
 * parentPort 抽象（参考 Electron utility process 的 process.parentPort 子集）。
 */
export interface ParentPortLike {
  on(event: 'message', listener: (event: ParentPortMessageEvent) => void): this;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

/** 定时器抽象，便于测试注入 */
export interface TimerProvider {
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const DEFAULT_TIMERS: TimerProvider = {
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: (h) => clearInterval(h),
};

export { DEFAULT_TIMERS };

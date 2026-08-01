/**
 * Orchestrator 测试辅助：mock IUtilityProcess / IMessagePort / TimerProvider。
 *
 * 提供受控的 mock 实现，便于测试 Provider 生命周期、心跳超时、空闲回收等。
 */
import { EventEmitter as EE } from 'node:events';
import type {
  IMessagePort,
  IUtilityProcess,
  ITokenBucket,
} from '../../src/main/orchestrator/types';
import type { TimerProvider } from '../../src/main/orchestrator/orchestrator';

/**
 * Mock MessagePort：用 EventEmitter 模拟双向通信。
 *
 * 配对的两个端口互发消息：a.postMessage(x) 会让 b 收到 message 事件。
 *
 * 消息缓冲：如果对端尚未注册 listener，消息会缓冲到 messageBuffer，
 * 等对端调用 on('message', ...) 时再 flush。这模拟了真实 MessagePortMain
 * 的行为（消息不会丢失），解决了「Orchestrator 先 postMessage、SDK 后 on」的时序问题。
 */
export class MockMessagePort implements IMessagePort {
  private readonly emitter = new EE();
  // 配对端口，配对后 postMessage 实际写入对端
  private pairedTo: MockMessagePort | null = null;
  // 缓冲对端尚未监听时收到的消息
  private messageBuffer: unknown[] = [];
  private hasListener = false;

  /** 配对两个端口，使其互发消息 */
  static pair(): readonly [MockMessagePort, MockMessagePort] {
    const a = new MockMessagePort();
    const b = new MockMessagePort();
    a.pairedTo = b;
    b.pairedTo = a;
    return [a, b] as const;
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    void transfer;
    const target = this.pairedTo;
    if (!target) return;
    if (target.hasListener) {
      // 对端已有 listener，直接异步投递
      queueMicrotask(() => {
        target.emitter.emit('message', message);
      });
    } else {
      // 对端尚未监听，缓冲消息
      target.messageBuffer.push(message);
    }
  }

  on(event: 'message', listener: (message: unknown) => void): this {
    this.emitter.on(event, listener);
    this.hasListener = true;
    // flush 缓冲的消息
    const buffered = this.messageBuffer;
    this.messageBuffer = [];
    for (const msg of buffered) {
      queueMicrotask(() => {
        this.emitter.emit('message', msg);
      });
    }
    return this;
  }

  removeListener(event: 'message', listener: (message: unknown) => void): this {
    this.emitter.removeListener(event, listener);
    return this;
  }

  start(): void {
    // no-op（mock 不依赖 start 状态）
  }

  close(): void {
    this.emitter.removeAllListeners();
    this.hasListener = false;
    this.messageBuffer = [];
  }

  /** 测试用：手动触发 inbound 消息（绕过缓冲，直接同步 emit） */
  emitMessage(message: unknown): void {
    this.emitter.emit('message', message);
  }
}

/**
 * Mock UtilityProcess。
 */
export class MockUtilityProcess implements IUtilityProcess {
  readonly emitter = new EE();
  killed = false;
  postMessageCalls: unknown[] = [];

  readonly pid: number = 12345;

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    void transfer;
    this.postMessageCalls.push(message);
  }

  on(event: 'exit' | 'message', listener: (arg: unknown) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  removeListener(event: 'exit' | 'message', listener: (arg: unknown) => void): this {
    this.emitter.removeListener(event, listener);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** 测试用：模拟进程退出 */
  simulateExit(code: number | null): void {
    this.emitter.emit('exit', code);
  }

  /** 测试用：模拟进程收到消息 */
  simulateMessage(msg: unknown): void {
    this.emitter.emit('message', msg);
  }
}

/**
 * Mock TokenBucket：不做限流，仅记录调用。
 */
export class MockTokenBucket implements ITokenBucket {
  acquireCalls = 0;
  availableTokens = Number.POSITIVE_INFINITY;

  // eslint-disable-next-line @typescript-eslint/require-await -- mock 不需要 await
  async acquireRequestToken(): Promise<void> {
    this.acquireCalls++;
  }
}

/**
 * 受控的 TimerProvider：所有定时器需手动触发。
 *
 * - setInterval 注册回调，但不会自动执行
 * - tickInterval() 手动触发一次 interval 回调
 * - tickTimeout() 手动触发一次 timeout 回调
 */
export class MockTimers implements TimerProvider {
  private readonly intervalHandlers = new Map<unknown, () => void>();
  private readonly timeoutHandlers = new Map<unknown, () => void>();
  private intervalCounter = 0;
  private timeoutCounter = 0;

  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval> {
    void ms;
    const id = `interval-${this.intervalCounter++}`;
    this.intervalHandlers.set(id, handler);
    return id as unknown as ReturnType<typeof setInterval>;
  }

  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    void ms;
    const id = `timeout-${this.timeoutCounter++}`;
    this.timeoutHandlers.set(id, handler);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.intervalHandlers.delete(handle);
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timeoutHandlers.delete(handle);
  }

  /** 手动触发一次 interval 回调 */
  tickInterval(handle?: ReturnType<typeof setInterval>): number {
    let count = 0;
    if (handle) {
      const h = this.intervalHandlers.get(handle);
      if (h) {
        h();
        count++;
      }
    } else {
      for (const h of this.intervalHandlers.values()) {
        h();
        count++;
      }
    }
    return count;
  }

  /** 手动触发一次 timeout 回调（触发后自动移除） */
  tickTimeout(handle?: ReturnType<typeof setTimeout>): number {
    let count = 0;
    if (handle) {
      const h = this.timeoutHandlers.get(handle);
      if (h) {
        h();
        this.timeoutHandlers.delete(handle);
        count++;
      }
    } else {
      for (const [id, h] of this.timeoutHandlers.entries()) {
        h();
        this.timeoutHandlers.delete(id);
        count++;
      }
    }
    return count;
  }

  /** 当前活跃的定时器数量 */
  get activeCount(): number {
    return this.intervalHandlers.size + this.timeoutHandlers.size;
  }
}

/**
 * 创建一组 mock factory 用于测试 Orchestrator。
 *
 * 返回的 factory 符合 UtilityProcessFactory 类型，
 * 同时暴露内部 processes / orchestratorPorts / childPorts 用于测试断言和模拟 child 行为。
 *
 * - processes：所有创建的 mock utility process
 * - orchestratorPorts：Orchestrator 端的 port（port1），测试时用 .emitMessage() 模拟收到 child 消息
 * - childPorts：child 端的 port（port2），测试时用 .postMessageCalls 或观察 Orchestrator 发来的消息
 */
export function createMockProcessFactory(): {
  readonly factory: import('../../src/main/orchestrator/types').UtilityProcessFactory;
  readonly processes: readonly MockUtilityProcess[];
  readonly orchestratorPorts: readonly MockMessagePort[];
  readonly childPorts: readonly MockMessagePort[];
} {
  const processes: MockUtilityProcess[] = [];
  const orchestratorPorts: MockMessagePort[] = [];
  const childPorts: MockMessagePort[] = [];

  const factory: import('../../src/main/orchestrator/types').UtilityProcessFactory = ({
    providerId,
    serviceModulePath,
  }) => {
    void providerId;
    void serviceModulePath;
    const proc = new MockUtilityProcess();
    const [port1, port2] = MockMessagePort.pair();
    // port1 留给 Orchestrator，port2 视作"已 transferred"给 child
    processes.push(proc);
    orchestratorPorts.push(port1);
    childPorts.push(port2);

    return { process: proc, port: port1 };
  };

  return { factory, processes, orchestratorPorts, childPorts };
}

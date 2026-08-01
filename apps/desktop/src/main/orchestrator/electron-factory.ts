/**
 * M11 AI Orchestrator · Electron 工厂实现
 *
 * 依据：契约 I §2 / OR1 决策
 *
 * 职责：封装 Electron utilityProcess.fork 与 MessageChannelMain 的创建，
 * 让 Orchestrator 核心逻辑可在无 Electron 环境下测试。
 *
 * 注意：本文件仅在主进程生产环境使用，测试时用 mock 替换。
 */
import { utilityProcess, MessageChannelMain } from 'electron';
import type { IMessagePort, IUtilityProcess, UtilityProcessFactory } from './types';

/**
 * 适配 Electron.MessagePortMain → IMessagePort。
 *
 * on() 时将传入的高层 listener 包装成 Electron listener 并缓存映射，
 * 以便 removeListener() 能精确移除对应包装函数（不能直接 removeListener 原始 listener，
 * 因为 on 时注册的是包装函数）。
 */
class MessagePortAdapter implements IMessagePort {
  /** 高层 listener → Electron 包装 listener 的映射（用于精确 removeListener） */
  private readonly wrapperMap = new Map<
    (message: unknown) => void,
    (event: { data: unknown }) => void
  >();

  constructor(private readonly port: Electron.MessagePortMain) {}

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(message, transfer as Electron.MessagePortMain[]);
    } else {
      this.port.postMessage(message);
    }
  }

  on(event: 'message', listener: (message: unknown) => void): this {
    const wrapper = (evt: { data: unknown }): void => {
      listener(evt.data);
    };
    this.wrapperMap.set(listener, wrapper);
    this.port.on(event, wrapper);
    return this;
  }

  removeListener(event: 'message', listener: (message: unknown) => void): this {
    const wrapper = this.wrapperMap.get(listener);
    if (wrapper) {
      this.port.removeListener(event, wrapper);
      this.wrapperMap.delete(listener);
    }
    return this;
  }

  start(): void {
    this.port.start();
  }

  close(): void {
    this.port.close();
    this.wrapperMap.clear();
  }
}

/**
 * 适配 Electron.UtilityProcess → IUtilityProcess。
 *
 * Electron 的 UtilityProcess.on() 有重载（'exit' / 'message' 不同 listener 签名），
 * 这里归一化为单一签名 (event, (arg) => void)，由调用方按 event 类型转换。
 */
class UtilityProcessAdapter implements IUtilityProcess {
  /** 高层 listener → Electron 包装 listener 的映射（用于精确 removeListener） */
  private readonly wrapperMap = new Map<(arg: unknown) => void, (...args: unknown[]) => void>();

  constructor(private readonly proc: Electron.UtilityProcess) {}

  get pid(): number | undefined {
    return this.proc.pid;
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    if (transfer && transfer.length > 0) {
      this.proc.postMessage(message, transfer as Electron.MessagePortMain[]);
    } else {
      this.proc.postMessage(message);
    }
  }

  on(event: 'exit' | 'message', listener: (arg: unknown) => void): this {
    // Electron UtilityProcess 的事件 listener 签名不同：
    // - 'exit': (code: number | null) => void
    // - 'message': (message: unknown) => void
    // 这里统一为 (arg: unknown) => void，listener 内部按需 cast。
    const proc = this.proc as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
      removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    const wrapper = (...args: unknown[]): void => listener(args[0]);
    this.wrapperMap.set(listener, wrapper);
    proc.on(event, wrapper);
    return this;
  }

  removeListener(event: 'exit' | 'message', listener: (arg: unknown) => void): this {
    const proc = this.proc as unknown as {
      removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    const wrapper = this.wrapperMap.get(listener);
    if (wrapper) {
      proc.removeListener(event, wrapper);
      this.wrapperMap.delete(listener);
    }
    return this;
  }

  kill(): boolean {
    return this.proc.kill();
  }
}

/**
 * 生产环境的 utility process 工厂。
 *
 * 1. fork 出 utility process
 * 2. 创建一对 MessageChannelMain，port1 包装返回，port2 transferred 给子进程
 */
export const electronProcessFactory: UtilityProcessFactory = ({
  providerId,
  serviceModulePath,
}) => {
  const proc = utilityProcess.fork(serviceModulePath, [`--provider-id=${providerId}`], {
    serviceName: `urchin-ai-provider-${providerId}`,
    stdio: 'pipe',
  });

  const { port1, port2 } = new MessageChannelMain();

  // 把 port2 transferred 给子进程
  proc.postMessage({ kind: 'orch.init', port: port2 }, [port2]);

  return {
    process: new UtilityProcessAdapter(proc),
    port: new MessagePortAdapter(port1),
  };
};

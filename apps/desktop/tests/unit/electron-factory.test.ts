/**
 * Electron 工厂（electron-factory.ts）单元测试
 *
 * 验证：
 * 1. electronProcessFactory fork 正确参数
 * 2. MessageChannel 创建并 transfer port2
 * 3. 返回的 process 与 port 适配器正确转发调用
 * 4. port.on / removeListener 的 wrapper 映射
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFork = vi.hoisted(() => vi.fn());
const mockMessageChannelMain = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  utilityProcess: { fork: mockFork },
  MessageChannelMain: mockMessageChannelMain,
}));

import { electronProcessFactory } from '../../src/main/orchestrator/electron-factory';

interface Proc {
  pid: number;
  postMessage: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

interface Port {
  postMessage: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let proc: Proc;
let port1: Port;
let port2: Port;

beforeEach(() => {
  vi.clearAllMocks();
  proc = {
    pid: 999,
    postMessage: vi.fn(),
    on: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    kill: vi.fn().mockReturnValue(true),
  };
  port1 = {
    postMessage: vi.fn(),
    on: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    start: vi.fn(),
    close: vi.fn(),
  };
  port2 = {
    postMessage: vi.fn(),
    on: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    start: vi.fn(),
    close: vi.fn(),
  };
  mockFork.mockReturnValue(proc);
  mockMessageChannelMain.mockReturnValue({ port1, port2 });
});

describe('electronProcessFactory', () => {
  it('should fork utility process with correct args', () => {
    electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });

    expect(mockFork).toHaveBeenCalledWith(
      './worker.js',
      ['--provider-id=p1'],
      expect.objectContaining({ serviceName: 'urchin-ai-provider-p1', stdio: 'pipe' }),
    );
  });

  it('should create MessageChannelMain and transfer port2', () => {
    electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });

    expect(mockMessageChannelMain).toHaveBeenCalled();
    expect(proc.postMessage).toHaveBeenCalledWith({ kind: 'orch.init', port: port2 }, [port2]);
  });

  it('should return process adapter with pid', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });

    expect(result.process.pid).toBe(999);
  });

  it('should delegate process.postMessage to underlying', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.process.postMessage('data', [1]);

    expect(proc.postMessage).toHaveBeenCalledWith('data', [1]);
  });

  it('should delegate process.postMessage without transfer', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.process.postMessage('hello');

    expect(proc.postMessage).toHaveBeenCalledWith('hello');
  });

  it('should delegate process.on and wrap listener', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    const listener = vi.fn();
    result.process.on('exit', listener);

    expect(proc.on).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('should delegate process.removeListener with wrapper', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    const listener = vi.fn();
    result.process.on('exit', listener);
    result.process.removeListener('exit', listener);

    expect(proc.removeListener).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('should delegate process.kill', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    expect(result.process.kill()).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('should delegate port.postMessage with transfer', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.port.postMessage('hello', [1, 2]);

    expect(port1.postMessage).toHaveBeenCalledWith('hello', [1, 2]);
  });

  it('should delegate port.postMessage without transfer', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.port.postMessage('hello');

    expect(port1.postMessage).toHaveBeenCalledWith('hello');
  });

  it('should delegate port.on and wrap listener', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    const listener = vi.fn();
    result.port.on('message', listener);

    expect(port1.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should delegate port.removeListener with wrapper', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    const listener = vi.fn();
    result.port.on('message', listener);
    result.port.removeListener('message', listener);

    expect(port1.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should delegate port.start', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.port.start();

    expect(port1.start).toHaveBeenCalled();
  });

  it('should delegate port.close and clear wrapper', () => {
    const result = electronProcessFactory({ providerId: 'p1', serviceModulePath: './worker.js' });
    result.port.on('message', vi.fn());
    vi.clearAllMocks();
    result.port.close();

    expect(port1.close).toHaveBeenCalled();
  });
});

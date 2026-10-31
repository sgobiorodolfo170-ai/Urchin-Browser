/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-empty-function -- node-pty mock 需要宽松类型处理 PTY 事件回调 */
/**
 * terminal.ts 单元测试
 *
 * 覆盖空状态（listTerminals / disposeAllTerminals）+
 * createTerminal/input/resize/kill mock 测试（P4）。
 * node-pty 被 mock 为 MockPty，支持 onData/onExit 回调模拟。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ptyMock = vi.hoisted(() => {
  const created: any[] = [];
  return {
    spawn: vi.fn(() => {
      const dataCbs: ((data: string) => void)[] = [];
      const exitCbs: ((e: { exitCode: number }) => void)[] = [];
      const pty = {
        pid: 12345,
        onData: vi.fn((cb: (data: string) => void) => dataCbs.push(cb)),
        onExit: vi.fn((cb: (e: { exitCode: number }) => void) => exitCbs.push(cb)),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        _emitData: (data: string) => dataCbs.forEach((cb) => cb(data)),
        _emitExit: (exitCode: number) => exitCbs.forEach((cb) => cb({ exitCode })),
      };
      created.push(pty);
      return pty;
    }),
    created,
    reset: () => {
      created.length = 0;
    },
  };
});

vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }));

import {
  listTerminals,
  disposeAllTerminals,
  createTerminal,
  terminalInput,
  terminalResize,
  terminalKill,
} from '../src/terminal';

describe('terminal empty state', () => {
  beforeEach(() => {
    disposeAllTerminals();
  });

  it('should return empty array when no terminals exist', () => {
    expect(listTerminals()).toEqual([]);
  });

  it('should return empty array after disposeAllTerminals', () => {
    disposeAllTerminals();
    expect(listTerminals()).toEqual([]);
  });

  it('should not throw when disposeAllTerminals called on empty state', () => {
    expect(() => disposeAllTerminals()).not.toThrow();
  });

  it('should be idempotent when disposeAllTerminals called multiple times', () => {
    expect(() => {
      disposeAllTerminals();
      disposeAllTerminals();
      disposeAllTerminals();
    }).not.toThrow();
    expect(listTerminals()).toEqual([]);
  });
});

describe('createTerminal (mock node-pty)', () => {
  beforeEach(() => {
    disposeAllTerminals();
    ptyMock.reset();
    ptyMock.spawn.mockClear();
  });

  it('should create terminal and appear in listTerminals', () => {
    const outputs: string[] = [];
    const exits: number[] = [];
    createTerminal(
      't1',
      '/cwd',
      80,
      24,
      'My Term',
      (_id, data) => outputs.push(data),
      (_id, code) => exits.push(code),
    );
    const list = listTerminals();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('t1');
    expect(list[0].title).toBe('My Term');
    expect(list[0].cwd).toBe('/cwd');
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
  });

  it('should use default title when not provided', () => {
    createTerminal(
      't2',
      '/cwd',
      80,
      24,
      undefined,
      () => {},
      () => {},
    );
    const list = listTerminals();
    expect(list[0].title).toBeDefined();
    expect(list[0].title.length).toBeGreaterThan(0);
  });

  it('should forward data to onData callback', () => {
    const outputs: { id: string; data: string }[] = [];
    createTerminal(
      't3',
      '/cwd',
      80,
      24,
      'T',
      (id, data) => outputs.push({ id, data }),
      () => {},
    );
    const pty = ptyMock.created[0];
    pty._emitData('hello world');
    expect(outputs).toEqual([{ id: 't3', data: 'hello world' }]);
  });

  it('should forward exit to onExit callback and remove from list', () => {
    const exits: { id: string; code: number }[] = [];
    createTerminal(
      't4',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      (id, code) => exits.push({ id, code }),
    );
    expect(listTerminals()).toHaveLength(1);
    const pty = ptyMock.created[0];
    pty._emitExit(42);
    expect(exits).toEqual([{ id: 't4', code: 42 }]);
    expect(listTerminals()).toHaveLength(0);
  });

  it('should handle null exitCode as 0', () => {
    const exits: number[] = [];
    createTerminal(
      't5',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      (_id, code) => exits.push(code),
    );
    const pty = ptyMock.created[0];
    pty._emitExit(null as any);
    expect(exits).toEqual([0]);
  });
});

describe('terminalInput / terminalResize / terminalKill (mock)', () => {
  beforeEach(() => {
    disposeAllTerminals();
    ptyMock.reset();
  });

  it('terminalInput should call pty.write', () => {
    createTerminal(
      'in1',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    terminalInput('in1', 'ls -la');
    expect(ptyMock.created[0].write).toHaveBeenCalledWith('ls -la');
  });

  it('terminalInput for non-existent id should not throw', () => {
    expect(() => terminalInput('ghost', 'data')).not.toThrow();
  });

  it('terminalResize should call pty.resize', () => {
    createTerminal(
      'rs1',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    terminalResize('rs1', 120, 40);
    expect(ptyMock.created[0].resize).toHaveBeenCalledWith(120, 40);
  });

  it('terminalResize for non-existent id should not throw', () => {
    expect(() => terminalResize('ghost', 80, 24)).not.toThrow();
  });

  it('terminalKill should call pty.kill and remove from list', () => {
    createTerminal(
      'k1',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    expect(listTerminals()).toHaveLength(1);
    terminalKill('k1');
    expect(ptyMock.created[0].kill).toHaveBeenCalled();
    expect(listTerminals()).toHaveLength(0);
  });

  it('terminalKill for non-existent id should not throw', () => {
    expect(() => terminalKill('ghost')).not.toThrow();
  });

  it('terminalKill should handle pty.kill errors', () => {
    createTerminal(
      'k2',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    ptyMock.created[0].kill.mockImplementation(() => {
      throw new Error('already dead');
    });
    expect(() => terminalKill('k2')).not.toThrow();
    expect(listTerminals()).toHaveLength(0);
  });
});

describe('disposeAllTerminals with active terminals', () => {
  beforeEach(() => {
    disposeAllTerminals();
    ptyMock.reset();
  });

  it('should kill all active terminals', () => {
    createTerminal(
      'a1',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    createTerminal(
      'a2',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    createTerminal(
      'a3',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    expect(listTerminals()).toHaveLength(3);
    disposeAllTerminals();
    expect(listTerminals()).toHaveLength(0);
    expect(ptyMock.created[0].kill).toHaveBeenCalled();
    expect(ptyMock.created[1].kill).toHaveBeenCalled();
    expect(ptyMock.created[2].kill).toHaveBeenCalled();
  });

  it('should handle kill errors during dispose', () => {
    createTerminal(
      'e1',
      '/cwd',
      80,
      24,
      'T',
      () => {},
      () => {},
    );
    ptyMock.created[0].kill.mockImplementation(() => {
      throw new Error('kill failed');
    });
    expect(() => disposeAllTerminals()).not.toThrow();
    expect(listTerminals()).toHaveLength(0);
  });
});

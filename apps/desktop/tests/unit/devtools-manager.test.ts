/**
 * DevtoolsManager 单元测试（M15 CDP 采集核心）。
 *
 * 验证（实施规划 §10.1）：
 * - attach 成功 / 内部页拒绝 / genoffice 拒绝 / 已附加拒绝（幂等）
 * - console 三来源映射（consoleAPICalled / exceptionThrown / Log.entryAdded）
 * - network 三态演进合并（requestWillBeSent → responseReceived → loadingFinished 脏集聚合为最终态）
 * - 环形缓冲淘汰与 dropped 计数
 * - 200ms 批合并（边缘触发）
 * - detach 前 flush 尾批
 * - 外部 detach（debugger 被抢占）→ state=unavailable
 * - evaluate 成功/异常/截断/未附加
 * - list 无会话返回空数组
 * - tab removed 自动 detach
 * - dispose 清理
 *
 * 纯函数辅助：truncateText / sanitizeHeaders / formatConsoleApiArgs 亦有覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DevtoolsManager,
  truncateText,
  sanitizeHeaders,
  formatConsoleApiArgs,
} from '../../src/main/devtools/devtools-manager';
import type { DebuggerLike } from '../../src/main/devtools/cdp-client';

// ---- Fake debugger：模拟 Electron webContents.debugger ----

interface FakeDebugger extends DebuggerLike {
  // 测试驱动：触发 CDP 事件
  emitMessage(method: string, params: unknown): void;
  emitDetach(reason: string): void;
  attached: boolean;
  sendCommandMock: ReturnType<typeof vi.fn<(method: string, params?: object) => Promise<unknown>>>;
}

function createFakeDebugger(): FakeDebugger {
  let attached = false;
  const messageListeners: ((event: unknown, method: string, params: unknown) => void)[] = [];
  const detachListeners: ((event: unknown, reason: string) => void)[] = [];
  const sendCommandMock = vi.fn<(method: string, params?: object) => Promise<unknown>>(() =>
    Promise.resolve({}),
  );
  const fd = {
    get attached() {
      return attached;
    },
    attach() {
      if (attached) throw new Error('Debugger is already attached.');
      attached = true;
    },
    detach() {
      attached = false;
    },
    isAttached() {
      return attached;
    },
    sendCommandMock,
    sendCommand(method: string, params?: object) {
      return sendCommandMock(method, params);
    },
    on(
      event: 'message' | 'detach',
      handler:
        | ((event: unknown, method: string, params: unknown) => void)
        | ((event: unknown, reason: string) => void),
    ) {
      if (event === 'message') messageListeners.push(handler);
      else detachListeners.push(handler as never);
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const list = event === 'message' ? messageListeners : detachListeners;
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    emitMessage(method: string, params: unknown) {
      for (const l of messageListeners) l({}, method, params);
    },
    emitDetach(reason: string) {
      attached = false;
      for (const l of detachListeners) l({}, reason);
    },
  };
  return fd;
}

// ---- Fake TabManager ----

interface FakeTab {
  id: number;
  url: string;
  title: string;
  viewKind: string;
  webContents: { debugger: FakeDebugger };
}

function createFakeTabManager(tabs: FakeTab[]) {
  return {
    getTab: (id: number) => tabs.find((t) => t.id === id),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createManager(tabs: FakeTab[], debuggers: Map<number, FakeDebugger>) {
  const notifications: {
    type: string;
    entries?: Record<string, unknown>[];
    [k: string]: unknown;
  }[] = [];
  const tabManager = createFakeTabManager(tabs);
  const manager = new DevtoolsManager({
    tabManager: tabManager as never,
    notify: (p) => notifications.push(p),
    resolveDebugger: (wc) => (wc as { debugger: FakeDebugger }).debugger,
  });
  // 关联 tabId → fake debugger
  for (const t of tabs) debuggers.set(t.id, t.webContents.debugger);
  return { manager, notifications, tabManager };
}

describe('truncateText', () => {
  it('should pass through within limit', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });
  it('should truncate over limit with suffix', () => {
    const s = 'x'.repeat(100);
    const out = truncateText(s, 10);
    // 截断主体 ≤10 字节 + 后缀标记；总长可能因后缀略大于限制，但远小于原串
    expect(Buffer.from(out, 'utf8').length).toBeLessThan(Buffer.from(s, 'utf8').length);
    expect(out.endsWith('…(truncated)')).toBe(true);
  });
  it('should count UTF-8 bytes not chars', () => {
    const s = '中'.repeat(100); // 300 bytes UTF-8
    const out = truncateText(s, 10);
    // 截断主体 ≤10 字节（3 个中文字符）+ 后缀 15 字节
    const bodyBytes = Buffer.from(out.replace('…(truncated)', ''), 'utf8').length;
    expect(bodyBytes).toBeLessThanOrEqual(10);
  });
});

describe('sanitizeHeaders', () => {
  it('should strip Set-Cookie', () => {
    const out = sanitizeHeaders({ 'Content-Type': 'text/html', 'Set-Cookie': 'a=1' });
    expect(out.headers?.['Content-Type']).toBe('text/html');
    expect(out.headers?.['Set-Cookie']).toBeUndefined();
  });
  it('should truncate over byte limit', () => {
    const big = { 'X-Big': 'a'.repeat(20 * 1024) };
    const out = sanitizeHeaders(big);
    expect(out.truncated).toBe(true);
  });
  it('should return empty for undefined input', () => {
    expect(sanitizeHeaders(undefined)).toEqual({});
  });
});

describe('formatConsoleApiArgs', () => {
  it('should format primitive values', () => {
    expect(formatConsoleApiArgs([1, 'two', true])).toBe('1 two true');
  });
  it('should use description for objects', () => {
    expect(formatConsoleApiArgs([{ type: 'object', description: 'Error: boom' }])).toBe(
      'Error: boom',
    );
  });
  it('should show type placeholder when no description', () => {
    expect(formatConsoleApiArgs([{ type: 'function' }])).toBe('<function>');
  });
  it('should handle undefined', () => {
    expect(formatConsoleApiArgs([undefined])).toBe('undefined');
  });
});

describe('DevtoolsManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject internal page (urchin://)', () => {
    const dbg = createFakeDebugger();
    const tabs = [
      {
        id: 1,
        url: 'urchin://settings',
        title: 'Settings',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    const res = manager.attach(1);
    expect(res.state).toBe('unavailable');
    expect(res.reason).toBe('internal-page');
    expect(dbg.attached).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it('should reject genoffice tab', () => {
    const dbg = createFakeDebugger();
    const tabs = [
      {
        id: 2,
        url: 'urchin://genoffice/?kind=docs',
        title: 'doc.docx',
        viewKind: 'genoffice',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    const res = manager.attach(2);
    expect(res.state).toBe('unavailable');
    expect(res.reason).toBe('genoffice-tab');
  });

  it('should return unavailable(target-closed) for missing tab', () => {
    const { manager } = createManager([], new Map());
    const res = manager.attach(999);
    expect(res.state).toBe('unavailable');
    expect(res.reason).toBe('target-closed');
  });

  it('should attach successfully and emit state event', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 3,
        url: 'https://example.com',
        title: 'Example',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    const res = manager.attach(3);
    expect(res.state).toBe('attached');
    expect(res.target?.tabId).toBe(3);
    expect(dbg.attached).toBe(true);
    expect(notifications).toEqual([
      { type: 'state', tabId: 3, state: 'attached', target: { tabId: 3, title: 'Example' } },
    ]);
    // Network.enable / Runtime.enable / Log.enable 都被调用
    expect(dbg.sendCommandMock).toHaveBeenCalledWith('Network.enable', undefined);
    expect(dbg.sendCommandMock).toHaveBeenCalledWith('Runtime.enable', undefined);
    expect(dbg.sendCommandMock).toHaveBeenCalledWith('Log.enable', undefined);
  });

  it('should be idempotent on re-attach (already attached)', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 4,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(4);
    notifications.length = 0;
    const res = manager.attach(4); // 再次 attach
    expect(res.state).toBe('attached');
    expect(notifications).toHaveLength(0); // 不重复推 state
  });

  it('should reject when Electron debugger already attached', () => {
    const dbg = createFakeDebugger();
    dbg.attach(); // 模拟已被外部占用
    const tabs = [
      {
        id: 5,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    const res = manager.attach(5);
    expect(res.state).toBe('unavailable');
    expect(res.reason).toBe('already-attached');
  });

  it('should collect consoleAPICalled → console.append after flush', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 6,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(6);
    notifications.length = 0;
    dbg.emitMessage('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'hello' }],
      timestamp: 1.5,
    });
    dbg.emitMessage('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'boom' }],
      timestamp: 1.6,
    });
    expect(notifications).toHaveLength(0); // flush 前不推
    vi.advanceTimersByTime(200);
    expect(notifications).toHaveLength(1);
    const batch = notifications[0]!;
    expect(batch.type).toBe('console.append');
    const entries = (batch as unknown as { entries: { level: string; text: string }[] }).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.level).toBe('log');
    expect(entries[1]?.level).toBe('error');
  });

  it('should map exceptionThrown → console error entry', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 7,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(7);
    notifications.length = 0;
    dbg.emitMessage('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: x' } },
      timestamp: 2,
    });
    vi.advanceTimersByTime(200);
    const batch = notifications[0] as unknown as {
      entries: { level: string; source: string; text: string }[];
    };
    expect(batch.entries[0]?.level).toBe('error');
    expect(batch.entries[0]?.source).toBe('exception');
    expect(batch.entries[0]?.text).toBe('Error: x');
  });

  it('should map Log.entryAdded → console network/other source', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 8,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(8);
    notifications.length = 0;
    dbg.emitMessage('Log.entryAdded', {
      entry: { level: 'error', text: 'net err', source: 'network' },
      timestamp: 3,
    });
    vi.advanceTimersByTime(200);
    const batch = notifications[0] as unknown as { entries: { source: string; level: string }[] };
    expect(batch.entries[0]?.source).toBe('network');
  });

  it('should aggregate network 3-state evolution into one final entry per flush', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 9,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(9);
    notifications.length = 0;
    dbg.emitMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://a', method: 'GET' },
      wallTime: 1,
    });
    dbg.emitMessage('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, mimeType: 'text/html', headers: { 'Content-Type': 'text/html' } },
    });
    dbg.emitMessage('Network.loadingFinished', {
      requestId: 'r1',
      encodedDataLength: 1024,
      timestamp: 1.5,
    });
    vi.advanceTimersByTime(200);
    expect(notifications).toHaveLength(1);
    const batch = notifications[0] as unknown as {
      type: string;
      entries: { requestId: string; status?: number; size?: number }[];
    };
    expect(batch.type).toBe('network.batch');
    expect(batch.entries).toHaveLength(1); // 三次演进合并为一条
    expect(batch.entries[0]?.status).toBe(200);
    expect(batch.entries[0]?.size).toBe(1024);
  });

  it('should FIFO-evict network entries over capacity', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 10,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    manager.attach(10);
    // 1001 requests → evict 1
    for (let i = 0; i < 1001; i++) {
      dbg.emitMessage('Network.requestWillBeSent', {
        requestId: `r${i}`,
        request: { url: `https://${i}`, method: 'GET' },
        wallTime: 1,
      });
    }
    const list = manager.listNetwork(10);
    expect(list.entries).toHaveLength(1000);
    expect(list.dropped).toBe(1);
    // 最旧的 r0 被淘汰
    expect(list.entries.find((e) => e.requestId === 'r0')).toBeUndefined();
  });

  it('should flush pending before detach', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 11,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(11);
    notifications.length = 0;
    dbg.emitMessage('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'pre-detach' }],
      timestamp: 1,
    });
    manager.detach(11); // 应 flush 尾批
    // detach 推送顺序：console.append → state(detached)
    const types = notifications.map((n) => n.type);
    expect(types).toContain('console.append');
    expect(types).toContain('state');
    expect(types[types.length - 1]).toBe('state');
    const stateEvt = notifications[notifications.length - 1]!;
    expect(stateEvt.state).toBe('detached');
    expect(dbg.attached).toBe(false);
  });

  it('should emit unavailable on external detach (debugger preempted)', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 12,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(12);
    notifications.length = 0;
    dbg.emitDetach('canceled by user'); // 原生 DevTools 抢占
    const stateEvt = notifications.find((n) => n.type === 'state') as unknown as {
      state: string;
      reason?: string;
    };
    expect(stateEvt.state).toBe('unavailable');
    expect(stateEvt.reason).toBe('already-attached');
    expect(manager.status(12).state).toBe('detached'); // 会话已移除
  });

  it('should return empty for list on non-existent session', () => {
    const { manager } = createManager([], new Map());
    expect(manager.listNetwork(999)).toEqual({ entries: [], dropped: 0 });
    expect(manager.listConsole(999)).toEqual({ entries: [], dropped: 0 });
  });

  it('should clear network and emit cleared event', () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 13,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager, notifications } = createManager(tabs, new Map());
    manager.attach(13);
    dbg.emitMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://a', method: 'GET' },
      wallTime: 1,
    });
    notifications.length = 0;
    manager.clearNetwork(13);
    expect(notifications).toEqual([{ type: 'cleared', tabId: 13, scope: 'network' }]);
    expect(manager.listNetwork(13).entries).toHaveLength(0);
  });

  it('should evaluate successfully and return value', async () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: 42, type: 'number' } });
      }
      return Promise.resolve({});
    });
    const tabs = [
      {
        id: 14,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    manager.attach(14);
    const res = await manager.evaluate(14, '1+1');
    expect(res.ok).toBe(true);
    expect(res.result).toBe(42);
  });

  it('should return exception on evaluate failure', async () => {
    const dbg = createFakeDebugger();
    dbg.sendCommandMock.mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({
          exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } },
        });
      }
      return Promise.resolve({});
    });
    const tabs = [
      {
        id: 15,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    manager.attach(15);
    const res = await manager.evaluate(15, 'x');
    expect(res.ok).toBe(false);
    expect(res.exception).toContain('ReferenceError');
  });

  it('should return error when evaluating without attach', async () => {
    const { manager } = createManager([], new Map());
    const res = await manager.evaluate(999, '1');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not attached');
  });

  it('should truncate huge evaluate result', async () => {
    const dbg = createFakeDebugger();
    const huge = 'a'.repeat(300 * 1024);
    dbg.sendCommandMock.mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate')
        return Promise.resolve({ result: { value: huge, type: 'string' } });
      return Promise.resolve({});
    });
    const tabs = [
      {
        id: 16,
        url: 'https://x.test',
        title: 'X',
        viewKind: 'browser',
        webContents: { debugger: dbg },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    manager.attach(16);
    const res = await manager.evaluate(16, 'big');
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
  });

  it('should dispose all sessions on dispose()', () => {
    const dbg1 = createFakeDebugger();
    const dbg2 = createFakeDebugger();
    dbg1.sendCommandMock.mockResolvedValue({});
    dbg2.sendCommandMock.mockResolvedValue({});
    const tabs = [
      {
        id: 17,
        url: 'https://a.test',
        title: 'A',
        viewKind: 'browser',
        webContents: { debugger: dbg1 },
      },
      {
        id: 18,
        url: 'https://b.test',
        title: 'B',
        viewKind: 'browser',
        webContents: { debugger: dbg2 },
      },
    ];
    const { manager } = createManager(tabs, new Map());
    manager.attach(17);
    manager.attach(18);
    manager.dispose();
    expect(dbg1.attached).toBe(false);
    expect(dbg2.attached).toBe(false);
    expect(manager.status(17).state).toBe('detached');
    expect(manager.status(18).state).toBe('detached');
  });
});

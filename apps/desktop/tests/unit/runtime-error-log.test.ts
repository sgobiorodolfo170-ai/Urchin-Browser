/**
 * 渲染进程运行时错误日志 store（renderer/lib/runtime-error-log.ts）单元测试
 *
 * 覆盖：
 * 1. 采集器安装（幂等）与 console 透传
 * 2. 相同内容去重计数（ERROR / WARN 级别分离）
 * 3. Error 对象格式化（name/message/stack）
 * 4. window error / unhandledrejection 事件采集
 * 5. 条目上限裁剪（保留最新）
 * 6. 订阅通知（新增 / 去重计数变化 / 清空）
 * 7. useSyncExternalStore 快照稳定性（无变更同引用，有变更换引用）
 * 8. 完整日期时间戳（YYYY-MM-DD HH:mm:ss）
 * 9. localStorage 持久化（写入 / 去重计数同步 / 清空删除 / 模块重载恢复）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  clearErrorLogs,
  getErrorLogs,
  initRuntimeErrorLog,
  subscribeErrorLogs,
} from '../../src/renderer/lib/runtime-error-log';

beforeEach(() => {
  clearErrorLogs();
});

describe('runtime error log store', () => {
  it('should install the collector once (idempotent) and pass through to original console', () => {
    initRuntimeErrorLog();
    initRuntimeErrorLog(); // 重复安装不应重复包裹

    // 默认 spy 会透传到当前实现（即已安装的采集器包裹层）
    const spy = vi.spyOn(console, 'error');
    console.error('boom');
    expect(spy).toHaveBeenCalledWith('boom');
    spy.mockRestore();

    // 仅记录一条（没有被包裹两次）
    expect(getErrorLogs()).toHaveLength(1);
  });

  it('should deduplicate identical console.error messages and count occurrences', () => {
    initRuntimeErrorLog();
    console.error('boom');
    console.error('boom');
    console.error('boom');

    const logs = getErrorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'ERROR', message: 'boom', count: 3 });
  });

  it('should keep distinct messages as separate entries and separate by level', () => {
    initRuntimeErrorLog();
    console.error('boom');
    console.warn('boom'); // 同内容不同级别 → 独立条目
    console.error('boom2');

    const logs = getErrorLogs();
    expect(logs).toHaveLength(3);
    expect(logs.map((e) => [e.level, e.message])).toEqual([
      ['ERROR', 'boom'],
      ['WARN', 'boom'],
      ['ERROR', 'boom2'],
    ]);
  });

  it('should format Error objects with name, message and stack', () => {
    initRuntimeErrorLog();
    const err = new Error('something broke');
    console.error(err);

    const entry = getErrorLogs()[0]!;
    expect(entry.level).toBe('ERROR');
    expect(entry.message).toContain('Error: something broke');
    expect(entry.message).toContain('at ');
  });

  it('should capture window error events as UNCAUGHT', () => {
    initRuntimeErrorLog();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'render crashed',
        filename: 'app.ts',
        lineno: 42,
        colno: 7,
      }),
    );

    const logs = getErrorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe('UNCAUGHT');
    expect(logs[0]!.message).toContain('render crashed @ app.ts:42:7');
  });

  it('should capture unhandled promise rejections as REJECTION', () => {
    initRuntimeErrorLog();
    // 事件构造需要一个真实 rejected promise；挂 catch 标记为已处理，
    // 避免测试环境把它当作真正的未处理 rejection（仅构造用，不影响事件派发）
    const rejected = Promise.reject(new Error('async failed'));
    rejected.catch(() => {
      /* 仅标记为已处理，避免测试环境把它当作真正的未处理 rejection */
    });
    window.dispatchEvent(
      new PromiseRejectionEvent('unhandledrejection', {
        promise: rejected,
        reason: new Error('async failed'),
      }),
    );

    const logs = getErrorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe('REJECTION');
    expect(logs[0]!.message).toContain('Error: async failed');
  });

  it('should cap entries at the limit and keep the newest', () => {
    initRuntimeErrorLog();
    for (let i = 0; i < 205; i += 1) {
      console.error(`msg ${i}`);
    }

    const logs = getErrorLogs();
    expect(logs).toHaveLength(200);
    expect(logs[0]!.message).toBe('msg 5'); // 最旧的 5 条被裁掉
    expect(logs[logs.length - 1]!.message).toBe('msg 204');
  });

  it('should notify subscribers on append, dedup count change and clear', () => {
    initRuntimeErrorLog();
    const listener = vi.fn();
    const unsubscribe = subscribeErrorLogs(listener);

    console.error('dup');
    expect(listener).toHaveBeenCalledTimes(1);

    console.error('dup'); // 去重计数变化同样通知（快照引用变化，见下一测试）
    expect(listener).toHaveBeenCalledTimes(2);

    clearErrorLogs();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getErrorLogs()).toHaveLength(0);

    unsubscribe();
    console.error('after unsubscribe');
    expect(listener).toHaveBeenCalledTimes(3); // 退订后不再通知
  });

  it('should return a stable snapshot reference unless the log changes', () => {
    initRuntimeErrorLog();
    const before = getErrorLogs();
    expect(getErrorLogs()).toBe(before); // 无变更 → 同引用

    console.error('first');
    expect(getErrorLogs()).not.toBe(before); // 新增 → 换引用
    const afterAppend = getErrorLogs();

    console.error('first'); // 去重计数变化 → 也换引用（触发重渲染显示新次数）
    const afterDedup = getErrorLogs();
    expect(afterDedup).not.toBe(afterAppend);
    expect(afterDedup[0]!.count).toBe(2);
  });

  // ===== 日期时间 + 持久化 =====

  const STORAGE_KEY = 'urchin.debug.runtimeErrorLogs';

  it('should stamp entries with a full date-time', () => {
    initRuntimeErrorLog();
    console.error('stamp me');

    const entry = getErrorLogs()[0]!;
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('should persist appended entries to localStorage', () => {
    initRuntimeErrorLog();
    console.error('persist me');

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as {
      level: string;
      message: string;
      count: number;
      time: string;
    }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ level: 'ERROR', message: 'persist me', count: 1 });
    expect(saved[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('should persist dedup count changes', () => {
    initRuntimeErrorLog();
    console.error('dup persist');
    console.error('dup persist');

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { count: number }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.count).toBe(2);
  });

  it('should remove persisted logs when cleared', () => {
    initRuntimeErrorLog();
    console.error('to be cleared');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    clearErrorLogs();
    expect(getErrorLogs()).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('should restore persisted entries on module reload (restart)', async () => {
    initRuntimeErrorLog();
    console.error('restart survivor');
    expect(getErrorLogs()).toHaveLength(1);

    // 模拟重启：重置模块注册表后重新导入，store 应从 localStorage 恢复。
    // 放在最后：resetModules 会创建新模块实例，后续测试仍绑定原实例（见 beforeEach 说明）。
    vi.resetModules();
    const fresh = await import('../../src/renderer/lib/runtime-error-log');

    const restored = fresh.getErrorLogs();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.message).toBe('restart survivor');
    expect(restored[0]!.count).toBe(1);
    expect(restored[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

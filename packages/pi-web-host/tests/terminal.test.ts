/**
 * terminal.ts 单元测试
 *
 * 仅覆盖空状态：listTerminals / disposeAllTerminals。
 * createTerminal 需要 node-pty 真实 spawn，CI 中 flaky，留待 P4 mock 测试。
 * node-pty 被 mock 为空桩，避免原生模块加载；空状态操作不依赖 spawn。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { listTerminals, disposeAllTerminals } from '../src/terminal';

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

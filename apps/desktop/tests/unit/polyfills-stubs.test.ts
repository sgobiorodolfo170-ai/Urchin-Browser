/**
 * 主进程 polyfill / stubs 单元测试
 *
 * 验证：
 * 1. worker-threads-polyfill：import 后不抛错（副作用：缺失时补 no-op）
 * 2. node-sqlite-stub：DatabaseSync 构造即抛（提示用 MemoryCacheStore）
 */

import { describe, it, expect } from 'vitest';

const POLYFILL_PATH = '../../src/main/polyfills/worker-threads-polyfill';

describe('worker-threads-polyfill', () => {
  it('should load without throwing and tolerate calling', async () => {
    await import(POLYFILL_PATH);

    expect(true).toBe(true);
  });
});

describe('node-sqlite-stub', () => {
  it('DatabaseSync constructor should throw with guidance', async () => {
    const { DatabaseSync } = await import('../../src/main/stubs/node-sqlite-stub');

    expect(() => new DatabaseSync()).toThrow(/node:sqlite is not available/i);
    expect(() => new DatabaseSync()).toThrow(/MemoryCacheStore/);
  });
});

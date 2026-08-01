/**
 * SQLite 数据库工厂单元测试
 *
 * 验证：
 * 1. createSqliteDatabase 创建 IDatabase 实例
 * 2. prepare/all/get/run 委托 better-sqlite3
 * 3. exec/pragma/transaction/close 委托正确
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStmt = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  prepare: vi.fn().mockReturnValue(mockStmt),
  exec: vi.fn(),
  pragma: vi.fn(),
  transaction: vi.fn().mockImplementation((fn: () => unknown) => fn),
  close: vi.fn(),
}));

const mockConstructor = vi.hoisted(() => vi.fn().mockReturnValue(mockDb));

vi.mock('better-sqlite3', () => ({
  default: mockConstructor,
}));

import { createSqliteDatabase } from '../../src/main/storage/sqlite-factory';

describe('createSqliteDatabase', () => {
  let db: ReturnType<typeof createSqliteDatabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createSqliteDatabase(':memory:');
  });

  it('should create a database with provided path', () => {
    expect(mockConstructor).toHaveBeenCalledWith(':memory:');
  });

  it('prepare should delegate to underlying db', () => {
    const stmt = db.prepare('SELECT 1');
    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT 1');
    expect(stmt).toBeDefined();
  });

  it('statement.all should delegate', () => {
    const stmt = db.prepare('SELECT ? AS v');
    mockStmt.all.mockReturnValue([{ v: 1 }, { v: 2 }]);
    const result = stmt.all(1);
    expect(mockStmt.all).toHaveBeenCalledWith(1);
    expect(result).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('statement.get should delegate', () => {
    const stmt = db.prepare('SELECT ? AS v');
    mockStmt.get.mockReturnValue({ v: 42 });
    const result = stmt.get(42);
    expect(mockStmt.get).toHaveBeenCalledWith(42);
    expect(result).toEqual({ v: 42 });
  });

  it('statement.run should delegate and return changes', () => {
    const stmt = db.prepare('INSERT INTO t VALUES(?)');
    mockStmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 100 });
    const result = stmt.run('x');
    expect(mockStmt.run).toHaveBeenCalledWith('x');
    expect(result).toEqual({ changes: 1, lastInsertRowid: 100 });
  });

  it('exec should delegate', () => {
    db.exec('CREATE TABLE t (id INTEGER)');
    expect(mockDb.exec).toHaveBeenCalledWith('CREATE TABLE t (id INTEGER)');
  });

  it('pragma should delegate', () => {
    db.pragma('journal_mode = WAL');
    expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
  });

  it('transaction should delegate and return function', () => {
    const fn = () => 42;
    db.transaction(fn);
    expect(mockDb.transaction).toHaveBeenCalledWith(fn);
  });

  it('close should delegate', () => {
    db.close();
    expect(mockDb.close).toHaveBeenCalled();
  });
});

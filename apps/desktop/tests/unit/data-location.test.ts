/**
 * M8 Storage Layer · 数据目录定位与迁移单元测试
 *
 * 验证 DD1 决策：
 * 1. 无指针 → 默认 <defaultRoot>/data
 * 2. 指针无迁移标记 → 直接返回目标目录
 * 3. 指针带迁移标记 → 整体复制迁移 + 清理源 + 清标记
 * 4. setDataLocation → 写指针 { path, migrateFrom }
 * 5. migrateLegacyPiData → 旧 data/ai.db、data/secrets、data/providers → userData/pi
 * 6. migrateLegacySummaries → 旧 userData/summaries → <dataDir>/summaries
 * 7. 无指针且旧 userData/data 已有数据 → 整体迁入新默认后清理
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDataLocation,
  setDataLocation,
  migrateLegacyPiData,
  migrateLegacySummaries,
  PI_DIR_NAME,
} from '../../src/main/storage/data-location';

describe('data-location', () => {
  let userDataPath: string;
  let defaultRoot: string;
  let dataDir: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'urchin-dataloc-test-'));
    defaultRoot = mkdtempSync(join(tmpdir(), 'urchin-dataloc-root-'));
    dataDir = '';
  });

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(defaultRoot, { recursive: true, force: true });
    if (dataDir && dataDir !== userDataPath && dataDir !== defaultRoot) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should resolve default data dir under defaultRoot when no pointer exists', () => {
    const resolved = resolveDataLocation(userDataPath, defaultRoot);
    expect(resolved).toBe(join(defaultRoot, 'data'));
    expect(existsSync(resolved)).toBe(true);
  });

  it('should follow pointer path without migrating when no migrateFrom', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-dataloc-custom-'));
    const pointer = join(userDataPath, 'data-location.json');
    writeFileSync(pointer, JSON.stringify({ path: dataDir }));
    expect(resolveDataLocation(userDataPath, defaultRoot)).toBe(dataDir);
  });

  it('should copy old dir to new path and clear migrateFrom on resolve', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'urchin-dataloc-old-'));
    writeFileSync(join(oldDir, 'urchin.db'), 'fake-db-content');
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-dataloc-new-'));
    const newDir = join(dataDir, 'nested');
    const pointer = join(userDataPath, 'data-location.json');
    writeFileSync(pointer, JSON.stringify({ path: newDir, migrateFrom: oldDir }));

    const resolved = resolveDataLocation(userDataPath, defaultRoot);
    expect(resolved).toBe(newDir);
    expect(existsSync(join(newDir, 'urchin.db'))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
    const after = JSON.parse(readFileSync(pointer, 'utf8')) as {
      path: string;
      migrateFrom?: string;
    };
    expect(after.path).toBe(newDir);
    expect(after.migrateFrom).toBeUndefined();
  });

  it('should migrate legacy default userData/data into new default when it has data', () => {
    const legacy = join(userDataPath, 'data');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'urchin.db'), 'legacy-db');

    const resolved = resolveDataLocation(userDataPath, defaultRoot);
    expect(resolved).toBe(join(defaultRoot, 'data'));
    expect(existsSync(join(defaultRoot, 'data', 'urchin.db'))).toBe(true);
    // 旧目录已清理
    expect(existsSync(legacy)).toBe(false);
  });

  it('should not migrate legacy default when new default already exists', () => {
    const legacy = join(userDataPath, 'data');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'urchin.db'), 'legacy-db');
    const newDefault = join(defaultRoot, 'data');
    mkdirSync(newDefault, { recursive: true });
    writeFileSync(join(newDefault, 'urchin.db'), 'new-db');

    const resolved = resolveDataLocation(userDataPath, defaultRoot);
    expect(resolved).toBe(newDefault);
    // 新默认保留，旧目录不清理（避免覆盖新数据）
    expect(readFileSync(join(newDefault, 'urchin.db'), 'utf8')).toBe('new-db');
    expect(existsSync(legacy)).toBe(true);
  });

  it('setDataLocation should write pointer with migrateFrom = current dir', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-dataloc-set-'));
    const current = resolveDataLocation(userDataPath, defaultRoot);
    setDataLocation(userDataPath, current, dataDir);

    const pointer = join(userDataPath, 'data-location.json');
    const file = JSON.parse(readFileSync(pointer, 'utf8')) as {
      path: string;
      migrateFrom: string;
    };
    expect(file.path).toBe(dataDir);
    expect(file.migrateFrom).toBe(current);
    expect(existsSync(dataDir)).toBe(true);
  });

  it('setDataLocation should reject empty or relative paths', () => {
    const current = resolveDataLocation(userDataPath, defaultRoot);
    expect(() => setDataLocation(userDataPath, current, '')).toThrow(/empty/i);
    expect(() => setDataLocation(userDataPath, current, 'relative/path')).toThrow(/absolute/i);
  });

  it('migrateLegacyPiData should move ai/secrets/providers to pi dir', () => {
    const oldData = join(userDataPath, 'data');
    mkdirSync(join(oldData, 'secrets'), { recursive: true });
    mkdirSync(join(oldData, 'providers'), { recursive: true });
    writeFileSync(join(oldData, 'ai.db'), 'ai-db');
    writeFileSync(join(oldData, 'secrets', 'ai_apiKey.enc'), 'enc');
    writeFileSync(join(oldData, 'providers', 'p1.db'), 'p1');

    migrateLegacyPiData(userDataPath);

    const piDir = join(userDataPath, PI_DIR_NAME);
    expect(existsSync(join(piDir, 'ai.db'))).toBe(true);
    expect(existsSync(join(piDir, 'secrets', 'ai_apiKey.enc'))).toBe(true);
    expect(existsSync(join(piDir, 'providers', 'p1.db'))).toBe(true);
    expect(existsSync(join(oldData, 'ai.db'))).toBe(false);
    // 主数据（urchin.db 等）不受影响
    expect(existsSync(oldData)).toBe(true);
  });

  it('migrateLegacySummaries should move userData/summaries into data dir', () => {
    mkdirSync(join(userDataPath, 'summaries'), { recursive: true });
    writeFileSync(join(userDataPath, 'summaries', 'doc.html'), '<html/>');

    const dataDirPath = join(defaultRoot, 'data');
    mkdirSync(dataDirPath, { recursive: true });
    migrateLegacySummaries(userDataPath, dataDirPath);

    expect(existsSync(join(dataDirPath, 'summaries', 'doc.html'))).toBe(true);
    expect(existsSync(join(userDataPath, 'summaries'))).toBe(false);
  });
});

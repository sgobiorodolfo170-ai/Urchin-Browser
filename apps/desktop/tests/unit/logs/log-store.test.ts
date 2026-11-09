/**
 * 运行日志落盘/读取单元测试（设置 → 运行日志）
 *
 * 覆盖：
 * - 落点注册后 createLogger 输出自动写入 JSONL，readLogs 新 → 旧返回；
 * - 级别筛选与关键词筛选（module/message/meta）；
 * - 损坏行跳过（进程崩溃时可能写半行）；
 * - getLogsInfo 返回目录/当前文件/文件列表；
 * - 历史文件裁剪只保留最近 7 个；
 * - addLogSink 注销后不再收到条目。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLogSink, createLogger } from '@urchin/logger';
import {
  __resetLogFileForTest,
  getLogsInfo,
  initLogFile,
  readLogs,
} from '../../../src/main/logs/log-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'urchin-logs-test-'));
  __resetLogFileForTest();
});

afterEach(() => {
  __resetLogFileForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('log-store', () => {
  it('should persist createLogger output and read newest first', () => {
    initLogFile(dir);
    const log = createLogger('unit-log');
    log.info('first message', { step: 1 });
    log.error('second message');

    const res = readLogs({ limit: 10 });
    expect(res.dir).toBe(dir);
    expect(res.currentFile).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log$/);
    // 最后一条应排在最前（新 → 旧）
    expect(res.entries[0]?.message).toBe('second message');
    expect(res.entries[0]?.level).toBe('ERROR');
    expect(res.entries.some((e) => e.message === 'first message')).toBe(true);
  });

  it('should filter by level and by keyword across module/message/meta', () => {
    initLogFile(dir);
    const log = createLogger('filter-target');
    log.info('info entry', { tag: 'alpha' });
    log.error('error entry', { tag: 'beta' });

    const errors = readLogs({ level: 'ERROR' });
    expect(errors.entries.every((e) => e.level === 'ERROR')).toBe(true);
    expect(errors.entries.some((e) => e.message === 'error entry')).toBe(true);

    const byModule = readLogs({ query: 'filter-target' });
    expect(byModule.entries.length).toBeGreaterThanOrEqual(2);

    const byMeta = readLogs({ query: 'beta' });
    expect(byMeta.entries.every((e) => JSON.stringify(e.meta ?? {}).includes('beta'))).toBe(true);

    const byMessage = readLogs({ query: 'INFO ENTRY' });
    expect(byMessage.entries.some((e) => e.message === 'info entry')).toBe(true);
  });

  it('should skip corrupted jsonl lines instead of failing the read', () => {
    initLogFile(dir);
    createLogger('corrupt').info('valid line');
    const info = getLogsInfo();
    appendFileSync(join(dir, info.currentFile), '{"timestamp":"broken"\n', 'utf8');

    const res = readLogs({ query: 'valid line' });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]?.message).toBe('valid line');
  });

  it('should report log directory info and current file', () => {
    initLogFile(dir);
    createLogger('info-test').info('entry');

    const info = getLogsInfo();
    expect(info.dir).toBe(dir);
    expect(info.files.some((f) => f.name === info.currentFile)).toBe(true);
    const current = info.files.find((f) => f.name === info.currentFile);
    expect(current?.size).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(current?.modifiedAt ?? ''))).toBe(false);
  });

  it('should keep at most 7 log files (prune oldest on init)', () => {
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      const name = `app-2020-01-0${i}.log`;
      writeFileSync(join(dir, name), '{}\n', 'utf8');
    }
    initLogFile(dir);
    const files = readdirSync(dir).filter((n) => n.startsWith('app-') && n.endsWith('.log'));
    expect(files.length).toBeLessThanOrEqual(7);
  });

  it('should stop forwarding after sink disposal', () => {
    const seen: string[] = [];
    const dispose = addLogSink((entry) => seen.push(entry.message));
    createLogger('sink-a').info('before dispose');
    dispose();
    createLogger('sink-b').info('after dispose');
    expect(seen).toContain('before dispose');
    expect(seen).not.toContain('after dispose');
  });
});

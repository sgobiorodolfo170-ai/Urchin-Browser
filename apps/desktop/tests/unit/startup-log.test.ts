/**
 * 启动耗时打点单元测试（启动优化 B5）。
 *
 * 验证：init 前打点静默、init 后 JSONL 逐行追加（mark 顺序保留）、
 * 非法路径 init 静默降级不抛、日志行不含内容字段（仅固定标签与时间）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initStartupLog, markStartup } from '../../src/main/startup-log';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-startup-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('startup-log', () => {
  it('should stay silent before init', () => {
    // 未 init：打点不得抛错、不得创建任何文件（路径参数不存在于本用例）
    expect(() => markStartup('early:boot')).not.toThrow();
  });

  it('should append JSONL marks in order after init', () => {
    const dir = makeTempDir();

    initStartupLog(dir);
    markStartup('main:boot');
    markStartup('main:ready');

    const lines = readFileSync(join(dir, 'logs', 'startup.log'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as { mark: string; elapsedMs: number; uptimeMs: number };
    const second = JSON.parse(lines[1]!) as { mark: string; elapsedMs: number };
    expect(first.mark).toBe('main:boot');
    expect(second.mark).toBe('main:ready');
    expect(first.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(first.uptimeMs).toBeGreaterThanOrEqual(0);
    // 隐私：行内仅固定字段（无 URL/标题/内容类字段）
    expect(Object.keys(first).sort()).toEqual(['elapsedMs', 'mark', 'pid', 'uptimeMs']);
  });

  it('should degrade silently when init path is not creatable', () => {
    // 父路径被文件占据 → mkdirSync 抛 ENOTDIR/EEXIST；init 必须静默降级
    const filePath = join(makeTempDir(), 'not-a-dir');
    writeFileSync(filePath, 'occupied', 'utf8');
    initStartupLog(filePath);

    expect(() => markStartup('main:boot')).not.toThrow();
  });
});

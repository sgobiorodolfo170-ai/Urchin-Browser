/**
 * 更新前 MAX_PATH 自卫单元测试（2026-11-10 dev.175 自动更新失败事故）
 *
 * 覆盖：
 * - stagingTargetLength 纯函数：暂存目标 = TEMP 前缀 + NSIS 暂存后缀 + 相对路径
 * - precleanLongPaths：越界文件就地改短名（内容保留）、短路径文件不动、
 *   非 win32 平台整体跳过、二次执行幂等
 *
 * 阈值推导见 src/main/update/long-path-guard.ts 头注释（259 - TEMP - 暂存后缀）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { precleanLongPaths, stagingTargetLength } from '../../src/main/update/long-path-guard';

/** 假 TEMP：长度固定便于精确构造越界/不越界两档路径。 */
const FAKE_TMP = 'C:\\Users\\tester\\AppData\\Local\\Temp';

function makeFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'urchin-lp-'));
}

/** 构造 rel 长度恰为 len 的文件（返回相对 instDir 的路径）。 */
function makeFileWithRelLength(instDir: string, len: number): string {
  // rel 形如 '\\dir\\<name>'；dirname 固定 6 字符（\dir\），余下给文件名
  const dir = 'dir';
  const nameLen = len - 1 - dir.length - 1; // 前导 \ + dir + \ + name
  const name = 'f'.repeat(Math.max(nameLen - 4, 1)) + '.md';
  fs.mkdirSync(path.join(instDir, dir), { recursive: true });
  const full = path.join(instDir, dir, name);
  fs.writeFileSync(full, 'content');
  return '\\' + dir + '\\' + name;
}

describe('long-path-guard', () => {
  let instDir: string;

  beforeEach(() => {
    instDir = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(instDir, { recursive: true, force: true });
  });

  it('should compute staging target length as tmpDir + suffix + rel', () => {
    const rel = '\\resources\\app.asar.unpacked\\x.md';
    const suffixLen = '\\nsXXXXXX.tmp\\old-install'.length;
    expect(stagingTargetLength(FAKE_TMP, rel)).toBe(FAKE_TMP.length + suffixLen + rel.length);
  });

  it('should rename over-limit file in place and keep content intact', () => {
    // 构造使暂存目标恰为 261（>259 越界）
    const suffixLen = '\\nsXXXXXX.tmp\\old-install'.length;
    const relLen = 261 - FAKE_TMP.length - suffixLen;
    const rel = makeFileWithRelLength(instDir, relLen);
    const before = path.join(instDir, rel.slice(1));

    const result = precleanLongPaths(instDir, FAKE_TMP, 'win32');

    expect(result.renamed).toEqual([rel]);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(before)).toBe(false);
    // 短名同目录、内容保留
    const shortPath = path.join(path.dirname(before), 'lp-0.md');
    expect(fs.existsSync(shortPath)).toBe(true);
    expect(fs.readFileSync(shortPath, 'utf8')).toBe('content');
  });

  it('should leave under-limit files untouched', () => {
    const suffixLen = '\\nsXXXXXX.tmp\\old-install'.length;
    const relLen = 259 - FAKE_TMP.length - suffixLen; // 恰好 259，不越界
    const rel = makeFileWithRelLength(instDir, relLen);
    const full = path.join(instDir, rel.slice(1));

    const result = precleanLongPaths(instDir, FAKE_TMP, 'win32');

    expect(result.renamed).toEqual([]);
    expect(fs.existsSync(full)).toBe(true);
  });

  it('should skip entirely on non-win32 platform', () => {
    const suffixLen = '\\nsXXXXXX.tmp\\old-install'.length;
    const rel = makeFileWithRelLength(instDir, 261 - FAKE_TMP.length - suffixLen);
    const full = path.join(instDir, rel.slice(1));

    const result = precleanLongPaths(instDir, FAKE_TMP, 'darwin');

    expect(result.skippedPlatform).toBe(true);
    expect(result.renamed).toEqual([]);
    expect(fs.existsSync(full)).toBe(true);
  });

  it('should be idempotent on second run', () => {
    const suffixLen = '\\nsXXXXXX.tmp\\old-install'.length;
    makeFileWithRelLength(instDir, 261 - FAKE_TMP.length - suffixLen);

    const first = precleanLongPaths(instDir, FAKE_TMP, 'win32');
    const second = precleanLongPaths(instDir, FAKE_TMP, 'win32');

    expect(first.renamed.length).toBe(1);
    expect(second.renamed).toEqual([]);
  });
});

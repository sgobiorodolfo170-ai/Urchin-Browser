/**
 * 便携版（Portable）模式检测单元测试
 *
 * 验证：
 * 1. exe 同级存在 portable.dat → 返回 <exeDir>/userdata
 * 2. 无 portable.dat → 返回 null（保持默认 userData）
 * 3. 标记文件与 exe 目录无关（仅同级检测）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PORTABLE_MARKER,
  PORTABLE_USER_DATA_DIR,
  portableMarkerPath,
  resolvePortableUserData,
} from '../../src/main/portable';

describe('portable mode detection', () => {
  let execDir: string;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'urchin-portable-test-'));
  });

  afterEach(() => {
    rmSync(execDir, { recursive: true, force: true });
  });

  it('should return userData dir under exe dir when portable.dat exists', () => {
    const execPath = join(execDir, 'Urchin Browser.exe');
    writeFileSync(join(execDir, PORTABLE_MARKER), '');
    expect(resolvePortableUserData(execPath)).toBe(join(execDir, PORTABLE_USER_DATA_DIR));
  });

  it('should return null when portable.dat does not exist', () => {
    const execPath = join(execDir, 'Urchin Browser.exe');
    expect(resolvePortableUserData(execPath)).toBeNull();
  });

  it('should build marker path as <exeDir>/portable.dat', () => {
    const execPath = join(execDir, 'sub', 'Urchin Browser.exe');
    expect(portableMarkerPath(execPath)).toBe(join(execDir, 'sub', PORTABLE_MARKER));
  });

  it('should detect marker regardless of other files present', () => {
    const execPath = join(execDir, 'Urchin Browser.exe');
    writeFileSync(join(execDir, 'data-location.json'), '{"path":"x"}');
    writeFileSync(join(execDir, PORTABLE_MARKER), '');
    expect(resolvePortableUserData(execPath)).toBe(join(execDir, PORTABLE_USER_DATA_DIR));
  });
});

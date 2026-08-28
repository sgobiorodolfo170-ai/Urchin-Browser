/**
 * pi UI 状态持久化单元测试（dev.67）
 *
 * 覆盖 urchin://pi-ui-state 的纯函数面：
 * 1. parseUiStateQuery：宽度钳制（180–520）、非法值拒绝、折叠开关、
 *    项目排序数组清洗（去重/上限/类型）
 * 2. readUiStateFile：缺失/损坏 JSON → {}（读端点永不抛）
 * 3. buildUiStateResponse：Referer 白名单（403 拒远程）、a=set 合并写入、
 *    读端点返回落盘内容
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUiStateQuery,
  readUiStateFile,
  buildUiStateResponse,
} from '../../src/main/pi-web/ui-state';

describe('parseUiStateQuery', () => {
  it('should parse widths with clamping to 180..520', () => {
    expect(parseUiStateQuery('?lw=280')).toEqual({ lw: 280 });
    expect(parseUiStateQuery('?rw=120')).toEqual({ rw: 180 });
    expect(parseUiStateQuery('?lw=9999')).toEqual({ lw: 520 });
    expect(parseUiStateQuery('?lw=abc')).toEqual({});
    expect(parseUiStateQuery('?lw=')).toEqual({});
  });

  it('should parse collapse flags only as 1/0', () => {
    expect(parseUiStateQuery('?lc=1&rc=0')).toEqual({ lc: true, rc: false });
    expect(parseUiStateQuery('?lc=true')).toEqual({});
  });

  it('should sanitize project order arrays', () => {
    expect(
      parseUiStateQuery('?po=' + encodeURIComponent(JSON.stringify(['C:/a', 'C:/b']))),
    ).toEqual({
      po: ['C:/a', 'C:/b'],
    });
    // 去重 + 非字符串过滤 + 空串过滤
    expect(
      parseUiStateQuery('?po=' + encodeURIComponent(JSON.stringify(['C:/a', 'C:/a', 3, '']))),
    ).toEqual({ po: ['C:/a'] });
    // 非数组拒绝
    expect(parseUiStateQuery('?po=' + encodeURIComponent('"C:/a"'))).toEqual({});
    expect(parseUiStateQuery('?po=not-json')).toEqual({});
  });
});

describe('readUiStateFile', () => {
  it('should return empty object for missing or corrupt file', () => {
    expect(readUiStateFile(join(tmpdir(), 'urchin-no-such-ui-state.json'))).toEqual({});
  });
});

describe('buildUiStateResponse', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'urchin-ui-state-'));
    file = join(dir, 'ui-state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should reject untrusted referers with 403', async () => {
    const res = await buildUiStateResponse(
      'https://evil.example.com/x',
      'urchin://pi-ui-state?a=set&lw=300',
      file,
    );
    expect(res.status).toBe(403);
  });

  it('should accept localhost / urchin / empty referers', async () => {
    for (const ref of ['', 'urchin://settings/', 'http://127.0.0.1:12345/']) {
      const res = await buildUiStateResponse(ref, 'urchin://pi-ui-state', file);
      expect(res.status).toBe(200);
    }
  });

  it('should merge and persist set queries, then read them back', async () => {
    const set = await buildUiStateResponse(
      'http://127.0.0.1:1/',
      'urchin://pi-ui-state?a=set&lw=300&rc=1&po=' +
        encodeURIComponent(JSON.stringify(['C:/a', 'C:/b'])),
      file,
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true });

    const read = await buildUiStateResponse('http://127.0.0.1:1/', 'urchin://pi-ui-state', file);
    expect(await read.json()).toEqual({ lw: 300, rc: true, po: ['C:/a', 'C:/b'] });

    // 增量合并：只传 rw 不清掉已有 lc/po
    await buildUiStateResponse(
      'http://127.0.0.1:1/',
      'urchin://pi-ui-state?a=set&rw=260&lc=0',
      file,
    );
    const read2 = await buildUiStateResponse('http://127.0.0.1:1/', 'urchin://pi-ui-state', file);
    expect(await read2.json()).toEqual({
      lw: 300,
      rw: 260,
      lc: false,
      rc: true,
      po: ['C:/a', 'C:/b'],
    });
  });

  it('should return {} for read before any write', async () => {
    const res = await buildUiStateResponse('', 'urchin://pi-ui-state', file);
    expect(await res.json()).toEqual({});
  });

  it('should survive a corrupt existing file on write', async () => {
    writeFileSync(file, '{corrupt', 'utf-8');
    const set = await buildUiStateResponse('', 'urchin://pi-ui-state?a=set&lw=220', file);
    expect(set.status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ lw: 220 });
  });
});

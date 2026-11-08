/**
 * session-scan.ts 单元测试
 *
 * 覆盖三块：
 * 1. BinaryStringFilter：丢弃 `"data": "..."` 巨型内联图片负载，且与逐字符参考实现逐字节等价；
 * 2. sessionLines：分块 / CRLF / 无结尾换行 / 取消语义 / 事件循环让出；
 * 3. mapSessionsConcurrent：并发上限、结果顺序、参数校验与取消传播。
 *
 * 全部离线：fixture 写在 mkdtempSync 临时目录。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import {
  BinaryStringFilter,
  mapSessionsConcurrent,
  sessionLines,
} from '../../src/pi-server/session-scan.js';

const dirs: string[] = [];

function tempFile(content: string, name = 'session.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-web-host-scan-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 逐字符参考实现：用于证明跳跃式实现语义等价（保留原实现的全部边界行为）。 */
class LegacyBinaryStringFilter {
  private inString = false;
  private escaped = false;
  private token = '';
  private dataKey = false;
  private awaitingValue = false;
  private discard = false;

  push(chunk: string): string {
    const output: string[] = [];
    for (const char of chunk) {
      if (char === '\n') {
        this.inString = false;
        this.escaped = false;
        this.discard = false;
      }
      if (this.inString) {
        if (!this.discard) output.push(char);
        if (this.escaped) {
          this.escaped = false;
          if (this.token.length < 16) this.token += char;
        } else if (char === '\\') {
          this.escaped = true;
          if (this.token.length < 16) this.token += char;
        } else if (char === '"') {
          this.inString = false;
          if (this.discard) output.push(char);
          try {
            this.dataKey = JSON.parse('"' + this.token + '"') === 'data';
          } catch {
            this.dataKey = false;
          }
          this.discard = false;
        } else if (this.token.length < 16) this.token += char;
        continue;
      }
      output.push(char);
      if (char === '"') {
        this.inString = true;
        this.token = '';
        this.discard = this.awaitingValue;
        this.awaitingValue = false;
        this.dataKey = false;
      } else if (!/\s/.test(char)) {
        this.awaitingValue = char === ':' && this.dataKey;
        this.dataKey = false;
      }
      if (char === '\n') {
        this.dataKey = false;
        this.awaitingValue = false;
      }
    }
    return output.join('');
  }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRecord(r: () => number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const text = () =>
    Array.from({ length: Math.floor(r() * 12) }, () =>
      pick([
        'a',
        ' ',
        '\\"',
        '\\\\',
        '\\n',
        'data',
        '"',
        ':',
        '中',
        '😀',
        '\t',
        '\\u0064ata',
        '{',
        '}',
      ]),
    ).join('');
  const value = () =>
    pick([
      () => JSON.stringify(text()),
      () => `"${'QUJD'.repeat(Math.floor(r() * 50))}"`,
      () => String(Math.floor(r() * 1e6)),
      () => 'null',
      () => `{"data": ${JSON.stringify(text())}}`,
    ])();
  const keys = ['data', 'text', 'type', 'd\\u0061ta', 'id', 'dat', 'datas', 'x'];
  const fields = Array.from({ length: 1 + Math.floor(r() * 5) }, () => {
    const k = pick(keys);
    const sp = pick(['', ' ', '  ', '\t']);
    return `"${k}"${sp}:${sp}${value()}`;
  });
  let line = `{${fields.join(',')}}`;
  if (r() < 0.1) line = line.slice(0, Math.floor(r() * line.length));
  return line;
}

function runFilter(F: new () => { push(s: string): string }, chunks: string[]): string {
  const f = new F();
  return chunks.map((c) => f.push(c)).join('');
}

describe('BinaryStringFilter', () => {
  it('should drop data string values while keeping the rest of the line intact', () => {
    const line =
      '{"type":"image","data":"AAAA\\"BBB","text":"keep \\"data\\": x","nested":{"data":"ZZZ"}}\n';
    expect(new BinaryStringFilter().push(line)).toBe(
      '{"type":"image","data":"","text":"keep \\"data\\": x","nested":{"data":""}}\n',
    );
  });

  it('should treat an escaped unicode spelling of the data key as the data key', () => {
    const line = '{"d\\u0061ta":"PAYLOAD","type":"x"}\n';
    expect(new BinaryStringFilter().push(line)).toBe('{"d\\u0061ta":"","type":"x"}\n');
  });

  it('should match the character-wise legacy filter on 600 randomized chunkings', () => {
    let discarded = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const input = Array.from({ length: 1 + Math.floor(r() * 6) }, () => randomRecord(r)).join(
        r() < 0.5 ? '\n' : '\r\n',
      );
      const chunks: string[] = [];
      let i = 0;
      while (i < input.length) {
        const len = 1 + Math.floor(r() * 40);
        chunks.push(input.slice(i, i + len));
        i += len;
      }
      const expected = runFilter(LegacyBinaryStringFilter, chunks);
      const got = runFilter(BinaryStringFilter, chunks);
      if (expected.length < input.length) discarded++;
      expect(got, `seed=${seed} input=${input}`).toBe(expected);
    }
    // 抽样有效性自检：至少一部分样本确实触发了 data 值丢弃。
    expect(discarded).toBeGreaterThan(150);
  });
});

describe('sessionLines', () => {
  const header = { type: 'session', id: 'test', cwd: '/workspace' };
  const headerLine = JSON.stringify(header);
  const message = (role: string, content: unknown, timestamp?: number) => ({
    type: 'message',
    message: { role, content, timestamp },
  });

  it('should yield UTF-8 lines across chunks with CRLF and an unterminated final record', async () => {
    const file = tempFile(
      headerLine + '\r\n' + JSON.stringify(message('user', `${'界'.repeat(24000)}尾部检索`, 9)),
    );
    const lines: string[] = [];
    for await (const line of sessionLines(file)) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(headerLine);
    expect(lines[1]).toContain('尾部检索');
    const parsedTail = JSON.parse(lines[1]) as { message: { timestamp: number } };
    expect(parsedTail.message.timestamp).toBe(9);
  });

  it('should drop huge inline image data while preserving neighbouring text', async () => {
    const file = tempFile(
      [
        headerLine,
        JSON.stringify(
          message(
            'user',
            [
              { type: 'image', data: 'a'.repeat(3 * 1024 * 1024), mimeType: 'image/png' },
              { type: 'text', text: 'quoted \\" data: needle 中文' },
            ],
            8,
          ),
        ),
        JSON.stringify(message('assistant', 'needle', 9)),
      ].join('\n'),
    );
    let longest = 0;
    const parsed: unknown[] = [];
    for await (const line of sessionLines(file)) {
      longest = Math.max(longest, line.length);
      parsed.push(JSON.parse(line));
    }
    expect(longest).toBeLessThan(1024);
    expect(parsed).toHaveLength(3);
    const first = parsed[1] as { message: { content: { type: string; text?: string }[] } };
    expect(first.message.content[1].text).toBe('quoted \\" data: needle 中文');
  });

  it('should reject a pre-aborted iteration without opening the file', async () => {
    const file = tempFile(`${headerLine}\n`);
    const controller = new AbortController();
    controller.abort();
    const openStream = vi.mocked(fs.createReadStream);
    openStream.mockClear();
    await expect(sessionLines(file, controller.signal).next()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(openStream).not.toHaveBeenCalled();
  });

  it('should stop yielding buffered lines after cancellation and close the stream', async () => {
    const file = tempFile([headerLine, JSON.stringify(message('user', 'needle', 1))].join('\n'));
    const controller = new AbortController();
    const lines = sessionLines(file, controller.signal);
    await lines.next();
    const stream = vi.mocked(fs.createReadStream).mock.results.at(-1)!.value as fs.ReadStream;
    const reason = new Error('superseded search');
    controller.abort(reason);
    await expect(lines.next()).rejects.toBe(reason);
    expect(stream.destroyed).toBe(true);
  });

  it('should yield unfinished trailing content when the file ends without a newline', async () => {
    const file = tempFile(headerLine);
    const lines: string[] = [];
    for await (const line of sessionLines(file)) lines.push(line);
    expect(lines).toEqual([headerLine]);
  });

  it('should yield to the event loop while scanning many buffered records', async () => {
    const file = tempFile(
      Array.from({ length: 2000 }, () => JSON.stringify(message('user', 'small', 1))).join('\n'),
    );
    let ticked = false;
    let count = 0;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    try {
      for await (const line of sessionLines(file)) {
        count += 1;
        if (count === 1500) {
          expect(ticked).toBe(true);
          expect(line.startsWith('{')).toBe(true);
        }
      }
    } finally {
      clearTimeout(timer);
    }
    expect(count).toBe(2000);
  });

  it('should propagate read errors for a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-web-host-scan-'));
    dirs.push(dir);
    await expect(sessionLines(join(dir, 'missing.jsonl')).next()).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('should see appended lines on a fresh iteration', async () => {
    const file = tempFile(`${headerLine}\n`);
    appendFileSync(file, `${JSON.stringify(message('user', 'second', 2))}\n`);
    const lines: string[] = [];
    for await (const line of sessionLines(file)) lines.push(line);
    expect(lines).toHaveLength(2);
  });
});

describe('mapSessionsConcurrent', () => {
  it('should bound active work and preserve candidate order', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapSessionsConcurrent(
      [0, 1, 2, 3, 4],
      async (n) => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((resolve) => setTimeout(resolve, n === 0 ? 10 : 1));
        active--;
        return n * 2;
      },
      2,
    );
    expect(maxActive).toBe(2);
    expect(result).toEqual([0, 2, 4, 6, 8]);
  });

  it('should pass the original index to the visitor', async () => {
    const seen: [string, number][] = [];
    const result = await mapSessionsConcurrent(['a', 'b', 'c'], (item, index) => {
      seen.push([item, index]);
      return Promise.resolve(`${index}:${item}`);
    });
    expect(result).toEqual(['0:a', '1:b', '2:c']);
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('should return an empty array for empty input', async () => {
    expect(await mapSessionsConcurrent([], () => Promise.resolve(1))).toEqual([]);
  });

  it('should reject out-of-range concurrency values', async () => {
    const visit = () => Promise.resolve(1);
    await expect(mapSessionsConcurrent([1], visit, 0)).rejects.toThrow(RangeError);
    await expect(mapSessionsConcurrent([1], visit, 33)).rejects.toThrow(RangeError);
    await expect(mapSessionsConcurrent([1], visit, 1.5)).rejects.toThrow(RangeError);
  });

  it('should stop queued worker tasks after cancellation even when active tasks resolve', async () => {
    const controller = new AbortController();
    const visited: number[] = [];
    await expect(
      mapSessionsConcurrent(
        [0, 1, 2, 3],
        (n) => {
          visited.push(n);
          controller.abort();
          return Promise.resolve(n);
        },
        1,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(visited).toEqual([0]);
  });

  it('should reject immediately for a pre-aborted signal without visiting items', async () => {
    const controller = new AbortController();
    controller.abort();
    const visit = vi.fn(() => Promise.resolve(1));
    await expect(mapSessionsConcurrent([1, 2], visit, 1, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(visit).not.toHaveBeenCalled();
  });
});

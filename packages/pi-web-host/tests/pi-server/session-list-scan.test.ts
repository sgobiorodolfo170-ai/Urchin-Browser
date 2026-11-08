/**
 * session-list-scan.ts 单元测试
 *
 * 增量列表扫描是会话列表的热路径：任何一个字段与旧实现（session-parser 的全量解析）
 * 不同，都会表现为列表里消息数 / 时间 / 标题抖动。这里用「随机转录等价性 +
 * 增量续扫 + 半行 + 改写/截断 + CLI 元信息」把语义钉住。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sessionLines } from '../../src/pi-server/session-scan.js';
import { scanSessionListInfo } from '../../src/pi-server/session-list-scan.js';

const root = mkdtempSync(join(tmpdir(), 'pi-web-host-list-scan-'));
let fileSeq = 0;

function tmpFile(content: string): string {
  const file = join(root, `s${fileSeq++}.jsonl`);
  writeFileSync(file, content, 'utf8');
  return file;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 旧路径参考实现：与 session-parser 的逐行全量解析保持同一套字段口径。 */
async function legacyListParse(filePath: string, fileMtime: number) {
  let id = '';
  let cwd = '';
  let name: string | undefined;
  let parentSessionPath: string | undefined;
  let firstMessage = '';
  let messageCount = 0;
  let lastActivityTime = 0;
  let headerTime = 0;
  for await (const line of sessionLines(filePath)) {
    if (!line.trim()) continue;
    if (id && firstMessage && line.length > 512 && !line.includes('"session_info"')) {
      const head = line.slice(0, 140);
      if (/"type"\s*:\s*"message"/.test(head)) {
        messageCount++;
        const tsMatch = /"timestamp"\s*:\s*(\d{10,16})/.exec(line);
        if (tsMatch) {
          const ts = Number(tsMatch[1]);
          if (ts > lastActivityTime) lastActivityTime = ts;
        }
      }
      continue;
    }
    let rec: Record<string, unknown> | null;
    try {
      rec = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!rec) continue;
    if (rec.type === 'session') {
      id = typeof rec.id === 'string' ? rec.id : '';
      cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
      if (typeof rec.timestamp === 'string') headerTime = new Date(rec.timestamp).getTime();
      if (typeof rec.parentSession === 'string') parentSessionPath = rec.parentSession;
    } else if (rec.type === 'session_info') {
      if (typeof rec.name === 'string' && rec.name.trim()) name = rec.name.trim();
    } else if (rec.type === 'message') {
      messageCount++;
      const msg = rec.message as Record<string, unknown> | null;
      if (msg) {
        if (typeof msg.timestamp === 'number')
          lastActivityTime = Math.max(lastActivityTime, msg.timestamp);
        if (!firstMessage && msg.role === 'user') {
          let text = '';
          if (typeof msg.content === 'string') text = msg.content;
          else if (Array.isArray(msg.content)) {
            for (const part of msg.content as { text?: unknown }[])
              if (part && typeof part.text === 'string') text += (text ? ' ' : '') + part.text;
          }
          if (text) firstMessage = text;
        }
      }
    }
  }
  if (!id) return null;
  const modified =
    lastActivityTime > 0 ? lastActivityTime : headerTime > 0 ? headerTime : fileMtime;
  return {
    id,
    cwd,
    name,
    parentSessionPath,
    created: new Date(headerTime || fileMtime).getTime(),
    modified: new Date(modified).getTime(),
    messageCount,
    firstMessage: firstMessage || '(no messages)',
  };
}

function comparable(result: Awaited<ReturnType<typeof scanSessionListInfo>>) {
  const i = result?.info;
  if (!i) return null;
  return {
    id: i.id,
    cwd: i.cwd,
    name: i.name,
    parentSessionPath: i.parentSessionPath,
    created: i.created.getTime(),
    modified: i.modified.getTime(),
    messageCount: i.messageCount,
    firstMessage: i.firstMessage,
  };
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

function randomTranscript(r: () => number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const lines: string[] = [];
  if (r() < 0.95)
    lines.push(
      JSON.stringify({
        type: 'session',
        id: `sess-${Math.floor(r() * 1e6)}`,
        cwd: '/p/中文 dir',
        timestamp: '2026-01-02T03:04:05.000Z',
        ...(r() < 0.3 ? { parentSession: '/p/parent.jsonl' } : {}),
      }),
    );
  const n = Math.floor(r() * 30);
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(r() * 100_000);
    const kind = r();
    if (kind < 0.08) {
      lines.push(
        JSON.stringify({ type: 'session_info', name: pick(['', '  ', 'Renamed', '重命名 ✓']) }),
      );
    } else if (kind < 0.12) {
      lines.push(pick(['', '   ', '{not json', '{"type":"message"', 'null']));
    } else {
      const role = pick(['user', 'assistant', 'toolResult']);
      const big = r() < 0.4 ? 'z'.repeat(400 + Math.floor(r() * 3000)) : '';
      const image =
        r() < 0.15
          ? [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'QUJD'.repeat(200 + Math.floor(r() * 500)),
              },
            ]
          : [];
      const content =
        r() < 0.3
          ? `text ${i} ${big} 你好 "quoted"`
          : [
              ...image,
              { type: 'text', text: `part ${i} ${big}` },
              ...(r() < 0.3 ? [{ type: 'text', text: 'second' }] : []),
            ];
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `m${i}`,
          parentId: i ? `m${i - 1}` : null,
          timestamp: new Date(ts).toISOString(),
          message: { role, content, ...(r() < 0.9 ? { timestamp: ts } : {}) },
        }),
      );
    }
  }
  const eol = r() < 0.2 ? '\r\n' : '\n';
  return lines.join(eol) + (r() < 0.8 ? eol : '');
}

describe('scanSessionListInfo equivalence', () => {
  it('should produce the same fields as the full legacy parser on 300 random transcripts', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const file = tmpFile(randomTranscript(rng(seed)));
      const expected = await legacyListParse(file, 1234);
      const got = comparable(await scanSessionListInfo(file, 1234));
      expect(got, `seed=${seed}`).toEqual(expected);
    }
  });
});

describe('native CLI metadata', () => {
  const header = {
    type: 'session',
    id: 'cli-session',
    cwd: '/workspace',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  const config = { preset: 'pi', args: ['--model', 'configured-model'] };
  const marker = (value: unknown = config, version = 1) => ({
    type: 'custom',
    customType: 'webui/native-cli',
    data: { version, config: value },
  });

  it('should expose a custom-only CLI session with zero messages and its persisted config', async () => {
    const file = tmpFile(
      [header, marker(), { type: 'session_info', name: 'Codex CLI' }]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const result = await scanSessionListInfo(file, 1234);
    expect(result?.info).toMatchObject({
      id: 'cli-session',
      name: 'Codex CLI',
      nativeCli: config,
      messageCount: 0,
      firstMessage: '',
    });
    expect(result?.state.nativeCli).toEqual(config);
  });

  it('should skip oversized non-marker lines in a native-CLI session without JSON.parse', async () => {
    // D11：0 消息的 CLI 会话不会填 firstMessage，旧实现让快路径整体失效，
    // 每条 >512B 的行都要完整 JSON.parse；这里用行数 + JSON.parse 次数锁死优化。
    const noise = Array.from({ length: 20 }, (_, i) => ({
      type: 'tool_result',
      seq: i,
      payload: 'x'.repeat(2048),
    }));
    const file = tmpFile(
      [header, marker(), ...noise].map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    const parse = vi.spyOn(JSON, 'parse');
    let calls = 0;
    try {
      await scanSessionListInfo(file, 0);
      calls = parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('should keep CLI metadata across incremental renames and long markers after a user message', async () => {
    const file = tmpFile(
      [header, { type: 'message', message: { role: 'user', content: 'existing message' } }]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const first = await scanSessionListInfo(file, 0);
    const configured = {
      preset: 'custom',
      args: ['x'.repeat(2000)],
      executable: '/native/program',
    };
    appendFileSync(file, `${JSON.stringify(marker(configured))}\n`);
    const typed = await scanSessionListInfo(file, 0, first!.state);
    expect(typed?.resumedFrom).toBe(first!.state.offset);
    expect(typed?.info?.nativeCli).toEqual(configured);
    expect(typed?.info?.messageCount).toBe(1);
    appendFileSync(file, `${JSON.stringify({ type: 'session_info', name: 'Renamed CLI' })}\n`);
    const renamed = await scanSessionListInfo(file, 0, typed!.state);
    expect(renamed?.info).toMatchObject({
      nativeCli: configured,
      name: 'Renamed CLI',
      messageCount: 1,
    });
  });

  it('should not advertise an invalid trailing CLI marker as valid configuration', async () => {
    const file = tmpFile(
      [header, marker(), marker(config, 99)].map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    expect((await scanSessionListInfo(file, 0))?.info?.nativeCli).toBeUndefined();
  });
});

describe('incremental scanning', () => {
  const header = JSON.stringify({
    type: 'session',
    id: 's1',
    cwd: '/p',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  const msg = (i: number, role = 'user', pad = 0) =>
    JSON.stringify({
      type: 'message',
      id: `m${i}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role,
        content: [{ type: 'text', text: `t${i}${'x'.repeat(pad)}` }],
        timestamp: 1_700_000_000_000 + i,
      },
    });

  it('should resume from the previous offset after an append and match a full rescan', async () => {
    const file = tmpFile(`${header}\n${msg(1)}\n${msg(2, 'assistant', 2000)}\n`);
    const first = await scanSessionListInfo(file, 0);
    expect(first!.resumedFrom).toBe(0);
    appendFileSync(
      file,
      `${msg(3, 'assistant', 5000)}\n${JSON.stringify({ type: 'session_info', name: 'N' })}\n`,
    );
    const inc = await scanSessionListInfo(file, 0, first!.state);
    expect(inc!.resumedFrom).toBe(first!.state.offset);
    const full = await scanSessionListInfo(file, 0);
    expect(comparable(inc)).toEqual(comparable(full));
    expect(inc!.info!.messageCount).toBe(3);
    expect(inc!.info!.name).toBe('N');
  });

  it('should count a trailing half line once without advancing the committed offset', async () => {
    const file = tmpFile(`${header}\n${msg(1)}\n`);
    const line = msg(2, 'assistant', 3000);
    appendFileSync(file, line.slice(0, 1500));
    const a = await scanSessionListInfo(file, 0);
    const offsetBefore = a!.state.offset;
    appendFileSync(file, `${line.slice(1500)}\n`);
    const b = await scanSessionListInfo(file, 0, a!.state);
    expect(b!.resumedFrom).toBe(offsetBefore);
    expect(comparable(b)).toEqual(comparable(await scanSessionListInfo(file, 0)));
    expect(b!.info!.messageCount).toBe(2);
  });

  it('should rescan from zero when the file was rewritten or truncated', async () => {
    const file = tmpFile(`${header}\n${msg(1)}\n${msg(2)}\n${msg(3)}\n`);
    const first = await scanSessionListInfo(file, 0);
    writeFileSync(
      file,
      `${header}\n${msg(1)}\n${msg(2).replace('"m2"', '"m2--dup-1"')}\n${msg(3)}\n${msg(4)}\n`,
    );
    const rescan = await scanSessionListInfo(file, 0, first!.state);
    expect(rescan!.resumedFrom).toBe(0);
    expect(rescan!.info!.messageCount).toBe(4);
    writeFileSync(file, `${header}\n${msg(1)}\n`);
    const truncated = await scanSessionListInfo(file, 0, rescan!.state);
    expect(truncated!.resumedFrom).toBe(0);
    expect(truncated!.info!.messageCount).toBe(1);
  });

  it('should return null for a missing file', async () => {
    expect(await scanSessionListInfo(join(root, 'no-such-session-file.jsonl'), 0)).toBeNull();
  });

  it('should return null info when the transcript has no session header', async () => {
    const file = tmpFile(`${msg(1)}\n`);
    const result = await scanSessionListInfo(file, 99);
    expect(result?.info).toBeNull();
    expect(result?.state.offset).toBeGreaterThan(0);
  });

  it('should fall back to the file mtime when neither activity nor header timestamps exist', async () => {
    const file = tmpFile(`${JSON.stringify({ type: 'session', id: 'x', cwd: '/p' })}\n`);
    const result = await scanSessionListInfo(file, 4321);
    expect(result?.info?.modified.getTime()).toBe(4321);
    expect(result?.info?.created.getTime()).toBe(4321);
  });
});

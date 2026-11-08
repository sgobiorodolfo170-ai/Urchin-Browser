/**
 * context-evidence.ts 单元测试
 *
 * 覆盖证据目录的索引构建、按会话隔离的路径解析、写入/复制/删除的并发排队、
 * 摘要与体积校验、取消传播，以及失败时「不破坏既有证据」的保守行为。
 *
 * 为何每次读取都要重算 sha256 并比对 size/mtime/ctime：证据文件是跨请求复用的
 * 磁盘残留，任何外部改写都会让 `context-evidence:<sha256>` 引用与实际内容脱钩；
 * 校验失败必须报错而不是继续用错内容回答。
 */
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  truncate,
  open,
  mkdir,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextEvidenceIndex,
  contextEvidenceReference,
  copyContextEvidence,
  persistContextEvidence,
  removeContextEvidence,
  withContextEvidenceRead,
} from '../../src/pi-server/context-evidence.js';

const directories: string[] = [];

async function session(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'context-evidence-'));
  directories.push(directory);
  const file = join(directory, 'session.jsonl');
  await writeFile(file, '');
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const text = 'line of evidence\n'.repeat(3000);

function result(
  toolName = 'read',
  content: unknown[] = [{ type: 'text', text }],
): Record<string, unknown> {
  return { role: 'toolResult', toolName, toolCallId: 'call-1', isError: false, content };
}

describe('persistent context evidence', () => {
  it('should build a deterministic bounded index from hash filenames without reading bodies', async () => {
    const file = await session();
    expect(await buildContextEvidenceIndex(file)).toBe('');
    await mkdir(`${file}.evidence`);
    expect(await buildContextEvidenceIndex(file)).toBe('');

    const hashes = Array.from({ length: 35 }, (_, index) => index.toString(16).padStart(64, '0'));
    for (const hash of hashes.slice().reverse()) {
      await writeFile(join(`${file}.evidence`, `${hash}.txt`), 'body must not appear');
    }
    await writeFile(join(`${file}.evidence`, 'notes.txt'), 'ignored');
    await writeFile(join(`${file}.evidence`, '.pending.tmp'), 'ignored');
    await mkdir(join(`${file}.evidence`, `${'f'.repeat(64)}.txt`));

    const index = await buildContextEvidenceIndex(file);
    expect(index.split('\n')).toEqual([
      '[Context evidence: 35 files. Read context-evidence:index for the complete directory listing.]',
      ...hashes.slice(0, 32).map((hash) => `context-evidence:${hash}`),
    ]);
    expect(index).not.toContain('body must not appear');
    expect(index).not.toContain(file);
    expect(await buildContextEvidenceIndex(file)).toBe(index);
  });

  it('should resolve the index alias through the guarded reader for the current session', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    await persistContextEvidence(second, `${text}second`);
    let current = first;
    const execute = vi.fn(async (_id: string, params: { path: string }) => ({
      content: [{ type: 'text', text: (await readdir(params.path)).join('\n') }],
    }));
    const reader = withContextEvidenceRead({ execute } as never, () => current);
    const invoke = (signal?: AbortSignal) =>
      reader.execute(
        'id',
        { file_path: 'context-evidence:index', limit: 100 },
        signal,
        undefined,
        {},
      );

    await invoke();
    expect(execute.mock.calls[0][1]).toEqual({
      path: `${first}.evidence`,
      file_path: `${first}.evidence`,
      limit: 100,
    });
    current = second;
    await invoke();
    expect(execute.mock.calls[1][1].path).toBe(`${second}.evidence`);

    execute.mockRejectedValueOnce(new Error('permission denied'));
    await expect(invoke()).rejects.toThrow('permission denied');

    const controller = new AbortController();
    controller.abort(new Error('index cancelled'));
    await expect(invoke(controller.signal)).rejects.toThrow('index cancelled');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('should validate SDK-resolved artifact paths before the base reader, including relative paths', async () => {
    const file = await session();
    const artifact = (await persistContextEvidence(file, text))!;
    const execute = vi.fn(() => Promise.resolve({ content: [] }));
    const reader = withContextEvidenceRead({ execute } as never, () => file);
    const invoke = (path: string) =>
      reader.execute('id', { path }, undefined, undefined, { cwd: process.cwd() });

    await invoke(artifact);
    await invoke(relative(process.cwd(), artifact));
    expect(execute).toHaveBeenCalledTimes(2);

    await writeFile(artifact, 'corrupt');
    await expect(invoke(artifact)).rejects.toThrow('integrity');
    await expect(invoke(relative(process.cwd(), artifact))).rejects.toThrow('integrity');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('should keep resolved-path validation scoped to the current session and direct children', async () => {
    const file = await session();
    const other = await session();
    const artifact = (await persistContextEvidence(other, text))!;
    await writeFile(artifact, 'corrupt in another session');
    const execute = vi.fn(() => Promise.resolve({ content: [] }));
    const reader = withContextEvidenceRead({ execute } as never, () => file);

    for (const path of [
      artifact,
      join(`${file}.evidence-other`, `${'a'.repeat(64)}.txt`),
      join(`${file}.evidence`, 'nested', `${'a'.repeat(64)}.txt`),
      join(`${file}.evidence`, 'notes.txt'),
    ]) {
      const params = { path };
      await reader.execute('id', params, undefined, undefined, {});
      expect((execute.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toBe(params);
    }
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('should validate the resolved index directory and preserve the permission guard', async () => {
    const file = await session();
    await persistContextEvidence(file, text);
    const execute = vi.fn().mockRejectedValue(new Error('permission denied'));
    const reader = withContextEvidenceRead({ execute } as never, () => file);

    await expect(
      reader.execute('id', { path: `${file}.evidence` }, undefined, undefined, {}),
    ).rejects.toThrow('permission denied');
    expect(execute).toHaveBeenCalledTimes(1);

    await removeContextEvidence(file);
    await writeFile(`${file}.evidence`, 'not a directory');
    await expect(
      reader.execute('id', { path: `${file}.evidence` }, undefined, undefined, {}),
    ).rejects.toThrow('directory');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('should pass non-evidence reads straight through to the base reader', async () => {
    const file = await session();
    const execute = vi.fn((id: string, params: { path: string }) =>
      Promise.resolve({ content: [{ type: 'text' as const, text: `${id}:${params.path}` }] }),
    );
    const reader = withContextEvidenceRead({ execute } as never, () => file);
    const params = { path: 'README.md' };
    await reader.execute('id', params, undefined, undefined, {});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe(params);
  });

  it('should refuse an evidence reference when the session is not persisted', async () => {
    const execute = vi.fn(() => Promise.resolve({ content: [] }));
    const reader = withContextEvidenceRead({ execute } as never, () => undefined);
    await expect(
      reader.execute('id', { path: 'context-evidence:index' }, undefined, undefined, {}),
    ).rejects.toThrow('Invalid evidence reference or no persisted session');
    expect(execute).not.toHaveBeenCalled();
  });

  it('should queue index construction after pending evidence persistence', async () => {
    const file = await session();
    const pending = persistContextEvidence(file, text);
    const index = buildContextEvidenceIndex(file);
    await pending;
    expect(await index).toContain(contextEvidenceReference(text));
  });

  it('should reject cancelled persistence, copies and ordinary reads before doing work', async () => {
    const file = await session();
    const child = await session();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(persistContextEvidence(file, text, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    await expect(copyContextEvidence(file, child, controller.signal)).rejects.toThrow('cancelled');

    const execute = vi.fn();
    const reader = withContextEvidenceRead({ execute } as never, () => file);
    await expect(
      reader.execute('id', { path: file }, controller.signal, undefined, {}),
    ).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
    await expect(readdir(`${file}.evidence`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should not run a cancelled write queued behind an active reader', async () => {
    const file = await session();
    await persistContextEvidence(file, text);

    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reader = withContextEvidenceRead(
      {
        execute: async () => {
          entered();
          await waiting;
          return { content: [] };
        },
      } as never,
      () => file,
    );

    const active = reader.execute(
      'id',
      { path: contextEvidenceReference(text) },
      undefined,
      undefined,
      {},
    );
    await started;

    const controller = new AbortController();
    const queued = persistContextEvidence(file, `${text}cancelled`, controller.signal);
    const rejected = expect(queued).rejects.toThrow('queued cancellation');
    controller.abort(new Error('queued cancellation'));
    release();
    await active;
    await rejected;

    expect(await readdir(`${file}.evidence`)).toHaveLength(1);
    expect(await persistContextEvidence(file, `${text}usable`)).toBeTruthy();
  });

  it('should clean a cancelled persistence write and let the next writer proceed', async () => {
    const file = await session();
    const probe = await open(file, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      writeFile: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const original = prototype.writeFile;
    const controller = new AbortController();
    vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const value = await original.apply(this, args);
      controller.abort(new Error('persistence cancelled'));
      return value;
    });

    await expect(persistContextEvidence(file, text, controller.signal)).rejects.toThrow(
      'persistence cancelled',
    );
    expect(await readdir(`${file}.evidence`)).toEqual([]);
    vi.restoreAllMocks();
    expect(await persistContextEvidence(file, text)).toBeTruthy();
  });

  it('should check digests and size before calling the guarded reader and preserve permission errors', async () => {
    const file = await session();
    const artifact = (await persistContextEvidence(file, text))!;
    const execute = vi.fn().mockRejectedValue(new Error('permission denied'));
    const reader = withContextEvidenceRead({ execute } as never, () => file);
    const invoke = () =>
      reader.execute(
        'id',
        { file_path: contextEvidenceReference(text), limit: 2 },
        undefined,
        undefined,
        {},
      );

    await expect(invoke()).rejects.toThrow('permission denied');
    expect(execute.mock.calls[0][1]).toMatchObject({
      path: artifact,
      file_path: artifact,
      limit: 2,
    });

    execute.mockClear();
    await writeFile(artifact, 'broken');
    await expect(invoke()).rejects.toThrow('integrity');
    await truncate(artifact, 128 * 1024 * 1024);
    await expect(invoke()).rejects.toThrow('budget');
    expect(execute).not.toHaveBeenCalled();
  });

  it('should fail when the guarded reader changes evidence or aborts', async () => {
    const file = await session();
    const artifact = (await persistContextEvidence(file, text))!;
    const controller = new AbortController();
    const execute = vi.fn(() => {
      controller.abort(new Error('reader cancelled'));
      return Promise.resolve({ content: [] });
    });
    const reader = withContextEvidenceRead({ execute } as never, () => file);

    await expect(
      reader.execute(
        'id',
        { path: contextEvidenceReference(text) },
        controller.signal,
        undefined,
        {},
      ),
    ).rejects.toThrow('reader cancelled');

    execute.mockImplementation(async () => {
      await writeFile(artifact, 'broken');
      return { content: [] };
    });
    await expect(
      reader.execute('id', { path: contextEvidenceReference(text) }, undefined, undefined, {}),
    ).rejects.toThrow('integrity');
  });

  it('should serialize opposite-direction copies without deadlock and preserve all evidence', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    await persistContextEvidence(second, `${text}second`);
    await Promise.all([
      copyContextEvidence(first, second),
      copyContextEvidence(second, first),
      persistContextEvidence(first, `${text}third`),
    ]);
    await copyContextEvidence(first, second);
    expect((await readdir(`${first}.evidence`)).sort()).toEqual(
      (await readdir(`${second}.evidence`)).sort(),
    );
    expect(await readdir(`${first}.evidence`)).toHaveLength(3);
  }, 10000);

  it('should reject a corrupt existing destination instead of keeping a broken reference', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    const target = (await persistContextEvidence(second, text))!;
    await writeFile(target, 'broken');
    await expect(copyContextEvidence(first, second)).rejects.toThrow('integrity');
    expect(await readFile(target, 'utf8')).toBe('broken');
  });

  it('should preflight the complete copy budget before writing artifacts', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    await persistContextEvidence(first, `${text}extra`);
    const seed = (await persistContextEvidence(second, 'seed'))!;
    await truncate(seed, 64 * 1024 * 1024 - Buffer.byteLength(text));
    await expect(copyContextEvidence(first, second)).rejects.toThrow('budget');
    expect(await readdir(`${second}.evidence`)).toHaveLength(1);
  });

  it('should reject symlinked evidence directories', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    await rm(`${first}.evidence`, { recursive: true });
    const outside = join(first, '..', `outside-${Date.now()}`);
    await mkdir(outside);
    try {
      await symlink(
        outside,
        `${first}.evidence`,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } finally {
      directories.push(outside);
    }
    expect(await persistContextEvidence(first, text)).toBeUndefined();
    await expect(copyContextEvidence(first, second)).rejects.toThrow('directory');
  });

  it('should bound streamed copy reads and clean temporary files on mid-copy cancellation', async () => {
    const first = await session();
    const second = await session();
    const artifact = (await persistContextEvidence(first, 'x'.repeat(1024 * 1024)))!;
    const probe = await open(artifact, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
    };
    await probe.close();
    const original = prototype.read;
    const controller = new AbortController();
    let reads = 0;
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      expect(args[2] as number).toBeLessThanOrEqual(64 * 1024);
      const value = await original.apply(this, args);
      if (++reads === 2) controller.abort(new Error('copy cancelled'));
      return value;
    });

    await expect(copyContextEvidence(first, second, controller.signal)).rejects.toThrow(
      'copy cancelled',
    );
    expect(reads).toBe(2);
    expect(await readdir(`${second}.evidence`)).toEqual([]);

    vi.restoreAllMocks();
    await copyContextEvidence(first, second);
    const copied = (await readdir(`${second}.evidence`))[0];
    expect(await stat(join(`${second}.evidence`, copied))).toMatchObject({ size: 1024 * 1024 });
  });

  it('should check the opened file identity after a pathname replacement', async () => {
    const first = await session();
    const second = await session();
    const artifact = (await persistContextEvidence(first, text))!;
    const probe = await open(artifact, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      stat: (...args: unknown[]) => Promise<{ size: number }>;
    };
    await probe.close();
    const original = prototype.stat;
    let replaced = false;
    vi.spyOn(prototype, 'stat').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const info = await original.apply(this, args);
      if (!replaced && info.size === Buffer.byteLength(text)) {
        replaced = true;
        await rm(artifact);
        await writeFile(artifact, text);
      }
      return info;
    });
    try {
      await expect(copyContextEvidence(first, second)).rejects.toThrow('changed while opening');
      expect(replaced).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('should detect growth after fstat without consuming the enlarged file', async () => {
    const first = await session();
    const second = await session();
    const artifact = (await persistContextEvidence(first, text))!;
    const probe = await open(artifact, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
    };
    await probe.close();
    const original = prototype.read;
    let reads = 0;
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (++reads === 1) await truncate(artifact, 128 * 1024 * 1024);
      return original.apply(this, args);
    });
    await expect(copyContextEvidence(first, second)).rejects.toThrow('changed');
    expect(reads).toBeLessThanOrEqual(2);
    expect(await readdir(`${second}.evidence`)).toEqual([]);
  });

  it('should remove evidence with deleted transcripts and reject late writers', async () => {
    const file = await session();
    await persistContextEvidence(file, text);
    await rm(file);
    await Promise.all([removeContextEvidence(file), persistContextEvidence(file, `${text}late`)]);
    await expect(readdir(`${file}.evidence`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await persistContextEvidence(file, text)).toBeUndefined();
    await removeContextEvidence(file);
  });

  it('should rebuild evidence while the transcript still exists', async () => {
    const file = await session();
    await persistContextEvidence(file, text);
    await removeContextEvidence(file);
    expect(await persistContextEvidence(file, text)).toBeTruthy();
  });

  it('should resolve the same reference in a relocated session before the guarded reader', async () => {
    const first = await session();
    const second = await session();
    await persistContextEvidence(first, text);
    await persistContextEvidence(second, text);
    let current = first;
    const paths: string[] = [];
    const reader = withContextEvidenceRead(
      {
        name: 'read',
        execute: async (_id: string, params: { path: string; offset?: number }) => {
          paths.push(params.path);
          expect(params.offset).toBe(10);
          return { content: [{ type: 'text', text: await readFile(params.path, 'utf8') }] };
        },
      },
      () => current,
    );
    const invoke = () =>
      reader.execute(
        'call',
        { path: contextEvidenceReference(text), offset: 10 },
        undefined,
        undefined,
        {},
      );

    await invoke();
    current = second;
    await invoke();
    expect(paths[0]).toContain(`${first}.evidence`);
    expect(paths[1]).toContain(`${second}.evidence`);

    await expect(
      reader.execute('call', { path: 'context-evidence:../../secret' }, undefined, undefined, {}),
    ).rejects.toThrow('Invalid evidence');
  });

  it('should inherit independent evidence that survives deletion of the parent session', async () => {
    const parent = await session();
    const child = await session();
    await persistContextEvidence(parent, text);
    await copyContextEvidence(parent, child);
    await rm(parent);
    await removeContextEvidence(parent);

    const digest = contextEvidenceReference(text).split(':')[1];
    expect(await readFile(join(`${child}.evidence`, `${digest}.txt`), 'utf8')).toBe(text);
    await copyContextEvidence(child, child);
    expect(await readdir(`${child}.evidence`)).toHaveLength(1);
  });

  it('should handle a parent without evidence and reject corrupt inherited evidence', async () => {
    const parent = await session();
    const child = await session();
    await copyContextEvidence(parent, child);
    // 源会话没有证据目录 → 直接返回，不创建目标目录
    await expect(readdir(`${child}.evidence`)).rejects.toMatchObject({ code: 'ENOENT' });

    const artifact = (await persistContextEvidence(parent, text))!;
    await writeFile(artifact, 'corrupt');
    await expect(copyContextEvidence(parent, child)).rejects.toThrow('integrity');
  });

  it('should be complete, stable across repeated calls and scoped by session', async () => {
    const file = await session();
    const first = await persistContextEvidence(file, text);
    expect(first).toBeTruthy();
    expect(await readFile(first!, 'utf8')).toBe(text);
    expect(await persistContextEvidence(file, text)).toBe(first);
    expect(await persistContextEvidence(await session(), text)).not.toBe(first);
    expect(await readdir(`${file}.evidence`)).toHaveLength(1);
  });

  it('should serialize concurrent writes so a full directory cannot overshoot its budget', async () => {
    const file = await session();
    const seed = (await persistContextEvidence(file, 'seed'))!;
    await truncate(seed, 64 * 1024 * 1024 - Buffer.byteLength(text));
    const results = await Promise.all([
      persistContextEvidence(file, text),
      persistContextEvidence(file, text.replace('line', 'LINE')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readdir(`${file}.evidence`)).toHaveLength(2);
  });

  it('should reuse a single complete artifact for concurrent identical writes', async () => {
    const file = await session();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => persistContextEvidence(file, text)),
    );
    expect(results[0]).toBeTruthy();
    expect(new Set(results).size).toBe(1);
    expect(await readdir(`${file}.evidence`)).toHaveLength(1);
    expect(await readFile(results[0]!, 'utf8')).toBe(text);
  });

  it('should not trust or replace a damaged artifact', async () => {
    const file = await session();
    const path = (await persistContextEvidence(file, text))!;
    await writeFile(path, 'damaged');
    expect(await persistContextEvidence(file, text)).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('damaged');
  });

  it('should reject oversized evidence and degrade gracefully when the directory is unusable', async () => {
    const file = await session();
    expect(await persistContextEvidence(file, 'x'.repeat(1024 * 1024 + 1))).toBeUndefined();
    await writeFile(`${file}.evidence`, 'not a directory');
    expect(await persistContextEvidence(file, text)).toBeUndefined();
    // 证据路径被非目录占用属于硬错误：索引构建不做静默降级
    await expect(buildContextEvidenceIndex(file)).rejects.toThrow('Invalid evidence directory');
    const reader = withContextEvidenceRead(
      { execute: vi.fn(() => Promise.resolve({ content: [] })) } as never,
      () => file,
    );
    await expect(
      reader.execute('id', { path: `${file}.evidence` }, undefined, undefined, {}),
    ).rejects.toThrow('directory');
  });

  it('should reference evidence by the sha256 of its UTF-8 text', () => {
    expect(contextEvidenceReference('abc')).toBe(
      'context-evidence:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(contextEvidenceReference('')).toHaveLength('context-evidence:'.length + 64);
  });

  it('should keep generated tool-result shapes untouched', () => {
    // 该辅助只用于本文件构造夹具，断言它没有副作用地返回独立对象
    const first = result();
    const second = result();
    expect(first).not.toBe(second);
    expect(first.toolCallId).toBe('call-1');
  });
});

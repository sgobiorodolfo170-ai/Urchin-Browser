import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { registerFileTransferRoutes } from '../../src/pi-server/file-transfer-routes.js';
import * as remoteSsh from '../../src/pi-server/remote-ssh-service.js';

const roots: string[] = [];

class FakeRes extends Writable {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);
  jsonBody: unknown;
  sent: string | undefined;

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.body = Buffer.concat([this.body, chunk]);
    done();
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  send(value: string) {
    this.sent = value;
    this.body = Buffer.from(value);
    this.headersSent = true;
    return this;
  }

  json(value: unknown) {
    this.jsonBody = value;
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  type(value: string) {
    this.headers['content-type'] = value;
    return this;
  }

  download(path: string, name: string, _opts: unknown, done: (error?: Error | null) => void) {
    this.headers['content-disposition'] = `attachment; filename="${name}"`;
    readFile(path).then(
      (buf) => {
        this.body = buf;
        this.headersSent = true;
        done(null);
      },
      (err: Error) => done(err),
    );
  }
}

type Handler = (req: any, res: any, next?: () => void) => Promise<void> | void;

function makeApp() {
  const routes = new Map<string, Handler>();
  const middleware: Handler[] = [];
  const app = {
    use: (_path: string, handler: Handler) => void middleware.push(handler),
    post: (path: string, handler: Handler) => void routes.set(path, handler),
  };
  return { app, routes, middleware };
}

function makeReq(options: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  chunks?: (Buffer | string)[];
}) {
  const headers: Record<string, string | undefined> = {
    'x-file-operation': '1',
    ...(options.headers ?? {}),
  };
  const req = {
    query: options.query ?? {},
    headers,
    body: options.body,
    is(type: string) {
      const raw = headers['content-type'];
      return typeof raw === 'string' && raw.split(';')[0]?.trim() === type;
    },
    iterator: function* iterator() {
      for (const chunk of options.chunks ?? []) yield chunk;
    },
  };
  return req;
}

async function fixture(maxBytes?: number, remote = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-transfer-test-'));
  roots.push(root);
  const temporary = join(root, 'temporary');
  await mkdir(temporary);
  await writeFile(join(root, 'a.txt'), 'archive me');
  const { app, routes, middleware } = makeApp();
  registerFileTransferRoutes(
    app as never,
    (id) => (id === 'test-client' ? (remote ? 'ssh://tester@example.test/work' : root) : undefined),
    temporary,
    maxBytes === undefined
      ? undefined
      : (clientId) => {
          expect(clientId).toBe('test-client');
          return maxBytes;
        },
  );
  return {
    root,
    temporary,
    routes,
    middleware,
    archive: (query: Record<string, string>, body: unknown) =>
      routes.get('/api/file-transfer/archive')!(
        makeReq({ query: { clientId: 'test-client', ...query }, body }),
        new FakeRes(),
      ),
    upload: (
      query: Record<string, string>,
      chunks: (Buffer | string)[],
      headers: Record<string, string> = {},
    ) =>
      routes.get('/api/file-transfer/upload')!(
        makeReq({
          query: { clientId: 'test-client', dir: '', name: 'a.txt', ...query },
          headers: { 'content-type': 'application/octet-stream', ...headers },
          chunks,
        }),
        new FakeRes(),
      ),
  };
}

function fakeSsh(overrides: Record<string, unknown> = {}) {
  return {
    sftpStat: vi.fn<
      (
        cwd: string,
        path: string,
      ) => Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }>
    >(() => Promise.resolve({ isFile: true, isDirectory: false, size: 10, mtime: 0 })),
    sftpWriteFile: vi.fn<
      (cwd: string, path: string, data: Buffer, opts?: unknown) => Promise<void>
    >(() => Promise.resolve()),
    sftpMkdirRecursive: vi.fn<(cwd: string, path: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    execInWorkspace: vi.fn<
      (
        cwd: string,
        cmd: string,
        opts?: unknown,
      ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
    >(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
    sftpCreateReadStream: vi.fn<(cwd: string, path: string) => Promise<Readable>>(() =>
      Promise.resolve(Readable.from([Buffer.from('remote-bytes')])),
    ),
    ...overrides,
  };
}

const REMOTE = 'ssh://tester@example.test/work';

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('file transfer guard', () => {
  it('should require the explicit file-operation header', async () => {
    const f = await fixture();
    const res = new FakeRes();
    void f.middleware[0]({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.sent).toBe('Missing file operation header');

    const ok = new FakeRes();
    const next = vi.fn();
    void f.middleware[0]({ headers: { 'x-file-operation': '1' } }, ok, next);
    expect(next).toHaveBeenCalled();
  });

  it('should reject unknown clients and invalid paths', async () => {
    const f = await fixture();
    const unknown = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'unknown' }, body: { action: 'compress', path: 'a.txt' } }),
      unknown,
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.sent).toContain('Client is not connected');

    for (const path of ['../outside', '@root']) {
      const res = new FakeRes();
      await f.routes.get('/api/file-transfer/archive')!(
        makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path } }),
        res,
      );
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('archive route (local)', () => {
  it('should compress a file alongside the source', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      res,
    );
    expect(res.jsonBody).toEqual({ name: 'a.txt.tar.gz' });
    expect(await readdir(f.root)).toContain('a.txt.tar.gz');
    expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('archive me');
  });

  it('should reject compressing twice without overwriting', async () => {
    const f = await fixture();
    const handler = f.routes.get('/api/file-transfer/archive')!;
    await handler(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      new FakeRes(),
    );
    const res = new FakeRes();
    await handler(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('archive me');
  });

  it('should stream a temporary download and delete it afterwards', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'download', path: 'a.txt' } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('a.txt.tar.gz');
    expect(res.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(await readdir(f.temporary)).toEqual([]);
    expect(await readdir(f.root)).not.toContain('a.txt.tar.gz');
  });

  it('should clean the temporary directory when the download fails', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'download', path: 'missing.txt' },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(await readdir(f.temporary)).toEqual([]);
  });

  it('should extract an archive with the requested policy', async () => {
    const f = await fixture();
    const handler = f.routes.get('/api/file-transfer/archive')!;
    await handler(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      new FakeRes(),
    );
    const out = join(f.root, 'out');
    await mkdir(out);
    const res = new FakeRes();
    await handler(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'extract', path: 'a.txt.tar.gz', destination: 'out', policy: 'skip' },
      }),
      res,
    );
    expect(res.jsonBody).toEqual({ written: 1, skipped: 0 });
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('archive me');
  });

  it('should reject unknown actions', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'nuke', path: 'a.txt' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.sent).toBe('Invalid archive action');
  });

  it('should refuse a second concurrent operation on the same client', async () => {
    const f = await fixture();
    const handler = f.routes.get('/api/file-transfer/archive')!;
    const first = new FakeRes();
    const running = handler(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      first,
    );
    const second = new FakeRes();
    await handler(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      second,
    );
    expect(second.statusCode).toBe(409);
    expect(second.sent).toBe('Another file operation is running');
    await running;
    expect(first.jsonBody).toEqual({ name: 'a.txt.tar.gz' });
  });
});

describe('archive route (remote)', () => {
  it('should extract with unzip for zip sources and tar otherwise', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const handler = f.routes.get('/api/file-transfer/archive')!;

    const zip = new FakeRes();
    await handler(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'extract', path: 'x.zip', destination: '' },
      }),
      zip,
    );
    expect(zip.jsonBody).toEqual({ extracted: 1, skipped: [] });
    expect(ssh.execInWorkspace.mock.calls[0][1]).toContain('unzip -o');

    ssh.execInWorkspace.mockClear();
    const tarRes = new FakeRes();
    await handler(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'extract', path: 'x.tar.gz', destination: '' },
      }),
      tarRes,
    );
    expect(ssh.execInWorkspace.mock.calls[0][1]).toContain('tar -xf');
  });

  it('should compress and download remote sources while cleaning the temp archive', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const handler = f.routes.get('/api/file-transfer/archive')!;

    const compress = new FakeRes();
    await handler(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'compress', path: 'sub/a.txt' },
      }),
      compress,
    );
    expect(compress.jsonBody).toEqual({ name: 'a.txt.tar.gz' });
    expect(ssh.execInWorkspace.mock.calls[0][1]).toContain('tar -czf');
    expect(ssh.execInWorkspace.mock.calls[0][1]).toContain('/work/sub/a.txt.tar.gz');

    ssh.execInWorkspace.mockClear();
    const download = new FakeRes();
    await handler(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'download', path: 'sub/a.txt' },
      }),
      download,
    );
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('a.txt.tar.gz');
    expect(download.headers['content-length']).toBe('10');
    expect(download.body.toString()).toBe('remote-bytes');
    const cleanup = ssh.execInWorkspace.mock.calls.at(-1)![1];
    expect(cleanup).toContain('rm -f');
  });

  it('should reject oversized temporary remote downloads', async () => {
    const ssh = fakeSsh({ sftpStat: vi.fn(() => Promise.resolve({ size: 201 * 1024 * 1024 })) });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({
        query: { clientId: 'test-client' },
        body: { action: 'download', path: 'big.bin' },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.sent).toContain('Temporary download exceeds 200 MiB');
  });

  it('should surface remote command failures and missing services', async () => {
    const ssh = fakeSsh({
      execInWorkspace: vi.fn(() =>
        Promise.resolve({ exitCode: 2, stdout: '', stderr: 'tar exploded' }),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.sent).toBe('tar exploded');

    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    const missing = new FakeRes();
    await f.routes.get('/api/file-transfer/archive')!(
      makeReq({ query: { clientId: 'test-client' }, body: { action: 'compress', path: 'a.txt' } }),
      missing,
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.sent).toContain('Remote SSH service not available');
  });
});

describe('upload route (local)', () => {
  it('should write nested uploads, including empty files', async () => {
    const f = await fixture();
    const nested = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'folder/nested/涓枃.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['hello'],
      }),
      nested,
    );
    expect(nested.jsonBody).toEqual({ name: 'folder/nested/涓枃.txt' });
    expect(await readFile(join(f.root, 'folder/nested/涓枃.txt'), 'utf8')).toBe('hello');

    const empty = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'folder/empty.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: [],
      }),
      empty,
    );
    expect(empty.jsonBody).toEqual({ name: 'folder/empty.txt' });
    expect(await readFile(join(f.root, 'folder/empty.txt'), 'utf8')).toBe('');
  });

  it('should return 409 when the destination already exists', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'dup.txt'), 'keep');
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'dup.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['replace'],
      }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(await readFile(join(f.root, 'dup.txt'), 'utf8')).toBe('keep');
  });

  it('should reject unsafe names, dirs, media types and declared sizes', async () => {
    const f = await fixture(8);
    const cases: {
      query: Record<string, string>;
      headers?: Record<string, string>;
      status: number;
    }[] = [
      { query: { name: '../escape' }, status: 400 },
      { query: { dir: '../escape', name: 'a' }, status: 400 },
      { query: { name: 'a' }, headers: { 'content-type': 'text/plain' }, status: 400 },
      { query: { name: 'a' }, headers: { 'content-length': '9' }, status: 413 },
      { query: { name: 'a' }, headers: { 'content-length': 'abc' }, status: 400 },
    ];
    for (const c of cases) {
      const res = new FakeRes();
      await f.routes.get('/api/file-transfer/upload')!(
        makeReq({
          query: { clientId: 'test-client', dir: '', ...c.query },
          headers: { 'content-type': 'application/octet-stream', ...c.headers },
          chunks: [],
        }),
        res,
      );
      expect(res.statusCode).toBe(c.status);
    }
    expect(await readdir(f.root)).toEqual(['a.txt', 'temporary']);
  });

  it('should enforce the byte limit while streaming and remove staging files', async () => {
    const f = await fixture(8);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'big.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['1234', '56789'],
      }),
      res,
    );
    expect(res.statusCode).toBe(413);
    expect((await readdir(f.root)).sort()).toEqual(['a.txt', 'temporary']);

    const atLimit = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'ok.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['12345678'],
      }),
      atLimit,
    );
    expect(atLimit.jsonBody).toEqual({ name: 'ok.txt' });
    expect(await readFile(join(f.root, 'ok.txt'), 'utf8')).toBe('12345678');
  });

  it('should reject incomplete bodies when a content length is declared', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'short.txt' },
        headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
        chunks: ['abc'],
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.sent).toBe('Incomplete upload');
    expect((await readdir(f.root)).sort()).toEqual(['a.txt', 'temporary']);
  });

  it('should create a directory for directory uploads and reject payload bytes', async () => {
    const f = await fixture();
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'newdir', kind: 'directory' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: [],
      }),
      res,
    );
    expect(res.jsonBody).toEqual({ name: 'newdir' });
    expect(await readdir(join(f.root, 'newdir'))).toEqual([]);

    const withBody = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'otherdir', kind: 'directory' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['x'],
      }),
      withBody,
    );
    expect(withBody.statusCode).toBe(413);
  });
});

describe('upload route (remote)', () => {
  it('should stream remote files through the exclusive write helper', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: 'sub', name: 'a.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['remote'],
      }),
      res,
    );
    expect(res.jsonBody).toEqual({ name: 'a.txt' });
    expect(ssh.sftpWriteFile).toHaveBeenCalledTimes(1);
    const [, temp, payload] = ssh.sftpWriteFile.mock.calls[0] as unknown[];
    expect(String(temp)).toMatch(/^\/work\/sub\/a\.txt\..*\.upload$/);
    expect(payload).toEqual(Buffer.from('remote'));
  });

  it('should create remote directories and reject a missing ssh service', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'newdir', kind: 'directory' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: [],
      }),
      res,
    );
    expect(res.jsonBody).toEqual({ name: 'newdir' });
    expect(ssh.sftpMkdirRecursive).toHaveBeenCalledWith(REMOTE, '/work/newdir');

    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    const missing = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'x.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['x'],
      }),
      missing,
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.sent).toContain('Remote SSH service not available');
  });

  it('should map remote EEXIST failures to 409', async () => {
    let call = 0;
    const ssh = fakeSsh({
      execInWorkspace: vi.fn(() =>
        Promise.resolve(
          call++ === 0
            ? { exitCode: 17, stdout: '', stderr: 'exists' }
            : { exitCode: 0, stdout: '', stderr: '' },
        ),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const f = await fixture(undefined, true);
    const res = new FakeRes();
    await f.routes.get('/api/file-transfer/upload')!(
      makeReq({
        query: { clientId: 'test-client', dir: '', name: 'a.txt' },
        headers: { 'content-type': 'application/octet-stream' },
        chunks: ['x'],
      }),
      res,
    );
    expect(res.statusCode).toBe(409);
  });
});

// Removed unused helper imports above; keep a minimal fixture sanity check.
describe('fixture sanity', () => {
  it('should have written the seed file used by archive tests', async () => {
    const f = await fixture();
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('archive me');
  });
});

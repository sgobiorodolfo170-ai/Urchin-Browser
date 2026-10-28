import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { createStaticHandler } from '../src/http-static';

interface Ctx {
  readonly server: Server;
  readonly base: string;
}

async function make(
  ctx: Ctx,
  path: string,
): Promise<{ status: number; body: string; type: string }> {
  const res = await fetch(`${ctx.base}${path}`);
  return {
    status: res.status,
    body: await res.text(),
    type: String(res.headers.get('content-type') ?? ''),
  };
}

function withServer(dir: string, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = createStaticHandler({ wwwDir: dir });
    const server = createServer((req, res) => void handler.serve(req, res));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const ctx: Ctx = { server, base: `http://127.0.0.1:${port}` };
      fn(ctx)
        .then(() => server.close(() => resolve()))
        .catch(reject);
    });
  });
}

describe('StaticHandler', () => {
  it('serves index.html for / with correct content-type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piwh-static-'));
    writeFileSync(join(dir, 'index.html'), '<h1>hello</h1>');
    await withServer(dir, async (ctx) => {
      const res = await make(ctx, '/');
      expect(res.status).toBe(200);
      expect(res.body).toBe('<h1>hello</h1>');
      expect(res.type).toContain('text/html');
    });
  });

  it('serves nested file within root with js mime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piwh-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    await withServer(dir, async (ctx) => {
      const res = await make(ctx, '/assets/app.js');
      expect(res.status).toBe(200);
      expect(res.body).toBe('console.log(1)');
      expect(res.type).toContain('javascript');
    });
  });

  it('blocks path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piwh-static-'));
    writeFileSync(join(dir, 'index.html'), 'x');
    await withServer(dir, async (ctx) => {
      const res = await make(ctx, '/..%2f..%2fetc%2fpasswd');
      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piwh-static-'));
    await withServer(dir, async (ctx) => {
      const res = await make(ctx, '/nope.html');
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not Found');
    });
  });
});

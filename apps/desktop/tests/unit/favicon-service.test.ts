/**
 * FaviconService 单元测试。
 *
 * 验证：
 * 1. 成功下载后返回 urchin://favicon/<hash>，协议读取返回正确 MIME
 * 2. 同一 URL 命中磁盘缓存，不再发起网络请求
 * 3. 非图片响应 / 超限响应被拒绝
 * 4. 内部品牌图标原样透传
 * 5. 协议路径非法（路径穿越 / 非哈希）返回 null
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FaviconService, type FaviconFetchSession } from '../../src/main/favicons/favicon-service';

/** 最小 PNG 头（嗅探只校验魔数，足以覆盖缓存/MIME 路径）。 */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('FaviconService', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-favicon-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createSession(responseFactory: () => Response): {
    session: FaviconFetchSession;
    fetchMock: ReturnType<typeof vi.fn>;
  } {
    const fetchMock = vi.fn(() => Promise.resolve(responseFactory()));
    return {
      session: { fetch: fetchMock },
      fetchMock,
    };
  }

  it('should cache a fetched favicon and serve it via protocol name', async () => {
    const service = new FaviconService(dataDir);
    const { session, fetchMock } = createSession(
      () => new Response(PNG_BYTES, { headers: { 'Content-Type': 'text/html' } }),
    );

    const url = await service.resolve({
      pageUrl: 'https://example.com/page',
      candidates: ['/favicon.png'],
      session,
    });

    expect(url).toMatch(/^urchin:\/\/favicon\/[a-f0-9]{64}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const name = url!.split('/').pop()!;
    const served = await service.serve(name);
    expect(served?.contentType).toBe('image/png');
    expect(Array.from(served!.data)).toEqual(Array.from(PNG_BYTES));
  });

  it('should reuse the disk cache for the same source URL', async () => {
    const service = new FaviconService(dataDir);
    const { session, fetchMock } = createSession(() => new Response(PNG_BYTES));

    const input = {
      pageUrl: 'https://example.com/',
      candidates: ['https://example.com/favicon.png'],
      session,
    };
    const first = await service.resolve(input);
    const second = await service.resolve(input);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should reject non-image bodies', async () => {
    const service = new FaviconService(dataDir);
    const { session } = createSession(() => new Response('<html><body>not an icon</body></html>'));

    const url = await service.resolve({
      pageUrl: 'https://example.com/',
      candidates: ['https://example.com/favicon.ico'],
      session,
    });

    expect(url).toBeUndefined();
  });

  it('should reject responses over the size limit', async () => {
    const service = new FaviconService(dataDir);
    const { session } = createSession(
      () =>
        new Response(PNG_BYTES, {
          headers: { 'Content-Length': String(2 * 1024 * 1024) },
        }),
    );

    const url = await service.resolve({
      pageUrl: 'https://example.com/',
      candidates: ['https://example.com/favicon.png'],
      session,
    });

    expect(url).toBeUndefined();
  });

  it('should pass through internal brand icons without fetching', async () => {
    const service = new FaviconService(dataDir);
    const { session, fetchMock } = createSession(() => new Response(PNG_BYTES));

    const url = await service.resolve({
      pageUrl: 'http://127.0.0.1:1234/',
      candidates: ['urchin://pi-icon/'],
      session,
    });

    expect(url).toBe('urchin://pi-icon/');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject protocol names outside the hash format', async () => {
    const service = new FaviconService(dataDir);

    expect(await service.serve('../secrets')).toBeNull();
    expect(await service.serve('not-a-hash')).toBeNull();
  });
});

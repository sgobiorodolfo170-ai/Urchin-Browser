/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-base-to-string -- 测试用 async mock 与类型断言 */
/**
 * CL11 图片本地化：URL 提取、下载重写、失败回退、SSRF 拦截、大小上限。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractRemoteImageUrls,
  getAssetLifecycleApi,
  localizeMarkdownImages,
  type FetchImpl,
  type AssetLifecycleApi,
} from '../../../src/main/clipper/image-localizer';
import type { GenOfficeEmbedApi } from '../../../src/main/genoffice/loader';

/** 构造 mock embedApi（三个 asset-lifecycle 函数齐全） */
function mockEmbedApi(overrides: Partial<GenOfficeEmbedApi> = {}): GenOfficeEmbedApi {
  return {
    writeImageIntoOwnedAssets: vi.fn(async (_doc: string, name: string) => `assets/${name}`),
    reconcileOwnedAssets: vi.fn(async () => ({ deleted: [], preserved: [], errors: [] })),
    extractMarkdownImageSources: vi.fn((md: string) => extractRemoteImageUrls(md)),
    ...overrides,
  } as unknown as GenOfficeEmbedApi;
}

/** 从 mockEmbedApi 提取 assetApi（模拟 register-handlers 中的流程） */
function mockAssetApi(overrides: Partial<GenOfficeEmbedApi> = {}): AssetLifecycleApi {
  return getAssetLifecycleApi(mockEmbedApi(overrides))!;
}

/** 构造 mock fetch：按 URL 映射返回不同结果 */
function mockFetch(
  responses: Record<string, { ok: boolean; body?: string; status?: number }>,
): FetchImpl {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = responses[url];
    if (!r) return new Response('Not Found', { status: 404 });
    if (!r.ok) return new Response('err', { status: r.status ?? 500 });
    return new Response(r.body ?? 'img-bytes', { status: 200 });
  }) as unknown as FetchImpl;
}

describe('extractRemoteImageUrls', () => {
  it('extracts http/https urls and dedupes', () => {
    const md = [
      '![](https://a.test/1.png)',
      '![alt text](http://b.test/img.jpg "title")',
      '![](https://a.test/1.png)', // 重复
      '![](data:image/png;base64,abc)', // data URI 不提取
      '![](assets/local.png)', // 本地路径不提取
    ].join('\n');
    const urls = extractRemoteImageUrls(md);
    expect(urls).toEqual(['https://a.test/1.png', 'http://b.test/img.jpg']);
  });

  it('returns empty for markdown without remote images', () => {
    expect(extractRemoteImageUrls('no images here')).toEqual([]);
    expect(extractRemoteImageUrls('![](assets/x.png)')).toEqual([]);
  });
});

describe('getAssetLifecycleApi', () => {
  it('returns api when all three functions exist', () => {
    expect(getAssetLifecycleApi(mockEmbedApi())).not.toBeNull();
  });

  it('returns null for null embedApi', () => {
    expect(getAssetLifecycleApi(null)).toBeNull();
  });

  it('returns null when writeImageIntoOwnedAssets missing', () => {
    const api = mockEmbedApi({ writeImageIntoOwnedAssets: undefined });
    expect(getAssetLifecycleApi(api)).toBeNull();
  });
});

describe('localizeMarkdownImages', () => {
  const opts = {
    pageUrl: 'https://example.com/page',
    documentPath: '/data/documents/clipper/test.md',
  };

  it('returns original markdown when embedApi is null', async () => {
    const md = '![](https://a.test/1.png)';
    const result = await localizeMarkdownImages(md, { ...opts, assetApi: null });
    expect(result.markdown).toBe(md);
    expect(result.warnings).toEqual([]);
  });

  it('returns original markdown when no remote images', async () => {
    const api = mockAssetApi();
    const md = '![](assets/local.png) and text';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl: mockFetch({}),
    });
    expect(result.markdown).toBe(md);
    expect(result.warnings).toEqual([]);
    expect(api.writeImageIntoOwnedAssets).not.toHaveBeenCalled();
  });

  it('downloads and rewrites image paths', async () => {
    const api = mockAssetApi();
    const fetchImpl = mockFetch({
      'https://a.test/1.png': { ok: true, body: 'png-data' },
      'https://b.test/2.jpg': { ok: true, body: 'jpg-data' },
    });
    const md = '![](https://a.test/1.png)\n![alt](https://b.test/2.jpg)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl,
    });
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toContain('assets/1.png');
    expect(result.markdown).toContain('assets/2.jpg');
    expect(result.markdown).not.toContain('https://a.test/1.png');
    expect(result.markdown).not.toContain('https://b.test/2.jpg');
    expect(api.writeImageIntoOwnedAssets).toHaveBeenCalledTimes(2);
    expect(api.reconcileOwnedAssets).toHaveBeenCalledTimes(1);
  });

  it('keeps original URL on download failure and adds warning', async () => {
    const api = mockAssetApi();
    const fetchImpl = mockFetch({
      'https://a.test/ok.png': { ok: true },
      'https://b.test/fail.png': { ok: false, status: 403 },
    });
    const md = '![](https://a.test/ok.png)\n![](https://b.test/fail.png)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl,
    });
    expect(result.markdown).toContain('assets/ok.png');
    expect(result.markdown).toContain('https://b.test/fail.png');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('1 张图片下载失败');
  });

  it('blocks SSRF to private addresses', async () => {
    const api = mockAssetApi();
    const fetchImpl = mockFetch({});
    const md = '![](http://127.0.0.1/secret.png)\n![](http://10.0.0.1/internal.png)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl,
    });
    expect(result.markdown).toBe(md); // 全部保留原 URL
    expect(result.warnings.length).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks SSRF to localhost hostname', async () => {
    const api = mockAssetApi();
    const md = '![](http://localhost/admin.png)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl: mockFetch({}),
    });
    expect(result.markdown).toBe(md);
    expect(result.warnings[0]).toContain('1 张图片下载失败');
  });

  it('handles empty response body gracefully', async () => {
    const api = mockAssetApi();
    const md = '![](https://a.test/empty.png)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl: mockFetch({ 'https://a.test/empty.png': { ok: true, body: '' } }),
    });
    // 空字节图片仍写入 assets（writeImageIntoOwnedAssets 不检查内容有效性）
    expect(result.markdown).toContain('assets/empty.png');
  });

  it('preserves alt text in rewritten markdown', async () => {
    const api = mockAssetApi();
    const md = '![描述文字](https://a.test/1.png)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl: mockFetch({ 'https://a.test/1.png': { ok: true } }),
    });
    expect(result.markdown).toBe('![描述文字](assets/1.png)');
  });

  it('defaults extension to .png when URL has none', async () => {
    const api = mockAssetApi();
    const md = '![](https://a.test/no-ext-image)';
    const result = await localizeMarkdownImages(md, {
      ...opts,
      assetApi: api,
      fetchImpl: mockFetch({ 'https://a.test/no-ext-image': { ok: true } }),
    });
    expect(result.markdown).toContain('assets/no-ext-image.png');
    expect(api.writeImageIntoOwnedAssets).toHaveBeenCalledWith(
      opts.documentPath,
      'no-ext-image.png',
      expect.any(Buffer),
    );
  });
});

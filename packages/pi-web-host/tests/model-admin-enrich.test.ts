/**
 * model-admin/model-enrich.ts 单元测试（零网络）
 *
 * id 归一化 / 档位后缀剥离 / 目录索引 / 两个目录源的解析 / 网页参数提取，
 * 以及 enrichBatch 的 hint、URL、自动匹配、家族建议、中断与双源不可达分支。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeModelId,
  stripTierSuffix,
  buildIndex,
  parseOpenRouterCatalog,
  parseModelsDevCatalog,
  extractParamsFromHtml,
  enrichBatch,
  getOpenRouterCatalog,
  type CatalogModel,
} from '../src/model-admin/model-enrich';

function model(partial: Partial<CatalogModel> & { id: string }): CatalogModel {
  return { provider: 'p', rawId: partial.id, name: partial.id, ...partial };
}

describe('normalizeModelId', () => {
  it('should trim, lowercase, normalize underscores and drop the provider prefix', () => {
    expect(normalizeModelId('  OpenAI/GPT_4O  ')).toBe('gpt-4o');
    expect(normalizeModelId('a/b/c')).toBe('c');
    expect(normalizeModelId('plain')).toBe('plain');
  });
});

describe('stripTierSuffix', () => {
  it('should strip routing tiers repeatedly', () => {
    expect(stripTierSuffix('gemini-3-pro-high')).toBe('gemini-3-pro');
    expect(stripTierSuffix('gemini-3-pro-thinking-high')).toBe('gemini-3-pro');
  });

  it('should strip date suffixes', () => {
    expect(stripTierSuffix('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
    expect(stripTierSuffix('model-0813')).toBe('model');
  });

  it('should keep real family suffixes', () => {
    expect(stripTierSuffix('gemini-3-pro')).toBe('gemini-3-pro');
    expect(stripTierSuffix('gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  it('should not strip a short id down to nothing', () => {
    expect(stripTierSuffix('hi')).toBe('hi');
  });
});

describe('buildIndex', () => {
  it('should index ids and distinct names', () => {
    const a = model({ id: 'Alpha', name: 'Alpha' });
    const b = model({ id: 'beta', name: 'Beta Model' });
    const index = buildIndex([a, b]);
    expect(index.byId.get('alpha')).toEqual([a]);
    expect(index.byName.get('beta model')).toEqual([b]);
    expect(index.byName.has('alpha')).toBe(false);
    expect(index.all).toEqual([a, b]);
  });

  it('should group duplicate ids', () => {
    const a = model({ id: 'dup' });
    const b = model({ id: 'DUP', provider: 'q' });
    const index = buildIndex([a, b]);
    expect(index.byId.get('dup')).toHaveLength(2);
  });
});

describe('parseOpenRouterCatalog', () => {
  it('should return an empty list for malformed input', () => {
    expect(parseOpenRouterCatalog(null)).toEqual([]);
    expect(parseOpenRouterCatalog({})).toEqual([]);
    expect(parseOpenRouterCatalog({ data: 'x' })).toEqual([]);
  });

  it('should parse ids, provider, context, vision and reasoning', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4',
          name: 'Claude Sonnet 4',
          architecture: { input_modalities: ['text', 'image'] },
          top_provider: { context_length: 200000, max_completion_tokens: 8192 },
          supported_parameters: ['tools', 'reasoning'],
        },
        { id: '   ' },
        { id: 'openai/gpt-4o' },
      ],
    });
    expect(models).toEqual([
      {
        id: 'claude-sonnet-4',
        provider: 'anthropic',
        rawId: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        contextWindow: 200000,
        maxTokens: 8192,
        vision: true,
        reasoning: true,
      },
      {
        id: 'gpt-4o',
        provider: 'openai',
        rawId: 'openai/gpt-4o',
        name: 'gpt-4o',
        contextWindow: undefined,
        maxTokens: undefined,
        vision: undefined,
        reasoning: undefined,
      },
    ]);
  });

  it('should fall back to top-level context_length and ignore non-positive numbers', () => {
    const [entry] = parseOpenRouterCatalog({
      data: [{ id: 'x', context_length: 1000, top_provider: { context_length: 0 } }],
    });
    expect(entry?.contextWindow).toBe(1000);
  });

  it('should use the tail of an unqualified id as name', () => {
    const [entry] = parseOpenRouterCatalog({ data: [{ id: 'z' }] });
    expect(entry).toMatchObject({ id: 'z', provider: '', name: 'z' });
  });
});

describe('parseModelsDevCatalog', () => {
  it('should parse providers, limits, family, vision and reasoning', () => {
    const models = parseModelsDevCatalog({
      acme: {
        models: {
          'acme/fast-1': {
            id: 'acme/fast-1',
            name: 'Fast One',
            family: 'FAST',
            limit: { context: 64000, output: 4096 },
            modalities: { input: ['text', 'image'] },
            reasoning: true,
          },
          bare: {},
        },
        ignored: 'x',
      },
      broken: { models: 'nope' },
    });
    expect(models[0]).toEqual({
      id: 'fast-1',
      provider: 'acme',
      rawId: 'acme/fast-1',
      name: 'Fast One',
      family: 'fast',
      contextWindow: 64000,
      maxTokens: 4096,
      vision: true,
      reasoning: true,
    });
    expect(models[1]).toMatchObject({ id: 'bare', provider: 'acme', name: 'bare' });
    expect(models).toHaveLength(2);
  });

  it('should skip entries whose id normalises to nothing', () => {
    expect(parseModelsDevCatalog({ p: { models: { '   ': {} } } })).toEqual([]);
  });
});

describe('extractParamsFromHtml', () => {
  it('should extract context / output / vision from plain text', () => {
    expect(extractParamsFromHtml('<p>128K token context</p>')).toMatchObject({
      contextWindow: 128000,
    });
    expect(extractParamsFromHtml('<p>1000000 tokens context</p>')).toMatchObject({
      contextWindow: 1000000,
    });
    expect(extractParamsFromHtml('<p>8192 tokens max output</p>')).toMatchObject({
      maxTokens: 8192,
    });
    expect(extractParamsFromHtml('<p>Maximum output: 8K tokens</p>')).toMatchObject({
      maxTokens: 8000,
    });
    expect(extractParamsFromHtml('<p>Image input supported</p>')).toMatchObject({ vision: true });
  });

  it('should ignore scripts and styles', () => {
    expect(
      extractParamsFromHtml('<script>128K token context</script><style>9K output</style>'),
    ).toEqual({});
  });

  it('should reject out-of-range values', () => {
    expect(extractParamsFromHtml('<p>999M token context</p>')).toEqual({});
    expect(extractParamsFromHtml('<p>0K token context</p>')).toEqual({});
  });
});

describe('enrichBatch', () => {
  const orCatalog: CatalogModel[] = [
    model({
      id: 'gemini-3-pro',
      rawId: 'google/gemini-3-pro',
      name: 'Gemini 3 Pro',
      provider: 'google',
      contextWindow: 1000000,
      maxTokens: 65536,
      vision: true,
    }),
    model({ id: 'cool-1', rawId: 'x/cool-1', name: 'Cool Model', provider: 'x' }),
    model({ id: 'or-model', rawId: 'y/or-model', provider: 'y' }),
  ];
  const mdCatalog: CatalogModel[] = [
    model({
      id: 'md-only',
      rawId: 'md-only',
      name: 'MD Only',
      provider: 'md',
      contextWindow: 32000,
    }),
    model({ id: 'or-model', rawId: 'or-model', provider: 'md', reasoning: true }),
    model({ id: 'gpt-family-1', rawId: 'gpt-family-1', provider: 'md', family: 'gpt' }),
  ];

  function opts(extra: Record<string, unknown> = {}) {
    return { catalogs: { openrouter: orCatalog, modelsdev: mdCatalog }, ...extra };
  }

  it('should match an exact OpenRouter id', async () => {
    const [result] = await enrichBatch(['gemini-3-pro'], {}, opts());
    expect(result).toMatchObject({
      id: 'gemini-3-pro',
      status: 'matched',
      contextWindow: 1000000,
      maxTokens: 65536,
      input: ['text', 'image'],
      matchType: 'exact',
      source: 'OpenRouter',
    });
  });

  it('should match an alias through tier-suffix stripping', async () => {
    const [result] = await enrichBatch(['gemini-3-pro-high'], {}, opts({ lang: 'zh' }));
    expect(result).toMatchObject({ status: 'matched', matchType: 'normalized' });
    expect(result?.source).toContain('别名');
  });

  it('should match by catalog name', async () => {
    const [result] = await enrichBatch(['cool model'], {}, opts());
    expect(result).toMatchObject({ status: 'matched', matchType: 'exact' });
  });

  it('should prefer a hint id over automatic matching', async () => {
    const [result] = await enrichBatch(['alias-model'], { 'alias-model': 'gemini-3-pro' }, opts());
    expect(result).toMatchObject({
      id: 'alias-model',
      status: 'matched',
      matchType: 'hint',
      source: 'Evidence',
      contextWindow: 1000000,
    });
  });

  it('should resolve a hint id from models.dev', async () => {
    const [result] = await enrichBatch(['alias-model'], { 'alias-model': 'md-only' }, opts());
    expect(result).toMatchObject({ status: 'matched', matchType: 'hint' });
  });

  it('should extract parameters from a hint URL', async () => {
    const [result] = await enrichBatch(
      ['web-model'],
      { 'web-model': 'https://docs.example.com/web-model' },
      opts({
        pageFetch: () =>
          Promise.resolve(
            '<p>200K token context</p><p>Maximum output: 16K tokens</p><p>Image input</p>',
          ),
      }),
    );
    expect(result).toMatchObject({
      status: 'matched',
      matchType: 'hint-url',
      contextWindow: 200000,
      maxTokens: 16000,
      input: ['text', 'image'],
    });
  });

  it('should report an unmatched hint URL with no usable params', async () => {
    const [result] = await enrichBatch(
      ['web-model'],
      { 'web-model': 'https://docs.example.com/empty' },
      opts({ pageFetch: () => Promise.resolve('<p>nothing here</p>') }),
    );
    expect(result).toMatchObject({ status: 'unmatched' });
    expect(String(result?.note)).toContain('No usable params');
  });

  it('should report an unmatched hint URL when the fetch fails', async () => {
    const [result] = await enrichBatch(
      ['web-model'],
      { 'web-model': 'https://docs.example.com/boom' },
      opts({
        pageFetch: () => {
          throw new Error('network');
        },
      }),
    );
    expect(result).toMatchObject({ status: 'unmatched' });
    expect(String(result?.note)).toContain('Failed to fetch');
  });

  it('should report an unknown hint id', async () => {
    const [result] = await enrichBatch(['m'], { m: 'does-not-exist' }, opts());
    expect(result).toMatchObject({ status: 'unmatched' });
    expect(String(result?.note)).toContain('not found');
  });

  it('should fall back to models.dev', async () => {
    const [result] = await enrichBatch(['md-only'], {}, opts());
    expect(result).toMatchObject({ status: 'matched', source: 'models.dev', contextWindow: 32000 });
  });

  it('should enrich reasoning from models.dev when OpenRouter lacks it', async () => {
    const [result] = await enrichBatch(['or-model'], {}, opts());
    expect(result).toMatchObject({ status: 'matched', source: 'OpenRouter', reasoning: true });
  });

  it('should suggest a close family when nothing matches', async () => {
    const familyCatalog: CatalogModel[] = [
      model({ id: 'gpt-family-1', rawId: 'gpt-family-1', provider: 'md', family: 'gpt' }),
      model({ id: 'other-1', rawId: 'other-1', provider: 'md' }),
    ];
    const [result] = await enrichBatch(
      ['gpt-family-2'],
      {},
      { catalogs: { openrouter: [], modelsdev: familyCatalog } },
    );
    expect(result).toMatchObject({ status: 'suggested', matchType: 'family' });
    expect(result?.suggestions).toEqual(['gpt-family-1']);
  });

  // 回归：familySuggestions 曾在内层循环用 break，导致目录里第一条无 family
  // 的模型就让建议永久为空；修复后应继续扫描后续候选。
  it('should keep scanning after a family-less catalog row', async () => {
    const [result] = await enrichBatch(['gpt-family-2'], {}, opts());
    expect(result).toMatchObject({ status: 'suggested' });
  });

  it('should report unmatched without suggestions', async () => {
    const [result] = await enrichBatch(['totally-unknown'], {}, opts());
    expect(result).toMatchObject({ status: 'unmatched' });
    expect(result?.suggestions).toBeUndefined();
  });

  it('should trim, deduplicate and cap the input at 100 ids', async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `m-${i}`).concat([' m-0 ', '']);
    const results = await enrichBatch(ids, {}, opts());
    expect(results).toHaveLength(100);
    expect(results[0]?.id).toBe('m-0');
  });

  it('should throw with partial results when aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(enrichBatch(['x'], {}, opts({ signal: controller.signal }))).rejects.toMatchObject(
      {
        message: 'aborted',
        partialResults: [],
      },
    );
  });

  it('should stop mid-batch when the signal aborts', async () => {
    const controller = new AbortController();
    const results: unknown[] = [];
    await expect(
      enrichBatch(
        ['gemini-3-pro', 'cool-1'],
        {},
        {
          ...opts(),
          signal: controller.signal,
          onProgress: (p: { phase: string }) => {
            results.push(p);
            if (p.phase === 'matching') controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ message: 'aborted' });
  });

  it('should fail when both catalogs are unreachable', async () => {
    const failingFetch = vi.fn(() => Promise.reject(new Error('offline')));
    await expect(
      enrichBatch(['x'], {}, { fetchFn: failingFetch as unknown as typeof fetch, lang: 'en' }),
    ).rejects.toThrow(/unreachable/i);
  });
});

describe('getOpenRouterCatalog cache', () => {
  it('should fetch once and reuse the cached catalog', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'p/cached-model' }] })),
      }),
    );
    const first = await getOpenRouterCatalog(fetchFn as unknown as typeof fetch);
    const second = await getOpenRouterCatalog(fetchFn as unknown as typeof fetch);
    expect(first[0]?.id).toBe('cached-model');
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('should surface an HTTP error', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      }),
    );
    // 缓存已在上一用例填充；用 models.dev 通道验证错误传播
    const { getModelsDevCatalog } = await import('../src/model-admin/model-enrich');
    await expect(getModelsDevCatalog(fetchFn as unknown as typeof fetch)).rejects.toThrow(
      'HTTP 503',
    );
  });
});

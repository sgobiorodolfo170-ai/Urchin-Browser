/**
 * GenOffice 嵌入包加载器单元测试（阶段 2）
 *
 * 验证：产物缺失返回 null、require 异常降级、成功加载走缓存、
 * scheme 特权列表在不可用时为空数组。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  __resetGenOfficeEmbedCache,
  getGenOfficeSchemePrivileges,
  loadGenOfficeEmbed,
} from '../../src/main/genoffice/loader';
import type { GenOfficeArtifacts } from '../../src/main/genoffice/paths';

function makeArtifacts(): GenOfficeArtifacts {
  return {
    embedPath: 'C:\\vendor\\embed.js',
    rendererRoots: { markdown: 'C:\\vendor\\renderer' },
    preloads: { markdown: 'C:\\vendor\\preload.js' },
  };
}

function makeEmbedApi() {
  return {
    GENOFFICE_SCHEME_PRIVILEGES: [{ scheme: 'genoffice-app', privileges: {} }],
    initGenOfficeEmbed: vi.fn(),
    createGenOfficeView: vi.fn().mockReturnValue({ id: 'view' }),
    genOfficeIsDirty: vi.fn().mockReturnValue(false),
    requestGenOfficeClose: vi.fn().mockResolvedValue(true),
  };
}

describe('loadGenOfficeEmbed', () => {
  beforeEach(() => {
    __resetGenOfficeEmbedCache();
  });

  it('should return null when artifacts are unavailable', () => {
    expect(loadGenOfficeEmbed({ resolveArtifacts: () => null })).toBeNull();
  });

  it('should load the bundle through the injected require and cache it', () => {
    const api = makeEmbedApi();
    const requireModule = vi.fn().mockReturnValue(api);

    const first = loadGenOfficeEmbed({ resolveArtifacts: makeArtifacts, requireModule });
    expect(first).toBe(api);
    expect(requireModule).toHaveBeenCalledWith('C:\\vendor\\embed.js');

    // 缓存命中：第二次不再 require
    const second = loadGenOfficeEmbed({ resolveArtifacts: makeArtifacts, requireModule });
    expect(second).toBe(api);
    expect(requireModule).toHaveBeenCalledTimes(1);
  });

  it('should degrade to null when require throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = loadGenOfficeEmbed({
      resolveArtifacts: makeArtifacts,
      requireModule: () => {
        throw new Error('boom');
      },
    });
    expect(result).toBeNull();
    errSpy.mockRestore();
  });

  it('should reject bundles missing createGenOfficeView', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = loadGenOfficeEmbed({
      resolveArtifacts: makeArtifacts,
      requireModule: () => ({}),
    });
    expect(result).toBeNull();
    errSpy.mockRestore();
  });

  it('should expose scheme privileges from the bundle, empty when unavailable', () => {
    const api = makeEmbedApi();
    __resetGenOfficeEmbedCache();
    expect(getGenOfficeSchemePrivileges({ resolveArtifacts: () => null })).toEqual([]);

    __resetGenOfficeEmbedCache();
    const privileges = getGenOfficeSchemePrivileges({
      resolveArtifacts: makeArtifacts,
      requireModule: () => api,
    });
    expect(privileges).toEqual(api.GENOFFICE_SCHEME_PRIVILEGES);
  });
});

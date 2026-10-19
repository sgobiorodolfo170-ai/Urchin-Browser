/**
 * GenOffice 嵌入包加载器单元测试（阶段 2）
 *
 * 验证：产物缺失返回 null、require 异常降级、成功加载走缓存、
 * scheme 特权列表优先读构建期抽取的轻量 JSON（启动优化），
 * JSON 缺失/损坏时回退嵌入包，产物完全缺失时为空数组。
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

  it('should fall back to bundle privileges without JSON, empty when everything is missing', () => {
    const api = makeEmbedApi();
    __resetGenOfficeEmbedCache();
    expect(
      getGenOfficeSchemePrivileges({
        resolveSchemePrivilegesPath: () => null,
        resolveArtifacts: () => null,
      }),
    ).toEqual([]);

    __resetGenOfficeEmbedCache();
    const privileges = getGenOfficeSchemePrivileges({
      resolveSchemePrivilegesPath: () => null,
      resolveArtifacts: makeArtifacts,
      requireModule: () => api,
    });
    expect(privileges).toEqual(api.GENOFFICE_SCHEME_PRIVILEGES);
  });
});

describe('getGenOfficeSchemePrivileges（抽取 JSON 优先，启动优化）', () => {
  beforeEach(() => {
    __resetGenOfficeEmbedCache();
  });

  it('should read privileges from the extracted JSON without loading the embed bundle', () => {
    const requireModule = vi.fn();
    const readTextFile = vi
      .fn()
      .mockReturnValue(
        JSON.stringify([{ scheme: 'genoffice-app', privileges: { standard: true } }]),
      );

    const privileges = getGenOfficeSchemePrivileges({
      resolveSchemePrivilegesPath: () => 'C:\\vendor\\scheme-privileges.json',
      readTextFile,
      resolveArtifacts: makeArtifacts,
      requireModule,
    });

    expect(privileges).toEqual([{ scheme: 'genoffice-app', privileges: { standard: true } }]);
    expect(readTextFile).toHaveBeenCalledWith('C:\\vendor\\scheme-privileges.json');
    expect(requireModule).not.toHaveBeenCalled();
  });

  it('should cache the JSON privileges across calls', () => {
    const readTextFile = vi.fn().mockReturnValue('[{"scheme":"a","privileges":{}}]');
    const deps = {
      resolveSchemePrivilegesPath: () => 'p.json',
      readTextFile,
    };

    getGenOfficeSchemePrivileges(deps);
    getGenOfficeSchemePrivileges(deps);

    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it('should fall back to the bundle when the JSON is malformed', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = makeEmbedApi();

    const privileges = getGenOfficeSchemePrivileges({
      resolveSchemePrivilegesPath: () => 'broken.json',
      readTextFile: () => '{not json',
      resolveArtifacts: makeArtifacts,
      requireModule: () => api,
    });

    expect(privileges).toEqual(api.GENOFFICE_SCHEME_PRIVILEGES);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('should fall back to the bundle when the JSON shape is invalid', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = makeEmbedApi();

    const privileges = getGenOfficeSchemePrivileges({
      resolveSchemePrivilegesPath: () => 'bad-shape.json',
      readTextFile: () => '[{"scheme":123}]',
      resolveArtifacts: makeArtifacts,
      requireModule: () => api,
    });

    expect(privileges).toEqual(api.GENOFFICE_SCHEME_PRIVILEGES);
    errSpy.mockRestore();
  });
});

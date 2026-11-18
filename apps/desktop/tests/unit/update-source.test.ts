/**
 * M20 更新源选择单元测试（2026-11-18 国内优先）
 *
 * 覆盖：
 * - 国内判定：zh* 语言、中国大陆时区，其余不命中
 * - 通道清单文件名：stable = latest.yml，dev = dev.yml
 * - Release 选择：通道 + 资产齐备 + 创建时间倒序
 * - feed URL 拼接与 tag 编码
 * - 拉取失败/非数组响应的降级语义（抛错由调用方兜底）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  atomgitFeedUrl,
  atomgitReleasesApiUrl,
  channelFileName,
  fetchAtomGitReleases,
  isDomesticLocale,
  pickDomesticFeed,
  type AtomGitRelease,
} from '../../src/main/update/update-source';

const stableRelease: AtomGitRelease = {
  tag_name: 'v0.3.1',
  prerelease: false,
  created_at: '2026-11-18T10:00:00+08:00',
  assets: [{ name: 'latest.yml' }, { name: 'Urchin-Browser-0.3.1-x64.exe' }],
};

const devRelease: AtomGitRelease = {
  tag_name: 'v0.3.1-dev.2',
  prerelease: true,
  created_at: '2026-11-18T12:00:00+08:00',
  assets: [{ name: 'dev.yml' }, { name: 'Urchin-Browser-0.3.1-dev.2-x64.exe' }],
};

describe('isDomesticLocale', () => {
  it('should treat zh locales as domestic', () => {
    expect(isDomesticLocale('zh-CN')).toBe(true);
    expect(isDomesticLocale('zh_TW')).toBe(true);
    expect(isDomesticLocale('zh')).toBe(true);
  });

  it('should treat mainland China time zones as domestic even for non-zh locales', () => {
    expect(isDomesticLocale('en-US', 'Asia/Shanghai')).toBe(true);
    expect(isDomesticLocale(undefined, 'Asia/Chongqing')).toBe(true);
  });

  it('should not treat other locales or time zones as domestic', () => {
    expect(isDomesticLocale('en-US', 'Europe/Berlin')).toBe(false);
    expect(isDomesticLocale(undefined, undefined)).toBe(false);
    expect(isDomesticLocale('ja-JP')).toBe(false);
  });
});

describe('channelFileName', () => {
  it('should map stable channel to latest.yml and prerelease channels to <channel>.yml', () => {
    expect(channelFileName('latest')).toBe('latest.yml');
    expect(channelFileName('dev')).toBe('dev.yml');
    expect(channelFileName('beta')).toBe('beta.yml');
  });
});

describe('atomgit feed helpers', () => {
  it('should request releases in descending order', () => {
    const url = atomgitReleasesApiUrl();
    expect(url).toContain('/repos/daichuanmu/Urchin-Browser/releases');
    expect(url).toContain('direction=desc');
  });

  it('should build a release asset directory URL and encode the tag', () => {
    expect(atomgitFeedUrl('v0.3.0')).toBe(
      'https://atomgit.com/daichuanmu/Urchin-Browser/releases/download/v0.3.0',
    );
    expect(atomgitFeedUrl('v0.3.0+x')).toContain('v0.3.0%2Bx');
  });
});

describe('pickDomesticFeed', () => {
  it('should pick the newest stable release with latest.yml', () => {
    const older: AtomGitRelease = {
      ...stableRelease,
      tag_name: 'v0.3.0',
      created_at: '2026-11-17T10:00:00+08:00',
    };
    const feed = pickDomesticFeed([older, stableRelease, devRelease], 'latest');
    expect(feed).toMatchObject({ tag: 'v0.3.1', channelFile: 'latest.yml' });
    expect(feed?.feedUrl).toContain('/releases/download/v0.3.1');
  });

  it('should pick the newest prerelease with dev.yml for the dev channel', () => {
    const feed = pickDomesticFeed([stableRelease, devRelease], 'dev');
    expect(feed).toMatchObject({ tag: 'v0.3.1-dev.2', channelFile: 'dev.yml' });
  });

  it('should sort by created_at instead of trusting input order', () => {
    const newer: AtomGitRelease = {
      ...stableRelease,
      tag_name: 'v0.4.0',
      created_at: '2026-11-19T00:00:00+08:00',
    };
    const feed = pickDomesticFeed([newer, stableRelease], 'latest');
    expect(feed?.tag).toBe('v0.4.0');
  });

  it('should skip releases whose channel file has not been uploaded', () => {
    const incomplete: AtomGitRelease = {
      ...stableRelease,
      tag_name: 'v0.3.2',
      created_at: '2026-11-19T00:00:00+08:00',
      assets: [{ name: 'Urchin-Browser-0.3.2-x64.exe' }],
    };
    const feed = pickDomesticFeed([incomplete, stableRelease], 'latest');
    expect(feed?.tag).toBe('v0.3.1');
  });

  it('should return null when no release matches the channel', () => {
    expect(pickDomesticFeed([devRelease], 'latest')).toBeNull();
    expect(pickDomesticFeed([stableRelease], 'dev')).toBeNull();
    expect(pickDomesticFeed([], 'latest')).toBeNull();
  });
});

describe('fetchAtomGitReleases', () => {
  it('should parse an array response', async () => {
    const fetchMock = vi.fn(
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([stableRelease]),
        }) as unknown as Promise<Response>,
    );
    await expect(fetchAtomGitReleases(fetchMock as unknown as typeof fetch)).resolves.toEqual([
      stableRelease,
    ]);
  });

  it('should throw on non-OK responses so the caller can fall back', async () => {
    const fetchMock = vi.fn(
      () => Promise.resolve({ ok: false, status: 503 }) as unknown as Promise<Response>,
    );
    await expect(fetchAtomGitReleases(fetchMock as unknown as typeof fetch)).rejects.toThrow('503');
  });

  it('should treat non-array payloads as empty', async () => {
    const fetchMock = vi.fn(
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ message: 'unexpected' }),
        }) as unknown as Promise<Response>,
    );
    await expect(fetchAtomGitReleases(fetchMock as unknown as typeof fetch)).resolves.toEqual([]);
  });
});

/**
 * 文件关联 · 纯函数单元测试（associations.ts）
 *
 * 验证：
 * 1. getExtensionsForGroup：音视频/文档/图片分组扩展名（源自 EXT_KIND 单一真源）
 * 2. buildProgId：ProgID 生成（小写、前缀）
 * 3. buildRegistryEntries：单个扩展名的注册表条目结构（默认值/OpenWithProgids/command/icon）
 * 4. buildAllRegistryEntries：去重 + 全部条目
 * 5. parseFileArg：裸路径 / file:// URL / 大小写 / 空参数 / 选项参数 / argv0 跳过
 */
import { describe, it, expect } from 'vitest';
import {
  ASSOCIATION_GROUPS,
  buildAllRegistryEntries,
  buildProgId,
  buildRegistryEntries,
  getExtensionsForGroup,
  parseFileArg,
} from '../../src/main/file-association/associations';

describe('getExtensionsForGroup', () => {
  it('should return audio and video extensions for media group', () => {
    const media = ASSOCIATION_GROUPS.find((g) => g.id === 'media')!;
    const exts = getExtensionsForGroup(media);
    expect(exts).toContain('mp3');
    expect(exts).toContain('mp4');
    expect(exts).toContain('wav');
    expect(exts).not.toContain('pdf');
    // 去重 + 字母序
    expect([...exts].sort()).toEqual([...exts]);
  });

  it('should return pdf/markdown/json/text extensions for documents group', () => {
    const docs = ASSOCIATION_GROUPS.find((g) => g.id === 'documents')!;
    const exts = getExtensionsForGroup(docs);
    expect(exts).toContain('pdf');
    expect(exts).toContain('md');
    expect(exts).toContain('json');
    expect(exts).toContain('txt');
    expect(exts).toContain('html');
    expect(exts).not.toContain('mp3');
  });

  it('should return image extensions for images group', () => {
    const images = ASSOCIATION_GROUPS.find((g) => g.id === 'images')!;
    const exts = getExtensionsForGroup(images);
    expect(exts).toContain('png');
    expect(exts).toContain('jpg');
    expect(exts).toContain('svg');
  });
});

describe('buildProgId', () => {
  it('should build lowercase ProgID with prefix', () => {
    expect(buildProgId('MP3')).toBe('UrchinBrowser.mp3');
    expect(buildProgId('.mp3')).toBe('UrchinBrowser..mp3'); // 调用方负责去点
  });
});

describe('buildRegistryEntries', () => {
  it('should build 5 entries for one extension', () => {
    const entries = buildRegistryEntries('mp3', 'C:\\apps\\urchin.exe');
    expect(entries).toHaveLength(5);
    // .mp3 默认值 = ProgID
    expect(entries[0]).toEqual({
      key: 'HKCU\\Software\\Classes\\.mp3',
      valueName: '/d',
      value: 'UrchinBrowser.mp3',
    });
    // OpenWithProgids 登记
    expect(entries[1]).toEqual({
      key: 'HKCU\\Software\\Classes\\.mp3\\OpenWithProgids',
      valueName: 'UrchinBrowser.mp3',
      value: '',
    });
    // open 命令带引号 exe + "%1"
    const command = entries.find((e) => e.key.endsWith('shell\\open\\command'));
    expect(command?.value).toBe('"C:\\apps\\urchin.exe" "%1"');
    // DefaultIcon 用 exe 图标
    const icon = entries.find((e) => e.key.endsWith('DefaultIcon'));
    expect(icon?.value).toBe('"C:\\apps\\urchin.exe",0');
  });

  it('should normalize leading dot and uppercase', () => {
    const entries = buildRegistryEntries('.MP3', 'C:\\a.exe');
    expect(entries[0]?.key).toBe('HKCU\\Software\\Classes\\.mp3');
  });
});

describe('buildAllRegistryEntries', () => {
  it('should dedupe extensions and keep order', () => {
    const entries = buildAllRegistryEntries(['mp3', 'mp3', 'mp4'], 'C:\\a.exe');
    expect(entries).toHaveLength(10); // 2 个扩展名 × 5 条
  });
});

describe('parseFileArg', () => {
  it('should return null when no file argument', () => {
    expect(parseFileArg(['C:\\apps\\urchin.exe'])).toBeNull();
    expect(parseFileArg(['C:\\apps\\urchin.exe', '--flag'])).toBeNull();
  });

  it('should skip argv0 (exe path) and return file path', () => {
    expect(parseFileArg(['C:\\apps\\urchin.exe', 'C:\\docs\\a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should parse file:// URL with slashes', () => {
    expect(parseFileArg(['exe', 'file:///C:/docs/a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should parse file:// URL without slashes', () => {
    expect(parseFileArg(['exe', 'file://C:/docs/a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should be case-insensitive for File:// prefix', () => {
    expect(parseFileArg(['exe', 'File:///C:/x.mp3'])).toBe('C:\\x.mp3');
  });

  it('should decode percent-encoded path', () => {
    expect(parseFileArg(['exe', 'file:///C:/%E6%96%B0%E5%BB%BA%20folder/a.mp3'])).toBe(
      'C:\\新建 folder\\a.mp3',
    );
  });

  it('should ignore option-like args before the file', () => {
    expect(parseFileArg(['exe', '--no-sandbox', 'D:\\data\\b.json'])).toBe('D:\\data\\b.json');
  });

  it('should return null for web URLs', () => {
    expect(parseFileArg(['exe', 'https://example.com'])).toBeNull();
  });
});

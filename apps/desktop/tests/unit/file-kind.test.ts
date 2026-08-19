/**
 * 本地文件类型分类（file-kind）单元测试
 *
 * 验证：
 * 1. 常见扩展名 → 正确 kind（音视频/PDF/图片/HTML/Markdown/JSON/文本）
 * 2. 扩展名大小写不敏感（MP4 → video）
 * 3. 无扩展名 / 未知扩展名 → binary
 * 4. getExt：带点、多级点、无点文件名边界
 * 5. inferMimeType：已知映射 + 未知回退 application/octet-stream
 */
import { describe, it, expect } from 'vitest';
import { classifyFileKind, getExt, inferMimeType } from '../../src/main/files/file-kind';

describe('getExt', () => {
  it('should return lowercase extension', () => {
    expect(getExt('song.MP3')).toBe('mp3');
  });

  it('should return empty string for no extension', () => {
    expect(getExt('README')).toBe('');
  });

  it('should return empty string for dotfile-like names (leading dot)', () => {
    expect(getExt('.gitignore')).toBe('');
  });

  it('should take the last extension for multi-dot names', () => {
    expect(getExt('archive.tar.gz')).toBe('gz');
  });
});

describe('classifyFileKind', () => {
  it('should classify audio formats', () => {
    for (const name of ['a.mp3', 'b.wav', 'c.ogg', 'd.m4a', 'e.flac', 'f.aac']) {
      expect(classifyFileKind(name), name).toBe('audio');
    }
  });

  it('should classify video formats', () => {
    for (const name of ['a.mp4', 'b.m4v', 'c.webm', 'd.mov', 'e.mkv', 'f.avi']) {
      expect(classifyFileKind(name), name).toBe('video');
    }
  });

  it('should classify pdf as pdf', () => {
    expect(classifyFileKind('doc.pdf')).toBe('pdf');
  });

  it('should classify image formats', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) {
      expect(classifyFileKind(name), name).toBe('image');
    }
  });

  it('should classify html as html', () => {
    expect(classifyFileKind('page.html')).toBe('html');
    expect(classifyFileKind('page.htm')).toBe('html');
  });

  it('should classify markdown formats', () => {
    expect(classifyFileKind('readme.md')).toBe('markdown');
    expect(classifyFileKind('readme.markdown')).toBe('markdown');
  });

  it('should classify json as json', () => {
    expect(classifyFileKind('data.json')).toBe('json');
  });

  it('should classify common text/code formats as text', () => {
    for (const name of ['a.txt', 'b.log', 'c.csv', 'd.ts', 'e.tsx', 'f.py', 'g.js', 'h.yaml']) {
      expect(classifyFileKind(name), name).toBe('text');
    }
  });

  it('should classify unknown extension as binary', () => {
    expect(classifyFileKind('archive.7z')).toBe('binary');
  });

  it('should classify no-extension file as binary', () => {
    expect(classifyFileKind('README')).toBe('binary');
  });

  it('should be case-insensitive (MP4 → video)', () => {
    expect(classifyFileKind('MOVIE.MP4')).toBe('video');
    expect(classifyFileKind('Song.Flac')).toBe('audio');
  });
});

describe('inferMimeType', () => {
  it('should return mapped mime type', () => {
    expect(inferMimeType('a.mp3')).toBe('audio/mpeg');
    expect(inferMimeType('b.mp4')).toBe('video/mp4');
    expect(inferMimeType('c.pdf')).toBe('application/pdf');
    expect(inferMimeType('d.png')).toBe('image/png');
    expect(inferMimeType('e.md')).toBe('text/markdown');
  });

  it('should fall back to application/octet-stream for unknown', () => {
    expect(inferMimeType('archive.7z')).toBe('application/octet-stream');
    expect(inferMimeType('README')).toBe('application/octet-stream');
  });
});

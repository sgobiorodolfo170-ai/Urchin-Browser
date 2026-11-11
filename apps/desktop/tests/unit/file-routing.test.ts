/**
 * 本地文件打开路由（shared/file-routing）单元测试
 *
 * 依据：ADR-021（FA4-FA8）。锁定的口径：
 * 1. 外部入口（external）：Office 三类直进 GenOffice，其余全走浏览器通道
 * 2. GenOffice 主页入口（genoffice）：能力表命中即进编辑器，否则转交浏览器
 * 3. recents 判定（isGenOfficeEditable）：文档类入、脚本/配置类不入
 * 4. 标签 URL 构造与编码
 */
import { describe, it, expect } from 'vitest';
import {
  GENOFFICE_EDITABLE_EXTENSIONS,
  EXTERNAL_GENOFFICE_KINDS,
  buildDirViewerUrl,
  buildFileViewerUrl,
  buildGenOfficeUrl,
  extOf,
  isGenOfficeEditable,
  resolveOpenTarget,
} from '../../src/shared/file-routing';

describe('extOf', () => {
  it('should take the lowercase extension from a windows path', () => {
    expect(extOf('C:\\Docs\\Report.DOCX')).toBe('docx');
    expect(extOf('C:/Docs/a.b.MP4')).toBe('mp4');
  });

  it('should return empty for no extension / dotfile whole name', () => {
    expect(extOf('C:\\Docs\\README')).toBe('');
    expect(extOf('C:\\Docs\\.gitignore')).toBe('');
    expect(extOf('C:\\Docs\\trailing.')).toBe('');
  });

  it('should treat a bare dotless name as having no extension', () => {
    expect(extOf('PNG')).toBe('');
    expect(extOf('folder\\name')).toBe('');
  });
});

describe('resolveOpenTarget · external（文件关联 / Ctrl+O / 拖放）', () => {
  it('should send Office documents to GenOffice (the only external exception)', () => {
    expect(resolveOpenTarget('docx', 'C:\\a\\report.docx', 'external')).toEqual({
      channel: 'genoffice',
      app: 'docs',
    });
    expect(resolveOpenTarget('pptx', 'C:\\a\\deck.pptx', 'external')).toEqual({
      channel: 'genoffice',
      app: 'slides',
    });
    expect(resolveOpenTarget('xlsx', 'C:\\a\\sheet.xlsx', 'external')).toEqual({
      channel: 'genoffice',
      app: 'sheets',
    });
  });

  it('should keep markdown / pdf / text in the browser viewer', () => {
    // 2026-11-11 口径调整：外部打开以浏览器阅读为主（简单编辑用 PlainTextEditor）
    expect(resolveOpenTarget('markdown', 'C:\\a\\note.md', 'external')).toEqual({
      channel: 'viewer',
    });
    expect(resolveOpenTarget('pdf', 'C:\\a\\doc.pdf', 'external')).toEqual({ channel: 'viewer' });
    expect(resolveOpenTarget('text', 'C:\\a\\notes.txt', 'external')).toEqual({
      channel: 'viewer',
    });
    expect(resolveOpenTarget('json', 'C:\\a\\data.json', 'external')).toEqual({
      channel: 'viewer',
    });
  });

  it('should open html as a normal web page tab', () => {
    expect(resolveOpenTarget('html', 'C:\\a\\page.html', 'external')).toEqual({
      channel: 'browser',
    });
  });

  it('should use the read-only MHTML viewer', () => {
    expect(resolveOpenTarget('mhtml', 'C:\\a\\snap.mhtml', 'external')).toEqual({
      channel: 'mhtml',
    });
  });

  it('should send media / images / binary to the viewer', () => {
    for (const [kind, name] of [
      ['audio', 'C:\\a\\song.mp3'],
      ['video', 'C:\\a\\movie.mp4'],
      ['image', 'C:\\a\\pic.png'],
      ['binary', 'C:\\a\\setup.exe'],
    ] as const) {
      expect(resolveOpenTarget(kind, name, 'external'), kind).toEqual({ channel: 'viewer' });
    }
  });

  it('should NOT widen the exception set beyond Office kinds', () => {
    // 能力表里有 csv（GenOffice 能编辑），但外部入口仍走浏览器——扩大例外需另行决策
    expect(resolveOpenTarget('text', 'C:\\a\\data.csv', 'external')).toEqual({
      channel: 'viewer',
    });
    expect([...EXTERNAL_GENOFFICE_KINDS].sort()).toEqual(['docx', 'pptx', 'xlsx']);
  });
});

describe('resolveOpenTarget · genoffice（GenOffice 主页入口）', () => {
  it('should open every GenOffice-editable format in the editor', () => {
    const cases = [
      ['docx', 'report.docx', 'docs'],
      ['xlsx', 'sheet.xlsx', 'sheets'],
      ['text', 'data.csv', 'sheets'],
      ['pptx', 'deck.pptx', 'slides'],
      ['pdf', 'doc.pdf', 'pdf'],
      ['markdown', 'note.md', 'markdown'],
      ['text', 'notes.txt', 'markdown'],
      ['json', 'data.json', 'markdown'],
      ['html', 'page.html', 'html'],
    ] as const;
    for (const [kind, name, app] of cases) {
      expect(resolveOpenTarget(kind, `C:\\a\\${name}`, 'genoffice'), name).toEqual({
        channel: 'genoffice',
        app,
      });
    }
  });

  it('should hand unsupported formats over to the browser channel', () => {
    expect(resolveOpenTarget('image', 'C:\\a\\pic.png', 'genoffice')).toEqual({
      channel: 'viewer',
    });
    expect(resolveOpenTarget('video', 'C:\\a\\movie.mp4', 'genoffice')).toEqual({
      channel: 'viewer',
    });
    expect(resolveOpenTarget('binary', 'C:\\a\\setup.exe', 'genoffice')).toEqual({
      channel: 'viewer',
    });
  });

  it('should treat script / config files as not GenOffice-editable', () => {
    // 它们能在 GenOffice 源码视图里打开，但不应进入「最近打开」列表
    for (const name of ['a.sh', 'a.ps1', 'a.bat', 'a.js', 'a.ts', 'a.css', 'a.ini', 'a.log']) {
      expect(isGenOfficeEditable(`C:\\a\\${name}`), name).toBe(false);
      expect(resolveOpenTarget('text', `C:\\a\\${name}`, 'genoffice'), name).toEqual({
        channel: 'viewer',
      });
    }
  });
});

describe('isGenOfficeEditable', () => {
  it('should include document formats', () => {
    for (const ext of ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'markdown', 'txt', 'json', 'html']) {
      expect(isGenOfficeEditable(`C:\\a\\file.${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it('should expose a single capability table for future editors', () => {
    // 未来 GenOffice 支持图片/音视频编辑器时，只需在表里追加扩展名
    expect(GENOFFICE_EDITABLE_EXTENSIONS.get('png')).toBeUndefined();
    expect(GENOFFICE_EDITABLE_EXTENSIONS.size).toBeGreaterThan(10);
  });
});

describe('标签 URL 构造', () => {
  it('should encode file paths', () => {
    expect(buildFileViewerUrl('C:\\壁纸\\a.mp4')).toBe(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\壁纸\\a.mp4'),
    );
    expect(buildDirViewerUrl('C:\\Pictures')).toBe(
      'urchin://file-viewer/?dir=' + encodeURIComponent('C:\\Pictures'),
    );
    expect(buildGenOfficeUrl('docs', 'C:\\a\\b.docx')).toBe(
      'urchin://genoffice/?kind=docs&path=' + encodeURIComponent('C:\\a\\b.docx'),
    );
  });

  it('should keep characters that break naive URL concatenation encoded', () => {
    const url = buildFileViewerUrl('C:\\a\\weird#name?.md');
    expect(url).not.toContain('#name');
    expect(url).toContain(encodeURIComponent('C:\\a\\weird#name?.md'));
  });
});

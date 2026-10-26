/**
 * parse-bookmarks-html · Netscape 书签 HTML 解析器单测
 */
import { describe, it, expect } from 'vitest';
import { parseNetscapeBookmarksHtml } from '../../src/main/import/parse-bookmarks-html';

const SAMPLE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1" ICON="data:">Example</A>
        <DT><A HREF="https://foo.bar/baz" ADD_DATE="2">Foo &amp; Bar</A>
        <DT><H3>子文件夹</H3>
        <DL><p>
            <DT><A HREF="https://sub.example.com/">Sub</A>
        </DL><p>
    </DL><p>
    <DT><H3>其他书签</H3>
    <DL><p>
        <DT><A HREF="https://other.example.com/">Other</A>
    </DL><p>
</DL><p>`;

describe('parseNetscapeBookmarksHtml', () => {
  it('should parse folders and bookmarks preserving hierarchy', () => {
    const root = parseNetscapeBookmarksHtml(SAMPLE_HTML);
    expect(root.children).toHaveLength(2);

    const bar = root.children![0]!;
    expect(bar.title).toBe('书签栏');
    expect(bar.children).toHaveLength(3);
    expect(bar.children![0]).toMatchObject({ title: 'Example', url: 'https://example.com/' });
    expect(bar.children![1]).toMatchObject({ title: 'Foo & Bar', url: 'https://foo.bar/baz' });

    const sub = bar.children![2]!;
    expect(sub.title).toBe('子文件夹');
    expect(sub.children).toHaveLength(1);
    expect(sub.children![0]).toMatchObject({ title: 'Sub', url: 'https://sub.example.com/' });

    const other = root.children![1]!;
    expect(other.title).toBe('其他书签');
    expect(other.children).toHaveLength(1);
  });

  it('should decode HTML entities in titles', () => {
    const root = parseNetscapeBookmarksHtml(SAMPLE_HTML);
    const bar = root.children![0]!;
    expect(bar.children![1]!.title).toBe('Foo & Bar');
  });

  it('should handle empty html gracefully', () => {
    const root = parseNetscapeBookmarksHtml('');
    expect(root.children).toHaveLength(0);
  });

  it('should skip <A> without HREF', () => {
    const root = parseNetscapeBookmarksHtml('<DL><p><DT><A>no href</A></DL><p>');
    expect(root.children).toHaveLength(0);
  });

  it('should treat top-level bookmarks (no H3) as root children', () => {
    const root = parseNetscapeBookmarksHtml(
      '<DL><p><DT><A HREF="https://a.example/">A</A><DT><A HREF="https://b.example/">B</A></DL><p>',
    );
    expect(root.children).toHaveLength(2);
  });
});

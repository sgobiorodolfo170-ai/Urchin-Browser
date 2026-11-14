import { describe, expect, it } from 'vitest';
import { renderNoteMarkdown, safeNoteUrl } from '../../src/renderer/notebook/note-markdown';

function renderMarkdown(content: string) {
  const element = document.createElement('div');
  element.innerHTML = renderNoteMarkdown(content);
  return element;
}

describe('note Markdown reading', () => {
  it('should render headings, formatting, tasks, tables, code and original line breaks', () => {
    const view = renderMarkdown(
      '## 计划\n\n**重点**与*想法*\n下一行\n\n- [x] 完成\n- [ ] 待办\n\n| 项目 | 状态 |\n| --- | --- |\n| 编辑器 | 完成 |\n\n```ts\nconst count = 1;\n```',
    );
    expect(view.querySelector('h2')?.textContent).toBe('计划');
    expect(view.querySelector('strong')?.textContent).toBe('重点');
    expect(view.querySelector('em')?.textContent).toBe('想法');
    expect(view.querySelector('br')).not.toBeNull();
    expect(view.querySelectorAll('input:disabled')).toHaveLength(2);
    expect(view.querySelector('input:checked')).not.toBeNull();
    expect(view.querySelector('td')?.textContent).toBe('编辑器');
    expect(view.querySelector('pre code')?.textContent).toContain('const count = 1;');
  });

  it('should display raw HTML as text without creating executable elements', () => {
    const source =
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<iframe src="https://example.com"></iframe>';
    const view = renderMarkdown(source);
    expect(view.querySelector('script, img, iframe, [onerror]')).toBeNull();
    expect(view.textContent).toContain('<script>alert(1)</script>');
    expect(view.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('should reject dangerous and local links while retaining safely rendered link text', () => {
    const view = renderMarkdown(
      '[**危险**](javascript:alert%281%29) [本地](file:///secret) [编码](jav&#x61;script:alert%281%29) [安全](https://example.com/?a=1&b=2)',
    );
    expect(view.querySelectorAll('a')).toHaveLength(1);
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://example.com/?a=1&b=2');
    expect(view.querySelector('strong')?.textContent).toBe('危险');
    expect(view.textContent).toContain('本地');
    expect(view.querySelector('a')?.getAttribute('rel')).toContain('noopener');
  });

  it('should allow web images and escape image attributes without loading data or local files', () => {
    const view = renderMarkdown(
      '![图片](https://example.com/image.png) ![数据](data:image/svg+xml,attack) ![本地](file:///image.png)',
    );
    expect(view.querySelectorAll('img')).toHaveLength(1);
    expect(view.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    expect(view.textContent).toContain('数据');
    expect(view.textContent).toContain('本地');
    expect(
      renderMarkdown('![" onerror="alert(1)](https://example.com/image.png)').querySelector(
        '[onerror]',
      ),
    ).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,attack',
    '/relative',
    '#shell',
    'file:///note',
    'https://',
  ])('should reject unsupported URL %s', (href) => {
    expect(safeNoteUrl(href)).toBeNull();
  });
});

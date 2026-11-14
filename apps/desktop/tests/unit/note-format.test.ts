import { describe, expect, it } from 'vitest';
import { formatNoteText, type NoteFormat } from '../../src/renderer/notebook/note-format';

function apply(content: string, start: number, end: number, format: NoteFormat) {
  const edit = formatNoteText(content, start, end, format);
  return { ...edit, content: content.slice(0, edit.start) + edit.text + content.slice(edit.end) };
}

describe('note formatting', () => {
  it('should wrap a selection and toggle it off without changing surrounding text', () => {
    const bold = apply('记录今天的想法', 2, 4, 'bold');
    expect(bold.content).toBe('记录**今天**的想法');
    expect(bold.content.slice(bold.selectionStart, bold.selectionEnd)).toBe('今天');
    const plain = apply(bold.content, bold.selectionStart, bold.selectionEnd, 'bold');
    expect(plain.content).toBe('记录今天的想法');
    expect(plain.content.slice(plain.selectionStart, plain.selectionEnd)).toBe('今天');
  });

  it('should select placeholder text when formatting at an empty caret', () => {
    const edit = apply('想法：', 3, 3, 'italic');
    expect(edit.content).toBe('想法：*斜体文字*');
    expect(edit.content.slice(edit.selectionStart, edit.selectionEnd)).toBe('斜体文字');
  });

  it('should add and remove italic inside bold without removing a bold delimiter', () => {
    const edit = apply('**重点**', 2, 4, 'italic');
    expect(edit.content).toBe('***重点***');
    expect(apply(edit.content, edit.selectionStart, edit.selectionEnd, 'italic').content).toBe(
      '**重点**',
    );
  });

  it.each([
    ['heading', '## 想法'],
    ['list', '- 想法'],
    ['checklist', '- [ ] 想法'],
    ['quote', '> 想法'],
    ['code', '`想法`'],
  ] as const)('should apply %s to the selected text', (format, expected) => {
    expect(apply('想法', 0, 2, format).content).toBe(expected);
  });

  it('should format selected lines without including the next unselected line', () => {
    const edit = apply('第一行\n第二行\n第三行', 0, 8, 'list');
    expect(edit.content).toBe('- 第一行\n- 第二行\n第三行');
    expect(apply(edit.content, edit.selectionStart, edit.selectionEnd, 'list').content).toBe(
      '第一行\n第二行\n第三行',
    );
  });

  it('should keep an empty caret on its line when adding and removing a prefix', () => {
    const edit = apply('上文\n想法', 4, 4, 'heading');
    expect(edit.content).toBe('上文\n## 想法');
    expect(edit.selectionStart).toBe(7);
    expect(edit.selectionEnd).toBe(7);
    const plain = apply(edit.content, 7, 7, 'heading');
    expect(plain.content).toBe('上文\n想法');
    expect(plain.selectionStart).toBe(4);
  });

  it('should handle a blank first line and completed checklist items', () => {
    expect(apply('\n下一行', 0, 0, 'list').content).toBe('- \n下一行');
    expect(apply('- [x] 完成\n- [ ] 待办', 0, 17, 'checklist').content).toBe('完成\n待办');
  });
});

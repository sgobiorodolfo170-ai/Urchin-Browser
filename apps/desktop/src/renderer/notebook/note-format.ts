/** Markdown 操作只替换选区或所在行，便于编辑器保留原生撤销与光标。 */
export type NoteFormat = 'heading' | 'bold' | 'italic' | 'list' | 'checklist' | 'quote' | 'code';

export interface NoteTextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export function formatNoteText(
  content: string,
  start: number,
  end: number,
  format: NoteFormat,
): NoteTextEdit {
  if (format === 'bold' || format === 'italic' || format === 'code') {
    const marker = format === 'bold' ? '**' : format === 'italic' ? '*' : '`';
    const selected = content.slice(start, end);
    const italicWrapped =
      marker !== '*' ||
      ((/\*+$/.exec(content.slice(0, start))?.[0].length ?? 0) % 2 === 1 &&
        (/^\*+/.exec(content.slice(end))?.[0].length ?? 0) % 2 === 1);
    if (
      start >= marker.length &&
      content.slice(start - marker.length, start) === marker &&
      content.slice(end, end + marker.length) === marker &&
      italicWrapped
    ) {
      return {
        start: start - marker.length,
        end: end + marker.length,
        text: selected,
        selectionStart: start - marker.length,
        selectionEnd: end - marker.length,
      };
    }
    const text =
      selected || (format === 'bold' ? '加粗文字' : format === 'italic' ? '斜体文字' : '代码');
    return {
      start,
      end,
      text: `${marker}${text}${marker}`,
      selectionStart: start + marker.length,
      selectionEnd: start + marker.length + text.length,
    };
  }

  const lineStart = start === 0 ? 0 : content.lastIndexOf('\n', start - 1) + 1;
  // 选区恰好结束在下一行开头时，不把未选中的下一行纳入操作。
  const lastSelected = end > start && content[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = content.indexOf('\n', lastSelected);
  const lineEnd = nextBreak === -1 ? content.length : nextBreak;
  const lines = content.slice(lineStart, lineEnd).split('\n');
  const prefix =
    format === 'heading'
      ? '## '
      : format === 'list'
        ? '- '
        : format === 'checklist'
          ? '- [ ] '
          : '> ';
  const pattern =
    format === 'heading'
      ? /^#{1,6} /
      : format === 'list'
        ? /^[-*+] /
        : format === 'checklist'
          ? /^- \[[ xX]\] /
          : /^> ?/;
  const remove = lines.every((line) => pattern.test(line));
  const text = lines
    .map((line) => (remove ? line.replace(pattern, '') : `${prefix}${line.replace(pattern, '')}`))
    .join('\n');
  const firstDelta = (text.split('\n')[0]?.length ?? 0) - (lines[0]?.length ?? 0);
  return {
    start: lineStart,
    end: lineEnd,
    text,
    selectionStart: start === end ? Math.max(lineStart, start + firstDelta) : lineStart,
    selectionEnd: start === end ? Math.max(lineStart, start + firstDelta) : lineStart + text.length,
  };
}

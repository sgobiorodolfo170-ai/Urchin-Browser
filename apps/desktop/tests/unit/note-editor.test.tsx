import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NoteEditor } from '../../src/renderer/notebook/NoteEditor';
import { NOTEBOOK_TEXT_MAX, type NotePage } from '../../src/renderer/notebook/types';

function renderEditor(content = '第一段\n第二段', title = '我的想法') {
  function Editor() {
    const [note, setNote] = useState<NotePage>({
      id: 'note-1',
      notebookId: 'nb-1',
      title,
      content,
      createdAt: 1,
      updatedAt: 1,
    });
    return (
      <NoteEditor note={note} onChange={(patch) => setNote((prev) => ({ ...prev, ...patch }))} />
    );
  }
  return render(<Editor />);
}

describe('NoteEditor', () => {
  it('should switch to reading without losing source, selection or the mounted editor', () => {
    renderEditor('## 计划\n\n**重点**');
    const body = screen.getByLabelText<HTMLTextAreaElement>('笔记正文');
    body.setSelectionRange(3, 5);
    fireEvent.click(screen.getByLabelText('阅读笔记'));
    const reading = screen.getByRole('region', { name: '笔记阅读' });
    expect(within(reading).getByRole('heading', { name: '我的想法' })).toBeInTheDocument();
    expect(within(reading).getByRole('heading', { name: '计划' })).toBeInTheDocument();
    expect(body).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('编辑笔记'));
    expect(screen.getByLabelText('笔记正文')).toBe(body);
    expect(body).toHaveValue('## 计划\n\n**重点**');
    expect(body.selectionStart).toBe(3);
    expect(body.selectionEnd).toBe(5);
    expect(body).toHaveFocus();
  });

  it('should format the selection by toolbar and keyboard and keep the selection useful', () => {
    renderEditor('今天的想法');
    const body = screen.getByLabelText<HTMLTextAreaElement>('笔记正文');
    body.setSelectionRange(0, 2);
    fireEvent.click(screen.getByLabelText('加粗'));
    expect(body).toHaveValue('**今天**的想法');
    expect(body.value.slice(body.selectionStart, body.selectionEnd)).toBe('今天');
    fireEvent.keyDown(body, { key: 'b', ctrlKey: true });
    expect(body).toHaveValue('今天的想法');
    fireEvent.keyDown(body, { key: 'i', metaKey: true });
    expect(body).toHaveValue('*今天*的想法');
  });

  it('should leave IME composition and title keyboard input alone', () => {
    renderEditor('输入中');
    const body = screen.getByLabelText<HTMLTextAreaElement>('笔记正文');
    fireEvent.compositionStart(body);
    fireEvent.keyDown(body, { key: 'b', ctrlKey: true, isComposing: true });
    fireEvent.click(screen.getByLabelText('加粗'));
    expect(body).toHaveValue('输入中');
    fireEvent.compositionEnd(body);
    fireEvent.keyDown(screen.getByLabelText('笔记标题'), { key: 'b', ctrlKey: true });
    expect(body).toHaveValue('输入中');
    fireEvent.keyDown(body, { key: 'M', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('region', { name: '笔记阅读' })).toBeVisible();
  });

  it('should adjust both views within font limits and show an empty reading state', () => {
    renderEditor('');
    const body = screen.getByLabelText<HTMLTextAreaElement>('笔记正文');
    expect(body.style.fontSize).toBe('16px');
    fireEvent.click(screen.getByLabelText('减小正文字号'));
    expect(body.style.fontSize).toBe('14px');
    expect(screen.getByLabelText('减小正文字号')).toBeDisabled();
    for (let index = 0; index < 5; index++) fireEvent.click(screen.getByLabelText('增大正文字号'));
    expect(body.style.fontSize).toBe('22px');
    expect(screen.getByLabelText('增大正文字号')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('阅读笔记'));
    expect(screen.getByText('还没有正文，切换到编辑模式开始记录。')).toBeVisible();
    expect(screen.getByText('0 字符')).toBeInTheDocument();
  });

  it('should refuse formatting that would exceed the persisted text limit', () => {
    renderEditor('字'.repeat(NOTEBOOK_TEXT_MAX));
    const body = screen.getByLabelText<HTMLTextAreaElement>('笔记正文');
    body.setSelectionRange(0, 1);
    fireEvent.click(screen.getByLabelText('加粗'));
    expect(body.value.length).toBe(NOTEBOOK_TEXT_MAX);
    expect(screen.getByRole('status')).toHaveTextContent('正文已达到长度上限');
  });

  it('should open reading links in a new app tab rather than replacing the editor', async () => {
    const invoke = vi.fn().mockResolvedValue({ windowId: 3 });
    Object.defineProperty(window, 'urchin', { configurable: true, value: { invoke } });
    renderEditor('[打开参考](https://example.com/)');
    fireEvent.click(screen.getByLabelText('阅读笔记'));
    fireEvent.click(screen.getByRole('link', { name: '打开参考' }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tab.create', {
        windowId: 3,
        url: 'https://example.com/',
        active: true,
      }),
    );
  });
});

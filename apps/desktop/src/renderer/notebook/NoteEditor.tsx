/** 中区笔记编辑器：Markdown 快捷操作与独立阅读模式，共用原有纯文本存储。 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  BookOpen,
  CheckSquare,
  Code,
  Heading2,
  Italic,
  List,
  Minus,
  PencilLine,
  Plus,
  Quote,
} from 'lucide-react';
import { getCurrentWindowId } from '../lib/current-window';
import { cn } from '../lib/utils';
import { formatNoteText, type NoteFormat } from './note-format';
import { renderNoteMarkdown, safeNoteUrl } from './note-markdown';
import { NOTEBOOK_TEXT_MAX, type NotePage } from './types';
import './note-editor.css';
import { parseTransitDrag } from '../transit/drag-utils';

const TOOL_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-30';
const FORMATS = [
  { format: 'heading', label: '二级标题', Icon: Heading2 },
  { format: 'bold', label: '加粗', shortcut: 'Ctrl/⌘ B', Icon: Bold },
  { format: 'italic', label: '斜体', shortcut: 'Ctrl/⌘ I', Icon: Italic },
  { format: 'list', label: '项目列表', Icon: List },
  { format: 'checklist', label: '待办列表', Icon: CheckSquare },
  { format: 'quote', label: '引用', Icon: Quote },
  { format: 'code', label: '行内代码', Icon: Code },
] as const;

export function NoteEditor({
  note,
  onChange,
}: {
  readonly note: NotePage;
  readonly onChange: (patch: Partial<Pick<NotePage, 'title' | 'content'>>) => void;
}) {
  const [reading, setReading] = useState(false);
  const [fontSize, setFontSize] = useState(16);
  const [message, setMessage] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const html = useMemo(
    () => (reading ? renderNoteMarkdown(note.content) : ''),
    [reading, note.content],
  );
  const characters = useMemo(
    () => Array.from(note.content.replace(/\s/g, '')).length,
    [note.content],
  );

  useLayoutEffect(() => {
    const selection = selectionRef.current;
    if (!reading && selection && bodyRef.current) {
      bodyRef.current.focus({ preventScroll: true });
      bodyRef.current.setSelectionRange(selection.start, selection.end);
      selectionRef.current = null;
    }
  }, [note.content, reading]);

  const toggleReading = () => {
    if (composingRef.current) return;
    if (!reading && bodyRef.current) {
      selectionRef.current = {
        start: bodyRef.current.selectionStart,
        end: bodyRef.current.selectionEnd,
      };
    }
    setReading((prev) => !prev);
  };

  const applyFormat = (format: NoteFormat) => {
    const body = bodyRef.current;
    if (!body || reading || composingRef.current) return;
    const edit = formatNoteText(body.value, body.selectionStart, body.selectionEnd, format);
    if (body.value.length - (edit.end - edit.start) + edit.text.length > NOTEBOOK_TEXT_MAX) {
      setMessage('正文已达到长度上限，请删减后再添加格式。');
      return;
    }
    setMessage('');
    body.focus({ preventScroll: true });
    body.setSelectionRange(edit.start, edit.end);
    selectionRef.current = { start: edit.selectionStart, end: edit.selectionEnd };
    // Chromium 的 insertText 会进入原生撤销栈；直接赋 value / setRangeText 会丢失撤销。
    const inserted =
      typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, edit.text);
    if (!inserted) body.setRangeText(edit.text, edit.start, edit.end, 'end');
    onChange({ content: body.value });
  };

  const openLink = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    event.preventDefault();
    const url = safeNoteUrl(anchor.getAttribute('href') ?? '');
    if (!url) return;
    void (async () => {
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url,
          active: true,
        });
      } catch {
        setMessage('链接打开失败，请稍后重试。');
      }
    })();
  };

  return (
    <div
      className="m-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
      onDrop={(event) => {
        const item = parseTransitDrag(event.dataTransfer);
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        const start = bodyRef.current?.selectionStart ?? note.content.length;
        const end = bodyRef.current?.selectionEnd ?? start;
        void (async () => {
          try {
            const text =
              item.filePath &&
              /\.(txt|md|markdown|csv|json|log|xml|html|css|js|ts)$/i.test(item.filePath)
                ? (
                    (await window.urchin.invoke('file.read', {
                      path: item.filePath,
                      maxBytes: 800000,
                    })) as { content: string }
                  ).content
                : (item.text ?? item.url ?? item.filePath ?? item.title);
            const inserted = text.slice(0, NOTEBOOK_TEXT_MAX - note.content.length + end - start);
            selectionRef.current = { start: start + inserted.length, end: start + inserted.length };
            setReading(false);
            onChange({
              content: note.content.slice(0, start) + inserted + note.content.slice(end),
            });
          } catch {
            setMessage('文字文件读取失败，请确认文件仍然存在。');
          }
        })();
      }}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          composingRef.current ||
          !(event.ctrlKey || event.metaKey) ||
          event.altKey
        )
          return;
        const key = event.key.toLowerCase();
        if (event.shiftKey && key === 'm') {
          event.preventDefault();
          event.stopPropagation();
          toggleReading();
        } else if (
          !reading &&
          event.target === bodyRef.current &&
          !event.shiftKey &&
          (key === 'b' || key === 'i')
        ) {
          event.preventDefault();
          event.stopPropagation();
          applyFormat(key === 'b' ? 'bold' : 'italic');
        }
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-secondary/30 px-3 py-2">
        <div
          className="flex items-center gap-1 rounded-lg bg-surface-secondary p-1"
          role="group"
          aria-label="笔记显示模式"
        >
          {[
            { label: '编辑', active: !reading, Icon: PencilLine },
            { label: '阅读', active: reading, Icon: BookOpen },
          ].map(({ label, active, Icon }) => (
            <button
              key={label}
              type="button"
              aria-label={`${label}笔记`}
              aria-pressed={active}
              title={`${label}笔记（Ctrl/⌘ Shift M）`}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                active
                  ? 'bg-surface font-medium text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => {
                if (!active) toggleReading();
              }}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        {!reading && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="笔记格式">
            {FORMATS.map(({ format, label, Icon, ...tool }) => (
              <button
                key={format}
                type="button"
                className={TOOL_BUTTON}
                aria-label={label}
                title={'shortcut' in tool ? `${label}（${tool.shortcut}）` : label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyFormat(format)}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="正文字号">
          <button
            type="button"
            className={TOOL_BUTTON}
            aria-label="减小正文字号"
            title="减小正文字号"
            disabled={fontSize <= 14}
            onClick={() => setFontSize((size) => Math.max(14, size - 2))}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span
            className="min-w-8 text-center text-xs tabular-nums text-text-secondary"
            aria-live="polite"
          >
            {fontSize}
          </span>
          <button
            type="button"
            className={TOOL_BUTTON}
            aria-label="增大正文字号"
            title="增大正文字号"
            disabled={fontSize >= 22}
            onClick={() => setFontSize((size) => Math.min(22, size + 2))}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* 切换模式时保留 textarea，维持原生撤销栈、选区与滚动位置。 */}
      <div
        hidden={reading}
        className={cn(
          'mx-auto w-full max-w-3xl min-h-0 flex-1 flex-col',
          reading ? 'hidden' : 'flex',
        )}
      >
        <input
          className="min-w-0 shrink-0 border-b border-border bg-transparent px-5 py-5 text-2xl font-semibold leading-snug text-text outline-none placeholder:text-text-secondary/50 focus:bg-primary/[0.02]"
          placeholder="笔记标题"
          value={note.title}
          maxLength={200}
          autoFocus
          onChange={(event) => onChange({ title: event.target.value })}
          aria-label="笔记标题"
        />
        <textarea
          ref={bodyRef}
          className="notebook-note-body min-h-0 flex-1 resize-none bg-transparent px-5 py-5 text-text outline-none placeholder:text-text-secondary/60"
          style={{ fontSize }}
          placeholder="记录想法，或用 Markdown 整理内容…"
          value={note.content}
          maxLength={NOTEBOOK_TEXT_MAX}
          spellCheck={false}
          aria-label="笔记正文"
          onChange={(event) => {
            setMessage('');
            onChange({ content: event.target.value });
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
      </div>
      {reading && (
        <div
          className="notebook-note-scroll min-h-0 min-w-0 flex-1 overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label="笔记阅读"
        >
          <article className="mx-auto max-w-3xl px-5 py-6">
            <h1 className="mb-6 break-words border-b border-border pb-5 text-2xl font-semibold leading-snug text-text">
              {note.title || '无标题笔记'}
            </h1>
            {note.content.trim() ? (
              <div
                className="prose-viewer notebook-note-preview"
                style={{ fontSize }}
                onClick={openLink}
                // renderNoteMarkdown 转义 HTML，并仅允许 http/https 链接与图片。
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <p className="py-8 text-sm leading-7 text-text-secondary">
                还没有正文，切换到编辑模式开始记录。
              </p>
            )}
          </article>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[11px] tabular-nums text-text-secondary">
        <span>
          {characters} 字符
          {characters > 0 && ` · 约 ${Math.max(1, Math.ceil(characters / 400))} 分钟`}
        </span>
        <span>Markdown</span>
        {message && (
          <p className="w-full text-error" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

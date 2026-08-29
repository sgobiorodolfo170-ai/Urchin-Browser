/**
 * 纯文本编辑器（PlainTextEditor）
 *
 * text/json 等非 Markdown 文本类的编辑形态：等宽 textarea 居中限宽
 * （与 Markdown 阅读列一致的网页式排版），**自动增高**——textarea 自身
 * 永不滚动（overflow-hidden + 高度随内容生长），纵向滚动归外层全宽容器、
 * 滚动条贴窗口边缘。这样同时满足「居中阅读列」与「滚动条贴边」两项要求
 * （textarea 若自带滚动，滚动条必然出现在居中列的右缘即页面中部）。
 * 受控交由父级 defaultValue + key 重挂载回读，避免受控光标跳动。
 * json 编辑的是磁盘原文，美化仅作用于阅读态显示（见 use-edit-session 设计要点）。
 */
import { useLayoutEffect, useRef } from 'react';

export interface PlainTextEditorProps {
  readonly initialContent: string;
  readonly onChange: (value: string) => void;
}

export function PlainTextEditor({ initialContent, onChange }: PlainTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  /** 高度随内容生长（置 auto 再取 scrollHeight，避免收缩滞后）。 */
  const resize = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    resize();
  }, [initialContent]);

  return (
    <div className="min-h-full">
      <textarea
        ref={ref}
        className="mx-auto block min-h-[60vh] w-full max-w-3xl resize-none overflow-hidden bg-surface px-6 py-4 font-mono text-sm leading-relaxed text-text outline-none"
        defaultValue={initialContent}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          resize();
        }}
      />
    </div>
  );
}

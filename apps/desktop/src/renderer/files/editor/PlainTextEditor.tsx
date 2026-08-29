/**
 * 纯文本编辑器（PlainTextEditor）
 *
 * text/json 等非 Markdown 文本类的编辑形态：等宽 textarea 铺满全宽
 * （滚动条贴窗口边缘——居中窄盒会把滚动条带到页面中部，2026-08-30 用户反馈；
 * 受控交由父级 defaultValue + key 重挂载回读，避免受控光标跳动）。
 * json 编辑的是磁盘原文，美化仅作用于阅读态显示（见 use-edit-session 设计要点）。
 */
export interface PlainTextEditorProps {
  readonly initialContent: string;
  readonly onChange: (value: string) => void;
}

export function PlainTextEditor({ initialContent, onChange }: PlainTextEditorProps) {
  return (
    <div className="h-full overflow-hidden">
      <textarea
        className="block h-full w-full resize-none bg-surface px-6 py-4 font-mono text-sm leading-relaxed text-text outline-none"
        defaultValue={initialContent}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

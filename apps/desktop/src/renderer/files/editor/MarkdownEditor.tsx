/**
 * Markdown 富文本编辑器（Tiptap 封装）
 *
 * 依赖（agents.md §七.4 依赖标注）：
 * - @tiptap/react@2 + @tiptap/starter-kit@2 + @tiptap/extension-link@2（MIT，
 *   ProseMirror 内核的 headless 编辑器，React 绑定）
 * - tiptap-markdown@0.8（MIT，社区维护，MD ↔ Tiptap 文档双向序列化）
 *   替换方案：Lexical（@lexical/markdown）/ Quill，选型理由见 docs/decisions/决策索引.md
 *
 * 安全（agents.md §六）：tiptap-markdown 配置 html:false——源内 raw HTML 一律
 * 不进文档模型（与阅读态 marked 渲染器丢 raw HTML 的策略一致），编辑器不会
 * 成为 XSS 注入面；输出经 React 渲染，无 dangerouslySetInnerHTML。
 *
 * 保真说明：保存输出为 tiptap 的 Markdown 规范化风格（如 *强调* → _强调_、
 * 列表符号统一），非逐字节往返——阅读/编辑互切同样经过此规范化。
 */
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import {
  Bold,
  Italic,
  Strikethrough,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Braces,
  Undo2,
  Redo2,
} from 'lucide-react';
import { cn } from '../../lib/utils';

export interface MarkdownEditorProps {
  /** 初始 Markdown 源（进入编辑时由会话重读的原文）。 */
  readonly initialContent: string;
  readonly onChange: (value: string) => void;
}

/** 从编辑器导出 Markdown（tiptap-markdown 注册的 storage）。 */
function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? '';
}

/** 工具条按钮（激活态高亮）。 */
function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded text-text-secondary hover:bg-surface-secondary hover:text-text',
        active && 'bg-primary/10 text-primary',
        disabled && 'opacity-30',
      )}
    >
      {children}
    </button>
  );
}

export function MarkdownEditor({ initialContent, onChange }: MarkdownEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false }),
      Markdown.configure({ html: false, linkify: false, breaks: true }),
    ],
    content: initialContent,
    onUpdate: ({ editor: e }) => {
      onChange(getMarkdown(e));
    },
  });

  if (!editor) {
    return <div className="flex-1 bg-surface" />;
  }

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus();

  return (
    <div className="flex h-full flex-col">
      {/* 格式工具条（v1 最小集：撤销重做/加粗/斜体/删除线/标题/列表/引用/代码）。
       * 内层与正文同宽（max-w-3xl + px-6）居中，按钮左缘与正文左缘对齐；
       * 外层条背景/分隔线保持通栏 */}
      <div className="shrink-0 border-b border-border bg-surface-secondary px-3 py-1.5">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-0.5 px-6">
          <ToolButton title="撤销" onClick={() => chain().undo().run()}>
            <Undo2 className="h-4 w-4" />
          </ToolButton>
          <ToolButton title="重做" onClick={() => chain().redo().run()}>
            <Redo2 className="h-4 w-4" />
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-border" />
          <ToolButton
            title="加粗"
            active={editor.isActive('bold')}
            onClick={() => chain().toggleBold().run()}
          >
            <Bold className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="斜体"
            active={editor.isActive('italic')}
            onClick={() => chain().toggleItalic().run()}
          >
            <Italic className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="删除线"
            active={editor.isActive('strike')}
            onClick={() => chain().toggleStrike().run()}
          >
            <Strikethrough className="h-4 w-4" />
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-border" />
          <ToolButton
            title="二级标题"
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => chain().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="三级标题"
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => chain().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className="h-4 w-4" />
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-border" />
          <ToolButton
            title="无序列表"
            active={editor.isActive('bulletList')}
            onClick={() => chain().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="有序列表"
            active={editor.isActive('orderedList')}
            onClick={() => chain().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="引用"
            active={editor.isActive('blockquote')}
            onClick={() => chain().toggleBlockquote().run()}
          >
            <Quote className="h-4 w-4" />
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-border" />
          <ToolButton
            title="行内代码"
            active={editor.isActive('code')}
            onClick={() => chain().toggleCode().run()}
          >
            <Code className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            title="代码块"
            active={editor.isActive('codeBlock')}
            onClick={() => chain().toggleCodeBlock().run()}
          >
            <Braces className="h-4 w-4" />
          </ToolButton>
        </div>
      </div>

      {/* 编辑区：复用阅读态 prose-viewer 排版（globals.css），编辑器自身去掉外框 */}
      <div className="flex-1 overflow-auto">
        <EditorContent
          editor={editor}
          className="prose-viewer mx-auto max-w-3xl px-6 py-4 [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none"
        />
      </div>
    </div>
  );
}

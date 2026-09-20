/**
 * GenOffice 文档主页（urchin://genoffice-home，阶段 4.5）
 *
 * 背景（用户指令 2026-09-20）：左侧栏「打开文件」按钮改为**嵌入的 GenOffice
 * 前端入口**——不再直接弹文件选择器，而是打开本主页作为文档模块的落点：
 * - 主操作：打开文件（走原有 file.open 选择器 → GenOffice 编辑器路由）
 * - 格式卡片：Word / PDF / Markdown / HTML（点击同样进入打开流程）
 * - AI 设置入口：跳到设置页「AI（GenOffice）」选项卡（与 pi 完全隔离）
 *
 * 设计理由：
 * - GenOffice 上游的 shell Home 依赖其专属 preload/IPC（window.aiOffice），
 *   不适合整页嵌入；本页用 Urchin 组件复刻「模块入口」所需的最小信息架构，
 *   视觉与主题完全跟随浏览器（settings/newtab 同族内部页机制）。
 * - 打开动作仍复用 handleOpenFilePicker（Ctrl+O 行为不变），保证单一入口逻辑。
 */
import { FileCode, FileText, FileType, FolderOpen, Globe, Sparkles } from 'lucide-react';
import { Button } from '../components/ui/button';

export interface GenOfficeHomeProps {
  /** 打开文件（native 选择器 → 按 kind 路由到 GenOffice 编辑器）。 */
  readonly onOpenFile: () => void;
  /** 跳转设置页「AI（GenOffice）」选项卡。 */
  readonly onOpenAiSettings: () => void;
}

/** 支持的文档格式卡片（信息展示 + 点击进入打开流程）。 */
const FORMATS = [
  {
    icon: FileText,
    name: 'Word 文档',
    ext: '.docx',
    desc: '打开与编辑，保存回真实格式',
  },
  {
    icon: FileType,
    name: 'PDF',
    ext: '.pdf',
    desc: '页面查看与文本编辑',
  },
  {
    icon: FileCode,
    name: 'Markdown',
    ext: '.md',
    desc: '块编辑器 + 实时渲染',
  },
  {
    icon: Globe,
    name: 'HTML',
    ext: '.html',
    desc: '源码编辑 + 实时预览',
  },
] as const;

export function GenOfficeHome({ onOpenFile, onOpenAiSettings }: GenOfficeHomeProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface text-text">
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        {/* 品牌区：模块图标 + 标题 + 定位说明 */}
        <header className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileText className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-medium">GenOffice 文档</h1>
            <p className="mt-1 text-sm text-text-secondary">
              本地文档编辑器（由 GenOffice 提供）：Word / PDF / Markdown / HTML。
              文件仅在本机打开与保存，不上传任何服务器。
            </p>
          </div>
        </header>

        {/* 主操作 */}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={onOpenFile}>
            <FolderOpen className="mr-1.5 h-4 w-4" />
            打开文件…
          </Button>
          <span className="text-xs text-text-secondary">
            也可使用 Ctrl+O，或直接把文件拖放到窗口
          </span>
        </div>

        {/* 格式卡片 */}
        <div className="mt-8 grid grid-cols-2 gap-3">
          {FORMATS.map(({ icon: Icon, name, ext, desc }) => (
            <button
              key={ext}
              type="button"
              onClick={onOpenFile}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface-secondary"
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{name}</span>
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    {ext}
                  </span>
                </span>
                <span className="mt-1 block text-xs text-text-secondary">{desc}</span>
              </span>
            </button>
          ))}
        </div>

        {/* AI 入口：GenOffice 原生 AI（与 pi 隔离） */}
        <section className="mt-8 rounded-lg border border-border bg-surface-secondary/40 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text">GenOffice 原生 AI</div>
              <p className="mt-1 text-xs text-text-secondary">
                文档编辑器内置 AI 面板使用 GenOffice 自己的模型与密钥（自备密钥 BYOK），
                与浏览器「AI 助手」（pi）完全隔离、互不读写配置。
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={onOpenAiSettings}>
              打开 AI 设置
            </Button>
          </div>
        </section>

        <p className="mt-6 text-xs text-text-secondary">
          提示：上述格式由 GenOffice 编辑器承载；音视频 / 图片 / JSON / 文本等仍由内置查看器打开。
        </p>
      </div>
    </div>
  );
}

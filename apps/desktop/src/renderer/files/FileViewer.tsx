/**
 * 本地文件查看器 / 文件夹浏览器（urchin://file-viewer）
 *
 * 职责：在主窗口 React 中渲染本地文件与文件夹浏览：
 * - 文件查看（?path=）：image → <img>；video/audio → 媒体元素；pdf → <iframe>
 *   （Chromium 内置 PDF 查看器）；markdown/json/txt → 文本渲染
 * - 目录浏览（?dir=）：文件夹网格（子目录在前 + 可预览文件），点击进入
 * - 同目录连续查看：打开文件时自动捕获所在目录，列出同目录全部可预览文件，
 *   工具栏上/下一个 + 键盘 ←/→ 在同标签内自由切换（不限类型）
 *
 * 数据/资源流：
 * - 文件元数据与目录列表经 IPC（file.stat / file.dir）
 * - 媒体/PDF/图片内容经 urchin://file-resource 协议流式加载（主进程 Range 支持）
 *
 * 安全（agents.md §六 跨进程边界 + XSS 防御）：
 * - 所有 IPC 入参/出参经 zod 校验（window.urchin.invoke 封装层自动执行）
 * - Markdown 渲染禁用 raw HTML（自定义 renderer 丢弃 <html> token），
 *   链接 href 仅放行 http/https/mailto/#，其余降级为纯文本
 * - json/txt 走 React 文本节点渲染（自动 HTML 转义），不用 dangerouslySetInnerHTML
 * - 本地文件内容经 file-resource 协议加载（主进程校验 Referer 必须 urchin://）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { marked, type Tokens } from 'marked';
import { Folder, FileText, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import type { FileKind } from '@urchin/ipc-contract';
import { getCurrentWindowId } from '../lib/current-window';

// ───────────────── 常量 ─────────────────

/** 视频键盘 seek 步进（秒）。 */
const VIDEO_SEEK_STEP = 10;
/** 视频键盘音量步进（0~1）：每按一次 ↑/↓ 增减 2%。 */
const VIDEO_VOLUME_STEP = 0.02;

/** 类型分类 → 展示徽标文案。 */
const KIND_LABELS: Readonly<Record<FileKind, string>> = {
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
  image: '图片',
  html: 'HTML',
  markdown: 'Markdown',
  json: 'JSON',
  text: '文本',
  binary: '二进制',
};

/** 可网页化预览的文件类型（序列成员）。html 走 file:// 直开、binary 不支持预览，均不入选。 */
const PREVIEWABLE_KINDS: ReadonlySet<FileKind> = new Set([
  'audio',
  'video',
  'pdf',
  'image',
  'markdown',
  'json',
  'text',
]);

/** 目录条目（与 ipc-contract FileDirEntry 对齐；invoke 返回 unknown，此处局部定型）。 */
interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly isDir: boolean;
  readonly size: number;
}

/** file.stat IPC 出参。 */
interface FileStatResult {
  readonly name: string;
  readonly size: number;
  readonly kind: FileKind;
}

/** file.read IPC 出参。 */
interface FileReadResult {
  readonly content: string;
}

// ───────────────── 工具函数（纯函数，便于单测） ─────────────────

/** 解析 urchin://file-viewer URL 的 path / dir 参数。 */
export function getViewerParams(url: string): { path: string | null; dir: string | null } {
  try {
    const u = new URL(url);
    if (u.hostname !== 'file-viewer') return { path: null, dir: null };
    return { path: u.searchParams.get('path'), dir: u.searchParams.get('dir') };
  } catch {
    return { path: null, dir: null };
  }
}

/** 从 urchin://file-viewer URL 提取文件绝对路径；URL 非法或无 path 参数返回 null。 */
export function extractViewerPath(url: string): string | null {
  return getViewerParams(url).path;
}

/** 构造 file-resource 资源 URL（FileViewer 内嵌媒体/PDF/图片加载用）。 */
export function fileResourceUrl(path: string): string {
  return `urchin://file-resource/${encodeURIComponent(path)}`;
}

/** 取路径所在目录（Windows 反斜杠 + 正斜杠兼容）；无目录分隔符返回原路径。 */
export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx <= 0 ? p : p.slice(0, idx);
}

/** 取目录的上一级；盘符根（C:\）或已到顶返回 null（无上一级）。 */
export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(parent)) return null;
  return parent.length > 0 ? parent : null;
}

/** 字节数 → 可读大小字符串（B/KB/MB/GB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** HTML 属性值转义（防属性注入）。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 链接协议白名单：http/https/mailto/页内锚点。 */
function isSafeLink(href: string): boolean {
  return /^(https?:|mailto:|#)/i.test(href);
}

/**
 * 构建安全 Markdown 渲染器：丢弃 raw HTML + 过滤危险链接。
 * v18 marked.parse 的 options.renderer 需要 _Renderer 实例（泛型显式 string）。
 */
function buildMarkdownRenderer() {
  const renderer = new marked.Renderer<string, string>();
  // raw HTML（如 <script>、<iframe>）一律丢弃，防 XSS（无参箭头函数：
  // TS 允许少参赋值给多参签名，且避免未使用参数触发 lint）
  renderer.html = (): string => '';
  // 非法协议链接降级为纯文本（保留可见文字，不生成 <a>）
  renderer.link = ({ href, title, text }: Tokens.Link): string => {
    if (!href || !isSafeLink(href)) return text;
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    return `<a href="${escapeAttr(href)}"${titleAttr}>${text}</a>`;
  };
  return renderer;
}

/**
 * JSON 内容美化：可解析则格式化缩进，不可解析（非 JSON）返回原文，
 * 由调用方按纯文本渲染。不抛异常。
 */
export function formatJsonContent(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

// ───────────────── 组件 ─────────────────

interface FileViewerProps {
  /** 当前激活标签的 URL（urchin://file-viewer/?path=... 或 ?dir=...）。 */
  readonly url: string;
  /** 导航回调（同标签切换到下一张/上级目录等），由 App 注入 handleNavigate。 */
  readonly onNavigate?: (url: string) => void;
}

/** 入口：按 URL 参数分发到文件查看 / 目录浏览。 */
export function FileViewer({ url, onNavigate }: FileViewerProps) {
  const { path, dir } = getViewerParams(url);
  if (dir !== null && path === null) {
    return <DirBrowser dir={dir} onNavigate={onNavigate} />;
  }
  return <FileViewerInner path={path} onNavigate={onNavigate} />;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'too-large'; readonly limitMb: number }
  | { readonly status: 'error'; readonly message: string };

/** 文件查看（单文件渲染 + 同类型连续导航）。 */
function FileViewerInner({
  path,
  onNavigate,
}: {
  readonly path: string | null;
  readonly onNavigate?: (url: string) => void;
}) {
  const [meta, setMeta] = useState<FileStatResult | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [content, setContent] = useState<string>('');
  const [markdownHtml, setMarkdownHtml] = useState<string>('');
  // 同目录序列：同目录下全部可预览文件（自动捕获所在文件夹），用于上/下一个自由切换
  const [sequence, setSequence] = useState<readonly string[]>([]);
  const [seqIndex, setSeqIndex] = useState(-1);
  // 视频元素引用：键盘 ←/→ 控制进度、↑/↓ 控制音量（仅视频查看模式）。
  // 音量浮层：按 ↑/↓ 调音量时短暂弹出（喇叭 + 竖条 + 百分比），1.5s 自动消失。
  // 原生 controls 的音量条只能点击喇叭弹出（Shadow DOM 不可编程触发），故自绘轻量浮层。
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [volume, setVolume] = useState(1);
  const [volumeVisible, setVolumeVisible] = useState(false);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理音量浮层计时器（避免卸载后 setState）
  useEffect(() => {
    return () => {
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    };
  }, []);

  /** 按音量键后短暂显示音量浮层（1.5s 后自动隐藏）。 */
  const showVolumeIndicator = useCallback(() => {
    setVolumeVisible(true);
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(() => setVolumeVisible(false), 1500);
  }, []);

  useEffect(() => {
    if (!path) {
      setState({ status: 'error', message: '无效的文件地址（缺少 path 参数）' });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const statRes = (await window.urchin.invoke('file.stat', { path })) as FileStatResult;
        if (cancelled) return;
        setMeta(statRes);

        // 同目录序列：读当前文件所在目录 → 收集全部可预览文件（不限类型，自动捕获目录）。
        // 当前文件自身也是序列成员（html/binary 除外，它们不进查看器）。
        if (PREVIEWABLE_KINDS.has(statRes.kind)) {
          try {
            const dirRes = (await window.urchin.invoke('file.dir', {
              path: dirname(path),
            })) as { entries: readonly DirEntry[] };
            if (cancelled) return;
            const files = dirRes.entries
              .filter((e) => !e.isDir && PREVIEWABLE_KINDS.has(e.kind))
              .map((e) => e.path);
            const idx = files.indexOf(path);
            setSequence(files);
            setSeqIndex(idx >= 0 ? idx : -1);
          } catch {
            // 目录读取失败（如单文件直开无权限）→ 无序列，仅单文件查看
            setSequence([]);
            setSeqIndex(-1);
          }
        } else {
          setSequence([]);
          setSeqIndex(-1);
        }

        // 文本类（markdown/json/text）读内容渲染；媒体/PDF/图片不读内容（资源协议加载）
        const textKinds: ReadonlySet<FileKind> = new Set(['markdown', 'json', 'text']);
        if (textKinds.has(statRes.kind)) {
          const readRes = (await window.urchin.invoke('file.read', { path })) as FileReadResult;
          if (cancelled) return;
          setContent(readRes.content);
          if (statRes.kind === 'markdown') {
            const html = await marked.parse(readRes.content, {
              gfm: true,
              breaks: true,
              renderer: buildMarkdownRenderer(),
            });
            if (cancelled) return;
            setMarkdownHtml(html);
          } else if (statRes.kind === 'json') {
            setContent(formatJsonContent(readRes.content));
          }
        }
        setState({ status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'FILE_TOO_LARGE'
        ) {
          setState({ status: 'too-large', limitMb: 5 });
        } else {
          setState({
            status: 'error',
            message: (err as Error)?.message ?? String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  /** 同类型序列导航：delta ±1；越界或无序列不动作。 */
  const navigateSeq = useCallback(
    (delta: number) => {
      if (seqIndex < 0 || sequence.length <= 1) return;
      const next = seqIndex + delta;
      if (next < 0 || next >= sequence.length) return;
      const target = sequence[next];
      if (target) onNavigate?.(`urchin://file-viewer/?path=${encodeURIComponent(target)}`);
    },
    [seqIndex, sequence, onNavigate],
  );

  // 键盘：视频查看模式 ←/→ = 进度后退/前进、↑/↓ = 音量减小/增大（阻止 video 原生默认避免双触发）；
  // 其余类型 ←/→ = 上/下一个文件。
  // 滚轮上下切换：仅对不可滚动内容（图片/视频/音频/PDF）生效——
  // 这些内容区本身不滚动，滚轮切换上一个/下一个符合看图软件习惯；
  // md/txt/json 长文档保留滚轮滚动内容，不拦截切换。
  useEffect(() => {
    if (state.status !== 'ready') return;
    const kind = meta?.kind ?? 'text';
    const scrollableKinds: ReadonlySet<FileKind> = new Set(['markdown', 'json', 'text']);
    const scrollable = scrollableKinds.has(kind);
    const onKeyDown = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (kind === 'video' && v) {
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown'
        ) {
          e.preventDefault();
          const current = v.currentTime || 0;
          if (e.key === 'ArrowLeft') {
            v.currentTime = Math.max(0, current - VIDEO_SEEK_STEP);
          } else if (e.key === 'ArrowRight') {
            const dur = Number.isFinite(v.duration) ? v.duration : Number.POSITIVE_INFINITY;
            v.currentTime = Math.min(dur, current + VIDEO_SEEK_STEP);
          } else if (e.key === 'ArrowUp') {
            v.volume = Math.min(1, v.volume + VIDEO_VOLUME_STEP);
          } else {
            v.volume = Math.max(0, v.volume - VIDEO_VOLUME_STEP);
          }
          // 同步展示音量浮层（反映调整后的音量值）
          setVolume(v.volume);
          showVolumeIndicator();
          return;
        }
      }
      if (e.key === 'ArrowLeft') navigateSeq(-1);
      if (e.key === 'ArrowRight') navigateSeq(1);
    };
    const onWheel = (e: WheelEvent) => {
      if (scrollable) return;
      // 小幅滚动忽略（防触控板/鼠标微抖误触）
      if (Math.abs(e.deltaY) < 5) return;
      if (e.deltaY > 0) navigateSeq(1);
      else navigateSeq(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, [state.status, meta, navigateSeq, showVolumeIndicator]);

  // md 内链接点击：拦截后新标签打开，防止直接导航替换浏览器 UI
  const handleMarkdownClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    void (async () => {
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url: href,
          active: true,
        });
      } catch (err) {
        console.error('Failed to open link:', err);
      }
    })();
  }, []);

  // ── 状态渲染 ──
  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-secondary">
        加载中…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-error">
        无法打开文件：{state.message}
      </div>
    );
  }

  if (state.status === 'too-large') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-text-secondary">
        <p className="text-text">文件过大（超过 {state.limitMb}MB），不适合在浏览器内预览</p>
        <p className="text-sm">建议用外部程序打开该文件</p>
      </div>
    );
  }

  const kind = meta?.kind ?? 'text';
  const resource = path ? fileResourceUrl(path) : '';
  const isMarkdown = kind === 'markdown';
  const canPrev = seqIndex > 0;
  const canNext = seqIndex >= 0 && seqIndex < sequence.length - 1;

  return (
    <div className="flex h-full flex-col bg-surface text-text">
      {/* 内容区：按 kind 渲染（唯一滚动容器，上下滑动不影响底部工具栏） */}
      <div className="flex-1 overflow-auto">
        {kind === 'image' && (
          // 容器铺满网页（无内边距），图片按比例 contain 居中自适应
          <div className="flex h-full w-full items-center justify-center bg-surface-secondary/50">
            <img
              src={resource}
              alt={meta?.name ?? '图片'}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
        {kind === 'video' && (
          // 容器铺满网页（无内边距/宽度限制），视频按比例 contain 铺满
          <div className="relative flex h-full w-full items-center justify-center">
            {/* 内嵌视频播放：file-resource 协议流式加载（主进程 Range 支持拖动 seek）；
             * ref 供键盘 ←/→ 进度、↑/↓ 音量控制 */}
            <video
              ref={videoRef}
              controls
              src={resource}
              className="h-full w-full object-contain"
            />
            {/* 精简音量浮层：按 ↑/↓ 调音量时短暂弹出（竖条 + 内部百分比），
             * 位于视频右侧中部，1.5s 自动消失。填充从下往上（absolute bottom-0）。 */}
            {volumeVisible && (
              <div className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-1.5 py-2 text-white">
                <div className="relative h-32 w-5 overflow-hidden rounded bg-white/25">
                  {/* 音量填充：absolute bottom-0 锚底 + height 比例 → 从下往上增长 */}
                  <div
                    className="absolute inset-x-0 bottom-0 bg-white"
                    style={{ height: `${volume * 100}%` }}
                  />
                  {/* 百分比数字显示在竖条内部（底部，深色文字保对比度） */}
                  <span className="absolute inset-x-0 bottom-1 flex items-center justify-center text-[10px] font-medium text-black mix-blend-difference">
                    {Math.round(volume * 100)}%
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {kind === 'audio' && (
          <div className="flex h-full w-full items-center justify-center">
            <audio controls src={resource} className="w-full max-w-2xl" />
          </div>
        )}
        {kind === 'pdf' && (
          <div className="h-full">
            {/* Chromium 内置 PDF 查看器：缩放/翻页/打印保留 */}
            <iframe src={resource} title={meta?.name ?? 'PDF'} className="h-full w-full" />
          </div>
        )}
        {isMarkdown && (
          <div
            className="prose-viewer mx-auto max-w-3xl px-6 py-4"
            onClick={handleMarkdownClick}
            // md 经自定义 renderer 过滤（丢弃 raw HTML + 白名单链接），见 buildMarkdownRenderer
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        )}
        {(kind === 'text' || kind === 'json') && (
          <pre className="mx-auto max-w-3xl overflow-x-auto px-6 py-4 font-mono text-sm leading-relaxed">
            {content}
          </pre>
        )}
        {(kind === 'binary' || kind === 'html') && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-secondary">
            <p className="text-text">此文件类型不支持在浏览器内预览</p>
            <p className="text-sm">请用外部程序打开</p>
          </div>
        )}
      </div>

      {/* 底部工具栏：文件名 + 类型徽标 + 大小 + 同目录序列导航。
       * 固定于内容区下方（地址栏上方），不受内容上下滑动影响。 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-secondary px-4 py-2">
        <span className="truncate text-sm font-medium">{meta?.name ?? path}</span>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
          {KIND_LABELS[kind]}
        </span>
        {meta && (
          <span className="shrink-0 text-xs text-text-secondary">{formatBytes(meta.size)}</span>
        )}
        {/* 同目录序列：上/下一个 + 计数（全部可预览文件自由切换）。
         * 按钮高度 self-stretch 铺满工具栏（标题框），宽高比 1.6:1（aspect-[1.6/1]）。
         * mr-[30px]：整体左移 30px，避免右侧边栏遮挡切换按钮 */}
        {sequence.length > 1 && (
          <div className="ml-auto mr-[30px] flex shrink-0 items-stretch gap-1 self-stretch">
            <button
              className="flex aspect-[1.6/1] items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text disabled:opacity-30"
              onClick={() => navigateSeq(-1)}
              disabled={!canPrev}
              aria-label="上一个"
              title="上一个（←）"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <span className="flex min-w-[3.5rem] items-center justify-center text-center text-xs text-text-secondary">
              {seqIndex >= 0 ? `${seqIndex + 1}/${sequence.length}` : '—'}
            </span>
            <button
              className="flex aspect-[1.6/1] items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text disabled:opacity-30"
              onClick={() => navigateSeq(1)}
              disabled={!canNext}
              aria-label="下一个"
              title="下一个（→）"
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 目录浏览（?dir=）：文件夹网格，点击进入子目录或预览文件。 */
function DirBrowser({
  dir,
  onNavigate,
}: {
  readonly dir: string;
  readonly onNavigate?: (url: string) => void;
}) {
  const [entries, setEntries] = useState<readonly DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void (async () => {
      try {
        const res = (await window.urchin.invoke('file.dir', { path: dir })) as {
          entries: readonly DirEntry[];
        };
        if (cancelled) return;
        setEntries(res.entries);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const up = parentDir(dir);

  const handleOpenEntry = useCallback(
    (entry: DirEntry) => {
      if (!onNavigate) return;
      if (entry.isDir) {
        onNavigate(`urchin://file-viewer/?dir=${encodeURIComponent(entry.path)}`);
      } else {
        onNavigate(`urchin://file-viewer/?path=${encodeURIComponent(entry.path)}`);
      }
    },
    [onNavigate],
  );

  return (
    <div className="flex h-full flex-col bg-surface text-text">
      {/* 工具栏：返回上一级 + 当前目录名 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-4 py-2">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text disabled:opacity-30"
          onClick={() => up && onNavigate?.(`urchin://file-viewer/?dir=${encodeURIComponent(up)}`)}
          disabled={!up}
          aria-label="返回上一级"
          title="返回上一级"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-medium">{dir}</span>
      </div>

      {/* 目录内容 */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="flex h-full items-center justify-center text-error">
            无法打开文件夹：{error}
          </div>
        )}
        {!error && !entries && (
          <div className="flex h-full items-center justify-center text-text-secondary">加载中…</div>
        )}
        {!error && entries?.length === 0 && (
          <div className="flex h-full items-center justify-center text-text-secondary">
            此文件夹为空
          </div>
        )}
        {!error && entries && entries.length > 0 && (
          <div className="mx-auto grid max-w-5xl grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 p-4">
            {entries.map((entry) => (
              <button
                key={entry.path}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left hover:border-primary hover:bg-surface-secondary"
                onClick={() => handleOpenEntry(entry)}
                title={entry.path}
              >
                {entry.isDir ? (
                  <Folder className="h-5 w-5 shrink-0 text-info" />
                ) : (
                  <FileText className="h-5 w-5 shrink-0 text-text-secondary" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                {!entry.isDir && (
                  <span className="shrink-0 text-xs text-text-secondary">
                    {formatBytes(entry.size)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

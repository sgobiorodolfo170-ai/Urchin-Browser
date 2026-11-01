/**
 * M26 剪藏 · 面板 UI（独立窗口 ?view=clipper&tabId=<id>）
 *
 * 流程：
 * 1. 并行拉取配置与页面快照；
 * 2. 渲染进程用 Defuddle 抽取正文（选中优先可切换）；
 * 3. 用户编辑文件名/属性/正文，或选择 MHTML/PDF/截图；
 * 4. 主进程落盘到 documents/clipper。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, X, Copy, Save, AlertTriangle, FileText } from 'lucide-react';
import type {
  ClipperConfigRes,
  ClipperFormat,
  ClipperPageRes,
  ClipperSnapshotMode,
} from '@urchin/ipc-contract';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import {
  buildVariables,
  composeMarkdown,
  parsePropertyTemplate,
  renderNoteName,
  renderTemplate,
  type ClipperPropertyRow,
} from './draft';
import { extractClipperContent, type ClipperExtraction } from './extract';
import { assessQuality, buildCleanedHtml, type ClipperQuality } from './clean-html';

const FORMAT_LABELS: Readonly<Record<ClipperFormat, string>> = {
  markdown: 'Markdown（可编辑）',
  mhtml: 'MHTML（图文整页快照）',
  pdf: 'PDF（打印版快照）',
  screenshot: '截图（整页 PNG）',
  ocr: 'OCR 文本（即将支持）',
};

const SNAPSHOT_FORMATS: ReadonlySet<ClipperFormat> = new Set(['mhtml', 'pdf', 'screenshot']);

interface SaveResult {
  readonly path: string;
}

interface SnapshotSaveResult {
  readonly paths: readonly string[];
  readonly warnings?: readonly string[];
}

function readTabId(): number {
  const raw = new URLSearchParams(location.search).get('tabId');
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export function ClipperPanelApp() {
  const tabId = readTabId();
  const [config, setConfig] = useState<ClipperConfigRes | null>(null);
  const [page, setPage] = useState<ClipperPageRes | null>(null);
  const [extraction, setExtraction] = useState<ClipperExtraction | null>(null);
  const [format, setFormat] = useState<ClipperFormat>('markdown');
  const [snapshotMode, setSnapshotMode] = useState<ClipperSnapshotMode>('clean');
  const [selectionPriority, setSelectionPriority] = useState(true);
  const [noteName, setNoteName] = useState('');
  const [rows, setRows] = useState<readonly ClipperPropertyRow[]>([]);
  const [body, setBody] = useState('');
  const [quality, setQuality] = useState<ClipperQuality>('good');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<readonly string[]>([]);

  const applyDraft = useCallback(
    (data: ClipperExtraction, cfg: ClipperConfigRes, preferSelection: boolean) => {
      const useSelection = preferSelection && data.selectionMarkdown.trim().length > 0;
      const contentMarkdown = useSelection ? data.selectionMarkdown : data.pageMarkdown;
      const variables = buildVariables({
        title: data.title,
        url: data.url,
        author: data.author,
        published: data.published,
        description: data.description,
        site: data.site,
        domain: data.domain,
        language: data.language,
        words: data.words,
        favicon: data.favicon,
        image: data.image,
        content: contentMarkdown,
        selection: data.selectionMarkdown,
      });
      setNoteName(renderNoteName(cfg.noteNameFormat, variables) || data.title || 'untitled');
      setRows(parsePropertyTemplate(cfg.properties, variables));
      setBody(renderTemplate(cfg.content, variables));
      setQuality(
        assessQuality({
          textLength: 0,
          markdownLength: contentMarkdown.length,
          imageCount: 0,
          hasCanvas: false,
        }),
      );
    },
    [],
  );

  useEffect(() => {
    document.title = '剪藏（Clipper）';
    document.documentElement.dataset.window = 'clipper';
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!tabId) {
        setError('剪藏面板缺少目标标签页');
        setLoading(false);
        return;
      }
      try {
        const [cfg, pageRes] = await Promise.all([
          window.urchin.invoke('clipper.config', {}) as Promise<ClipperConfigRes>,
          window.urchin.invoke('clipper.page', { tabId }) as Promise<ClipperPageRes>,
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setPage(pageRes);
        document.documentElement.setAttribute('data-theme', cfg.theme);
        setFormat(cfg.defaultFormat === 'ocr' ? 'markdown' : cfg.defaultFormat);
        setSnapshotMode(cfg.cleanSnapshot ? 'clean' : 'original');
        setSelectionPriority(cfg.selectionPriority);

        const data = extractClipperContent(pageRes, cfg.selectionPriority);
        if (cancelled) return;
        setExtraction(data);
        applyDraft(data, cfg, cfg.selectionPriority);
        setQuality(
          assessQuality({
            textLength: pageRes.signals.textLength,
            markdownLength: data.contentMarkdown.length,
            imageCount: pageRes.signals.imageCount,
            hasCanvas: pageRes.signals.hasCanvas,
          }),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tabId, applyDraft]);

  const close = useCallback(() => {
    void window.urchin.invoke('clipper.close', {}).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const isSnapshot = SNAPSHOT_FORMATS.has(format);
  const markdownContent = useMemo(() => composeMarkdown(rows, body), [rows, body]);

  const handleSelectionPriorityChange = (enabled: boolean): void => {
    setSelectionPriority(enabled);
    if (extraction && config) {
      applyDraft(extraction, config, enabled);
      if (page) {
        const content = enabled ? extraction.selectionMarkdown : extraction.pageMarkdown;
        setQuality(
          assessQuality({
            textLength: page.signals.textLength,
            markdownLength: content.length,
            imageCount: page.signals.imageCount,
            hasCanvas: page.signals.hasCanvas,
          }),
        );
      }
    }
  };

  const updateRow = (index: number, value: string): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row)));
  };

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await window.urchin.invoke('clipper.copy', { text: markdownContent });
      // Toast 由面板本地状态表达，避免引入与主窗口耦合的 toast 系统。
      setSavedPath('已复制到剪贴板');
      setTimeout(() => setSavedPath(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [markdownContent]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!config || !page || !extraction) return;
    setSaving(true);
    setError(null);
    setSaveWarnings([]);
    try {
      const name = noteName.trim() || extraction.title || 'untitled';
      let saved = '';
      let warnings: readonly string[] = [];
      if (format === 'markdown') {
        const result = (await window.urchin.invoke('clipper.saveMarkdown', {
          noteName: name,
          markdown: markdownContent,
        })) as SaveResult;
        saved = result.path;
      } else if (isSnapshot) {
        const cleanedHtml =
          snapshotMode === 'clean'
            ? buildCleanedHtml(extraction.pageContentHtml, extraction.url, extraction.title)
            : undefined;
        const result = (await window.urchin.invoke('clipper.saveSnapshot', {
          ...(tabId ? { tabId } : {}),
          format,
          mode: snapshotMode,
          noteName: name,
          ...(cleanedHtml ? { cleanedHtml } : {}),
        })) as SnapshotSaveResult;
        saved = result.paths[0] ?? '';
        warnings = result.warnings ?? [];
      } else {
        throw new Error('OCR 尚未实现');
      }
      setSavedPath(saved);
      setSaveWarnings(warnings);
      // 有提示（如截图分段/回退视口）时保持面板打开，让用户看到提示。
      if (warnings.length === 0) {
        setTimeout(() => {
          void window.urchin.invoke('clipper.close', {}).catch(() => undefined);
        }, 1000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [
    config,
    extraction,
    format,
    isSnapshot,
    markdownContent,
    noteName,
    page,
    snapshotMode,
    tabId,
  ]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 bg-surface text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在提取页面正文…
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-error" />
        <div className="text-sm text-error">{error}</div>
        <Button variant="secondary" size="sm" onClick={close}>
          关闭
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">剪藏（Clipper）</h1>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {extraction?.title ?? page?.title ?? '未命名页面'}
          </p>
        </div>
        <button
          type="button"
          className="rounded p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={close}
          aria-label="关闭剪藏面板"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        {quality !== 'good' && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              {quality === 'unavailable'
                ? '正文抽取结果很少，页面可能由图片/Canvas 构成。建议改用 MHTML、PDF 或截图。'
                : '正文抽取质量较低，可能缺少部分内容。可改用 MHTML、PDF 或截图保留完整视觉。'}
            </span>
          </div>
        )}

        <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
          <label className="text-xs text-text-secondary" htmlFor="clipper-format">
            保存格式
          </label>
          <select
            id="clipper-format"
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
            value={format}
            onChange={(e) => setFormat(e.target.value as ClipperFormat)}
          >
            <option value="markdown">{FORMAT_LABELS.markdown}</option>
            <option value="mhtml">{FORMAT_LABELS.mhtml}</option>
            <option value="pdf">{FORMAT_LABELS.pdf}</option>
            <option value="screenshot">{FORMAT_LABELS.screenshot}</option>
            <option value="ocr" disabled>
              {FORMAT_LABELS.ocr}
            </option>
          </select>

          <label className="text-xs text-text-secondary" htmlFor="clipper-name">
            文件名
          </label>
          <Input
            id="clipper-name"
            className="h-8"
            value={noteName}
            onChange={(e) => setNoteName(e.target.value)}
            placeholder="剪藏文件名（不含扩展名）"
          />

          {isSnapshot && (
            <>
              <label className="text-xs text-text-secondary" htmlFor="clipper-snapshot-mode">
                快照方式
              </label>
              <select
                id="clipper-snapshot-mode"
                className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
                value={snapshotMode}
                onChange={(e) => setSnapshotMode(e.target.value as ClipperSnapshotMode)}
              >
                <option value="clean">正文清洗（去除广告/导航）</option>
                <option value="original">原页完整（保留版式）</option>
              </select>
            </>
          )}

          {format === 'markdown' && (
            <>
              <span className="text-xs text-text-secondary">内容来源</span>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1',
                    selectionPriority
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-text-secondary',
                  )}
                  onClick={() => handleSelectionPriorityChange(true)}
                  disabled={!extraction?.selectionMarkdown.trim()}
                >
                  选中优先
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1',
                    !selectionPriority
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-text-secondary',
                  )}
                  onClick={() => handleSelectionPriorityChange(false)}
                >
                  整页正文
                </button>
              </div>
            </>
          )}
        </div>

        {isSnapshot ? (
          <div className="mt-5 rounded-md border border-border bg-surface-secondary px-4 py-3 text-xs leading-6 text-text-secondary">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-text">
              <FileText className="h-4 w-4" />
              {FORMAT_LABELS[format]}
            </div>
            <p>
              {snapshotMode === 'clean'
                ? '将使用 Defuddle 提取的正文重新排版后导出，去除广告、导航、侧栏和评论；不保证与原页逐像素一致。'
                : '将直接导出当前网页原貌，保留原版式；广告/侧栏等无效信息不会被剔除。'}
            </p>
            <p className="mt-1">保存位置：{config?.saveDirLabel ?? 'documents/clipper'}</p>
            {page?.signals.hasCanvas && (
              <p className="mt-1 text-warning">
                页面包含 Canvas，快照可能无法完整保留其动态绘制内容。
              </p>
            )}
          </div>
        ) : (
          <div className="mt-5">
            {rows.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 text-xs font-medium text-text-secondary">页面属性</div>
                <div className="space-y-1.5">
                  {rows.map((row, index) => (
                    <div
                      key={`${row.key}-${index}`}
                      className="grid grid-cols-[96px_minmax(0,1fr)] gap-2"
                    >
                      <div className="truncate rounded-md bg-surface-secondary px-2 py-1.5 text-xs text-text-secondary">
                        {row.key}
                      </div>
                      <Input
                        className="h-8"
                        value={row.value}
                        onChange={(e) => updateRow(index, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-1 text-xs font-medium text-text-secondary">正文 Markdown</div>
            <textarea
              className="h-64 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 text-text outline-none focus:border-primary"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border px-4 py-3">
        {savedPath && (
          <div className="mb-2 truncate text-xs text-success" title={savedPath}>
            {savedPath.startsWith('已复制') ? savedPath : `已保存：${savedPath}`}
          </div>
        )}
        {saveWarnings.length > 0 && (
          <div className="mb-2 space-y-0.5 text-xs text-warning">
            {saveWarnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs text-text-secondary">
            保存到 {config?.saveDirLabel ?? 'documents/clipper'}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {format === 'markdown' && (
              <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                复制
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={close}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || format === 'ocr'}
            >
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              保存
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

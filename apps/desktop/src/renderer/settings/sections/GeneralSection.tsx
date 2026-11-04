/**
 * 「通用」选项卡（refactor-plan-p2 §3.3 步骤 2，代码自 SettingsPage.tsx 原样迁出）
 *
 * 组成：通用设置字段（GENERAL_FIELDS 经共享 SettingsSection 渲染）+
 * 从其他浏览器导入书签区块（ImportBookmarksBlock，含检测/导入逻辑与
 * IPC 契约对齐类型）。
 */
import { useCallback, useState } from 'react';
import { Button } from '../../components/ui/button';
import { SettingsSection, type SettingField } from '../settings-form';

const GENERAL_FIELDS: readonly SettingField[] = [
  {
    key: 'language',
    label: '界面语言',
    desc: '应用界面显示语言（默认中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en-US', label: 'English' },
    ],
  },
  {
    key: 'searchEngine',
    label: '搜索引擎',
    desc: '地址栏搜索使用的引擎（与 parse-input 的 SEARCH_ENGINE_TEMPLATES 表对应）',
    type: 'select',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
      { value: 'baidu', label: '百度' },
      { value: 'duckduckgo', label: 'DuckDuckGo' },
      { value: 'sogou', label: '搜狗' },
      { value: 'so360', label: '360 搜索' },
    ],
  },
  {
    key: 'links.openInNewTab',
    label: '在新标签页打开链接',
    desc: '点击网页内链接时在新标签页打开（关闭则在当前标签页打开）',
    type: 'toggle',
  },
  {
    key: 'startup.restoreTabs',
    label: '启动时继续浏览上次打开的网页',
    desc: '关闭浏览器时保存当前打开的标签页，下次启动时自动恢复默认工作区的标签；其他工作区的标签在切换到该工作区时自动恢复',
    type: 'toggle',
  },
  {
    key: 'translate.targetLang',
    label: '网页翻译目标语言',
    desc: '整页翻译与划词翻译的目标语言（默认简体中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'zh-TW', label: '繁體中文' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
      { value: 'fr', label: 'Français' },
      { value: 'de', label: 'Deutsch' },
      { value: 'ru', label: 'Русский' },
      { value: 'es', label: 'Español' },
    ],
  },
  {
    key: 'translate.engine',
    label: '翻译引擎',
    desc: '自动（推荐）：直连网络优先 MyMemory 翻译、走代理优先谷歌翻译，引擎失败自动切换至其他可用引擎（三引擎互为兜底）；也可手动锁定单一引擎。注：微软免费端点已于 2026-09 关闭，保留选项但可能不可用',
    type: 'select',
    options: [
      { value: 'auto', label: '自动（推荐）' },
      { value: 'mymemory', label: 'MyMemory 翻译（国内直连可用）' },
      { value: 'google', label: '谷歌翻译（需代理）' },
      { value: 'microsoft', label: '微软翻译（端点已关闭，可能不可用）' },
    ],
  },
  {
    key: 'translate.autoTranslate',
    label: '自动翻译外语页面',
    desc: '开启后打开外语网页时自动翻译为目标语言（默认关闭）。隐私提示：翻译时页面文本将发送至所选翻译服务（微软/谷歌）；关闭时仅在手动点击翻译后发送',
    type: 'toggle',
  },
];

/** 已检测浏览器 profile 的最小结构（与 ipc-contract ImportedBrowser 对齐）。 */
interface ImportedBrowserInfo {
  readonly id: string;
  readonly kind: 'chrome' | 'edge' | 'firefox';
  readonly displayName: string;
  readonly profileName: string;
  readonly profileDir: string;
  readonly bookmarksSource: 'chromium-json' | 'firefox-places';
}

/** 导入结果摘要（与 ipc-contract ImportSummary 对齐）。 */
interface ImportSummaryInfo {
  readonly folders: number;
  readonly bookmarks: number;
  readonly skipped: number;
  readonly rootFolderId: string;
  readonly rootFolderTitle: string;
}

/** 摘要 → toast 文案。 */
function summaryToast(s: ImportSummaryInfo): string {
  return `已导入 ${s.bookmarks} 个书签、${s.folders} 个文件夹${s.skipped > 0 ? `（跳过 ${s.skipped}）` : ''}`;
}

/**
 * 「从其他浏览器导入」区块（通用 tab 底部）。
 *
 * 导入的书签放入收藏夹根目录下「导入自 <浏览器> (YYYY-MM-DD)」文件夹，
 * 完整保留原目录结构，可整夹删除回退（详见 docs/数据导入评估.md）。
 */
function ImportBookmarksBlock({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [browsers, setBrowsers] = useState<ImportedBrowserInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [fileImporting, setFileImporting] = useState(false);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = (await window.urchin.invoke('import.detectBrowsers', {})) as {
        browsers: ImportedBrowserInfo[];
      };
      setBrowsers(res.browsers ?? []);
      if ((res.browsers ?? []).length === 0) {
        onToast('未检测到可导入的浏览器');
      }
    } catch (e) {
      onToast('检测失败：' + String(e));
    } finally {
      setDetecting(false);
    }
  }, [onToast]);

  const handleFromFile = useCallback(async () => {
    setFileImporting(true);
    try {
      const res = (await window.urchin.invoke('import.bookmarksFromFile', {})) as {
        canceled: boolean;
        summary: ImportSummaryInfo | null;
      };
      if (res.canceled || !res.summary) {
        onToast('已取消');
        return;
      }
      onToast(summaryToast(res.summary));
    } catch (e) {
      onToast('导入失败：' + String(e));
    } finally {
      setFileImporting(false);
    }
  }, [onToast]);

  const handleFromBrowser = useCallback(
    async (id: string) => {
      setImporting(id);
      try {
        const res = (await window.urchin.invoke('import.bookmarksFromBrowser', { id })) as {
          canceled: boolean;
          summary: ImportSummaryInfo | null;
        };
        if (res.canceled || !res.summary) {
          onToast('已取消');
          return;
        }
        onToast(summaryToast(res.summary));
      } catch (e) {
        onToast('导入失败：' + String(e));
      } finally {
        setImporting(null);
      }
    },
    [onToast],
  );

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">从其他浏览器导入</h2>
      <p className="mb-4 text-sm text-text-secondary">
        导入 Chrome / Edge / Firefox 的收藏夹，或从书签 HTML 文件导入。导入的书签会放入
        收藏夹根目录下「导入自 &lt;浏览器&gt;
        (&lt;日期&gt;)」文件夹，完整保留原目录结构，可整夹删除回退。
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={fileImporting}
          onClick={() => void handleFromFile()}
        >
          {fileImporting ? '导入中…' : '从书签 HTML 文件导入…'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting}
          onClick={() => void handleDetect()}
        >
          {detecting ? '检测中…' : '检测本机浏览器'}
        </Button>
      </div>

      {browsers.length > 0 && (
        <div className="mt-4 space-y-2">
          {browsers.map((b) => {
            const key = b.id;
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-md border border-border bg-surface-secondary px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="font-medium">{b.displayName}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{b.profileName}</div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing === b.id}
                  onClick={() => void handleFromBrowser(b.id)}
                >
                  {importing === b.id ? '导入中…' : '导入收藏夹'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export interface GeneralSectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
  readonly onToast: (msg: string) => void;
}

export function GeneralSection({ entries, onChange, onToast }: GeneralSectionProps) {
  return (
    <>
      <SettingsSection title="通用" fields={GENERAL_FIELDS} entries={entries} onChange={onChange} />
      <ImportBookmarksBlock onToast={onToast} />
    </>
  );
}

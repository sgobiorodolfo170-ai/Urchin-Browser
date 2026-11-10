/**
 * 「从其他浏览器导入」区块（dev.121 创建，2026-11-10 自「通用」迁入「数据」页）
 *
 * 组成：
 * 1. 从书签 HTML 文件导入（仅书签）；
 * 2. 检测本机 Chrome / Edge / Firefox profile，逐条导入收藏夹；
 * 3. 区块级「同时导入 Cookie」开关（Firefox 明文 / Chromium 旧版 v10/v11；
 *    Chrome 127+ App-Bound Encryption 的 v20 Cookie 无法解密，按能力提示）。
 */
import { useCallback, useState } from 'react';
import { Button } from '../../components/ui/button';

/** 已检测浏览器 profile 的最小结构（与 ipc-contract ImportedBrowser 对齐）。 */
interface ImportedBrowserInfo {
  readonly id: string;
  readonly kind: 'chrome' | 'edge' | 'firefox';
  readonly displayName: string;
  readonly profileName: string;
  readonly profileDir: string;
  readonly bookmarksSource: 'chromium-json' | 'firefox-places';
  readonly cookiesSupport?: 'full' | 'partial' | 'none';
  readonly cookiesNote?: string;
}

/** 导入结果摘要（与 ipc-contract ImportSummary 对齐）。 */
interface ImportSummaryInfo {
  readonly folders: number;
  readonly bookmarks: number;
  readonly skipped: number;
  readonly rootFolderId: string;
  readonly rootFolderTitle: string;
}

/** Cookie 导入摘要（与 ipc-contract ImportCookiesSummary 对齐）。 */
interface CookieImportSummaryInfo {
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly encryptedSkipped: number;
  readonly note?: string;
}

/** Cookie 能力标签（UI 展示；不暴露 Cookie 内容）。 */
function cookieCapabilityLabel(b: ImportedBrowserInfo): string {
  if (b.cookiesSupport === 'full') return 'Cookie：可导入';
  if (b.cookiesSupport === 'partial') return 'Cookie：仅旧版可用';
  return 'Cookie：不可用';
}

/** 摘要 → toast 文案（Cookie 部分单独拼接，失败不掩盖书签结果）。 */
function summaryToast(s: ImportSummaryInfo, cookies?: CookieImportSummaryInfo | null): string {
  let msg = `已导入 ${s.bookmarks} 个书签、${s.folders} 个文件夹${
    s.skipped > 0 ? `（跳过 ${s.skipped}）` : ''
  }`;
  if (!cookies) return msg;
  if (cookies.note && cookies.imported === 0) {
    return `${msg}；Cookie 未导入：${cookies.note}`;
  }
  msg += `；Cookie 导入 ${cookies.imported} 条`;
  const skipped = cookies.skipped + cookies.encryptedSkipped;
  if (skipped > 0) msg += `（跳过 ${skipped}）`;
  if (cookies.failed > 0) msg += `（失败 ${cookies.failed}）`;
  if (cookies.note) msg += `（${cookies.note}）`;
  return msg;
}

export interface ImportSectionProps {
  readonly onToast: (msg: string) => void;
}

export function ImportSection({ onToast }: ImportSectionProps) {
  const [browsers, setBrowsers] = useState<ImportedBrowserInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [fileImporting, setFileImporting] = useState(false);
  /** 是否同时导入 Cookie（默认关闭：导入登录凭据需用户显式选择） */
  const [includeCookies, setIncludeCookies] = useState(false);

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
        const res = (await window.urchin.invoke('import.bookmarksFromBrowser', {
          id,
          includeCookies,
        })) as {
          canceled: boolean;
          summary: ImportSummaryInfo | null;
          cookies?: CookieImportSummaryInfo | null;
        };
        if (res.canceled || !res.summary) {
          onToast('已取消');
          return;
        }
        onToast(summaryToast(res.summary, res.cookies));
      } catch (e) {
        onToast('导入失败：' + String(e));
      } finally {
        setImporting(null);
      }
    },
    [onToast, includeCookies],
  );

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">从其他浏览器导入</h2>
      <p className="mb-4 text-sm text-text-secondary">
        导入 Chrome / Edge / Firefox 的收藏夹，或从书签 HTML 文件导入。导入的书签会放入
        收藏夹根目录下「导入自 &lt;浏览器&gt;
        (&lt;日期&gt;)」文件夹，完整保留原目录结构，可整夹删除回退。
      </p>

      <label className="mb-4 flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={includeCookies}
          onChange={(e) => setIncludeCookies(e.target.checked)}
        />
        <span>
          <span className="font-medium">同时导入 Cookie（登录状态）</span>
          <span className="mt-0.5 block text-xs text-text-secondary">
            仅对下方「检测本机浏览器」的导入生效，写入默认工作区。Firefox 可完整导入； Chrome / Edge
            若已启用应用级加密（ABE），只能导入旧版 Cookie。Cookie
            导入不保证所有站点保持登录（部分站点还依赖 localStorage）。导入前请关闭源浏览器， 否则
            Cookie 数据库被占用会失败。
          </span>
        </span>
      </label>

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
      <p className="mt-2 text-xs text-text-secondary">
        从书签 HTML 文件导入仅包含书签，不含 Cookie。
      </p>

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
                  <div className="mt-0.5 text-xs text-text-secondary" title={b.cookiesNote}>
                    {cookieCapabilityLabel(b)}
                    {includeCookies ? '' : '（未勾选）'}
                  </div>
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

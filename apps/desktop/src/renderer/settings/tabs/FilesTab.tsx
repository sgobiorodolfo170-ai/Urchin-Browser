/**
 * 「默认应用」选项卡（Windows 文件关联 · 非侵入注册模型）
 *
 * 交互：
 * - 每张卡片显示该组扩展名与三态登记状态（未关联 / 部分关联 / 已登记）
 * - 「设为默认打开方式」→ file-association.register → 主进程写 HKCU 注册表
 *   （只登记能力 + OpenWithProgids，**不改写 .ext 默认值**）→ 刷新状态 + toast
 * - 「清除关联」→ ConfirmDialog → file-association.unregister（幂等清理本应用项）
 * - 「打开系统默认应用」→ file-association.openSettings（只唤起设置页，不写注册表）
 *
 * 为什么要显示 exePath / devMode：登记项里写死了 exe 路径。开发模式
 * （`electron <appDir>` 启动）登记的是 node_modules 里的 electron 副本，
 * 卸载/移动目录后这些登记项全部失效，表现为「双击文件没反应」却看不出原因。
 * 这里显式暴露路径与「指向旧位置」判定，让用户能自己判断要不要清掉重登。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { cn } from '../../lib/utils';
import { displayNameForLocale } from '../../../shared/brand';

/** 分组定义（与主进程 file-association/associations.ts 的 ASSOCIATION_GROUPS 对齐）。 */
interface AssociationGroupDef {
  readonly id: 'media' | 'documents' | 'images';
  readonly label: string;
  readonly description: string;
}

const ASSOCIATION_GROUP_DEFS: readonly AssociationGroupDef[] = [
  { id: 'media', label: '音视频', description: 'MP3 / MP4 / WAV / FLAC 等音频视频文件' },
  {
    id: 'documents',
    label: '文档',
    description: 'PDF / Word / Excel / PPT / Markdown / 文本 / JSON 等文档文件',
  },
  { id: 'images', label: '图片', description: 'PNG / JPG / GIF / SVG 等图片文件' },
];

interface GroupStatus {
  readonly registered: number;
  readonly total: number;
  readonly extensions: readonly string[];
}

/** file-association.getStatus 的返回（字段可缺省，兼容旧主进程）。 */
interface StatusPayload {
  readonly groups: Record<string, GroupStatus>;
  readonly exePath?: string;
  readonly devMode?: boolean;
  readonly appRegistered?: boolean;
  readonly exeMatches?: boolean;
}

/** 三态：0 未关联 / 部分关联 / 全部登记。 */
function registrationState(status: GroupStatus | undefined): 'none' | 'partial' | 'full' {
  if (!status || status.total === 0) return 'none';
  if (status.registered === 0) return 'none';
  return status.registered >= status.total ? 'full' : 'partial';
}

/**
 * 「默认应用」选项卡：把本浏览器登记为音视频/文档/图片的打开方式。
 */
export function FilesTab({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [settingDefaultBrowser, setSettingDefaultBrowser] = useState(false);

  const appName = displayNameForLocale(navigator.language);

  const loadStatus = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file-association.getStatus', {})) as StatusPayload;
      setStatus(res);
      setSelected((prev) => {
        const next: Record<string, readonly string[]> = {};
        for (const group of ASSOCIATION_GROUP_DEFS) {
          const extensions = res.groups[group.id]?.extensions ?? [];
          const previous = new Set(prev[group.id] ?? extensions);
          next[group.id] = extensions.filter((ext) => previous.has(ext));
        }
        return next;
      });
    } catch (e) {
      onToast('读取关联状态失败：' + String(e));
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const toggleExtension = useCallback((groupId: string, ext: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev[groupId] ?? []);
      if (checked) next.add(ext);
      else next.delete(ext);
      return { ...prev, [groupId]: [...next] };
    });
  }, []);

  const handleOpenSettings = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file-association.openSettings', {})) as {
        ok: boolean;
      };
      if (!res.ok) onToast('无法打开系统「默认应用」页，请手动前往 设置 → 应用 → 默认应用');
    } catch (e) {
      onToast('打开系统设置失败：' + String(e));
    }
  }, [onToast]);

  const handleSetDefaultBrowser = useCallback(async () => {
    setSettingDefaultBrowser(true);
    try {
      const res = (await window.urchin.invoke('file-association.setDefaultBrowser', {})) as {
        openedSettings: boolean;
      };
      onToast(
        res.openedSettings
          ? `已登记默认浏览器。请在打开的系统设置中把「Web 浏览器」设为 ${appName}（Windows 不允许程序直接改默认，需要你确认）`
          : `已登记默认浏览器。请到系统「默认应用」中把「Web 浏览器」设为 ${appName}`,
      );
      await loadStatus();
    } catch (e) {
      onToast('设置默认浏览器失败：' + String(e));
    } finally {
      setSettingDefaultBrowser(false);
    }
  }, [appName, loadStatus, onToast]);

  const handleRegister = useCallback(
    async (groupId: string) => {
      const extensions = selected[groupId] ?? [];
      if (extensions.length === 0) {
        onToast('请至少勾选一种格式');
        return;
      }
      setRegistering(groupId);
      try {
        await window.urchin.invoke('file-association.register', { group: groupId, extensions });
        onToast(
          `已登记 ${extensions.length} 种格式。请在系统「打开方式」中选择 ${appName} 并勾选"始终使用"（Windows 需你确认一次）`,
        );
        await loadStatus();
      } catch (e) {
        onToast('注册失败：' + String(e));
      } finally {
        setRegistering(null);
      }
    },
    [appName, loadStatus, onToast, selected],
  );

  const handleUnregister = useCallback(
    async (groupId: string) => {
      setConfirmClear(null);
      setClearing(groupId);
      try {
        const res = (await window.urchin.invoke('file-association.unregister', {
          scope: 'extensions',
          group: groupId,
        })) as { removed: number; attempted: number };
        onToast(
          res.removed > 0
            ? `已清除本应用的 ${res.removed} 项登记。若系统仍用本应用打开，请在系统「默认应用」中改回其它应用`
            : '未发现本应用的登记项（已是干净状态）',
        );
        await loadStatus();
      } catch (e) {
        onToast('清除关联失败：' + String(e));
      } finally {
        setClearing(null);
      }
    },
    [loadStatus, onToast],
  );

  const devMode = status?.devMode === true;
  const staleRegistration =
    (status?.appRegistered === true && status?.exeMatches === false) ||
    status?.appRegistered === false;
  const pendingClear = confirmClear
    ? ASSOCIATION_GROUP_DEFS.find((g) => g.id === confirmClear)
    : undefined;

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">默认应用</h1>
      <p className="mb-4 text-sm text-text-secondary">
        把 {appName} 登记为默认浏览器和音视频、文档、图片的打开方式。Windows 10/11
        不允许程序直接改写默认，因此这里只把本应用登记为「可选项」，由你在系统「默认应用」里确认一次——
        <span className="text-text">不会改动你现有的默认设置</span>。
      </p>

      {/* 登记路径状态：dev 实例 / 指向旧位置都需要显式提示，否则「双击没反应」无从判断 */}
      {!loading && status?.exePath !== undefined && (
        <div
          className={cn(
            'mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            devMode || staleRegistration
              ? 'border-warning/40 bg-warning/5 text-text-secondary'
              : 'border-border bg-surface-secondary text-text-secondary',
          )}
        >
          {devMode || staleRegistration ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <div className="break-all">
              登记目标：<span className="text-text">{status.exePath}</span>
            </div>
            {devMode && (
              <div className="mt-0.5">
                当前是开发实例（未打包）。登记项指向开发可执行文件，仅供测试；正式使用请安装打包版本后重新登记。
              </div>
            )}
            {!devMode && staleRegistration && (
              <div className="mt-0.5">
                未检测到本应用的有效登记，或登记指向旧位置。请点下方「设为默认打开方式」重新登记。
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void handleOpenSettings()}>
            打开系统默认应用
          </Button>
        </div>
      )}

      <div className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">默认浏览器</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              登记 http / https 与网页文件关联，并打开系统默认应用设置
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={settingDefaultBrowser}
            onClick={() => void handleSetDefaultBrowser()}
          >
            {settingDefaultBrowser ? '设置中…' : '设为默认浏览器'}
          </Button>
        </div>
      </div>

      {loading && <p className="text-text-secondary">加载中…</p>}
      {!loading &&
        ASSOCIATION_GROUP_DEFS.map((group) => {
          const groupStatus = status?.groups[group.id];
          const selectedExtensions = selected[group.id] ?? [];
          const state = registrationState(groupStatus);
          return (
            <div
              key={group.id}
              className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{group.label}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{group.description}</div>
                </div>
                {groupStatus && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs',
                      state === 'full' && 'bg-success/15 text-success',
                      state === 'partial' && 'bg-warning/15 text-warning',
                      state === 'none' && 'bg-text-secondary/10 text-text-secondary',
                    )}
                  >
                    {state === 'full'
                      ? `已登记 ${groupStatus.registered}/${groupStatus.total}`
                      : state === 'partial'
                        ? `部分登记 ${groupStatus.registered}/${groupStatus.total}`
                        : '未登记'}
                  </span>
                )}
              </div>
              {groupStatus && groupStatus.extensions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {groupStatus.extensions.map((ext) => (
                    <label
                      key={ext}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:text-text"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={selectedExtensions.includes(ext)}
                        onChange={(e) => toggleExtension(group.id, ext, e.target.checked)}
                      />
                      .{ext}
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={registering === group.id || selectedExtensions.length === 0}
                  onClick={() => void handleRegister(group.id)}
                >
                  {registering === group.id
                    ? '登记中…'
                    : `设为默认打开方式（${selectedExtensions.length}）`}
                </Button>
                {state !== 'none' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clearing === group.id}
                    onClick={() => setConfirmClear(group.id)}
                  >
                    {clearing === group.id ? '清除中…' : '清除本应用关联'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}

      <ConfirmDialog
        open={pendingClear !== undefined}
        title={`清除「${pendingClear?.label ?? ''}」的本应用关联？`}
        message="只会删除本应用写过的登记项（ProgID / OpenWithProgids / 能力声明），不影响其它应用。若系统当前正用本应用打开这些文件，需再到系统「默认应用」里改回其它应用。"
        actions={[
          { label: '取消', onClick: () => setConfirmClear(null) },
          {
            label: '清除',
            variant: 'danger',
            autoFocus: true,
            onClick: () => {
              if (confirmClear) void handleUnregister(confirmClear);
            },
          },
        ]}
        onDismiss={() => setConfirmClear(null)}
      />
    </section>
  );
}

/**
 * 「默认应用」选项卡（Windows 文件关联，refactor-plan-p2 §3.3 步骤 7：自
 * SettingsPage.tsx 原样提升为独立文件，逻辑不变）
 *
 * 交互：每张卡片显示该组扩展名与注册状态；点「设为默认打开方式」→
 * file-association.register → 主进程写 HKCU 注册表 → 刷新状态 + toast。
 * 注册后浏览器出现在 Windows「打开方式 → 选择其他应用」列表，用户勾选
 * 「始终使用」即由系统完成永久默认（UserChoice 由 Windows 写入）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { displayNameForLocale } from '../../../shared/brand';

/** 分组定义（与主进程 file-association/associations.ts 的 ASSOCIATION_GROUPS 对齐）。 */
interface AssociationGroupDef {
  readonly id: 'media' | 'documents' | 'images';
  readonly label: string;
  readonly description: string;
}

const ASSOCIATION_GROUP_DEFS: readonly AssociationGroupDef[] = [
  { id: 'media', label: '音视频', description: 'MP3 / MP4 / WAV 等音频视频文件' },
  { id: 'documents', label: '文档', description: 'PDF / Markdown / 文本 / JSON 等文档文件' },
  { id: 'images', label: '图片', description: 'PNG / JPG / GIF / SVG 等图片文件' },
];

interface GroupStatus {
  readonly registered: number;
  readonly total: number;
  readonly extensions: readonly string[];
}

/**
 * 「默认应用」选项卡：把本浏览器注册为音视频/文档/图片的打开方式。
 *
 * 交互：每张卡片显示该组扩展名与注册状态；点「设为默认打开方式」→
 * file-association.register → 主进程写 HKCU 注册表 → 刷新状态 + toast。
 * 注册后浏览器出现在 Windows「打开方式 → 选择其他应用」列表，用户勾选
 * 「始终使用」即由系统完成永久默认（UserChoice 由 Windows 写入）。
 */
export function FilesTab({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [statuses, setStatuses] = useState<Record<string, GroupStatus> | null>(null);
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);
  const [settingDefaultBrowser, setSettingDefaultBrowser] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file-association.getStatus', {})) as {
        groups: Record<string, GroupStatus>;
      };
      setStatuses(res.groups);
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

  const handleSetDefaultBrowser = useCallback(async () => {
    setSettingDefaultBrowser(true);
    try {
      const res = (await window.urchin.invoke('file-association.setDefaultBrowser', {})) as {
        openedSettings: boolean;
      };
      onToast(
        res.openedSettings
          ? `已登记默认浏览器能力，请在系统「默认应用」中选择 ${displayNameForLocale(navigator.language)}`
          : '已登记默认浏览器能力，请到系统「默认应用」中手动选择本浏览器',
      );
    } catch (e) {
      onToast('设置默认浏览器失败：' + String(e));
    } finally {
      setSettingDefaultBrowser(false);
    }
  }, [onToast]);

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
          `已注册。可在系统「打开方式」选择 ${displayNameForLocale(navigator.language)} 并勾选"始终使用"`,
        );
        await loadStatus();
      } catch (e) {
        onToast('注册失败：' + String(e));
      } finally {
        setRegistering(null);
      }
    },
    [loadStatus, onToast, selected],
  );

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">默认应用</h1>
      <p className="mb-6 text-sm text-text-secondary">
        把 {displayNameForLocale(navigator.language)}{' '}
        设为默认浏览器和音视频、文档、图片的打开方式。Windows 10/11 不允许程序直接改写默认浏览器，
        点击下方按钮后会打开系统「默认应用」页，由你确认选择本浏览器。
      </p>

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
          const status = statuses?.[group.id];
          const selectedExtensions = selected[group.id] ?? [];
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
                {status && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs',
                      status.registered > 0
                        ? 'bg-success/15 text-success'
                        : 'bg-text-secondary/10 text-text-secondary',
                    )}
                  >
                    {status.registered}/{status.total} 已关联
                  </span>
                )}
              </div>
              {status && status.extensions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {status.extensions.map((ext) => (
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
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                disabled={registering === group.id || selectedExtensions.length === 0}
                onClick={() => void handleRegister(group.id)}
              >
                {registering === group.id
                  ? '注册中…'
                  : `设为默认打开方式（${selectedExtensions.length}）`}
              </Button>
            </div>
          );
        })}
    </section>
  );
}

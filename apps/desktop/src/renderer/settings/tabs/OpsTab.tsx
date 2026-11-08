/**
 * 「操作」选项卡（refactor-plan-p2 §3.3 步骤 7：自 SettingsPage.tsx 原样提升
 * 为独立文件，逻辑不变）
 *
 * 组成：操作设置字段（OPS_FIELDS）+ OpsTab（经共享 SettingsSection 渲染）
 * + UpdateSection（自动更新：检查/下载/安装，仅 Windows 生效）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { SettingsSection, type SettingField } from '../settings-form';

const OPS_FIELDS: readonly SettingField[] = [
  {
    key: 'ui.rightSidebarAutoExpand',
    label: '右侧边栏展开方式',
    desc: '切换展开方式：双击展开（默认）/ 悬停自动展开。开启=悬停自动展开，关闭=双击展开',
    type: 'select',
    options: [
      { value: 'false', label: '双击展开' },
      { value: 'true', label: '悬停自动展开' },
    ],
  },
  {
    key: 'ui.leftSidebarAutoExpand',
    label: '左侧边栏悬停自动展开',
    desc: '开启后，左侧栏折叠时鼠标停留即可自动展开（默认关闭）；双击左侧栏空白处始终可展开/折叠。',
    type: 'toggle',
  },
  {
    key: 'debug.sidebarHoverDelay',
    label: '侧边栏悬停展开延迟',
    desc: '右侧栏折叠时，鼠标停留多久后自动展开（毫秒，0 = 立即展开，范围 0–3000）。仅在「展开方式=悬停自动展开」时生效',
    type: 'number',
    min: 0,
    max: 3000,
    step: 50,
    unit: 'ms',
  },
  {
    key: 'ui.workspaceSwitcherMode',
    label: '折叠态工作区切换',
    desc: '右侧栏折叠时切换工作区的方式：点击图标打开工作区总览页（卡片，默认）或滚轮循环切换；展开态选项条不受影响',
    type: 'select',
    options: [
      { value: 'cards', label: '点击卡片' },
      { value: 'wheel', label: '滚轮循环切换' },
    ],
  },
];
// ───────────────── 更新选项卡 ─────────────────

/** update.* IPC 状态快照（与 packages/ipc-contract updateStateSchema 对齐）。 */
export interface UpdateStateView {
  readonly status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly releaseName?: string;
  readonly releaseNotes?: string;
  readonly progress?: {
    readonly percent: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  };
  readonly error?: string;
  readonly checkedAt?: string;
}

/** 字节数 → 人类可读文案（下载进度用）。 */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** ISO 时间 → 本地时间文案（检查时间展示）。 */
function formatCheckedAt(iso?: string): string {
  if (!iso) return '未检查';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '未检查' : t.toLocaleString('zh-CN');
}

/** 状态 → 一句话描述（错误优先展示具体原因）。 */
function describeUpdateChannel(currentVersion?: string): string {
  if (!currentVersion) return '…';
  return /^\d+\.\d+\.\d+-/.test(currentVersion)
    ? 'dev（GitHub Releases 预发布）'
    : 'latest（GitHub Releases 正式版）';
}

function describeUpdateStatus(state: UpdateStateView | null, actionError: string | null): string {
  switch (state?.status ?? 'idle') {
    case 'disabled':
      return '开发模式下不检查更新（安装版自动连接 GitHub Releases）';
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return '已是最新版本';
    case 'available':
      return `发现新版本 v${state?.latestVersion ?? ''}`;
    case 'downloading':
      return `正在下载 v${state?.latestVersion ?? ''}…`;
    case 'downloaded':
      return `新版本 v${state?.latestVersion ?? ''} 已下载，重启后完成更新`;
    case 'installing':
      return '正在退出并安装，应用将自动重启…';
    case 'error':
      return actionError ?? state?.error ?? '更新失败';
    default:
      return '点击「立即检查」连接 GitHub Releases 获取最新版本';
  }
}

/**
 * 「操作」选项卡：侧栏/工作区/悬浮球设置。
 */
export function OpsTab({
  entries,
  onChange,
}: {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}) {
  const sensVRaw = entries['ui.statusBall.sensitivityVertical'];
  const ballSensV = typeof sensVRaw === 'number' && Number.isFinite(sensVRaw) ? sensVRaw : 1;
  const sensHRaw = entries['ui.statusBall.sensitivityHorizontal'];
  const ballSensH = typeof sensHRaw === 'number' && Number.isFinite(sensHRaw) ? sensHRaw : 1;

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">操作</h1>
      <SettingsSection
        title="侧栏与工作区"
        fields={OPS_FIELDS}
        entries={entries}
        onChange={onChange}
      />

      {/* 地址栏悬浮球滚动灵敏度设置 */}
      <div className="mt-6 rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-sm font-medium">地址栏悬浮球滚动灵敏度</div>
        <div className="mt-0.5 text-xs text-text-secondary">
          按住悬浮球拖动滚动网页时的位移倍率（上下/左右独立可调；0.1–5.0，默认
          1.0）。拖到限位后继续按住，网页仍会持续滚动直到松手。
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">上下</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">左右</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function UpdateSection() {
  const [state, setState] = useState<UpdateStateView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (payload: unknown): void => {
      if (alive) setState(payload as UpdateStateView);
    };
    // 主进程状态变化推送（下载进度 / 已下载 / 错误…）
    const off = window.urchin.on('update:event', apply);
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        apply(s);
        const status = (s as UpdateStateView).status;
        // 打开更新页自动检查一次（进行中/已下载/安装中/开发态不打扰）
        if (
          status === 'idle' ||
          status === 'up-to-date' ||
          status === 'available' ||
          status === 'error'
        ) {
          return window.urchin.invoke('update.check', {}).then(apply, () => undefined);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback((channel: 'update.check' | 'update.download' | 'update.install') => {
    setActionError(null);
    void window.urchin.invoke(channel, {}).then(
      (s) => {
        if (s && typeof s === 'object' && 'status' in s) setState(s as UpdateStateView);
      },
      (e: unknown) => setActionError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const status = state?.status ?? 'idle';
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';
  const errorText = actionError ?? (status === 'error' ? state?.error : undefined);
  const progress = state?.progress ?? { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };

  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-3 text-sm font-medium">更新检查</div>
      <div className="rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-xs text-text-secondary">当前版本</div>
        <div className="mt-1 text-lg font-medium">v{state?.currentVersion ?? '…'}</div>
        <div className="mt-1 text-xs text-text-secondary">
          更新通道：{describeUpdateChannel(state?.currentVersion)}
        </div>
      </div>

      <div className="rounded-md border border-border px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-medium">检查更新</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              {describeUpdateStatus(state, actionError)}（上次检查：
              {formatCheckedAt(state?.checkedAt)}）
            </div>
            {errorText && <div className="mt-1 text-xs text-error">{errorText}</div>}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => run('update.check')}
            disabled={busy || status === 'disabled'}
          >
            {status === 'checking' ? '检查中…' : '立即检查'}
          </Button>
        </div>
      </div>

      {status === 'available' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">发现新版本 v{state?.latestVersion ?? ''}</div>
          {state?.releaseName && (
            <div className="mt-0.5 text-xs text-text-secondary">{state.releaseName}</div>
          )}
          {state?.releaseNotes && (
            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-xs text-text-secondary">
              {state.releaseNotes}
            </pre>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.download')}>
              下载并更新
            </Button>
          </div>
        </div>
      )}

      {status === 'downloading' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">正在下载 v{state?.latestVersion ?? ''}</div>
            <div className="text-xs text-text-secondary">{Math.floor(progress.percent)}%</div>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(progress.percent)}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
          <div className="mt-1.5 text-xs text-text-secondary">
            {formatBytes(progress.transferred)} / {formatBytes(progress.total)} ·{' '}
            {formatBytes(progress.bytesPerSecond)}/s
          </div>
        </div>
      )}

      {status === 'downloaded' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">v{state?.latestVersion ?? ''} 已就绪</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            点击「重启并安装」立即更新；直接退出应用也会自动完成安装。
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.install')}>
              重启并安装
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

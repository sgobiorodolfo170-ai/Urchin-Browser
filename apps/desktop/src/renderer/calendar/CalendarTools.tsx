import { useEffect, useState } from 'react';
import { calendarChannels, calendarBackupSchema, type Calendar } from '@urchin/ipc-contract';
import { CalendarConfirmation } from './CalendarConfirmation';

const field = 'rounded border border-border bg-surface px-2 py-1 text-text';
export function CalendarTools({
  calendars,
  filter,
  onFilter,
  onRefresh,
  disabled,
  onDraftChange,
  onBusyChange,
}: {
  readonly calendars: readonly Calendar[];
  readonly filter: readonly string[] | null;
  readonly onFilter: (ids: string[]) => void;
  readonly onRefresh: () => void;
  readonly disabled: boolean;
  readonly onDraftChange: (dirty: boolean) => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [edit, setEdit] = useState<Calendar | 'new' | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4285F4');
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [isDefault, setDefault] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  const [restore, setRestore] = useState<{ data: string; digest: string; count: number } | null>(
    null,
  );
  const start = (calendar: Calendar | 'new') => {
    onDraftChange(true);
    setEdit(calendar);
    setName(calendar === 'new' ? '' : calendar.name);
    setColor(calendar === 'new' ? '#4285F4' : calendar.color);
    setZone(
      calendar === 'new' ? Intl.DateTimeFormat().resolvedOptions().timeZone : calendar.timeZone,
    );
    setDefault(calendar === 'new' ? false : calendar.isDefault);
    setEnabled(calendar === 'new' ? true : calendar.isEnabled);
  };
  const prepare = async (data: string) => {
    const parsed = calendarBackupSchema.parse(JSON.parse(data));
    const current = calendarChannels['calendar.exportBackup'].res.parse(
      await window.urchin.invoke('calendar.exportBackup', {}),
    );
    setRestore({ data, digest: current.digest, count: parsed.events.length });
  };
  return (
    <details className="max-h-[30vh] shrink-0 overflow-auto overscroll-contain border-b border-border px-4 py-2 text-sm">
      <summary className="cursor-pointer text-text-secondary">日历管理、筛选与备份</summary>
      <div className="mt-2 flex flex-wrap gap-3">
        {calendars.map((calendar) => (
          <div key={calendar.calendarId} className="flex items-center gap-1">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={`显示日历 ${calendar.name}`}
                checked={
                  filter === null ? calendar.isEnabled : filter.includes(calendar.calendarId)
                }
                onChange={(e) => {
                  const ids =
                    filter ??
                    calendars.filter((item) => item.isEnabled).map((item) => item.calendarId);
                  onFilter(
                    e.target.checked
                      ? [...ids, calendar.calendarId]
                      : ids.filter((id) => id !== calendar.calendarId),
                  );
                }}
              />
              <span style={{ color: calendar.color }}>●</span>
              {calendar.name}
              {calendar.isDefault ? '（默认）' : ''}
              {!calendar.isEnabled ? '（已归档）' : ''}
            </label>
            <button
              type="button"
              className="text-primary"
              disabled={disabled || busy}
              aria-label={`管理日历 ${calendar.name}`}
              onClick={() => start(calendar)}
            >
              管理
            </button>
          </div>
        ))}
      </div>
      <div className="my-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={field}
          disabled={disabled || busy}
          onClick={() => start('new')}
        >
          新建日历
        </button>
        <button
          type="button"
          className={field}
          disabled={disabled || busy}
          onClick={() => {
            setBusy(true);
            void window.urchin
              .invoke('calendar.exportBackup', {})
              .then((raw) => {
                const backup = calendarChannels['calendar.exportBackup'].res.parse(raw);
                const url = URL.createObjectURL(
                  new Blob([backup.data], { type: 'application/json' }),
                );
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `urchin-calendar-${new Date().toISOString().slice(0, 10)}.json`;
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
              })
              .catch(() => setError('导出失败'))
              .finally(() => setBusy(false));
          }}
        >
          导出日历备份
        </button>
        <label>
          导入备份
          <input
            aria-label="导入日历备份"
            type="file"
            accept=".json,application/json"
            className="ml-2 max-w-48"
            disabled={disabled || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 5_000_000) {
                setError('备份不能超过 5MB');
                return;
              }
              void file
                .text()
                .then(prepare)
                .catch(() => setError('备份格式无效'));
            }}
          />
        </label>
        <button
          type="button"
          className={field}
          disabled={disabled || busy}
          onClick={() => {
            void window.urchin
              .invoke('calendar.exportBackup', {})
              .then((raw) => {
                const backup = calendarChannels['calendar.exportBackup'].res.parse(raw);
                if (!backup.previous) {
                  setError('暂无可撤销的恢复');
                  return;
                }
                return prepare(backup.previous);
              })
              .catch(() => setError('读取恢复记录失败'));
          }}
        >
          撤销上次恢复
        </button>
      </div>
      {edit && (
        <form
          aria-label="日历管理表单"
          className="my-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void window.urchin
              .invoke('calendar.saveCalendar', {
                ...(edit === 'new'
                  ? {}
                  : { calendarId: edit.calendarId, expectedVersion: edit.version }),
                calendar: { name, color, timeZone: zone, isDefault, isEnabled: enabled },
              })
              .then(() => {
                setEdit(null);
                onDraftChange(false);
                onRefresh();
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '保存失败'))
              .finally(() => setBusy(false));
          }}
        >
          <input
            aria-label="日历名称"
            className={field}
            value={name}
            required
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="日历颜色"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <input
            aria-label="日历默认时区"
            className={field}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            required
          />
          <label>
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setDefault(e.target.checked)}
            />
            默认日历
          </label>
          <label>
            <input
              aria-label="启用日历"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用（取消即归档）
          </label>
          <button type="submit" disabled={busy} className={field}>
            保存日历
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEdit(null);
              onDraftChange(false);
            }}
          >
            取消
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {restore && (
        <CalendarConfirmation
          title="恢复日历备份"
          message={`将用备份中的 ${restore.count} 个事件覆盖当前日历数据。恢复前自动保留最近 3 份快照，可撤销上次恢复。速记数据不受影响。`}
          confirmLabel="恢复备份"
          busy={busy}
          onCancel={() => setRestore(null)}
          onConfirm={() => {
            setBusy(true);
            void window.urchin
              .invoke('calendar.importBackup', {
                data: restore.data,
                expectedDigest: restore.digest,
              })
              .then(() => {
                setRestore(null);
                onRefresh();
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '恢复失败'))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </details>
  );
}

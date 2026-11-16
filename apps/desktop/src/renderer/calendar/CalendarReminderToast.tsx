import { useEffect, useState } from 'react';
import { calendarChannels } from '@urchin/ipc-contract';

export function CalendarReminderToast() {
  const [error, setError] = useState('');
  const [items, setItems] = useState<{ id: string; title: string; dueAt: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.urchin
        .invoke('calendar.listReminders', {})
        .then((raw) => {
          if (alive) setItems(calendarChannels['calendar.listReminders'].res.parse(raw).reminders);
        })
        .catch(() => undefined);
    };
    load();
    const startup = setTimeout(load, 1500);
    const dispose = window.urchin.on('calendar.reminder', load);
    const disposeChanges = window.urchin.on('calendar.changed', load);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      clearTimeout(startup);
      dispose();
      disposeChanges();
      window.removeEventListener('focus', load);
    };
  }, []);
  if (!items.length) return null;
  return (
    <aside
      aria-label="日历提醒"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-72 space-y-2 rounded-lg border border-border bg-surface p-3 text-sm text-text shadow-xl"
    >
      <strong>日历提醒{items.length > 3 ? `（${items.length}）` : ''}</strong>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {items.slice(0, 3).map((item) => (
        <div key={item.id} className="flex items-start justify-between gap-2">
          <span className="break-words">
            <span className="block">{item.title}</span>
            <small className="block text-text-secondary">
              {new Date(item.dueAt).toLocaleString()}
            </small>
          </span>
          <button
            type="button"
            aria-label={`关闭提醒 ${item.title}`}
            className="shrink-0 rounded px-2 text-text-secondary hover:bg-primary/10"
            onClick={() => {
              void window.urchin
                .invoke('calendar.dismissReminder', { id: item.id })
                .then(() =>
                  setItems((previous) => previous.filter((value) => value.id !== item.id)),
                )
                .catch(() => setError('更新提醒失败，请重试'));
            }}
          >
            关闭
          </button>
        </div>
      ))}
    </aside>
  );
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../lib/utils';

const button =
  'rounded-md p-2 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** 入口阶段仅浏览日期；事件数据将在 M8 / typed IPC 接入后提供。 */
export function CalendarDialog({ onClose }: { readonly onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(() => new Date());
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const today = new Date();
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="calendar-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
      className="m-auto h-[86vh] max-h-[900px] w-[92vw] max-w-[1280px] overflow-hidden rounded-xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/50"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <h2 id="calendar-title" className="mr-4 text-lg font-semibold">
            日历
          </h2>
          <button
            type="button"
            className={button}
            aria-label="上个月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              setSelected(today);
              setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            }}
          >
            今天
          </button>
          <button
            type="button"
            className={button}
            aria-label="下个月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span aria-live="polite" className="font-medium">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </span>
          <button
            type="button"
            className={cn(button, 'ml-auto')}
            aria-label="关闭日历"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain p-4 sm:flex-row sm:gap-4">
          <section aria-label="月视图" className="flex min-h-[320px] min-w-0 flex-1 flex-col">
            <div className="grid grid-cols-7 text-center text-sm text-text-secondary">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <div key={day} className="py-2">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid flex-1 grid-cols-7 grid-rows-6 gap-1">
              {days.map((day) => (
                <button
                  key={day.getTime()}
                  type="button"
                  aria-label={day.toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                  aria-pressed={sameDay(day, selected)}
                  aria-current={sameDay(day, today) ? 'date' : undefined}
                  className={cn(
                    button,
                    'border border-border text-left text-sm',
                    day.getMonth() !== month.getMonth() && 'text-text-secondary',
                    sameDay(day, today) && 'font-bold text-primary',
                    sameDay(day, selected) && 'bg-primary/15 ring-1 ring-primary',
                  )}
                  onClick={() => {
                    setSelected(day);
                    setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
                  }}
                >
                  {day.getDate()}
                </button>
              ))}
            </div>
          </section>
          <aside className="py-4 text-sm sm:w-56 sm:shrink-0">
            <h3 className="font-semibold">
              {selected.toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}
            </h3>
            <p className="mt-4 leading-relaxed text-text-secondary">
              日程管理尚未接入。后续支持事件创建、议程查看与本地保存。
            </p>
          </aside>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

import type { CalendarEvent, Calendar } from '@urchin/ipc-contract';
import { useEffect, useRef } from 'react';
import { dateKey } from './EventEditor';

export function CalendarTimeView({
  selected,
  mode,
  events,
  calendars,
  onSelect,
  onEdit,
}: {
  readonly selected: Date;
  readonly mode: 'week' | 'day';
  readonly events: readonly CalendarEvent[];
  readonly calendars: readonly Calendar[];
  readonly onSelect: (date: Date) => void;
  readonly onEdit: (event: CalendarEvent) => void;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const selectedDay = dateKey(selected);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 8 * 40;
  }, [mode, selectedDay]);
  const first = new Date(
    selected.getFullYear(),
    selected.getMonth(),
    selected.getDate() - (mode === 'week' ? (selected.getDay() + 6) % 7 : 0),
  );
  const days = Array.from(
    { length: mode === 'week' ? 7 : 1 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index),
  );
  return (
    <section
      ref={scrollRef}
      aria-label={mode === 'week' ? '周视图' : '日视图'}
      className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
    >
      <div
        className="grid min-w-[350px]"
        style={{ gridTemplateColumns: `40px repeat(${days.length},minmax(0,1fr))` }}
      >
        <div className="sticky top-0 z-10 bg-surface" />
        {days.map((day) => (
          <button
            key={dateKey(day)}
            type="button"
            className="sticky top-0 z-10 border-b border-border bg-surface p-2 text-xs"
            aria-label={`选择日期 ${dateKey(day)}`}
            onClick={() => onSelect(day)}
          >
            {day.toLocaleDateString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              weekday: 'short',
            })}
          </button>
        ))}
        <span className="p-1 text-xs text-text-secondary">全天</span>
        {days.map((day) => (
          <div key={dateKey(day)} className="min-h-10 border-b border-l border-border p-1">
            {events
              .filter(
                (event) =>
                  event.allDay &&
                  event.startDate! <= dateKey(day) &&
                  dateKey(day) < event.endDateExclusive!,
              )
              .map((event) => (
                <button
                  key={event.eventId}
                  type="button"
                  className="mb-1 block w-full truncate rounded bg-primary/10 p-1 text-left text-xs"
                  onClick={() => onEdit(event)}
                >
                  {event.title}
                </button>
              ))}
          </div>
        ))}
        <div className="relative h-[960px]">
          {Array.from({ length: 24 }, (_, hour) => (
            <span
              key={hour}
              className="absolute text-[10px] text-text-secondary"
              style={{ top: hour * 40 }}
            >
              {String(hour).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {days.map((day) => {
          const until = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
          const items = events
            .filter(
              (event) =>
                !event.allDay &&
                Date.parse(event.startAt!) < until &&
                Date.parse(event.endAt!) > day.getTime(),
            )
            .sort((a, b) => Date.parse(a.startAt!) - Date.parse(b.startAt!));
          const laneEnds: number[] = [];
          const positioned = items.map((event) => {
            let lane = laneEnds.findIndex((end) => end <= Date.parse(event.startAt!));
            if (lane < 0) lane = laneEnds.length;
            laneEnds[lane] = Date.parse(event.endAt!);
            return { event, lane };
          });
          return (
            <div
              key={dateKey(day)}
              className="relative h-[960px] border-l border-border"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to bottom, transparent 0px, transparent 39px, var(--color-border, #80808033) 39px, var(--color-border, #80808033) 40px)',
              }}
            >
              {positioned.map(({ event, lane }) => {
                const a = new Date(event.startAt!),
                  b = new Date(event.endAt!);
                const start = a.getTime() <= day.getTime() ? 0 : a.getHours() * 60 + a.getMinutes();
                const end = b.getTime() >= until ? 1440 : b.getHours() * 60 + b.getMinutes();
                const color =
                  calendars.find((calendar) => calendar.calendarId === event.calendarId)?.color ??
                  '#4285F4';
                return (
                  <button
                    key={event.eventId}
                    type="button"
                    title={`${event.title} ${a.toLocaleString()} — ${b.toLocaleString()}`}
                    className="absolute overflow-hidden rounded border border-border bg-surface p-1 text-left text-xs shadow-sm"
                    style={{
                      top: (start * 2) / 3,
                      height: Math.max(20, ((end - start) * 2) / 3),
                      left: `${(lane * 100) / Math.max(1, laneEnds.length)}%`,
                      width: `${100 / Math.max(1, laneEnds.length)}%`,
                      borderLeft: `3px solid ${color}`,
                    }}
                    onClick={() => onEdit(event)}
                  >
                    <span className="block truncate">{event.title}</span>
                    <small>
                      {a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </small>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

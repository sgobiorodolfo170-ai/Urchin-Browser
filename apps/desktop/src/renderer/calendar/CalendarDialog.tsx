import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../lib/utils';
import type { CalendarEvent, CalendarEventInput, Calendar } from '@urchin/ipc-contract';
import { calendarChannels } from '@urchin/ipc-contract';
import { dateKey, EventEditor } from './EventEditor';
import { CalendarConfirmation } from './CalendarConfirmation';
import { CalendarTools } from './CalendarTools';
import { CalendarTimeView } from './CalendarTimeView';

const button =
  'rounded-md p-2 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** M28 本地日历；笔记页面保持挂载，日程经 typed IPC 写主库。 */
export function CalendarDialog({
  onClose,
  relationOptions = [],
  onOpenRelation,
}: {
  readonly onClose: () => void;
  readonly relationOptions?: readonly { type: 'note' | 'task'; id: string; name: string }[];
  readonly onOpenRelation?: (type: 'note' | 'task', id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'month' | 'agenda' | 'week' | 'day'>('month');
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [filter, setFilter] = useState<string[] | null>(null);
  const [deleteScope, setDeleteScope] = useState<'single' | 'future' | 'series'>('single');
  const [catalogDirty, setCatalogDirty] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  useEffect(
    () => window.urchin.on('calendar.changed', () => setRevision((value) => value + 1)),
    [],
  );
  const [search, setSearch] = useState('');
  const [trash, setTrash] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CalendarEvent | null>(null);
  const [discard, setDiscard] = useState<'close' | 'edit' | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState(() => new Date());
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const today = new Date();
  const move = (direction: number) => {
    const next =
      view === 'month' || view === 'agenda'
        ? new Date(month.getFullYear(), month.getMonth() + direction, 1)
        : new Date(
            selected.getFullYear(),
            selected.getMonth(),
            selected.getDate() + direction * (view === 'week' ? 7 : 1),
          );
    setSelected(next);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };
  useEffect(() => {
    let active = true;
    const from = new Date(month.getFullYear(), month.getMonth(), -7);
    const until = new Date(month.getFullYear(), month.getMonth() + 1, 9);
    const load = () => {
      void window.urchin
        .invoke('calendar.listEvents', {
          startAt: from.toISOString(),
          endAt: until.toISOString(),
          includeDeleted: trash,
          calendarIds: filter ?? [],
        })
        .then((result) => {
          if (active) {
            setEvents(calendarChannels['calendar.listEvents'].res.parse(result).events);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('加载日历失败，请重试');
        });
    };
    load();
    void window.urchin
      .invoke('calendar.listCalendars', {})
      .then((raw) => {
        if (active)
          setCalendars(calendarChannels['calendar.listCalendars'].res.parse(raw).calendars);
      })
      .catch(() => {
        if (active) setError('加载日历列表失败');
      });
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [month, revision, trash, filter]);
  const close = () => {
    if (discard || deleteTarget) {
      setDiscard(null);
      setDeleteTarget(null);
      return;
    }
    if (busy || catalogBusy) return;
    if (dirty || catalogDirty) setDiscard('close');
    else onClose();
  };
  const cancelEdit = () => {
    if (dirty) setDiscard('edit');
    else setEditing(null);
  };
  const visibleEvents = events.filter(
    (event) =>
      Boolean(event.deletedAt) === trash &&
      (filter === null || filter.includes(event.calendarId)) &&
      event.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const onDay = (event: CalendarEvent, day: Date) =>
    event.allDay
      ? Boolean(
          event.startDate &&
          event.endDateExclusive &&
          event.startDate <= dateKey(day) &&
          dateKey(day) < event.endDateExclusive,
        )
      : Boolean(
          event.startAt &&
          event.endAt &&
          Date.parse(event.startAt) <
            new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() &&
          Date.parse(event.endAt) >
            new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(),
        );
  const save = async (input: CalendarEventInput, scope?: 'single' | 'future' | 'series') => {
    setBusy(true);
    try {
      const { events: conflicts } = calendarChannels['calendar.checkConflicts'].res.parse(
        await window.urchin.invoke('calendar.checkConflicts', {
          event: input,
          ...(editing && editing !== 'new' ? { excludeEventId: editing.eventId } : {}),
        }),
      );
      // 冲突不阻止用户明确保存；结果显示在错误区供审阅后再次提交。
      if (conflicts.length && !conflictAccepted.current) {
        conflictAccepted.current = true;
        throw new Error(`与 ${conflicts.length} 个日程时间重叠，再次保存可继续。`);
      }
      if (editing === 'new')
        await window.urchin.invoke('calendar.createEvent', {
          event: input,
          idempotencyKey: requestKey,
        });
      else if (editing)
        await window.urchin.invoke('calendar.updateEvent', {
          eventId: editing.eventId,
          expectedVersion: editing.version,
          event: input,
          scope,
        });
      setEditing(null);
      setDirty(false);
      setRevision((value) => value + 1);
      conflictAccepted.current = false;
    } finally {
      setBusy(false);
    }
  };
  const conflictAccepted = useRef(false);
  const startEditing = (event: CalendarEvent | 'new') => {
    if (dirty || busy || catalogDirty || catalogBusy) return;
    setEditing(event);
    setDirty(false);
    setRequestKey(crypto.randomUUID());
    conflictAccepted.current = false;
  };
  const mutate = async (
    event: CalendarEvent,
    restore: boolean,
    scope?: 'single' | 'future' | 'series',
  ) => {
    setBusy(true);
    try {
      if (restore)
        await window.urchin.invoke('calendar.restoreEvent', {
          eventId: event.eventId,
          expectedVersion: event.version,
        });
      else
        await window.urchin.invoke('calendar.deleteEvent', {
          eventId: event.eventId,
          expectedVersion: event.version,
          scope,
        });
      setRevision((value) => value + 1);
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };
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
        close();
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
            close();
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
            aria-label={view === 'week' ? '上一周' : view === 'day' ? '上一天' : '上个月'}
            onClick={() => move(-1)}
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
            aria-label={view === 'week' ? '下一周' : view === 'day' ? '下一天' : '下个月'}
            onClick={() => move(1)}
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
            onClick={close}
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm">
          <span className="mr-2 text-text-secondary">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
          {(['week', 'day'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={button}
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
            >
              {mode === 'week' ? '周视图' : '日视图'}
            </button>
          ))}
          <button
            type="button"
            className={button}
            aria-pressed={view === 'month'}
            onClick={() => setView('month')}
          >
            月视图
          </button>
          <button
            type="button"
            className={button}
            aria-pressed={view === 'agenda'}
            onClick={() => setView('agenda')}
          >
            议程
          </button>
          <input
            aria-label="搜索日程"
            placeholder="搜索日程"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 rounded border border-border bg-surface px-2 py-1"
          />
          <label className="flex gap-1">
            <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
            已删除
          </label>
          <button
            type="button"
            className={cn(button, 'ml-auto text-primary')}
            disabled={dirty || busy || catalogDirty || catalogBusy || !calendars.length}
            onClick={() => startEditing('new')}
          >
            新建日程
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新日历
          </button>
        </div>
        <CalendarTools
          calendars={calendars}
          filter={filter}
          onFilter={setFilter}
          onRefresh={() => {
            setCatalogDirty(false);
            setFilter(null);
            setRevision((value) => value + 1);
          }}
          disabled={Boolean(editing) || busy}
          onDraftChange={setCatalogDirty}
          onBusyChange={setCatalogBusy}
        />
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-error">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain p-4 sm:flex-row sm:gap-4 sm:overflow-hidden">
          {(view === 'week' || view === 'day') && (
            <CalendarTimeView
              selected={selected}
              mode={view}
              events={visibleEvents}
              calendars={calendars}
              onSelect={(day) => {
                setSelected(day);
                setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
              }}
              onEdit={startEditing}
            />
          )}
          <section
            aria-label="月视图"
            className={cn(
              'flex min-h-[320px] min-w-0 flex-1 flex-col sm:h-full',
              view !== 'month' && 'hidden',
            )}
          >
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
                  aria-selected={sameDay(day, selected)}
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
                  <span className="block truncate text-xs text-primary">
                    {visibleEvents
                      .filter((event) => onDay(event, day))
                      .slice(0, 2)
                      .map((event) => event.title)
                      .join(' · ')}
                  </span>
                  {visibleEvents.filter((event) => onDay(event, day)).length > 2 && (
                    <span className="text-xs text-text-secondary">更多日程</span>
                  )}
                </button>
              ))}
            </div>
          </section>
          {view === 'agenda' && (
            <section
              aria-label="议程列表"
              className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto sm:h-full"
            >
              {visibleEvents
                .filter((event) => onDay(event, selected))
                .map((event) => (
                  <div key={event.eventId} className="rounded border border-border p-3">
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => startEditing(event)}
                    >
                      {event.title}
                    </button>
                    <p className="text-xs text-text-secondary">
                      {event.allDay
                        ? `${event.startDate} — ${event.endDateExclusive}（不含结束日）`
                        : `${new Date(event.startAt!).toLocaleString()} — ${new Date(event.endAt!).toLocaleString()}`}
                    </p>
                  </div>
                ))}
              {!visibleEvents.some((event) => onDay(event, selected)) && (
                <p className="text-text-secondary">所选日期没有日程</p>
              )}
            </section>
          )}
          <aside className="space-y-3 py-4 text-sm sm:h-full sm:w-80 sm:shrink-0 sm:overflow-y-auto sm:overscroll-contain">
            <h3 className="font-semibold">
              {selected.toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}
            </h3>
            {editing ? (
              <EventEditor
                key={editing === 'new' ? requestKey : editing.eventId}
                event={editing === 'new' ? null : editing}
                selected={selected}
                onDirty={() => {
                  setDirty(true);
                  conflictAccepted.current = false;
                }}
                onSave={save}
                onCancel={cancelEdit}
                busy={busy}
                calendars={calendars}
                relationOptions={relationOptions}
              />
            ) : (
              <>
                {visibleEvents
                  .filter((event) => onDay(event, selected))
                  .map((event) => (
                    <article
                      key={event.eventId}
                      className="space-y-2 rounded border border-border p-3"
                    >
                      <h4 className="break-words font-medium">{event.title}</h4>
                      <p
                        className="text-xs"
                        style={{
                          color: calendars.find(
                            (calendar) => calendar.calendarId === event.calendarId,
                          )?.color,
                        }}
                      >
                        {
                          calendars.find((calendar) => calendar.calendarId === event.calendarId)
                            ?.name
                        }
                        {event.seriesId ? ' · 重复日程' : ''}
                      </p>
                      {event.attendees.length > 0 && (
                        <p className="text-xs text-text-secondary">
                          参与者：
                          {event.attendees
                            .map(
                              (person) =>
                                `${person.displayName}（${person.responseStatus === 'accepted' ? '已接受' : person.responseStatus === 'declined' ? '已拒绝' : person.responseStatus === 'tentative' ? '待定' : '未响应'}）`,
                            )
                            .join('、')}
                        </p>
                      )}
                      {event.relations.map((relation) => (
                        <div key={`${relation.type}:${relation.id}`} className="text-xs">
                          {(relation.type === 'note' || relation.type === 'task') &&
                          relationOptions.some(
                            (option) => option.type === relation.type && option.id === relation.id,
                          ) ? (
                            <button
                              type="button"
                              className="text-primary"
                              onClick={() =>
                                onOpenRelation?.(relation.type as 'note' | 'task', relation.id)
                              }
                            >
                              {relation.type === 'note' ? '打开关联笔记' : '打开关联任务'}：
                              {
                                relationOptions.find(
                                  (option) =>
                                    option.type === relation.type && option.id === relation.id,
                                )?.name
                              }
                            </button>
                          ) : (
                            <span className="break-all text-text-secondary">
                              关联引用 {relation.type}：{relation.id}（由所属模块解析）
                            </span>
                          )}
                        </div>
                      ))}
                      <p className="text-xs text-text-secondary">
                        {event.allDay
                          ? '全天'
                          : `${new Date(event.startAt!).toLocaleString()} — ${new Date(event.endAt!).toLocaleString()}`}{' '}
                        · {event.timeZone}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{event.description}</p>
                      {event.location && <p>{event.location}</p>}
                      {event.meetingUrl && (
                        <a
                          className="break-all text-primary"
                          href={event.meetingUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          会议链接
                        </a>
                      )}
                      <p className="text-xs text-text-secondary">
                        {event.status === 'cancelled'
                          ? '已取消'
                          : event.status === 'tentative'
                            ? '待定'
                            : '已确认'}
                      </p>
                      {trash ? (
                        <button
                          type="button"
                          className={button}
                          disabled={busy}
                          onClick={() => {
                            void mutate(event, true);
                          }}
                        >
                          恢复日程
                        </button>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className={button}
                            onClick={() => startEditing(event)}
                          >
                            编辑日程
                          </button>
                          <button
                            type="button"
                            className={cn(button, 'text-error')}
                            onClick={() => {
                              setDeleteScope('single');
                              setDeleteTarget(event);
                            }}
                          >
                            删除日程
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                {!visibleEvents.some((event) => onDay(event, selected)) && (
                  <p className="text-text-secondary">所选日期没有日程</p>
                )}
              </>
            )}
          </aside>
        </div>
        {(discard ?? deleteTarget) && (
          <CalendarConfirmation
            title={discard ? '未保存的日程' : '删除日程确认'}
            message={
              discard
                ? '有未保存的修改，是否放弃？'
                : `删除「${deleteTarget?.title}」？删除后可在“已删除”中恢复。`
            }
            confirmLabel={discard ? '放弃修改' : '确认删除'}
            busy={busy}
            onCancel={() => {
              setDiscard(null);
              setDeleteTarget(null);
            }}
            onConfirm={() => {
              if (discard) {
                const action = discard;
                setDiscard(null);
                setDirty(false);
                setEditing(null);
                if (action === 'close') onClose();
              } else if (deleteTarget) {
                void mutate(deleteTarget, false, deleteTarget.seriesId ? deleteScope : undefined);
              }
            }}
          >
            {deleteTarget?.seriesId && !discard && (
              <label className="mt-3 block">
                删除范围
                <select
                  aria-label="删除范围"
                  className="ml-2 rounded border border-border bg-surface p-1"
                  value={deleteScope}
                  onChange={(e) => setDeleteScope(e.target.value as typeof deleteScope)}
                >
                  <option value="single">仅此日程</option>
                  <option value="future">此日程及以后</option>
                  <option value="series">整个系列</option>
                </select>
              </label>
            )}
          </CalendarConfirmation>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

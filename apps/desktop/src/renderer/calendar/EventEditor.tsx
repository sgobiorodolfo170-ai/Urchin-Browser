import { useState } from 'react';
import {
  calendarEventInputSchema,
  type CalendarEvent,
  type CalendarEventInput,
  type Calendar,
} from '@urchin/ipc-contract';

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function wallValue(iso: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function wallToIso(value: string, timeZone: string) {
  const target = Date.parse(`${value}:00Z`);
  let result = target;
  for (let i = 0; i < 4; i++) {
    const actual = Date.parse(`${wallValue(new Date(result).toISOString(), timeZone)}:00Z`);
    const next = result + target - actual;
    if (next === result) return new Date(result).toISOString();
    result = next;
  }
  throw new Error('该时间在所选时区不存在，请检查夏令时');
}
const field = 'w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text';
export function EventEditor({
  event,
  selected,
  onDirty,
  onSave,
  onCancel,
  busy,
  calendars,
  relationOptions,
}: {
  readonly event: CalendarEvent | null;
  readonly selected: Date;
  readonly onDirty: () => void;
  readonly onSave: (
    input: CalendarEventInput,
    scope?: 'single' | 'future' | 'series',
  ) => Promise<void>;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly calendars: readonly Calendar[];
  readonly relationOptions: readonly { type: 'note' | 'task'; id: string; name: string }[];
}) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [calendarId, setCalendarId] = useState(
    event?.calendarId ??
      calendars.find((calendar) => calendar.isDefault)?.calendarId ??
      'local-default',
  );
  const [scope, setScope] = useState<'single' | 'future' | 'series'>('single');
  const [frequency, setFrequency] = useState(event?.recurrence?.frequency ?? 'none');
  const [interval, setIntervalValue] = useState(event?.recurrence?.interval ?? 1);
  const [count, setCount] = useState(event?.recurrence?.count?.toString() ?? '');
  const [repeatEnd, setRepeatEnd] = useState(event?.recurrence?.endDate ?? '');
  const [weekdays, setWeekdays] = useState(event?.recurrence?.byWeekday ?? []);
  const [relations, setRelations] = useState(event?.relations ?? []);
  const [attendees, setAttendees] = useState(event?.attendees ?? []);
  const [personId, setPersonId] = useState('');
  const [personName, setPersonName] = useState('');
  const [linkType, setLinkType] = useState<'file' | 'email' | 'project' | 'contact'>('file');
  const [linkId, setLinkId] = useState('');
  const [reminderMethod, setReminderMethod] = useState(event?.reminders[0]?.method ?? 'in_app');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [timeZone, setTimeZone] = useState(
    event?.timeZone ??
      calendars.find((calendar) => calendar.isDefault)?.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [start, setStart] = useState(
    event?.startAt ? wallValue(event.startAt, event.timeZone) : `${dateKey(selected)}T09:00`,
  );
  const [end, setEnd] = useState(
    event?.endAt ? wallValue(event.endAt, event.timeZone) : `${dateKey(selected)}T10:00`,
  );
  const [startDate, setStartDate] = useState(event?.startDate ?? dateKey(selected));
  const [endDate, setEndDate] = useState(
    event?.endDateExclusive ??
      dateKey(new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 1)),
  );
  const [description, setDescription] = useState(event?.description ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [meetingUrl, setMeetingUrl] = useState(event?.meetingUrl ?? '');
  const [status, setStatus] = useState(event?.status ?? 'confirmed');
  const [reminder, setReminder] = useState(event?.reminders[0]?.minutesBefore.toString() ?? '');
  const [error, setError] = useState('');
  return (
    <form
      aria-label="日程编辑"
      className="space-y-3"
      onChange={onDirty}
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        try {
          const input = calendarEventInputSchema.parse({
            ...(event && calendarEventInputSchema.strip().parse(event)),
            title,
            calendarId,
            relations,
            attendees,
            seriesId: null,
            recurrence:
              frequency === 'none'
                ? null
                : {
                    frequency,
                    interval,
                    count: count ? Number(count) : null,
                    endDate: repeatEnd || null,
                    startDate: allDay ? startDate : start.slice(0, 10),
                    timeZone,
                    byWeekday: frequency === 'weekly' ? weekdays : [],
                  },
            allDay,
            timeZone,
            startAt: allDay ? null : wallToIso(start, timeZone),
            endAt: allDay ? null : wallToIso(end, timeZone),
            startDate: allDay ? startDate : null,
            endDateExclusive: allDay ? endDate : null,
            description,
            location: location || null,
            meetingUrl: meetingUrl || null,
            status,
            reminders:
              reminder === ''
                ? []
                : [
                    {
                      method: reminderMethod,
                      minutesBefore: Number(reminder),
                    },
                    ...(event?.reminders.slice(1) ?? []),
                  ],
          });
          void onSave(
            input,
            event?.seriesId ? scope : event?.recurrence ? 'series' : undefined,
          ).catch((err: unknown) => setError(err instanceof Error ? err.message : '保存失败'));
        } catch {
          setError('请检查标题、日期、时区和会议链接（仅限 http/https）');
        }
      }}
    >
      <h3 className="font-semibold">{event ? '编辑日程' : '新建日程'}</h3>
      <label className="block">
        所属日历
        <select
          aria-label="所属日历"
          className={field}
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
        >
          {calendars
            .filter((calendar) => calendar.isEnabled || calendar.calendarId === calendarId)
            .map((calendar) => (
              <option key={calendar.calendarId} value={calendar.calendarId}>
                {calendar.name}
              </option>
            ))}
        </select>
      </label>
      {event?.seriesId && (
        <label className="block">
          修改范围
          <select
            aria-label="修改范围"
            className={field}
            value={scope}
            onChange={(e) => {
              const value = e.target.value as typeof scope;
              setScope(value);
              setCount(
                event.recurrence?.count
                  ? String(
                      value === 'future'
                        ? Math.max(1, event.recurrence.count - (event.occurrenceIndex ?? 0))
                        : event.recurrence.count,
                    )
                  : '',
              );
            }}
          >
            <option value="single">仅此日程</option>
            <option value="future">此日程及以后</option>
            <option value="series">整个系列</option>
          </select>
        </label>
      )}
      <label className="block">
        标题
        <input
          aria-label="日程标题"
          className={field}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={300}
        />
      </label>
      <label className="flex gap-2">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        全天
      </label>
      {allDay ? (
        <>
          <label className="block">
            开始日期
            <input
              aria-label="开始日期"
              type="date"
              className={field}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          </label>
          <label className="block">
            结束日期（不含）
            <input
              aria-label="结束日期（不含）"
              type="date"
              className={field}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
          </label>
        </>
      ) : (
        <>
          <label className="block">
            开始时间
            <input
              aria-label="开始时间"
              type="datetime-local"
              className={field}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>
          <label className="block">
            结束时间
            <input
              aria-label="结束时间"
              type="datetime-local"
              className={field}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>
        </>
      )}
      <label className="block">
        时区
        <input
          aria-label="日程时区"
          className={field}
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          required
        />
      </label>
      <label className="block">
        地点
        <input
          className={field}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          maxLength={1000}
        />
      </label>
      <label className="block">
        会议链接
        <input
          type="url"
          className={field}
          value={meetingUrl}
          onChange={(e) => setMeetingUrl(e.target.value)}
        />
      </label>
      <label className="block">
        说明
        <textarea
          aria-label="日程说明"
          className={field}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={20000}
        />
      </label>
      <label className="block">
        状态
        <select
          className={field}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="confirmed">已确认</option>
          <option value="tentative">待定</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      <label className="block">
        提前提醒（分钟）
        <input
          type="number"
          min="0"
          max="40320"
          className={field}
          value={reminder}
          onChange={(e) => setReminder(e.target.value)}
        />
      </label>
      <label className="block">
        提醒方式
        <select
          aria-label="提醒方式"
          className={field}
          value={reminderMethod}
          onChange={(e) => setReminderMethod(e.target.value as typeof reminderMethod)}
        >
          <option value="in_app">应用内提醒</option>
          <option value="notification">系统通知与应用内提醒</option>
        </select>
      </label>
      <p className="text-xs text-text-secondary">
        应用运行时提醒；重启补偿最近 24 小时，退出或关机期间不能保证通知。
      </p>
      <fieldset
        className="space-y-2 rounded border border-border p-2"
        disabled={Boolean(event?.seriesId && scope === 'single')}
      >
        <legend>重复规则</legend>
        <select
          aria-label="重复频率"
          className={field}
          value={frequency}
          disabled={Boolean(event?.seriesId && scope === 'single')}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="none">不重复</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
          <option value="yearly">每年</option>
        </select>
        {frequency !== 'none' && (
          <>
            <label className="block">
              间隔
              <input
                aria-label="重复间隔"
                type="number"
                min="1"
                max="365"
                className={field}
                value={interval}
                onChange={(e) => setIntervalValue(Number(e.target.value))}
              />
            </label>
            {frequency === 'weekly' && (
              <div className="flex flex-wrap gap-2">
                {['一', '二', '三', '四', '五', '六', '日'].map((day, index) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(index + 1)}
                      onChange={(e) =>
                        setWeekdays(
                          e.target.checked
                            ? [...weekdays, index + 1]
                            : weekdays.filter((value) => value !== index + 1),
                        )
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
            )}
            <label className="block">
              重复次数（可留空）
              <input
                aria-label="重复次数"
                type="number"
                min="1"
                max="10000"
                className={field}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>
            <label className="block">
              重复结束日（可留空）
              <input
                aria-label="重复结束日"
                type="date"
                className={field}
                value={repeatEnd}
                onChange={(e) => setRepeatEnd(e.target.value)}
              />
            </label>
            <p className="text-xs text-text-secondary">不存在的月末/闰日或夏令时跳变时间会跳过。</p>
          </>
        )}
      </fieldset>
      <fieldset className="space-y-2 rounded border border-border p-2">
        <legend>关联与参与者</legend>
        <select
          aria-label="关联速记对象"
          className={field}
          value=""
          onChange={(e) => {
            const option = relationOptions.find(
              (item) => `${item.type}:${item.id}` === e.target.value,
            );
            if (
              option &&
              !relations.some((item) => item.type === option.type && item.id === option.id)
            ) {
              setRelations([...relations, { type: option.type, id: option.id }]);
              onDirty();
            }
          }}
        >
          <option value="">关联笔记或任务…</option>
          {relationOptions.map((item) => (
            <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>
              {item.type === 'note' ? '笔记' : '任务'}：{item.name}
            </option>
          ))}
        </select>
        {relations.map((item) => (
          <div className="flex justify-between gap-2" key={`${item.type}:${item.id}`}>
            <span className="break-all">
              {relationOptions.find((option) => option.type === item.type && option.id === item.id)
                ?.name ?? `${item.type}：${item.id}`}
            </span>
            <button
              type="button"
              onClick={() => {
                setRelations(relations.filter((value) => value !== item));
                onDirty();
              }}
            >
              移除
            </button>
          </div>
        ))}
        <details>
          <summary>关联其他模块对象</summary>
          <p className="text-xs text-text-secondary">
            仅引用已有对象的标识；不创建项目、联系人或文件，不复制内容。
          </p>
          <select
            className={field}
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as typeof linkType)}
          >
            <option value="file">文件</option>
            <option value="email">邮件</option>
            <option value="project">项目</option>
            <option value="contact">联系人</option>
          </select>
          <input
            aria-label="关联对象标识"
            className={field}
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
            maxLength={128}
            placeholder="已有对象的标识"
          />
          <button
            type="button"
            disabled={!linkId.trim()}
            onClick={() => {
              if (!relations.some((item) => item.type === linkType && item.id === linkId.trim()))
                setRelations([...relations, { type: linkType, id: linkId.trim() }]);
              setLinkId('');
              onDirty();
            }}
          >
            添加关联
          </button>
        </details>
        {attendees.map((person) => (
          <div key={person.contactId} className="space-y-1 border-t border-border pt-1">
            <div className="flex justify-between">
              <span>{person.displayName}</span>
              <button
                type="button"
                onClick={() => {
                  setAttendees(attendees.filter((item) => item.contactId !== person.contactId));
                  onDirty();
                }}
              >
                移除参与者
              </button>
            </div>
            <select
              aria-label={`参与角色 ${person.displayName}`}
              className={field}
              value={person.role}
              onChange={(e) => {
                setAttendees(
                  attendees.map((item) =>
                    item.contactId === person.contactId
                      ? { ...item, role: e.target.value as typeof person.role }
                      : item,
                  ),
                );
                onDirty();
              }}
            >
              <option value="required">必需</option>
              <option value="optional">可选</option>
            </select>
            <select
              aria-label={`响应状态 ${person.displayName}`}
              className={field}
              value={person.responseStatus}
              onChange={(e) => {
                setAttendees(
                  attendees.map((item) =>
                    item.contactId === person.contactId
                      ? { ...item, responseStatus: e.target.value as typeof person.responseStatus }
                      : item,
                  ),
                );
                onDirty();
              }}
            >
              <option value="needs_action">未响应</option>
              <option value="accepted">已接受</option>
              <option value="declined">已拒绝</option>
              <option value="tentative">待定</option>
            </select>
          </div>
        ))}
        <input
          aria-label="参与者姓名"
          placeholder="参与者显示姓名"
          className={field}
          value={personName}
          onChange={(e) => setPersonName(e.target.value)}
          maxLength={200}
        />
        <input
          aria-label="参与者联系人标识"
          placeholder="已有联系人标识"
          className={field}
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          maxLength={128}
        />
        <button
          type="button"
          disabled={!personId.trim() || !personName.trim()}
          onClick={() => {
            if (!attendees.some((person) => person.contactId === personId.trim()))
              setAttendees([
                ...attendees,
                {
                  type: 'contact',
                  contactId: personId.trim(),
                  displayName: personName.trim(),
                  role: 'required',
                  responseStatus: 'needs_action',
                },
              ]);
            setPersonId('');
            setPersonName('');
            onDirty();
          }}
        >
          添加参与者引用
        </button>
        <p className="text-xs text-text-secondary">
          不会发送邀请。项目、联系人及外部文件标识由所属模块负责，本日历仅保存引用。
        </p>
      </fieldset>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded bg-primary px-3 py-2 text-white disabled:opacity-50"
          disabled={busy}
        >
          保存日程
        </button>
        <button
          type="button"
          className="rounded border border-border px-3 py-2"
          onClick={onCancel}
          disabled={busy}
        >
          取消编辑
        </button>
      </div>
    </form>
  );
}

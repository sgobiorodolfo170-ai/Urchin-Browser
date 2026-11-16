import { randomUUID, createHash } from 'node:crypto';
import {
  calendarChannels,
  calendarEventInputSchema,
  calendarBackupSchema,
  type CalendarEvent,
  type CalendarEventInput,
  type IpcReq,
} from '@urchin/ipc-contract';
import type { CalendarRepository } from './repository';

export { CalendarError } from './error';
import { CalendarError } from './error';
export { eventRange, midnight } from './time';
import { eventRange, midnight, addDays, dateInZone, reanchor, wallInstant } from './time';
import { anchorDate, occurrences } from './recurrence';
export class CalendarService {
  constructor(
    readonly repository: CalendarRepository,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    repository.initialize(timeZone);
  }
  calendars() {
    return { calendars: this.repository.calendars() };
  }
  saveCalendar(req: IpcReq<'calendar.saveCalendar'>) {
    req = calendarChannels['calendar.saveCalendar'].req.parse(req);
    return this.repository.db.transaction(() => {
      const all = this.repository.calendars(),
        previous = all.find((calendar) => calendar.calendarId === req.calendarId);
      if (!req.calendarId && all.length >= 100)
        throw new CalendarError('INVALID_ARGUMENT', '最多支持 100 个本地日历');
      if (req.calendarId && !previous) throw new CalendarError('NOT_FOUND', '日历不存在');
      if (previous && previous.version !== req.expectedVersion)
        throw new CalendarError('VERSION_CONFLICT', '日历已变化，请刷新');
      if (!req.calendar.isEnabled && (req.calendar.isDefault || previous?.isDefault))
        throw new CalendarError('INVALID_ARGUMENT', '请先指定其他默认日历再归档');
      if (previous?.isDefault && !req.calendar.isDefault)
        throw new CalendarError('INVALID_ARGUMENT', '请通过指定其他默认日历完成切换');
      const now = new Date().toISOString();
      if (req.calendar.isDefault)
        for (const calendar of all.filter(
          (calendar) => calendar.isDefault && calendar.calendarId !== req.calendarId,
        ))
          this.repository.saveCalendar({
            ...calendar,
            isDefault: false,
            version: calendar.version + 1,
            updatedAt: now,
          });
      const result = {
        ...previous,
        ...req.calendar,
        calendarId: previous?.calendarId ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        visibility: 'private' as const,
        defaultReminders: previous?.defaultReminders ?? [],
        writable: true,
      };
      this.repository.saveCalendar(result);
      return result;
    });
  }
  private validate(input: CalendarEventInput) {
    const event = calendarEventInputSchema.parse(input);
    if (
      !this.repository
        .calendars()
        .some(
          (calendar) =>
            calendar.calendarId === event.calendarId && calendar.isEnabled && calendar.writable,
        )
    )
      throw new CalendarError('NOT_FOUND', '日历不存在或不可写');
    if (event.seriesId) throw new CalendarError('INVALID_ARGUMENT', '系列 ID 由服务分配');
    if (
      event.recurrence &&
      (event.recurrence.startDate !== anchorDate(event) ||
        event.recurrence.timeZone !== event.timeZone ||
        (event.recurrence.endDate && event.recurrence.endDate < event.recurrence.startDate) ||
        (event.recurrence.frequency !== 'weekly' && event.recurrence.byWeekday.length))
    )
      throw new CalendarError(
        'INVALID_ARGUMENT',
        '重复规则须与事件起始日期、时区一致，星期筛选仅用于每周规则',
      );
    const [start, end] = eventRange(event);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new CalendarError('INVALID_ARGUMENT', '结束时间必须晚于开始时间');
    return { event, start, end };
  }
  get(eventId: string) {
    if (eventId.includes('@')) {
      const [seriesId, date] = eventId.split('@');
      const master = this.repository.get(seriesId!);
      if (!master?.recurrence || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new CalendarError('NOT_FOUND', '重复实例不存在');
      const original = occurrences(
        master,
        midnight(addDays(date, 2), master.timeZone),
        midnight(date, master.timeZone) - 86400000,
      ).find((event) => event.occurrenceDate === date);
      if (!original) throw new CalendarError('NOT_FOUND', '重复实例不存在');
      const exception = this.repository
        .exceptions(master.eventId)
        .find((item) => item.date === date);
      return {
        ...original,
        ...exception?.event,
        eventId,
        seriesId: master.eventId,
        occurrenceDate: date,
        recurrence: master.recurrence,
        version: master.version,
        deletedAt: master.deletedAt ?? exception?.deletedAt ?? null,
      };
    }
    const event = this.repository.get(eventId);
    if (!event) throw new CalendarError('NOT_FOUND', '事件不存在');
    return event;
  }
  list(req: IpcReq<'calendar.listEvents'>) {
    const start = Date.parse(req.startAt),
      end = Date.parse(req.endAt);
    if (end <= start || end - start > 366 * 86400000)
      throw new CalendarError('INVALID_ARGUMENT', '查询范围须为正且不超过 366 天');
    const ordinary = this.repository
      .range(start, end, req.includeDeleted)
      .filter((event) => !event.recurrence);
    const expanded: CalendarEvent[] = [];
    for (const master of this.repository.series(req.includeDeleted)) {
      const exceptions = this.repository.exceptions(master.eventId);
      for (const event of occurrences(master, end, start))
        if (!exceptions.some((item) => item.date === event.occurrenceDate)) expanded.push(event);
      for (const exception of exceptions) {
        try {
          expanded.push(this.get(`${master.eventId}@${exception.date}`));
        } catch (error) {
          if (!(error instanceof CalendarError) || error.code !== 'NOT_FOUND') throw error;
        }
      }
    }
    const enabled = new Set(
      this.repository
        .calendars()
        .filter((calendar) => calendar.isEnabled)
        .map((calendar) => calendar.calendarId),
    );
    const events = [...ordinary, ...expanded]
      .filter((event) => {
        const [a, b] = eventRange(event);
        return (
          a < end &&
          b > start &&
          (req.includeDeleted || !event.deletedAt) &&
          (req.calendarIds.length
            ? req.calendarIds.includes(event.calendarId)
            : enabled.has(event.calendarId))
        );
      })
      .sort((a, b) => eventRange(a)[0] - eventRange(b)[0] || a.eventId.localeCompare(b.eventId));
    return { events };
  }
  create(req: IpcReq<'calendar.createEvent'>, source: 'user' | 'ai' = 'user') {
    return this.repository.db.transaction(() => {
      const requested = calendarEventInputSchema.parse(req.event);
      const previous = this.repository.byKey(req.idempotencyKey);
      if (previous) {
        const original = calendarEventInputSchema.strip().parse(previous);
        if (JSON.stringify(original) !== JSON.stringify(requested))
          throw new CalendarError('IDEMPOTENCY_CONFLICT', '相同请求键对应不同内容');
        return previous;
      }
      const { event, start, end } = this.validate(requested);
      const now = new Date().toISOString();
      const result: CalendarEvent = {
        occurrenceDate: null,
        occurrenceIndex: null,
        ...event,
        eventId: randomUUID(),
        version: 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        source: { type: source, requestId: req.idempotencyKey },
      };
      this.repository.write(result, start, end, 'create', req.idempotencyKey);
      return result;
    });
  }
  update(req: IpcReq<'calendar.updateEvent'>) {
    if (req.eventId.includes('@')) return this.changeOccurrence(req, false);
    return this.repository.db.transaction(() => {
      const previous = this.get(req.eventId);
      this.checkVersion(previous, req.expectedVersion);
      if (previous.deletedAt) throw new CalendarError('NOT_FOUND', '事件已删除，请先恢复');
      if (previous.recurrence && req.scope !== 'series')
        throw new CalendarError('INVALID_ARGUMENT', '修改重复系列必须明确范围');
      const { event, start, end } = this.validate(req.event);
      const result = {
        ...previous,
        ...event,
        version: previous.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.repository.write(result, start, end, 'update');
      if (!result.recurrence) this.repository.clearExceptions(result.eventId);
      return result;
    });
  }
  private checkVersion(event: CalendarEvent, version: number) {
    if (event.version !== version)
      throw new CalendarError('VERSION_CONFLICT', '事件已变化，请重新读取后操作');
  }
  private changeOccurrence(
    req: IpcReq<'calendar.updateEvent'> | IpcReq<'calendar.deleteEvent'>,
    deleted: boolean,
  ): CalendarEvent {
    return this.repository.db.transaction(() => {
      const current = this.get(req.eventId),
        master = this.repository.get(current.seriesId!)!;
      this.checkVersion(master, req.expectedVersion);
      const editing = 'event' in req;
      let scope =
        req.scope ?? (!editing && !deleted ? (master.deletedAt ? 'series' : 'single') : undefined);
      if (!scope)
        throw new CalendarError('INVALID_ARGUMENT', '重复事件操作必须指定单次、此后或整个系列');
      if (editing && current.deletedAt) throw new CalendarError('NOT_FOUND', '请先恢复已删除事件');
      const now = new Date().toISOString(),
        date = current.occurrenceDate!;
      if (
        scope === 'future' &&
        occurrences(
          master,
          midnight(addDays(anchorDate(master), 366 * master.recurrence!.interval), master.timeZone),
          Number.NEGATIVE_INFINITY,
          1,
        )[0]?.occurrenceDate === date
      )
        scope = 'series';
      if (scope === 'series') {
        let result = { ...master, version: master.version + 1, updatedAt: now };
        if (editing) {
          const input = { ...req.event, seriesId: null };
          const delta =
            (Date.parse(anchorDate(input)) - Date.parse(anchorDate(current))) / 86400000;
          const moved = reanchor(input, addDays(anchorDate(master), delta));
          if (moved.recurrence)
            moved.recurrence = { ...moved.recurrence, startDate: anchorDate(moved) };
          result = { ...result, ...this.validate(moved).event };
        } else result.deletedAt = deleted ? now : null;
        const [a, b] = eventRange(result);
        this.repository.write(
          result,
          a,
          b,
          editing ? 'update-series' : deleted ? 'delete-series' : 'restore-series',
        );
        if (!result.recurrence) this.repository.clearExceptions(result.eventId);
        return result;
      }
      if (scope === 'future') {
        const beforeCount = master.recurrence?.count
          ? occurrences(master, midnight(addDays(date, 1), master.timeZone)).filter(
              (event) => event.occurrenceDate! < date,
            ).length
          : 0;
        const input = editing
          ? { ...req.event, seriesId: null }
          : calendarEventInputSchema.strip().parse(reanchor(master, date));
        const rule = input.recurrence;
        input.recurrence = rule
          ? {
              ...rule,
              startDate: anchorDate(input),
              count: editing
                ? rule.count
                : rule.count
                  ? Math.max(1, rule.count - beforeCount)
                  : null,
            }
          : null;
        const checked = this.validate(input);
        const next: CalendarEvent = {
          ...master,
          ...checked.event,
          eventId: randomUUID(),
          seriesId: null,
          occurrenceDate: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: deleted ? now : null,
          source: { type: 'user', requestId: null },
        };
        const old = {
          ...master,
          recurrence: { ...master.recurrence!, endDate: addDays(date, -1) },
          version: master.version + 1,
          updatedAt: now,
        };
        const [a, b] = eventRange(old);
        this.repository.write(old, a, b, 'split-series');
        this.repository.write(
          next,
          checked.start,
          checked.end,
          deleted ? 'delete-future' : 'update-future',
        );
        const offset = (Date.parse(anchorDate(input)) - Date.parse(date)) / 86400000;
        for (const exception of this.repository
          .exceptions(master.eventId)
          .filter((item) => item.date >= date)) {
          if (!next.recurrence) continue;
          this.repository.setException(
            next.eventId,
            addDays(exception.date, offset),
            exception.event
              ? reanchor(exception.event, addDays(anchorDate(exception.event), offset))
              : null,
            exception.deletedAt,
          );
          this.repository.clearException(master.eventId, exception.date);
        }
        return next;
      }
      const previousException = this.repository
        .exceptions(master.eventId)
        .find((item) => item.date === date);
      if (editing) {
        const input = this.validate({ ...req.event, recurrence: null, seriesId: null }).event;
        this.repository.setException(master.eventId, date, input, null);
      } else if (deleted)
        this.repository.setException(master.eventId, date, previousException?.event ?? null, now);
      else if (previousException?.event)
        this.repository.setException(master.eventId, date, previousException.event, null);
      else this.repository.clearException(master.eventId, date);
      const result = { ...master, version: master.version + 1, updatedAt: now };
      const [a, b] = eventRange(result);
      this.repository.write(
        result,
        a,
        b,
        editing ? 'update-single' : deleted ? 'delete-single' : 'restore-single',
      );
      return this.get(req.eventId);
    });
  }
  setDeleted(req: IpcReq<'calendar.deleteEvent'>, deleted: boolean) {
    if (req.eventId.includes('@')) return this.changeOccurrence(req, deleted);
    return this.repository.db.transaction(() => {
      const previous = this.get(req.eventId);
      this.checkVersion(previous, req.expectedVersion);
      if (deleted && previous.recurrence && req.scope !== 'series')
        throw new CalendarError('INVALID_ARGUMENT', '删除重复系列必须明确范围');
      const now = new Date().toISOString();
      const result = {
        ...previous,
        deletedAt: deleted ? now : null,
        updatedAt: now,
        version: previous.version + 1,
      };
      const [start, end] = eventRange(result);
      this.repository.write(result, start, end, deleted ? 'delete' : 'restore');
      return result;
    });
  }
  conflicts(req: IpcReq<'calendar.checkConflicts'>) {
    const { start, end } = this.validate({ ...req.event, seriesId: null });
    const exclude = req.excludeEventId?.split('@')[0];
    return {
      events: this.list(
        calendarChannels['calendar.listEvents'].req.parse({
          startAt: new Date(start).toISOString(),
          endAt: new Date(end).toISOString(),
        }),
      ).events.filter(
        (event) =>
          event.eventId !== exclude && event.seriesId !== exclude && event.status !== 'cancelled',
      ),
    };
  }
  freeSlots(req: IpcReq<'calendar.findFreeSlots'>) {
    const { events } = this.list(req);
    const start = Date.parse(req.startAt),
      end = Date.parse(req.endAt),
      duration = req.durationMinutes * 60000,
      buffer = req.bufferMinutes * 60000;
    if (req.workingHours && req.workingHours.endMinute <= req.workingHours.startMinute)
      throw new CalendarError('INVALID_ARGUMENT', '工作结束时间须晚于开始时间');
    const busy = events
      .filter(
        (event) =>
          event.status !== 'cancelled' &&
          !event.deletedAt &&
          !req.excludeEventIds.includes(event.eventId) &&
          !req.excludeEventIds.includes(event.seriesId ?? ''),
      )
      .map(eventRange)
      .sort((a, b) => a[0] - b[0]);
    const windows: [number, number][] = [];
    if (req.workingHours) {
      for (
        let date = dateInZone(start, req.timeZone);
        date <= dateInZone(end, req.timeZone);
        date = addDays(date, 1)
      ) {
        const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        if (!req.workingHours.weekdays.includes(weekday)) continue;
        const a = wallInstant(
          date,
          Math.floor(req.workingHours.startMinute / 60),
          req.workingHours.startMinute % 60,
          req.timeZone,
        );
        const b =
          req.workingHours.endMinute === 1440
            ? midnight(addDays(date, 1), req.timeZone)
            : wallInstant(
                date,
                Math.floor(req.workingHours.endMinute / 60),
                req.workingHours.endMinute % 60,
                req.timeZone,
              );
        if (a < end && b > start) windows.push([Math.max(start, a), Math.min(end, b)]);
      }
    } else windows.push([start, end]);
    const slots: { startAt: string; endAt: string }[] = [];
    for (const [from, to] of windows) {
      let cursor = from;
      for (const [a, b] of [...busy, [to + buffer, to] as [number, number]]) {
        if (b + buffer <= from) continue;
        if (cursor + duration <= Math.min(a - buffer, to) && slots.length < req.limit)
          slots.push({
            startAt: new Date(cursor).toISOString(),
            endAt: new Date(cursor + duration).toISOString(),
          });
        cursor = Math.max(cursor, b + buffer);
        if (cursor >= to || slots.length >= req.limit) break;
      }
      if (slots.length >= req.limit) break;
    }
    return { slots };
  }
  exportBackup() {
    const requests = this.repository.db
      .query<{ key: string; payload: string }>(
        'SELECT key,payload FROM calendar_requests ORDER BY key',
      )
      .map((row) => ({ key: row.key, event: JSON.parse(row.payload) as CalendarEvent }));
    const audit = this.repository.db.query<{
      id: string;
      event_id: string;
      action: string;
      at: string;
      version: number;
      actor: string;
    }>('SELECT * FROM calendar_audit_log ORDER BY id');
    const data = JSON.stringify(
      calendarBackupSchema.parse({
        format: 'urchin-calendar',
        version: 1,
        calendars: this.repository.calendars(),
        events: this.repository.allEvents(),
        exceptions: this.repository.exceptions(),
        deliveries: this.repository.deliveries(),
        requests,
        audit,
      }),
    );
    const previous =
      this.repository.db.query<{ payload: string }>(
        'SELECT payload FROM calendar_restore_snapshots ORDER BY id DESC LIMIT 1',
      )[0]?.payload ?? null;
    return { data, digest: createHash('sha256').update(data).digest('hex'), previous };
  }
  importBackup(req: IpcReq<'calendar.importBackup'>) {
    const backup = calendarBackupSchema.parse(JSON.parse(req.data));
    const calendars = new Map(backup.calendars.map((calendar) => [calendar.calendarId, calendar]));
    const events = new Map(backup.events.map((event) => [event.eventId, event]));
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      calendars.size !== backup.calendars.length ||
      events.size !== backup.events.length ||
      !calendars.has('local-default') ||
      backup.calendars.filter((calendar) => calendar.isDefault && calendar.isEnabled).length !==
        1 ||
      backup.calendars.filter((calendar) => calendar.isDefault).length !== 1 ||
      !unique(backup.exceptions.map((item) => `${item.seriesId}@${item.date}`)) ||
      !unique(backup.requests.map((item) => item.key)) ||
      !unique(backup.audit.map((item) => item.id)) ||
      !unique(backup.deliveries.map((item) => item.id))
    )
      throw new CalendarError('INVALID_ARGUMENT', '备份存在重复标识或默认日历不一致');
    for (const event of backup.events) {
      const [a, b] = eventRange(event);
      if (
        !calendars.has(event.calendarId) ||
        event.seriesId ||
        event.occurrenceDate ||
        b <= a ||
        (event.recurrence &&
          (event.recurrence.startDate !== anchorDate(event) ||
            event.recurrence.timeZone !== event.timeZone))
      )
        throw new CalendarError('INVALID_ARGUMENT', '备份事件不一致');
    }
    for (const exception of backup.exceptions) {
      if (!events.get(exception.seriesId)?.recurrence)
        throw new CalendarError('INVALID_ARGUMENT', '备份例外没有对应系列');
      if (exception.event) {
        const [a, b] = eventRange(exception.event);
        if (
          b <= a ||
          !calendars.has(exception.event.calendarId) ||
          exception.event.recurrence ||
          exception.event.seriesId
        )
          throw new CalendarError('INVALID_ARGUMENT', '备份例外不一致');
      }
    }
    if (
      backup.requests.some((item) => !events.has(item.event.eventId)) ||
      backup.audit.some(
        (item) => !events.has(item.event_id) || item.version > events.get(item.event_id)!.version,
      )
    )
      throw new CalendarError('INVALID_ARGUMENT', '备份追溯数据不一致');
    return this.repository.db.transaction(() => {
      const before = this.exportBackup();
      const currentEvents = new Map(
        this.repository.allEvents().map((event) => [event.eventId, event.version]),
      );
      const currentCalendars = new Map(
        this.repository.calendars().map((calendar) => [calendar.calendarId, calendar.version]),
      );
      const restoredEvents: CalendarEvent[] = [];
      if (before.digest !== req.expectedDigest)
        throw new CalendarError('VERSION_CONFLICT', '恢复预览后日历数据已变化，请重新确认');
      this.repository.db.run(
        'INSERT INTO calendar_restore_snapshots(id,payload) VALUES (?,?)',
        `${new Date().toISOString()}-${randomUUID()}`,
        before.data,
      );
      this.repository.db.run(
        'DELETE FROM calendar_restore_snapshots WHERE id NOT IN (SELECT id FROM calendar_restore_snapshots ORDER BY id DESC LIMIT 3)',
      );
      for (const table of [
        'calendar_event_exceptions',
        'calendar_requests',
        'calendar_audit_log',
        'calendar_reminder_deliveries',
        'calendar_events',
        'calendar_calendars',
      ])
        this.repository.db.run(`DELETE FROM ${table}`);
      for (const calendar of backup.calendars)
        this.repository.saveCalendar({
          ...calendar,
          version: Math.max(calendar.version, currentCalendars.get(calendar.calendarId) ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
      for (const event of backup.events) {
        const restored = {
          ...event,
          version: Math.max(event.version, currentEvents.get(event.eventId) ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        restoredEvents.push(restored);
        const [a, b] = eventRange(event);
        this.repository.db.run(
          'INSERT INTO calendar_events(id,calendar_id,start_at,end_at,version,deleted_at,payload,idempotency_key) VALUES (?,?,?,?,?,?,?,NULL)',
          event.eventId,
          event.calendarId,
          a,
          b,
          restored.version,
          event.deletedAt,
          JSON.stringify(restored),
        );
      }
      for (const exception of backup.exceptions)
        this.repository.setException(
          exception.seriesId,
          exception.date,
          exception.event,
          exception.deletedAt,
        );
      for (const request of backup.requests)
        this.repository.db.run(
          'INSERT INTO calendar_requests(key,payload) VALUES (?,?)',
          request.key,
          JSON.stringify(request.event),
        );
      for (const audit of backup.audit)
        this.repository.db.run(
          'INSERT INTO calendar_audit_log(id,event_id,action,at,version,actor) VALUES (?,?,?,?,?,?)',
          audit.id,
          audit.event_id,
          audit.action,
          audit.at,
          audit.version,
          audit.actor,
        );
      for (const delivery of backup.deliveries) this.repository.saveDelivery(delivery);
      for (const event of restoredEvents)
        this.repository.db.run(
          'INSERT INTO calendar_audit_log(id,event_id,action,at,version,actor) VALUES (?,?,?,?,?,?)',
          `${event.eventId}:${event.version}`,
          event.eventId,
          'restore-backup',
          event.updatedAt,
          event.version,
          'local-user',
        );
      return { restored: backup.events.length };
    });
  }
  reminders() {
    return { reminders: this.repository.pendingDeliveries() };
  }
  dismissReminder(id: string) {
    const item = this.repository.deliveries().find((delivery) => delivery.id === id);
    if (item) this.repository.saveDelivery({ ...item, dismissed: true });
    return { ok: Boolean(item) };
  }
  deliverReminders(
    now: number,
    notify: (title: string, method: 'in_app' | 'notification') => void,
  ) {
    const sent = new Set<string>();
    const req = calendarChannels['calendar.listEvents'].req.parse({
      startAt: new Date(now - 86400000).toISOString(),
      endAt: new Date(now + 29 * 86400000).toISOString(),
    });
    const events = this.list(req).events.filter(
      (event) => !event.deletedAt && event.status !== 'cancelled',
    );
    let delivered = 0;
    for (const event of events)
      for (const reminder of event.reminders) {
        const start = eventRange(event)[0],
          due = start - reminder.minutesBefore * 60000;
        const id = createHash('sha256')
          .update(`${event.eventId}:${start}:${reminder.method}:${reminder.minutesBefore}`)
          .digest('hex');
        if (due > now || due < now - 86400000 || sent.has(id) || this.repository.hasDelivery(id))
          continue;
        // 先持久记录，再触发本机通知；崩溃恢复保持至多一次，不重复惊扰用户。
        this.repository.saveDelivery({
          id,
          eventId: event.eventId,
          title: event.title,
          dueAt: new Date(due).toISOString(),
          dismissed: false,
        });
        sent.add(id);
        delivered++;
        try {
          notify(event.title, reminder.method);
        } catch {
          /* 通知失败仍可在持久提醒列表查看。 */
        }
      }
    return delivered;
  }
}

/** 可供未来工具宿主测试的日历适配；不连接或设计 AI 助手。 */
export function createCalendarOperations(service: CalendarService) {
  return {
    'calendar.saveCalendar': (req: IpcReq<'calendar.saveCalendar'>) => service.saveCalendar(req),
    'calendar.exportBackup': () => service.exportBackup(),
    'calendar.importBackup': (req: IpcReq<'calendar.importBackup'>) => service.importBackup(req),
    'calendar.listReminders': () => service.reminders(),
    'calendar.dismissReminder': (req: IpcReq<'calendar.dismissReminder'>) =>
      service.dismissReminder(req.id),
    'calendar.listCalendars': () => service.calendars(),
    'calendar.listEvents': (req: IpcReq<'calendar.listEvents'>) => service.list(req),
    'calendar.getEvent': (req: IpcReq<'calendar.getEvent'>) => service.get(req.eventId),
    'calendar.createEvent': (req: IpcReq<'calendar.createEvent'>) => service.create(req),
    'calendar.updateEvent': (req: IpcReq<'calendar.updateEvent'>) => service.update(req),
    'calendar.deleteEvent': (req: IpcReq<'calendar.deleteEvent'>) => service.setDeleted(req, true),
    'calendar.restoreEvent': (req: IpcReq<'calendar.restoreEvent'>) =>
      service.setDeleted(req, false),
    'calendar.checkConflicts': (req: IpcReq<'calendar.checkConflicts'>) => service.conflicts(req),
    'calendar.findFreeSlots': (req: IpcReq<'calendar.findFreeSlots'>) => service.freeSlots(req),
  } satisfies { [K in keyof typeof calendarChannels]: (req: IpcReq<K>) => unknown };
}

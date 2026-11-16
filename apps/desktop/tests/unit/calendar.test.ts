// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { calendarContextSchema } from '@urchin/ipc-contract';
import { wallToIso } from '../../src/renderer/calendar/EventEditor';
import {
  calendarChannels,
  calendarEventInputSchema,
  calendarToolContracts,
} from '@urchin/ipc-contract';
import { CalendarRepository, type CalendarDatabase } from '../../src/main/calendar/repository';
import {
  CalendarService,
  createCalendarOperations,
  eventRange,
  midnight,
} from '../../src/main/calendar/service';
import { MIGRATIONS_MAIN } from '../../src/main/storage/migrations';
import { registerCalendarHandlers } from '../../src/main/calendar/register-handlers';

describe('M28 calendar service / SQLite / prepared tools', () => {
  const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync;
  let service: CalendarService;
  let store: CalendarDatabase;
  const input = () =>
    calendarEventInputSchema.parse({
      title: '会议',
      startAt: '2026-11-16T09:00:00+08:00',
      endAt: '2026-11-16T10:00:00+08:00',
      timeZone: 'Asia/Shanghai',
    });
  const create = (key = 'request-1') => service.create({ event: input(), idempotencyKey: key });
  const range = () =>
    calendarChannels['calendar.listEvents'].req.parse({
      startAt: '2026-11-16T00:00:00+08:00',
      endAt: '2026-11-17T00:00:00+08:00',
    });
  beforeEach(() => {
    db = new sqlite.DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of MIGRATIONS_MAIN) db.exec(migration.up);
    store = {
      query: <T>(sql: string, ...params: readonly unknown[]) =>
        db.prepare(sql).all(...(params as (string | number | null)[])) as T[],
      run: (sql, ...params) => {
        db.prepare(sql).run(...(params as (string | number | null)[]));
      },
      transaction: <T>(fn: () => T) => {
        db.exec('BEGIN');
        try {
          const result = fn();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    service = new CalendarService(new CalendarRepository(store), 'Asia/Shanghai');
  });
  afterEach(() => db.close());
  it('creates a unique default calendar and reloads persisted events', () => {
    const event = create();
    const reloaded = new CalendarService(new CalendarRepository(store));
    expect(reloaded.calendars().calendars).toHaveLength(1);
    expect(reloaded.get(event.eventId)).toEqual(event);
  });
  it('deduplicates creation, rejects changed content and keeps an audit trail', () => {
    const event = create();
    expect(create().eventId).toBe(event.eventId);
    expect(() =>
      service.create({ event: { ...input(), title: '不同请求' }, idempotencyKey: 'request-1' }),
    ).toThrow('IDEMPOTENCY_CONFLICT');
    expect(store.query('SELECT * FROM calendar_audit_log')).toHaveLength(1);
    service.update({
      eventId: event.eventId,
      expectedVersion: 1,
      event: { ...input(), title: '已编辑' },
    });
    expect(create()).toEqual(event);
  });
  it('checks versions, updates, soft deletes and restores', () => {
    const event = create();
    const updated = service.update({
      eventId: event.eventId,
      expectedVersion: 1,
      event: { ...input(), title: '更新' },
    });
    expect(updated.version).toBe(2);
    expect(() =>
      service.update({ eventId: event.eventId, expectedVersion: 1, event: input() }),
    ).toThrow('VERSION_CONFLICT');
    const deleted = service.setDeleted({ eventId: event.eventId, expectedVersion: 2 }, true);
    expect(service.list(range()).events).toHaveLength(0);
    expect(service.list({ ...range(), includeDeleted: true }).events).toHaveLength(1);
    service.setDeleted({ eventId: event.eventId, expectedVersion: deleted.version }, false);
    expect(service.list(range()).events).toHaveLength(1);
    expect(store.query('SELECT * FROM calendar_audit_log')).toHaveLength(4);
  });
  it('uses half-open conflict intervals and ignores cancelled events', () => {
    const event = create();
    expect(service.conflicts({ event: input() }).events).toHaveLength(1);
    expect(
      service.conflicts({ event: input(), excludeEventId: event.eventId }).events,
    ).toHaveLength(0);
    const adjacent = { ...input(), startAt: input().endAt, endAt: '2026-11-16T11:00:00+08:00' };
    expect(service.conflicts({ event: adjacent }).events).toHaveLength(0);
    service.update({
      eventId: event.eventId,
      expectedVersion: 1,
      event: { ...input(), status: 'cancelled' },
    });
    expect(service.conflicts({ event: input() }).events).toHaveLength(0);
  });
  it('rejects invalid ranges, dates, zones and inconsistent recurrence anchors', () => {
    expect(() =>
      service.create({ event: { ...input(), endAt: input().startAt }, idempotencyKey: 'bad' }),
    ).toThrow('INVALID_ARGUMENT');
    expect(() => calendarEventInputSchema.parse({ ...input(), timeZone: 'Unknown/Bad' })).toThrow();
    expect(() => calendarEventInputSchema.parse({ ...input(), startDate: '2026-02-30' })).toThrow();
    expect(() =>
      service.create({
        event: {
          ...input(),
          recurrence: {
            frequency: 'daily',
            interval: 1,
            startDate: '2026-11-17',
            endDate: null,
            count: null,
            timeZone: 'Asia/Shanghai',
            byWeekday: [],
          },
        },
        idempotencyKey: 'repeat',
      }),
    ).toThrow('INVALID_ARGUMENT');
    expect(() => service.list({ ...range(), endAt: range().startAt })).toThrow('INVALID_ARGUMENT');
    expect(() => service.get('missing')).toThrow('NOT_FOUND');
    expect(() =>
      service.create({ event: { ...input(), calendarId: 'unknown' }, idempotencyKey: 'unknown' }),
    ).toThrow('NOT_FOUND');
  });
  it('resolves all-day DST boundaries with 23 and 25 hour days', () => {
    expect(wallToIso('2026-11-16T09:00', 'Asia/Shanghai')).toBe('2026-11-16T01:00:00.000Z');
    expect(() => wallToIso('2026-03-08T02:30', 'America/New_York')).toThrow();
    const spring = calendarEventInputSchema.parse({
      title: '全天',
      allDay: true,
      startDate: '2026-03-08',
      endDateExclusive: '2026-03-09',
      timeZone: 'America/New_York',
    });
    const [a, b] = eventRange(spring);
    expect(b - a).toBe(23 * 3600000);
    expect(midnight('2026-11-02', spring.timeZone) - midnight('2026-11-01', spring.timeZone)).toBe(
      25 * 3600000,
    );
    const created = service.create({ event: spring, idempotencyKey: 'all-day' });
    expect(created.startAt).toBeNull();
    expect(created.endDateExclusive).toBe('2026-03-09');
  });
  it('rolls back event writes when audit insertion fails', () => {
    db.exec(
      "CREATE TRIGGER reject_calendar_audit BEFORE INSERT ON calendar_audit_log BEGIN SELECT RAISE(ABORT, 'test fault'); END",
    );
    expect(() => create()).toThrow('test fault');
    expect(store.query('SELECT * FROM calendar_events')).toHaveLength(0);
  });
  it('returns free slots with a buffer and excludes occupied time', () => {
    create();
    const req = calendarChannels['calendar.findFreeSlots'].req.parse({
      ...range(),
      durationMinutes: 60,
      bufferMinutes: 15,
    });
    const result = service.freeSlots(req);
    expect(result.slots).toHaveLength(2);
    for (const slot of result.slots)
      expect(service.conflicts({ event: { ...input(), ...slot } }).events).toHaveLength(0);
  });
  it('validates all prepared tool contracts through a mock host without AI registration', () => {
    const operations = createCalendarOperations(service);
    const host = <K extends keyof typeof calendarChannels>(channel: K, raw: unknown) => {
      const schema = calendarChannels[channel];
      const req = schema.req.parse(raw);
      const operation = operations[channel] as (value: typeof req) => unknown;
      return schema.res.parse(operation(req));
    };
    expect(Object.keys(calendarToolContracts)).toHaveLength(8);
    expect(
      calendarContextSchema.parse({
        today: '2026-11-16',
        timeZone: 'Asia/Shanghai',
        calendarIds: ['local-default'],
        selectedEvent: null,
        range: null,
        capabilities: { recurrenceExecution: false, reminderDelivery: false, externalSync: false },
      }).timeZone,
    ).toBe('Asia/Shanghai');
    host('calendar.listCalendars', {});
    const event = host('calendar.createEvent', {
      event: input(),
      idempotencyKey: 'mock',
    }) as ReturnType<typeof create>;
    host('calendar.getEvent', { eventId: event.eventId });
    host('calendar.listEvents', range());
    host('calendar.checkConflicts', { event: input() });
    host('calendar.findFreeSlots', { ...range(), durationMinutes: 30 });
    host('calendar.updateEvent', { eventId: event.eventId, expectedVersion: 1, event: input() });
    host('calendar.deleteEvent', { eventId: event.eventId, expectedVersion: 2 });
    expect(() =>
      host('calendar.createEvent', { ownerId: 'other', event: input(), idempotencyKey: 'no' }),
    ).toThrow();
  });
  const repeating = (frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'daily', count = 3) =>
    service.create({
      event: {
        ...input(),
        recurrence: {
          frequency,
          interval: 1,
          startDate: '2026-11-16',
          endDate: null,
          count,
          timeZone: 'Asia/Shanghai',
          byWeekday: [],
        },
      },
      idempotencyKey: 'recurring',
    });
  const week = () => ({ ...range(), endAt: '2026-11-23T00:00:00+08:00' });
  it('manages multiple calendars, defaults, versions, archive and explicit filters', () => {
    const initial = service.calendars().calendars[0]!;
    const other = service.saveCalendar({
      calendar: {
        name: '工作',
        color: '#112233',
        timeZone: 'Asia/Shanghai',
        isEnabled: true,
        isDefault: true,
      },
    });
    expect(service.calendars().calendars.filter((calendar) => calendar.isDefault)).toHaveLength(1);
    expect(() =>
      service.saveCalendar({
        calendarId: initial.calendarId,
        expectedVersion: 1,
        calendar: {
          name: '旧修改',
          color: initial.color,
          timeZone: initial.timeZone,
          isEnabled: true,
          isDefault: true,
        },
      }),
    ).toThrow('VERSION_CONFLICT');
    const fresh = service
      .calendars()
      .calendars.find((calendar) => calendar.calendarId === initial.calendarId)!;
    service.saveCalendar({
      calendarId: fresh.calendarId,
      expectedVersion: fresh.version,
      calendar: {
        name: fresh.name,
        color: fresh.color,
        timeZone: fresh.timeZone,
        isDefault: false,
        isEnabled: false,
      },
    });
    expect(() => create()).toThrow('NOT_FOUND');
    const event = service.create({
      event: { ...input(), calendarId: other.calendarId },
      idempotencyKey: 'other',
    });
    expect(service.list({ ...range(), calendarIds: [other.calendarId] }).events[0]?.eventId).toBe(
      event.eventId,
    );
    expect(() =>
      service.saveCalendar({
        calendarId: other.calendarId,
        expectedVersion: other.version,
        calendar: {
          name: other.name,
          color: other.color,
          timeZone: other.timeZone,
          isEnabled: false,
          isDefault: true,
        },
      }),
    ).toThrow('INVALID_ARGUMENT');
  });
  it('expands recurring instances and supports single edits, delete, restore and stale versions', () => {
    const master = repeating();
    let instances = service.list(week()).events;
    expect(instances.map((event) => event.occurrenceDate)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]);
    const original = instances[1]!;
    service.update({
      eventId: original.eventId,
      expectedVersion: original.version,
      scope: 'single',
      event: { ...calendarEventInputSchema.strip().parse(original), title: '单次变更' },
    });
    instances = service.list(week()).events;
    expect(instances.map((event) => event.title)).toEqual(['会议', '单次变更', '会议']);
    expect(() =>
      service.update({
        eventId: instances[0]!.eventId,
        expectedVersion: 1,
        scope: 'single',
        event: input(),
      }),
    ).toThrow('VERSION_CONFLICT');
    const removed = service.setDeleted(
      { eventId: instances[0]!.eventId, expectedVersion: 2, scope: 'single' },
      true,
    );
    expect(service.list(week()).events).toHaveLength(2);
    expect(service.list({ ...week(), includeDeleted: true }).events).toHaveLength(3);
    service.setDeleted({ eventId: removed.eventId, expectedVersion: removed.version }, false);
    expect(service.list(week()).events).toHaveLength(3);
    expect(service.repository.allEvents()).toHaveLength(1);
    expect(service.get(master.eventId).version).toBe(4);
    expect(() => service.setDeleted({ eventId: master.eventId, expectedVersion: 4 }, true)).toThrow(
      'INVALID_ARGUMENT',
    );
  });
  it('splits this-and-future edits while preserving prior history and remaining count', () => {
    repeating();
    const instance = service.list(week()).events[1]!;
    const next = service.update({
      eventId: instance.eventId,
      expectedVersion: 1,
      scope: 'future',
      event: {
        ...calendarEventInputSchema.strip().parse(instance),
        title: '未来安排',
        recurrence: { ...instance.recurrence!, count: 2 },
      },
    });
    expect(next.recurrence?.count).toBe(2);
    expect(service.list(week()).events.map((event) => event.title)).toEqual([
      '会议',
      '未来安排',
      '未来安排',
    ]);
    expect(service.repository.allEvents()).toHaveLength(2);
  });
  it('retains the deleted future series for recovery and applies whole-series changes', () => {
    repeating();
    const instance = service.list(week()).events[1]!;
    const deleted = service.setDeleted(
      { eventId: instance.eventId, expectedVersion: 1, scope: 'future' },
      true,
    );
    expect(service.list(week()).events).toHaveLength(1);
    expect(service.list({ ...week(), includeDeleted: true }).events).toHaveLength(3);
    service.setDeleted({ eventId: deleted.eventId, expectedVersion: deleted.version }, false);
    const future = service.list(week()).events[2]!;
    service.update({
      eventId: future.eventId,
      expectedVersion: future.version,
      scope: 'series',
      event: { ...calendarEventInputSchema.strip().parse(future), title: '系列修改' },
    });
    expect(service.list(week()).events.map((event) => event.title)).toEqual([
      '会议',
      '系列修改',
      '系列修改',
    ]);
  });
  it('handles monthly ends, leap years, weekly intervals and DST wall-clock recurrence', () => {
    const make = (
      startAt: string,
      endAt: string,
      frequency: 'monthly' | 'yearly' | 'weekly' | 'daily',
      count: number,
      timeZone = 'UTC',
      byWeekday: number[] = [],
      interval = 1,
    ) =>
      service.create({
        event: {
          ...input(),
          startAt,
          endAt,
          timeZone,
          recurrence: {
            frequency,
            count,
            interval,
            startDate: startAt.slice(0, 10),
            endDate: null,
            timeZone,
            byWeekday,
          },
        },
        idempotencyKey: startAt,
      });
    const monthly = make('2026-01-31T09:00:00Z', '2026-01-31T10:00:00Z', 'monthly', 3);
    expect(
      service
        .list({ ...range(), startAt: '2026-01-01T00:00:00Z', endAt: '2026-06-01T00:00:00Z' })
        .events.filter((event) => event.seriesId === monthly.eventId)
        .map((event) => event.occurrenceDate),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    const yearly = make('2024-02-29T09:00:00Z', '2024-02-29T10:00:00Z', 'yearly', 3);
    expect(service.get(`${yearly.eventId}@2028-02-29`).startAt).toBe('2028-02-29T09:00:00.000Z');
    expect(() => service.get(`${yearly.eventId}@2027-02-28`)).toThrow('NOT_FOUND');
    const weekly = make(
      '2026-11-16T09:00:00Z',
      '2026-11-16T10:00:00Z',
      'weekly',
      4,
      'UTC',
      [1, 3],
      2,
    );
    expect(
      service
        .list({ ...range(), endAt: '2026-12-05T00:00:00Z' })
        .events.filter((event) => event.seriesId === weekly.eventId)
        .map((event) => event.occurrenceDate),
    ).toEqual(['2026-11-16', '2026-11-18', '2026-11-30', '2026-12-02']);
    const dst = make(
      '2026-03-07T09:00:00-05:00',
      '2026-03-07T10:00:00-05:00',
      'daily',
      3,
      'America/New_York',
    );
    expect(service.get(`${dst.eventId}@2026-03-08`).startAt).toBe('2026-03-08T13:00:00.000Z');
    const gap = make(
      '2026-03-07T02:30:00-05:00',
      '2026-03-07T03:30:00-05:00',
      'daily',
      3,
      'America/New_York',
    );
    expect(() => service.get(`${gap.eventId}@2026-03-08`)).toThrow('NOT_FOUND');
    expect(service.get(`${gap.eventId}@2026-03-10`).occurrenceDate).toBe('2026-03-10');
  });
  it('filters working weekdays, buffers, calendars and excluded events in free-slot queries', () => {
    const event = create();
    const req = calendarChannels['calendar.findFreeSlots'].req.parse({
      ...range(),
      durationMinutes: 60,
      bufferMinutes: 15,
      timeZone: 'Asia/Shanghai',
      workingHours: { startMinute: 540, endMinute: 1080, weekdays: [1, 2, 3, 4, 5] },
    });
    expect(service.freeSlots(req).slots[0]?.startAt).toBe('2026-11-16T02:15:00.000Z');
    expect(service.freeSlots({ ...req, excludeEventIds: [event.eventId] }).slots[0]?.startAt).toBe(
      '2026-11-16T01:00:00.000Z',
    );
    expect(
      service.freeSlots({ ...req, workingHours: { ...req.workingHours!, weekdays: [7] } }).slots,
    ).toHaveLength(0);
  });
  it('persists and deduplicates reminders across edits, restarts, reschedule and cancellation', () => {
    const event = service.create({
      event: { ...input(), reminders: [{ method: 'in_app', minutesBefore: 0 }] },
      idempotencyKey: 'reminder',
    });
    const now = Date.parse(event.startAt!);
    const messages: string[] = [];
    expect(
      service.deliverReminders(now, (title) => {
        messages.push(title);
      }),
    ).toBe(1);
    service.update({
      eventId: event.eventId,
      expectedVersion: 1,
      event: { ...calendarEventInputSchema.strip().parse(event), title: '改标题' },
    });
    expect(
      new CalendarService(new CalendarRepository(store)).deliverReminders(now, () => undefined),
    ).toBe(0);
    const moved = service.update({
      eventId: event.eventId,
      expectedVersion: 2,
      event: {
        ...calendarEventInputSchema.strip().parse(event),
        startAt: '2026-11-16T11:00:00+08:00',
        endAt: '2026-11-16T12:00:00+08:00',
      },
    });
    expect(
      service.deliverReminders(now + 2 * 3600000, () => {
        throw new Error('OS unavailable');
      }),
    ).toBe(1);
    expect(service.reminders().reminders).toHaveLength(2);
    const item = service.reminders().reminders[0]!;
    service.dismissReminder(item.id);
    expect(service.reminders().reminders).toHaveLength(1);
    service.update({
      eventId: event.eventId,
      expectedVersion: moved.version,
      event: {
        ...calendarEventInputSchema.strip().parse(moved),
        status: 'cancelled',
        startAt: '2026-11-16T13:00:00+08:00',
        endAt: '2026-11-16T14:00:00+08:00',
      },
    });
    expect(service.deliverReminders(now + 4 * 3600000, () => undefined)).toBe(0);
    expect(messages).toEqual(['会议']);
  });
  it('restores complete backups atomically, keeps undo snapshots and invalidates stale editors', () => {
    const event = create();
    repeating();
    const original = service.exportBackup();
    service.update({
      eventId: event.eventId,
      expectedVersion: 1,
      event: { ...input(), title: '恢复前' },
    });
    expect(() =>
      service.importBackup({ data: original.data, expectedDigest: original.digest }),
    ).toThrow('VERSION_CONFLICT');
    const current = service.exportBackup();
    expect(
      service.importBackup({ data: original.data, expectedDigest: current.digest }).restored,
    ).toBe(2);
    expect(service.get(event.eventId).title).toBe('会议');
    expect(service.get(event.eventId).version).toBe(3);
    expect(() =>
      service.update({ eventId: event.eventId, expectedVersion: 1, event: input() }),
    ).toThrow('VERSION_CONFLICT');
    expect(service.exportBackup().previous).toBe(current.data);
    const restored = service.exportBackup();
    service.importBackup({ data: restored.previous!, expectedDigest: restored.digest });
    expect(service.get(event.eventId).title).toBe('恢复前');
    const malformed = JSON.parse(original.data) as { calendars: unknown[] };
    malformed.calendars = [];
    expect(() =>
      service.importBackup({
        data: JSON.stringify(malformed),
        expectedDigest: service.exportBackup().digest,
      }),
    ).toThrow('INVALID_ARGUMENT');
    expect(service.get(event.eventId).title).toBe('恢复前');
  });
  it('guards every IPC operation and sanitizes database errors', async () => {
    const handlers = new Map<
      string,
      (event: { sender: unknown }, req: unknown) => Promise<unknown>
    >();
    const trusted = {};
    registerCalendarHandlers(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      store,
      (sender) => sender === trusted,
    );
    expect(handlers.size).toBe(14);
    for (const [channel, req] of [
      ['calendar.listCalendars', {}],
      [
        'calendar.saveCalendar',
        {
          calendar: {
            name: 'a',
            color: '#112233',
            timeZone: 'UTC',
            isEnabled: true,
            isDefault: false,
          },
        },
      ],
      ['calendar.exportBackup', {}],
      ['calendar.importBackup', { data: '{}', expectedDigest: 'x' }],
      ['calendar.listReminders', {}],
      ['calendar.dismissReminder', { id: 'x' }],
      ['calendar.listEvents', range()],
      ['calendar.getEvent', { eventId: 'missing' }],
      ['calendar.createEvent', { event: input(), idempotencyKey: 'ipc' }],
      ['calendar.updateEvent', { eventId: 'missing', expectedVersion: 1, event: input() }],
      ['calendar.deleteEvent', { eventId: 'missing', expectedVersion: 1 }],
      ['calendar.restoreEvent', { eventId: 'missing', expectedVersion: 1 }],
      ['calendar.checkConflicts', { event: input() }],
      ['calendar.findFreeSlots', { ...range(), durationMinutes: 30 }],
    ] as const) {
      expect(await handlers.get(channel)!({ sender: {} }, req)).toMatchObject({
        code: 'PERMISSION',
      });
    }
    expect(await handlers.get('calendar.listCalendars')!({ sender: trusted }, {})).toMatchObject({
      calendars: [expect.objectContaining({ isDefault: true })],
    });
    db.exec(
      "CREATE TRIGGER reject_calendar_audit BEFORE INSERT ON calendar_audit_log BEGIN SELECT RAISE(ABORT, 'private database detail'); END",
    );
    expect(
      await handlers.get('calendar.createEvent')!(
        { sender: trusted },
        { event: input(), idempotencyKey: 'fault' },
      ),
    ).toMatchObject({ code: 'INTERNAL', message: '日历操作失败，请重试' });
  });
});

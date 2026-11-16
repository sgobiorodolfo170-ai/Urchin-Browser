import {
  calendarEventSchema,
  calendarSchema,
  calendarExceptionSchema,
  calendarDeliverySchema,
  type CalendarEvent,
  type Calendar,
} from '@urchin/ipc-contract';
import type { DatabaseFacade } from '../storage/types';

export type CalendarDatabase = Pick<DatabaseFacade, 'query' | 'run'> & {
  transaction<T>(fn: () => T): T;
};
export class CalendarRepository {
  constructor(readonly db: CalendarDatabase) {}
  calendars() {
    return this.db
      .query<{ payload: string }>('SELECT payload FROM calendar_calendars ORDER BY id')
      .map((row) => calendarSchema.parse(JSON.parse(row.payload)));
  }
  saveCalendar(calendar: Calendar) {
    this.db.run(
      'INSERT INTO calendar_calendars(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      calendar.calendarId,
      JSON.stringify(calendar),
    );
  }
  allEvents() {
    return this.db
      .query<{ payload: string }>('SELECT payload FROM calendar_events ORDER BY id')
      .map((row) => calendarEventSchema.parse(JSON.parse(row.payload)));
  }
  series(includeDeleted: boolean) {
    return this.db
      .query<{ payload: string }>(
        `SELECT payload FROM calendar_events WHERE json_extract(payload,'$.recurrence') IS NOT NULL ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
      )
      .map((row) => calendarEventSchema.parse(JSON.parse(row.payload)));
  }
  exceptions(seriesId?: string) {
    return this.db
      .query<{
        series_id: string;
        occurrence_date: string;
        payload: string | null;
        deleted_at: string | null;
      }>(
        `SELECT * FROM calendar_event_exceptions ${seriesId ? 'WHERE series_id = ?' : ''} ORDER BY series_id, occurrence_date`,
        ...(seriesId ? [seriesId] : []),
      )
      .map((row) =>
        calendarExceptionSchema.parse({
          seriesId: row.series_id,
          date: row.occurrence_date,
          event: row.payload ? (JSON.parse(row.payload) as unknown) : null,
          deletedAt: row.deleted_at,
        }),
      );
  }
  setException(
    seriesId: string,
    date: string,
    event: ReturnType<typeof calendarExceptionSchema.parse>['event'],
    deletedAt: string | null,
  ) {
    this.db.run(
      'INSERT INTO calendar_event_exceptions(series_id,occurrence_date,payload,deleted_at) VALUES (?,?,?,?) ON CONFLICT(series_id,occurrence_date) DO UPDATE SET payload=excluded.payload,deleted_at=excluded.deleted_at',
      seriesId,
      date,
      event ? JSON.stringify(event) : null,
      deletedAt,
    );
  }
  clearExceptions(seriesId: string) {
    this.db.run('DELETE FROM calendar_event_exceptions WHERE series_id = ?', seriesId);
  }
  clearException(seriesId: string, date: string) {
    this.db.run(
      'DELETE FROM calendar_event_exceptions WHERE series_id = ? AND occurrence_date = ?',
      seriesId,
      date,
    );
  }
  deliveries() {
    return this.db
      .query<{ payload: string }>('SELECT payload FROM calendar_reminder_deliveries ORDER BY id')
      .map((row) => calendarDeliverySchema.parse(JSON.parse(row.payload)));
  }
  hasDelivery(id: string) {
    return this.db.query('SELECT id FROM calendar_reminder_deliveries WHERE id = ?', id).length > 0;
  }
  pendingDeliveries() {
    return this.db
      .query<{ payload: string }>(
        "SELECT payload FROM calendar_reminder_deliveries WHERE json_extract(payload,'$.dismissed') = 0 ORDER BY json_extract(payload,'$.dueAt') DESC LIMIT 100",
      )
      .map((row) => calendarDeliverySchema.parse(JSON.parse(row.payload)));
  }
  saveDelivery(delivery: ReturnType<typeof calendarDeliverySchema.parse>) {
    this.db.run(
      'INSERT INTO calendar_reminder_deliveries(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      delivery.id,
      JSON.stringify(delivery),
    );
  }
  initialize(timeZone: string) {
    const now = new Date().toISOString();
    const calendar = calendarSchema.parse({
      calendarId: 'local-default',
      name: '我的日历',
      color: '#4285F4',
      timeZone,
      isDefault: true,
      isEnabled: true,
      visibility: 'private',
      version: 1,
      createdAt: now,
      updatedAt: now,
      defaultReminders: [],
      writable: true,
    });
    this.db.run(
      'INSERT OR IGNORE INTO calendar_calendars(id,payload) VALUES (?,?)',
      calendar.calendarId,
      JSON.stringify(calendar),
    );
  }
  get(id: string): CalendarEvent | null {
    const row = this.db.query<{ payload: string }>(
      'SELECT payload FROM calendar_events WHERE id = ?',
      id,
    )[0];
    return row ? calendarEventSchema.parse(JSON.parse(row.payload)) : null;
  }
  byKey(key: string) {
    const row = this.db.query<{ payload: string }>(
      'SELECT payload FROM calendar_requests WHERE key = ?',
      key,
    )[0];
    return row ? calendarEventSchema.parse(JSON.parse(row.payload)) : null;
  }
  range(start: number, end: number, includeDeleted: boolean) {
    return this.db
      .query<{ payload: string }>(
        `SELECT payload FROM calendar_events WHERE start_at < ? AND end_at > ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY start_at, id`,
        end,
        start,
      )
      .map((row) => calendarEventSchema.parse(JSON.parse(row.payload)));
  }
  write(event: CalendarEvent, start: number, end: number, action: string, key?: string) {
    if (key)
      this.db.run(
        'INSERT INTO calendar_requests(key,payload) VALUES (?,?)',
        key,
        JSON.stringify(event),
      );
    this.db.run(
      `INSERT INTO calendar_events(id,calendar_id,start_at,end_at,version,deleted_at,payload,idempotency_key) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,start_at=excluded.start_at,end_at=excluded.end_at,version=excluded.version,deleted_at=excluded.deleted_at,payload=excluded.payload`,
      event.eventId,
      event.calendarId,
      start,
      end,
      event.version,
      event.deletedAt,
      JSON.stringify(event),
      key ?? null,
    );
    this.db.run(
      'INSERT INTO calendar_audit_log(id,event_id,action,at,version,actor) VALUES (?,?,?,?,?,?)',
      `${event.eventId}:${event.version}`,
      event.eventId,
      action,
      event.updatedAt,
      event.version,
      event.source.type,
    );
  }
}

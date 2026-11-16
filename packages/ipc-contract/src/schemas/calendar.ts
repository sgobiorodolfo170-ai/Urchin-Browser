import { z } from 'zod';

const id = z.string().min(1).max(128);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, '无效日期');
const instant = z.string().datetime({ offset: true });
export const calendarTimeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '无效时区');
export const calendarReminderSchema = z
  .object({
    method: z.enum(['in_app', 'notification']),
    minutesBefore: z.number().int().min(0).max(40320),
  })
  .strict();
export const calendarRecurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(365),
    byWeekday: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    startDate: date,
    endDate: date.nullable().default(null),
    count: z.number().int().positive().max(10000).nullable().default(null),
    timeZone: calendarTimeZoneSchema,
  })
  .strict();
export const calendarEventInputSchema = z
  .object({
    calendarId: id.default('local-default'),
    title: z.string().trim().min(1).max(300),
    allDay: z.boolean().default(false),
    startAt: instant.nullable().default(null),
    endAt: instant.nullable().default(null),
    startDate: date.nullable().default(null),
    endDateExclusive: date.nullable().default(null),
    timeZone: calendarTimeZoneSchema,
    description: z.string().max(20000).default(''),
    location: z.string().max(1000).nullable().default(null),
    meetingUrl: z
      .string()
      .url()
      .max(8192)
      .refine((value) => /^https?:\/\//i.test(value))
      .nullable()
      .default(null),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
    visibility: z.enum(['private', 'default']).default('private'),
    recurrence: calendarRecurrenceSchema.nullable().default(null),
    seriesId: id.nullable().default(null),
    reminders: z.array(calendarReminderSchema).max(10).default([]),
    attendees: z
      .array(
        z
          .object({
            type: z.literal('contact'),
            contactId: id,
            displayName: z.string().max(200),
            role: z.enum(['required', 'optional']),
            responseStatus: z.enum(['needs_action', 'accepted', 'declined', 'tentative']),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    relations: z
      .array(
        z
          .object({ type: z.enum(['task', 'project', 'note', 'file', 'email', 'contact']), id })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const calendarEventSchema = calendarEventInputSchema.extend({
  occurrenceDate: date.nullable().default(null),
  occurrenceIndex: z.number().int().nonnegative().nullable().default(null),
  eventId: id,
  version: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.nullable(),
  source: z.object({ type: z.enum(['user', 'ai', 'import', 'system']), requestId: id.nullable() }),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;
/** 供未来调用方选用的数据规范，不规定助手的上下文注入实现。 */
export const calendarContextSchema = z
  .object({
    today: date,
    timeZone: calendarTimeZoneSchema,
    calendarIds: z.array(id).max(100),
    selectedEvent: z.object({ eventId: id, version: z.number().int().positive() }).nullable(),
    range: z.object({ startAt: instant, endAt: instant }).nullable(),
    capabilities: z
      .object({
        recurrenceExecution: z.boolean(),
        reminderDelivery: z.boolean(),
        externalSync: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const calendarSchema = z.object({
  calendarId: id,
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  timeZone: calendarTimeZoneSchema,
  isDefault: z.boolean(),
  isEnabled: z.boolean(),
  visibility: z.literal('private'),
  version: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  defaultReminders: z.array(calendarReminderSchema),
  writable: z.boolean(),
});
export type Calendar = z.infer<typeof calendarSchema>;
export const calendarExceptionSchema = z
  .object({
    seriesId: id,
    date,
    event: calendarEventInputSchema.nullable(),
    deletedAt: instant.nullable(),
  })
  .strict();
export const calendarDeliverySchema = z
  .object({ id, eventId: id, title: z.string().max(300), dueAt: instant, dismissed: z.boolean() })
  .strict();
export const calendarBackupSchema = z
  .object({
    format: z.literal('urchin-calendar'),
    version: z.literal(1),
    calendars: z.array(calendarSchema).max(100),
    events: z.array(calendarEventSchema).max(20000),
    exceptions: z.array(calendarExceptionSchema).max(20000),
    deliveries: z.array(calendarDeliverySchema).max(50000),
    requests: z.array(z.object({ key: id, event: calendarEventSchema }).strict()).max(20000),
    audit: z
      .array(
        z
          .object({
            id,
            event_id: id,
            action: z.string().max(100),
            at: instant,
            version: z.number().int().positive(),
            actor: z.string().max(100),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
const calendarEdit = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    timeZone: calendarTimeZoneSchema,
    isEnabled: z.boolean(),
    isDefault: z.boolean(),
  })
  .strict();
const range = z
  .object({
    startAt: instant,
    endAt: instant,
    calendarIds: z.array(id).max(100).default([]),
    includeDeleted: z.boolean().default(false),
  })
  .strict();
export const calendarChannels = {
  'calendar.saveCalendar': {
    req: z
      .object({
        calendarId: id.optional(),
        expectedVersion: z.number().int().positive().optional(),
        calendar: calendarEdit,
      })
      .strict(),
    res: calendarSchema,
  },
  'calendar.exportBackup': {
    req: z.object({}).strict(),
    res: z.object({ data: z.string(), digest: z.string(), previous: z.string().nullable() }),
  },
  'calendar.importBackup': {
    req: z.object({ data: z.string().max(5_000_000), expectedDigest: z.string() }).strict(),
    res: z.object({ restored: z.number().int().nonnegative() }),
  },
  'calendar.listReminders': {
    req: z.object({}).strict(),
    res: z.object({ reminders: z.array(calendarDeliverySchema) }),
  },
  'calendar.dismissReminder': {
    req: z.object({ id }).strict(),
    res: z.object({ ok: z.boolean() }),
  },
  'calendar.listCalendars': {
    req: z.object({}).strict(),
    res: z.object({ calendars: z.array(calendarSchema) }),
  },
  'calendar.listEvents': { req: range, res: z.object({ events: z.array(calendarEventSchema) }) },
  'calendar.getEvent': { req: z.object({ eventId: id }).strict(), res: calendarEventSchema },
  'calendar.createEvent': {
    req: z.object({ event: calendarEventInputSchema, idempotencyKey: id }).strict(),
    res: calendarEventSchema,
  },
  'calendar.updateEvent': {
    req: z
      .object({
        eventId: id,
        expectedVersion: z.number().int().positive(),
        event: calendarEventInputSchema,
        scope: z.enum(['single', 'future', 'series']).optional(),
      })
      .strict(),
    res: calendarEventSchema,
  },
  'calendar.deleteEvent': {
    req: z
      .object({
        eventId: id,
        expectedVersion: z.number().int().positive(),
        scope: z.enum(['single', 'future', 'series']).optional(),
      })
      .strict(),
    res: calendarEventSchema,
  },
  'calendar.restoreEvent': {
    req: z.object({ eventId: id, expectedVersion: z.number().int().positive() }).strict(),
    res: calendarEventSchema,
  },
  'calendar.checkConflicts': {
    req: z.object({ event: calendarEventInputSchema, excludeEventId: id.optional() }).strict(),
    res: z.object({ events: z.array(calendarEventSchema) }),
  },
  'calendar.findFreeSlots': {
    req: range
      .extend({
        durationMinutes: z.number().int().min(1).max(1440),
        bufferMinutes: z.number().int().min(0).max(1440).default(0),
        limit: z.number().int().min(1).max(100).default(10),
        timeZone: calendarTimeZoneSchema.default('UTC'),
        workingHours: z
          .object({
            startMinute: z.number().int().min(0).max(1439),
            endMinute: z.number().int().min(1).max(1440),
            weekdays: z.array(z.number().int().min(1).max(7)).max(7),
          })
          .strict()
          .optional(),
        excludeEventIds: z.array(id).max(100).default([]),
      })
      .strict(),
    res: z.object({ slots: z.array(z.object({ startAt: instant, endAt: instant })) }),
  },
} as const;

/** 仅日历契约预备，不注册到任何 AI 助手或决定其工具架构。 */
export const calendarToolContracts = {
  calendar_list_calendars: calendarChannels['calendar.listCalendars'],
  calendar_list_events: calendarChannels['calendar.listEvents'],
  calendar_get_event: calendarChannels['calendar.getEvent'],
  calendar_create_event: calendarChannels['calendar.createEvent'],
  calendar_update_event: calendarChannels['calendar.updateEvent'],
  calendar_delete_event: calendarChannels['calendar.deleteEvent'],
  calendar_check_conflicts: calendarChannels['calendar.checkConflicts'],
  calendar_find_free_slots: calendarChannels['calendar.findFreeSlots'],
} as const;

import type { CalendarEventInput } from '@urchin/ipc-contract';
import { CalendarError } from './error';
export function dateInZone(instant: number, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function wallInstant(date: string, hour: number, minute: number, timeZone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60000;
  let result = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(result).map((part) => [part.type, part.value]),
    );
    const actual = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
    const next = result + target - actual;
    if (next === result) return result;
    result = next;
  }
  throw new CalendarError('INVALID_ARGUMENT', '本地时间在夏令时跳变中不存在');
}
export function wallParts(
  iso: string,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const instant = Date.parse(iso);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return { date: dateInZone(instant, timeZone), hour: Number(p.hour), minute: Number(p.minute) };
}
/** 将事件移至另一民用日期，保留事件时区中的钟表时间和跨天长度。 */
export function reanchor<T extends CalendarEventInput>(event: T, date: string): T {
  if (event.allDay) {
    const span = (Date.parse(event.endDateExclusive!) - Date.parse(event.startDate!)) / 86400000;
    return { ...event, startDate: date, endDateExclusive: addDays(date, span) };
  }
  const start = wallParts(event.startAt!, event.timeZone),
    end = wallParts(event.endAt!, event.timeZone);
  const span = (Date.parse(end.date) - Date.parse(start.date)) / 86400000;
  return {
    ...event,
    startAt: new Date(wallInstant(date, start.hour, start.minute, event.timeZone)).toISOString(),
    endAt: new Date(
      wallInstant(addDays(date, span), end.hour, end.minute, event.timeZone),
    ).toISOString(),
  };
}
/** 日期到瞬时的转换集中在服务端，全天范围依事件时区计算（含 DST）。 */
export function midnight(date: string, timeZone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const local = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    const next = instant + target - local;
    if (next === instant) return instant;
    instant = next;
  }
  throw new CalendarError('INVALID_ARGUMENT', '该日期在所选时区不存在可表示的午夜');
}

export function eventRange(event: CalendarEventInput): [number, number] {
  if (event.allDay) {
    if (!event.startDate || !event.endDateExclusive || event.startAt || event.endAt)
      throw new CalendarError('INVALID_ARGUMENT', '全天事件需要独立的起止日期');
    return [
      midnight(event.startDate, event.timeZone),
      midnight(event.endDateExclusive, event.timeZone),
    ];
  }
  if (!event.startAt || !event.endAt || event.startDate || event.endDateExclusive)
    throw new CalendarError('INVALID_ARGUMENT', '定时事件需要起止时间');
  return [Date.parse(event.startAt), Date.parse(event.endAt)];
}

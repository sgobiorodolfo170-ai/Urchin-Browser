import type { CalendarEvent } from '@urchin/ipc-contract';
import { addDays, dateInZone, eventRange, reanchor } from './time';
import { CalendarError } from './error';

export function anchorDate(
  event: Pick<CalendarEvent, 'allDay' | 'startDate' | 'startAt' | 'timeZone'>,
): string {
  return event.allDay ? event.startDate! : dateInZone(Date.parse(event.startAt!), event.timeZone);
}
/** 有界展开；不复制未来实例。月末/闰日无对应日期时跳过，DST 缺失时间也跳过。 */
export function occurrences(
  event: CalendarEvent,
  until: number,
  from = Number.NEGATIVE_INFINITY,
  limit = Number.POSITIVE_INFINITY,
): CalendarEvent[] {
  const rule = event.recurrence;
  if (!rule) return [event];
  const first = rule.startDate,
    base = new Date(`${first}T00:00:00Z`),
    firstDay = base.getUTCDate();
  const maxDate = dateInZone(until, event.timeZone);
  if (maxDate < first) return [];
  const result: CalendarEvent[] = [];
  let count = 0;
  let firstPeriod = 0;
  if (!rule.count && Number.isFinite(from)) {
    const [start, end] = eventRange(event);
    const lower = new Date(
      `${dateInZone(from - (end - start) - 2 * 86400000, event.timeZone)}T00:00:00Z`,
    );
    const dayDiff = (lower.getTime() - base.getTime()) / 86400000;
    const units =
      rule.frequency === 'daily'
        ? dayDiff
        : rule.frequency === 'weekly'
          ? dayDiff / 7
          : rule.frequency === 'monthly'
            ? (lower.getUTCFullYear() - base.getUTCFullYear()) * 12 +
              lower.getUTCMonth() -
              base.getUTCMonth()
            : lower.getUTCFullYear() - base.getUTCFullYear();
    firstPeriod = Math.max(0, Math.floor(units / rule.interval) - 1);
  }
  for (let period = firstPeriod; period < firstPeriod + 10000; period++) {
    let candidates: string[] = [];
    if (rule.frequency === 'daily') candidates = [addDays(first, period * rule.interval)];
    if (rule.frequency === 'weekly') {
      const monday = addDays(first, -((base.getUTCDay() + 6) % 7) + period * rule.interval * 7);
      const weekdays = rule.byWeekday.length
        ? [...new Set(rule.byWeekday)].sort()
        : [((base.getUTCDay() + 6) % 7) + 1];
      candidates = weekdays.map((day) => addDays(monday, day - 1));
    }
    if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
      const candidate = new Date(
        Date.UTC(
          base.getUTCFullYear() + (rule.frequency === 'yearly' ? period * rule.interval : 0),
          base.getUTCMonth() + (rule.frequency === 'monthly' ? period * rule.interval : 0),
          firstDay,
        ),
      );
      if (
        candidate.getUTCDate() === firstDay &&
        (rule.frequency !== 'yearly' || candidate.getUTCMonth() === base.getUTCMonth())
      )
        candidates = [candidate.toISOString().slice(0, 10)];
      else if (candidate.toISOString().slice(0, 10) > maxDate) break;
    }
    if (candidates.length && candidates[0]! > maxDate) break;
    let done = false;
    for (const date of candidates) {
      if (date < first) continue;
      if (
        date > maxDate ||
        (rule.endDate && date > rule.endDate) ||
        (rule.count && count >= rule.count)
      ) {
        done = true;
        break;
      }
      try {
        const shifted = reanchor(event, date);
        const [start, end] = eventRange(shifted);
        if (end <= start) continue;
        count++;
        if (end > from)
          result.push({
            ...shifted,
            eventId: `${event.eventId}@${date}`,
            seriesId: event.eventId,
            occurrenceDate: date,
            occurrenceIndex: firstPeriod > 0 ? null : count - 1,
          });
        if (result.length >= limit) return result;
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
      }
    }
    if (done || (rule.count && count >= rule.count) || candidates.at(-1) === maxDate) break;
    if (period === firstPeriod + 9999)
      throw new CalendarError(
        'INVALID_ARGUMENT',
        '重复事件展开超过 10000 个周期，请缩小范围或设置结束条件',
      );
  }
  return result;
}

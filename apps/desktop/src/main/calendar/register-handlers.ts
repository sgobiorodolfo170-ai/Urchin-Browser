import { registerHandler, IpcError, IpcErrorCode, type IpcMainLike } from '@urchin/ipc-contract';
import { CalendarError, CalendarService, createCalendarOperations } from './service';
import { CalendarRepository, type CalendarDatabase } from './repository';

export function registerCalendarHandlers(
  ipcMain: IpcMainLike,
  database: CalendarDatabase,
  authorize: (sender: unknown) => boolean,
  onChanged: () => void = () => undefined,
): CalendarService {
  const service = new CalendarService(new CalendarRepository(database));
  const operations = createCalendarOperations(service);
  const safe = <T>(sender: unknown, action: () => T, changed = false): T => {
    if (!authorize(sender)) throw new IpcError(IpcErrorCode.PERMISSION, '无权访问本地日历');
    try {
      const result = action();
      if (changed) {
        try {
          onChanged();
        } catch {
          /* 通知失败不改变已提交写入的结果。 */
        }
      }
      return result;
    } catch (error) {
      if (error instanceof CalendarError)
        throw new IpcError(IpcErrorCode.VALIDATION, error.message);
      throw new IpcError(IpcErrorCode.INTERNAL, '日历操作失败，请重试');
    }
  };
  registerHandler(ipcMain, 'calendar.listCalendars', (_req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.listCalendars']()),
  );
  registerHandler(ipcMain, 'calendar.listEvents', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.listEvents'](req)),
  );
  registerHandler(ipcMain, 'calendar.getEvent', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.getEvent'](req)),
  );
  registerHandler(ipcMain, 'calendar.createEvent', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.createEvent'](req), true),
  );
  registerHandler(ipcMain, 'calendar.updateEvent', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.updateEvent'](req), true),
  );
  registerHandler(ipcMain, 'calendar.deleteEvent', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.deleteEvent'](req), true),
  );
  registerHandler(ipcMain, 'calendar.restoreEvent', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.restoreEvent'](req), true),
  );
  registerHandler(ipcMain, 'calendar.checkConflicts', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.checkConflicts'](req)),
  );
  registerHandler(ipcMain, 'calendar.findFreeSlots', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.findFreeSlots'](req)),
  );
  registerHandler(ipcMain, 'calendar.saveCalendar', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.saveCalendar'](req), true),
  );
  registerHandler(ipcMain, 'calendar.exportBackup', (_req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.exportBackup']()),
  );
  registerHandler(ipcMain, 'calendar.importBackup', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.importBackup'](req), true),
  );
  registerHandler(ipcMain, 'calendar.listReminders', (_req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.listReminders']()),
  );
  registerHandler(ipcMain, 'calendar.dismissReminder', (req, ctx) =>
    safe(ctx.event.sender, () => operations['calendar.dismissReminder'](req), true),
  );
  return service;
}

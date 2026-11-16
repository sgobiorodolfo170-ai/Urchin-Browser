import type { CalendarService } from './service';

/** 运行时扫描 + 主库投递去重。退出时不依赖 OS 后台任务；重启补偿最近 24 小时。 */
export function startCalendarReminders(
  service: CalendarService,
  notify: (title: string, method: 'in_app' | 'notification') => void,
): () => void {
  const tick = () => {
    try {
      service.deliverReminders(Date.now(), notify);
    } catch {
      /* 暂时失败保留至下一次扫描；不输出日程正文。 */
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  const startup = setTimeout(tick, 1000);
  startup.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(startup);
  };
}

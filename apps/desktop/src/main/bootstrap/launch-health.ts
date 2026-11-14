/** 仅 pnpm start 使用的外部启动回执。心跳停更可区分“进程存在”和“事件循环可用”。 */
import { writeFile } from 'node:fs/promises';
export function installLaunchHealth(file: string | undefined): () => void {
  if (!file) return () => undefined;
  let writing = false;
  const tick = () => {
    if (writing) return;
    writing = true;
    void writeFile(file, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }), 'utf8')
      .catch(() => undefined)
      .finally(() => {
        writing = false;
      });
  };
  tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

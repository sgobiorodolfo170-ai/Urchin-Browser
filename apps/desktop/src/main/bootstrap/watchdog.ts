/**
 * 事件循环阻塞 watchdog（refactor-plan-p2 §1.3 步骤 4，自 index.ts 原样迁出；
 * 2026-08-17 加，排查主进程偶发 100% CPU 卡死）。
 */
export function installEventLoopWatchdog(): void {
  let last = Date.now();
  const tick = (): void => {
    const now = Date.now();
    const lag = now - last - 500;
    if (lag > 2000) {
      console.error(`[watchdog] event loop blocked ${lag}ms`, new Error('blocked').stack);
    }
    last = now;
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}

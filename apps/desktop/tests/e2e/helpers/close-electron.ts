export interface ManagedApplication {
  close(): Promise<void>;
  process(): { pid?: number; exitCode: number | null; signalCode: string | null };
}
/**
 * 进程表里仍需等到 PID 真正消失：`taskkill /F` 只保证信号送达，
 * 窗口销毁与前台焦点交接可能滞后；下一个用例若立刻启动，
 * 会和仍在退出的实例抢焦点（症状：`webContents.isFocused()` 轮询超时）。
 */
async function waitForPidExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** 不依赖被测应用的主线程完成清理；原生 DLL 卡死时仍有外部 PID 回收路径。 */
export async function closeManagedApplication(
  app: ManagedApplication,
  terminate: (pid: number) => Promise<void>,
  timeout = 3000,
): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    Promise.resolve()
      .then(() => app.close())
      .then(
        () => true,
        () => false,
      ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed && child.pid && child.exitCode === null && child.signalCode === null) {
    await terminate(child.pid);
    await waitForPidExit(child.pid);
  }
}

export interface ManagedApplication {
  close(): Promise<void>;
  process(): { pid?: number; exitCode: number | null; signalCode: string | null };
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
  if (!closed && child.pid && child.exitCode === null && child.signalCode === null)
    await terminate(child.pid);
}

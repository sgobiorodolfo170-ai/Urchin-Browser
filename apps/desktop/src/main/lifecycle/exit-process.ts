/**
 * 隔离验收进程在资源清理后直接终止，绕开旧输入法 DLL 的 detach 死锁。
 * 仅显式启用且双数据目录隔离时生效，安装版默认退出路径不变。
 */
export function finishProcessExit(
  code: number,
  normalExit: (code: number) => void,
  options = {
    platform: process.platform as string,
    env: process.env as Record<string, string | undefined>,
    terminate: () => {
      process.kill(process.pid, 'SIGKILL');
    },
  },
): void {
  if (
    options.platform === 'win32' &&
    options.env.URCHIN_NATIVE_EXIT_GUARD === '1' &&
    options.env.URCHIN_TEST_USER_DATA &&
    options.env.URCHIN_TEST_DATA_DIR
  ) {
    options.terminate();
    return;
  }
  normalExit(code);
}

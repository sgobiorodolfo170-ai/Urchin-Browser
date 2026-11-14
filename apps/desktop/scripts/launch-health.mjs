/** 启动回执同时约束 PID 与时间，避免把旧文件当成新实例就绪。 */
export function isLaunchReady(record, pid, startedAt, now = Date.now()) {
  return (
    record?.pid === pid &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= startedAt &&
    now - record.updatedAt < 6000
  );
}
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 防抖自动保存器（auto-saver）
 *
 * 职责：编辑内容变更后延迟 N 毫秒执行一次保存（草稿落盘）。
 * - schedule()：尾沿防抖——连续输入只保留最后一次计时
 * - flushNow()：立即执行并清除待发计时（保存/放弃/切换前兜底）
 * - cancel()：放弃待发（保存成功后不再需要草稿写入）
 * 纯计时编排、不涉及 IO，flush 由调用方注入（便于 fake timers 单测）。
 */
export interface AutoSaver {
  /** 重置并启动延迟计时（连续调用只保留最后一次）。 */
  schedule(): void;
  /** 取消待发计时。 */
  cancel(): void;
  /** 是否有待发计时。 */
  hasPending(): boolean;
  /** 立即执行 flush 并清除待发计时。 */
  flushNow(): Promise<void>;
}

/** 创建防抖自动保存器。 */
export function createAutoSaver(delayMs: number, flush: () => Promise<void>): AutoSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    schedule(): void {
      clear();
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    },
    cancel(): void {
      clear();
    },
    hasPending(): boolean {
      return timer !== null;
    },
    async flushNow(): Promise<void> {
      clear();
      await flush();
    },
  };
}

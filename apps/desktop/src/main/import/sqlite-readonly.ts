/**
 * Import 域 · 只读 SQLite 打开器（Firefox places / cookies 共用）
 *
 * 设计理由（2026-11-10 抽取）：
 * - 原先 SqliteReadonlyFactory 与 defaultReadonlyFactory 私有在 firefox-profiles.ts，
 *   Cookie 导入（cookies.sqlite）需要同一套「复制临时文件 + 只读打开」策略；
 * - `better-sqlite3` 保持**按需 dynamic import**：原生模块缺失时只影响导入功能，
 *   不拖垮主进程启动（dev.176 事故教训，见 AGENTS.md §七.2）。
 */

/** 只读 SQLite 最小接口（便于单测注入 mock，不泄漏 better-sqlite3 类型）。 */
export interface SqliteReadonlyDatabase {
  prepare(sql: string): { all(...params: readonly unknown[]): unknown[] };
  close(): void;
}

/** better-sqlite3 工厂注入（生产用 better-sqlite3，单测注入 mock 或跳过 DB 测试）。 */
export type SqliteReadonlyFactory = (path: string) => SqliteReadonlyDatabase;

/**
 * 生产默认 better-sqlite3 只读工厂——按需加载原生模块。
 *
 * 为什么惰性（2026-11-10 dev.176 事故）：静态导入会让 vite 在共享 chunk 顶层
 * 生成 require('better-sqlite3')，安装未完成时主进程启动即崩溃；动态导入把
 * 故障面收敛到「导入功能首次使用」。
 */
export async function defaultReadonlyFactory(): Promise<SqliteReadonlyFactory> {
  const { default: SqliteCtor } = await import('better-sqlite3');
  return (path: string) => {
    const db = new SqliteCtor(path, { readonly: true });
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return { all: (...params: readonly unknown[]) => stmt.all(...params) };
      },
      close: () => db.close(),
    };
  };
}

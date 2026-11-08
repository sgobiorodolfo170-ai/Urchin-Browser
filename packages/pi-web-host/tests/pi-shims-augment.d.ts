/**
 * 测试侧 ambient 声明补充（仅类型，不影响运行时）。
 *
 * 背景：`src/pi-server/engine-probe.ts` 直接 `import { VERSION } from
 * "@earendil-works/pi-coding-agent"`，但 `src/pi-shims.d.ts` 未声明该导出。
 * `src/pi-server/**` 被 tsconfig 的 `exclude` 排除，只要没有测试引用它，这个缺口
 * 就不会进入 typecheck 程序；一旦 `tests/engine-probe.test.ts` 引用它，tsc 会连带
 * 检查该文件并报 TS2305。
 *
 * 这里只补齐 vendored 包真实存在的导出（真实包确实导出 VERSION），属于测试侧
 * 的声明补充。待 `src/pi-shims.d.ts` 自行补上 `export const VERSION: string;`
 * 之后，本文件即可删除。
 */
declare module '@earendil-works/pi-coding-agent' {
  export const VERSION: string;
}

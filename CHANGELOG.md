## 版本迭代记录

> 按 AGENTS.md §四版本迭代记录规范维护。版本号规则：SemVer（主版本.次版本.修订号）。

| 版本号 | 日期 | 摘要 |
| --- | --- | --- |
| v0.0.1 | 2026-07-27 | 设计文档体系落盘：00-设计总览、01-愿景与定位、02-架构设计、03-技术栈、04-模块全景、05-路线图、06-需求文档、07-立项准备、11 份接口契约（A-提供方接口 至 K-主题系统）、3 份关键 ADR + 决策索引。无代码产出。设计层主线收口完成。 |
| v0.0.2 | 2026-07-29 | 设计文档 W0 收敛：依据 [docs/文档评估报告-2026-07-29](./docs/文档评估报告-2026-07-29.md) 完成 P0/P1/P2 全部修订——M10 拆分 lite/完整、覆盖率阶梯单一真源、版本时间点统一（签名 v0.4/撤销 v0.3/session restore v0.5）、契约 B/F 技术硬伤修复、新增 M23 Download Manager、新决策 CP6/CP7/TP6/PC8/OM10；决策口径统一为核心 36 + 契约内 68 = 104 项。 |
| v0.0.3 | 2026-07-29 | D8 议题收口：agents.md 项目级适配完成并生效——§八覆盖率门槛阶梯化（原值/适配值留痕）、§九工具链项目化、§二至§六术语本地化、§十一 Graph Engineering 按规模裁剪；无架构性变更。 |
| v0.1.0 | TBD | 计划：MVP 最小闭环 + per-provider 强隔离（8 周分波），详见 [docs/04-模块全景 §4](./docs/04-模块全景.md#4-v01-分波次交付计划6-8-周) |
| v0.1.0-dev.1 | 2026-07-29 | **W1-D1 脚手架 + IPC 契约层完成**。pnpm monorepo（apps/desktop + packages/ipc-contract/logger/chrome-types）；ESLint 9 flat + Prettier 3 + Husky + commitlint + CI；tsconfig strict + noUncheckedIndexedAccess；M17 IPC 契约层（zod schema 9 通道 + registerHandler 包装器 + typedInvoke 客户端 + IpcError 协议）；main/preload/renderer 入口（sandbox+contextIsolation）；Electron 32.3.3 二进制就绪。验证：typecheck 4 包全过 / lint 全过 / 37 测试全过（ipc-contract 34 + desktop 3）。 |

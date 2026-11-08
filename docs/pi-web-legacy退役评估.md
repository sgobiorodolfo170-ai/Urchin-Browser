# pi-web legacy 壳退役评估（按需抉择留痕）

> 建立：2026-11-09 · 性质：**评估留痕，未执行**——退役决策待用户按需抉择，状态见 §七
> 关联：[pi-web-评估](./pi-web-评估.md)（三阶段演化源头）· [pi-web-重建台账](./pi-web-重建台账.md)（R1 混合式重建）· [pi-web-测试交接-2026-11-08](./pi-web-测试交接-2026-11-08.md)（测试基线与结构决策）· [ADR-013](./decisions/ADR-013-pi阶段2自研前端与托管服务.md)（自研壳诞生）· [ADR-015](./decisions/ADR-015-pi服务常驻与入口收口.md)（常驻语义）· [pi-web-上游跟进流程](./pi-web-上游跟进流程.md)（上游跟进现行流程）
> 上游对照库：`G:\pj\github\pi-web-ui`，基线 0.118.0（[事实登记表 F9](./事实登记表.md)）

## 一、术语与范围

「退役 pi-web-host」在本项目语境下必须按两层拆开，**本文只讨论前者**：

| 对象 | 内容 | 结论 |
| --- | --- | --- |
| **legacy 轻量壳**（本文退役对象） | `packages/pi-web-host/src/` 顶层自研服务（server / entry / auth / http-static / ws-handler / agent-bridge / session-store / file-ops / git-ops / terminal / ssh-client / plugin-\* 等 18 文件 4,565 行）+ `src/model-admin/`（9 文件 3,915 行）+ 顶层测试（30 文件 8,681 行） | 可评估退役 |
| **包整体**（不退役） | `@urchin/pi-web-host` 作为包仍承载：`src/pi-server/`（默认服务端）、`./shared/*` 导出（前后端协议单一真源，前端 vite/vitest 别名直通）、`pi-server-ready.ts`（两种服务共用的就绪行契约）、desktop launcher/IPC 集成层 | 主权件，长期保留 |

（行数为 2026-11-09 实测时点事实；测试文件数与交接文档历史口径的差异源于统计范围，以实测为准。）

## 二、依赖解耦现状（2026-11-09 逐项核实）

| #  | 核实项                                                       | 结果                                                                                                                         | 出处                                              |
| -- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1  | desktop 源码/测试从包根（不带子路径）import                   | **0 命中**（apps/desktop/src、apps/desktop/tests、apps/pi-web/src 全查）                                                       | grep 实测                                         |
| 2  | 包根公共出口 `src/index.ts` 的消费方                          | 无外部源码消费方；`startPiWebHostServer` 全仓唯一命中在构建产物 `dist/main/pi-web-host.js` 内部（legacy bundle 自身字符串）   | grep 实测                                         |
| 3  | launcher 对 legacy 的依赖                                    | 无 import；pi-server 模式 token 由 launcher 自行生成（`launcher.ts:234`）；两种就绪行正则并存（`HOST_URL_LINE_RE` / `PI_SERVER_URL_LINE_RE`） | `apps/desktop/src/main/pi-web-host/launcher.ts`   |
| 4  | pi-server 反向依赖顶层壳                                     | **0 命中**（`from '../../'` 全查）；唯一共享物为 `pi-server-ready.ts` 就绪行契约                                              | grep 实测                                         |
| 5  | 前端引用面                                                   | 只走 `@urchin/pi-web-host/shared`（→ src/pi-server）与 `/browser` 别名，不触顶层                                              | `apps/pi-web/vite.config.ts:39-40`                |
| 6  | E2E 实际模式                                                 | `pi-web-host.spec.ts` 不设 `URCHIN_PI_SERVER` → 实测的就是默认 pi-server 模式                                                  | `apps/desktop/tests/e2e/pi-web-host.spec.ts`      |
| 7  | 双轨开关                                                     | `URCHIN_PI_SERVER=legacy` 才回退轻量壳，默认 pi-server                                                                        | `apps/desktop/src/main/bootstrap/handlers.ts:594` |

**结论**：引用方向是干净的单向结构——pi-server 自立、不被 legacy 依赖，legacy 与外界只剩「launcher fork 目标 + env 开关」一条接线。退役是局部手术，不产生网状耦合。

## 三、退役工作量清单（届时执行用）

1. **删除**：顶层 legacy 模块（18 文件 4,565 行）+ `src/model-admin/`（9 文件 3,915 行，pi-server 有自己的上游版 `model-admin.ts`）+ 包根出口 `src/index.ts` + 顶层测试 30 文件 8,681 行；**保留** `pi-server-ready.ts`（pi-server 共用）。
2. **launcher / handlers 简化**：`serverKind` 双模式收敛为单模式、`HOST_URL_LINE_RE` 移除、`URCHIN_PI_SERVER` 开关移除（`handlers.ts:592-597`）及 launcher 单测双模式用例同步。
3. **构建**：`scripts/build-pi-web.mjs` 删 CJS 产物步骤（现双产物：`pi-web-host.js` CJS + `pi-server.mjs` ESM，见脚本 :34-35 / :58-59 / :88-94）。
4. **打包核查清单**：B1（dist/main 产物清单）、§3 输入文件、C13 构建脚本行同步——注意 `pi-server.mjs` 本身尚未登记（见 §四.2），届时一并修正。
5. **门禁口径**：包内 vitest 覆盖率分层中 legacy 档随范围消失调整（口径见[交接文档 §9](./pi-web-测试交接-2026-11-08.md)）。
6. **文档留痕**：本档状态改「已执行」、[重建台账](./pi-web-重建台账.md)与交接文档补记、CHANGELOG 行。

## 四、暂不退役的四个理由（2026-11-09 结论）

1. **转正时间过短，真实链路证据不足**：pi-server 于 2026-11-08 P6 才成为默认（[台账 §5.6](./pi-web-重建台账.md)）；P8（真实 Key 全链路）为人工验证、CI 只有无 Key 路径；打包态 pi-server 冒烟无留痕。dev.158 教训：**打包成功且校验通过 ≠ 安装版能跑**。
2. **打包口径未收口**：`dist/main/pi-server.mjs` 尚未登记进[打包核查清单](./打包核查清单.md)（台账 P6 明确遗留；2026-11-09 复核清单 B1 仍只列 `pi-web-host.js`）。安全网未挂好前不拆备用绳。
3. **legacy 是唯一「全门禁」实现**：pi-server 被排除出 tsc/eslint（上游类型缺口与风格，测试侧 ambient shim 兜底，[交接文档 §3](./pi-web-测试交接-2026-11-08.md) 结构决策「不要回退」）；legacy 是 strict TS、覆盖 80.75% lines（截至 2026-11-08，交接文档口径）的实现，`URCHIN_PI_SERVER=legacy` 是出事时的运行时逃生路。
4. **piSettingsChanged 回写缺口未决策**：set_model → 桌面 `pi.*` 设置键的回路只存在于 legacy（`server.ts:619` 发、`handlers.ts:619-627` 收）；pi-server 全目录 grep `parentPort` / `piSettingsChanged` **0 命中**——当前默认模式下主进程监听空转，旧 `pi.*` 设置不自动迁移（台账 P6 遗留）。退役前必须先决策：补进 pi-server（经 `process.parentPort` 回发）或接受废弃并清理监听。

## 五、建议路径（三步，退役执行需用户届时授权）

1. **立即补闭环**（无论退役与否）：打包核查清单登记 `pi-server.mjs`；按清单 §9/§10 跑一次 `package:win` 冒烟并留痕。
2. **观察期**（1-2 个 dev 版本）：pi-server 默认模式下真实 Key 链路 + 打包态跑稳。
3. **退役执行**：按 §三 清单一次收口，verify + pi-web 前后端测试 + E2E 全绿后提交；同场决策 §四.4 缺口处置。

## 六、历史决策分析（为何当初自研、为何不直接用 pi-server / 全量复制上游）

用三个时间点的约束差异回答——两次决策都不错，**变的不是认知，是条件**。

### 6.1 阶段 0/1（2026-08-22）：为什么不 fork

评估期生态二选一（pi-web-ui vs pi-web-chat），且目标功能面是**有意减法**的子集（[评估 §三](./pi-web-评估.md)：「扬弃内嵌终端与 Git 面板」）；定制需求用注入即可满足，于是建立 67 锚点升级管控（评估 §七）而非 fork——评估期 fork 等于过早承诺。

### 6.2 ADR-013（2026-10-28）：为什么自研小壳而不是复制上游 server

六条当时真实存在的约束：

1. **安全审计面**：上游 server 是「以用户权限执行、含 node-pty（等价任意命令能力）、自身无鉴权」的第三方代码（评估 §二 披露）；自研壳把可审计面压到最小。全量复制 370 文件 ≈ 10 万行未审计代码 internalize 进库，当时**没有任何承接治理**（无对照库、无裁剪流程、无测试波次）。
2. **功能范围决策不同**：当时的目标是子集；「除其他引擎外全保留」（台账 R2）是后来产品诉求长出来的**范围反转**——方案跟着范围变，不是当初选错。
3. **战略上贴官方而非社区**：评估 §三「对齐官方、pi 原生事件形状透传」；M2B 落为薄 SDK 桥（agent-bridge 直接构造 vendored pi `Agent`），是对官方真实接口面的忠实响应（ADR-013 事实更正：官方并无 CBOR 自定义前端栈）。
4. **源码工作流不存在**：上游当时仅以 npm 构建产物形态存在；本地只读对照库 2026-11-08 才建立（F9）。
5. **门禁冲突未获裁决**：全量复制 = 引入非 strict、上游风格代码，与「生产级标准」（项目声明 2026-08-17）正面冲突；「pi-server 排除出 tsc/eslint」的妥协是重建时才**显式决策并登记**的。
6. **M2A 本就是去风险步骤**：ADR-013 明写「M2A 仅骨架、与阶段 1 双轨、M2C 整体退役」——先把安全壳能力（utilityProcess / token / 就绪行握手 / 静态托管）立起来，不是对终局的判断。

### 6.3 重建（2026-11-07/08）：什么条件变了

| 变化                                       | 证据                                        |
| ------------------------------------------ | ------------------------------------------- |
| 范围反转：全功能面都要                      | 台账 R2                                     |
| 镜像成本显性化：legacy 已手写 3,915 行 model-admin 镜像上游 24 条协议消息——自研追赶 = 永久跑步机 | `model-admin/dispatch.ts` 头注释             |
| 治理基建就位：对照库（F9）+ 裁剪方法论（删引擎不删功能）+ 测试波次 P0-P9 + 打包核查清单 | 台账 / 交接 / 打包核查清单                   |
| 中间形态失败的教育：apps/pi-web 旧「失败继承」被证明不可维护，倒逼干净重建 | 台账 §一                                    |
| 兼容性疑虑证伪：上游 0.118 所需 SDK API 面，vendored 1.4.0 全部具备 | 台账 §七                                    |

### 6.4 壳为什么至今不复制（R1 的另一半）

上游 server 为「独立 Node 服务」设计：无鉴权、系统 Node、固定 pipe 名。Urchin 壳里是**没有上游对应物的主权件**——token 鉴权、utilityProcess 生命周期、就绪行握手、懒加载。混合式的本质：**业务层复制+裁剪，主权层自研保留**。

## 七、决策状态与重评估触发条件

- **决策状态**：待抉择——本档仅评估，未执行任何退役动作（2026-11-09 用户指令「留作以后按需抉择」）。
- **重评估触发条件**（任一满足即可重启决策）：
  1. §五.1 打包闭环补齐且 §五.2 观察期跑稳；
  2. §四.4 piSettingsChanged 缺口完成处置决策（补回写或废弃清理）；
  3. 用户主动触发。
- 上游 pi-web-ui 的跟进/参考/复制流程不在本档，见 [pi-web-上游跟进流程](./pi-web-上游跟进流程.md)。

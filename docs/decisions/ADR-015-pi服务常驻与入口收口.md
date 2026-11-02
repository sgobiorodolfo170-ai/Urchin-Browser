# ADR-015 · pi 服务常驻与入口收口（释放 urchin://ai）

> 状态：Accepted · 决策日：2026-11-02 · 关联：[ADR-013](./ADR-013-pi阶段2自研前端与托管服务.md) PH6（生命周期/入口部分由本 ADR 取代）
> 影响范围：pi 模块服务生命周期、入口交互、协议路由命名、utility 进程内存占用
> 依据：用户指令（2026-11-02 讨论）+ [AI助手与pi切割整改报告](../AI助手与pi切割整改报告.md)（`ai.*` 命名空间已释放给未来原生 AI 助手）

## 决策

pi 托管服务（piWebHost）从「标签生命周期绑定」改为**应用级常驻守护进程**，并收口入口交互：

1. **服务常驻**：首次点 pi 按钮按需启动（`piWebHost.launch` 幂等），服务活到应用退出（`performCleanup` 调 `dispose`）。关闭 pi 聊天标签**不停服务**。
2. **删除启动器页**：移除 `urchin://ai` 启动器中间页（`PiWebLauncherView`）。点 pi 按钮 = 确保服务运行 → 直接打开 pi-web-host 托管的 `http://127.0.0.1:<port>` 聊天标签。无 toggle 关闭语义。
3. **释放 `urchin://ai`**：`urchin://ai` 协议路由不再被 pi 占用，预留给未来原生 AI 助手（与 [整改报告](../AI助手与pi切割整改报告.md) §4.1「`ai.*` 命名空间释放」对齐——设置键与 URL 路由均不再被 pi 使用）。
4. **侧栏 π 按钮状态灯**：绿(运行) / 黄(启动中) / 红(故障) / 熄灭(未启动)。无手动启停入口（服务常驻，用户不需手动控制）。
5. **origin 匹配**：标签复用与 favicon 钉定统一按 origin（protocol+host+port）匹配，根治 token 丢失 / URL 变化导致的失配。
6. **B1 懒加载**：`packages/pi-web-host/src/server.ts` 将 pi SDK（agent-bridge）、node-pty（terminal）、ssh2（ssh-client）从静态 import 改为**动态 import**，使常驻服务空闲时不加载这些重模块，压低内存。

## 取代 ADR-013 的部分

ADR-013 PH6 原定「关闭标签即停服务（对齐 dsh 语义）」。本 ADR 将 pi 改为常驻（dsh 维持不变）。理由见下。

## 候选方案与否决理由

| 方案 | 否决/采纳理由 |
| --- | --- |
| A. 生命周期跟随前端（同 dsh） | 误关标签杀掉在飞 AI 任务；每次冷启动（STARTUP_TIMEOUT_MS=60s）；不能多窗口/多 tab 共享 |
| **B. 服务常驻（采纳）** | 秒开、在飞任务不怕误关、可多 tab 共享、语义单一（点 pi = 打开）；空闲内存靠懒加载控制 |
| C. 引用计数 + 宽限期 | 自动回收但实现复杂、跨窗口边界多；当前无引用计数基础设施 |
| D. 侧栏按钮做成启停开关 | 「打开 pi」和「关后端」是两种意图，混在一个按钮最误导 |
| 启动失败兜底页 `urchin://pi` | A2 否决：彻底删启动器页，失败只弹 toast + 红灯，点 pi 重试；不引入新路由 |
| 设置页手动启停 | B2 否决：服务常驻无需手动控制；仅状态灯反映状态 |

## 后果

### 正面
- 入口语义清晰：点 pi = 打开聊天页（不再在「关聊天/关启动器」间 toggle）
- `urchin://ai` 释放给未来原生 AI 助手
- 在飞 AI 任务不怕误关标签
- 懒加载压低常驻空闲内存（pi SDK / node-pty / ssh2 不在启动时加载）

### 负面 / 待办
- 常驻服务空闲仍有 utility 进程基线开销（需实测确认；懒加载后预期 ~50-80MB）
- 无手动停止入口（用户依赖应用退出回收；如后续需要可加设置项）
- `list_models` 在前端连接时会触发 agent-bridge 加载（需要模型表）；「无标签常驻」仍保持懒加载

## 落地清单

- `apps/desktop/src/main/index.ts`：移除 pi 的 `bindTabCloseToStop`；启动恢复丢弃遗留 `urchin://ai` 标签
- `apps/desktop/src/main/protocol/index.ts`：移除 `host === 'ai'` 路由
- `apps/desktop/src/main/tabs/view-integration.ts`：从 `URCHIN_RENDERER_HOSTS` 移除 `urchin://ai`
- `apps/desktop/src/renderer/App.tsx`：重写 `handleOpenPi`（origin 匹配 + 确保运行 + 直接开标签）；删 `PiWebLauncherView` / `isAiTab` / toggle；加状态灯 + 轮询
- `apps/desktop/src/renderer/host-impl.ts`：移除 `urchin://ai` lifecycle 推导
- `packages/pi-web-host/src/server.ts`：agent-bridge / terminal / ssh-client 动态 import
- 测试：App.test / host-impl.test / protocol-index.test / view-integration.test / pi-agent-driver 更新
- `apps/desktop/src/renderer/pi-web/launcher-view.tsx`：删除

# pi-web 生态依赖引入审查与效果评估(阶段 0 留痕)

> 日期:2026-08-22 · 关联决策:用户指令「pi 模块 = 定制前端网页版 UI + pi 官方源码(可更新),前端优先直接调用 pi 原有接口;与浏览器主体隔离;现有前端入口退化为启动器」
> 依据:AGENTS.md §九 依赖引入审查(包名验证 / 版本可达性 / 许可证兼容性 / 维护度评估)

## 一、官方架构事实(vendored 0.84.2 核验)

| 包                                | 浏览器安全                             | 角色                                                                    |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `@earendil-works/pi-client`       | ✅(上游 `check:browser-smoke` CI 保证) | 官方客户端 SDK,自备 ByteTransport(WebSocket 等)                         |
| `@earendil-works/pi-protocol`     | ✅(仅依赖 typebox,零 node: 导入)       | CBOR 帧 + 消息 schema(hello / request / event / snapshot)               |
| `@earendil-works/pi-ai`(根入口)   | ✅                                     | 统一 LLM API、模型目录(`models.generated.ts` + `providers/data/*.json`) |
| `@earendil-works/pi-agent-core`   | ✅                                     | Agent 运行时、AgentEvent 流                                             |
| `@earendil-works/pi-server`       | ❌ Node                                | 传输无关 CBOR 服务(PiServer + 自实现 PiServerService)                   |
| `@earendil-works/pi-coding-agent` | ❌ Node                                | AgentSession SDK、SessionManager(JSONL 会话)、RPC 模式                  |

官方「自定义前端」路径:Node 侧 `PiServer` ↔ 浏览器侧 `PiClient`(WebSocket/Unix ByteTransport),快照权威 + `session_progress` 流式增量;配套 `RemoteSession`/transcript 视图模型。**上游标记 experimental、无兼容性承诺**——本项目 vendored 锁定版本,更新节奏由本项目控制,风险可控。

## 二、候选社区包审查

| 项          | pi-web-ui                                                                                     | pi-web-chat                                                                        |
| ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| npm 包名    | `pi-web-ui`(已验证存在于 registry)                                                            | `pi-web-chat`(已验证)                                                              |
| 版本 / 发布 | v0.47.0,2026-08-28(活跃;2026-08-29 由 0.29.1 升级并全锚点核验,见 §六A)                         | v0.1.19,2026-08-11(~3.5k 下载/月)                                                  |
| 作者 / 性质 | xingshuyin,社区(非 earendil 官方)                                                             | preinpost,社区(非官方)                                                             |
| 许可证      | MIT(与本项目兼容)                                                                             | MIT                                                                                |
| 架构        | pi SDK 进程内 + WebSocket 快照推流(60ms 节流),默认仅绑 127.0.0.1,凭据留服务端                 | Node + ws 服务,React 19 前端,默认 127.0.0.1,复用 pi CLI auth                       |
| 启动        | `npx pi-web-ui`(默认 :8787)                                                                   | `pi install npm:pi-web-chat` + `pi --web`(:3141)                                   |
| 环境要求    | Node ≥22.19 + node-pty 原生模块                                                               | pi CLI 已配置                                                                      |
| 功能面      | 模型/API Key 网页内管理、思考块、工具卡片、终端(xterm.js+node-pty)、Git 面板、主题、goal 模式 | OpenWebUI 风格:流式、markdown、工具展示、会话 fork、模型切换、图片附件、移动端适配 |
| 本机可行性  | ✅ 系统 Node v24.19.0 / npm 11.17.0                                                           | 需预装 pi CLI(未装)                                                                |

**共同风险(已向用户披露,计划批准视为知情确认)**:两者均为第三方 Node 代码,在本机以用户权限执行(pi-web-ui 含 node-pty 终端能力,等价于可执行任意命令);两者自身**无 token 鉴权**,本机其他进程理论上可访问其端口。缓解:仅绑回环 + 随机端口 + 不长期常驻;自研阶段(阶段 2)服务端内置随机 token 鉴权。

**选型结论**:demo 与阶段 1 启动器首选 **pi-web-ui**(无需预装 pi CLI、网页内即可配 Key,效果最完整);pi-web-chat 作为对照参考。

## 三、效果验证记录(阶段 0)

- 环境:Node v24.19.0、npm 11.17.0(满足 ≥22.19)
- 启动:`PORT=8917 PI_WEB_DATA_DIR=<临时目录> npx -y pi-web-ui`(独立临时数据目录,不污染用户级配置)
- 验证:HTTP 探活 + 页面加载(记录于 CHANGELOG dev.37 与提交信息)
- 评估结论(阶段 2 需求输入):
  - 保留:流式 markdown、思考折叠块、工具调用卡片、模型目录选择、API Key 网页内管理、会话持久化与恢复
  - 扬弃:内嵌终端与 Git 面板(浏览器主项目定位外的重能力,阶段 2 不做)
  - 对齐官方:`pi-client` + WebSocket 直连、快照权威状态、pi 原生事件形状透传(不手抄类型)

## 三·补、运行方式澄清与整项目 E2E(2026-08-22 用户二次决策)

> 用户澄清:此前的「仅限 Urchin 打开」表述有误——**并非要排除其他浏览器、也不与当前浏览器强绑定**;
> 真实诉求是:「运行」= 运行**整个项目**(主浏览器 + pi 模块一体),pi 模块通过 Urchin 主项目的入口直接启动,
> 而不是在应用外手动 npx 单独拉起、再拿别的浏览器去看。据此**不做**访问排除/鉴权代理类机制。

- 整项目运行链路已由 E2E 实测闭环(`tests/e2e/pi-web-launcher.spec.ts`,dev.38):
  启动真实 Electron 应用 → 左侧栏「AI 助手」→ 启动器标签页 → 点「启动 pi 网页」→
  主进程拉起 pi-web-ui 子进程 → pi 网页以标签页在 Urchin 内打开(HTTP 200)→
  关闭应用后子进程树随 performCleanup 终止(端口不可达)——与主项目同生共死。
- 顺带修复:渲染层 CSP `img-src` 增加 `http://127.0.0.1`(本机回环服务图标源),
  否则 pi 标签的 favicon 被主窗口 CSP 拦截。
- 已知事项(与本次改动无关的既有测试腐化,待另行修复):
  `perf.spec.ts` 仍指向已移除的「展开右侧栏」按钮;`tab-order-repro.spec.ts` 依赖展开态标题文本。

## 三·补二、运行体验三项改进(2026-08-22 用户三次反馈,dev.39)

1. **依赖构建期预装,运行时零下载**:pi-web-ui@0.28.2 以精确版本钉入 apps/desktop
   dependencies(pnpm install 时安装,单一真源);launcher 弃用 `npx`(会运行时下载)改为
   系统 `node <node_modules>/pi-web-ui/bin/pi-web-ui.mjs` 直启;启动超时 180s→60s。
   打包态路径经 asar swap 解析(app.asar → app.asar.unpacked),electron-builder 增加
   `asarUnpack: **/node_modules/**`(外部系统 Node 无法读取 asar 内文件,pi-web-ui 及其
   全部运行时依赖须为实体文件)。运行仍需系统 Node ≥22.19(engines 要求)。
2. **入口一键直达**:左侧栏「AI 助手」点开即启动——pi 已运行时直接开/复用 pi 网页标签;
   未运行时打开启动器页并**自动启动**(首次运行仍需先确认第三方来源说明,确认后立即启动)。
3. **一律由本浏览器打开,不弹系统默认浏览器**:pi-web-ui CLI 加 `--no-browser`
   (其启动时会自动调系统 `open` 拉起默认浏览器,这是此前「跳到系统浏览器」的根源);
   页面内 window.open/target=_blank 本就被 tab-manager 的 setWindowOpenHandler
   拦截在本浏览器内打开(当前标签/新标签,按 links.openInNewTab 设置)。

- E2E 调试中发现:第三方说明确认标记存于主窗口 localStorage,而 DD1 布局下 sessionData
  分区不随测试临时 userData 变化——说明确认状态跨测试运行保留(测试需兼容两路径)。

## 四、阶段 2 方向(已获计划批准,另立迭代实施)

自研 `apps/pi-web`(Vite+React,消费 pi 原生类型)+ `packages/pi-web-host`(Electron utilityProcess 内 vendored pi SDK `AgentSession` + WebSocket + 随机 token,数据落 `userData/pi`);同时满足 ADR-004 进程隔离与工具恢复条件。CBOR 官方栈 vs 轻量 JSON-over-WS 于开工时决策留痕。

## 五、依赖 containment 原则(2026-08-22 用户四次决策,dev.42)

> 用户原则:**pi 为本项目内模块,所有依赖随本项目构建/打包/安装,不可单独全局安装;
> 卸载本项目即同时卸载 pi。**

落实措施:

- **npm 前缀沙箱**:launcher spawn env 注入 `npm_config_prefix=<userData>/pi/npm-global`
  ——pi-web-ui 进程树内任何 `npm i -g`(如其「安装 pi agent」引导按钮,该按钮在
  auth.json 无凭据时出现,实为面向独立用户的 `npm i -g @earendil-works/pi-coding-agent`)
  都只落项目沙箱目录,系统全局不可能再被写入。
- **卸载即全卸**:electron-builder nsis `deleteAppDataOnUninstall: true`(cookies 与
  pi 全部数据在 AppData\Roaming\<app>;浏览器主数据在软件根 data/,随安装目录删除)。
- **事故记录**:dev.41→42 之间用户误点该按钮,`@earendil-works/pi-coding-agent@0.84.2`
  曾全局安装(140 包 + pi/pi.cmd/pi.ps1 命令);已 `npm uninstall -g` 并核验清零。
- **已知边界**:无 Git Bash 的机器上 pi-web-ui 会后台下载 busybox 到 `~/.pi-web/bin`
  (其 windowsBashDir 硬编码,无环境变量可覆盖;本机有 Git Bash 不触发)。根治待
  阶段 2 自研服务(届时该第三方包整体退场)。

## 六、pi-web-ui 升级核验记录(0.28.2 → 0.29.1,2026-08-22)

> 升级流程:pnpm add -E 精确钉版 → 逐项核验本项目全部注入/定制锚点在新版成立
> → 全量门禁 + pi-web E2E 全链路回归。任一锚点失效应先适配再放行。

| 锚点(本项目依赖面)                                                                 | 0.29.1 核验                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| bin/pi-web-ui.mjs 入口 + `--no-browser`                                            | 通过                                                                          |
| env PORT / PI_WEB_DATA_DIR / PI_WEB_CWD / PI_CODING_AGENT_DIR                      | 通过                                                                          |
| auth.json 形状 `{type:"api_key"}` + isPiConfigured(keys>0)                         | 通过(写入移入 modelAdmin,形状不变;另新增 clearProviderApiKey 清除凭据)        |
| DOM 类名 status-cwd / status-cwd-input / panel-projects / project-item / fp-notice | 通过(全部在)                                                                  |
| 主题键 pi-web-ui:theme / theme-change 事件 / #theme-stylesheet / pi-web-client-id  | 通过                                                                          |
| themes/light.css、favicon.svg                                                      | 通过                                                                          |
| set_cwd 等 WS 命令                                                                 | 通过(命令 50→56:新增 scm__/terminal__/start_goal_wizard/write_file 等,无删除) |
| install_pi_agent(内部 npm i -g)                                                    | 通过(仍在 → npm 前缀沙箱继续覆盖)                                             |
| 内嵌 pi SDK                                                                        | ^0.83.0 → ^0.84.2(与本项目 vendored pi 0.84.2 对齐)                           |

验证:typecheck / 938 单测全绿 / build:main / pi-web E2E 20.3s 全绿
(启动→auth占位→原生目录选择→主题亮色→删除按钮→提示抑制→退出杀进程全链路)。

## 六A、pi-web-ui 升级核验记录(0.29.1 → 0.47.0,2026-08-29,dev.71)

> 跨 18 个 minor(95 commits,21 个版本)。锚点审计结果:绝大多数存活,三类变化已适配。

| 锚点 | 0.47.0 核验 | 适配 |
| --- | --- | --- |
| 左区容器 .panel-left/.panel-projects/.panel-convs/.panel-sessions/.panel-section-title | 存活(新增 panel-conv-group 按 cwd 分组) | 无需改(:has() 接管照常) |
| 顶栏 chip.newchat / chip-sub / topbar-desktop | 存活 | 无需改 |
| 状态栏 statusbar / status-cwd / status-cwd-input / status-ctx / ctx-bar-fill | 存活 | 无需改(dir-picker/cwd 行/圆环数据链完好) |
| toast .notice/.notice-close + 文案「已切换到/已在工作目录」 | 存活 | 无需改(dev.64 抑制正则仍命中) |
| 设置弹窗 | **改为标签页布局**(.settings-rail + button.settings-tab,title=精确标签;技能/插件/界面插件/审查/视觉桥/预设为 tab) | dev.69 去重从「删节」改「删 tab」+ 激活兜底;.set-section 内容级移除保留兜底 |
| 输入框区 | **类名整体改名**:inputbox-row→(无,.inputbox 直含)、input-tools*→composer-tools*;上游原生实现 ChatGPT 式单框(模型/思考移入工具条、发送在右、下拉原生向上) | dev.51-58 结构性 hack 退役;保留视觉定制(发送反色/「+」绘制/圆环/信息栏隐藏+cwd 行),选择器映射 composer-tools-left |
| 侧栏拖拽 | **新增原生 .resize-handle**(resize-left/right,180-520 钳制,localStorage 持久化——但 pi 端口随机致跨会话失效) | dev.67 自绘分割线退役;持久化挂原生把手(pointerdown→window pointerup 延迟 120ms 读宽);宽度守护改写 .layout 的 --left-w/--right-w CSS 变量(写 aside 内联会遮蔽变量致拖拽失效,实测复现);拖拽期(body.panel-resizing)避让 |
| 折叠按钮 | 无原生等价物 | dev.67 折叠按钮保留 |
| 全局对话 | **conversations 跨项目全局广播**(switch_conversation 跨项目同步 set_cwd 全套副作用;sessions 仍按项目) | 左区面板按 c.cwd 分组归位各项目行;跨项目切对话直发;pendNew 守卫(new_chat)保留 |
| 协议消息(pi-web-client-id//ws/hello/set_cwd/new_chat/switch_conversation/switch_session/set_settings/apply_preset/delete_preset/list_*/read_file/write_file) | 全部存活,ConversationSummary 形状不变(范围语义全局化) | 无需改 |
| 新增面(本项目未接) | MCP 工具桥、界面插件系统(dataDir/plugins)、全局搜索 Ctrl+K、思考显示开关、clone_provider、终端接管 bash、上游 Electron 壳+三平台 CI | 按升级管控流程留待用户决策 |
| 内嵌 pi SDK | ^0.84.2(本项目 vendored 已同步 0.84.3,兼容) | 无需改 |

验证:typecheck / **1004 单测全绿** / build:main / pi-web E2E 全绿(启动→全局对话分组→折叠→原生把手拖拽 +120→重载宽度与排序恢复→设置弹窗 tab 去重→主题直推→图标钉定→退出杀进程)。
遗留观察:pi-agent-build/tetris E2E(需真实 API key,本地未跑)的模型下拉选择器已同步映射 composer-tools-left,待有 key 会话回归。

## 七、pi-web-ui 升级管控流程(2026-08-23 用户八次决策确立,长期有效)

> **原则:本项目对 pi 前端的定制(注入/拦截/锚点,见 §六 核验表)优先于上游迭代。
> 上游更新涉及的定制区域,未经用户逐项判断,不得改动本项目实现——防止重复建设
> 与定制丢失。本流程随本项目 pi 前端的迭代长期监控执行,任何执行者(Agent/人)必须遵守。**

### 流程(五步,缺一不可)

1. **取新版比对源**(不动本项目依赖):`npm pack pi-web-ui@<新版>` 或临时目录
   `npm i --prefix`,与当前 `node_modules/pi-web-ui` 逐项比对。
2. **锚点比对**:对照 §六 核验表逐项检查——bin 入口/`--no-browser`/四个 env/
   auth.json 形状与 isPiConfigured/五个 DOM 类名(status-cwd、status-cwd-input、
   panel-projects、project-item、fp-notice)/四个主题键/themes 目录/favicon/
   WS 命令集/update_app 行为;另比对 dd-update(更新组件)与 client-state 结构。
3. **无变化 → 默认沿用本项目迭代**:直接走 dev.46 升级流程(pnpm add -E →
   锚点核验 → 门禁+E2E 全链路 → 提交)。
4. **有变化 → 先报告后动手**:列出每个变动锚点的新旧代码位置与改动说明、
   对本项目对应定制的影响评估、建议方案(适配/保持本项目实现/部分采纳);
   **经用户明确判断后方可**修改本项目定制或放行升级。禁止未经确认合并上游
   同功能实现(防重复建设——例如上游若新增目录选择器/项目删除,须评估是否
   弃用本项目注入版,由用户定夺)。
5. **升级后验证**:锚点核验 + typecheck/lint/单测/build + pi-web E2E 全链路
   (含真实点击拦截/主题/删除确认/更新组件隐藏断言)。

### 本项目定制清单(上游变更时的受控面,2026-08-23 现状)

| 定制                           | 实现位置                                    | 依赖的上游锚点                                                              |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------- |
| 原生目录选择器                 | pi-web/dir-picker.ts + urchin://pi-pick-dir | button.status-cwd、input.status-cwd-input、set_cwd、fetch 可用              |
| 主题默认亮色                   | pi-web/page-enhance.ts(主题脚本)            | pi-web-ui:theme 键、theme-change 事件、#theme-stylesheet、/themes/light.css |
| 最近项目删除+确认+路径提示抑制 | pi-web/page-enhance.ts(面板脚本)            | panel-projects、project-item(title=路径)、fp-notice 文案                    |
| 更新组件隐藏(仅版本号)         | page-enhance 注入 CSS                       | .dd-update、.update-dot                                                     |
| auth 占位(引导抑制)            | pi-web/auth-placeholder.ts                  | auth.json 形状、isPiConfigured                                              |
| npm 沙箱/进程/数据目录         | pi-web/launcher.ts + main 接线              | bin 入口、--no-browser、四个 env                                            |
| favicon π 统一                 | urchin://pi-icon + webRequest 重定向        | /favicon.svg                                                                | .ico 路径 |

## 八、dev.48 定制追加（2026-08-23，dev.49 修订，纳入 §七 受控面长期管控）

| 定制                                                 | 实现位置                                                                                                                                        | 依赖的上游锚点                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主题完全跟随浏览器(替代默认亮色;dev.49 直推根治阻塞) | page-enhance(注入脚本暴露 __ubApplyTheme + 2s 轮询兜底) + urchin://pi-theme(主进程读 nativeTheme) + main 接线(ui.theme.set 后 pushPiTheme 直推) | pi-web-ui:theme 键、theme-change 事件、#theme-stylesheet、/themes/light.css                                                                                                                                                                                                                                                                       |
| pi 主题切换按钮删除(dev.49,替代 dev.48 隐藏)         | page-enhance(顶栏 chip-sub「主题/theme」所在 .dropdown 整体移除 + more 菜单 .dd-menu 内主题段删除,MutationObserver 重删防 React 重建)           | span.chip-sub 文本、.dropdown、.dd-menu、.dd-header                                                                                                                                                                                                                                                                                               |
| 新对话按钮移植至历史对话标题行                       | page-enhance(隐藏 chip.newchat + 注入 __ubNewChat 转发触发)                                                                                     | button.chip.newchat、.panel-sessions>.panel-section-title                                                                                                                                                                                                                                                                                         |
| pi 打开的网页图标钉定 π                              | tab-manager(piIconPinner + favicon 不覆盖) + main 接线(读实时 pi URL)                                                                           | window-open 创建路径、tab.favicon 快照字段                                                                                                                                                                                                                                                                                                        |
| 对话输入框重构(dev.51–61,ChatGPT 风格一体大框) | page-enhance 注入 CSS(.inputbar 前缀高优先级覆盖) + 顶栏增强 | .inputbox、.inputbox-row(含官方隐藏的行内 attach/actions)、.input-tools/.input-tools-left/.input-tools-right、.btn.send/.btn.stop、.btn.attach-img(背景图 + 非 ::before，27px)、.dropdown .dd-menu(向上弹)、.topbar-desktop .dropdown(模型 span.chip-model + 思考)、.statusbar(statusbar 整体隐藏)、.statusbar .status-ctx(上下文用量→__ubCtxRing 圆环)、button.status-cwd(→.__ubCwdRow 项目路径行)、prefers-color-scheme、var(--text)/var(--bg)/var(--bg-elev)/var(--bg-elev2) 主题变量 |

主题跟随危险度评估(用户要求先行,结论:低):仅外观层(样式表切换),不涉会话/
凭据/进程;失败模式=不同步(页面维持当前主题,2s 轮询兜底)无功能损失;写入值
light/null 均为官方已知值;禁用 reload(dev.47 空窗教训)。dev.49 根因留痕:
dev.48 的 300ms 延迟双步 + localStorage 前置守卫组合,在 React 重挂载改写存储
后会永久早退(DOM 与存储脱节),且纯 2s 轮询存在 ≤2s 滞后与 fetch 偶发失败——
表现为「浏览器切主题时 pi 前端主题阻塞」;修复=主进程直推 + 同步幂等 DOM 应用

- 官方存储语义(亮 setItem 'light'/暗 removeItem),守卫与延迟全部移除。

## 九、固化教训（dev.57，注入脚本字符串必须转义，防重复踩坑）

**教训**：凡以 `executeJavaScript` 注入、且把 CSS/JS 内容拼进 `st.textContent = "..."` 这类
**双引号 JS 字符串字面量**时，内容里的双引号（如 CSS `url("data:image/svg+xml,...")`）**必须转义**。
dev.55/56 曾把整段 CSS 内联 `st.textContent = "...url("data:...")..."`——`"` 提前终止字符串，
注入脚本抛 `Uncaught SyntaxError: Unexpected identifier 'data'`，面板+主题脚本全部失效、
`#__ubProjStyle` 从未创建，`#.input-tools` 回落官方宽屏 `display:none`，表象是「工具条消失」，
极易误判为「CSS 规则写错」而反复调样式（实际根源在注入源的字符串转义）。

**规避（已固化到 `page-enhance.ts`）**：

1. 注入的样本文本先抽成独立字符串变量（`const styleCss = '...'`），再用 **`JSON.stringify(styleCss)`**
   嵌入 `st.textContent`——JSON.stringify 会把内嵌 `"`、`\`、换行等全部安全转义，生成合法 JS 源。
2. 若新增含双引号/复杂字符的注入 CSS/JS，一律走该路径；禁止手工把含 `"` 的内容直接拼进
   `st.textContent = "..."`。
3. **注入类改动必须跑运行时诊断**：`_electron.launch` 抓 pi webContents 的
   `console-message`（看有无 `Uncaught SyntaxError`）+ 轮询 `#__ubProjStyle` 存在性 +
   `.input-tools` 计算 `display`——三重断言确认注入生效，而不仅是 typecheck/单测（它们只验
   生成的字符串，验不出执行期 SyntaxError）。

**排查手法**（本次定位路径）：新增 `installPiWebPageEnhance` 同款诊断脚本——
`_electron.launch` → 打开 pi 页 → `webContents.on('console-message')` 捕获 SyntaxError →
轮询 `#__ubProjStyle`（40s 不应为 false）→ 读 `.inputbar .input-tools` 计算样式 confirm flex。
凡「注入后功能莫名消失」均可先走这套诊断，别先猜样式。

## 十、pi 模块「真实用户使用场景」E2E（2026-08-27 建立，dev.62）

> 场景：模拟用户真实使用 pi 的 agent 工具——让 pi agent 在隔离目录里**完整开发一个实例小项目**，
> 并让 pi 前端**同步展示**整个过程（用户消息 → 思考 → 工具调用(建文件/跑命令) → 结果）。
> 区别于既有 pi-web-launcher E2E（只验启动链路），本场景验「agent 真干活的完整链路」。

### 1. 文件与运行方式

- `apps/desktop/tests/e2e/pi-agent-build.spec.ts`——注：需真实 provider key，**无 key 自动 skip**（非 CI 确定性）。
- 运行：`powershell` 设 `$env:OPENCODE_API_KEY=<key>` → `npx playwright test tests/e2e/pi-agent-build.spec.ts`。

### 2. 关键事实（坑与对策，长期有效）

- **key 注入**：provider=opencode-go（项目内置），模型=MiMo V2.5，endpoint=`https://opencode.ai/zen/go/v1`。
  pi 经 launcher 继承 `process.env` + vendor `env-api-keys.ts`（`opencode-go → OPENCODE_API_KEY`）读取。
  key 只经环境变量传递、**绝不落盘**（不入 auth.json、不写代码）。
- **默认模型是 kimi-k2.6（余额不足）**：pi-web-ui 默认选中列表首个模型，常为 kimi-k2.6 → 实际运行报
  `CreditsError: Insufficient balance`。对策：**显式选中 MiMo V2.5**——Radix Dropdown 需 `pointerdown`
  事件序列打开（`click` 无效），且模型列表异步加载（等 `.dd-menu .dd-model-name` 最多 ~15s）。
- **`electronApp.evaluate` 闭包不跨界**：回调会被序列化到主进程执行，**不能闭包引用测试里的变量**
  （否则 `ReferenceError: piUrl is not defined`）；URL/参数必须经 `evaluate(fn, arg)` 的 `arg` 传入。
- **发送要真实受信点击**：`wc.sendInputEvent(mouseDown/mouseUp)` 而非 `button.click()`（后者有自动化副作用，
  且 `.btn.send` 在 DOM 里有多份，须按 `getComputedStyle().display!=='none' && width>0` 取可见的那个）。
- **完成判定以磁盘为准**：agent 输出随机，前端「stop 消失/助手终稿」等启发式会误判；唯一可靠信号是
  **目标文件全部落盘**（`existsSync` 轮询）。
- **注入 JS 必须纯 JS**：`executeJavaScript` 字符串内出现 TS 的 `as` 会抛
  `Uncaught SyntaxError: Unexpected identifier 'as'`（同 §九 转义教训）。

### 3. 验收信号（机器判定）

1. pi 启动器 running + pi 页面就绪（`__ubPageEnhanceInstalled`/`__ubCwdPickerInstalled`）；
2. 前端同步展示：完整 transcript（dump 到 `<项目目录>/__pi_transcript_dump.txt`）+ 工具调用序列；
3. 真实开发成果：目标文件（如 package.json/index.js/todos.json）全部落盘，内容核验；
4. 全程 0 未捕获 console/page 报错（main + pi 双通道采集）。

### 4. 迭代场景（2026-08-27 续）

- dev.62：todo-cli —— agent 建 package.json/index.js，`node index.js add/list` 真实运行。
- dev.63：俄罗斯方块（Tetris，`pi-agent-tetris.spec.ts`）——agent 开发游戏逻辑 + `node:test` 测试 + demo 运行，
  **前端保活展示全过程**，并真实运行测试；首跑命中 agent 测试真实缺陷（off-by-one），追加修复指令后
  **8/8 全通过**。坑与对策见 dev.63 留痕（选付费精确 "MiMo V2.5" 避 Free 限额；follow-up 前须等 agent 空闲）。

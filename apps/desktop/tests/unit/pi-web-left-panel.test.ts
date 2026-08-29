/**
 * pi 左区重构注入单元测试（dev.65 建立）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 数据通道：同 clientId（pi-web-client-id）第二条 WebSocket（/ws）+ hello 握手；
 *    收 projects/conversations/sessions/settings_state/files/file_content/snapshot；
 *    发 set_cwd/new_chat/switch_conversation/switch_session/set_settings/
 *    list_files/read_file/write_file（与官方 UI 同一 ClientSession）
 * 2. 跨项目「＋」时序：set_cwd 后等 snapshot 确认 cwd 再 new_chat（防落在旧 cwd）
 * 3. 上区「项目配置」：技能/插件启停（set_settings disabled*）+ .pi 配置文件编辑
 *    （read_file/write_file + body 级编辑浮层）
 * 4. 下区「项目」：项目行（set_cwd 切换）+ 行内「＋」/「×」+ 当前项目下挂单一
 *    会话列表（dev.66 合并：switch_conversation/switch_session；会话名取第一轮
 *    提问前几字；运行中对话排最上）
 * 5. 优雅降级：面板未就绪（无 cwd）不加 __ubReady，:has() 不隐藏官方面板
 * 6. 删除确认沿用 __ubProjDelConfirm 钩子 + sessionStorage __ubHiddenProjects
 */
import { describe, it, expect } from 'vitest';
import { buildLeftPanelScript } from '../../src/main/pi-web/left-panel';

describe('buildLeftPanelScript', () => {
  it('should install with idempotent flag and self-contained lifecycle', () => {
    const s = buildLeftPanelScript();
    expect(s).toContain('__ubLeftPanelInstalled');
    // React 重挂载 aside 后由 MutationObserver 补插面板节点
    expect(s).toContain("getElementById('__ubLeftPanel')");
    expect(s).toContain('MutationObserver');
    expect(s).toContain('visibilitychange');
  });

  it('should establish a second websocket with the official client id', () => {
    const s = buildLeftPanelScript();
    expect(s).toContain("sessionStorage.getItem('pi-web-client-id')");
    expect(s).toContain("+ location.host + '/ws'");
    expect(s).toContain("type: 'hello', clientId: id");
    // 就绪后按需拉取（attachSink 自动推 conversations/settings）
    expect(s).toContain("send({ type: 'list_projects' })");
    expect(s).toContain("send({ type: 'list_sessions' })");
  });

  it('should consume official protocol broadcasts', () => {
    const s = buildLeftPanelScript();
    for (const t of [
      'projects',
      'conversations',
      'sessions',
      'settings_state',
      'files',
      'file_content',
      'snapshot',
    ]) {
      expect(s).toContain(`m.type === '${t}'`);
    }
    // snapshot flood 只做 cwd 比对；cwd 变化触发项目/会话重拉
    expect(s).toContain('cwd !== S.cwd');
  });

  it('should defer new_chat until set_cwd is confirmed by snapshot (cross-project +)', () => {
    const s = buildLeftPanelScript();
    // 非当前项目：先 set_cwd + 记录 pendNew；snapshot 确认后才 new_chat
    expect(s).toContain(
      "S.pendNew = v; S.pendNewAt = Date.now(); send({ type: 'set_cwd', path: v })",
    );
    expect(s).toContain('S.pendNew === cwd');
    // 当前项目：直接 new_chat
    expect(s).toContain("if (v === S.cwd) send({ type: 'new_chat' })");
    // 8s 未确认放弃（服务端另有错误 notice 兜底）
    expect(s).toContain('8000');
  });

  it('should manage config zone via official settings/files endpoints', () => {
    const s = buildLeftPanelScript();
    // 技能/插件启停走 set_settings（disabled 数组整体回传）
    expect(s).toContain("type: 'set_settings', disabledSkills:");
    expect(s).toContain("type: 'set_settings', disabledExtensions:");
    // .pi 配置文件：惰性 list_files（避免重置服务端文件监视目录）+ 读/写
    expect(s).toContain("type: 'list_files', path: '.pi'");
    expect(s).toContain("type: 'read_file', path: v");
    expect(s).toContain("type: 'write_file'");
    // 编辑浮层挂在 body（render 重建面板不波及），二进制禁编
    expect(s).toContain('__ubLPEditor');
    expect(s).toContain('不支持编辑');
    expect(s).toContain('ta.disabled = !!m.binary');
  });

  it('should render project rows with switch/new-chat and nested conversations', () => {
    const s = buildLeftPanelScript();
    // 项目行：切换 + 行内「＋」（dev.68 起「×」删除按钮已移除）
    expect(s).toContain('data-act="proj"');
    expect(s).toContain('data-act="newchat"');
    expect(s).toContain("send({ type: 'set_cwd', path: v })");
    // 当前项目下挂：运行对话 + 历史会话（同一列表）
    expect(s).toContain('data-act="conv"');
    expect(s).toContain("send({ type: 'switch_conversation', id: Number(v) })");
    expect(s).toContain('data-act="sess"');
    expect(s).toContain("send({ type: 'switch_session', path: v })");
  });

  it('should group global conversations under their own project rows (dev.71)', () => {
    const s = buildLeftPanelScript();
    // 0.47.0 conversations 跨项目全局广播 → 按 c.cwd 归位到各项目行
    expect(s).toContain('c.cwd === p.path');
    // 跨项目对话直发 switch_conversation（服务端同步 cwd），无 set_cwd 前置
    expect(s).toContain("send({ type: 'switch_conversation', id: Number(v) })");
    // 历史会话仍仅当前项目（上游 sessions 未全局化）
    expect(s).toContain('var sess = act ? S.sessions.slice(0, 50) : [];');
  });

  it('should merge conversations and history into one list named by first prompt (dev.66)', () => {
    const s = buildLeftPanelScript();
    // 会话名统一取第一轮提问前几字（30 字截断 + 空白规范化）
    expect(s).toContain('function sessName(');
    expect(s).toContain('SESS_NAME_MAX = 30');
    // 历史会话 firstMessage 优先于自定义 name；运行对话用 title
    //（服务端 conversationTitle 已按首个 user 消息生成）
    expect(s).toContain('sessName(ss.firstMessage || ss.name)');
    expect(s).toContain('sessName(c.title)');
    // 运行中对话排最上：isStreaming 优先，其余保持服务端顺序
    expect(s).toContain('(b.isStreaming ? 1 : 0) - (a.isStreaming ? 1 : 0)');
    // 不再分「对话/历史」两组：无分组小标题
    expect(s).not.toContain('__ubLPMini');
    expect(s).not.toContain('__ubLPMini">对话');
    // 运行行视觉区分：__ubLPRunning 样式
    expect(s).toContain('__ubLPRunning');
  });

  it('should take over from first frame with skeleton and degrade on timeout (dev.68)', () => {
    const s = buildLeftPanelScript();
    // zone 创建即 __ubOn 接管 + 骨架（配合 dom-ready 注入，官方旧 UI 零闪现）
    expect(s).toContain("'__ubLP __ubOn'");
    expect(s).toContain('function skeleton(');
    expect(s).toContain('左区加载中');
    // 6s 未就绪撤下接管降级回官方面板；数据到达重新接管
    expect(s).toContain('TAKEOVER_TIMEOUT_MS = 6000');
    expect(s).toContain("classList.remove('__ubOn')");
    expect(s).toContain("classList.add('__ubOn')");
    // 隐藏规则挂在 __ubOn（__ubReady 仅数据就绪标记）
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubOn)>.panel-projects');
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubOn)>.panel-convs');
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubOn)>.panel-sessions');
    expect(s).toContain("classList.add('__ubReady')");
  });

  it('should have fold toggle before new-chat and no project delete button (dev.68)', () => {
    const s = buildLeftPanelScript();
    // 「＋」前的 ▾/▸ 会话折叠按钮（默认展开，sessionStorage 记忆）
    expect(s).toContain('data-act="fold"');
    expect(s).toContain('__ubFoldBtn');
    expect(s).toContain("var FOLD_KEY = '__ubFoldedProjs'");
    expect(s).toContain('function toggleFold(');
    expect(s).toContain('if (!fold) {');
    // 项目行删除按钮已按用户要求移除（预设的小 × 属独立 data-act）
    expect(s).not.toContain('data-act="del"');
    expect(s).not.toContain('从列表移除该项目');
    expect(s).not.toContain('__ubProjDelConfirm');
  });

  it('should surface commands, presets and review skills in config zone (dev.68)', () => {
    const s = buildLeftPanelScript();
    // 命令目录：slash_commands 广播 → 只读列表（含来源标签）
    expect(s).toContain("m.type === 'slash_commands'");
    expect(s).toContain("cfgRow('cmds', '命令'");
    expect(s).toContain('__ubLPSrc');
    // 预设：点击应用 / × 删除（保存入口在官方设置弹窗）
    expect(s).toContain("cfgRow('presets', '预设'");
    expect(s).toContain("type: 'apply_preset', name: v");
    expect(s).toContain("type: 'delete_preset', name: v");
    expect(s).toContain('data-act="delpreset"');
    // 审查技能：技能小节内第二组开关（reviewDisabledSkills）
    expect(s).toContain('data-act="rskill"');
    expect(s).toContain('reviewDisabledSkills');
    expect(s).toContain('审查技能');
  });

  it('should order projects by persisted order with manual drag support (dev.67)', () => {
    const s = buildLeftPanelScript();
    // 排序消费 window.__ubPiUI.state.po；未加载时维持服务端顺序
    expect(s).toContain('function orderedProjects(');
    expect(s).toContain('window.__ubPiUI');
    expect(s).toContain('if (!ui || !ui.loaded) return list');
    // 新项目首见追加（≈创建顺序），并存回 po
    expect(s).toContain('unseen.forEach(function (p) { merged.push(p.path); })');
    // 拖拽排序：行 draggable + dragstart/dragover/drop 委托 + __reorder 持久化
    expect(s).toContain('draggable="true"');
    expect(s).toContain("addEventListener('dragstart', onDragStart)");
    expect(s).toContain("addEventListener('drop', onDrop)");
    expect(s).toContain('ui.__reorder(dragPath, before)');
    // 落点指示样式
    expect(s).toContain('__ubDropBefore');
    expect(s).toContain('__ubDropAfter');
    // 布局状态就绪/排序变化 → 重渲染
    expect(s).toContain("'__ubPiUIReady'");
    expect(s).toContain("'__ubPiUIOrder'");
  });

  it('should keep legacy hidden-set semantics for stale entries', () => {
    const s = buildLeftPanelScript();
    // 项目删除按钮已移除（dev.68），但旧隐藏数据仍生效于渲染过滤
    expect(s).toContain('__ubHiddenProjects');
    expect(s).toContain('window.confirm');
  });

  it('should escape html in rendered values (injected innerHTML safety)', () => {
    const s = buildLeftPanelScript();
    expect(s).toContain('function esc(');
    expect(s).toContain('&amp;');
    expect(s).toContain('&#39;');
  });
});

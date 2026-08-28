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

  it('should render project rows with switch/new-chat/delete and nested conversations', () => {
    const s = buildLeftPanelScript();
    // 项目行：切换 + 行内「＋」「×」
    expect(s).toContain('data-act="proj"');
    expect(s).toContain('data-act="newchat"');
    expect(s).toContain('data-act="del"');
    expect(s).toContain("send({ type: 'set_cwd', path: v })");
    // 当前项目下挂：运行对话 + 历史会话（同一列表）
    expect(s).toContain('data-act="conv"');
    expect(s).toContain("send({ type: 'switch_conversation', id: Number(v) })");
    expect(s).toContain('data-act="sess"');
    expect(s).toContain("send({ type: 'switch_session', path: v })");
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

  it('should degrade gracefully until the panel is ready', () => {
    const s = buildLeftPanelScript();
    // 未拿到 cwd 不加 __ubReady；官方面板仅在就绪后被 :has() 隐藏
    expect(s).toContain("classList.remove('__ubReady')");
    expect(s).toContain("classList.add('__ubReady')");
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubReady)>.panel-projects');
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubReady)>.panel-convs');
    expect(s).toContain('.panel-left:has(>.__ubLP.__ubReady)>.panel-sessions');
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

  it('should keep dev.45/47 delete-confirm hook and hidden-set semantics', () => {
    const s = buildLeftPanelScript();
    expect(s).toContain('__ubProjDelConfirm');
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

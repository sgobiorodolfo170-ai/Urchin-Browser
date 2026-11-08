/**
 * plan-mode.ts 单元测试
 *
 * 覆盖计划模式的只读 bash 白名单、工具拒绝对应关系（写工具 / 旁路工具 /
 * 终端写向工具）、活跃集剥离名单、终端 schema 收窄与恢复、系统提示词与通知文案。
 *
 * 为何 bash 白名单要「先判语法再判命令」：`$(...)`、反引号、`>`、`<<`、`&`
 * 都能在看似只读的命令里执行副作用；先按语法拒绝无法静态判定的输入，
 * 才能避免「白名单里的命令 + 命令替换」绕过只读约束。
 */
import { describe, expect, it } from 'vitest';
import {
  bashCommandHasSupportedSyntax,
  bashCommandIsReadOnly,
  buildPlanModePrompt,
  planModeDenial,
  planModeNoticeText,
  PLAN_MODE_BLOCKED_TOOL_NAMES,
  PLAN_MODE_SYSTEM_PROMPT,
  readOnlyToolCallAllowed,
  restrictTerminalToolToReadOnly,
  syncTerminalReadOnlySchema,
} from '../../src/pi-server/plan-mode.js';

describe('merged terminal', () => {
  it('should allow only read actions and restore the original schema afterwards', () => {
    for (const action of ['list', 'read', 'wait'])
      expect(planModeDenial('terminal', { action })).toBeUndefined();
    for (const action of ['create', 'close', 'input', 'key', '', 'unknown'])
      expect(planModeDenial('terminal', { action, command: 'pwd' })).toBeDefined();
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('terminal')).toBe(false);

    const parameters = {
      type: 'object',
      properties: { action: { enum: ['create', 'list', 'close', 'input', 'key', 'read', 'wait'] } },
    };
    const tool = { parameters };
    const session = { _toolRegistry: new Map([['terminal', tool]]) };
    syncTerminalReadOnlySchema(session, true);
    syncTerminalReadOnlySchema(session, true);
    expect(tool.parameters.properties.action.enum.slice()).toEqual(['list', 'read', 'wait']);
    syncTerminalReadOnlySchema(session, false);
    expect(tool.parameters).toBe(parameters);
  });

  it('should narrow the terminal schema without mutating the source object', () => {
    const parameters = { type: 'object', properties: { action: { enum: ['create', 'read'] } } };
    const narrowed = restrictTerminalToolToReadOnly({ parameters });
    expect(narrowed.parameters.properties.action.enum).toEqual(['list', 'read', 'wait']);
    expect(parameters.properties.action.enum).toEqual(['create', 'read']);
  });

  it('should ignore sessions without a terminal tool or registry', () => {
    expect(() => syncTerminalReadOnlySchema({}, true)).not.toThrow();
    const session = { _toolRegistry: new Map<string, unknown>() };
    syncTerminalReadOnlySchema(session, true);
    expect(session._toolRegistry.size).toBe(0);
  });
});

describe('bashCommandIsReadOnly', () => {
  it('should allow read-only commands', () => {
    for (const cmd of [
      'ls -la',
      'cat server/index.ts',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'rg -n set_plan_mode server',
      'grep -rn foo . | head -20',
      'wc -l server/index.ts',
      'jq .name package.json',
      "find . -name '*.ts' -newer package.json",
      'node --version',
      'pwd && ls',
      'cat a.txt | grep x | wc -l',
      "rg --glob '*.ts' --max-count=3 'hello world' server",
      'git --no-pager diff --name-only',
      "find . -name '*.ts' -maxdepth 3 -print",
      'git describe --tags --always',
      'git rev-parse --show-toplevel',
      'git ls-files --cached',
      'git cat-file -p HEAD',
      'git blame -L 1,10 file.ts',
      'stat -c %s file',
      'du -sh node_modules',
      'df -h',
      'basename /a/b.txt',
      'dirname /a/b.txt',
      'uname -a',
      'whoami',
      'printenv',
      'md5sum f',
      'sha256sum f',
      'cut -d , -f 1 f.csv',
      'realpath ./x',
      'readlink -f x',
      'head -n 20 f',
      'tail -20 f',
      'python3 -V',
    ]) {
      expect(bashCommandIsReadOnly(cmd), cmd).toBe(true);
    }
  });

  it('should reject write operations and command substitution', () => {
    for (const cmd of [
      '',
      'rm -rf dist',
      'mkdir -p out',
      'git commit -m x',
      'git push',
      'npm install',
      'npm run build',
      'node -e \'require("fs").rmSync("x")\'',
      'echo hi > out.txt',
      'cat f | tee g',
      "sed -i 's/a/b/' f.ts",
      'awk \'{print > "f"}\'',
      "find . -name '*.log' -delete",
      'find . -exec touch pwned {} +',
      "find . -name '*.tmp' -execdir rm {} \\;",
      'find . -fprintf /tmp/pwn x',
      'ls $(git rev-parse HEAD)',
      'sleep 5 &',
      'cat <<EOF',
      'python3 script.py',
      'python -v',
      'python3 -v',
    ]) {
      expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
    }
  });

  it('should reject unsupported syntax and command capabilities, not just known payloads', () => {
    for (const cmd of [
      'ls "$(touch pwned)"',
      'cat "`touch pwned`"',
      'ls & touch pwned & pwd',
      'ls &&',
      '| ls',
      'ls || || pwd',
      "ls 'unfinished",
      'ls \\\n&& pwd',
      'ls # comment',
      'ls (pwd)',
      'env ls',
      'command ls',
      'nohup ls',
      'time ls',
      'PATH=evil ls',
      'rg * foo .',
      'git log *',
      'wc -l *.ts',
      'LC_ALL=C sort f.txt',
      '/tmp/ls x',
      'awk \'BEGIN { system("touch x") }\'',
      "sed '1e touch x' f",
      "sed -n '1w x' f",
      'sort -o output input',
      'uniq input output',
      'fd -x touch x',
      'fd --exec=touch x',
      'rg --pre=touch foo .',
      'rg --hostname-bin touch foo',
      "yq -i '.a=1' f",
      'git diff --output=x',
      'git log --output x',
      'git -c core.pager=touch log',
      'git --exec-path=/tmp status',
      'git show --ext-diff',
      'git grep --open-files-in-pager=touch foo',
      'git cat-file --filters HEAD:f',
      'find . -fprint x',
      'jq -L /tmp \'include "evil"\' f',
      "jq 'input' f",
      'rg --new-side-effect-option foo',
      'ls --unknown-option',
    ])
      expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
  });

  it('should reject the whole command when any segment writes', () => {
    expect(bashCommandIsReadOnly('ls && rm -rf /')).toBe(false);
    expect(bashCommandIsReadOnly('git status; git push')).toBe(false);
    expect(bashCommandIsReadOnly('cat f | tee g')).toBe(false);
  });

  it('should handle quoted operators and numeric short values inside read-only commands', () => {
    expect(bashCommandIsReadOnly('grep "a|b" f.txt')).toBe(true);
    expect(bashCommandIsReadOnly("grep 'a && b' f.txt")).toBe(true);
    expect(bashCommandIsReadOnly('head -10 f')).toBe(true);
    expect(bashCommandIsReadOnly('head -n -5 f')).toBe(false);
    expect(bashCommandIsReadOnly('git log -n 5')).toBe(true);
    expect(bashCommandIsReadOnly('git log -5')).toBe(true);
  });
});

describe('bashCommandHasSupportedSyntax', () => {
  it('should accept simple pipelines and reject empty, redirection and control characters', () => {
    expect(bashCommandHasSupportedSyntax('ls | wc -l')).toBe(true);
    expect(bashCommandHasSupportedSyntax('  ')).toBe(false);
    expect(bashCommandHasSupportedSyntax('ls > x')).toBe(false);
    expect(bashCommandHasSupportedSyntax('ls\u0000')).toBe(false);
    expect(bashCommandHasSupportedSyntax('ls ~')).toBe(false);
  });
});

describe('planModeDenial', () => {
  it('should allow read-only tools', () => {
    for (const t of [
      'read',
      'grep',
      'ls',
      'plan_update',
      'present_files',
      'scm',
      'conversation_read',
      'skill',
    ]) {
      expect(planModeDenial(t, {}), t).toBeUndefined();
    }
  });

  it('should fail closed for unknown tools and action tools while retaining query entry points', () => {
    for (const [name, params] of [
      ['plugin_delete', {}],
      ['mcp_write', {}],
      ['', {}],
      ['notes', { op: 'note_add' }],
      ['canvas', { action: 'run_all' }],
      ['worktree', { action: 'create' }],
      ['browser_page', { op: 'eval' }],
      ['browser_page', { op: 'click' }],
      ['remote_term', { action: 'run', cmd: 'ls' }],
      ['skill', { action: 'unknown' }],
      ['scm', { action: 'commit' }],
      ['lsp', { action: 'rename' }],
    ] as const)
      expect(planModeDenial(name, params), name).toBeDefined();
    for (const [name, params] of [
      ['load_tools', {}],
      ['tool_search', {}],
      ['ask_user_question', {}],
      ['notes', { op: 'list' }],
      ['canvas', { action: 'get' }],
      ['worktree', { action: 'list' }],
      ['browser_page', { op: 'read' }],
      ['skill', { action: 'list' }],
      ['lsp', { action: 'references' }],
      ['terminal_wait', {}],
      ['claim_files', { action: 'list' }],
    ] as const)
      expect(planModeDenial(name, params), name).toBeUndefined();
  });

  it('should reject write tools and point at the planning alternative', () => {
    const d = planModeDenial('write', { path: 'a.ts', content: 'x' });
    expect(d?.kind).toBe('write-tool');
    expect(d?.reason).toContain('plan_update');
    expect(d?.reasonEn).toContain('Plan mode');
    expect(planModeDenial('edit_soft', {})?.kind).toBe('write-tool');
    expect(planModeDenial('patch', {})?.kind).toBe('write-tool');
    expect(planModeDenial('git', { command: 'commit' })?.kind).toBe('write-tool');
    expect(planModeDenial('eval', { code: "require('fs').writeFileSync('x','y')" })?.kind).toBe(
      'write-tool',
    );
    expect(
      planModeDenial('codemode', { code: "tools.write({ path: 'a.txt', content: 'x' })" })?.kind,
    ).toBe('write-tool');
  });

  it('should only allow read-only bash commands', () => {
    expect(planModeDenial('bash', { command: 'git diff' })).toBeUndefined();
    const d = planModeDenial('bash', { command: 'npm run build' });
    expect(d?.kind).toBe('bash');
    expect(d?.reasonEn).toContain('read-only');
    expect(planModeDenial('bash', {})?.kind).toBe('bash');
    expect(planModeDenial('bash', { cmd: 'ls' })).toBeUndefined();
    expect(planModeDenial('bash', { script: 'ls' })).toBeUndefined();
    expect(planModeDenial('bash', { input: 'ls' })).toBeUndefined();
  });

  it('should reject bypass tools because they run outside this conversation', () => {
    expect(planModeDenial('delegate_task', {})?.kind).toBe('bypass-tool');
    expect(planModeDenial('schedule', {})?.kind).toBe('bypass-tool');
  });

  it('should allow only read-only subagent actions and reject every write action', () => {
    for (const readonly of ['get_result', 'list', 'templates']) {
      expect(planModeDenial('subagent', { action: readonly }), readonly).toBeUndefined();
    }
    for (const action of ['spawn', 'steer', 'stop', 'wait_all', 'handoff', 'erase']) {
      const d = planModeDenial('subagent', { action });
      expect(d, action).toBeDefined();
      expect(d!.kind).toBe('bypass-tool');
    }
    expect(planModeDenial('subagent', { action: '' })?.kind).toBe('bypass-tool');
    expect(planModeDenial('subagent', {})?.kind).toBe('bypass-tool');
    expect(planModeDenial('subagent', undefined)?.kind).toBe('bypass-tool');
  });

  it('should reject resident terminal write tools (terminal_input/terminal_key)', () => {
    for (const [name, params] of [
      ['terminal_input', { terminalId: 't1', data: 'rm -rf dist' }],
      ['terminal_input', { terminalId: 't1', data: 'y' }],
      ['terminal_key', { terminalId: 't1', key: 'Enter' }],
    ] as const) {
      const d = planModeDenial(name, params);
      expect(d, name).toBeDefined();
      expect(d!.kind).toBe('write-tool');
      expect(d!.reasonEn).toContain('Plan mode');
    }
  });

  it('should trim the tool name and explain both languages', () => {
    const d = planModeDenial('  write  ', {});
    expect(d?.kind).toBe('write-tool');
    expect(d?.reason.length).toBeGreaterThan(0);
    expect(d?.reasonEn.length).toBeGreaterThan(0);
  });

  it('should tolerate a missing tool name by failing closed', () => {
    expect(planModeDenial(undefined as unknown as string, {})?.kind).toBe('write-tool');
    expect(planModeDenial('   ', {})?.kind).toBe('write-tool');
  });
});

describe('readOnlyToolCallAllowed', () => {
  it('should gate action-based tools on their read-only actions', () => {
    expect(readOnlyToolCallAllowed('terminal', { action: 'read' })).toBe(true);
    expect(readOnlyToolCallAllowed('terminal', { action: 'input' })).toBe(false);
    expect(readOnlyToolCallAllowed('notes', { op: 'list' })).toBe(true);
    expect(readOnlyToolCallAllowed('notes', {})).toBe(false);
    expect(readOnlyToolCallAllowed('remote_term', { action: 'list' })).toBe(true);
    expect(readOnlyToolCallAllowed('remote_term', { action: 'run' })).toBe(false);
    expect(readOnlyToolCallAllowed('browser_page', { op: 'shot' })).toBe(true);
    expect(readOnlyToolCallAllowed('browser_page', { op: 'eval' })).toBe(false);
    expect(readOnlyToolCallAllowed('lsp', { action: 'cascade' })).toBe(true);
    expect(readOnlyToolCallAllowed('unknown_tool', {})).toBe(false);
  });

  it('should treat conversation tools by their read-only action list', () => {
    expect(readOnlyToolCallAllowed('conversation', { action: 'status' })).toBe(true);
    expect(readOnlyToolCallAllowed('conversation', { action: 'fork' })).toBe(false);
  });

  it('should treat non-object params as an empty parameter bag', () => {
    expect(readOnlyToolCallAllowed('terminal', null)).toBe(false);
    expect(readOnlyToolCallAllowed('read', undefined)).toBe(true);
    expect(readOnlyToolCallAllowed('skill', null)).toBe(true);
  });
});

describe('PLAN_MODE_BLOCKED_TOOL_NAMES', () => {
  it('should strip terminal write tools but keep read/list/wait', () => {
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('terminal_input')).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('terminal_key')).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('codemode')).toBe(true);
    for (const readonly of ['terminal_read', 'terminal_list', 'terminal_wait', 'read', 'grep']) {
      expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(readonly), readonly).toBe(false);
    }
  });

  it('should strip eval', () => {
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('eval')).toBe(true);
  });

  it('should no longer list ghost names while listing real bypass tools', () => {
    for (const ghost of [
      'spawn',
      'spawn_agent',
      'subagent_spawn',
      'schedule_agent',
      'host_schedule',
      'create_goal',
      'set_goal',
      'start_goal_wizard',
      'create_conversation',
      'fork_conversation',
      'set_plan_mode',
    ]) {
      expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(ghost), ghost).toBe(false);
    }
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('delegate_task')).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has('schedule')).toBe(true);
  });
});

describe('PLAN_MODE_SYSTEM_PROMPT', () => {
  it('should be pure English and carry the key constraints', () => {
    expect(/[\u4e00-\u9fff]/.test(PLAN_MODE_SYSTEM_PROMPT)).toBe(false);
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('plan_update');
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('do NOT implement');
  });

  it('should forbid dumping implementation code into the reply', () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('NEVER write the implementation');
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('No file dumps');
  });

  it('should allow skipping plan_update for small requests', () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('skip plan_update entirely');
  });
});

describe('buildPlanModePrompt', () => {
  it('should return the built-in default for empty custom text in both modes', () => {
    expect(buildPlanModePrompt('append', '')).toBe(PLAN_MODE_SYSTEM_PROMPT);
    expect(buildPlanModePrompt('replace', '   ')).toBe(PLAN_MODE_SYSTEM_PROMPT);
  });

  it('should append custom text after a blank line in append mode', () => {
    expect(buildPlanModePrompt('append', 'extra')).toBe(`${PLAN_MODE_SYSTEM_PROMPT}\n\nextra`);
  });

  it('should send only the custom text in replace mode', () => {
    expect(buildPlanModePrompt('replace', 'only this')).toBe('only this');
  });

  it('should tolerate an absent custom template string', () => {
    expect(buildPlanModePrompt('append', undefined as unknown as string)).toBe(
      PLAN_MODE_SYSTEM_PROMPT,
    );
    expect(buildPlanModePrompt('replace', undefined as unknown as string)).toBe(
      PLAN_MODE_SYSTEM_PROMPT,
    );
  });
});

describe('planModeNoticeText', () => {
  it('should announce both states in Chinese and English', () => {
    const on = planModeNoticeText(true);
    expect(on.text).toContain('计划模式');
    expect(on.textEn).toContain('Plan mode on');
    const off = planModeNoticeText(false);
    expect(off.text).toContain('计划模式已关闭');
    expect(off.textEn).toContain('Plan mode off');
  });
});

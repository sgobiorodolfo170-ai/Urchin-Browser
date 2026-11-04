/**
 * 设置页 React 组件（多选项卡布局）
 *
 * 设计：
 * - 左侧选项卡导航，右侧内容区
 * - 自动保存：字段变更后立即写入（debounce 800ms，与主流浏览器设置页对齐）
 * - 选项卡：通用 / 操作 / AI 助手 / 数据 / 默认应用 / 帮助手册 / 隐私与安全 / 建议与反馈 / 关于
 *
 * 通过主窗口已有的 window.urchin.invoke('settings.*') 读写设置。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { getCurrentWindowId } from '../lib/current-window';
import { displayNameForLocale } from '../../shared/brand';
import { useSettings } from './use-settings';
import { SettingsSection, type SettingField } from './settings-form';

// 类型定义（FieldType/SettingField/ProfileApi 等）与共享表单机件
// （SettingsSection/FieldControl/ProfileSelect/toStr）在 ./settings-form

/** 选项卡定义 */
type TabKey =
  | 'general'
  | 'clipper'
  | 'ops'
  | 'ai'
  | 'data'
  | 'privacy'
  | 'files'
  | 'help'
  | 'feedback'
  | 'about';

interface TabDef {
  readonly key: TabKey;
  readonly label: string;
}

const TABS: readonly TabDef[] = [
  { key: 'general', label: '通用' },
  { key: 'clipper', label: '剪藏' },
  { key: 'ops', label: '操作' },
  { key: 'ai', label: 'AI 助手' },
  { key: 'data', label: '数据' },
  { key: 'files', label: '默认应用' },
  { key: 'help', label: '帮助手册' },
  { key: 'privacy', label: '隐私与安全' },
  { key: 'feedback', label: '建议与反馈' },
  { key: 'about', label: '关于' },
];

// ───────────────── 设置项分组（按选项卡组织） ─────────────────

const GENERAL_FIELDS: readonly SettingField[] = [
  {
    key: 'language',
    label: '界面语言',
    desc: '应用界面显示语言（默认中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en-US', label: 'English' },
    ],
  },
  {
    key: 'searchEngine',
    label: '搜索引擎',
    desc: '地址栏搜索使用的引擎（与 parse-input 的 SEARCH_ENGINE_TEMPLATES 表对应）',
    type: 'select',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
      { value: 'baidu', label: '百度' },
      { value: 'duckduckgo', label: 'DuckDuckGo' },
      { value: 'sogou', label: '搜狗' },
      { value: 'so360', label: '360 搜索' },
    ],
  },
  {
    key: 'links.openInNewTab',
    label: '在新标签页打开链接',
    desc: '点击网页内链接时在新标签页打开（关闭则在当前标签页打开）',
    type: 'toggle',
  },
  {
    key: 'startup.restoreTabs',
    label: '启动时继续浏览上次打开的网页',
    desc: '关闭浏览器时保存当前打开的标签页，下次启动时自动恢复默认工作区的标签；其他工作区的标签在切换到该工作区时自动恢复',
    type: 'toggle',
  },
  {
    key: 'translate.targetLang',
    label: '网页翻译目标语言',
    desc: '整页翻译与划词翻译的目标语言（默认简体中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'zh-TW', label: '繁體中文' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
      { value: 'fr', label: 'Français' },
      { value: 'de', label: 'Deutsch' },
      { value: 'ru', label: 'Русский' },
      { value: 'es', label: 'Español' },
    ],
  },
  {
    key: 'translate.engine',
    label: '翻译引擎',
    desc: '自动（推荐）：直连网络优先 MyMemory 翻译、走代理优先谷歌翻译，引擎失败自动切换至其他可用引擎（三引擎互为兜底）；也可手动锁定单一引擎。注：微软免费端点已于 2026-09 关闭，保留选项但可能不可用',
    type: 'select',
    options: [
      { value: 'auto', label: '自动（推荐）' },
      { value: 'mymemory', label: 'MyMemory 翻译（国内直连可用）' },
      { value: 'google', label: '谷歌翻译（需代理）' },
      { value: 'microsoft', label: '微软翻译（端点已关闭，可能不可用）' },
    ],
  },
  {
    key: 'translate.autoTranslate',
    label: '自动翻译外语页面',
    desc: '开启后打开外语网页时自动翻译为目标语言（默认关闭）。隐私提示：翻译时页面文本将发送至所选翻译服务（微软/谷歌）；关闭时仅在手动点击翻译后发送',
    type: 'toggle',
  },
];

const OPS_FIELDS: readonly SettingField[] = [
  {
    key: 'ui.rightSidebarAutoExpand',
    label: '右侧边栏展开方式',
    desc: '切换展开方式：双击展开（默认）/ 悬停自动展开。开启=悬停自动展开，关闭=双击展开',
    type: 'select',
    options: [
      { value: 'false', label: '双击展开' },
      { value: 'true', label: '悬停自动展开' },
    ],
  },
  {
    key: 'ui.leftSidebarAutoExpand',
    label: '左侧边栏悬停自动展开',
    desc: '开启后，左侧栏折叠时鼠标停留即可自动展开（默认开启）；双击左侧栏空白处始终可展开/折叠。',
    type: 'toggle',
  },
  {
    key: 'debug.sidebarHoverDelay',
    label: '侧边栏悬停展开延迟',
    desc: '右侧栏折叠时，鼠标停留多久后自动展开（毫秒，0 = 立即展开，范围 0–3000）。仅在「展开方式=悬停自动展开」时生效',
    type: 'number',
    min: 0,
    max: 3000,
    step: 50,
    unit: 'ms',
  },
  {
    key: 'ui.workspaceSwitcherMode',
    label: '折叠态工作区切换',
    desc: '右侧栏折叠时切换工作区的方式：滚轮循环切换（默认）或点击图标打开工作区总览页（卡片 + 网页快照，参考 ego-lite Space 设计）；展开态选项条不受影响',
    type: 'select',
    options: [
      { value: 'wheel', label: '滚轮循环切换' },
      { value: 'cards', label: '点击卡片' },
    ],
  },
];

const CLIPPER_FIELDS: readonly SettingField[] = [
  {
    key: 'clipper.defaultFormat',
    label: '默认保存格式',
    desc: '打开剪藏面板时预选的格式。MHTML/PDF/截图用于图文网页存档；OCR 暂未实现',
    type: 'select',
    options: [
      { value: 'markdown', label: 'Markdown（可编辑）' },
      { value: 'mhtml', label: 'MHTML（图文整页）' },
      { value: 'pdf', label: 'PDF（打印版）' },
      { value: 'screenshot', label: '截图（整页 PNG）' },
    ],
  },
  {
    key: 'clipper.cleanSnapshot',
    label: '快照默认正文清洗',
    desc: 'MHTML/PDF/截图默认使用 Defuddle 正文重新排版，去掉广告、导航、侧栏等；关闭则保留原页版式',
    type: 'toggle',
  },
  {
    key: 'clipper.selectionPriority',
    label: '优先剪藏选中内容',
    desc: 'Markdown 剪藏时，如果页面有选中文本则优先使用选中内容；可在面板中临时切换',
    type: 'toggle',
  },
  {
    key: 'clipper.loadLazyContent',
    label: '快照前滚动加载懒加载内容',
    desc: '快照格式保存前先分步滚动页面，尽量加载懒加载图片（最多 20 步，可能较慢）',
    type: 'toggle',
  },
  {
    key: 'clipper.trimBoilerplate',
    label: '剪除正文末尾信息栏',
    desc: '自动去掉正文末尾的「来源：/作者：/评论：/责编：」等中文信息栏短行（只剪末尾连续短行，不动正文中间的合法引用）',
    type: 'toggle',
  },
  {
    key: 'clipper.localizeImages',
    label: 'Markdown 剪藏时下载图片到本地',
    desc: '剪藏为 Markdown 时把远程图片下载到 assets/ 目录，md 中改为本地相对路径。下载失败的图片保留原链接。需 GenOffice 编辑器可用',
    type: 'toggle',
  },
  {
    key: 'clipper.noteNameFormat',
    label: '文件名模板',
    desc: '支持 {{title}} / {{date}} / {{domain}} 等变量；最终文件名由主进程净化',
    type: 'text',
  },
  {
    key: 'clipper.properties',
    label: '页面属性模板',
    desc: '每行一条「key: 值模板」，保存为 YAML frontmatter。留空则不生成属性区。可用变量：{{title}} {{url}} {{author}} {{published}} {{date}} {{description}} {{site}} {{content}} {{selection}}',
    type: 'textarea',
    rows: 8,
  },
  {
    key: 'clipper.content',
    label: '正文模板',
    desc: 'Markdown 正文模板；{{content}} 为抽取正文，{{selection}} 为选中内容。属性区之外的内容都写在这里',
    type: 'textarea',
    rows: 5,
  },
];

/** 剪藏保存目录说明（固定路径，不开放修改） */
function ClipperLocationHint() {
  return (
    <div className="mt-4 rounded-md border border-border bg-surface-secondary px-4 py-3 text-xs leading-6 text-text-secondary">
      <div className="text-sm font-medium text-text">保存位置</div>
      所有剪藏文件固定保存到 <code className="rounded bg-surface px-1">documents/clipper</code>
      （用户数据目录下）。Markdown / MHTML / PDF / 截图共用该目录，重名自动追加序号。
      <br />
      MHTML 为只读图文快照，可在浏览器 MHTML 查看器中打开；也可从 GenOffice 文档主页打开。
    </div>
  );
}

const DATA_FIELDS: readonly SettingField[] = [
  {
    key: 'data.directory',
    label: '数据存储位置',
    desc: '书签、历史、设置、截图、下载、网页保存的根目录（留空使用默认位置）。修改后重启生效；pi 对话数据与设置固定存于 userData/pi，不随此目录变动',
    type: 'directory',
  },
  {
    key: 'downloadsPath',
    label: '下载位置',
    desc: '下载保存目录（留空 = 每次下载询问保存位置，确认时可设为默认）',
    type: 'directory',
  },
];

const PRIVACY_FIELDS: readonly SettingField[] = [
  { key: 'blockTrackers', label: '拦截追踪器', desc: '阻止第三方追踪脚本', type: 'toggle' },
  { key: 'doNotTrack', label: '请勿追踪', desc: '发送 DNT 头', type: 'toggle' },
  {
    key: 'blockAds',
    label: '屏蔽广告浮窗',
    desc: '隐藏网页内悬浮/弹窗类广告（如固定悬浮广告层、弹窗遮罩）',
    type: 'toggle',
  },
];

// ───────────────── 主组件 ─────────────────

export interface SettingsPageProps {
  /**
   * 初始选项卡（深链 `urchin://settings?tab=<key>` 传入）；非法值回退 general。
   * 调用方以 key 绑定该值，参数变化时重挂载以生效。
   */
  readonly initialTab?: string;
}

export function SettingsPage({ initialTab }: SettingsPageProps = {}) {
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : 'general',
  );
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }, []);

  // 设置加载 / 自动保存（debounce 800ms）/ 重置默认值收拢于 settings/use-settings.ts
  // （entries 为全部设置键的单一真源，跨选项卡共享，见 hook 头注释）
  const { entries, loading, error, saving, updateField, handleReset } = useSettings({
    onToast: showToast,
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">加载中…</div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-error">加载失败：{error}</div>
    );
  }

  return (
    <div className="flex h-full bg-surface text-text">
      {/* 左侧选项卡导航 */}
      <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-secondary py-4">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center px-4 py-2.5 text-sm text-left transition-colors',
              activeTab === tab.key
                ? 'border-l-2 border-primary bg-surface font-medium text-text'
                : 'border-l-2 border-transparent text-text-secondary hover:bg-surface hover:text-text',
            )}
          >
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <div className="px-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleReset()}
            className="w-full"
          >
            重置默认
          </Button>
          {saving && <p className="mt-2 text-center text-xs text-text-secondary">保存中…</p>}
        </div>
      </nav>

      {/* 右侧内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6 pb-16">
          {activeTab === 'general' && (
            <>
              <SettingsSection
                title="通用"
                fields={GENERAL_FIELDS}
                entries={entries}
                onChange={updateField}
              />
              <ImportBookmarksBlock onToast={showToast} />
            </>
          )}
          {activeTab === 'clipper' && (
            <>
              <SettingsSection
                title="剪藏"
                fields={CLIPPER_FIELDS}
                entries={entries}
                onChange={updateField}
              />
              <ClipperLocationHint />
            </>
          )}
          {activeTab === 'ops' && <OpsTab entries={entries} onChange={updateField} />}
          {activeTab === 'ai' && (
            <section>
              <h1 className="mb-6 text-2xl font-semibold">AI 助手</h1>
              <div className="rounded-md border border-border bg-surface-secondary px-6 py-12 text-center">
                <p className="text-sm text-text-secondary">AI 助手功能正在开发中，敬请期待。</p>
              </div>
            </section>
          )}
          {activeTab === 'data' && (
            <SettingsSection
              title="数据"
              fields={DATA_FIELDS}
              entries={entries}
              onChange={updateField}
            />
          )}
          {activeTab === 'privacy' && (
            <SettingsSection
              title="隐私与安全"
              fields={PRIVACY_FIELDS}
              entries={entries}
              onChange={updateField}
            />
          )}
          {activeTab === 'files' && <FilesTab onToast={showToast} />}
          {activeTab === 'help' && <HelpTab />}
          {activeTab === 'feedback' && <FeedbackTab />}
          {activeTab === 'about' && <AboutTab />}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-md bg-success px-4 py-2 text-sm text-white shadow-md">
          {toast}
        </div>
      )}
    </div>
  );
}

// ───────────────── 更新选项卡 ─────────────────

/** update.* IPC 状态快照（与 packages/ipc-contract updateStateSchema 对齐）。 */
interface UpdateStateView {
  readonly status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly releaseName?: string;
  readonly releaseNotes?: string;
  readonly progress?: {
    readonly percent: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  };
  readonly error?: string;
  readonly checkedAt?: string;
}

/** 字节数 → 人类可读文案（下载进度用）。 */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** ISO 时间 → 本地时间文案（检查时间展示）。 */
function formatCheckedAt(iso?: string): string {
  if (!iso) return '未检查';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '未检查' : t.toLocaleString('zh-CN');
}

/** 状态 → 一句话描述（错误优先展示具体原因）。 */
function describeUpdateChannel(currentVersion?: string): string {
  if (!currentVersion) return '…';
  return /^\d+\.\d+\.\d+-/.test(currentVersion)
    ? 'dev（GitHub Releases 预发布）'
    : 'latest（GitHub Releases 正式版）';
}

function describeUpdateStatus(state: UpdateStateView | null, actionError: string | null): string {
  switch (state?.status ?? 'idle') {
    case 'disabled':
      return '开发模式下不检查更新（安装版自动连接 GitHub Releases）';
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return '已是最新版本';
    case 'available':
      return `发现新版本 v${state?.latestVersion ?? ''}`;
    case 'downloading':
      return `正在下载 v${state?.latestVersion ?? ''}…`;
    case 'downloaded':
      return `新版本 v${state?.latestVersion ?? ''} 已下载，重启后完成更新`;
    case 'installing':
      return '正在退出并安装，应用将自动重启…';
    case 'error':
      return actionError ?? state?.error ?? '更新失败';
    default:
      return '点击「立即检查」连接 GitHub Releases 获取最新版本';
  }
}

/**
 * 「操作」选项卡：侧栏/工作区/悬浮球设置。
 */
function OpsTab({
  entries,
  onChange,
}: {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}) {
  const sensVRaw = entries['ui.statusBall.sensitivityVertical'];
  const ballSensV = typeof sensVRaw === 'number' && Number.isFinite(sensVRaw) ? sensVRaw : 1;
  const sensHRaw = entries['ui.statusBall.sensitivityHorizontal'];
  const ballSensH = typeof sensHRaw === 'number' && Number.isFinite(sensHRaw) ? sensHRaw : 1;

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">操作</h1>
      <SettingsSection
        title="侧栏与工作区"
        fields={OPS_FIELDS}
        entries={entries}
        onChange={onChange}
      />

      {/* 地址栏悬浮球滚动灵敏度设置 */}
      <div className="mt-6 rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-sm font-medium">地址栏悬浮球滚动灵敏度</div>
        <div className="mt-0.5 text-xs text-text-secondary">
          按住悬浮球拖动滚动网页时的位移倍率（上下/左右独立可调；0.1–5.0，默认
          1.0）。拖到限位后继续按住，网页仍会持续滚动直到松手。
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">上下</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">左右</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function UpdateSection() {
  const [state, setState] = useState<UpdateStateView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (payload: unknown): void => {
      if (alive) setState(payload as UpdateStateView);
    };
    // 主进程状态变化推送（下载进度 / 已下载 / 错误…）
    const off = window.urchin.on('update:event', apply);
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        apply(s);
        const status = (s as UpdateStateView).status;
        // 打开更新页自动检查一次（进行中/已下载/安装中/开发态不打扰）
        if (
          status === 'idle' ||
          status === 'up-to-date' ||
          status === 'available' ||
          status === 'error'
        ) {
          return window.urchin.invoke('update.check', {}).then(apply, () => undefined);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback((channel: 'update.check' | 'update.download' | 'update.install') => {
    setActionError(null);
    void window.urchin.invoke(channel, {}).then(
      (s) => {
        if (s && typeof s === 'object' && 'status' in s) setState(s as UpdateStateView);
      },
      (e: unknown) => setActionError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const status = state?.status ?? 'idle';
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';
  const errorText = actionError ?? (status === 'error' ? state?.error : undefined);
  const progress = state?.progress ?? { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };

  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-3 text-sm font-medium">更新检查</div>
      <div className="rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-xs text-text-secondary">当前版本</div>
        <div className="mt-1 text-lg font-medium">v{state?.currentVersion ?? '…'}</div>
        <div className="mt-1 text-xs text-text-secondary">
          更新通道：{describeUpdateChannel(state?.currentVersion)}
        </div>
      </div>

      <div className="rounded-md border border-border px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-medium">检查更新</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              {describeUpdateStatus(state, actionError)}（上次检查：
              {formatCheckedAt(state?.checkedAt)}）
            </div>
            {errorText && <div className="mt-1 text-xs text-error">{errorText}</div>}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => run('update.check')}
            disabled={busy || status === 'disabled'}
          >
            {status === 'checking' ? '检查中…' : '立即检查'}
          </Button>
        </div>
      </div>

      {status === 'available' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">发现新版本 v{state?.latestVersion ?? ''}</div>
          {state?.releaseName && (
            <div className="mt-0.5 text-xs text-text-secondary">{state.releaseName}</div>
          )}
          {state?.releaseNotes && (
            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-xs text-text-secondary">
              {state.releaseNotes}
            </pre>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.download')}>
              下载并更新
            </Button>
          </div>
        </div>
      )}

      {status === 'downloading' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">正在下载 v{state?.latestVersion ?? ''}</div>
            <div className="text-xs text-text-secondary">{Math.floor(progress.percent)}%</div>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(progress.percent)}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
          <div className="mt-1.5 text-xs text-text-secondary">
            {formatBytes(progress.transferred)} / {formatBytes(progress.total)} ·{' '}
            {formatBytes(progress.bytesPerSecond)}/s
          </div>
        </div>
      )}

      {status === 'downloaded' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">v{state?.latestVersion ?? ''} 已就绪</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            点击「重启并安装」立即更新；直接退出应用也会自动完成安装。
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.install')}>
              重启并安装
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────── 帮助手册选项卡 ─────────────────

/** 常用快捷键（帮助手册顶部速查）。 */
const HELP_SHORTCUTS: readonly { readonly keys: string; readonly desc: string }[] = [
  { keys: 'Ctrl + O', desc: '打开本地文件（文档 / 音视频 / 图片 / 文本）' },
  { keys: 'F12', desc: '打开或关闭右侧 DevTools 检视面板' },
  { keys: 'Ctrl + 滚轮', desc: '缩放当前网页或内部页内容' },
  { keys: 'Esc', desc: '取消截图，或关闭当前面板 / 对话框' },
  { keys: '双击标签卡片', desc: '关闭该标签' },
  { keys: '双击右侧栏空白', desc: '展开或折叠右侧栏' },
  { keys: '← / →', desc: '文件查看器中切换同目录上一个 / 下一个文件' },
  { keys: 'Ctrl + V', desc: '在笔记画布中粘贴文本并新建便利贴' },
];

interface HelpTopic {
  readonly title: string;
  readonly body: string;
}

interface HelpSection {
  readonly title: string;
  readonly topics: readonly HelpTopic[];
}

/**
 * 帮助手册正文（本项目全部操作说明）。
 *
 * 单一入口：设置页「帮助手册」。内容按功能域分组，只写用户可执行的操作；
 * 具体默认值与可选项以对应设置页为准，避免两处维护同一份默认值。
 */
const HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: '界面总览',
    topics: [
      {
        title: '左侧栏',
        body: '顶部按钮折叠 / 展开左侧栏；折叠时也可双击左侧栏空白处或悬停展开（悬停可在设置「操作」中关闭）。折叠按钮下方是「中转区」，用于暂存文件、链接、选中文字与截图。底部从上到下依次是 DeepSeek Harness、pi、笔记 / 便利贴、GenOffice 文档、邮箱、主页、主题切换与设置入口。',
      },
      {
        title: '中间内容区',
        body: '网页、设置页、主页、笔记、邮箱等都在中间区域显示。底部悬浮地址栏始终可用，包含后退、前进、刷新、翻译、地址输入、收藏、截图与剪藏按钮。',
      },
      {
        title: '右侧栏',
        body: '顶部是工作区色块，下面是当前工作区的标签卡片，底部为「新建标签」。拖拽右侧栏左缘可调整宽度；双击空白处可展开 / 折叠。折叠后只显示工作区图标与标签图标，可在设置「操作」中选择悬停自动展开。',
      },
      {
        title: '状态栏悬浮球',
        body: '单击悬浮球展开 / 隐藏底部地址栏；按住左键拖动可像摇杆一样滚动网页；按住右键拖动可移动悬浮球位置（可拖出主窗口）。',
      },
    ],
  },
  {
    title: '标签页与工作区',
    topics: [
      {
        title: '新建与切换标签',
        body: '点击右侧栏底部的「新建标签」创建新标签页；单击标签卡片即可切换。没有打开任何标签时，导航或新建操作会自动补一个标签。',
      },
      {
        title: '关闭与排序标签',
        body: '鼠标悬停标签卡片后点击右侧叉号关闭，或双击标签卡片关闭。按住标签卡片上下拖动可调整顺序。右键标签卡片可选择「在另一工作区打开当前页」「新建工作区并在此打开…」或「关闭标签」。',
      },
      {
        title: '工作区',
        body: '每个工作区拥有独立的 Cookie、localStorage、IndexedDB 与 Service Worker，适合同一网站登录多个账号。点击工作区选项卡右侧「+」新建；右键工作区选项卡可重命名、更换颜色、清空数据或删除。折叠态默认用滚轮切换工作区，也可在设置「操作」中改为点击打开工作区总览页。',
      },
      {
        title: '恢复上次标签',
        body: '在设置「通用」中开启「启动时继续浏览上次打开的网页」，下次启动会恢复默认工作区的标签，其他工作区的标签在切换过去时恢复。',
      },
    ],
  },
  {
    title: '地址栏与网页浏览',
    topics: [
      {
        title: '输入网址或搜索',
        body: '在地址栏输入网址后按 Enter 打开；输入普通文字会按设置中的搜索引擎搜索。输入过程中会显示历史记录与书签的补全建议，点击建议即可打开。输入本地文件路径（如 C:\\Users\\me\\a.txt）会直接用文件查看器打开。',
      },
      {
        title: '页面导航与操作',
        body: '地址栏左侧依次是后退、前进、刷新与翻译。右侧星标用于收藏当前页（未收藏时打开收藏夹面板选择保存位置）；收藏夹按钮打开「收藏夹 / 历史记录 / 下载列表」三合一面板；相机按钮截图；剪藏按钮打开剪藏面板。',
      },
      {
        title: '网页右键菜单',
        body: '网页内右键可复制、粘贴、保存网页为…（默认保存到数据目录的 saved-pages 文件夹）。有选中文字时可翻译选中文字或加入中转区；右键链接 / 视频可加入中转区；未处于翻译状态时可翻译整页，翻译中可恢复原文。',
      },
      {
        title: '收藏夹、历史与下载',
        body: '收藏夹面板支持文件夹面包屑下钻、新建文件夹、重命名与删除；历史记录可查看访问过的页面；下载列表显示进度，支持暂停、取消与打开所在文件夹，并可清空已结束的下载。',
      },
      {
        title: '链接打开方式',
        body: '设置「通用」中的「在新标签页打开链接」控制网页内链接在当前标签还是新标签打开。',
      },
    ],
  },
  {
    title: '网页翻译',
    topics: [
      {
        title: '整页翻译与恢复',
        body: '点击地址栏的翻译按钮，或在网页右键选择「翻译页面」，即可把当前页就地翻译为目标语言。再次点击翻译按钮或右键「恢复原文」可还原。',
      },
      {
        title: '划词翻译',
        body: '在网页中选中文字后右键选择「翻译选中文字」，翻译结果会以浮层卡片显示。',
      },
      {
        title: '目标语言与引擎',
        body: '在设置「通用」中设置翻译目标语言与引擎。默认「自动」会按网络环境选择可用引擎，失败时自动切换。开启「自动翻译外语页面」后，打开外语网页会自动翻译（默认关闭；翻译时页面文本会发送至所选翻译服务）。',
      },
    ],
  },
  {
    title: '网页剪藏',
    topics: [
      {
        title: '打开剪藏面板',
        body: '在网页标签点击地址栏的剪藏按钮。面板会抽取当前页正文，可临时切换「优先选中内容」与「快照正文清洗」。',
      },
      {
        title: '保存格式',
        body: '支持 Markdown（可编辑）、MHTML（图文整页）、PDF（打印版）与截图（整页 PNG）。Markdown 可复制到剪贴板或保存；MHTML / PDF / 截图用于网页存档。',
      },
      {
        title: '保存位置与打开',
        body: '所有剪藏固定保存到用户数据目录下的 documents/clipper，重名自动追加序号。MHTML 可用内置只读查看器打开，也可从 GenOffice 文档主页打开。',
      },
      {
        title: '文件名与正文模板',
        body: '在设置「剪藏」中可配置默认格式、快照清洗、懒加载滚动、Markdown 图片本地化、文件名模板、页面属性（frontmatter）与正文模板。',
      },
    ],
  },
  {
    title: '笔记与便利贴',
    topics: [
      {
        title: '打开与布局',
        body: '点击左侧栏的笔形按钮打开笔记页。页面分三区：左侧笔记本与页面树、中间笔记 / 任务清单、右侧无限画布。两条分割线可拖动，布局会自动保存。',
      },
      {
        title: '笔记本与笔记',
        body: '左侧可新建、重命名、删除笔记本；每个笔记本内可新建页面。单击选中笔记，在中间区域编辑标题与正文（当前版本为纯文本）。删除操作会二次确认。',
      },
      {
        title: '任务清单',
        body: '选中笔记本下的「任务清单」节点，在中间区域输入任务后按 Enter 添加；点击复选框标记完成，垃圾桶按钮删除。',
      },
      {
        title: '便利贴画布',
        body: '右侧画布双击空白处、点击「+」或按 Ctrl+V 粘贴文本即可新建便利贴。便利贴可拖动、调整大小、切换颜色、用 A-/A+ 调整字号与删除；图片可直接拖入画布独立放置，鼠标停在图片上滚轮可放大图片本身，双击恢复 100%。画布支持放大、缩小与重置视图。',
      },
    ],
  },
  {
    title: '中转区',
    topics: [
      {
        title: '加入内容',
        body: '把文件从桌面 / 资源管理器拖入左侧中转区；或在网页右键把选中文字、链接、视频加入中转区。截图等模块也可把内容放入中转区。',
      },
      {
        title: '拖出与排序',
        body: '中转区条目可拖到 pi 输入框、笔记、GenOffice、邮箱、主页常用网站或网页区域使用。条目之间可拖动排序；悬停后点击叉号移除，也可使用清空按钮。中转区内容会持久保存。',
      },
    ],
  },
  {
    title: '本地文件与 GenOffice 文档',
    topics: [
      {
        title: '打开文件',
        body: '四种入口：按 Ctrl+O；点击左侧栏 GenOffice 文档按钮后在主页点「打开文件」；把文件拖放到窗口；在地址栏输入本地路径。',
      },
      {
        title: '内置查看与编辑',
        body: '图片、音视频与 PDF 直接渲染；文本、Markdown、JSON 等进入文件查看器。打开文件时会自动列出同目录可预览文件，用工具栏或键盘 ← / → 切换。文本类文件可进入编辑，支持保存、另存为与完成；有未保存修改时切换或关闭会先询问。',
      },
      {
        title: 'GenOffice 编辑器',
        body: 'GenOffice 文档主页支持 Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）、PDF、Markdown 与 HTML。文件只在本机打开与保存。GenOffice 内置 AI 使用它自己的模型与密钥，与浏览器 pi 完全隔离。',
      },
    ],
  },
  {
    title: '开发者工具',
    topics: [
      {
        title: '打开与使用',
        body: '按 F12 打开或关闭右侧 DevTools 检视面板。面板提供 Network、Console 与 Runtime.evaluate（执行 JavaScript）。拖拽面板左缘可调整宽度。内部页与 GenOffice 标签不支持检视。',
      },
    ],
  },
  {
    title: '邮箱',
    topics: [
      {
        title: '添加账户',
        body: '点击左侧栏邮箱按钮打开邮箱页。首次使用按向导添加账户：可先用自动检测填充 IMAP / SMTP 配置，也可手动填写服务器、端口与密码。密码使用系统安全存储加密。',
      },
      {
        title: '收信与阅读',
        body: '左侧选择文件夹，中间选择邮件，右侧查看详情。邮件正文支持翻译（原文 / 译文切换）；支持手动刷新与后台同步提示。',
      },
      {
        title: '写信',
        body: '在文件夹列表点击写邮件，填写收件人、可展开抄送、主题与正文，并可添加附件后发送。当前版本回复、转发、标记未读与删除按钮尚未开放。',
      },
    ],
  },
  {
    title: 'pi 与 DeepSeek Harness',
    topics: [
      {
        title: 'pi',
        body: '点击左侧栏 π 按钮会确保本地 pi 服务运行，并打开 pi 聊天页标签。按钮右下角状态灯表示运行 / 启动中 / 故障 / 未启动。关闭 pi 标签不会停止服务，再次点击即可回到聊天页；pi 的 Provider 与模型在 pi 设置中配置。',
      },
      {
        title: 'DeepSeek Harness',
        body: '点击左侧栏 π 上方的 DeepSeek Harness 按钮会启动本地 dsh 服务并打开其前端标签。与 pi 不同，关闭该标签会停止 dsh 后端。',
      },
    ],
  },
  {
    title: '截图与默认应用',
    topics: [
      {
        title: '截图',
        body: '点击地址栏的相机按钮，屏幕进入框选模式；拖拽选择区域后确认即可截图。按 Esc 取消。截图保存到数据目录的 screenshots 文件夹，并提示打开所在文件夹。',
      },
      {
        title: '默认应用',
        body: '在设置「默认应用」中可把本浏览器注册为音视频、文档或图片的打开方式。注册后仍需在 Windows「打开方式」中选择本浏览器设为默认。',
      },
    ],
  },
  {
    title: '数据、导入与更新',
    topics: [
      {
        title: '数据存储位置',
        body: '在设置「数据」中修改数据存储根目录与下载位置。数据根目录影响书签、历史、设置、截图、下载与网页保存，修改后需重启生效；pi 对话数据与设置固定保存在 userData/pi。',
      },
      {
        title: '导入收藏夹',
        body: '设置「通用」底部可从书签 HTML 文件导入，或检测本机 Chrome / Edge / Firefox 并导入收藏夹。导入的书签会放进收藏夹根目录下「导入自 <浏览器>」文件夹。',
      },
      {
        title: '检查更新',
        body: '在设置「关于」中检查更新。发现新版本可下载并在准备好后点击「重启并安装」；直接退出应用也会完成已下载的更新。',
      },
      {
        title: '建议与反馈',
        body: '设置「建议与反馈」提供 GitHub Issues 与 Discussions 入口，会在浏览器新标签页打开对应页面。',
      },
    ],
  },
  {
    title: '设置项索引',
    topics: [
      {
        title: '通用',
        body: '界面语言、搜索引擎、链接打开方式、启动时恢复标签、网页翻译目标语言 / 引擎 / 自动翻译，以及从其他浏览器导入收藏夹。',
      },
      {
        title: '剪藏与操作',
        body: '「剪藏」配置默认保存格式与 Markdown 模板；「操作」配置右侧栏展开方式、悬停延迟与折叠态工作区切换方式。',
      },
      {
        title: '数据、默认应用与隐私',
        body: '「数据」配置存储位置与下载目录；「默认应用」注册文件关联；「隐私与安全」控制拦截追踪器、请勿追踪与屏蔽广告浮窗。',
      },
      {
        title: '其他',
        body: '「AI 助手」为后续原生助手预留；「帮助手册」即本页；「建议与反馈」与「关于」提供反馈、更新与运行时信息。',
      },
    ],
  },
];

function HelpTab() {
  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">帮助手册</h1>
      <p className="mb-6 text-sm text-text-secondary">
        本页汇总顽童浏览器的全部操作说明。按功能域分组，可在此查阅界面入口、常用操作与设置项位置。
      </p>

      <div className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4">
        <h2 className="text-base font-semibold">常用快捷键</h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {HELP_SHORTCUTS.map((item) => (
            <div key={item.keys} className="flex items-start gap-2">
              <dt className="shrink-0">
                <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text">
                  {item.keys}
                </kbd>
              </dt>
              <dd className="text-xs leading-5 text-text-secondary">{item.desc}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-4">
        {HELP_SECTIONS.map((section) => (
          <div key={section.title} className="rounded-md border border-border px-4 py-4">
            <h2 className="text-base font-semibold">{section.title}</h2>
            <dl className="mt-3 space-y-3">
              {section.topics.map((topic) => (
                <div key={topic.title}>
                  <dt className="text-sm font-medium">{topic.title}</dt>
                  <dd className="mt-1 text-xs leading-6 text-text-secondary">{topic.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

// ───────────────── 关于选项卡 ─────────────────

function AboutTab() {
  // 应用版本经 update.getState 取主进程 app.getVersion()（打包时由
  // package-win.mjs 从 CHANGELOG 盖章 0.1.0-dev.NNN；开发态为 package.json 的 0.1.0）
  const [appVersion, setAppVersion] = useState<string>('—');
  useEffect(() => {
    let alive = true;
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        if (alive) setAppVersion((s as UpdateStateView).currentVersion);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const versions = useMemo(() => {
    if (typeof window !== 'undefined' && window.urchin?.versions) {
      return {
        electron: window.urchin.versions.electron,
        chrome: window.urchin.versions.chrome,
        node: window.urchin.versions.node,
        platform: window.urchin.platform,
      };
    }
    return { electron: '-', chrome: '-', node: '-', platform: '-' };
  }, []);

  const handleOpenRepo = useCallback(async () => {
    try {
      const windowId = await getCurrentWindowId();
      await window.urchin.invoke('tab.create', { windowId, url: REPO_URL, active: true });
    } catch {
      // 标签创建失败不中断设置页交互：静默忽略
    }
  }, []);

  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">关于</h1>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">{displayNameForLocale(navigator.language)}</div>
          <div className="mt-1 text-sm text-text-secondary">版本 {appVersion}</div>
          <div className="mt-3 text-xs text-text-secondary">
            一款基于 Electron + Chromium 的 AI 浏览器，集成多 Provider AI 助手与隐私保护。
          </div>
        </div>

        {/* 更新检查（原「更新」选项卡内容移入此处） */}
        <UpdateSection />

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">运行时信息</div>
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-text-secondary">Electron</dt>
            <dd>{versions.electron}</dd>
            <dt className="text-text-secondary">Chromium</dt>
            <dd>{versions.chrome}</dd>
            <dt className="text-text-secondary">Node.js</dt>
            <dd>{versions.node}</dd>
            <dt className="text-text-secondary">平台</dt>
            <dd>{versions.platform}</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">作者</div>
          <button
            type="button"
            className="break-all text-left text-xs text-primary hover:underline"
            onClick={() => void handleOpenRepo()}
          >
            {REPO_URL}
          </button>
          <div className="mt-2 text-xs text-text-secondary">
            Copyright © 2026 Urchin Browser Contributors
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────── 建议与反馈选项卡 ─────────────────

/** 远程仓库地址（Issues / Discussions 链接以此拼接）。 */
const REPO_URL = 'https://github.com/sgobiorodolfo170-ai/Urchin-Browser';

/**
 * 「建议与反馈」选项卡：聚合 GitHub Issues 与 Discussions 入口。
 *
 * 点击后在 Urchin 内新开标签页打开对应 GitHub 页面（复用 tab.create，
 * active:true 让新标签立即获得焦点，自然离开设置面板）。
 */
function FeedbackTab() {
  const [opening, setOpening] = useState<string | null>(null);

  const handleOpen = useCallback(async (url: string) => {
    setOpening(url);
    try {
      const windowId = await getCurrentWindowId();
      await window.urchin.invoke('tab.create', { windowId, url, active: true });
    } catch {
      // 标签创建失败不应中断设置页交互：静默忽略，用户可重试或复制链接手动打开
    } finally {
      setOpening(null);
    }
  }, []);

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">建议与反馈</h1>
      <p className="mb-6 text-sm text-text-secondary">
        欢迎通过 GitHub 提交问题、分享想法或参与讨论。点击下方入口会在本浏览器新标签页打开对应页面。
      </p>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">问题反馈（Issues）</div>
          <div className="mt-1 text-sm text-text-secondary">
            报告 Bug、提出功能请求或查看已知问题。
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={opening === `${REPO_URL}/issues`}
            onClick={() => void handleOpen(`${REPO_URL}/issues`)}
          >
            {opening === `${REPO_URL}/issues` ? '打开中…' : '前往 Issues'}
          </Button>
        </div>

        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">讨论区（Discussions）</div>
          <div className="mt-1 text-sm text-text-secondary">
            想法交流、使用问答、Show &amp; Tell 与经验分享。
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={opening === `${REPO_URL}/discussions`}
            onClick={() => void handleOpen(`${REPO_URL}/discussions`)}
          >
            {opening === `${REPO_URL}/discussions` ? '打开中…' : '前往 Discussions'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ───────────────── 默认应用选项卡（Windows 文件关联） ─────────────────

/** 分组定义（与主进程 file-association/associations.ts 的 ASSOCIATION_GROUPS 对齐）。 */
interface AssociationGroupDef {
  readonly id: 'media' | 'documents' | 'images';
  readonly label: string;
  readonly description: string;
}

const ASSOCIATION_GROUP_DEFS: readonly AssociationGroupDef[] = [
  { id: 'media', label: '音视频', description: 'MP3 / MP4 / WAV 等音频视频文件' },
  { id: 'documents', label: '文档', description: 'PDF / Markdown / 文本 / JSON 等文档文件' },
  { id: 'images', label: '图片', description: 'PNG / JPG / GIF / SVG 等图片文件' },
];

interface GroupStatus {
  readonly registered: number;
  readonly total: number;
  readonly extensions: readonly string[];
}

/**
 * 「从其他浏览器导入收藏夹」区块（通用选项卡底部，dev.119）。
 *
 * 交互：
 * - 「从书签 HTML 文件导入…」→ import.bookmarksFromFile（主进程弹文件选择器）
 * - 「检测本机浏览器」→ import.detectBrowsers → 列表，每行「导入收藏夹」按钮
 *   → import.bookmarksFromBrowser（按 id 导入指定 profile）
 * - 结果 toast：「已导入 N 个书签、M 个文件夹（跳过 K）」；取消时 toast「已取消」
 *
 * 导入的书签放入收藏夹根目录下「导入自 <浏览器> (YYYY-MM-DD)」文件夹，
 * 完整保留原目录结构，可整夹删除回退（详见 docs/数据导入评估.md）。
 */
function ImportBookmarksBlock({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [browsers, setBrowsers] = useState<ImportedBrowserInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [fileImporting, setFileImporting] = useState(false);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = (await window.urchin.invoke('import.detectBrowsers', {})) as {
        browsers: ImportedBrowserInfo[];
      };
      setBrowsers(res.browsers ?? []);
      if ((res.browsers ?? []).length === 0) {
        onToast('未检测到可导入的浏览器');
      }
    } catch (e) {
      onToast('检测失败：' + String(e));
    } finally {
      setDetecting(false);
    }
  }, [onToast]);

  const handleFromFile = useCallback(async () => {
    setFileImporting(true);
    try {
      const res = (await window.urchin.invoke('import.bookmarksFromFile', {})) as {
        canceled: boolean;
        summary: ImportSummaryInfo | null;
      };
      if (res.canceled || !res.summary) {
        onToast('已取消');
        return;
      }
      onToast(summaryToast(res.summary));
    } catch (e) {
      onToast('导入失败：' + String(e));
    } finally {
      setFileImporting(false);
    }
  }, [onToast]);

  const handleFromBrowser = useCallback(
    async (id: string) => {
      setImporting(id);
      try {
        const res = (await window.urchin.invoke('import.bookmarksFromBrowser', { id })) as {
          canceled: boolean;
          summary: ImportSummaryInfo | null;
        };
        if (res.canceled || !res.summary) {
          onToast('已取消');
          return;
        }
        onToast(summaryToast(res.summary));
      } catch (e) {
        onToast('导入失败：' + String(e));
      } finally {
        setImporting(null);
      }
    },
    [onToast],
  );

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">从其他浏览器导入</h2>
      <p className="mb-4 text-sm text-text-secondary">
        导入 Chrome / Edge / Firefox 的收藏夹，或从书签 HTML 文件导入。导入的书签会放入
        收藏夹根目录下「导入自 &lt;浏览器&gt;
        (&lt;日期&gt;)」文件夹，完整保留原目录结构，可整夹删除回退。
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={fileImporting}
          onClick={() => void handleFromFile()}
        >
          {fileImporting ? '导入中…' : '从书签 HTML 文件导入…'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting}
          onClick={() => void handleDetect()}
        >
          {detecting ? '检测中…' : '检测本机浏览器'}
        </Button>
      </div>

      {browsers.length > 0 && (
        <div className="mt-4 space-y-2">
          {browsers.map((b) => {
            const key = b.id;
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-md border border-border bg-surface-secondary px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="font-medium">{b.displayName}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{b.profileName}</div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing === b.id}
                  onClick={() => void handleFromBrowser(b.id)}
                >
                  {importing === b.id ? '导入中…' : '导入收藏夹'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 已检测浏览器 profile 的最小结构（与 ipc-contract ImportedBrowser 对齐）。 */
interface ImportedBrowserInfo {
  readonly id: string;
  readonly kind: 'chrome' | 'edge' | 'firefox';
  readonly displayName: string;
  readonly profileName: string;
  readonly profileDir: string;
  readonly bookmarksSource: 'chromium-json' | 'firefox-places';
}

/** 导入结果摘要（与 ipc-contract ImportSummary 对齐）。 */
interface ImportSummaryInfo {
  readonly folders: number;
  readonly bookmarks: number;
  readonly skipped: number;
  readonly rootFolderId: string;
  readonly rootFolderTitle: string;
}

/** 摘要 → toast 文案。 */
function summaryToast(s: ImportSummaryInfo): string {
  return `已导入 ${s.bookmarks} 个书签、${s.folders} 个文件夹${s.skipped > 0 ? `（跳过 ${s.skipped}）` : ''}`;
}

/**
 * 「默认应用」选项卡：把本浏览器注册为音视频/文档/图片的打开方式。
 *
 * 交互：每张卡片显示该组扩展名与注册状态；点「设为默认打开方式」→
 * file-association.register → 主进程写 HKCU 注册表 → 刷新状态 + toast。
 * 注册后浏览器出现在 Windows「打开方式 → 选择其他应用」列表，用户勾选
 * 「始终使用」即由系统完成永久默认（UserChoice 由 Windows 写入）。
 */
function FilesTab({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [statuses, setStatuses] = useState<Record<string, GroupStatus> | null>(null);
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);
  const [settingDefaultBrowser, setSettingDefaultBrowser] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file-association.getStatus', {})) as {
        groups: Record<string, GroupStatus>;
      };
      setStatuses(res.groups);
      setSelected((prev) => {
        const next: Record<string, readonly string[]> = {};
        for (const group of ASSOCIATION_GROUP_DEFS) {
          const extensions = res.groups[group.id]?.extensions ?? [];
          const previous = new Set(prev[group.id] ?? extensions);
          next[group.id] = extensions.filter((ext) => previous.has(ext));
        }
        return next;
      });
    } catch (e) {
      onToast('读取关联状态失败：' + String(e));
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const toggleExtension = useCallback((groupId: string, ext: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev[groupId] ?? []);
      if (checked) next.add(ext);
      else next.delete(ext);
      return { ...prev, [groupId]: [...next] };
    });
  }, []);

  const handleSetDefaultBrowser = useCallback(async () => {
    setSettingDefaultBrowser(true);
    try {
      const res = (await window.urchin.invoke('file-association.setDefaultBrowser', {})) as {
        openedSettings: boolean;
      };
      onToast(
        res.openedSettings
          ? `已登记默认浏览器能力，请在系统「默认应用」中选择 ${displayNameForLocale(navigator.language)}`
          : '已登记默认浏览器能力，请到系统「默认应用」中手动选择本浏览器',
      );
    } catch (e) {
      onToast('设置默认浏览器失败：' + String(e));
    } finally {
      setSettingDefaultBrowser(false);
    }
  }, [onToast]);

  const handleRegister = useCallback(
    async (groupId: string) => {
      const extensions = selected[groupId] ?? [];
      if (extensions.length === 0) {
        onToast('请至少勾选一种格式');
        return;
      }
      setRegistering(groupId);
      try {
        await window.urchin.invoke('file-association.register', { group: groupId, extensions });
        onToast(
          `已注册。可在系统「打开方式」选择 ${displayNameForLocale(navigator.language)} 并勾选"始终使用"`,
        );
        await loadStatus();
      } catch (e) {
        onToast('注册失败：' + String(e));
      } finally {
        setRegistering(null);
      }
    },
    [loadStatus, onToast, selected],
  );

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">默认应用</h1>
      <p className="mb-6 text-sm text-text-secondary">
        把 {displayNameForLocale(navigator.language)}{' '}
        设为默认浏览器和音视频、文档、图片的打开方式。Windows 10/11 不允许程序直接改写默认浏览器，
        点击下方按钮后会打开系统「默认应用」页，由你确认选择本浏览器。
      </p>

      <div className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">默认浏览器</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              登记 http / https 与网页文件关联，并打开系统默认应用设置
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={settingDefaultBrowser}
            onClick={() => void handleSetDefaultBrowser()}
          >
            {settingDefaultBrowser ? '设置中…' : '设为默认浏览器'}
          </Button>
        </div>
      </div>

      {loading && <p className="text-text-secondary">加载中…</p>}
      {!loading &&
        ASSOCIATION_GROUP_DEFS.map((group) => {
          const status = statuses?.[group.id];
          const selectedExtensions = selected[group.id] ?? [];
          return (
            <div
              key={group.id}
              className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{group.label}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{group.description}</div>
                </div>
                {status && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs',
                      status.registered > 0
                        ? 'bg-success/15 text-success'
                        : 'bg-text-secondary/10 text-text-secondary',
                    )}
                  >
                    {status.registered}/{status.total} 已关联
                  </span>
                )}
              </div>
              {status && status.extensions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {status.extensions.map((ext) => (
                    <label
                      key={ext}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:text-text"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={selectedExtensions.includes(ext)}
                        onChange={(e) => toggleExtension(group.id, ext, e.target.checked)}
                      />
                      .{ext}
                    </label>
                  ))}
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                disabled={registering === group.id || selectedExtensions.length === 0}
                onClick={() => void handleRegister(group.id)}
              >
                {registering === group.id
                  ? '注册中…'
                  : `设为默认打开方式（${selectedExtensions.length}）`}
              </Button>
            </div>
          );
        })}
    </section>
  );
}

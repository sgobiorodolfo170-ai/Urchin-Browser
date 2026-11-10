/**
 * 「帮助手册」选项卡（refactor-plan-p2 §3.3 步骤 7：自 SettingsPage.tsx 原样
 * 提升为独立文件，逻辑不变）
 *
 * 组成：快捷键速查（HELP_SHORTCUTS）+ 分主题帮助文档（HELP_SECTIONS）。
 */

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
        body: '顶部按钮折叠 / 展开左侧栏；折叠时也可双击左侧栏空白处或悬停展开（悬停默认关闭，可在设置「操作」中开启）。折叠按钮下方是「中转区」，用于暂存文件、链接、选中文字与截图。底部从上到下依次是 DeepSeek Harness、pi、笔记 / 便利贴、GenOffice 文档、邮箱、主页、主题切换与设置入口。',
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
        body: '剪藏默认保存到数据目录下的 documents/clipper（重名自动追加序号），可在设置「数据 → 剪藏保存路径」修改。MHTML 可用内置只读查看器打开，也可从 GenOffice 文档主页打开。',
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
        title: '导入收藏夹与 Cookie',
        body: '设置「数据」底部可从书签 HTML 文件导入，或检测本机 Chrome / Edge / Firefox 并导入收藏夹。导入的文件夹与书签会直接放入收藏夹根目录，完整保留原目录结构。勾选「同时导入 Cookie」会一并导入登录状态：Firefox 可完整导入；Chrome / Edge 若已启用应用级加密（ABE），只能导入旧版 Cookie，无法导入的部分会明确提示。导入前请关闭源浏览器；Cookie 导入不保证所有站点保持登录。',
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
        body: '界面语言、搜索引擎、链接打开方式、启动时恢复标签、关闭窗口驻留托盘、网页翻译目标语言 / 引擎 / 自动翻译。',
      },
      {
        title: '数据',
        body: '数据存储位置、下载位置、剪藏保存路径，以及从其他浏览器导入收藏夹与 Cookie。',
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

export function HelpTab() {
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

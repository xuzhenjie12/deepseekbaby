# deepseekbaby

DSH 内的「deepseekbaby」小程序：右下角按钮打开浮层，把对话按任务/分支组织成树，
自带文件/命令工具、工作区隔离、文件与图片上传、联网搜索，用 DSH 配置的模型跑，
数据全部落在本地。

> 包名 `deepseekbaby`；仓库目录仍叫 `node-chat`，HTTP 路由前缀也还是 `/node-chat`，
> 改名时为了避免旧面板/链接一起失效而保留了。品牌名只影响包、浮层按钮和页面标题。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边：注册 `/node-chat` 路由（页面 + JSON API），调用 `lib/agent.js` |
| `lib/store.js` | 节点树与消息历史（`~/.dsh/deepseekbaby/{nodes,history}.json`），串行写 |
| `lib/agent.js` | 一轮模型调用 + 有界工具循环；流式事件、usage 汇总 |
| `lib/tools.js` | `fs_read` / `fs_list` / `fs_write` / `fs_delete` / `shell` |
| `lib/workspace.js` | 工作区根与路径越界检查 |
| `lib/sessions.js` | 从 DSH 会话导入最近 N 轮，作为新任务初始内容 |
| `lib/dsml.js` | 解析/清理被模型写成正文的 DSML 工具调用标记 |
| `lib/web.js` | 联网搜索：优先 `ctx.web`，否则用 `apiKeyEnv` 密钥或已登录账号直连 |
| `lib/compat.js` | 兼容性清单：Node 版本闸门 + 插件用到的每个 DSH 服务（`HOST_SEAMS`） |
| `cordis.patch.yml` | bundle 补丁，向 profile 插入 `id: node-chat / name: deepseekbaby` |
| `panel.html` | 自包含前端（节点树、消息、工具折叠、统计） |
| `panel-markdown.js` | 面板用的最小 Markdown 渲染器（先转义再加标签） |
| `client.js` | DSH 浮层入口按钮（iframe 指向 `/node-chat`） |

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/node-chat/` | 面板页面 |
| GET | `/node-chat/markdown.js` | 渲染器脚本 |
| GET | `/node-chat/api/state` | 当前树 + 可见消息 + 用量 |
| GET | `/node-chat/api/sessions` | 可导入的 DSH 会话 |
| GET | `/node-chat/api/compat` | 兼容性报告：Node 版本 + 每个 DSH 服务在不在（见「兼容性」一节） |
| GET | `/node-chat/api/fs` | 目录浏览（工作区选择器） |
| POST | `/node-chat/api/upload` | 上传文件/图片到当前任务工作区 |
| POST | `/node-chat/api/send` | 发送一轮；`stream:true` 时返回 NDJSON 进度 |
| POST | `/node-chat/api/node/{new,switch,back,delete,profile}` | 节点操作 |
| POST | `/node-chat/api/turns/delete` | 删除当前节点最新 N 轮（只删末尾） |
| POST | `/node-chat/api/restart` | 关→开本插件（重新加载宿主代码） |

## 开发与重载

- 改 `panel.html`、`panel-markdown.js`：刷新面板即可，宿主每次请求都重新读文件。
- 改 `lib/*.js`、`index.js`：宿主导入有缓存，必须在「设置 → 插件」里把 deepseekbaby
  关掉再打开（或点面板里的 ⟳）。
- 改 `client.js`：客户端插件走 HMR，自动重载。
- 起本地测试：在插件目录跑 `npm test`（不依赖 DSH；`test/handler.test.mjs` 用假 ctx 跑全部宿主路由）。
  单个文件也行，例如改兼容性清单后跑 `node test/compat.test.mjs`，发布前跑 `node test/release.test.mjs`。

## 配置项（写在 profile 的 `cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxTokens` | 4096 | 单次回复上限 |
| `maxToolRounds` | 16 | 工具循环上限 |
| `enableShell` / `shellScope` | true / workspace | 是否给 shell，以及是否限制在工作区内 |
| `enableWrite` / `enableDelete` | true / true | 文件写/删开关 |
| `enableWebSearch` | true | 是否注册 `web_search`（还要按轮勾选「联网」） |
| `searchBaseURL` / `searchModel` | DeepSeek Anthropic 端点 / `deepseek-v4-flash` | 联网兜底直连的端点与模型，换供应商时改这里 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 直连模型与联网兜底用的密钥环境变量；显式写空串 = 只用 DSH 提供的服务（无密钥部署可这样配） |
| `workspaceRoot` | 空 | 固定默认工作区；留空跟随 DSH |
| `fileAccess` | computer | 有任务工作区时会被收窄，`computer` 只对旧任务生效 |
| `priceHitPerM` / `priceMissPerM` / `priceOutputPerM` | 0.2 / 2 / 3 | 消费统计单价（每百万 tokens，默认人民币） |
| `priceCurrency` | CNY | 统计显示用的货币符号，改美元价时填 `USD` |

## 一键安装

把插件目录放到目标机器后，在目录里运行：

**Windows**（系统自带 PowerShell 即可，不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

**macOS / Linux**：

```bash
chmod +x install.sh && ./install.sh
```

脚本会自动做四件事，然后提示重启 DSH：

1. 在 `~/.dsh/profiles/<profile>/package.json` 里写入
   `"deepseekbaby": "link:<插件目录>"`；
2. 把 `deepseekbaby` 加进 `dsh.profile.bundles`；
3. 建立 `node_modules/deepseekbaby` 目录链接；
4. 用 DSH 自带的 pnpm 同步依赖并做一次包解析自检。

常用参数：

| 参数 | 说明 |
|---|---|
| `-Profile work` | 指定 profile，默认 `desktop` |
| `-DshHome D:\dsh` | 指定 DSH_HOME，默认 `%USERPROFILE%\.dsh` |
| `-Uninstall` | 移除依赖与链接，保留数据 |
| `-NoInstall` | 不跑 pnpm（DSH 启动时会自己装） |
| `-SkipVerify` | 跳过 import 自检 |

macOS/Linux 的 `install.sh` 支持 `./install.sh -u` 卸载；它不跑 pnpm，DSH 启动时会自动安装。

### 手动安装（脚本失败时）

1. 把本目录放到目标机器，确认 `package.json` 的 `name` 是 `deepseekbaby`。
2. 编辑目标 profile 的 `~/.dsh/profiles/<名字>/package.json`：

   ```json
   "dependencies": { "deepseekbaby": "link:D:/plugins/deepseekbaby" },
   "dsh": { "profile": { "bundles": [ ..., "deepseekbaby" ] } }
   ```

3. 建链接（Windows；macOS/Linux 用 `ln -s`）：

   ```bat
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\deepseekbaby" "D:\plugins\deepseekbaby"
   ```

4. 重启 DSH，在「设置 → 插件」里打开开关。

数据目录是 `$DSH_HOME/deepseekbaby/`（默认 `~/.dsh/deepseekbaby/`）。从旧版
`~/.dsh/node-chat/` 升级时会自动复制一次 `nodes.json` / `history.json`。

### 兼容性：依赖的 DSH 内部服务

本插件**没有** import 任何 `@deepseek-ai/*` 模块（`index.js` 只依赖 Node 内置模块），
它是通过这些服务接进 DSH 的。**这些名字都不是 DSH 的公开 API**，升级 DSH 后要
重新验证一遍：

| 能力 | 怎么拿到 | 用途 | 缺失时 |
|---|---|---|---|
| `webServer` | `ctx.inject` | 面板与 API | **必需**：注入回调不跑，整个插件静默不出现 |
| `llm` / `agentDefaultModel` | `ctx.get` | 对话 | 发不出消息；也配不了 `baseURL` 就彻底不可用 |
| `workspaceRegistry` / `workingDirectory` | `ctx.get` | 默认工作区 | 退到进程 cwd |
| `sessionQuery` | `ctx.get` | 导入 DSH 会话作为新任务起点 | 「从会话导入」列表为空 |
| `attachments` | `ctx.get` | 图片给模型看 | 图片仍存工作区，但模型只看到路径文字 |
| `web` | `ctx.get` | 联网搜索首选通路 | 用 `deepseekAccount` 令牌直连 |
| `deepseekAccount` | `ctx.get` | 无 initiator 时的搜索凭证 | 需要 `DEEPSEEK_API_KEY`，否则搜索不可用 |
| `pluginManager` | `ctx.get` | 面板里的 ⟳ 重启 | 按钮报错，手动去设置里关开 |
| `@deepseek-ai/dsh-client-ui-layout` | 客户端 `inject` | 右下角浮层按钮 | 按钮不出现（控制台有 error 日志） |
| `@deepseek-ai/dsh-client-locale` | 客户端 `inject` | 按钮中英文案 | 文案退回键名 |

这张表和 `package.json` 的 `dsh.compat.seams`、`lib/compat.js` 的 `HOST_SEAMS`
是同一份清单（`test/compat.test.mjs` 会逐项比对，漏改一处就会红）。运行时实际探测结果：

```powershell
curl http://127.0.0.1:4101/node-chat/api/compat
```

返回 `usable`（面板能不能用）、`node`（Node 版本是否 ≥20）、`services`
（每个服务的 `present` 与 `reach`）、`missingRequired`、`degraded` 和一句中文
`summary`。插件启动时若有缺失，也会在宿主日志里打一行
`[deepseekbaby] ...`；设 `DEEPSEEKBABY_DEBUG=1` 会打印完整 JSON。
**反馈问题时贴这段，比“面板打不开”有用得多。**

### 版本边界

- **Node**：`engines.node` 要求 `>=20`（`lib/compat.js` 的 `MIN_NODE_MAJOR` 同步校验）。
  npm 会拦，手工拷目录时不会，所以 `install.ps1` 装前会检查一次，插件启动时也会探测
  并在 `/api/compat` 里报告。真的跑在旧 Node 上时插件只报警，不拒绝加载。
- **DSH**：目前只在 `dsh.compat.testedRange`（`>=1.2 <2`）范围内验证过。
  跨大版本升级后请先打开 `/node-chat/api/compat` 看 `usable` 与 `degraded`。
  DSH 的插件宿主模块不发布到 npm，所以 `peerDependencies` 里只有两个客户端包且标记为
  optional——**不会**因此去 npm 拉取，也不限制宿主版本，真正起作用的是这份清单与探测。

### 可移植性边界

- **平台**：Windows / macOS / Linux。目录选择器在 Windows 列盘符，其它平台给 `/` 和 home；
  工作区路径按平台绝对路径处理。
- **模型**：跟随 DSH 当前默认模型。图片要模型声明 image 输入，否则 DSH 会把图片降级成文字。
- **无构建、无 npm 依赖**：只用 Node 内置模块 + `ctx.get()` 的服务，目标机装 DSH 即可。
- **仍是本地单用户**：HTTP API 只做同源校验，没有鉴权；不要直接暴露到公网。
- **语言**：面板与提示词目前是中文。要做多语言，得把 `panel.html` 的文案抽出来。
- **路由前缀** `/node-chat` 若要改成 `/deepseekbaby`，需要同时改 `index.js` 的 `PREFIX`、
  `panel.html` 的 `API`、`client.js` 的 `PAGE`。
- **发布**：`private` 已去掉，`exports` 只暴露 `./index.js`、`./client.js`、`./icon.svg`
  （之前的 `./locale/*.json` 指向不存在的目录，已删除）；发布前把 `repository` /
  `homepage` / `bugs` 改成真实地址。

## 工作区（按主任务隔离）

每个**主任务**（根节点）拥有一个工作区，子节点按祖先继承：

- 新建主任务时可填绝对路径，或点「浏览…」逐级选目录；留空则自动创建
  `<默认工作区>/.deepseekbaby/workspaces/<标题>-<时间>`。
- 该任务里每一轮，`fs_*` 与 `shell` 只允许在这个目录内活动；越界返回
  `path outside allowed roots`，同级任务之间互不可见。
- 旧任务（创建时还没有 workspace 字段）仍沿用部署默认工作区、不隔离。
- 工作区路径存在节点里，界面右下角会显示当前任务的目录名。

## 附件（文件与图片）

输入框左边的「＋」选择文件，也可以直接拖进输入框或粘贴剪贴板图片：

- 文件保存到 `<工作区>/uploads/<时间>-<文件名>`，消息里给模型一条路径提示，
  它需要时用 `fs_read` 读取。
- 图片除保存一份到工作区外，还会写入 DSH 的 attachment store，消息以
  `{type:"image", attachment: ref}` 发出；`deepseek-account` 路由声明了
  text+image，模型能直接看图。
- 单文件上限 10MB，每条消息最多 8 个附件；上传接口按 base64 收包。

## 开发者模式（让它改自己）

新建开发者任务：点左侧栏底部的「🛠 开发者模式」按钮，确认标题后创建
（也可以在新建主任务的表单里用同样的入口；按钮只是把标题和工具档位预填好）。
这个任务的工作区会直接指向插件源码目录：

- 系统提示里带架构速查（`index.js`、`lib/*`、`panel.html`、`client.js` 各管什么）、
  测试命令和禁止项（不动 `~/.dsh` 数据、不跑 install 脚本）。
- 改完必须跑 `npm test`（含 `test/handler.test.mjs`，它 import `index.js`，能抓出语法错误）。
- 测试通过后模型调用 `restart_plugin` 工具；重启被排到**本轮保存并回复之后**，
  不会把正在写的历史截断。
- 开发者任务的上传文件落在源码目录的 `.dev-uploads/`，不混进普通任务的 `uploads/`。

边界：没有版本控制，模型能把插件改坏；建议先在插件目录 `git init` 并提交一次再玩。
它只能写这个工作区，改不到 profile、安装脚本或数据目录。

## 暂停

生成过程中输入框旁会出现「暂停」按钮（类比 DSH 的停止生成）。点一下会：

- 立即中断正在流式生成的模型请求（AbortSignal），不再等剩余 token；
- 正在运行的 shell 连同子进程一起杀掉（Windows 用 `taskkill /T`）；
- 跳过剩余工具调用，以及最后那次「收尾总结」模型请求——这两步通常最贵；
- 已生成的部分正文保留下来，消息右上角标「已暂停」。

暂停不是挂起后继续，而是结束本轮；想接着做，再发一条消息即可。上下文里只保留到中断为止的内容。

## 删除末尾对话

「删末尾」只允许删当前节点**最新的 N 轮**，不能从中间任意删。原因就是缓存：删中间会让
那条消息之后的所有前缀都变，下一轮整段按未命中计费；删末尾留下的每条消息都和以前发过的
字节一致，前缀缓存还能复用。删除不可恢复，确认框会显示当前节点约有多少轮。

## 联网

输入框上方的「联网」开关按轮生效：打开后这一轮额外提供 `web_search`（不受工具档位限制），
关掉则完全按档位走。开关状态存在 localStorage，切换会改变工具前缀，缓存会重建一次。

- 首选 DSH 的 `ctx.web` 服务；但该服务的 DeepSeek 账号分支要求有 Agent initiator
  （`agents.currentInitiator()`），面板发起的 HTTP 请求没有，会退到环境变量里的密钥。
- 退化链：`ctx.web` → 环境变量 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`，走 `authorization: Bearer`）
  → 已登录 DeepSeek 账号的令牌（`x-dsh-auth-token`）。两条都不可用时明确报错，并说出该设哪个
  环境变量；其它错误不吞，原样抛给模型。
- 换一家搜索供应商：改 `searchBaseURL` / `searchModel`，接口需兼容 Anthropic messages +
  `web_search_20250305` 工具。

## 统计口径

「上一轮」的输入/命中/输出取自本轮**最后一次** HTTP 请求；`usage.last` 单独存这次请求的
数字，`usage.input/hit/output` 是本轮所有工具轮次的累加。命中率 = 命中 /（输入 + 命中），
拿累加的输入去除单次命中会低估命中率。

## 消费统计（本地账本）

面板右下角的 ⚙ 打开「消费统计」：纯 DOM 柱状图 + 合计，数据来自
`$DSH_HOME/deepseekbaby/billing.jsonl`。

- 两种粒度：顶部「时 / 日」切换，默认**近 24 小时**（按小时分桶、补空桶），点「日」看近 30 天；
  选择记在 `localStorage`，下次打开沿用。
- 桶按本地时区分：`summary({ hours: 24 })` 返回 `hours[]`，每项含 `hour`、`turns`、
  `input/hit/output/amount`；`{ days: 30 }` 仍返回 `days[]`，接口兼容旧调用。
- **只追加**：每完成一轮写一行，删节点、删末尾对话都不会改写历史账目，重启也不丢。
- 计费口径：`input` 记完整输入（未命中 + 命中）；未命中 = 输入 − 命中；金额 =（未命中 × miss 单价 + 命中 × hit 单价 + 输出 × output 单价）/ 1e6。
  多工具轮次的 `usage.input/hit/output` 已累加，直接按整轮计价。v2.5.2 之前的旧账行只存了未命中数、命中被钳到同样大，
  命中率会显示成 100%，这部分无法回溯（账本只追加），新轮次起恢复正常。
- 中途抛错、没有落进 `history.json` 的轮次不会记账（因为没有 usage 可写）。
- `billing.jsonl` 损坏时读取会跳过半行；文件可以随时手工看或备份。

## 工具档位与省钱

每个任务（根节点）创建时固定一档工具：

| 档位 | 工具 | 每轮 schema 开销约 |
|---|---|---|
| `none` | 无 | 0 |
| `basic` | `fs_read` / `fs_list` / `shell` | 28 tokens |
| `full` | 全部 5 个 | 52 tokens |

档位中途不切（切了前缀缓存全灭，反而更贵）。其余省钱措施：

- 消息 id 由内容哈希生成，请求前缀稳定，缓存命中才可能高。
- 工具结果超过 4000 字只回传头 200 行 + 提示，模型需要时再分段读。
- 「丢掉本轮」的问答留在历史里但不进上下文。
- 统计里的「命中率 = hit /(input + hit)」，不是累计值。

### 轻量 / 极简模式

输入框上方的两个开关只影响**回答方式与工具范围**，不改模型、不改工具档位。两个开关可以**同时打开、叠加生效**：轻量决定"怎么做"，极简决定"说多少"。

- **轻量**：理解并总结用户的回答，先给出方案再动手，避免做多余工作。
  - 每轮开头先写一句「方案」：意图、要改什么、不改什么、预计几步；然后**在同一轮里直接开始做**，
    不再停下来等确认——早先"先只出方案、停下来等『执行』"的写法已取消，它正是"反复读两遍却不动手"的根源。
  - 只有三种情况才停下来问：缺关键信息无法推进、要删除或覆盖不可恢复的数据、方案和明确指令冲突。
  - 只做方案列出的必要步骤，不顺手重构、不加未要求的功能、不跑无关命令；工具档位（无 / 基础 / 完整）照旧生效。
  - 点消息下方的「继续执行」或直接输入「执行 / 做吧 / 直接改」，把后续轮次标记为执行阶段，做完给阶段报告。
  - 工具结果不压缩（4000 字符 / 200 行）、每轮正文都写进历史，下一轮能接着上一轮的进度做，不返工。
- **极简**：大幅压缩 AI 的回答，只说重要结论和进度，让上下文变得精简。
  - 先一句话给结果，再最多 3 条进度（已完成 / 未完成 / 下一步）。
  - 不展示工具调用：不提工具名、不贴参数、不复述输出、不贴代码或日志。
  - 用户追问细节时才展开；同时把工具结果压到 800 字 / 10 行。
  - 每轮正文照常写进历史，不会丢上一轮做到哪；复杂任务开着它仍可能多跑几轮。
  - 与轻量同开时，工具结果仍按极简的 800 字压缩，方案 / 执行两个阶段的提示词照常发送。

两个模式的提示都挂在最新一条用户消息尾部（不改 system prompt），所以开关只影响当轮尾巴，
缓存前缀保持稳定。两个都开时，两段提示合并成一条尾巴消息，顺序是先极简、后轻量。

## DSML 回退

某些模型/通道会把工具调用写成正文：

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="fs_list">
<｜｜DSML｜｜ parameter name="path" string="true">.</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

`lib/dsml.js` 会把这种块解析回真正的工具调用并执行，同时从回复、流式输出和
历史里剥掉标记；旧版本存进 `history.json` 的残留会在读取时一次性清理。

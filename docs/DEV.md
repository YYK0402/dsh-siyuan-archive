# dsh-siyuan-archive 维护文档（DEV）

> 记录真实踩过的坑与联调步骤。下一个维护者，看这里比看代码快。

## 1. 形态与结构

A 路 bundle 包（npm 可发布），直连思源 HTTP API，**不套 MCP**。

| 文件 | 角色 |
| --- | --- |
| `package.json` | npm + dsh manifest（`dsh.bundle.patch` / `dsh.client.platform=web`） |
| `cordis.patch.yml` | 发布用 patch 层，等价一行 `insert: id=siyuan-archive name=dsh-siyuan-archive` |
| `lib/index.js` | Host 半场：配置 + 凭据 + 权限 + 路由 + 6 个工具 |
| `lib/client.js` | Client 半场：设置页 5 卡（连接/token/归档/权限/工具开关） |
| `test/` | `harness.mjs`（纯函数）、`mock-siyuan.mjs`（替身）、`tools-e2e.mjs`（全链路） |

宿主契约（`apply`）：`ctx.inject(['tools','webServer'], sctx => mount(sctx))`；
工具注册 `ctx.tools.register(def)`、路由 `ctx.webServer.register({kind:'prefix', path, handler})`、
凭据 `ctx.get('credentials')`（`resolve/describe/set/unset`）、清理 `ctx.effect(fn, label)`。
客户端契约：`window.__ModuleLoader__.load({ id: <包名>, factory })`，`slots.inject('settings.section', ...)`。

## 2. 本地开发与联调

```bash
# 本地 link 安装（开发态）
dsh plugin --profile web add D:\code\dsh-siyuan

# 隔离实例迭代（不污染真实 profile）
DSH_HOME=/tmp/dsa-probe node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web \
  --host 127.0.0.1 --port 3099 --no-open
```

**CLI 通道与手工软链只能二选一**：同时存在会让同一插件挂两次、路由重复注册，profile 起不来。

### 改动生效方式

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js` | 不用重启。`dsh-client-hmr` 轮询 mtime/size，SSE 推浏览器 |
| `lib/index.js` | 必须重启。Node ESM 不允许二次 import 同一 URL |
| `cordis.patch.yml` / profile 组合树 | 必须重启 |

## 3. 关键设计取舍

### 3.1 零运行时依赖

只用 Node 内建 `fs/path/zlib` + `fetch`（Node ≥ 20）。别引 `node-fetch`/`undici`。

### 3.2 配置原子写

`$DSH_HOME/storages/siyuan-archive/config.json`：同目录写临时文件 → fsync → rename。
直接覆盖目标文件，写到一半被打断会留下半个 JSON，`readConfig` 只能回退默认值，用户会静默丢配置。

- `baseUrl` 必须是合法 http(s)，否则保存直接拒绝（`normalizeBaseUrlInput`），读配置时遇非法值回退默认并告警一次。
- 损坏的配置文件只告警一次（`reportConfigCorrupt`），避免每次工具调用刷日志。

### 3.3 token 存凭据库

token 存宿主 `credentials` 服务，ref `SIYUAN_TOKEN`（与思源官方环境变量同名，env 回退自然生效）。
设置页永不回显值，只显示「是否已配置 / 来源 / 可写」。env 来源只读（输入框置灰）。

### 3.4 权限模型（本项目核心）

数据：`config.permissions = { 笔记本id: { r,w,d, docs: { hPath前缀: {r,w,d} } } }`。

三条语义（见 `resolvePermission`，纯函数、已单测）：

1. **未显式配置的笔记本默认全拒**（读/写/删皆拒）；
2. 有配置 → 沿 hPath 取**最长前缀**匹配的显式节点，向上继承到笔记本级；
3. **子级只能收紧、不能放松**：子节点显式 `false` 可关闭继承来的权限，但无法把上级未授予的权限打开。

执行点：每个工具入口 `assertPerm(notebook, hPath, mode)`，在发任何 HTTP 请求**之前**判定。
`siyuan_list_notebooks` 只暴露笔记本名/id（无内容），不设权限。删除/写入/读取分别映射到 d/w/r。

**为什么不靠思源自带 ACL**：token 是管理员级凭据，思源 ACL 是协作用途、拦不住 API 直调。工具白名单是第一道，`assertPerm` 是第二道。

### 3.5 读类工具的权限归属映射

检索/读文档要先知道「这个块属于哪个笔记本、哪条路径」。用 SQL
`SELECT box, hpath FROM blocks WHERE id = '...'`（`locateBlock`）定位。检索结果批量定位
（`WHERE id IN (...)`）一次往返。定位不到按无权限过滤——不泄露无权限文档内容，只在提示里报条数。

### 3.6 客户端 API 基址 = 部署前缀自动定位

设置页所有读写走宿主 `/siyuan-archive/api/*`。**不能硬编码根绝对路径**：`/siyuan-archive/api/x`
只在「DSH 挂在 origin 根目录」时成立。DSH 整条前端链路（`/api`、`/plugins`、`/plugins/events`、
WS `remote.mux`）都是根绝对路径，所以反代必须做**前缀剥离**，浏览器侧实际该发的是
`/dsh/siyuan-archive/api/*`。硬编码会让所有「反代 + 路径前缀」部署的设置页整页报「读取配置失败」。

`client.js` 的做法（`ensureApiBase`，页内只探一次，结果缓存）：

1. **候选顺序**：localStorage 人工覆盖 → `location.pathname` 推断 → origin 根目录（历史行为兜底）。
2. **怎么推断**：`document.baseURI` 用不了——DSH 硬注入 `<base href="/">`（`dsh-host-frontend-static`），
   相对 URL 和 baseURI 全被锚在根。但 DSH **没有前端路由**（全仓无 `pushState`），
   `location.pathname` 就是外壳页面路径，也就是挂载前缀本身。
3. **怎么确认猜对**：宿主路由的响应必是 `{ok: boolean, ...}` 信封。猜错时命中静态兜底，
   拿到的是 404 空体或 `index.html`（JSON 解析失败 → `null`），据此换下一个候选。
4. **必须分开「打到了路由」与「业务报错」**：`ok:false` 是业务错误，说明前缀已对，
   原样上抛并把前缀缓存下来；只有非信封响应才算没打中，误差就是多一次失败请求。
5. **全落空不写缓存**：下次调用重新探，顺带覆盖「宿主比页面起得晚」的启动竞态；
   错误消息点名试过的前缀并给出 `localStorage.setItem('dsh-siyuan-archive.apiBase', '/前缀')`。

**前缀存成无尾斜杠**（`''` 或 `/dsh`），才能与 `API_ROUTE` 直接相接。归一化必须折叠开头的
重复斜杠：`//dsh` 在 fetch 里是**协议相对 URL**，会被解析成 `https://dsh/`，把请求打到外网去。

设置页页脚常驻显示「宿主接口前缀：/dsh/（自动）」——这类 bug 用户第一眼要能看出是「自动」
猜对了还是压根没猜对。回归测试在 `test/client.mjs`（53 条，离线，stub `window`/`location`/
`localStorage`/`fetch`）。

## 4. 思源 API 血泪坑（抄结论即可）

| 坑 | 解决 |
| --- | --- |
| DSH 0.1.7-alpha.1 之后 HTTP 响应不再自动解压（`EnvHttpProxyAgent` 丢 `content-encoding`） | `decodeResponseBody` **魔数优先**（看字节实际是什么），头只兜底 br；JSON 报错带 `content-encoding` 与前 8 字节 hex |
| 思源删除是**异步落库**：`removeDocByID`/`deleteBlock` 返回成功那一刻 blocks 行还在 | `waitUntilBlockGone` 指数退避复核，约 6 秒预算；慢到 1.5s 顺手告知 |
| `createDocWithMd` **非幂等**：同一 path 重复调用堆同名文档 | 归档前 `getIDsByHPath` 查重，存在则 `appendBlock` 而非新建 |
| `deleteBlock` 对**文档块静默 no-op**（报成功不删） | 先 `locateBlock` 查 type，文档块直接拒绝并指路 `remove_doc` |
| 删除复核的 6 秒预算要能被取消 | `sleepAbortable` + `AbortSignal.any([timeout, callerSignal])`；抛 `name==='AbortError'` 让 dsh-tools 标 `ABORTED` |
| 请求围栏防同源绕过（C10） | 比 `URL(origin).host`（含端口），不比 hostname，避免 `example.com:9999` 打到 `:3080` 设置页路由 |

## 5. 测试约定

- 默认不联网、不读环境变量、不碰真实实例：`harness.mjs` 用假 ctx，`tools-e2e.mjs` 把
  `globalThis.fetch` 指向 `mock-siyuan.mjs`，`DSH_HOME` 指向 `mkdtempSync` 临时目录。
- `client.mjs` 走浏览器那一侧：stub `window.__ModuleLoader__` 接住 factory，再 stub
  `location` / `localStorage` / `fetch`，直接测前缀归一化、候选顺序、信封识别与端到端回落。
- 替身刻意复刻真实行为（鉴权、`code` 信封、非幂等、异步落库）——**改测试时别把它们「修」掉**。
- `tools-e2e.mjs` 通过 `internals.buildTools(ctx, signal => internals.createApi(ctx, signal))` 拿到
  工具定义并直接调 `execute`，`ctx` 里 `credentials.resolve` 返回测试 token。

## 6. 发布清单与坑

- `files` 白名单只发 `lib/` + `cordis.patch.yml` + `CHANGELOG.md`。
- **不要在 `lib/` 留 `*.bak-*` 备份**：白名单目录内的文件不能用 `.npmignore` 排除，会被原样打进包。
- 兼容范围按 rc 线逐条枚举：`>=0.1.5-rc.1 || >=0.1.6-0 || >=0.1.7-0`（`semver` 只对同元组预发布放行）。
- **改名必须同时改三处**：`package.json.name`、`cordis.patch.yml` 的 `name`、`lib/client.js` 里
  `__ModuleLoader__.load({id})` 的 id + `data-plugin`/`data-plugin-css`——漏一处 Web 整页起不来。

## 7. 环境坑（部署前先确认）

思源内核常跑在容器里，读不到宿主机文件路径（所以不能走 MCP asset upload，只能直连 HTTP）。
**先确认 dsh 跑在哪**：宿主机 vs 容器决定 `baseUrl` 是 `127.0.0.1:6806` 还是容器网络地址。
客户端 `baseUrl` 的视角是「dsh 进程所在机器」。

### 7.1 挂在路径前缀下（`https://example.com/dsh/`）

DSH 官方只支持 origin 根部署（无 `basePath` 配置项、无 CLI 开关、宿主不剥前缀），但反代前缀
部署很常见。本插件的设置页已能自动定位前缀（§3.6），但**反代本身仍有两个硬要求**，不满足时
症状和原来的 bug 长得一样，别误判：

| 要求 | 不满足的后果 |
| --- | --- |
| **反代必须剥前缀**（nginx `proxy_pass http://127.0.0.1:3080/;` 带尾斜杠，或 `rewrite`；caddy `handle_path`） | 浏览器发的 `/dsh/siyuan-archive/api/*` 原样送到宿主，`/api`、`/plugins` 全挂——不是本插件的问题 |
| **反代必须保留 `Host`**（nginx `proxy_set_header Host $host;`） | 宿主信任围栏比 `URL(origin).host` 与 `Host` 头，不一致直接 403。围栏是 C10 加固，**不要为了绕过它去放宽** |

前缀部署时首次打开页面会被 DSH 鉴权 303 到 `Location: /`（`dsh-client-connection` 把
`url.pathname` 强制成 `/`），跳回 origin 根、丢掉前缀。让用户直接访问带前缀的地址即可
（cookie 本身是 origin 级的，带 `Path=/`，前缀下照常生效）。

**本插件不新增宿主路由**，因此改 `client.js` 不用重启宿主（§2 的生效方式表仍然成立），
前缀探测也不依赖新加的接口方法——升级期新旧 `index.js` 混跑不会把设置页打挂。

# Changelog

## 0.1.1

- **修复：归档后「索引与规范」索引表残留为空。** 思源 3.8.5 `createDocWithMd` 立刻返回 200，
  但随后紧接的 SQL 在写后读窗口（约 2s）内查不到刚建的文档；`syncIndexDoc` 同步跟进调用 SQL，
  旧实现只查一次就放弃，于是索引表永远只剩表头分隔符。改为：archive 把新建文档 id 透传给
  `syncIndexDoc`，SQL 重试到该 id 可见为止（预算 10×300ms = 3s）。同时过滤掉 `parseArchiveEntry`
  后 `when === ''` 的目录文档（典型是 `/2026-09` `/2026-09/杂项` 这种手动建的容器），它们曾经
  以空 category/when 形式污染索引表。
- **修复：第二次起归档索引表被复制堆叠。** `lib/index.js` 旧代码按 `type === 'table'` 找表格块，
  但思源 SQL schema 里表格块的 type 是 `'t'`（DOM 上是 `NodeTable`），`'table'` 在思源里根本不存在
  —— 每次同步都走 `appendBlock` 分支，旧表留底、新表追加，多归档几次后变成一堆空表叠加。改为
  `'t'`，命中现有表格 `updateBlock`，命中失败才 append。
- 测试替身 `test/mock-siyuan.mjs` 同步按真实思源修正：表格块 `type: 't'`（替身原来按错误的
  `'table'` 模拟，导致原 e2e 测不出这个 BUG），新增 `createAfterCreateMs` 选项模拟写后读窗口
  默认 0 不破现有用例，回归用例显式设为 600ms 触发 syncIndexDoc 的重试逻辑。
- e2e 新增 `[索引延迟一致与 type 修正]` 章节 6 个断言：延迟 mock 下归档成功、索引与规范文档生成、
  重试兜住后索引表含归档标题、第二次归档后表格不被 append 重复、两次归档标题都在、非归档命名的
  目录文档被剔除。

## 0.1.0

- **修复：设置页在「反代 + 路径前缀」部署下整页报「读取配置失败」。** `lib/client.js` 原先硬编码
  `fetch("/siyuan-archive/api/…")`，把「DSH 挂在 origin 根目录」当成了前提；DSH 整条前端链路都是
  根绝对路径，反代必然要剥前缀，于是浏览器该发 `/dsh/siyuan-archive/api/…`。改为页内自动定位部署
  前缀（人工覆盖 → `location.pathname` 推断 → origin 根兜底，试打第一个回出 `{ok:…}` 信封的前缀即
  答案），设置页页脚常驻显示识别结果。根目录部署行为逐字节不变。
- 归档正文顶部自动附元数据表（主题 / 类型 / 归档时间）；首次归档创建笔记本根的
  「索引与规范」文档，之后每次归档重建索引表（标题 / 类型 / 归档时间，标题列块引用可跳转），
  仅更新表格块、保留「规范」部分的用户改动。
- 权限卡递归树：逐层展开/折叠，子级开关显示继承到的有效权限、父级未授予时置灰禁用；
  `resolvePermission` 改为累计收紧语义（与 UI 一致）。
- 删除类工具 `siyuan_delete_block` / `siyuan_remove_doc`（danger 组默认关闭）：需 confirm=true +
  「删」权限；`waitUntilBlockGone` 指数退避复核异步落库（约 6 秒预算），文档块走 delete_block
  会被拦下指路 remove_doc。
- 自包含 e2e 测试 `test/tools-e2e.mjs` + `test/mock-siyuan.mjs` 替身（复刻鉴权、code 信封、
  createDocWithMd 非幂等、删除异步落库），对替身跑通归档/读/检索/删除全链路。
- `test/client.mjs`：`lib/client.js` 的部署前缀定位回归测试（归一化 / 候选顺序 / 信封识别 /
  端到端自动定位·回落·全落空自诊断），已并入 `npm test`。

## 0.0.1

- 骨架：bundle 包（package.json + cordis.patch.yml + lib/index.js + lib/client.js）。
- 连接卡（baseUrl / token / 测试连接）、归档卡（默认笔记本 / 归档路径 / 类型 / 标题模板）、
  权限卡（逐笔记本 r/w/d，默认全拒，顶级授予继承子级）、工具开关卡。
- 宿主半场：配置原子写、token 存凭据库、直连思源 HTTP、`siyuan_archive` / `siyuan_list_notebooks`
  两个工具（归档工具带权限判定）。
- 权限模型：最长 hPath 前缀匹配，子级只可收紧不可放松；`resolvePermission` 为可单测纯函数。
- 自包含单元测试 `test/harness.mjs`。

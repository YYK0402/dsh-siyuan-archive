# Changelog

## Unreleased

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

## 0.0.1

- 骨架：bundle 包（package.json + cordis.patch.yml + lib/index.js + lib/client.js）。
- 连接卡（baseUrl / token / 测试连接）、归档卡（默认笔记本 / 归档路径 / 类型 / 标题模板）、
  权限卡（逐笔记本 r/w/d，默认全拒，顶级授予继承子级）、工具开关卡。
- 宿主半场：配置原子写、token 存凭据库、直连思源 HTTP、`siyuan_archive` / `siyuan_list_notebooks`
  两个工具（归档工具带权限判定）。
- 权限模型：最长 hPath 前缀匹配，子级只可收紧不可放松；`resolvePermission` 为可单测纯函数。
- 自包含单元测试 `test/harness.mjs`。

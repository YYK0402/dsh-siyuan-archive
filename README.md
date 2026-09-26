# dsh-siyuan-archive

DeepSeek Harness（DSH）插件：把 DSH 对话产出的内容**归档到思源笔记**，带连接 / token / 归档 / 权限设置页。token 存宿主凭据库，权限按「笔记本 → 文档」继承、默认全拒。

直连思源 HTTP API，零运行时依赖，不套 MCP。

## 功能

- 一条命令归档：按「`<归档路径>/<年-月>/<类型>/<日期>_<时间>_<主题>_<内容>`」生成标题与路径写入思源。
- 设置页五卡：连接（地址 + 测试连接）、API token（永不回显）、归档（目标笔记本 / 路径 / 类型 / 标题模板）、权限（笔记本级授予 + 文档级收紧）、工具开关。
- 7 个工具：`siyuan_list_notebooks` / `siyuan_search` / `siyuan_read_doc` / `siyuan_archive` / `siyuan_delete_block` / `siyuan_remove_doc`。
- 权限模型：未配置的笔记本默认全拒；笔记本级勾选自动继承到其全部子文档；文档级只能收紧、不能放松。

## 前置条件

- Node ≥ 20，dsh（web profile）。
- 思源笔记已开启 API token（思源 → 设置 → 关于 → API token）。
- `baseUrl` 以 **dsh 进程所在机器** 的视角访问思源（默认 `http://127.0.0.1:6806`）。

## 安装

```bash
# 从 GitHub 安装（推荐；纯 JS 无构建步骤，无需额外授权）
dsh plugin --profile web add github:YYK0402/dsh-siyuan-archive#main

# 本地开发版（link）
dsh plugin --profile web add /path/to/dsh-siyuan

# 发布到 npm 后
dsh plugin --profile web add dsh-siyuan-archive
```

安装后重启 dsh web 进程（宿主半场 `lib/index.js` 改动必须重启；客户端半场会热更新）。

## 配置

DSH Web → 设置 → 左侧导航「思源归档」：

1. **连接**：填思源地址 → 保存地址 → 测试连接（显示版本号即成功）。
2. **API token**：粘贴 token → 保存（写入宿主凭据库）。
3. **归档**：加载笔记本 → 选目标笔记本、归档路径、默认类型、标题模板 → 保存。
4. **权限**：给目标笔记本勾选读/写（归档需「写」）；可展开文档对子路径收紧；未勾的默认全拒 → 保存。
5. **工具开关**：默认开 `siyuan_archive`；删除类默认关。

## 使用

在对话里直接下指令，模型会自动调用工具：

> 把下面这段需求归档到思源，主题「合同系统二期」，类型「需求」

生成文档：`/<归档路径>/2026-09/需求/2026-09-26_xxxx_合同系统二期_xxx`，正文 = 元数据表 + 内容。

## 工具清单

| 工具 | 分组 | 权限 | 说明 |
| --- | --- | --- | --- |
| `siyuan_list_notebooks` | 只读 | 无 | 列出笔记本名与 id |
| `siyuan_search` | 只读 | 读 | 全文检索，无权限命中会被过滤并提示条数 |
| `siyuan_read_doc` | 只读 | 读 | 读文档（text / markdown） |
| `siyuan_archive` | 归档 | 写 | 归档一段内容；同路径已存在则追加 |
| `siyuan_delete_block` | 危险 | 删 | 删除内容块（需 confirm=true） |
| `siyuan_remove_doc` | 危险 | 删 | 删除整篇文档（需 confirm=true） |

## 权限模型

- 未显式配置的笔记本：读/写/删**全拒**。
- 笔记本级勾选 = 授予，自动继承到其全部子文档。
- 文档级开关 = 显式拒绝（收紧）：只能关掉继承来的权限，不能凭空放开。
- 判定在每次工具调用发请求前执行；`siyuan_list_notebooks` 只暴露名/id，不设权限。

## 开发

```bash
npm test              # harness（纯函数）+ tools-e2e（对 mock-siyuan 替身全链路）
```

详见 [docs/DEV.md](docs/DEV.md)（联调步骤、思源 API 血泪坑、发布清单）。

## License

MIT

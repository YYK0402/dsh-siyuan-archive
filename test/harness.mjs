/**
 * 自包含单元测试：默认不联网、不读真实环境变量、不碰真实思源实例。
 * 只测纯函数（权限解析 / 归档路径标题）与 apply() 在假 ctx 下的注册行为。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-test-'))

const { internals, apply } = await import('../lib/index.js')

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    console.error('  ✗ ' + label)
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`)
}

// ── 权限解析 ────────────────────────────────────────────────────────────────

const nb = { r: true, w: true, d: false, docs: {} }
const perms = internals.normalizePermissions({
  'nb-a': { r: true, w: true, d: false, docs: { '/2026-09': { w: false }, '/2026-09/方案': { r: false, w: true } } },
})

console.log('\n[权限解析]')
eq(internals.resolvePermission(perms, 'nb-a', '/2026-09/方案/x', 'w'), false, '浅层 w=false 收紧对深层仍生效（深层 w=true 不能放松）')
eq(internals.resolvePermission(perms, 'nb-a', '/2026-09/方案/x', 'r'), false, '深层节点 r=false 收紧')
eq(internals.resolvePermission(perms, 'nb-a', '/2026-09/纪要/x', 'w'), false, '浅层前缀节点 w=false 收紧')
eq(internals.resolvePermission(perms, 'nb-a', '/2026-09/纪要/x', 'r'), true, '继承笔记本级 r=true')
eq(internals.resolvePermission(perms, 'nb-a', '/其它/x', 'w'), true, '无前缀命中 → 继承笔记本级')
eq(internals.resolvePermission(perms, 'nb-a', '/其它/x', 'd'), false, '笔记本级 d=false 全拒')
eq(internals.resolvePermission(perms, 'nb-a', '/x', 'r'), true, '根级前缀不命中，回落到笔记本')
eq(internals.resolvePermission(perms, 'nb-missing', '/x', 'r'), false, '未配置笔记本默认全拒')
eq(internals.resolvePermission(perms, 'nb-a', '/x', 'w'), true, '根级前缀不命中，回落到笔记本')

// 子级不能放松：笔记本 w=false，子级 w=true 应被忽略。
const narrow = internals.normalizePermissions({ 'nb-b': { r: false, w: false, d: false, docs: { '/x': { w: true } } } })
eq(internals.resolvePermission(narrow, 'nb-b', '/x/y', 'w'), false, '子级显式 true 不能放松上级 false')

// ── 归档路径与标题 ──────────────────────────────────────────────────────────

console.log('\n[归档路径与标题]')
const date = new Date(2026, 8, 23, 18, 12, 0)
const title = internals.buildArchiveTitle('{date}_{time}_{topic}_{desc}', '思源归档', '管线使用说明', date)
eq(title, '2026-09-23_1812_思源归档_管线使用说明', '标题按模板渲染')
const cfg = { archivePath: '', category: '纪要', titleTemplate: '{date}_{time}_{topic}_{desc}' }
eq(internals.buildArchivePath(cfg, '方案', '思源归档', '管线使用说明', date), '/2026-09/方案/2026-09-23_1812_思源归档_管线使用说明', '路径 = /年-月/类型/标题')
const cfgBase = { archivePath: '/DSH', category: '纪要', titleTemplate: '{date}_{time}_{topic}_{desc}' }
eq(internals.buildArchivePath(cfgBase, '方案', 't', 'd', date), '/DSH/2026-09/方案/2026-09-23_1812_t_d', '归档根路径前缀生效')
eq(internals.normalizeHPath('/a//b/'), '/a/b', 'normalizeHPath 去尾斜杠并折叠重复斜杠')
eq(internals.normalizeHPath('a/b'), '/a/b', 'normalizeHPath 补前斜杠')

// ── 配置归一化 ──────────────────────────────────────────────────────────────

console.log('\n[配置归一化]')
const normalized = internals.normalizeConfig({ baseUrl: 'not a url', defaultNotebook: 'n1', permissions: { n1: { r: true } } })
eq(normalized.baseUrl, 'http://127.0.0.1:6806', '非法 baseUrl 回退默认')
ok(normalized.permissions.n1.r === true, '权限被归一化进 config')
eq(internals.normalizeConfig({ archivePath: '/' }).archivePath, '', '根路径归一化为空')

// ── apply() 假 ctx 注册 ─────────────────────────────────────────────────────

console.log('\n[apply() 假 ctx 注册]')
const registered = []
const routes = []
const effectDisposers = []
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  webServer: { register: (spec) => { routes.push(spec); return () => {} } },
  get: (name) => {
    if (name === 'credentials') {
      return { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} }
    }
    if (name === 'webRuntime') return { trustedHosts: [] }
    return undefined
  },
  effect: (fn, label) => { effectDisposers.push(label); const d = fn(); return () => {} },
  logger: { warn: () => {}, info: () => {} },
}
apply(ctx)

ok(registered.some((t) => t.name === 'siyuan_archive'), '归档工具默认注册')
ok(registered.some((t) => t.name === 'siyuan_list_notebooks'), '列笔记本工具默认注册')
ok(registered.some((t) => t.name === 'siyuan_search'), '检索工具默认注册')
ok(registered.some((t) => t.name === 'siyuan_read_doc'), '读文档工具默认注册')
ok(routes.some((r) => r.path === '/siyuan-archive/api' && r.kind === 'prefix'), '设置页路由已注册')
ok(registered.every((t) => t.group === 'read' || t.group === 'archive'), '工具都带 group')

// 工具 schema 形状：官方 tools 注册表要求的字段。
const archive = registered.find((t) => t.name === 'siyuan_archive')
ok(archive.parameters.type === 'object' && archive.parameters.additionalProperties === false, '工具参数 schema 形状正确')
ok(Array.isArray(archive.parameters.required) && archive.parameters.required.includes('markdown'), 'required 包含 markdown')

// ── 内容辅助与块定位 ────────────────────────────────────────────────────────

console.log('\n[内容辅助与块定位]')
eq(internals.domToText('<p>a</p><h1>Title</h1><ul><li>x</li></ul>'), 'a\n# Title\n- x', 'DOM 转纯文本')
eq(internals.stripMarks('<mark>foo</mark>bar'), 'foobar', '去掉高亮标记')
const fakeSqlApi = async () => [{ box: 'nb-x', hpath: '/a/b', type: 'd' }]
const loc = await internals.locateBlock(fakeSqlApi, 'doc-1')
eq(loc.box, 'nb-x', 'locateBlock 取 box')
eq(loc.hpath, '/a/b', 'locateBlock 取 hpath')
eq(await internals.locateBlock(async () => [], 'missing'), null, 'locateBlock 不存在返回 null')

// ── 元数据表与索引 ──────────────────────────────────────────────────────────

console.log('\n[元数据表与索引]')
const mdTable = internals.buildMetadataTable('合同系统二期', '需求', new Date(2026, 8, 26, 18, 12, 0))
ok(mdTable.includes('| 主题 | 合同系统二期 |'), '元数据表含主题')
ok(mdTable.includes('2026-09-26 18:12'), '元数据表含归档时间')
const entry = internals.parseArchiveEntry({ id: 'doc1', hpath: '/2026-09/需求/2026-09-26_1812_合同系统二期_需求说明' })
eq(entry.title, '2026-09-26_1812_合同系统二期_需求说明', 'parseArchiveEntry 取标题')
eq(entry.category, '需求', 'parseArchiveEntry 取类型')
eq(entry.when, '2026-09-26 18:12', 'parseArchiveEntry 取归档时间')
const indexTable = internals.buildIndexTable([entry])
ok(indexTable.includes('((doc1 "2026-09-26_1812_合同系统二期_需求说明"))'), '索引表含块引用')

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)

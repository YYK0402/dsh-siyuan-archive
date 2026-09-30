/**
 * 工具端到端测试：对 mock-siyuan 替身跑通归档 / 读 / 删除，覆盖权限判定与异步落库复核。
 * 默认不联网、不读环境变量（DSH_HOME 指向临时目录，globalThis.fetch 指向替身）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockSiYuan } from './mock-siyuan.mjs'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-e2e-'))

const { internals } = await import('../lib/index.js')

const NB = '20260923180727-bh43cx1'
const mock = createMockSiYuan({ token: 'test-token' })
globalThis.fetch = mock.fetch

const ctx = {
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'test-token' }) }
    return undefined
  },
}
const tools = internals.buildTools(ctx, (signal) => internals.createApi(ctx, signal))
const tool = (name) => tools.find((entry) => entry.definition.name === name).definition

function writePerms(perms) {
  internals.writeConfig({
    baseUrl: 'http://mock.internal',
    defaultNotebook: NB,
    archivePath: '',
    category: '纪要',
    titleTemplate: '{date}_{time}_{topic}_{desc}',
    tools: {},
    permissions: perms,
  })
}

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
async function throws(fn, label) {
  try {
    await fn()
    ok(false, label + '（未抛错）')
  } catch {
    ok(true, label)
  }
}
async function run(name, args) {
  return (await tool(name).execute(args, {})).result
}

// ── 归档：权限授予后可写 ────────────────────────────────────────────────────

console.log('\n[归档]')
writePerms({ [NB]: { r: true, w: true, d: false, docs: {} } })
const archiveResult = await run('siyuan_archive', { markdown: '# 新方案\n\n内容', topic: '思源归档', desc: '管线使用说明', notebook: NB })
ok(archiveResult.includes('已归档'), '归档成功返回')
ok(archiveResult.includes(NB), '归档结果含笔记本 id')
const createdHPath = [...mock.state.blocks.values()].find((b) => b.type === 'd' && b.hpath.includes('思源归档_管线使用说明'))
ok(createdHPath !== undefined, '归档文档已按生成路径落库')
ok(createdHPath !== undefined && String(createdHPath.markdown).includes('| 主题 |'), '归档正文含元数据表')

// ── 索引与规范 ──────────────────────────────────────────────────────────────

console.log('\n[索引与规范]')
let indexDoc = [...mock.state.blocks.values()].find((b) => b.type === 'd' && b.hpath === '/索引与规范')
ok(indexDoc !== undefined, '首次归档生成「索引与规范」文档')
ok(indexDoc !== undefined && String(indexDoc.markdown).includes('思源归档_管线使用说明'), '索引表含归档标题')
ok(indexDoc !== undefined && String(indexDoc.markdown).includes('## 规范'), '索引文档含「规范」章节')

const archiveResult2 = await run('siyuan_archive', { markdown: '内容B', topic: '第二个主题', desc: '说明B', notebook: NB })
ok(archiveResult2.includes('已归档'), '第二次归档成功')
indexDoc = [...mock.state.blocks.values()].find((b) => b.type === 'd' && b.hpath === '/索引与规范')
ok(indexDoc !== undefined && String(indexDoc.markdown).includes('第二个主题') && String(indexDoc.markdown).includes('思源归档'), '索引表更新后含两篇归档')

// ── 归档：无写权限应拒绝 ────────────────────────────────────────────────────

console.log('\n[归档权限]')
writePerms({ [NB]: { r: true, w: false, d: false, docs: {} } })
await throws(() => run('siyuan_archive', { markdown: 'x', topic: 'T', notebook: NB }), '无写权限归档抛错')

// ── 读：有读权限可读、无读权限拒绝 ──────────────────────────────────────────

console.log('\n[读文档]')
writePerms({ [NB]: { r: true, w: false, d: false, docs: {} } })
const readResult = await run('siyuan_read_doc', { id: mock.state.seededDoc, format: 'markdown' })
ok(readResult.includes('正文内容'), '有读权限读到正文')
writePerms({ [NB]: { r: false, w: false, d: false, docs: {} } })
await throws(() => run('siyuan_read_doc', { id: mock.state.seededDoc }), '无读权限读文档抛错')

// ── 检索：权限过滤 ───────────────────────────────────────────────────────────

console.log('\n[检索]')
writePerms({ [NB]: { r: true, w: false, d: false, docs: {} } })
const searchResult = await run('siyuan_search', { query: '正文' })
ok(searchResult.includes('测试文档'), '有读权限能命中')
writePerms({ [NB]: { r: false, w: false, d: false, docs: {} } })
const searchDenied = await run('siyuan_search', { query: '正文' })
ok(searchDenied.includes('因权限被过滤'), '无读权限检索提示被过滤')

// ── 删除文档：confirm + 权限 + 异步落库复核 ──────────────────────────────────

console.log('\n[删除文档]')
writePerms({ [NB]: { r: true, w: true, d: true, docs: {} } })
await throws(() => run('siyuan_remove_doc', { docId: mock.state.seededDoc }), '缺 confirm 删除抛错')
await throws(() => run('siyuan_remove_doc', { docId: 'no-such-id', confirm: true }), '删除不存在的文档抛错')
const removeResult = await run('siyuan_remove_doc', { docId: mock.state.seededDoc, confirm: true })
ok(removeResult.includes('已删除'), '删除文档成功并复核')
ok(mock.state.blocks.get(mock.state.seededDoc) === undefined, '删除后块已从替身消失')

// ── 删除内容块：文档块走 delete_block 应被拦截 ───────────────────────────────

console.log('\n[删除内容块]')
writePerms({ [NB]: { r: true, w: true, d: true, docs: {} } })
const doc2 = mock.seedDoc(NB, '/2026-09/方案/要删块', '# x\n\n内容')
const block2 = mock.seedBlock(doc2, 'p', '一个段落')
await throws(() => run('siyuan_delete_block', { blockId: doc2, confirm: true }), '对文档块调 delete_block 抛错（指路 remove_doc）')
const delBlockResult = await run('siyuan_delete_block', { blockId: block2, confirm: true })
ok(delBlockResult.includes('已删除'), '删除内容块成功')
ok(mock.state.blocks.get(block2) === undefined, '内容块已从替身消失')

// ── 索引：写后读一致性延迟 + 表格 type 修正 ──────────────────────────────────
//
// 思源 3.8.5 createDocWithMd 立刻返回，但 SQL 在写后读窗口（约 1–2s）内查不到刚建的文档；
// syncIndexDoc 跟在 archive 之后同步调用，必须重试到可见为止，否则索引表会留空。
// 另：思源 SQL schema 里表格块的 type 是 't'（NodeTable），不是 'table'——'table' 是早期文档里的错字面量。

console.log('\n[索引延迟一致与 type 修正]')
const NB2 = '20260923180727-delay01'
// 600ms 延迟 < 重试窗口 5×200=1000ms，让 syncIndexDoc 重试 3 次后拿到（验证重试逻辑）；同时验 type='t' 后 updateBlock 仍命中。
const mock2 = createMockSiYuan({
  token: 'test-token',
  notebooks: [{ id: NB2, name: 'delay', closed: false }],
  createAfterCreateMs: 600,
})
globalThis.fetch = mock2.fetch
internals.writeConfig({
  baseUrl: 'http://mock2.internal',
  defaultNotebook: NB2,
  archivePath: '',
  category: '纪要',
  titleTemplate: '{date}_{time}_{topic}_{desc}',
  tools: {},
  permissions: { [NB2]: { r: true, w: true, d: false, docs: {} } },
})
const ctx2 = {
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'test-token' }) }
    return undefined
  },
}
const tools2 = internals.buildTools(ctx2, (signal) => internals.createApi(ctx2, signal))
const tool2 = (name) => tools2.find((entry) => entry.definition.name === name).definition
const run2 = async (name, args) => (await tool2(name).execute(args, {})).result

const delayedResult = await run2('siyuan_archive', { markdown: 'delay body', topic: '延迟一致', desc: 'regression', notebook: NB2 })
ok(delayedResult.includes('已归档'), '延迟 mock 下归档仍成功')
let idxDoc = [...mock2.state.blocks.values()].find((b) => b.type === 'd' && b.hpath === '/索引与规范')
ok(idxDoc !== undefined, '索引与规范文档已生成')
ok(idxDoc !== undefined && String(idxDoc.markdown).includes('延迟一致'), '重试兜住后索引表含归档标题（不再因延迟留空）')

// 第二次归档：验证表格 type='t' 修正后不会 append 重复表格，而是 update 现有那块
await run2('siyuan_archive', { markdown: 'body2', topic: '第二次', desc: 'regression', notebook: NB2 })
idxDoc = [...mock2.state.blocks.values()].find((b) => b.type === 'd' && b.hpath === '/索引与规范')
const tableRows = String(idxDoc.markdown).split('\n').filter((line) => line.startsWith('|') && line.includes('|'))
// 表头 + 1 分隔符 + 2 行数据 = 4 行表格内容（不应是 6+ 行=append 重复）
ok(tableRows.length === 4, `索引表行数为 4 头/分隔/两行 = ${tableRows.length}（不是 append 重复）`)
ok(String(idxDoc.markdown).includes('第二次') && String(idxDoc.markdown).includes('延迟一致'), '两次归档标题都在表中')

// 再测一条：手动建一个非归档命名的目录文档（与本会话真实复现一致），验证它不进索引表
const strayDirId = mock2.seedDoc(NB2, '/2026-09', '')
mock2.state.blocks.get(strayDirId)._visibleAt = 0
const straySubId = mock2.seedDoc(NB2, '/2026-09/杂项', '')
mock2.state.blocks.get(straySubId)._visibleAt = 0
await run2('siyuan_archive', { markdown: 'body3', topic: '第三次', desc: 'regression', notebook: NB2 })
idxDoc = [...mock2.state.blocks.values()].find((b) => b.type === 'd' && b.hpath === '/索引与规范')
const strayHdr = String(idxDoc.markdown).split('## 索引')[1] ?? ''
ok(!strayHdr.includes('| 杂项 |'), '非归档命名的目录文档（hpath=/2026-09/杂项）被剔除索引表')

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)

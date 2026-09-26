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

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)

/**
 * dsh-siyuan-archive — 思源笔记归档插件：宿主半场。
 *
 * 职责：
 *  1. 维护插件配置（$DSH_HOME/storages/siyuan-archive/config.json）：思源地址、归档目标
 *     笔记本、归档路径与标题模板、逐笔记本/文档的读写删权限；
 *  2. 把 API token 存进 dsh 凭据库（credential ref `SIYUAN_TOKEN`），配置页只说
 *     「是否已配置 / 来源 / 可写」，永不回显值；
 *  3. 注册 /siyuan-archive/api/* 路由，供 Web 客户端设置页读写配置与测试连接；
 *  4. 按配置动态注册模型可调用的 `siyuan_*` 工具，并在每个工具入口做权限判定。
 *
 * 思源接口约定（实测 3.8.3）：全部 POST，一律返回 HTTP 200，成败只看响应体 `code`
 * 字段（0 成功，非 0 失败，原因在 `msg`）；鉴权头为 `Authorization: Token <TOKEN>`。
 *
 * 本文件只依赖 node 内建模块：宿主进程提供 ctx.tools / ctx.webServer / ctx.credentials。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

export const name = 'siyuan-archive'

/** 配置页与客户端调用的路由前缀。 */
const API_PREFIX = '/siyuan-archive/api'
/** 存 token 的凭据引用（与思源官方环境变量同名，env 回退自然生效）。 */
const TOKEN_REF = 'SIYUAN_TOKEN'
const DEFAULT_BASE_URL = 'http://127.0.0.1:6806'
const REQUEST_TIMEOUT_MS = 20000
/** 设置页打开时的可达性探测：短超时，思源没开也不让页面干等。 */
const PROBE_TIMEOUT_MS = 4000
/** 「测试连接」每一项的探测超时。 */
const CONNECT_TEST_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 工具分组。read=只读，archive=归档写入，danger=破坏性（后续阶段再补）。 */
const TOOL_GROUPS = ['read', 'archive', 'danger']

/** 每组的默认开关状态：只在某个工具没有显式记录时兜底（新工具/新装/旧配置文件）。 */
const TOOL_GROUP_DEFAULTS = { read: true, archive: true, danger: false }

/** 权限的三种动作。 */
const PERM_MODES = ['r', 'w', 'd']
const PERM_MODE_LABELS = { r: '读取', w: '写入/归档', d: '删除' }

const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  // 归档目标笔记本 id；为空表示工具调用时必须显式传 notebook。
  defaultNotebook: '',
  // 归档根路径（人类路径，以 / 开头）。归档文档会生成在 `<archivePath>/<年-月>/<类型>/<标题>` 下。
  archivePath: '',
  // 归档默认「类型」（对应 /2026-09/<类型>/ 的目录名）：需求 / 方案 / 报告 / 数据 / 演示 / 纪要 / 杂项。
  category: '纪要',
  // 归档文档标题模板，占位符 {date}{time}{topic}{desc}{category}。
  titleTemplate: '{date}_{time}_{topic}_{desc}',
  // 工具开关按工具名存（`{ "siyuan_archive": false }`）。
  tools: {},
  // 权限：{ 笔记本id: { r,w,d, docs: { hPath前缀: { r,w,d } } } }。
  // 未列出的笔记本默认全拒；子级只能收紧、不能放松（见 resolvePermission）。
  permissions: {},
}

// ── 配置持久化 ──────────────────────────────────────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), 'storages', 'siyuan-archive', 'config.json')
}

let onConfigCorrupt = null
let warnedCorruptFile = ''

function reportConfigCorrupt(file, reason) {
  if (warnedCorruptFile === file) return
  warnedCorruptFile = file
  if (onConfigCorrupt === null) return
  try {
    onConfigCorrupt(file, reason)
  } catch {
    // 告警本身不得影响功能
  }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeHPath(value) {
  let text = String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (text === '' || text === '/') return '/'
  if (!text.startsWith('/')) text = '/' + text
  return text.replace(/\/+$/, '')
}

function normalizePermissions(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const [notebookId, entry] of Object.entries(source)) {
    if (notebookId === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const nb = { r: entry.r === true, w: entry.w === true, d: entry.d === true, docs: {} }
    if (entry.docs !== null && typeof entry.docs === 'object' && !Array.isArray(entry.docs)) {
      for (const [prefix, docEntry] of Object.entries(entry.docs)) {
        if (docEntry === null || typeof docEntry !== 'object' || Array.isArray(docEntry)) continue
        const normalized = normalizeHPath(prefix)
        if (normalized === '/') continue
        // 文档级只存显式 false（收紧）；无 false 的空条目直接丢弃。
        if (docEntry.r !== false && docEntry.w !== false && docEntry.d !== false) continue
        nb.docs[normalized] = {
          r: docEntry.r === false ? false : undefined,
          w: docEntry.w === false ? false : undefined,
          d: docEntry.d === false ? false : undefined,
        }
      }
    }
    out[notebookId] = nb
  }
  return out
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rawTools = source.tools !== null && typeof source.tools === 'object' ? source.tools : {}
  const tools = {}
  for (const [key, value] of Object.entries(rawTools)) {
    if (typeof value === 'boolean') tools[key] = value
  }
  const candidate = typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/+$/, '') : ''
  let baseUrl = DEFAULT_BASE_URL
  if (candidate !== '') {
    if (isHttpUrl(candidate)) baseUrl = candidate
    else reportConfigCorrupt(configPath(), `baseUrl 不是合法的 http(s) 地址：「${candidate}」，已回退默认值`)
  }
  const archivePath = typeof source.archivePath === 'string' ? normalizeHPath(source.archivePath) : ''
  return {
    baseUrl,
    defaultNotebook: typeof source.defaultNotebook === 'string' ? source.defaultNotebook : '',
    archivePath: archivePath === '/' ? '' : archivePath,
    category: typeof source.category === 'string' && source.category.trim() !== '' ? source.category.trim() : '纪要',
    titleTemplate: typeof source.titleTemplate === 'string' && source.titleTemplate.trim() !== '' ? source.titleTemplate : '{date}_{time}_{topic}_{desc}',
    tools,
    permissions: normalizePermissions(source.permissions),
  }
}

function readConfig() {
  const file = configPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeConfig(undefined)
    reportConfigCorrupt(file, `读取失败：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    reportConfigCorrupt(file, `不是合法 JSON：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  warnedCorruptFile = ''
  return normalizeConfig(parsed)
}

function writeConfig(config) {
  const target = configPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  try {
    const handle = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(handle, JSON.stringify(config, null, 2) + '\n', 'utf8')
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, target)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // 临时文件没建起来或已被清掉都无所谓
    }
    throw error
  }
}

// ── 凭据 ────────────────────────────────────────────────────────────────────

async function tokenValue(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = process.env[TOKEN_REF]
    return typeof ambient === 'string' ? ambient : ''
  }
  try {
    const hit = await credentials.resolve(TOKEN_REF)
    return hit !== undefined && typeof hit.value === 'string' ? hit.value : ''
  } catch {
    return ''
  }
}

async function tokenState(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = process.env[TOKEN_REF]
    return {
      value: typeof ambient === 'string' ? ambient : '',
      configured: typeof ambient === 'string' && ambient !== '',
      source: typeof ambient === 'string' && ambient !== '' ? 'env' : '',
      writable: false,
    }
  }
  let source = ''
  let writable = true
  let configured = false
  try {
    const info = await credentials.describe(TOKEN_REF)
    configured = info !== undefined && info.configured === true
    source = info !== undefined && typeof info.source === 'string' ? info.source : ''
    writable = info === undefined || info.writable !== false
  } catch {
    // describe 失败时退化为直接 resolve
  }
  let value = ''
  try {
    const hit = await credentials.resolve(TOKEN_REF)
    if (hit !== undefined && typeof hit.value === 'string') {
      value = hit.value
      configured = value !== ''
      if (source === '' && typeof hit.source === 'string') source = hit.source
    }
  } catch {
    // 未配置即视为空
  }
  return { value, configured, source, writable }
}

// ── 思源 HTTP 客户端 ────────────────────────────────────────────────────────

class SiYuanError extends Error {}

function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function requestSignal(timeoutMs, callerSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (callerSignal === undefined || typeof AbortSignal.any !== 'function') return timeout
  return AbortSignal.any([timeout, callerSignal])
}

function decodeResponseBody(buf, contentEncoding) {
  const tryDecompress = (fn) => {
    try {
      return fn(buf)
    } catch {
      return buf
    }
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return tryDecompress(gunzipSync)
  if (buf.length >= 2 && buf[0] === 0x78 && [0x01, 0x9c, 0xda].includes(buf[1])) return tryDecompress(inflateSync)
  const enc = typeof contentEncoding === 'string' ? contentEncoding.trim().toLowerCase() : ''
  if (enc === 'br') return tryDecompress(brotliDecompressSync)
  return buf
}

async function siyuanFetch(config, token, apiPath, payload, timeoutMs = REQUEST_TIMEOUT_MS, callerSignal = undefined) {
  const url = config.baseUrl.replace(/\/+$/, '') + apiPath
  const headers = { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }
  if (token !== '') headers.Authorization = 'Token ' + token
  assertNotAborted(callerSignal)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: requestSignal(timeoutMs, callerSignal),
    })
  } catch (error) {
    if (callerSignal?.aborted === true) throw abortError()
    throw new SiYuanError(`连接思源失败（${url}）：${error?.message ?? String(error)}`)
  }
  const rawBuf = Buffer.from(await response.arrayBuffer())
  const text = decodeResponseBody(rawBuf, response.headers.get('content-encoding')).toString('utf8')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    const enc = response.headers.get('content-encoding') ?? 'null'
    const headHex = [...rawBuf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    throw new SiYuanError(
      `思源 ${apiPath} 响应无法解析为 JSON（HTTP ${response.status}，content-encoding=${enc}，前 8 字节=${headHex}）：${text.slice(0, 200)}`,
    )
  }
  if (body === null || typeof body !== 'object' || body.code !== 0) {
    const code = body !== null && typeof body === 'object' ? body.code : '?'
    const msg = body !== null && typeof body === 'object' && typeof body.msg === 'string' ? body.msg : text.slice(0, 200)
    throw new SiYuanError(`思源接口 ${apiPath} 失败：code=${String(code)} msg=${msg}`)
  }
  return body.data
}

function createApi(ctx, signal = undefined) {
  return async (apiPath, payload) => {
    const config = readConfig()
    const token = await tokenValue(ctx)
    return siyuanFetch(config, token, apiPath, payload, REQUEST_TIMEOUT_MS, signal)
  }
}

// ── 权限模型 ────────────────────────────────────────────────────────────────

/** path 是否落在 prefix 之下（含自身）。prefix 与 path 都已归一化，以 / 开头。 */
function isPathUnder(prefix, target) {
  if (prefix === '/' || prefix === '') return true
  return target === prefix || target.startsWith(prefix + '/')
}

/**
 * 解析某个动作在某个笔记本某条人类路径上的最终权限。
 *
 * 语义（三条已确定，与客户端 UI 一致）：
 *  1. 笔记本未显式配置 → 全拒；
 *  2. 有配置 → 从笔记本级继承，再沿 hPath 逐层累计：路径上任一祖先（含自身）显式
 *     `false` 都会收紧；
 *  3. 子级只能收紧、不能放松：`false` 可关闭上级已授予的权限，`true` 无法把上级的
 *     `false` 重新打开。
 *
 * @param {object} permissions - normalizePermissions 的结果
 * @param {string} notebookId - 笔记本 id
 * @param {string} hPath - 人类路径（未归一化也可）
 * @param {'r'|'w'|'d'} mode - 动作
 * @returns {boolean}
 */
function resolvePermission(permissions, notebookId, hPath, mode) {
  const nb = permissions[notebookId]
  if (nb === undefined) return false
  let value = nb[mode] === true
  const target = normalizeHPath(hPath)
  for (const prefix of Object.keys(nb.docs)) {
    if (!isPathUnder(prefix, target)) continue
    if (nb.docs[prefix][mode] === false) value = false
    // true / undefined：不放松
  }
  return value
}

/**
 * 工具入口的权限判定。deny 即抛错，绝不静默降级。
 * @param {string} notebook - 笔记本 id
 * @param {string} hPath - 人类路径
 * @param {'r'|'w'|'d'} mode - 动作
 */
function assertPerm(notebook, hPath, mode) {
  const config = readConfig()
  if (notebook === undefined || notebook === '') {
    throw new Error('未指定笔记本：无法判定权限。请在设置页「归档」里选择默认笔记本，或工具调用时显式传 notebook。')
  }
  if (resolvePermission(config.permissions, notebook, hPath, mode)) return
  const where = hPath === undefined || hPath === '' ? `笔记本 ${notebook}` : `笔记本 ${notebook} 的 ${normalizeHPath(hPath)}`
  throw new Error(`权限不足：当前配置不允许对 ${where} 执行「${PERM_MODE_LABELS[mode]}」操作。请在设置页「权限」里勾选相应权限（顶级授予会自动继承到子级）。`)
}

// ── 归档标题与路径 ──────────────────────────────────────────────────────────

function pad2(value) {
  return String(value).padStart(2, '0')
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
}

function dateParts(date) {
  return {
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${pad2(date.getHours())}${pad2(date.getMinutes())}`,
    ym: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`,
  }
}

/** 用模板渲染归档文档标题。 */
function renderTitle(template, vars) {
  return template.replace(/\{(date|time|topic|desc|category)\}/g, (match, key) => (vars[key] === undefined || vars[key] === '' ? '' : String(vars[key])))
}

function buildArchiveTitle(template, topic, desc, date = new Date()) {
  const parts = dateParts(date)
  const title = renderTitle(template, {
    date: parts.date,
    time: parts.time,
    topic: sanitizeSegment(topic),
    desc: sanitizeSegment(desc),
    category: '',
  })
  return title.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
}

/** 计算归档文档的人类路径：`/<归档路径>/<年-月>/<类型>/<标题>`（始终以 / 开头）。 */
function buildArchivePath(config, category, topic, desc, date = new Date()) {
  const parts = dateParts(date)
  const base = String(config.archivePath ?? '').replace(/^\/+|\/+$/g, '')
  const cat = sanitizeSegment(category === '' ? config.category : category)
  const title = buildArchiveTitle(config.titleTemplate, topic, desc, date)
  const joined = [base, parts.ym, cat, title].filter((part) => part !== '').join('/')
  return '/' + joined
}

// ── 元数据表与索引文档 ──────────────────────────────────────────────────────

/** 归档正文顶部的元数据表。 */
function buildMetadataTable(topic, category, date = new Date()) {
  const parts = dateParts(date)
  const stamp = `${parts.date} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return [
    '| 项 | 值 |',
    '| --- | --- |',
    `| 主题 | ${sanitizeSegment(topic)} |`,
    `| 类型 | ${sanitizeSegment(category)} |`,
    `| 归档时间 | ${stamp} |`,
  ].join('\n')
}

/** 从归档文档的 hPath 解析索引行字段：标题 / 类型（年-月下的目录）/ 归档时间（标题前缀）。 */
function parseArchiveEntry(doc) {
  const hpath = normalizeHPath(doc.hpath)
  const segs = hpath.split('/').filter(Boolean)
  const title = segs.length > 0 ? segs[segs.length - 1] : hpath
  const category = segs.length >= 3 ? segs[segs.length - 2] : ''
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_/.exec(title)
  const when = match ? `${match[1]} ${match[2]}:${match[3]}` : ''
  return { id: doc.id, title, category, when, hpath }
}

/** 索引表 Markdown（标题列用思源块引用，可点击跳转）。 */
function buildIndexTable(entries) {
  const head = '| 标题 | 类型 | 归档时间 |'
  const sep = '| --- | --- | --- |'
  const rows = entries.map((entry) => `| ((${entry.id} "${entry.title}")) | ${entry.category} | ${entry.when} |`)
  return [head, sep, ...rows].join('\n')
}

/** 索引与规范文档的完整 Markdown（首次创建用）。 */
function buildIndexMarkdown(entries) {
  return [
    '# 索引与规范',
    '',
    '> 本文件由 dsh-siyuan-archive 插件自动维护，请勿手改下方「索引」表。',
    '',
    '## 规范',
    '',
    '- 命名格式：`<日期>_<时间>_<主题>_<内容>`，例如 `2026-09-26_1812_合同系统二期_需求说明`',
    '- 目录结构：`<归档路径>/<年-月>/<类型>/<标题>`',
    '- 类型：需求 / 方案 / 报告 / 数据 / 演示 / 纪要 / 杂项',
    '- 每篇归档正文顶部附带元数据表（主题 / 类型 / 归档时间）',
    '',
    '## 索引',
    '',
    buildIndexTable(entries),
  ].join('\n')
}

/**
 * 同步「索引与规范」文档：列出笔记本内归档文档，重建索引表。
 * 首次创建整个文档；已存在则只更新其中的表格块（保留「规范」部分的用户改动）。
 * @returns {Promise<{created: boolean}>}
 */
// 思源 write-after-read 一致性窗口：createDocWithMd 立刻返回，但 SQL 在 ~2s 内查不到刚建的文档。
// syncIndexDoc 跟在 archive 之后同步调用，必须重试到 SQL 可见为止，否则索引会空。
// 预算 ≈ 10 × 300ms = 3s，覆盖真实思源 3.8.5 的窗口（实测 sleep 2 后才可见）。
const INDEX_SQL_RETRY_TIMES = 10
const INDEX_SQL_RETRY_GAP_MS = 300

/**
 * 同步「索引与规范」文档：列出笔记本内归档文档，重建索引表。
 * 首次创建整个文档；已存在则只更新其中的表格块（保留「规范」部分的用户改动）。
 * 传 `newDocId` 时重试 SQL 直到该 id 可见为止——思源 createDocWithMd 立刻返回，但 SQL 在写后读窗口内查不到刚建的文档，必须等。
 * @returns {Promise<{created: boolean}>}
 */
async function syncIndexDoc(api, config, notebook, { newDocId, signal } = {}) {
  const indexPath = '/索引与规范'
  const stmt = `SELECT id, hpath FROM blocks WHERE box = '${sqlEscape(notebook)}' AND type = 'd' AND hpath != '/'`
  const docs = await queryDocsWithRetry(api, stmt, { newDocId, signal })
  const root = config.archivePath === '' || config.archivePath === '/' ? '' : config.archivePath
  const archived = root === '' ? docs : docs.filter((d) => d.hpath === root || d.hpath.startsWith(root + '/'))
  // parseArchiveEntry 后 `when === ''` 表示标题不符合「日期_时间_…」命名（典型是目录文档 / 手动建的非归档文档），从索引里剔除。
  const entries = archived.map(parseArchiveEntry).filter((entry) => entry.when !== '').sort((a, b) => b.hpath.localeCompare(a.hpath))
  const tableMarkdown = buildIndexTable(entries)
  const existing = await api('/api/filetree/getIDsByHPath', { notebook, path: indexPath })
  const ids = Array.isArray(existing) ? existing.filter((id) => typeof id === 'string' && id !== '') : []
  if (ids.length === 0) {
    await api('/api/filetree/createDocWithMd', { notebook, path: indexPath, markdown: buildIndexMarkdown(entries) })
    return { created: true }
  }
  const docId = ids[0]
  const children = await api('/api/block/getChildBlocks', { id: docId })
  // 思源 SQL schema 里表格块 type='t'（DOM 标识 NodeTable），不是 'table'。
  const tableBlock = (Array.isArray(children) ? children : []).find((b) => b?.type === 't' && typeof b.id === 'string' && b.id !== '')
  if (tableBlock !== undefined) {
    await api('/api/block/updateBlock', { id: tableBlock.id, dataType: 'markdown', data: tableMarkdown })
  } else {
    await api('/api/block/appendBlock', { dataType: 'markdown', data: tableMarkdown, parentID: docId })
  }
  return { created: false }
}

/**
 * 思源 createDocWithMd 返回后立即 SQL 查不到刚建的文档；这里循环重试。
 * - 传 `newDocId`：循环到该 id 出现在结果里为止（覆盖建文档的写后读窗口；即便笔记本里有别的旧文档也继续等）。
 * - 不传：循环到任意文档可见或预算耗尽（保留旧语义）。
 */
async function queryDocsWithRetry(api, stmt, { newDocId, attempts = INDEX_SQL_RETRY_TIMES, gapMs = INDEX_SQL_RETRY_GAP_MS, signal } = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < attempts; i += 1) {
    assertNotAborted(signal)
    const data = await api('/api/query/sql', { stmt })
    const rows = Array.isArray(data) ? data : []
    const docs = rows.filter((row) => typeof row?.id === 'string' && row.id !== '' && row.hpath !== '/索引与规范')
    if (newDocId !== undefined && newDocId !== '') {
      if (docs.some((d) => d.id === newDocId)) return docs
    } else if (docs.length > 0) {
      return docs
    }
    if (i < attempts - 1) await sleep(gapMs)
  }
  return []
}

// ── 工具集 ──────────────────────────────────────────────────────────────────

function stringProp(description) {
  return { type: 'string', description }
}

function defineTextTool(spec) {
  const properties = spec.parameters ?? {}
  const required = Array.isArray(spec.required) ? spec.required.filter((key) => Object.hasOwn(properties, key)) : []
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      assertNotAborted(signal)
      return { result: await spec.execute(args, signal) }
    },
  }
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''")
}

/** 用 SQL 定位一个块/文档所属的笔记本（box）与人类路径（hpath）；不存在返回 null。 */
async function locateBlock(api, id) {
  const rows = await api('/api/query/sql', { stmt: `SELECT box, hpath, type FROM blocks WHERE id = '${sqlEscape(id)}'` })
  if (!Array.isArray(rows) || rows.length === 0) return null
  return { box: rows[0].box ?? '', hpath: rows[0].hpath ?? '', type: rows[0].type ?? '' }
}

/** 把思源 getDoc 返回的 DOM 转成保留段落/标题/列表结构的纯文本。 */
function domToText(dom) {
  if (typeof dom !== 'string') return ''
  let text = dom.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>\s*/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '- ')
  text = text.replace(/<h([1-6])[^>]*>/gi, (_match, level) => '#'.repeat(Number(level)) + ' ')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/** 去掉思源检索结果里的高亮标记。 */
function stripMarks(value) {
  return typeof value === 'string' ? value.replace(/<\/?mark>/g, '') : ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 可被取消的 sleep：工具调用被取消时立刻结束等待。 */
function sleepAbortable(ms, signal) {
  if (signal === undefined) return sleep(ms)
  return new Promise((resolve, reject) => {
    const finish = (settle) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = () => finish(() => reject(abortError()))
    const timer = setTimeout(() => finish(resolve), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function blockStillExists(api, id) {
  return (await locateBlock(api, id)) !== null
}

/** 删除复核的默认预算：15 次探测、指数退避、总等待上限约 6 秒。 */
const DELETE_VERIFY_PROBE_LIMIT = 15
const DELETE_VERIFY_FIRST_DELAY_MS = 150
const DELETE_VERIFY_MAX_DELAY_MS = 1200
const DELETE_VERIFY_TOTAL_MS = 6000
const DELETE_VERIFY_SLOW_HINT_MS = 1500

/**
 * 轮询等待块真的消失。思源删除是异步落库：removeDocByID / deleteBlock 返回成功那一刻
 * blocks 行还在，稍后才消失，所以必须复核。指数退避、总预算约 6 秒。
 */
async function waitUntilBlockGone(api, id, options = {}) {
  const signal = options.signal
  const probeLimit = options.probeLimit ?? DELETE_VERIFY_PROBE_LIMIT
  const totalMs = options.totalMs ?? DELETE_VERIFY_TOTAL_MS
  const maxDelayMs = options.maxDelayMs ?? DELETE_VERIFY_MAX_DELAY_MS
  let delayMs = options.firstDelayMs ?? DELETE_VERIFY_FIRST_DELAY_MS
  let waitedMs = 0
  for (let attempt = 0; attempt < probeLimit; attempt += 1) {
    assertNotAborted(signal)
    if (!(await blockStillExists(api, id))) {
      return { gone: true, missed: waitedMs >= DELETE_VERIFY_SLOW_HINT_MS, waitedMs }
    }
    if (attempt === probeLimit - 1 || waitedMs >= totalMs) break
    const wait = Math.min(delayMs, Math.max(0, totalMs - waitedMs))
    if (wait > 0) {
      await sleepAbortable(wait, signal)
      waitedMs += wait
    }
    delayMs = Math.min(delayMs * 2, maxDelayMs)
  }
  assertNotAborted(signal)
  const gone = !(await blockStillExists(api, id))
  return { gone, missed: gone && waitedMs >= DELETE_VERIFY_SLOW_HINT_MS, waitedMs }
}

function deletionNotVerifiedMessage(kind, id, waitedMs) {
  return `思源已接受删除，但等待 ${waitedMs}ms 后 ${kind} ${id} 仍能查到（思源删除是异步落库，可能只是还没轮到）。请稍后用 siyuan_search 复核；若确实还在，再重试删除。`
}

function buildTools(ctx, makeApi) {
  return [
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_list_notebooks',
        description: '列出思源笔记的所有笔记本及其 id。归档或检索前用它确认真实笔记本 id。（仅暴露笔记本名与 id，不涉及内容，无需权限）',
        parameters: {},
        execute: async (_args, signal) => {
          const api = makeApi(signal)
          const data = await api('/api/notebook/lsNotebooks', {})
          const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
          if (notebooks.length === 0) return '（没有笔记本）'
          return notebooks
            .map((nb) => `${nb.closed === true ? '[已关闭] ' : ''}${nb.name ?? '(无名)'} | id=${nb.id ?? ''}`)
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_search',
        description: '全文检索思源笔记。只返回你被授予「读」权限的文档里的命中块；被权限过滤的命中会提示条数。每条给出文档 id（rootID）、块 id、人类路径与带高亮的片段。',
        parameters: {
          query: stringProp('检索关键词'),
          limit: { type: 'integer', description: '返回条数上限，默认 20' },
        },
        required: ['query'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const config = readConfig()
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
          const data = await api('/api/search/fullTextSearchBlock', { query: args.query, limit })
          const blocks = Array.isArray(data?.blocks) ? data.blocks : []
          if (blocks.length === 0) return `没有命中「${args.query}」的块。`
          // 批量定位每个命中块的根文档所属笔记本与路径，用于权限判定（默认全拒，定位不到即过滤）。
          const rootIds = [...new Set(blocks.map((block) => block.rootID).filter((id) => typeof id === 'string' && id !== ''))]
          const locById = new Map()
          if (rootIds.length > 0) {
            const quoted = rootIds.map((id) => `'${sqlEscape(id)}'`).join(',')
            try {
              const rows = await api('/api/query/sql', { stmt: `SELECT id, box, hpath FROM blocks WHERE id IN (${quoted})` })
              if (Array.isArray(rows)) for (const row of rows) locById.set(row.id, { box: row.box ?? '', hpath: row.hpath ?? '' })
            } catch {
              // 定位失败按无权限处理
            }
          }
          const allowed = []
          let filtered = 0
          for (const block of blocks) {
            const loc = locById.get(block.rootID)
            const box = typeof block.box === 'string' && block.box !== '' ? block.box : loc?.box ?? ''
            const hpath = typeof block.hPath === 'string' && block.hPath !== '' ? block.hPath : loc?.hpath ?? ''
            if (box === '' || !resolvePermission(config.permissions, box, hpath, 'r')) {
              filtered += 1
              continue
            }
            allowed.push(block)
          }
          if (allowed.length === 0) {
            return `命中了 ${blocks.length} 个块，但都因权限被过滤。请在设置页「权限」里给对应笔记本勾选「读」。`
          }
          const lines = allowed.map((block, index) => {
            const head = `${index + 1}. ${block.hPath ?? ''} | 文档id=${block.rootID ?? ''} | 块id=${block.id ?? ''} | 类型=${block.type ?? ''}`
            const snippet = stripMarks(block.content).replace(/\s+/g, ' ').slice(0, 200)
            return `${head}\n   ${snippet}`
          })
          const suffix = filtered > 0 ? `\n（另有 ${filtered} 个命中因权限不足被过滤）` : ''
          return lines.join('\n') + suffix
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_read_doc',
        description: '按文档 id 读取思源文档（需对所属笔记本/路径有「读」权限）。format=markdown 走导出接口返回 Markdown；默认 text 返回纯文本。',
        parameters: {
          id: stringProp('文档 id（检索结果里的 rootID）'),
          format: { type: 'string', enum: ['text', 'markdown'], description: '默认 text' },
        },
        required: ['id'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const loc = await locateBlock(api, args.id)
          if (loc === null) throw new Error(`文档 ${args.id} 不存在：可能是块 id，请用检索结果里的 rootID。`)
          assertPerm(loc.box, loc.hpath, 'r')
          if (args.format === 'markdown') {
            const data = await api('/api/export/exportMdContent', { id: args.id })
            const content = typeof data?.content === 'string' ? data.content : ''
            if (content === '') throw new Error(`文档 ${args.id} 没有导出到内容。`)
            return content
          }
          const data = await api('/api/filetree/getDoc', { id: args.id })
          const content = typeof data?.content === 'string' ? data.content : ''
          if (content === '') throw new Error(`文档 ${args.id} 没有取到内容：可能该 id 是块 id，或文档为空。`)
          return domToText(content)
        },
      }),
    },
    {
      group: 'archive',
      definition: defineTextTool({
        name: 'siyuan_archive',
        description:
          '把 DSH 对话产出的一段内容归档到思源笔记。按「<归档路径>/<年-月>/<类型>/<日期_时间_主题_内容>」生成标题与路径写入，正文顶部自动附元数据表；同路径已存在则追加。写入前做权限判定（需「写」权限）；对笔记本根有写权限时同步更新「索引与规范」文档。',
        parameters: {
          markdown: stringProp('要归档的内容正文 Markdown'),
          topic: stringProp('主题，如「合同系统二期」；同一主题的产出会聚在一起'),
          desc: stringProp('内容描述；默认取主题'),
          category: stringProp('类型：需求/方案/报告/数据/演示/纪要/杂项；省略用设置页默认'),
          notebook: stringProp('目标笔记本 id（省略则用设置页配置的默认笔记本）'),
        },
        required: ['markdown', 'topic'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const config = readConfig()
          const notebook = typeof args.notebook === 'string' && args.notebook.trim() !== '' ? args.notebook.trim() : config.defaultNotebook
          if (notebook === '') {
            throw new Error('未指定笔记本，且设置页里也没有配置默认笔记本。请传 notebook 参数，或先在设置页「归档」里选择默认笔记本。')
          }
          const topic = String(args.topic ?? '').trim()
          if (topic === '') throw new Error('topic 不能为空')
          const desc = typeof args.desc === 'string' && args.desc.trim() !== '' ? args.desc.trim() : topic
          const category = typeof args.category === 'string' && args.category.trim() !== '' ? args.category.trim() : config.category
          const now = new Date()
          const hPath = buildArchivePath(config, category, topic, desc, now)

          // 权限判定：归档 = 写入，落在目标笔记本 + 生成路径上。
          assertPerm(notebook, hPath, 'w')

          const existing = await api('/api/filetree/getIDsByHPath', { notebook, path: hPath })
          const ids = Array.isArray(existing) ? existing.filter((id) => typeof id === 'string' && id !== '') : []
          let result
          let archivedDocId = ''
          if (ids.length > 0) {
            await api('/api/block/appendBlock', { dataType: 'markdown', data: args.markdown, parentID: ids[0] })
            archivedDocId = ids[0]
            result = `已归档到已有文档并追加内容：\n文档 id=${ids[0]}\n笔记本=${notebook} 路径=${hPath}\n（同路径已有 ${ids.length} 篇，操作了第一篇；其余未动。）`
          } else {
            const markdown = buildMetadataTable(topic, category, now) + '\n\n' + args.markdown
            const id = await api('/api/filetree/createDocWithMd', { notebook, path: hPath, markdown })
            archivedDocId = typeof id === 'string' ? id : ''
            result = `已归档：\n文档 id=${typeof id === 'string' ? id : JSON.stringify(id)}\n笔记本=${notebook} 路径=${hPath}`
          }

          // 同步「索引与规范」文档（需对笔记本根有写权限；无权限或失败只提示、不阻断归档）。
          // 传 archivedDocId 让 syncIndexDoc 重试 SQL 到新建文档可见为止——绕开思源 createDocWithMd 的写后读窗口。
          let indexNote = ''
          if (resolvePermission(config.permissions, notebook, '/索引与规范', 'w')) {
            try {
              await syncIndexDoc(api, config, notebook, { newDocId: archivedDocId, signal })
            } catch (error) {
              indexNote = `\n（索引表更新失败：${error?.message ?? String(error)}）`
            }
          }
          return result + indexNote
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_delete_block',
        description: '删除一个内容块（需对所属文档有「删」权限，且 confirm=true）。删除标题块会连同其下内容一起删除。整篇文档请用 siyuan_remove_doc——文档块走这个接口只「报成功不删」。',
        parameters: {
          blockId: stringProp('要删除的块 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['blockId', 'confirm'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          const loc = await locateBlock(api, args.blockId)
          if (loc === null) throw new Error(`块 ${args.blockId} 不存在，请核对 id`)
          if (loc.type === 'd') throw new Error(`块 ${args.blockId} 是文档块：思源对文档走 /api/block/deleteBlock 会返回成功但不删除。删除整篇文档请用 siyuan_remove_doc。`)
          assertPerm(loc.box, loc.hpath, 'd')
          await api('/api/block/deleteBlock', { id: args.blockId })
          const verified = await waitUntilBlockGone(api, args.blockId, { signal })
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('块', args.blockId, verified.waitedMs))
          return verified.missed ? `已删除块 ${args.blockId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）` : `已删除块 ${args.blockId}`
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_remove_doc',
        description: '删除整篇文档（走 /api/filetree/removeDocByID，之后可在思源回收站找回）。需对所属文档有「删」权限，且 confirm=true。删除单个内容块请用 siyuan_delete_block。',
        parameters: {
          docId: stringProp('要删除的文档 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['docId', 'confirm'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          const loc = await locateBlock(api, args.docId)
          if (loc === null) throw new Error(`文档 ${args.docId} 不存在，请核对 id（检索结果里的 rootID 是文档 id）`)
          if (loc.type !== 'd') throw new Error(`块 ${args.docId} 是内容块（type=${loc.type}），不是整篇文档。删除单个内容块请用 siyuan_delete_block。`)
          assertPerm(loc.box, loc.hpath, 'd')
          await api('/api/filetree/removeDocByID', { id: args.docId })
          const verified = await waitUntilBlockGone(api, args.docId, { signal })
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('文档', args.docId, verified.waitedMs))
          return verified.missed ? `已删除文档 ${args.docId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）` : `已删除文档 ${args.docId}`
        },
      }),
    },
  ]
}

// ── 请求信任围栏与 JSON 响应 ────────────────────────────────────────────────

function headerValue(headers, key) {
  const value = headers[key]
  return Array.isArray(value) ? value[0] : value
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

function isTrustedRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const trusted = Array.isArray(trustedHosts) ? trustedHosts : []
  const isTrustedAuthority = trusted.some((candidate) => (typeof candidate === 'string' ? candidate === host || candidate === hostUrl.host : false))
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority) return false
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function isToolEnabled(config, name, group) {
  const explicit = config.tools[name]
  if (typeof explicit === 'boolean') return explicit
  const legacyGroup = config.tools[group]
  if (typeof legacyGroup === 'boolean') return legacyGroup
  return TOOL_GROUP_DEFAULTS[group] === true
}

function normalizeBaseUrlInput(raw) {
  const candidate = String(raw).trim().replace(/\/+$/, '')
  if (!isHttpUrl(candidate)) {
    throw new Error(`baseUrl 不是合法的 http(s) 地址：「${String(raw).trim()}」。示例：http://127.0.0.1:6806`)
  }
  return candidate
}

async function buildStatePayload(ctx, allTools) {
  const config = readConfig()
  const token = await tokenState(ctx)
  let version = ''
  let reachable = false
  try {
    version = String((await siyuanFetch(config, token.value, '/api/system/version', {}, PROBE_TIMEOUT_MS)) ?? '')
    reachable = true
  } catch {
    reachable = false
  }
  return {
    config: {
      baseUrl: config.baseUrl,
      defaultNotebook: config.defaultNotebook,
      archivePath: config.archivePath,
      category: config.category,
      titleTemplate: config.titleTemplate,
      permissions: config.permissions,
    },
    token: { configured: token.configured, source: token.source, writable: token.writable },
    reachable,
    version,
    toolGroups: TOOL_GROUPS,
    tools: allTools.map((entry) => ({
      name: entry.definition.name,
      group: entry.group,
      enabled: isToolEnabled(config, entry.definition.name, entry.group),
    })),
    toolCount: allTools.length,
  }
}

function mount(ctx) {
  onConfigCorrupt = (file, reason) => ctx.logger?.warn?.(`[dsh-siyuan-archive] 配置文件损坏，已回退默认值：${file}（${reason}）`)
  const allTools = buildTools(ctx, (signal) => createApi(ctx, signal))

  // ── 工具动态注册（按设置页的逐工具开关） ──
  let toolDisposers = []
  const disposeTools = () => {
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        // 已随插件树卸载时忽略
      }
    }
    toolDisposers = []
  }
  const syncTools = () => {
    disposeTools()
    const config = readConfig()
    const enabled = []
    for (const entry of allTools) {
      if (isToolEnabled(config, entry.definition.name, entry.group) !== true) continue
      entry.definition.group = entry.group
      toolDisposers.push(ctx.tools.register(entry.definition))
      enabled.push(entry.definition.name)
    }
    ctx.logger?.info?.(`[dsh-siyuan-archive] 已注册工具：${enabled.join(', ') || '(无)'}`)
  }
  syncTools()
  ctx.effect(() => disposeTools, 'dsh-siyuan-archive: tools')

  const statePayload = () => buildStatePayload(ctx, allTools)

  const probeConnection = async (body) => {
    const config = readConfig()
    if (typeof body?.baseUrl === 'string' && body.baseUrl.trim() !== '') {
      config.baseUrl = normalizeBaseUrlInput(body.baseUrl)
    }
    const stored = await tokenState(ctx)
    const draftToken = typeof body?.token === 'string' ? body.token.trim() : ''
    const token = draftToken === '' ? stored : { value: draftToken, configured: true, source: 'draft', writable: stored.writable }
    return { config, token }
  }

  const handlers = {
    async getState() {
      return statePayload()
    },
    async updateConfig(body) {
      const config = readConfig()
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') {
        config.baseUrl = normalizeBaseUrlInput(body.baseUrl)
      }
      if (typeof body.defaultNotebook === 'string') config.defaultNotebook = body.defaultNotebook
      if (typeof body.archivePath === 'string') {
        const normalized = normalizeHPath(body.archivePath)
        config.archivePath = normalized === '/' ? '' : normalized
      }
      if (typeof body.category === 'string' && body.category.trim() !== '') config.category = body.category.trim()
      if (typeof body.titleTemplate === 'string' && body.titleTemplate.trim() !== '') config.titleTemplate = body.titleTemplate.trim()
      if (body.permissions !== null && typeof body.permissions === 'object') {
        config.permissions = normalizePermissions(body.permissions)
      }
      if (body.tools !== null && typeof body.tools === 'object') {
        const incoming = {}
        for (const [key, value] of Object.entries(body.tools)) {
          if (typeof value === 'boolean') incoming[key] = value
        }
        if (Object.keys(incoming).some((key) => !TOOL_GROUPS.includes(key))) {
          const settled = {}
          for (const entry of allTools) {
            const name = entry.definition.name
            settled[name] = typeof incoming[name] === 'boolean' ? incoming[name] : isToolEnabled(config, name, entry.group)
          }
          config.tools = settled
        } else {
          config.tools = { ...config.tools, ...incoming }
        }
      }
      writeConfig(config)
      syncTools()
      return statePayload()
    },
    async setToken(body) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('宿主的凭据服务不可用，无法保存 token')
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('token 不能为空')
      await credentials.set(TOKEN_REF, token)
      return statePayload()
    },
    async clearToken() {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('宿主的凭据服务不可用')
      try {
        await credentials.unset(TOKEN_REF)
      } catch (error) {
        throw new Error(`清除失败：${error?.message ?? String(error)}`)
      }
      return statePayload()
    },
    async listNotebooks(body) {
      const { config, token } = await probeConnection(body)
      const data = await siyuanFetch(config, token.value, '/api/notebook/lsNotebooks', {}, CONNECT_TEST_TIMEOUT_MS)
      const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
      return {
        baseUrl: config.baseUrl,
        notebooks: notebooks.map((nb) => ({ id: nb.id ?? '', name: nb.name ?? '', closed: nb.closed === true })),
      }
    },
    async listDocTree(body) {
      const { config, token } = await probeConnection(body)
      const notebook = typeof body?.notebook === 'string' ? body.notebook.trim() : ''
      if (notebook === '') throw new Error('未指定 notebook')
      const data = await siyuanFetch(
        config,
        token.value,
        '/api/query/sql',
        { stmt: `SELECT id, hpath FROM blocks WHERE box = '${sqlEscape(notebook)}' AND type = 'd' AND hpath != '/'` },
        CONNECT_TEST_TIMEOUT_MS,
      )
      const docs = Array.isArray(data)
        ? data.map((row) => ({ id: row.id ?? '', hpath: row.hpath ?? '' })).filter((d) => d.id !== '' && d.hpath !== '')
        : []
      return { notebook, docs }
    },
    async testConnection(body) {
      const { config, token } = await probeConnection(body)
      const runProbe = async (label, apiPath, payload) => {
        try {
          const data = await siyuanFetch(config, token.value, apiPath, payload, CONNECT_TEST_TIMEOUT_MS)
          return { label, ok: true, detail: typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300) }
        } catch (error) {
          return { label, ok: false, detail: error?.message ?? String(error) }
        }
      }
      const probes = await Promise.all([
        runProbe('系统版本 /api/system/version', '/api/system/version', {}),
        runProbe('列出笔记本 /api/notebook/lsNotebooks', '/api/notebook/lsNotebooks', {}),
        runProbe('SQL 查询 /api/query/sql', '/api/query/sql', { stmt: 'SELECT 1 AS ok' }),
      ])
      return {
        ok: probes.every((probe) => probe.ok === true),
        version: probes[0].ok ? probes[0].detail : '',
        baseUrl: config.baseUrl,
        tokenConfigured: token.configured,
        tokenSource: token.source,
        probes,
      }
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const trustedHosts = ctx.get('webRuntime')?.trustedHosts
          if (!isTrustedRequest(req, trustedHosts)) {
            writeJson(res, 403, { ok: false, error: { message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : ''
          const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
          if (handler === undefined) {
            writeJson(res, 404, { ok: false, error: { message: `unknown siyuan-archive api method "${method}"` } })
            return
          }
          try {
            const body = await readJsonBody(req)
            const value = await handler(body)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: { message: error?.message ?? String(error) } })
          }
        },
      }),
    'dsh-siyuan-archive: settings routes',
  )
}

export const inject = ['tools', 'webServer']

export function apply(ctx) {
  mount(ctx)
}

/**
 * 测试缝：把纯函数与请求函数导出，仅用于单元测试（宿主按名字加载插件，多出的命名导出无副作用）。
 */
export const internals = {
  readConfig,
  writeConfig,
  configPath,
  normalizeConfig,
  normalizeBaseUrlInput,
  normalizeHPath,
  normalizePermissions,
  resolvePermission,
  assertPerm,
  isToolEnabled,
  buildArchivePath,
  buildArchiveTitle,
  renderTitle,
  sanitizeSegment,
  dateParts,
  buildMetadataTable,
  parseArchiveEntry,
  buildIndexTable,
  buildIndexMarkdown,
  syncIndexDoc,
  domToText,
  stripMarks,
  sqlEscape,
  locateBlock,
  blockStillExists,
  waitUntilBlockGone,
  deletionNotVerifiedMessage,
  sleepAbortable,
  buildTools,
  createApi,
  decodeResponseBody,
  siyuanFetch,
  buildStatePayload,
  TOOL_GROUP_DEFAULTS,
  DEFAULT_CONFIG,
}

/**
 * client.js 的「反代 + 路径前缀」回归测试。
 *
 * 背景：client.js 曾硬编码 `fetch("/siyuan-archive/api/…")`，把「DSH 挂在 origin 根目录」
 * 当成了前提。任何把 DSH 挂在路径前缀下的反代（nginx `proxy_pass .../;` / caddy
 * `handle_path` 都会剥前缀，于是浏览器该发 `/dsh/siyuan-archive/api/…`）都会让设置页整页
 * 报「读取配置失败」。这里钉死「前缀能自动定位 + 猜错能回落 + 回落不了能自解释」三条。
 *
 * 纯离线：只 stub `window` / `location` / `localStorage` / `fetch`，不联网、不碰真实 DOM。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// ── 装载 client.js：它不是 ESM，靠 window.__ModuleLoader__ 交出 factory ──

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const clientPath = new URL('../lib/client.js', import.meta.url)
await import(clientPath.href)

ok(loaded !== null, 'client.js 顶层注册了模块')
eq(loaded.id, 'dsh-siyuan-archive', '模块 id 与 package.json 的 name 一致')

const react = { createElement: () => ({}), useCallback: (fn) => fn, useEffect: () => {}, useState: () => [null, () => {}] }
// factory 直接返回 module.exports（exports 与之同一对象）
const internals = loaded.factory(() => react).internals

// ── 环境桩 ──

function setLocation(pathname) {
  globalThis.location = { pathname, origin: 'https://example.com', href: 'https://example.com' + pathname }
}
function setLocalStorage(get) {
  const store = { getItem: (key) => (get === null ? null : get[key] ?? null) }
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
}
function clearLocalStorage() {
  Reflect.deleteProperty(globalThis, 'localStorage')
}

/** 装一个假 fetch：只有 `hostBase` 前缀下的路由回信封，其余回 SPA 回退的 HTML。 */
function setFetch(hostBase, options = {}) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (options.throwOn && options.throwOn(url)) throw new TypeError('Failed to fetch')
    const routed = url.startsWith(hostBase + internals.API_ROUTE)
    if (!routed) {
      // 反代剥掉前缀后，宿主 webserver 的静态兜底会回 200 + index.html（HTML 解析失败 → null）
      return { status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
    }
    const method = url.slice((hostBase + internals.API_ROUTE).length)
    if (options.failMethod === method) {
      return { status: 200, json: async () => ({ ok: false, error: { message: '业务失败' } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { method, base: hostBase } }) }
  }
  return calls
}

const realFetch = globalThis.fetch
const realLocation = globalThis.location

// ── 前缀归一化 ──

console.log('\n[前缀归一化]')
eq(internals.normalizeApiBase(''), '', '空串 = origin 根')
eq(internals.normalizeApiBase('/'), '', '单斜杠 = origin 根')
eq(internals.normalizeApiBase('/dsh'), '/dsh', '已是规范形式（无尾斜杠）')
eq(internals.normalizeApiBase('/dsh/'), '/dsh', '剥掉尾斜杠，才能与 API_ROUTE 直接相接')
eq(internals.normalizeApiBase('dsh'), '/dsh', '补头斜杠')
eq(internals.normalizeApiBase('/tools/dsh/'), '/tools/dsh', '多级前缀原样保留')
eq(internals.normalizeApiBase('//dsh//'), '/dsh', '折叠重复斜杠（否则 fetch 会当成协议相对 URL 把请求打到外网）')
eq(internals.normalizeApiBase('/dsh?x=1#y'), '/dsh', '剥掉 query/hash，避免截断路径')
eq(internals.normalizeApiBase(undefined), '', 'undefined = origin 根')
eq(internals.normalizeApiBase(null), '', 'null = origin 根')

// ── 由页面路径反推前缀 ──

console.log('\n[由页面路径反推前缀]')
setLocation('/')
eq(internals.apiBaseFromLocation(), '', '根部署 → 无前缀')
setLocation('/dsh/')
eq(internals.apiBaseFromLocation(), '/dsh', '前缀部署 → /dsh')
setLocation('/dsh')
eq(internals.apiBaseFromLocation(), '/dsh', '无尾斜杠也认')
setLocation('/tools/dsh/index.html')
eq(internals.apiBaseFromLocation(), '/tools/dsh', '多级前缀 + index.html 剥掉文件名')
setLocation('/dsh/')
delete globalThis.location
eq(internals.apiBaseFromLocation(), '', '无 location（如测试环境）退回根目录')
globalThis.location = realLocation

// ── 候选顺序 ──

console.log('\n[候选顺序]')
setLocation('/dsh/')
clearLocalStorage()
eq(internals.apiBaseCandidates().join(','), '/dsh,', '自动探测：先页面路径、后 origin 根')
setLocalStorage({ [internals.API_BASE_KEY]: '/manual/' })
eq(internals.apiBaseCandidates().join(','), '/manual,/dsh,', '人工覆盖排最前（尾斜杠被归一化）')
setLocalStorage({ [internals.API_BASE_KEY]: '/dsh/' })
eq(internals.apiBaseCandidates().join(','), '/dsh,', '覆盖与推断重复时去重')
setLocalStorage({ [internals.API_BASE_KEY]: '/' })
eq(internals.apiBaseCandidates().join(','), ',/dsh', '覆盖写成「/」= 强制退回根目录，并排到最前优先试')
clearLocalStorage()
setLocation('/')
eq(internals.apiBaseCandidates().join(','), '', '根部署只留一个候选')
setLocation('/dsh/')

eq(internals.apiUrl('/dsh', 'getState'), '/dsh/siyuan-archive/api/getState', '前缀拼进路由')
eq(internals.apiUrl('', 'getState'), '/siyuan-archive/api/getState', '根部署仍是历史路径（向后兼容）')
eq(internals.apiUrl('', 'getState').startsWith('/'), true, '永远是绝对路径，不靠 <base href="/"> 兜底')

// ── 信封识别：404 空体 / SPA 回退 HTML 与真信封必须分得开 ──

console.log('\n[信封识别]')
ok(internals.isApiEnvelope({ ok: true, value: 1 }), '{ok:true} 是信封')
ok(internals.isApiEnvelope({ ok: false, error: { message: 'x' } }), '{ok:false} 也是信封（业务错误，前缀已对）')
ok(!internals.isApiEnvelope(null), 'null 不是信封（404 空体）')
ok(!internals.isApiEnvelope('a string'), '字符串不是信封（HTML 解析产物）')
ok(!internals.isApiEnvelope({ value: 1 }), '缺 ok 字段不是信封（撞上别的路由）')

// ── 端到端：前缀部署下自动定位 ──

console.log('\n[端到端 · 前缀部署]')
setLocation('/dsh/')
clearLocalStorage()
internals.resetApiBaseCache()
let calls = setFetch('/dsh')
const value = await internals.api('getState', {})
eq(value.method, 'getState', '前缀部署下读到了 getState 结果')
eq(value.base, '/dsh', '结果来自 /dsh 前缀')
ok(calls[0] === '/dsh/siyuan-archive/api/getState', '首个候选就用页面路径推断出的前缀（多数场景零浪费）')
eq(calls.length, 2, '探测 1 次 + 实际请求 1 次')
calls = setFetch('/dsh')
await internals.api('listNotebooks', {})
eq(calls.length, 1, '前缀缓存后每次只发 1 个请求')

// ── 端到端：根部署行为不变 ──

console.log('\n[端到端 · 根部署]')
setLocation('/')
internals.resetApiBaseCache()
calls = setFetch('')
const rootValue = await internals.api('getState', {})
eq(rootValue.base, '', '根部署解析出的前缀为空')
eq(calls[0], '/siyuan-archive/api/getState', '根部署仍打 /siyuan-archive/api/*（老用户零影响）')

// ── 端到端：推断错了要能回落，而不是整页报错 ──

console.log('\n[端到端 · 推断回落]')
setLocation('/dsh/')
internals.resetApiBaseCache()
calls = setFetch('') // 实际挂在根，页面路径推断错了
const fallbackValue = await internals.api('getState', {})
eq(fallbackValue.base, '', '推断失准时回落到 origin 根')
eq(calls.length, 3, '先试推断前缀（失败）+ origin 根探测 + 实际请求')
eq(calls[1], '/siyuan-archive/api/getState', '第二个候选是 origin 根')

// ── 端到端：前缀已对时，业务错误原样上抛且缓存前缀 ──

console.log('\n[端到端 · 业务错误]')
setLocation('/dsh/')
internals.resetApiBaseCache()
calls = setFetch('/dsh', { failMethod: 'updateConfig' })
let thrown = null
try {
  await internals.api('updateConfig', { baseUrl: 'x' })
} catch (error) {
  thrown = error
}
ok(thrown !== null && thrown.message === '业务失败', '宿主回 ok:false 时原样抛业务错误')
ok(!/找不到宿主接口/.test(thrown?.message ?? ''), '业务错误不会被误判成「找不到接口」')
calls = setFetch('/dsh', { failMethod: 'updateConfig' })
await internals.api('setToken', {})
eq(calls.length, 1, '回出信封即证明前缀正确并被缓存（不再重复探测）')

// ── 端到端：全落空要给出可操作的自诊断 ──

console.log('\n[端到端 · 全落空]')
setLocation('/dsh/')
internals.resetApiBaseCache()
calls = setFetch('/nonexistent')
thrown = null
try {
  await internals.api('getState', {})
} catch (error) {
  thrown = error
}
ok(thrown !== null && /找不到宿主接口/.test(thrown.message), '全落空报「找不到宿主接口」')
ok(thrown.message.includes('/dsh/'), '错误里点名试过的前缀')
ok(thrown.message.includes('origin 根目录'), '错误里点名 origin 根')
ok(thrown.message.includes('localStorage.setItem'), '错误里给出人工覆盖的具体命令')
eq(calls.length, 2, '只试了 2 个候选（/dsh/ 与根）')

// 落空不写缓存：宿主稍后才起好时，下一次调用能自愈。
calls = setFetch('/dsh')
const recovered = await internals.api('getState', {})
eq(recovered.base, '/dsh', '全落空后重新探测可以自愈（覆盖「宿主比页面先起好」竞态）')

// ── 人工覆盖：优先于推断 ──

console.log('\n[人工覆盖]')
setLocation('/wrong/')
internals.resetApiBaseCache()
setLocalStorage({ [internals.API_BASE_KEY]: 'dsh' }) // 故意不带头斜杠
calls = setFetch('/dsh')
const overridden = await internals.api('getState', {})
eq(overridden.base, '/dsh', '人工覆盖生效，优先于页面路径推断')
eq(calls[0], '/dsh/siyuan-archive/api/getState', '覆盖值先归一化再拼路由')
clearLocalStorage()

// ── 存储不可用（隐私模式）不能抛 ──

console.log('\n[存储不可用]')
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    throw new Error('SecurityError: 存储被禁用')
  },
})
setLocation('/dsh/')
eq(internals.readApiBaseOverride(), null, 'localStorage 抛异常时降级为未覆盖')
eq(internals.apiBaseCandidates().join(','), '/dsh,', '存储不可用不影响自动探测')
clearLocalStorage()

// ── 汇总 ──

globalThis.fetch = realFetch
if (globalThis.location !== realLocation) globalThis.location = realLocation
console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)

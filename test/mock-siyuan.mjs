/**
 * 思源 API 本地替身（测试用）。复刻真实行为：鉴权、`code` 信封、createDocWithMd 非幂等、
 * 删除异步落库（返回成功那一刻 blocks 行还在，稍后才消失）。
 * 默认不联网、不读环境变量、不碰真实实例。改测试时别把这里复刻的行为「修」掉。
 */

export function createMockSiYuan(options = {}) {
  const token = options.token ?? 'test-token'
  const deleteDelayMs = options.deleteDelayMs ?? 80
  // createDocWithMd 立刻返回，但 SQL 查不到刚建的文档，N 毫秒后才可见——复刻思源 3.8.5 的写后读一致性窗口。
  // 默认 0（生产 mock 同步可见，不破现有用例）；回归用例显式设一个数触发 syncIndexDoc 的重试逻辑。
  const createAfterCreateMs = options.createAfterCreateMs ?? 0
  const notebooks = options.notebooks ?? [{ id: '20260923180727-bh43cx1', name: 'DSH', closed: false }]
  const blocks = new Map()
  const pendingDeletes = new Set()
  const tableOwner = new Map()
  let seq = 0
  const nextId = () => `mock${Date.now()}${String(++seq).padStart(4, '0')}`

  function seedDoc(notebookId, hpath, markdown = '') {
    const id = nextId()
    blocks.set(id, { id, box: notebookId, hpath, type: 'd', markdown, _visibleAt: 0 })
    return id
  }

  function seedBlock(docId, type = 'p', markdown = '') {
    const doc = blocks.get(docId)
    const id = nextId()
    blocks.set(id, { id, box: doc.box, hpath: doc.hpath, type, markdown, rootId: docId })
    return id
  }

  const seededDoc = options.seed === false ? null : seedDoc(notebooks[0].id, '/2026-09/方案/测试文档', '# 测试文档\n\n正文内容')

  function sql(stmt) {
    const idEq = /WHERE\s+id\s*=\s*'([^']*)'/.exec(stmt)
    if (idEq) {
      const b = blocks.get(idEq[1])
      if (b === undefined) return []
      const row = {}
      if (/\bid\b/.test(stmt)) row.id = b.id
      if (/\bbox\b/.test(stmt)) row.box = b.box
      if (/\bhpath\b/.test(stmt)) row.hpath = b.hpath
      if (/\btype\b/.test(stmt)) row.type = b.type
      if (/\bmarkdown\b/.test(stmt)) row.markdown = b.markdown
      return [row]
    }
    const idIn = /WHERE\s+id\s+IN\s*\(([^)]*)\)/.exec(stmt)
    if (idIn) {
      const ids = [...idIn[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
      return ids.map((id) => (blocks.has(id) ? { id, box: blocks.get(id).box, hpath: blocks.get(id).hpath } : null)).filter(Boolean)
    }
    const boxEq = /WHERE\s+box\s*=\s*'([^']*)'/.exec(stmt)
    if (boxEq) {
      const box = boxEq[1]
      const now = Date.now()
      const rows = []
      for (const b of blocks.values()) {
        if (b.box !== box) continue
        if (/type\s*=\s*'d'/.test(stmt) && b.type !== 'd') continue
        if (/hpath\s*!=\s*'\/'/.test(stmt) && b.hpath === '/') continue
        if ((b._visibleAt ?? 0) > now) continue
        rows.push({ id: b.id, hpath: b.hpath })
      }
      return rows
    }
    return []
  }

  function idsByHPath(payload) {
    const out = []
    for (const b of blocks.values()) {
      if (b.box === payload.notebook && b.hpath === payload.path && b.type === 'd') out.push(b.id)
    }
    return out
  }

  function createDoc(payload) {
    const id = nextId()
    blocks.set(id, { id, box: payload.notebook, hpath: payload.path, type: 'd', markdown: payload.markdown ?? '', _visibleAt: createAfterCreateMs > 0 ? Date.now() + createAfterCreateMs : 0 })
    // 若正文含 Markdown 表格，登记一个 table 子块，供索引更新用。
    const md = payload.markdown ?? ''
    if (/^\|[\s:|-]+\|\s*$/m.test(md)) {
      const tblId = id + '-tbl'
      blocks.set(tblId, { id: tblId, box: payload.notebook, hpath: payload.path, type: 't', markdown: md, _visibleAt: createAfterCreateMs > 0 ? Date.now() + createAfterCreateMs : 0 })
      tableOwner.set(tblId, id)
    }
    return id
  }

  function getChildBlocks(payload) {
    const children = []
    for (const [tblId, ownerId] of tableOwner) {
      if (ownerId === payload.id) children.push({ id: tblId, type: 't', subType: '' })
    }
    return children
  }

  function updateBlock(payload) {
    const b = blocks.get(payload.id)
    if (b === undefined) return []
    if (b.type === 't') {
      const ownerId = tableOwner.get(payload.id)
      const doc = blocks.get(ownerId)
      if (doc !== undefined) {
        const idx = doc.markdown.lastIndexOf('## 索引')
        const head = idx >= 0 ? doc.markdown.slice(0, idx) : doc.markdown + '\n\n'
        doc.markdown = head + '## 索引\n\n' + (payload.data ?? '')
      }
      b.markdown = payload.data ?? ''
    } else {
      b.markdown = payload.data ?? ''
    }
    return []
  }

  function search(payload) {
    const query = String(payload.query ?? '')
    const hits = []
    for (const b of blocks.values()) {
      if (b.type !== 'd') continue
      if (query !== '' && !String(b.markdown).includes(query)) continue
      hits.push({ rootID: b.id, id: b.id, hPath: b.hpath, type: 'd', content: b.markdown })
    }
    return { blocks: hits }
  }

  function removeAsync(id) {
    if (pendingDeletes.has(id)) return
    pendingDeletes.add(id)
    setTimeout(() => {
      blocks.delete(id)
      pendingDeletes.delete(id)
    }, deleteDelayMs)
  }

  async function handle(reqUrl, init) {
    if ((init?.method ?? 'POST') !== 'POST') return { status: 405, body: { code: -1, msg: 'method not allowed' } }
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? ''
    if (auth !== 'Token ' + token) return { status: 200, body: { code: -1, msg: 'auth failed' } }
    let payload = {}
    try {
      payload = init?.body ? JSON.parse(init.body) : {}
    } catch {
      payload = {}
    }
    const pathname = new URL(reqUrl).pathname
    let data
    switch (pathname) {
      case '/api/system/version':
        data = '3.8.3'
        break
      case '/api/notebook/lsNotebooks':
        data = { notebooks }
        break
      case '/api/query/sql':
        data = sql(payload.stmt)
        break
      case '/api/search/fullTextSearchBlock':
        data = search(payload)
        break
      case '/api/filetree/getIDsByHPath':
        data = idsByHPath(payload)
        break
      case '/api/filetree/createDocWithMd':
        data = createDoc(payload)
        break
      case '/api/block/appendBlock':
        data = []
        break
      case '/api/block/getChildBlocks':
        data = getChildBlocks(payload)
        break
      case '/api/block/updateBlock':
        data = updateBlock(payload)
        break
      case '/api/export/exportMdContent': {
        const b = blocks.get(payload.id)
        data = b ? { hPath: b.hpath, content: b.markdown } : {}
        break
      }
      case '/api/filetree/getDoc': {
        const b = blocks.get(payload.id)
        data = b ? { content: `<p>${b.markdown}</p>` } : {}
        break
      }
      case '/api/block/deleteBlock':
        removeAsync(payload.id)
        data = []
        break
      case '/api/filetree/removeDocByID':
        removeAsync(payload.id)
        data = null
        break
      default:
        return { status: 200, body: { code: -1, msg: 'unhandled mock path ' + pathname } }
    }
    return { status: 200, body: { code: 0, msg: '', data } }
  }

  const fetch = async (url, init) => {
    const { status, body } = await handle(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  return { fetch, state: { blocks, notebooks, seededDoc }, seedDoc, seedBlock }
}

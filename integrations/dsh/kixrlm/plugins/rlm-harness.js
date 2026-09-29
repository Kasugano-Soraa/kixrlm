// rlm-harness — continual harness 状态（prime-agent rlm.harness 的 DSH 移植件）
//
// 状态模型（与 prime-agent 对齐）：四类条目 prompt|memory|skill|subagent，
// local/global 双域；local = <workspace>/.rlm/，global = <dsh-home>/rlm/。
// 所有写入（直接 CRUD 与 apply_refinement）都记录 before/after 快照进
// refinements.jsonl；rollback = 逆向编辑重放，带冲突检测（目标之后条目被
// 再次改动则拒绝，除非 force:true——force 为覆盖语义：把条目重置为逆向
// 快照，含时间戳，允许越过存在性冲突）。
// 状态文件损坏/不可读/结构失真/未知 schema → 一律隔离为 .corrupt-<ts> 并
// 降级为空态（degraded 标记透出，digest 持续提示隔离残留），绝不静默覆盖
// 原始文件。写入顺序：先 state 后日志；日志写失败时回滚 state 文件到原始
// 字节，不留"已提交但无记录"的半程状态。
// digest 经 systemPrompt 变量注入运行时上下文快照（空态渲染为空串 → 该
// context 被丢弃，零常驻上下文）；子代理经 lastWorkspace 回退同样可见。
// 已知边界（设计取舍，非缺陷）：跨进程并发写同一 store 为 last-writer-wins
// （无锁；单工作区多会话同时写才可能丢更新——见 README）。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const KINDS = ['prompt', 'memory', 'skill', 'subagent']
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/
const MAX_CONTENT = 8 * 1024        // content 字节数上限（UTF-8）
const MAX_OBJ_JSON = 4 * 1024       // reference/arguments 序列化上限
const MAX_TEXT_FIELD = 1000         // summary/rationale/expected_outcome 上限
const MAX_PER_KIND = 200
const DIGEST_PER_KIND = 6
const DIGEST_PREVIEW = 180
const ROLLBACK_WINDOW = 5000        // rollback 搜索窗口（条数）

function nowIso() { return new Date().toISOString() }

function emptyState() { return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} } } }

function flatten(text) { return String(text ?? '').split(/\s+/).join(' ').trim() }

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  // fsync 文件与目录：掉电后 rename 的内容必须已落盘，否则空文件会走进
  // 隔离路径并把上一次完好的状态当损坏丢弃（F7）。
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    const dir = fs.opendirSync(path.dirname(file))
    try { fs.fsyncSync(dir.fd) } finally { dir.closeSync() }
  } catch { /* 目录 fsync 尽力而为（部分平台/文件系统不支持） */ }
}

// 深度剥离 undefined：工具返回值必须是无损 JSON（registry 对输出做 JSON 契约
// 校验，undefined 字段会让整个调用被判定失败）。null 保留（显式清除语义）。
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v)
    return out
  }
  return value
}

// 冲突比较剔除易变时间戳：时间戳差异不构成内容冲突（写入必然刷新
// updated_at，把它纳入比较会让 rollback 后的历史 refinement 永远假冲突）。
function stripVolatile(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = {}
  for (const [k, v] of Object.entries(entry)) if (k !== 'created_at' && k !== 'updated_at') out[k] = v
  return out
}

function deepEqual(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

// 结构校验：任何"合法 JSON 但失真"的形态（entries 缺失/null、桶缺失/非对象、
// 未知 schema）都按损坏处理——隔离 + 降级，而不是归一化成空态后把失真写死。
function normalizeParsed(parsed) {
  const state = emptyState()
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('state must be a JSON object')
  if (parsed.schema !== undefined && parsed.schema !== 1) throw new Error(`unknown state schema ${JSON.stringify(parsed.schema)} (this build understands schema 1)`)
  if (parsed.entries == null) throw new Error('state is missing entries')
  if (typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('state.entries must be an object')
  for (const k of KINDS) {
    const bucket = parsed.entries[k]
    if (bucket == null) throw new Error(`state.entries.${k} is missing`)
    if (typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error(`state.entries.${k} must be an object`)
    state.entries[k] = bucket
  }
  return state
}

// 加载状态；读失败（非 ENOENT）、JSON 损坏、结构失真一律把原文件隔离为
// .corrupt-<ts>（只移一次），降级为空态继续并透出 degraded——绝不静默覆盖。
// raw 返回原始字节（ENOENT/隔离路径为 null），供日志写失败时字节级还原。
function loadStateResult(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: emptyState(), degraded: false, raw: null }
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now().toString(36)}`)
    } catch { /* 隔离失败也继续降级，不炸会话 */ }
    return { state: emptyState(), degraded: true, raw: null }
  }
  try {
    return { state: normalizeParsed(JSON.parse(text)), degraded: false, raw: text }
  } catch {
    try {
      const quarantine = `${file}.corrupt-${Date.now().toString(36)}`
      fs.renameSync(file, quarantine)
    } catch { /* 隔离失败也继续降级，不炸会话 */ }
    return { state: emptyState(), degraded: true, raw: null }
  }
}

// 原型链 id 防护：__proto__/constructor/toString 等会穿透普通对象的桶，
// 产生幻影读/静默 no-op/序列化崩溃。拒绝一切 Object.prototype 自有属性名。
function badId(id) {
  return typeof id !== 'string' || Object.prototype.hasOwnProperty.call(Object.prototype, id)
}

function capText(text, n) { return flatten(text).slice(0, n) }

function validateEntryFields(fields) {
  const out = {}
  if (fields.title !== undefined) out.title = flatten(fields.title).slice(0, 200)
  if (fields.content !== undefined) {
    const content = String(fields.content)
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) throw new Error(`content exceeds ${MAX_CONTENT} UTF-8 bytes`)
    out.content = content
  }
  if (fields.path !== undefined) out.path = fields.path == null ? null : String(fields.path)
  if (fields.reference !== undefined) {
    if (fields.reference != null && (typeof fields.reference !== 'object' || Array.isArray(fields.reference))) throw new Error('reference must be an object')
    if (fields.reference != null && JSON.stringify(fields.reference).length > MAX_OBJ_JSON) throw new Error(`reference exceeds ${MAX_OBJ_JSON} bytes serialized`)
    out.reference = fields.reference == null ? null : fields.reference
  }
  if (fields.arguments !== undefined) {
    if (fields.arguments != null && (typeof fields.arguments !== 'object' || Array.isArray(fields.arguments))) throw new Error('arguments must be an object')
    if (fields.arguments != null && JSON.stringify(fields.arguments).length > MAX_OBJ_JSON) throw new Error(`arguments exceeds ${MAX_OBJ_JSON} bytes serialized`)
    out.arguments = fields.arguments == null ? null : fields.arguments
  }
  if (fields.evidence !== undefined) out.evidence = fields.evidence == null ? null : flatten(fields.evidence).slice(0, 500)
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

// 可选字段的显式 null = 清除：合并后剥掉 null 键（create/update/force 还原共用）。
function stripNullOptionals(entry) {
  for (const k of ['path', 'reference', 'arguments', 'evidence']) {
    if (entry[k] === null) delete entry[k]
  }
  return entry
}

module.exports = {
  name: 'rlm-harness',
  inject: ['tools', 'systemPrompt'],
  apply(ctx) {
    const workspaces = new Map() // agentId -> workspaceRoot（从工具调用学习，供 digest 定位 local 域）
    let lastWorkspace = null // 会话树回退：子代理首次渲染 digest 时也能命中 local 域
    const degradedDirs = new Set() // 曾被隔离的损坏 store：会话内持续在 digest 透出数据丢失事实

    function globalDir() { return path.join(os.homedir(), '.dsh', 'rlm') }
    // workspace 解析链：exec 自带 header → 本会话已知（agentId）→ 会话树回退。
    // 第三级覆盖 exec 缺 session.header 的调用方（合成 exec / 部分子代理路径），
    // 与 rlm-kernel 的 resolveCwd 回退一致——同会话树的 workspace 本就相同。
    function resolveWorkspace(exec) {
      const agent = exec && exec.agent
      const cwd = agent && agent.session && agent.session && agent.session.header && agent.session.header.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
      const id = agent && agent.id
      if (id != null) {
        const known = workspaces.get(String(id))
        if (known) return known
      }
      return lastWorkspace
    }
    function dirFor(scope, exec) {
      if (scope === 'global') return globalDir()
      const ws = resolveWorkspace(exec)
      return ws ? path.join(ws, '.rlm') : null
    }
    function learnWorkspace(exec) {
      const agent = exec && exec.agent
      const id = agent && agent.id
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      if (typeof cwd === 'string' && cwd.length > 0) {
        lastWorkspace = cwd
        if (id) workspaces.set(String(id), cwd)
      }
    }

    function paths(dir) { return { state: path.join(dir, 'harness_state.json'), log: path.join(dir, 'refinements.jsonl') } }

    function saveState(dir, state) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      atomicWrite(paths(dir).state, JSON.stringify(state, null, 2))
    }

    // 两段提交：先落 state，再写日志；日志失败 → 用 rawBefore 字节级还原
    // state 文件（rawBefore===null 表示原先无文件 → 删除新建文件）。还原也
    // 失败时如实报告可能已提交，绝不谎报成功。
    function commit(dir, state, rawBefore, record) {
      saveState(dir, state)
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.appendFileSync(paths(dir).log, JSON.stringify(record) + '\n', { mode: 0o600 })
      } catch (e) {
        let restored = true
        try {
          if (rawBefore === null) fs.rmSync(paths(dir).state, { force: true })
          else atomicWrite(paths(dir).state, rawBefore)
        } catch { restored = false }
        throw new Error(`refinement log write failed (${String(e && e.message || e)}); state file ${restored ? 'was restored to its pre-change content' : 'MAY CONTAIN THE CHANGE (restore failed — inspect ' + paths(dir).state + ' manually)'}`)
      }
    }

    function readRefinements(dir, limit = 50) {
      try {
        const lines = fs.readFileSync(paths(dir).log, 'utf8').split('\n').filter(Boolean)
        const total = lines.length
        const records = lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        return { records, total }
      } catch { return { records: [], total: 0 } }
    }

    function requireKindId(args) {
      if (!KINDS.includes(args && args.kind)) throw new Error(`kind is required and must be one of ${KINDS.join('|')} (got ${JSON.stringify(args && args.kind)})`)
      const id = args && args.id
      if (!ID_RE.test(String(id || '')) || badId(id)) throw new Error(`id is required and must match ${ID_RE} and must not collide with Object.prototype builtins (got ${JSON.stringify(id)})`)
    }

    // force（仅 rollback 逆向重放可达）= 覆盖语义：
    //   create 遇已存在 → 用快照覆盖；update/delete 遇不存在 → 按快照还原/
    //   视为目标态已达成；update 遇已存在 → 整体替换为 before 快照（非合并）。
    // 时间戳从快照精确还原（created_at/updated_at），保证链式 rollback 可续。
    function applyEdits(state, edits, { forRollback = false, force = false } = {}) {
      const applied = []
      for (const edit of edits) {
        const { op, kind, id } = edit
        if (!KINDS.includes(kind)) throw new Error(`edit kind must be one of ${KINDS.join('|')} (got ${JSON.stringify(kind)})`)
        if (!ID_RE.test(String(id || '')) || badId(id)) throw new Error(`invalid entry id ${JSON.stringify(id)} (match ${ID_RE}, no Object.prototype builtins)`)
        const bucket = state.entries[kind]
        // own-key 读：原型链属性绝不当作条目（防幻影读/静默 no-op）。
        const existing = Object.prototype.hasOwnProperty.call(bucket, id) ? bucket[id] : null
        let before = existing ? JSON.parse(JSON.stringify(existing)) : null
        let after = null
        const snapshot = forRollback && edit.entry && typeof edit.entry === 'object' ? edit.entry : null
        if (op === 'create') {
          if (existing && !(force && snapshot)) throw new Error(`${kind}:${id} already exists`)
          const fields = validateEntryFields(snapshot ? snapshot : edit)
          if (!fields.title) throw new Error(`create ${kind}:${id} requires title`)
          if (!fields.content) throw new Error(`create ${kind}:${id} requires content`)
          after = stripNullOptionals({ id, kind, created_at: (snapshot && snapshot.created_at) || nowIso(), updated_at: (snapshot && snapshot.updated_at) || nowIso(), ...fields })
          bucket[id] = after
        } else if (op === 'update') {
          if (!existing) {
            if (!(force && snapshot)) throw new Error(`${kind}:${id} does not exist`)
            // 目标之后被删除 + force：整体还原 before 快照
            const fields = validateEntryFields(snapshot)
            after = stripNullOptionals({ id, kind, created_at: snapshot.created_at || nowIso(), updated_at: snapshot.updated_at || nowIso(), ...fields })
            bucket[id] = after
          } else if (force && snapshot) {
            // force：整体替换为快照（不合并当前值）
            const fields = validateEntryFields(snapshot)
            after = stripNullOptionals({ id, kind, created_at: snapshot.created_at || existing.created_at, updated_at: snapshot.updated_at || nowIso(), ...fields })
            bucket[id] = after
          } else {
            const fields = validateEntryFields(snapshot ? snapshot : edit)
            const merged = stripNullOptionals({ ...existing, ...fields, updated_at: nowIso() })
            bucket[id] = merged
            after = JSON.parse(JSON.stringify(merged))
          }
        } else if (op === 'delete') {
          if (!existing && !force) throw new Error(`${kind}:${id} does not exist`)
          if (existing) delete bucket[id]
        } else {
          throw new Error(`edit op must be create|update|delete (got ${JSON.stringify(op)})`)
        }
        applied.push({ op, kind, id, before, after })
      }
      for (const k of KINDS) {
        const n = Object.keys(state.entries[k]).length
        if (n > MAX_PER_KIND) throw new Error(`kind ${k} exceeds ${MAX_PER_KIND} entries`)
      }
      return applied
    }

    function digestFor(dir, label) {
      if (!dir) return ''
      const { state, degraded } = loadStateResult(paths(dir).state)
      if (degraded) degradedDirs.add(dir)
      // 隔离残留跨会话可见：新会话的 digest 也能提示数据丢失事实。
      let quarantined = 0
      try { quarantined = fs.readdirSync(dir).filter((f) => f.indexOf('.corrupt-') !== -1).length } catch { /* 目录不可读/不存在 */ }
      const lines = []
      if (degradedDirs.has(dir) || quarantined > 0) lines.push(`[${label} harness store was corrupt/unreadable and has been quarantined (previous entries lost); starting empty${quarantined > 1 ? `; ${quarantined} quarantined files present` : ''}]`)
      for (const k of KINDS) {
        const entries = Object.values(state.entries[k])
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id))
        if (entries.length === 0) continue
        lines.push(`[${label} ${k}: ${entries.length}]`)
        for (const e of entries.slice(0, DIGEST_PER_KIND)) {
          // id 也过 flatten：id 携带换行会破坏 digest 行结构（注入边界）。
          lines.push(`- ${flatten(e.id)} — ${flatten(e.title || '')}${e.content ? `: ${flatten(e.content).slice(0, DIGEST_PREVIEW)}` : ''}`)
        }
        if (entries.length > DIGEST_PER_KIND) lines.push(`  +${entries.length - DIGEST_PER_KIND} more (use harness action=overview kind=${k})`)
      }
      return lines.join('\n')
    }

    function renderDigest(context) {
      try {
        // 组装上下文的 scope 就是 Agent 本体：session-start 首次渲染即可从
        // session.header.cwd 定位 local 域，不等第一次工具调用。
        const scope = context && context.scope
        const ws = resolveWorkspace(scope && scope.id != null ? { agent: scope } : null)
        const local = ws ? digestFor(path.join(ws, '.rlm'), 'local') : ''
        const global = digestFor(globalDir(), 'global')
        const body = [local, global].filter(Boolean).join('\n')
        if (!body) return ''
        return [
          '## Continual harness state (durable across sessions; manage via the `harness` tool)',
          '',
          body,
          '',
          'Full entries: harness action=overview/get. Refine: the `refine` skill or harness action=apply_refinement; rollback: harness action=rollback.',
        ].join('\n')
      } catch {
        return '' // digest 失败绝不阻塞 prompt 组装
      }
    }

    const disposeTool = ctx.tools.register({
      name: 'harness',
      description: [
        'Read and refine this agent\'s continual harness state: durable prompt notes, memories, skills, and reusable subagent specs.',
        'Scopes: `local` (this workspace, default) or `global` (cross-session; use only for stable lessons).',
        'Actions: overview | get | create | update | delete | history | apply_refinement | rollback.',
        'Prefer apply_refinement for deliberate changes: it records summary/rationale/expected_outcome plus before/after snapshots of every edit, so `rollback` can replay the inverse.',
        'rollback refuses to clobber entries changed after the target refinement unless you pass force: true (force overwrites entries with their pre-refinement snapshots).',
        'create requires id (slug), kind, title, content. update patches title/content/path/reference/arguments/evidence (explicit null clears the optional fields). Entries are supplemental state — they never rewrite the base system prompt.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'overview | get | create | update | delete | history | apply_refinement | rollback' },
          scope: { type: 'string', description: '"local" (default, this workspace) or "global" (cross-session).' },
          kind: { type: 'string', description: 'prompt | memory | skill | subagent (also filters overview).' },
          id: { type: 'string', description: 'Entry id (slug: [a-z0-9][a-z0-9_-]).' },
          title: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string', description: 'Optional file path this entry points at.' },
          reference: { type: 'object', description: 'Optional executable reference, e.g. {type:"python", import, callable}.' },
          arguments: { type: 'object', description: 'Optional argument contract for skill/subagent entries.' },
          evidence: { type: 'string', description: 'What observation justifies this entry.' },
          summary: { type: 'string', description: 'apply_refinement: what this refinement does.' },
          rationale: { type: 'string', description: 'apply_refinement: why, with evidence.' },
          expected_outcome: { type: 'string', description: 'apply_refinement: what should improve.' },
          edits: { type: 'array', description: 'apply_refinement: [{op, kind, id, ...entry fields}]' },
          refinement_id: { type: 'string', description: 'rollback: which refinement to invert.' },
          force: { type: 'boolean', description: 'rollback: overwrite entries changed after the target refinement (conflict bypass).' },
        },
        required: ['action'],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        learnWorkspace(exec)
        const action = String(args && args.action || '')
        const rawScope = args && args.scope
        if (rawScope != null && rawScope !== 'local' && rawScope !== 'global') {
          return clean({ ok: false, error: `scope must be "local" or "global" (got ${JSON.stringify(rawScope)})` })
        }
        const scope = rawScope === 'global' ? 'global' : 'local'
        const dir = dirFor(scope, exec)
        if (!dir) return clean({ ok: false, error: 'cannot resolve workspace for the local harness store; use scope="global" or run from a session with a workspace' })
        const { state: stateFile } = paths(dir)
        const { state, degraded, raw } = loadStateResult(stateFile)
        if (degraded) degradedDirs.add(dir)
        // degraded 会话级粘滞：本会话曾隔离过该 store，后续所有响应持续透出
        // 数据丢失事实（跨会话由 digest 的隔离残留扫描兜底）。
        const sticky = degradedDirs.has(dir)

        try {
          let result
          switch (action) {
            case 'overview': {
              const kinds = KINDS.includes(args && args.kind) ? [args.kind] : KINDS
              const counts = {}
              const listing = {}
              for (const k of KINDS) {
                if (!kinds.includes(k)) { counts[k] = 0; listing[k] = []; continue }
                const entries = Object.values(state.entries[k]).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
                counts[k] = entries.length
                listing[k] = entries.slice(0, 40).map((e) => ({ id: e.id, title: e.title, updated_at: e.updated_at, preview: flatten(e.content || '').slice(0, 120) }))
              }
              result = { ok: true, scope, dir, degraded: sticky, counts, entries: listing }
              break
            }
            case 'get': {
              requireKindId(args)
              const bucket = state.entries[args.kind]
              const e = Object.prototype.hasOwnProperty.call(bucket, args.id) ? bucket[args.id] : null
              result = e ? { ok: true, entry: e } : { ok: false, error: `${args.kind}:${args.id} not found in ${scope} store` }
              break
            }
            case 'create':
            case 'update':
            case 'delete': {
              requireKindId(args)
              const applied = applyEdits(state, [{ op: action, kind: args.kind, id: args.id, title: args.title, content: args.content, path: args.path, reference: args.reference, arguments: args.arguments, evidence: args.evidence }])
              const record = { id: `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ts: nowIso(), summary: capText(args.summary || `${action} ${args.kind}:${args.id}`, MAX_TEXT_FIELD), rationale: capText(args.rationale || args.evidence || '', MAX_TEXT_FIELD), expected_outcome: capText(args.expected_outcome || '', MAX_TEXT_FIELD), edits: applied }
              commit(dir, state, raw, record)
              result = { ok: true, refinement_id: record.id, degraded: sticky, applied: applied.map(({ op, kind, id }) => ({ op, kind, id })) }
              break
            }
            case 'history': {
              const { records, total } = readRefinements(dir)
              result = { ok: true, scope, degraded: sticky, total, older: Math.max(0, total - records.length), refinements: records.map(({ id, ts, summary, rationale, expected_outcome, rollback_of, edits }) => ({ id, ts, summary, rationale, expected_outcome, rollback_of, edits: (edits || []).map(({ op, kind, id: eid }) => ({ op, kind, id: eid })) })) }
              break
            }
            case 'apply_refinement': {
              const edits = args.edits
              if (!Array.isArray(edits) || edits.length === 0) throw new Error('apply_refinement requires a non-empty edits array')
              if (!args.summary || !args.rationale) throw new Error('apply_refinement requires summary and rationale (evidence-backed small edits)')
              const applied = applyEdits(state, edits)
              const record = { id: `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ts: nowIso(), summary: capText(args.summary, MAX_TEXT_FIELD), rationale: capText(args.rationale, MAX_TEXT_FIELD), expected_outcome: capText(args.expected_outcome || '', MAX_TEXT_FIELD), edits: applied }
              commit(dir, state, raw, record)
              result = { ok: true, refinement_id: record.id, degraded: sticky, applied: applied.map(({ op, kind, id }) => ({ op, kind, id })) }
              break
            }
            case 'rollback': {
              const { records, total } = readRefinements(dir, ROLLBACK_WINDOW)
              const target = records.find((r) => r.id === args.refinement_id)
              if (!target) {
                throw new Error(`refinement ${JSON.stringify(args.refinement_id)} not found in ${scope} log${total > ROLLBACK_WINDOW ? ` (only the most recent ${ROLLBACK_WINDOW} of ${total} records are searched)` : ''}`)
              }
              // 冲突检测（内容级，忽略时间戳）：目标之后条目又被改过时，逆向
              // 重放会覆盖新状态——拒绝，除非 force。
              const conflicts = []
              for (const edit of target.edits || []) {
                const bucket = state.entries[edit.kind]
                const current = (bucket && Object.prototype.hasOwnProperty.call(bucket, edit.id)) ? bucket[edit.id] : null
                if (edit.op === 'create' || edit.op === 'update') {
                  if (!current) {
                    conflicts.push(`${edit.kind}:${edit.id} was deleted after ${target.id}`)
                  } else if (!deepEqual(stripVolatile(current), stripVolatile(edit.after))) {
                    conflicts.push(`${edit.kind}:${edit.id} was modified after ${target.id}`)
                  }
                } else if (edit.op === 'delete' && current) {
                  conflicts.push(`${edit.kind}:${edit.id} was re-created after ${target.id}`)
                }
              }
              if (conflicts.length > 0 && args.force !== true) {
                result = { ok: false, error: `rollback ${target.id} would clobber later changes; pass force: true to override`, conflicts }
                break
              }
              const inverse = []
              for (const edit of [...(target.edits || [])].reverse()) {
                if (edit.op === 'create') inverse.push({ op: 'delete', kind: edit.kind, id: edit.id })
                else if (edit.op === 'delete') inverse.push({ op: 'create', kind: edit.kind, id: edit.id, entry: edit.before })
                else if (edit.op === 'update') inverse.push({ op: 'update', kind: edit.kind, id: edit.id, entry: edit.before })
              }
              const applied = applyEdits(state, inverse, { forRollback: true, force: args.force === true })
              const record = { id: `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ts: nowIso(), summary: `rollback ${target.id}`, rationale: capText(args.rationale || '', MAX_TEXT_FIELD), expected_outcome: '', rollback_of: target.id, edits: applied }
              commit(dir, state, raw, record)
              result = { ok: true, refinement_id: record.id, rolled_back: target.id, degraded: sticky, applied: applied.map(({ op, kind, id }) => ({ op, kind, id })) }
              break
            }
            default:
              result = { ok: false, error: `unknown action ${JSON.stringify(action)}; expected overview|get|create|update|delete|history|apply_refinement|rollback` }
          }
          return clean(result)
        } catch (e) {
          return clean({ ok: false, error: String(e && e.message || e) })
        }
      },
    })

    // digest 注入：变量 + 运行时上下文条目；空态渲染为空串 → 该 context 被丢弃，零常驻成本。
    const disposeVar = ctx.systemPrompt.variable('rlm_harness_digest', renderDigest)
    const disposeCtx = ctx.systemPrompt.context({ name: 'rlm:harness-digest', order: 130, text: '{{rlm_harness_digest}}' })

    ctx.effect(() => () => { disposeTool(); disposeVar(); disposeCtx() })
    ctx.logger?.info?.('[rlm-harness] harness 工具与 digest 注入已注册')
  },
}

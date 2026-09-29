// rlm-harness.js 插件回归测试（mock DSH ctx + 临时目录）。
//
// 覆盖：
//   - 注册形状（harness 工具、rlm_harness_digest 变量、rlm:harness-digest context）
//   - CRUD：create/get/update/delete、重复 create、字段校验、id/kind/scope 校验
//   - apply_refinement：edits 批量、快照、refinements.jsonl、history
//   - rollback：逆向重放、冲突检测（后续改动）、force、回滚 rollback
//   - 状态损坏 → 隔离 + degraded；digest 透出丢失事实
//   - digest：local/global、空态零成本（渲染空串）
//   - workspace 解析：缺 header 报错（fresh 实例）
// 运行：node plugins/rlm-harness.test.js
'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const plugin = require(path.join(__dirname, 'rlm-harness.js'))

// global 域指向 os.homedir()/.dsh/rlm —— 测试进程 HOME 重定向到临时目录
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-harness-home-'))
process.env.HOME = FAKE_HOME

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-harness-ws-'))

function makeCtx() {
  const registered = []
  const effects = []
  const vars = {}
  const contexts = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    systemPrompt: {
      variable(name, fn) { vars[name] = fn; return () => delete vars[name] },
      context(c) { contexts.push(c); return () => {} },
    },
    effect(fn) { effects.push(fn()) },
  }
  return { ctx, registered, effects, vars, contexts }
}

const exec = { agent: { id: 'ag-1', session: { header: { cwd: WS } } } }

async function main() {
  const { ctx, registered, vars, contexts } = makeCtx()
  plugin.apply(ctx)
  assert.strictEqual(registered.length, 1)
  const tool = registered[0]
  assert.strictEqual(tool.name, 'harness')
  assert.strictEqual(typeof tool.execute, 'function')
  assert.strictEqual(typeof vars.rlm_harness_digest, 'function', 'digest 变量已注册')
  assert.strictEqual(contexts.length, 1, 'digest context 已注册')
  assert.strictEqual(contexts[0].name, 'rlm:harness-digest')
  assert.strictEqual(contexts[0].order, 130)
  assert.strictEqual(contexts[0].text, '{{rlm_harness_digest}}')

  const call = (args) => tool.execute(args, exec)
  const localDir = path.join(WS, '.rlm')

  // ── 空态 ─────────────────────────────────────────────────────────────────
  let r = await call({ action: 'overview' })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.counts, { prompt: 0, memory: 0, skill: 0, subagent: 0 })
  assert.strictEqual(r.degraded, false)
  assert.strictEqual(vars.rlm_harness_digest({ scope: { id: 'ag-1' } }), '', '空态 digest 渲染为空串（零成本）')

  // ── 校验错误 ─────────────────────────────────────────────────────────────
  r = await call({ action: 'create', kind: 'bogus', id: 'x', title: 't', content: 'c' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'create', kind: 'memory', id: 'Bad_Id!', title: 't', content: 'c' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'get', kind: 'memory', id: 'missing' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'nope' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'overview', scope: 'elsewhere' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'create', kind: 'memory', id: 'no-title', content: 'c' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'create', kind: 'memory', id: 'too-big', title: 't', content: 'x'.repeat(9 * 1024) })
  assert.strictEqual(r.ok, false, 'content 超 8KB 必须拒绝')

  // ── CRUD ─────────────────────────────────────────────────────────────────
  r = await call({ action: 'create', kind: 'memory', id: 'repo-test-cmd', title: '测试入口', content: '走 ./test.sh', evidence: '本会话实证' })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.ok(r.refinement_id)
  r = await call({ action: 'get', kind: 'memory', id: 'repo-test-cmd' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.entry.title, '测试入口')
  assert.strictEqual(r.entry.evidence, '本会话实证')
  r = await call({ action: 'create', kind: 'memory', id: 'repo-test-cmd', title: 'dup', content: 'dup' })
  assert.strictEqual(r.ok, false, '重复 create 必须拒绝')
  r = await call({ action: 'update', kind: 'memory', id: 'repo-test-cmd', content: '走 ./ci.sh' })
  assert.strictEqual(r.ok, true)
  r = await call({ action: 'get', kind: 'memory', id: 'repo-test-cmd' })
  assert.strictEqual(r.entry.content, '走 ./ci.sh')
  assert.strictEqual(r.entry.title, '测试入口', 'update 只 patch 提供的字段')

  // 状态文件落盘
  const stateFile = path.join(localDir, 'harness_state.json')
  assert.ok(fs.existsSync(stateFile), 'harness_state.json written')
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.strictEqual(persisted.entries.memory['repo-test-cmd'].content, '走 ./ci.sh')

  // ── digest（local 有条目）────────────────────────────────────────────────
  let digest = vars.rlm_harness_digest({ scope: { id: 'ag-1' } })
  assert.ok(digest.includes('Continual harness state'), digest)
  assert.ok(digest.includes('repo-test-cmd'), digest)
  assert.ok(digest.includes('[local memory: 1]'), digest)

  // ── digest 会话首渲染即定位 workspace（不经工具调用学习）────────────────
  const { ctx: ctxS, vars: varsS } = makeCtx()
  plugin.apply(ctxS)
  const startDigest = varsS.rlm_harness_digest({ scope: { id: 'fresh-agent', session: { header: { cwd: WS } } } })
  assert.ok(startDigest.includes('repo-test-cmd'), 'session-start digest must resolve the workspace from the agent itself')

  // ── exec 缺 header：回退到已学习的 workspace ────────────────────────────
  r = await tool.execute({ action: 'get', kind: 'memory', id: 'repo-test-cmd' }, { agent: { id: 'no-hdr-late' } })
  assert.strictEqual(r.ok, true, 'headerless exec falls back to the learned workspace')

  // ── apply_refinement 批量 ────────────────────────────────────────────────
  r = await call({
    action: 'apply_refinement',
    summary: '沉淀两条',
    rationale: '实测需要',
    expected_outcome: '下次更快',
    edits: [
      { op: 'create', kind: 'prompt', id: 'lead-with-outcome', title: '先说结论', content: '首句给状态' },
      { op: 'create', kind: 'subagent', id: 'explorer-spec', title: '探索代理', content: '只读快查', arguments: { depth: 'shallow' } },
    ],
  })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.applied.length, 2)
  const rfId = r.refinement_id

  r = await call({ action: 'history' })
  assert.strictEqual(r.ok, true)
  const histEntry = r.refinements.find((h) => h.id === rfId)
  assert.ok(histEntry, 'history contains the refinement')
  assert.strictEqual(histEntry.summary, '沉淀两条')
  assert.strictEqual(histEntry.edits.length, 2)

  const logFile = path.join(localDir, 'refinements.jsonl')
  assert.ok(fs.existsSync(logFile), 'refinements.jsonl written')

  // ── rollback：逆向重放 ───────────────────────────────────────────────────
  r = await call({ action: 'rollback', refinement_id: rfId })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  r = await call({ action: 'get', kind: 'prompt', id: 'lead-with-outcome' })
  assert.strictEqual(r.ok, false, 'rolled-back create must remove entry')
  r = await call({ action: 'get', kind: 'subagent', id: 'explorer-spec' })
  assert.strictEqual(r.ok, false)
  r = await call({ action: 'history' })
  assert.ok(r.refinements.some((h) => h.rollback_of === rfId), 'rollback recorded')

  // 回滚 rollback（恢复条目）
  const rollbackRec = (await call({ action: 'history' })).refinements.find((h) => h.rollback_of === rfId)
  r = await call({ action: 'rollback', refinement_id: rollbackRec.id })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  r = await call({ action: 'get', kind: 'prompt', id: 'lead-with-outcome' })
  assert.strictEqual(r.ok, true, 'rollback of rollback restores entries')

  // ── rollback 冲突检测 ────────────────────────────────────────────────────
  r = await call({ action: 'apply_refinement', summary: 'A', rationale: 'r', edits: [{ op: 'create', kind: 'skill', id: 'conflict-skill', title: 'T', content: 'C1' }] })
  const rfA = r.refinement_id
  r = await call({ action: 'apply_refinement', summary: 'B', rationale: 'r', edits: [{ op: 'update', kind: 'skill', id: 'conflict-skill', content: 'C2' }] })
  const rfB = r.refinement_id
  r = await call({ action: 'rollback', refinement_id: rfA })
  assert.strictEqual(r.ok, false, 'must refuse to clobber later changes')
  assert.ok(r.conflicts.length > 0)
  r = await call({ action: 'rollback', refinement_id: rfA, force: true })
  assert.strictEqual(r.ok, true, 'force bypasses conflict')
  r = await call({ action: 'get', kind: 'skill', id: 'conflict-skill' })
  assert.strictEqual(r.ok, false, 'force rollback of a create deletes the entry (create inverse = delete)')
  // rollback 未知 id
  r = await call({ action: 'rollback', refinement_id: 'rf-nonexistent' })
  assert.strictEqual(r.ok, false)

  // ── delete + rollback 恢复 ───────────────────────────────────────────────
  r = await call({ action: 'delete', kind: 'memory', id: 'repo-test-cmd' })
  assert.strictEqual(r.ok, true)
  r = await call({ action: 'get', kind: 'memory', id: 'repo-test-cmd' })
  assert.strictEqual(r.ok, false)
  const delHist = (await call({ action: 'history' })).refinements.find((h) => h.edits.some((e) => e.op === 'delete' && e.id === 'repo-test-cmd'))
  r = await call({ action: 'rollback', refinement_id: delHist.id })
  assert.strictEqual(r.ok, true)
  r = await call({ action: 'get', kind: 'memory', id: 'repo-test-cmd' })
  assert.strictEqual(r.ok, true, 'delete rollback restores entry')

  // ── global 域 ────────────────────────────────────────────────────────────
  r = await call({ action: 'create', scope: 'global', kind: 'memory', id: 'cross-session', title: '跨会话', content: '稳定教训' })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  const globalDir = path.join(FAKE_HOME, '.dsh', 'rlm')
  assert.ok(fs.existsSync(path.join(globalDir, 'harness_state.json')), 'global store under $HOME/.dsh/rlm')
  digest = vars.rlm_harness_digest({ scope: { id: 'ag-1' } })
  assert.ok(digest.includes('[global memory: 1]'), digest)
  assert.ok(digest.includes('cross-session'), digest)

  // ── 状态损坏 → 隔离 + degraded ───────────────────────────────────────────
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-harness-ws2-'))
  const dir2 = path.join(ws2, '.rlm')
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'harness_state.json'), '{corrupt json!!')
  const { ctx: ctx2, registered: reg2, vars: vars2 } = makeCtx()
  plugin.apply(ctx2)
  const tool2 = reg2[0]
  const exec2 = { agent: { id: 'ag-2', session: { header: { cwd: ws2 } } } }
  r = await tool2.execute({ action: 'overview' }, exec2)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.degraded, true, 'corrupt state must surface degraded')
  const quarantined = fs.readdirSync(dir2).find((f) => f.startsWith('harness_state.json.corrupt-'))
  assert.ok(quarantined, 'corrupt file quarantined, not overwritten')
  const d2 = vars2.rlm_harness_digest({ scope: { id: 'ag-2' } })
  assert.ok(d2.includes('quarantined'), 'digest surfaces the data-loss fact')
  // 隔离后新写入正常
  r = await tool2.execute({ action: 'create', kind: 'memory', id: 'post-corrupt', title: 't', content: 'c' }, exec2)
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  r = await tool2.execute({ action: 'overview' }, exec2)
  assert.strictEqual(r.counts.memory, 1)

  // ── workspace 解析失败（fresh 实例、无 header）─────────────────────────
  const { ctx: ctx3, registered: reg3 } = makeCtx()
  plugin.apply(ctx3)
  r = await reg3[0].execute({ action: 'overview' }, { agent: { id: 'no-hdr' } })
  assert.strictEqual(r.ok, false)
  assert.ok(r.error.includes('cannot resolve workspace'), r.error)

  console.log('rlm-harness.test.js: ALL PASS')
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) },
)

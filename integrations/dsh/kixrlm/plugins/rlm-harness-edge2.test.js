// rlm-harness.js 独立复审发现问题的回归（red-first：修复前应 FAIL，修复后全绿）。
// 来源：2026-09-22 独立对抗复审 F1/F2/F3/F4/F5/F6/F10/F14。
// 运行：node plugins/rlm-harness-edge2.test.js
'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const plugin = require(path.join(__dirname, 'rlm-harness.js'))

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-edge2-home-'))
process.env.HOME = FAKE_HOME

function fresh(ws) {
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    systemPrompt: { variable() { return () => {} }, context() { return () => {} } },
    effect(fn) { fn() },
  }
  plugin.apply(ctx)
  const exec = { agent: { id: 'ag-' + ws, session: { header: { cwd: ws } } } }
  return { call: (args) => registered[0].execute(args, exec) }
}

async function main() {
  // ── F1：非 ENOENT 读取错误不得静默清空/覆盖 ──────────────────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f1-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'memory', id: 'm1', title: 'T', content: 'C' })
    fs.rmSync(path.join(ws, '.rlm', 'harness_state.json'))
    fs.mkdirSync(path.join(ws, '.rlm', 'harness_state.json')) // 读 → EISDIR（非 ENOENT）
    let r = await call({ action: 'overview' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.degraded, true, 'F1: unreadable state must surface degraded, not clean-empty')
    assert.ok(fs.readdirSync(path.join(ws, '.rlm')).some((f) => f.startsWith('harness_state.json.corrupt-')),
      'F1: unreadable original must be quarantined, not overwritten in place')
    const r2 = await call({ action: 'create', kind: 'memory', id: 'm2', title: 'T', content: 'C' })
    assert.ok(r2.ok === false || r2.degraded === true,
      'F1: writes over a degraded store must keep surfacing degraded (or fail) — never a clean ok')
  }

  // ── F2：结构失真但合法的 JSON → 隔离 + degraded，不得静默归一 ────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f2-'))
    fs.mkdirSync(path.join(ws, '.rlm'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.rlm', 'harness_state.json'), '{"entries": null}')
    const { call } = fresh(ws)
    let r = await call({ action: 'overview' })
    assert.strictEqual(r.degraded, true, 'F2a: entries:null must degrade, not normalize to empty')
    assert.ok(fs.readdirSync(path.join(ws, '.rlm')).some((f) => f.startsWith('harness_state.json.corrupt-')),
      'F2a: original file quarantined')
  }
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f2b-'))
    fs.mkdirSync(path.join(ws, '.rlm'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.rlm', 'harness_state.json'), JSON.stringify({ schema: 99, entries: { prompt: { x: { title: 't', content: 'c' } } } }))
    const { call } = fresh(ws)
    let r = await call({ action: 'overview' })
    assert.strictEqual(r.degraded, true, 'F2b: unknown schema must degrade (future layout), not read as empty')
  }

  // ── F3：refinement 日志写失败不得留下已提交的 state ──────────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f3-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'memory', id: 'base', title: 'T', content: 'C' })
    const stateBefore = fs.readFileSync(path.join(ws, '.rlm', 'harness_state.json'), 'utf8')
    fs.rmSync(path.join(ws, '.rlm', 'refinements.jsonl'))
    fs.mkdirSync(path.join(ws, '.rlm', 'refinements.jsonl')) // append → EISDIR
    let r = await call({ action: 'create', kind: 'memory', id: 'ghost-commit', title: 'T', content: 'C' })
    assert.strictEqual(r.ok, false, 'F3: append failure must report failure')
    const stateAfter = fs.readFileSync(path.join(ws, '.rlm', 'harness_state.json'), 'utf8')
    assert.strictEqual(stateAfter, stateBefore, 'F3: state must be rolled back when the log write fails (no invisible commit)')
    fs.rmdirSync(path.join(ws, '.rlm', 'refinements.jsonl'))
    r = await call({ action: 'get', kind: 'memory', id: 'ghost-commit' })
    assert.strictEqual(r.ok, false, 'F3: failed create must not be visible')
  }

  // ── F4：force 必须能越过存在性冲突（覆盖语义）────────────────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f4-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'prompt', id: 'p1', title: 'T', content: 'C1' })
    const r1 = (await call({ action: 'history' })).refinements[0]
    await call({ action: 'delete', kind: 'prompt', id: 'p1' })
    const r2 = (await call({ action: 'history' })).refinements.at(-1)
    await call({ action: 'create', kind: 'prompt', id: 'p1', title: 'T', content: 'HANDMADE' }) // 手工重建
    let r = await call({ action: 'rollback', refinement_id: r2.id, force: true })
    assert.strictEqual(r.ok, true, `F4: force rollback over delete-op conflict must work (${JSON.stringify(r)})`)
    r = await call({ action: 'get', kind: 'prompt', id: 'p1' })
    assert.strictEqual(r.ok, true, 'F4: rollback of delete recreates (overwrites the re-created one)')
    assert.strictEqual(r.entry.content, 'C1', 'F4: restored content is the pre-delete snapshot')
    // 反向：create 的逆（delete）遇手工重建 → force 删除
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f4b-'))
    const c2 = fresh(ws2)
    await c2.call({ action: 'create', kind: 'prompt', id: 'q1', title: 'T', content: 'C' })
    const qa = (await c2.call({ action: 'history' })).refinements.at(-1)
    await c2.call({ action: 'delete', kind: 'prompt', id: 'q1' })
    await c2.call({ action: 'rollback', refinement_id: qa.id })
    let rb = await c2.call({ action: 'rollback', refinement_id: qa.id, force: true })
    assert.strictEqual(rb.ok, true, `F4b: force rollback of create (entry re-created by prior rollback) must work (${JSON.stringify(rb)})`)
  }

  // ── F5：rollback 后时间戳不得毒化后续 rollback（链式回滚）───────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f5-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'memory', id: 'a', title: 'T', content: 'C1' })
    const rA = (await call({ action: 'history' })).refinements[0]
    await call({ action: 'update', kind: 'memory', id: 'a', content: 'C2' })
    const rB = (await call({ action: 'history' })).refinements.at(-1)
    let r = await call({ action: 'rollback', refinement_id: rB.id })
    assert.strictEqual(r.ok, true, 'F5: rollback B')
    r = await call({ action: 'rollback', refinement_id: rA.id })
    assert.strictEqual(r.ok, true, `F5: chained rollback A must not false-conflict on timestamps (${JSON.stringify(r)})`)
    r = await call({ action: 'get', kind: 'memory', id: 'a' })
    assert.strictEqual(r.ok, false, 'F5: A inverted the create')
  }

  // ── F6：原型链 id 不得产生幻影条目/静默 no-op ────────────────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f6-'))
    const { call } = fresh(ws)
    let r = await call({ action: 'get', kind: 'prompt', id: '__proto__' })
    assert.strictEqual(r.ok, false, 'F6: __proto__ get must miss, not return Object.prototype')
    r = await call({ action: 'create', kind: 'prompt', id: 'toString', title: 'T', content: 'C' })
    assert.strictEqual(r.ok, false, 'F6: toString create must be cleanly rejected')
    assert.ok(!r.error || !/Unexpected token/.test(r.error), 'F6: rejection message must be explicit, not a JSON stringify crash')
    r = await call({ action: 'update', kind: 'prompt', id: 'constructor', title: 'X' })
    assert.strictEqual(r.ok, false, 'F6: constructor update must fail (no own key)')
    r = await call({ action: 'delete', kind: 'prompt', id: '__proto__' })
    assert.strictEqual(r.ok, false, 'F6: __proto__ delete must fail, not log a phantom refinement')
  }

  // ── F10：显式 null 清除可选字段 ──────────────────────────────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f10-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'memory', id: 'n1', title: 'T', content: 'C', evidence: 'E', path: '/tmp/x' })
    let r = await call({ action: 'update', kind: 'memory', id: 'n1', evidence: null })
    assert.strictEqual(r.ok, true)
    r = await call({ action: 'get', kind: 'memory', id: 'n1' })
    assert.strictEqual(r.entry.evidence, undefined, 'F10: explicit null clears the optional field')
    assert.strictEqual(r.entry.path, '/tmp/x', 'F10: untouched fields preserved')
  }

  // ── F14：overview 支持 kind 过滤（digest 提示与之对齐）──────────────────
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-e2-f14-'))
    const { call } = fresh(ws)
    await call({ action: 'create', kind: 'memory', id: 'a', title: 'T', content: 'C' })
    await call({ action: 'create', kind: 'prompt', id: 'b', title: 'T', content: 'C' })
    let r = await call({ action: 'overview', kind: 'memory' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.counts.memory, 1)
    assert.strictEqual(r.counts.prompt, 0, 'F14: kind-filtered overview counts only that kind')
  }

  console.log('rlm-harness-edge2.test.js: ALL PASS')
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) },
)

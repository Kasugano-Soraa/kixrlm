// rlm-harness.js 边缘行为回归（补充 rlm-harness.test.js 之外的失败路径）。
//
// 覆盖：
//   1. update/delete 不存在条目 → 明确失败
//   2. apply_refinement 空 edits 的行为
//   3. 同一 refinement 二次 rollback → 必须拒绝（状态已分叉）
//   4. kind 错配 get → not found
//   5. MAX_PER_KIND=200 上限
//   6. id 长度边界（80 通过 / 81 拒绝）
//   7. scope 语义：local 条目在 global 域不可见（get/update/delete）
//   8. create→rollback→手工重建→再 rollback（create 逆的冲突语义）
// 运行：node plugins/rlm-harness-edge.test.js
'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const plugin = require(path.join(__dirname, 'rlm-harness.js'))

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-edge-home-'))
process.env.HOME = FAKE_HOME
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-edge-ws-'))

function makeCtx() {
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    systemPrompt: {
      variable(name, fn) { return () => {} },
      context() { return () => {} },
    },
    effect(fn) { fn() },
  }
  return { ctx, registered }
}

const exec = { agent: { id: 'edge-ag', session: { header: { cwd: WS } } } }

async function main() {
  const { ctx, registered } = makeCtx()
  plugin.apply(ctx)
  const call = (args) => registered[0].execute(args, exec)
  let r

  // ── 1. 不存在条目 ───────────────────────────────────────────────────────
  r = await call({ action: 'update', kind: 'memory', id: 'ghost', title: 't' })
  assert.strictEqual(r.ok, false, 'update missing entry must fail')
  r = await call({ action: 'delete', kind: 'memory', id: 'ghost' })
  assert.strictEqual(r.ok, false, 'delete missing entry must fail')

  // ── 2. 空 edits ─────────────────────────────────────────────────────────
  r = await call({ action: 'apply_refinement', summary: '空', rationale: 'x', edits: [] })
  // 契约：允许记录（0 applied）或明确拒绝都算 sane；不允许抛异常/半写状态
  assert.ok(r.ok === true || r.ok === false, 'empty edits answered without throw')
  const hist = await call({ action: 'history' })
  assert.strictEqual(hist.ok, true, 'history intact after empty-edits call')

  // ── 3. 二次 rollback 拒绝 ───────────────────────────────────────────────
  r = await call({ action: 'create', kind: 'memory', id: 'double-rb', title: 'T', content: 'C' })
  const rf = (await call({ action: 'history' })).refinements.find((h) => h.edits.some((e) => e.id === 'double-rb' && e.op === 'create'))
  r = await call({ action: 'rollback', refinement_id: rf.id })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  r = await call({ action: 'rollback', refinement_id: rf.id })
  assert.strictEqual(r.ok, false, 'second rollback of the same refinement must be refused')

  // ── 4. kind 错配 ────────────────────────────────────────────────────────
  await call({ action: 'create', kind: 'memory', id: 'kinded', title: 'T', content: 'C' })
  r = await call({ action: 'get', kind: 'skill', id: 'kinded' })
  assert.strictEqual(r.ok, false, 'kind-scoped lookup must not cross kinds')

  // ── 5. MAX_PER_KIND=200 ─────────────────────────────────────────────────
  for (let i = 0; i < 200; i++) {
    r = await call({ action: 'create', kind: 'prompt', id: `bulk-${i}`, title: `T${i}`, content: 'x' })
    if (!r.ok) throw new Error(`bulk create failed early at ${i}: ${JSON.stringify(r)}`)
  }
  r = await call({ action: 'create', kind: 'prompt', id: 'bulk-200', title: 'T', content: 'x' })
  assert.strictEqual(r.ok, false, '201st entry in a kind must be rejected')
  r = await call({ action: 'create', kind: 'memory', id: 'other-kind-ok', title: 'T', content: 'x' })
  assert.strictEqual(r.ok, true, 'other kinds unaffected by the cap')
  // 清掉 bulk（delete 走 refinement，走单条最快路径：直接 200 次 delete 太慢 → 重建环境更省）
  // —— 用独立 workspace 断言已够；此处仅验证 overview 计数一致
  const ov = await call({ action: 'overview' })
  assert.strictEqual(ov.counts.prompt, 200 + (r && 0), JSON.stringify(ov.counts))

  // ── 6. id 长度边界 ──────────────────────────────────────────────────────
  const id80 = 'a'.repeat(80)
  const id81 = 'a'.repeat(81)
  r = await call({ action: 'create', kind: 'skill', id: id80, title: 'T', content: 'C' })
  assert.strictEqual(r.ok, true, '80-char id is the documented maximum')
  r = await call({ action: 'create', kind: 'skill', id: id81, title: 'T', content: 'C' })
  assert.strictEqual(r.ok, false, '81-char id must be rejected')

  // ── 7. scope 语义 ───────────────────────────────────────────────────────
  r = await call({ action: 'get', kind: 'memory', id: 'kinded', scope: 'global' })
  assert.strictEqual(r.ok, false, 'local entry invisible in global scope')
  r = await call({ action: 'update', kind: 'memory', id: 'kinded', scope: 'global', title: 'X' })
  assert.strictEqual(r.ok, false, 'cross-scope update refused')
  r = await call({ action: 'delete', kind: 'memory', id: 'kinded', scope: 'global' })
  assert.strictEqual(r.ok, false, 'cross-scope delete refused')
  r = await call({ action: 'get', kind: 'memory', id: 'kinded' })
  assert.strictEqual(r.ok, true, 'original local entry untouched')

  // ── 8. create→rollback→手工重建→再 rollback ────────────────────────────
  await call({ action: 'create', kind: 'subagent', id: 'reborn', title: 'T', content: 'C1' })
  const rfA = (await call({ action: 'history' })).refinements.find((h) => h.edits.some((e) => e.id === 'reborn' && e.op === 'create'))
  await call({ action: 'rollback', refinement_id: rfA.id })
  r = await call({ action: 'get', kind: 'subagent', id: 'reborn' })
  assert.strictEqual(r.ok, false, 'rollback removed it')
  await call({ action: 'create', kind: 'subagent', id: 'reborn', title: 'T2', content: 'C2' })  // 手工重建
  r = await call({ action: 'rollback', refinement_id: rfA.id })
  // create 的逆是 delete；当前存在的是“别人创建”的实体 → 冲突拒绝（保护后建数据）
  assert.strictEqual(r.ok, false, 'rollback of a create must refuse to delete re-created data')

  console.log('rlm-harness-edge.test.js: ALL PASS')
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) },
)

// rlm-kernel.js 插件边缘行为回归（补充 rlm-kernel.test.js 之外的失败路径）。
//
// 覆盖：
//   1. cell 屏蔽 SIGINT（signal.SIG_IGN）→ 宽限 SIGKILL → KernelDied；
//      下次调用 kernel_restarted:true 且命名空间清空；flag 只出现一次
//   2. python3 不可用（PATH 破坏）→ KernelDied 带诊断；PATH 恢复后自愈重启
//   3. 同代理并发调用排队（不交错、双方结果正确）
//   4. 负 timeout 钳到 1s（不静默关闭超时）
// 运行：node plugins/rlm-kernel-edge.test.js
'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const plugin = require(path.join(__dirname, 'rlm-kernel.js'))

function makeCtx() {
  const registered = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    effect(fn) { effects.push(fn()) },
  }
  return { ctx, registered, effects }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-kernel-edge-'))

async function main() {
  const { ctx, registered } = makeCtx()
  plugin.apply(ctx)
  const tool = registered[0]
  const exec = { agent: { id: 'edge-1', session: { header: { cwd: WS } } } }

  // ── 1. SIGINT 被屏蔽 → SIGKILL 梯 ────────────────────────────────────────
  await tool.execute({ code: 'state_marker = "before-kill"' }, exec)
  const t0 = Date.now()
  let r = await tool.execute({
    code: 'import signal; signal.signal(signal.SIGINT, signal.SIG_IGN); import time; time.sleep(30)',
    timeout: 1,
  }, exec)
  const elapsed = Date.now() - t0
  assert.strictEqual(r.status, 'error', JSON.stringify(r))
  assert.strictEqual(r.error.ename, 'KernelDied',
    'SIGINT-immune cell must be hard-killed after grace, not hang')
  assert.ok(elapsed < 10000, `timeout ladder must resolve promptly (took ${elapsed}ms)`)
  r = await tool.execute({ code: '1 + 1' }, exec)
  assert.strictEqual(r.kernel_restarted, true, 'restart flag after SIGKILL path')
  r = await tool.execute({ code: '"state_marker" in dir()' }, exec)
  assert.strictEqual(r.result, 'False', 'state must be gone after restart')
  r = await tool.execute({ code: '2 + 2' }, exec)
  assert.strictEqual(r.kernel_restarted, undefined, 'flag consumed once')

  // ── 2. python3 不可用 → 诊断 + 自愈 ──────────────────────────────────────
  const exec2 = { agent: { id: 'edge-nopy', session: { header: { cwd: WS } } } }
  const realPath = process.env.PATH
  process.env.PATH = '/nonexistent-dir-for-test'
  r = await tool.execute({ code: '1' }, exec2)
  process.env.PATH = realPath
  assert.strictEqual(r.status, 'error', JSON.stringify(r))
  assert.strictEqual(r.error.ename, 'KernelDied', 'spawn failure surfaces as KernelDied')
  assert.ok((r.error.evalue || '').length > 0 || (r.stderr || '').length > 0,
    'spawn failure carries a diagnostic')
  // PATH 恢复后同代理自愈
  r = await tool.execute({ code: '3 + 3' }, exec2)
  assert.strictEqual(r.result, '6', 'kernel recovers once python3 is resolvable again')

  // ── 3. 同代理并发调用排队 ────────────────────────────────────────────────
  const exec3 = { agent: { id: 'edge-conc', session: { header: { cwd: WS } } } }
  const [a, b, c] = await Promise.all([
    tool.execute({ code: 'import time; time.sleep(0.6); "A"' }, exec3),
    tool.execute({ code: '"B"' }, exec3),
    tool.execute({ code: '"C"' }, exec3),
  ])
  assert.strictEqual(a.result, "'A'")
  assert.strictEqual(b.result, "'B'")
  assert.strictEqual(c.result, "'C'")

  // ── 4. 负 timeout 钳到 1s ────────────────────────────────────────────────
  const exec4 = { agent: { id: 'edge-neg', session: { header: { cwd: WS } } } }
  const tn = Date.now()
  r = await tool.execute({ code: 'import time; time.sleep(20); "done"', timeout: -5 }, exec4)
  assert.strictEqual(r.error.ename, 'KeyboardInterrupt',
    `negative timeout must clamp to ~1s interrupt (got ${r.error && r.error.ename})`)
  assert.ok(Date.now() - tn < 10000, 'clamped timeout fires promptly')
  r = await tool.execute({ code: '"alive"' }, exec4)
  assert.strictEqual(r.result, "'alive'", 'kernel survives clamped-timeout interrupt')

  console.log('rlm-kernel-edge.test.js: ALL PASS')
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) },
)

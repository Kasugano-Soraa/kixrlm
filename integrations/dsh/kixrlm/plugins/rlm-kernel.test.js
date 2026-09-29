// rlm-kernel.js 插件回归测试（mock DSH ctx + 真实 python 子进程）。
//
// 覆盖：
//   - 注册形状（ipython 工具、schema、render）
//   - 基本 exec / 持久化 / 尾表达式
//   - 每代理独立内核（命名空间隔离）
//   - 同步 cell 超时：SIGINT → KeyboardInterrupt，内核存活（无重启标记）
//   - 异步 cell（await）超时：SIGINT 必须打断协程（shim 修复后的契约），
//     内核存活且状态保留
//   - 内核硬死（cell 自杀）→ KernelDied；下次调用 kernel_restarted: true
//   - render 输出格式
//   - dispose 收割全部内核进程
//   - exec 缺 session.header 时 cwd 回退
// 运行：node plugins/rlm-kernel.test.js
'use strict'
const assert = require('node:assert')
const { execSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const plugin = require(path.join(__dirname, 'rlm-kernel.js'))

function countShimProcs() {
  try {
    const out = execSync("pgrep -fc 'rlm_kernel.py' || true", { shell: '/bin/bash' }).toString().trim()
    return Number(out) || 0
  } catch { return 0 }
}

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

function execFor(id, cwd) {
  return { agent: { id, session: { header: { cwd } } } }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-kernel-test-'))

async function main() {
  const baseline = countShimProcs()
  const { ctx, registered, effects } = makeCtx()
  plugin.apply(ctx)
  assert.strictEqual(registered.length, 1, '一个工具注册')
  const tool = registered[0]
  assert.strictEqual(tool.name, 'ipython')
  assert.strictEqual(tool.parameters.required[0], 'code')
  assert.strictEqual(tool.parameters.additionalProperties, false)
  assert.strictEqual(typeof tool.execute, 'function')
  assert.strictEqual(typeof tool.output.render, 'function')

  const exec = execFor('agent-1', WS)

  // ── 基本 exec ─────────────────────────────────────────────────────────────
  let r = await tool.execute({ code: 'x = 21' }, exec)
  assert.strictEqual(r.status, 'ok', JSON.stringify(r))
  r = await tool.execute({ code: 'x * 2' }, exec)
  assert.strictEqual(r.result, '42')
  assert.strictEqual(r.kernel_restarted, undefined)

  // timeout 参数边界
  r = await tool.execute({ code: "'t'", timeout: 30 }, exec)
  assert.strictEqual(r.result, "'t'")

  // ── 每代理隔离 ───────────────────────────────────────────────────────────
  const exec2 = execFor('agent-2', WS)
  r = await tool.execute({ code: "'agent1-secret' in dir()" }, exec2)
  assert.strictEqual(r.result, 'False', 'agent-2 must not see agent-1 namespace')
  await tool.execute({ code: 'x = 99' }, exec2)
  r = await tool.execute({ code: 'x' }, exec)
  assert.strictEqual(r.result, '21', 'agent-1 x unchanged by agent-2 write')

  // ── 同步 cell 超时：SIGINT 打断，内核存活 ────────────────────────────────
  r = await tool.execute({ code: 'import time; time.sleep(20); "done"', timeout: 1 }, exec)
  assert.strictEqual(r.status, 'error', JSON.stringify(r))
  assert.strictEqual(r.error.ename, 'KeyboardInterrupt', 'sync timeout must surface KeyboardInterrupt')
  r = await tool.execute({ code: 'x' }, exec)
  assert.strictEqual(r.result, '21', 'kernel must survive sync-cell SIGINT with state')
  assert.strictEqual(r.kernel_restarted, undefined)

  // ── 异步 cell（await）超时：SIGINT 打断协程，内核存活 ────────────────────
  await tool.execute({ code: 'import asyncio' }, exec)
  r = await tool.execute({ code: 'await asyncio.sleep(20); "done"', timeout: 1 }, exec)
  assert.strictEqual(r.status, 'error', JSON.stringify(r))
  assert.strictEqual(r.error.ename, 'KeyboardInterrupt',
    `await-cell timeout must interrupt the coroutine (got ${r.error && r.error.ename})`)
  r = await tool.execute({ code: 'x' }, exec)
  assert.strictEqual(r.result, '21', 'kernel must survive await-cell SIGINT with state')
  assert.strictEqual(r.kernel_restarted, undefined)

  // ── 内核硬死 → KernelDied → 重启标记 ─────────────────────────────────────
  r = await tool.execute({ code: 'import os, signal; os.kill(os.getpid(), signal.SIGKILL)' }, exec)
  assert.strictEqual(r.status, 'error')
  assert.strictEqual(r.error.ename, 'KernelDied', JSON.stringify(r))
  r = await tool.execute({ code: '1 + 1' }, exec)
  assert.strictEqual(r.kernel_restarted, true, 'next call after hard death must carry kernel_restarted')
  assert.strictEqual(r.result, '2')
  r = await tool.execute({ code: 'x' }, exec)
  assert.strictEqual(r.status, 'error', 'state must be gone after restart')
  r = await tool.execute({ code: '2 + 2' }, exec)
  assert.strictEqual(r.kernel_restarted, undefined, 'flag consumed exactly once')

  // ── exec 缺 session.header：cwd 回退不炸 ─────────────────────────────────
  r = await tool.execute({ code: "'fallback-ok'" }, { agent: { id: 'nohdr' } })
  assert.strictEqual(r.result, "'fallback-ok'")

  // ── render ───────────────────────────────────────────────────────────────
  const text = (tool.output.render({}, { kernel_restarted: true, stdout: 'out', result: 'res', stderr: 'err', error: { ename: 'E', evalue: 'v', traceback: 'tb' } })[0].text)
  assert.ok(text.includes('[kernel restarted'))
  assert.ok(text.includes('out') && text.includes('res') && text.includes('err') && text.includes('[E] v'))
  const empty = tool.output.render({}, {})[0].text
  assert.strictEqual(empty, '(no output)')

  // ── dispose：收割全部内核进程 ──────────────────────────────────────────────
  await tool.execute({ code: 'y = 1' }, exec)   // 起 agent-1 内核
  await tool.execute({ code: 'y = 1' }, exec2)  // 起 agent-2 内核
  await tool.execute({ code: 'z = 1' }, { agent: { id: 'nohdr' } })
  const beforeDispose = countShimProcs()
  assert.ok(beforeDispose >= baseline + 3, `expected >=3 live kernels, saw ${beforeDispose - baseline}`)
  for (const dispose of effects) dispose()
  await new Promise((res) => setTimeout(res, 700))
  const afterDispose = countShimProcs()
  assert.ok(afterDispose <= baseline, `dispose must kill all kernels (baseline=${baseline}, after=${afterDispose})`)

  console.log('rlm-kernel.test.js: ALL PASS')
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) },
)

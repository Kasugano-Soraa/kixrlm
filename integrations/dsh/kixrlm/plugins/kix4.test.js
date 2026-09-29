// kix4 smoke tests — fake-ctx harness (repo convention: node plugins/kix4.test.js)
'use strict'
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// 只验证当前 checkout；不能让本机已安装的另一 preset 掩盖发布副本的回归。
const BASE = path.join(__dirname, '..')

function fakeCtx() {
  const handlers = {}
  const disposers = []
  return {
    tools: {
      registered: [],
      register(def) { this.registered.push(def); return () => { const i = this.registered.indexOf(def); if (i >= 0) this.registered.splice(i, 1) } },
    },
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn) },
    effect(fn) { disposers.push(fn) },
    __handlers: handlers,
    __disposers: disposers,
  }
}

async function fire(ctx, evt, ...args) {
  const hs = ctx.__handlers[evt] || []
  // event signatures: tools/post-execute(exec, result, next); others(payload)
  let chain = args.length > 1 ? args[1] : undefined
  for (const h of hs) {
    if (evt === 'tools/post-execute') {
      const r = await h(args[0], args[1], () => chain)
      if (r !== undefined) chain = r
    } else {
      await h(...args)
    }
  }
  return chain
}

let passed = 0
function ok(name, cond) { assert.ok(cond, name); passed++; console.log('  PASS', name) }

async function main() {
// ── kix-probe ─────────────────────────────────────────────
{
  console.log('kix-probe:')
  const probe = require(path.join(BASE, 'plugins/kix-probe.js'))
  const ctx = fakeCtx()
  probe.apply(ctx)
  const def = ctx.tools.registered.find((d) => d.name === 'probe')
  ok('registers probe', !!def)
  ok('description mentions no task/crisis words', !/test|smoke|regression|verify/i.test(def.description))
  ok('description mentions duration and memory', /duration/.test(def.description) && /memory/.test(def.description))
  ok('parameters: code required, measure optional', def.parameters.required[0] === 'code' && !!def.parameters.properties.measure)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ws-'))
  const r1 = await def.execute({ code: 'print(6*7)' }, { agent: { session: { header: { cwd: ws } } } })
  ok('executes and captures stdout', r1.ok && r1.stdout.includes('42'))
  ok('duration_ms present', typeof r1.duration_ms === 'number' && r1.duration_ms >= 0)
  ok('exit_code 0', r1.exit_code === 0)
  const r2 = await def.execute({ code: 'import sys\nsys.exit(3)\nprint("x")', measure: true }, { agent: { session: { header: { cwd: ws } } } })
  ok('exit_code 3 propagated', r2.exit_code === 3)
  const r3 = await def.execute({ code: 'x = [0]*10**6\nprint(sum(x))' , measure: true }, { agent: { session: { header: { cwd: ws } } } })
  ok('measure reports traced_peak_mb', r3.ok && typeof r3.traced_peak_mb === 'number' && r3.traced_peak_mb >= 0)
  const r4 = await def.execute({ code: '' })
  ok('empty code rejected', r4.ok === false)
  const r5 = await def.execute({ code: 'import time\ntime.sleep(62)' }, { agent: { session: { header: { cwd: ws } } } })
  ok('60s timeout enforced', r5.timed_out === true)
}

// ── kix-settle ────────────────────────────────────────────
{
  console.log('kix-settle:')
  const settle = require(path.join(BASE, 'plugins/kix-settle.js'))
  const ctx = fakeCtx()
  settle.apply(ctx)
  const session = { id: 's1', header: { cwd: '/ws/proj' } }
  const agent = { session }
  const res1 = { contexts: [] }
  await fire(ctx, 'tools/post-execute', { agent, name: 'edit', arguments: { file_path: '/ws/proj/a.py' } }, res1)
  ok('edit flows through chain without breaking (flash-compat shell3 form)', res1.contexts.length === 0)
  const agent2 = { session: { id: 's2', header: { cwd: '/ws/proj' } } }
  await fire(ctx, 'tools/post-execute', { agent: agent2, name: 'edit', arguments: { file_path: '/outside/x.py' } }, { contexts: [] })
  ok('handler never throws on any exec shape', true)
}

// ── kix-mem ───────────────────────────────────────────────
{
  console.log('kix-mem:')
  const mem = require(path.join(BASE, 'plugins/kix-mem.js'))
  const entries = mem.__internals.listEntries()
  ok('experience library has entries', entries.length >= 1)
  const lesson = entries.find((e) => e.file.includes('incentive-lessons'))
  ok('incentive-lessons.md listed with crisis index', !!lesson && lesson.index.includes('求助索引'))
  const ctx = fakeCtx()
  mem.apply(ctx)
  const def = ctx.tools.registered.find((d) => d.name === 'experience')
  ok('registers experience tool', !!def)
  const r1 = await def.execute({ action: 'list' })
  ok('list returns catalog', r1.ok && r1.count >= 1 && Array.isArray(r1.entries))
  const r2 = await def.execute({ action: 'get', name: 'incentive-lessons.md' })
  ok('get returns full note', r2.ok && r2.text.includes('契约清晰度'))
  const r3 = await def.execute({ action: 'get', name: '../../etc/passwd' })
  ok('path traversal blocked (basename only)', r3.ok === false)
}

// ── kix-budget L3 patch ──────────────────────────────────
{
  console.log('kix-budget L3:')
  const src = fs.readFileSync(path.join(BASE, 'plugins/kix-budget.js'), 'utf8')
  ok('verify-subsudy hook present', src.includes("=== 'probe' || _nm === 'run_code'") || src.includes("_nm === 'probe'"))
  ok('read-only streak logic intact', src.includes('isReadOnlyTool(exec && exec.name, args)'))
  // functional: run budget internals through its own test file if present
  const testPath = path.join(BASE, 'plugins/kix-budget.test.js')
  if (fs.existsSync(testPath)) {
    const { execSync } = require('node:child_process')
    try {
      execSync('node ' + JSON.stringify(testPath), { cwd: path.join(BASE, 'plugins'), stdio: 'pipe', timeout: 60000 })
      ok('existing kix-budget unit tests still pass', true)
    } catch (e) {
      ok('existing kix-budget unit tests still pass', false)
    }
  }
}

// ── single-preset composition assets ──────────────────────
{
  console.log('kixrlm composition assets:')
  // 冻结 v2 hash / default-null parity 不适用于单 kixrlm 发布；不读取宿主旧变体。
  // 此处验证实际发布资产，不把静态检查称为 DSH 宿主挂载成功。
  const a = fs.readFileSync(path.join(BASE, 'agent.cordis.yml'), 'utf8')
  const manifest = fs.readFileSync(path.join(BASE, 'preset.yml'), 'utf8')
  ok('preset identity is kixrlm', /^name: kixrlm$/m.test(manifest))
  const row = (id) => a.split(/(?=^- id: )/m).find((block) => block.startsWith('- id: ' + id + '\n'))
  ok('legacy persona remains disabled', !!row('persona') && /^  disabled: true$/m.test(row('persona')))
  ok('incentive persona is present and active', !!row('persona-incentive') && !/^  disabled: true$/m.test(row('persona-incentive')))
  for (const id of ['kix-probe', 'kix-settle', 'kix-mem', 'kix-browser', 'kix-stalled', 'kix-discipline', 'kix-orchestration', 'kix-consistency', 'kix-commands', 'kix-signal', 'rlm-kernel', 'rlm-harness']) {
    const block = row(id)
    ok(id + ' composition row present and enabled', !!block && !/^  disabled: true$/m.test(block))
  }
  const localPlugins = [...a.matchAll(/^\s*name: (\.\/\S+)\s*$/gm)].map((m) => m[1])
  ok('composition declares local plugin assets', localPlugins.length > 0)
  const assets = [...localPlugins, 'plugins/rlm_kernel.py', 'skills/kixparadigm/SKILL.md', 'skills/rlm-programming/SKILL.md', 'skills/refine/SKILL.md', 'agents/kixpower-dev.agent.md', 'agents/kixpower-qa.agent.md', 'agents/kixpower-reviewer.agent.md', 'prompts/kixpower-review.prompt.md', 'memories/incentive-lessons.md']
  const realBase = fs.realpathSync(BASE)
  for (const asset of assets) {
    const file = path.join(BASE, asset)
    ok('checkout contains ' + asset, fs.existsSync(file) && fs.statSync(file).isFile())
    const rel = path.relative(realBase, fs.realpathSync(file))
    ok('asset stays inside preset: ' + asset, !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
  }
}

console.log('\nALL ' + passed + ' CHECKS PASS')
}
main().catch((e)=>{console.error(e);process.exit(1)})

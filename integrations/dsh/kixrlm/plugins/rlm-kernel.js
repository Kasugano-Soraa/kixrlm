// rlm-kernel — 持久 Python REPL 工具（prime-agent RLM 的 DSH 移植件）
//
// 契约：每个 agent（exec.agent.id）一个 python 子进程——父会话与其子代理各自
// 持有独立内核，命名空间互不可见。行 JSON 协议，跨调用保持命名空间与
// asyncio loop。cell 有超时（默认 300s，可传 timeout: 秒，0 关闭）：超时先
// SIGINT（KeyboardInterrupt 打断运行中的 cell），2.5s 未收敛则 SIGKILL，
// 下次调用自动重启并标注 kernel_restarted（状态丢失）。
// 随 scope 销毁时 kill 全部内核；宿主死亡时 shim 读 stdin EOF 自行退出并收割
// 后台句柄进程组，不留孤儿。
//
// 非沙箱：内核以 dsh 宿主进程权限执行模型生成的 Python，与 prime-agent 的
// kernel 信任级一致。安全边界属于 fs/bash sandbox 层，本工具不在其内——
// preset 即可信配置（dsh-agent-presets README 语义）。
'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const SHIM = path.join(__dirname, 'rlm_kernel.py')

const DEFAULT_TIMEOUT_S = 300
const INTERRUPT_GRACE_MS = 2500

// 内核子进程环境白名单（对齐 prime-agent 的 child-safe whitelist 思路）：
// 不传 DSH_* 与 API 密钥（宿主机密不进子进程）；其余常用运行环境放行，
// 保证内核 bash() 里的工具行为与原生 bash 工具一致。
function kernelEnv() {
  const keep = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL',
    'SSH_AUTH_SOCK', 'EDITOR', 'VISUAL',
    'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]
  const env = {
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    TERM: process.env.TERM || 'xterm-256color',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  }
  for (const k of keep) if (typeof process.env[k] === 'string') env[k] = process.env[k]
  for (const k of Object.keys(process.env)) if (k.startsWith('XDG_')) env[k] = process.env[k]
  return env
}

let lastCwd = null // 会话树回退：子代理 exec 缺 session.header 时沿用已知 workspace

function resolveCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
    if (typeof cwd === 'string' && cwd.length > 0) { lastCwd = cwd; return cwd }
  } catch { /* fall through */ }
  return lastCwd || process.cwd()
}

function agentKey(exec) {
  try {
    const id = exec && exec.agent && exec.agent.id
    if (id != null) return String(id)
  } catch { /* fall through */ }
  return 'anonymous'
}

const DESCRIPTION = [
  'Execute Python code in a persistent Python REPL (rlm kernel). Top-level `await` is supported. Variables, imports, functions, and loaded data persist across calls; a trailing bare expression returns its repr as `result`.',
  'Each agent gets its own kernel: your Python namespace is private to you and is NOT shared with parent/child agents — pass data through files or prompts, not kernel variables.',
  'A cell times out after `timeout` seconds (default 300; 0 disables): the kernel first receives SIGINT (the cell dies with KeyboardInterrupt), and is force-restarted if it does not recover; a restarted kernel loses all Python state and the result carries kernel_restarted: true.',
  'Run shell commands with `bash("cmd")` inside the REPL — it returns a background handle immediately (h.pid, h.running, h.tail(n), h.output(), h.poll(), h.kill(), `await h` for the completed result); never use subprocess/os.system for that, and never read sys.stdin or call input() (they are the kernel protocol channel and raise RuntimeError).',
  'Keep bulk data in Python variables or on disk and carry only slices in your own context (prompt-as-a-variable).',
  'The kernel is NOT a security sandbox: it runs with the harness host\'s OS permissions. Prefer the read/edit/bash tools for ordinary single-step file and shell actions.',
].join(' ')

module.exports = {
  name: 'rlm-kernel',
  inject: ['tools'],
  apply(ctx) {
    const kernels = new Map() // agentKey -> kernel 实例

    function makeKernel() {
      return {
        child: null,
        rl: null,
        seq: 0,
        everSpawned: false,
        pendingRestartFlag: false,
        pending: new Map(), // id -> {resolve, timer, graceTimer}
        stderrTail: '',
      }
    }

    function kernelFor(key) {
      let k = kernels.get(key)
      if (!k) {
        k = makeKernel()
        kernels.set(key, k)
      }
      return k
    }

    function settleAll(k, result) {
      for (const [, p] of k.pending) {
        clearTimeout(p.timer)
        clearTimeout(p.graceTimer)
        p.resolve(result)
      }
      k.pending.clear()
    }

    function teardown(k) {
      if (k.rl) { try { k.rl.close() } catch { /* noop */ } k.rl = null }
      if (k.child) { try { k.child.kill('SIGKILL') } catch { /* noop */ } k.child = null }
      settleAll(k, { status: 'error', stdout: '', stderr: '', result: null, error: { ename: 'KernelKilled', evalue: 'kernel process killed (session scope disposed)', traceback: '' } })
    }

    function ensureKernel(k, cwd) {
      if (k.child) return
      k.pendingRestartFlag = k.everSpawned // 重启 ⇒ 此前状态丢失
      k.stderrTail = ''
      k.child = spawn('python3', ['-u', SHIM], { stdio: ['pipe', 'pipe', 'pipe'], env: kernelEnv(), cwd })
      k.everSpawned = true
      k.child.on('error', () => { /* 写入/退出路径处理 */ })
      k.child.stderr.on('data', (d) => { k.stderrTail = (k.stderrTail + d.toString()).slice(-4096) })
      // 用 'close' 而非 'exit'：spawn 失败（如无 python3）只发 error+close，
      // 不发 exit——只听 exit 会让 pending 调用挂到超时、后续写入打僵尸管道。
      k.child.on('close', (code, signal) => {
        const was = k.child
        k.child = null
        if (k.rl) { try { k.rl.close() } catch { /* noop */ } k.rl = null }
        settleAll(k, { status: 'error', stdout: '', stderr: k.stderrTail, result: null, error: { ename: 'KernelDied', evalue: `kernel exited (code=${code}, signal=${signal})`, traceback: '' } })
        try { was && was.stdin.destroy() } catch { /* noop */ }
      })
      k.rl = readline.createInterface({ input: k.child.stdout })
      k.rl.on('line', (line) => {
        let res
        try { res = JSON.parse(line) } catch { return }
        const p = k.pending.get(res.id)
        if (!p) return
        k.pending.delete(res.id)
        clearTimeout(p.timer)
        clearTimeout(p.graceTimer)
        p.resolve(res)
      })
    }

    function runCell(k, code, cwd, timeoutS) {
      return new Promise((resolve) => {
        try {
          ensureKernel(k, cwd)
        } catch (e) {
          resolve({ status: 'error', stdout: '', stderr: '', result: null, error: { ename: 'KernelSpawnError', evalue: String(e && e.message || e), traceback: '' } })
          return
        }
        const id = ++k.seq
        const entry = { resolve, timer: null, graceTimer: null }
        const limitMs = timeoutS === 0 ? 0 : Math.max(1, timeoutS || DEFAULT_TIMEOUT_S) * 1000
        if (limitMs > 0) {
          entry.timer = setTimeout(() => {
            // 先礼后兵：SIGINT 打断运行中的 cell（KeyboardInterrupt 收尾，
            // 响应照常回来）；2.5s 内不收敛则 SIGKILL，exit 处理器统一结算。
            if (k.child) { try { k.child.kill('SIGINT') } catch { /* noop */ } }
            entry.graceTimer = setTimeout(() => {
              if (k.pending.has(id) && k.child) {
                try { k.child.kill('SIGKILL') } catch { /* noop */ }
              }
            }, INTERRUPT_GRACE_MS)
            entry.graceTimer.unref?.()
          }, limitMs)
          entry.timer.unref?.()
        }
        k.pending.set(id, entry)
        try {
          k.child.stdin.write(JSON.stringify({ id, code }) + '\n')
        } catch (e) {
          k.pending.delete(id)
          clearTimeout(entry.timer)
          clearTimeout(entry.graceTimer)
          resolve({ status: 'error', stdout: '', stderr: '', result: null, error: { ename: 'KernelWriteError', evalue: String(e && e.message || e), traceback: '' } })
        }
      })
    }

    const dispose = ctx.tools.register({
      name: 'ipython',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source to execute in the persistent kernel namespace.' },
          timeout: { type: 'number', description: `Per-cell limit in seconds (default ${DEFAULT_TIMEOUT_S}; 0 disables). On expiry the running cell is interrupted (KeyboardInterrupt); an unrecoverable kernel is restarted and prior state is lost.` },
        },
        required: ['code'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => {
          const parts = []
          if (value.kernel_restarted) parts.push('[kernel restarted — all prior Python state lost]')
          if (value.stdout) parts.push(value.stdout)
          if (value.result != null) parts.push(String(value.result))
          if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
          if (value.error) parts.push(`[${value.error.ename}] ${value.error.evalue}\n${value.error.traceback || ''}`)
          return [{ type: 'text', text: parts.filter(Boolean).join('\n') || '(no output)' }]
        },
      },
      async execute(args, exec) {
        const key = agentKey(exec)
        const k = kernelFor(key)
        const timeoutS = args && typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT_S
        const r = await runCell(k, String((args && args.code) || ''), resolveCwd(exec), timeoutS)
        const out = { ...r }
        delete out.id
        if (k.pendingRestartFlag) { out.kernel_restarted = true; k.pendingRestartFlag = false }
        return out
      },
    })

    ctx.effect(() => () => {
      dispose()
      for (const k of kernels.values()) teardown(k)
      kernels.clear()
    })
    ctx.logger?.info?.('[rlm-kernel] ipython 工具已注册（每代理持久 Python REPL，懒启动，超时 SIGINT→SIGKILL，随 scope 销毁）')
  },
}

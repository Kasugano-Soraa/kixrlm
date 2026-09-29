#!/usr/bin/env python3
"""rlm_kernel.py shim 的协议级回归测试（不依赖 DSH 宿主）。

直接以子进程拉起 shim、说行 JSON，覆盖：
  1. 基本 exec / 尾表达式 repr / 持久化 / 顶层 await
  2. stdout/stderr 捕获、异常 traceback、语法错误
  3. stdin 守卫（sys.stdin.read / input() 均 RuntimeError）
  4. bash() 句柄：await 结果、kill 进程组、spawn 错误
  5. cell 串行化（第二个 cell 排队不交错）
  6. SIGINT 打断运行中 cell → KI 响应，内核存活
  7. stdin EOF → 内核退出且收割后台句柄（无孤儿）
  8. 64KiB 输出截断
运行：python3 plugins/rlm_shim_test.py
"""
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SHIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rlm_kernel.py")


class ShimHarness:
    """单读线程按 id 分发响应，多线程安全。"""

    def __init__(self, cwd=None):
        self.proc = subprocess.Popen(
            [sys.executable, "-u", SHIM],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, cwd=cwd,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            start_new_session=True,
        )
        self._id = 0
        self._lock = threading.Lock()
        self._routes = {}  # id -> queue.Queue
        self._reader_stop = threading.Event()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                res = json.loads(line)
            except ValueError:
                continue
            q = self._routes.get(res.get("id"))
            if q is not None:
                q.put(res)
        # EOF：给所有等待者发结束信号
        for q in list(self._routes.values()):
            q.put({"__eof__": True})

    def cell(self, code, timeout=30):
        with self._lock:
            self._id += 1
            rid = self._id
            q = queue.Queue()
            self._routes[rid] = q
            try:
                self.proc.stdin.write(json.dumps({"id": rid, "code": code}) + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                return {"status": "error", "error": {"ename": "BrokenPipe", "evalue": str(e)}}
        try:
            res = q.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"no response for id={rid} within {timeout}s")
        if res.get("__eof__"):
            raise EOFError("shim exited before answering")
        return res

    def sigint(self):
        self.proc.send_signal(signal.SIGINT)

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass

    def wait_exit(self, timeout=10):
        rc = self.proc.wait(timeout=timeout)
        try:
            err = self.proc.stderr.read()
        except OSError:
            err = ""
        return rc, err

    def kill(self):
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def res_ok(res):
    return res.get("status") == "ok"


class TestShimBasics(unittest.TestCase):
    def setUp(self):
        self.h = ShimHarness()

    def tearDown(self):
        self.h.kill()

    def test_exec_and_trailing_expr(self):
        res = self.h.cell("x = 1 + 1")
        self.assertEqual(res["status"], "ok", res)
        self.assertIsNone(res["result"])
        res = self.h.cell("x * 2")
        self.assertEqual(res["result"], "4")

    def test_persistence_and_imports(self):
        self.h.cell("import json\ndata = {'a': [1, 2, 3]}")
        res = self.h.cell("len(data['a']) + 10")
        self.assertEqual(res["result"], "13")

    def test_top_level_await(self):
        self.h.cell("import asyncio")
        res = self.h.cell("await asyncio.sleep(0.01); 'awaited'")
        self.assertEqual(res["status"], "ok", res)
        self.assertEqual(res["result"], "'awaited'")

    def test_await_bash_handle(self):
        res = self.h.cell('h = bash("echo hello-from-bash")')
        self.assertEqual(res["status"], "ok", res)
        res = self.h.cell("await h")
        self.assertEqual(res["status"], "ok", res)
        self.assertIn("exit_code': 0", res["result"], res)
        self.assertIn("hello-from-bash", res["result"])

    def test_stdout_stderr_capture(self):
        res = self.h.cell("print('out-line'); import sys; sys.stderr.write('err-line\\n')")
        self.assertEqual(res["status"], "ok", res)
        self.assertIn("out-line", res["stdout"])
        self.assertIn("err-line", res["stderr"])

    def test_exception(self):
        res = self.h.cell("raise ValueError('boom')")
        self.assertEqual(res["status"], "error")
        self.assertEqual(res["error"]["ename"], "ValueError")
        self.assertIn("boom", res["error"]["evalue"])
        self.assertIn("ValueError", res["error"]["traceback"])

    def test_syntax_error(self):
        res = self.h.cell("def broken(:")
        self.assertEqual(res["status"], "error")
        self.assertEqual(res["error"]["ename"], "SyntaxError")

    def test_stdin_guard(self):
        res = self.h.cell("import sys; sys.stdin.read()")
        self.assertEqual(res["status"], "error", res)
        self.assertEqual(res["error"]["ename"], "RuntimeError")

    def test_input_guard(self):
        res = self.h.cell("input('prompt? ')")
        self.assertEqual(res["status"], "error", res)
        self.assertEqual(res["error"]["ename"], "RuntimeError")

    def test_eval_exec_code_mode(self):
        # exec 模式 code 对象经 eval 执行（内核实现路径）
        res = self.h.cell("y = 5; y")
        self.assertEqual(res["result"], "5")

    def test_bash_bad_args(self):
        res = self.h.cell('bash("")')
        self.assertEqual(res["status"], "error")
        self.assertEqual(res["error"]["ename"], "TypeError")

    def test_bash_spawn_error(self):
        res = self.h.cell('h2 = bash("definitely-not-a-command-xyz")')
        self.assertEqual(res["status"], "ok", res)  # 句柄创建本身成功
        res = self.h.cell("await h2")
        self.assertEqual(res["status"], "ok", res)
        self.assertIn("exit_code': 127", res["result"], res)

    def test_truncation_64k(self):
        res = self.h.cell("print('x' * 200_000)")
        self.assertEqual(res["status"], "ok")
        self.assertLessEqual(len(res["stdout"]), 64 * 1024 + 200)
        self.assertIn("truncated", res["stdout"])

    def test_none_result_stays_null(self):
        res = self.h.cell("None")
        self.assertIsNone(res["result"])

    def test_result_repr_truncated(self):
        res = self.h.cell("'z' * 300_000")  # repr 也应截断
        self.assertLessEqual(len(res["result"]), 64 * 1024 + 200)


class TestShimAdvanced(unittest.TestCase):
    def setUp(self):
        self.h = ShimHarness()

    def tearDown(self):
        self.h.kill()

    def test_cell_serialization(self):
        # 第一个 cell 慢，第二个 cell 必须排队在其后完成
        self.h.cell("import asyncio")
        t0 = time.monotonic()
        slow_res = {}

        def run_slow():
            slow_res["r"] = self.h.cell("import time; time.sleep(1.0); 'slow-done'")

        t = threading.Thread(target=run_slow)
        t.start()
        time.sleep(0.25)  # 确保慢 cell 已被派发
        t_fast = time.monotonic()
        fast = self.h.cell("'fast-done'")
        fast_latency = time.monotonic() - t_fast
        t.join(timeout=10)
        self.assertEqual(fast["result"], "'fast-done'")
        # fast 在 slow 完成前不能返回（cell_lock 串行）
        self.assertGreaterEqual(fast_latency, 0.6,
                                f"second cell returned too early ({fast_latency:.2f}s) — cells interleaved")
        self.assertEqual(slow_res["r"]["result"], "'slow-done'")

    def test_sigint_interrupts_cell_kernel_survives(self):
        self.h.cell("import time")
        holder = {}

        def run_long():
            holder["res"] = self.h.cell("time.sleep(30)")

        t = threading.Thread(target=run_long, daemon=True)
        t.start()
        time.sleep(0.5)
        self.h.sigint()
        t.join(timeout=10)
        self.assertIn("res", holder, "interrupted cell must still answer")
        res = holder["res"]
        self.assertEqual(res["status"], "error")
        self.assertEqual(res["error"]["ename"], "KeyboardInterrupt", res)
        # 内核存活：后续 cell 正常
        ok = self.h.cell("'alive'")
        self.assertEqual(ok["result"], "'alive'")

    def test_sigint_on_await_cell(self):
        # 打断 await 中的 cell（协程路径）
        self.h.cell("import asyncio")
        holder = {}

        def run_long():
            holder["res"] = self.h.cell("await asyncio.sleep(30)")

        t = threading.Thread(target=run_long, daemon=True)
        t.start()
        time.sleep(0.5)
        self.h.sigint()
        t.join(timeout=10)
        self.assertIn("res", holder)
        self.assertEqual(holder["res"]["status"], "error")
        ok = self.h.cell("'still-alive'")
        self.assertEqual(ok["result"], "'still-alive'")

    def test_bash_kill_reaps_group(self):
        self.h.cell('hk = bash("sleep 300 & sleep 300 & wait")')
        pid = int(str(self.h.cell("hk.pid")["result"]))
        self.h.cell("hk.kill()")
        self.assertEqual(self.h.cell("hk.running")["result"], "False")
        res = self.h.cell("await hk")  # 触发 _watch 收尾
        self.assertEqual(res["status"], "ok", res)
        # 进程组整体被杀（两个 sleep 都死）
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except (ProcessLookupError, ValueError):
                return  # 通过
        self.fail(f"process pid={pid} still alive after kill()")

    def test_cwd_persists_for_bash(self):
        with tempfile.TemporaryDirectory() as td:
            self.h.cell(f"import os; os.chdir({td!r})")
            res = self.h.cell('await bash("pwd")')
            self.assertIn(td, res["result"], res)

    def test_state_isolation_between_kernels(self):
        self.h.cell("secret = 42")
        other = ShimHarness()
        try:
            res = other.cell("'secret' in dir()")
            self.assertEqual(res["result"], "False", "namespaces must be per-kernel")
        finally:
            other.kill()


class TestShimShutdown(unittest.TestCase):
    def test_stdin_eof_exits_and_reaps_handles(self):
        h = ShimHarness()
        h.cell('bg = bash("sleep 600")')
        pid = int(str(h.cell("bg.pid")["result"]))
        h.close_stdin()
        rc, err = h.wait_exit(timeout=10)
        self.assertEqual(rc, 0, f"kernel should exit cleanly on EOF, stderr={err}")
        # 后台句柄进程被收割
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except (ProcessLookupError, ValueError):
                return  # 通过
        self.fail(f"bash handle pid={pid} survived kernel exit")

    def test_protocol_noise_ignored(self):
        h = ShimHarness()
        h.proc.stdin.write("not json\n")
        h.proc.stdin.write("\n")
        h.proc.stdin.flush()
        res = h.cell("'after-noise'")
        self.assertEqual(res["result"], "'after-noise'")
        h.kill()


class TestShimKernelReview(unittest.TestCase):
    """独立复审（2026-09-22）修复回归：fd 层捕获/__main__ pickle/嵌套句柄收割/有界排水/增量解码。"""

    def test_fd1_bypass_captured_and_framing_intact(self):
        # F1：裸 os.write(1) 不再打到协议管道；下一 cell 响应完好
        h = ShimHarness()
        res = h.cell('import os; os.write(1, b"raw-fd1-fragment")')
        self.assertEqual(res["status"], "ok")
        self.assertIn("raw-fd1-fragment", res["stdout"])
        res2 = h.cell("'framing-ok'")
        self.assertEqual(res2["result"], "'framing-ok'")
        h.kill()

    def test_subprocess_stdout_inherited_captured(self):
        # F1：不带 capture_output 的子进程输出进捕获，不污染协议
        h = ShimHarness()
        res = h.cell('import subprocess; subprocess.run(["echo","sub-inherited-out"], check=True)')
        self.assertEqual(res["status"], "ok")
        self.assertIn("sub-inherited-out", res["stdout"])
        h.kill()

    def test_subprocess_stdin_inherits_devnull(self):
        # fd 0 → /dev/null：继承 stdin 的子进程读不到协议行；cat 立即 EOF
        h = ShimHarness()
        res = h.cell('import subprocess; r=subprocess.run(["cat"], input=None, timeout=5); r.returncode')
        self.assertEqual(res["status"], "ok")
        res2 = h.cell("'stdin-guard-ok'")
        self.assertEqual(res2["result"], "'stdin-guard-ok'")
        h.kill()

    def test_pickle_of_cell_defined_class(self):
        # F8：NS 是真 __main__ 模块字典 → pickle 找得到类
        h = ShimHarness()
        res = h.cell("class Picklable:\n    x = 41\n    def bump(self):\n        return self.x + 1\nPicklable().bump()")
        self.assertEqual(res["result"], "42")
        res = h.cell("import pickle; pickle.loads(pickle.dumps(Picklable())).bump()")
        self.assertEqual(res["result"], "42")
        h.kill()

    def test_eof_kills_nested_handle_no_orphan(self):
        # F6：嵌套在 list 里的句柄（非 NS 顶层绑定）也在收割范围
        h = ShimHarness()
        h.cell('hs = [bash("sleep 9871")]')
        h.close_stdin()
        rc, _ = h.wait_exit(timeout=10)
        self.assertEqual(rc, 0)
        deadline = time.time() + 4
        while time.time() < deadline:
            probe = subprocess.run(["pgrep", "-f", "sleep 9871"], capture_output=True)
            if probe.returncode != 0:
                break
            time.sleep(0.2)
        self.assertNotEqual(
            subprocess.run(["pgrep", "-f", "sleep 9871"], capture_output=True).returncode,
            0, "nested handle's process group must be reaped on EOF",
        )

    def test_bash_output_bounded_no_oom(self):
        # F3：高速生产者的输出有界（保留最近窗口，丢弃头部），await 不饿死
        h = ShimHarness()
        res = h.cell('h = bash("head -c 300000 /dev/zero | base64")\nawait h')
        self.assertEqual(res["status"], "ok")
        res = h.cell('len(h.output())')
        self.assertLessEqual(int(res["result"]), 65536 + 80)
        res = h.cell('"earlier bytes dropped" in h.output()')
        self.assertEqual(res["result"], "True")
        h.kill()

    def test_utf8_multibyte_split_survives(self):
        # F7：多字节字符跨 64KiB 读边界不损坏（连续缓冲整体解码）
        h = ShimHarness()
        res = h.cell("h = bash(\"python3 -c \\\"print('\\u20ac'*30000)\\\"\")\nawait h")
        self.assertEqual(res["status"], "ok")
        res = h.cell("o = h.output(); (o.count('\\u20ac'), o.count('\\ufffd'))")
        euros, bad = res["result"].strip("()").split(",")
        self.assertGreaterEqual(int(euros), 29990)
        self.assertEqual(int(bad), 0)
        h.kill()

    def test_tail_zero_empty_and_capped(self):
        # F10：tail(0) 返回空串；大输出 tail 也过 _trunc
        h = ShimHarness()
        h.cell('h = bash("head -c 300000 /dev/zero | base64")\nawait h')
        res = h.cell('h.tail(0)')
        self.assertEqual(res["result"], "''")
        res = h.cell('len(h.tail(3))')
        self.assertLessEqual(int(res["result"]), 65536 + 80)
        h.kill()

    def test_kill_from_foreign_thread_marshalled(self):
        # F9：非 loop 线程 kill() 经 call_soon_threadsafe 封送，不裸改 loop 状态
        h = ShimHarness()
        h.cell('h = bash("sleep 9872")')
        res = h.cell('import threading; t = threading.Thread(target=h.kill); t.start(); t.join(); "sent"')
        self.assertEqual(res["result"], "'sent'")
        deadline = time.time() + 5
        running = "True"
        while time.time() < deadline:
            running = h.cell("h.running")["result"]
            if running == "False":
                break
            time.sleep(0.1)
        self.assertEqual(running, "False", "marshalled kill must settle the handle")
        res2 = h.cell("'alive-after-thread-kill'")
        self.assertEqual(res2["result"], "'alive-after-thread-kill'")
        h.kill()


if __name__ == "__main__":
    unittest.main(verbosity=2)

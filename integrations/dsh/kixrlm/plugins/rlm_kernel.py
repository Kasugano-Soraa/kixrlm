#!/usr/bin/env python3
"""rlm-kernel shim — a persistent Python REPL speaking line-delimited JSON on stdio.

Protocol (one JSON object per line):
  request : {"id": <int>, "code": "<python source>"}
  response: {"id": <int>, "status": "ok"|"error",
             "stdout": str, "stderr": str, "result": str|None,
             "error": {"ename": str, "evalue": str, "traceback": str}|None}

Semantics:
  - One persistent namespace across cells: it IS the real ``__main__`` module's
    dict (``sys.modules["__main__"]``), so pickle/copy of cell-defined classes
    works. One asyncio loop runs forever on the MAIN thread. A custom SIGINT
    handler interrupts the running cell as a KeyboardInterrupt BOTH ways: the
    handler raises KI (breaks PEP-475-retried sync calls like time.sleep) and
    queues task.cancel() (breaks cells suspended in ``await``, which a raw KI
    cannot reach because it only unwinds run_forever). CancelledError at a
    cell's await point is reported as KeyboardInterrupt; the kernel keeps
    running. Residual known window: a KI landing inside loop machinery between
    the pop and run of a ready handle can drop that callback (CPython eval-
    breaker timing); the host's timeout→SIGINT→SIGKILL ladder is the designed
    recovery (full state loss, kernel restarts).
  - Cells are serialized through an asyncio.Lock: a second cell never
    interleaves with a running one; it queues.
  - Output capture is TWO layers: Python-level sys.stdout/sys.stderr swapping
    AND fd-level dup2 of fd 1 onto a temp file for the duration of each cell
    (raw ``os.write(1, …)``, subprocesses inheriting stdout, and threads that
    write during the cell all land in the capture instead of corrupting the
    protocol pipe). fd 0 is likewise dup2'd to /dev/null for the cell so an
    inheriting subprocess cannot eat protocol lines. Protocol responses are
    written to a private dup of the original fd 1, immune to cell fd games.
    Writers that fire after the cell returns (late background threads) still
    reach the protocol fd — keep foreground producers inside the cell.
  - Top-level await works: cells are compiled with PyCF_ALLOW_TOP_LEVEL_AWAIT.
  - A trailing bare expression's value is returned as `result` (repr).
  - Preloaded names: `bash` (background shell handles) and `asyncio`.
  - sys.stdin is the protocol channel: cells get a guard object whose reads
    raise RuntimeError, and builtins.input is patched likewise — otherwise
    ``input()`` would swallow the next request line and wedge the session.
  - bash() output is drained in bounded slices (a fast producer yields back to
    the event loop instead of starving it) and the raw byte buffer is capped
    (recent 2×LIMIT bytes kept; older output is dropped, not OOM'd). UTF-8 is
    decoded over the contiguous buffer, so characters split across read
    boundaries survive.
  - stdin EOF (host death) terminates the kernel; ALL live bash handles are
    tracked in a weak registry (not just top-level namespace bindings) and
    their process groups are killed on the way out so nothing is orphaned.
    The shutdown and reap paths are SIGINT-masked so a late KI cannot cancel
    the exit or skip reaping.
  - kill() from a non-loop thread is marshalled onto the loop via
    call_soon_threadsafe (it never mutates loop state off-thread).
"""

import asyncio
import ast
import builtins
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import traceback
import types
import weakref

LIMIT = 64 * 1024
BUF_CAP = 2 * LIMIT          # bash() 原始字节缓冲上限（保留最近窗口）
DRAIN_SLICE = 8              # 单次回调最多排水的 64KiB 块数（防饿死 loop）

# 真正的 __main__：pickle/copy 按 sys.modules["__main__"] 找类定义。
_MAIN = types.ModuleType("__main__")
_MAIN.__dict__.update({"__name__": "__main__", "__file__": "<rlm-kernel>", "__builtins__": builtins})
sys.modules["__main__"] = _MAIN
NS = _MAIN.__dict__

_REAL_STDIN = os.fdopen(os.dup(0), "r", encoding="utf-8", errors="replace")
# 协议读线程用 fd 0 的私有 dup：cell 期间把 fd 0 dup2 到 /dev/null 只影响
# 继承 fd 0 的子进程（吃不到协议行），协议读取不受任何干扰。

# 所有存活 bash 句柄（弱引用）：EOF 收割不依赖 NS 顶层绑定。
_LIVE_HANDLES = weakref.WeakSet()

_LOOP_THREAD = None          # loop 所在线程（kill() 的跨线程封送目标）


class _StdinGuard:
    """Replacement sys.stdin for cells: never let model code eat protocol lines."""

    def read(self, *args):
        raise RuntimeError("sys.stdin is the rlm kernel protocol channel; read files or use bash() instead")

    def readline(self, *args):
        raise RuntimeError("sys.stdin is the rlm kernel protocol channel; read files or use bash() instead")

    def readlines(self, *args):
        raise RuntimeError("sys.stdin is the rlm kernel protocol channel; read files or use bash() instead")

    def isatty(self):
        return False

    def readable(self):
        return False

    @property
    def closed(self):
        return False

    def fileno(self):
        raise RuntimeError("sys.stdin is the rlm kernel protocol channel")

    def __iter__(self):
        raise RuntimeError("sys.stdin is the rlm kernel protocol channel")


def _guarded_input(prompt=""):
    raise RuntimeError("input() would read the rlm kernel protocol channel; take input from the user message, files, or bash() instead")


builtins.input = _guarded_input


def _trunc(s):
    if len(s) <= LIMIT:
        return s
    return s[:LIMIT] + f"\n…[truncated {len(s) - LIMIT} chars]"


class _sigint_blocked:
    """临界区屏蔽 SIGINT（短同步段：响应写出/退出收割），KI 只会延后不会丢。"""

    def __enter__(self):
        self._prev = None
        try:
            self._prev = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
        except (AttributeError, OSError, ValueError):
            pass
        return self

    def __exit__(self, *exc):
        if self._prev is not None:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, self._prev)
            except (OSError, ValueError):
                pass
        return False


class _Capture:
    """stdout/stderr capture exposing a real .buffer (TextIOWrapper over BytesIO)."""

    def __init__(self):
        self._raw = io.BytesIO()
        self._text = io.TextIOWrapper(self._raw, encoding="utf-8", errors="replace", write_through=True)

    @property
    def stream(self):
        return self._text

    def getvalue(self):
        self._text.flush()
        return self._raw.getvalue().decode("utf-8", "replace")


class BashHandle:
    """Handle for a background shell command started with bash().

    h = bash('npm test'); h.pid; h.running; h.tail(n); h.output(); h.poll();
    h.kill(); await h -> {'exit_code', 'output', 'duration'}.

    The process is spawned synchronously (subprocess.Popen) as its own session
    leader, so `pid` is valid in the same cell that creates the handle and
    `kill()` fells the whole process group. Output is pumped by the kernel's
    asyncio loop through `add_reader` (no threads), so a kernel whose stdin
    closes exits immediately even with live handles. The byte buffer keeps the
    most recent BUF_CAP bytes (earlier output is dropped, never OOM) and is
    drained in bounded slices so a fast producer cannot starve the loop.
    """

    def __init__(self, command):
        self.command = command
        self._buf = bytearray()
        self._dropped = 0
        self._exit = None
        self._watching = True  # _watch 是否仍在轮询（reap 完成前保持 True）
        self._loop = asyncio.get_running_loop()
        self._started = self._loop.time()
        self._fd = None
        self._reader_ok = False
        self._duration = None
        self._done = self._loop.create_future()
        try:
            self._proc = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                cwd=os.getcwd(),
                start_new_session=True,
            )
            try:
                os.set_blocking(self._proc.stdout.fileno(), False)
                self._fd = self._proc.stdout.fileno()
                self._loop.add_reader(self._fd, self._on_readable)
                self._reader_ok = True
            except BaseException:
                # 无 add_reader（平台/loop 限制）：保留 _fd，退化为 _watch
                # tick 轮询排水；exit code/duration 仍经 _watch 收尾。
                pass
        except KeyboardInterrupt:
            raise  # 打断不算 spawn 失败——绝不伪造句柄吞掉 KI
        except BaseException as e:
            self._proc = None
            self._append(f"[bash spawn error: {type(e).__name__}: {e}]".encode("utf-8", "replace"))
            self._exit = -1
            self._duration = 0.0
            self._done.set_result(None)
        _LIVE_HANDLES.add(self)
        if self._exit is None:
            self._loop.call_soon(self._watch)

    def _append(self, chunk):
        self._buf += chunk
        overflow = len(self._buf) - BUF_CAP
        if overflow > 0:
            del self._buf[:overflow]
            self._dropped += overflow

    def _text(self):
        # 对连续缓冲整体解码：块边界不会撕碎多字节字符（仅头部截断点可能
        # 损坏一个字符，那是丢弃窗口的固有代价）。
        out = bytes(self._buf).decode("utf-8", "replace")
        if self._dropped:
            out = f"…[{self._dropped} earlier bytes dropped]\n" + out
        return out

    def _drain(self):
        if self._fd is None:
            return True
        n = 0
        try:
            while True:
                chunk = os.read(self._fd, 65536)
                if not chunk:
                    return True
                self._append(chunk)
                n += 1
                if n >= DRAIN_SLICE:
                    # 高速生产者：让出本回调，剩余数据下一轮继续（同一 fd 的
                    # reader 仍挂着；退化模式下由 _watch 继续触发）。
                    if self._reader_ok:
                        self._loop.call_soon(self._on_readable)
                    return False
        except BlockingIOError:
            return False
        except OSError:
            return True

    def _on_readable(self):
        if self._drain():
            self._remove_reader()  # EOF is permanent; keep watching the process

    def _remove_reader(self):
        if self._fd is None:
            return
        try:
            self._loop.remove_reader(self._fd)
        except BaseException:
            pass
        try:
            self._proc.stdout.close()
        except BaseException:
            pass
        self._fd = None

    def _watch(self):
        """Poll the process until it is REAPED, then finalize (the pipe may outlive it).

        Keeps ticking after kill()'s eager state settle: a SIGKILLed child can
        die a tick later, and stopping at the first `_exit` would leave a
        zombie nobody reaps. Settle and reap are deliberately independent.
        """
        if not self._watching or self._proc is None:
            return
        if self._fd is not None and not self._reader_ok:
            self._drain()  # 退化模式：轮询排水
        rc = self._proc.poll()
        if rc is None:
            self._loop.call_later(0.05, self._watch)
            return
        self._watching = False
        self._finalize(rc)

    def _finalize(self, exit_code):
        """Drain remaining output and settle exit state exactly once.

        Called both from the _watch poller (natural exit, post-reap) and from
        kill() (eager, so `running`/`await h` reflect the kill immediately
        instead of lagging a watch tick). Runs on the loop thread only — no
        locking; idempotent via the `_exit` guard. Off-loop callers are
        marshalled by kill() via call_soon_threadsafe.
        """
        if self._exit is not None:
            return
        self._drain()  # pick up output still sitting in the pipe
        self._remove_reader()
        self._exit = exit_code
        self._duration = self._loop.time() - self._started
        if not self._done.done():
            self._done.set_result(None)

    @property
    def pid(self):
        return self._proc.pid if self._proc is not None else None

    @property
    def running(self):
        return self._exit is None

    def output(self):
        return _trunc(self._text())

    def tail(self, n=20):
        if n <= 0:
            return ""
        return _trunc("\n".join(self._text().splitlines()[-n:]))

    def poll(self):
        if self._exit is None:
            return None
        return {"exit_code": self._exit, "output": self.output(), "duration": self._duration}

    def _do_kill(self):
        if self._proc is None or self._exit is not None:
            return
        try:
            pgid = os.getpgid(self._proc.pid)
            if pgid == self._proc.pid:  # start_new_session 成立才 killpg，绝不误杀自身组
                os.killpg(pgid, signal.SIGKILL)
            else:
                self._proc.kill()
        except (ProcessLookupError, PermissionError):
            pass
        except BaseException:
            try:
                self._proc.kill()
            except BaseException:
                pass
        # 立即收尾：kill 返回后 running/await h 马上反映死亡，不等 watch tick。
        # 自然退出与 kill 的竞态由 _finalize 的幂等守卫兜底（都在 loop 线程）。
        rc = None
        try:
            rc = self._proc.poll()
        except BaseException:
            pass
        self._finalize(-9 if rc is None else rc)

    def kill(self):
        # 跨线程调用只封送不动手：_drain/_finalize 会改 loop 状态，绝不能在
        # 非 loop 线程直跑（selector 并发变异 / 非 threadsafe 调度）。
        if _LOOP_THREAD is not None and threading.current_thread() is not _LOOP_THREAD:
            try:
                self._loop.call_soon_threadsafe(self._do_kill)
                return
            except RuntimeError:
                pass  # loop 已关：落到同步路径，尽力而为
        self._do_kill()

    def __await__(self):
        async def _wait():
            await asyncio.shield(self._done)  # cancelling the cell keeps the handle alive
            return {"exit_code": self._exit, "output": self.output(), "duration": self._duration}

        return _wait().__await__()

    def __repr__(self):
        state = "running" if self.running else f"exit={self._exit}"
        return f"<BashHandle pid={self.pid} {state} cmd={self.command!r}>"


def bash(command):
    """Start a shell command in the background and return a BashHandle immediately."""
    if not isinstance(command, str) or not command:
        raise TypeError("bash(command) requires a non-empty command string")
    return BashHandle(command)


def _compile_cell(code):
    """Split a cell into (exec_part, last_expression_part), both await-tolerant."""
    tree = ast.parse(code, mode="exec")
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = tree.body.pop()
        exec_code = None
        if tree.body:
            exec_code = compile(ast.fix_missing_locations(ast.Module(body=tree.body, type_ignores=[])), "<cell>", "exec", flags=flags)
        last_code = compile(ast.fix_missing_locations(ast.Expression(last_expr.value)), "<cell>", "eval", flags=flags)
        return exec_code, last_code
    return compile(tree, "<cell>", "exec", flags=flags), None


async def run_cell(code):
    out_cap = _Capture()
    err_cap = _Capture()
    old_out, old_err = sys.stdout, sys.stderr
    old_stdin = sys.stdin
    sys.stdout, sys.stderr = out_cap.stream, err_cap.stream
    sys.stdin = _StdinGuard()
    result_repr = None
    error = None
    # fd 层捕获：裸 os.write(1,…)/继承 stdout 的子进程/线程写都进临时文件，
    # 协议管道（PROTO_OUT 的私有 dup）不受污染；fd 0 指向 /dev/null，继承
    # stdin 的子进程吃不到协议行。
    fd_saved_out = fd_saved_in = devnull_fd = None
    fd_cap = None
    fd_layer_out = ""
    try:
        fd_cap = tempfile.TemporaryFile()
        fd_saved_out = os.dup(1)
        fd_saved_in = os.dup(0)
        devnull_fd = os.open(os.devnull, os.O_RDONLY)
        os.dup2(fd_cap.fileno(), 1)
        os.dup2(devnull_fd, 0)
        os.close(devnull_fd)
        devnull_fd = None
    except OSError:
        if fd_saved_out is not None:
            try:
                os.dup2(fd_saved_out, 1)
            except OSError:
                pass
            os.close(fd_saved_out)
            fd_saved_out = None
        if fd_saved_in is not None:
            try:
                os.dup2(fd_saved_in, 0)
            except OSError:
                pass
            os.close(fd_saved_in)
            fd_saved_in = None
        if devnull_fd is not None:
            try:
                os.close(devnull_fd)
            except OSError:
                pass
            devnull_fd = None
        if fd_cap is not None:
            fd_cap.close()
            fd_cap = None
    try:
        try:
            exec_code, last_code = _compile_cell(code)
            if exec_code is not None:
                maybe_coro = eval(exec_code, NS)
                if asyncio.iscoroutine(maybe_coro):
                    await maybe_coro
            if last_code is not None:
                value = eval(last_code, NS)
                if asyncio.iscoroutine(value):
                    value = await value
                if value is not None:
                    result_repr = _trunc(repr(value))
        except BaseException as e:
            if isinstance(e, asyncio.CancelledError):
                # SIGINT 打断 await 中的 cell：协议契约是 KeyboardInterrupt（内核存活）
                e = KeyboardInterrupt("cell interrupted")
            error = {
                "ename": type(e).__name__,
                "evalue": _trunc(str(e)),
                "traceback": _trunc("".join(traceback.format_exception(type(e), e, e.__traceback__))),
            }
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            sys.stdin = old_stdin
    finally:
        # 先还原 fd 再读临时文件：cell 的迟写线程最多污染到还原之后的协议 fd
        # （已知边界），还原窗口内的写入仍进临时文件。
        if fd_saved_out is not None:
            try:
                os.dup2(fd_saved_out, 1)
            except OSError:
                pass
            os.close(fd_saved_out)
        if fd_saved_in is not None:
            try:
                os.dup2(fd_saved_in, 0)
            except OSError:
                pass
            os.close(fd_saved_in)
        if fd_cap is not None:
            try:
                fd_cap.seek(0)
                fd_layer_out = fd_cap.read().decode("utf-8", "replace")
            except OSError:
                pass
            finally:
                fd_cap.close()
    return {
        "status": "error" if error else "ok",
        "stdout": _trunc(out_cap.getvalue() + fd_layer_out),
        "stderr": _trunc(err_cap.getvalue()),
        "result": result_repr,
        "error": error,
    }


def main():
    global _LOOP_THREAD
    _LOOP_THREAD = threading.current_thread()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    cell_lock = asyncio.Lock()
    # 协议写出走原始 fd 1 的私有 dup：cell 的 fd 级重定向/关闭都够不到它。
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    state = {"cell_task": None, "closing": False}  # cell_task：SIGINT 打断目标；closing：EOF 停机标记

    async def run_and_respond(req):
        task = asyncio.current_task()
        try:
            async with cell_lock:  # 串行：第二个 cell 永远排队，不与运行中的交错
                state["cell_task"] = task
                res = await run_cell(str(req.get("code", "")))
        except BaseException as e:  # KeyboardInterrupt 落在边界也要回响应
            with _sigint_blocked():
                res = {
                    "status": "error",
                    "stdout": "",
                    "stderr": "",
                    "result": None,
                    "error": {"ename": type(e).__name__, "evalue": _trunc(str(e)), "traceback": ""},
                }
        finally:
            with _sigint_blocked():
                if state["cell_task"] is task:
                    state["cell_task"] = None
        with _sigint_blocked():
            # 从 await 返回到写完响应整段屏蔽 SIGINT：KI 落在响应构造/锁清理/
            # write 中间会丢响应（宿主只能走 SIGKILL 梯，状态全丢）。
            res["id"] = req.get("id")
            try:
                out.write(json.dumps(res) + "\n")
                out.flush()
            except (BrokenPipeError, OSError):
                state["closing"] = True
                loop.call_soon(loop.stop)  # host 已消失——安静退出

    def on_sigint(signum, frame):
        # 双通道打断：排队 cancel 打断 await 中挂起的 cell（KI 到不了协程内部，
        # 只会弹开 run_forever）；随后 raise 打断同步阻塞（PEP 475 的重试只有
        # 处理器抛异常才会停）。两条路都汇到 run_cell 的 KI 错误响应。
        task = state["cell_task"]
        if task is not None and not task.done():
            loop.call_soon(task.cancel)
        raise KeyboardInterrupt

    def on_stdin_line(line):
        if state["closing"]:
            return  # 停机中不再受理新 cell（防向已停 loop 投协程）
        line = line.strip()
        if not line:
            return
        try:
            req = json.loads(line)
        except ValueError:
            return
        future = asyncio.run_coroutine_threadsafe(run_and_respond(req), loop)
        future.add_done_callback(lambda f: f.exception())  # 消费异常，防 "never retrieved" 噪音

    def reader_thread():
        for line in _REAL_STDIN:
            loop.call_soon_threadsafe(on_stdin_line, line)
        # stdin EOF：宿主死亡——停 loop，内核退出（句柄收割在 main 尾部）
        state["closing"] = True
        loop.call_soon_threadsafe(loop.stop)

    signal.signal(signal.SIGINT, on_sigint)  # 先装处理器再起读线程（消除窗口）
    threading.Thread(target=reader_thread, daemon=True).start()

    NS["bash"] = bash
    NS["asyncio"] = asyncio

    while True:
        try:
            loop.run_forever()
        except KeyboardInterrupt:
            # SIGINT 弹开 run_forever：被 cancel 的 cell 已另行回 KI 响应。
            # 若 stop 与 KI 同批到达（_stopping 已被 finally 复位），closing
            # 标记保证 EOF 退出不被一个迟到的 KI 吃掉。
            if state["closing"]:
                break
            continue
        break  # loop.stop()：stdin EOF / BrokenPipe，正常退出

    # 退出前收割所有存活句柄（弱注册表：嵌套/裸表达式句柄也覆盖），
    # 整段屏蔽 SIGINT——KI 落在这里会跳过收割留孤儿。
    with _sigint_blocked():
        for handle in list(_LIVE_HANDLES):
            if handle.running:
                try:
                    handle.kill()
                except BaseException:
                    pass


if __name__ == "__main__":
    main()

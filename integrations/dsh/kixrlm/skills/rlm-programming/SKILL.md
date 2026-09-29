---
name: rlm-programming
description: RLM 编程模型的实战模式——上下文外置（prompt-as-a-variable）、异步子代理扇出/扇入、文件契约、内核状态管理。处理长文档、大数据集、多子代理编排或跨轮长任务时使用。
---

# RLM 编程模式

内核（ipython）持有状态，子代理持有专注。你的上下文只放切片与结论。

## 上下文外置（prompt-as-a-variable）

```python
from pathlib import Path
files = list(Path('.').rglob('*.py'))            # 全量数据进变量，不进对话
big = [p for p in files if p.stat().st_size > 10_000]
```

- 读取/搜索的结果**总是绑定到具名变量**，后续轮次直接复用，不重复读。
- 大对象（日志、语料、API dump）进 Python 变量或写盘；对话里只带 `len()`、head、摘要。
- 内核输出有截断（64KiB 级）；打印切片而非整体。

## 子代理：admission，不是答案

```text
subagent({ description, prompt, run_in_background: true })  → 立即返回 id
```

- 独立子任务**同一批** spawn（并行），然后结束你的轮次——不要用 sleep/轮询把轮次挂着。
- 结果三通道：完成通知（自动到达）、`list_agents` 只读快照、`send_message` 追问/转向。
- 子代理只拿它需要的上下文：切片、文件路径、明确契约——不是你的 transcript。
- 需要子代理继承你的上下文时用 `subagent_fork`。
- 子代理的内核**与你不是同一个**（每代理独立进程/命名空间）：给子代理传数据走文件或 prompt，别指望它读得到你的 Python 变量。

## map/reduce 扇出（代码内编排）

一次 `run_code` 程序 = 一次完整的 fan-out/fan-in：

```ts
const chunks = /* 由内核或文件准备好的切片 */
const handles = await Promise.all(chunks.map((c, i) =>
  tools.subagent({ description: `chunk ${i}`, prompt: `分析 /tmp/chunk-${i}.txt …`, run_in_background: true })))
return handles.map(h => h.subagentId)
```

或者单段脚本内等待全部结果：用 `workflow` 工具（agent() + pipeline/parallel），它把子代理结果带回脚本内聚合。纪律：

- **每个 `agent()` 句柄都必须消费**（await/pipeline/parallel）——丢弃的句柄会被静默杀死，run 却仍报 completed。
- `agent()` 解析的是子代理的**最终文本**（空串是"完成但没说话"，不是失败）；要结构化结果就让子代理在文本里回 JSON。
- 无 run 级超时/停摆看门狗：脚本里自己给等待设界；无 console，用 `log()`；args/返回值必须是无损 JSON（Date/RegExp 会炸）。
- `run_code` 同理：重要副作用（写文件/spawn）先做再 return——抛错会丢掉没完成的动作，且只有 return 值可见。

## 文件契约

跨轮、跨代理交换大块数据的默认通道是文件：
- 父写 `/tmp/task-<id>.md`（输入）→ 子读 → 子写 `/tmp/result-<id>.md` → 父在内核里聚合。
- 契约写进子的 prompt：输入路径、输出路径、完成判据、回答格式。

## 内核纪律

- `bash("cmd")` 启动后台进程返回句柄；`await bash("cmd")` 等完成拿 `{exit_code, output, duration}`；`h.kill()` 杀整个进程组。
- cell 默认 300s 超时（`timeout` 秒可调，0 关闭）：超时先 SIGINT（KeyboardInterrupt——同步阻塞与 `await` 挂起都会被打断，内核与已建变量存活），不收敛才内核强杀重启。长跑任务放 `bash()` 句柄；要在 cell 里等长跑句柄时传 `timeout: 0` 或轮询 `h.poll()`——被打断的句柄本身存活，重新 `await h` 续等即可。
- `input()` 和 `sys.stdin.read()` 是禁区（内核协议通道，调用即 RuntimeError）；需要输入就从用户消息、文件或 `bash()` 拿。
- `os.chdir()` 在内核里持久，影响后续 bash()。
- 装包：用目标项目自己的环境；内核自身要包时 `await bash("python3 -m pip install --user <pkg>")`。
- `kernel_restarted: true` 意味着此前所有 Python 状态已丢——重建关键变量再继续。
- 大输出别硬打印：截断上限 64KiB，且压缩期 tool-result pruner 会把旧结果裁到 8KiB 级——大数据写文件，对话里只带路径和切片。

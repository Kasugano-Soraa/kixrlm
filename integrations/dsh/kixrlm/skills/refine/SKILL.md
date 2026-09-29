---
name: refine
description: 巩固本轮经验到 continual harness——回顾近期轨迹，提炼有证据的小步更新（prompt/memory/skill/subagent 条目），带快照落盘，可回滚。完成一个非平凡任务、发现可复用教训、或用户要求"记住/沉淀/自我改进"时使用。
---

# Refine：把轨迹变成耐用的 harness 状态

原则：小步、有证据、可回滚。基础系统提示不可变——你改的只是补充状态。

## 流程

1. **回顾**：本会话刚刚完成的工作里，什么是下次还想知道的？候选形态：
   - `memory`：一条经验/事实（"这个仓的 X 必须走 Y 命令"）；
   - `prompt`：一条补充工作约定（"回复先给结论"类偏好）；
   - `skill`：一个可复用能力的描述记录（有 reference/arguments 契约更好）；
   - `subagent`：一个可复用的委托规格（角色 + prompt 模板 + 验收）。
2. **去重**：先 `harness {action:"overview"}` 看已有条目；能 update 就不 create。
3. **落盘**：优先一次 `apply_refinement` 带完整依据：

```json
{
  "action": "apply_refinement",
  "summary": "一句话：这次改了什么",
  "rationale": "证据：哪次失败/哪条用户反馈证明了需要它",
  "expected_outcome": "下次什么行为会因此不同",
  "edits": [
    {"op": "create", "kind": "memory", "id": "repo-test-command",
     "title": "本仓测试入口", "content": "测试必须走 ./test.sh，直跑 pytest 会漏 env。",
     "evidence": "2026-09 本会话 pytest 直跑红、test.sh 绿"}
  ]
}
```

4. **域选择**：默认 `local`（本工作区 `.rlm/`）；只有跨项目都成立的稳定教训才 `scope:"global"`。
5. **报告**：一句话告诉用户沉淀了什么、refinement_id 是多少。

## 回滚

`harness {action:"rollback", refinement_id:"rf-…"}` 逆向重放该次 refinement（create↔delete、update 还原 before），并记录一条新的 rollback refinement。

## 红线

- 没有证据不写（"以防万一"的条目是负债，不是资产）。
- 一次 refinement 的 edits 控制在个位数；大改拆多次。
- 不写源文件、不改其他会话的状态；条目内容 ≤ 8KB。

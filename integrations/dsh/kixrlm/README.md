# kixrlm — DSH agent preset（kixparadigm + RLM 融合档）

> 开源参考实现：本页保留融合时的历史设计记录，历史测试数字不是本次发布的验证结果。
> 安装与兼容性以仓库 [安装说明](../../../docs/INSTALLATION.md)、[运行依赖](../runtime-manifest.json) 和 [验证记录](../../../docs/VALIDATION.md) 为准。
> 本发布副本去除了个人路由偏好和机器绑定示例；不会修改原有安装副本。

一个 preset 同时携带两个范式的全部功能面：

| 来源 | 携带内容 |
|---|---|
| kixparadigm | 激励面 persona（三通道/二相性/规则是负债/需求三检/写码前/架构感知/成本纪律）+ 全部 kix 插件（guards/discipline/orchestration/consistency/commands/signal/stalled/cost/route/focus/settle/mem/probe/browser/webhook）+ 技能货架（kixparadigm/kixpower/tdd/prototype/…）+ kixpower agents/prompts + memories + patches |
| RLM | 持久 Python REPL（`plugins/rlm-kernel.js` + `rlm_kernel.py`，每代理独立内核、顶层 await、bash() 句柄、SIGINT 双通道超时打断）+ continual harness（`plugins/rlm-harness.js`，四类条目/refinement/rollback/digest 注入）+ `rlm-programming`/`refine` 技能 + workflow 引擎帽（100/16） |

## 相对 kixparadigm 的增量（agent.cordis.yml）

1. persona-incentive 追加三段：RLM 持久内核 / Continual harness / workflow 引擎锐边。
2. `workflow-worker-thread` 增 `maxTotalAgents: 100` / `maxConcurrentAgents: 16`（RLM 的防失控水位）。
3. 新增 `rlm-kernel` / `rlm-harness` 两个 isolate realm 组。
4. `kix-webhook` 的 `agentPreset` 改指 kixrlm（默认 disabled，行为不变）。
5. 独立复审（2026-09-22）补齐两行 RLM 有而 kix 家族缺的用户面功能：
   `present`（声明交付文件，dsh-tool-present）与 `command-goal`（/goal 用户命令）。
   与 kix 机制无冲突（present 不在门禁 1 正则内；/goal 与 /kixpower-* 命令面正交）。

插件层唯一改动：`kix-guards.js` 的 KNOWN_SAFE_TOOLS 登记 `ipython`（门禁 1 正则匹配
"python"，未登记即拒）——已同步到 kixparadigm / kixparadigm-classic / kixrlm 三个根
（身份组字节一致；未挂载该工具的 preset 里是死条目）。`kix-guards.test.js` 带
`ipython → allow` 回归用例。**注意：该修复与新行都要求重启 dsh web 宿主后新会话才生效**
（preset 组成与 JS 插件模块随宿主进程缓存；2026-09-22 实测：修复落盘后旧进程内的新会话
仍用旧名单/旧行，fresh 进程单测 290/290 通过；重启后的预期：ipython 放行、present 可见）。

其余行与 kixparadigm 逐字节一致；`plugins/rlm-*` 与 rlm preset 逐字节一致（kix-consistency 身份组约束）。
例外（有意分歧，独立复审 2026-09-22）：`plugins/kix-webhook.js` 的
`DEFAULT_AGENT_PRESET` 在本档为 `kixrlm`（身份组只锁 kixparadigm↔kixparadigm-null，
本档允许分歧）——config 缺省时 webhook 会话也落在融合档；`patches/kix-webhook.*.yml`
的部署路径与 agentPreset 示例均指向 kixrlm。`preset.yml` 带 `order: 1`（继承 RLM 的
排序位置）。RLM 侧 harness 与 kernel 的独立复审发现已全部修复并带回归（15 项
harness 发现 + 9 项 kernel 发现，见 rlm preset README 的修复清单）；跨进程并发
写同一 harness store 为 last-writer-wins（无锁，单工作区多会话同写才可能丢更新）。

## 回归测试

```bash
node plugins/rlm-kernel.test.js   # RLM 内核插件（超时/隔离/重启/dispose）
node plugins/rlm-harness.test.js  # RLM harness（CRUD/rollback/损坏隔离/digest）
python3 plugins/rlm_shim_test.py  # shim 协议级（持久化/SIGINT/EOF/截断）
node plugins/kix-focus.test.js    # kix 代表性套件（其余 *.test.js 同法）
```

## 安装

请从仓库根阅读 [安装说明](../../../docs/INSTALLATION.md)。只复制此 preset 目录，不要把整个仓库复制进 DSH home，也不要覆盖已有安装或凭据。

设为默认 preset：`settings.yaml` 里 `agent-presets.default: kixrlm`（只影响之后新建的会话）。

组成、persona、JS 模块与 skill 资源的生效受宿主缓存影响；安装/升级后按宿主文档安排重启并创建新会话验证，不能假定运行中的会话热更新。

## 信任模型

preset 是可执行的可信配置。RLM 内核以宿主权限执行模型生成的 Python，不是沙箱；
内核中的文件访问及 `bash()` 子进程不会自动经过原生 fs/bash 工具的门禁或审批。
需要隔离时应在宿主进程/容器/操作系统层实现，并单独验证。详见 [SECURITY.md](../../../SECURITY.md)。

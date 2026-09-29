# kixrlm

**模型主导的自适应编排方法，以及它在 DeepSeek Harness（DSH）上的实验性参考实现。**

kixrlm 开源的是一整套工作方式：让模型围绕用户目标、任务风险、证据缺口和执行成本，自主选择直接完成、调用工具、引入独立观察，或组织多代理协作。角色是可选的职责契约，不是必须依次经过的流水线；RLM 持久 Python 内核是可选的执行手段，不是采用这套方法的前提。

项目地址：[Kasugano-Soraa/kixrlm](https://github.com/Kasugano-Soraa/kixrlm)。

## 从哪里开始

| 你想做什么 | 入口 |
|---|---|
| 理解方法，并在现有工作方式中小步采用 | [原则](docs/PRINCIPLES.md) |
| 判断其他 Harness 能迁移哪些部分 | [可移植性与能力边界](docs/PORTABILITY.md) |
| 在 Linux / DSH 环境手动试用参考实现 | [安装说明](docs/INSTALLATION.md)，先读 [安全说明](SECURITY.md) |
| 用小任务观察编排选择是否合理 | [三个合成使用场景](examples/README.md) |
| 查看本次实际检查了什么 | [发布验证记录](docs/VALIDATION.md) |
| 提交改进或复现问题 | [贡献指南](CONTRIBUTING.md) |

## 方法的核心

- **目标先于流程。** 目标不清或方案前提存疑时，检查 XY 问题、前提与更优路径；明确、低风险、可逆的小任务可以直接做。
- **按信息缺口投入。** 工具、观察者、角色和并发只有在收益超过成本时才值得引入；不为“多代理”而多代理。
- **证据比共识重要。** 确定性测试、真实链路与有效反例决定结论；多个 APPROVE 不会冲掉一个成立的反例。独立上下文也不等于模型或厂商独立。
- **把判断与强制边界分开。** 提示词与 skills 引导模型判断；可机械检查的权限、门禁与生命周期约束需要宿主 hooks / 插件支持，不能靠提示词替代。
- **承认剩余未知。** 旧测试、历史实验和工具成功只支持其覆盖范围；能力缺失应诚实失败，而非伪装成验证通过。

## 仓库里有什么

| 路径 | 用途 |
|---|---|
| [`integrations/dsh/kixrlm/`](integrations/dsh/kixrlm/) | 完整导出的 DSH preset：persona、skills、角色与提示词、插件及其测试、历史记忆和局部补丁 |
| [`integrations/dsh/kixrlm/agent.cordis.yml`](integrations/dsh/kixrlm/agent.cordis.yml) | 参考实现组成；当前启用的是 `persona-incentive`，不是前面的 disabled persona |
| [`integrations/dsh/runtime-manifest.json`](integrations/dsh/runtime-manifest.json) | 观测运行环境与依赖记录，不是通用兼容性保证 |
| [`integrations/dsh/host-patches/`](integrations/dsh/host-patches/) | 真实环境使用的额外宿主 workflow 与 compaction cap 补丁，供人工审阅，不会自动应用 |
| [`docs/`](docs/)、[`examples/`](examples/) | 方法、边界、手动安装和使用/验收场景 |

源 preset 保留了来源环境的部分注释、路径与历史记录，它们不代表推荐安装流程。**首次采用请以本仓库的安装和安全文档为入口**；历史测试数字不等于本次发布验证。完整来源与公开整理说明见 [PROVENANCE.md](docs/PROVENANCE.md)。

## 当前边界

- 这是 **DSH 实验性参考实现**，不是已经支持所有 Harness 的运行时，也不承诺生产就绪。
- 参考环境为 **Linux**。当前观测到的 DSH 版本是 **`0.1.5-rc.2`，且带额外 workflow 与 compaction cap 宿主补丁**；这不是最低支持版本，也不是干净机器全功能保证。Windows 原生 RLM 尚未验证。
- provider、模型、凭据和跨厂商路由由使用者自行配置。公开配置已去掉个人 provider/模型偏好表，依赖宿主注册的能力目录；不附送服务、账号或可用性。
- **RLM Python 以宿主权限运行，不是沙箱。** 内核中的文件访问和 shell 不经过原生工具门禁；每代理独立内核只是状态隔离，不是安全隔离。仅启用原生 fs/bash 限制不足以约束 RLM。
- local/global 记忆会持久化并影响后续上下文；并发写同一存储可能丢更新。具体路径、隐私与回滚限制见 [安全说明](SECURITY.md)。

## 验证与许可

仓库根目录的验证入口为：

```bash
bash scripts/check.sh
bash scripts/test.sh
```

覆盖范围、环境、失败与未验证项以 [验证记录](docs/VALIDATION.md) 为准。合成范例不是 benchmark；本项目不以源中的历史成绩宣称本次发布的效果。

许可见 [LICENSE](LICENSE)，第三方许可、归属与源码来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## English summary

kixrlm is a **model-led adaptive orchestration method** with an **experimental DeepSeek Harness reference implementation**. The model chooses solo work, tools, independent observation, or multi-agent collaboration according to task value, risk, evidence gaps, and cost—not a fixed role pipeline. RLM is optional; prompts and skills cannot replace enforced host hooks.

The observed reference environment is Linux with DSH `0.1.5-rc.2` plus additional workflow and compaction-cap host patches. This is neither a minimum-version claim nor a clean-install compatibility guarantee. Providers and cross-vendor routing require user configuration. The Python kernel runs with host permissions, outside native file/shell tool gates; per-agent kernels are not a security boundary. See [installation](docs/INSTALLATION.md), [security](SECURITY.md), and [validation](docs/VALIDATION.md) before use.

# 可移植性：迁移方法，不假定运行时兼容

kixrlm 的方法可以在其他环境中借鉴；本仓库可执行的参考实现目前面向 **DSH / Linux**。它不是通用 Harness SDK，也没有已完成的全平台兼容矩阵。

## 哪些可以迁移

| 部分 | 迁移方式 | 不能省略的边界 |
|---|---|---|
| 模型主导的选择、需求三检、证据与反例原则 | 改写为目标环境的 persona / 提示词 | 这是行为指导，不是强制权限 |
| skills、观察视角、职责契约 | 按需载入，映射实际工具名与材料路径 | 不要求固定角色序列；不要引用不存在的工具或源环境路径 |
| kix 插件门禁 | 用目标 Harness 的 hooks / 审批机制重新实现并测试 | 复制提示词不能替代实现，也不能声称拥有同等保障 |
| 子代理与 workflow | 适配路由、生命周期、返回格式、并发与取消语义 | 同名 API 不等于同一契约；失败/空输出不能伪装成证据 |
| RLM Python 内核 | 可不采用；需要时单独适配宿主执行和进程管理 | 每代理独立不是安全隔离，原生文件/shell 策略不自动覆盖内核 |
| local/global 持久记忆 | 明确存储位置、注入范围、回滚与并发规则 | 不是无状态提示词；有隐私、跨会话污染和丢更新风险 |

纯提示词/skills 的移植也可以有用，但请称为**方法适配**，并写明未实现的强制边界，不称为“完整 kixrlm 运行时支持”。

## DSH 参考实现依赖什么

[`agent.cordis.yml`](../integrations/dsh/kixrlm/agent.cordis.yml) 通过 DSH/Cordis 组合原生工具、kix 插件、子代理路由、workflow、RLM 内核和 continual harness。宿主还负责注册表、文件与 shell 策略、审批、模型服务及其他运行能力；复制 preset 不会补齐这些宿主服务。

当前观测环境为 **DSH `0.1.5-rc.2` 加额外 workflow 与 compaction cap 宿主补丁**，见 [运行环境清单](../integrations/dsh/runtime-manifest.json) 与 [host-patches](../integrations/dsh/host-patches/)。版本号只是观测事实，不是最低支持版本。补丁是否适配另一个 checkout，需要逐项审阅；本文不提供自动应用补丁、安装或重启流程，也不承诺干净 DSH 环境全功能可用。

provider、模型能力目录和凭据由使用者自行配置。公开 preset 已去掉个人 provider/模型偏好表，`kix-route` 依赖宿主真实已注册的路由；如需偏好配置，应针对自己的目录设置。跨厂商能力不足时不得把同厂商结果冒充跨厂商证据；实现细节见 [`kix-route.js`](../integrations/dsh/kixrlm/plugins/kix-route.js)。

## 平台与状态注意事项

- **Linux：** 本次参考平台，实际覆盖仍以 [验证记录](VALIDATION.md) 为准。
- **Windows 原生 RLM：** 未验证。Python shim 使用进程、信号和文件描述符等平台相关机制，不能因 preset 中有 PowerShell 配置就推导 RLM 可用。WSL 与 macOS 也应单独记录运行证据。
- **状态路径：** local 为工作区 `.rlm/`；当前 global 实现按宿主用户 home 取 `~/.dsh/rlm/`，不自动跟随自定义 `DSH_HOME`。多个工作区或会话可能共享 global；跨进程写同一 store 无锁。
- **已有源材料：** 历史路径、测试数字、旧 preset 名和内部环境描述属于来源记录；不构成此次支持承诺。

## 如何诚实描述一次移植

记录目标 Harness/平台/版本、启用的能力与替代实现、实际执行的检查，以及未覆盖项。至少对你要承诺的行为给出可重放证据：例如拒绝未经授权写入、检测材料变化、子任务失败回流、能力缺失不伪造成功。

不支持的能力可以明确缺失；只有该能力对当前任务必需时才阻塞交付。不得通过换工具或执行面绕过权限拒绝。安装参考实现见 [INSTALLATION.md](INSTALLATION.md)，所有执行路径的信任边界见 [SECURITY.md](../SECURITY.md)。

# 来源与首发整备边界

本仓库发布 kixrlm 的编排方法、技能/角色/命令资源、DSH 插件源码与测试，不是个人机器镜像，也不是某次会话的导出。

## 来源

- **KIX / kixparadigm**：同一维护者的公开项目 [Kasugano-Soraa/kixparadigm](https://github.com/Kasugano-Soraa/kixparadigm)。开源整备时核对的上游参考 revision 为 [`c4cb4217455647d8dbcc9b6ff967c414b329a912`](https://github.com/Kasugano-Soraa/kixparadigm/commit/c4cb4217455647d8dbcc9b6ff967c414b329a912)。它是来源参考，不代表融合后所有文件均与该 revision 字节一致。
- **RLM**：`plugins/rlm-kernel.js`、`rlm_kernel.py`、`rlm-harness.js` 及对应技能/测试源于 prime-agent RLM 的 DSH 移植工作。本地核对的上游为 [Dmatut7/prime-agent-rlm](https://github.com/Dmatut7/prime-agent-rlm)，revision [`402d58516f38b68be37e039d68cc0751b173914d`](https://github.com/Dmatut7/prime-agent-rlm/commit/402d58516f38b68be37e039d68cc0751b173914d)。保留其 MIT 版权与许可文本。
- **DSH**：插件依赖 DeepSeek Harness 的 Cordis 服务与生命周期接口。宿主 workflow 与 compaction cap 的本地改动以 [统一 diff](../integrations/dsh/host-patches/) 单独发布；上游包的 MIT 许可另附。运行依赖并未作为本仓库原创代码重新打包。

具体授权范围与资源归属见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 发布基线与改动

首发导入基线为一个完整融合 preset：130 个文件、1,992,345 字节（不含 Python 缓存与 VCS 元数据）。导入前源副本与当时安装副本经逐文件 SHA256 比对一致，未发现符号链接。本仓库随后进行面向公开分发的整备，因此不再承诺与该安装副本逐字节一致。

整备范围：

1. 保留编排、插件、技能、角色、命令、经验文档及其测试的功能面；不导入私人会话、账号凭据、模型账号配置或工作区 `.rlm` 状态。
2. 移除个人 provider/model 偏好表；运行时仍须由用户配置真实可用的模型目录。跨厂商/视觉等能力要求不因此消失。
3. 将机器绑定的部署示例换成占位符，并将可选的本地 Web 认证旁路示例默认禁用。相关实现仍保留，必须阅读安全说明后才能选择使用。
4. 修正发布目录布局下失效的测试定位与过时 preset 断言；历史多变体仓库的断言不能冒充单 preset 发布包的验收。
5. 增加面向外部用户的文档、许可文本、验证入口、Linux CI 及宿主补丁说明。

生产源副本与原有安装环境不随本次公开整备被覆盖。

## 历史资料不是发布证明

`memories/`、部分代码注释和技能参考文件包含作者历史使用经验、日期与试验数字。它们保留方法的演进语境，不是公开可复现的性能基准；原始会话日志不随包公开。旧的单机路径、旧变体名或旧上游仓库内链接可能只在其历史环境成立，应结合上游文档理解，不能据此推断本仓库支持全部历史环境。

本次具体运行过的检查及未验证项只以 [VALIDATION.md](VALIDATION.md) 为准。合成的使用场景不是已完成的实验报告。

## 核心上游文档入口

部分继承的技能文本使用 classic 目录的历史相对路径。以下是已核对存在的固定版本入口，不需要复制整套旧 preset：

- [DSH-ADAPTATION.md](https://github.com/Kasugano-Soraa/kixparadigm/blob/c4cb4217455647d8dbcc9b6ff967c414b329a912/dsh/preset-classic/DSH-ADAPTATION.md)：Copilot 到 DSH 的工具映射与适配背景。
- [PLUGINIZATION-ROADMAP.md](https://github.com/Kasugano-Soraa/kixparadigm/blob/c4cb4217455647d8dbcc9b6ff967c414b329a912/dsh/preset-classic/PLUGINIZATION-ROADMAP.md)：机制插件化的设计背景。
- [可选 vision-bridge](https://github.com/Kasugano-Soraa/kixparadigm/tree/c4cb4217455647d8dbcc9b6ff967c414b329a912/dsh/vision-bridge)：非本包默认启用能力；保留旧 persona 中的提及不代表随包安装了该桥。

上游文档解释历史契约；本发布包的实际支持范围仍由当前配置、安装说明与验证记录限定。

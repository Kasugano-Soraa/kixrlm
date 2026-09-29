# DSH 宿主补丁（实验性参考）

当前 kixrlm 的运行环境使用 DSH `0.1.5-rc.2` 的本地修改版。仅复制 preset 或只安装相同版本号，不能保证得到相同行为。

本目录发布两份由补丁前备份与运行文件生成的统一 diff，不分发 DSH 完整运行依赖：

| 补丁 | 目标包 | 作用 |
|---|---|---|
| `workflow-0.1.5-rc.2.patch` | `@deepseek-ai/dsh-workflow-worker-thread` | 未等待子代理的结算清理、实际启动计数、label/深度限制、停滞检测、console 转发 |
| `compaction-cap-0.1.5-rc.2.patch` | `@deepseek-ai/dsh-compaction-basic` | 为配置校验、schema 与压缩预算计算增加 `maxThresholdTokens` / `maxRetainTokens` |

**compaction cap 是有效配置依赖，不只是性能建议。** 本 preset 配置了上述两个绝对上限字段；不支持它们的宿主可能因未知配置键而拒绝挂载。不要为消除报错而悄悄删除上限，改变上下文预算语义。当前分发以实际 diff 代替历史注释中的本机补丁脚本与服务 drop-in；本仓库不会自动安装任何服务补丁。

workflow 的停滞检测仅覆盖“无活动子代理且无 worker 流量”，不是总运行超时。两份补丁目标代码的上游许可均为 MIT，见仓库根 `licenses/deepseek-dsh-MIT.txt`。

## 应用之前

1. 阅读完整 diff。不要将补丁应用到未知版本或正在运行的安装。
2. 在隔离的依赖副本中，按 [`../runtime-manifest.json`](../runtime-manifest.json) 的 `hostPatches` 分别比较对应包、文件的 SHA256，必须匹配 `before`。
3. 在**对应包目录**运行 `git apply --check /absolute/path/to/the-matching.patch`。这是检查，不是安装；两份补丁都使用相对 `lib/` 路径，不要在同一包目录混用。
4. 仅在明确选择采用补丁并保留回退副本之后，才手动应用，再验证对应 `after` SHA256、运行回归测试并安排宿主重启。

若 `before` 不匹配，停止；先检查上游是否已修复，不要强行忽略冲突。已匹配 `after` 的文件不应重复打补丁。回滚应恢复经过校验的原始包文件，同时评估当前 preset 对扩展字段的依赖，不能只回滚代码却保留不兼容配置。

## 证据边界

本目录保留可审查的宿主修改，不宣称是完整宿主锁文件，也不宣称已在所有干净安装、模型提供方或新版 DSH 上通过端到端测试。导出和验证过程只作用于隔离副本，不修改已安装宿主，不自动应用补丁或重启服务。本次重放检查结果见仓库根 `docs/VALIDATION.md`。

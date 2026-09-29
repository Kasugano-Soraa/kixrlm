# 手动试用 DSH 参考实现

本文只说明如何在 **Linux 测试环境**安全放置 preset，以及加载前需要确认什么。不是自动安装器，不安装 DSH、不配置 provider、不应用宿主补丁，也不执行重启。

## 1. 先核对环境和信任边界

- 阅读 [SECURITY.md](../SECURITY.md)。RLM 以宿主权限执行 Python，内核内文件/shell 不受原生工具门禁覆盖；请使用无生产凭据、低权限的独立测试环境。
- 准备你自己安装并管理的 DSH，核对 [runtime-manifest.json](../integrations/dsh/runtime-manifest.json)。当前观测版本为 **`0.1.5-rc.2`，并带额外 workflow 与 compaction cap 宿主补丁**；不据此声明最低版本或干净机器全功能兼容。
- 人工审阅 [host-patches](../integrations/dsh/host-patches/) 与目标 DSH checkout 的差异。此目录不是 preset 的一部分；下方复制命令不会应用其中内容。缺少需要的宿主能力时，应先停止对应能力的试用。
- provider、模型与凭据自行配置。核对模型目录、跨厂商与图像能力；公开 preset 已去掉个人偏好表，不会为你注册 provider。不要把密钥写入公共仓库。
- 若要使用 RLM，宿主需要可执行的 `python3`；其进程/信号行为需在目标环境实测。Windows 原生 RLM 未验证，不使用本页命令推导其支持状态。

仅想采用编排方法时，可以不加载 preset 或 RLM，先读 [原则](PRINCIPLES.md) 和 [可移植性](PORTABILITY.md)。导出的完整 preset 默认包含 RLM；本页不提供一键精简配置。

## 2. 只复制 preset，已有目标就停止

在本仓库根目录，以**实际运行 DSH 的用户**执行。下面明确使用 `DSH_HOME="$HOME/.dsh"` 示例；若服务账号的 home 是 `/home/dsh`，对应值就是 `/home/dsh/.dsh`。先确认实际宿主配置位置，不要把管理员自己的 home 当成服务账号的 home，也不要依赖本示例改变已运行宿主的配置。

```bash
# 示例：当前用户就是运行 DSH 的用户。
export DSH_HOME="$HOME/.dsh"

(
  set -eu
  src="$PWD/integrations/dsh/kixrlm"
  dst="$DSH_HOME/.agent-presets/kixrlm"

  test -f "$src/preset.yml"
  test -f "$src/agent.cordis.yml"
  mkdir -p -- "$DSH_HOME/.agent-presets"
  if ! mkdir -- "$dst"; then
    printf '%s\n' "停止：目标已存在或不可创建：$dst" >&2
    exit 1
  fi
  cp -R -- "$src/." "$dst/"
  printf '%s\n' "已复制 preset，尚未加载：$dst"
)
```

此命令先独占创建新的目标目录；目标目录、文件或同名符号链接已存在时，`mkdir` 失败并停止，不覆盖现有安装。复制中途失败会留下不完整目录，应先人工检查，再决定如何处置；不要改成覆盖重跑。

**只复制 `integrations/dsh/kixrlm`。不要复制仓库根目录，不要使用 `rsync --delete`；源材料的历史注释和路径不是推荐安装流程。** 既有安装的升级、备份与合并需自行审阅差异，不在此首次放置命令的范围内。

## 3. 人工配置与加载

1. 检查安装副本中的 `agent.cordis.yml`，确认 `kix-route` 能使用你的宿主能力目录；需要时再配置可选的 provider/模型偏好。保留来源副本便于对照，不把旧文档中的部署名称直接当成可用服务。
2. 核对宿主的工具、审批、sandbox 与 workflow 能力。preset 不是宿主，插件声明存在不代表其依赖已安装或行为已生效。
3. 在 DSH 的 preset 选择入口选择 `kixrlm` 并新建测试会话；如需调整默认项，使用你所部署版本的配置机制，不覆盖整份宿主配置。
4. 组成或 JS 插件可能受宿主进程缓存影响；文件复制成功、新建会话，都不自动证明旧进程已加载新实现。如需重载/重启，由操作者按宿主维护方式自行安排，本项目不自动执行。

内核全局记忆位置另有边界：当前实现使用宿主用户的 `~/.dsh/rlm/`，不随本页自定义 `DSH_HOME` 自动改变。不要据此变量推断不同部署的记忆已隔离。

## 4. 验证，不把复制成功当安装成功

仓库根目录提供两个检查入口：

```bash
bash scripts/check.sh
bash scripts/test.sh
```

结果与覆盖范围见 [VALIDATION.md](VALIDATION.md)。脚本通过不等于真实宿主加载、所有模型路由、隔离安全或端到端效果已经验证。

在无敏感数据的测试工作区里，从 [合成使用场景](../examples/README.md) 开始，核对实际工具列表、路由与错误回流。若启用 RLM，分别确认跨 cell 状态保持和重启后的状态丢失；不要在没有外部隔离的内核里用危险操作测试权限。记录宿主版本、补丁、平台与未验证能力，能力缺失时诚实停止或收窄任务。

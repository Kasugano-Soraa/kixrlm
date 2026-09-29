# 首次公开整备：验证记录

这是本次公开源码的实际检查记录，不是跨模型性能 benchmark，也不是完整 DSH 安装认证。合成案例见 `examples/README.md`，不要将其视为已执行实验。

## 环境

- Linux；Node.js `v24.21.0`；Python `3.12.3`；Git `2.43.0`。
- 观察到的宿主为 DSH `0.1.5-rc.2`，包含额外 workflow 与 compaction cap 修改，详见 [`runtime-manifest.json`](../integrations/dsh/runtime-manifest.json)。版本号不是最低版本保证。
- 检查对象是本仓库的公开副本，不是直接运行用户安装目录中的 preset 测试。

## 本地可重放检查

| 命令/检查 | 实际结果 | 覆盖范围 |
|---|---|---|
| `bash scripts/check.sh` | 通过 | 42 个 JavaScript/CommonJS 文件，Python 编译语法检查，两个 shell 入口语法；不是完整 ESLint/类型检查 |
| `bash scripts/test.sh` | **22 个 suite 入口，0 失败** | 21 个 JavaScript 测试文件，以及 Python RLM 协议测试入口；部分历史 JS 套件会再调用其他测试，因此不把相加的断言数当独立测试数 |
| Python `rlm_shim_test.py` | **32 tests，OK** | 实际 Python 进程/协议行为；包含在上述 22 个 suite 中，不另计一套 |
| `python3 -m json.tool integrations/dsh/runtime-manifest.json` | 通过 | 环境/补丁清单 JSON 语法 |
| workflow 补丁隔离重放 | 通过 | 从补丁前备份应用统一 diff；两份结果分别与观察到的 `index.js`、`worker.cjs` 逐字节相同 |
| compaction cap 补丁隔离重放 | 通过 | 从补丁前备份应用统一 diff；结果与观察到的运行 `index.js` 逐字节相同 |

各补丁重放的起止 SHA256 在运行清单中。重放发生在临时副本，没有修改已安装的 DSH 文件、应用系统服务配置或重启宿主。字节重放说明补丁准确表达了已观察到的修改，不等于修改已获完整端到端安全/语义证明。

## 首轮失败与修复

原样导入时语法检查通过，但 22 个 suite 中有 3 个失败。不是将失败套件排除后获得绿色结果：

1. `kix4.test.js` 原先优先加载某台机器的安装副本，并读取本包不分发的 v2/null 变体。现在只测试当前 checkout，检查实际 kixrlm 组成与所需本地资源；不再把历史多变体对照当成单 preset 发布契约。
2. `kix-consistency.test.js` 原先将真实宿主祖先目录当多变体 fixture。现在使用已有临时夹具，保留内容漂移/文件集合/缺失副本等覆盖，并验证单 preset 的无跨副本检查行为。普通目录负例放在受控深层临时树，避免同级 `/tmp` 测试残留污染八层向上发现。
3. `kix-webhook.test.js` 原先仍断言默认 preset 为 `kixparadigm`。现在对齐实际 `kixrlm` 默认值，并补显式 preset/permission override 的优先级测试。

这些修改没有重写生产插件算法。修复后完整脚本重跑得到上表结果。

## 公开内容检查

- 导入基线经过文件清单、路径/URL、凭据形状与高熵候选检查，以及独立来源复核。未确认真实密钥；这不等于保证所有秘密绝对不存在。
- 已保留 KIX、prime-agent RLM、Matt Pocock skills 和 DSH 的适用 MIT 文本与版权声明；归属见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- 个人路由偏好、机器绑定用户路径和部分历史会话标签已清理/匿名化；测试常量与安全识别规则保留。
- `.rlm/`、本次任务记录、凭据和会话历史不属于分发物。静态 `memories/` 是随源码维护的经验资料，不是整个用户记忆数据库。

## 证据边界 / 尚未验证

- 多数 JS 插件测试使用 fake Cordis context；不能证明真实宿主全部服务、hooks 与生命周期集成正确。
- 未在一台全新机器上安装并挂载完整 DSH preset；未验证全部真实模型调用、跨厂商路由或浏览器/CDP 集成。
- 发布整备会话中一次跨厂商观察工具调用报告 `kix-route:cross` 未解析为已配置模型；未做根因诊断，不以其他单元测试通过掩盖该未知项。
- RLM 以宿主权限执行，不因测试通过就变成沙箱；进程/命名空间隔离不是文件、网络或账号权限隔离。
- 当前环境没有 PowerShell，未执行继承的 KIXPower PowerShell 契约回归。Native Windows RLM 与其他 Harness 原生适配也未验证。
- 历史 memories 中的性能数字与旧测试数量不是此次重跑结果；本仓库不据此承诺通用效率提升。
- GitHub Actions 复用同两个脚本；远端运行结果应以仓库 Actions 页对应 commit 为准，不能仅凭本地通过推定远端已通过。

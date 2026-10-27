# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## v1.0.1

日期：2026-10-27

### 修复

- 打印模型 ID 时给 Bedrock ARN 的 12 位账号号码打码（`doctor` / `configure` / `uninstall` / `provider` / `route-check` / `usage-audit` / `ccswitch-caps`），比较和查表仍用原值
- `doctor.js` 的报错不再回显原文：`settings.json` 语法错只报「不是合法 JSON（第 N 行附近）」，网关与 transcript 的报错只报分类和错误码，避免把 key、带凭据的 URL、完整路径打出来
- `doctor.js` 读 `settings.json` 前先去掉 BOM（和 `configure` / `ccswitch-caps` / `uninstall` 一致）；一个读不了的 transcript 不再让整段检查中止，只记下第一个失败的文件名继续扫

### 变更

- `/route` 最后汇报精简为四条：问题 / 解法（含决定清单）/ 现状（审查报告、修了哪几条、没验证的、未提交的改动）/ 一行模型核对；不再贴 `route-check` 全表、模型构成和用量。装过的用户下次跑一次安装入口才会更新 `route.md`

### 文档

- README 给出 EIU 定义并说明它是体量指数、不是花费，实际花费以网关账单或 CC Switch 余额为准
- 新增 auto 模式下 `Agent` / `SendMessage` 放行规则不生效的调查结论（TECH-LIBRARY §3、GUIDE 安装与已知边界）
- `doctor --gateway` 的报错按原因分类：base URL 写法问题、返回的不是模型列表格式、网络问题，修复建议不再一律让人等网络

### 已知限制

- auto 模式下 `Agent` 的 `permissions.allow` 规则会被 CLI 整条摘掉，派子代理没法靠规则免拦
- 服务端若打开 yolo-equiv 开关（默认关），auto 下连 Bash / PowerShell 的 allow 规则也会一起失效

## v1.0.0

日期：2026-10-27

首个正式版。下面是到这一版为止的全部内容，按功能分组。

### /route 命令和两个子代理

- 新增 `/route <任务>`：一条命令跑完「规划 → 你拍板 → 实现 → 查错 → 汇报」，主会话只编排、把决定交给你、核实结果，不写生产代码，过程报告落盘。命令名统一为 `/route`（开发中曾叫 `/dev`、`/automode`）
- 新增 `/plan-fable <任务>`：只规划、不实现，规划交给 Fable 子代理
- 两个子代理：`planner-fable`（frontmatter 钉 `fable`，effort `xhigh`，负责规划）、`code-reviewer`（frontmatter 钉 `opus`，effort `xhigh`，负责查错）；实现、修复、文档走 `sonnet` 的通用子代理
- 规划和查错都跑在子代理里：读的文件留在子代理上下文，只有结论回主会话，不污染主上下文，也不破坏主会话的 prompt cache
- 派活时带收工条款，防止子代理一路干到上下文膨胀、每次调用越来越贵
- 审查报告落盘后，主会话上下文超过 300k 会附一行现成的 `/compact` 提示（只给不催）

### 一键安装 / 卸载

- 新增安装入口：`setup.cmd`、`setup.ps1`（Windows）、`setup.sh`（Linux / macOS）、`setup.command`（macOS 访达双击）。不带参数出菜单：1 安装 / 升级、2 卸载、3 试运行（只列会改什么）、4 给 CC Switch 卡片补能力声明、5 只配模型设置并体检；带参数就直接执行（如 `install --rules=…`、`--dry-run`、`--yes`、`--items=…`、`--no-configure`、`--no-doctor`）；不认识的参数直接退出，不会先装一半
- `install.js`：插件文件放到 `~/.claude/plugins/model-router/`，`commands/*.md` 部署到 `~/.claude/commands/`，`agents/*.md` 部署到 `~/.claude/agents/`；会覆盖的旧文件先备份；重复跑就是升级。插件目录里已有克隆仓库或被改过的文件时走「原地模式」，只部署命令和子代理，不复制、不记进清单
- 放行规则：安装时逐条列出让你勾，写进用户级 `settings.json` 的 `permissions.allow`。共四条：`clean`、`check`（默认勾选）、`audit`、`doctor`（默认不勾）；每条只放插件自带的一个脚本。改 `settings.json` 前先备份，写完核对其余内容一字不差；再跑一次少选几条，上次加的会被去掉，你自己加过的同名规则不动
- `uninstall.js`：按安装清单只撤回安装时放进去、之后没改过的文件和安装器加的规则；备份不动，列出路径；认 `--dry-run`、`--keep-ccswitch-caps`、`--keep-card-settings`。补过 CC Switch 能力声明的会先一起撤回，撤不了就整个卸载中止，什么都不动，并打印可直接照抄的命令
- `.gitattributes` 写死安装入口的换行符：`.cmd`、`.ps1` 用 CRLF，`.sh`、`.command` 用 LF

### 安装 flow：装插件 → 配模型设置 → 体检

- 菜单 1 和 `setup install` 把三步串起来：装插件（`install.js`）→ 配模型设置（`configure.js`）→ 体检（`doctor.js`）。前一步失败就停下并打印停在第几步；体检退出码非 0 只表示发现了要处理的问题，只打印一行提示，不算安装失败
- 新增 `configure.js`：改本机用户级 `settings.json`，先列出每一项的状态再问一次（回车按默认，输入编号只做这几项）。共七项：`subagent`（删 `CLAUDE_CODE_SUBAGENT_MODEL`）、`effort`（补 `modelSettings`）、`fallback`（顶层 `effortLevel`）、`model`（顶层 `model`）默认做；`compact`（`autoCompactWindow`）、`cache`（`promptCacheTtl`）、`pwsh`（PowerShell 工具，只在 Windows 列出）默认不做
- 已配过的项不动，只在列表里标出差异；`ANTHROPIC_DEFAULT_*_MODEL` 只报告、不写（模型 ID 跟网关走，猜错代价是调用全失败）
- 改之前备份、写后重读核对，不一致就从备份恢复并以退出码 1 结束；改了什么记进安装清单，卸载时按清单撤回
- 菜单 5（或 `setup configure`）可以单独只配模型设置并体检；认 `--items`、`--yes`、`--dry-run`、`--no-doctor`
- 换供应商漏映射检查：当前供应商不是 Claude 系（env 里 `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` 或 `ANTHROPIC_MODEL` 有值不以 `claude-` 开头；`ANTHROPIC_MODEL` 写别名不算）、而 `fable` / `opus` / `sonnet` 有没映射的，用这个别名的子代理会去要 Claude 的模型、直接失败。`doctor.js`（快速、完整都查）报 ❌（`haiku` 没映射报 ⚠），`configure.js` 打一行 ⚠，修法是在 CC Switch 卡片里把这个别名映射到这家的模型；只报告、不写。`CLAUDE_CODE_USE_BEDROCK` / `_MANTLE` / `_VERTEX` / `_FOUNDRY`（Bedrock / Bedrock Mantle / Vertex / Foundry）任一为真时整段跳过（这些平台上别名由 CLI 自己映射）

### CLAUDE_CONFIG_DIR 支持

- 安装、配置、卸载、体检、`provider.js`、`route-check.js` 等脚本都认环境变量 `CLAUDE_CONFIG_DIR`（和 Claude Code 一致），没设就是 `~/.claude`；菜单顶上会写出实际装到哪
- 装在默认位置时，命令文件和放行规则里的脚本路径写 `~/.claude/plugins/model-router/…`；装在别处时写成插件目录的绝对路径，命令文件和放行规则两边同形
- 安装清单记着装在哪个配置目录（`configDir`）；整个目录挪了位置后重装、卸载，不在当前配置目录里的文件一律不删

### 按会话切换供应商（`provider.js`）

- 新增 `provider.js`：只给一个会话换供应商，不动 CC Switch、不改 `settings.json`，可以一边开 Claude 会话、一边开别家会话。它把 `providers/<名字>.json` 的 env 加上 key 写进临时文件，用 `claude --settings` 启动，会话结束就删；`--list` 列出可用配置，`--dry-run` 只看会怎么启动（key 打码）
- 不存任何 key：key 从环境变量读（默认 `DEEPSEEK_API_KEY`，`--key-env` 换变量名，只认变量名、填成 key 本身会被拒绝）
- 主模型是完整模型 ID 时，会话自动改成 OPUS 别名映射的模型并打印说明，避免第三方供应商按最贵的模型计费
- 新增 `providers/deepseek.json`。**目前只实测适配了 DeepSeek**，其他供应商还没适配
- `route-check`、`doctor`、`usage-audit` 都认第三方模型：别名映射到同一个模型时只给说明不报错，`usage-audit` 按 DeepSeek 公开价计费并区分高峰和非高峰

### ccswitch-caps：给 CC Switch 卡片补能力声明

- 新增 `ccswitch-caps.js`（安装菜单第 4 项）：按卡片 `ANTHROPIC_BASE_URL` 的主机名对上 `providers/*.json`，只给映射到第三方模型的别名补**缺的**能力声明（`_SUPPORTED_CAPABILITIES`）和 `_NAME`，已有的键不改；对不上的卡片只列出来、不动
- 认 `--dry-run`（先看会补什么）、`--undo`（撤回补过的）、`--db <路径>`（数据库搬了位置时用）；写之前要求先退出 CC Switch，先备份数据库和 `settings.json`，写完核对其余内容一字不差，输出里不出现 key
- 读 CC Switch 的 SQLite 数据库要 Node 22.13+（`node:sqlite`；18+ 也能装，只是读不了 CC Switch 卡片）；版本不够会列出要手动加的几行

### 工具：route-check / doctor / usage-audit / route-clean

- `route-check.js`：每轮结束后核实各子代理**实际**跑的模型和档位（读 transcript 里的 `message.model` 和 `effort`，不看配置推断），跑错当场报，有 ❌ 退出码为 1；没问题时只打一行，并输出主会话当前上下文
- `doctor.js`：配置体检（网关连通、别名钉版、孤儿键等）；`--quick` 只读 `settings.json`，配合 `--quiet` 可挂 SessionStart 钩子静默自检；`--gateway` 另外问网关有没有同族新版模型（要读凭据，需要时手动跑）
- `usage-audit.js`：统一口径的用量统计（EIU、缓存命中率、子代理规模分档、缓存 TTL 模拟）；价格口径内置，基线用 `--baseline` 自行生成，不入库
- `route-clean.js`：清理 `/route` 的过程文件，只删 `.route-plan.md`、`.route-plan-*.md`、`.route-handoff-*.md` 三种文件名，并跳过被 git 跟踪的文件

### 文档

- `README.md`：亮点、实测数据、安装（一键安装 / 手动安装）、用法、换供应商、依赖要求、Roadmap；顶部加 logo 和徽章
- `docs/GUIDE.md`：为什么这样分、实测踩过的坑、安装细节（含安装 flow、配置目录、CC Switch 哪些键切卡会变、卸载）、验证、升级与回滚、成本分析
- `docs/TECH-LIBRARY.md`：调研过但暂缓的方向（跨供应商通用化、Codex 迁移）
- 采用 MIT 许可证，见 `LICENSE`

### 已知限制

- 当前定位只服务 Claude Code
- 依赖 Claude Code CLI（本方案在 2.1.276 实测）和 Node.js 22.13+（18+ 也能装，只是读不了 CC Switch 卡片）；Windows / macOS / Linux 都能装，但只在 Windows 上实测过整套流程
- 供应商只实测适配了 DeepSeek
- CC Switch 哪些键切卡会变，是按其新版源码读出来的，没有在真实切卡里逐项实测

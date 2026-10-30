<div align="center">

<img src="docs/logo.svg" width="112" height="112" alt="model-router logo：一条线分成三条，分别对应规划、执行、查错">

# claude-model-router

[![version](https://img.shields.io/badge/version-v2.0.3-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#安装)

</div>

Claude Code 插件 **model-router**：按任务阶段分配模型（规划 / 实现 / 查错），降低 token 开销同时控制 bug 率。

日常只需要一条命令：**`/route <任务>`** —— 它把三个阶段串起来自动跑完：

| 阶段 | 模型 | 跑在哪 |
|---|---|---|
| **规划** | fable | `planner-fable` 子代理 |
| **实现 / 修复 / 文档** | sonnet | `general-purpose` 子代理 |
| **查错 / 复审** | opus | `code-reviewer` 子代理 |

主会话只编排、把决定交给你、核实结果，不写生产代码。规划和查错都跑在**子代理**里：它们读的文件留在子上下文，只有结论回主会话——既不污染主上下文，也不破坏主会话的 prompt cache。

设计目标是同时解决两个互相冲突的痛点：**全程 Opus 太贵**，但**全程 Sonnet bug 太多**。

## 为什么这样分

省钱**不靠削执行阶段的思考质量**。真正的节省来自两处：

1. **单价差**：占 token 绝大头的执行阶段（读文件、跑命令、写代码）从 Opus 换成 Sonnet。
2. **上下文不膨胀**：审查跑在子代理里，读的一大堆文件留在子代理的上下文，**只有结论回主会话**。

而 Fable 和 Opus 给到最高档 effort——规划质量直接决定 Sonnet 会不会写错，钱花在这里才划算。每轮跑完用 `route-check.js` 核实每个子代理**实际**跑的模型，防止静默跑错。

## 亮点

- **一条命令跑完整链路**：`/route <任务>` 串起规划 → 实现 → 审查 → 汇报，主会话只编排、把决定交给你、核实结果，不写生产代码
- **上下文可见、膨胀有刹车**：`route-check.js` 每轮输出「主会话当前上下文」；审查报告落盘后超过 300k 会附一行现成的 `/compact` 提示（只给不催）；`autoCompactWindow` 控制原生自动压缩的触发点
- **子代理隔离上下文**：规划、审查读的一大堆文件留在子代理上下文里，只有结论回主会话——不污染主上下文，也不打爆 prompt cache（实测比切模型省约 8 倍 token）
- **防静默跑错**：每个子代理返回后核实它实际跑的模型（不是看配置推断），跑错当场报，不用等账单
- **用量可度量**：`usage-audit.js`（v2.0.0 起在 `plugins/usage/`，根目录留转发脚本）提供统一口径的成本统计：`$/h`、缓存命中率、子代理规模分档、缓存 TTL 模拟、按 `/route` 轮看、`--check` 单价表检查，所有结论可复现。`$` 按各模型公开价分项算，**只作大致对比**（判断「是不是更便宜」够用），准确金额以网关账单为准；想校准实付就跑一次 `usage-balance.js`（见[用法](#用法)）。EIU 已在 v2.0.0 废弃。口径见 [GUIDE「用量插件」](docs/GUIDE.md#用量插件usage-auditjspluginsusage)
- **配置可体检**：`doctor.js` 一条命令核查网关连通、别名钉版、孤儿键，可挂 SessionStart 钩子静默自检
- **不存任何 key**：供应商与凭据由 Claude Code / CC Switch 管理；只有 `provider.js` 在启动时从环境变量读 key、交给那一个会话，会话结束就删临时文件
- **能换供应商**：别名映射到 DeepSeek 等第三方模型时，流程照样按阶段派活，`route-check` / `doctor` / `usage-audit` 都认第三方模型（DeepSeek 10-26 实测）

## 实测数据

单机 22 天口径（`usage-audit.js` 可复现，统计口径详见 [GUIDE](docs/GUIDE.md)）：

| 期间 | 平均 $/h（大致对比） |
|---|---|
| 纯 Opus（10 天） | $32.9 |
| route 模式（7 天） | **$25.3（−23%）** |

| 发现 | 数字 |
|---|---|
| 成本大头是上下文长度，不是输出 | 缓存读写合计 **92%**，输出仅 7.6% |
| 规划走子代理 vs 主会话切模型 | 约 **1/8** token（切模型令缓存全量归零） |
| 主会话缓存 TTL 5min → 1h | 回放 16 天：日均 **−$18.6** |
| 子代理规模超 200 次调用 | 每次调用的体量翻 **2.6 倍**（按当时的 EIU 折算；平方级膨胀，流程已加收工条款） |

> 样本为单人真实工作负载，绝对金额与你的模型单价相关，比例关系更有参考价值。

## 仓库结构

```
.claude-plugin/plugin.json     插件清单
commands/route.md           /route 一站式流程（权威说明）
commands/plan-fable.md         /plan-fable 单独规划
agents/planner-fable.md        规划子代理（frontmatter 钉模型）
agents/code-reviewer.md        审查子代理
route-check.js              每轮结束后核实子代理实际跑的模型
doctor.js                      配置体检（网关、别名、孤儿键等）
usage-audit.js                 旧路径转发脚本（真脚本在 plugins/usage/，老命令照常可用）
plugins/usage/usage-audit.js   用量统计（$ 口径内置；--rounds 按轮、--check 单价表；基线 / 校准记录同目录、不入库）
plugins/usage/usage-balance.js 记一次实付读数（余额或中转站累计用量），给 usage-audit 校准隐形占比
.claude-plugin/marketplace.json 三个插件的市场清单（实验性，见「安装」最后一节）
route-clean.js              清理 /route 过程文件
plugins/switch/provider.js     只给一个会话换供应商（不动 CC Switch、不改 settings.json）
plugins/switch/ccswitch-caps.js 给 CC Switch 里映射到第三方模型的卡片补能力声明（安装菜单第 4 项）
configure.js                   装完接着配模型设置（modelSettings、effortLevel 等，安装菜单第 5 项也能单独跑）
plugins/switch/providers/*.json 供应商配置（别名映射、能力声明、key 从哪个环境变量读、余额 / 用量接口）；仓库只带 deepseek.json，自建的放这里、安装器不碰
setup.cmd / .ps1 / .sh / .command   安装入口：双击或命令行，出菜单（Windows / PowerShell / Linux·macOS / macOS 访达）
setup.js                       菜单本体，也负责把「安装 → 配置模型设置 → 体检」串起来（上面四个都调它）
install.js / uninstall.js      安装 / 卸载（入口最终跑这两个，也能直接调）
docs/GUIDE.md                  详细文档（安装、实测结论、成本分析、验证、升级）
docs/TECH-LIBRARY.md           技术调研库（跨供应商 / Codex 迁移等暂缓方向）
```

## 安装

完整说明见 [docs/GUIDE.md](docs/GUIDE.md)。

### 一键安装（推荐）

先装 [Node.js](https://nodejs.org) 22.13+（18+ 也能装，只是读不了 CC Switch 卡片），再把仓库克隆或下载解压到任意位置：

```bash
git clone https://github.com/Aack000/claude-model-router.git
```

不想装 git 的话，也可以从 [Releases 页](https://github.com/Aack000/claude-model-router/releases)下载最新版本里的 **Source code (zip)**，解压到任意位置，再双击对应平台的 `setup` 入口（见下表「双击」一列；Linux 没有双击，在终端里跑 `./setup.sh`）。两种装法进的是同一个菜单。

| 系统 | 双击 | 命令行 |
|---|---|---|
| Windows | `setup.cmd` | `setup.cmd`（cmd）、`.\setup.ps1`（PowerShell） |
| macOS | `setup.command`（访达里双击） | `./setup.sh` |
| Linux | — | `./setup.sh` |

不带参数出菜单：1 安装 / 升级（先问装哪些组件，装完接着配模型设置、体检，见下面「装哪些组件」和「安装 flow」）、2 卸载、3 试运行（只列会改什么，不动文件）、4 给 CC Switch 卡片补能力声明（见下面「换供应商」）、5 只配模型设置并体检（要先装好插件）。选了安装会依次问组件（装哪些）、放行规则（逐条列出让你勾）、模型设置（列出各项）三次，都是直接回车按默认。

带参数就直接执行、不出菜单：

```bash
./setup.sh install --rules=clean,check   # 指定放行规则：名字或编号，逗号分隔；all = 全要，none = 都不要
./setup.sh install --dry-run             # 只看会改什么
./setup.sh install --yes                 # 模型设置不逐项问，按默认勾的来
./setup.sh install --items=effort,fallback --no-doctor   # 模型设置只配这两项，装完不体检
./setup.sh install --no-configure        # 只装插件（和体检），不配模型设置
./setup.sh install --components=core,usage   # 装哪些组件：名字或编号，all = 全装（见下面「装哪些组件」）
./setup.sh configure                     # 只配模型设置并体检（= 菜单 5，要先装好插件）
./setup.sh uninstall                     # 卸载，同样支持 --dry-run
```

**装哪些组件（v2.0.0 起，`--components=core,usage,switch`）**：也认编号（1 core、2 usage、3 switch）和 `all` / `core`。**core 必装**；没给参数时会先问一行（回车 = 按勾的来，输入编号 = 只要这几个，`0` = 只装 core），输入已结束（管道、没有终端）时不问、直接用默认。默认勾哪些：

| 组件 | 装什么 | 默认 |
|---|---|---|
| core | `/route` 流程、`route-check`、`route-clean`、`doctor`、`configure`、根目录的 `usage-audit.js` 转发脚本 | 总是装 |
| usage | 用量统计（`usage-audit.js`、`usage-balance.js`），装到 `<插件目录>/usage/` | 新装不勾；**v1.x 升级默认勾上** |
| switch | 供应商工具（`provider.js`、`ccswitch-caps.js`、`providers/deepseek.json`），装到 `<插件目录>/switch/` | 新装时检测到 CC Switch（`~/.cc-switch`）才勾；**v1.x 升级默认勾上** |

- **v1.x 升级不带 `--components` 时默认全装三个组件**：v1.x 装的就是全部，只装 core 的话，旧的 `usage-audit.js` 命令会失效、装过的 `audit` 放行规则会被去掉。新用户第一次装仍只默认 core（检测到 CC Switch 再加 switch）；装过 v2 的，沿用清单里记的上次选择。
- **组件文件是写死的清单，不是递归复制**：上表那几个文件才会装。源目录里自己的本地数据（`calibration.jsonl`、`usage-baseline.json`、自建的供应商文件、编辑器备份）不会被装进插件目录、也不记进清单，升级和卸载都不会覆盖或误删它们。
- **装完布局**：core 仍平铺在 `~/.claude/plugins/model-router/`，组件在同名子目录里；v1.x 装过的平铺 `provider.js` / `ccswitch-caps.js` / `providers/` 里没改过的会被自动清掉（改过的留着并提示）。**自定义供应商文件现在放 `<插件目录>/switch/providers/`**：v1.x 在旧 `providers/` 里自建的 json 要自己挪过去，安装器发现后会提示，但不动它们。
- **从装好的插件目录跑安装（副本模式）**：新勾的组件在源目录里找不到文件，动任何文件之前就停（退出 2），提示从下载的仓库或解压出来的目录跑安装入口；已装的组件这次没勾，副本模式不删它的文件，会提示一行「要去掉从仓库目录跑安装入口，或者用卸载」。
- **没装的组件被用到时**：根目录的 `usage-audit.js` 转发脚本、`setup caps` 会提示 `node install.js --components=all`（三个全装、不会卸掉已装的）；别手敲只含缺的那个组件的列表，那会把没列的已装组件卸掉。

Windows 把 `./setup.sh` 换成 `setup.cmd` 或 `.\setup.ps1`。也可以直接跑 `node install.js …`、`node configure.js …`、`node uninstall.js …`，各自认的参数见下；串联「安装 → 配置 → 体检」是 `setup` 做的，直接跑 `install.js` 只装插件，结尾会提示接着跑 `configure.js`。

**安装 flow：装插件 → 配模型设置 → 体检。** 菜单 1 和 `setup install` 都是三步串着跑：① 装插件（`install.js`）→ ② 配模型设置（`configure.js`）→ ③ 体检（`doctor.js`）。前一步失败（退出码不是 0）就停下，打印停在第几步，后面的不跑；体检是例外，它退出码非 0 只表示发现了要处理的问题，只打印一行提示，不算安装失败。第 2 步失败时安装已经做完，修好后用菜单 5（或 `setup configure`）接着配。菜单 4（补能力声明）不在 flow 里，要的话单独选。

`setup install` 的参数，分给各步：

| 参数 | 交给 | 作用 |
|---|---|---|
| `--components=…` | `install.js` | 装哪些组件，写法见上 |
| `--rules=…` | `install.js` | 放行规则，写法见上 |
| `--items=…` | `configure.js` | 只配这几项：写名字，逗号分隔（如 `--items=effort,fallback`）；`all` = 全做，`none` = 都不做；给了就不再逐项问。也可以用编号，编号按屏幕上列出的顺序，不同平台可能不同，写脚本时用名字 |
| `--yes` | `configure.js` | 不问，按默认勾的来 |
| `--dry-run` | 安装和配置两步 | 只看会改什么。体检不预演；还没装过插件（没有安装清单）时，配置这一步也没法预演 |
| `--no-configure` | `setup` 自己 | 跳过第 2 步（体检照跑） |
| `--no-doctor` | `setup` 自己 | 不体检 |

`setup configure` 认 `--items`、`--yes`、`--dry-run`、`--no-doctor`。不认识的参数直接退出（exit 2），不会先装一半。

**第 2 步配什么**（`configure.js`，也可以单独跑：`node ~/.claude/plugins/model-router/configure.js [--dry-run] [--yes] [--items=…]`；要先装好插件，没有安装清单会提示先装并退出）。它改的是本机用户级 `settings.json`，先列出每一项的状态再问一次：回车 = 按 `[x]` 的来，输入编号 = 只要这几项，`0` = 一项都不要；没有可交互的输入（管道）时按默认。`[ ]` 是默认不做，`[-]` 是没有要做的。

| 编号（Windows 上的顺序） | 名字 | 做什么 | 默认 |
|---|---|---|---|
| 1 | `subagent` | 删 `env.CLAUDE_CODE_SUBAGENT_MODEL`（有它时）：它会让所有子代理 frontmatter 里的 `model` 失效，`code-reviewer` 被静默降级 | 做 |
| 2 | `effort` | `modelSettings`：sonnet `high`、fable `xhigh`、opus `xhigh`、haiku `low`，只补缺的别名 | 做 |
| 3 | `fallback` | 顶层 `effortLevel` = `"high"`（`modelSettings` 没列到的模型用它） | 做 |
| 4 | `model` | 顶层 `model` = `"opus"`，本机没有才补 | 做 |
| 5 | `compact` | `autoCompactWindow` = `500000` | 不做（个人选择） |
| 6 | `cache` | `promptCacheTtl` = `"1h"` | 不做（Kimi、百炼、OpenRouter 等网关不支持 1h 缓存，按自己的网关定） |
| 7 | `pwsh` | `env.CLAUDE_CODE_USE_POWERSHELL_TOOL` = `"1"` | 不做（只在 Windows 上列出） |

- **已经配过的项不动**：已有且同推荐值的跳过；已有但值不同的（比如你自己把 sonnet 设成 `xhigh`）保留，只在列表里标出差异；缺的才补。唯一会删东西的是第 1 项。
- **`ANTHROPIC_DEFAULT_*_MODEL` 只报告、不写**：没钉就提示一行。模型 ID 跟网关走，安装器猜错的代价是调用全失败，所以用 CC Switch 卡片或自己手动配。
- **改之前备份、写后核对、记进清单**：改 `settings.json` 前先备份成 `settings.json.bak-model-router-<时间>`；写完重读核对，除了本次改的键，其余内容一字不差，不一致就从备份恢复并以退出码 1 结束；沿用原文件的缩进、换行和 BOM。改了什么记进安装清单（`settingsChanges`），卸载时按它撤回（见下面「卸载」）。输出里不会出现 env 里的其它值。

第 1 步装插件做三件事，可以重复跑（重复跑就是升级，想改放行规则的选择也是再跑一次）。下面写的 `~/.claude` 都指配置目录，设了 `CLAUDE_CONFIG_DIR` 的话见下面「配置目录」：

1. 插件文件放到 `~/.claude/plugins/model-router/`（`route.md` 按这个路径调用脚本）。把 zip 解压进插件目录、再从那里跑安装时，分两种情况：
   - 目录里没有 `.git`，且文件和上次装好时完全一致：**副本模式**，正常升级
   - 否则（克隆的仓库就在那里、第一次就解压在那里、解压了新版覆盖进来、或文件被改过）：**原地模式**——插件文件不复制、不记进清单，只部署命令和子代理。卸载时插件目录里的文件不会被删，要自己删整个目录
2. `commands/*.md` → `~/.claude/commands/`，`agents/*.md` → `~/.claude/agents/`；会覆盖的旧文件先备份成 `*.bak-<时间>`
3. 用户级 `~/.claude/settings.json` 的 `permissions.allow` 按你的选择加放行规则：

| 名字 | 默认 | 放行的命令 | 不放行会怎样 |
|---|---|---|---|
| `clean` | ✓ | `node ~/.claude/plugins/model-router/route-clean.js …` | `/route` 收尾删过程文件被拦，流程卡住等人 |
| `check` | ✓ | `node ~/.claude/plugins/model-router/route-check.js …` | `/route` 每个子代理返回后都要核模型，被拦就停 |
| `audit` |  | `node ~/.claude/plugins/model-router/usage-audit.js …`（旧路径，转发到 usage 组件；没选 usage 时不列出这条） | 让 Claude 查用量时偶尔要你手动批 |
| `doctor` |  | `node ~/.claude/plugins/model-router/doctor.js`（只放不带参数的） | 同上；`--gateway` 要读凭据，始终不放行 |

为什么要放行规则：auto 模式的权限分类器会误拦这几个脚本（作者实测 route-check 300 多次里被拦 5 次），命中放行规则的命令不送分类器。每条规则只放插件自带的一个脚本，边界由脚本自己守：`route-clean.js` 只删 `.route-plan.md`、`.route-plan-*.md`、`.route-handoff-*.md` 三种文件名，并跳过被 git 跟踪的文件；其余三个只读。改 `settings.json` 前先备份（同一秒连跑也不会互相覆盖），只动 `permissions.allow`，写完核对 env 和其余配置一字不差。再跑一次少选几条，上次安装加的会被去掉；你自己原先加过的同名规则不动。这些规则 Claude 自己加不了（auto 模式下给自己放权会被拦），所以要你亲手跑。**派子代理（Agent 工具）没法用放行规则免拦**：auto 模式会把 Agent 的放行规则整条忽略，查证结论见 [TECH-LIBRARY §3](docs/TECH-LIBRARY.md)。

装完**重启 Claude Code**。一键安装的第 2 步已经问着帮你配了模型设置（模型别名映射 `ANTHROPIC_DEFAULT_*_MODEL` 除外，它因网关而异，脚本只提示、不替你写），不用再手动改；手动安装才要按下面「手动安装」第 3 步自己配。

**配置目录**：认环境变量 `CLAUDE_CONFIG_DIR`（和 Claude Code 一样），没设就是 `~/.claude`；安装、配置、卸载、体检都按它走，菜单顶上那一行会写出实际装到哪。装在默认位置时，命令文件和放行规则里的脚本路径写 `~/.claude/plugins/model-router/…`（已装用户的规则和命令文件不变）；装在别处时写成插件目录的绝对路径（正斜杠，含空格等字符时整条脚本路径加双引号），命令文件和放行规则两边同形，规则才对得上。目录名里带引号、反引号、`$`、反斜杠字符的会被拒绝（命令里没法安全引用，什么都没改）。`CLAUDE_CONFIG_DIR` 设成相对路径时，`setup` 先解析成绝对路径再交给各步。安装清单记着装在哪个配置目录（`configDir`）：把配置目录整个复制或挪了位置以后，重装和卸载都按当前所在的目录处理——清单里记的旧路径换到当前目录下，不在当前配置目录里的文件一律不删（打印「没动」），不会删到别的目录。

**用 CC Switch 的话**：新版（`~/.cc-switch/` 里有 `cc-switch.db` 和 `live-state.json`）切卡时不是整份替换 `settings.json`，只换「归卡片」的键，其余原样保留。下面是按 CC Switch 新版源码读出来的，没有在真实切卡里逐项实测：

| 归谁 | 键 | 切卡时 |
|---|---|---|
| 归卡片 | env 里所有 `ANTHROPIC_*`（含 `ANTHROPIC_DEFAULT_*_MODEL`、`_SUPPORTED_CAPABILITIES`）、`AWS_*`、`CLAUDE_CODE_SUBAGENT_MODEL`、OAuth 相关；顶层 `model`、`modelOverrides`、`apiKeyHelper`、`fallbackModel` 等；`CLAUDE_CODE_AUTO_MODE_SERVER`、env 版的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 等兼容开关 | 换成新卡片自己的。写本机文件 = 写进当前卡片（切走时存回），别的卡片各有各的 |
| 归你 | 其余所有键：`modelSettings`、`effortLevel`、顶层 `autoCompactWindow`、`promptCacheTtl`、`permissions`、`hooks`、`CLAUDE_CODE_USE_POWERSHELL_TOOL` 等 | 原样保留，写本机文件一次就够，切卡不丢 |

- 所以第 2 步配的项，除 `model` 和 `subagent`（`CLAUDE_CODE_SUBAGENT_MODEL`）外切卡不丢。这两项写的是当前卡片：别的卡片如果自己带着 `CLAUDE_CODE_SUBAGENT_MODEL`，切过去它就回来了。`configure.js` 会只读打开 CC Switch 的数据库（不写），列出还带着它的卡片名，请你在 CC Switch 里把它删掉（要 Node 22.13+，版本不够就只提示）。换到没配 `model` 的卡片（比如 DeepSeek），主模型会回到 CLI 默认，这是 CC Switch 的设计。
- **旧版** CC Switch（有 `cc-switch.db`、没有 `live-state.json`）切卡会整份覆盖本机 `settings.json`，这里配的会被冲掉。`configure.js` 开头会打警告；要么升级 CC Switch，要么把这些设置同步进每张卡片。安装器只警告，不替你做卡片同步。
- CC Switch 默认写的是 `~/.claude`；设了 `CLAUDE_CONFIG_DIR` 指到别处时，除非 CC Switch 也指到了同一个目录，上面关于它的说法不一定适用（装了 CC Switch 的话，`configure.js` 会提醒一句）。

卸载：再跑一次入口选「卸载」，或 `node ~/.claude/plugins/model-router/uninstall.js`（认 `--dry-run`、`--keep-ccswitch-caps`、`--keep-card-settings`）。它只撤回安装时放进去、之后没改过的文件，以及安装器加的规则；备份不动，列出路径。第 2 步配过的模型设置也按清单撤回：加的键，值还是配置时的才去掉，改过的留着、只提示；配置时删掉的 `CLAUDE_CODE_SUBAGENT_MODEL` 恢复成原值（现在已经有这个键就不动），恢复时会提醒它会让子代理的 model 设置失效、体检会报；`modelSettings` 里撤空后留下的空对象（`sonnet: {}` 之类）不删。补过 CC Switch 能力声明的，卸载会先一起撤回（要先退出 CC Switch；检测不了它在不在运行时会问你一次）。撤得成的先撤掉；撤不了的（没有 node:sqlite、数据库挪了位置之类）留在清单里，卸载就此中止，插件文件、命令、放行规则都不动，并提示两条路：把数据库放回原处再卸载，或加 `--keep-ccswitch-caps` 让补的几行留在卡片里。

- **`model`、`CLAUDE_CODE_SUBAGENT_MODEL` 归卡片，卸载会先看当前是哪张**：第 2 步改这两项时（有 CC Switch、配置目录是默认的 `~/.claude`）记下了当时的当前卡片。卸载时 CC Switch 的当前卡片不是那张、或查不出是哪张（没有 node:sqlite、读库失败），现在撤回会落到另一张卡片上，所以整个卸载在动任何东西之前停下（退出码 1，什么都不动；加 `--dry-run` 只提示正式卸载会在这里停）。两条路：在 CC Switch 切回那张卡片再卸载；或加 `--keep-card-settings`——`model`、`CLAUDE_CODE_SUBAGENT_MODEL` 这两项一律不撤（不管撤不撤得了），其余照常卸载。CC Switch 已经没有了（数据库不在）就照常撤回；配置目录不是默认的 `~/.claude` 时不比对卡片（第 2 步也不记卡片）。
- **双击菜单传不了参数**：卸载在上面两种情况（卡片、能力声明撤不了）停下时，会打印一行可以直接照抄的命令。这次已经带的参数（含 `--dry-run`）原样保留，再加上要加的那个；设了 `CLAUDE_CONFIG_DIR` 的话，会先写出「先把 `CLAUDE_CONFIG_DIR` 设成 <解析后的绝对路径>，再跑 …」。CC Switch 正在运行时，提示退出它之后用同样的参数再卸载一次，同样给出这行命令。

平台注意：

- Windows 双击 `.ps1` 默认是用记事本打开，所以双击用 `setup.cmd`；`setup.ps1` 可以右键「使用 PowerShell 运行」。PowerShell 提示禁止运行脚本时：`powershell -ExecutionPolicy Bypass -File .\setup.ps1`
- macOS 双击 `setup.command` 提示「无法打开」：右键 → 打开；仓库里已带执行权限，提示没有权限时（比如解压工具丢了权限）再在终端里 `chmod +x setup.command setup.sh`

### 手动安装

1. **取文件**：把本仓库克隆（或下载解压）到 `~/.claude/plugins/model-router/`：

   ```bash
   git clone https://github.com/Aack000/claude-model-router.git "$HOME/.claude/plugins/model-router"
   ```

2. **命令与子代理**，二选一：

   - 把 `commands/*.md` 拷进 `~/.claude/commands/`、`agents/*.md` 拷进 `~/.claude/agents/`。**拷完要把 `commands/route.md`、`commands/plan-fable.md` 里的 `${CLAUDE_PLUGIN_ROOT}` 全部换成 `~/.claude/plugins/model-router`**（只有安装器和原生插件安装会替换它；不换的话 Bash 把它展开成空串，`node ${CLAUDE_PLUGIN_ROOT}/route-check.js` 会变成 `node /route-check.js`，找不到文件）。嫌麻烦就直接用上面的一键安装，它替你换；
   - 或在 `settings.json` 里把插件目录挂载为 marketplace：

     ```json
     "extraKnownMarketplaces": {
       "model-router": {
         "source": {
           "source": "directory",
           "path": "C:\\Users\\<你的用户名>\\.claude\\plugins\\model-router"
         }
       }
     }
     ```

     macOS / Linux 的 `path` 写 `/Users/<你的用户名>/.claude/plugins/model-router` 或 `/home/<你的用户名>/.claude/plugins/model-router`。

   两种方式都要**重启 Claude Code** 才会加载新的 agent。

   手动安装时，放行规则也要自己加：`/permissions` 里至少加 `Bash(node ~/.claude/plugins/model-router/route-clean.js *)`，否则 auto 模式下收尾删文件会被拦；其余几条见上面「一键安装」的表，`route-check`、`usage-audit` 要同时加不带参数和带 ` *` 的两种写法。

3. **settings.json**：按 [GUIDE #安装](docs/GUIDE.md) 配置模型别名与 effort（`modelSettings`、`autoCompactWindow`、删掉 `CLAUDE_CODE_SUBAGENT_MODEL` 等）。手动安装没有安装清单，`configure.js` 用不了（它会提示先装），所以这一步要自己改；想让安装器问着帮你配，用上面的「一键安装」。

> `route-check.js` / `doctor.js` / `usage-audit.js` 按插件目录路径调用。手动拷命令文件时，把 `commands/route.md`、`commands/plan-fable.md` 里的 `${CLAUDE_PLUGIN_ROOT}` 换成你实际的插件目录（默认是 `~/.claude/plugins/model-router`，照上面第 2 步）；若你把仓库克隆到了别的位置，换成那个位置。想省掉这一步，用一键安装：它按配置目录自动换。

装完先跑 `node doctor.js` 做一次配置体检（命令文件里还留着没替换的 `${CLAUDE_PLUGIN_ROOT}` 时它会报 ⚠）；再跑一轮 `/route` 后用 `node route-check.js` 核实各子代理实际跑的模型。

### 实验性：原生插件市场

仓库里带了 `.claude-plugin/marketplace.json`（三个条目：`model-router` / `model-router-usage` / `model-router-switch`），可以走 Claude Code 原生的插件市场：

```bash
claude plugin marketplace add <仓库目录>
claude plugin install model-router@model-router-marketplace
```

- 命令前缀是 `/model-router:route`（不是 `/route`）
- 放行规则要自己加（原生装不会改 settings.json）
- `${CLAUDE_PLUGIN_ROOT}` 由 CLI 自己替换成插件源目录
- 这条路只做过实测走通，**仍标实验性**；日常还是用安装器（分组件、自动配放行规则和模型设置）。实测记录见 [TECH-LIBRARY §4](docs/TECH-LIBRARY.md)

## 用法

```text
/route 给用户列表加分页       # 一站式：规划 → 实现 → 审查 → 汇报
/plan-fable 重构数据层           # 只出规划，不实现
```

审查单独触发：说「用 code-reviewer 审一下 xxx」。

**小任务默认走轻流程**：改动 ≤ 2 个文件、不改接口时，不启动规划子代理，主会话写一份 ≤ 10 行的计划记录后直接派一个 sonnet 包，审查照常；要先查证、有多种做法、或你说要规划时走完整流程。

**看用量**（v2.0.0 起在 usage 组件里，旧路径仍可用）：

```bash
node ~/.claude/plugins/model-router/usage-audit.js                 # 最近 7 天日报（$ 大致对比）
node ~/.claude/plugins/model-router/usage-audit.js --rounds        # 按 /route 轮看每轮 $ / 耗时 / 阶段占比
node ~/.claude/plugins/model-router/usage-audit.js --check         # env 钉的模型有没有单价
node ~/.claude/plugins/model-router/usage/usage-balance.js --amount 3        # 记一笔实付（手填）
node ~/.claude/plugins/model-router/usage/usage-balance.js --provider deepseek --rate 7.2   # 真余额，key 走 DEEPSEEK_API_KEY
```

`usage-balance.js` 只打印一行金额 / 读数，失败只打状态码，不打印 URL 和 key；记满两次读数后，`usage-audit` 会自动把「实付」和隐形占比校准出来（`--plan` 表示包月套餐）。new-api 系的中转站用 `--provider <名>` 读它的累计用量接口，`unit` 写在供应商文件里，也可以跑的时候加 `--unit`——它表示「多少读数算 1 美元」，**每家的额度符号都不一样**（有的按分、有的按自家额度、有的还带汇率），所以不写死也不猜；不给 `unit` 时只记读数、不折算 $。中转站的供应商文件含你自己的地址，仓库里不放，自己在 `switch/providers/` 下建（仓库只带 DeepSeek 那一份）。

校准的要点（细节和方法限制见 [GUIDE「校准」](docs/GUIDE.md)）：

- **实付只算两次读数之间那一段**，可见 $ 也只取这一段里的调用，两者比出隐形占比；整份报表只用这一个占比。读数只在同一家、同一种记法（余额 / 用量读数）之间相减；中途遇到额度重置、余额充值、换币种，就从那个断点之后起算，口径行会写明。
- 读数段至少一半落在统计区间里才用；读数段不到 1 小时、或只占本区间可见 $ 的不到 20% 时，口径行标「样本短，仅供参考」。给了 `--project` 时，隐形占比仍按整个账号在读数段内的调用算，再套到本项目。
- `--rounds` 的「$实付分摊」= 该轮可见 $ ÷ (1 − 隐形占比)，分母含 `/route` 之外的调用。`--check` 查价前先去掉 `claude-` 前缀和 `[1M]` 之类的后缀，所以保留 `[1M]` 的配置不会误报。
- 旧基线（v1.x 存的）自动回退读取；含 EIU 的旧基线只用 $ 项比较，主会话占比口径不同、标「不可比」。EIU 已在 v2.0.0 废弃。

## 换供应商（以 DeepSeek 为例）

`/route` 按别名派活（规划 fable、审查 opus、实现 sonnet），别名映射到哪个模型由 `ANTHROPIC_DEFAULT_*_MODEL` 决定。所以换供应商只是换一套映射，流程不用改。**目前只实测适配了 DeepSeek**，其他供应商还没适配（`plugins/switch/providers/` 里只有 DeepSeek 一份配置）；用 CC Switch 时，`/route` 按当前卡片的模型映射走。两种用法：

> **换模型 / 换供应商后第一轮会明显变贵**：prompt cache 按模型记，映射一变整段缓存就失效、要全量重写（实测两次分别多花约 $0.3、$0.9），第二轮起回落到正常。看到某一轮 `$/h` 突然翻倍，先确认它是不是切换后的第一轮。

**模型不可用时自动降级**（`fallbackModel`）：在供应商文件里加一行，主会话和子代理都会生效——原模型 503 / overloaded / 不存在时，CLI 按顺序换下一个：

```json
{ "name": "my-relay", "keyEnv": ["MY_KEY"], "fallbackModel": ["opus", "sonnet"], "env": { } }
```

**写别名（推荐）**：`opus` / `sonnet` 这些会在当前会话里按 `ANTHROPIC_DEFAULT_*_MODEL` 解析成实际模型（实测：`sonnet` 指向不存在的模型时，子代理落到 opus 映射的 `qwen3.8-max`）。这样换中转站、换用户都不用改这一行；写具体模型名只在网关认识它时才有意义。

手工启动 `claude` 时也可以 `--fallback-model opus,sonnet`。**必须写成数组**：写成字符串时 CLI 会忽略整份 settings（连 env 里的别名映射一起丢，模型退回内置目录名）。

**① CC Switch 卡片（全局切换）**：卡片的 env 写 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和四个别名的映射，切卡后所有新会话都用它。内容可以照抄 [`plugins/switch/providers/deepseek.json`](plugins/switch/providers/deepseek.json) 的 `env`（再加上 key）。

卡片里常漏的是能力声明（`ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES`，见下面实测第 3 条）。可以让安装器补：菜单选 4，或者

```bash
node ~/.claude/plugins/model-router/switch/ccswitch-caps.js --dry-run   # 先看会补什么
node ~/.claude/plugins/model-router/switch/ccswitch-caps.js             # 列出计划，确认后才写
node ~/.claude/plugins/model-router/switch/ccswitch-caps.js --undo      # 撤回补过的
```

它按卡片 `ANTHROPIC_BASE_URL` 的主机名对上 `providers/*.json` 里的供应商，只给映射到第三方模型的别名补**缺的**能力声明和 `_NAME`，已有的键不改；对不上的卡片只列出来、不动。当前卡片以本机 `~/.claude/settings.json` 为准（CC Switch 的编辑框读写的就是它）：本机缺的才补，数据库里那份副本跟着补；本机已有的键不动。撤回只删值还是当初补的那几行，值被你改过的报一次就不再管；数据库搬了位置用 `--undo --db <新路径>`。写之前要求先退出 CC Switch，先备份数据库和 settings.json，写完核对其余内容一字不差；输出里不出现 key 和完整地址。要 Node 22.13+（读 CC Switch 的 SQLite 数据库），版本不够会列出要手动加的几行。

**② `provider.js`（只换这一个会话）**：CC Switch 当前卡片不动，可以一边开 Claude 会话、一边开 DeepSeek 会话。在项目目录里：

```bash
node ~/.claude/plugins/model-router/switch/provider.js deepseek                         # key 从环境变量 DEEPSEEK_API_KEY 读
node ~/.claude/plugins/model-router/switch/provider.js deepseek --key-env MY_KEY_VAR   # key 存在别的变量名里
node ~/.claude/plugins/model-router/switch/provider.js deepseek --dry-run              # 只看会怎么启动（key 打码）
node ~/.claude/plugins/model-router/switch/provider.js --list                          # 有哪些供应商配置
```

其余参数原样交给 `claude`（如 `--resume`）。它把 `providers/<名字>.json` 的 env 加上 key 写进临时文件，用 `claude --settings` 启动；这个文件的优先级高于用户级 settings.json，只对这个进程生效，会话结束就删。Windows 上刚设的环境变量要新开窗口才进进程，所以它还会去注册表读。加别的供应商就照 `deepseek.json` 再写一份。

**别直接改 `providers/deepseek.json`**：它是安装器管理的文件，升级时会被备份后覆盖。要换映射就复制一份、另起名字再改，`--list` 会列出来。自建的文件放在 `<插件目录>/switch/providers/`（v2 的 `provider.js` 和 `ccswitch-caps.js` 只读这里；安装器只装 `deepseek.json`，不会碰你自建的文件）。例如想让规划和审查跑 `deepseek-v4-pro`：

```bash
cd ~/.claude/plugins/model-router/switch/providers
cp deepseek.json deepseek-pro.json    # 在 deepseek-pro.json 里把 FABLE、OPUS 两行换成 deepseek-v4-pro[1M]
node ~/.claude/plugins/model-router/switch/provider.js deepseek-pro
```

v1.x 时在旧的 `~/.claude/plugins/model-router/providers/` 里自建的 json，升级后要自己挪到 `switch/providers/`（安装器发现旧目录里有清单外的 json 时会提示，但不动它们）。

几处保护：

- `--key-env` 只认环境变量的名字（`--key-env 名字`、`--key-env=名字` 都行），填成 key 本身会被拒绝（不回显、不去查）
- 实际生效的主模型（用户级配置，或当前目录的项目配置 `.claude/settings.json`、`settings.local.json`）若是完整模型 ID（如 `claude-opus-5-5`），这个会话会自动改成 OPUS 别名映射的模型并打印一行说明，不然 DeepSeek 会把它按最贵的模型计费；透传了 `--model` 就不动
- Windows 上经 cmd 启动，参数里含 `%` 或换行没法安全转义，会被拒绝（exit 2）
- 含 key 的临时设置文件在会话结束、按 Ctrl+Break、直接点 × 关终端时都会删掉；异常退出留下的，下次启动时清掉

**换了供应商、别名漏映射：体检会报。** `/route` 各阶段只写别名（规划 `fable`、审查 `opus`、实现 `sonnet`），不写具体模型，跟着 CC Switch 当前卡片的映射走。当前供应商不是 Claude 系、而 `fable` / `opus` / `sonnet` 里有没映射的，用这个别名的子代理会去要 Claude 的模型，这家没有，调用直接失败，事前没有任何提示。所以 `doctor.js`（快速、完整模式都查，挂在 SessionStart 钩子上的 `--quick --quiet` 也会）和 `configure.js` 会替你核一遍：

- **怎么判断「不是 Claude 系」**：本机 `settings.json` 的 env 里，`ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` 或 `ANTHROPIC_MODEL` 有一个值（去掉 `[1m]` 之类的后缀）不以 `claude-` 开头。`ANTHROPIC_MODEL` 写的是别名（`opus`、`sonnet[1m]` 等）不算；全是 `claude-*`（中转 Claude 的网关）、或一个都没钉的，也不查
- **查什么**：`fable` / `opus` / `sonnet` 没映射（没写，或写成空串）时，`doctor.js` 报 ❌、`configure.js` 打一行 ⚠，写明是哪个别名、管哪个阶段、后果；`haiku`（CLI 的后台小任务用它）没映射时，`doctor.js` 报 ⚠，`configure.js` 不打 ⚠。四个都映射了，`doctor.js` 打一行 ✅
- **修法**：在 CC Switch 的卡片里把这个别名映射到这家的模型（没有 CC Switch 就在 `settings.json` 的 env 里写 `ANTHROPIC_DEFAULT_<别名>_MODEL`）。`configure.js` 只报告、不替你写：模型 ID 跟供应商走，猜错的代价是调用全失败
- **Bedrock / Bedrock Mantle / Vertex / Foundry 不查**：`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_MANTLE`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY` 任一为真（`1`、`true`、`yes`、`on`，不分大小写；`settings.json` 的 env 里写了就以它为准，没写才看 shell 的环境变量）时整段跳过，因为 CLI 在这些平台上自己负责别名映射。OpenRouter 这类网关的 `anthropic/claude-…` 不在此列，别名没映射照样会失败，照常报
- 输出里只有别名、键名和判定依据的模型 ID，不打印 key、地址。Bedrock 的模型 ID 若是 inference profile ARN，打印时 12 位账号号码打码成 `************`，比较和查表仍用原值

DeepSeek 10-26 实测：

- 两个模型 `deepseek-flash`、`deepseek-v4-pro`，都是 1M 上下文。`providers/deepseek.json` 按最省钱的方式把四个别名全映射到 flash；想让规划和审查更强，按上面的办法复制一份，把 FABLE、OPUS 两行换成 `deepseek-v4-pro[1M]`
- 规划、审查、实现三个子代理和主会话都按映射跑在 flash 上；auto 模式的权限分类器跑在 sonnet 别名映射的模型上，在 DeepSeek 上能正常工作
- CLI 认不出第三方模型的能力，要用 `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` 声明，否则可能不发 effort / thinking。DeepSeek 接口接受 `effort,xhigh_effort,max_effort,thinking,adaptive_thinking` 这几种写法
- 几个别名映射到同一个模型时，CLI 分不清子代理是哪个角色，各角色的 effort 会套成同一档（sonnet 配 high，实际跑 xhigh）。`route-check` 遇到这种情况只给说明、不报错，`doctor` 会提示
- `route-check` 优先读会话的环境变量，所以两种用法下都按当前会话实际生效的映射核对；`usage-audit` 按 DeepSeek 公开价计费，区分高峰和非高峰（非高峰半价）

## 依赖要求

- Claude Code CLI（本方案在 2.1.276 实测）
- Node.js 22.13+：配置模型设置和 `ccswitch-caps.js` 要用 `node:sqlite` 读 CC Switch 的卡片。18+ 也能装，安装入口和 `doctor.js` / `route-check.js` / `usage-audit.js` 都能跑，只是读不了卡片（会提示，不影响安装）
- Windows / macOS / Linux 都能装（只在 Windows 上实测过整套流程）
- 模型别名 `fable` / `sonnet` / `opus` 可用（由 `settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 决定，具体见 GUIDE）

## Roadmap

**当前定位：只服务 Claude Code。** 各家模型用各家的载体（Codex、Kimi CLI、dsh…）是大趋势，把整套流程移植到别的 CLI 意味着适配 ×N 的维护成本，而「分阶段用不同模型」这个核心卖点在上游 bug 修复前根本无法在别家复现（见下），所以不铺多 CLI 的路。

迭代方向按可行性排序：

1. **同供应商多模型分工（已可用）**：四个模型别名经 `ANTHROPIC_DEFAULT_*_MODEL` / CC Switch 卡片 / `provider.js` 映射，换成哪家供应商、映射到哪几个模型，流程不用改；核对、体检、计费工具已能认第三方模型（DeepSeek 10-26 实测，见上面「换供应商」）
2. **跨供应商分流（可行度：中，待实测）**：机制上有两条路——网关按模型名分流，或经 ACP（acpx）做进程级编排。已知各家兼容端点的坑（拒收中间 `role:system`、`tool_choice`、WebSearch 仅官方等）已调研归档在 [TECH-LIBRARY](docs/TECH-LIBRARY.md)。第一步是加一个**异家族审查员**并行试点（只读代码只写报告，模型不行最坏是报告没用），验证非 Claude 模型能否守住收工条款和报告格式
3. **多 CLI 版本（可行度：低，观望）**：被上游硬阻塞——Codex 子代理只能沿用主会话同一供应商（openai/codex#47752）、Windows 上子代理配置不生效（openai/codex#19399）；dsh 处于开发者预览、声明有破坏性变更。这些修复前不投入；届时也在本仓库内演进，不拆多仓库

## 文档

- [CHANGELOG.md](CHANGELOG.md) — 版本更新记录
- [docs/GUIDE.md](docs/GUIDE.md) — 为什么要这样分、实测踩过的坑、安装细节、验证、升级与回滚、成本分析
- [docs/TECH-LIBRARY.md](docs/TECH-LIBRARY.md) — 调研过但暂缓的方向（跨供应商通用化、Codex 迁移）

## License

[MIT](LICENSE)

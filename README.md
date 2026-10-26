# claude-model-router

Claude Code 插件 **model-router**：按任务阶段分配模型（规划 / 实现 / 查错），降低 token 开销同时控制 bug 率。

日常只需要一条命令：**`/route <任务>`** —— 它把三个阶段串起来自动跑完：

| 阶段 | 模型 | 跑在哪 |
|---|---|---|
| **规划** | fable | `planner-fable` 子代理 |
| **实现 / 修复 / 文档** | sonnet | general-purpose 子代理 |
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
- **用量可度量**：`usage-audit.js` 提供统一口径的成本统计（EIU、缓存命中率、子代理规模分档、缓存 TTL 模拟），所有结论可复现
- **配置可体检**：`doctor.js` 一条命令核查网关连通、别名钉版、孤儿键，可挂 SessionStart 钩子静默自检
- **不存任何 key**：供应商与凭据由 Claude Code / CC Switch 管理；只有 `provider.js` 在启动时从环境变量读 key、交给那一个会话，会话结束就删临时文件
- **能换供应商**：别名映射到 DeepSeek 等第三方模型时，流程照样按阶段派活，`route-check` / `doctor` / `usage-audit` 都认第三方模型（DeepSeek 10-26 实测）

## 实测数据

单机 22 天口径（`usage-audit.js` 可复现，统计口径详见 [GUIDE](docs/GUIDE.md)）：

| 期间 | 平均 EIU/h | 平均 $/h |
|---|---|---|
| 纯 Opus（10 天） | 5.87 | $32.9 |
| route 模式（7 天） | 5.03 | **$25.3（−23%）** |

| 发现 | 数字 |
|---|---|
| 成本大头是上下文长度，不是输出 | 缓存读写合计 **92%**，输出仅 7.6% |
| 规划走子代理 vs 主会话切模型 | 约 **1/8** token（切模型令缓存全量归零） |
| 主会话缓存 TTL 5min → 1h | 回放 16 天：日均 **−$18.6** |
| 子代理规模超 200 次调用 | EIU/调用翻 **2.6 倍**（平方级膨胀，流程已加收工条款） |

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
usage-audit.js                 用量统计（价格口径内置；基线用 --baseline 自行生成，不入库）
route-clean.js              清理 /route 过程文件
provider.js                    只给一个会话换供应商（不动 CC Switch、不改 settings.json）
providers/*.json               供应商配置（别名映射、能力声明、key 从哪个环境变量读）
setup.cmd / .ps1 / .sh / .command   安装入口：双击或命令行，出菜单（Windows / PowerShell / Linux·macOS / macOS 访达）
setup.js                       菜单本体（上面四个都调它）
install.js / uninstall.js      安装 / 卸载（入口最终跑这两个，也能直接调）
docs/GUIDE.md                  详细文档（安装、实测结论、成本分析、验证、升级）
docs/TECH-LIBRARY.md           技术调研库（跨供应商 / Codex 迁移等暂缓方向）
```

## 安装

完整说明见 [docs/GUIDE.md](docs/GUIDE.md)。

### 一键安装（推荐）

先装 [Node.js](https://nodejs.org) 18+，再把仓库克隆或下载解压到任意位置：

```bash
git clone https://github.com/Aack000/claude-model-router.git
```

| 系统 | 双击 | 命令行 |
|---|---|---|
| Windows | `setup.cmd` | `setup.cmd`（cmd）、`.\setup.ps1`（PowerShell） |
| macOS | `setup.command`（访达里双击） | `./setup.sh` |
| Linux | — | `./setup.sh` |

不带参数出菜单：1 安装 / 升级、2 卸载、3 试运行（只列会改什么，不动文件）。选了安装会逐条列出放行规则让你勾，直接回车按默认。

带参数就直接执行、不出菜单：

```bash
./setup.sh install --rules=clean,check   # 指定放行规则：名字或编号，逗号分隔；all = 全要，none = 都不要
./setup.sh install --dry-run             # 只看会改什么
./setup.sh uninstall                     # 卸载，同样支持 --dry-run
```

Windows 把 `./setup.sh` 换成 `setup.cmd` 或 `.\setup.ps1`。也可以直接跑 `node install.js …`、`node uninstall.js …`，参数一样。

安装做三件事，可以重复跑（重复跑就是升级，想改放行规则的选择也是再跑一次）：

1. 插件文件放到 `~/.claude/plugins/model-router/`（`route.md` 按这个路径调用脚本）
2. `commands/*.md` → `~/.claude/commands/`，`agents/*.md` → `~/.claude/agents/`；会覆盖的旧文件先备份成 `*.bak-<时间>`
3. 用户级 `~/.claude/settings.json` 的 `permissions.allow` 按你的选择加放行规则：

| 名字 | 默认 | 放行的命令 | 不放行会怎样 |
|---|---|---|---|
| `clean` | ✓ | `node ~/.claude/plugins/model-router/route-clean.js …` | `/route` 收尾删过程文件被拦，流程卡住等人 |
| `check` | ✓ | `node ~/.claude/plugins/model-router/route-check.js …` | `/route` 每个子代理返回后都要核模型，被拦就停 |
| `audit` |  | `node ~/.claude/plugins/model-router/usage-audit.js …` | 让 Claude 查用量时偶尔要你手动批 |
| `doctor` |  | `node ~/.claude/plugins/model-router/doctor.js`（只放不带参数的） | 同上；`--gateway` 要读凭据，始终不放行 |

为什么要放行规则：auto 模式的权限分类器会误拦这几个脚本（作者实测 route-check 300 多次里被拦 5 次），命中放行规则的命令不送分类器。每条规则只放插件自带的一个脚本，边界由脚本自己守：`route-clean.js` 只删 `.route-plan.md`、`.route-plan-*.md`、`.route-handoff-*.md` 三种文件名，并跳过被 git 跟踪的文件；其余三个只读。改 `settings.json` 前先备份（同一秒连跑也不会互相覆盖），只动 `permissions.allow`，写完核对 env 和其余配置一字不差。再跑一次少选几条，上次安装加的会被去掉；你自己原先加过的同名规则不动。这些规则 Claude 自己加不了（auto 模式下给自己放权会被拦），所以要你亲手跑。

装完**重启 Claude Code**，再按下面「手动安装」第 3 步配 `settings.json`（模型别名和 effort 因人而异，脚本不替你改）。

卸载：再跑一次入口选「卸载」，或 `node ~/.claude/plugins/model-router/uninstall.js`（同样支持 `--dry-run`）。它只撤回安装时放进去、之后没改过的文件，以及安装器加的规则；备份不动，列出路径。

平台注意：

- Windows 双击 `.ps1` 默认是用记事本打开，所以双击用 `setup.cmd`；`setup.ps1` 可以右键「使用 PowerShell 运行」。PowerShell 提示禁止运行脚本时：`powershell -ExecutionPolicy Bypass -File .\setup.ps1`
- macOS 双击 `setup.command` 提示「无法打开」：右键 → 打开；仓库里已带执行权限，提示没有权限时（比如解压工具丢了权限）再在终端里 `chmod +x setup.command setup.sh`
- 设置了 `CLAUDE_CONFIG_DIR` 的暂不支持（命令和规则写死了 `~/.claude`），安装器会直接拒绝

### 手动安装

1. **取文件**：把本仓库克隆（或下载解压）到 `~/.claude/plugins/model-router/`：

   ```bash
   git clone https://github.com/Aack000/claude-model-router.git "$HOME/.claude/plugins/model-router"
   ```

2. **命令与子代理**，二选一：

   - 把 `commands/*.md` 拷进 `~/.claude/commands/`、`agents/*.md` 拷进 `~/.claude/agents/`；
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

3. **settings.json**：按 [GUIDE #安装](docs/GUIDE.md) 配置模型别名与 effort（`modelSettings`、`autoCompactWindow`、删掉 `CLAUDE_CODE_SUBAGENT_MODEL` 等）。这一步插件管不了，必须手动改。

> `route-check.js` / `doctor.js` / `usage-audit.js` 按插件目录路径调用。若你把仓库克隆到了别的位置，请同步修改 `commands/route.md` 里的调用路径，或保持默认路径不变。

装完先跑 `node doctor.js` 做一次配置体检；再跑一轮 `/route` 后用 `node route-check.js` 核实各子代理实际跑的模型。

## 用法

```text
/route 给用户列表加分页       # 一站式：规划 → 实现 → 审查 → 汇报
/plan-fable 重构数据层           # 只出规划，不实现
```

审查单独触发：说「用 code-reviewer 审一下 xxx」。

## 换供应商（以 DeepSeek 为例）

`/route` 按别名派活（规划 fable、审查 opus、实现 sonnet），别名映射到哪个模型由 `ANTHROPIC_DEFAULT_*_MODEL` 决定。所以换供应商只是换一套映射，流程不用改。两种用法：

**① CC Switch 卡片（全局切换）**：卡片的 env 写 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和四个别名的映射，切卡后所有新会话都用它。内容可以照抄 [`providers/deepseek.json`](providers/deepseek.json) 的 `env`（再加上 key）。

**② `provider.js`（只换这一个会话）**：CC Switch 当前卡片不动，可以一边开 Claude 会话、一边开 DeepSeek 会话。在项目目录里：

```bash
node ~/.claude/plugins/model-router/provider.js deepseek                         # key 从环境变量 DEEPSEEK_API_KEY 读
node ~/.claude/plugins/model-router/provider.js deepseek --key-env MY_KEY_VAR   # key 存在别的变量名里
node ~/.claude/plugins/model-router/provider.js deepseek --dry-run              # 只看会怎么启动（key 打码）
node ~/.claude/plugins/model-router/provider.js --list                          # 有哪些供应商配置
```

其余参数原样交给 `claude`（如 `--resume`）。它把 `providers/<名字>.json` 的 env 加上 key 写进临时文件，用 `claude --settings` 启动；这个文件的优先级高于用户级 settings.json，只对这个进程生效，会话结束就删。Windows 上刚设的环境变量要新开窗口才进进程，所以它还会去注册表读。加别的供应商就照 `deepseek.json` 再写一份。

DeepSeek 10-26 实测：

- 两个模型 `deepseek-flash`、`deepseek-v4-pro`，都是 1M 上下文。`providers/deepseek.json` 按最省钱的方式把四个别名全映射到 flash；想让规划和审查更强，把 FABLE、OPUS 两行换成 `deepseek-v4-pro[1M]`
- 规划、审查、实现三个子代理和主会话都按映射跑在 flash 上；auto 模式的权限分类器跑在 sonnet 别名映射的模型上，在 DeepSeek 上能正常工作
- CLI 认不出第三方模型的能力，要用 `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` 声明，否则可能不发 effort / thinking。DeepSeek 接口接受 `effort,xhigh_effort,max_effort,thinking,adaptive_thinking` 这几种写法
- 几个别名映射到同一个模型时，CLI 分不清子代理是哪个角色，各角色的 effort 会套成同一档（sonnet 配 high，实际跑 xhigh）。`route-check` 遇到这种情况只给说明、不报错，`doctor` 会提示
- `route-check` 优先读会话的环境变量，所以两种用法下都按当前会话实际生效的映射核对；`usage-audit` 按 DeepSeek 公开价计费，区分高峰和非高峰（非高峰半价）

## 依赖要求

- Claude Code CLI（本方案在 2.1.276 实测）
- Node.js 18+（安装入口和 `doctor.js` / `route-check.js` / `usage-audit.js` 都要）
- Windows / macOS / Linux 都能装（只在 Windows 上实测过整套流程）
- 模型别名 `fable` / `sonnet` / `opus` 可用（由 `settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 决定，具体见 GUIDE）

## Roadmap

**当前定位：只服务 Claude Code。** 各家模型用各家的载体（Codex、Kimi CLI、dsh…）是大趋势，把整套流程移植到别的 CLI 意味着适配 ×N 的维护成本，而「分阶段用不同模型」这个核心卖点在上游 bug 修复前根本无法在别家复现（见下），所以不铺多 CLI 的路。

迭代方向按可行性排序：

1. **同供应商多模型分工（已可用）**：四个模型别名经 `ANTHROPIC_DEFAULT_*_MODEL` / CC Switch 卡片 / `provider.js` 映射，换成哪家供应商、映射到哪几个模型，流程不用改；核对、体检、计费工具已能认第三方模型（DeepSeek 10-26 实测，见上面「换供应商」）
2. **跨供应商分流（可行度：中，待实测）**：机制上有两条路——网关按模型名分流，或经 ACP（acpx）做进程级编排。已知各家兼容端点的坑（拒收中间 `role:system`、`tool_choice`、WebSearch 仅官方等）已调研归档在 [TECH-LIBRARY](docs/TECH-LIBRARY.md)。第一步是加一个**异家族审查员**并行试点（只读代码只写报告，模型不行最坏是报告没用），验证非 Claude 模型能否守住收工条款和报告格式
3. **多 CLI 版本（可行度：低，观望）**：被上游硬阻塞——Codex 子代理只能沿用主会话同一供应商（openai/codex#47752）、Windows 上子代理配置不生效（openai/codex#19399）；dsh 处于开发者预览、声明有破坏性变更。这些修复前不投入；届时也在本仓库内演进，不拆多仓库

## 文档

- [docs/GUIDE.md](docs/GUIDE.md) — 为什么要这样分、实测踩过的坑、安装细节、验证、升级与回滚、成本分析
- [docs/TECH-LIBRARY.md](docs/TECH-LIBRARY.md) — 调研过但暂缓的方向（跨供应商通用化、Codex 迁移）

## License

[MIT](LICENSE)

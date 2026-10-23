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
docs/GUIDE.md                  详细文档（安装、实测结论、成本分析、验证、升级）
docs/TECH-LIBRARY.md           技术调研库（跨供应商 / Codex 迁移等暂缓方向）
```

## 安装

完整说明见 [docs/GUIDE.md](docs/GUIDE.md)。三步：

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

   两种方式都要**重启 Claude Code** 才会加载新的 agent。

3. **settings.json**：按 [GUIDE #安装](docs/GUIDE.md) 配置模型别名与 effort（`modelSettings`、`autoCompactWindow`、删掉 `CLAUDE_CODE_SUBAGENT_MODEL` 等）。这一步插件管不了，必须手动改。

> `route-check.js` / `doctor.js` / `usage-audit.js` 按插件目录路径调用。若你把仓库克隆到了别的位置，请同步修改 `commands/route.md` 里的调用路径，或保持默认路径不变。

装完先跑 `node doctor.js` 做一次配置体检；再跑一轮 `/route` 后用 `node route-check.js` 核实各子代理实际跑的模型。

## 用法

```text
/route 给用户列表加分页       # 一站式：规划 → 实现 → 审查 → 汇报
/plan-fable 重构数据层           # 只出规划，不实现
```

审查单独触发：说「用 code-reviewer 审一下 xxx」。

## 依赖要求

- Claude Code CLI（本方案在 2.1.276 实测）
- Node.js（跑 `doctor.js` / `route-check.js` / `usage-audit.js`）
- 模型别名 `fable` / `sonnet` / `opus` 可用（由 `settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 决定，具体见 GUIDE）

## 文档

- [docs/GUIDE.md](docs/GUIDE.md) — 为什么要这样分、实测踩过的坑、安装细节、验证、升级与回滚、成本分析
- [docs/TECH-LIBRARY.md](docs/TECH-LIBRARY.md) — 调研过但暂缓的方向（跨供应商通用化、Codex 迁移）

## License

[MIT](LICENSE)

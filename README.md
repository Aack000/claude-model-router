# cc-autoworkflow

Claude Code 插件：**按任务阶段分配模型**（规划 / 实现 / 查错），降低 token 开销同时控制 bug 率。

日常只需要一条命令：`/dev <任务>` —— 它把三个阶段串起来自动跑完：

| 阶段 | 模型 | 跑在哪 |
|---|---|---|
| **规划** | fable | `planner-fable` 子代理 |
| **实现 / 修复 / 文档** | sonnet | general-purpose 子代理 |
| **查错 / 复审** | opus | `code-reviewer` 子代理 |

主会话只编排、把决定交给你、核实结果，不写生产代码。规划和查错都跑在**子代理**里：它们读的文件留在子上下文，只有结论回主会话——不污染主上下文，也不破坏主会话的 prompt cache。

设计目标是同时解决两个互相冲突的痛点：**全程 Opus 太贵**，但**全程 Sonnet bug 太多**。

## 仓库结构

```
.claude-plugin/plugin.json   插件清单
commands/dev.md              /dev 一站式流程（权威说明）
commands/plan-fable.md       /plan-fable 单独规划
agents/planner-fable.md      规划子代理（frontmatter 钉模型）
agents/code-reviewer.md      审查子代理
dev-check.js                 每轮结束后核实子代理实际跑的模型
doctor.js                    配置体检（网关、别名、孤儿键等）
usage-audit.js               用量统计（依赖 usage-baseline.json 的价格基线）
dev-clean.js                 清理流程残留
docs/GUIDE.md                详细文档（安装、实测结论、成本分析、验证）
docs/TECH-LIBRARY.md         技术调研库（跨供应商 / Codex 迁移方向）
```

## 安装

完整说明见 [docs/GUIDE.md](docs/GUIDE.md#安装)。三步：

1. **取文件**：把本仓库克隆（或下载）到 `~/.claude/plugins/model-router/`：

   ```
   git clone https://github.com/Aack000/cc-autoworkflow.git ~/.claude/plugins/model-router
   ```

2. **命令与子代理**：二选一——

   - 把 `commands/*.md` 拷进 `~/.claude/commands/`、`agents/*.md` 拷进 `~/.claude/agents/`；
   - 或在 `settings.json` 里挂载插件：

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

   新加的 agent 要**重启 Claude Code** 才加载。

3. **settings.json**：按 [GUIDE #1](docs/GUIDE.md) 配置模型别名与 effort（`modelSettings`、`autoCompactWindow` 等，插件管不了这步，必须手动改）。

装完用 `node doctor.js` 做一次配置体检，再跑一轮 `/dev` 后用 `node dev-check.js` 核实各子代理实际跑的模型。

## 用法

```
/dev 给用户列表加分页          # 一站式：规划 → 实现 → 审查 → 汇报
/plan-fable 重构数据层         # 只出规划，不实现
```

审查单独触发：说「用 code-reviewer 审一下 xxx」。

## 文档

- [docs/GUIDE.md](docs/GUIDE.md) — 为什么要这样分、实测结论、安装细节、验证、成本分析
- [docs/TECH-LIBRARY.md](docs/TECH-LIBRARY.md) — 调研过但暂缓的方向（跨供应商、Codex 迁移）

## License

[MIT](LICENSE)

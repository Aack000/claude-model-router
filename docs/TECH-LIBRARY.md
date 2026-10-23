# 技术库

调研过、但**暂时搁置**的方向。每条写清结论、依据和重启时从哪接，别让下次从头查。

---

## 1. 跨供应商 / 跨宿主通用化（2026-09-30，搁置）

**状态**：只调研、没写代码。用户暂时只有 Claude 系模型，跨家方案没法实测；先完善 `/route`，有第二家的 key 或 Coding Plan 时再重启。

### 目标（按优先级）

1. **第一级**：规划、实现、审查各用一个不同的模型（可跨家），发挥各自的长处
2. **第二级**：同一家供应商的不同模型分工
3. **附加分**：在 Codex 里也能跑完整流程

用户对项目的取向：**尽量通用、简单、少维护**。

### 结论

| 目标 | 做法 | 我们要写的 |
|---|---|---|
| 第二级（同一家） | **CC Switch 快照就够**：四个别名（含 FABLE）映射到这家的模型 | 零代码；可选让 doctor / usage-audit 认得非 Claude 模型 |
| 第一级（跨家） | **各家自有 harness，经 ACP 统一驱动（acpx）为主**；CCR 兜底 | `/route` 里一种「外部阶段」执行方式 + 一张「阶段 → agent」配置表 |
| Codex 附加分 | acpx 与宿主无关，Codex 里同样能调 | 同一份流程说明出两份宿主适配 |

**为什么第一级不走 CCR 为主**：最初选的是 CCR（所有模型都在 Claude Code 里跑，我们零代码）。但主流几家现在都有自己调过的 harness，模型在自家工具里才发挥得出真实水平；而「每接一家写一个适配」的维护难题，ACP + acpx 已经解决了。CCR 留给「既没自家 harness、又没 Anthropic 兼容端点」的供应商。

### 各家 harness 与接入方式

| 供应商 | 自家 harness | 经 acpx 接入 |
|---|---|---|
| OpenAI | Codex | 内置 `codex` |
| Anthropic | Claude Code | 内置 `claude` |
| Google | Gemini CLI（个人版 2026-06-18 起停服）→ Antigravity CLI | 内置 `gemini` / `antigravity` |
| Moonshot | Kimi CLI | 内置 `kimi` |
| 阿里 | Qwen Code | 内置 `qwen` |
| MiniMax | MiniMax Code | 内置 `mcode` |
| DeepSeek | DeepSeek Harness（dsh，MIT，08-13 发布，**开发者预览、官方声明会有破坏性变更**） | 官方 ACP 包 `@deepseek-ai/dsh-acp`，配成 custom agent |
| 智谱 | ZCode（Apache-2.0，3.0 起自研引擎、针对 GLM 调） | 只有社区桥接（zcode-acp / zcode-open-bridge）；或直接用 headless `zcode -p … --output-format stream-json --resume <id>` |

> ⚠ 我曾凭印象说「GLM、DeepSeek 没有自家 harness，官方教程就是接 Claude Code」，被用户当场更正。**这类判断变化很快，重启时先搜一遍再下结论。**

### acpx 要点

[openclaw/acpx](https://github.com/openclaw/acpx)：无头 ACP 客户端，MIT，**pre-1.0，接口还在变**。

```bash
acpx <agent> -s <会话名> "提示"      # 持久会话，相当于 SendMessage 续聊
acpx <agent> exec "提示"             # 一次性，不存会话
acpx <agent> ... --format json       # NDJSON 事件（思考、工具调用、diff、完成状态）
acpx <agent> ... --format quiet      # 只输出最终回答
```

- 会话存在 `~/.acpx/`，按仓库隔离；进程崩了下次自动 resume
- Windows 上自定义 agent 要写结构化 `argv` 配置（`~/.acpx/config.json`）
- 要求 Node ≥ 22.13（本机 v24.15 ✅）

### 硬约束（已查实）

- **Claude Code 一个进程只有一套 BASE_URL 和凭据**，agent 文件只能指定模型名。所以跨家要么靠网关按模型名分流，要么进程级编排（每个阶段起一个外部进程）
- **CC Switch 3.20.4 不能按档位分到不同供应商**：本地路由（`127.0.0.1:15721`）能转换协议、同一供应商内映射模型、故障转移；跨供应商分流是 open 的功能请求（[#3153](https://github.com/farion1231/cc-switch/issues/3153)、[#3703](https://github.com/farion1231/cc-switch/issues/3703)、[#3855](https://github.com/farion1231/cc-switch/issues/3855)，#2074 已并入 #3153）
- 第三方供应商预设通常不配 FABLE，`planner-fable` 会报找不到模型；**四个别名都要映射**
- 快照 env 里**不能有 `CLAUDE_CODE_SUBAGENT_MODEL`**，它会让所有子代理都用同一个模型
- 非 Claude 模型不认 effort 等参数时用 `CLAUDE_CODE_MODEL_CAPABILITIES` 关掉，如 `"deepseek-*=-effort"`（`;` 分条、`*` 前缀通配、`-` 关闭）
- 已知供应商坑：Qwen / DeepSeek 的 Anthropic 兼容端点拒收对话中间的 `role:system`（CC 2.1.154+ 会发）；deepseek-reasoner 不支持 `tool_choice`；WebSearch 只有 Anthropic 官方接口能用
- **Codex**：`~/.codex/agents/*.toml` 能按代理设 model 和 reasoning_effort，**不能按代理设供应商**（openai/codex#47752、#14039）；第三方必须走 Responses API；**Windows 上子代理专属配置不生效（#19399）**
- `x-claude-code-agent-type` 请求头对自定义代理一律报 `custom`，分不开 planner 和 reviewer

### 外部阶段放进 `/route` 时要解决的

- **Bash 工具单次最多 10 分钟**，实现阶段常 30 分钟以上 → 必须 `run_in_background`，完成时再通知主会话
- 续聊从 `SendMessage` 换成 `acpx -s <会话名>`
- **用量统计**：外部阶段不在 Claude Code 的 transcript 里，usage-audit 看不到。acpx 的 json 事件里有没有 usage **未核实**
- 每个外部阶段多一个 Node 进程，本机内存本来就紧
- 各家 CLI 自己登录，插件**不碰任何 key**（符合使用方的隐私要求）

### 重启时从哪接

1. 确认手上有哪家的 key 或 Coding Plan
2. **先用 `acpx claude` 在现有 Claude 环境里跑通机制**（后台运行、会话续聊、报告落盘）。要先实测它走的 Claude Agent SDK 能不能读到现在的中转配置
3. 挑一个风险最低的阶段接第一家：**先加一个异家族审查员**，和 Opus 审查员并行、不替换。审查只读代码只写报告，模型不行最坏也就是报告没用
4. 再换实现阶段，用「审查找出的 🔴 数 / 返工轮数」按实现模型统计，拿数据判断分工值不值

### 预估

- 第二级：配 CC Switch 快照，半天内
- 第一级：搭机制 1–2 天，之后每加一家半天实测。**最大的不确定不在路由而在质量**：非 Claude 模型能不能守住收工条款、按格式落盘报告，只能实跑
- Codex 附加分：大部分时间会花在 Codex 的坑上（尤其 Windows），放最后

### 来源

- [openclaw/acpx](https://github.com/openclaw/acpx)、[内置 agent 列表](https://github.com/openclaw/acpx/blob/main/docs/agents.md)
- [ACP 官方支持的 agent](https://agentclientprotocol.com/get-started/agents)、[ACP 注册表](https://github.com/agentclientprotocol/registry)
- [zai-org/ZCode](https://github.com/zai-org/ZCode)、[ZCode 文档](https://zcode.z.ai/en/docs/welcome)、[zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge)
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、[DeepSeek Harness 介绍](https://deepseek.com/harness/en/)、[dsh 接入 ACP](https://agenticcontrolplane.com/blog/deepseek-harness-acp-integration)
- [claude-code-router](https://github.com/musistudio/claude-code-router)、[CCR 路由文档](https://github.com/musistudio/claude-code-router/blob/main/docs/src/content/docs/en/configuration/routing.md)
- [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)、[PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server)（2025-12 后未更新）
- [cc-switch 中文 README](https://github.com/farion1231/cc-switch/blob/main/README_ZH.md)
- [Codex 子代理文档](https://developers.openai.com/codex/subagents)、[openai/codex#19399](https://github.com/openai/codex/issues/19399)、[#47752](https://github.com/openai/codex/issues/47752)
- [cc-compatible-models](https://github.com/Alorse/cc-compatible-models)、[DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/)、[智谱接 Claude Code](https://docs.z.ai/devpack/tool/claude)

---

## 2. 把 /route 迁到 Codex（2026-10-22，搁置）

**状态**：只调研、没写代码。用户问「移植到 Codex 该怎么做」，看完结论后选「模型来源还没想好、暂不动手」。这一节是第 1 节「Codex 附加分」的展开。

### 结论

**技术上可行，现在不具备条件。** Codex 的 skill、插件、子代理、钩子都齐了，结构能一一对应。但 /route 的核心「分阶段用不同模型」被两件事卡住：用户手上只有 Claude 模型；Windows 上子代理配置不生效（#19399）。照现在的条件搬过去，得到的是流程完整、但每个阶段都跑在同一个默认模型上的 /route。

能原样带走的是规矩（决策权 S1–S7、审查报告落盘、收工条款）；靠换便宜模型省钱的那部分，要等模型来源定了才谈得上。

### 对应关系

| 现在（Claude Code） | Codex | 能否直接搬 |
|---|---|---|
| `commands/route.md`、`plan-fable.md` | skill：`skills/<名>/SKILL.md`，用 `$route` 调用；关自动触发用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false` | ✅ 约 70 处 Claude 专有写法要改写（`Agent`、`SendMessage`、`AskUserQuestion`、`TaskCreate`、模型别名） |
| `agents/planner-fable.md`、`code-reviewer.md` | `~/.codex/agents/*.toml`：必填 `name`、`description`、`developer_instructions`，可设 `model`、`model_reasoning_effort` | ⚠ Windows 上不生效 |
| 实现阶段（派 sonnet） | 内置 `worker`（另有 `default`、`explorer`）；`config.toml` 的 `[agents]` 下有 `default_subagent_model`、`default_subagent_reasoning_effort`、`max_threads` | ✅ |
| `CLAUDE.md` | `AGENTS.md` | ✅ |
| SessionStart 钩子 | `hooks/hooks.json`，格式接近 Claude Code；装完要在 `/hooks` 里点信任 | ✅ |
| `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json`；市场是 `.agents/plugins/marketplace.json`，用 `codex plugin marketplace add`、`codex plugin add` 安装 | ✅ |
| `route-check`、`usage-audit`、`doctor` | 没有对应物 | ❌ 读的是 `~/.claude/projects`，要改读 `~/.codex/sessions` |

### 阻碍（10-22 核过）

1. **模型来源**：子代理只能沿用主会话的同一个供应商（#47752，还开着）。要么全用 OpenAI 自家模型（要 OpenAI 账号），要么通过网关跑 Claude 模型（要 所用的中转站 提供 OpenAI Responses 兼容接口，未知）。
2. **Windows bug**：子代理 TOML 被忽略，按默认配置起来（#19399，还开着，最后更新 07-28）。社区绕法是主代理读出 TOML、派活时显式传入指令、模型、档位，未实测。
3. **route-check 必须重写**：不然第 2 条那种静默跑错模型发现不了。
4. **质量未知**：非 Claude 模型能不能守住 /route 的规矩，只能实跑。

### 三条路线

| 路线 | 做法 | 现在能做吗 | 工作量 |
|---|---|---|---|
| A. 整体迁到 Codex | skill + TOML 子代理 + 重写 route-check，打包成插件 | ❌ 卡在阻碍 1、2 | 3–5 天：最小验证半天、流程改写和 TOML 1 天、route-check 半天到 1 天、打包半天、实跑看质量 1–2 天；usage-audit、doctor 往后放 |
| B. 留在 Claude Code、调用 Codex | 用 codex-plugin-cc 把 Codex 当成一个阶段（比如加一道 GPT 审查） | ⚠ 一样要 OpenAI 账号 | 约半天 |
| C. 一份流程、两个宿主 | 按第 1 节：维护一份流程说明，生成两个宿主的版本，外部阶段经 acpx 调用 | ❌ 前提同 A | 1–2 天搭机制，加上 A 的 Codex 适配 |

### 重启时从哪接

1. 先满足两个前提：有了 OpenAI 账号，或确认 所用的中转站 提供 Responses 兼容接口；#19399 修复了，或者下面第 2 步证明绕法能用。
2. **最小验证**（半天，不动现有插件）：用户装 Codex 并登录；写一个规划用的 TOML，让主代理派它跑一次，看 `~/.codex/sessions` 里实际的模型和档位。
3. 验证通过再选 A 或 C；只想让 GPT 参与一部分就走 B。

### 查资料的坑

WebFetch 拦 developers.openai.com 和 github.com；curl 抓 developers.openai.com 会被 Vercel 返回 403。**GitHub API 能用**（`api.github.com` 查 issue 状态、release 版本），但 Codex 仓库的 `docs/*.md` 只有一行，指向官网。其余只能靠 WebSearch 的摘要，动手前要在装好的版本上实测。10-22 时最新版是 `rust-v0.164.0-alpha`。

### 来源

- [openai/codex#19399](https://github.com/openai/codex/issues/19399)、[#47752](https://github.com/openai/codex/issues/47752)、[#15250](https://github.com/openai/codex/issues/15250)（按名字派自定义子代理，已关）
- [Codex 子代理官方文档](https://developers.openai.com/codex/subagents)、[Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [子代理 TOML 格式](https://codex.danielvaughan.com/2026/04/27/codex-cli-custom-agent-definitions-toml-specialised-subagents/)、[子代理已知问题](https://codex.danielvaughan.com/2026/03/29/subagent-gotchas-known-issues/)、[插件生态](https://codex.danielvaughan.com/2026/05/04/codex-cli-plugin-ecosystem-building-distributing-marketplace-plugins/)、[Hooks 指南](https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/)
- [Claude skills 迁到 Codex 的讨论](https://community.openai.com/t/claude-to-codex-bring-claude-skills-to-codex-automatically/1378574)、[melodic-software/codex-plugins](https://github.com/melodic-software/codex-plugins)（插件示例）、[codex-plugin-cc](https://github.com/openai/codex-plugin-cc)

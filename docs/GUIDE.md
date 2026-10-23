# model-router — 分阶段模型调控

按任务阶段分配模型，而不是全程用同一个：

**日常只需要一条命令：`/route <任务>`** —— 它把下面三个阶段串起来自动跑完。

| 阶段 | 模型 | 单独触发 | 跑在哪 |
|---|---|---|---|
| **规划** | fable | `/plan-fable <任务>` | `planner-fable` 子代理（frontmatter 钉模型，**不传 model 参数**） |
| **实现 / 修复 / 文档** | sonnet | `/route` 自动派 | general-purpose 子代理，Agent 工具传 `model: "sonnet"` |
| **查错 / 复审** | opus | 说「用 code-reviewer 审一下 xxx」 | `code-reviewer` 子代理（同规划，不传 model） |

主会话只编排、把决定交给你、核实结果，不写生产代码。所有文件里只写别名，版本由 `settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 决定；每轮跑完用 `route-check.js` 核实每个子代理**实际**跑的模型（见「验证」）。

> **`/route` 的权威说明是 `commands/route.md` 本身**，这份 README 只是概览。两边对不上时以 route.md 为准，并回来改 README——别反过来照 README 改 route.md。

设计目标是同时解决两个互相冲突的痛点：**全程 Opus 太贵**，但**全程 Sonnet bug 太多**。

规划和查错都跑在**子代理**里，这是关键：它们读的文件留在子上下文，只有结论回主会话——既不污染主上下文，也不破坏主会话的 prompt cache。

---

## 为什么这样分

省钱**不靠削执行阶段的思考质量**。Sonnet 的 effort 特意保持 `high` 而非降档——降它只会让 bug 变多，正好踩中要避免的痛点。真正的节省来自两处：

1. **单价差**：占 token 绝大头的执行阶段（读文件、跑命令、写代码）从 Opus 换成 Sonnet。
2. **上下文不膨胀**：审查跑在子代理里，读的一大堆文件留在子代理的上下文，**只有结论回主会话**。

反过来，Fable 和 Opus 给到 `xhigh`——规划和查错的 token 量只占零头，但规划质量直接决定 Sonnet 会不会写错。钱花在这里是划算的。

> 🧪 **10-19 起试用 Sonnet `xhigh` 3–5 天**（使用方拍板）。当初定 `high` 只是「不降档」，没测过 xhigh 值不值。实测 Sonnet 的输出（含思考）只占它花费的 5.4%，估计 xhigh 让 Sonnet 这块贵约 10%（每天 $4–6）。试完拿「首轮审查的 R 编号条数」和花费跟之前比，再定留不留。CLI 不认识 sonnet-5-5，xhigh 靠默认规则推断，`route-check` 会核实际档位。

---

## 实测得出的结论（每条都踩过）

**1. 斜杠命令 frontmatter 里的 `model` 不生效。**

手打 `/xxx` 走的是 **prompt 展开**路径——正文被注入成一条 user message，在**当前会话模型**下执行。实测：`/plan-fable` 带着 `model: fable` 却跑出 `claude-sonnet-5`。

只有 **agent 路径**的 `model` 生效（`agentFrontmatter.model`，和 `code-reviewer` 同一条解析链）。实测同一时刻用 Agent 工具指定 `fable` → 跑出 `claude-fable-5-1`。

**所以要指定模型，必须做成 agent，不能靠命令的 frontmatter。**

**2. 切模型会让 prompt cache 全部归零。**

```
opus → sonnet   切换后: 缓存命中 0 tok，新读 131,066 tok
sonnet → opus   切换后: 缓存命中 0 tok，新读 157,575 tok
```

缓存按模型绑定，切一次全额重读一次。一轮「切过去规划完再切回来」约 **29 万 token**。而 fable 子代理跑两轮共 **35,625 tok** 且主会话缓存毫发无损——**约 1/8**。这就是规划宁可绕道子代理也不用 `/model fable` 的原因。

**3. `/code-review`（内置 skill）≠ `code-reviewer`（本方案的子代理）。**

前者是 Claude Code 自带的，fork 出的 agent **继承主循环模型**；后者才是钉死 `model: opus` 的那个。想要 Opus 审查，说「用 code-reviewer 审一下 xxx」，别打 `/code-review`。

**4. 新建或改动 agent 定义后要重启 Claude Code 才加载。**

`~/.claude/agents/` 下新加的文件不会热加载，当次会话里 Agent 工具会报 `Agent type not found`。命令（`~/.claude/commands/`）则是热加载的。

**5. 子代理最多并行 2 个，而且条件从严。**

并发会撞 `429 Concurrency limit exceeded for user`（用户级、跨会话共享的额度）。最早同时开两个 sonnet 子代理时，其中一个跑到改完 402 行被打断，当时定成「必须串行」；后来三周实测只撞了 11 次、只有一天扎堆，所以 09-09 起放宽为**最多并行 2 个**，前提是两包改的文件完全不相交、没有依赖，拿不准就串行；一轮撞两次以上退回串行。被打断时用 `SendMessage` 发回**同一个** agent 能从断点续上。

**6. 有两条 env 千万别设，它们会静默废掉整套路由。**

- **`CLAUDE_CODE_SUBAGENT_MODEL`** —— 一刀切强制所有子代理的模型，**连 Agent 工具的 `model` 参数也一起短路**，不只是 frontmatter。A/B 实测（同一台机器、同一个参数 `model: fable`，唯一变量是这条 env）：

  | env 状态 | 实际跑的模型 |
  |---|---|
  | 不存在 | `claude-fable-5-1` ✅ |
  | `= sonnet[1M]` | `claude-sonnet-5` ❌ |

  它不是「默认值」，是**强制值**——代码里它在最前面直接 `return`，后面读 frontmatter 和工具参数的分支根本走不到。所以「想让实现走 Sonnet」也不该用它，那会把 Fable 规划和 Opus 审查一起降级。正确做法是 Agent 工具的 `model: "sonnet"` 参数，`/route` 就是这么做的。

- **`ANTHROPIC_MODEL`** —— 优先级高于 `settings.model`，会让配置文件里的主模型设置静默失效。

**这两项的「缺失」看起来像配置遗漏，所以容易被人补回来**（实际发生过一次）。doctor 专门查它们。

主模型解析优先级（已核对 `claude.exe`）：

```
--model  >  agent frontmatter  >  env.ANTHROPIC_MODEL  >  settings.model
```

会话内 `/model` 切换优先于一切配置文件。

**7. 别在 plan 模式下打 `/route`——Fable 会被完全绕过。**

plan 模式的系统指令写着 *"This supercedes any other instructions you have received"*，优先级高于命令正文。后果：

- plan 模式禁止一切写操作 → `planner-fable` 需要 Write 落盘，**启动不了**
- 主会话只好自己承担规划职责，用 **Opus** 做完并写进 `~/.claude/plans/`
- `.route-plan.md` 根本不会生成

实测（09-08）：在 plan 模式下打 `/route`，7 次 Agent 调用里 **0 次 `planner-fable`**。规划阶段被整个截走，其余阶段（sonnet 实现、opus 审查）反而都正常。

**`/route` 是 plan 模式的替代品，不是补充。** 它自带规划阶段，把关点是阶段 2 回答「待确认问题」，等同于 ExitPlanMode 的批准环节。

| | 谁产出规划 | 落在哪 | 怎么把关 |
|---|---|---|---|
| plan 模式 | 主会话（Opus） | `~/.claude/plans/*.md` | ExitPlanMode |
| `/route` | planner-fable（Fable） | `.route-plan.md` | 阶段 2 待确认问题 |

`route.md` 里现在有硬拦截：检测到 plan 模式就停下来要求先退出。

**8. 内置 agent 默认 `model: inherit`，会跟着主会话跑 Opus。**

`Explore`、`general-purpose` 这些内置子代理的定义里 model 是 `inherit`。主会话是 Opus 时，它们**全部跟着跑 Opus**——包括 `/route` 前期用来摸代码库的 Explore。

实测一次 `/route` 的前期调研：

| Explore | 请求 | 输出 | 缓存读 | 耗时 |
|---|---|---|---|---|
| ×3 合计 | 142 | 74.6k | 9.85M | 37.4 分钟 |

全在 Opus 上，换 Sonnet 省约 80%。搜文件、grep、读片段这类活不需要 Opus。

**所以在 `/route` 流程里，实现、修复、文档、调研子代理都要显式传 `model: "sonnet"`；只有 `planner-fable` 和 `code-reviewer` 不传**——它们的 frontmatter 已钉 fable / opus，而 Agent 工具的 model 参数**优先于** frontmatter（2.1.276 `sdk-tools.d.ts`），传了就会静默覆盖。见 `route.md`「一、总则·模型路由」。

**9. 流程类反馈要落到命令文件里，光记 memory 不算固化。**

「审查报告要完整输出」这条反馈提过两次。第一次只写进了 memory，命令文件没改，下一轮照旧翻车。

**10. Fable 规划时的「长时间空窗、不消耗 token」是正常现象，不是卡死。**

实测一次 `planner-fable` 运行（28 分钟、232 条消息）：

```
out_tok   前置间隔   文本字符   stop_reason
 21894      299s      31093     end_turn     ← 最终规划
```

| 输出量 | 次数 | 平均等待 | 最长 |
|---|---|---|---|
| ≤10 tok | 64 | 15.7s | 91s |
| 101–1000 | 51 | 4.7s | 85s |
| **5000+** | **4** | **75.3s** | **299s** |

两个原因叠加，看起来像"挂了"：

- **`usage` 只在响应完成时才写入 transcript。** 生成那 5 分钟里 token 在涨，但 statusline 读不到，完成瞬间才一次性跳 2.2 万。
- **46% 的请求输出 ≤10 token 却平均等 15.7 秒** —— 那些是加密思考的中间块：`thinking` 字段明文为空，只有 812–1156 字符的 `signature`。思考在发生，内容和计数都看不见。

怎么确认它是在干活而不是卡住：

```bash
# 看子代理 transcript 的最后修改时间，几十秒内动过就是在跑
ls -l --time-style=+%H:%M:%S \
  ~/.claude/projects/<项目>/<会话id>/subagents/agent-*.jsonl
```

**顺带修掉的一个设计缺陷**：原先 planner 把完整规划作为返回值输出、主会话**再写一遍** `.route-plan.md`——同样内容生成两遍 output token，第二遍还在主会话的贵模型上。

现在的分工是：

- planner 自己 `Write` 落盘（给了它 Write/Edit，但提示词限定**只能碰规划文件**）
- 返回值是**完整规划全文**，主会话原样贴进对话供 review
- 修订时用 `Edit` 只改受影响段落，不重写全文
- 主会话**不再重写文件**
- 流程结束后**删掉 `.route-plan.md`**（临时中转文件，全文已在对话里）

### 规划全文进对话是要花钱的

不是免费的：规划全文进主会话上下文后，**后续每次请求都要重读它**。一份 2.2 万 token 的规划，若后面还有 100 次请求，就是 220 万缓存读 token——是**持续成本**，不是一次性的。

**这钱是自觉花的**：能亲眼 review 规划，比规划错了返工便宜太多。上限定在 **2.5 万 token**（实测 1 token ≈ 1.4 字符，约 3.5 万字符），写进了 planner 的提示词。

这个数字怎么来的——实测两份未加约束的规划是 **21894** 和 **22851** token，自然产出稳定在 2.2–2.3 万。2.5 万容纳它还留 10% 余量，正常任务不用刻意压。**没定 3 万**是因为模型有填满预算的倾向，上限一旦不咬人就不起约束作用，而它比 2 万贵 50%、换不到决策信息。

篇幅紧张时的取舍优先级也写死了：

- **保** — 「待确认问题」（实测只占全文 2.6%，最该保的最便宜）、「实现细节」里的路径/函数名/边界值
- **压** — 逐条铺开的测试用例（实测两个测试小节占了 **40.7%**，代码块只有 663 字符，其余全是散文；测试规划只需说清覆盖范围，具体用例让实现者写）、背景介绍、已覆盖的遗漏项、代码原文复述
- **装不下就分期** — 明说「建议拆成 N 期，本份只覆盖第一期」。超篇幅通常意味着任务本身该拆了。

### 自己估算 token 的换算

文件资源管理器和 `wc -c` 给的是**字节**，中文一字三字节，看起来会比实际大一倍多：

```
字节 ÷ 2.16 ≈ token       （中文为主的文档）
2.5 万 token ≈ 3.5 万字符 ≈ 5.4 万字节
```

看到 `.route-plan.md` 有 5 万字节左右就是刚好卡在预算上，超过 6 万才需要留意。

**想省这笔钱的话**：只在**分步模式**（`/plan-fable` 规划完、自己接着执行）里可以 `/clear` 一次，规划已落盘在 `.route-plan.md`。**`/route` 进行中不要 `/clear`**——会丢掉 route.md 的指令本身、planner 的会话（阶段 2 要靠它改规划）、跳过的文档清单和你中途追加的需求。

---

## ⚠️ 一个会静默失效的坑

CLI 内部解析子代理模型的逻辑（`claude.exe` 2.1.241）：

```js
let a = V.CLAUDE_CODE_SUBAGENT_MODEL;
if (a && a !== "inherit") { let p = vs(a); ...; return p; }  // ← 直接 return
if (r) { ... }                                               // ← r = agent frontmatter 的 model，走不到
```

**`CLAUDE_CODE_SUBAGENT_MODEL` 环境变量会短路掉所有子代理 frontmatter 里的 `model:` 字段。**

所以 `settings.json` 里**不能有** `env.CLAUDE_CODE_SUBAGENT_MODEL`，否则 `code-reviewer` 的 `model: opus` 会被静默降成该变量的值，**不报错、不提示**。

删掉后该值默认为 `inherit`：没传 model 参数的普通子代理**跟随主会话**（现在主会话是 opus，所以不传就跑 opus）。这正是 `/route` 要求实现、修复、文档子代理一律显式传 `model: "sonnet"` 的原因。

---

## 安装

### 1. settings.json（插件管不了，必须手动改）

改 `~/.claude/settings.json`：

```jsonc
{
  "env": {
    // ❌ 删掉这一行（见上方「坑」）
    // "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5[1M]",

    // ✅ 启用 PowerShell 工具（探测顺序天然优先 PowerShell 7）
    "CLAUDE_CODE_USE_POWERSHELL_TOOL": "1"
  },

  // 主模型：本机用 opus（使用方明确选择，不要建议改成 sonnet）
  // 规划和查错都在子代理里跑，跟这个值无关；但没传 model 的普通子代理会继承它
  "model": "opus",

  // ✅ 按模型分别配 effort
  "modelSettings": {
    "sonnet": { "effortLevel": "high"  },
    "fable":  { "effortLevel": "xhigh" },
    "opus":   { "effortLevel": "xhigh" },
    "haiku":  { "effortLevel": "low"   }
  },

  // 兜底 default，modelSettings 里没列到的模型用这个
  "effortLevel": "high",

  // 自动压缩窗口：上下文到「这个值 − 1.3 万」时自动压缩（默认 auto，对 1M 模型约等于快到 1M 才压）
  // ⚠ 子代理继承同一个值（2.1.276 代码实测）。500k 是 10-19 按两周数据选的：主会话净省约 $19/天，
  //   只有反复复审、拖到 487k 以上的审查会被中途压缩；400k 会误伤规划和审查
  "autoCompactWindow": 500000
}
```

以上两处（`autoCompactWindow`、试用中的 Sonnet `xhigh`）用 CC Switch 的话，要同步进当前供应商卡片，否则切换供应商会被覆盖。

别名会经 `ANTHROPIC_DEFAULT_<家族>_MODEL` 解析成具体版本（保留 `[1M]` 后缀，**1M 上下文不会丢**）。`modelSettings` 的键也写别名——`/effort` 会写入完整 ID 的键，换代后旧键变孤儿，doctor 会报。

> **省钱的优先级不在这里。** 实测各天的成本构成：缓存读写占 **92%**，输出（effort 影响的部分）只占 7.6%。真正的大头是**上下文长度**——曾出现平均每次请求重读 40 万 token 的情况。所以调 effort 基本没用，**任务之间 `/clear`、把读文件的活交给子代理**才是有效手段。详见文末「成本从哪来」。

### 2. 命令与子代理

本机已直接落地在：

- `~/.claude/commands/route.md`（一站式流程，权威说明）
- `~/.claude/commands/plan-fable.md`
- `~/.claude/agents/planner-fable.md`
- `~/.claude/agents/code-reviewer.md`

本插件目录里是同样内容的**副本**，用于换机迁移或分享；`doctor.js`、`route-check.js`、`usage-audit.js` 只在插件目录里，route.md 按 `~/.claude/plugins/model-router/` 的路径调用它们。**改了 `~/.claude/` 下的四个文件，记得同步副本**。

> **不要在本机启用本插件** —— 会和上述四个文件同名冲突。插件默认 `defaultEnabled: false` 就是这个原因。换到新机器时，二选一：要么把四个 md 文件拷进 `~/.claude/{commands,agents}/`（并把整个插件目录放到 `~/.claude/plugins/model-router/`），要么挂载并启用本插件。新加的 agent 要重启 Claude Code 才加载。

### 3. 换机时挂载插件（可选）

在 `settings.json` 的 `extraKnownMarketplaces` 里加：

```json
"model-router": {
  "source": {
    "source": "directory",
    "path": "C:\\Users\\<你的用户名>\\.claude\\plugins\\model-router"
  }
}
```

路径要用**当前用户的真实 home**。

---

## 日常用法

### 一站式（推荐）

```
/route 给用户列表加分页
```

阶段之间自动推进，但**凡是决定都交给你**。必须停下来问你的地方（S1–S7，定义在 route.md「一、总则·决策权」）：

| 停点 | 什么时候 |
|---|---|
| S1 | 项目里有上一轮残留的规划 / 交接文件：接着做还是丢弃 |
| S2 | 规划的「待确认问题」不是空的——**只要非空就逐条问，不判断「阻塞不阻塞」** |
| S3 | 实现中发现规划走不通、或子代理要改方案 |
| S4 | 审查的 🟡 修不修 |
| S5 | 子代理缺凭据或缺前提 |
| S6 | 复审两轮后仍有 🔴 |
| S7 | `route-check` 报 ❌：某个子代理用错了模型，要不要重跑 |

固定停点之外，凡是「在几种做法里选一个、而且会影响产出」的决定也要先问。

跳过停点只认你在本轮亲口给的授权，**而且只管你说话时针对的那一处**：在待确认问题那里说「都按推荐」，到 🟡 修不修时照样会问；要覆盖后面所有停点，得明说「后面都不用问我」或「我不在」。即便如此，缺凭据（S5）、复审两轮仍有 🔴（S6）、模型用错（S7）也不会跳过：规划或审查跑错模型，本轮就停在那一步等你；某个实现包缺凭据或跑错模型，只把那一包标成阻塞，其它包照做；复审两轮仍有 🔴，就带着它们来汇报、不写文档。「有默认做法」「代价小」都不算理由——10-08 就是被这个理由跳过了 6 个问题。

```
/route <任务>
   ↓ 阶段 0：有残留就问你（S1）· 核实「待实施」项是不是早做完了
   ↓ 阶段 1：planner-fable 规划 → 落盘 .route-plan.md ＋ 返回全文 → route-check 核模型 → 全文原样贴出
   ↓ 阶段 2：待确认问题逐条问你（S2，选择题，第一项是推荐）
你回答 → 转发回同一 planner，它改受影响段落、标 ✅ 已答，返回新文件清单和新问题
   ↓ 阶段 3：sonnet 子代理实现（每包 1–3 步，最多并行 2 个，文档步骤留到最后）
   ↓ 阶段 4：code-reviewer 审查 → 报告落盘 ＋ 终端完整表格（带编号）
            → 🟡 问你（S4）→ 🔴 ＋ 你批准的 🟡 一起派 sonnet 修 → 同一审查员复审一次（新发现编 N1…）
   ↓ 阶段 4.5：sonnet 写文档（描述修复后的代码）
   ↓ 阶段 5：清理临时文件（审查报告保留）· 不提交、不推送
汇报：改了什么 / 决定清单（每条谁定的）/ 修了哪几条 / 没验证的 / route-check 模型核实表 / 未提交的改动
```

几个刻意的设计：

- **规划全文原样进对话。** 你要能亲眼 review 规划，不是看摘要。同时落盘一份给实现子代理读——它们看不到对话。这份文件是临时中转，流程末尾删掉。
- **实现走 Sonnet 子代理，主会话不写生产代码。** 实测上一轮主会话在 Opus 上做了 35 次 Edit、19 次 Write，这是单笔最大浪费。
- **审查报告先完整输出再动手修。** 只报「修了 2 个 🔴」等于什么都没说——你看不到 bug 内容就没法判断。报告落盘因为长任务的终端输出会被刷走，且它是要留档的，不删。
- **规划可以慢，不能糊。** Fable 生成一份长规划可能耗时数分钟且看着像卡住（见上文「实测得出的结论」第 10 条），这是正常的，等它。
- **每轮核实模型。** 规划返回后、最后汇报前各跑一次 `route-check.js`，模型用错当场报出来，不靠配置推断。

任务明显很小（typo、单行改动）时会跳过规划直接做，但仍然过一遍审查。

### 分步（想自己掌控每一步时）

```
/plan-fable 给用户列表加分页          ← 只做规划
（回答待确认问题）
（继续对话，主模型执行）
用 code-reviewer 审一下刚才的改动       ← 手动触发查错
```

**关键在第二步。** `planner-fable` 强制输出编号的「待确认问题」，每条都写明：问题是什么、它暂时按哪个假设写的、备选是什么、选错的后果。**规划回来先读这一节**——那是 Fable 明确告诉你「我拿不准」的地方。在这里花一分钟，比让执行模型顺着一个错误假设写完一整套再返工便宜得多。

回答后不需要重新描述任务，答案会被转发回**同一个 agent**，它带着完整上下文继续修订，只改受影响的部分。

### 用的时候注意

- **背景要带够。** 子代理看不到主会话，只能看到任务描述里的信息。`/plan-fable` 的正文已经提醒了这一点，但如果规划质量不对劲，先检查是不是背景没带够。
- **别新起 agent。** 回答问题时必须发回原来那个，新起一个会丢掉全部上下文，等于从头再来。
- **主模型不会被切走。** 整个规划过程主会话模型不变，缓存也不受影响。

---

## 验证

| 检查项 | 方法 | 期望 |
|---|---|---|
| 配置完整性 | `node doctor.js` | 全绿（含「流程文件里没有写死模型版本号」） |
| **每轮实际模型** | `node route-check.js --from <开工时间戳>` | 规划 = fable、审查 = opus、其余 = sonnet，版本都等于 env 当前钉的，全 ✅ |
| **规划模型** | `/plan-fable 小任务`，然后跑 route-check | 等于 `ANTHROPIC_DEFAULT_FABLE_MODEL` |
| **审查模型** | 用 `code-reviewer` 审一次，然后跑 route-check | 等于 `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| 多轮往返 | 回答问题后转发回同一 agent | 它记得上一轮内容 |
| PowerShell | 跑 `$PSVersionTable.PSVersion` | `7.x`，不是 5.1 |
| 成本 | `/cost` | 记基线，几天后对比 |

**查子代理实际用了什么模型**——这是唯一可信的验证方式，不要靠界面显示或询问模型自己。首选 `route-check.js`（按 `message.id` 去重、逐个对照预期、有 ❌ 返回退出码 1）：

```bash
node ~/.claude/plugins/model-router/route-check.js                 # 当前会话（读 CLAUDE_CODE_SESSION_ID）
node ~/.claude/plugins/model-router/route-check.js --from 1760000000  # 只看这个时间戳之后有活动的记录（/route 开工时 date +%s 记下）
node ~/.claude/plugins/model-router/route-check.js --since 90      # 同上，换算成最近 90 分钟
node ~/.claude/plugins/model-router/route-check.js --session ff02  # 指定会话
node ~/.claude/plugins/model-router/route-check.js --from 1760000000 --full  # 没问题也打完整表（/route 最后汇报用）
```

没有 ❌ 和 ⚠ 时只打一行：各角色个数，加上「主会话当前上下文」（最后一次调用送进去的 token 数）。有问题才打完整表。一轮 /route 要跑一二十次，整表每次进主会话约 1 万 token，全是重复的 ✅。route.md 用这个上下文数判断：审查报告落盘后，上下文超过 300k 时附一行现成的 `/compact`，只给不催。

它判定的规则和 route.md「模型路由」一节一一对应：

- planner-fable 必须是 fable、code-reviewer 必须是 opus、其余必须是 sonnet，家族不对判 ❌；给前两个传了 model 参数但实际家族正确的，只报 ⚠（违反规矩、结果没错，不用重跑）
- 实际版本必须等于 env 当前钉的版本，对不上报 ⚠（有地方写死了旧版本号，或会话中途改过 env）
- 主会话窗口内出现别的模型报 ⚠（中途 `/model` 切过）
- 实现、修复、文档子代理超过 100 次调用报 ⚠（收工条款没触发）；规划和审查豁免
- 时间窗按**活动**过滤：SendMessage 复用的老子代理，只要窗口内干过活就算进来；窗口里没有规划或审查的活动会明说，不会给出「全部 ✅」的假安心

手工核对也行，但**要按 `message.id` 去重**——同一次响应会拆成多行，直接数行会翻倍（09 月就因此把 66 次误报成 115 次）：

```bash
grep -ohE '"model":"claude-[a-z0-9.-]+"' \
  ~/.claude/projects/<项目目录>/<会话id>/subagents/agent-*.jsonl \
  | sort | uniq -c        # 只看有哪些模型，次数不准
```

子代理的 transcript 在会话目录下的 `subagents/` 里，一个 agent 一个文件。注意 `tasks/*.output` 那些文件是空的，别去读。

---

## 升级后怎么办

### 一句话

```
! node ~/.claude/plugins/model-router/doctor.js
```

CLI 升级或换模型之后跑这一条（在 Claude Code 里用 `!` 前缀直接执行，不消耗模型 token）。约半秒出结果，全绿就是没事。

它不是拿硬编码去猜——而是**从当前这个 `claude.exe` 里现场读出模型别名白名单、effort 档位、字段名**，再和本方案实际用的值比对。所以 CLI 换了版本，它读到的就是新版本的规则。

提取时匹配的是**数据字面量**（`["sonnet","opus","haiku",...]` 这种），不是 minify 后的变量名 —— 变量名每次构建都变，数据不会。这是它能跨版本工作的原因。

用法：

| 命令 | 用途 | 耗时 |
|---|---|---|
| `node doctor.js` | 完整检查，含二进制扫描。**升级后跑这个** | ~0.5s |
| `node doctor.js --quick` | 只读 settings.json，不扫二进制 | ~50ms |
| `node doctor.js --quick --quiet` | 同上，但没问题时完全不输出 | ~50ms |

有问题时退出码为 `1`，可以挂 hook 或进 CI。

### 各部分的抗变化能力

按稳定性从高到低，心里有个数就行：

| 依赖项 | 稳定性 | 万一变了会怎样 |
|---|---|---|
| `~/.claude/{commands,agents}/*.md` 目录约定 | 🟢 高 | 公开且长期稳定的接口 |
| frontmatter 的 `model` / `effort` 字段 | 🟢 高 | 在 CLI 的合法字段白名单里，属公开接口 |
| `sonnet` / `opus` / `haiku` 别名 | 🟢 高 | 本方案**全程用别名而非写死 model ID**，正是为了让底层模型换代时自动跟随 |
| `fable` 别名 | 🟡 中 | 是 CLI 官方别名，但相对新。失效则 `/plan-fable` 回落到默认模型 —— doctor 会报 ❌ |
| `env.ANTHROPIC_DEFAULT_*_MODEL` 里的具体 ID | 🟡 中 | **最可能需要动的地方**：中转站换 ID 或上线新模型时要手动更新。doctor 会比对并提示 |
| `modelSettings` 逐模型 effort | 🟠 低 | **未文档化字段**，从二进制挖出来的。若被改名/移除，effort 分档会**静默回落**到顶层 `effortLevel` —— 不会崩，但也不会报错。doctor 专门查这一项 |

关键点：**没有任何一项失效会导致 Claude Code 起不来或报错**。最坏情况是某一档模型分配悄悄失效、退回默认行为。所以定期跑 doctor 比等报错更靠谱 —— 这类故障不会自己冒头。

### 模型换代时（比如 Sonnet 6 上线）

因为主模型写的是别名 `sonnet` 而不是 `claude-sonnet-5[1M]`，多数情况下只需要更新 env 里的一行：

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-6[1M]"
```

`modelSettings` 的键也是别名（`sonnet` / `opus` / `fable`），**不用跟着改**。

doctor 会在 CLI 已知某族更新代号、而你的 env 还钉在旧代号时主动提示。带日期后缀的 ID（`claude-haiku-4-5-20251001`）和中转站自定义代号（`claude-fable-5-1`）都能正确识别，不会误报。

### 想让它自动检查（可选）

在 `settings.json` 的 `hooks.SessionStart` 里追加一项，每次启动静默自检、只在出问题时才说话：

```json
{
  "type": "command",
  "command": "node \"%USERPROFILE%\\.claude\\plugins\\model-router\\doctor.js\" --quick --quiet",
  "timeout": 10
}
```

**默认没有挂**。你的 `settings.json` 已经有两个 SessionStart hook，而且这个文件被反复覆写过；要不要再加一个由你定。挂上的好处是：`CLAUDE_CODE_SUBAGENT_MODEL` 若被 zh-cn 的 `install.ps1` 带回来，下次启动立刻就会知道，而不是安静地多花几个月 Opus 的钱。

`--quick` 模式还会记录上次见到的 CLI 版本，版本一变就提醒你跑完整检查。

---

## 回滚

改动是 `settings.json` + 四个流程文件（插件目录里的工具不影响 CLI 行为，可留可删）：

```bash
cp ~/.claude/settings.json.pre-model-router.20260907 ~/.claude/settings.json
rm ~/.claude/commands/route.md \
   ~/.claude/commands/plan-fable.md \
   ~/.claude/agents/planner-fable.md \
   ~/.claude/agents/code-reviewer.md
```

**四个要一起删**：只删 agent 不删 `route.md`，`/route` 还在却会报 `Agent type not found`。删掉 agent 后同样要重启才会从列表里消失。只想退回上一版 `route.md`，用 `~/.claude/commands/route.md.bak-<日期>`。

---

## 已知边界

- **主会话不会自动换模型**。CLI 没有任何 hook 输出字段能切换模型（已核查 `claude.exe` 2.1.241），所以分阶段换模型全靠子代理：`/route` 自动派，分步模式手动触发。唯一内置的自动切换是 `model: "opusplan"`（plan 模式用 Opus、其余用 Sonnet）——但它锁死 Opus，用不了 Fable，故未采用。
- **规划走子代理的代价**：子代理看不到主会话上下文，背景要靠任务描述带过去；交互是往返式而非实时对话；走不了正式的 plan 流程和 `ExitPlanMode`。换来的是真正跑在 Fable 上 + 约 1/8 的 token 开销。
- **`modelSettings` 的键**走别名规范化，写 `sonnet` / `opus` / `fable` / `haiku` 即可，不必写完整 model ID。
- **command frontmatter 的 `agent:` 字段**（解析结构里确认存在）也许能直接声明用哪个 agent 跑，未验证。当前靠正文指示，是确定可行的路径。
- **只支持 Claude 系模型**。跨供应商 / 跨宿主（Codex）的调研结论在 [`TECH-LIBRARY.md`](TECH-LIBRARY.md)，09-30 搁置。

---

## 成本从哪来

某次统计（Opus 5，按标准价格比例，非绝对金额）：

| 日期 | 输出（effort 影响） | 缓存写 | 缓存读 | 平均上下文/请求 |
|---|---|---|---|---|
| 09-01 | **7.6%** | 34.9% | 57.3% | **398k** |
| 09-02 | 9.7% | 31.5% | 58.6% | **411k** |
| 09-04 | 8.0% | 32.2% | 59.4% | **388k** |
| 09-07 | 25.6% | 34.1% | 39.3% | 125k |

**缓存读写合计 92%，输出只占 7.6%。**

结论很反直觉：**调 `effortLevel` 基本没用**。把 xhigh 砍到 low、思考 token 减半，也只省约 4% 总成本，代价却是 bug 变多。

真正的成本是**上下文长度**。09-01 那天 2114 次请求 × 平均 398k 上下文 = 8.4 亿缓存读 token——每一次交互都拖着一整天的历史在跑。

### 按杠杆排序（09-15 修订）

1. **控制单个子代理的规模**（当前最大杠杆）。子代理上下文只增不减、没有 `/clear`，跑成 200+ 次调用的巨兽时每次调用成本翻 2.6 倍。三周里 6 个超标子代理合计 45.82M EIU ≈ $188。详见下面的度量衡一节。
2. **任务之间新开会话**。平均上下文 400k → 100k。⚠️ 但**追加需求不必赶用户去开新会话**——接住它、记进交接文档留到下一轮即可（`route.md` 阶段 0）。
3. **把读文件的活交给子代理**。这正是 `planner-fable` / `code-reviewer` 的价值——不只是"用对模型"，更是**抑制主上下文膨胀速度**。
4. **确认 `[1M]` 后缀的计价**。Anthropic 官方对超 200k 的部分有溢价（input 翻倍）。若平均上下文 398k，则全程在溢价区间。中转站是否照此计价需向其确认。

**已否掉、不要再提的两条**：主模型换 Sonnet（用户 09-15：「主会话习惯用 opus 了」，而且数据也不支持——Opus 主会话调用次数少 2.75 倍，每小时反而更便宜）；给 `planner-fable` 加读法限制（读得多规划才准，那正是它值钱的地方）。

---

## 统一度量衡：`usage-audit.js`

**为什么需要它**：此前每次分析都临时写脚本，口径不固定，反复得出又推翻结论。踩过的六个口径陷阱：

| # | 陷阱 | 造成的错误结论 |
|---|---|---|
| 1 | **没按 `message.id` 去重** | 全部数字翻倍（重复率 ~52%）。同一次 API 响应会拆成多条 jsonl 行，每行都带完整 `usage` |
| 2 | 仪表盘口径与 transcript 口径混用 | cache read 386M vs 318M 放同一张表比 |
| 3 | 两天样本就下结论 | 任务难度差异被当成模型差异 |
| 4 | 只比总量不做归一化 | 工时多 0.8h 就被算成「更贵」 |
| 5 | **工时用 wall clock** | 含几小时空隙，`EIU/h` 被摊薄成假的「效率高」 |
| 6 | 只扫主会话 | 漏掉子代理的写操作，得出反向结论 |

### 口径定义（改 `usage-audit.js` 顶部就改了全部结论，慎动）

```
EIU（等效输入单位） = input×1 + output×5 + cacheWrite×1.25 + cacheRead×0.1
```

按 Anthropic 官方价格比例把四类 token 折算到同一标尺，**与模型无关**，跨天跨模型可比。

```
活跃工时 = 相邻调用间隔 ≤30 分钟才累加，超过视为休息
```

**$ 按公开价分项算**（10-22 起）：`PRICE` 每个模型是 `[输入, 输出, 读缓存, 写缓存]` 的 $/百万 token，5 系取自 CC Switch 的 `model_pricing`，网关按这个价扣。旧的「三个日花费反解的 $/百万 EIU」已废弃，它比网关高估约 25%。表里没有的模型按 `_default` 估，「模型构成」里会标出来，doctor 也会报。

**看不见的那部分**：auto 模式的权限分类器、压缩之类的后台请求不写 transcript。10-09～10-22 网关总账比 transcript 多 29%，主要是分类器。日报和单日详解多打一行「网关实付估计」，按 `HIDDEN_SHARE` 往回补；这个比例变了要重新对一次网关面板。

**去重取最大输出**：子代理 transcript 里同一条消息的第一行，`output_tokens` 只写到一半。10-22 之前取的是第一行，子代理输出少算了 3–9 倍。

### 用法

```bash
node usage-audit.js                     # 最近 7 天日报
node usage-audit.js --days 22           # 指定区间
node usage-audit.js --day 2026-09-15    # 单日详解
node usage-audit.js --agents            # 子代理排行 + 超标检测（查上下文膨胀）
node usage-audit.js --sessions          # 主会话排行
node usage-audit.js --baseline          # 把当前区间存为基线
node usage-audit.js --vs-baseline       # 跟基线对比，✅/⚠️ 标好坏
node usage-audit.js --json              # 机器可读
node usage-audit.js --ttl-sim           # 模拟缓存 TTL 改 1 小时的得失（按主会话/规划/审查/实现分开算）
node usage-audit.js --project <目录名>   # 只看某个项目
```

### 六个核心指标

| 指标 | 看什么 | 越低越好？ |
|---|---|---|
| **EIU/h** | 单位时间烧钱速度。**最核心**，排除了工时差异 | ✅ |
| **$/h** | 同上，但含模型单价收益 | ✅ |
| **EIU/调用** | 平均每次请求背多少上下文 → 查上下文膨胀 | ✅ |
| **子代理平均规模** | 拆得够不够细 | ✅ |
| **命中率** = `cr/(cr+cw)` | 缓存效率 | ❌ 越高越好 |
| **主会话占比** | 有没有把活派出去 | 无绝对好坏 |

外加 **TTL 重建次数**（间隔 >5min 且 `cw>100k` 且 `cr=0` 的全量重建）——这是 route 模式的固有开销：主会话等子代理时 5 分钟 prompt cache TTL 必然过期。09-30 起主会话改成 1h TTL（见下文「缓存 TTL」），这一项应大幅下降；跟之前的数据比时记得这个变量。

### 三周实测（`--days 22`）

| 期间 | 平均 EIU/h | 平均 $/h | 日均 $ |
|---|---|---|---|
| 纯 Opus（08-24~09-04，10 天） | 5.87 | **$32.9** | $244 |
| route 模式（09-07~09-15，7 天） | 5.03 | **$25.3** | $198 |
| **改善** | **−14%** | **−23%** | −19% |

> `EIU/h` 只降 14%、`$/h` 降 23%——差额那 9pp 来自模型分配（Sonnet 单价低）。
> **早先声称的「降 37%」是 wall clock 口径的高估**，改用活跃工时后真值是 23%。

**子代理规模分档（超线性证据）：**

| 调用次数 | 个数 | 平均 EIU | EIU/调用 | 平均峰值上下文 |
|---|---|---|---|---|
| 0–50 | 71 | 0.46M | **18.4k** | 116k |
| 50–100 | 45 | 1.47M | 21.4k | 215k |
| 100–200 | 13 | 3.21M | 25.5k | 301k |
| **200+** | 2 | **13.11M** | **48.3k** | **570k** |

峰值上下文随调用次数线性增长，而总成本 ≈ 调用次数 × 平均上下文，所以是**平方级**。

最坏一例：09-15「构建 S9 P0 demo」——304 次调用、5h11m、上下文 31k→**703k**、17.61M EIU ≈ $72，占当天 39%，比整个主会话还多。工具分布 `Bash=112 Edit=92 Read=58`，即**在长时间反复调试**。

`route.md` 阶段 3 已据此加入规模上限与收工条款。

---

## 缓存 TTL：主会话开 1 小时（09-30）

**TTL = 缓存保鲜期。** 保鲜期内再发请求读缓存（0.1×），过期就整段重写（1.25×）。走 API key / 中转站默认 **5 分钟**，订阅用户默认 1 小时。

route 模式里主会话派活后要干等 10–30 分钟，5 分钟必过期——子代理一回来整段上下文全价重写，这就是报表里「TTL 重建」那列（占主会话缓存写入 63–89%）。

1 小时的代价是**每次写入从 1.25× 涨到 2×**。`usage-audit.js --ttl-sim` 回放 16 天历史：

| 范围 | 日均 | 盈亏平衡倍率 | 结论 |
|---|---|---|---|
| **主会话** | **−$18.6** | 4.28× | ✅ 开 |
| 规划 fable | −$0.1 | 2.04× | 持平，不开 |
| 审查 opus | +$0.2 | 1.91× | ❌ |
| 实现 sonnet | +$3.5 | 1.49× | ❌ 连续干活不等人，只吃涨价 |

「盈亏平衡倍率」= 网关对 1h 写入收费不超过 input 的这么多倍时仍划算（官方 2×）。主会话余量很大。

**已配置**：`settings.json` 顶层 `"promptCacheTtl": "1h"`（只管主会话）。**实测网关支持**：改完 40 秒后当前会话就出现了 `ephemeral_1h_input_tokens=361181`（设置热加载）。会话中途切换会整段重写一次（那次约 $4），新会话没有这笔。

优先级（从 `claude.exe` 核实）：`FORCE_PROMPT_CACHING_5M` > env（`CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`）> settings（`promptCacheTtl` / `subagentPromptCacheTtl`）> agent frontmatter 的 `cacheTtl` > `ENABLE_PROMPT_CACHING_1H`。⚠️ 别用 `ENABLE_PROMPT_CACHING_1H`，它会把子代理也一起开成 1h。

---

## 模型换代：只改 env 一处

agent 文件和 `route.md` 全用别名，版本由 env 决定：

```
planner-fable.md   model: fable    ─┐
code-reviewer.md   model: opus     ─┼─→ ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET}_MODEL → 实际版本
route.md 派实现代理  model: "sonnet"  ─┘
```

新模型上线时改对应那一行（连同 `_NAME`，保留 `[1M]`），主会话和所有子代理下个会话一起切。**别在 agent 文件里写死版本号。**

`doctor.js`（完整模式）现在会：
- **问网关 `/v1/models`**（**只在加 `--gateway` 时**，因为要读 settings 里的凭据；09-30 起默认关）：同族出了新版而 env 还钉旧版 → 报警。这个接口只列模型、不耗 token
- **查 transcript 里子代理实际跑的版本**，跟 env 对不上 → 报警
- **原样搜二进制里有没有这个模型 ID**：没有 = CLI 比模型旧，effort 档位靠默认推断，要用 transcript 的 `"effort"` 字段核实
- **查 1h 缓存是否真的在写**
- **报 `modelSettings` 的换代孤儿键**（`/effort` 写的是完整 ID，换代后旧键不生效也不报错）
- **扫四个流程文件里有没有写死的版本号**（`claude-<家族>-<数字>`，快速模式也查）：有就提醒改成别名
- **查 env 钉的模型在 `usage-audit.js` 单价表里有没有价**（快速模式也查）：没有就按默认价估，账面会偏。10-09 sonnet-5-5 上线后没进表，按 $5.00 估了一周（sonnet-5 是 $4.10），sonnet 那部分虚高 22%

每轮 `/route` 结束还会跑 `route-check.js`，逐个子代理核对实际版本是否等于 env 当前钉的——env 改了但某个角色还停在旧版，当轮就会报出来。

⚠️ 09-30 修掉一个漏报：原先用 `startsWith` 判「已知模型」，`"claude-opus-5-5".startsWith("claude-opus-5")` 为真，换代新模型被当成已知。

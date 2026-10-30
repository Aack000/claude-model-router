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

## 为什么 /route 这样设计（实测记录）

`commands/route.md` 只留规则，每条规则的来由和实测数据都在这里，按「规则 → 实测依据」两列写。数字和日期照原始记录，没有改写。

### 决策与提问

| 规则 | 实测依据 |
|---|---|
| 不许拿「有默认做法、选错代价小、不算阻塞」当跳过停点的理由（决策权） | 10-08 `ff02bc08`：planner 列了 Q1–Q6，主会话一句「都有明确的默认做法、选错代价很小，都不算阻塞问题，我直接按默认做法往下走」，19 秒后就派了实现，用户一个问题都没看到。planner 按设计给每一条都写了「暂按什么」和「选错的后果」，拿「有默认、代价小」当标准，就没有任何一条会停。使用方的原话是「很恐怖」 |
| 固定停点之外，主会话自己动手时碰到的决定也要先问（例：判成「微」直接做，改文案时挑哪种措辞） | 10-23 首版就有的规则（例子 v2.0.2 从 route.md 挪来），具体是哪次事故没有留下原始记录；最接近的是上一行 10-08 那次 |
| 跳过停点只认本轮亲口授权的**那一个**停点（例：S2 说「都按你的推荐来」，管不到 S4；要覆盖后面所有停点必须明说「后面都不用问我」或「我不在，你一路做完」） | 「本轮」这层：09-18 用户说过一次「……然后就别问了，有 bug 就修，就按你的推荐来」，之后被当成长期免问；09-30 用户更正：那是临时不在设备前的下策，不是常态。「只管那一个停点」这层：没有留下原始记录 |
| 提问框本身要能独立看懂：逐条写「编号 + 是什么问题 + 不修会怎样」 | 10-09：审查表格放在正文、提问框里只写了「N26 替换规矩交给子代理」「N27 备份名精确到分钟」，用户的反应是「n26 和 27 你都没给我看？？」 |

### 派活与子代理规模

| 规则 | 实测依据 |
|---|---|
| P8、P9：缺凭据、缺前提、规划走不通都要停下来回报，同时给出另一条路 | 09-16 有子代理拿不到测试账号的密码，就直连数据库把密码哈希覆盖了。一个被要求「做完 / 跑绿」又没有出路的子代理，必然会自己找一条走得通的路 |
| 每个子代理只做 1–3 个步骤，每个步骤结束按 P7 自评（不是边干边监控） | 子代理上下文只增不减，体量超线性。每次调用的体量（按当时的 EIU 折算）：0–50 次 18.4k，50–100 次 21.4k，100–200 次 25.5k，200–400 次 48.3k（2.6 倍，不是 $ 倍数）。最坏一个跑了 304 次、5 小时、上下文涨到 703k，等效 17.61M，占当天 39%。另一个只写了「约 10 个文件」没给检查点，一路跑到 251 次都没收工 |
| 一轮里撞两次 `429 Concurrency limit` 就退回串行 | 它是用户级、跨会话共享的额度 |
| 规划一次只开一个，追加需求交给同一个 planner | 10-21 两个 fable 规划并行，撞了两次 `429 Concurrency limit`；失败的请求网关照样计费，两周累计约 43 次、40 美元 |
| P1 只给路径和步骤号，不复述规划内容 | 复述在贵模型上多花 output，还会丢细节 |
| P10：不把写文件 / 删除 / git 改工作区 / 跑测试拼进复合命令；测试只跑 P3 点名的固定脚本 | 10-29 v2.0.0 那轮被分类器拦了 5 次，都是这几类：子代理自己跑全套测试、复合命令里带 `echo >>` / `rm -f`、想用 `git restore` 覆盖有未提交改动的文件；多数要用户切出 auto 或自己动手。这条规矩本身审了三轮（R1–R6 → N1–N2 → N3） |
| P2 行尾（Edit 保 CRLF、Write 一律 LF、Python 用 bytes） | CLI 2.1.276 实测；CLI 升级后要重测 |
| P7 每步落盘，不要只在收工时才写 | 逐步记进度是为了进程崩溃后能接上；只在收工时写，正常干到一半崩了就什么都没留下 |
| 子代理被 429 / 503 打断用 `SendMessage` 续同一个，不重开（规划、实现、审查都适用） | 审查员重开一次多花 1.17M，还会漏掉追到一半的线索；新起的要从头再来 |
| 子代理按 P7 主动收工后新起一个，不续 | 就是要丢掉膨胀的上下文 |

### 模型路由与核实

| 规则 | 实测依据 |
|---|---|
| 每个子代理返回后跑 `route-check`，越早越好 | 一次不到 1 秒、不花 token；审查员跑错模型，要是到最后才发现，审查、修复、文档全得重来 |
| 任何地方只写别名，不写版本号 | 写死版本号 = 新模型出来后这个角色还停在旧版，而且不报错 |
| 实现、修复、文档、调研子代理必须传 `model: "sonnet"` | 内置 agent 默认都是 inherit，见上文「实测得出的结论」第 8 条（3 个 Explore 串行 37 分钟，全在 Opus 上） |
| 不要先开 Explore 再转述给 planner | 它自带 Read / Grep / Glob / Bash，查两遍还丢细节；实测 3 个 Explore 串行 37 分钟 |
| planner 返回后不要自己再把规划写一遍文件 | planner 已经写好了，重写等于同样内容在贵模型上生成两遍 |
| 几分钟不涨 token 不是卡死，别重开 | fable 的思考是加密的，usage 要等整条响应完成才写入，实测空窗最长近 5 分钟；看 `subagents/agent-*.jsonl` 的修改时间 |

### 主会话分工与上下文

| 规则 | 实测依据 |
|---|---|
| 主会话不写生产代码，审查发现的问题一律派修复子代理 | 实测一轮主会话在 opus 上做了 35 次 Edit、19 次 Write，是最大的一笔浪费；10-19 主会话自己改了 141 次 Edit、52 次 Write，当天主会话占了 73% |
| 审查报告落盘后、上下文超过 300k 时附现成的 `/compact`（只给不催） | 10-14 实测：会话不压缩一路涨到 818k，后半程每次调用光重读上下文就要 6–8 万（当时用的 EIU 权重折算，EIU 已废弃，现在统一看 $）；手动压缩后回到约 2 万，加上自动带回的文件和 route.md。压缩后 route.md 会被自动带回（同日实测），所以命令里只写找回状态要用的 |
| 流程上的新经验写进命令或 agent 定义，不只记 memory | memory 按启动目录分，换个目录就读不到 |
| 不相关的新任务默认留到下一轮 | 新任务在本会话开工，就全程背着前一个任务的上下文，每次交互都更贵。实测一个会话追加了 2 个新需求，上下文从 140k 涨到 419k，单会话烧掉 21.90M 等效 token |
| 开工先报分母 | 使用方最大的痛点是不知道做到哪、还差多少 |

### 阶段细节

| 规则 | 实测依据 |
|---|---|
| 阶段 0：plan 模式下直接停，退出后重打 | 原因见上文「实测得出的结论」第 7 条：plan 模式的指令优先级高于命令正文，主会话自己用 opus 把规划做了，fable 完全不参与（09-08 实测：7 次 Agent 调用里 0 次 planner）。`/route` 的阶段 2 本身就是批准环节，是 plan 模式的替代品，两者叠加只会互相干扰 |
| 残留文件不问就不许删 | 进程崩溃后这是唯一能恢复进度的东西（本机内存超规格，会随机崩进程） |
| 动手前先核「待实施」的项是不是早就做完了 | 计划文档常被实测证伪：09-18 一天里两项标着「待实施」的其实早已提交，照文档派活会白跑一整轮 |
| 已有拍过板的规划就不重跑 planner | 重跑 fable 只会产出一份更差的重复品，而它是流程里最贵的一环（单次约 2M） |
| 阶段 2 重新规划写进单独的 `.route-plan-redesign.md`，不写 `.route-plan.md` | `.route-plan.md` 有时就是原规划本身（续跑时），有时装着指向 `PLAN-*.md` 的记录和还没并回去的修订补充。planner 按首轮规则是整份 Write，写进去就把这些全覆盖了 |
| 阶段 2 改动多时选 A 的 sonnet 子代理要带 P2 和替换规矩 | 不交给它，它会按习惯顺延编号或顺手整理别的节 |
| 文档类步骤留到阶段 4.5，先审查 | 审查必然会改代码，改完文档就过时了。实测一轮里同一批文档写了两遍（0.47M + 0.79M） |
| 审查启动时别给「不可达 / 死代码」这类没验证的推断 | 09-07 就有一条「不可达」被审查证伪，反例正是同一轮新写的测试 |
| 复审结果每轮都追加进 `code-review-*.md` | 阶段 4.5 的文档子代理只能读文件；09-10 因收口轮结论没落盘，文档里少了一条 |
| 界面小改攒批审，但审还是要审 | 10-19 一批小改审了 10 美元，查出的「手机上按钮撑出横向滚动」就是样式改动引起的 |
| 绝不为了快而压缩审查 | 前面省下的时间就是留给这里的 |
| 文档子代理报「某条找不到」要先查自己的派活，它宁可交白也不编 | 这种行为是挡住幻觉进文档的最后一道闸，要在汇报里明确肯定 |
| 命令参数里美元金额不能写成「货币符号紧跟数字」 | CLI 的命令参数替换会把「货币符号加数字」整个当成第 N 个参数；没有转义写法，所以 route.md 里的金额一律写成「约 40 美元」「10 美元」这种形式 |

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

### 1. settings.json（安装器会问着帮你配，手动配见下）

**用一键安装的话不用自己改**：安装入口（`setup`）菜单 1 / `setup install` 装完插件会接着跑 `configure.js`，把下面这些项逐项列出来、问着帮你配，再跑一次体检；只想重做这一步用菜单 5（`setup configure`）。哪些默认做、哪些默认不做、已经配过的怎么处理，见下面「4. 安装 flow 与参数」。手动安装（没有安装清单）时 `configure.js` 用不了，才需要照下面自己改。

手动改本机用户级 `settings.json`（`~/.claude/settings.json`；设了 `CLAUDE_CONFIG_DIR` 就是那个目录下的，见「5. 配置目录」）：

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

用 CC Switch 的话：新版切卡只换归卡片的键（`model`、`ANTHROPIC_*`、`CLAUDE_CODE_SUBAGENT_MODEL` 等），上面其余的写本机一次就够、切卡不丢；旧版（`~/.cc-switch/` 里没有 `live-state.json`）切卡会整份覆盖本机文件，要同步进每张卡片。详见「6. CC Switch：哪些键切卡会变」。

别名会经 `ANTHROPIC_DEFAULT_<家族>_MODEL` 解析成具体版本（保留 `[1M]` 后缀，**1M 上下文不会丢**）。`modelSettings` 的键也写别名——`/effort` 会写入完整 ID 的键，换代后旧键变孤儿，doctor 会报。

> **省钱的优先级不在这里。** 实测各天的成本构成：缓存读写占 **92%**，输出（effort 影响的部分）只占 7.6%。真正的大头是**上下文长度**——曾出现平均每次请求重读 40 万 token 的情况。所以调 effort 基本没用，**任务之间 `/clear`、把读文件的活交给子代理**才是有效手段。详见文末「成本从哪来」。

### 2. 命令与子代理

本机已直接落地在：

- `~/.claude/commands/route.md`（一站式流程，权威说明）
- `~/.claude/commands/plan-fable.md`
- `~/.claude/agents/planner-fable.md`
- `~/.claude/agents/code-reviewer.md`

本插件目录里是同样内容的**副本**，用于换机迁移或分享；`doctor.js`、`route-check.js` 只在插件目录里，route.md 按 `~/.claude/plugins/model-router/` 的路径调用它们（用量统计 `usage-audit.js` 在 v2.0.0 起属于 usage 组件，见下面「用量插件」）。**要改这四个文件，改仓库里的副本，再跑一次安装入口（`setup` 或 `node install.js`）部署出去**。别把 `~/.claude/` 下部署好的文件直接拷回仓库：部署时 route.md / plan-fable.md 里的 `${CLAUDE_PLUGIN_ROOT}` 已被换成本机路径（设了 `CLAUDE_CONFIG_DIR` 的是绝对路径），拷回去提交，原生插件安装的用户会拿到固定路径、找不到脚本，本机路径也进了仓库。

> **手动复制时要换掉 `${CLAUDE_PLUGIN_ROOT}`。** v2.0.0 起仓库里的 `commands/route.md`、`commands/plan-fable.md` 用 `${CLAUDE_PLUGIN_ROOT}/…` 指脚本，只有安装器（`install.js`，部署时按配置目录换成实际路径）和原生插件安装（CLI 自己替换，指向**源目录**）会替换它。直接 `cp commands/*.md ~/.claude/commands/` 的话不会换：Bash 把它展开成空串，`node ${CLAUDE_PLUGIN_ROOT}/route-check.js …` 变成 `node /route-check.js`，找不到模块，放行规则也匹配不上（`doctor.js` 会报 ⚠）。手动复制的做法：把这两个文件里的 `${CLAUDE_PLUGIN_ROOT}` 全部换成 `~/.claude/plugins/model-router`（默认配置目录；设了 `CLAUDE_CONFIG_DIR` 的换成那里的插件目录，写法见「5. 配置目录」）。更省事也更不容易漏的是直接跑安装入口（`setup` 或 `node install.js`），它替你换、同时配放行规则。

> **不要在本机启用本插件** —— 会和上述四个文件同名冲突。插件默认 `defaultEnabled: false` 就是这个原因。换到新机器时，二选一：要么把四个 md 文件拷进 `~/.claude/{commands,agents}/`（照上一段换掉 `${CLAUDE_PLUGIN_ROOT}`，并把整个插件目录放到 `~/.claude/plugins/model-router/`），要么挂载并启用本插件。新加的 agent 要重启 Claude Code 才加载。

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

### 4. 安装 flow 与参数（一键安装）

入口 `setup`（`setup.cmd` / `setup.ps1` / `setup.sh` / `setup.command`，最终都跑 `setup.js`）。不带参数出菜单：

| 菜单 | 做什么 |
|---|---|
| 1 | 安装 / 升级：先选装哪些组件（core / usage / switch），再装插件 → 配模型设置 → 体检，串着跑 |
| 2 | 卸载（要输入 `y` 确认；菜单传不了参数，要加参数用命令行 `setup uninstall …`，见「7. 卸载」） |
| 3 | 试运行：只跑 `install.js --dry-run`，列出安装会改什么 |
| 4 | 给 CC Switch 卡片补能力声明（第三方模型，要先装好插件；见 README「换供应商」）。不在 flow 里，单独选 |
| 5 | 只配模型设置并体检（`configure.js` → `doctor.js`），要先装好插件 |
| q | 退出 |

带参数就直接执行、不出菜单：

```text
setup install   [--components=…] [--rules=…] [--items=…] [--yes] [--no-configure] [--no-doctor] [--dry-run]
setup configure [--items=…] [--yes] [--no-doctor] [--dry-run]            （= 菜单 5）
setup uninstall [--dry-run] [--keep-ccswitch-caps] [--keep-card-settings]  （参数原样交给 uninstall.js）
setup caps      […]                                                      （参数原样交给 ccswitch-caps.js）
```

`--pause` 是双击启动器自己加的（跑完等回车再关窗口），不用手动给。

**flow 的规则**

- 三步：① `install.js` → ② `configure.js` → ③ `doctor.js`（体检）。前一步退出码不是 0 就停下，打印「停在第 N 步（名字）」和退出码，后面的不跑。第 2 步失败时会再提示安装已经做完，修好后用菜单 5 接着配。
- 体检是例外：退出码 1 = 发现了要处理的问题，只打印「体检发现要处理的问题，见上（不算安装失败）」；别的非 0（没正常跑完）也只打印提示。刚装完或在沙盒里它常有要处理的事，那是提醒，不是安装坏了。
- 参数分给各步：`--components`、`--rules` → `install.js`；`--items`、`--yes` → `configure.js`；`--dry-run` → 安装和配置两步（体检不预演；还没装过插件、没有安装清单时配置这一步也没法预演，会提示「真装之后会接着配」）；`--no-configure` 跳过第 2 步（体检照跑）；`--no-doctor` 不体检。
- 不认识的参数、`--components` / `--rules` / `--items` 没给值，立刻退出（exit 2），不会先装一半。PowerShell 调 `.ps1` 时会把 `--components=a,b`、`--rules=a,b` 拆成「`--rules=a`」「`b`」两个参数，跟在后面的裸词会接回去。
- 同一个 stdin 上菜单、组件、放行规则、配置各读各的一行：`printf '1\n\n\n\n' | ./setup.sh` 能走完整个 flow（每一步回车按默认）。想在管道里「放行规则一条不要」：`0` 写在第 3 行（放行规则那一问）就行，`printf '1\n\n0\n\n' | ./setup.sh`；或者不走菜单，`printf '\n\n' | ./setup.sh install --rules=none`（带了动作就不出菜单，管道里没有菜单那一行，所以不能再写开头的 `1`）。
- 环境变量 `MR_SETUP_FLOW`：串着跑时 `setup` 给安装这一步设的，值是后面还要跑哪几步（逗号分隔，如 `configure,doctor`）；`install.js` 据此决定结尾的「下一步」怎么写——后面有配置这一步就不再提示手动配；单独跑 `install.js`（或用 `--no-configure` 跳过了）才提示「接着跑 `configure.js`（或安装入口菜单 5）」。这是内部约定，不用自己设；外面残留的会被清掉。

**组件（v2.0.0 起，`--components`）**

安装器按三个组件装，`core` 永远会装：

| 组件 | 编号 | 装进去的文件 | 装好后的位置 |
|---|---|---|---|
| `core` | 1 | `/route` 工作流：commands、agents、`route-check.js`、`route-clean.js`、`doctor.js`、`configure.js`、安装 / 卸载脚本、`docs/`、旧路径的 `usage-audit.js` 转发脚本 | 插件目录根（`~/.claude/plugins/model-router/`） |
| `usage` | 2 | `usage-audit.js`、`usage-balance.js` | `<插件目录>/usage/` |
| `switch` | 3 | `provider.js`、`ccswitch-caps.js`、`providers/deepseek.json` | `<插件目录>/switch/` |

- **怎么选**：`--components=core,usage` 或 `--components=2,3`（名字、编号都行，逗号或空格分隔），`all` = 三个全装，`core` = 只装核心。不给就在放行规则那一问之前先问一次（回车 = 按勾的来，输入编号 = 只要这几个，`0` = 只装 core）；输入已结束（管道、没有终端）时不问。不认识的名字退出 2，什么都没改。选择会记进安装清单的 `components`。
- **默认勾哪些**：第一次装只勾 `core`，检测到 CC Switch（只看它的目录 / 程序在不在，不读里面任何东西）再加 `switch`；清单里有 `components` 记录的沿用上次的选择；**v1.x 装的（有清单、但清单里没有 `components` 记录）默认三个全勾**——v1.x 装的就是全部，不这样的话旧的 `usage-audit.js` 命令会失效、安装器加过的 audit 放行规则会被摘掉。
- **组件文件是写死的清单，不是递归复制**：`usage/`、`switch/` 只装上表列的那几个文件。源目录里自己的本地数据——`calibration.jsonl`、`usage-baseline.json`、自建的供应商文件（`providers/` 下除 `deepseek.json` 以外的 json）、编辑器备份——不会被装进插件目录、也不会记进清单，所以升级和卸载都不会覆盖或误删它们。自定义供应商文件放在 `<插件目录>/switch/providers/`（v2 的 `provider.js` 和 `ccswitch-caps.js` 只读这里）；v1.x 时放在旧 `providers/` 里的自建 json，安装器发现后只提示、不挪不删，要用的话自己移到 `switch/providers/`。
- **放行规则**：`audit`（查用量，只读）属于 `usage` 组件，没选 usage 时规则列表里不列它，`--rules=audit` 会报「需要 usage 组件」退出 2。规则字符串没变（仍写旧路径 `usage-audit.js`，由转发脚本接到 `usage/usage-audit.js`），所以 v1.x 时加的规则和 CLAUDE.md 里写的旧命令原样可用。
- **从装好的插件目录自己跑安装（副本模式）**：组件文件的来源是源目录里的 `plugins/<名>/` 或 `<名>/`。新勾的组件在源目录里找不到文件时，动任何文件之前就停（退出 2），提示「从下载的仓库或解压出来的目录跑安装入口」，不会出现清单记了但文件没装的情况。反过来，已装的组件这次没勾，副本模式**不删**它的文件（文件还留在清单里），会打一行提示：要去掉就从仓库目录跑安装入口，或者用卸载。
- **提示里给的命令是 `--components=all`**：旧路径转发脚本（根目录的 `usage-audit.js`）、命令行的 `setup caps` 发现组件没装时，提示的是 `node install.js --components=all`（三个全装、不会卸掉已装的）。不要照着手敲一个只含缺的那个组件的列表，那会把没列的已装组件卸掉。
- **卸载**：`usage/` 里有你自己的 `calibration.jsonl`、`usage-baseline.json` 时目录不会被收掉，数据留下。

**放行规则管不到派子代理**：`permissions.allow` 里写 `Agent` / `Agent(*)` / `Agent(general-purpose)` 在 auto 模式下会被 CLI 整条摘掉（判「危险规则」时不看括号内容），等于没写；子代理自己的工具调用也各自过分类器。查证过程、debug 日志原文和重验方法见 [TECH-LIBRARY §3](TECH-LIBRARY.md)；免拦的办法是临时切出 auto（Shift+Tab）。

**`configure.js` 单独用**

```bash
node ~/.claude/plugins/model-router/configure.js [--dry-run] [--yes] [--items=<名字，逗号分隔；也可以用编号>|all|none]
```

- `--dry-run` 只打印会做什么，不改任何文件；`--yes` 不问，按默认勾的来；`--items=…` 只做这几项（如 `--items=effort,fallback`），`all` = 全做，`none` = 都不做，给了就不再逐项问。也可以用编号，编号按屏幕上列出的顺序，不同平台可能不同（`pwsh` 只在 Windows 上列出），写脚本时用名字。
- 不给 `--items` 也不给 `--yes`：先列出每一项的状态，再问一次。回车 = 按 `[x]` 的来，输入编号 = 只要这几项，`0` = 一项都不要；输入已结束（管道、没有终端）时按默认。列表里 `[x]` 默认做，`[ ]` 默认不做，`[-]` 没有要做的（已配 / 保留 / 动不了）。
- 要先装好插件（有安装清单）；没有就提示先装，退出 1，什么都没改。
- 退出码：0 成功（含没有要改的、选了都不要）；1 失败（没装插件、`settings.json` 读不了、写后核对不一致）；2 参数不认识。

| 编号（Windows 上的顺序） | 名字 | 做什么 | 默认 |
|---|---|---|---|
| 1 | `subagent` | 删 `env.CLAUDE_CODE_SUBAGENT_MODEL`（有它时）；原因见上面「会静默失效的坑」 | 做 |
| 2 | `effort` | `modelSettings`：sonnet `high`、fable `xhigh`、opus `xhigh`、haiku `low`，只补缺的别名 | 做 |
| 3 | `fallback` | 顶层 `effortLevel` = `"high"`（`modelSettings` 没列到的模型用它） | 做 |
| 4 | `model` | 顶层 `model` = `"opus"`，本机没有才补 | 做 |
| 5 | `compact` | `autoCompactWindow` = `500000` | 不做（个人选择） |
| 6 | `cache` | `promptCacheTtl` = `"1h"` | 不做（Kimi、百炼、OpenRouter 等网关不支持 1h 缓存，按自己的网关定） |
| 7 | `pwsh` | `env.CLAUDE_CODE_USE_POWERSHELL_TOOL` = `"1"` | 不做（只在 Windows 上列出） |

- **已经配过的项不动**：每一项分三种状态——已配（同推荐）、已配（值不同，保留）、缺。值不同的一律不改，只在列表里标出差异（比如你自己把 sonnet 设成 `xhigh`，会写「已配（值不同，保留）…（推荐 …）」）；缺的才补。`effort` 一项里，四个别名各自判断，只补缺的那几个。唯一会删东西的是 `subagent`。
- **`ANTHROPIC_DEFAULT_*_MODEL` 只报告、不写**：没钉就提示一行「别名会用 CLI 内置的默认版本」。模型 ID 跟网关走，安装器猜错的代价是调用全失败，所以用 CC Switch 卡片或手动配。当前供应商不是 Claude 系、而 fable / opus / sonnet 里有没映射的，这一行改成 ⚠（会直接失败，不再另说一行 ℹ；判定见「6. CC Switch」末尾的「换供应商漏映射」）；只缺 haiku 不打 ⚠。
- **改之前备份**：`settings.json` 备份成 `settings.json.bak-model-router-<时间>`（同一秒撞名加 `-2`、`-3`），路径记进安装清单。备份后立刻比对、写回前重新读一遍：等输入期间 `settings.json` 被别的程序改了（CC Switch 切卡、你自己），按最新内容重算，不会拿旧内容覆盖。
- **写后核对**：沿用原文件的缩进、换行（CRLF）、BOM 和末尾换行；写完重读，把本次的改动撤回后必须和写之前一字不差（env 里只允许少掉 `CLAUDE_CODE_SUBAGENT_MODEL`、多出 `CLAUDE_CODE_USE_POWERSHELL_TOOL`），不一致就从备份恢复、退出 1。
- **输出里不出现密钥**：除上面两个键外，env 里的值一概不打印；`settings.json` 读不了时也不回显原文。
- **记进安装清单**（`<配置目录>/plugins/model-router/.install-manifest.json` 的 `settingsChanges`），卸载按它撤回。重跑只追加新的（`path`、`op`、值都一样的不重复记）：

```json
{ "path": ["modelSettings", "sonnet", "effortLevel"], "op": "add", "value": "high" }
{ "path": ["env", "CLAUDE_CODE_SUBAGENT_MODEL"], "op": "remove", "old": "<删之前的原值>" }
```

  `model` 和 `env.CLAUDE_CODE_SUBAGENT_MODEL` 这两类记录归 CC Switch 的卡片管，满足条件时还会带上 `"card": { "id": …, "name": … }`（当时的当前卡片），条件见「6. CC Switch」。

### 5. 配置目录（`CLAUDE_CONFIG_DIR`）

- **认哪个目录**：`install.js`、`configure.js`、`uninstall.js`、`setup.js`、`ccswitch-caps.js`、`provider.js`、`doctor.js`、`route-check.js`、`usage-audit.js` 都和 Claude Code 一样认环境变量 `CLAUDE_CONFIG_DIR`，没设就是 `~/.claude`。相对路径先解析成绝对路径；`setup` 解析后把绝对路径交给各步，所以换了当前目录也不会指到别处。菜单顶上那一行会写出实际装到哪。要和装的时候用同一个设置。
- **命令里的路径怎么写**：`commands/route.md` 里调用脚本的路径和放行规则必须一字不差，规则才匹配得上。配置目录是默认的 `~/.claude`（Windows、macOS 上不分大小写）时写 `~/.claude/plugins/model-router/<脚本>`，已装用户的规则和命令文件不变；在别处时写成插件目录的绝对路径（正斜杠；含空格等字符时整条脚本路径加双引号），部署 `commands/*.md`、`agents/*.md` 时把正文里的 `~/.claude/plugins/model-router/…` 换成这个写法，清单里记的 sha 是换过之后的。目录名里带引号、反引号、`$`、反斜杠字符的会被拒绝（命令里没法安全引用，什么都没改）。
- **清单记着装在哪**：`.install-manifest.json` 记 `configDir`（装在哪个配置目录）和 `pathToken`（脚本路径的写法）。换了位置重装，上次按旧写法加的放行规则按 `rulesAdded` 去掉。
- **配置目录整个复制或挪了位置**（做第二套配置、改名、搬家）：清单里的文件记的是绝对路径，照着删会删到原来那个目录。所以重装和卸载读到旧清单时，先按记下的 `configDir` 把路径换到当前配置目录下；旧清单没有 `configDir` 的，从清单里的 plugin 记录（`…/plugins/model-router/…`）或命令、子代理记录（上两级目录）反推；换不过来的留原样。删之前还要再判断一次，不在当前配置目录里的一律不删，打印「清单记录的 … 不在当前配置目录 … 里，没动」。结果：在复制出来的副本里装、重装或卸载，原配置目录里的文件不会被删；从挪过去的插件目录里重装，也能认出是上次装好的那份（副本模式），不会掉出清单。
- **CC Switch 只管默认的 `~/.claude`**：配置目录不是默认的时，`configure.js` 不记卡片、`uninstall.js` 不比对卡片（路径比较 Windows、macOS 上不分大小写，Linux 区分），有 CC Switch 时 `configure.js` 还会提醒一句「它默认写的是 `~/.claude`」。

### 6. CC Switch：哪些键切卡会变

CC Switch 新版（`~/.cc-switch/` 里有 `cc-switch.db` 和 `live-state.json`）用「投影」写 live 的 `settings.json`，不是整份替换。下面的分类依据 CC Switch 源码（`farion1231/cc-switch`），**没有在真实切卡里逐项实测**：

| 归谁 | 键 | 切卡时 |
|---|---|---|
| 归卡片（关键字段） | env 里所有 `ANTHROPIC_*`（含 `ANTHROPIC_DEFAULT_*_MODEL`、`_SUPPORTED_CAPABILITIES`）、`AWS_*`、`CLAUDE_CODE_SUBAGENT_MODEL`、OAuth 相关；顶层 `model`、`modelOverrides`、`apiKeyHelper`、`fallbackModel` 等 | 一律清空，再写新卡片自己的 |
| 归卡片（独有字段） | `CLAUDE_CODE_AUTO_MODE_SERVER`、env 版的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等兼容开关 | 先删上一张卡片带进来、且值没被改过的，再写新卡片的 |
| 归你 | 其余所有键：`modelSettings`、`effortLevel`、顶层 `autoCompactWindow`（注意和上面 env 版的同名不同位置）、`promptCacheTtl`、`permissions`、`hooks`、`CLAUDE_CODE_USE_POWERSHELL_TOOL` 等 | 原样保留 |

存回卡片时（切走时），只换关键字段和独有字段，卡片行里其余内容原样保留。由此：

- `modelSettings`、`effortLevel`、`autoCompactWindow`、`promptCacheTtl`、PowerShell 开关、安装器加的 `permissions.allow` ——**写本机 `settings.json` 一次就够，切卡不丢**。
- `model`、`ANTHROPIC_DEFAULT_*_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` ——**归卡片**：写进本机文件 = 写进当前卡片（切走时存回），别的卡片各有各的。某张卡片自己带着 `CLAUDE_CODE_SUBAGENT_MODEL`，切过去它就回来了、`code-reviewer` 又被静默降级。`configure.js` 因此在有 CC Switch 数据库时只读打开它（不写、不开写事务），列出 env 里带着这个键的卡片名（只打印卡片名），请你在 CC Switch 里删；要 Node 22.13+（`node:sqlite`），版本不够就只提示（18+ 也能装，只是读不了 CC Switch 卡片）。换到没配 `model` 的卡片（比如 DeepSeek），主模型回到 CLI 默认，这是 CC Switch 的设计。
- **旧版**（有 `cc-switch.db`、没有 `live-state.json`）切卡会整份覆盖本机 `settings.json`，`configure.js` 配的会被冲掉。`configure.js` 开头会打警告：要么升级 CC Switch，要么把这些设置同步进每张卡片。安装器只警告，不做卡片同步。
- **记下当时的卡片**：`configure.js` 改 `model` 或 `CLAUDE_CODE_SUBAGENT_MODEL` 时，如果有 `cc-switch.db`、配置目录是默认的 `~/.claude`，会只读查一次当前卡片（只取 id 和名字），记进这两类清单记录的 `card` 里；查不出（没有 `node:sqlite`、读库失败）就不记，并提醒「卸载前请先切回现在这张卡片」。卸载时用它，见下一节。

目前只实测适配了 DeepSeek，其他供应商还没适配；`/route` 按 CC Switch 当前卡片的模型映射走。

**换供应商漏映射（`doctor.js` ❌ / ⚠，`configure.js` ⚠）**

`/route` 各阶段只写别名（规划 `fable`、审查 `opus`、实现 `sonnet`），跟着当前卡片的映射走。切到非 Claude 系的卡片、而这几个别名里有没映射的：CLI 会拿内置的 Claude 模型 ID 去请求，这家没有这个模型，用这个别名的子代理直接失败，事前没有任何提示。切卡本身就会把 `ANTHROPIC_DEFAULT_*_MODEL` 整体换成新卡片自己的（见上面的表），新卡片漏写哪个，哪个别名就没映射。所以体检和配置两边都核一遍：

- **判定**：本机 `settings.json` 的 env 里，`ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`、`ANTHROPIC_MODEL` 有一个值（去掉 `[1m]` 之类的后缀）不以 `claude-` 开头，就算「不是 Claude 系」。`ANTHROPIC_MODEL` 写别名（`opus`、`sonnet[1m]`、`opusplan` 等）不算；全是 `claude-*`（中转 Claude 的网关没钉别名也能用内置 ID）或一个都没钉，不查。`doctor.js` 和 `configure.js` 各有一份一模一样的判定
- **`doctor.js`**（快速、完整模式都查，所以挂在 SessionStart 钩子上的 `--quick --quiet` 换完卡片下次开会话就会报）：`fable` / `opus` / `sonnet` 没映射（没写，或写成空串）各报一条 ❌，写明哪个别名、管哪个阶段（规划 / 审查 / 实现）、判成非 Claude 的依据（哪些键钉的是哪个模型 ID）和后果，下面一行是修法；`haiku` 没映射报 ⚠（CLI 的后台小任务用它，会去要 Claude 的模型）；四个都映射了打一行 ✅。有 ❌ 时退出码 1，只有 ⚠ 不影响
- **`configure.js`**：同样的判定，打一行 ⚠，点名没映射的别名和阶段，依据只写键名、不写值。只报告、不写：模型 ID 跟供应商走，猜错的代价是调用全失败
- **修法**：在 CC Switch 的卡片里把这个别名映射到这家的模型；没有 CC Switch 就在 `settings.json` 的 env 里写 `ANTHROPIC_DEFAULT_<别名>_MODEL`
- **Bedrock / Bedrock Mantle / Vertex / Foundry 不查**：env 里 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_MANTLE`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY` 任一为真（`1`、`true`、`yes`、`on`，不分大小写；JSON 里写成 `true` 或 `1` 也算）时整段跳过。这四个平台的模型 ID（`us.anthropic.claude-…`、`anthropic.claude-opus-4-7`、ARN）不以 `claude-` 开头，但 CLI 在这些平台上自己负责别名映射，别名没映射不会失败。`settings.json` 的 env 里写了这个变量就以它为准（写 `0` 就照常判），没写才看 shell 的环境变量。不能改成「ID 里含 `claude-` 就算 Claude」：OpenRouter 的 `anthropic/claude-…` 别名没映射照样失败，照常报
- 这段检查不打印 token、地址；`doctor.js` 的判定依据里会出现钉的模型 ID，`configure.js` 只出现键名

### 7. 卸载

```bash
node ~/.claude/plugins/model-router/uninstall.js [--dry-run] [--keep-ccswitch-caps] [--keep-card-settings]
```

也可以在安装入口菜单选 2，或 `setup uninstall …`。依据是插件目录里的 `.install-manifest.json`，没有它就说明不是 `install.js` 装的，什么都不做（手动安装的回滚见「回滚」一节）。配置目录要和装的时候用同一个（`CLAUDE_CONFIG_DIR`，见「5」）。

它做的事，按顺序：

1. **卡片预检**（动任何东西之前）：清单里 `model`、`CLAUDE_CODE_SUBAGENT_MODEL` 的记录带着配置时的卡片。CC Switch 现在的当前卡片不是那张，或查不出是哪张（没有 `node:sqlite`、读库失败），现在撤回会落到另一张卡片上，切走时被 CC Switch 存进那张卡片。因为卸载最后会删清单，只跳过这两条再删清单就再也撤不回，所以**整个卸载中止**：退出码 1，什么都没动（`--dry-run` 只提示「正式卸载会在这里中止」）。两条路：在 CC Switch 切回那张卡片再卸载；或加 `--keep-card-settings`。CC Switch 已经没有了（数据库不在）就照常撤回；配置目录不是默认的 `~/.claude` 时不做这一步。
2. **撤回 CC Switch 能力声明**（清单里有 `ccswitchCaps` 时，菜单 4 补的）：要先退出 CC Switch，检测不了它在不在运行时会问一次。撤不了的（没有 `node:sqlite`、数据库挪了位置等）记录留在清单里，整个卸载中止、什么都不动。出口：把数据库放回原处再卸载，或加 `--keep-ccswitch-caps`（补的留在卡片里，要去掉就在 CC Switch 的卡片里手动删）。
3. **删文件**：只删 `install.js` 放进配置目录的命令、子代理、插件目录文件，且装完后没被改过的（改过的不删，只提示）；不在当前配置目录里的一律不删。仓库本身就克隆在插件目录时不删仓库。
4. **`settings.json`**：去掉安装器加的放行规则（你自己原先加的不动），并按清单的 `settingsChanges` 撤回 `configure.js` 配过的键——和放行规则同一次读、同一份备份（`settings.json.bak-model-router-uninstall-<时间>`）、同一次写，写完把动过的键倒回去核对，其余内容一字不差：
   - 加的键（`op: add`）：现在的值仍是配置时的才去掉，改过的留着、只提示；删空了的父对象（如 `modelSettings` 里的 `sonnet: {}`）不删，留空对象；
   - 删的键（`op: remove`，即 `CLAUDE_CODE_SUBAGENT_MODEL`）：恢复成装之前的原值，但现在已经有了这个键（不管值是什么）就不动。恢复时会提醒「它会让子代理的 model 设置失效，体检会报」——这是把卸载做成「回到装之前的样子」，不想要它就自己删掉这一行；
   - env 里除这两个键外的值一律不打印。
5. 安装时做的备份 `*.bak-*` 一律不动，列出路径，要不要恢复由你定。

`--keep-card-settings`：`model`、`CLAUDE_CODE_SUBAGENT_MODEL` 这两项**一律不撤**（不管撤不撤得了，包括当前卡片就是记录的那张时），其余照常卸载。`--keep-ccswitch-caps`：跳过第 2 步。两个参数都可以和 `--dry-run` 一起给。

**停下时给的现成命令**：双击菜单传不了参数，所以卸载在上面两种情况（卡片预检、能力声明撤不了）停下，以及 CC Switch 正在运行时，会打印一行可以直接照抄的命令：

```text
命令行这样跑（双击菜单传不了参数）：node "<uninstall.js 的绝对路径>" --keep-card-settings
```

这次已经带的参数（含 `--dry-run`）原样保留，再加上要加的那个，去重——所以两种情况同时存在时，照着抄第二次会带上两个参数，不会来回绕。设了 `CLAUDE_CONFIG_DIR` 的话，会先写出「先把 `CLAUDE_CONFIG_DIR` 设成 <解析后的绝对路径>，再跑 …」（写绝对路径，不写 shell 语法）。CC Switch 正在运行时，提示退出它之后用同样的参数再卸载一次。

---

## 日常用法

### 轻流程三档（默认）

`/route` 先按改动规模分流，**小任务默认走轻流程**，不启动规划子代理：

| 档 | 判据 | 怎么做 |
|---|---|---|
| 微 | 一两行、单文件、不改逻辑（typo、调常量、纯查询） | 主会话直接改，攒批审 |
| **小（默认）** | 改动 ≤ 2 个文件、不改接口 / 数据结构、不需要先查证 | 主会话把任务、文件、验证命令写成 ≤ 10 行的 `.route-plan.md`（标「轻流程」），派 1 个 sonnet 包，审查照常 |
| 大 | 满足任一条：≥ 3 个文件、改接口 / 数据结构 / 迁移、要先查证现状、有多种做法要选、用户点名要规划 | 完整流程：planner 规划 → 你拍板 → 实现 → 审查 |

拿不准算哪一档时按「小」走。三档的判据和规矩以 `route.md` 阶段 0 为准。

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
            → 🟡 问你（S4）→ 🔴 ＋ 你批准的 🟡 一起派 sonnet 修 → 同一审查员复审一次（新发现编 N1…；只动 .md 的轮次只复审 🔴 的修复）
   ↓ 阶段 4.5：sonnet 写文档（描述修复后的代码）
   ↓ 阶段 5：清理临时文件（审查报告保留）· 不提交、不推送
汇报：问题 / 解法（含决定清单，每条谁定的）/ 现状（审查报告、修了哪几条、没验证的、未提交的改动）/ 一行模型核对
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

**`route-check` 那几行怎么读**：「版本 ≠ env」→ 会话中途改过 env 就正常，否则查哪里写死了版本号；「主会话窗口内有别的模型」→ 中途 `/model` 切过，告诉用户；「窗口内没有 planner-fable / code-reviewer」→ 本轮跳过规划或还没到审查就正常，否则检查时间戳。

**注意**：它判断「应跑哪个模型」的顺序是**进程环境变量 → `settings.json` 的 env**。在会话里跑（Bash 工具，`/route` 正常就是这么跑）拿到的是这个会话的实际映射；**事后换个终端核上一轮**只能读到 `settings.json`（CC Switch 卡片那套），用 `provider.js` 起的会话会被判成「模型用错」——那是核验方式的问题，不是真跑错。

**查子代理实际用了什么模型**——这是唯一可信的验证方式，不要靠界面显示或询问模型自己。首选 `route-check.js`（按 `message.id` 去重、逐个对照预期、有 ❌ 返回退出码 1）：

```bash
node ~/.claude/plugins/model-router/route-check.js                 # 当前会话（读 CLAUDE_CODE_SESSION_ID）
node ~/.claude/plugins/model-router/route-check.js --from 1760000000  # 只看这个时间戳之后有活动的记录（/route 开工时 date +%s 记下）
node ~/.claude/plugins/model-router/route-check.js --since 90      # 同上，换算成最近 90 分钟
node ~/.claude/plugins/model-router/route-check.js --session ff02  # 指定会话
node ~/.claude/plugins/model-router/route-check.js --from 1760000000 --full  # 没问题也打完整表（人工核对时用）
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

一键安装装的，优先用安装器卸载（见「安装 → 7. 卸载」）：它按安装清单撤回，包括 `configure.js` 配过的键。下面是手动回滚（手动安装、没有安装清单时用）：

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
- **模型：除 Claude 系外，目前只实测适配了 DeepSeek**，其他供应商还没适配；`/route` 按 CC Switch 当前卡片的模型映射走（做法见 README「换供应商」）。跨宿主（Codex）的调研结论在 [`TECH-LIBRARY.md`](TECH-LIBRARY.md)，09-30 搁置。
- **`fallbackModel` 写别名，不写具体模型**：值是别名列表（如 `["opus", "sonnet"]`），在当前会话里按 `ANTHROPIC_DEFAULT_*_MODEL` 解析（实测：`sonnet` 指向不存在的模型时，子代理落到 opus 映射的 `qwen3.8-max`），所以换中转站/换人都不用改这一行。它是**会话级的一个列表，不能给每个别名各配一份**。另外**必须写成数组**——写成字符串时 CLI 忽略整份 settings（env 里的别名映射一起丢，模型退回内置目录名）。
- **切换模型 / 供应商后的第一轮会重建缓存**：prompt cache 按模型绑定，映射一变整段失效、全量重写（测量见上文「实测得出的结论」第 2 条，单次切换约 13–16 万 token 全额重读）。所以切完那轮 `$/h` 偏高是预期；看 `usage-audit --rounds` 时别把第一轮当成回归。
- **auto 模式下的放行规则**：`Agent`、`SendMessage` 的 allow 规则会被 CLI 整条摘掉（见 [TECH-LIBRARY §3](TECH-LIBRARY.md)）；若服务端打开 `tengu_ant_yolo_equiv_strip_config`（yolo-equiv，默认关），auto 下连 Bash / PowerShell 的 allow 规则也会一起失效，安装器加的四条规则随之无效。
- **派子代理（Agent 工具）会被 auto 分类器拦，没有配置能绕开**：实测 10 轮里 Agent 被拦 14 次。改 allow 规则没用（上一条：规则在 auto 下被整条摘掉，根本到不了分类器），`disableAllHooks` 也没用。`/route` 的 **P10 措辞禁区**（prompt 里不写 key / token 的值，不写「隐藏文件」「绕过」「直连库」这类词，凭据只写环境变量名）只能把被拦的概率降下来，免不掉。被拦时按 P10 把原命令或 prompt 原样交给用户放行，**不要换写法重试**——换写法是绕过，也会让分类器更严。要彻底免拦只能临时切出 auto（Shift+Tab）。
- **原生插件市场（实验性）**：仓库带了 `.claude-plugin/marketplace.json`，`claude plugin marketplace add <仓库目录>` + `claude plugin install model-router@model-router-marketplace` 能装上，但命令前缀变成 `/model-router:route`、放行规则要自己加、`${CLAUDE_PLUGIN_ROOT}` 由 CLI 替换成**源目录**（不是安装后的插件目录）。日常仍推荐安装器（分组件、自动配放行规则和模型设置）。
- **中转站（new-api 系）实测**（10-28，只测了一家，别的中转站不一定一样）：
  - `/v1/messages` 的普通和流式请求，Claude、GPT、DeepSeek、GLM、Qwen、豆包、MiniMax 各系都通，响应里的 `model` 字段和请求一致；`/v1/messages/count_tokens` 全部 404（中转站没实现）。
  - 工具调用：Claude、DeepSeek、GLM、Qwen、豆包、MiniMax 都正常；**GPT 系不行**——中转站把它转成 chat completions、默认带推理，返回「带 reasoning_effort 的函数工具在 chat completions 里不支持」。`/route` 的子代理要靠工具干活，所以经这类中转站时，GPT 系目前不适合当子代理的模型（直连和别家中转未测）。
  - thinking 的写法各家不同，只列实测过的：Claude Sonnet 系只认 `adaptive` + `output_config.effort`（写 `enabled` 返回 400）；GPT 系三种写法都返回 200、但不返回 thinking 块；DeepSeek 三种写法都行、有 thinking 块；GLM / Qwen / 豆包 / MiniMax 的 thinking 写法没有单独测（工具调用时自带 thinking 块）。
  - 缓存：Claude 的 5 分钟 / 1 小时都正常；GPT 能读写缓存但不分 1 小时；DeepSeek 是自动缓存，没有 creation 字段。
  - 用量：能读到的是累计用量（`GET /v1/dashboard/billing/usage` 的 `total_usage`，纯 GET、不耗 token），读不到剩余余额（没设额度上限的 key，订阅接口只给一个默认的超大上限）。所以校准走「两次读数相减」（见「用量插件」），读数的**单位各家不同**，要在供应商文件的 `balance` 块里写 `unit`、或跑 `usage-balance.js` 时用 `--unit` 给（实测过的一家是 100 读数 = 1 美元，别家不要照搬）。
- **auto 模式分类器在非 Claude 主模型下**：分类器仍然走 Claude 模型。实测：主模型是 DeepSeek 系、`--permission-mode auto` 让它跑一条 `echo`，Bash 被正常执行，`modelUsage` 里出现了 Claude 系模型——所以网关上有 Claude 系模型时 auto 就能用。**推断（未实测）**：纯非 Claude 的网关（比如只接 DeepSeek 官方直连）分类器没有可用的模型，auto 下 Bash 会退化成「分类器不可用、停下来等人工放行」。
- **跨家族分工（provider.js）**：用 `provider.js` 把规划 / 审查 / 实现映射到不同家族，实测跑通一次完整 `/route`（实现子代理实际跑 GLM 系、审查子代理实际跑 DeepSeek 系，主会话是 DeepSeek 系，`.route-plan.md`、交接文件、审查报告都正常落盘）。**`route-check` 要在 `provider.js` 起的那个会话里跑才对**：它的别名映射先读进程环境、再读 `settings.json`；`provider.js` 用 `--settings` 套给会话的映射，只在这个会话（及其里面的 Bash）的环境里。会话里跑（`/route` 收尾自动跑的就是这种）判 ✅；在会话外，或者在另一个带着自己映射的 Claude 会话里，去核同一份 transcript，拿到的是别的映射，会把跨家族的子代理判成 ❌（「应跑 sonnet，实际跑的是 GLM 系的模型」）——这不是真的跑错，要核就回到那个会话里跑。
- **脚本化调用 `/route` 的坑**：Git Bash 里 `claude -p "/route …"`，MSYS 会把 `/route` 这个参数当成路径改写成 Git 安装目录下的 `route`，模型会照着那个路径去建文件。用 `MSYS2_ARG_CONV_EXCL="/route"`（环境变量，放在命令前面）关掉对它的改写，或者在交互式会话里跑。

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

1. **控制单个子代理的规模**（当前最大杠杆）。子代理上下文只增不减、没有 `/clear`，跑成 200+ 次调用的巨兽时每次调用的体量翻 2.6 倍（按当时的 EIU 折算）。三周里 6 个超标子代理合计约 $188。详见下面的用量插件一节。
2. **任务之间新开会话**。平均上下文 400k → 100k。⚠️ 但**追加需求不必赶用户去开新会话**——接住它、记进交接文档留到下一轮即可（`route.md` 阶段 0）。
3. **把读文件的活交给子代理**。这正是 `planner-fable` / `code-reviewer` 的价值——不只是"用对模型"，更是**抑制主上下文膨胀速度**。
4. **确认 `[1M]` 后缀的计价**。Anthropic 官方对超 200k 的部分有溢价（input 翻倍）。若平均上下文 398k，则全程在溢价区间。中转站是否照此计价需向其确认。

**已否掉、不要再提的两条**：主模型换 Sonnet（用户 09-15：「主会话习惯用 opus 了」，而且数据也不支持——Opus 主会话调用次数少 2.75 倍，每小时反而更便宜）；给 `planner-fable` 加读法限制（读得多规划才准，那正是它值钱的地方）。

---

## 用量插件：`usage-audit.js`（`plugins/usage/`）

v2.0.0 起用量统计是独立的 **usage 组件**（安装见「4. 安装 flow 与参数」的组件小节）：真脚本是 `usage-audit.js` 和 `usage-balance.js`，装好后在 `<插件目录>/usage/`，仓库里在 `plugins/usage/`。插件目录根部的 `usage-audit.js` 只是转发脚本，把参数和退出码原样交给真脚本，所以 v1.x 时写在 CLAUDE.md、放行规则里的旧命令（`node ~/.claude/plugins/model-router/usage-audit.js …`）照常可用；没装 usage 组件时它退出 2 并提示怎么装。下面的命令都按旧路径写，装好后用哪个路径都一样。

> **EIU（等效输入单位）已废弃。** 它是 v1.x 的固定权重体量指数，不是花费，v2.0.0 起报表只看 $、调用数和时长。旧基线里的 EIU 键只用来打一行提示，见下面「基线」。

usage-audit 给的是**迭代对比用的相对数**：$ 按公开价分项算，只含 transcript 里看得见的部分；实际花了多少，以网关账单或余额为准。看不见的那部分（权限分类器等）默认按 29% 补，也可以用 `usage-balance.js` 记两次读数，换成你自己实测的比例（见「校准」）。

**为什么需要它**：此前每次分析都临时写脚本，口径不固定，反复得出又推翻结论。踩过的六个口径陷阱：

| # | 陷阱 | 造成的错误结论 |
|---|---|---|
| 1 | **没按 `message.id` 去重** | 全部数字翻倍（重复率 ~52%）。同一次 API 响应会拆成多条 jsonl 行，每行都带完整 `usage` |
| 2 | 仪表盘口径与 transcript 口径混用 | cache read 386M vs 318M 放同一张表比 |
| 3 | 两天样本就下结论 | 任务难度差异被当成模型差异 |
| 4 | 只比总量不做归一化 | 工时多 0.8h 就被算成「更贵」 |
| 5 | **工时用 wall clock** | 含几小时空隙，`$/h` 被摊薄成假的「效率高」 |
| 6 | 只扫主会话 | 漏掉子代理的写操作，得出反向结论 |

### 口径定义（改 `usage-audit.js` 顶部就改了全部结论，慎动）

```
活跃工时 = 相邻调用间隔 ≤30 分钟才累加，超过视为休息
```

**$ 按公开价分项算**（10-22 起）：`PRICE` 每个模型是 `[输入, 输出, 读缓存, 写缓存]` 的 $/百万 token，5 系取自 CC Switch 的 `model_pricing`，网关按这个价扣；1 小时写缓存按输入价的 2 倍算。表里没有的模型按 `_default` 估，「模型构成」里会标出来，`--check` 也会报（见下）。EIU 时代那个「三个日花费反解的 $/百万 EIU」更早就废弃了，它比网关高估约 25%。

**看不见的那部分**：auto 模式的权限分类器、压缩之类的后台请求不写 transcript。10-09～10-22 网关总账比 transcript 多 29%，主要是分类器。日报和单日详解多打一行「网关实付估计」= 可见 $ ÷ (1 − 隐形占比)，没校准时隐形占比取 `HIDDEN_SHARE`（29%）；这个比例变了要重新对一次网关面板，或者直接用下面的校准。

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
node usage-audit.js --rounds            # 按 /route 轮看（见下「按 /route 轮看」）
node usage-audit.js --check             # settings.json 里 env 钉的模型有没有单价（只读，见下「--check」）
```

（上面省略了脚本路径，完整写法是 `node ~/.claude/plugins/model-router/usage-audit.js <参数>`。）记读数的脚本是 `usage/usage-balance.js`，见「校准」。

### 核心指标

| 指标 | 看什么 | 越低越好？ |
|---|---|---|
| **$/h** | 单位时间花费，按活跃工时算。**主指标**，含模型单价差异 | ✅ |
| **$/调用** | 平均每次请求的花费 → 查上下文膨胀 | ✅ |
| **子代理平均规模**（子均 $） | 拆得够不够细 | ✅ |
| **命中率** = `cr/(cr+cw)` | 缓存效率 | ❌ 越高越好 |
| **主会话占比**（按 $） | 有没有把活派出去 | 无绝对好坏 |

外加 **TTL 重建次数**（间隔 >5min 且 `cw>100k` 且 `cr=0` 的全量重建）——这是 route 模式的固有开销：主会话等子代理时 5 分钟 prompt cache TTL 必然过期。09-30 起主会话改成 1h TTL（见下文「缓存 TTL」），这一项应大幅下降；跟之前的数据比时记得这个变量。

### 按 /route 轮看（`--rounds`）

```bash
node usage-audit.js --rounds [--days N | --day <日期>] [--gap 分钟] [--session <会话前缀>] [--project <目录名>] [--json]
```

- **起点** = 一次 `/route` 启动：会话记录里的 `/route` 命令记录（带 `model-router:` 前缀的也认），或模型用 Skill 工具启动它的那次调用；改名前的旧名 `/dev`、`/automode` 照认。`/plan-fable` 只记事件、不切轮。同名且和上一个起点间隔不到 120 秒的只算一个（一次启动可能同时留下命令记录和 Skill 调用）。**终点** = 下一次起点。子代理按调用时间归轮。
- **空闲截断**：轮内相邻两次调用（含起点本身）间隔 ≥ `--gap` 分钟（默认 **120**，`--gap 0` 不截）就在那里截断，后面的调用归「/route 之外」。起点早于统计区间的轮，空闲从区间开头量起（区间开头之前的调用没收集，不能把「起点 → 区间开头」当成空闲）；这样的轮在开始时间前标 `*`，只含区间内的调用。
- **每轮一行**：可见 $、实付（见下）、活跃 h / wall h、规划 / 实现 / 审查 / 修复 / 文档 / 主会话各占几成（按 $）、审查条数（首轮 🔴 / 🟡 / 🔵 · 复审共几条 / 几轮，按 R / N 编号去重，取自审查员子代理的 transcript）、分类器拦截（被拦 / 不可用次数）和拦截率（分母是「会送分类器的工具调用」数，只是上界——命中放行规则的调用从 transcript 里看不出来）、子代理数、压缩次数。末尾有汇总、模型构成，和「/route 之外」一行（第一次起点之前、`--gap` 截断后的调用，另有没打过 /route 的会话也单列，不计入各轮）。
- **实付分摊**：没校准时这一列叫「$实付估」，校准过叫「$实付分摊」；值都是**该轮可见 $ ÷ (1 − 隐形占比)**。分母和隐形占比是同一口径，含 `/route` 之外的调用和没打过 `/route` 的会话（等价于该轮可见 $ × 读数段实付 ÷ 读数段可见 $）。记了 `--plan` 时这一列打「—」。
- 开头那行「N 次 API 调用（原始 M 行，去重率…）」的原始行只数统计区间内的；为校准多收的更早日期的行不算。
- `--json` 输出机器可读结构，校准结论在 `criteria.calibration`（`spentUsd`、`visibleUsd`、`hidden`、`projectVisibleUsd`、`sample`、`spanFrom` / `spanTo`；时间是 ISO 字符串，未校准时为 `null`；只有手填实付时是统计区间的起止）。

### 校准：把 29% 换成你自己实测的隐形占比

`usage-balance.js` 记一次「实付」读数（**你自己跑**；零成本，查的接口是纯 GET、不耗 token），追加到同目录的 `calibration.jsonl`（含个人用量，已在 `.gitignore`，不入库、不会被安装器复制或卸载删掉）。`usage-audit.js` 发现里面有读数，就用它算实付和隐形占比；没有这个文件就沿用 29%。

```bash
node ~/.claude/plugins/model-router/usage/usage-balance.js --provider <供应商名> [--key-env <变量名>] [--rate R] [--unit N]
node ~/.claude/plugins/model-router/usage/usage-balance.js --amount <数字> [--currency USD] [--rate R]
node ~/.claude/plugins/model-router/usage/usage-balance.js --plan
```

- **`--provider`**：现查一次，读 `switch/providers/<名>.json` 里的 `balance` 块（要装 switch 组件，没装就用 `--amount`）。两种接口：
  - 真余额接口（DeepSeek 的 `/user/balance` 那种）：记 `balance` 和币种。`deepseek.json` 里已经有写好的 `balance` 块（`url` / `method` / `auth` / `amountPath` / `currencyPath`）。
  - 累计用量接口（new-api 系中转站）：块里写 `"mode": "usage"`、`readingPath`（默认 `total_usage`）和 `unit`，记 `reading` 和 `unit`。**`unit` = 多少读数算 1 美元**，各家额度符号不同，不猜：写在供应商文件里，或者跑的时候用 `--unit` 给；都不给就只记读数、不折算 $。中转站的供应商文件含你自己的地址，仓库里不放，自己在 `switch/providers/` 下建。
  - key 只从环境变量读：用 `--key-env <变量名>`，不给就取供应商文件 `keyEnv[]` 里第一个有值的；这里只能填**变量名**（填成 key 本身会被拒绝、也不回显）。HTTP 跳转不跟随。整个过程只打印一行（`余额 … / 读数 … （已记录）`），出错只打状态码或错误码，不打地址、响应原文和 key。
  - `--rate R` = 1 美元等于多少该币种（余额不是 USD 时用来折算）。
- **`--amount`**：自己在网关面板上查到实付多少，手填。非 USD 的币种要带 `--rate`。
- **`--plan`**：包月套餐，只记一条，以后 $ 列打「—」。

**怎么算（`calibration()`、`finishCalib()`）**

1. **包月**：最近一条记录是 `--plan` 时，按包月套餐处理：日报、单日详解里的 $ 和 `--rounds` 的实付列打「—」，口径行写「包月套餐：只看 token / 调用数」；`--agents`、`--sessions`、`--ttl-sim` 的 $ 仍是公开价折算。
2. **接口读数的读数段 a → b**：
   - **b** = 统计区间内最后一条接口读数（`--day` 时不晚于当天结束）。区间内没有接口读数就没有 b，不校准。
   - **a 只在同一家供应商、同一种记法（余额 / 用量读数）的记录里找**，不同家、不同记法的读数绝不相减；这一家在 b 之前没有读数时写「读数不够两条」。
   - **连续段**：从 b 往前，方向一致就继续——读数往前只减不增，余额往前只增不减（相等算一致，余额币种变了算断点）；遇到读数被重置、余额被充值、换币种就停。断点只限制 a 最远能往前到哪。
   - 段内 **a 取统计区间开始前最近的一条，段里没有就取区间内最早的一条**。a 正好是连续段最早的一条、前面还有被断点挡住的读数时，口径行写「读数段从 X 起算（之前有一次重置或充值）」（断点是换币种时写「之前换过币种」）；b 紧挨着断点、段内只有 b 一条时未校准，提示再记一次读数。
   - 实付：余额 = a 的余额 − b 的余额；用量读数 = (b 读数 − a 读数) ÷ `unit`。不算数的情况只提示、不校准：余额没变 / 没减少（中途充值）、读数没增加 / 回退（额度被重置）、读数模式没给 `unit`（只报读数增加了多少、不折算）、非 USD 余额没给 `--rate`（只显示金额）。
   - **汇率**取 b 的 `--rate`，没有取 a 的，再没有取连续段里离 b 最近一条带 `--rate` 的；三处都没有才算「没给 `--rate`」。
   - **覆盖率**：读数段落在统计区间里的比例要 ≥ `CALIB_MIN_COVER`（**50%**），否则不拿它校准。a 在区间前、实付算得出但覆盖率不够时，改用连续段里区间内最早的一条再判断一次（比如 27 天前试过一次、之后隔很久才定期记，区间内那一对仍能用）；还不够就未校准，提示拉长 `--days` 盖住整个读数段，或在统计区间内再记一次读数。
3. **手填**：统计区间内的 `--amount` 求和；有读数段时只算落在 a→b 之内的，其余的在说明里写「有 N 条手填落在读数段之外，没计入」。读数段实付和手填实付相加。
4. **隐形占比** = 1 − 读数段内的可见 $ ÷ 实付，限制在 0–90%。**可见 $ 只取读数段内的调用**（为此会从读数段起点那天起多收 transcript，但日报、`--rounds` 等其余报表仍只算统计区间内的调用），分子分母是同一段时间。整个统计区间**只用这一个占比**，各报表共用，不按天分开算。读数段内没有可见调用就算不出来，退回未校准。
5. **`--project` 时**：读数是账号级的，所以隐形占比按**整个账号**（所有项目）在读数段内的可见 $ 算，再套到本项目；报表其余部分仍只算 `--project` 指定的那个项目，口径行会写明本项目占读数段可见 $ 的多少。
6. 算不出来时口径行写「未校准（原因），按 29.0% 补」，报表照旧用默认比例。

**口径行**（日报、单日详解、`--agents` / `--sessions` / `--ttl-sim`、`--rounds` 末尾都会打）校准成功时形如：

```
校准：读数段实付 ≈ $X（来源 api，读数段 MM-DD hh:mm → MM-DD hh:mm），该段可见 $Y → 隐形占比 Z%（只按这一段算一次、整份报表共用；读数段至少 50% 落在统计区间内才用）；样本：读数段 N 小时、可见 $Y、占本区间可见 $W 的 P%
```

用了读数时开头写「读数段实付」（它对应的是 a→b 这一段，不是整个统计区间），只有手填时写「手填实付」、不带读数段时间、没有样本行。

**样本行**写读数段多长、可见 $ 多少、占本区间可见 $ 的几成。读数段超出统计区间时写「可见 $Y（其中落在本区间 $Z）、占本区间可见 $W 的 P%」，P% 是落在区间内的那部分（$Z）占区间可见 $W 的比例，分子分母口径一致。**读数段不到 1 小时，或占本区间可见 $ 的比例低于 20%**，样本行末尾加「（样本短，仅供参考）」：照样校准，但这个占比只代表那一小段。

**方法限制（识别不出来，实付会算少）**

- 余额模式：两次读数之间**既充了值、净余额又在减少**。比如 a 读数 60，期间花了 20、又充了 10，b 读数 50：两条读数只看到净减少 10，实付算成 10，实际花了 20。
- 读数模式：两次读数之间**被重置、新读数又超过了旧读数**。比如 a 读数 600，重置后又用到 700，b 读数 700：只看到差 100，实际远不止，连续段识别不出中间的那次重置。
- 建议：定期记读数；**充值 / 重置前后各记一次**，让断点落在两条读数之间而不是里面。读数可能是账号级而不是 key 级（new-api 两种实现都有），测量期间不要用同一个账号的其他 key。

### 基线（`--baseline` / `--vs-baseline`）

- `--baseline` 把当前区间存成基线，写到脚本同目录的 `usage-baseline.json`（装好后在 `usage/` 下，不入库）。`--vs-baseline` 对比 `$/h`、`$/调用`、子代理平均规模、命中率、主会话占比，用 ✅ / ⚠️ 标好坏。单价表或工时判据变了会警告「口径已变，$ 的对比不可直接采信」。
- **旧基线回退读取**：v1.x 的基线存在插件目录根。新位置没有基线时，会回退去读旧位置（装好的布局是脚本上一级，原地模式 / 仓库里跑是上两级），并打一行「用的是旧位置的基线，下次 --baseline 会存到 usage/」；写永远只写新位置。
- **旧基线是 EIU 口径时**：打一行「旧基线含 EIU（v2.0.0 已废弃），已忽略 EIU 项，$ 列照常可比」。其中的**主会话占比**旧基线按 EIU 算、现在按 $ 算，口径不同，不相减，那一行标「口径不同（旧基线按 EIU），不可比」。

### `--check`：钉的模型有没有单价

```bash
node usage-audit.js --check
```

只读 `settings.json`（配置目录下，认 `CLAUDE_CONFIG_DIR`）里 env 的 `ANTHROPIC_DEFAULT_*_MODEL`，不扫 transcript。查价前先去掉 `[1M]` 之类的上下文后缀和 `claude-` 前缀（所以保留 `[1M]` 的配置不会误报）；都有价打「✅ env 钉的模型在单价表里都有价」，有缺的打「⚠ 单价表里没有 …，花费会按默认价估」并提示去 `PRICE` 补一行，两种都退出 0；`settings.json` 读不了或不是合法 JSON 退出 1。`doctor.js` 不再自己查单价表，只留一行指向它。

### 三周实测（`--days 22`）

| 期间 | 平均 $/h | 日均 $ |
|---|---|---|
| 纯 Opus（08-24~09-04，10 天） | **$32.9** | $244 |
| route 模式（09-07~09-15，7 天） | **$25.3** | $198 |
| **改善** | **−23%** | −19% |

> 当时还有一个已废弃的 EIU 口径（EIU/h 只降 14%），差额那 9pp 来自模型分配（Sonnet 单价低）；现在只看 `$/h`。
> **早先声称的「降 37%」是 wall clock 口径的高估**，改用活跃工时后真值是 23%。

**子代理规模分档（超线性证据）：**

| 调用次数 | 个数 | 相对体量（按当时的 EIU/调用折算，0–50 档 = 1） | 平均峰值上下文 |
|---|---|---|---|
| 0–50 | 71 | **1.00** | 116k |
| 50–100 | 45 | 1.16 | 215k |
| 100–200 | 13 | 1.39 | 301k |
| **200+** | 2 | **2.63** | **570k** |

「相对体量」来自已废弃的 EIU 口径（体量指数，不是花费）：量级可参考，不是 $ 倍数。

峰值上下文随调用次数线性增长，而总成本 ≈ 调用次数 × 平均上下文，所以是**平方级**。

最坏一例：09-15「构建 S9 P0 demo」——304 次调用、5h11m、上下文 31k→**703k**、≈ $72，占当天 39%，比整个主会话还多。工具分布 `Bash=112 Edit=92 Read=58`，即**在长时间反复调试**。

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
- **env 钉的模型在 `usage-audit.js` 单价表里有没有价**：v2.0.0 起这个检查搬进了 usage 组件（`node ~/.claude/plugins/model-router/usage-audit.js --check`，见「用量插件」），`doctor.js` 装了 usage 组件时只留一行指向它。没有价就按默认价估，账面会偏。10-09 sonnet-5-5 上线后没进表，按 $5.00 估了一周（sonnet-5 是 $4.10），sonnet 那部分虚高 22%

每轮 `/route` 结束还会跑 `route-check.js`，逐个子代理核对实际版本是否等于 env 当前钉的——env 改了但某个角色还停在旧版，当轮就会报出来。

⚠️ 09-30 修掉一个漏报：原先用 `startsWith` 判「已知模型」，`"claude-opus-5-5".startsWith("claude-opus-5")` 为真，换代新模型被当成已知。

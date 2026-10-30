# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## v2.0.3

日期：2026-10-30

### 变更

- 供应商文件支持 `fallbackModel`（数组，**推荐写别名** `["opus", "sonnet"]`，按当前会话的 `ANTHROPIC_DEFAULT_*_MODEL` 解析，换中转站不用改）：写进临时 settings 的顶层，原模型 503 / overloaded / 不存在时由 CLI 自动降级，**主会话和子代理都生效**（实测：`sonnet` 指向不存在的模型时，子代理请求落到 `glm-5.3` 并正常返回）。字符串写法会自动归一成数组

### 修复

- `route.md` 阶段 4「修复」：「收口」和「两轮后仍有 🔴（S6）」都编成了第 5 条，改成 5（S6）、6（收口）。收口改了四处：
  - 只动 `.md` / 措辞时 🟡 **照常按 S4 问你**（原来的「🟡 照修」可能被读成不问就修）
  - 只动 `.md` / 措辞时 **🟡 修完不再复审，🔴 修完只把那几处送同一个审查员复审一次**；修复改到了脚本就按「改了脚本」那半句走（原来的「只审一轮」既能读成不复审、也能读成复审一轮，修复自己带进来的问题可能没人看）
  - 改了脚本 / 配置时复审最多 2 轮，**第 2 轮复审新出的** 🟡🔵 写进下一轮待办、🟡 标「待用户决定」（你在 S4 选了不修的照旧记成已知问题，不进待办）
  - **🔴 不推迟、按 S6 停下**（原来的「第 3 轮的发现写进下一轮待办」把 🔴 也一起推迟了，和 S6 冲突）
- GUIDE「流程概览」补上例外：只动 `.md` 的轮次只复审 🔴 的修复
- GUIDE「验证」那段末尾残留的表格碎片「的，全 ✅ |」删掉（v2.0.2 挪段落时截下来的）
- GUIDE「已知边界」缓存重建那条，测量出处指错了节，改成「实测得出的结论」第 2 条
- GUIDE「为什么 /route 这样设计」里 v2.0.1、v2.0.2 补的三条实测依据，有的日期和事件在原始记录里找不到、有的引语顺序和次数写错了：改成能对上的来由，对不上的如实写「没有留下原始记录」；P10 那条的分项次数在原始记录里本身就加不齐（分项合计 6、总数 5），只保留总数和类别
- README 版本徽章从 v2.0.0 改成 v2.0.3（v2.0.1、v2.0.2 都漏改了）

### 文档

- 换模型 / 换供应商后第一轮要重建缓存的说明（`provider.js` 头注释、README「换供应商」、GUIDE「已知边界」）：v2.0.2 之后先进了 main，随本版一起发布
- README「换供应商」补 `fallbackModel` 的用法和「必须写成数组」这个坑（写成字符串会让整份 settings 失效，连 env 里的别名映射一起丢）
- GUIDE「已知边界」说明它是会话级、不能按别名分设

### 升级说明

- 装过的用户跑一次安装入口（`setup.cmd` / `setup.ps1` / `./setup.sh`）才会更新 `commands/route.md` 和插件脚本

## v2.0.2

日期：2026-10-29

### 变更

- 审查加**收口**（阶段 4 第 5 条）：本轮只动 `.md` / 措辞、没改脚本行为时**只审一轮** —— 🟡 照修，只剩 🔵 就收口，剩下的 🔵 写进报告「没修的及原因」由你定；改了脚本 / 配置仍按原流程，**最多审 2 轮**，第 3 轮的发现写进下一轮待办。为的是不再出现「一条规矩审三轮」那种情况
- `route.md` 腾出约 300 字节（上限只剩 94 字节）：把两处例子（主会话自己动手时的决定、S2 授权的覆盖范围）和 route-check 输出解读那一段挪进 GUIDE，**规则一条没删**

### 文档

- GUIDE「决策与提问」补两条实测依据（主会话自作主张、把 S2 授权当整轮免问）
- GUIDE「验证」补 route-check 的输出读法，并写明取值顺序（进程环境变量 → `settings.json`）：**事后换个终端核上一轮**时，用 `provider.js` 起的会话会被判成「模型用错」，那是核验方式的问题

### 升级说明

- 装过的用户跑一次安装入口（`setup.cmd` / `setup.ps1` / `./setup.sh`）才会更新 `commands/route.md`

## v2.0.1

日期：2026-10-29

### 变更

- `commands/route.md` 的 **P10 扩成「措辞与命令禁区」**：除了原有的 key / token / 口令与「隐藏文件」「绕过」「直连库」这类措辞，还明确子代理不把有副作用的操作拼进复合命令 —— 进度用 Edit 追加（不写 `echo >>`）、不写删除命令、不用 git 改工作区（restore / checkout / stash / reset 等）；确需时写进报告、接着做其余步骤，由主会话在**阶段 5 清理前**一次交给你执行
- 跑测试只认 P3 点名的命令：项目有固定测试脚本（你加过放行规则的）就只用它、单独一次调用，不拼 `cd`、不接管道或重定向；P3 由主会话写成不需要 `cd` 的单条形式（原来 P10 与 P3 会互相打架）
- 最后汇报第 3 条改成「交给你执行的命令（执行了没有、重跑 P3 的结果）」，避免把已经执行过的命令当成待办再执行一次

### 修复

- 复审 N1：交出命令、用户执行、重跑 P3 的时间点挪到阶段 5 清理**之前** —— 否则 `.route-plan.md` 和交接文件先被删，命令清单丢失、重跑失败也没规划可接
- 复审 N2：最后汇报那一栏不再叫「待你执行」（按流程写汇报时通常已经执行完）
- 未修 N3（🔵）：「末尾交给用户」这个 TaskCreate 标题在压缩后可能被读成「清理之后再交」；要「压缩过」且「没回看阶段 3 正文」同时成立，概率低

### 文档

- GUIDE「为什么 /route 这样设计」补 P10 的来由（10-29 被分类器拦 4 次、同一条规矩审了三轮）

### 升级说明

- 装过的用户跑一次安装入口（`setup.cmd` / `setup.ps1` / `./setup.sh`）才会更新 `commands/route.md`

## v2.0.0

日期：2026-10-29

### 变更

- 拆成三个插件：`model-router`（核心流程，仍在仓库根）、`model-router-usage`（`plugins/usage/`）、`model-router-switch`（`plugins/switch/`）；新增 `.claude-plugin/marketplace.json`（实验性，见「文档」）。装好后的布局是 `<插件目录>/usage/`、`<插件目录>/switch/`，原来的 `provider.js`、`ccswitch-caps.js`、`providers/` 从根目录搬进 `switch/`
- 安装器按组件装：`--components=core,usage,switch`（也认编号、`all`、`core`）；新装默认 core，检测到 CC Switch 时自动带 switch，**v1.x 升级（旧清单里没有组件记录）默认全装三个组件**，装过 v2 的沿用上次选择；`audit` 放行规则只在选了 usage 时才列出来；不给参数时先问一行组件（没有终端的非交互也按同样的默认走）；这样旧的 `usage-audit.js` 命令和已加的 `audit` 放行规则在 v1.x 升级后照常可用；`provider.js` / `ccswitch-caps.js` / `providers/deepseek.json` 升级后都在 `switch/` 下装好（不会只清掉旧文件却不装新的），但路径变了，见升级说明
- 从装好的插件目录跑安装入口（副本模式）：新勾的组件在源目录里找不到文件时，动任何文件之前就停（退出 2）并提示从仓库或解压目录跑；已装的组件这次没勾，副本模式不删文件，只打一行提示。根目录 `usage-audit.js` 转发脚本和 `setup caps` 发现组件没装时，提示里给的是 `--components=all`（`--components` 给的是完整的选择，只写缺的那一个会把已装的另一个卸掉）
- v1.x 时在旧 `providers/` 里自建的供应商 json：v2 只读 `switch/providers/`，安装器发现旧目录里有清单外的 json 时提示挪过去（只提示，不动文件）
- 组件文件是写死的清单（usage：`usage-audit.js`、`usage-balance.js`；switch：`provider.js`、`ccswitch-caps.js`、`providers/deepseek.json`），不递归复制：源目录里自己的本地数据（`calibration.jsonl`、`usage-baseline.json`、自建的供应商文件、编辑器备份）不会被装进插件目录、不记进清单，升级和卸载都不会覆盖或误删
- 根目录的 `usage-audit.js` 换成转发脚本：CLAUDE.md、放行规则、你记的老命令（`node ~/.claude/plugins/model-router/usage-audit.js …`）照常可用
- CC Switch 检测：只看 `~/.cc-switch`、Windows 的 `cc-switch.exe`、macOS 的 `CC Switch.app` 在不在（`existsSync`，不读任何文件）
- 用量插件（`plugins/usage/`）：
  - 起点识别同时认命令记录和 `Skill` 调用；默认在轮内空闲 120 分钟处截断（`--gap 0` 不截）
  - **EIU 废弃**：报表只看 `$`、调用数和时长；含 `eiuWeights` 的旧基线自动忽略 EIU 项（其中的主会话占比旧基线按 EIU 算、口径不同，标「不可比」、不相减），旧位置的基线自动回退读取（装好的布局、原地模式 / 仓库里跑都找得到）；口径不同的旧基线只比 `$` 项
  - 新增 `--rounds`：按 `/route` 轮看每轮 `$` / 耗时 / 阶段占比 / 审查条数 / 分类器拦截（`--json` 可机读）；「$实付分摊」= 该轮可见 `$` ÷ (1 − 隐形占比)，分母含 `/route` 之外的调用和没打过 `/route` 的会话；起点早于统计区间的轮，空闲从区间开头量起，不会被默认的空闲截断误截
  - 新增 `--check`：settings.json 里 env 钉的模型有没有单价（原 doctor 里的单价表检查，搬到 usage 组件）；查价前去掉 `claude-` 前缀和 `[1M]` 之类的后缀，保留 `[1M]` 的配置不会误报
  - 新增 `usage-balance.js`：记一次实付读数（new-api 中转站的累计用量、DeepSeek 那种真余额、`--amount` 手填、`--plan` 包月），读数按 `unit`（多少读数算 1 美元）折算，**各家的额度符号不同**，不写就不折算、只记读数，`usage-audit` 据此把「实付」和隐形占比校准出来；`--rounds` 在校准后多一列「$实付分摊」
  - 校准口径：实付是两次读数之间那一段（读数段）的实付，可见 `$` 也只取这一段里的调用，整份报表只用这一个隐形占比；读数只在同一家、同一种记法（余额 / 用量读数）之间相减；从最后一条读数往前找连续段，遇到额度重置、余额充值、换币种就停，口径行写「读数段从 X 起算」；起点优先取统计区间前最近的一条，段内没有再取区间内最早的一条；汇率取最后一条读数的、没有取起点的、再没有取连续段里最近一条带汇率的
  - 校准的门槛与提示：读数段至少 50% 落在统计区间里才用，覆盖率不够时改用区间内的那一对；读数段超出区间时，样本行写「可见 $X（其中落在本区间 $Y）」；读数段不到 1 小时或只占本区间可见 `$` 不到 20% 时，口径行加「样本短，仅供参考」；给了 `--project` 时隐形占比仍按整个账号在读数段内的调用算，再套到本项目；包月（`--plan`）时 `$` 列打「—」；有读数段时口径行写「读数段实付」（只手填时写「手填实付」），「N 次 API 调用（原始 M 行…）」只数统计区间内的行
- `route.md` 的脚本路径改成 `${CLAUDE_PLUGIN_ROOT}`：安装器部署时换成固定路径，原生插件安装时由 CLI 自己替换；新增 **P10 措辞禁区**（必带十条，原 P1–P9）
- `doctor.js`：命令文件里还留着没替换的 `${CLAUDE_PLUGIN_ROOT}`（不是安装器部署的）时给 ⚠；单价表检查搬进 usage 组件，core 不再依赖组件的文件
- `uninstall.js`：按组件找 `ccswitch-caps.js`（装好的副本在 `switch/`，原地模式在 `plugins/switch/`，兼容 v1.x 旧平铺）；收空目录的清单加上 `switch/providers`、`switch`、`usage`
- `setup.js`：透传 `--components`；菜单 4 和命令行 `caps` 在没装 switch 组件时给提示（exit 1）

### 文档

- README 仓库结构按三插件重画，安装一节补组件说明（含 v1.x 升级默认全装、组件文件写死清单、副本模式、`--components=all` 提示）与「实验性：原生插件市场」（放在安装一节最后），用法补 `usage-balance.js` 与校准要点；自定义供应商一节改成 `switch/providers/` 并说明 v1.x 旧文件要挪；手动安装说明补「`${CLAUDE_PLUGIN_ROOT}` 要换成 `~/.claude/plugins/model-router`，或直接用一键安装」；实测数据表去掉 EIU
- GUIDE 重做：「统一度量衡」改成「用量插件」（无 EIU、校准口径与方法限制、按轮、`--check`、基线）；手动复制说明补 `${CLAUDE_PLUGIN_ROOT}`；安装 flow 补组件小节；「已知边界」补 auto 模式下 Agent 被拦的实测结论、marketplace 实验性、中转站实测、分类器在非 Claude 主模型下的表现、跨家族分工里 `route-check` 要在会话内跑
- TECH-LIBRARY 新增「§4 原生 marketplace 实测」

### 升级说明

- **装过的用户跑一次安装入口**（`setup.cmd` / `setup.ps1` / `./setup.sh`）：会问装哪些组件。**v1.x 装的是全部功能，所以不带 `--components` 时默认全装三个组件**（usage、switch 都在，旧的 `usage-audit.js` 命令和老放行规则一字不差照常可用）；想要精简，输入编号只选要的。原 v1.x 平铺的 `provider.js` / `ccswitch-caps.js` / `providers/` 里没改过的会被自动清掉并换成 `switch/` 下的新版（改过的留着并提示），根目录 `usage-audit.js` 覆盖成转发脚本
- **`provider.js`、`ccswitch-caps.js` 的路径变了**：旧的 `node ~/.claude/plugins/model-router/provider.js …` 升级后会报找不到模块，改成 `node ~/.claude/plugins/model-router/switch/provider.js …`；`ccswitch-caps.js` 同理改到 `switch/`（用了别名或脚本的要自己改）。只有 `usage-audit.js` 在根目录留了转发脚本
- **自定义供应商文件要挪**：v1.x 时你在旧 `providers/` 里自己建的 json（如 `deepseek-pro.json`），v2 的 `provider.js` 和 `ccswitch-caps.js` 只读 `<插件目录>/switch/providers/`，要自己挪过去；安装器发现后会提示，但不会动它们
- 之后想补装某个组件：重跑安装入口时用 `--components=all`（三个全装、不会卸掉已装的）；`--components` 给的是完整的选择，别手敲只含缺的那一个的列表，没列的已装组件会被卸掉
- 原生 marketplace 路线仍是实验性：装完命令前缀是 `/model-router:route`，放行规则要自己加

## v1.1.0

日期：2026-10-28

### 变更

- `commands/route.md` 瘦身：404 行 / 40.7 KB → 232 行 / 32.5 KB，每条规则的来由和实测数据挪到 GUIDE「为什么 /route 这样设计」，规则一条没丢
- 轻流程成默认：按改动规模分「微 / 小 / 大」三档，「小」档（≤ 2 个文件、不改接口）不启动规划子代理，主会话写 ≤ 10 行的 `.route-plan.md` 后直接派一个 sonnet 包，审查照常
- 命令正文里的 `$40`、`$10` 改成文字（CLI 会把 `$` 紧跟数字当成参数替换，`$40` 会变成不存在的第 40 个参数）
- 装过的用户跑一次安装入口才会更新 `route.md`、`configure.js`、`doctor.js`

### 修复

- `configure.js`：`modelSettings` 里用完整模型 ID 作键（如 `claude-opus-5-5`）时也认，不再重复补别名键
- `doctor.js`：读命令文件失败不再直接崩；transcript 读失败的提示（v1.0.1 已有）措辞改了，不再泛指「上面几条」，改成点名完整模式里「子代理实测版本」「1h 缓存实测」「第三方模型实测」三项没算这些文件、结论可能不全；别名与完整 ID 指向同一模型，只在两条都配了 effort 时才提示
- 路径显示：`USERPROFILE` 用正斜杠时也能正确显示成 `~\.claude\…`

### 文档

- GUIDE 新增「为什么 /route 这样设计」（规则 → 实测依据两列），日常用法补轻流程三档表
- README 用法段补一句「小任务默认轻流程」

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

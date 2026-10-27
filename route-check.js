#!/usr/bin/env node
/**
 * route-check —— 核实一轮 /route 里每个子代理**实际**跑的模型和档位
 *
 * 配置说了不算，transcript 里的 message.model 和 "effort" 才是真相。
 * 这个脚本把「规划该跑 fable、审查该跑 opus、其余该跑 sonnet」逐个对一遍，
 * 跑错了当场报出来，不用等账单或者事后翻 transcript。约 0.5 秒，不花 token。
 *
 * 用法：
 *   node route-check.js --from <开工时间戳>   只看这个时间之后**有活动**的记录（/route 阶段 0 用 `date +%s` 记下）
 *   node route-check.js --since 90            同上，换算成「最近 90 分钟」
 *   node route-check.js                       不限时间：当前会话的全部记录
 *   node route-check.js --session <id前缀>     指定会话（默认读环境变量 CLAUDE_CODE_SESSION_ID）
 *   node route-check.js --from <时间戳> --full  没问题时也打完整表（人工核对时用）
 *
 * 输出：没有 ❌ 和 ⚠ 时只打一行（各角色个数 + 主会话当前上下文），有问题才打完整表——
 * 一轮 /route 要跑一二十次，每次整表进主会话上下文约 1 万 token，全是重复的 ✅。
 * 主会话上下文 = 最后一次调用送进去的 token 数，route.md 用它判断阶段边界要不要附压缩命令。
 *
 * 退出码：有 ❌ 返回 1。
 *
 * 判定规则（和 commands/route.md【模型路由】一一对应，改一边要改另一边）：
 *   planner-fable → fable    靠 frontmatter，不该传 model 参数（传了会覆盖 frontmatter）
 *   code-reviewer → opus     同上
 *   其余所有子代理 → sonnet   必须显式传 model: "sonnet"，不传就继承主会话
 *   主会话           → settings.model 的别名
 *   实际版本必须等于 env 里 ANTHROPIC_DEFAULT_<家族>_MODEL 当前钉的版本，对不上 = 有地方写死了旧版本号
 *
 * 时间窗按「有没有活动」过滤，不按首条记录：用 SendMessage 复用的老子代理，只要窗口内干过活就算进来，
 * 而且只统计它窗口内的那部分调用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const fromArg = Number(arg('--from')) || 0;          // epoch 秒
const sinceMin = Number(arg('--since')) || 0;
const from = fromArg ? fromArg * 1000 : (sinceMin ? Date.now() - sinceMin * 6e4 : 0);
const FULL = process.argv.includes('--full');

// 收工条款的「上百次」只约束实现、修复、文档子代理；规划和审查天然要读大量文件，豁免
const CALL_LIMIT = 100;
const CALL_LIMIT_EXEMPT = new Set(['planner-fable', 'code-reviewer']);

// ---------- 设置：别名 → 当前版本、effort 配置 ----------
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8')); } catch { /* 没有也能跑，只是少了版本比对 */ }
const bareId = (s) => String(s || '').replace(/\[\d+m\]$/i, '');
/** Bedrock 的模型 ID 可以是 inference profile 的 ARN，里面带 12 位 AWS 账号号码：只在打印前打码，比较、查表都用原值（各脚本各自内联这一行，单个脚本被拷走也能用） */
const maskArn = (s) => String(s).replace(/(arn:aws[\w-]*:[\w-]*:[\w-]*:)\d{12}(?=:)/g, '$1************');
/** 所有输出都经这里打码 */
const say = (s = '') => console.log(maskArn(s));
const famOf = (id) => (String(id).match(/^claude-([a-z]+)-/) || [])[1] || null;
// 别名 → 当前钉的模型。优先读进程环境：route-check 在会话里经 Bash 调用时，继承的就是这个会话实际生效的映射
// （CC Switch 切卡写进 settings.json 的，或启动脚本 provider.js 用 --settings 只套给这一个会话的）；在会话外跑才退回读 settings.json
const pinOf = (fam) => { const k = `ANTHROPIC_DEFAULT_${String(fam).toUpperCase()}_MODEL`; return bareId(process.env[k] || (settings.env || {})[k]) || null; };
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

/** 读 agent 文件 frontmatter 里的 effort */
function agentEffort(type) {
  try {
    const t = fs.readFileSync(path.join(CLAUDE_DIR, 'agents', `${type}.md`), 'utf8');
    return (t.match(/^effort:\s*(\S+)/m) || [])[1] || null;
  } catch { return null; }
}

/** 传了别名的子代理该用的 effort：modelSettings 别名键优先于完整 ID 键（09-30 实测），再退到全局 */
function configuredEffort(alias) {
  const ms = settings.modelSettings || {};
  const pin = pinOf(alias);
  return ms[alias]?.effortLevel || (pin && ms[pin]?.effortLevel) || settings.effortLevel || null;
}

const EXPECT = {
  'planner-fable': { fam: 'fable' },
  'code-reviewer': { fam: 'opus' },
};

// ---------- 定位会话 ----------
function findSession() {
  const want = arg('--session') || process.env.CLAUDE_CODE_SESSION_ID;
  if (want) {
    for (const d of fs.readdirSync(PROJECTS)) {
      let hit;
      try { hit = fs.readdirSync(path.join(PROJECTS, d)).find((f) => f.startsWith(want) && f.endsWith('.jsonl')); } catch { continue; }
      if (hit) return path.join(PROJECTS, d, hit);
    }
    return null;
  }
  // 兜底：当前目录对应的项目目录里最新的会话（同目录有并行会话时可能挑错，输出里会打印会话 ID）
  const dir = path.join(PROJECTS, process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}

/** 一个 transcript 在时间窗内的实际模型（含调用次数）、effort、去重后的调用数、窗口内首次活动时间、最后一次调用的上下文 */
function scan(file) {
  const perModel = {};            // 模型 → 去重后的调用数
  const efforts = new Set();
  const seen = new Set();
  let first = null, lastCtx = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m?.model || m.model === '<synthetic>') continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (from && ts < from) continue;
    if (o.effort) efforts.add(o.effort);
    // 同一次响应会拆成多行、每行都带 model，按 message.id 去重
    const key = m.id || o.requestId || `${o.timestamp}|${line.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    perModel[m.model] = (perModel[m.model] || 0) + 1;
    if (!first || ts < first) first = ts;
    const u = m.usage;
    if (u) lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return { perModel, models: Object.keys(perModel), efforts: [...efforts], calls: seen.size, first, lastCtx };
}

const fmtModels = (s) => s.models.length === 1 ? s.models[0]
  : s.models.map((m) => `${m}×${s.perModel[m]}`).join(' / ');

// ---------- 主流程 ----------
const main = findSession();
if (!main) {
  say('找不到会话 transcript。用 --session <id前缀> 指定。');
  process.exit(2);
}
const sid = path.basename(main, '.jsonl');
const subDir = path.join(path.dirname(main), sid, 'subagents');

const rows = [];
const tail = [];
let bad = 0, warnN = 0, mainCtx = 0;
const roleN = { planner: 0, reviewer: 0, other: 0 };
const hhmm = (ts) => ts ? new Date(ts).toTimeString().slice(0, 5) : '--:--';

// 主会话：窗口内只要有一条不是 settings.model 对应的版本就提醒（中途 /model 切过）
{
  const s = scan(main);
  mainCtx = s.lastCtx;
  // 主模型的优先级同 CLI：ANTHROPIC_MODEL 环境变量 > settings.model；值可以是别名，也可以是完整模型 ID（第三方供应商常这么写）。
  // 只有含 - 的才是完整模型 ID，才拿来逐条比对；opusplan、best、default 这类 CLI 合法别名不在上面四个里，实际跑哪个模型由 CLI 当场决定，
  // 没有固定的「应跑」，pin 留空、不比对（拿它当模型 ID 比，每次都会误报「中途切过」）
  const spec = String(process.env.ANTHROPIC_MODEL || (settings.env || {}).ANTHROPIC_MODEL || settings.model || 'opus');
  const alias = bareId(spec);
  const pin = ALIASES.includes(alias) ? pinOf(alias) : alias.includes('-') ? alias : null;
  const notes = [];
  const off = pin ? s.models.filter((m) => bareId(m) !== pin) : [];
  if (off.length) {
    notes.push(`⚠ 窗口内有 ${off.map((m) => `${m}×${s.perModel[m]}`).join('、')}，不是 ${alias}（${pin}）——中途用 /model 切过？`);
    warnN++;
  }
  rows.push({ t: hhmm(s.first), who: '主会话', expect: `${alias}（${pin || '?'}）`,
              actual: fmtModels(s) || '-', effort: s.efforts.join('/') || '-', calls: s.calls, notes });
}

let subs = [];
try { subs = fs.readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f)); } catch { /* 这个会话没开过子代理 */ }

const typesSeen = new Set();
for (const f of subs) {
  const file = path.join(subDir, f);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* 老版本 CLI 没有 meta */ }
  const s = scan(file);
  // 按活动过滤：窗口内一次调用都没有的子代理不算本轮（还没跑出第一次调用的也会被排除，跑完再查）
  if (from && !s.calls) continue;

  // 以插件形式启用时 agentType 可能带插件名前缀（model-router:planner-fable），去掉再比
  const type = String(meta.agentType || '?').replace(/^.*:/, '');
  typesSeen.add(type);
  roleN[type === 'planner-fable' ? 'planner' : type === 'code-reviewer' ? 'reviewer' : 'other']++;
  const rule = EXPECT[type];
  const fam = rule ? rule.fam : 'sonnet';
  const pin = pinOf(fam);
  const notes = [];

  // 判定：实际模型 = 这个别名当前钉的模型就对，不管是不是 Claude（第三方供应商把别名映射到 deepseek-flash 之类也成立）。
  // 不等时：Claude 家族对、只是版本不同 → ⚠（中途改过 env）；家族都不对、或第三方模型对不上 → ❌。
  // 几个别名钉同一个模型时（比如全映射到 deepseek-flash），「忘了传 sonnet、继承了主会话」查不出来，但跑的本来就是同一个模型，不算错
  if (!s.models.length) {
    notes.push('（还没有模型调用记录）');
  } else if (pin ? s.models.every((m) => bareId(m) === pin) : s.models.every((m) => famOf(m) === fam)) {
    /* 按设计跑 */
  } else if (pin && s.models.every((m) => famOf(m) === fam)) {
    notes.push(`⚠ 版本 ${fmtModels(s)} ≠ env 当前的 ${pin}（会话中途改过 env 就正常；否则查哪里写死了版本号）`);
    warnN++;
  } else {
    notes.push(`❌ 应跑 ${fam}${pin ? `（${pin}）` : ''}，实际 ${fmtModels(s)}` +
      (!rule && !meta.model ? '——没传 model 参数，继承了主会话' : '') +
      (rule && meta.model ? `——被传了 model: "${meta.model}"，覆盖了 frontmatter` : ''));
    bad++;
  }
  // 家族对了但传了参数：违反规矩、结果没错，提醒即可，不要因此去重跑
  if (rule && meta.model && !notes.some((n) => n.startsWith('❌'))) {
    notes.push(`⚠ 给 ${type} 传了 model: "${meta.model}"（违反「不传参数」的规矩，但实际模型正确，不用重跑）`);
    warnN++;
  }
  const wantEffort = rule ? agentEffort(type) : configuredEffort(fam);
  if (wantEffort && s.efforts.length && s.efforts.some((e) => e !== wantEffort)) {
    // 几个别名钉同一个模型时，CLI 分不清这个子代理是哪个角色，effort 会套成同模型别的别名的档位（10-26 DeepSeek 全映射 flash 实测：
    // sonnet 配 high，实际 xhigh）。实际档位落在同模型别名的配置里 → 只说明、不算提醒，免得每次都打整张表
    const shared = ALIASES.filter((a) => a !== fam && pin && pinOf(a) === pin);
    const sharedEfforts = new Set([...shared.map(configuredEffort), ...(shared.includes('fable') ? [agentEffort('planner-fable')] : []),
      ...(shared.includes('opus') ? [agentEffort('code-reviewer')] : [])].filter(Boolean));
    if (shared.length && s.efforts.every((e) => e === wantEffort || sharedEfforts.has(e))) {
      notes.push(`ℹ effort 实际 ${s.efforts.join('/')}、配置是 ${wantEffort}：${[fam, ...shared].join('/')} 钉的是同一个模型 ${pin}，CLI 分不开角色，不算跑错`);
    } else {
      notes.push(`⚠ effort 实际 ${s.efforts.join('/')}，配置是 ${wantEffort}`);
      warnN++;
    }
  }
  if (!CALL_LIMIT_EXEMPT.has(type) && s.calls > CALL_LIMIT) {
    notes.push(`⚠ ${s.calls} 次调用，超过收工条款的上百次`);
    warnN++;
  }
  rows.push({ t: hhmm(s.first), who: `${type}｜${(meta.description || '').slice(0, 24)}`,
              expect: `${fam}（${pin || '?'}）${rule ? '' : '·传 sonnet'}`,
              actual: fmtModels(s) || '-', effort: s.efforts.join('/') || '-', calls: s.calls, notes });
}

// 窗口里缺了关键角色就明说，别让「全部 ✅」变成假的安心
if (from) {
  if (!typesSeen.has('planner-fable')) tail.push('⚠ 窗口内没有 planner-fable 的活动（本轮跳过了规划就正常；否则检查 --from 是否晚于规划开始）');
  if (!typesSeen.has('code-reviewer')) tail.push('⚠ 窗口内没有 code-reviewer 的活动（还没到审查阶段就正常）');
}

rows.sort((a, b) => (a.who === '主会话' ? -1 : b.who === '主会话' ? 1 : a.t.localeCompare(b.t)));

const windowDesc = fromArg ? `  ·  自 ${new Date(from).toLocaleString('zh-CN', { hour12: false })} 起`
  : sinceMin ? `  ·  最近 ${sinceMin} 分钟` : '  ·  不限时间';
const ctxLine = `主会话当前上下文 ${Math.round(mainCtx / 1000)}k`;

// 没有 ❌、没有 ⚠ → 一行。缺规划 / 缺审查只是提示，个数写进这一行，0 个时附一句怎么看
if (!bad && !warnN && !FULL) {
  const zero = [];
  if (from && !roleN.planner) zero.push('规划 0 个：本轮跳过了规划就正常，否则查 --from 是否晚于规划开始');
  if (from && !roleN.reviewer) zero.push('审查 0 个：还没到审查就正常');
  const total = roleN.planner + roleN.reviewer + roleN.other;
  say(`✅ route-check  ·  会话 ${sid.slice(0, 8)}${windowDesc}  ·  ` +
    (total ? `子代理 ${total} 个（规划 ${roleN.planner} · 审查 ${roleN.reviewer} · 其余 ${roleN.other}）全部按设计跑，版本都是 env 当前钉的`
           : '窗口内还没有子代理，主会话模型正常') + `  ·  ${ctxLine}`);
  if (zero.length) say(`   （${zero.join('；')}）`);
  process.exit(0);
}

say(`route-check  ·  会话 ${sid}${windowDesc}\n`);
say('| 首次活动 | 谁 | 应跑 | 实际模型 | effort | 调用 | 结论 |');
say('|---|---|---|---|---|---|---|');
for (const r of rows) {
  say(`| ${r.t} | ${r.who} | ${r.expect} | ${r.actual} | ${r.effort} | ${r.calls} | ${r.notes.length ? r.notes.join('；') : '✅'} |`);
}
say();
for (const t of tail) say(t);
if (bad) say(`❌ ${bad} 处模型用错——在 /route、/plan-fable 流程里：这几个子代理的产出按「没按设计跑」处理，停下来问用户要不要重跑（route.md 停点 S7）。流程外有意指定别的模型的子代理不算`);
if (warnN) say(`⚠ ${warnN} 项提醒`);
if (!bad && !warnN && !tail.length) say('✅ 窗口内全部按设计跑：规划 fable、审查 opus、其余 sonnet，版本都是 env 当前钉的');
else if (!bad) say('没有用错模型的子代理');
say(ctxLine);
process.exit(bad ? 1 : 0);

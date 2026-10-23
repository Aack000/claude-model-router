#!/usr/bin/env node
'use strict';
/**
 * usage-audit —— Claude Code 用量统一度量衡
 *
 * 为什么要有这个工具：此前每次分析都临时写脚本，口径不固定，
 * 反复得出又推翻的结论（没去重、wall clock 当工时、只扫主会话…）。
 * 这里把口径钉死，让同一个问题每次算出同一个答案。
 *
 * 用法：
 *   node usage-audit.js                    最近 7 天日报
 *   node usage-audit.js --days 21          最近 21 天
 *   node usage-audit.js --day 2026-09-15   单日详解（含会话/子代理拆解）
 *   node usage-audit.js --agents [--days N]  子代理排行（查上下文膨胀）
 *   node usage-audit.js --sessions [--days N] 会话排行
 *   node usage-audit.js --baseline         把当前区间存为基线
 *   node usage-audit.js --vs-baseline      跟基线对比
 *   node usage-audit.js --json             机器可读输出
 *   node usage-audit.js --ttl-sim [--days N]  模拟缓存 TTL 改成 1 小时的得失
 *   node usage-audit.js --project <名>     只看某个项目目录
 */

const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const BASELINE = path.join(__dirname, 'usage-baseline.json');

// ───────────────────────── 口径定义（改这里就改了全部结论，慎动） ─────────────────────────

/**
 * EIU = Equivalent Input Unit（等效输入单位）
 * 按 Anthropic 官方价格比例把四类 token 折算到同一标尺：
 *   output 是 input 的 5 倍、cache write 1.25 倍、cache read 0.1 倍。
 * 好处：与模型无关，纯粹衡量"消耗了多少计算量"，跨天跨模型可比。
 */
const EIU = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

/**
 * 1 小时 TTL 的缓存写入权重（官方价是 input 的 2 倍，5 分钟的是 1.25 倍）。
 * 单列而不放进 EIU：放进去会让 --vs-baseline 误报"口径已变"。
 * usage 里 cache_creation.ephemeral_1h_input_tokens 有值时按这个权重计。
 */
const EIU_1H_WRITE = 2.0;

/**
 * 模型公开价（$/百万 token）：[输入, 输出, 读缓存, 写缓存（5 分钟）]。1 小时写缓存按输入的 2 倍算（官方比例）。
 * 5 系来自 CC Switch 的 model_pricing 表；10-22 对过网关面板，网关按公开价扣（Actual = Standard）。
 * 换掉了 09 月用三个日花费反解的「$/百万 EIU」：那套把四类 token 压成一个单价，
 * 10-20 估 $248、网关实付可见部分只有 $196——5-5 系读缓存只要输入的 5%，EIU 按 10% 算，读缓存越多高估越多。
 * 4 系是旧的官方价，只为算历史数据。
 */
const PRICE = {
  'opus-5-5': [4, 20, 0.20, 5],
  'opus-5': [5, 25, 0.50, 6.25],
  'sonnet-5-5': [2, 10, 0.10, 2.50],
  'sonnet-5': [2, 10, 0.20, 2.50],
  'fable-5-1': [10, 50, 0.25, 12.50],
  'haiku-5-5': [0.10, 0.50, 0.01, 0.125],
  'opus-4-8': [5, 25, 0.50, 6.25],
  'sonnet-4-6': [3, 15, 0.30, 3.75],
  'sonnet-4-5': [3, 15, 0.30, 3.75],
  'haiku-4-5': [1, 5, 0.10, 1.25],
  _default: [5, 25, 0.50, 6.25],
};

/**
 * 查单价：先原样查，再去掉日期后缀查（haiku-4-5-20251001 → haiku-4-5），都没有才落到 _default。
 * 落到 _default 的模型在「模型构成」里会标出来——10-09 sonnet-5-5 上线后没进表，
 * 按默认价估了一周，sonnet 部分虚高 22% 没人发现。doctor 也会查 env 钉的模型有没有单价。
 */
const priceKey = (model) => (model in PRICE ? model : String(model).replace(/-\d{8}$/, ''));
const isPriced = (model) => priceKey(model) in PRICE;
const priceOf = (model) => PRICE[priceKey(model)] ?? PRICE._default;
/** 一次调用的美元：四类 token 各按各的价，1h 写缓存按输入 2 倍 */
const usdOf = (r) => {
  const [pi, po, pr, pw] = priceOf(r.model);
  return (r.i * pi + r.o * po + r.cr * pr + (r.cw - r.cw1h) * pw + r.cw1h * pi * 2) / 1e6;
};
const priceLabel = (model) => { const [pi, po, pr, pw] = priceOf(model); return `$${pi}/${po}/${pr}/${pw}`; };

/**
 * 看不见的那部分：auto 模式的权限分类器、压缩之类的后台请求不写 transcript，这里统计不到。
 * 10-09～10-22 网关按模型的总账比 transcript 多 29%（$482，其中分类器约 $361），比例变了要重新对一次面板。
 */
const HIDDEN_SHARE = 0.29;

/**
 * 活跃工时判据：相邻两次 API 调用间隔 ≤ ACTIVE_GAP_MIN 分钟才算连续工作，
 * 超过就视为休息、不计入工时。
 * 为什么不用 wall clock（首末时间差）：09-09 首末跨 11.6 小时，
 * 其中有几小时空隙，会把 EIU/h 摊薄成假的"效率高"。
 */
const ACTIVE_GAP_MIN = 30;

// ───────────────────────── 参数 ─────────────────────────

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OPT = {
  days: parseInt(val('--days', '7'), 10),
  day: val('--day', null),
  agents: has('--agents'),
  sessions: has('--sessions'),
  baseline: has('--baseline'),
  vsBaseline: has('--vs-baseline'),
  json: has('--json'),
  project: val('--project', null),
  ttlSim: has('--ttl-sim'),
};

// ───────────────────────── 采集 ─────────────────────────

function* walkJsonl(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const eiuOf = (r) => r.i * EIU.input + r.o * EIU.output + (r.cw - r.cw1h) * EIU.cacheWrite + r.cw1h * EIU_1H_WRITE + r.cr * EIU.cacheRead;

/** 一条记录 = 一次真实的 API 调用（已按 message.id 去重） */
function collect(sinceDay) {
  const rows = [];
  const seen = new Map();   // 去重键 → 已收的那条
  let rawLines = 0;

  const root = OPT.project ? path.join(PROJECTS, OPT.project) : PROJECTS;
  for (const file of walkJsonl(root)) {
    const isSub = file.includes(`${path.sep}subagents${path.sep}`) || file.includes('/subagents/');
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (txt.indexOf('"usage"') === -1) continue;

    for (const line of txt.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (!m || !m.usage || !o.timestamp) continue;
      const day = o.timestamp.slice(0, 10);
      if (sinceDay && day < sinceDay) continue;
      rawLines++;

      // 去重：同一次 API 响应会被拆成多条 jsonl 行（thinking/text/tool_use 各一行），
      // 每行都带一份 usage。实测重复率约 52%，不去重全部数字翻倍。
      // 输出数要取同一条里最大的：子代理的第一行是流式写到一半的 output_tokens，比最后一行少 2–9 倍
      // （主会话各行相同）。10-22 前取第一行，子代理输出少算 3–9 倍，得出过「Sonnet 输出只占 5.4%」的错结论。
      const u = m.usage;
      const out = u.output_tokens || 0;
      const key = m.id || (o.requestId ? `${file}|${o.requestId}` : null);
      if (key) {
        const prev = seen.get(key);
        if (prev) { if (out > prev.o) prev.o = out; continue; }
      }

      const i = u.input_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      // 1h TTL 的写入单独计价（开了 promptCacheTtl / cacheTtl 之后才会有）
      const cw1h = Math.min(cw, u.cache_creation?.ephemeral_1h_input_tokens || 0);
      const model = (m.model || 'unknown').replace(/^claude-/, '');

      const row = {
        day, file, isSub, model,
        t: Date.parse(o.timestamp),
        i, o: out, cw, cr, cw1h,
        ctx: i + cw + cr,                                        // 本次送进去的上下文总量
        eiu: 0, usd: 0,                                          // 输出数可能被后面的行改大，收完再算
      };
      rows.push(row);
      if (key) seen.set(key, row);
    }
  }
  for (const r of rows) { r.eiu = eiuOf(r); r.usd = usdOf(r); }
  return { rows, rawLines };
}

// ───────────────────────── 度量 ─────────────────────────

/** 活跃工时（小时）：剔除超过 ACTIVE_GAP_MIN 的空隙 */
function activeHours(rows) {
  if (rows.length < 2) return rows.length ? 1 / 60 : 0;
  const ts = rows.map(r => r.t).sort((a, b) => a - b);
  const gapMs = ACTIVE_GAP_MIN * 60e3;
  let ms = 0;
  for (let k = 1; k < ts.length; k++) {
    const d = ts[k] - ts[k - 1];
    if (d <= gapMs) ms += d;
  }
  return Math.max(ms / 3600e3, 1 / 60);
}

function metrics(rows) {
  const m = { calls: rows.length, i: 0, o: 0, cw: 0, cr: 0, eiu: 0, usd: 0 };
  for (const r of rows) { m.i += r.i; m.o += r.o; m.cw += r.cw; m.cr += r.cr; m.eiu += r.eiu; m.usd += r.usd; }
  const main = rows.filter(r => !r.isSub);
  const sub = rows.filter(r => r.isSub);

  m.hours = activeHours(rows);
  m.wallHours = rows.length > 1 ? (Math.max(...rows.map(r => r.t)) - Math.min(...rows.map(r => r.t))) / 3600e3 : 0;
  m.hitRate = (m.cr + m.cw) ? m.cr / (m.cr + m.cw) : 0;

  // 派生指标 —— 这些才是能指导决策的
  m.eiuPerHour = m.eiu / 1e6 / m.hours;          // 单位时间烧钱速度（最核心的口径）
  m.usdPerHour = m.usd / m.hours;
  m.eiuPerCall = m.calls ? m.eiu / m.calls : 0;   // 单次调用的重量 → 查上下文膨胀
  m.cwPerCall = m.calls ? m.cw / m.calls : 0;     // 缓存重建频率 → 查 TTL 过期
  m.mainShare = m.eiu ? metrics0(main).eiu / m.eiu : 0;  // 主会话占比 → 查有没有把活派出去
  m.subCount = new Set(sub.map(r => r.file)).size;
  m.subEiu = metrics0(sub).eiu;
  m.subAvg = m.subCount ? m.subEiu / m.subCount : 0;      // 子代理平均规模 → 查拆得够不够细
  m.peakCtx = rows.length ? Math.max(...rows.map(r => r.ctx)) : 0;

  // 超 TTL 全量重建（间隔 >5 分钟且本次 cw 很大且缓存未命中）
  const byFile = {};
  for (const r of main) (byFile[r.file] ||= []).push(r);
  let ttlN = 0, ttlCw = 0;
  for (const rs of Object.values(byFile)) {
    rs.sort((a, b) => a.t - b.t);
    for (let k = 1; k < rs.length; k++) {
      if (rs[k].cw > 100e3 && (rs[k].t - rs[k - 1].t) > 300e3 && rs[k].cr === 0) { ttlN++; ttlCw += rs[k].cw; }
    }
  }
  m.ttlRebuilds = ttlN;
  m.ttlCw = ttlCw;

  m.byModel = {};
  for (const mod of new Set(rows.map(r => r.model))) {
    const g = rows.filter(r => r.model === mod);
    if (mod === '<synthetic>' || mod === 'unknown') continue;
    m.byModel[mod] = { calls: g.length, eiu: metrics0(g).eiu, usd: g.reduce((a, r) => a + r.usd, 0) };
  }
  return m;
}
/** 只算总量，不递归派生（避免无限递归） */
function metrics0(rows) {
  const m = { eiu: 0 };
  for (const r of rows) m.eiu += r.eiu;
  return m;
}

// ───────────────────────── 输出 ─────────────────────────

const M = n => (n / 1e6).toFixed(2);
const K = n => (n / 1e3).toFixed(1);
const pct = n => (n * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padStart(n);

function agentBrief(rows) {
  // agentId -> 派活描述（从主会话的 Agent 工具调用里抽）
  const map = {};
  const root = OPT.project ? path.join(PROJECTS, OPT.project) : PROJECTS;
  for (const file of walkJsonl(root)) {
    if (file.includes('subagents')) continue;
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (txt.indexOf('"Agent"') === -1) continue;
    const byToolId = {};
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') {
        for (const c of o.message?.content || []) {
          if (c.type === 'tool_use' && c.name === 'Agent') {
            byToolId[c.id] = { desc: c.input?.description || '?', type: c.input?.subagent_type || '?', model: c.input?.model || 'inherit' };
          }
        }
      } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
        for (const x of o.message.content) {
          if (x.type === 'tool_result' && byToolId[x.tool_use_id]) {
            const s = typeof x.content === 'string' ? x.content : JSON.stringify(x.content || '');
            const mm = s.match(/a[0-9a-f]{16}/);
            if (mm) map[mm[0]] = byToolId[x.tool_use_id];
          }
        }
      }
    }
  }
  return map;
}

function reportDaily(rows) {
  const days = [...new Set(rows.map(r => r.day))].sort();
  console.log('\n=== 日报（EIU = 等效输入单位，$ 为估算） ===');
  console.log('日期        调用  EIU(M)   $估算  活跃h  wall h  EIU/h   $/h   命中率  主%  子代理  子均EIU  EIU/调用  TTL重建');
  const out = [];
  for (const d of days) {
    const g = rows.filter(r => r.day === d);
    const m = metrics(g);
    if (m.eiu < 1e6) continue;
    out.push({ day: d, m });
    console.log(
      `${d}  ${pad(m.calls, 4)}  ${pad(M(m.eiu), 6)}  ${pad('$' + m.usd.toFixed(0), 6)}  ` +
      `${pad(m.hours.toFixed(1), 5)}  ${pad(m.wallHours.toFixed(1), 6)}  ${pad(M(m.eiu / m.hours), 5)}  ` +
      `${pad('$' + m.usdPerHour.toFixed(0), 5)}  ${pad(pct(m.hitRate), 6)}  ${pad((m.mainShare * 100).toFixed(0), 3)}%  ` +
      `${pad(m.subCount, 5)}   ${pad(M(m.subAvg), 6)}   ${pad(K(m.eiuPerCall), 7)}k  ${pad(m.ttlRebuilds, 5)}`
    );
  }
  // 汇总
  const all = metrics(rows);
  console.log('─'.repeat(128));
  console.log(`合计 ${days.length} 天  ${pad(all.calls, 5)}  ${pad(M(all.eiu), 6)}  $${all.usd.toFixed(0)}  ` +
    `${all.hours.toFixed(1)}h 活跃  均 ${M(all.eiu / all.hours)} EIU/h  $${all.usdPerHour.toFixed(0)}/h  命中 ${pct(all.hitRate)}`);
  console.log(`网关实付估计 ≈ $${(all.usd / (1 - HIDDEN_SHARE)).toFixed(0)}（上面只是 transcript 可见部分，分类器等后台请求按 ${pct(HIDDEN_SHARE)} 补；准数看网关面板）`);
  console.log('\n模型构成（按 EIU）:');
  for (const [mod, v] of Object.entries(all.byModel).sort((a, b) => b[1].eiu - a[1].eiu)) {
    console.log(`   ${mod.padEnd(14)} ${pad(M(v.eiu), 6)}M (${pad(pct(v.eiu / all.eiu), 6)})  $${v.usd.toFixed(0)}  公开价 ${priceLabel(mod)}${isPriced(mod) ? '' : '  ⚠ 单价表里没有，按默认价估'}`);
  }
  return out;
}

function reportAgents(rows) {
  const brief = agentBrief(rows);
  const groups = {};
  for (const r of rows) if (r.isSub) (groups[r.file] ||= []).push(r);
  const list = Object.entries(groups).map(([file, g]) => {
    const id = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const m = metrics(g);
    return {
      id, day: g[0].day, calls: m.calls, eiu: m.eiu, usd: m.usd,
      hours: m.wallHours, peak: m.peakCtx, eiuPerCall: m.eiuPerCall,
      model: [...new Set(g.map(r => r.model))].filter(x => x !== '<synthetic>').join(','),
      brief: brief[id] || null,
    };
  }).sort((a, b) => b.eiu - a.eiu);

  console.log('\n=== 子代理排行（查上下文膨胀） ===');
  console.log('日期   EIU(M)  $估算  调用  时长h  峰值ctx  EIU/调用  模型          任务');
  for (const a of list.slice(0, 25)) {
    console.log(`${a.day.slice(5)} ${pad(M(a.eiu), 6)}  ${pad('$' + a.usd.toFixed(0), 5)} ${pad(a.calls, 5)} ${pad(a.hours.toFixed(1), 6)} ${pad(K(a.peak), 7)}k ${pad(K(a.eiuPerCall), 8)}k  ${(a.model || '?').padEnd(13)} ${a.brief ? a.brief.desc.slice(0, 40) : '(无派活记录)'}`);
  }

  console.log('\n规模分档（验证超线性）:');
  const buckets = [[0, 50], [50, 100], [100, 200], [200, 1e9]];
  for (const [lo, hi] of buckets) {
    const g = list.filter(a => a.calls > lo && a.calls <= hi);
    if (!g.length) continue;
    const avgCalls = g.reduce((s, a) => s + a.calls, 0) / g.length;
    const avgEiu = g.reduce((s, a) => s + a.eiu, 0) / g.length;
    const avgPeak = g.reduce((s, a) => s + a.peak, 0) / g.length;
    console.log(`   ${String(lo + '-' + (hi > 1e8 ? '∞' : hi)).padEnd(9)} ${pad(g.length, 3)} 个  平均 ${pad(avgCalls.toFixed(0), 3)} 次 / ${M(avgEiu)}M  → ${K(avgEiu / avgCalls)}k EIU/调用  平均峰值 ${K(avgPeak)}k`);
  }
  const over = list.filter(a => a.calls > 150 || a.peak > 400e3);
  if (over.length) {
    console.log(`\n⚠️  ${over.length} 个子代理超标（>150 次调用 或 峰值 >400k），合计 ${M(over.reduce((s, a) => s + a.eiu, 0))}M EIU / $${over.reduce((s, a) => s + a.usd, 0).toFixed(0)}：`);
    for (const a of over) console.log(`   ${a.day.slice(5)} ${M(a.eiu)}M  ${a.calls} 次  峰值 ${K(a.peak)}k  ${a.brief ? a.brief.desc.slice(0, 44) : '?'}`);
  }
  return list;
}

function reportSessions(rows) {
  const groups = {};
  for (const r of rows) if (!r.isSub) (groups[r.day + '|' + r.file] ||= []).push(r);
  const list = Object.entries(groups).map(([k, g]) => {
    const m = metrics(g);
    return {
      day: k.split('|')[0], name: path.basename(k.split('|')[1]).slice(0, 8),
      calls: m.calls, eiu: m.eiu, usd: m.usd, hours: m.hours,
      peak: m.peakCtx, cwPerCall: m.cwPerCall, ttl: m.ttlRebuilds,
      models: Object.keys(m.byModel).join(','),
    };
  }).sort((a, b) => b.eiu - a.eiu);
  console.log('\n=== 主会话排行 ===');
  console.log('日期   会话     EIU(M)  $估算  调用  活跃h  峰值ctx  cw/调用  TTL重建  模型');
  for (const s of list.slice(0, 20)) {
    console.log(`${s.day.slice(5)} ${s.name} ${pad(M(s.eiu), 6)}  ${pad('$' + s.usd.toFixed(0), 5)} ${pad(s.calls, 5)} ${pad(s.hours.toFixed(1), 6)} ${pad(K(s.peak), 7)}k ${pad(K(s.cwPerCall), 7)}k ${pad(s.ttl, 6)}   ${s.models}`);
  }
  return list;
}

function reportDay(rows, day) {
  const g = rows.filter(r => r.day === day);
  if (!g.length) { console.log(`${day} 无记录`); return; }
  const m = metrics(g);
  console.log(`\n=== ${day} 详解 ===`);
  console.log(`总量      ${M(m.eiu)}M EIU  ≈ $${m.usd.toFixed(0)}   (${m.calls} 次调用；网关实付估计 ≈ $${(m.usd / (1 - HIDDEN_SHARE)).toFixed(0)}，含分类器等看不见的请求)`);
  console.log(`工时      活跃 ${m.hours.toFixed(1)}h / wall ${m.wallHours.toFixed(1)}h  → ${M(m.eiu / m.hours)}M EIU/h  ≈ $${m.usdPerHour.toFixed(0)}/h`);
  console.log(`缓存      命中率 ${pct(m.hitRate)}   cache write ${M(m.cw)}M   cache read ${M(m.cr)}M`);
  console.log(`          超 TTL 全量重建 ${m.ttlRebuilds} 次 / ${M(m.ttlCw)}M（占主会话 cw ${pct(m.ttlCw / (metrics(g.filter(r => !r.isSub)).cw || 1))}）`);
  console.log(`结构      主会话 ${pct(m.mainShare)}   子代理 ${m.subCount} 个 / 平均 ${M(m.subAvg)}M`);
  console.log(`单次      ${K(m.eiuPerCall)}k EIU/调用   峰值上下文 ${K(m.peakCtx)}k`);
  console.log(`\n模型构成:`);
  for (const [mod, v] of Object.entries(m.byModel).sort((a, b) => b[1].eiu - a[1].eiu)) {
    console.log(`   ${mod.padEnd(14)} ${pad(M(v.eiu), 6)}M (${pad(pct(v.eiu / m.eiu), 6)})  ≈ $${v.usd.toFixed(0)}`);
  }
}

// ───────────────────────── TTL 模拟 ─────────────────────────

/**
 * 回放历史调用，估算"如果缓存 TTL 是 1 小时"会怎样。
 *
 * 两股力量相反：
 *   省：间隔 5–60 分钟、本来因 TTL 过期全量重建的调用，前缀改为命中（1.25× → 0.1×）
 *   亏：所有缓存写入从 1.25× 涨到 2×（包括本来就命中、只写增量的调用）
 * 间隔 >60 分钟的照样过期，还要按 2× 重写——所以休息多的会话反而更亏。
 *
 * 近似：把"本次 cache_read < 上一次前缀的一半"当作过期重建；
 * 1h 下能命中的量取 min(上一次前缀, 本次可缓存总量)。不改变 input/output。
 */
function reportTtlSim(rows) {
  const W5 = EIU.cacheWrite, W1 = EIU_1H_WRITE, R = EIU.cacheRead;
  const scopeOf = r => {
    if (!r.isSub) return '主会话';
    if (r.model.startsWith('fable')) return '规划 fable';
    if (r.model.startsWith('opus')) return '审查 opus';
    return '实现 sonnet 等';
  };
  const byFile = {};
  for (const r of rows) (byFile[r.file] ||= []).push(r);

  const acc = {};
  const bucket = k => (acc[k] ||= { calls: 0, cur: 0, sim: 0, curUsd: 0, simUsd: 0, saved: 0, lost: 0, cw2: 0, cr2: 0 });
  for (const rs of Object.values(byFile)) {
    rs.sort((a, b) => a.t - b.t);
    for (let k = 0; k < rs.length; k++) {
      const r = rs[k], prev = rs[k - 1];
      const keys = [scopeOf(r), '合计'];
      const price = priceOf(r.model)[0] / 1e6;   // 缓存量已按 EIU 折成输入单位，乘输入价（近似：5-5 系读缓存实价只有输入的 5%）
      let cw2 = r.cw, cr2 = r.cr, saved = 0, lost = 0;
      if (prev) {
        const gap = r.t - prev.t;
        const prevPrefix = prev.i + prev.cw + prev.cr;
        const missed = r.cr < prevPrefix * 0.5;
        if (missed && gap > 5 * 60e3 && gap <= 60 * 60e3) {
          cr2 = Math.min(prevPrefix, r.cw + r.cr);
          cw2 = r.cw + r.cr - cr2;
          saved = 1;
        } else if (missed && gap > 60 * 60e3) {
          lost = 1;
        }
      }
      const cur = (r.cw - r.cw1h) * W5 + r.cw1h * W1 + r.cr * R;
      const sim = cw2 * W1 + cr2 * R;
      for (const key of keys) {
        const b = bucket(key);
        b.calls++; b.cur += cur; b.sim += sim; b.curUsd += cur * price; b.simUsd += sim * price;
        b.saved += saved; b.lost += lost; b.cw2 += cw2; b.cr2 += cr2;
      }
    }
  }

  const days = new Set(rows.map(r => r.day)).size;
  console.log('\n=== 缓存 TTL 模拟：5 分钟（现状） vs 1 小时 ===');
  console.log('只比较缓存部分（input/output 不受 TTL 影响）。$ 为估算，且假设网关按官方比例对 1h 写入收 2 倍。\n');
  console.log('范围            调用   现状缓存EIU  1h缓存EIU   差额      差额$    日均差额$  救回重建  >1h仍过期  盈亏平衡倍率');
  const order = ['主会话', '规划 fable', '审查 opus', '实现 sonnet 等', '合计'];
  for (const k of order) {
    const b = acc[k]; if (!b) continue;
    const d = b.sim - b.cur, dUsd = b.simUsd - b.curUsd;
    const mark = dUsd < -0.5 ? '✅' : dUsd > 0.5 ? '❌' : '  ';
    // 1h 写入倍率高于这个值就不划算（sim 对写入倍率是线性的）
    const be = b.cw2 ? (b.cur - b.cr2 * R) / b.cw2 : 0;
    console.log(`${mark} ${k.padEnd(12)} ${pad(b.calls, 5)}  ${pad(M(b.cur), 9)}M  ${pad(M(b.sim), 8)}M  ${pad((d >= 0 ? '+' : '') + M(d), 7)}M  ${pad((dUsd >= 0 ? '+$' : '-$') + Math.abs(dUsd).toFixed(0), 7)}  ${pad((dUsd >= 0 ? '+$' : '-$') + Math.abs(dUsd / days).toFixed(1), 8)}  ${pad(b.saved, 7)}  ${pad(b.lost, 8)}     ${be.toFixed(2)}×`);
  }
  console.log(`\n区间 ${days} 天。✅ = 开 1h 更省，❌ = 开 1h 更贵。`);
  console.log(`盈亏平衡倍率 = 网关对 1h 写入收费不超过 input 的这么多倍时仍然划算（官方是 ${W1}×，5 分钟是 ${W5}×）。`);
  console.log('开法：主会话 settings.promptCacheTtl / 子代理 settings.subagentPromptCacheTtl / 单个 agent 的 frontmatter cacheTtl。');
}

// ───────────────────────── 基线 ─────────────────────────

function snapshot(rows) {
  const all = metrics(rows);
  const days = [...new Set(rows.map(r => r.day))].sort();
  return {
    savedAt: new Date().toISOString(),
    range: { from: days[0], to: days[days.length - 1], days: days.length },
    price: PRICE,
    eiuWeights: EIU,
    activeGapMin: ACTIVE_GAP_MIN,
    totals: {
      calls: all.calls, eiu: all.eiu, usd: all.usd, hours: all.hours,
      eiuPerHour: all.eiu / all.hours, usdPerHour: all.usdPerHour,
      hitRate: all.hitRate, mainShare: all.mainShare,
      eiuPerCall: all.eiuPerCall, subAvg: all.subAvg, ttlRebuilds: all.ttlRebuilds,
    },
    byModel: all.byModel,
  };
}

function compareBaseline(rows) {
  if (!fs.existsSync(BASELINE)) {
    console.log(`没有基线文件，先跑：node ${path.basename(__filename)} --days N --baseline`);
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const now = snapshot(rows);
  console.log(`\n=== 对比基线 ===`);
  console.log(`基线 ${base.range.from} ~ ${base.range.to}（${base.range.days} 天，存于 ${base.savedAt.slice(0, 16)}）`);
  console.log(`当前 ${now.range.from} ~ ${now.range.to}（${now.range.days} 天）\n`);
  if (JSON.stringify(base.price) !== JSON.stringify(now.price) ||
      JSON.stringify(base.eiuWeights) !== JSON.stringify(now.eiuWeights) ||
      base.activeGapMin !== now.activeGapMin) {
    console.log('⚠️  口径已变（单价表 / EIU 权重 / 工时判据），$ 与 EIU/h 的对比不可直接采信\n');
  }
  const KEYS = [
    ['eiuPerHour', 'EIU/h（核心）', v => M(v) + 'M', true],
    ['usdPerHour', '$/h', v => '$' + v.toFixed(0), true],
    ['eiuPerCall', 'EIU/调用', v => K(v) + 'k', true],
    ['subAvg', '子代理平均规模', v => M(v) + 'M', true],
    ['hitRate', '缓存命中率', v => pct(v), false],
    ['mainShare', '主会话占比', v => pct(v), null],
  ];
  for (const [k, label, fmt, lowerBetter] of KEYS) {
    const b = base.totals[k], n = now.totals[k];
    if (b == null || n == null) continue;
    const d = (n - b) / (b || 1) * 100;
    const mark = lowerBetter === null ? '  ' : (lowerBetter ? (d < -2 ? '✅' : d > 2 ? '⚠️ ' : '  ') : (d > 2 ? '✅' : d < -2 ? '⚠️ ' : '  '));
    console.log(`${mark} ${label.padEnd(18)} ${pad(fmt(b), 9)} → ${pad(fmt(n), 9)}  ${(d >= 0 ? '+' : '') + d.toFixed(1)}%`);
  }
}

// ───────────────────────── main ─────────────────────────

function main() {
  const since = OPT.day
    ? OPT.day
    : new Date(Date.now() - OPT.days * 864e5).toISOString().slice(0, 10);

  const t0 = Date.now();
  const { rows, rawLines } = collect(OPT.day ? OPT.day : since);
  const scoped = OPT.day ? rows.filter(r => r.day === OPT.day) : rows;

  if (!scoped.length) { console.log('区间内没有用量记录'); return; }

  if (OPT.json) {
    console.log(JSON.stringify(snapshot(scoped), null, 2));
    return;
  }

  console.log(`usage-audit  ·  ${scoped.length} 次 API 调用（原始 ${rawLines} 行，去重率 ${pct(1 - scoped.length / rawLines)}）  ·  ${Date.now() - t0}ms`);
  console.log(`口径：EIU = in×1 + out×5 + cacheW×1.25 + cacheR×0.1  ·  活跃工时按间隔 ≤${ACTIVE_GAP_MIN}min 累加  ·  $ 按公开价分项算，只含 transcript 可见部分（网关实付约再多 ${pct(HIDDEN_SHARE / (1 - HIDDEN_SHARE))}）`);

  if (OPT.ttlSim) reportTtlSim(scoped);
  else if (OPT.day) reportDay(scoped, OPT.day);
  else if (OPT.agents) reportAgents(scoped);
  else if (OPT.sessions) reportSessions(scoped);
  else reportDaily(scoped);

  if (OPT.baseline) {
    fs.writeFileSync(BASELINE, JSON.stringify(snapshot(scoped), null, 2), 'utf8');
    console.log(`\n✅ 基线已存入 ${BASELINE}`);
  }
  if (OPT.vsBaseline) compareBaseline(scoped);
}

main();

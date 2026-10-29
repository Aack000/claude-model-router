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
 *   node usage-audit.js --rounds [--days N] 按 /route 轮看：每轮 $ / 耗时 / 阶段占比 / 审查条数 / 分类器拦截（--json 可机读）
 *       起点 = /route 启动（命令记录或 Skill 调用；旧名 /dev、/automode 照认），终点 = 下一次起点
 *   node usage-audit.js --rounds --gap 60 --session <会话前缀>   轮内空闲 ≥60 分钟处截断（默认 120，--gap 0 不截） / 只看某个会话
 *   node usage-audit.js --check            settings.json 里 env 钉的模型有没有单价（原 doctor 里的单价表检查，只读，exit 0/1）
 *
 * 报表只看 $、调用数和时长；$ 按公开价分项算，只含 transcript 可见部分。
 * 同目录 calibration.jsonl（由 usage-balance.js 记）有两次以上读数时，自动用它校准「实付」和隐形占比
 * （同一家、同一种记法的两次读数；隐形占比只用这两次读数之间的可见 $ 算，整份报表共用一个）；
 * 只记了一条 --plan 时按包月套餐处理（$ 列打 —）。没有这个文件就沿用 HIDDEN_SHARE。
 */

const fs = require('fs');
const path = require('path');

// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const BASELINE = path.join(__dirname, 'usage-baseline.json');

/** Bedrock 的模型 ID 可以是 inference profile 的 ARN，里面带 12 位 AWS 账号号码：只在打印前打码，比较、查表都用原值（各脚本各自内联这一行，单个脚本被拷走也能用） */
const maskArn = (s) => String(s).replace(/(arn:aws[\w-]*:[\w-]*:[\w-]*:)\d{12}(?=:)/g, '$1************');

// ───────────────────────── 口径定义（改这里就改了全部结论，慎动） ─────────────────────────

const LEGACY_BASE = { key: 'eiuWeights', note: 'ℹ 旧基线含 EIU（v2.0.0 已废弃），已忽略 EIU 项，$ 列照常可比' };   // EIU（等效输入单位）已于 v2.0.0 废弃：报表只看 $、调用数和时长；旧基线里的 EIU 键只用来给这行提示

/**
 * 缓存写入 / 读取相对输入价的比例，只给 --ttl-sim 用（那里要算「1 小时写入贵 2 倍」的得失）。
 * 1 小时 TTL 的写入是输入价的 2 倍（官方比例），5 分钟的是 1.25 倍，读缓存按 0.1 倍近似（实价按模型不同，见 PRICE）。
 */
const CACHE_RATIO = { write5m: 1.25, write1h: 2.0, read: 0.1 };

/**
 * 模型公开价（$/百万 token）：[输入, 输出, 读缓存, 写缓存（5 分钟）]。1 小时写缓存按输入的 2 倍算（官方比例）。
 * 5 系来自 CC Switch 的 model_pricing 表；10-22 对过网关面板，网关按公开价扣（Actual = Standard）。
 * 不再把四类 token 压成一个单价（09 月的旧做法 10-20 估 $248、网关实付可见部分只有 $196：5-5 系读缓存只要输入的 5%，
 * 按 10% 折算，读缓存越多高估越多），四类 token 各按各的价。
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
  // DeepSeek（Anthropic 兼容接口，10-26 取自 api-docs.deepseek.com 定价页）：高峰价；没有写缓存费，未命中按输入价算，所以第 4 项 = 输入价。
  // 非高峰减半，见 OFFPEAK_HALF。deepseek-v4-flash 是旧名，现由 flash 接管、按 flash 计价
  'deepseek-flash': [0.30, 1.20, 0.006, 0.30],
  'deepseek-v4-flash': [0.30, 1.20, 0.006, 0.30],
  'deepseek-v4-pro': [1.32, 3.96, 0.044, 1.32],
  _default: [5, 25, 0.50, 6.25],
};

/**
 * 分时计价的模型：PRICE 里是高峰价，非高峰减半。DeepSeek 高峰 = 周一到周五 UTC 01–04 点、06–10 点（北京 9–12 点、14–18 点）；
 * 中国法定节假日全天算非高峰，这里不认节假日，那几天会按高峰多估
 */
const OFFPEAK_HALF = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']);
const isDeepSeekPeak = (t) => { const d = new Date(t), h = d.getUTCHours(), w = d.getUTCDay(); return w >= 1 && w <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)); };

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
  const k = OFFPEAK_HALF.has(priceKey(r.model)) && r.t && !isDeepSeekPeak(r.t) ? 0.5 : 1;
  return k * (r.i * pi + r.o * po + r.cr * pr + (r.cw - r.cw1h) * pw + r.cw1h * pi * 2) / 1e6;
};
const priceLabel = (model) => { const [pi, po, pr, pw] = priceOf(model); return `$${pi}/${po}/${pr}/${pw}`; };

/**
 * 看不见的那部分：auto 模式的权限分类器、压缩之类的后台请求不写 transcript，这里统计不到。
 * 10-09～10-22 网关按模型的总账比 transcript 多 29%（$482，其中分类器约 $361），比例变了要重新对一次面板。
 */
const HIDDEN_SHARE = 0.29;

// ───────────────────────── 校准（usage-balance.js 记的读数 → 实付 / 隐形占比） ─────────────────────────

const CALIB_FILE = path.join(__dirname, 'calibration.jsonl');
let CALIB = null;          // 区间内的校准结论；main() 里算，报表跟着它走
let HID = HIDDEN_SHARE;    // 实际用的隐形占比：能校准时是算出来的，否则沿用 HIDDEN_SHARE
const PLAN = () => CALIB?.mode === 'plan';
const isoOrNull = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);   // JSON 里的时间：非有限数（Infinity）一律 null，别让 toISOString 抛错
const clampPct = (v) => Math.min(0.9, Math.max(0, v));

/** 读 calibration.jsonl（一行一条）；坏行跳过；按时间排序 */
function readCalib() {
  let txt;
  try { txt = fs.readFileSync(CALIB_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const t = Date.parse(String(r && r.at));
      if (r && typeof r === 'object' && Number.isFinite(t)) out.push({ ...r, t });
    } catch { /* 坏行跳过 */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 校准读数段（a→b）至少要有这么多落在统计区间里，才拿它校准。
 * 为什么：实付是 a→b 两次读数之间花的，隐形占比 = 1 − 这一段的可见 $ ÷ 这一段的实付；
 * 读数段大部分在统计区间之外（比如 27 天前那条读数配 7 天报表）时，这个比例代表不了统计区间，退回「未校准」。
 */
const CALIB_MIN_COVER = 0.5;

/**
 * 校准结论（读数 → 实付 / 隐形占比）。两种接口记法：
 *   balance（真余额接口，DeepSeek /user/balance 那种）：a 的余额 − b 的余额 = 花了多少
 *   reading（new-api 的累计用量接口）：读数增加多少 ÷ unit（unit = 多少读数算 1 美元；各家的额度符号不一样，记的时候没给就只报读数差）
 * 选 a、b：b = 统计区间内最后一条接口读数（--day 时不晚于当天结束）；a 只在同一家（provider）、同一种记法（mode）的记录里找，且只在「连续段」里找：
 *   从 b 往前，方向一致就继续（读数往前只减不增、余额往前只增不减，相等算一致；余额币种变了也算断点），遇到重置 / 充值 / 换币种就停，断点只限制 a 最远能往前到哪。
 *   连续段里 a 取统计区间开始前最近的一条，没有就取段里区间内最早的一条（没有重置 / 充值时和原来的选法一样）；
 *   用的 a 正好是连续段最早的一条、且前面还有被断点挡住的读数时，口径行写「读数段从 X 起算（之前有一次重置或充值）」（断点是换币种时写「之前换过币种」）；b 前面紧挨着就是断点、段里只有 b 一条时未校准。
 *   非 USD 余额的汇率取 b 的 --rate、没有取 a 的、再没有取连续段里离 b 最近一条带 --rate 的；三处都没有才「没给 --rate」。
 *   a → b 落在统计区间里的比例不够 CALIB_MIN_COVER 且 a 在区间前时，改用这一连续段里区间内最早的一条再判断一次。不同家 / 不同记法的读数绝不相减。
 * manual（--amount 手填）：没有读数 a→b 时在统计区间内求和；有读数时只算落在 a→b 内的，其余在 note 里说明。币种不是 USD 时按记录里的 --rate 除。
 * 返回 null（没有记录）/ { mode:'plan' } / { mode:'api'|'manual'|'api+manual', spentUsd, source, spanFrom, spanTo, note? }
 *   spanFrom / spanTo = 这笔实付对应的时间段（api：a.t→b.t；只有手填：整个统计区间）。main() 用它收齐这一段的 transcript，
 *   只拿这一段的可见 $ 算隐形占比（finishCalib），不是整个统计区间的。
 * win = { from, to }（毫秒；to 可以是 Infinity）。
 */
function calibration(win) {
  const recs = readCalib();
  if (!recs.length) return null;
  if (recs[recs.length - 1].source === 'plan') return { mode: 'plan' };
  const { from, to } = win;
  const toUsd = (v, cur, rate) => (String(cur || 'USD').toUpperCase() === 'USD' ? v : (Number(rate) > 0 ? v / Number(rate) : null));
  const notes = [];
  // 接口读数
  let apiUsd = null, span = null;
  const api = recs.filter((r) => r.source === 'api' && Number.isFinite(r.t));
  const modeOf = (r) => r.mode || (Number.isFinite(r.reading) ? 'usage' : 'balance');
  const b = api.filter((r) => r.t < to).pop();
  if (b && b.t >= from) {
    const before = api.filter((r) => r !== b && r.t < b.t && (r.provider ?? '') === (b.provider ?? '') && modeOf(r) === modeOf(b));   // b 之前同一家同一记法的读数，时间升序
    // 连续段：从 b 往前，方向一致就继续（读数往前只减不增，余额往前只增不减；相等 = 没流量，算一致；余额的币种变了也算断点），
    // 遇到第一个不一致的（读数被重置 / 余额被充值 / 换了币种）就停，那条之后的一条就是这一段最早的一条 a
    const curOf = (r) => String(r.currency || 'USD').toUpperCase();
    const stepOk = (p, n) => {
      if (Number.isFinite(p.reading) && Number.isFinite(n.reading)) return p.reading <= n.reading;
      if (Number.isFinite(p.balance) && Number.isFinite(n.balance)) return curOf(p) === curOf(n) && p.balance >= n.balance;
      return false;
    };
    let si = before.length;
    while (si > 0 && stepOk(before[si - 1], si === before.length ? b : before[si])) si--;
    const seg = before.slice(si);          // 连续段里 b 之前的读数（时间升序）；seg[0] = a
    const brokeAt = si > 0;                // a 前面还有同一家同一记法的读数、只是方向不一致 = 停在了重置 / 充值 / 换币种点
    // 断点原因：余额的币种变了 = 换币种（提示措辞不同）；其余（读数被重置 / 余额被充值）= 重置或充值
    const brokeByCur = brokeAt && (() => {
      const p = before[si - 1], n = si === before.length ? b : before[si];
      return Number.isFinite(p.balance) && Number.isFinite(n.balance) && curOf(p) !== curOf(n);
    })();
    // 非 USD 余额的汇率来源：b 的 → a 的 → 连续段里离 b 最近一条带汇率的（记读数时汇率时带时不带也能折算）
    const segRate = (() => { for (let i = seg.length - 1; i >= 0; i--) if (Number(seg[i].rate) > 0) return Number(seg[i].rate); return 0; })();
    if (!before.length) {
      notes.push(`区间内「${b.provider || '未记名'}」这一家的读数不够两条，先跑两次 usage-balance.js；各家分开算，不拿两家的读数相减`);
    } else if (!seg.length) {
      notes.push(`区间内「${b.provider || '未记名'}」这一家在最近一次${brokeByCur ? '换币种' : '重置 / 充值'}之后（${localStamp(b.t)} 起）只有这一条读数，不够两条；再记一次读数（usage-balance.js）就能校准`);
    } else {
      // 用 a、b 两条读数算这一段的实付，和这一段落在统计区间里的比例
      const evalPair = (a) => {
        let note = null, usd = null;
        if (Number.isFinite(a.reading) && Number.isFinite(b.reading)) {
          // unit = 「多少读数算 1 美元」：各家中转站的额度符号不一样，记的时候没给就不折算，只报读数差
          const unit = Number(b.unit) > 0 ? Number(b.unit) : 0;
          const d = b.reading - a.reading;
          if (!(d > 0)) {
            note = d === 0
              ? `读数没增加（${a.reading} → ${b.reading}），这段时间没有流量，无法校准`
              : `读数回退了（${a.reading} → ${b.reading}，额度被重置？），无法校准`;
          } else if (!unit) {
            note = `读数增加了 ${d}，但这家没给 unit（多少读数算 1 美元，各家不一样），只报读数不折算 $`;
          } else usd = d / unit;
        } else if (Number.isFinite(a.balance) && Number.isFinite(b.balance)) {
          const cur = String(b.currency || a.currency || 'USD').toUpperCase();
          const rate = Number(b.rate) || Number(a.rate) || segRate;
          if (a.balance === b.balance) note = `余额没变（${a.balance} → ${b.balance}），这段时间没有消耗，无法校准`;
          else if (a.balance - b.balance < 0) note = `余额没减少（${a.balance} → ${b.balance}，中途充值？），无法校准`;
          else {
            const v = toUsd(a.balance - b.balance, cur, rate);
            if (v === null) note = `余额币种 ${cur} 不是 USD、没给 --rate，只显示金额不校准`;
            else usd = v;
          }
        }
        const cover = usd !== null ? (Math.min(b.t, to) - Math.max(a.t, from)) / (b.t - a.t) : null;
        return { a, note, usd, cover };
      };
      // 断点只限制 a 最远能往前到哪；连续段里 a 仍取「区间开始前最近的一条」，没有就取段里区间内最早的一条
      let pick = evalPair(seg.filter((r) => r.t < from).pop() || seg[0]);
      // a 在区间前、算得出实付但覆盖率不够（比如 27 天前试过一次、之后隔很久才定期记录）：
      // 改用这一连续段里区间内最早的一条再判断一次（只在连续段内找，不越过重置 / 充值点）。算不出实付的情况连续段里已经没有别的可试
      // （重置 / 充值 / 换币种都已经是断点），只有「读数没增加 / 没给 unit」这类，换一条 a 结论一样
      if (pick.usd !== null && pick.cover < CALIB_MIN_COVER && pick.a.t < from) {
        const a1 = seg.find((r) => r.t >= from);
        if (a1) {
          const alt = evalPair(a1);
          if (alt.usd !== null) pick = alt;
          else if (alt.note) notes.push(`区间内最早的一对：${alt.note}`);
        }
      }
      if (pick.note) notes.push(pick.note);
      if (pick.usd !== null) {
        if (pick.cover < CALIB_MIN_COVER) {
          notes.push(`读数段 ${localStamp(pick.a.t)} → ${localStamp(b.t)} 只有 ${(pick.cover * 100).toFixed(0)}% 落在统计区间里，要求至少 ${CALIB_MIN_COVER * 100}%，不拿它校准；拉长区间（--days）盖住整个读数段，或在统计区间内再记一次读数（区间内有两条同一家的读数，就改用区间内这一对）`);
        } else {
          apiUsd = pick.usd; span = { from: pick.a.t, to: b.t };
          if (brokeAt && pick.a === seg[0]) notes.push(`读数段从 ${localStamp(pick.a.t)} 起算（${brokeByCur ? '之前换过币种' : '之前有一次重置或充值'}）`);
        }
      }
    }
  }
  // 手填：有读数段就只算落在段内的，没有就算整个统计区间
  const mFrom = span ? span.from : from, mTo = span ? span.to : to;
  let manualUsd = 0, manualN = 0, outside = 0;
  for (const r of recs) {
    if (r.source !== 'manual' || !Number.isFinite(r.amount)) continue;
    if (!(r.t >= from && r.t < to)) continue;
    if (!(r.t >= mFrom && r.t <= mTo)) { outside++; continue; }
    const v = toUsd(r.amount, r.currency, r.rate);
    if (v === null) { notes.push(`手填的币种 ${r.currency} 不是 USD、没给 --rate，只显示金额不校准`); continue; }
    manualUsd += v; manualN++;
  }
  if (outside) notes.push(`有 ${outside} 条手填落在读数段之外，没计入`);
  const spentUsd = (apiUsd || 0) + manualUsd;
  const source = apiUsd !== null ? (manualN ? 'api+manual' : 'api') : (manualN ? 'manual' : null);
  const note = notes.length ? [...new Set(notes)].join('；') : undefined;
  if (!source) return { mode: 'api', spentUsd: 0, note: note || '区间内的校准记录不够两条（先跑两次 usage-balance.js）' };
  // 只有手填、没有读数段时，这笔实付对应整个统计区间；不带 --day 时区间终点是 Infinity，换成「现在」（JSON / 时间戳都要有限数）
  return { mode: source, spentUsd, source, spanFrom: span ? span.from : from, spanTo: span ? span.to : (Number.isFinite(to) ? to : Date.now()), api: !!span, note };
}

/**
 * 收齐 transcript 之后补算隐形占比：只拿「实付对应的那一段」的可见 $（rows 里落在 spanFrom～spanTo 的调用），
 * 分子分母同一时间段；整个统计区间只用这一个占比，各报表共用。这一段里没有可见调用就算不出来，退回未校准。
 */
/** 样本（读数段）至少要有这么长、且占统计区间可见 $ 的这么多，否则口径行追加「样本短，仅供参考」 */
const CALIB_SHORT_MS = 3600e3, CALIB_SHORT_SHARE = 0.2;
const fmtSpan = (ms) => { const m = ms / 60000; return m < 90 ? `${Math.round(m)} 分钟` : m < 2880 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 1440).toFixed(1)} 天`; };

/**
 * acct = 账号级的调用（所有项目）：给了 --project 时 rows 只有这一个项目，而校准读数是账号级的，
 * 隐形占比必须拿账号级的可见 $ 算，再套到本项目；没给 --project 时 rows 本来就是账号级。
 * win = 统计区间，用来算样本占本区间可见 $ 的比例（样本短提示）。
 */
function finishCalib(rows, win, acct) {
  if (!(CALIB && CALIB.spentUsd > 0)) return;
  const all = acct || rows;
  const sum = (arr, lo, hi) => arr.reduce((a, r) => (r.t >= lo && r.t <= hi ? a + r.usd : a), 0);
  const vis = sum(all, CALIB.spanFrom, CALIB.spanTo);
  if (!(vis > 0)) {
    const seg = CALIB.api ? `读数段 ${localStamp(CALIB.spanFrom)} → ${localStamp(CALIB.spanTo)}` : '统计区间';
    CALIB = { mode: CALIB.mode, spentUsd: 0, note: `${seg}内没有可见调用，算不出隐形占比（这段实付 ≈ $${CALIB.spentUsd.toFixed(2)}）` };
    return;
  }
  CALIB.visibleUsd = vis;
  CALIB.hidden = clampPct(1 - vis / CALIB.spentUsd);
  HID = CALIB.hidden;
  if (acct) CALIB.projectVisibleUsd = sum(rows, CALIB.spanFrom, CALIB.spanTo);
  if (CALIB.api) {
    // 样本规模：读数段多长、这一段的可见 $ 占统计区间可见 $ 的几成（只算落在区间里的那部分，不会超过 100%）
    const ms = CALIB.spanTo - CALIB.spanFrom;
    const rangeUsd = sum(all, win.from, win.to - 1);
    const inRange = sum(all, Math.max(CALIB.spanFrom, win.from), Math.min(CALIB.spanTo, win.to - 1));
    const share = rangeUsd > 0 ? inRange / rangeUsd : null;
    // beyond = 读数段超出统计区间；inRangeUsd 是 share 的分子（读数段落在区间内那部分的可见 $），超出时样本行要把它和整段的可见 $ 分开写
    const beyond = CALIB.spanFrom < win.from || CALIB.spanTo > win.to - 1;
    CALIB.sample = { ms, rangeUsd, inRangeUsd: inRange, beyond, share, short: ms < CALIB_SHORT_MS || (share !== null && share < CALIB_SHORT_SHARE) };
  }
}

/** plan 模式（包月套餐）下 $ 列打 —：这时候 $ 没有实付含义，只看 token / 调用数 */
const USD = (v, d = 0) => (PLAN() ? '—' : '$' + Number(v).toFixed(d));

/** 口径行里关于「实付怎么来的」那一句；可见 $ 用校准时算的那一段（CALIB.visibleUsd），跟 hidden 同一口径 */
function calibLine() {
  if (PLAN()) return '包月套餐：只看 token / 调用数（记了 --plan，$ 列打 —）';
  if (CALIB && CALIB.spentUsd > 0 && CALIB.hidden !== undefined) {
    const seg = CALIB.api ? `，读数段 ${localStamp(CALIB.spanFrom)} → ${localStamp(CALIB.spanTo)}` : '';
    const sm = CALIB.sample;
    return `校准：${CALIB.api ? '读数段实付' : '手填实付'} ≈ $${CALIB.spentUsd.toFixed(2)}（来源 ${CALIB.source}${seg}），该段可见 $${CALIB.visibleUsd.toFixed(2)} → 隐形占比 ${pct(CALIB.hidden)}` +
      `（只按这一段算一次、整份报表共用；读数段至少 ${CALIB_MIN_COVER * 100}% 落在统计区间内才用）` +
      (OPT.project ? `；隐形占比按整个账号算（读数是账号级，上面的可见 $ 含所有项目，其中 ${OPT.project} 占 $${(CALIB.projectVisibleUsd ?? 0).toFixed(2)}），再套到本项目，报表其余部分只算 ${OPT.project}` : '') +
      (sm ? `；样本：读数段 ${fmtSpan(sm.ms)}、可见 $${CALIB.visibleUsd.toFixed(2)}${sm.beyond ? `（其中落在本区间 $${sm.inRangeUsd.toFixed(2)}）` : ''}、占本区间可见 $${sm.rangeUsd.toFixed(2)} 的 ${sm.share === null ? '—' : pct(sm.share)}${sm.short ? '（样本短，仅供参考）' : ''}` : '') +
      (CALIB.note ? `；另：${CALIB.note}` : '');
  }
  if (CALIB && CALIB.note) return `未校准（${CALIB.note}），按 ${pct(HIDDEN_SHARE)} 补`;
  return `$实付估 = $可见 ÷ (1 − ${pct(HIDDEN_SHARE)})：按 ${pct(HIDDEN_SHARE)} 补分类器等 transcript 看不见的请求（准数看网关面板，或跑一次 usage-balance.js 校准）`;
}

/**
 * 活跃工时判据：相邻两次 API 调用间隔 ≤ ACTIVE_GAP_MIN 分钟才算连续工作，
 * 超过就视为休息、不计入工时。
 * 为什么不用 wall clock（首末时间差）：09-09 首末跨 11.6 小时，
 * 其中有几小时空隙，会把 $/h 摊薄成假的"效率高"。
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
  rounds: has('--rounds'),
  session: val('--session', null),
  gap: (() => { const g = parseInt(val('--gap', '120'), 10); return Number.isFinite(g) && g >= 0 ? g : 120; })(),   // 轮内空闲 N 分钟处截断；默认 120，0 = 不截，非数字 / 负数回落 120
  check: has('--check'),   // 单价表检查（原 doctor 里的那一段），只读 settings.json 的 env
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

/** 一条记录 = 一次真实的 API 调用（已按 message.id 去重） */
/**
 * opts.win = 统计区间 { from, to }：rawInWin 只数落在区间里的原始行（sinceDay 为校准多收的更早日期不算）。
 * opts.account = 不看 --project、收全部项目（只给校准算账号级隐形占比用，不记会话标记）。
 */
function collect(sinceDay, opts = {}) {
  const rows = [];
  const seen = new Map();   // 去重键 → 已收的那条
  let rawLines = 0, rawInWin = 0;

  const root = OPT.project && !opts.account ? path.join(PROJECTS, OPT.project) : PROJECTS;
  for (const file of walkJsonl(root)) {
    const isSub = file.includes(`${path.sep}subagents${path.sep}`) || file.includes('/subagents/');
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (OPT.rounds && !opts.account) MARKERS.set(file, scanMarkers(txt, file, isSub));   // 主会话可能没有 usage 行但有起点，所以放在 usage 检查之前
    if (txt.indexOf('"usage"') === -1) continue;
    const ids = fileIds(file, isSub);

    for (const line of txt.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (!m || !m.usage || !o.timestamp) continue;
      const day = o.timestamp.slice(0, 10);
      if (sinceDay && day < sinceDay) continue;
      rawLines++;
      if (opts.win) { const t0 = Date.parse(o.timestamp); if (t0 >= opts.win.from && t0 < opts.win.to) rawInWin++; }

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
      const model = maskArn((m.model || 'unknown').replace(/^claude-/, ''));

      const row = {
        day, file, isSub, model,
        proj: ids.proj, sid: ids.sid, agent: ids.agent,          // --rounds 用：归到哪个项目 / 会话 / 子代理
        t: Date.parse(o.timestamp),
        i, o: out, cw, cr, cw1h,
        ctx: i + cw + cr,                                        // 本次送进去的上下文总量
        usd: 0,                                                  // 输出数可能被后面的行改大，收完再算
      };
      rows.push(row);
      if (key) seen.set(key, row);
    }
  }
  for (const r of rows) r.usd = usdOf(r);
  return { rows, rawLines, rawInWin };
}

// ───────────────────────── 会话标记（--rounds 用） ─────────────────────────

/** 起点命令：插件形式会带 model-router: 前缀；/dev、/automode 是改名前的旧名（本机历史轮全是 /dev）。plan-fable 只记事件、不切轮 */
const ROUND_CMD_RE = /<command-name>\/(?:[\w-]+:)?(route|dev|automode|plan-fable)<\/command-name>/;
const ROUND_CMDS = ['route', 'dev', 'automode'];
/** 会送 auto 分类器的工具（10-22 classifier.js 的 9 个）：只作「可分类调用」的上界，命中放行规则的从 transcript 里看不出来 */
const CLASSIFIED = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'SendMessage', 'WebFetch', 'Skill'];
const MARKER_KEYS = ['<command-name>', '"tool_use"', 'toolDenialKind', 'compact_boundary', 'continued-in'];
const MARKERS = new Map();      // 文件 → scanMarkers 的结果

/** 路径 → 项目目录名 / 会话 id / 子代理 id。主会话 <proj>/<sid>.jsonl；子代理 <proj>/<sid>/subagents/agent-<id>.jsonl */
function fileIds(file, isSub) {
  const rel = path.relative(PROJECTS, file).split(path.sep);
  const base = path.basename(file).replace(/\.jsonl$/, '');
  return isSub
    ? { proj: rel[0], sid: rel[1] || '', agent: base.replace(/^agent-/, '') }
    : { proj: rel[0], sid: base, agent: null };
}

const blockText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '';

/**
 * 扫一个 jsonl 里和「轮」有关的标记：起点命令、tool_use、被拒记录、压缩、continued-in。
 * 只解析含关键子串的行（主会话大多数行是 thinking / 长文本，全解析太慢）。没有时间戳的行跳过。
 */
function scanMarkers(txt, file, isSub) {
  const m = { ...fileIds(file, isSub), isSub, cmds: [], toolUses: [], agentUses: new Map(), denials: [], compacts: [], continuedIn: null, cwd: null };
  const toolName = new Map();      // tool_use id → 工具名（给 toolDenialKind 反查）
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let hit = false;
    for (const k of MARKER_KEYS) if (line.indexOf(k) !== -1) { hit = true; break; }
    if (!hit) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'continued-in') { if (o.continuedInSessionId) m.continuedIn = String(o.continuedInSessionId); continue; }
    const t = Date.parse(o.timestamp);
    if (!(t > 0)) continue;
    if (!m.cwd && o.cwd) m.cwd = o.cwd;
    const c = o.message?.content;

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const cm = o.compactMetadata || {};
      m.compacts.push({ t, trigger: cm.trigger || '?', pre: cm.preTokens || 0, post: cm.postTokens || 0, uuid: o.uuid || null });
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use' || !b.id) continue;
        toolName.set(b.id, b.name);
        m.toolUses.push({ t, tool: b.name, id: b.id });
        if (b.name === 'Agent' || b.name === 'Task') {
          m.agentUses.set(b.id, { t, type: b.input?.subagent_type || '?', desc: b.input?.description || '', model: b.input?.model || null, bg: !!b.input?.run_in_background });
        } else if (!isSub && b.name === 'Skill') {
          // 模型用 Skill 工具启动 /route：有的会话只有这条记录、没有 <command-name>（这时靠它认起点）
          const sk = String(b.input?.skill || '').replace(/^[\w-]+:/, '');
          if (ROUND_CMDS.includes(sk) || sk === 'plan-fable') m.cmds.push({ t, name: sk, args: String(b.input?.args || '').trim().slice(0, 40), uuid: o.uuid || null, via: 'skill' });
        }
      }
    } else if (o.type === 'user') {
      if (o.toolDenialKind) {
        const b0 = Array.isArray(c) ? c.find(x => x && x.type === 'tool_result') : null;
        const rt = b0 ? blockText(b0.content) : (typeof o.toolUseResult === 'string' ? o.toolUseResult : '');
        const rm = rt.match(/Reason:\s*\[([^\]]+)\]/);
        m.denials.push({ t, kind: String(o.toolDenialKind), tool: (b0 && toolName.get(b0.tool_use_id)) || '?', reason: rm ? rm[1] : '', id: b0?.tool_use_id || null, uuid: o.uuid || null });
      }
      if (typeof c === 'string') {
        if (!isSub && !o.isMeta) {
          const cm = c.match(ROUND_CMD_RE);
          if (cm) {
            const am = c.match(/<command-args>([\s\S]*?)<\/command-args>/);
            m.cmds.push({ t, name: cm[1], args: am ? am[1].trim().slice(0, 40) : '', uuid: o.uuid || null, via: 'command' });
          }
        }
      }
    }
  }
  return m;
}

const SUBMETA_CACHE = new Map();
/** <proj>/<sid>/subagents/*.meta.json → Map(子代理 id → { type（去前缀）, desc, toolUseId })；读不了的跳过（老版本 CLI 没有 meta） */
function readSubMeta(proj, sid) {
  const key = proj + '|' + sid;
  if (SUBMETA_CACHE.has(key)) return SUBMETA_CACHE.get(key);
  const map = new Map();
  SUBMETA_CACHE.set(key, map);
  const dir = path.join(PROJECTS, proj, sid, 'subagents');
  let names; try { names = fs.readdirSync(dir); } catch { return map; }
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      map.set(n.replace(/^agent-/, '').replace(/\.meta\.json$/, ''), { type: String(j.agentType || '').replace(/^.*:/, ''), desc: String(j.description || ''), toolUseId: j.toolUseId || null });
    } catch { /* 坏 meta 跳过，回落到主会话里的派活记录 */ }
  }
  return map;
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
  const m = { calls: rows.length, i: 0, o: 0, cw: 0, cr: 0, usd: 0 };
  for (const r of rows) { m.i += r.i; m.o += r.o; m.cw += r.cw; m.cr += r.cr; m.usd += r.usd; }
  const main = rows.filter(r => !r.isSub);
  const sub = rows.filter(r => r.isSub);

  m.hours = activeHours(rows);
  m.wallHours = rows.length > 1 ? (Math.max(...rows.map(r => r.t)) - Math.min(...rows.map(r => r.t))) / 3600e3 : 0;
  m.hitRate = (m.cr + m.cw) ? m.cr / (m.cr + m.cw) : 0;

  // 派生指标 —— 这些才是能指导决策的
  m.usdPerHour = m.usd / m.hours;                 // 单位时间烧钱速度（最核心的口径）
  m.usdPerCall = m.calls ? m.usd / m.calls : 0;   // 单次调用的重量 → 查上下文膨胀
  m.cwPerCall = m.calls ? m.cw / m.calls : 0;     // 缓存重建频率 → 查 TTL 过期
  m.mainShare = m.usd ? metrics0(main).usd / m.usd : 0;  // 主会话占比 → 查有没有把活派出去
  m.subCount = new Set(sub.map(r => r.file)).size;
  m.subUsd = metrics0(sub).usd;
  m.subAvgUsd = m.subCount ? m.subUsd / m.subCount : 0;   // 子代理平均规模（$）→ 查拆得够不够细
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
    m.byModel[mod] = { calls: g.length, usd: metrics0(g).usd };
  }
  return m;
}
/** 只算总量，不递归派生（避免无限递归） */
function metrics0(rows) {
  const m = { usd: 0 };
  for (const r of rows) m.usd += r.usd;
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
  console.log('\n=== 日报（$ 按公开价分项估算，只含 transcript 可见部分） ===');
  console.log('日期        调用  $估算  活跃h  wall h   $/h   命中率  主%  子代理  子均$  $/调用  TTL重建');
  const out = [];
  for (const d of days) {
    const g = rows.filter(r => r.day === d);
    const m = metrics(g);
    if (m.usd < 0.5) continue;
    out.push({ day: d, m });
    console.log(
      `${d}  ${pad(m.calls, 4)}  ${pad(USD(m.usd, 0), 6)}  ` +
      `${pad(m.hours.toFixed(1), 5)}  ${pad(m.wallHours.toFixed(1), 6)}  ` +
      `${pad(USD(m.usdPerHour, 0), 5)}  ${pad(pct(m.hitRate), 6)}  ${pad((m.mainShare * 100).toFixed(0), 3)}%  ` +
      `${pad(m.subCount, 5)}  ${pad(USD(m.subAvgUsd, 2), 6)}  ${pad(USD(m.usdPerCall, 3), 7)}  ${pad(m.ttlRebuilds, 5)}`
    );
  }
  // 汇总
  const all = metrics(rows);
  console.log('─'.repeat(110));
  console.log(`合计 ${days.length} 天  ${pad(all.calls, 5)}  ${USD(all.usd, 0)}  ` +
    `${all.hours.toFixed(1)}h 活跃  均 ${USD(all.usdPerHour, 0)}/h  命中 ${pct(all.hitRate)}`);
  console.log(`网关实付估计 ≈ ${USD(all.usd / (1 - HID), 0)}${PLAN() ? '（包月套餐：$ 列是公开价折算，不是实付）' : '（上面只是 transcript 可见部分）'}`);
  console.log(calibLine());
  console.log('\n模型构成（按 $）:');
  for (const [mod, v] of Object.entries(all.byModel).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`   ${mod.padEnd(14)} ${pad(v.calls, 5)} 次  ${USD(v.usd, 0)} (${pad(all.usd ? pct(v.usd / all.usd) : '—', 6)})  公开价 ${priceLabel(mod)}${isPriced(mod) ? '' : '  ⚠ 单价表里没有，按默认价估'}`);
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
      id, day: g[0].day, calls: m.calls, usd: m.usd,
      hours: m.wallHours, peak: m.peakCtx, usdPerCall: m.usdPerCall,
      model: [...new Set(g.map(r => r.model))].filter(x => x !== '<synthetic>').join(','),
      brief: brief[id] || null,
    };
  }).sort((a, b) => b.usd - a.usd);

  console.log('\n=== 子代理排行（查上下文膨胀） ===');
  console.log('日期   $估算   调用  时长h  峰值ctx  $/调用  模型          任务');
  for (const a of list.slice(0, 25)) {
    console.log(`${a.day.slice(5)} ${pad('$' + a.usd.toFixed(2), 7)} ${pad(a.calls, 5)} ${pad(a.hours.toFixed(1), 6)} ${pad(K(a.peak), 7)}k ${pad('$' + a.usdPerCall.toFixed(3), 7)}  ${(a.model || '?').padEnd(13)} ${a.brief ? a.brief.desc.slice(0, 40) : '(无派活记录)'}`);
  }

  console.log('\n规模分档（验证超线性）:');
  const buckets = [[0, 50], [50, 100], [100, 200], [200, 1e9]];
  for (const [lo, hi] of buckets) {
    const g = list.filter(a => a.calls > lo && a.calls <= hi);
    if (!g.length) continue;
    const avgCalls = g.reduce((s, a) => s + a.calls, 0) / g.length;
    const avgUsd = g.reduce((s, a) => s + a.usd, 0) / g.length;
    const avgPeak = g.reduce((s, a) => s + a.peak, 0) / g.length;
    console.log(`   ${String(lo + '-' + (hi > 1e8 ? '∞' : hi)).padEnd(9)} ${pad(g.length, 3)} 个  平均 ${pad(avgCalls.toFixed(0), 3)} 次 / $${avgUsd.toFixed(2)}  → $${(avgUsd / avgCalls).toFixed(3)}/调用  平均峰值 ${K(avgPeak)}k`);
  }
  const over = list.filter(a => a.calls > 150 || a.peak > 400e3);
  if (over.length) {
    console.log(`\n⚠️  ${over.length} 个子代理超标（>150 次调用 或 峰值 >400k），合计 $${over.reduce((s, a) => s + a.usd, 0).toFixed(0)}：`);
    for (const a of over) console.log(`   ${a.day.slice(5)} $${a.usd.toFixed(2)}  ${a.calls} 次  峰值 ${K(a.peak)}k  ${a.brief ? a.brief.desc.slice(0, 44) : '?'}`);
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
      calls: m.calls, usd: m.usd, hours: m.hours,
      peak: m.peakCtx, cwPerCall: m.cwPerCall, ttl: m.ttlRebuilds,
      models: Object.keys(m.byModel).join(','),
    };
  }).sort((a, b) => b.usd - a.usd);
  console.log('\n=== 主会话排行 ===');
  console.log('日期   会话      $估算  调用  活跃h  峰值ctx  cw/调用  TTL重建  模型');
  for (const s of list.slice(0, 20)) {
    console.log(`${s.day.slice(5)} ${s.name} ${pad('$' + s.usd.toFixed(0), 7)} ${pad(s.calls, 5)} ${pad(s.hours.toFixed(1), 6)} ${pad(K(s.peak), 7)}k ${pad(K(s.cwPerCall), 7)}k ${pad(s.ttl, 6)}   ${s.models}`);
  }
  return list;
}

function reportDay(rows, day) {
  const g = rows.filter(r => r.day === day);
  if (!g.length) { console.log(`${day} 无记录`); return; }
  const m = metrics(g);
  console.log(`\n=== ${day} 详解 ===`);
  console.log(`总量      ≈ ${USD(m.usd, 0)}   (${m.calls} 次调用；网关实付估计 ≈ ${USD(m.usd / (1 - HID), 0)}，含分类器等看不见的请求)`);
  console.log(calibLine());
  console.log(`工时      活跃 ${m.hours.toFixed(1)}h / wall ${m.wallHours.toFixed(1)}h  → ≈ ${USD(m.usdPerHour, 0)}/h`);
  console.log(`缓存      命中率 ${pct(m.hitRate)}   cache write ${M(m.cw)}M   cache read ${M(m.cr)}M`);
  console.log(`          超 TTL 全量重建 ${m.ttlRebuilds} 次 / ${M(m.ttlCw)}M（占主会话 cw ${pct(m.ttlCw / (metrics(g.filter(r => !r.isSub)).cw || 1))}）`);
  console.log(`结构      主会话 ${pct(m.mainShare)}   子代理 ${m.subCount} 个 / 平均 ${USD(m.subAvgUsd, 2)}`);
  console.log(`单次      ${USD(m.usdPerCall, 3)}/调用   峰值上下文 ${K(m.peakCtx)}k`);
  console.log(`\n模型构成:`);
  for (const [mod, v] of Object.entries(m.byModel).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`   ${mod.padEnd(14)} ${pad(v.calls, 5)} 次  (${pad(m.usd ? pct(v.usd / m.usd) : '—', 6)})  ≈ ${USD(v.usd, 0)}`);
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
  const W5 = CACHE_RATIO.write5m, W1 = CACHE_RATIO.write1h, R = CACHE_RATIO.read;   // 缓存量按「等价输入 token」折算，再乘输入价得 $
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
      const price = priceOf(r.model)[0] / 1e6;   // 缓存量已折成等价输入 token，乘输入价（近似：5-5 系读缓存实价只有输入的 5%）
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
  console.log('范围            调用   现状$      1h 后$     差额$    日均差额$  救回重建  >1h仍过期  盈亏平衡倍率');
  const order = ['主会话', '规划 fable', '审查 opus', '实现 sonnet 等', '合计'];
  for (const k of order) {
    const b = acc[k]; if (!b) continue;
    const dUsd = b.simUsd - b.curUsd;
    const mark = dUsd < -0.5 ? '✅' : dUsd > 0.5 ? '❌' : '  ';
    // 1h 写入倍率高于这个值就不划算（sim 对写入倍率是线性的）
    const be = b.cw2 ? (b.cur - b.cr2 * R) / b.cw2 : 0;
    console.log(`${mark} ${k.padEnd(12)} ${pad(b.calls, 5)}  ${pad('$' + b.curUsd.toFixed(0), 8)}  ${pad('$' + b.simUsd.toFixed(0), 9)}  ${pad((dUsd >= 0 ? '+$' : '-$') + Math.abs(dUsd).toFixed(0), 7)}  ${pad((dUsd >= 0 ? '+$' : '-$') + Math.abs(dUsd / days).toFixed(1), 8)}  ${pad(b.saved, 7)}  ${pad(b.lost, 8)}     ${be.toFixed(2)}×`);
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
    activeGapMin: ACTIVE_GAP_MIN,
    totals: {
      calls: all.calls, usd: all.usd, hours: all.hours,
      usdPerHour: all.usdPerHour,
      hitRate: all.hitRate, mainShare: all.mainShare,
      usdPerCall: all.usdPerCall, subAvgUsd: all.subAvgUsd, ttlRebuilds: all.ttlRebuilds,
    },
    byModel: all.byModel,
  };
}

/**
 * 基线的位置：新位置在脚本同目录（v2.0.0 起在 usage/ 下）；v1.x 存在插件根目录，读不到新位置时回退读它，写永远只写新位置。
 * 插件根目录有两种相对位置：装好的布局脚本在 <插件目录>/usage/（上一级）；原地模式 / 仓库里跑时脚本在 <插件目录>/plugins/usage/（上两级）。两处都查，先近后远
 */
const OLD_BASELINES = [path.join(__dirname, '..', 'usage-baseline.json'), path.join(__dirname, '..', '..', 'usage-baseline.json')];

function compareBaseline(rows) {
  let basePath = BASELINE, fromOld = false;
  if (!fs.existsSync(basePath)) {
    const old = OLD_BASELINES.find((p) => fs.existsSync(p));
    if (old) { basePath = old; fromOld = true; }
    else {
      console.log(`没有基线文件，先跑：node ${path.basename(__filename)} --days N --baseline`);
      return;
    }
  }
  let base;
  try { base = JSON.parse(fs.readFileSync(basePath, 'utf8')); } catch { console.log('基线文件读不了（不是合法 JSON），重存：--baseline'); return; }
  const now = snapshot(rows);
  console.log(`\n=== 对比基线 ===`);
  if (fromOld) console.log('ℹ 用的是旧位置的基线，下次 --baseline 会存到 usage/');
  console.log(`基线 ${base.range.from} ~ ${base.range.to}（${base.range.days} 天，存于 ${base.savedAt.slice(0, 16)}）`);
  console.log(`当前 ${now.range.from} ~ ${now.range.to}（${now.range.days} 天）\n`);
  if (LEGACY_BASE.key in base) console.log(LEGACY_BASE.note + '\n');
  if (JSON.stringify(base.price) !== JSON.stringify(now.price) || base.activeGapMin !== now.activeGapMin) {
    console.log('⚠️  口径已变（单价表 / 工时判据），$ 的对比不可直接采信\n');
  }
  const KEYS = [
    ['usdPerHour', '$/h（核心）', v => '$' + v.toFixed(0), true],
    ['usdPerCall', '$/调用', v => '$' + v.toFixed(3), true],
    ['subAvgUsd', '子代理平均规模', v => '$' + v.toFixed(2), true],
    ['hitRate', '缓存命中率', v => pct(v), false],
    ['mainShare', '主会话占比', v => pct(v), null],
  ];
  for (const [k, label, fmt, lowerBetter] of KEYS) {
    const b = base.totals[k], n = now.totals[k];
    if (b == null || n == null) continue;
    // 旧基线（含 EIU）的主会话占比按 EIU 算、现在按 $ 算，口径不同，不相减
    if (k === 'mainShare' && LEGACY_BASE.key in base) {
      console.log(`   ${label.padEnd(18)} ${pad(fmt(b), 9)} → ${pad(fmt(n), 9)}  口径不同（旧基线按 EIU），不可比`);
      continue;
    }
    const d = (n - b) / (b || 1) * 100;
    const mark = lowerBetter === null ? '  ' : (lowerBetter ? (d < -2 ? '✅' : d > 2 ? '⚠️ ' : '  ') : (d > 2 ? '✅' : d < -2 ? '⚠️ ' : '  '));
    console.log(`${mark} ${label.padEnd(18)} ${pad(fmt(b), 9)} → ${pad(fmt(n), 9)}  ${(d >= 0 ? '+' : '') + d.toFixed(1)}%`);
  }
}

// ───────────────────────── 按 /route 轮看（--rounds） ─────────────────────────

const PHASES = ['规划', '实现', '审查', '修复', '文档', '主会话'];
const DOC_RE = /文档|docs?\b|readme|changelog|guide/i;
const ID_RE = /\b([RN]\d{1,2})\b/g;
const ID_HINT_RE = /[RN]\d{1,2}(?:\s*[、,，/／~～–—-]\s*[RN]?\d{1,2})*\s*(?:…|\.{3})/g;   // 「R1…」「N1、N2…」这类编号模板
const REVIEW_STRIP_HINTS = true;      // 设 false = 规划原文做法（user 文本里出现的编号一律当引用），在真实 transcript 上会漏数
const SEVERITY = ['🔴', '🟡', '🔵'];
const firstSeverity = (s) => { let best = null, bi = Infinity; for (const e of SEVERITY) { const i = s.indexOf(e); if (i >= 0 && i < bi) { bi = i; best = e; } } return best; };
const zeroBag = () => ({ total: 0, red: 0, yellow: 0, blue: 0, unknown: 0 });

const REVIEW_CACHE = new Map();
/**
 * 一个审查员子代理文件里每个「审查回合」查出几条新发现。
 * 回合 = 一条 user 文本记录（首轮 prompt，或之后每次 SendMessage）到下一条之间；连续的 user 文本（prompt + system-reminder）算同一回合。
 * 报告 = 回合里最后一条 assistant 消息的 text 块，加上回合内 SubagentHandback 工具调用的 message（新版 CLI 的子代理把报告写在这里，最后一条 text 只是「已发送」）。
 * 一条发现 = 一个 R/N 编号：先把本回合 user 文本里的编号记入 seen（主会话写「已按 R1 修改」时是引用），再数报告里不在 seen 的编号。
 * 严重度 = 编号所在行第一个 🔴/🟡/🔵；那一行没有就取它所属小节标题上的（审查员常写成「## 🔴 必须修」下面列「**N1**」）；
 * 同一编号出现多处时取第一个有严重度的（开头摘要行常常不带 emoji）；都没有算 unknown。
 */
function reviewFindings(file) {
  if (REVIEW_CACHE.has(file)) return REVIEW_CACHE.get(file);
  const out = [];
  REVIEW_CACHE.set(file, out);
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const seen = new Set();
  let cur = null, turnNo = 0, tail = [];

  const finish = () => {
    if (!cur || cur.t === null) return;                       // 没有任何 assistant 回应的回合不算
    // 派活 / SendMessage 里的「报告格式：每条一个编号 R1…」「新发现请编号 N1、N2…」是编号模板、不是引用：先剔掉以省略号结尾的编号枚举，否则 R1 / N1 会被当成已知而漏数
    const refText = REVIEW_STRIP_HINTS ? cur.userText.replace(ID_HINT_RE, ' ') : cur.userText;
    for (const mm of refText.matchAll(ID_RE)) seen.add(mm[1]);
    const f = { turn: cur.n, t: cur.t, ...zeroBag() };
    const found = new Map();      // 新编号 → 严重度（取它各处出现里第一个有严重度的；报告开头的摘要行常常不带 emoji）
    let sect = null;
    for (const ln of [...tail, ...cur.handback].join('\n').split('\n')) {
      const own = firstSeverity(ln);
      // 「没有 N2」「无 N2」是在说没发现，不是一条发现；紧挨着编号前面带否定词的出现不算
      const ids = [...ln.matchAll(ID_RE)].filter(x => !/(没有|没发现|未发现|无|不存在|no|none)\s*$/i.test(ln.slice(Math.max(0, x.index - 8), x.index))).map(x => x[1]);
      for (const id of ids) {
        if (seen.has(id)) continue;
        if (!found.has(id)) found.set(id, null);
        if (found.get(id) === null) found.set(id, own || sect);
      }
      if (!ids.length && (/^\s*#{1,6}\s/.test(ln) || /^\s*\*\*[^*]+\*\*\s*$/.test(ln))) sect = own;   // 小节标题：带 emoji 就切换，不带就清空
    }
    for (const sev of found.values()) {
      f.total++;
      if (sev === '🔴') f.red++; else if (sev === '🟡') f.yellow++; else if (sev === '🔵') f.blue++; else f.unknown++;
    }
    for (const id of found.keys()) seen.add(id);
    out.push(f);
  };

  for (const line of txt.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user') {
      const c = o.message?.content;
      const isText = typeof c === 'string' || (Array.isArray(c) && c.some(x => x && x.type === 'text') && !c.some(x => x && x.type === 'tool_result'));
      if (!isText) { tail = []; continue; }                  // tool_result：之前的 assistant 文本不是最终报告
      const text = blockText(c);
      if (/^\s*\[Request interrupted/.test(text)) continue;   // 用户打断的占位，不算新回合
      if (cur && cur.t === null) cur.userText += '\n' + text;
      else { finish(); cur = { n: turnNo++, userText: text, t: null, handback: [] }; }
      tail = [];
    } else if (o.type === 'assistant' && cur) {
      const t = Date.parse(o.timestamp);
      if (t > 0) cur.t = t;
      const c = o.message?.content;
      if (Array.isArray(c)) for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && b.text) tail.push(b.text);
        else if (b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input?.message) cur.handback.push(String(b.input.message));
      }
    }
  }
  finish();
  return out;
}

let BRIEF = null;
/** 没有 meta.json（老版本 CLI）时，从主会话的 Agent 工具调用里取派活描述：agentBrief() 已有这张表，懒加载（它要再扫一遍全部主会话） */
function briefOf(agentId) {
  if (!BRIEF) BRIEF = agentBrief();
  const b = BRIEF[agentId];
  return b ? { type: b.type === '?' ? '' : String(b.type).replace(/^.*:/, ''), desc: b.desc === '?' ? '' : b.desc } : null;
}

const dedupBy = (arr, keyOf) => { const s = new Set(), out = []; for (const x of arr) { const k = keyOf(x); if (s.has(k)) continue; s.add(k); out.push(x); } return out; };

/**
 * 把会话接成「逻辑会话」：continued-in 把旧文件接到新文件（新文件会重放旧历史，所以事件要按 uuid / id 去重）。
 * 返回链数组；每条链合并事件和 rows（主会话 + 各 sid 的子代理）。按 sid 做 visited 防环。
 */
function logicalSessions(rows) {
  const mains = new Map();       // proj|sid → { proj, sid, mk }
  const subMk = new Map();       // proj|sid → [子代理文件的 markers]
  for (const mk of MARKERS.values()) {
    const key = mk.proj + '|' + mk.sid;
    if (mk.isSub) { if (!subMk.has(key)) subMk.set(key, []); subMk.get(key).push(mk); }
    else mains.set(key, { proj: mk.proj, sid: mk.sid, mk });
  }
  const rowsBy = new Map();
  for (const r of rows) { const k = r.proj + '|' + r.sid; if (!rowsBy.has(k)) rowsBy.set(k, []); rowsBy.get(k).push(r); }
  for (const k of rowsBy.keys()) if (!mains.has(k)) { const [proj, sid] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; mains.set(k, { proj, sid, mk: null }); }   // 只有子代理目录、没有主会话文件

  const nextOf = (k) => { const e = mains.get(k); return e && e.mk && e.mk.continuedIn ? e.proj + '|' + e.mk.continuedIn : null; };
  const hasPrev = new Set();
  for (const k of mains.keys()) { const n = nextOf(k); if (n && mains.has(n) && n !== k) hasPrev.add(n); }
  const chainsKeys = [], visited = new Set();
  const walk = (start) => { const keys = []; let k = start; while (k && mains.has(k) && !visited.has(k)) { visited.add(k); keys.push(k); k = nextOf(k); } if (keys.length) chainsKeys.push(keys); };
  for (const k of mains.keys()) if (!hasPrev.has(k)) walk(k);
  for (const k of mains.keys()) if (!visited.has(k)) walk(k);      // 环里没有起点的，各自从任一点切开

  const chains = [];
  for (const keys of chainsKeys) {
    const mks = [];
    for (const k of keys) { const e = mains.get(k); if (e.mk) mks.push(e.mk); for (const s of subMk.get(k) || []) mks.push(s); }
    const evKey = (x) => x.uuid || `${x.t}|${x.kind || x.name || x.tool || ''}|${x.id || ''}`;
    const chain = {
      proj: mains.get(keys[0]).proj,
      sids: keys.map(k => mains.get(k).sid),
      cmds: dedupBy(mks.flatMap(m => m.cmds), evKey).sort((a, b) => a.t - b.t),
      denials: dedupBy(mks.flatMap(m => m.denials), evKey).sort((a, b) => a.t - b.t),
      compacts: dedupBy(mks.flatMap(m => m.compacts), evKey).sort((a, b) => a.t - b.t),
      toolUses: dedupBy(mks.flatMap(m => m.toolUses), x => x.id).sort((a, b) => a.t - b.t),
      rows: keys.flatMap(k => rowsBy.get(k) || []).sort((a, b) => a.t - b.t),
      metas: new Map(),
    };
    for (const k of keys) { const e = mains.get(k); for (const [id, v] of readSubMeta(e.proj, e.sid)) if (!chain.metas.has(id)) chain.metas.set(id, v); }
    chains.push(chain);
  }
  return chains;
}

/**
 * 把一条逻辑会话切成轮。起点 = route|dev|automode 的命令记录或 Skill 调用，终点 = 下一个起点（没有就到末尾）；
 * 一次启动可能同时留下命令记录和 Skill 调用：同名且与上一个起点间隔 < 120 秒的丢掉，不多切一轮。
 * --gap N（默认 120）：轮内相邻两次调用（含起点本身）间隔 ≥ N 分钟时截断，后面的归「/route 之外」；0 = 不截。起点早于统计区间的轮，起点那一项按区间开头算。
 * 返回 { rounds, outside: rows[] }；链里没有任何起点时 rounds 为空、全部 rows 归 outside。
 */
function buildRounds(chain, win) {
  const starts = [];
  for (const c of chain.cmds.filter(c => ROUND_CMDS.includes(c.name)).sort((a, b) => a.t - b.t)) {
    const last = starts[starts.length - 1];
    if (last && last.name === c.name && c.t - last.t < 120e3) continue;
    starts.push(c);
  }
  const outside = [], rounds = [];
  if (!starts.length) return { rounds, outside: chain.rows.slice(), noRoute: true };
  outside.push(...chain.rows.filter(r => r.t < starts[0].t));

  const infoOf = (r) => chain.metas.get(r.agent) || briefOf(r.agent) || { type: '', desc: '' };
  // 审查员文件：整条链里 type = code-reviewer 的子代理文件（回合时间在各轮窗口里再切）
  const reviewerFiles = new Set();
  for (const r of chain.rows) if (r.isSub && infoOf(r).type === 'code-reviewer') reviewerFiles.add(r.file);
  const reviewTurns = [...reviewerFiles].flatMap(f => reviewFindings(f));

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i], end = i + 1 < starts.length ? starts[i + 1].t : null;
    let rs = chain.rows.filter(r => r.t >= s.t && (end === null || r.t < end));
    let cutAt = null;
    if (OPT.gap > 0) {
      let prev = Math.max(s.t, win.from);     // 起点早于统计区间时，区间开头之前的调用没收集，空闲从区间开头量起，不把「起点 → 区间开头」当空闲
      for (const r of rs) { if (r.t - prev >= OPT.gap * 60e3) { cutAt = r.t; break; } prev = r.t; }
      if (cutAt !== null) { outside.push(...rs.filter(r => r.t >= cutAt)); rs = rs.filter(r => r.t < cutAt); }
    }
    const upper = cutAt !== null ? cutAt : (end === null ? Infinity : end);
    const inWin = (x) => x.t >= s.t && x.t < upper;
    if (!rs.length && (s.t < win.from || s.t >= win.to)) continue;     // 区间外开的、区间内没有调用的轮不列

    // 阶段归类
    let firstReview = Infinity;
    for (const r of rs) if (r.isSub && r.t < firstReview && infoOf(r).type === 'code-reviewer') firstReview = r.t;
    const phases = {};
    for (const p of PHASES) phases[p] = { calls: 0, usd: 0, agents: new Set() };
    for (const r of rs) {
      let ph;
      if (!r.isSub) ph = '主会话';
      else {
        const info = infoOf(r);
        if (info.type === 'planner-fable') ph = '规划';
        else if (info.type === 'code-reviewer') ph = '审查';
        else if (r.t < firstReview) ph = '实现';
        else if (!info.type && !info.desc) ph = '实现';                  // 没有 meta、主会话里也没有派活记录
        else ph = DOC_RE.test(info.desc) ? '文档' : '修复';
      }
      const b = phases[ph];
      b.calls++; b.usd += r.usd;
      if (r.isSub) b.agents.add(r.agent);
    }

    const reviews = { turns: 0, first: zeroBag(), later: zeroBag() };
    for (const f of reviewTurns) {
      if (!inWin(f)) continue;
      reviews.turns++;
      const bag = f.turn === 0 ? reviews.first : reviews.later;
      bag.total += f.total; bag.red += f.red; bag.yellow += f.yellow; bag.blue += f.blue; bag.unknown += f.unknown;
    }

    const den = { blocked: 0, unavailable: 0, parsing: 0, rule: 0, userRejected: 0, other: 0, byTool: {}, byReason: {}, classifiable: 0 };
    for (const d of chain.denials.filter(inWin)) {
      if (d.kind === 'automode-blocked') {
        den.blocked++;
        den.byTool[d.tool] = (den.byTool[d.tool] || 0) + 1;
        const why = d.reason || '无类别';
        den.byReason[why] = (den.byReason[why] || 0) + 1;
      } else if (d.kind === 'automode-unavailable') den.unavailable++;
      else if (d.kind === 'automode-parsing-error') den.parsing++;
      else if (d.kind === 'permission-rule') den.rule++;
      else if (d.kind === 'user-rejected') den.userRejected++;
      else den.other++;
    }
    den.classifiable = chain.toolUses.filter(x => inWin(x) && CLASSIFIED.includes(x.tool) ).length;

    const m = rs.length ? metrics(rs) : null;
    const subAgents = new Set(rs.filter(r => r.isSub).map(r => r.agent));
    rounds.push({
      proj: chain.proj, sids: chain.sids, cmd: s.name, args: s.args,
      start: s.t, end, cutAt, partial: s.t < win.from,
      rows: rs, phases, reviews, denials: den,
      subagents: subAgents.size,
      compactions: chain.compacts.filter(inWin).length,
      usd: m ? m.usd : 0, usdGateway: m ? m.usd / (1 - HID) : 0, calls: rs.length,
      activeHours: m ? m.hours : 0, wallHours: m ? m.wallHours : 0, peakCtx: m ? m.peakCtx : 0,
      models: m ? m.byModel : {},
    });
  }
  return { rounds, outside };
}

/** 一轮的 JSON 形态：rows 去掉、Set 转数组、时间转 ISO */
function roundJson(r) {
  const { rows, phases, start, end, cutAt, ...rest } = r;
  const ph = {};
  for (const [k, v] of Object.entries(phases)) ph[k] = { calls: v.calls, usd: v.usd, agents: [...v.agents] };
  return { ...rest, start: new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString(), cutAt: cutAt === null ? null : new Date(cutAt).toISOString(), phases: ph };
}

// 显示宽度（中日韩字符和 emoji 占两格）：任务名是中文，用 padStart/padEnd 会对不齐
const dispW = (s) => { let w = 0; for (const ch of String(s)) { const c = ch.codePointAt(0); w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)) ? 2 : 1; } return w; };
const padLeft = (s, n) => ' '.repeat(Math.max(0, n - dispW(s))) + s;
const padRight = (s, n) => s + ' '.repeat(Math.max(0, n - dispW(s)));
const clipW = (s, n) => { let w = 0, out = ''; for (const ch of String(s)) { const cw = dispW(ch); if (w + cw > n) break; out += ch; w += cw; } return out; };
const two = (n) => String(n).padStart(2, '0');
const localStamp = (t) => { const d = new Date(t); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const share = (v, total) => total > 0 ? v / total : null;
const sharePct = (p) => p === null ? '—' : (p > 0 && p < 0.005 ? '<1%' : (p * 100).toFixed(0) + '%');
const top3 = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join('、') || '—';

function reportRounds(rounds, outsideInfo) {
  // 校准过（calibration.jsonl 有两次读数、且读数段里有可见调用）时，隐形占比 HID 是读数段的「1 − 可见 $ ÷ 实付」；
  // 该轮的实付分摊 = 该轮可见 $ ÷ (1 − HID) = 该轮可见 $ × 读数段实付 ÷ 读数段可见 $（分母跟隐形占比同一口径，含 /route 之外和没打过 /route 的会话）；没校准就按默认隐形占比估
  const shareSpent = !!(CALIB && CALIB.spentUsd > 0 && CALIB.hidden !== undefined);
  const payOf = (r) => (PLAN() ? '—' : '$' + r.usdGateway.toFixed(2));
  const cols = [['#', 3, 'L'], ['命令', 6, 'R'], ['开始', 11, 'R'], ['会话', 9, 'R'], ['任务', 20, 'R'], ['$可见', 7, 'L'], [shareSpent ? '$实付分摊' : '$实付估', 8, 'L'], ['活跃h', 6, 'L'], ['wall h', 7, 'L'],
    ['规划%', 6, 'L'], ['实现%', 6, 'L'], ['审查%', 6, 'L'], ['修复%', 6, 'L'], ['文档%', 6, 'L'], ['主会话%', 7, 'L'],
    ['审查(首轮🔴/🟡/🔵 · 复审 条/轮)', 31, 'R'], ['拦截(blk/unav)', 14, 'L'], ['拦截率', 7, 'L'], ['子代理', 6, 'L'], ['压缩', 4, 'L']];
  const fmtRow = (cells) => cells.map((c, i) => cols[i][2] === 'L' ? padLeft(c, cols[i][1]) : padRight(c, cols[i][1])).join('  ');
  console.log('\n=== 按 /route 轮看（时间为本地时间；占比按 $） ===');
  console.log(fmtRow(cols.map(c => c[0])));

  rounds.forEach((r, i) => {
    const none = r.calls === 0;
    const rv = r.reviews;
    const unk = (b) => b.unknown ? `+${b.unknown}?` : '';
    const review = rv.turns ? `${rv.first.red}/${rv.first.yellow}/${rv.first.blue}${unk(rv.first)} · ${rv.later.total}${unk(rv.later)} 条/${rv.turns} 轮` : '—';
    const d = r.denials;
    const ph = (p) => none ? '—' : sharePct(share(r.phases[p].usd, r.usd));
    console.log(fmtRow([
      String(i + 1), '/' + r.cmd, (r.partial ? '*' : '') + localStamp(r.start), r.sids[0].slice(0, 8) + (r.sids.length > 1 ? '+' : ''),
      clipW(r.args || '(无参数)', 20),
      none ? '—' : '$' + r.usd.toFixed(2), none ? '—' : payOf(r), none ? '—' : r.activeHours.toFixed(1), none ? '—' : r.wallHours.toFixed(1),
      ph('规划'), ph('实现'), ph('审查'), ph('修复'), ph('文档'), ph('主会话'),
      review, `${d.blocked}/${d.unavailable}`, d.classifiable ? pct(d.blocked / d.classifiable) : '—', String(r.subagents), String(r.compactions),
    ]));
  });

  // 汇总
  const n = rounds.length;
  const live = rounds.filter(r => r.calls > 0);
  const sum = (f) => rounds.reduce((a, r) => a + f(r), 0);
  console.log('─'.repeat(150));
  const avgPay = live.length ? sum(r => r.usdGateway) / live.length : 0;
  console.log(`汇总  ${n} 轮（其中 ${n - live.length} 轮区间内没有调用）  ·  均 $${(live.length ? sum(r => r.usd) / live.length : 0).toFixed(2)} 可见 / $${avgPay.toFixed(2)} ${PLAN() ? '（包月：不看 $）' : shareSpent ? '实付分摊' : '实付估'} 每轮  ·  均活跃 ${(live.length ? sum(r => r.activeHours) / live.length : 0).toFixed(1)}h 每轮`);
  const avgShare = PHASES.map(p => {
    const g = live.filter(r => r.usd > 0);
    return `${p} ${g.length ? sharePct(g.reduce((a, r) => a + r.phases[p].usd / r.usd, 0) / g.length) : '—'}`;
  });
  console.log(`各阶段平均占比（按 $，每轮等权）  ${avgShare.join('  ·  ')}`);
  const blocked = sum(r => r.denials.blocked), unav = sum(r => r.denials.unavailable), cls = sum(r => r.denials.classifiable);
  const byTool = {}, byReason = {};
  for (const r of rounds) { for (const [k, v] of Object.entries(r.denials.byTool)) byTool[k] = (byTool[k] || 0) + v; for (const [k, v] of Object.entries(r.denials.byReason)) byReason[k] = (byReason[k] || 0) + v; }
  console.log(`分类器拦截  ${blocked} 次 / 可分类调用 ${cls} 次 = ${cls ? pct(blocked / cls) : '—'}（另有 ${unav} 次分类器不可用；用户拒绝 ${sum(r => r.denials.userRejected)} 次、命中拒绝规则 ${sum(r => r.denials.rule)} 次）`);
  console.log(`            按工具前三 ${top3(byTool)}  ·  按类别前三 ${top3(byReason)}`);
  const rev = { turns: sum(r => r.reviews.turns), first: sum(r => r.reviews.first.total), later: sum(r => r.reviews.later.total) };
  console.log(`审查        ${rev.turns} 个回合；首轮共查出 ${rev.first} 条，复审共 ${rev.later} 条`);

  console.log('\n模型构成（按 $，上面各轮合计）:');
  const mod = {};
  for (const r of rounds) for (const [k, v] of Object.entries(r.models)) { const e = (mod[k] ||= { calls: 0, usd: 0 }); e.calls += v.calls; e.usd += v.usd; }
  const usdAll = Object.values(mod).reduce((a, v) => a + v.usd, 0);
  for (const [k, v] of Object.entries(mod).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`   ${k.padEnd(14)} ${pad(v.calls, 5)} 次  $${v.usd.toFixed(2)} (${pad(usdAll ? pct(v.usd / usdAll) : '—', 6)})  公开价 ${priceLabel(k)}${isPriced(k) ? '' : '  ⚠ 单价表里没有，按默认价估'}`);
  }

  console.log(`\n/route 之外：${outsideInfo.calls} 次 / $${outsideInfo.usd.toFixed(2)}（第一次起点之前${OPT.gap ? '、以及 --gap 截断后' : ''}的调用）` +
    (outsideInfo.noRoute.sessions ? `；另有 ${outsideInfo.noRoute.sessions} 个会话没打过 /route（${outsideInfo.noRoute.calls} 次 / $${outsideInfo.noRoute.usd.toFixed(2)}），不计入` : ''));
  console.log('口径：起点 = /route 启动（命令记录或 Skill 调用；旧名 /dev、/automode 照认），终点 = 下一次起点' + (OPT.gap ? `，并在空闲 ${OPT.gap} 分钟处截断（--gap 0 不截）` : '（--gap 0：不截断，轮后的闲聊会算进最后一轮）') +
    `；子代理按调用时间归轮。${calibLine()}（每次审批约送调用方当时上下文的 25%）。` +
    '审查条数按 R/N 编号去重，取自审查员子代理的 transcript。带 * 的轮开在统计区间之前，只含区间内的调用。');
}

function runRounds(scoped, since) {
  const win = OPT.day ? { from: Date.parse(OPT.day + 'T00:00:00Z'), to: Date.parse(OPT.day + 'T00:00:00Z') + 864e5 } : { from: Date.parse(since + 'T00:00:00Z'), to: Infinity };
  let chains = logicalSessions(scoped);
  if (OPT.session) chains = chains.filter(c => c.sids.some(s => s.startsWith(OPT.session)));

  const rounds = [];
  const outsideRows = [];
  const noRoute = { sessions: 0, calls: 0, usd: 0 };
  for (const ch of chains) {
    const res = buildRounds(ch, win);
    if (res.noRoute) { if (res.outside.length) { noRoute.sessions++; noRoute.calls += res.outside.length; noRoute.usd += res.outside.reduce((a, r) => a + r.usd, 0); } continue; }
    rounds.push(...res.rounds);
    outsideRows.push(...res.outside);
  }
  rounds.sort((a, b) => a.start - b.start);
  const outsideInfo = { calls: outsideRows.length, usd: outsideRows.reduce((a, r) => a + r.usd, 0), noRoute };

  if (OPT.json) {
    console.log(JSON.stringify({
      rounds: rounds.map(roundJson),
      outside: outsideInfo,
      criteria: {
        roundCmds: ROUND_CMDS, classified: CLASSIFIED, hiddenShare: HID,
        calibration: CALIB ? {
          mode: CALIB.mode, spentUsd: CALIB.spentUsd ?? null, source: CALIB.source ?? null, note: CALIB.note ?? null,
          visibleUsd: CALIB.visibleUsd ?? null, hidden: CALIB.hidden ?? null,
          projectVisibleUsd: CALIB.projectVisibleUsd ?? null,       // 给了 --project 时：读数段内本项目的可见 $（visibleUsd 是账号级）
          sample: CALIB.sample ? { ms: CALIB.sample.ms, rangeUsd: CALIB.sample.rangeUsd, inRangeUsd: CALIB.sample.inRangeUsd, beyond: CALIB.sample.beyond, share: CALIB.sample.share, short: CALIB.sample.short } : null,
          spanFrom: CALIB.hidden !== undefined ? isoOrNull(CALIB.spanFrom) : null, spanTo: CALIB.hidden !== undefined ? isoOrNull(CALIB.spanTo) : null,
        } : null,
      },
    }, null, 2));
    return;
  }
  if (!rounds.length) { console.log('区间内没有 /route（或 /dev）的记录'); return; }
  reportRounds(rounds, outsideInfo);
}

// ───────────────────────── 单价表检查（--check；原 doctor.js 里的那一段搬过来） ─────────────────────────

/** settings.json 里 env 钉的模型在不在 PRICE 里。只读，只打模型 ID（ARN 打码），金额按默认价估时给出提示 */
function priceCheck() {
  const f = path.join(CLAUDE_DIR, 'settings.json');
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`settings.json 读不了（${e.code || e.name || 'error'}）`); return 1; }
  const body = txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt;
  let j;
  try { j = JSON.parse(body); } catch { console.log('settings.json 不是合法 JSON'); return 1; }
  const env = j && typeof j.env === 'object' && j.env ? j.env : {};
  const pinned = Object.entries(env)
    .filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(k))
    .map(([, v]) => String(v)).filter((v) => v && !v.includes('${'));
  // 查价前照原 doctor 做两步归一化：去 [1M] 之类的上下文后缀、去 claude- 前缀（transcript 里的模型 ID 在读入时已做过同样处理）；报出来的仍是原写法
  const norm = (m) => m.replace(/\[\d+m\]\s*$/i, '').replace(/^claude-/, '');
  const missing = [...new Set(pinned.filter((m) => !isPriced(norm(m))))];
  if (!missing.length) { console.log('✅ env 钉的模型在单价表里都有价'); return 0; }
  console.log(`⚠ 单价表里没有 ${missing.map(maskArn).join('、')}，花费会按默认价估 → 在 usage-audit.js 的 PRICE 里补一行`);
  return 0;
}

// ───────────────────────── main ─────────────────────────

function main() {
  if (OPT.check) process.exit(priceCheck());   // 只读 settings.json 的 env，不扫 transcript

  const since = OPT.day
    ? OPT.day
    : new Date(Date.now() - OPT.days * 864e5).toISOString().slice(0, 10);

  const t0 = Date.now();
  const dayFrom = Date.parse(since + 'T00:00:00Z');
  const win = { from: dayFrom, to: OPT.day ? dayFrom + 864e5 : Infinity };

  // 校准：先定读数段 a→b（--day 时 b 不晚于当天结束），transcript 要从 a 那天起收，这样读数段里的可见 $ 才收得齐；
  // 隐形占比只用读数段的可见 $ 算一次，整个统计区间（日报 / 日详解 / 按轮）共用这一个占比
  CALIB = calibration(win);
  const collectFrom = CALIB && CALIB.api ? new Date(Math.min(dayFrom, CALIB.spanFrom)).toISOString().slice(0, 10) : since;
  const { rows, rawInWin } = collect(collectFrom, { win });
  const scoped = rows.filter(r => r.t >= win.from && r.t < win.to);      // 统计区间内的调用（collect 为了校准可能多收了读数段里更早的，只给 finishCalib 用）
  // 读数是账号级的：给了 --project 时另按全部项目收一遍，隐形占比用账号级的可见 $ 算，报表其余部分仍只算 --project
  const acct = OPT.project && CALIB && CALIB.spentUsd > 0
    ? collect(collectFrom, { account: true }).rows : null;
  finishCalib(rows, win, acct);

  if (OPT.rounds) {                // 按轮视图优先于其他报表；没有记录时也走这里，好打出「没有 /route 的记录」（--json 时输出空结构）
    if (!OPT.json && scoped.length) console.log(`usage-audit  ·  ${scoped.length} 次 API 调用（原始 ${rawInWin} 行，去重率 ${pct(1 - scoped.length / rawInWin)}）  ·  ${Date.now() - t0}ms`);
    runRounds(scoped, since);
    return;
  }

  if (!scoped.length) { console.log('区间内没有用量记录'); return; }

  if (OPT.json) {
    console.log(JSON.stringify(snapshot(scoped), null, 2));
    return;
  }

  console.log(`usage-audit  ·  ${scoped.length} 次 API 调用（原始 ${rawInWin} 行，去重率 ${pct(1 - scoped.length / rawInWin)}）  ·  ${Date.now() - t0}ms`);
  console.log(`口径：输入 / 输出 / 读缓存 / 写缓存各按各的公开价算 $（只作大致对比，不是账单）  ·  活跃工时按间隔 ≤${ACTIVE_GAP_MIN}min 累加  ·  $ 只含 transcript 可见部分（实付约再多 ${pct(HID / (1 - HID))}）`);
  if (OPT.ttlSim || OPT.agents || OPT.sessions) console.log(calibLine());

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

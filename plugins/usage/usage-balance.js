#!/usr/bin/env node
'use strict';
/**
 * usage-balance —— 记一次「实付」读数，给 usage-audit.js 校准隐形占比用（用户自己跑，脚本不打印 key / URL / 响应原文）
 *
 * 用法（三种，各记一条到同目录的 calibration.jsonl）：
 *   node usage-balance.js --provider <供应商名> [--key-env <变量名>] [--rate <1 美元等于多少该币种>]
 *       读 switch 组件里的 providers/<供应商名>.json 的 balance 块，现查一次读数：
 *       - 真余额接口（DeepSeek /user/balance 那种）：记 balance + currency
 *       - new-api 中转站的累计用量接口：记 reading + unit（unit = 多少读数算 1 美元；每家的额度符号都不一样，所以要在文件里写明，不猜）
 *   node usage-balance.js --amount <数字> [--currency USD] [--rate …]     自己查到实付多少，手填
 *   node usage-balance.js --plan                                          包月套餐：只记一条，$ 列以后打 —
 *   --key-env 只能填环境变量的名字（照 provider.js 的校验）；不给就用供应商文件 keyEnv[] 里第一个有值的
 *
 * balance 块的写法（供应商文件里）：
 *   "balance": { "url": "https://api.deepseek.com/user/balance", "method": "GET", "auth": "bearer",
 *                "amountPath": "balance_infos.0.total_balance", "currencyPath": "balance_infos.0.currency" }
 *   "balance": { "url": "https://<中转站>/v1/dashboard/billing/usage", "auth": "bearer",
 *                "mode": "usage", "readingPath": "total_usage", "unit": <多少读数算 1 美元> }
 *
 * 校准怎么用：两次读数相减（余额减少 / 用量增加）就是这段时间的实付 $，和 transcript 可见 $ 一比得出隐形占比。
 * 所以这里只负责「记一次读数」，算账在 usage-audit.js 里。零成本：这些接口是纯 GET，不消耗 token。
 *
 * 隐私：整个过程只打印一行「余额 … / 读数 … / 已记录：…」；HTTP 出错只打状态码，不打 URL、响应体、key。
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const USAGE = '用法：node usage-balance.js --provider <名> [--key-env <变量名>] [--rate R] [--unit N]｜--amount <数字> [--currency USD] [--rate R]｜--plan';

const OUT = path.join(__dirname, 'calibration.jsonl');
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
/** 只看金额 / 读数这一类，不带 url、key：出错只留错误码 */
const codeOf = (e) => String((e && (e.cause && e.cause.code || e.code || e.name)) || 'error').slice(0, 40);
/** 供应商文件：装好后在 <插件目录>/switch/providers/，仓库 / 原地模式在 <插件目录>/plugins/switch/providers/ */
const providerFile = (name) => path.join(__dirname, '..', 'switch', 'providers', `${name}.json`);
/** a.b.0.c 取路径；取不到返回 undefined */
const pick = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

function append(rec) {
  try { fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); }
  catch (e) { die(`写不了 ${path.basename(OUT)}（${codeOf(e)}）`, 1); }
}
/** 环境变量名 + 用户名（keyEnv）的合法性；看着像 key 本身就不回显（照 provider.js） */
const looksLikeKeyNotName = (s) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s)) || /^(sk-|Bearer)/i.test(String(s));

// ---------- --plan / --amount ----------
if (has('--plan')) {
  append({ source: 'plan' });
  console.log('已记录：包月套餐（不记 $）');
  process.exit(0);
}

if (has('--amount')) {
  const raw = val('--amount', null);
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) die(`--amount 要一个 ≥ 0 的数字\n${USAGE}`);
  const currency = String(val('--currency', 'USD')).toUpperCase().slice(0, 8);
  const rate = Number(val('--rate', ''));
  append({ source: 'manual', amount, currency, ...(Number.isFinite(rate) && rate > 0 ? { rate } : {}) });
  console.log(`已记录：实付 ${amount} ${currency}`);
  process.exit(0);
}

// ---------- --provider ----------
const name = val('--provider', null);
if (!name) die(USAGE);
if (!/^[A-Za-z0-9._-]+$/.test(name)) die('--provider 要供应商文件的名字（字母、数字、点、横线、下划线）');

const file = providerFile(name);
if (!fs.existsSync(file)) die('--provider 需要 switch 组件，或用 --amount', 2);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${name}.json 读不了（${codeOf(e)}），没记`, 1); }
const b = cfg && cfg.balance;
if (!b || typeof b !== 'object' || !b.url) die(`${name}.json 里没有 balance 块（写法见 docs/GUIDE.md），没记`);

const keyEnvArg = val('--key-env', null);
if (keyEnvArg !== null && looksLikeKeyNotName(keyEnvArg)) die('--key-env 要填环境变量的名字（字母、数字、下划线，不能以数字开头）；为了不泄露，不回显你填的内容');
// 变量名：--key-env > keyEnv[] 里第一个有值的 > keyEnv[0]（有名字但没设也照着名字报「没设」，比「读不到」好排查）
const envName = keyEnvArg
  || (Array.isArray(cfg.keyEnv) && cfg.keyEnv.length ? (cfg.keyEnv.find((n) => process.env[n]) || cfg.keyEnv[0]) : null);
if (!envName) die(`${name}.json 里没有 keyEnv[]，用 --key-env <变量名> 指定 key 在哪个环境变量里`, 1);
const key = process.env[envName];
if (!key) die(`环境变量 ${envName} 没设${keyEnvArg ? '' : '（供应商文件 keyEnv[] 里列的）'}`, 1);

const mode = b.mode === 'usage' ? 'usage' : 'balance';
const rate = Number(val('--rate', ''));
const auth = b.auth === 'none' ? 'none' : b.auth === 'x-api-key' ? 'x-api-key' : 'bearer';

(async () => {
  let res;
  try {
    res = await fetch(String(b.url), {
      method: String(b.method || 'GET').toUpperCase(),
      headers: { ...(auth === 'bearer' ? { authorization: `Bearer ${key}` } : auth === 'x-api-key' ? { 'x-api-key': key } : {}), accept: 'application/json' },
      redirect: 'manual',   // 跳转不跟：key 不能被带到别的主机
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) { die(`连不上（${codeOf(e)}），没记`, 1); }
  if (!res.ok) die(`HTTP ${res.status}，没记`, 1);
  let j;
  try { j = await res.json(); } catch (e) { die(`响应不是 JSON（${codeOf(e)}），没记`, 1); }

  if (mode === 'usage') {
    const reading = Number(pick(j, b.readingPath || 'total_usage'));
    if (!Number.isFinite(reading)) die('响应里没有读数（readingPath 对不上），没记', 1);
    // unit = 「多少读数算 1 美元」：每家中转站的额度符号都不一样（有的是美分、有的是自家额度、有的还带汇率），
    // 所以不猜：供应商文件里写 unit，或者跑的时候加 --unit；都不给就只记读数、不折算
    const unitArg = Number(val('--unit', ''));
    if (val('--unit', null) !== null && !(unitArg > 0)) die(`--unit 要一个 > 0 的数字（多少读数算 1 美元）\n${USAGE}`);
    const unit = unitArg > 0 ? unitArg : (Number(b.unit) > 0 ? Number(b.unit) : 0);
    append({ source: 'api', provider: String(cfg.name || name), mode: 'usage', reading, ...(unit > 0 ? { unit } : {}) });
    console.log(unit > 0
      ? `读数 ${reading}（已记录；两次相减 ÷ unit ${unit} 得这段时间花了多少）`
      : `读数 ${reading}（已记录；这家没给 unit，只记读数、不折算 $ —— 想知道花了多少，在供应商文件的 balance 块里写 unit，或加 --unit）`);
    process.exit(0);
  }
  const amount = Number(pick(j, b.amountPath));
  if (!Number.isFinite(amount)) die('响应里没有金额（amountPath 对不上），没记', 1);
  const currency = String(pick(j, b.currencyPath) || b.currency || 'USD').toUpperCase().slice(0, 8);
  append({ source: 'api', provider: String(cfg.name || name), mode: 'balance', balance: amount, currency, ...(Number.isFinite(rate) && rate > 0 ? { rate } : {}) });
  console.log(`余额 ${amount.toFixed(2)} ${currency}（已记录）`);
})();

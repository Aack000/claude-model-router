#!/usr/bin/env node
'use strict';
/**
 * configure —— 装完接着配模型设置（setup 菜单里装完自动接着跑，也可以单独跑）
 *
 * 用法：node configure.js [--dry-run] [--yes] [--items=<编号或名字，逗号分隔>|all|none]
 *   --dry-run   只打印会做什么，不改任何文件
 *   --yes       不问，按默认勾的来（没给 --items 时）
 *   --items=…   只做这几项：编号（列表里的序号）或名字（subagent、effort…），all = 全做，none = 都不做。给了就不再逐项问
 * 不给 --items 也不给 --yes：先列出每一项的状态，再问一次；回车 = 按勾的来，输入编号 = 只要这几项，0 = 都不要；
 * 输入已结束（管道、没有终端）时不问，按默认勾的来。
 *
 * 配的是本机用户级 settings.json（配置目录认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude），逐项判断：
 *   已配（同推荐）／已配（值不同，保留）／缺。值不同的一律不改，只在列表里标出差异；缺的才补。
 *
 *   编号 名字      做什么                                              默认
 *   1    subagent  删 env.CLAUDE_CODE_SUBAGENT_MODEL（有它时）            勾  它会让子代理的 model 设置失效，code-reviewer 被静默降级
 *   2    effort    modelSettings：sonnet high / fable xhigh / opus xhigh / haiku low，只补缺的别名   勾
 *   3    fallback  顶层 effortLevel = "high"（modelSettings 没列到的模型用它）    勾
 *   4    model     顶层 model = "opus"（本机没有才补）                    勾  归卡片，见下
 *   5    compact   autoCompactWindow = 500000                          不勾 个人选择
 *   6    cache     promptCacheTtl = "1h"                               不勾 第三方网关多数不支持 1h 缓存
 *   7    pwsh      env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "1"（只在 Windows 列出）  不勾
 *
 * 只报告、不写：ANTHROPIC_DEFAULT_*_MODEL 没钉时提示一行（模型 ID 跟网关走，猜错的代价是调用全失败）。
 *
 * CC Switch：
 *   · 新版（~/.cc-switch/ 里有 cc-switch.db 和 live-state.json）切卡时，env 里 ANTHROPIC_*、CLAUDE_CODE_SUBAGENT_MODEL 和顶层 model 等
 *     「关键字段」归卡片，其余键（modelSettings、effortLevel、autoCompactWindow、promptCacheTtl、permissions……）原样保留。
 *     所以上面除 model 和 subagent 外写本机一次就够，切卡不丢；model 和 subagent 写本机 = 写进当前卡片，别的卡片各有各的。
 *   · 旧版（有 cc-switch.db、没有 live-state.json）切卡会整份覆盖本机文件，这里只警告，不做卡片同步。
 *   · 有数据库时只读打开它（不写、不开写事务），列出 env 里还带着 CLAUDE_CODE_SUBAGENT_MODEL 的卡片名（只打印卡片名），请你在 CC Switch 里删。
 *
 * 安全：
 *   · 写之前备份 settings.json 成 <原名>.bak-model-router-<时间>（撞名加 -2、-3），路径记进安装清单；
 *     写回保持原文件的缩进 / 换行（CRLF）/ BOM / 末尾换行；
 *   · 写完重读核对：把本次的改动撤回后必须和写之前一字不差（env 里只允许少掉 CLAUDE_CODE_SUBAGENT_MODEL、多出 CLAUDE_CODE_USE_POWERSHELL_TOOL，
 *     别的键只允许多出上表里的），不一致就从备份恢复、exit 1；
 *   · 任何输出都不打印 env 里除这两个键以外的值；JSON 读不了也不回显原文（原文里有 token）；
 *   · 备份前后各核一次：等输入期间 settings.json 被别人（CC Switch 切卡、你自己）改了，按最新内容重算，不会拿旧内容覆盖。
 *
 * 记进安装清单（<配置目录>/plugins/model-router/.install-manifest.json）的 settingsChanges，卸载按它撤回：
 *   { path: ['modelSettings','sonnet','effortLevel'], op: 'add', value: 'high' }      加的键：卸载时值仍等于 value 才删
 *   { path: ['env','CLAUDE_CODE_SUBAGENT_MODEL'], op: 'remove', old: <原值> }          删的键：old 是删之前的原值，卸载时可以恢复
 * 重跑只追加新的（path、op、值都一样的不重复记）。需要先装好插件（清单存在）：没有就提示先装，exit 1。
 *
 * 退出码：0 成功（含没有要改的、选了都不要）；1 失败（没装插件、settings.json 读不了、写后核对不一致）；2 参数不认识。
 *
 * 环境变量 MR_CONFIGURE_TEST_PLATFORM、MR_CONFIGURE_TEST_TAMPER 只给测试用（用户不要设）：
 *   前者假装在别的平台（测「pwsh 只在 Windows 列出」）；后者在写完之后、核对之前偷偷改一个键（测「核对不一致就从备份恢复」）。
 * Windows / macOS / Linux 通用，只要有 Node.js；读 CC Switch 的卡片要 Node 22.5+（node:sqlite），没有就只提示、不影响配置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
// 配置目录是不是默认的 ~/.claude（CC Switch 只管这一份）；Windows、macOS 上不分大小写（和 install.js 一致）
const lowerKey = (p) => { const r = path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };
const IS_DEFAULT = lowerKey(CLAUDE) === lowerKey(path.join(os.homedir(), '.claude'));
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(CLAUDE, 'plugins', 'model-router', '.install-manifest.json');
const CCS_DIR = path.join(os.homedir(), '.cc-switch');
const CCS_DB = path.join(CCS_DIR, 'cc-switch.db');
const CCS_LIVE = path.join(CCS_DIR, 'live-state.json');
const USAGE = '用法：node configure.js [--dry-run] [--yes] [--items=<编号或名字，逗号分隔>|all|none]';
const PLAT = process.env.MR_CONFIGURE_TEST_PLATFORM || process.platform;

const SUB = 'CLAUDE_CODE_SUBAGENT_MODEL';
const PWSH = 'CLAUDE_CODE_USE_POWERSHELL_TOOL';
const EFFORT = [['sonnet', 'high'], ['fable', 'xhigh'], ['opus', 'xhigh'], ['haiku', 'low']];
const PINNED = ['FABLE', 'OPUS', 'SONNET', 'HAIKU'];
/** 项目表：顺序就是列表里的编号；def = 默认勾不勾（只对「有活可干」的项有意义） */
const ITEMS = [
  { id: 'subagent', def: true },
  { id: 'effort', def: true },
  { id: 'fallback', def: true },
  { id: 'model', def: true },
  { id: 'compact', def: false },
  { id: 'cache', def: false },
  { id: 'pwsh', def: false, winOnly: true },
];
const VISIBLE = ITEMS.filter((i) => !i.winOnly || PLAT === 'win32');

const BOM = String.fromCharCode(0xFEFF);   // 不直接写字面量，免得源码里混进不可见字符
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
/** 备份名撞了就加 -2、-3：同一秒连跑两次，第二次不能盖掉第一次 */
const uniq = (p) => { let q = p, i = 2; while (fs.existsSync(q)) q = `${p}-${i++}`; return q; };
/** 解析 JSON：出错只说「不行」，不回显原文（原文里有 token；Node 的报错信息里会带一段原文） */
const tryParse = (t) => { try { return { ok: true, v: JSON.parse(String(t).charCodeAt(0) === BOM.charCodeAt(0) ? String(t).slice(1) : t) }; } catch { return { ok: false }; } };
/** 打印一个值：只放行看起来像模型名 / 档位的短字符串和数字，别的不显示（这些键的值不该是密钥，但输出里一个密钥都不许有） */
const disp = (v) => {
  if (typeof v === 'string') return /^[\w.\-[\]:\/ ]{0,60}$/.test(v) && !/sk-|key|token|secret|bearer/i.test(v) ? JSON.stringify(v) : '（不是常规值，不显示）';
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return '（不是常规值，不显示）';
};
/** 同一个值？数字和字符串形式的数字算同一个（env 里的值本来都是字符串） */
const same = (a, b) => (typeof a !== 'object' && typeof b !== 'object' && a != null && b != null ? String(a) === String(b) : isDeepStrictEqual(a, b));

// ---------- 按路径读写 ----------
const getPath = (o, p) => { let x = o; for (const k of p) { if (!isObj(x) || !has(x, k)) return undefined; x = x[k]; } return x; };
const hasPath = (o, p) => { let x = o; for (const k of p) { if (!isObj(x) || !has(x, k)) return false; x = x[k]; } return true; };
function setPath(o, p, v) {
  let x = o;
  for (const k of p.slice(0, -1)) { if (!isObj(x[k])) x[k] = {}; x = x[k]; }
  x[p[p.length - 1]] = v;
}
function delPath(o, p) {
  let x = o;
  for (const k of p.slice(0, -1)) { if (!isObj(x) || !has(x, k)) return; x = x[k]; }
  if (isObj(x)) delete x[p[p.length - 1]];
}
const dotted = (p) => p.join('.');

// ---------- 读一行输入（照 setup.js：同步逐字节读，不在 stdin 上留挂起的读，和 setup.js 的菜单、install.js 的提问不抢同一行）----------
function readLineSync(q) {
  process.stdout.write(q);
  const buf = Buffer.alloc(1), bytes = [];
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, 1, null); } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); continue; }
      if (e.code === 'EOF') n = 0; else throw e;
    }
    if (n === 0) return bytes.length ? Buffer.from(bytes).toString().replace(/\r$/, '') : null;
    if (buf[0] === 0x0a) return Buffer.from(bytes).toString().replace(/\r$/, '');
    bytes.push(buf[0]);
  }
}

// ---------- 参数 ----------
/** 解析选择：编号（列表里的序号）或名字，逗号 / 空格分隔；all、none、0。有不认识的返回 null */
function parseSel(s) {
  const toks = String(s).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0] === 'all') return new Set(VISIBLE.map((i) => i.id));
  if (toks.length === 1 && (toks[0] === 'none' || toks[0] === '0')) return new Set();
  const out = new Set();
  for (const t of toks) {
    const it = /^\d+$/.test(t) ? VISIBLE[Number(t) - 1] : ITEMS.find((x) => x.id === t);
    if (!it) return null;
    out.add(it.id);
  }
  return out;
}

// ---------- 判断每一项的状态 ----------
/**
 * 看一份 settings 对象，逐项给出 { work: [改动], text: 一句状态, warn: 要提醒的 }。
 * 改动 = { path, op:'add', value } | { path, op:'remove', old }。work 为空 = 没活可干（已配 / 保留 / 动不了）
 */
function analyze(j) {
  const out = {};
  const envBad = has(j, 'env') && !isObj(j.env);
  const env = isObj(j.env) ? j.env : null;

  // subagent：有就删
  if (envBad) out.subagent = { work: [], text: 'env 不是对象，没法动，跳过', warn: true };
  else if (env && has(env, SUB)) {
    out.subagent = { work: [{ path: ['env', SUB], op: 'remove', old: env[SUB] }],
      text: `有 env.${SUB}（现值 ${disp(env[SUB])}）→ 删掉。它会让子代理的 model 设置失效，code-reviewer 被静默降级；它归卡片，见下` };
  } else out.subagent = { work: [], text: `没有 env.${SUB}，不用动` };

  // effort：modelSettings 四个别名，只补缺的
  if (has(j, 'modelSettings') && !isObj(j.modelSettings)) out.effort = { work: [], text: 'modelSettings 不是对象，没法动，跳过', warn: true };
  else {
    const ms = isObj(j.modelSettings) ? j.modelSettings : {};
    const work = [], ok = [], diff = [], miss = [], bad = [];
    for (const [alias, rec] of EFFORT) {
      const e = has(ms, alias) ? ms[alias] : undefined;
      if (e !== undefined && !isObj(e)) { bad.push(alias); continue; }
      const cur = e && has(e, 'effortLevel') ? e.effortLevel : undefined;
      if (cur === undefined) { work.push({ path: ['modelSettings', alias, 'effortLevel'], op: 'add', value: rec }); miss.push(`${alias}→${rec}`); }
      else if (same(cur, rec)) ok.push(`${alias}=${disp(cur)}`);
      else diff.push(`${alias}=${disp(cur)}（推荐 ${rec}）`);
    }
    const parts = [];
    if (miss.length) parts.push(`缺 ${miss.join('、')}，补上`);
    if (ok.length) parts.push(`已配（同推荐）${ok.join('、')}`);
    if (diff.length) parts.push(`已配（值不同，保留）${diff.join('、')}`);
    if (bad.length) parts.push(`${bad.join('、')} 不是对象，没法动，跳过`);
    out.effort = { work, text: parts.join('；'), warn: !!bad.length };
  }

  // 顶层键
  const top = (key, rec, what, extra) => {
    if (!has(j, key)) return { work: [{ path: [key], op: 'add', value: rec }], text: `缺 ${key}，补 ${JSON.stringify(rec)}${what ? `（${what}）` : ''}${extra || ''}` };
    return { work: [], text: same(j[key], rec) ? `已配（同推荐）${disp(j[key])}` : `已配（值不同，保留）${disp(j[key])}（推荐 ${JSON.stringify(rec)}）` };
  };
  out.fallback = top('effortLevel', 'high', 'modelSettings 没列到的模型用它');
  out.model = top('model', 'opus', '主模型；归卡片：写本机 = 写进当前卡片，别的卡片不管');
  out.compact = top('autoCompactWindow', 500000, '上下文到「这个值 − 1.3 万」时自动压缩；个人选择，子代理继承同一个值');
  out.cache = top('promptCacheTtl', '1h', '主会话用 1h 缓存；Kimi、百炼、OpenRouter 等网关不支持，按自己的网关定');

  // pwsh：env 里的开关
  if (PLAT !== 'win32') out.pwsh = { work: [], text: '只在 Windows 上有，不适用', na: true };
  else if (envBad) out.pwsh = { work: [], text: 'env 不是对象，没法动，跳过', warn: true };
  else if (env && has(env, PWSH)) out.pwsh = { work: [], text: same(env[PWSH], '1') ? `已配（同推荐）${disp(env[PWSH])}` : `已配（值不同，保留）${disp(env[PWSH])}（推荐 "1"）` };
  else out.pwsh = { work: [{ path: ['env', PWSH], op: 'add', value: '1' }], text: `缺 env.${PWSH}，补 "1"（启用 PowerShell 工具）` };
  return out;
}

/** 在副本上套用改动，返回新对象 */
function applyChanges(j, changes) {
  const o = clone(j);
  for (const c of changes) { if (c.op === 'add') setPath(o, c.path, c.value); else delPath(o, c.path); }
  return o;
}

/**
 * 写后核对：k = 写完重读的对象，orig = 写之前的对象。
 * 加的键必须在、值对；删的键必须没了；把这些改动撤回后（加的键删掉——父对象原来没有的整个删掉，删的键按原值放回）必须和 orig 深相等，
 * 也就是除了本次改的键，其余一字不差
 */
function verify(orig, k, changes) {
  if (!isObj(k)) return false;
  for (const c of changes) {
    if (c.op === 'add' && !(hasPath(k, c.path) && isDeepStrictEqual(getPath(k, c.path), c.value))) return false;
    if (c.op === 'remove' && hasPath(k, c.path)) return false;
  }
  const probe = clone(k);
  for (const c of changes) {
    if (c.op === 'add') {
      let i = 0, o = orig;   // i = 沿路径走到第一个「原来就没有」的那一段（那一段及以下都是本次建的）
      while (i < c.path.length - 1 && isObj(o) && has(o, c.path[i])) { o = o[c.path[i]]; i++; }
      delPath(probe, c.path.slice(0, i + 1));
    } else setPath(probe, c.path, c.old);
  }
  return isDeepStrictEqual(probe, orig);
}

/** 按原文的习惯写回：有换行就缩进（沿用原缩进，否则 2 空格），没有就紧凑；沿用 CRLF、末尾换行、BOM（照 ccswitch-caps.js 的 fmt） */
function fmt(oldText, obj) {
  const bom = oldText.charCodeAt(0) === BOM.charCodeAt(0) ? BOM : '';
  const body = bom ? oldText.slice(1) : oldText;
  let indent;
  if (body.includes('\n')) {
    const m = body.match(/^([ \t]+)\S/m);
    indent = m ? (m[1].startsWith('\t') ? '\t' : m[1].length) : 2;
  }
  let s = JSON.stringify(obj, null, indent);
  if (/\r?\n$/.test(body)) s += '\n';
  if (body.includes('\r\n')) s = s.replace(/\n/g, '\r\n');
  return bom + s;
}

// ---------- CC Switch ----------
let SqliteCls;   // 只载一次：重复载会把 emitWarning 包好几层
/** 载入 node:sqlite，只压掉它的 ExperimentalWarning、别的警告照常；这个 Node 没有就返回 null */
function loadSqlite() {
  if (SqliteCls !== undefined) return SqliteCls;
  try {
    const orig = process.emitWarning;
    process.emitWarning = function (w, ...a) {
      const name = isObj(w) || w instanceof Error ? w.name : (typeof a[0] === 'string' ? a[0] : a[0]?.type);
      const msg = typeof w === 'string' ? w : w?.message;
      if (name === 'ExperimentalWarning' && /sqlite/i.test(String(msg))) return;
      return orig.call(process, w, ...a);
    };
    SqliteCls = require('node:sqlite').DatabaseSync;
  } catch { SqliteCls = null; }
  return SqliteCls;
}
/** 只读查 CC Switch 当前的 claude 卡片，只取 id、name：{ id, name } | { none: true }（没有当前卡片）| { err } */
function currentCard() {
  const Sqlite = loadSqlite();
  if (!Sqlite) return { err: `这个 Node（${process.version}）没有 node:sqlite` };
  let db;
  try {
    db = new Sqlite(CCS_DB, { readOnly: true });
    const r = db.prepare("SELECT id, name FROM providers WHERE app_type = 'claude' AND is_current = 1").get();
    return r ? { id: String(r.id), name: String(r.name) } : { none: true };
  } catch (e) { return { err: `读 CC Switch 数据库失败（${String(e && e.message || e).slice(0, 120)}）` }; } finally { try { if (db) db.close(); } catch { /* 没开成 */ } }
}
/** 只读打开 CC Switch 的库，列出 env 里带 CLAUDE_CODE_SUBAGENT_MODEL 的 claude 卡片（只取卡片名和是否当前，不碰配置里的别的内容） */
function cardsWithSubagent() {
  const Sqlite = loadSqlite();
  if (!Sqlite) return { status: 'nosqlite' };
  let db;
  try {
    db = new Sqlite(CCS_DB, { readOnly: true });
    const rows = db.prepare("SELECT name, settings_config, is_current FROM providers WHERE app_type = 'claude' ORDER BY sort_index, created_at, id").all();
    const cards = [];
    let unreadable = 0;
    for (const r of rows) {
      const p = tryParse(r.settings_config);
      if (!p.ok || !isObj(p.v)) { unreadable++; continue; }
      if (isObj(p.v.env) && has(p.v.env, SUB)) cards.push({ name: String(r.name), current: !!r.is_current });
    }
    return { status: 'ok', cards, unreadable, total: rows.length };
  } catch (e) { return { status: 'error', msg: String(e && e.message || e).slice(0, 120) }; } finally { try { if (db) db.close(); } catch { /* 没开成 */ } }
}

// ---------- 主流程 ----------
function main() {
  const argv = process.argv.slice(2);
  let DRY = false, YES = false, itemsArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') DRY = true;
    else if (a === '--yes') YES = true;
    else if (a.startsWith('--items=')) itemsArg = a.slice(8);
    else if (a === '--items' && i + 1 < argv.length) itemsArg = argv[++i];
    // PowerShell 调 .ps1 时会把 --items=a,b 拆成「--items=a」「b」两个参数，跟在后面的裸名字接回去（同 install.js 的 --rules）
    else if (itemsArg !== null && !a.startsWith('-')) itemsArg += `,${a}`;
    else { console.error(`不认识的参数：${a}\n${USAGE}`); process.exit(2); }
  }
  let pre = null;   // --items 给的选择
  if (itemsArg !== null) {
    pre = parseSel(itemsArg);
    if (!pre) { console.error(`✗ --items 里有不认识的：${itemsArg}（可选 ${VISIBLE.map((i, n) => `${n + 1}=${i.id}`).join('、')}，或 all / none）\n${USAGE}`); process.exit(2); }
  }
  const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);
  const fail = (s) => { console.error(s); process.exit(1); };

  // ---------- 没装插件就先装 ----------
  if (!fs.existsSync(MANIFEST)) fail('还没装插件：先装插件（setup 菜单 1），再配这一步。什么都没改。');
  let m;
  try { const mp = tryParse(fs.readFileSync(MANIFEST, 'utf8')); if (!mp.ok || !isObj(mp.v)) throw new Error('bad'); m = mp.v; } catch { fail('安装清单读不了（不是合法 JSON），什么都没改。'); }

  /** 读 settings.json；读不了、不是 JSON 对象就退出（此时还什么都没改）。env 不打印 */
  const readSettings = () => {
    if (!fs.existsSync(SETTINGS)) return { exists: false, raw: '{}\n', j: {} };
    let raw;
    try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch { fail(`✗ 读不了 ${SETTINGS}，什么都没改。`); }
    const p = tryParse(raw);
    if (!p.ok || !isObj(p.v)) fail(`✗ ${SETTINGS} 不是合法的 JSON 对象，什么都没改。修好后重跑。`);
    return { exists: true, raw, j: p.v };
  };
  let { exists, raw, j } = readSettings();
  let plan = analyze(j);

  // ---------- 列出状态 ----------
  console.log(`配置文件：${SETTINGS}${exists ? '' : '（还不存在，会新建）'}`);
  const ccDb = fs.existsSync(CCS_DB), ccLive = fs.existsSync(CCS_LIVE);
  if (ccDb && ccLive) console.log('CC Switch：新版。下面除 model、subagent 外写本机文件一次就够，切卡不丢；model、ANTHROPIC_DEFAULT_*_MODEL、CLAUDE_CODE_SUBAGENT_MODEL 归卡片（写本机 = 写进当前卡片，别的卡片各有各的）。');
  else if (ccDb) console.log('⚠ CC Switch：旧版（有 cc-switch.db、没有 live-state.json）。旧版切卡会整份覆盖本机 settings.json，这里配的会被冲掉：要么升级 CC Switch，要么把这些设置同步进每张卡片。');
  if (ccDb && !IS_DEFAULT) {
    console.log(`  （你设了 CLAUDE_CONFIG_DIR=${CLAUDE}：CC Switch 默认写的是 ~/.claude，除非它也指到了这个目录，上面关于它的说法不一定适用）`);
  }
  console.log('');
  const labelOf = { subagent: '删子代理模型覆盖', effort: '各模型 effort', fallback: '默认 effort', model: '主模型', compact: '自动压缩窗口', cache: '1h 缓存', pwsh: 'PowerShell 工具' };
  VISIBLE.forEach((it, i) => {
    const p = plan[it.id];
    const mark = p.work.length ? (it.def ? '[x]' : '[ ]') : '[-]';
    console.log(`  ${mark} ${i + 1} ${it.id.padEnd(8)} ${labelOf[it.id]}：${p.warn ? '⚠ ' : ''}${p.text}`);
  });
  console.log('      [x] 默认做　[ ] 默认不做（个人选择，按自己的网关定）　[-] 没有要做的（已配 / 保留 / 动不了）');

  // 只报告：ANTHROPIC_DEFAULT_*_MODEL 没钉
  const env0 = isObj(j.env) ? j.env : {};
  const unpinned = PINNED.filter((a) => !has(env0, `ANTHROPIC_DEFAULT_${a}_MODEL`));
  if (unpinned.length) console.log(`\nℹ ANTHROPIC_DEFAULT_{${unpinned.join(',')}}_MODEL 没钉：别名会用 CLI 内置的默认版本。模型 ID 跟网关走，这里不替你写；用 CC Switch 卡片或手动配（docs/GUIDE.md）。`);

  // Q1：只读扫一遍 CC Switch 的卡片，列出还带着 CLAUDE_CODE_SUBAGENT_MODEL 的卡片名
  if (ccDb) {
    const r = cardsWithSubagent();
    if (r.status === 'nosqlite') console.log(`\nℹ 这个 Node（${process.version}）没有 node:sqlite（要 22.5 以上），查不了 CC Switch 的卡片里有没有带 ${SUB}；自己在 CC Switch 的卡片编辑框里看一眼，有就删。`);
    else if (r.status === 'error') console.log(`\nℹ 读 CC Switch 的数据库失败（${r.msg}），没法查卡片里有没有带 ${SUB}；自己在 CC Switch 里看一眼。`);
    else {
      if (!r.cards.length) console.log(`\nCC Switch 的 ${r.total} 张 claude 卡片里，没有带 ${SUB} 的。`);
      else {
        console.log(`\n⚠ CC Switch 里这些卡片的 env 也带着 ${SUB}：${r.cards.map((c) => `「${c.name}」${c.current ? '（当前）' : ''}`).join('、')}`);
        console.log('  切到非当前的卡片它就回来了，请在 CC Switch 里把这个键删掉（本脚本只读数据库，不改它）；当前卡片以本机文件为准，本机删了、切走时 CC Switch 会同步。');
      }
      if (r.unreadable) console.log(`  （另有 ${r.unreadable} 张卡片的配置读不了，没查）`);
    }
  }
  console.log('');

  // ---------- 选 ----------
  const defaults = () => new Set(VISIBLE.filter((i) => i.def).map((i) => i.id));
  const names = (s) => (s.size ? ITEMS.filter((i) => s.has(i.id)).map((i) => i.id).join('、') : '一项都不要');
  const anyWork = VISIBLE.some((i) => plan[i.id].work.length);
  let sel;
  if (!anyWork) { console.log('没有要补的，什么都没改。'); process.exit(0); }
  if (pre) sel = pre;
  else if (YES) sel = defaults();
  else {
    for (;;) {
      const a = readLineSync('回车 = 按 [x] 的来；输入编号 = 只要这几项（如 1 3）；0 = 一项都不要：');
      if (!process.stdin.isTTY) process.stdout.write('\n');   // 管道里的输入不会回显换行
      if (a === null) { sel = defaults(); console.log(`（没有可交互的输入，按默认的来：${names(sel)}）`); break; }
      if (!a.trim()) { sel = defaults(); break; }
      sel = parseSel(a);
      if (sel) break;
      console.log(`看不懂「${a.trim()}」，再输一次。`);
    }
  }
  if (pre) {
    const na = [...pre].filter((id) => !VISIBLE.some((i) => i.id === id));
    if (na.length) console.log(`${na.join('、')}：这个平台用不上，跳过。`);
  }
  say(`选了：${names(sel)}`);

  // 等输入可能等了很久（CC Switch 切卡、你自己改配置都会写 settings.json）：写回之前重新读，别拿开头那份旧内容把别人的改动冲掉
  const first = raw;
  ({ exists, raw, j } = readSettings());
  plan = analyze(j);
  if (raw !== first) console.log('等输入期间 settings.json 变了，按最新内容重算。');
  const changes = VISIBLE.filter((i) => sel.has(i.id)).flatMap((i) => plan[i.id].work);
  if (!changes.length) { console.log(DRY ? '试运行结束，没改任何文件。' : sel.size ? '选的这几项都没有要做的，什么都没改。' : '什么都没选，什么都没改。'); process.exit(0); }

  say(`要做的改动（${changes.length} 处）：`);
  for (const c of changes) {
    if (c.op === 'add') say(`  + ${dotted(c.path)} = ${JSON.stringify(c.value)}`);
    else say(`  - ${dotted(c.path)}（原值 ${disp(c.old)}；记进安装清单，卸载时可以恢复）`);
  }
  if (DRY) { console.log('\n试运行结束，没改任何文件。'); process.exit(0); }

  // ---------- 备份、写、核对 ----------
  const newObj = applyChanges(j, changes);
  const text = fmt(raw, newObj);
  let bak = null;
  /** 恢复到写之前：有备份就拷回去，原来没有这个文件就删掉新建的；现在已经是写之前的样子（比如写根本没成功）就不用动 */
  const restore = () => {
    try {
      const cur = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;
      if (bak ? cur === raw : cur === null) return true;
      if (bak) { fs.copyFileSync(bak, SETTINGS); return fs.readFileSync(SETTINGS, 'utf8') === raw; }
      fs.rmSync(SETTINGS, { force: true }); return true;
    } catch { return false; }
  };
  const abort = (why) => {
    const back = restore();
    console.error(`✗ ${why}；${back ? 'settings.json 已恢复成写之前的样子（有改动的已从备份恢复）' : `恢复也没成功，请用备份 ${bak || '（无备份：原来没有这个文件）'} 手动恢复`}。`);
    process.exit(1);
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    if (exists) {
      bak = uniq(`${SETTINGS}.bak-model-router-${stamp()}`);
      fs.copyFileSync(SETTINGS, bak);
      // 备份的就是此刻的文件：和刚读的不一样，说明有人在这几毫秒里改了它
      if (fs.readFileSync(bak, 'utf8') !== raw) { try { fs.unlinkSync(bak); } catch { /* 删不掉就留着 */ } fail('✗ settings.json 刚被别的程序改过，没动。再跑一次。'); }
    }
  } catch (e) { fail(`✗ 备份失败（${e.code || '出错'}），什么都没改。`); }
  say(`备份 ${bak ? path.basename(bak) : '（原来没有这个文件，不用备份）'}`);

  let ok = false, why = '写完核对不一致（写出去的和预期的不一样，或除本次改的键外别的内容变了）';
  try {
    fs.writeFileSync(SETTINGS, text);
    if (process.env.MR_CONFIGURE_TEST_TAMPER) { const t = clone(newObj); t.model = 'tampered-by-test'; fs.writeFileSync(SETTINGS, fmt(raw, t)); }
    const back = fs.readFileSync(SETTINGS, 'utf8'), p = tryParse(back);
    ok = back === text && p.ok && verify(j, p.v, changes);
  } catch (e) { ok = false; why = `写 settings.json 出错（${e.code || '未知错误'}）`; }
  if (!ok) abort(why);
  say('核对通过：除了上面这些键，settings.json 其余内容一字不差');

  // ---------- 记进安装清单 ----------
  // 归卡片管的键（model、env.CLAUDE_CODE_SUBAGENT_MODEL）顺带记下当前是哪张卡片：卸载时当前卡片不是这张就不撤，免得撤到别的卡片上（复审 R2）。
  // 只在本机文件归 CC Switch 管时记（有它的库、配置目录是默认的 ~/.claude）；查不出当前卡片就不记，提醒一句
  const CARD_KEYS = new Set(['model', `env.${SUB}`]);
  let card = null;
  if (ccDb && IS_DEFAULT && changes.some((c) => CARD_KEYS.has(dotted(c.path)))) {
    const c = currentCard();
    if (c.id !== undefined) card = c;
    else if (c.err) console.log(`ℹ 查不了 CC Switch 当前是哪张卡片（${c.err}），清单里 model / ${SUB} 这几条没记卡片；卸载前请先切回现在这张卡片。`);
  }
  const keyOf = (e) => `${e.op}|${JSON.stringify(e.path)}|${JSON.stringify(e.op === 'add' ? e.value : e.old)}`;
  const list = Array.isArray(m.settingsChanges) ? m.settingsChanges : [];
  const seen = new Set(list.filter(isObj).map(keyOf));
  let added = 0;
  for (const c of changes) {
    const e = c.op === 'add' ? { path: c.path, op: 'add', value: c.value } : { path: c.path, op: 'remove', old: c.old };
    if (card && CARD_KEYS.has(dotted(c.path))) e.card = { id: card.id, name: card.name };
    if (seen.has(keyOf(e))) continue;   // 重跑：path、op、值都一样的不重复记
    seen.add(keyOf(e)); list.push(e); added++;
  }
  m.settingsChanges = list;
  m.backups = [...(Array.isArray(m.backups) ? m.backups : []), ...(bak ? [bak] : [])];
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n'); } catch { abort('安装清单写不进去（卸载就撤不回这些改动）'); }

  console.log(`\n配好了。清单里记了 ${added} 条${bak ? `；备份 ${path.basename(bak)}` : ''}。重启 Claude Code 生效；跑一次 doctor.js 体检。撤回：卸载插件时会按清单撤回。`);
}

main();

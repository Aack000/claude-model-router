#!/usr/bin/env node
'use strict';
/**
 * ccswitch-caps —— 给 CC Switch 里映射到第三方模型的卡片补「能力声明」（可选步骤，安装入口菜单 4）
 *
 * 用法：node ccswitch-caps.js [--dry-run] [--yes] [--db <路径>] [--undo]
 *   --dry-run   只打印计划，不改任何文件
 *   --yes       不问「确认？」直接做
 *   --db <路径> CC Switch 数据库的位置；默认 ~/.cc-switch/cc-switch.db。撤回时先用清单记录里的库路径，不在了才用这个（不退回默认位置）；没记路径的旧记录先用这个、再用默认位置
 *   --undo      撤回之前补的（只删值还等于当时补的那个的键；值被改过的报一次、以后不再管；撤不了的记录留在清单里）；卸载时 uninstall.js 也会调同一段
 *
 * 为什么：Claude Code 按模型 ID 判断能不能调 effort、能不能开 thinking，第三方模型（deepseek-flash[1M] 之类）它不认识，
 * 要在 env 里声明 ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL_SUPPORTED_CAPABILITIES。本脚本替你补到 CC Switch 的卡片里，
 * 以后在 CC Switch 里切到这张卡片，能力声明就跟着走。
 *
 * 怎么判断补什么：读本目录 providers/*.json，用 ANTHROPIC_BASE_URL 的主机名去认卡片；
 * 卡片里四个别名的 _MODEL 去掉 [1M] 之类后缀后不以 claude- 开头的，算第三方模型：
 *   缺 _SUPPORTED_CAPABILITIES → 补供应商文件里同一别名的值（没有就用文件里任意一个别名的）；缺 _NAME → 补去掉后缀的模型 ID。
 *   已有的键一律不改。主机名认不出的卡片只列出来、不动。
 * 当前卡片（CC Switch 里选中的）的真实配置是本机 ~/.claude/settings.json（设了 CLAUDE_CONFIG_DIR 就是那个目录下的），数据库里那份只是副本，补的时候以本机文件为准：
 *   本机缺、要补的键，数据库副本也缺就两边一起补；本机已有的键（不管什么值），副本缺也不补、不记——
 *   用户可能在 CC Switch 编辑框里自己加过（编辑框写的是本机文件、不回写副本），切走时 CC Switch 会用本机文件回填副本。
 * 没有 CC Switch 数据库就只处理本机 settings.json。
 *
 * 安全：
 *   · 先打印计划再问；要写数据库时 CC Switch 必须已退出（它在运行会拿内存里的旧数据覆盖回去），在运行就什么都不改直接退出；
 *     确认之后、真正写之前（备份和提交之前）再查一次，等确认期间又打开了它也一样拒绝
 *   · 检测不了它在不在运行（没有 tasklist / pgrep）：补的路径警告后由确认提示兜底；撤回 / 卸载没有确认提示，单独问一次「它已经退出了吗」，
 *     没答 y（含输入结束）按「在运行」处理
 *   · 写之前备份数据库和 settings.json（<原名>.bak-model-router-<时间>），路径记进安装清单；
 *     数据库在事务里改、旧文本当乐观锁；写完重读核对「去掉本次加的键后和原来一模一样」，不一致就从备份恢复
 *   · 任何输出都不带 env 的值，只有模型 ID 和本次加的能力值；base URL 只打印主机名；JSON 解析出错也不回显原文
 *   · 补了什么记在安装清单的 ccswitchCaps 里，--undo / 卸载按它撤回。每条记录 { cardId, cardName, key, value, sides, db }：
 *     sides = 实际写入的位置（'local' 本机文件 / 'db' 数据库副本，可以两个都有），db = 数据库的绝对路径（本机文件那条是 null）。
 *     撤回时每处都是「值仍等于记录的值才删」：
 *       含 'local'（补的时候它是当前卡片）：现在仍是当前卡片就删本机文件里的（sides 含 'db' 再删副本里的）；现在不是了，只删数据库那行
 *         （切走时 CC Switch 已把本机文件回填进去；本机文件现在是别的卡片的配置，不碰）
 *       只有 'db'（补的时候不是当前卡片）：现在是当前卡片就两边都删（切过来时 CC Switch 把副本写进了本机文件），否则只删数据库
 *     值被改过的记录报一次就从清单去掉；只有「撤不了」（找不到库、没有 node:sqlite 等）的才留着
 * 要 Node 22.13+（node:sqlite；22.5–22.12 要加 --experimental-sqlite）；没有就打印手动补的步骤。需要先装好插件（安装清单存在）。
 *
 * 这个文件也能被 require：导出 undoManifest（--undo 和 uninstall.js 共用）、ccRunning、analyze。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）。
// CC Switch 的库仍在 ~/.cc-switch（CC Switch 自己的目录，和 CLAUDE_CONFIG_DIR 无关）
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(CLAUDE, 'plugins', 'model-router', '.install-manifest.json');
const DEFAULT_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const USAGE = '用法：node ccswitch-caps.js [--dry-run] [--yes] [--db <路径>] [--undo]';

const ALIASES = ['FABLE', 'OPUS', 'SONNET', 'HAIKU'];
const kModel = (a) => `ANTHROPIC_DEFAULT_${a}_MODEL`;
const kName = (a) => `${kModel(a)}_NAME`;
const kCaps = (a) => `${kModel(a)}_SUPPORTED_CAPABILITIES`;

const BOM = String.fromCharCode(0xFEFF);   // 不直接写字面量，免得源码里混进不可见字符
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
/** 备份名撞了就加 -2、-3：同一秒连跑两次，第二次不能盖掉第一次 */
const uniq = (p) => { let q = p, i = 2; while (fs.existsSync(q)) q = `${p}-${i++}`; return q; };
/** 解析 JSON：出错只说「不行」，不回显原文（原文里有 token） */
const tryParse = (t) => { try { return { ok: true, v: JSON.parse(String(t).charCodeAt(0) === BOM.charCodeAt(0) ? String(t).slice(1) : t) }; } catch { return { ok: false }; } };
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase() || null; } catch { return null; } };
const bareId = (v) => String(v).replace(/\[[^\]]*\]\s*$/, '').trim();

// ---------- 读一行输入（照 setup.js：同步逐字节读，不在 stdin 上留挂起的读）----------
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
/** 问 y/N；--yes 直接过；输入结束（EOF）当作 N */
function confirmYes(yes) {
  if (yes) return true;
  const a = readLineSync('确认？[y/N]：');
  if (!process.stdin.isTTY) process.stdout.write('\n');   // 管道里的输入不会回显换行
  if (a === null) console.log('\n（输入已结束，按 N 处理）');
  return a !== null && /^y(es)?$/i.test(a.trim());
}

// ---------- node:sqlite ----------
let warnMuted = false;
/** 只压掉 SQLite 的 ExperimentalWarning，别的警告照常 */
function muteSqliteWarning() {
  if (warnMuted) return;
  warnMuted = true;
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...a) {
    const name = isObj(w) || w instanceof Error ? w.name : (typeof a[0] === 'string' ? a[0] : a[0]?.type);
    const msg = typeof w === 'string' ? w : w?.message;
    if (name === 'ExperimentalWarning' && /sqlite/i.test(String(msg))) return;
    return orig.call(process, w, ...a);
  };
}
/** 返回 DatabaseSync；Node 太旧（低于 22.5，或 22.5–22.12 没加 flag）返回 null */
function loadSqlite() {
  muteSqliteWarning();
  try { return require('node:sqlite').DatabaseSync; } catch { return null; }
}
/** 撤回失败时给的出口：手动删了就不用再撤，卸载时加 --keep-ccswitch-caps 跳过这一步 */
const KEEP_HINT = '手动在 CC Switch 卡片里删掉这几行后，加 --keep-ccswitch-caps 再卸载';
/** 没有 node:sqlite：什么都没改，打印手动补的步骤（只有能力值和 _NAME），调用方 exit 1 */
function printNoSqlite(provs) {
  console.error(`✗ 这个 Node（${process.version}）没有 node:sqlite（要 22.13 以上），读不了 CC Switch 的数据库，什么都没改。`);
  console.error('  升级 Node 后重跑这一步；或者可以手动在 CC Switch 的卡片里加这几行（卡片的编辑框里，env 里加，保存；只给映射到对应供应商的别名加）：');
  for (const p of provs) {
    const lines = Object.entries(p.env).filter(([k, v]) => typeof v === 'string' && /_MODEL_(NAME|SUPPORTED_CAPABILITIES)$/.test(k));
    if (!lines.length) continue;
    console.error(`  供应商 ${p.name}（${p.host}）：`);
    for (const [k, v] of lines) console.error(`    ${k} = ${v}`);
  }
}

// ---------- CC Switch 在不在运行 ----------
/**
 * true 在运行；false 没有；null 查不出来。
 * 两个环境变量只给测试用（用户不要设）：
 *   MR_CCSWITCH_IMAGE     覆盖要查的镜像名
 *   MR_CCSWITCH_TEST_SEQ  逗号分隔的结果序列：第 n 次调用返回第 n 项（用完后一直是最后一项），项为 run / idle / unknown，
 *                         分别模拟「在运行」「没在运行」「检测不了」——用来测「检测不了」和「确认之后写之前再查一次」
 */
let ccCalls = 0;
function ccRunning() {
  const seq = process.env.MR_CCSWITCH_TEST_SEQ;
  if (seq) {
    const a = seq.split(',').map((s) => s.trim()), v = a[Math.min(ccCalls++, a.length - 1)];
    return v === 'run' ? true : v === 'idle' ? false : null;
  }
  const img = process.env.MR_CCSWITCH_IMAGE;
  try {
    if (process.platform === 'win32') {
      const name = img || 'cc-switch.exe';
      const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true });
      if (r.error || r.status !== 0) return null;
      return r.stdout.toString('latin1').toLowerCase().includes(name.toLowerCase());
    }
    const r = spawnSync('pgrep', ['-i', img || 'cc[- ]switch'], { encoding: 'utf8' });
    if (r.error) return null;
    return r.status === 0 ? true : r.status === 1 ? false : null;
  } catch { return null; }
}

// ---------- 供应商表 ----------
function loadProviders() {
  const dir = path.join(__dirname, 'providers');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const p = tryParse(fs.readFileSync(path.join(dir, n), 'utf8'));
    if (!p.ok || !isObj(p.v) || !isObj(p.v.env)) { console.log(`供应商文件 providers/${n} 读不了，跳过`); continue; }
    const host = hostOf(p.v.env.ANTHROPIC_BASE_URL);
    if (host) out.push({ file: n, name: p.v.name || n.slice(0, -5), host, env: p.v.env });
  }
  return out;
}
/** 这个供应商里某个别名的能力声明；该别名没有就取任意一个别名的；都没有返回 null */
function capsFor(prov, alias) {
  const ok = (v) => (typeof v === 'string' && v ? v : null);
  const own = ok(prov.env[kCaps(alias)]);
  if (own) return own;
  for (const a of ALIASES) { const v = ok(prov.env[kCaps(a)]); if (v) return v; }
  return null;
}

/**
 * 看一份 env 要补什么。返回 { third: 第三方别名, host, prov: 认出的供应商或 null, adds: [{alias, model, items:[{key,value}]}], noCaps }
 * noCaps：供应商文件里没有能力声明可补
 */
function analyze(env, provs) {
  const r = { third: [], host: null, prov: null, adds: [], noCaps: false };
  if (!isObj(env)) return r;
  for (const a of ALIASES) {
    const v = env[kModel(a)];
    if (typeof v !== 'string') continue;
    const id = bareId(v);
    if (!id || /^claude-/i.test(id)) continue;
    r.third.push({ alias: a, model: v, id });
  }
  if (!r.third.length) return r;
  r.host = hostOf(env.ANTHROPIC_BASE_URL);
  r.prov = r.host ? provs.find((p) => p.host === r.host) || null : null;
  if (!r.prov) return r;
  for (const t of r.third) {
    const items = [];
    if (!has(env, kName(t.alias))) items.push({ key: kName(t.alias), value: t.id });
    if (!has(env, kCaps(t.alias))) {
      const v = capsFor(r.prov, t.alias);
      if (v == null) r.noCaps = true; else items.push({ key: kCaps(t.alias), value: v });
    }
    if (items.length) r.adds.push({ alias: t.alias, model: t.model, items });
  }
  return r;
}

// ---------- 读写 ----------
/** 按原文的习惯写回：有换行就缩进（detect 时沿用原缩进，否则 2 空格），没有就紧凑；沿用 CRLF、末尾换行、BOM */
function fmt(oldText, obj, detect) {
  const bom = oldText.charCodeAt(0) === BOM.charCodeAt(0) ? BOM : '';
  const body = bom ? oldText.slice(1) : oldText;
  let indent;
  if (body.includes('\n')) {
    const m = detect ? body.match(/^([ \t]+)\S/m) : null;
    indent = m ? (m[1].startsWith('\t') ? '\t' : m[1].length) : 2;
  }
  let s = JSON.stringify(obj, null, indent);
  if (/\r?\n$/.test(body)) s += '\n';
  if (body.includes('\r\n')) s = s.replace(/\n/g, '\r\n');
  return bom + s;
}
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function readLocal() {
  if (!fs.existsSync(SETTINGS)) return { exists: false, ok: false };
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const p = tryParse(raw);
  return { exists: true, ok: p.ok && isObj(p.v), raw, j: p.ok ? p.v : null };
}
/** claude 卡片，当前卡片在 is_current 上 */
function readRows(dbPath, Sqlite) {
  const db = new Sqlite(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'claude' ORDER BY sort_index, created_at, id")
      .all().map((r) => ({ id: r.id, name: r.name, settings_config: r.settings_config, is_current: !!r.is_current }));
  } finally { db.close(); }
}
const snap = (db) => new Map(db.prepare('SELECT * FROM providers').all().map((r) => [`${r.id}|${r.app_type}`, { ...r }]));

/**
 * 在一个事务里改数据库。edits = [{ id, name, oldText, newText, verify(parsed) }]；旧文本不对（卡片被别人改过）整个回滚。
 * 返回 { ok } 或 { ok:false, changed, reason }；changed = 已经提交了（调用方要从备份恢复）
 */
function applyDbEdits(dbPath, Sqlite, edits) {
  const db = new Sqlite(dbPath);
  let changed = false;
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const before = snap(db);
    db.exec('BEGIN IMMEDIATE');
    const up = db.prepare("UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = 'claude' AND settings_config = ?");
    for (const e of edits) {
      if (Number(up.run(e.newText, e.id, e.oldText).changes) !== 1) {
        db.exec('ROLLBACK');
        return { ok: false, changed: false, reason: `卡片「${e.name}」在这期间被改过，没动` };
      }
    }
    db.exec('COMMIT');
    changed = true;
    // 核对：没动的行一字不差；动过的行除 settings_config 外各列不变，新文本重读后「去掉本次改动」和原来深相等
    const after = snap(db), byKey = new Map(edits.map((e) => [`${e.id}|claude`, e]));
    let bad = after.size !== before.size;
    for (const [k, rb] of before) {
      const ra = after.get(k), e = byKey.get(k);
      if (!ra) { bad = true; break; }
      if (!e) { if (!isDeepStrictEqual(rb, ra)) bad = true; continue; }
      const { settings_config: _o, ...restB } = rb, { settings_config: sa, ...restA } = ra;
      const p = tryParse(sa);
      if (!isDeepStrictEqual(restB, restA) || sa !== e.newText || !p.ok || !e.verify(p.v)) bad = true;
    }
    return bad ? { ok: false, changed, reason: '写完核对不一致（数据库里其他列或其余内容变了）' } : { ok: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 没有开着的事务 */ }
    return { ok: false, changed, reason: `写数据库出错：${e.message}` };
  } finally { db.close(); }
}

/**
 * 落盘：先备份（数据库、settings.json 各一份），再写库、写本机文件，核对；失败就从备份恢复。
 * edits = { db: [...applyDbEdits 的 edits], local: { oldRaw, newRaw, verify } | null }
 * 返回 { ok, reason, backups }
 */
function commit(edits, ctx) {
  const backups = [];
  try {
    if (edits.local) {   // 等确认期间本机文件被别人（CC Switch 切卡、用户自己）改了就不动
      let now = null; try { now = fs.readFileSync(SETTINGS, 'utf8'); } catch { /* 读不到 */ }
      if (now !== edits.local.oldRaw) return { ok: false, reason: '本机 settings.json 在这期间被改过，没动', backups };
    }
    const TS = stamp();
    const mk = (f) => { const b = uniq(`${f}.bak-model-router-${TS}`); fs.copyFileSync(f, b); backups.push(b); return b; };
    const bakDb = edits.db.length ? mk(ctx.dbPath) : null;
    const bakLocal = edits.local ? mk(SETTINGS) : null;
    const restore = () => { if (bakDb) fs.copyFileSync(bakDb, ctx.dbPath); if (bakLocal) fs.copyFileSync(bakLocal, SETTINGS); };

    if (edits.db.length) {
      const r = applyDbEdits(ctx.dbPath, ctx.Sqlite, edits.db);
      if (!r.ok) {
        if (r.changed) { restore(); return { ok: false, reason: `${r.reason}；已从备份恢复`, backups }; }
        for (const b of backups) { try { fs.unlinkSync(b); } catch { /* 删不掉就留着 */ } }   // 事务已回滚、库没变：这次的备份没用
        return { ok: false, reason: r.reason, backups: [] };
      }
    }
    if (edits.local) {
      let ok = false;
      try {
        fs.writeFileSync(SETTINGS, edits.local.newRaw);
        const back = fs.readFileSync(SETTINGS, 'utf8'), p = tryParse(back);
        ok = back === edits.local.newRaw && p.ok && edits.local.verify(p.v);
      } catch { /* 当作失败 */ }
      if (!ok) { restore(); return { ok: false, reason: '写完核对 settings.json 不一致；已从备份恢复', backups }; }
    }
    return { ok: true, backups };
  } catch (e) {
    return { ok: false, reason: `出错：${e.message}（如有部分已写，备份在 ${backups.join('、') || '无'}）`, backups };
  }
}

const sideTxt = (db, local) => [db && '数据库', local && '本机 settings.json'].filter(Boolean).join('＋');

// ---------- 撤回（--undo 和 uninstall.js 共用）----------
/** 记录里的 sides 规范化：本机文件那条（cardId null）只有 'local'；没有 sides 的旧记录当作 ['db']（现在是当前卡片时撤回规则会再带上本机文件） */
function sidesOf(e) {
  if (e.cardId == null) return ['local'];
  const s = Array.isArray(e.sides) ? e.sides.filter((x) => x === 'local' || x === 'db') : [];
  return s.length ? [...new Set(s)] : ['db'];
}
/** 撤回时有些写库路径没有确认提示（卸载），检测不了 CC Switch 在不在运行时单独问一次；只有明确答 y 才算它已退出（输入结束 = N） */
function askExited() {
  const a = readLineSync('没法检测 CC Switch 是否在运行。它已经退出了吗？[y/N]：');
  if (!process.stdin.isTTY) process.stdout.write('\n');
  if (a === null) console.log('\n（输入已结束，按「在运行」处理）');
  return a !== null && /^y(es)?$/i.test(a.trim());
}

/**
 * 按安装清单 m.ccswitchCaps 撤回。o = { dry, yes, confirm, db, say, retry }
 *   confirm：要不要问「确认？」（uninstall.js 前面已经问过「确认卸载」，传 false；没有确认提示的路径检测不了 CC Switch 时会单独问一次「它已退出了吗」）
 *   db：--db 指的库，记录里的库路径找不到时再用它；retry：被 CC Switch 在运行挡住时提示怎么重来
 * 每条记录用哪个库：记录里的 db → o.db（不退回默认位置）；没有 db 的旧记录 o.db → 默认位置。都找不到这条就是「撤不了」
 * 返回 { code, unreachable }：code 0 正常（含取消、试运行），1 被挡住（CC Switch 在运行 / 没有 node:sqlite / 读库失败 / 写失败），什么都没改或已恢复；
 *   unreachable = 撤不了的条目数（记录留在清单里；uninstall.js 据此中止卸载）
 * 非试运行时会把剩下的记录（撤不了的、写失败的）、新备份写回清单文件，并同步改传进来的 m；撤成的、值被改过的（报一次）都从清单去掉
 */
function undoManifest(m, o = {}) {
  const dry = !!o.dry;
  const say = o.say || ((s) => console.log((dry ? '[试运行] ' : '') + s));
  const all = Array.isArray(m.ccswitchCaps) ? m.ccswitchCaps : [];
  const valid = (e) => isObj(e) && typeof e.key === 'string' && typeof e.value === 'string';
  const entries = all.filter(valid), strange = all.filter((e) => !valid(e));
  if (!entries.length) return { code: 0, empty: true, unreachable: 0 };

  // 每条要动数据库的记录用哪个库。记录里写了库路径的，那个库不在时只退回使用方这次显式给的 --db、不退回默认库：
  // 默认库里没有这张卡片会被当成「卡片删了」而丢掉记录，默认库若是那个库的副本还会删到真库里的键（复审 M8）。
  // 没写路径的旧记录才按 --db、默认库找。fallback = 用的不是记录里的那个库：这时库里找不到卡片算「撤不了」，不算「已经不在了」
  const findDb = (e) => {
    const own = typeof e.db === 'string' && e.db ? path.resolve(e.db) : null;
    for (const c of own ? [own, o.db] : [o.db, DEFAULT_DB]) {
      if (typeof c !== 'string' || !c) continue;
      const p = path.resolve(c);
      if (fs.existsSync(p)) return { p, fallback: !!own && p !== own };
    }
    return null;
  };
  const groups = new Map();   // 库路径 → { rows: id → 行, parsed: id → 解析后的配置, del: id → 要删的键 }
  const dbOfEntry = new Map(), fallbackOf = new Map();
  for (const e of entries) {
    if (e.cardId == null) continue;
    const found = findDb(e), p = found ? found.p : null;
    dbOfEntry.set(e, p);
    fallbackOf.set(e, !!(found && found.fallback));
    if (p && !groups.has(p)) groups.set(p, { rows: new Map(), parsed: new Map(), del: new Map() });
  }
  let Sqlite = null;
  if (groups.size) {
    Sqlite = loadSqlite();
    if (!Sqlite) {
      console.error(`✗ 这个 Node（${process.version}）没有 node:sqlite，撤不了 CC Switch 数据库里的记录，什么都没改。`);
      console.error(`  升级 Node 后重跑；或者${KEEP_HINT}。要删的是（只删值还是下面这个的）：`);
      for (const e of entries.filter((x) => dbOfEntry.get(x))) console.error(`    「${e.cardName}」${e.key} = ${e.value}`);
      return { code: 1, unreachable: 0 };
    }
    for (const [p, g] of groups) {
      try { g.rows = new Map(readRows(p, Sqlite).map((r) => [r.id, r])); } catch (e) {
        console.error(`✗ 读 CC Switch 数据库失败：${e.message}。什么都没改。`);
        console.error(`  把数据库修好或放回原处后重跑；或者${KEEP_HINT}。`);
        return { code: 1, unreachable: 0 };
      }
      for (const [id, r] of g.rows) { const pr = tryParse(r.settings_config); if (pr.ok && isObj(pr.v)) g.parsed.set(id, pr.v); }
    }
  }
  const local = readLocal();
  const recorded = (cardId, key) => new Set(entries.filter((x) => x.cardId === cardId && x.key === key).map((x) => x.value));

  // 逐条看：删哪些、哪些值被改过。每处都是「值仍等于记录的值才删」
  const localDel = new Set(), results = [];
  const note = [];
  for (const e of entries) {
    const rec = recorded(e.cardId, e.key), who = e.cardId == null ? '本机 settings.json' : `「${e.cardName}」`;
    const sides = sidesOf(e);
    let removed = 0, modified = 0, unreachable = null, inDb = false, inLocal = false, dbPath = null;
    const look = (env, onDelete) => {
      if (!isObj(env) || !has(env, e.key)) return;
      if (rec.has(env[e.key])) { removed++; onDelete(); } else modified++;
    };
    const lookLocal = () => {
      if (!local.ok) { if (local.exists) unreachable = '本机 settings.json 读不了'; return; }
      look(local.j.env, () => { localDel.add(e.key); inLocal = true; });
    };
    if (e.cardId == null) lookLocal();
    else {
      dbPath = dbOfEntry.get(e);
      if (!dbPath) unreachable = '找不到 CC Switch 数据库';
      else {
        const g = groups.get(dbPath), row = g.rows.get(e.cardId);
        if (row) {
          // 本机文件：现在是当前卡片才动（不是的话它已经是别的卡片的配置了，切走时 CC Switch 把它回填进了这张卡片的副本）。
          // 数据库那行：除了「补的时候是当前卡片、只补了本机文件、现在仍是当前卡片」，都要看
          const wantLocal = row.is_current, wantDb = !(sides.includes('local') && row.is_current && !sides.includes('db'));
          if (wantDb) {
            if (!g.parsed.has(e.cardId)) unreachable = '这张卡片的配置读不了';
            else look(g.parsed.get(e.cardId).env, () => { if (!g.del.has(e.cardId)) g.del.set(e.cardId, new Set()); g.del.get(e.cardId).add(e.key); inDb = true; });
          }
          if (wantLocal) lookLocal();
        } else if (fallbackOf.get(e)) unreachable = '记录里的数据库不在了，--db 给的库里也没有这张卡片';
      }
    }
    let status, line;
    if (unreachable) { status = 'unreachable'; line = `${who} ${e.key}：${unreachable}，没法撤回，记录留着`; }
    // 有一处值还等于补的那个就删那一处、记录算撤完：另一处（数据库副本 / 本机文件）值不一样多半是使用方自己的，不算「被改过」
    else if (removed) { status = 'done'; line = `${who} 去掉 ${e.key}（${sideTxt(inDb, inLocal)}）${modified ? '；另一处的值不是补的那个，没动' : ''}`; }
    // 所有位置的值都不是补的那个：这几行已经算使用方自己的了，报这一次，记录去掉，以后不再管
    else if (modified) { status = 'modified'; line = `${who} ${e.key}：值被改过，留着，以后不再管这一条`; }
    else { status = 'done'; line = `${who} ${e.key}：已经不在了，记录去掉`; }
    results.push({ e, status, dbPath: inDb ? dbPath : null, local: inLocal });
    note.push(line);
  }
  say(`撤回之前补的能力声明（${entries.length} 条）：`);
  for (const l of note) say(`  ${l}`);
  const unreachableN = results.filter((r) => r.status === 'unreachable').length;

  // 要写的东西：每个库一个单元（本机文件的改动并进第 0 个单元，一次备份、一次核对，失败一起恢复）
  const units = [];
  for (const [p, g] of groups) {
    const edits = { db: [], local: null };
    for (const [id, keys] of g.del) {
      const row = g.rows.get(id), obj = g.parsed.get(id);
      const newObj = { ...obj, env: omit(obj.env, [...keys]) };
      edits.db.push({ id, name: row.name, oldText: row.settings_config, newText: fmt(row.settings_config, newObj, false), verify: (pp) => isDeepStrictEqual(pp, newObj) });
    }
    units.push({ path: p, edits });
  }
  if (localDel.size) {
    const newObj = { ...local.j, env: omit(local.j.env, [...localDel]) };
    if (!units.length) units.push({ path: null, edits: { db: [], local: null } });
    units[0].edits.local = { oldRaw: local.raw, newRaw: fmt(local.raw, newObj, true), verify: (pp) => isDeepStrictEqual(pp, newObj) };
  }
  const todo = units.filter((u) => u.edits.db.length || u.edits.local);
  const needDbWrite = todo.some((u) => u.edits.db.length);
  /** 写成功的单元；条目要写的位置都成功了才算撤成 */
  const okUnits = new Set();
  const finish = (backups) => {   // 撤成的、值被改过的从清单去掉；撤不了的、没写成的留着，新备份记进去
    if (dry) return;
    const wrote = (r) => (!r.local || okUnits.has(units[0])) && (!r.dbPath || okUnits.has(units.find((u) => u.path === r.dbPath)));
    const left = results.filter((r) => r.status === 'unreachable' || (r.status === 'done' && !wrote(r))).map((r) => r.e);
    m.ccswitchCaps = [...strange, ...left];
    m.backups = [...(m.backups || []), ...backups];
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  };
  const refuseRunning = () => {
    console.error(`✗ CC Switch 正在运行：先退出 CC Switch（托盘图标右键退出），${o.retry || '再跑一次'}。什么都没改。`);
    return { code: 1, running: true, unreachable: 0 };
  };
  if (!todo.length) { say('没有要动的值'); finish([]); return { code: 0, unreachable: unreachableN }; }
  const running = needDbWrite ? ccRunning() : false;
  if (dry) {
    if (running) say('注意：CC Switch 正在运行，正式跑会在这里停下、什么都不改；先退出 CC Switch（托盘图标右键退出）。下面是退出后会做的事。');
    else if (running === null && !o.confirm) say('注意：没法检测 CC Switch 是否在运行，正式跑会先问一次「它已经退出了吗」。');
    return { code: 0, unreachable: unreachableN };
  }
  if (running) return refuseRunning();
  if (running === null) {
    if (o.confirm) console.log('⚠ 没法检测 CC Switch 是否在运行，请自己确认它已退出。');   // 有确认提示兜底
    else if (!askExited()) return refuseRunning();   // 没有确认提示（卸载）：单独问；没答 y 按「在运行」处理
  }
  if (o.confirm && !confirmYes(o.yes)) { console.log('取消了，什么都没改。'); return { code: 0, cancelled: true, unreachable: unreachableN }; }
  // 等确认 / 等回答期间 CC Switch 可能又被打开了：真正写之前（备份和提交之前）再查一次，只有明确查到在运行才拒绝
  if (needDbWrite && ccRunning() === true) return refuseRunning();
  const backups = [];
  for (const u of todo) {
    const r = commit(u.edits, { dbPath: u.path, Sqlite });
    backups.push(...r.backups);
    if (!r.ok) {
      console.error(`✗ ${r.reason}${r.backups.length ? `。备份：${r.backups.join('、')}` : ''}`);
      if (okUnits.size) { console.error('  前面已经写成功的单元不回滚，记录已按实际情况更新。'); finish(backups); }
      return { code: 1, unreachable: unreachableN };
    }
    okUnits.add(u);
    say(`核对通过：只去掉了上面那些键，其余内容一字不差${r.backups.length ? `；备份 ${r.backups.map((b) => path.basename(b)).join('、')}` : ''}`);
  }
  finish(backups);
  return { code: 0, backups, unreachable: unreachableN };
}

// ---------- 补 ----------
function main() {
  const argv = process.argv.slice(2);
  let DRY = false, YES = false, UNDO = false, dbArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') DRY = true;
    else if (a === '--yes') YES = true;
    else if (a === '--undo') UNDO = true;
    else if (a === '--db' && i + 1 < argv.length) dbArg = argv[++i];
    else if (a.startsWith('--db=') && a.length > 5) dbArg = a.slice(5);
    else if (a === '--db' || a.startsWith('--db=')) { console.error(`--db 后面要跟数据库文件的路径\n${USAGE}`); process.exit(2); }
    else { console.error(`不认识的参数：${a}\n${USAGE}`); process.exit(2); }
  }
  const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);

  if (!fs.existsSync(MANIFEST)) { console.error('还没装插件：先装插件（setup 菜单 1），再补这一步。什么都没改。'); process.exit(1); }
  const mp = tryParse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!mp.ok || !isObj(mp.v)) { console.error('安装清单读不了（不是合法 JSON），什么都没改。'); process.exit(1); }
  const m = mp.v;

  if (UNDO) {
    if (!Array.isArray(m.ccswitchCaps) || !m.ccswitchCaps.length) { console.log('安装清单里没有补过能力声明的记录，没什么可撤回的。'); process.exit(0); }
    const r = undoManifest(m, { dry: DRY, yes: YES, confirm: !DRY, db: dbArg });
    if (!r.code && !r.cancelled && r.unreachable) {   // 撤不了的记录留在清单里
      console.error(`\n✗ 有 ${r.unreachable} 条撤不了（原因见上），记录留在清单里。把数据库放回原处，或用 --db <路径> 指到它现在的位置后再跑一次 --undo；也可以${KEEP_HINT}。`);
      if (DRY) console.log('\n试运行结束，没改任何文件。');
      process.exit(DRY ? 0 : 1);
    }
    if (!r.code && !r.cancelled) console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '撤回完成。'}`);
    process.exit(r.code);
  }

  const provs = loadProviders();
  if (!provs.length) { console.error('providers/ 里没有可用的供应商文件，没法判断卡片，什么都没改。'); process.exit(1); }
  const dbPath = dbArg ? path.resolve(dbArg) : DEFAULT_DB;
  const hasDb = fs.existsSync(dbPath);
  if (dbArg && !hasDb) { console.error(`指定的数据库不存在：${dbPath}。什么都没改。`); process.exit(1); }
  let Sqlite = null, rows = [];
  if (hasDb) {
    Sqlite = loadSqlite();
    if (!Sqlite) { printNoSqlite(provs); process.exit(1); }
    try { rows = readRows(dbPath, Sqlite); } catch (e) { console.error(`✗ 读 CC Switch 数据库失败：${e.message}。不像 CC Switch 的库，什么都没改。`); process.exit(1); }
  }
  const local = readLocal();
  const cur = rows.find((r) => r.is_current) || null;

  // ---------- 算计划 ----------
  const targets = [], skipped = [];   // targets：{ side, cardId, cardName, label, host, prov, adds, obj, text }
  const why = (a) => (!a.third.length ? '没有第三方模型（全是 claude-* 或没有映射），不用补'
    : !a.prov ? `不认识这个供应商，没动（主机名 ${a.host || '看不懂 base URL'}；第三方模型 ${[...new Set(a.third.map((t) => t.model))].join('、')}）`
      : a.noCaps && !a.adds.length ? `供应商文件里没有能力声明可补（${a.prov.name}）` : '能力声明和 _NAME 都已齐全，不用补');
  const consider = (side, cardId, cardName, label, obj, text, quietIfPlain) => {
    const a = analyze(obj.env, provs);
    if (a.adds.length) targets.push({ side, cardId, cardName, label, host: a.host, prov: a.prov, adds: a.adds, obj, text });
    else if (!(quietIfPlain && !a.third.length)) skipped.push({ label, why: why(a) });
  };
  // 当前卡片以本机 settings.json 为准：本机缺、要补的键，数据库副本也缺才一起补；本机已有的键（不管什么值）副本缺也不补、不记
  // （用户可能在 CC Switch 编辑框里自己加过，编辑框写的是本机文件、不回写副本；切走时 CC Switch 会用本机文件回填副本）
  const localUsable = local.exists && local.ok;
  const localAdd = new Set(localUsable ? analyze(local.j.env, provs).adds.flatMap((ad) => ad.items.map((it) => it.key)) : []);
  for (const r of rows) {
    const label = `「${r.name}」${r.is_current ? '（当前）' : ''}`;
    const p = tryParse(r.settings_config);
    if (!p.ok || !isObj(p.v)) { skipped.push({ label, why: '配置读不了（不是合法的 JSON 对象），没动' }); continue; }
    if (!r.is_current) { consider('db', r.id, r.name, label, p.v, r.settings_config, false); continue; }
    if (!localUsable) { skipped.push({ label, why: `当前卡片以本机 settings.json 为准，而它${local.exists ? '不是合法的 JSON 对象' : '不存在'}，数据库副本不单独补，没动` }); continue; }
    const a = analyze(p.v.env, provs);
    const adds = a.adds.map((ad) => ({ ...ad, items: ad.items.filter((it) => localAdd.has(it.key)) })).filter((ad) => ad.items.length);
    if (adds.length) targets.push({ side: 'db', cardId: r.id, cardName: r.name, label, host: a.host, prov: a.prov, adds, obj: p.v, text: r.settings_config });
    else skipped.push({ label, why: a.adds.length ? '当前卡片以本机 settings.json 为准：副本缺的键本机文件里已经有（或本机不用补），不补、不记' : why(a) });
  }
  if (local.exists) {
    const label = cur ? `本机 settings.json（当前卡片「${cur.name}」的真实配置）` : '本机 settings.json';
    if (!local.ok) skipped.push({ label, why: '不是合法的 JSON 对象，没动' });
    else consider('local', cur ? cur.id : null, cur ? cur.name : '(本机 settings.json)', label, local.j, local.raw, true);
  }

  // ---------- 打印计划 ----------
  console.log(`CC Switch 数据库：${hasDb ? `${dbPath}（claude 卡片 ${rows.length} 张${cur ? `，当前「${cur.name}」` : '，没有当前卡片'}）` : `没找到（${dbPath}），只处理本机 settings.json`}`);
  console.log(`本机 settings.json：${local.exists ? SETTINGS : '不存在'}\n`);
  if (targets.length) {
    say(`要补的（${targets.length} 处）：`);
    for (const t of targets) {
      say(`  ${t.side === 'db' ? `「${t.cardName}」· 数据库` : t.label}：${t.host}，按 ${t.prov.name} 的配置补`);
      for (const ad of t.adds) {
        say(`    ${ad.alias}  ${ad.model}`);
        for (const it of ad.items) say(`      + ${it.key} = ${it.value}`);
      }
    }
  } else say('没有要补的。');
  if (skipped.length) {
    say('不动的：');
    for (const s of skipped) say(`  ${s.label}：${s.why}`);
  }
  if (!targets.length) { console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '没有要做的，什么都没改。'}`); process.exit(0); }

  const needDb = targets.some((t) => t.side === 'db');
  const running = needDb ? ccRunning() : false;
  if (DRY) {
    if (running) say('注意：CC Switch 正在运行，正式跑会在这里停下、什么都不改；先退出 CC Switch（托盘图标右键退出）。');
    console.log('\n试运行结束，没改任何文件。');
    process.exit(0);
  }
  if (running) { console.error('\n✗ CC Switch 正在运行：先退出 CC Switch（托盘图标右键退出），再跑一次。什么都没改。'); process.exit(1); }
  if (running === null) console.log('\n⚠ 没法检测 CC Switch 是否在运行，请自己确认它已退出。');
  console.log('');
  if (!confirmYes(YES)) { console.log('取消了，什么都没改。'); process.exit(0); }
  // 等确认期间 CC Switch 可能又被打开了：真正写之前（备份和提交之前）再查一次，只有明确查到在运行才拒绝
  if (needDb && ccRunning() === true) { console.error('\n✗ CC Switch 正在运行：先退出 CC Switch（托盘图标右键退出），再跑一次。什么都没改。'); process.exit(1); }

  // ---------- 落盘 ----------
  const edits = { db: [], local: null };
  for (const t of targets) {
    const keys = t.adds.flatMap((ad) => ad.items.map((it) => it.key));
    const vals = Object.fromEntries(t.adds.flatMap((ad) => ad.items.map((it) => [it.key, it.value])));
    const newObj = { ...t.obj, env: { ...t.obj.env, ...vals } };
    // 核对：去掉本次加的键后和原来深相等，且加的键值就是计划里的
    const verify = (p) => isObj(p.env) && isDeepStrictEqual({ ...p, env: omit(p.env, keys) }, t.obj) && keys.every((k) => p.env[k] === vals[k]);
    if (t.side === 'db') edits.db.push({ id: t.cardId, name: t.cardName, oldText: t.text, newText: fmt(t.text, newObj, false), verify });
    else edits.local = { oldRaw: t.text, newRaw: fmt(t.text, newObj, true), verify };
  }
  const r = commit(edits, { dbPath, Sqlite });
  if (!r.ok) { console.error(`✗ ${r.reason}${r.backups.length ? `\n  备份：${r.backups.join('\n        ')}` : ''}`); process.exit(1); }

  // ---------- 记进安装清单 ----------
  // 每条记录写明补在哪：sides = 实际写入的位置（'local' 本机文件 / 'db' 数据库副本），db = 数据库的绝对路径（本机文件那条是 null）。
  // 当前卡片两边都补了、或重跑：同一卡片同一个键同一个值只记一条，sides 取并集
  const list = Array.isArray(m.ccswitchCaps) ? m.ccswitchCaps : [];
  const at = new Map();
  list.forEach((e, i) => { if (isObj(e)) at.set(`${e.cardId == null ? null : e.cardId}|${e.key}|${e.value}`, i); });
  let added = 0;
  for (const t of targets) for (const ad of t.adds) for (const it of ad.items) {
    const id = t.cardId == null ? null : t.cardId, k = `${id}|${it.key}|${it.value}`;
    if (at.has(k)) {
      const e = list[at.get(k)], s = new Set(sidesOf(e));
      s.add(t.side);
      e.sides = ['local', 'db'].filter((x) => s.has(x));
      if (id != null) e.db = dbPath;
      continue;
    }
    at.set(k, list.length);
    list.push({ cardId: id, cardName: t.cardName, key: it.key, value: it.value, sides: [t.side], db: id == null ? null : dbPath });
    added++;
  }
  m.ccswitchCaps = list;
  m.backups = [...(m.backups || []), ...r.backups];
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  console.log(`核对通过：去掉本次加的键后和原来一模一样，数据库其余列也没变。清单里记了 ${added} 条；备份：${r.backups.map((b) => path.basename(b)).join('、')}`);
  console.log(`\n补完了。${needDb ? '再打开 CC Switch 就行；' : ''}非当前卡片切过去时生效，当前卡片要重启 Claude Code。撤回：node ccswitch-caps.js --undo（卸载插件时也会撤）。`);
}

module.exports = { undoManifest, ccRunning, analyze, loadSqlite };

if (require.main === module) main();

#!/usr/bin/env node
'use strict';
/**
 * uninstall —— 撤回 install.js 做的事
 *
 * 用法：node ~/.claude/plugins/model-router/uninstall.js [--dry-run] [--keep-ccswitch-caps] [--keep-card-settings]；也可以跑安装入口（setup.*）选「卸载」
 *   - 清单里有 ccswitch-caps.js 给 CC Switch 卡片补过的能力声明（ccswitchCaps）：先撤回（只删值还等于当时补的那个的键，要备份；
 *     库的位置、补在数据库副本还是本机文件，记录里都有）。要动数据库而 CC Switch 在运行（或检测不了、又没答「已退出」）：提示退出它，整个卸载什么都不做；
 *     没有 node:sqlite / 读不了库 / 有记录撤不了（库找不到等）：同样整个卸载中止、什么都不动，撤成的记录从清单去掉、撤不了的留着。
 *     出口：把数据库放回原处再卸载，或加 --keep-ccswitch-caps 跳过这一步（卡片里补的留着，要去掉就在 CC Switch 的卡片里手动删）
 *   - 删 install.js 放进 ~/.claude/commands、~/.claude/agents、插件目录的文件；装完后被改过的不删，只提示
 *   - settings.json 去掉安装器加的放行规则；你原先自己加的不动。先备份，env 不打印、写完核对
 *   - 清单里有 settingsChanges（configure.js 配过的键）：加的键值仍是配置时的才去掉，改过的留着只提示；
 *     配置时删掉的 env.CLAUDE_CODE_SUBAGENT_MODEL 恢复成装之前的原值（现在已经有这个键就不动），恢复时提醒它会让子代理的 model 设置失效、体检会报。
 *     和放行规则同一次读、同一份备份、同一次写；写完把动过的键倒回去核对，其余内容一字不差。env 里除这两个键以外的值不打印
 *     model、env.CLAUDE_CODE_SUBAGENT_MODEL 归 CC Switch 的卡片管：记录里带着配置时的卡片，现在 CC Switch 的当前卡片不是那张（或查不出是哪张），
 *     整个卸载在动手前中止（清单一删就再也撤不回）；切回那张卡片再卸载，或加 --keep-card-settings 留着这两项、其余照常卸
 *     （加了这个参数，这两项不管撤不撤得了都不撤）。只在配置目录是默认的 ~/.claude 时才比卡片：CC Switch 只管这一份
 *   - 仓库本身就克隆在插件目录时不删仓库，提示自己删
 *   - 安装时做的备份 *.bak-* 一律不动，列出路径，要不要恢复由你定
 * 依据是插件目录里的 .install-manifest.json；没有它就说明不是 install.js 装的，什么都不做。
 * 配置目录 = 环境变量 CLAUDE_CONFIG_DIR，没设就是 ~/.claude；上面写的 ~/.claude 都指它（要和装的时候用同一个）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const KEEP_CAPS = argv.includes('--keep-ccswitch-caps');
const KEEP_CARD = argv.includes('--keep-card-settings');
const bad = argv.find((a) => a !== '--dry-run' && a !== '--keep-ccswitch-caps' && a !== '--keep-card-settings');
if (bad) { console.error(`不认识的参数：${bad}\n用法：node uninstall.js [--dry-run] [--keep-ccswitch-caps] [--keep-card-settings]`); process.exit(2); }

// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);

if (!fs.existsSync(MANIFEST)) {
  console.error(`没找到 ${MANIFEST}，看起来不是 install.js 装的，什么都没做。手动卸载见 docs/GUIDE.md。`);
  process.exit(1);
}
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// 清单里记的是绝对路径。配置目录换过位置（复制一份做第二套配置、改名、搬家）后，旧路径指向的是别的目录，照着删会删到原来那个目录（复审 R1）。
// 按记下的旧配置目录（旧清单没记 configDir 就从路径反推）把路径换到当前配置目录下；换不了的留原样，删之前还有 inCurrent 把关。和 install.js 同一段
function rebaseFiles(mf) {
  if (!mf || !Array.isArray(mf.files)) return;
  const fromPath = (f) => {
    const t = String(f.target || '');
    if (f.kind === 'plugin') { const i = t.search(/[\\/]plugins[\\/]model-router[\\/]/); return i > 0 ? t.slice(0, i) : null; }
    return f.kind === 'command' || f.kind === 'agent' ? path.dirname(path.dirname(t)) : null;
  };
  const old = typeof mf.configDir === 'string' && mf.configDir ? mf.configDir : mf.files.map(fromPath).find(Boolean);
  if (!old) return;
  for (const f of mf.files) {
    const r = path.relative(path.resolve(old), path.resolve(String(f.target)));
    if (r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) f.target = path.join(CLAUDE, r);
  }
}
/** p 在不在当前配置目录里面：不在的一律不删 */
const inCurrent = (p) => { const r = path.relative(CLAUDE, path.resolve(String(p))); return !!r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
rebaseFiles(m);

// 归卡片管的键（CC Switch 切卡时会换成新卡片的值，规划 §1.1）：configure.js 记录时带了当时的卡片 card:{id,name}。
// 现在 CC Switch 的当前卡片不是那张，就不能动本机文件——不然恢复 / 删除会落到另一张卡片上，切走时被 CC Switch 存进那张卡片（复审 R2）。
// 查不出当前是哪张（没有 node:sqlite、读库失败）也不动：写错卡片比没撤回更坏。
// 只在配置目录是默认的 ~/.claude 时才比（CC Switch 只管这一份，和 configure.js 记卡片的条件一致）：复制出来的配置目录带着记录也照常撤回（复审 N1）
const CARD_KEYS = new Set(['model', 'env.CLAUDE_CODE_SUBAGENT_MODEL']);
const lowerKey = (p) => { const r = path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };   // Windows、macOS 上不分大小写（和 install.js 一致）
const IS_DEFAULT = lowerKey(CLAUDE) === lowerKey(path.join(os.homedir(), '.claude'));
/**
 * 停下来时给的现成命令（双击菜单卸载传不了参数，要在命令行跑）：这次已经带的参数原样保留（含 --dry-run），再加上 flag，去重——
 * 只带 flag 的话，卡片和 ccswitchCaps 两处都停时，照抄会两头来回（复审 N3）。设了 CLAUDE_CONFIG_DIR 就写出解析后的绝对路径：原来是相对路径的话，换个当前目录就指到别处了
 */
const cmdWith = (flag) => {
  const args = [...new Set([...argv, ...(flag ? [flag] : [])])];
  return `  命令行这样跑（双击菜单传不了参数）：${process.env.CLAUDE_CONFIG_DIR ? `先把 CLAUDE_CONFIG_DIR 设成 ${CLAUDE}，再跑 ` : ''}node "${__filename}"${args.map((a) => ` ${a}`).join('')}`;
};
let curCard;   // 只查一次
function currentCard() {
  if (curCard !== undefined) return curCard;
  const db = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (!fs.existsSync(db)) return (curCard = { none: true });   // 没有 CC Switch 了：本机文件不归哪张卡片，照常撤回
  const orig = process.emitWarning;   // 只压掉 SQLite 的 ExperimentalWarning，别的警告照常（只走到这里一次，不会包两层）
  process.emitWarning = function (w, ...a) {
    const name = w !== null && typeof w === 'object' ? w.name : (typeof a[0] === 'string' ? a[0] : a[0]?.type);   // 预检时 isObj 还没定义，不能用它
    const msg = typeof w === 'string' ? w : w?.message;
    if (name === 'ExperimentalWarning' && /sqlite/i.test(String(msg))) return;
    return orig.call(process, w, ...a);
  };
  let Sqlite;
  try { Sqlite = require('node:sqlite').DatabaseSync; } catch { return (curCard = { err: `这个 Node（${process.version}）没有 node:sqlite，查不了 CC Switch 当前是哪张卡片` }); }
  let d;
  try {
    d = new Sqlite(db, { readOnly: true });   // 只取 id、name，不读卡片配置
    const r = d.prepare("SELECT id, name FROM providers WHERE app_type = 'claude' AND is_current = 1").get();
    return (curCard = r ? { id: String(r.id), name: String(r.name) } : { none: true });
  } catch (e) { return (curCard = { err: `读 CC Switch 数据库失败（${String(e && e.message || e).slice(0, 120)}）` }); } finally { try { if (d) d.close(); } catch { /* 没开成 */ } }
}
/** 这条归卡片管的记录现在不能撤的原因；能撤返回 null */
function cardBlock(name, card) {
  if (!IS_DEFAULT) return null;
  const c = currentCard();
  if (c.err) return `${name} 是配置时在卡片「${card.name}」上改的；${c.err}，不确定本机文件现在是不是那张卡片的`;
  if (!c.none && c.id !== card.id) return `${name} 属于卡片「${card.name}」，现在当前是「${c.name}」`;
  return null;
}
// 预检：卸载最后会删清单，删了这几项就再也撤不回，所以有撤不了的就在动任何东西之前停下（--keep-card-settings：这几项留着，其余照常卸）
if (!KEEP_CARD) {
  const firstByPath = new Map();
  for (const e of Array.isArray(m.settingsChanges) ? m.settingsChanges : []) {
    if (!e || typeof e !== 'object' || !Array.isArray(e.path) || !e.card || typeof e.card.id !== 'string') continue;
    const name = e.path.join('.');
    if (CARD_KEYS.has(name) && !firstByPath.has(name)) firstByPath.set(name, e.card);
  }
  const stuck = [...firstByPath].map(([name, card]) => cardBlock(name, card)).filter(Boolean);
  if (stuck.length) {
    console.error(`${DRY ? '[试运行] 正式卸载会在这里中止' : '卸载中止，什么都没动'}：这几项归 CC Switch 的卡片管，现在撤回会落到别的卡片上——`);
    for (const s of stuck) console.error(`  ${s}`);
    console.error('  两条路：在 CC Switch 切回那张卡片再卸载；或者加 --keep-card-settings，这几项留着不撤，其余照常卸载。');
    console.error(cmdWith('--keep-card-settings'));
    if (!DRY) process.exit(1);
  }
}
// 旧版清单只记一条 rule / ruleAdded
const ours = m.rulesAdded || (m.ruleAdded && m.rule ? [m.rule] : []);
const kept = [];

// CC Switch 卡片里补过的能力声明：趁插件文件还在先撤回。要动数据库而 CC Switch 在运行就在这里停下，下面一步都不做
if (Array.isArray(m.ccswitchCaps) && m.ccswitchCaps.length) {
  if (KEEP_CAPS) say('卡片里补的能力声明留着（--keep-ccswitch-caps）；清单随卸载一起删，以后要去掉就在 CC Switch 的卡片里手动删');
  else if (!fs.existsSync(path.join(__dirname, 'ccswitch-caps.js'))) say('同目录没有 ccswitch-caps.js（旧安装），跳过撤回；卡片里补的能力声明留着');
  else {
    const r = require(path.join(__dirname, 'ccswitch-caps.js')).undoManifest(m, { dry: DRY, confirm: false, say, retry: '再卸载一次（不想撤回卡片里的能力声明就加 --keep-ccswitch-caps 跳过这一步）' });
    if (r.code) {
      console.error('卸载没有继续：插件文件、命令、放行规则都没动。');
      if (!r.running) console.error(`  不想撤回卡片里的能力声明：手动在 CC Switch 卡片里删掉这几行后，加 --keep-ccswitch-caps 再卸载。\n${cmdWith('--keep-ccswitch-caps')}`);   // 没有 node:sqlite / 读库失败 / 写失败的出口
      else console.error(`  退出 CC Switch 后再卸载一次，用同样的参数：\n${cmdWith(null)}`);   // 用菜单重跑会丢掉这次带的参数（比如 --keep-card-settings），又被前面拦一次
      process.exit(r.code);
    }
    // 有撤不了的（找不到库等）：撤成的已从清单去掉，撤不了的留在清单里；整个卸载中止，不然清单一删，那几行就再没有工具能撤
    if (r.unreachable) {
      console.error(DRY ? `\n[试运行] 正式卸载会在这里中止：有 ${r.unreachable} 条撤不了（原因见上），记录会留在清单里。`
        : `\n卸载中止：有 ${r.unreachable} 条撤不了（原因见上），记录留在清单里；插件文件、命令、放行规则都没动。`);
      console.error('  两条路：把数据库放回原处再卸载（用过 --db 指别处的库，记录里带着路径，放回那里就行）；或者加 --keep-ccswitch-caps 卸载，补的留在卡片里。');
      console.error(cmdWith('--keep-ccswitch-caps'));
      if (!DRY) process.exit(1);
    }
  }
}

for (const f of m.files) {
  if (!fs.existsSync(f.target)) continue;
  if (!inCurrent(f.target)) { say(`清单记录的 ${f.target} 不在当前配置目录 ${CLAUDE} 里，没动`); continue; }
  if (sha(f.target) !== f.sha) { kept.push(f.target); continue; }
  say(`删 ${f.target}`);
  if (!DRY) fs.unlinkSync(f.target);
}

// 插件目录里因此空掉的子目录顺手收掉（只收空的）
for (const d of ['commands', 'agents', 'docs', 'providers', '.claude-plugin']) {
  const p = path.join(PLUGIN, d);
  if (fs.existsSync(p) && fs.readdirSync(p).length === 0) { say(`删空目录 ${p}`); if (!DRY) fs.rmdirSync(p); }
}

// ---------- settings.json：放行规则 + configure.js 配过的键，一次读、一次备份、一次写、一次核对 ----------
// 清单的 settingsChanges 是 configure.js 记的：
//   { path, op:'add', value }  加的键：现在的值仍等于记录的才删（只删这个键本身，删空了的父对象不删，留空对象）；值被改过就留着
//   { path, op:'remove', old } 删的键：现在没有这个键才把原值写回去（Q5：卸载时删掉的也恢复）；已经有了（不管值是什么）就不动
// 同一个 path 有多条 remove 时取第一条的 old：那是装之前的原值（后面几条是 CC Switch 切卡又带回来、再被删掉的）
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const BOM = String.fromCharCode(0xFEFF);   // 不直接写字面量，免得源码里混进不可见字符
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasPath = (o, p) => { let x = o; for (const k of p) { if (!isObj(x) || !has(x, k)) return false; x = x[k]; } return true; };
const getPath = (o, p) => { let x = o; for (const k of p) x = x[k]; return x; };
/** 写一个值；沿路径遇到不是对象的（用户把 env 改成了字符串之类）就不动、返回 false，不拿它覆盖掉 */
function setPath(o, p, v) {
  let x = o;
  for (const k of p.slice(0, -1)) { if (!has(x, k)) x[k] = {}; else if (!isObj(x[k])) return false; x = x[k]; }
  x[p[p.length - 1]] = v;
  return true;
}
function delPath(o, p) { let x = o; for (const k of p.slice(0, -1)) { if (!isObj(x) || !has(x, k)) return; x = x[k]; } if (isObj(x)) delete x[p[p.length - 1]]; }
/** 把 probe 里这条路径倒回 orig 的样子：原来有就放回去，原来没有就从「第一个原来没有的那一段」起删掉（那一段及以下都是本次建的） */
function rewind(probe, orig, p) {
  let o = orig, i = 0;
  while (i < p.length && isObj(o) && has(o, p[i])) { o = o[p[i]]; i++; }
  if (i === p.length) setPath(probe, p, clone(o)); else delPath(probe, p.slice(0, i + 1));
}
/** 同一个值？数字和字符串形式的数字算同一个（env 里的值本来都是字符串）——和 configure.js 一致 */
const same = (a, b) => (typeof a !== 'object' && typeof b !== 'object' && a != null && b != null ? String(a) === String(b) : isDeepStrictEqual(a, b));
/** 打印值：只放行看起来像模型名 / 档位的短字符串和数字；env 里除这两个键以外的值一律不显示 */
const SHOWN_ENV = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_POWERSHELL_TOOL'];
const disp = (p, v) => {
  if (p[0] === 'env' && !SHOWN_ENV.includes(p[1])) return '（不显示）';
  if (typeof v === 'string') return /^[\w.\-[\]:\/ ]{0,60}$/.test(v) && !/sk-|key|token|secret|bearer/i.test(v) ? JSON.stringify(v) : '（不是常规值，不显示）';
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return '（不是常规值，不显示）';
};
/** 按原文的习惯写回：有换行就缩进（沿用原缩进，否则 2 空格），没有就紧凑；沿用 CRLF、末尾换行、BOM（和 configure.js 的 fmt 一致） */
function fmt(oldText, obj) {
  const bom = oldText.charCodeAt(0) === BOM.charCodeAt(0) ? BOM : '';
  const body = bom ? oldText.slice(1) : oldText;
  let indent;
  if (body.includes('\n')) {
    const mt = body.match(/^([ \t]+)\S/m);
    indent = mt ? (mt[1].startsWith('\t') ? '\t' : mt[1].length) : 2;
  }
  let s = JSON.stringify(obj, null, indent);
  if (/\r?\n$/.test(body)) s += '\n';
  if (body.includes('\r\n')) s = s.replace(/\n/g, '\r\n');
  return bom + s;
}
const validRec = (e) => isObj(e) && (e.op === 'add' ? has(e, 'value') : e.op === 'remove' && has(e, 'old'))
  && Array.isArray(e.path) && e.path.length > 0 && e.path.every((k) => typeof k === 'string' && k && !BAD_KEYS.has(k));

/** 撤回 configure 记的改动：在 j 上原地改，返回 { lines: 要打印的说明, touched: 动过的路径 } */
function undoChanges(j, recs) {
  const groups = new Map(), lines = [], touched = [];
  for (const e of recs) { const key = JSON.stringify(e.path); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e); }
  for (const list of groups.values()) {
    const p = list[0].path, name = p.join('.'), first = list[0], last = list[list.length - 1];
    const card = (list.find((e) => isObj(e.card) && typeof e.card.id === 'string') || {}).card;
    const why = card && CARD_KEYS.has(name) ? cardBlock(name, card) : null;
    if (why) { lines.push(`settings.json 里 ${why}，没动${KEEP_CARD ? '（--keep-card-settings）' : ''}`); continue; }
    // --keep-card-settings：这两项一律不撤，不管现在撤不撤得了（复审 N2：参数名说的就是「留着」）
    if (KEEP_CARD && CARD_KEYS.has(name)) { lines.push(`settings.json 里 ${name} 留着没动（--keep-card-settings）`); continue; }
    const now = hasPath(j, p) ? { v: getPath(j, p) } : null;
    const addVals = list.filter((e) => e.op === 'add').map((e) => e.value);
    // 现在的样子是不是安装器留下的：最后一条是 remove → 应当没有这个键；最后一条是 add → 值应当还等于记录的
    if (last.op === 'remove' ? now : !(now && addVals.some((v) => same(now.v, v)))) {
      lines.push(last.op === 'remove' ? `settings.json 里 ${name} 现在又有了（不管值是什么），不动`
        : now ? `settings.json 里 ${name} 的值被改过，留着` : `settings.json 里 ${name} 已经不在了，不用动`);
      continue;
    }
    if (first.op === 'remove') {
      if (!setPath(j, p, clone(first.old))) { lines.push(`settings.json 里 ${p.slice(0, -1).join('.')} 不是对象，${name} 没法恢复，不动`); continue; }
      touched.push(p);
      lines.push(`settings.json 恢复 ${name}（配置时删掉的，原值 ${disp(p, first.old)}）`);
      if (name === 'env.CLAUDE_CODE_SUBAGENT_MODEL') lines.push('提醒：它会让子代理的 model 设置失效，体检会报；这是把卸载做成「回到装之前的样子」，不想要它就自己删掉这一行');
    } else if (!now) {
      lines.push(`settings.json 里 ${name} 已经不在了，不用动`);   // 只有记录里先 add 后 remove 的混合情况走到这里（configure.js 不会这样记）
    } else {
      delPath(j, p); touched.push(p);
      lines.push(`settings.json 去掉 ${name}（值还是配置时加的 ${disp(p, now.v)}）`);
    }
  }
  return { lines, touched };
}

const recsAll = Array.isArray(m.settingsChanges) ? m.settingsChanges : [];
const recs = recsAll.filter(validRec);
if (recsAll.length > recs.length) say(`清单的 settingsChanges 里有 ${recsAll.length - recs.length} 条看不懂的记录，跳过`);
if ((ours.length || recs.length) && fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  let j;
  try { j = JSON.parse(raw.charCodeAt(0) === BOM.charCodeAt(0) ? raw.slice(1) : raw); } catch { console.error(`✗ ${SETTINGS} 不是合法 JSON，放行规则和配置过的键都没法撤回，没动它。修好后再卸载一次`); process.exit(1); }
  if (!isObj(j)) { console.error(`✗ ${SETTINGS} 不是 JSON 对象，没动它。修好后再卸载一次`); process.exit(1); }
  const j0 = clone(j);
  const allow = Array.isArray(j.permissions?.allow) ? j.permissions.allow : [];
  const drop = ours.filter((r) => allow.includes(r));
  if (drop.length) {
    j.permissions.allow = allow.filter((r) => !drop.includes(r));
    for (const r of drop) say(`settings.json 去掉放行规则：${r}`);
  } else if (ours.length) say('安装器加的放行规则已经不在 settings.json 里，不用改');
  const u = undoChanges(j, recs);
  for (const l of u.lines) say(l);
  if ((drop.length || u.touched.length) && !DRY) {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const base = `${SETTINGS}.bak-model-router-uninstall-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
    let bak = base;
    for (let i = 2; fs.existsSync(bak); i++) bak = `${base}-${i}`;   // 撞名就加序号，不盖掉旧备份
    fs.copyFileSync(SETTINGS, bak);
    fs.writeFileSync(SETTINGS, fmt(raw, j));
    // 核对：写出去的 = 想写的；把本次动过的键倒回去后 = 动手之前（除了这些键，其余一字不差）
    let ok = false;
    try {
      const back = fs.readFileSync(SETTINGS, 'utf8');
      const k = JSON.parse(back.charCodeAt(0) === BOM.charCodeAt(0) ? back.slice(1) : back);
      const probe = clone(k);
      for (const p of u.touched) rewind(probe, j0, p);
      if (drop.length) rewind(probe, j0, ['permissions', 'allow']);
      ok = isDeepStrictEqual(k, j) && isDeepStrictEqual(probe, j0);
    } catch { ok = false; }
    if (!ok) { console.error(`✗ 写完核对不一致，请用 ${bak} 恢复`); process.exit(1); }
    say(`settings.json 核对通过（备份 ${path.basename(bak)}）`);
  }
} else if (recs.length) say('settings.json 不在了，configure 配过的键没法撤回');
if (!ours.length && !recs.length) say('settings.json 里没有安装器加的放行规则，没动');

if (!DRY) fs.unlinkSync(MANIFEST);

if (kept.length) console.log(`\n装完后被改过、没删的文件：\n  ${kept.join('\n  ')}`);
if (m.backups.length) console.log(`\n安装时做的备份（没动，要恢复就自己改回原名）：\n  ${m.backups.join('\n  ')}`);
if (fs.existsSync(path.join(PLUGIN, '.git'))) console.log(`\n${PLUGIN} 是 git 仓库，没删；不要了就自己删整个目录。`);
else if (!DRY && fs.existsSync(PLUGIN)) {
  const left = fs.readdirSync(PLUGIN);
  if (!left.length) {
    // Windows 上有窗口 / 进程把当前目录放在里面时删不掉（EBUSY / EPERM）：其余都已卸载，这只是个空目录，提示一句就行，别抛堆栈
    try { fs.rmdirSync(PLUGIN); } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      console.log(`\n插件目录 ${PLUGIN} 正被占用（可能有窗口开在里面），其余都已卸载；关掉窗口后手动删这个空目录。`);
    }
  } else console.log(`\n插件目录里还剩这些（运行时生成的或你放的），没删：\n  ${left.map((n) => path.join(PLUGIN, n)).join('\n  ')}`);
}
console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '卸载完成，重启 Claude Code 生效。'}`);

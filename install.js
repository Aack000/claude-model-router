#!/usr/bin/env node
'use strict';
/**
 * install —— 一键部署 model-router（/route）
 *
 * 用法：node install.js [--rules=<清单>] [--dry-run]；可重复跑，重复跑就是升级。双击启动器（setup.*）最终也是跑它
 *   --rules=clean,check   要哪几条放行规则：名字或编号，逗号分隔；all = 全要，none = 都不要。
 *                         不给就逐条列出来问；输入已结束（管道、没有终端）时不问，用上次的选择，第一次装用默认
 *   --dry-run             只列出会做什么，不改任何文件
 *
 * 做三件事，都能用 uninstall.js 撤回：
 *   1. 插件文件 → ~/.claude/plugins/model-router/（脚本、文档、commands / agents 原件、安装入口）。
 *      仓库本身就克隆在这个目录时跳过这一步；从上次装好的副本重跑（目录里没有 .git）也不复制，命令和子代理按清单里的记录部署
 *   2. commands/*.md → ~/.claude/commands/，agents/*.md → ~/.claude/agents/。
 *      目标已存在且内容不同的，先备份成 <原名>.bak-<时间>；上次安装放进去、之后没被改过的直接覆盖（升级）。
 *      上一版装过、这一版没有的文件：没被改过的删掉，被改过的留着只提示（都不再进清单）
 *   3. 用户级 ~/.claude/settings.json 的 permissions.allow 按选择加放行规则（清单见 RULES）。
 *      为什么：auto 模式的分类器会误拦这几个脚本，/route 就卡住等人；命中放行规则的命令不送分类器。
 *      每条规则只放一个插件自带脚本，脚本自己守边界（只删过程文件 / 只读），规则才敢放宽到任意参数。
 *      这次没选、上次是本脚本加的规则会去掉；你自己原先加的不动。
 *      settings.json 先备份；只动 permissions.allow，env 不打印，写完核对 env 和其余配置一字不差。
 *      规则只能由用户自己加：Claude 在 auto 模式下给自己放权会被拦，这也是本脚本要用户亲手跑的原因。
 *
 * 不做的：modelSettings、autoCompactWindow、ANTHROPIC_DEFAULT_*_MODEL 因人而异，按 docs/GUIDE.md 手动配。
 * Windows / macOS / Linux 通用，只要有 Node.js。装完要重启 Claude Code，新的 agent 才会加载。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const SRC = __dirname;
const CLAUDE = path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');

// 可选的放行规则。路径写 ~ 而不是绝对路径：commands/route.md 里就是这么调用的，规则按命令原文匹配
const P = '~/.claude/plugins/model-router';
// 不带参数的写法单列一条：拿不准 `脚本 *` 能不能匹配零个参数
const RULES = [
  { id: 'clean', script: 'route-clean', def: true, desc: '删 /route 的过程文件（不放行的话收尾会卡在删文件上等人）',
    rules: [`Bash(node ${P}/route-clean.js *)`] },
  { id: 'check', script: 'route-check', def: true, desc: '核子代理实际跑的模型（只读；/route 每个子代理返回后都跑）',
    rules: [`Bash(node ${P}/route-check.js)`, `Bash(node ${P}/route-check.js *)`] },
  { id: 'audit', script: 'usage-audit', def: false, desc: '查用量（只读）',
    rules: [`Bash(node ${P}/usage-audit.js)`, `Bash(node ${P}/usage-audit.js *)`] },
  { id: 'doctor', script: 'doctor', def: false, desc: '升级后体检，只放不带参数的（--gateway 要读凭据，不放）',
    rules: [`Bash(node ${P}/doctor.js)`] },
];

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
let rulesArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') continue;
  if (a.startsWith('--rules=')) { rulesArg = a.slice(8); continue; }
  if (a === '--rules' && i + 1 < argv.length) { rulesArg = argv[++i]; continue; }
  // PowerShell 调 .ps1 时会把 --rules=a,b 拆成「--rules=a」「b」两个参数（5.1 和 7 都实测过），跟在后面的裸名字接回去
  if (rulesArg !== null && !a.startsWith('-')) { rulesArg += `,${a}`; continue; }
  console.error(`不认识的参数：${a}\n用法：node install.js [--rules=clean,check｜all｜none] [--dry-run]`);
  process.exit(2);
}

if (process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR) !== path.resolve(CLAUDE)) {
  console.error(`✗ 设置了 CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}，Claude Code 会去那里读配置；`
    + '本插件的命令和放行规则写死了 ~/.claude，装了也对不上，暂不支持，什么都没改。');
  process.exit(1);
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x ?? null)).digest('hex');
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
/** 备份名撞了就加 -2、-3：同一秒连跑两次，第二次不能盖掉第一次（第一次备的才是装之前的原样） */
const uniq = (p) => { let q = p, i = 2; while (fs.existsSync(q)) q = `${p}-${i++}`; return q; };
const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);
const mkdirFor = (p) => { if (!DRY) fs.mkdirSync(path.dirname(p), { recursive: true }); };

/** 解析选择：编号、短名（clean）或脚本名（route-clean / route-clean.js），逗号 / 空格分隔；all、none、0。有不认识的返回 null */
function parseSel(s) {
  const toks = String(s).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0] === 'all') return new Set(RULES.map((r) => r.id));
  if (toks.length === 1 && (toks[0] === 'none' || toks[0] === '0')) return new Set();
  const out = new Set();
  for (const t of toks) {
    const r = /^\d+$/.test(t) ? RULES[Number(t) - 1] : RULES.find((x) => [x.id, x.script, `${x.script}.js`].includes(t));
    if (!r) return null;
    out.add(r.id);
  }
  return out;
}

/** 按行读输入：终端和管道都能用；输入结束返回 null */
const lines = [], waiters = [];
let rl = null, ended = false;
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
    rl.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  }
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  if (ended) return Promise.resolve(null);
  return new Promise((r) => waiters.push(r));
}

async function main() {
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  // 旧版清单只记一条 rule / ruleAdded
  const prevAdded = new Set(prev?.rulesAdded || (prev?.ruleAdded && prev?.rule ? [prev.rule] : []));
  const base = Array.isArray(prev?.rules) ? new Set(prev.rules) : new Set(RULES.filter((r) => r.def).map((r) => r.id));
  const ids = (s) => (s.size ? RULES.filter((r) => s.has(r.id)).map((r) => r.script).join('、') : '一条都不要');

  /** 读 settings.json；不合法就退出（此时还什么都没改）。env 不打印 */
  const readSettings = () => {
    const exists = fs.existsSync(SETTINGS);
    const raw = exists ? fs.readFileSync(SETTINGS, 'utf8') : '{}\n';
    let j;
    try { j = JSON.parse(raw); } catch { console.error(`✗ ${SETTINGS} 不是合法 JSON，什么都没改。修好后重跑。`); process.exit(1); }
    const allow = j.permissions?.allow ?? [];
    if (!Array.isArray(allow)) { console.error(`✗ ${SETTINGS} 里 permissions.allow 不是数组，什么都没改。修好后重跑。`); process.exit(1); }
    return { exists, raw, j, allow };
  };
  // 这一次读取只为提前挡掉坏文件、显示哪些规则已经有了；后面写回用的是等输入结束后重新读的那份
  let { exists, raw, j, allow } = readSettings();

  // ---------- 0. 先定放行规则，再动文件：中途取消什么都不改 ----------
  let sel;
  if (rulesArg !== null) {
    sel = parseSel(rulesArg);
    if (!sel) { console.error(`✗ --rules 里有不认识的：${rulesArg}（可选 ${RULES.map((r) => r.id).join('、')}，或 all / none）`); process.exit(2); }
  } else {
    console.log('放行规则：命中的命令不送 auto 模式分类器，直接执行。');
    RULES.forEach((r, i) => {
      const has = r.rules.every((x) => allow.includes(x)) ? '（settings.json 里已有）' : '';
      console.log(`  [${base.has(r.id) ? 'x' : ' '}] ${i + 1} ${r.script.padEnd(11)}  ${r.desc}${has}`);
    });
    for (;;) {
      const a = await ask('回车 = 按勾的来；输入编号 = 只要这几条（如 1 3）；0 = 一条都不要：');
      if (a === null) { sel = base; console.log(`\n（没有可交互的输入，用${prev?.rules ? '上次' : '默认'}的选择：${ids(sel)}）`); break; }
      if (!a.trim()) { sel = base; break; }
      sel = parseSel(a);
      if (sel) break;
      console.log(`看不懂「${a.trim()}」，再输一次。`);
    }
  }
  if (rl) rl.close();
  say(`放行规则：${ids(sel)}`);
  // 等输入可能等了很久（CC Switch 切卡、用户自己改配置都会写 settings.json）：写回之前重新读，别拿开头那份旧内容把别人的改动冲掉。
  // 紧跟在选择之后、动任何文件之前读：万一这时文件坏了，「什么都没改」仍然成立
  ({ exists, raw, j, allow } = readSettings());

  const TS = stamp();
  const manifest = { installedAt: new Date().toISOString(), version: null, files: [], backups: [], rules: [...sel], rulesAdded: [] };
  try { manifest.version = JSON.parse(fs.readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { /* 没有清单也能装 */ }
  manifest.backups = (prev?.backups || []).filter((b) => fs.existsSync(b));   // 历次备份都留着，卸载时一起列出
  const oldBackups = manifest.backups.length;
  const prevSha = new Map((prev?.files || []).map((f) => [f.target, f.sha]));

  /** 复制一个文件；目标已有且不是上次装的原样，就先备份 */
  function place(rel, target, kind) {
    const from = path.join(SRC, rel);
    const h = sha(from);
    if (fs.existsSync(target)) {
      const cur = sha(target);
      if (cur === h) { manifest.files.push({ target, sha: h, kind }); return; }
      if (prevSha.get(target) !== cur) {
        const bak = uniq(`${target}.bak-${TS}`);
        say(`备份 ${target} → ${path.basename(bak)}`);
        if (!DRY) fs.copyFileSync(target, bak);
        manifest.backups.push(bak);
      }
    }
    say(`${fs.existsSync(target) ? '更新' : '新增'} ${target}`);
    mkdirFor(target);
    if (!DRY) {
      fs.copyFileSync(from, target);
      if (process.platform !== 'win32' && /\.(js|sh|command)$/.test(target)) fs.chmodSync(target, 0o755);
    }
    manifest.files.push({ target, sha: h, kind });
  }

  const listMd = (dir, ext = '.md') => (fs.existsSync(path.join(SRC, dir)) ? fs.readdirSync(path.join(SRC, dir)).filter((n) => n.endsWith(ext)).map((n) => `${dir}/${n}`) : []);

  // ---------- 1. 插件文件 ----------
  const norm = (p) => { const r = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };
  const inPlace = norm(SRC) === norm(PLUGIN);
  // 「就在插件目录」有两种：git 克隆就放在那儿，或上次安装复制过去的副本（没有 .git、有清单）。
  // 副本里会躺着旧版残留（比如已改名的 commands/dev.md），不能 readdir 当源文件部署，只信清单；插件文件的记录原样带进新清单
  const copyMode = inPlace && !!prev && !fs.existsSync(path.join(SRC, '.git'));
  const prevPlugin = (prev?.files || []).filter((f) => f.kind === 'plugin');
  /** 副本模式：dir（commands / agents）下的源文件取自清单里的插件文件记录，文件还在才算 */
  const listFromManifest = (dir) => prevPlugin.map((f) => path.relative(PLUGIN, f.target))
    .filter((r) => path.dirname(r) === dir && r.endsWith('.md') && fs.existsSync(path.join(SRC, r))).map((r) => `${dir}/${path.basename(r)}`);
  const listSrc = (dir) => (copyMode ? listFromManifest(dir) : listMd(dir));
  if (copyMode) {
    say('从已安装的副本重跑：插件文件不动，只按记录重新部署命令和子代理');
    manifest.files.push(...prevPlugin);   // sha 用记录里的、不重算：装完后被改过的，卸载时仍然不删
  } else if (inPlace) {
    say(`仓库就在 ${PLUGIN}，跳过复制插件文件`);
  } else {
    const pluginFiles = ['.claude-plugin/plugin.json', 'README.md', 'LICENSE', 'install.js', 'uninstall.js',
      'setup.js', 'setup.cmd', 'setup.ps1', 'setup.sh', 'setup.command',
      'route-check.js', 'route-clean.js', 'doctor.js', 'usage-audit.js', 'provider.js',
      ...listMd('commands'), ...listMd('agents'), ...listMd('docs'), ...listMd('providers', '.json')]
      .filter((f) => fs.existsSync(path.join(SRC, f)));
    for (const f of pluginFiles) place(f, path.join(PLUGIN, f), 'plugin');
  }

  // ---------- 2. 命令与子代理 ----------
  for (const f of listSrc('commands')) place(f, path.join(CLAUDE, 'commands', path.basename(f)), 'command');
  for (const f of listSrc('agents')) place(f, path.join(CLAUDE, 'agents', path.basename(f)), 'agent');

  // ---------- 2b. 上一版装过、这一版没有的文件 ----------
  // 不处理的话它们既不在新清单里、卸载也删不掉，永远残留。没被改过的删掉；被改过的留着，但也不再记进清单
  const pk = (p) => { const r = path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };   // 大小写不敏感的盘上，别把刚放好的文件当成「没有的」
  const nowTargets = new Set(manifest.files.map((f) => pk(f.target)));
  for (const f of prev?.files || []) {
    if (nowTargets.has(pk(f.target))) continue;
    if (inPlace && f.kind === 'plugin') continue;   // 仓库自己的文件，绝不删（副本模式的已经带进新清单了）
    if (!fs.existsSync(f.target)) continue;
    if (sha(f.target) === f.sha) { say(`删 上一版装过、这一版没有的：${f.target}`); if (!DRY) fs.unlinkSync(f.target); }
    else say(`上一版装过、这一版没有，但被改过，没删：${f.target}`);
  }

  // ---------- 3. 放行规则 ----------
  const next = [...allow], added = [], removed = [], userOwn = [];
  for (const e of RULES) {
    for (const r of e.rules) {
      const want = sel.has(e.id), has = allow.includes(r);
      if (want && !has) { next.push(r); added.push(r); manifest.rulesAdded.push(r); }
      else if (want && has) { if (prevAdded.has(r)) manifest.rulesAdded.push(r); }
      else if (!want && has) {
        if (prevAdded.has(r)) { next.splice(next.indexOf(r), 1); removed.push(r); }
        else userOwn.push(r);
      }
    }
  }
  for (const r of added) say(`settings.json 加放行规则：${r}`);
  for (const r of removed) say(`settings.json 去掉放行规则（上次安装加的，这次没选）：${r}`);
  for (const r of userOwn) say(`没选但保留（你原先自己加的，安装器不动）：${r}`);
  if (!added.length && !removed.length) say('settings.json 不用改');
  else if (!DRY) {
    const envBefore = hash(j.env), restBefore = hash({ ...j, permissions: undefined }), permBefore = hash({ ...(j.permissions || {}), allow: undefined });
    j.permissions = { ...(j.permissions || {}), allow: next };
    if (exists) { const bak = uniq(`${SETTINGS}.bak-model-router-${TS}`); fs.copyFileSync(SETTINGS, bak); manifest.backups.push(bak); }
    let s = JSON.stringify(j, null, 2) + '\n';
    if (raw.includes('\r\n')) s = s.replace(/\n/g, '\r\n');
    mkdirFor(SETTINGS);
    fs.writeFileSync(SETTINGS, s);
    const k = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    const ok = hash(k.env) === envBefore && hash({ ...k, permissions: undefined }) === restBefore
      && hash({ ...k.permissions, allow: undefined }) === permBefore && JSON.stringify(k.permissions.allow) === JSON.stringify(next);
    if (!ok) { console.error('✗ 写完核对不一致，请用备份恢复 settings.json 后反馈'); process.exit(1); }
    say('settings.json 核对通过：env 和其余配置未变');
  }

  if (!DRY) { fs.mkdirSync(PLUGIN, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n'); }

  // 旧版文件只提示，不动
  const legacy = [['commands', 'dev.md'], ['commands', 'automode.md'], ['plugins/model-router', 'dev-check.js'], ['plugins/model-router', 'dev-clean.js'], ['plugins/model-router', 'automode-check.js']]
    .map(([d, n]) => path.join(CLAUDE, d, n)).filter((p) => fs.existsSync(p));
  if (legacy.length) console.log(`\n发现旧版（改名前）的文件，没动它们，确认不用了可以自己删：\n  ${legacy.join('\n  ')}`);

  console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '装好了。'}文件 ${manifest.files.length} 个，本次备份 ${manifest.backups.length - oldBackups} 个。`);
  if (!DRY) console.log(`下一步：重启 Claude Code；按 docs/GUIDE.md 配 modelSettings 等；跑 \`node ${P}/doctor.js\` 体检。卸载：再跑一次安装入口选「卸载」，或 \`node ${P}/uninstall.js\``);
}

main();

#!/usr/bin/env node
'use strict';
/**
 * install —— 一键部署 model-router（/route）
 *
 * 用法：node install.js [--components=<清单>] [--rules=<清单>] [--dry-run]；可重复跑，重复跑就是升级。双击启动器（setup.*）最终也是跑它
 *   --components=core,usage  装哪几个组件：名字或编号（1 core、2 usage、3 switch），逗号分隔；all = 全装；core 总会装。
 *                         不给就先问一次；输入已结束时不问，用上次的选择；第一次装 = core，检测到 CC Switch 再加 switch；
 *                         v1.x 装的（有清单、但清单里没有 components 记录）= 全部三个组件，沿用旧版装的全部
 *   --rules=clean,check   要哪几条放行规则：名字或编号，逗号分隔；all = 全要，none = 都不要。
 *                         不给就逐条列出来问；输入已结束（管道、没有终端）时不问，用上次的选择，第一次装用默认
 *                         （audit 属于 usage 组件，没选 usage 时不列、也不能指定）
 *   --dry-run             只列出会做什么，不改任何文件
 *
 * 做三件事，都能用 uninstall.js 撤回：
 * 配置目录 = 环境变量 CLAUDE_CONFIG_DIR（和 Claude Code 一样），没设就是 ~/.claude；下面写的 ~/.claude 都指它。
 * 换了位置（CLAUDE_CONFIG_DIR 不是 ~/.claude）时，命令文件里和放行规则里的脚本路径写成插件目录的绝对路径（正斜杠；
 * 含空格等字符时整条脚本路径加双引号），两边同形，规则才匹配得上；默认位置仍写 ~/.claude/plugins/model-router，已装用户的规则和命令文件不变。
 *   1. 插件文件 → ~/.claude/plugins/model-router/（脚本、文档、commands / agents 原件、安装入口）。
 *      从别处（克隆的仓库、解压出来的目录）跑：复制过去。从插件目录自己跑，分两种，开头会打印走了哪种：
 *      · 副本模式：目录里没有 .git，且上次安装清单里的插件文件记录至少 1 条、这些文件全都还在、内容和记录的一模一样
 *        （= 上次装好后原封未动的那份）。插件文件不动，命令和子代理按记录部署（目录里的旧版残留如 commands/dev.md 不会被当成源文件），记录原样带进新清单
 *      · 原地模式：其余情况——克隆的仓库就在这里，或把发布包解压进了这个目录（第一次装、清单里没有插件文件记录、
 *        解压覆盖过新版、手改过插件文件，都归这里）。不复制插件文件、不记进清单，命令和子代理按目录里现有的文件部署，
 *        只排除已知的旧版文件名（见 LEGACY）。所以卸载时这些插件文件不会被删，要删自己删整个目录
 *   2. commands/*.md → ~/.claude/commands/，agents/*.md → ~/.claude/agents/（换了位置时正文里的脚本路径按上面的写法换过，清单记的 sha 是换过之后的）。
 *      目标已存在且内容不同的，先备份成 <原名>.bak-<时间>；上次安装放进去、之后没被改过的直接覆盖（升级）。
 *      上一版装过、这一版没有的文件：没被改过的删掉，被改过的留着只提示（都不再进清单）；
 *      本次部署的目标、源目录 commands/ agents/ 里还有同名文件的目标，一律不删
 *   3. 用户级 ~/.claude/settings.json 的 permissions.allow 按选择加放行规则（清单见 RULES）。
 *      为什么：auto 模式的分类器会误拦这几个脚本，/route 就卡住等人；命中放行规则的命令不送分类器。
 *      每条规则只放一个插件自带脚本，脚本自己守边界（只删过程文件 / 只读），规则才敢放宽到任意参数。
 *      这次没选、上次是本脚本加的规则会去掉；你自己原先加的不动。
 *      settings.json 先备份；只动 permissions.allow，env 不打印，写完核对 env 和其余配置一字不差。
 *      规则只能由用户自己加：Claude 在 auto 模式下给自己放权会被拦，这也是本脚本要用户亲手跑的原因。
 *
 * 不做的：modelSettings、autoCompactWindow、ANTHROPIC_DEFAULT_*_MODEL 因人而异，本脚本不碰。装完接着跑 configure.js 配
 * （安装入口菜单 1 会串着跑：安装 → 配置 → 体检；菜单 5 只配置 + 体检；手动配见 docs/GUIDE.md）。
 * 串着跑时安装入口会设环境变量 MR_SETUP_FLOW（后面还要跑哪几步，逗号分隔），本脚本据此决定结尾的「下一步」怎么写。
 * 可选的另一步：ccswitch-caps.js（安装入口菜单 4）给 CC Switch 里第三方模型的卡片补能力声明；它补过什么记在清单的 ccswitchCaps 里，
 * configure.js 配过什么记在 settingsChanges 里；重装都原样带着，卸载时按它们撤回。
 * Windows / macOS / Linux 通用，只要有 Node.js。装完要重启 Claude Code，新的 agent 才会加载。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SRC = __dirname;
// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');

// 脚本路径的「写法」：commands/route.md 里怎么调用脚本，放行规则就得一字不差地写成什么样（规则按命令原文匹配）。
//  · 配置目录是默认的 ~/.claude：写 ~/.claude/plugins/model-router（已装用户的放行规则和命令文件都不变）
//  · 否则：插件目录的绝对路径、正斜杠；含空格等 shell 会拆开的字符时，整条脚本路径加双引号（~ 在引号里不展开，所以不用 ~ 形式）
const lowerKey = (p) => { const r = path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };
const IS_DEFAULT = lowerKey(CLAUDE) === lowerKey(path.join(os.homedir(), '.claude'));
const P = IS_DEFAULT ? '~/.claude/plugins/model-router' : PLUGIN.split(path.sep).join('/');
if (!IS_DEFAULT && /["`$\\]/.test(P)) {
  console.error(`✗ 配置目录 ${CLAUDE} 的路径里有引号、反引号、$ 或反斜杠，命令里没法安全引用它，装了放行规则也对不上。换一个不含这些字符的目录，什么都没改。`);
  process.exit(1);
}
const q = (s) => (/^[A-Za-z0-9_.\/:@%+=,~-]+$/.test(s) ? s : `"${s}"`);
/** 脚本（插件目录下的文件）在命令里的写法 */
const ref = (file) => q(`${P}/${file}`);

// 组件：core 平铺在插件目录里，usage / switch 在插件目录的同名子目录里（仓库里在 plugins/<名>/ 下）
const COMPONENTS = [
  { id: 'core', desc: '核心工作流（必装）' },
  // files：组件文件写死的清单（相对组件目录）。不递归列目录：源目录里被 .gitignore 排除的本地文件（calibration.jsonl、usage-baseline.json）、
  // 用户自建的 providers/*.json、编辑器备份都不是安装器管的，不能复制进插件目录、也不能记进清单（复审 R6）
  { id: 'usage', desc: '用量统计（usage-audit、usage-balance）', files: ['usage-audit.js', 'usage-balance.js'] },
  { id: 'switch', desc: '供应商与 CC Switch 工具（provider、ccswitch-caps）', files: ['provider.js', 'ccswitch-caps.js', 'providers/deepseek.json'] },
];
/** CC Switch 装没装：只看它的目录 / 程序在不在（existsSync），不 readdir、不读任何文件 */
const ccSwitchInstalled = () => [path.join(os.homedir(), '.cc-switch'),
  ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cc-switch', 'cc-switch.exe')]
    : process.platform === 'darwin' ? ['/Applications/CC Switch.app'] : [])]
  .some((p) => { try { return fs.existsSync(p); } catch { return false; } });

// 可选的放行规则（写法见上）。不带参数的写法单列一条：拿不准 `脚本 *` 能不能匹配零个参数。comp：规则要的组件（空 = core）
const RULES = [
  { id: 'clean', script: 'route-clean', def: true, desc: '删 /route 的过程文件（不放行的话收尾会卡在删文件上等人）',
    rules: [`Bash(node ${ref('route-clean.js')} *)`] },
  { id: 'check', script: 'route-check', def: true, desc: '核子代理实际跑的模型（只读；/route 每个子代理返回后都跑）',
    rules: [`Bash(node ${ref('route-check.js')})`, `Bash(node ${ref('route-check.js')} *)`] },
  { id: 'audit', script: 'usage-audit', def: false, comp: 'usage', desc: '查用量（只读）',
    rules: [`Bash(node ${ref('usage-audit.js')})`, `Bash(node ${ref('usage-audit.js')} *)`] },
  { id: 'doctor', script: 'doctor', def: false, desc: '升级后体检，只放不带参数的（--gateway 要读凭据，不放）',
    rules: [`Bash(node ${ref('doctor.js')})`] },
];

/**
 * 部署出去的命令 / 子代理正文：源文件里的 ${CLAUDE_PLUGIN_ROOT}（原生插件装时由 CLI 替换）换成插件目录的实际写法；
 * 旧写法 ~/.claude/plugins/model-router/<脚本> 也换成实际写法，和放行规则同形。
 * 默认位置时实际写法就是 ~/.claude/plugins/model-router，旧写法替换后一字不变（没有 ${CLAUDE_PLUGIN_ROOT} 的正文返回同一个 Buffer）。
 * 只换这个插件目录的写法，正文里别的 ~/.claude/… 是说明文字，不动
 */
function retarget(buf) {
  const txt = buf.toString('utf8');
  const out = txt
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g, (_, f) => ref(f))   // 源文件里的 ${CLAUDE_PLUGIN_ROOT}/<脚本名>：整条脚本路径一起加引号
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => q(P))   // 只写了目录的
    .replace(/~\/\.claude\/plugins\/model-router\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g, (_, f) => ref(f))   // 带脚本名的：整条脚本路径一起加引号
    .replace(/~\/\.claude\/plugins\/model-router/g, () => q(P));   // 只写了目录的
  return out === txt ? buf : Buffer.from(out, 'utf8');
}

// 改名前的旧版文件 [目录（相对 ~/.claude）, 文件名]：装完只提示，不动；
// 在插件目录里就地部署（原地模式）时，也靠它把 commands / agents 里的旧版残留从源文件里排除
const LEGACY = [['commands', 'dev.md'], ['commands', 'automode.md'], ['plugins/model-router', 'dev-check.js'], ['plugins/model-router', 'dev-clean.js'], ['plugins/model-router', 'automode-check.js']];

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
let rulesArg = null, compsArg = null, lastOpt = null;   // lastOpt：最近一个带值的参数，PowerShell 拆开的裸名字接回它
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') continue;
  if (a.startsWith('--rules=')) { rulesArg = a.slice(8); lastOpt = 'rules'; continue; }
  if (a === '--rules' && i + 1 < argv.length) { rulesArg = argv[++i]; lastOpt = 'rules'; continue; }
  if (a.startsWith('--components=')) { compsArg = a.slice(13); lastOpt = 'comps'; continue; }
  if (a === '--components' && i + 1 < argv.length) { compsArg = argv[++i]; lastOpt = 'comps'; continue; }
  // PowerShell 调 .ps1 时会把 --rules=a,b 拆成「--rules=a」「b」两个参数（5.1 和 7 都实测过），跟在后面的裸名字接回去（--components 同理）
  if (lastOpt === 'rules' && !a.startsWith('-')) { rulesArg += `,${a}`; continue; }
  if (lastOpt === 'comps' && !a.startsWith('-')) { compsArg += `,${a}`; continue; }
  console.error(`不认识的参数：${a}\n用法：node install.js [--components=core,usage,switch｜all｜core] [--rules=clean,check｜all｜none] [--dry-run]`);
  process.exit(2);
}

const shaBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha = (p) => shaBuf(fs.readFileSync(p));
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x ?? null)).digest('hex');
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
/** 备份名撞了就加 -2、-3：同一秒连跑两次，第二次不能盖掉第一次（第一次备的才是装之前的原样） */
const uniq = (p) => { let q = p, i = 2; while (fs.existsSync(q)) q = `${p}-${i++}`; return q; };
const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);
const mkdirFor = (p) => { if (!DRY) fs.mkdirSync(path.dirname(p), { recursive: true }); };

/** 解析组件选择：编号（1 core、2 usage、3 switch）或名字，逗号 / 空格分隔；all = 全装；0 = 只装 core；core 总是在。有不认识的返回 null */
function parseComps(s) {
  const toks = String(s).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0] === 'all') return new Set(COMPONENTS.map((c) => c.id));
  const out = new Set(['core']);
  for (const t of toks) {
    if (t === '0') continue;
    const c = /^\d+$/.test(t) ? COMPONENTS[Number(t) - 1] : COMPONENTS.find((x) => x.id === t);
    if (!c) return null;
    out.add(c.id);
  }
  return out;
}
/** 选了这些组件时能选的放行规则（规则要的组件没选就不列） */
const rulesFor = (comps) => RULES.filter((r) => !r.comp || comps.has(r.comp));

/** 解析选择：编号（只数 rulesFor(comps) 列出来的）、短名（clean）或脚本名（route-clean / route-clean.js），逗号 / 空格分隔；all、none、0。有不认识的（含要的组件没选的）返回 null */
function parseSel(s, comps) {
  const avail = rulesFor(comps);
  const toks = String(s).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0] === 'all') return new Set(avail.map((r) => r.id));
  if (toks.length === 1 && (toks[0] === 'none' || toks[0] === '0')) return new Set();
  const out = new Set();
  for (const t of toks) {
    const r = /^\d+$/.test(t) ? avail[Number(t) - 1] : avail.find((x) => [x.id, x.script, `${x.script}.js`].includes(t));
    if (!r) return null;
    out.add(r.id);
  }
  return out;
}

/**
 * 按行读输入：终端和管道都能用；输入结束返回 null。
 * 同步逐字节读（和 setup.js、configure.js 同一种读法）：不在 stdin 上留挂起的读，也不多吞管道里后面的行。
 * 安装入口把「菜单 → 放行规则 → 配模型设置」串在一起，几步共用同一个 stdin；
 * 用 readline 的话，管道里一次喂进来的几行会被这一步整块吞掉，下一步就读不到自己那一行。
 */
function ask(q) {
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

// 清单里记的是绝对路径。配置目录换过位置（复制一份做第二套配置、改名、搬家）后，旧路径指向的是别的目录：
// 照着删会删到原来那个目录里的文件（复审 R1），照着比对会把挪过来的原样当成「改过了」（R3）。
// 所以按记下的旧配置目录（旧清单没记 configDir 就从路径反推）把路径换到当前配置目录下；换不了的留原样，删之前还有 inCurrent 把关
function rebaseFiles(m) {
  if (!m || !Array.isArray(m.files)) return;
  const fromPath = (f) => {
    const t = String(f.target || '');
    if (f.kind === 'plugin') { const i = t.search(/[\\/]plugins[\\/]model-router[\\/]/); return i > 0 ? t.slice(0, i) : null; }
    return f.kind === 'command' || f.kind === 'agent' ? path.dirname(path.dirname(t)) : null;
  };
  const old = typeof m.configDir === 'string' && m.configDir ? m.configDir : m.files.map(fromPath).find(Boolean);
  if (!old) return;
  for (const f of m.files) {
    const r = path.relative(path.resolve(old), path.resolve(String(f.target)));
    if (r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) f.target = path.join(CLAUDE, r);
  }
}
/** p 在不在当前配置目录里面：不在的一律不删 */
const inCurrent = (p) => { const r = path.relative(CLAUDE, path.resolve(String(p))); return !!r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };

function main() {
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  rebaseFiles(prev);
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

  // ---------- 0. 先定组件和放行规则，再动文件：中途取消什么都不改 ----------
  const ccsw = ccSwitchInstalled();
  // v1.x 升级：清单在、但没有 components 记录（v1 没有组件的概念，装的是全部）→ 默认全装，不然 usage-audit 等老命令会没了、audit 规则会被去掉（复审 R4）。
  // 没有清单（新用户）仍是 core，检测到 CC Switch 再加 switch
  const fromV1 = !!prev && !Array.isArray(prev.components);
  const defComps = Array.isArray(prev?.components) ? new Set(['core', ...prev.components.filter((c) => COMPONENTS.some((x) => x.id === c))])
    : fromV1 ? new Set(COMPONENTS.map((c) => c.id))
    : new Set(['core', ...(ccsw ? ['switch'] : [])]);
  let comps;
  if (compsArg !== null) {
    comps = parseComps(compsArg);
    if (!comps) { console.error(`✗ --components 里有不认识的：${compsArg}（可选 ${COMPONENTS.map((c) => c.id).join('、')}，或 all / core）`); process.exit(2); }
  } else {
    console.log('组件：');
    COMPONENTS.forEach((c, i) => {
      console.log(`  [${defComps.has(c.id) ? 'x' : ' '}] ${i + 1} ${c.id.padEnd(6)}  ${c.desc}${c.id === 'switch' && ccsw ? '（检测到 CC Switch）' : ''}`);
    });
    if (fromV1) console.log('（旧版装的是全部组件，所以默认全勾；不想要哪个就输入编号只选要的）');
    for (;;) {
      const a = ask('回车 = 按勾的来；输入编号 = 只要这几个（如 2 3，core 总会装）；0 = 只装 core：');
      if (a === null) { comps = defComps; console.log(`\n（没有可交互的输入，${fromV1 ? '旧版装的是全部组件，沿用' : `用${Array.isArray(prev?.components) ? '上次' : '默认'}的选择`}：${[...defComps].join('、')}）`); break; }
      if (!a.trim()) { comps = defComps; break; }
      comps = parseComps(a);
      if (comps) break;
      console.log(`看不懂「${a.trim()}」，再输一次。`);
    }
  }
  const compList = COMPONENTS.map((c) => c.id).filter((c) => comps.has(c));   // 按固定顺序排，清单和输出都稳定
  say(`组件：${compList.join('、')}${ccsw ? '（检测到 CC Switch）' : ''}`);

  const avail = rulesFor(comps);
  const baseSel = new Set([...base].filter((id) => avail.some((r) => r.id === id)));   // 要的组件没选的规则，默认也不要
  let sel;
  if (rulesArg !== null) {
    const toks = rulesArg.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const lack = RULES.find((r) => r.comp && !comps.has(r.comp) && toks.some((t) => [r.id, r.script, `${r.script}.js`].includes(t)));
    if (lack) { console.error(`✗ ${lack.id} 需要 ${lack.comp} 组件：--components 里加上 ${lack.comp}（现在选的是 ${compList.join('、')}）`); process.exit(2); }
    sel = parseSel(rulesArg, comps);
    if (!sel) { console.error(`✗ --rules 里有不认识的：${rulesArg}（可选 ${avail.map((r) => r.id).join('、')}，或 all / none）`); process.exit(2); }
  } else {
    console.log('放行规则：命中的命令不送 auto 模式分类器，直接执行。');
    avail.forEach((r, i) => {
      const has = r.rules.every((x) => allow.includes(x)) ? '（settings.json 里已有）' : '';
      console.log(`  [${baseSel.has(r.id) ? 'x' : ' '}] ${i + 1} ${r.script.padEnd(11)}  ${r.desc}${has}`);
    });
    for (;;) {
      const a = ask('回车 = 按勾的来；输入编号 = 只要这几条（如 1 3）；0 = 一条都不要：');
      if (a === null) { sel = baseSel; console.log(`\n（没有可交互的输入，用${prev?.rules ? '上次' : '默认'}的选择：${ids(sel)}）`); break; }
      if (!a.trim()) { sel = baseSel; break; }
      sel = parseSel(a, comps);
      if (sel) break;
      console.log(`看不懂「${a.trim()}」，再输一次。`);
    }
  }
  say(`放行规则：${ids(sel)}`);
  // 等输入可能等了很久（CC Switch 切卡、用户自己改配置都会写 settings.json）：写回之前重新读，别拿开头那份旧内容把别人的改动冲掉。
  // 紧跟在选择之后、动任何文件之前读：万一这时文件坏了，「什么都没改」仍然成立
  ({ exists, raw, j, allow } = readSettings());

  const TS = stamp();
  // pathToken：脚本路径的写法（放行规则和部署出去的命令文件都按它写）；换了位置重装时，上次按旧写法加的规则会去掉
  // configDir：装在哪个配置目录。以后配置目录挪了位置，靠它把清单里的绝对路径换过去（rebaseFiles）
  const manifest = { installedAt: new Date().toISOString(), version: null, configDir: CLAUDE, files: [], backups: [], rules: [...sel], components: compList, rulesAdded: [], pathToken: P };
  if (!IS_DEFAULT) say(`配置目录：${CLAUDE}（来自 CLAUDE_CONFIG_DIR）；命令文件和放行规则里的脚本路径写成 ${P}/<脚本名>（含空格等字符时整条路径加双引号）`);
  try { manifest.version = JSON.parse(fs.readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { /* 没有清单也能装 */ }
  manifest.backups = (prev?.backups || []).filter((b) => fs.existsSync(b));   // 历次备份都留着，卸载时一起列出
  if (Array.isArray(prev?.ccswitchCaps)) manifest.ccswitchCaps = prev.ccswitchCaps;   // ccswitch-caps.js 补过的记录，重装不能丢
  if (Array.isArray(prev?.settingsChanges)) manifest.settingsChanges = prev.settingsChanges;   // configure.js 配过的记录，重装不能丢（丢了卸载就撤不回）
  const oldBackups = manifest.backups.length;
  const prevSha = new Map((prev?.files || []).map((f) => [f.target, f.sha]));
  // 整个配置目录挪过位置（改名、搬家）后，清单里记的绝对路径是旧的，按路径对不上；再按「类别 + 文件名（插件文件按插件目录内的相对路径）」认一次上次装的原样，
  // 免得把安装器自己装的文件当成使用方的、给它们一个个做备份
  const idKey = (kind, target) => {
    if (kind !== 'plugin') return `${kind}:${path.basename(target)}`;
    const r = String(target).split(/plugins[\\/]model-router[\\/]/)[1];
    return r ? `plugin:${r.replace(/\\/g, '/')}` : null;
  };
  const prevShaById = new Map((prev?.files || []).map((f) => [idKey(f.kind, f.target), f.sha]).filter(([k]) => k));

  /** 复制一个文件；目标已有且不是上次装的原样，就先备份。命令 / 子代理的正文按脚本路径的写法换过（默认位置不换），清单里记的 sha 是换过之后的 */
  function place(rel, target, kind) {
    const from = path.join(SRC, rel);
    const orig = fs.readFileSync(from);
    const data = kind === 'command' || kind === 'agent' ? retarget(orig) : orig;
    const h = shaBuf(data);
    if (fs.existsSync(target)) {
      const cur = sha(target);
      if (cur === h) { manifest.files.push({ target, sha: h, kind }); return; }
      if ((prevSha.get(target) ?? prevShaById.get(idKey(kind, target))) !== cur) {
        const bak = uniq(`${target}.bak-${TS}`);
        say(`备份 ${target} → ${path.basename(bak)}`);
        if (!DRY) fs.copyFileSync(target, bak);
        manifest.backups.push(bak);
      }
    }
    say(`${fs.existsSync(target) ? '更新' : '新增'} ${target}`);
    mkdirFor(target);
    if (!DRY) {
      if (data === orig) fs.copyFileSync(from, target); else fs.writeFileSync(target, data);
      if (process.platform !== 'win32' && /\.(js|sh|command)$/.test(target)) fs.chmodSync(target, 0o755);
    }
    manifest.files.push({ target, sha: h, kind });
  }

  const listMd = (dir, ext = '.md') => (fs.existsSync(path.join(SRC, dir)) ? fs.readdirSync(path.join(SRC, dir)).filter((n) => n.endsWith(ext)).map((n) => `${dir}/${n}`) : []);

  // ---------- 1. 插件文件 ----------
  const norm = (p) => { const r = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };
  const inPlace = norm(SRC) === norm(PLUGIN);
  // 从插件目录自己跑（inPlace）有两种处理：
  //  · 副本模式：上次安装复制过去的那份「原封未动」——没有 .git、清单里 plugin 记录至少 1 条、这些文件全都还在且 sha 和记录一致。
  //    里面会躺着旧版残留（比如已改名的 commands/dev.md），所以不 readdir，只信清单；plugin 记录原样带进新清单
  //  · 原地模式：其余一律按「仓库就在这里」处理（克隆的仓库；解压发布包直接装；解压新版覆盖过旧装；手改过插件文件）。
  //    这时清单信不得——没有记录会把命令和子代理当「这一版没有的」全删，记录旧了会漏部署新增的文件——
  //    所以 readdir 列源文件，只排除已知旧版文件名；插件文件不复制、也不记 plugin 记录
  const hasGit = fs.existsSync(path.join(SRC, '.git'));
  const prevPlugin = (prev?.files || []).filter((f) => f.kind === 'plugin');
  const untouched = (f) => { try { return fs.statSync(f.target).isFile() && sha(f.target) === f.sha; } catch { return false; } };
  const rel = (p) => path.relative(PLUGIN, p).split(path.sep).join('/');
  let copyMode = false, notCopy = '';
  if (inPlace && !hasGit) {
    if (!prev) notCopy = '没有上次的安装清单，这是第一次装';
    else if (!prevPlugin.length) notCopy = '上次的安装清单里没有插件文件的记录';
    else {
      const changed = prevPlugin.filter((f) => !untouched(f));
      if (changed.length) notCopy = `${changed.length} 个插件文件和上次装好时不一样或已不在（${changed.slice(0, 3).map((f) => rel(f.target)).join('、')}${changed.length > 3 ? ' 等' : ''}）`;
      else copyMode = true;
    }
  }
  const legacyRel = new Set(LEGACY.map(([d, n]) => `${d}/${n}`));
  /** 副本模式：dir（commands / agents）下的源文件取自清单里的插件文件记录，文件还在才算 */
  const listFromManifest = (dir) => prevPlugin.map((f) => rel(f.target))
    .filter((r) => path.posix.dirname(r) === dir && r.endsWith('.md') && fs.existsSync(path.join(SRC, r))).map((r) => `${dir}/${path.posix.basename(r)}`);
  /** 原地模式：readdir，但旧版文件名不当源文件（它们只是改名前留下的残留） */
  const listInPlace = (dir) => listMd(dir).filter((r) => {
    if (!legacyRel.has(r)) return true;
    say(`不部署 ${PLUGIN}/${r}：改名前的旧版文件，只是残留`);
    return false;
  });
  const listSrc = (dir) => (copyMode ? listFromManifest(dir) : inPlace ? listInPlace(dir) : listMd(dir));

  // 选了的组件，它的文件得在源目录里：从仓库 / 解压的发布包跑是 plugins/<名>/，装好的副本、原地模式也可能是 <名>/。
  // 都找不到就在动任何文件之前停：不然副本模式一个文件不装、清单和放行规则却照新选择写，最后还打「装好了」，转发脚本再提示「重跑安装入口」，死循环（复审 R5）
  const compSrcDir = (c) => {
    const files = COMPONENTS.find((x) => x.id === c).files;
    return (inPlace ? [`plugins/${c}`, c] : [`plugins/${c}`]).find((d) => files.every((f) => fs.existsSync(path.join(SRC, d, f))));
  };
  const noSrc = compList.filter((c) => c !== 'core' && !compSrcDir(c));
  if (noSrc.length) {
    console.error(`✗ 选了 ${noSrc.join('、')} 组件，但这个目录里找不到它的文件：${SRC}（要有 ${noSrc.map((c) => `plugins/${c}/ 或 ${c}/`).join('、')}，里面是 ${noSrc.map((c) => COMPONENTS.find((x) => x.id === c).files.join('、')).join('；')}）。`
      + '\n  从下载的仓库或解压出来的目录跑安装入口（setup.* 或 node install.js）再选这些组件；什么都没改。');
    process.exit(2);
  }
  if (copyMode) {
    say('副本模式：插件目录里的文件和上次装好时一模一样，插件文件不动，命令和子代理按清单里的记录重新部署');
    manifest.files.push(...prevPlugin);   // sha 用记录里的、不重算（此时必然和现文件一致）
    // 上次装了、这次没勾的组件：副本模式只信清单、不删文件，文件还在也还记在清单里，说一声免得以为已经去掉了（复审 N4）
    const kept = COMPONENTS.map((x) => x.id).filter((c) => c !== 'core' && !compList.includes(c) && prevPlugin.some((f) => rel(f.target).startsWith(`${c}/`)));
    if (kept.length) say(`${kept.join('、')} 这次没选，文件还在：副本模式不删组件文件；要去掉，从仓库目录跑安装入口，或者用 uninstall`);
  } else if (inPlace && hasGit) {
    say(`仓库就在 ${PLUGIN}，跳过复制插件文件；命令和子代理按目录里现有的文件部署（旧版文件名除外），插件文件不记进清单`);
  } else if (inPlace) {
    say(`仓库就在 ${PLUGIN}（没有 .git，也不是上次装好后原样没动的那份：${notCopy}），跳过复制插件文件；`
      + '命令和子代理按目录里现有的文件部署（旧版文件名除外），插件文件不记进清单，卸载时不会删它们');
  } else {
    const pluginFiles = ['.claude-plugin/plugin.json', 'README.md', 'LICENSE', 'install.js', 'uninstall.js',
      'setup.js', 'setup.cmd', 'setup.ps1', 'setup.sh', 'setup.command',
      'route-check.js', 'route-clean.js', 'doctor.js', 'usage-audit.js', 'configure.js',
      ...listMd('commands'), ...listMd('agents'), ...listMd('docs')]
      .filter((f) => fs.existsSync(path.join(SRC, f)));
    for (const f of pluginFiles) place(f, path.join(PLUGIN, f), 'plugin');
    // 组件：仓库里在 plugins/<名>/ 下，装好后去掉 plugins/ 前缀（<插件目录>/usage/…、<插件目录>/switch/…）；只装写死清单里的文件（见 COMPONENTS）
    const counts = { core: pluginFiles.length };
    for (const c of compList.filter((x) => x !== 'core')) {
      const cfiles = COMPONENTS.find((x) => x.id === c).files;
      counts[c] = cfiles.length;
      for (const f of cfiles) place(`plugins/${c}/${f}`, path.join(PLUGIN, c, ...f.split('/')), 'plugin');
    }
    say(`组件：${compList.map((c) => `${c} ${counts[c]} 个文件`).join('、')}`);
  }

  // ---------- 2. 命令与子代理 ----------
  for (const f of listSrc('commands')) place(f, path.join(CLAUDE, 'commands', path.basename(f)), 'command');
  for (const f of listSrc('agents')) place(f, path.join(CLAUDE, 'agents', path.basename(f)), 'agent');

  // ---------- 2b. 上一版装过、这一版没有的文件 ----------
  // 不处理的话它们既不在新清单里、卸载也删不掉，永远残留。没被改过的删掉；被改过的留着，但也不再记进清单
  const pk = (p) => { const r = path.resolve(p); return process.platform === 'linux' ? r : r.toLowerCase(); };   // 大小写不敏感的盘上，别把刚放好的文件当成「没有的」
  const nowTargets = new Set(manifest.files.map((f) => pk(f.target)));
  const srcDirOf = { command: 'commands', agent: 'agents' };
  for (const f of prev?.files || []) {
    if (nowTargets.has(pk(f.target))) continue;   // 本次刚部署的（含大小写不同的同一个文件），不删
    if (inPlace && f.kind === 'plugin') continue;   // 仓库自己的文件，绝不删（副本模式的已经带进新清单了）
    if (!fs.existsSync(f.target)) continue;
    if (!inCurrent(f.target)) { say(`上一版记录的 ${f.target} 不在当前配置目录 ${CLAUDE} 里，没动`); continue; }
    // 源目录 commands/ agents/ 里还有同名文件：这一版没部署它多半是被排除了（比如旧版文件名），但源文件还在，
    // 目标是留着还是删交给使用方，安装器不替人定
    const sd = srcDirOf[f.kind];
    if (sd && fs.existsSync(path.join(SRC, sd, path.basename(f.target)))) { say(`上一版装过的 ${f.target}：源目录 ${sd}/ 里还有同名文件，没删`); continue; }
    if (sha(f.target) === f.sha) { say(`删 上一版装过、这一版没有的：${f.target}`); if (!DRY) fs.unlinkSync(f.target); }
    else say(`上一版装过、这一版没有，但被改过，没删：${f.target}`);
  }
  // v2 的 provider.js / ccswitch-caps.js 只读 <插件目录>/switch/providers/；v1.x 的 <插件目录>/providers/ 里清单外的 json 是用户自建的，
  // 安装器不动（不挪、不删），只列出来请他自己挪（复审 R13）
  const oldProv = path.join(PLUGIN, 'providers');
  if (fs.existsSync(oldProv) && fs.statSync(oldProv).isDirectory()) {
    const prevSet = new Set((prev?.files || []).map((f) => pk(f.target)));
    const own = fs.readdirSync(oldProv).filter((n) => /\.json$/i.test(n) && !prevSet.has(pk(path.join(oldProv, n))) && !nowTargets.has(pk(path.join(oldProv, n))));
    if (own.length) say(`旧的 ${oldProv} 里有不是安装器装的 json：${own.join('、')}。v2 只读 switch/providers/，要用就把它们移到 ${path.join(PLUGIN, 'switch', 'providers')}（安装器没动这些文件）`);
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
  // 上次加的、但这次的写法里已经没有的规则（换了位置，路径写法变了）：留着就是指向旧位置的死规则，按 rulesAdded 去掉
  const current = new Set(RULES.flatMap((e) => e.rules)), stale = [];
  for (const r of prevAdded) {
    if (current.has(r) || !next.includes(r)) continue;
    next.splice(next.indexOf(r), 1); stale.push(r);
  }
  for (const r of added) say(`settings.json 加放行规则：${r}`);
  for (const r of removed) say(`settings.json 去掉放行规则（上次安装加的，这次没选）：${r}`);
  for (const r of stale) say(`settings.json 去掉放行规则（上次安装加的，脚本路径的写法和这次不同）：${r}`);
  for (const r of userOwn) say(`没选但保留（你原先自己加的，安装器不动）：${r}`);
  if (!added.length && !removed.length && !stale.length) say('settings.json 不用改');
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
  const legacy = LEGACY.map(([d, n]) => path.join(CLAUDE, d, n)).filter((p) => fs.existsSync(p));
  if (legacy.length) console.log(`\n发现旧版（改名前）的文件，没动它们，确认不用了可以自己删：\n  ${legacy.join('\n  ')}`);

  // 没装 switch 又没检测到 CC Switch：提示一句（只测装没装，不读它的任何内容）
  if (!ccsw && !comps.has('switch')) console.log('\n没检测到 CC Switch（切换供应商很常用，建议安装：https://github.com/farion1231/cc-switch ；装好后重跑安装入口勾上 switch 组件）');

  console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '装好了。'}文件 ${manifest.files.length} 个，本次备份 ${manifest.backups.length - oldBackups} 个。`);
  if (!DRY) {
    // 安装入口（setup.js）把「安装 → 配置 → 体检」串着跑时，会在环境变量 MR_SETUP_FLOW 里写后面还要跑哪几步（逗号分隔）：
    // 后面有配置这一步，这里就不再提示手动配；单独跑 install.js（或配置这一步被跳过）才提示
    const flowNext = (process.env.MR_SETUP_FLOW || '').split(',').filter(Boolean);
    const bye = `卸载：再跑一次安装入口选「卸载」，或 \`node ${ref('uninstall.js')}\``;
    if (flowNext.includes('configure')) console.log(`下一步：接着配模型设置${flowNext.includes('doctor') ? '、体检' : ''}（安装入口自动做）；做完重启 Claude Code。${bye}`);
    else console.log(`下一步：重启 Claude Code；接着跑 \`node ${ref('configure.js')}\`（或安装入口菜单 5）配模型设置并体检，手动配见 docs/GUIDE.md。${bye}`);
  }
}

main();

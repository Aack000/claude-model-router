#!/usr/bin/env node
'use strict';
/**
 * provider —— 只给这一个 Claude Code 会话换供应商：不动 CC Switch 当前卡片，不改 settings.json
 *
 * 用法（在项目目录里）：node ~/.claude/plugins/model-router/provider.js <供应商> [--key-env 变量名] [--dry-run] [claude 的参数…]
 *   node ~/.claude/plugins/model-router/provider.js deepseek
 *   node ~/.claude/plugins/model-router/provider.js deepseek --key-env DEEPSEEK_KEY --resume
 *   node ~/.claude/plugins/model-router/provider.js --list           列出有哪些供应商配置
 *   --dry-run   只打印会怎么启动（key 打码），不启动
 * 供应商配置在 providers/<名字>.json：env 是套给这个会话的环境变量（别名映射、能力声明…），keyEnv 是默认从哪些环境变量读 key。
 *
 * 原理：claude --settings <文件> 的优先级高于用户级 settings.json，只对这个进程生效，所以能一边开着 CC Switch 当前卡片的会话、
 * 一边开一个 DeepSeek 会话。/route 按别名派活，换了映射就自动换模型；route-check 读会话环境，核对的也是这份映射。
 * key：先读当前进程环境变量；Windows 上刚设的用户 / 系统环境变量要新开窗口才进进程，所以再读注册表。
 * key 写进系统临时目录里的设置文件交给 claude，会话结束就删；异常退出留下的，下次启动时清掉。key 不打印。
 * 主模型：实际生效的主模型（用户级或当前目录的项目配置、环境变量）是 Claude 完整 ID（claude-opus-5-5 之类）时，
 * 第三方供应商会把它当成最贵的模型计费，所以这个会话里自动改成供应商配置里 OPUS 别名的模型（透传 --model 的话不动）。
 *
 * 用户级 settings.json 指配置目录下的那份：环境变量 CLAUDE_CONFIG_DIR，没设就是 ~/.claude。
 *
 * 这个文件也能被 require：导出的几个纯函数（拆参数、参数加引号、拒绝判断、主模型判断）是为了单测。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'providers');
// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const TMP_RE = /^model-router-[\w.-]+-(\d+)\.json$/;
const list = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);

// ---------- Windows 经 shell 启动 claude：自己给参数加引号 ----------
// claude 在 Windows 上是 npm 生成的 .cmd（或自装的启动器），要经 shell（cmd /d /s /c "<整行>"）才找得到。
// 参数要过两道解析：cmd 先按引号状态判断 & | < > ^ 是不是元字符，再由 MSVCRT 把整行拆成 argv。
// 引号内的写法（一次都不能错）：
//   · 内部的 " 写成 ""（不是 \"）：MSVCRT 把引号区里的 "" 读成一个字面 "，而对 cmd 来说是两次开关、净状态不变；
//     写成 \" 的话 cmd 只看见一次开关，引号状态错位，后面的 & | 就裸奔了
//   · 紧挨在 " 前面的反斜杠要翻倍（n 个 → 2n 个），否则 \" 会被 MSVCRT 当成转义；末尾的反斜杠也要翻倍，
//     不然 "C:\work\" 的收尾引号被吃掉，引号区一直延伸到行尾（后面的参数全丢）
// 两件没法安全转义的东西直接拒绝：% （cmd 在命令行里会展开 %VAR%，引号里也一样）和换行（cmd 当成命令结束）
const SAFE_ARG = /^[\w./:=@-]+$/;
function quoteWinArg(a) {
  a = String(a);
  return SAFE_ARG.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
}
/** 参数里有没有没法安全交给 cmd 的字符；有就返回原因（不含参数内容），没有返回 null */
function winArgProblem(a) {
  a = String(a);
  if (a.includes('%')) return '含 %：cmd 会把 %变量% 展开（引号里也一样），没法安全转义';
  if (/[\r\n\0]/.test(a)) return '含换行：cmd 会把它当成命令结束，没法安全转义';
  return null;
}
const winCommandLine = (args) => ['claude', ...args.map(quoteWinArg)].join(' ');

// ---------- 主模型 ----------
const bareModel = (s) => String(s || '').replace(/\[\d+m\]$/i, '');
/** 带 - 的才是完整模型 ID（claude-opus-5-5、deepseek-flash）；不带的是 CLI 别名（fable/opus/sonnet/haiku/opusplan/best/default…） */
const isFullModelId = (s) => bareModel(s).includes('-');
const hasModelArg = (pass) => pass.some((a) => a === '--model' || a.startsWith('--model='));
/**
 * 这个会话要不要把主模型改掉。spec = 用户级配置 / 环境变量里解析出来的主模型值，cfgEnv = 供应商配置的 env。
 * 返回 { to }（该设成的模型）或 null（不用动）。
 * 不动的情况：没设 / 是别名（会走别名映射，已经被供应商接管）/ 透传了 --model / 供应商配置里没有 OPUS 映射可参照 /
 * 它本来就是这个供应商自己配置里的模型（用户已经在用这家的卡片了）
 */
function pickModelOverride(spec, cfgEnv, pass) {
  if (!spec || hasModelArg(pass) || !isFullModelId(spec)) return null;
  const to = (cfgEnv || {}).ANTHROPIC_DEFAULT_OPUS_MODEL;
  if (!to) return null;
  const own = Object.entries(cfgEnv).filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(k)).map(([, v]) => bareModel(v).toLowerCase());
  if (own.includes(bareModel(spec).toLowerCase())) return null;
  return { to };
}

const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
/**
 * 按 CLI 的优先级找实际生效的主模型：各配置的 env.ANTHROPIC_MODEL > 启动时的环境变量 ANTHROPIC_MODEL > 各配置的 model 字段；
 * 配置之间是 项目本地 > 项目共享 > 用户级（项目配置按当前目录找，和 claude 一样）。返回 { spec, from }（from 说明出处）或 null。
 * 配置的 env 会盖掉 shell 里的同名变量（10-26 实测：shell 设 haiku、项目配置 env 设 sonnet，跑的是 sonnet）。
 * 只管判断：我们的临时设置文件经 --settings 传入，优先级高于这三层，覆盖本身不受影响
 */
function resolveMainModel(procEnv, cwd, home, claudeDir) {
  const user = path.join(claudeDir || path.join(home, '.claude'), 'settings.json');   // 用户级配置在配置目录里（CLAUDE_CONFIG_DIR 或 ~/.claude）；不传就按 home 推
  const layers = [
    ['项目本地配置', path.join(cwd, '.claude', 'settings.local.json')],
    ['项目配置', path.join(cwd, '.claude', 'settings.json')],
    ['用户级配置', user],
  ].filter(([label, f]) => label === '用户级配置' || !samePath(f, user))   // 在家目录里启动时，项目配置就是用户级那份
    .map(([label, f]) => ({ label, f, j: readJson(f) }));
  for (const { label, f, j } of layers) {
    const v = j.env && j.env.ANTHROPIC_MODEL;
    if (typeof v === 'string' && v) return { spec: v, from: `${label}（${f}）的 env.ANTHROPIC_MODEL` };
  }
  if (procEnv.ANTHROPIC_MODEL) return { spec: procEnv.ANTHROPIC_MODEL, from: '环境变量 ANTHROPIC_MODEL' };
  for (const { label, f, j } of layers) if (typeof j.model === 'string' && j.model) return { spec: j.model, from: `${label}（${f}）的 model` };
  return null;
}

// ---------- --key-env 只能是变量名 ----------
const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** --key-env 的值是不是不像变量名（多半是把 key 本身填进来了）。true 就不能去查、更不能打印 */
const looksLikeKeyNotName = (v) => !KEY_ENV_RE.test(String(v)) || /^sk-/i.test(String(v));

/**
 * 拆参数：第一个不带横杠的是供应商名，本脚本自己的开关拿掉，其余原样交给 claude。
 * 返回 { list:true }、{ error }（错误信息里不含用户填的内容）或 { name, keyEnv, dry, pass }
 */
function parseArgs(argv) {
  let name = null, keyEnv = null, dry = false;
  const pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') return { list: true };
    if (a === '--dry-run') { dry = true; continue; }
    // 以 --key-env 开头的都在这里拦下：--key-env 名字、--key-env=名字，以及打错的 --key-envXXX。
    // 认不出的不能透传给 claude：试运行会打印它，claude 报「未知参数」时也会原样回显，而它可能带着 key
    if (a.startsWith('--key-env')) {
      if (a === '--key-env') {
        if (i + 1 >= argv.length) return { error: '--key-env 后面要跟环境变量的名字' };
        keyEnv = argv[++i];
      } else if (a.startsWith('--key-env=')) keyEnv = a.slice('--key-env='.length);
      else return { error: '有个以 --key-env 开头的参数认不出来（要写成 --key-env 名字 或 --key-env=名字）。为避免泄露，不回显它，也不交给 claude。' };
      // 误把 key 本身填在这里：不去查环境变量 / 注册表（名字会拼进 reg query 的命令行），也不能在任何输出里回显
      if (looksLikeKeyNotName(keyEnv)) return { error: '--key-env 要填环境变量的名字（字母、数字、下划线，不能以数字开头），你填的看起来是 key 本身或不是变量名。为避免泄露，不回显你填的内容，也没有去查。' };
      continue;
    }
    if (!name && !a.startsWith('-')) { name = a; continue; }
    pass.push(a);
  }
  return { name, keyEnv, dry, pass };
}

// ---------- key ----------
const HIVES = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
function readVar(v) {
  if (process.env[v]) return process.env[v].trim();
  if (process.platform !== 'win32') return null;
  for (const h of HIVES) {
    let out = '';
    try { out = execFileSync('reg', ['query', h, '/v', v], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    const m = out.match(new RegExp(`^\\s*${v.replace(/\W/g, '\\$&')}\\s+REG_(?:EXPAND_)?SZ\\s+(\\S+)`, 'im'));
    if (m) return m[1].trim();
  }
  return null;
}

function main() {
  const p = parseArgs(process.argv.slice(2));
  if (p.list) { console.log(`供应商配置（${DIR}）：${list().join('、') || '无'}`); process.exit(0); }
  if (p.error) { console.error(p.error); process.exit(2); }
  const { name, keyEnv, dry, pass } = p;
  if (!name) { console.error(`用法：node provider.js <供应商> [--key-env 变量名] [--dry-run] [claude 的参数…]\n可选：${list().join('、') || '无'}`); process.exit(2); }
  const file = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(file)) { console.error(`没有供应商配置 ${file}\n可选：${list().join('、') || '无'}`); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  // ---------- key ----------
  const names = keyEnv ? [keyEnv] : (cfg.keyEnv || []);
  let key = null, from = null;
  for (const v of names) { key = readVar(v); if (key) { from = v; break; } }
  // --key-env 是用户敲进来的，错误信息里不回显（万一是个正好符合变量名写法的 key）；默认读的变量名来自供应商配置，可以打印
  if (!key) { console.error(keyEnv ? `没读到 ${cfg.name || name} 的 key：--key-env 指定的那个环境变量没有值（Windows 上刚设的要新开窗口）` : `没读到 ${cfg.name || name} 的 key：设环境变量 ${names.join(' 或 ') || '（配置里没写 keyEnv）'}，或用 --key-env <变量名> 指定`); process.exit(1); }

  // ---------- 设置文件 ----------
  const env = { ...cfg.env, ANTHROPIC_AUTH_TOKEN: key };
  // 用户级配置里有 ANTHROPIC_API_KEY 时也要盖掉：不然它会以 x-api-key 发给新供应商，被拒 401。没有就不加（加了交互模式会多问一次要不要用这个 key）
  let userSettings = {};
  try { userSettings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8')) || {}; } catch { /* 没有也行 */ }
  const userEnv = userSettings.env || {};
  if ('ANTHROPIC_API_KEY' in userEnv || process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = key;

  // 主模型若是 Claude 完整 ID（项目 / 用户级配置的 model、env.ANTHROPIC_MODEL、环境变量），临时设置里的别名映射管不到它：
  // DeepSeek 会把 claude-opus* 当成 deepseek-v4-pro 按约 4.4 倍计费
  const mm = resolveMainModel(process.env, process.cwd(), os.homedir(), CLAUDE_DIR);
  const override = mm && pickModelOverride(mm.spec, cfg.env, pass);
  if (override) {
    env.ANTHROPIC_MODEL = override.to;
    console.log(`${mm.from} 是 "${mm.spec}"（完整模型 ID，不是别名），${cfg.name || name} 不一定认它、认了也可能按最贵的模型计费，这个会话的主模型改用 ${override.to}（想自己指定：透传 --model <别名或 ${cfg.name || name} 的模型 ID>）`);
  }

  const mask = (o) => JSON.stringify(o, (k, v) => (typeof v === 'string' && v === key ? `<key，来自 ${from}，长度 ${key.length}>` : v), 2);
  const tmp = path.join(os.tmpdir(), `model-router-${name}-${process.pid}.json`);
  const args = ['--settings', tmp, ...pass];

  // Windows 经 shell 启动：有没法安全转义的参数就拒绝（试运行也一样，让人先看到问题）
  const isWin = process.platform === 'win32';
  if (isWin) {
    for (let i = 0; i < args.length; i++) {
      const why = winArgProblem(args[i]);
      if (why) {
        console.error(`${i === 1 ? '临时设置文件的路径' : `传给 claude 的第 ${i - 1} 个参数`}${why}，已拒绝启动（不回显参数内容）。` +
          (i === 1 ? '把 TEMP 目录改到不含这类字符的位置。' : '去掉它，或在 cmd 之外直接运行 claude。'));
        process.exit(2);
      }
    }
  }
  const cmdline = isWin ? winCommandLine(args) : null;

  if (dry) {
    console.log(`[试运行] 会写 ${tmp}：\n${mask({ env })}\n[试运行] 然后在 ${process.cwd()} 里启动：${isWin ? cmdline : `claude ${args.join(' ')}`}\n[试运行] 会话结束后删掉这个文件`);
    process.exit(0);
  }

  // 上次异常退出（窗口被直接关掉之类）留下的设置文件里有 key，进程已经不在的就删
  for (const n of fs.readdirSync(os.tmpdir())) {
    const m = n.match(TMP_RE);
    if (!m || Number(m[1]) === process.pid) continue;
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) try { fs.unlinkSync(path.join(os.tmpdir(), n)); } catch { /* 删不掉下次再说 */ }
  }

  fs.writeFileSync(tmp, JSON.stringify({ env }), { mode: 0o600 });
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* 已经删了 */ } };
  process.on('exit', cleanup);
  // Ctrl+C 交给 claude 自己处理（它用来打断当前回合），这里只等它退出再删文件
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  // 直接点 × 关终端：Windows 把关窗映射成 SIGHUP（Ctrl+Break 是 SIGBREAK），Node 收到后不会再走 'exit' 事件就被终止，
  // 含明文 key 的设置文件就留在 %TEMP% 里了。这里同步删掉再退出：Windows 关窗后给进程约 10 秒，同步删文件来得及；
  // 注册了监听就不再有默认的「立即终止」，所以删完要自己 exit。claude 自己也收到同一个关窗事件，不用我们替它收尾。
  // 万一这一步没删成（文件被占用之类），下次启动时上面那段会按 PID 清掉
  const onHangup = (sig) => () => { cleanup(); process.exit(128 + (sig === 'SIGHUP' ? 1 : 21)); };
  process.on('SIGHUP', onHangup('SIGHUP'));
  if (isWin) process.on('SIGBREAK', onHangup('SIGBREAK'));

  console.log(`用 ${cfg.name || name} 启动 Claude Code（key 来自 ${from}；只对这个会话生效，CC Switch 和 settings.json 不动）`);
  const child = isWin ? spawn(cmdline, { stdio: 'inherit', shell: true }) : spawn('claude', args, { stdio: 'inherit' });
  child.on('error', (e) => { console.error(`启动 claude 失败：${e.message}`); cleanup(); process.exit(1); });
  child.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
}

module.exports = { quoteWinArg, winArgProblem, winCommandLine, pickModelOverride, isFullModelId, looksLikeKeyNotName, parseArgs, resolveMainModel };

if (require.main === module) main();

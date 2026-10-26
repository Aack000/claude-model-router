#!/usr/bin/env node
'use strict';
/**
 * provider —— 只给这一个 Claude Code 会话换供应商：不动 CC Switch 当前卡片，不改 settings.json
 *
 * 用法（在项目目录里）：node ~/.claude/plugins/model-router/provider.js <供应商> [--key-env 变量名] [--dry-run] [claude 的参数…]
 *   node ~/.claude/plugins/model-router/provider.js deepseek
 *   node ~/.claude/plugins/model-router/provider.js deepseek --key-env test_api_key --resume
 *   node ~/.claude/plugins/model-router/provider.js --list           列出有哪些供应商配置
 *   --dry-run   只打印会怎么启动（key 打码），不启动
 * 供应商配置在 providers/<名字>.json：env 是套给这个会话的环境变量（别名映射、能力声明…），keyEnv 是默认从哪些环境变量读 key。
 *
 * 原理：claude --settings <文件> 的优先级高于用户级 settings.json，只对这个进程生效，所以能一边开着 CC Switch 当前卡片的会话、
 * 一边开一个 DeepSeek 会话。/route 按别名派活，换了映射就自动换模型；route-check 读会话环境，核对的也是这份映射。
 * key：先读当前进程环境变量；Windows 上刚设的用户 / 系统环境变量要新开窗口才进进程，所以再读注册表。
 * key 写进系统临时目录里的设置文件交给 claude，会话结束就删；异常退出留下的，下次启动时清掉。key 不打印。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'providers');
const TMP_RE = /^model-router-[\w.-]+-(\d+)\.json$/;
const list = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);

// ---------- 参数：第一个不带横杠的是供应商名，本脚本自己的开关拿掉，其余原样交给 claude ----------
const argv = process.argv.slice(2);
let name = null, keyEnv = null, dry = false;
const pass = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list') { console.log(`供应商配置（${DIR}）：${list().join('、') || '无'}`); process.exit(0); }
  if (a === '--dry-run') { dry = true; continue; }
  if (a === '--key-env' && i + 1 < argv.length) { keyEnv = argv[++i]; continue; }
  if (!name && !a.startsWith('-')) { name = a; continue; }
  pass.push(a);
}
if (!name) { console.error(`用法：node provider.js <供应商> [--key-env 变量名] [--dry-run] [claude 的参数…]\n可选：${list().join('、') || '无'}`); process.exit(2); }
const file = path.join(DIR, `${name}.json`);
if (!fs.existsSync(file)) { console.error(`没有供应商配置 ${file}\n可选：${list().join('、') || '无'}`); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

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
const names = keyEnv ? [keyEnv] : (cfg.keyEnv || []);
let key = null, from = null;
for (const v of names) { key = readVar(v); if (key) { from = v; break; } }
if (!key) { console.error(`没读到 ${cfg.name || name} 的 key：设环境变量 ${names.join(' 或 ') || '（配置里没写 keyEnv）'}，或用 --key-env <变量名> 指定`); process.exit(1); }

// ---------- 设置文件 ----------
const env = { ...cfg.env, ANTHROPIC_AUTH_TOKEN: key };
// 用户级配置里有 ANTHROPIC_API_KEY 时也要盖掉：不然它会以 x-api-key 发给新供应商，被拒 401。没有就不加（加了交互模式会多问一次要不要用这个 key）
let userEnv = {};
try { userEnv = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {}; } catch { /* 没有也行 */ }
if ('ANTHROPIC_API_KEY' in userEnv || process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = key;

const mask = (o) => JSON.stringify(o, (k, v) => (typeof v === 'string' && v === key ? `<key，来自 ${from}，长度 ${key.length}>` : v), 2);
const tmp = path.join(os.tmpdir(), `model-router-${name}-${process.pid}.json`);
const args = ['--settings', tmp, ...pass];

if (dry) {
  console.log(`[试运行] 会写 ${tmp}：\n${mask({ env })}\n[试运行] 然后在 ${process.cwd()} 里启动：claude ${args.join(' ')}\n[试运行] 会话结束后删掉这个文件`);
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

console.log(`用 ${cfg.name || name} 启动 Claude Code（key 来自 ${from}；只对这个会话生效，CC Switch 和 settings.json 不动）`);
// Windows 上的 claude 是 npm 生成的 .cmd（或自装的启动器），要经 shell 才找得到；经 shell 就得自己给参数加引号
const isWin = process.platform === 'win32';
const q = (a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
const child = isWin ? spawn(['claude', ...args.map(q)].join(' '), { stdio: 'inherit', shell: true }) : spawn('claude', args, { stdio: 'inherit' });
child.on('error', (e) => { console.error(`启动 claude 失败：${e.message}`); cleanup(); process.exit(1); });
child.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });

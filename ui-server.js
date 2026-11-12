#!/usr/bin/env node
/**
 * model-router 本地控制面板
 *
 * 用法：
 *   node ui-server.js                 起服务并自动打开浏览器（随机端口，只监听 127.0.0.1）
 *   node ui-server.js --port 34567    固定端口
 *   node ui-server.js --no-open       不自动打开浏览器
 *
 * 只读接口照常展示安装状态、路由映射、规则、文件健康和 doctor --quick；
 * 唯一的写操作是 POST /api/install：按页面勾选的组件 / 放行规则重新运行安装器。
 * 写操作要带启动时生成的一次性 token（URL query 传入，页面存 sessionStorage），
 * 并校验 Origin，只接受本机回环访问；安装器自己负责备份和改 settings.json。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const PORT = portAt >= 0 ? Number(argv[portAt + 1]) : 0;
const NO_OPEN = argv.includes('--no-open');
const TOKEN = crypto.randomBytes(18).toString('hex');
let installing = false;

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const short = (p) => String(p).replace(os.homedir(), '~');

const RULE_SCRIPTS = { clean: 'route-clean', check: 'route-check', audit: 'usage-audit', doctor: 'doctor' };
const ALLOWED_COMPONENTS = ['core', 'usage', 'switch'];
const ALLOWED_RULES = ['clean', 'check', 'audit', 'doctor'];

let doctorCache = null;
let claudeJsonCache = null;

function runDoctor() {
  if (doctorCache && Date.now() - doctorCache.at < 20000) return Promise.resolve(doctorCache.data);
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'doctor.js'), '--quick'], {
      cwd: ROOT, timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const data = {
        ok: !err || err.code === 0,
        code: err && typeof err.code === 'number' ? err.code : 0,
        timedOut: Boolean(err && err.killed),
        output: stripAnsi(`${stdout || ''}${stderr || ''}`).trim(),
        durationMs: Date.now() - started,
      };
      doctorCache = { at: Date.now(), data };
      resolve(data);
    });
  });
}

/** 从 ~/.claude.json 找 ui-guard 的 MCP 注册（user 或 project scope），并核对 CLI 路径 */
function uiGuardStatus() {
  if (!claudeJsonCache || Date.now() - claudeJsonCache.at > 10000) {
    claudeJsonCache = { at: Date.now(), data: readJson(CLAUDE_JSON) || {} };
  }
  const cfg = claudeJsonCache.data;
  let entry = cfg.mcpServers && cfg.mcpServers['ui-guard'];
  let scope = entry ? 'user' : null;
  let projectPath = null;
  if (!entry && cfg.projects && typeof cfg.projects === 'object') {
    for (const [p, project] of Object.entries(cfg.projects)) {
      if (project && project.mcpServers && project.mcpServers['ui-guard']) {
        entry = project.mcpServers['ui-guard'];
        scope = 'project';
        projectPath = p;
        break;
      }
    }
  }
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  const cliPath = args.find((a) => /ui-guard[\\/]+bin[\\/]+ui-guard\.js$/i.test(a)) || null;
  let version = null;
  if (cliPath) {
    version = readJson(path.join(path.dirname(path.dirname(cliPath)), 'package.json'))?.version || null;
  }
  let reports = 0;
  let latestReportAt = null;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^ui-guard-.*\.json$/i.test(name)) continue;
      reports++;
      const stat = fs.statSync(path.join(os.tmpdir(), name));
      if (!latestReportAt || stat.mtimeMs > new Date(latestReportAt).getTime()) {
        latestReportAt = new Date(stat.mtimeMs).toISOString();
      }
    }
  } catch { /* 临时目录不可读就显示 0 */ }
  return {
    registered: Boolean(entry),
    scope,
    projectPath,
    cliPath: cliPath ? short(cliPath) : null,
    cliExists: cliPath ? fs.existsSync(cliPath) : false,
    version,
    reports,
    latestReportAt,
  };
}

async function buildStatus() {
  const manifest = readJson(MANIFEST);
  const settings = readJson(SETTINGS) || {};
  const env = settings.env || {};
  const modelFor = (name) => env[`ANTHROPIC_DEFAULT_${name.toUpperCase()}_MODEL`] || null;

  const files = (Array.isArray(manifest?.files) ? manifest.files : []).map((f) => {
    let state = 'ok';
    try {
      if (!fs.existsSync(f.target)) state = 'missing';
      else if (sha(f.target) !== f.sha) state = 'modified';
    } catch {
      state = 'unreadable';
    }
    return { target: f.target, kind: f.kind, state };
  });

  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const rules = Object.keys(RULE_SCRIPTS).map((id) => ({
    id,
    script: RULE_SCRIPTS[id],
    active: allow.some((r) => typeof r === 'string' && r.includes(RULE_SCRIPTS[id])),
  }));

  const rawComponents = Array.isArray(manifest?.components) ? manifest.components : null;
  // v1.x 清单没有 components 字段：安装器会按“全部已装”处理，面板必须回填同样的语义，
  // 否则管理区默认全不勾，一点 APPLY 就会把旧组件和规则删掉。
  const components = manifest ? (rawComponents || ['core', 'usage', 'switch']) : [];
  const legacy = Boolean(manifest) && !rawComponents;

  return {
    installed: Boolean(manifest),
    version: manifest?.version || readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'))?.version || null,
    installedAt: manifest?.installedAt || null,
    configDir: short(CLAUDE),
    pluginDir: short(PLUGIN),
    components,
    legacy,
    componentFiles: {
      core: files.filter((f) => f.kind === 'plugin').length,
      usage: files.filter((f) => /[\\/]usage[\\/]/.test(f.target)).length,
      switch: files.filter((f) => /[\\/]switch[\\/]/.test(f.target)).length,
    },
    routing: [
      { role: '规划', agent: 'planner-fable', alias: 'fable', model: modelFor('fable'), tone: 'violet' },
      { role: '实现', agent: 'general-purpose', alias: 'sonnet', model: modelFor('sonnet'), tone: 'cyan' },
      { role: '审查', agent: 'code-reviewer', alias: 'opus', model: modelFor('opus'), tone: 'amber' },
    ],
    haiku: modelFor('haiku'),
    rules,
    files: {
      total: files.length,
      ok: files.filter((f) => f.state === 'ok').length,
      issuesTotal: files.filter((f) => f.state !== 'ok').length,
      issues: files.filter((f) => f.state !== 'ok').slice(0, 12),
    },
    uiGuard: uiGuardStatus(),
    doctor: await runDoctor(),
    generatedAt: new Date().toISOString(),
  };
}

function runInstall(components, rules) {
  const comps = components.filter((c) => ALLOWED_COMPONENTS.includes(c));
  if (!comps.includes('core')) comps.unshift('core');
  const selected = rules.filter((r) => ALLOWED_RULES.includes(r));
  const args = [
    path.join(ROOT, 'install.js'),
    `--components=${comps.join(',')}`,
    `--rules=${selected.length ? selected.join(',') : 'none'}`,
  ];
  return new Promise((resolve) => {
    execFile(process.execPath, args, {
      cwd: ROOT, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      doctorCache = null;
      claudeJsonCache = null;
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        output: stripAnsi(`${stdout || ''}${stderr || ''}`).trim().slice(-8000),
      });
    });
  });
}

function readBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const STATIC = {
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['ui/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['ui/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/opening.gif': ['ui/opening.gif', 'image/gif'],
};

/** 只接受回环 Host，挡住 DNS rebinding 读走本机路径信息 */
function hostAllowed(req) {
  const port = server.address()?.port;
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden host');
    return;
  }
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* 默认路径 */ }

  if (pathname === '/api/status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await buildStatus()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    }
    return;
  }

  if (pathname === '/api/install') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const origin = req.headers.origin;
    const port = server.address().port;
    const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (req.headers['x-ui-token'] !== TOKEN || (origin && !allowedOrigins.includes(origin))) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (installing) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'another install is already running' }));
      return;
    }
    installing = true;
    try {
      const body = JSON.parse(await readBody(req));
      const components = Array.isArray(body.components) ? body.components : ['core'];
      const rules = Array.isArray(body.rules) ? body.rules : [];
      const result = await runInstall(components, rules);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    } finally {
      installing = false;
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('read-only');
    return;
  }

  const entry = STATIC[pathname];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    const body = fs.readFileSync(path.join(ROOT, entry[0]));
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ui assets missing');
  }
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就手动访问打印出来的地址 */ }
}

function shutdown() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch { /* 终端已断开 */ }
  console.log('\n面板已退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/?token=${TOKEN}`;
  console.log(`model-router 控制面板：${url}`);
  console.log('只监听本机回环 · 按 Q 退出');
  if (!NO_OPEN) openBrowser(url);

  // 终端里按 q 退出（raw 模式下 Ctrl+C 不再产生 SIGINT，一并处理）
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const key = String(chunk).toLowerCase();
      if (key === 'q' || key === '\u0003') shutdown();
    });
  }
});

server.on('error', (err) => {
  console.error(`✗ 启动失败：${err.message}`);
  process.exit(1);
});

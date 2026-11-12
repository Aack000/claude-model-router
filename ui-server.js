#!/usr/bin/env node
/**
 * model-router 本地控制面板（只读）
 *
 * 用法：
 *   node ui-server.js                 起服务并自动打开浏览器（随机端口，只监听 127.0.0.1）
 *   node ui-server.js --port 34567    固定端口
 *   node ui-server.js --no-open       不自动打开浏览器
 *
 * 设计边界：只提供 GET，只读展示安装清单、模型别名映射、放行规则和 doctor --quick 结果；
 * 不写任何配置、不碰凭据，不打印 env 里的其它值。装好的副本里同样直接可用（ui/ 目录随插件复制）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const UI_DIR = path.join(ROOT, 'ui');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');
const SETTINGS = path.join(CLAUDE, 'settings.json');

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const PORT = portAt >= 0 ? Number(argv[portAt + 1]) : 0;
const NO_OPEN = argv.includes('--no-open');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const short = (p) => String(p).replace(os.homedir(), '~');

const RULE_SCRIPTS = { clean: 'route-clean', check: 'route-check', audit: 'usage-audit', doctor: 'doctor' };

let doctorCache = null;

/** doctor --quick：只读 settings.json，毫秒级；缓存 20 秒，避免每次刷新都起子进程 */
function runDoctor() {
  if (doctorCache && Date.now() - doctorCache.at < 20000) return Promise.resolve(doctorCache.data);
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'doctor.js'), '--quick'], {
      cwd: ROOT, timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const output = stripAnsi(`${stdout || ''}${stderr || ''}`).trim();
      const data = {
        ok: !err || err.code === 0,
        code: err && typeof err.code === 'number' ? err.code : 0,
        timedOut: Boolean(err && err.killed),
        output,
        durationMs: Date.now() - started,
      };
      doctorCache = { at: Date.now(), data };
      resolve(data);
    });
  });
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

  const usageFiles = files.filter((f) => /[\\/]usage[\\/]/.test(f.target)).length;
  const switchFiles = files.filter((f) => /[\\/]switch[\\/]/.test(f.target)).length;

  return {
    installed: Boolean(manifest),
    version: manifest?.version || readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'))?.version || null,
    installedAt: manifest?.installedAt || null,
    configDir: short(CLAUDE),
    pluginDir: short(PLUGIN),
    components: Array.isArray(manifest?.components) ? manifest.components : [],
    componentFiles: {
      core: files.filter((f) => f.kind === 'plugin').length,
      usage: usageFiles,
      switch: switchFiles,
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
      issues: files.filter((f) => f.state !== 'ok').slice(0, 12),
    },
    doctor: await runDoctor(),
    generatedAt: new Date().toISOString(),
  };
}

const STATIC = {
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['ui/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['ui/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('read-only');
    return;
  }
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* 用默认路径 */ }

  if (pathname === '/api/status') {
    try {
      const body = JSON.stringify(await buildStatus());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
    return;
  }

  const entry = STATIC[pathname];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const file = path.join(ROOT, entry[0]);
  try {
    const body = fs.readFileSync(file);
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

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`model-router 控制面板（只读）：${url}`);
  console.log('数据：安装清单 + model-router 设置 + doctor --quick；Ctrl+C 退出');
  if (!NO_OPEN) openBrowser(url);
});

server.on('error', (err) => {
  console.error(`✗ 启动失败：${err.message}`);
  process.exit(1);
});

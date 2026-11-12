'use strict';

const $ = (id) => document.getElementById(id);

/* 启动时 URL 里的 token 只用于写操作校验：读进 sessionStorage 后从地址栏抹掉 */
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  sessionStorage.setItem('ui-token', urlToken);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('ui-token') || '';

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setHealth(tone, text) {
  $('health').replaceChildren(node('span', `dot ${tone}`), node('span', 'health-text', text));
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setRing(ratio) {
  const circumference = 402.12;
  const value = Math.max(0, Math.min(1, ratio));
  $('ring-val').style.strokeDashoffset = String(circumference * (1 - value));
  $('ring-num').textContent = `${Math.round(value * 100)}%`;
}

/* ---------- intro sequence ---------- */
function setupIntro() {
  const intro = $('intro');
  if (!intro) return;
  if (document.documentElement.classList.contains('no-intro')) {
    intro.remove();
    return;
  }
  const duration = 2800;
  const steps = [
    [0, 'BOOT SEQUENCE'],
    [25, 'LINK ESTABLISHED'],
    [50, 'LOADING MANIFEST'],
    [75, 'ROUTING TABLE'],
    [95, 'SURFACE READY'],
  ];
  const started = performance.now();
  const bar = $('intro-bar');
  const pct = $('intro-pct');
  const step = $('intro-step');
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    intro.classList.add('done');
    sessionStorage.setItem('intro-done', '1');
    setTimeout(() => intro.remove(), 750);
  };

  const timer = setInterval(() => {
    const t = Math.min(1, (performance.now() - started) / duration);
    const value = Math.round(t * 100);
    bar.style.width = `${value}%`;
    pct.textContent = String(value).padStart(3, '0');
    const current = steps.filter(([at]) => value >= at).pop();
    if (current) step.textContent = current[1];
    if (t >= 1) finish();
  }, 40);

  $('intro-skip').addEventListener('click', finish);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !finished) finish();
  });
}

/* ---------- renderers ---------- */
function renderRouting(rows) {
  const body = $('routing-body');
  body.replaceChildren();
  for (const r of rows) {
    const row = node('div', 'route-row');

    const role = node('div');
    const roleHead = node('div', 'route-role');
    roleHead.append(node('span', `dot ${r.tone}`), node('span', '', r.role));
    role.append(roleHead, node('span', 'route-agent', r.agent));

    const alias = node('div', 'route-alias');
    const target = node('span', 'route-target');
    target.append(node('span', 'arrow', '→'));
    target.append(r.model ? node('span', 'route-model', r.model) : node('span', 'route-model warn', '未映射'));
    alias.append(node('code', '', r.alias), target);

    row.append(role, alias);
    body.append(row);
  }
}

function renderComponents(data) {
  const body = $('components-body');
  body.replaceChildren();
  for (const id of ['core', 'usage', 'switch']) {
    const on = data.components.includes(id);
    const chip = node('span', `chip${on ? '' : ' off'}`);
    chip.append(node('span', `dot ${on ? 'ok' : ''}`), document.createTextNode(id));
    body.append(chip);
  }
  const meta = $('components-meta');
  meta.replaceChildren();
  const add = (label, value) => meta.append(node('dt', '', label), node('dd', '', value));
  add('VERSION', data.version ? `v${data.version}` : '未安装');
  add('INSTALLED', data.installedAt ? fmtTime(data.installedAt) : '—');
  add('CONFIG', data.configDir);
  add('PLUGIN', data.pluginDir);
}

function renderUiGuard(ug) {
  const head = $('ug-status');
  head.replaceChildren();
  if (ug.registered) {
    head.append(node('span', 'dot ok'), node('span', '', '已注册 MCP'));
    head.append(node('span', 'tag on', ug.scope === 'user' ? 'USER' : 'PROJECT'));
  } else {
    head.append(node('span', 'dot warn'), node('span', '', '未注册 MCP'));
  }

  const meta = $('ug-meta');
  meta.replaceChildren();
  const add = (label, value) => meta.append(node('dt', '', label), node('dd', '', value));
  add('VERSION', ug.version ? `v${ug.version}` : '未知');
  add('CLI', ug.cliPath || '未配置');
  add('STATE', ug.registered ? (ug.cliExists ? '可用' : '路径不存在') : '未连接');
  add('REPORTS', ug.reports > 0 ? `${ug.reports} 份 · ${fmtTime(ug.latestReportAt)}` : '暂无');
  $('ug-note').hidden = ug.registered && ug.cliExists;
}

function renderFiles(data) {
  const ratio = data.files.total > 0 ? data.files.ok / data.files.total : 0;
  $('files-ratio').textContent = `${data.files.ok}/${data.files.total} FILES`;
  $('files-bar').style.width = `${Math.round(ratio * 100)}%`;

  const list = $('files-issues');
  list.replaceChildren();
  if (data.files.total === 0) {
    list.append(node('li', 'empty', '没有安装清单，先运行安装器。'));
    return;
  }
  if (data.files.issues.length === 0) {
    list.append(node('li', 'empty', '清单中的文件全部与安装记录一致。'));
    return;
  }
  const label = { missing: '缺失', modified: '被修改', unreadable: '不可读' };
  for (const issue of data.files.issues) {
    const li = node('li');
    li.append(
      node('span', `badge ${issue.state === 'missing' ? 'err' : 'warn'}`, label[issue.state] || issue.state),
      document.createTextNode(issue.target)
    );
    list.append(li);
  }
  if (data.files.issues.length === 12) list.append(node('li', 'empty', '仅显示前 12 条。'));
}

function renderRules(rules) {
  const body = $('rules-body');
  body.replaceChildren();
  for (const rule of rules) {
    const li = node('li');
    const main = node('div', 'rule-main');
    main.append(node('strong', '', rule.id), node('span', '', rule.script));
    li.append(main, node('span', `tag${rule.active ? ' on' : ''}`, rule.active ? 'ON' : 'OFF'));
    body.append(li);
  }
}

function renderDoctor(doctor) {
  const meta = $('doctor-meta');
  const state = doctor.timedOut ? '超时' : doctor.ok ? '通过' : '有异常';
  const tone = doctor.timedOut ? 'warn' : doctor.ok ? 'ok' : 'err';
  meta.replaceChildren(node('span', `dot ${tone}`), document.createTextNode(` ${state} · ${doctor.durationMs}ms · exit ${doctor.code}`));
  $('doctor-body').textContent = doctor.output || '（无输出）';
}

/* ---------- manage ---------- */
let current = null;

function initManage(data) {
  current = data;
  for (const input of document.querySelectorAll('[data-group="components"]')) {
    input.checked = data.components.includes(input.value);
  }
  for (const input of document.querySelectorAll('[data-group="rules"]')) {
    const active = data.rules.find((r) => r.id === input.value)?.active;
    input.checked = Boolean(active);
  }
  syncDependencies();
}

function syncDependencies() {
  const usage = document.querySelector('[data-group="components"][value="usage"]');
  const audit = document.querySelector('[data-group="rules"][value="audit"]');
  if (!usage || !audit) return;
  if (audit.checked && !usage.checked) usage.checked = true;
  audit.disabled = !usage.checked;
  if (audit.disabled) audit.checked = false;
}

function selected() {
  const components = [...document.querySelectorAll('[data-group="components"]')]
    .filter((i) => i.checked).map((i) => i.value);
  const rules = [...document.querySelectorAll('[data-group="rules"]')]
    .filter((i) => i.checked).map((i) => i.value);
  return { components, rules };
}

const dialog = $('dialog');
const dialogLog = $('dialog-log');
const confirmButton = $('dialog-confirm');

function openDialog() {
  if (!current) return;
  const { components, rules } = selected();
  const summary = $('dialog-summary');
  summary.replaceChildren();
  const add = (label, value) => {
    const li = node('li');
    li.append(node('b', '', label), document.createTextNode(value));
    summary.append(li);
  };
  add('组件', ['core', ...components].join('、'));
  add('规则', rules.length ? rules.join('、') : '全部移除');
  add('影响', '重装后需重启 Claude Code');

  dialogLog.hidden = true;
  dialogLog.textContent = '';
  confirmButton.disabled = false;
  confirmButton.textContent = '确认并运行';
  dialog.showModal();
}

async function applyChanges() {
  const { components, rules } = selected();
  confirmButton.disabled = true;
  confirmButton.textContent = '正在运行…';
  dialogLog.hidden = false;
  dialogLog.textContent = '正在运行安装器…';
  try {
    const res = await fetch('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ui-token': token },
      body: JSON.stringify({ components, rules }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    dialogLog.textContent = data.output || '（无输出）';
    dialogLog.scrollTop = dialogLog.scrollHeight;
    if (data.ok) {
      confirmButton.textContent = '完成';
      toast('安装器已完成');
      await load();
    } else {
      confirmButton.disabled = false;
      confirmButton.textContent = '重试';
      toast(`安装器退出码 ${data.code}`);
    }
  } catch (err) {
    dialogLog.textContent = `失败：${err.message}`;
    confirmButton.disabled = false;
    confirmButton.textContent = '重试';
    toast('写操作失败');
  }
}

/* ---------- main ---------- */
function render(data) {
  $('version').textContent = data.version ? `v${data.version}` : 'v—';
  $('config-dir').textContent = data.configDir;
  $('config-dir').title = data.configDir;
  $('build').textContent = data.version ? `v${data.version}` : 'v—';

  const doctorWarn = !data.doctor.ok || data.doctor.timedOut || /[⚠✗❌]/.test(data.doctor.output || '');
  if (data.doctor.timedOut) setHealth('warn', '体检超时');
  else if (!data.installed) setHealth('warn', '未检测到安装');
  else if (data.doctor.ok && !doctorWarn) setHealth('ok', '运行正常');
  else setHealth('warn', '体检有提示');

  const healthy = data.doctor.ok && !data.doctor.timedOut && !doctorWarn;
  $('hud-status').textContent = !data.installed ? 'OFFLINE' : healthy ? 'ONLINE' : 'DEGRADED';

  $('stat-install').textContent = data.installed ? '已安装' : '未安装';
  $('stat-install').className = `stat-value ${data.installed ? 'tone-ok' : 'tone-warn'}`;
  $('stat-install-hint').textContent = data.installedAt ? `更新于 ${fmtTime(data.installedAt)}` : '运行安装器后显示';

  $('stat-doctor').textContent = data.doctor.timedOut ? '超时' : healthy ? '通过' : '有提示';
  $('stat-doctor').className = `stat-value ${healthy ? 'tone-ok' : 'tone-warn'}`;
  $('stat-doctor-hint').textContent = `doctor --quick · ${data.doctor.durationMs}ms`;

  $('stat-components').textContent = data.components.length ? `${data.components.length} 个` : '—';
  $('stat-components-hint').textContent = data.components.length ? data.components.join(' · ') : '未安装';

  $('stat-files').textContent = data.files.total ? `${data.files.ok}/${data.files.total}` : '—';
  $('stat-files').className = `stat-value ${data.files.total && data.files.issues.length ? 'tone-warn' : ''}`;
  $('stat-files-hint').textContent = data.files.issues.length ? `${data.files.issues.length} 个异常` : '全部一致';

  setRing(data.files.total ? data.files.ok / data.files.total : 0);
  $('ring-val').style.stroke = healthy ? '' : 'var(--amber)';
  $('ring-meta').textContent = data.files.total ? `${data.files.ok} / ${data.files.total}` : '—';

  renderRouting(data.routing);
  renderComponents(data);
  renderUiGuard(data.uiGuard);
  renderFiles(data);
  renderRules(data.rules);
  renderDoctor(data.doctor);
  initManage(data);

  const generated = new Date(data.generatedAt);
  $('generated').textContent = `生成于 ${generated.toLocaleTimeString('zh-CN', { hour12: false })}`;
  $('foot-time').textContent = fmtTime(data.generatedAt);
}

async function load() {
  const button = $('refresh');
  button.disabled = true;
  button.classList.add('loading');
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    setHealth('err', '读取失败');
    toast(`读取失败：${err.message}`);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
}

document.querySelectorAll('.copy').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      document.body.append(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
      toast('已复制');
    }
  });
});

for (const input of document.querySelectorAll('[data-group="components"]')) {
  input.addEventListener('change', syncDependencies);
}

$('refresh').addEventListener('click', load);
$('apply').addEventListener('click', openDialog);
$('dialog-cancel').addEventListener('click', () => dialog.close());
confirmButton.addEventListener('click', () => {
  if (confirmButton.textContent === '完成') {
    dialog.close();
    return;
  }
  applyChanges();
});

setupIntro();
load();

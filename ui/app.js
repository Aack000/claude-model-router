'use strict';

const $ = (id) => document.getElementById(id);

/* 启动时 URL 里的 token 只用于写操作校验：读进 sessionStorage 后从地址栏抹掉 */
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  sessionStorage.setItem('ui-token', urlToken);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('ui-token') || '';
if (!token) {
  $('token-banner').hidden = false;
  $('apply').disabled = true;
}

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
  const app = document.querySelector('.app');
  if (app) app.inert = true; // 开场期间键盘不能穿到背景

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
  const gif = intro.querySelector('.intro-gif');
  if (gif && gif.dataset.src) gif.src = gif.dataset.src;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    intro.classList.add('done');
    if (app) app.inert = false;
    sessionStorage.setItem('intro-done', '1');
    setTimeout(() => intro.remove(), 750);
  };

  const timer = setInterval(() => {
    const t = Math.min(1, (performance.now() - started) / duration);
    const value = Math.round(t * 100);
    bar.style.transform = `scaleX(${t})`;
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
  const total = data.files.issuesTotal ?? data.files.issues.length;
  $('files-ratio').textContent = `${data.files.ok}/${data.files.total} FILES`;
  $('files-bar').style.width = `${Math.round(ratio * 100)}%`;

  const list = $('files-issues');
  list.replaceChildren();
  if (data.files.total === 0) {
    list.append(node('li', 'empty', '没有安装清单，先运行安装器。'));
    return;
  }
  if (total === 0) {
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
  if (total > data.files.issues.length) {
    list.append(node('li', 'empty', `还有 ${total - data.files.issues.length} 条未显示。`));
  }
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
let dirty = false;
let running = false;

function initManage(data) {
  current = data;
  if (!dirty) {
    for (const input of document.querySelectorAll('[data-group="components"]')) {
      input.checked = data.components.includes(input.value);
    }
    for (const input of document.querySelectorAll('[data-group="rules"]')) {
      const active = data.rules.find((r) => r.id === input.value)?.active;
      input.checked = Boolean(active);
    }
  }
  syncDependencies();
}

function syncDependencies() {
  const usage = document.querySelector('[data-group="components"][value="usage"]');
  const audit = document.querySelector('[data-group="rules"][value="audit"]');
  if (!usage || !audit) return;
  // usage 是 audit 的前提：只置灰，不改用户的选择；提交时再剔除无法应用的规则。
  audit.disabled = !usage.checked;
}

function selected() {
  const components = [...document.querySelectorAll('[data-group="components"]')]
    .filter((i) => i.checked).map((i) => i.value);
  let rules = [...document.querySelectorAll('[data-group="rules"]')]
    .filter((i) => i.checked).map((i) => i.value);
  if (!components.includes('usage')) rules = rules.filter((r) => r !== 'audit');
  return { components, rules };
}

const dialog = $('dialog');
const dialogLog = $('dialog-log');
const confirmButton = $('dialog-confirm');

let pendingPayload = null;

function openDialog(mode = 'apply') {
  if (running) {
    toast('安装器正在运行，请等它结束');
    return;
  }
  if (!current) {
    toast('数据还没加载完成，先点 REFRESH');
    return;
  }

  let payload;
  if (mode === 'reinstall') {
    payload = {
      components: current.components,
      rules: current.rules
        .filter((r) => r.active && (r.id !== 'audit' || current.components.includes('usage')))
        .map((r) => r.id),
    };
    $('dialog-title').textContent = '重装 / 升级面板';
    $('dialog-desc').textContent = '按当前已安装的组件与规则重装，安装器会刷新面板文件并备份 settings.json。';
  } else {
    payload = selected();
    $('dialog-title').textContent = '应用更改';
    $('dialog-desc').textContent = '将重新运行安装器。';
  }
  pendingPayload = payload;
  const { components, rules } = payload;
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
  const { components, rules } = pendingPayload || selected();
  running = true;
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
    if (res.status === 403) throw new Error('写操作令牌失效：请从终端里带 token 的链接重新打开面板');
    if (res.status === 409) throw new Error('另一个安装器正在运行，请等它结束');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.ok) {
      dirty = false;
      dialogLog.textContent = `✓ 安装完成\n\n${data.output || '（无输出）'}`;
      dialogLog.scrollTop = 0;
      confirmButton.disabled = false;
      confirmButton.textContent = '完成';
      toast('安装器已完成');
      await load();
    } else {
      dialogLog.textContent = `✗ 安装器退出码 ${data.code}\n\n${data.output || '（无输出）'}`;
      confirmButton.disabled = false;
      confirmButton.textContent = '重试';
      toast(`安装器退出码 ${data.code}`);
    }
  } catch (err) {
    dialogLog.textContent = `✗ ${err.message}`;
    confirmButton.disabled = false;
    confirmButton.textContent = '重试';
    toast('写操作失败');
  } finally {
    running = false;
  }
}

/* ---------- main ---------- */
function renderError(message) {
  const hud = $('hud-status');
  hud.textContent = 'ERROR';
  hud.className = 'hud-tag err';
  const rail = $('rail-status');
  rail.textContent = 'ERROR';
  rail.className = '';
  setHealth('err', '读取失败');

  for (const id of ['stat-install', 'stat-doctor', 'stat-components', 'stat-files']) {
    $(id).textContent = '—';
    $(id).className = 'stat-value';
  }
  for (const id of ['stat-install-hint', 'stat-doctor-hint', 'stat-components-hint', 'stat-files-hint']) {
    $(id).textContent = '读取失败';
  }
  setRing(0);
  $('ring-val').style.stroke = 'var(--amber)';
  $('ring-meta').textContent = '—';
  $('routing-body').replaceChildren(node('div', 'empty', message));
  $('components-body').replaceChildren();
  $('components-meta').replaceChildren();
  $('ug-status').replaceChildren(node('span', 'dot err'), node('span', '', '读取失败'));
  $('ug-meta').replaceChildren();
  $('files-issues').replaceChildren(node('li', 'empty', message));
  $('files-ratio').textContent = '—';
  $('files-bar').style.width = '0';
  $('rules-body').replaceChildren(node('li', 'empty', message));
  $('doctor-body').textContent = message;
  $('legacy-note').hidden = true;
  $('generated').textContent = '读取失败';
  dirty = false;
}

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
  const hud = $('hud-status');
  hud.textContent = !data.installed ? 'OFFLINE' : healthy ? 'ONLINE' : 'DEGRADED';
  hud.className = `hud-tag ${!data.installed ? 'err' : healthy ? 'ok' : 'warn'}`;
  const rail = $('rail-status');
  rail.textContent = !data.installed ? 'OFFLINE' : healthy ? 'ONLINE' : 'DEGRADED';
  rail.className = healthy ? 'green' : '';

  $('legacy-note').hidden = !data.legacy;

  const setHint = (id, text) => {
    const el = $(id);
    el.textContent = text;
    el.title = text; // 省略号截断时仍能看到全文
  };

  $('stat-install').textContent = data.installed ? '已安装' : '未安装';
  $('stat-install').className = `stat-value ${data.installed ? 'tone-ok' : 'tone-warn'}`;
  setHint('stat-install-hint', data.installedAt ? `更新于 ${fmtTime(data.installedAt)}` : '运行安装器后显示');

  $('stat-doctor').textContent = data.doctor.timedOut ? '超时' : healthy ? '通过' : '有提示';
  $('stat-doctor').className = `stat-value ${healthy ? 'tone-ok' : 'tone-warn'}`;
  setHint('stat-doctor-hint', `doctor --quick · ${data.doctor.durationMs}ms`);

  $('stat-components').textContent = data.components.length ? `${data.components.length} 个` : '—';
  setHint('stat-components-hint', data.components.length ? data.components.join(' · ') : '未安装');

  const issuesTotal = data.files.issuesTotal ?? data.files.issues.length;
  $('stat-files').textContent = data.files.total ? `${data.files.ok}/${data.files.total}` : '—';
  $('stat-files').className = `stat-value ${data.files.total && issuesTotal ? 'tone-warn' : ''}`;
  setHint('stat-files-hint', issuesTotal ? `${issuesTotal} 个异常` : '全部一致');

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
    renderError(`读取失败（${err.message}），点 REFRESH 重试。`);
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

for (const input of document.querySelectorAll('[data-group]')) {
  input.addEventListener('change', () => {
    dirty = true;
    if (input.dataset.group === 'components') syncDependencies();
  });
}

$('refresh').addEventListener('click', load);
$('apply').addEventListener('click', () => openDialog('apply'));
$('reinstall').addEventListener('click', () => openDialog('reinstall'));
$('dialog-cancel').addEventListener('click', () => {
  if (running) {
    toast('安装器正在运行，请等它结束');
    return;
  }
  dialog.close();
});
dialog.addEventListener('cancel', (e) => {
  if (running) {
    e.preventDefault();
    toast('安装器正在运行，请等它结束');
  }
});
confirmButton.addEventListener('click', () => {
  if (confirmButton.textContent === '完成') {
    dialog.close();
    return;
  }
  if (running) return;
  applyChanges();
});

setupIntro();
load();

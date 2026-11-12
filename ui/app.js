'use strict';

const $ = (id) => document.getElementById(id);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setHealth(tone, text) {
  const wrap = $('health');
  wrap.replaceChildren(node('span', `dot ${tone}`), node('span', 'health-text', text));
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

function renderRouting(rows) {
  const body = $('routing-body');
  body.replaceChildren();
  for (const r of rows) {
    const row = node('div', 'route-row');

    const roleWrap = node('div', 'route-role');
    roleWrap.append(node('span', `dot ${r.tone}`), node('span', '', r.role));
    const role = node('div');
    role.append(roleWrap, node('span', 'route-agent', r.agent));

    const alias = node('div', 'route-alias');
    alias.append(node('code', '', r.alias), node('span', 'arrow', '→'));

    const model = r.model
      ? node('span', 'route-model', r.model)
      : node('span', 'route-model warn', '未映射');
    alias.append(model);

    row.append(role, alias);
    body.append(row);
  }
}

function renderComponents(data) {
  const body = $('components-body');
  body.replaceChildren();
  const known = ['core', 'usage', 'switch'];
  for (const id of known) {
    const on = data.components.includes(id);
    const chip = node('span', `chip${on ? '' : ' off'}`);
    chip.append(node('span', `dot ${on ? 'ok' : ''}`), document.createTextNode(id));
    body.append(chip);
  }

  const meta = $('components-meta');
  meta.replaceChildren();
  const add = (label, value) => {
    meta.append(node('dt', '', label), node('dd', '', value));
  };
  add('版本', data.version ? `v${data.version}` : '未安装');
  add('安装于', data.installedAt ? fmtTime(data.installedAt) : '—');
  add('配置目录', data.configDir);
  add('插件目录', data.pluginDir);
}

function renderFiles(data) {
  const ratio = data.files.total > 0 ? data.files.ok / data.files.total : 0;
  $('files-ratio').textContent = `${data.files.ok}/${data.files.total} 个文件一致`;
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
    const badgeClass = issue.state === 'missing' ? 'err' : 'warn';
    li.append(node('span', `badge ${badgeClass}`, label[issue.state] || issue.state), document.createTextNode(issue.target));
    list.append(li);
  }
  if (data.files.issues.length === 12) {
    list.append(node('li', 'empty', '仅显示前 12 条。'));
  }
}

function renderRules(rules) {
  const body = $('rules-body');
  body.replaceChildren();
  for (const rule of rules) {
    const li = node('li');
    const main = node('div', 'rule-main');
    main.append(node('strong', '', rule.id), node('span', '', rule.script));
    li.append(main, node('span', `badge ${rule.active ? 'ok' : 'warn'}`, rule.active ? '已放行' : '未放行'));
    body.append(li);
  }
}

function renderDoctor(doctor) {
  const meta = $('doctor-meta');
  const dot = doctor.timedOut ? 'warn' : doctor.ok ? 'ok' : 'err';
  const state = doctor.timedOut ? '超时' : doctor.ok ? '通过' : '有异常';
  meta.replaceChildren(node('span', `dot ${dot}`), document.createTextNode(` ${state} · ${doctor.durationMs}ms · exit ${doctor.code}`));

  const pre = $('doctor-body');
  pre.textContent = doctor.output || '（无输出）';
}

function render(data) {
  $('version').textContent = data.version ? `v${data.version}` : '未安装';
  $('config-dir').textContent = data.configDir;
  $('config-dir').title = data.configDir;

  const doctorWarn = !data.doctor.ok || data.doctor.timedOut || /[⚠✗❌]/.test(data.doctor.output || '');
  if (data.doctor.timedOut) setHealth('warn', '体检超时');
  else if (!data.installed) setHealth('warn', '未检测到安装');
  else if (data.doctor.ok && !doctorWarn) setHealth('ok', '运行正常');
  else setHealth('warn', '体检有提示');

  $('stat-install').textContent = data.installed ? '已安装' : '未安装';
  $('stat-install').className = `stat-value ${data.installed ? 'tone-ok' : 'tone-warn'}`;
  $('stat-install-hint').textContent = data.installedAt ? `更新于 ${fmtTime(data.installedAt)}` : '运行安装器后显示';

  const doctorHealthy = data.doctor.ok && !data.doctor.timedOut && !doctorWarn;
  $('stat-doctor').textContent = data.doctor.timedOut ? '超时' : doctorHealthy ? '通过' : '有提示';
  $('stat-doctor').className = `stat-value ${doctorHealthy ? 'tone-ok' : 'tone-warn'}`;
  $('stat-doctor-hint').textContent = `doctor --quick · ${data.doctor.durationMs}ms`;

  const comps = data.components.length ? data.components.join(' · ') : '无';
  $('stat-components').textContent = data.components.length ? `${data.components.length} 个` : '—';
  $('stat-components-hint').textContent = comps;

  const ratio = data.files.total ? `${data.files.ok}/${data.files.total}` : '—';
  $('stat-files').textContent = ratio;
  $('stat-files').className = `stat-value ${data.files.total && data.files.issues.length ? 'tone-warn' : ''}`;
  $('stat-files-hint').textContent = data.files.issues.length ? `${data.files.issues.length} 个异常` : '全部一致';

  renderRouting(data.routing);
  renderComponents(data);
  renderFiles(data);
  renderRules(data.rules);
  renderDoctor(data.doctor);

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

$('refresh').addEventListener('click', load);
load();

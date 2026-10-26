#!/usr/bin/env node
'use strict';
/**
 * uninstall —— 撤回 install.js 做的事
 *
 * 用法：node ~/.claude/plugins/model-router/uninstall.js [--dry-run]；也可以跑安装入口（setup.*）选「卸载」
 *   - 删 install.js 放进 ~/.claude/commands、~/.claude/agents、插件目录的文件；装完后被改过的不删，只提示
 *   - settings.json 去掉安装器加的放行规则；你原先自己加的不动。先备份，env 不打印、写完核对
 *   - 仓库本身就克隆在插件目录时不删仓库，提示自己删
 *   - 安装时做的备份 *.bak-* 一律不动，列出路径，要不要恢复由你定
 * 依据是插件目录里的 .install-manifest.json；没有它就说明不是 install.js 装的，什么都不做。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const bad = argv.find((a) => a !== '--dry-run');
if (bad) { console.error(`不认识的参数：${bad}\n用法：node uninstall.js [--dry-run]`); process.exit(2); }

const CLAUDE = path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE, 'plugins', 'model-router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const MANIFEST = path.join(PLUGIN, '.install-manifest.json');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x ?? null)).digest('hex');
const say = (s) => console.log((DRY ? '[试运行] ' : '') + s);

if (!fs.existsSync(MANIFEST)) {
  console.error(`没找到 ${MANIFEST}，看起来不是 install.js 装的，什么都没做。手动卸载见 docs/GUIDE.md。`);
  process.exit(1);
}
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
// 旧版清单只记一条 rule / ruleAdded
const ours = m.rulesAdded || (m.ruleAdded && m.rule ? [m.rule] : []);
const kept = [];

for (const f of m.files) {
  if (!fs.existsSync(f.target)) continue;
  if (sha(f.target) !== f.sha) { kept.push(f.target); continue; }
  say(`删 ${f.target}`);
  if (!DRY) fs.unlinkSync(f.target);
}

// 插件目录里因此空掉的子目录顺手收掉（只收空的）
for (const d of ['commands', 'agents', 'docs', '.claude-plugin']) {
  const p = path.join(PLUGIN, d);
  if (fs.existsSync(p) && fs.readdirSync(p).length === 0) { say(`删空目录 ${p}`); if (!DRY) fs.rmdirSync(p); }
}

if (ours.length && fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const j = JSON.parse(raw);
  const allow = j.permissions?.allow || [];
  const drop = ours.filter((r) => allow.includes(r));
  if (drop.length) {
    const envBefore = hash(j.env), restBefore = hash({ ...j, permissions: undefined }), permBefore = hash({ ...j.permissions, allow: undefined });
    const next = allow.filter((r) => !drop.includes(r));
    j.permissions.allow = next;
    for (const r of drop) say(`settings.json 去掉放行规则：${r}`);
    if (!DRY) {
      const d = new Date(), z = (n) => String(n).padStart(2, '0');
      const base = `${SETTINGS}.bak-model-router-uninstall-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
      let bak = base;
      for (let i = 2; fs.existsSync(bak); i++) bak = `${base}-${i}`;   // 撞名就加序号，不盖掉旧备份
      fs.copyFileSync(SETTINGS, bak);
      let s = JSON.stringify(j, null, 2) + '\n';
      if (raw.includes('\r\n')) s = s.replace(/\n/g, '\r\n');
      fs.writeFileSync(SETTINGS, s);
      const k = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
      const ok = hash(k.env) === envBefore && hash({ ...k, permissions: undefined }) === restBefore
        && hash({ ...k.permissions, allow: undefined }) === permBefore && JSON.stringify(k.permissions.allow) === JSON.stringify(next);
      if (!ok) { console.error(`✗ 写完核对不一致，请用 ${bak} 恢复`); process.exit(1); }
      say(`settings.json 核对通过（备份 ${path.basename(bak)}）`);
    }
  } else say('安装器加的放行规则已经不在 settings.json 里，不用改');
}
if (!ours.length) say('settings.json 里没有安装器加的放行规则，没动');

if (!DRY) fs.unlinkSync(MANIFEST);

if (kept.length) console.log(`\n装完后被改过、没删的文件：\n  ${kept.join('\n  ')}`);
if (m.backups.length) console.log(`\n安装时做的备份（没动，要恢复就自己改回原名）：\n  ${m.backups.join('\n  ')}`);
if (fs.existsSync(path.join(PLUGIN, '.git'))) console.log(`\n${PLUGIN} 是 git 仓库，没删；不要了就自己删整个目录。`);
else if (!DRY && fs.existsSync(PLUGIN)) {
  const left = fs.readdirSync(PLUGIN);
  if (!left.length) fs.rmdirSync(PLUGIN);
  else console.log(`\n插件目录里还剩这些（运行时生成的或你放的），没删：\n  ${left.map((n) => path.join(PLUGIN, n)).join('\n  ')}`);
}
console.log(`\n${DRY ? '试运行结束，没改任何文件。' : '卸载完成，重启 Claude Code 生效。'}`);

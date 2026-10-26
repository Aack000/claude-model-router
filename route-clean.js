#!/usr/bin/env node
'use strict';
/**
 * route-clean —— 删 /route 的过程文件
 *
 * 用法（单独一次调用，前面别拼 `cd …&&`、后面别接管道，否则不命中放行规则）：
 *   node ~/.claude/plugins/model-router/route-clean.js <目录>             删该目录下全部过程文件
 *   node ~/.claude/plugins/model-router/route-clean.js <目录> <文件名…>    只删这几个（阶段 5「已完成包的 handoff」）
 *
 * 为什么要它：auto 模式的权限分类器常把 `rm` 判成危险操作拦下，/route 收尾就卡在删文件上等人。
 * 在 `autoMode.allow` 里写文字说明也没用：实测快速判定那一档照拦。
 * 放行规则命中的命令根本不送分类器，所以 `install.js` 会在用户级 settings.json 里加这一条：
 *   Bash(node ~/.claude/plugins/model-router/route-clean.js *)
 * 这条不会被 auto 模式当成「危险规则」摘掉：CLI 只摘 `node -e …` 这种解释器加横杠参数的写法。
 * 规则只能由用户自己加（跑 install.js 或 /permissions）：Claude 不能给自己放权。
 *
 * 安全边界全在这里，规则才敢放宽到任意参数：
 *   - 只认三种文件名：.route-plan.md、.route-plan-<名>.md、.route-handoff-<名>.md；规划备份 *.bak-* 匹配不上
 *   - 只看给定目录这一层，文件名里带路径分隔符直接拒绝；只删普通文件，不删目录、不跟符号链接
 *   - 被 git 跟踪的跳过（删跟踪文件要使用方自己来）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PATTERN = /^\.route-(plan(-[\w.-]+)?|handoff-[\w.-]+)\.md$/;

const [dirArg, ...names] = process.argv.slice(2);
if (!dirArg) {
  console.error('用法：node route-clean.js <目录> [文件名…]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`不是目录：${dir}`);
  process.exit(2);
}
for (const n of names) {
  if (n !== path.basename(n) || n.includes('/') || n.includes('\\') || !PATTERN.test(n)) {
    console.error(`拒绝：「${n}」不是过程文件名（只认 .route-plan.md、.route-plan-*.md、.route-handoff-*.md，且不带路径）`);
    process.exit(2);
  }
}

const targets = names.length ? names : fs.readdirSync(dir).filter((n) => PATTERN.test(n));
const tracked = (n) => spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', n], { stdio: 'ignore' }).status === 0;

let removed = 0;
for (const n of targets) {
  const p = path.join(dir, n);
  let st;
  try { st = fs.lstatSync(p); } catch { console.log(`没有：${n}`); continue; }
  if (!st.isFile()) { console.log(`跳过（不是普通文件）：${n}`); continue; }
  if (tracked(n)) { console.log(`跳过（被 git 跟踪）：${n}`); continue; }
  fs.unlinkSync(p);
  console.log(`已删：${n}`);
  removed++;
}
console.log(`${dir}：共删 ${removed} 个${targets.length ? '' : '（没有过程文件）'}`);

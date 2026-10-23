#!/usr/bin/env node
'use strict';
/**
 * dev-clean —— 删 /dev 的过程文件，不经 auto 模式分类器（使用方 10-22 授权设置）
 *
 * 用法（单独一次调用，前面别拼 `cd …&&`、后面别接管道，否则不命中放行规则）：
 *   node ~/.claude/plugins/model-router/dev-clean.js <目录>             删该目录下全部过程文件
 *   node ~/.claude/plugins/model-router/dev-clean.js <目录> <文件名…>    只删这几个（阶段 5「已完成包的 handoff」）
 *
 * 为什么要它：auto 模式分类器的快速判定那一档会直接拦 `rm`。10-22 删 `_patch_tmp/dev-1022/` 下的
 * `.dev-plan.md`、`.dev-handoff-*.md` 被拦，用户级 `autoMode.allow` 写明了放行这类文件也没用。
 * 放行规则命中就不走分类器，所以给它配一条（用户级 settings.json）：
 *   Bash(node ~/.claude/plugins/model-router/dev-clean.js *)
 * 这条不会被 auto 模式当成「危险规则」摘掉：CLI 只摘 `node -e …` 这种解释器加横杠参数的写法。
 * 这套设置分类器不让 Claude 自己做（写工具、改 dev.md 都被拦），是使用方临时切出 auto 后批准完成的。
 *
 * 安全边界全在这里，规则才敢放宽到任意参数：
 *   - 只认三种文件名：.dev-plan.md、.dev-plan-<名>.md、.dev-handoff-<名>.md；规划备份 *.bak-* 匹配不上
 *   - 只看给定目录这一层，文件名里带路径分隔符直接拒绝；只删普通文件，不删目录、不跟符号链接
 *   - 被 git 跟踪的跳过（删跟踪文件要使用方自己来）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PATTERN = /^\.dev-(plan(-[\w.-]+)?|handoff-[\w.-]+)\.md$/;

const [dirArg, ...names] = process.argv.slice(2);
if (!dirArg) {
  console.error('用法：node dev-clean.js <目录> [文件名…]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`不是目录：${dir}`);
  process.exit(2);
}
for (const n of names) {
  if (n !== path.basename(n) || n.includes('/') || n.includes('\\') || !PATTERN.test(n)) {
    console.error(`拒绝：「${n}」不是过程文件名（只认 .dev-plan.md、.dev-plan-*.md、.dev-handoff-*.md，且不带路径）`);
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

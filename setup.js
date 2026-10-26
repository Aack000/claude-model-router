#!/usr/bin/env node
'use strict';
/**
 * setup —— 安装入口。双击启动器（setup.cmd / setup.ps1 / setup.command）和命令行（setup.sh）最终都跑它
 *
 * 用法：node setup.js [install|configure|uninstall|caps] [参数]
 *   不给动作 = 菜单：1 安装·升级（装完接着配模型设置、体检）　2 卸载　3 试运行　4 给 CC Switch 卡片补能力声明（第三方模型，要先装好插件）
 *   　　　　　　　　　5 只配模型设置并体检（要先装好插件）
 *   install [--rules=…] [--items=…] [--yes] [--no-configure] [--no-doctor] [--dry-run]
 *       安装 → 配置模型设置 → 体检，串着跑：前一步失败（退出码不是 0）就停，打印停在哪一步，后面的不跑。
 *       --rules 交给 install.js；--items、--yes 交给 configure.js；--dry-run 两边都给（试运行不预演体检，
 *       还没装过的话也不预演配置，因为没有安装清单）；--no-configure 不配置（体检照跑）；--no-doctor 不体检。
 *       体检的退出码是 1（发现要处理的问题）只打印一行提示，不算失败。
 *   configure [--items=…] [--yes] [--no-doctor] [--dry-run]    配置模型设置 → 体检（同菜单 5）
 *   uninstall / caps：其余参数原样交给 uninstall.js / ccswitch-caps.js
 *   例：node setup.js install --rules=clean,check --no-configure　　node setup.js uninstall --dry-run　　node setup.js caps --dry-run
 *   --pause   跑完等回车再退出（双击启动器加，免得窗口一闪就关）
 *   装到哪：环境变量 CLAUDE_CONFIG_DIR（和 Claude Code 一样），没设就是 ~/.claude；菜单顶上那一行会写出实际目录
 *
 * 菜单这一行用同步逐字节读：不在 stdin 上留挂起的读，后面 install.js 问放行规则、configure.js 问配哪几项时，输入才不会被这里抢走
 * （Windows 控制台上父进程挂着的读会跟子进程抢同一行）；逐字节读也不会多吞管道里后面的行。
 * install.js、configure.js 也是同一种读法，所以管道里一次喂完几行（如 printf '1\n\n\n'：菜单、放行规则、配置各一行）也是各读各的。
 * 串着跑时给安装这一步设环境变量 MR_SETUP_FLOW（后面还要跑哪几步，逗号分隔），install.js 据此决定结尾的「下一步」怎么写。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 配置目录和 Claude Code 一样认 CLAUDE_CONFIG_DIR，没设就是 ~/.claude（各脚本各自内联这一行，单个脚本被拷走也能用）
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const MANIFEST = path.join(CLAUDE, 'plugins', 'model-router', '.install-manifest.json');
const ACTIONS = { uninstall: 'uninstall.js', caps: 'ccswitch-caps.js' };   // 参数原样转给脚本；install / configure 走下面的 flow
const USAGE = '用法：setup [install|configure|uninstall|caps] [参数…]；不带参数出菜单';
const args = process.argv.slice(2);
const PAUSE = args.includes('--pause');
const rest = args.filter((a) => a !== '--pause');

/** 同步读一行；输入结束返回 null */
function readLineSync(q) {
  process.stdout.write(q);
  const buf = Buffer.alloc(1), bytes = [];
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, 1, null); } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); continue; }
      if (e.code === 'EOF') n = 0; else throw e;
    }
    if (n === 0) return bytes.length ? Buffer.from(bytes).toString().replace(/\r$/, '') : null;
    if (buf[0] === 0x0a) return Buffer.from(bytes).toString().replace(/\r$/, '');
    bytes.push(buf[0]);
  }
}

function run(script, pass, extraEnv) {
  // cwd 换到家目录：从插件目录双击 / 右键运行时，当前目录就是插件目录，Windows 上占着的目录删不掉，卸载最后删插件目录会 EBUSY。
  // 设了 CLAUDE_CONFIG_DIR 时把解析过的绝对路径交给子进程：它可能是相对路径，换了 cwd 就会指到别处
  const env = { ...process.env, ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: CLAUDE } : {}), ...(extraEnv || {}) };
  if (!extraEnv || !('MR_SETUP_FLOW' in extraEnv)) delete env.MR_SETUP_FLOW;   // 只有这里串着跑时才设，别沿用外面残留的
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...pass], { stdio: 'inherit', cwd: os.homedir(), env });
  return r.status ?? 1;
}

/**
 * 把命令行参数分给各步。--rules 给安装；--items、--yes 给配置；--dry-run 两边都给；--no-configure、--no-doctor 是这里自己的开关。
 * --rules / --items 后面跟着的裸词算它的值（PowerShell 调 .ps1 时会把 --rules=a,b 拆成「--rules=a」「b」两个参数）。
 * 不认识的参数立刻拒绝（返回 { bad }），免得前面的步骤白跑
 */
function splitArgs(list, allowed) {
  const r = { install: [], configure: [], noConfigure: false, noDoctor: false, dry: false };
  let cur = null;    // 当前在接谁的值：'install' | 'configure' | null
  let need = null;   // 刚给了 --rules / --items 但还没给值（空着往下跑，要等配置那一步才发现，那时安装已经做完了）
  for (const a of list) {
    const name = a.startsWith('--') ? a.split('=')[0] : null;
    if (need && name) return { bad: need };
    if (name && !allowed.includes(name)) return { bad: a };
    if (name === '--rules' || name === '--items') {
      if (a.endsWith('=')) return { bad: a };
      (name === '--rules' ? r.install : r.configure).push(a);
      cur = name === '--rules' ? 'install' : 'configure';
      if (a === name) need = a;
    } else if (name) {
      if (a !== name) return { bad: a };   // 这几个开关不带值
      if (name === '--yes') r.configure.push(a);
      else if (name === '--dry-run') { r.dry = true; r.install.push(a); r.configure.push(a); }
      else if (name === '--no-configure') r.noConfigure = true;
      else if (name === '--no-doctor') r.noDoctor = true;
      cur = null;
    } else if (cur) { r[cur].push(a); need = null; }
    else return { bad: a };
  }
  if (need) return { bad: need };
  return r;
}

/**
 * 串着跑几步：安装 → 配置 → 体检（按开关取其中几步）。前一步失败（退出码不是 0）就停，打印停在哪一步；
 * 体检退出码不是 0 只打印提示、不算失败（沙盒或刚装好时它常有要处理的事，那是提醒，不是安装坏了）
 */
function runFlow({ doInstall, doConfigure, doDoctor, installArgs = [], configureArgs = [], dry = false }) {
  const steps = [];
  if (doInstall) steps.push({ id: 'install', name: '安装', script: 'install.js', args: installArgs });
  if (doConfigure) steps.push({ id: 'configure', name: '配置模型设置', script: 'configure.js', args: configureArgs });
  if (doDoctor) steps.push({ id: 'doctor', name: '体检', script: 'doctor.js', args: [] });
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], n = `${i + 1}/${steps.length}`;
    if (steps.length > 1) console.log(`\n=== 第 ${n} 步：${s.name} ===`);
    if (dry && s.id === 'doctor') { console.log('[试运行] 体检不预演（它查的是装好之后的状态）。'); continue; }
    if (dry && s.id === 'configure' && doInstall && !fs.existsSync(MANIFEST)) { console.log('[试运行] 还没装插件（没有安装清单），配置这一步没法预演；真装之后会接着配。'); continue; }
    const later = steps.slice(i + 1).map((x) => x.id).join(',');
    const code = run(s.script, s.args, s.id === 'install' && later ? { MR_SETUP_FLOW: later } : null);
    if (s.id === 'doctor') {
      if (code === 1) console.log('\n体检发现要处理的问题，见上（不算安装失败）。');
      else if (code !== 0) console.log(`\n体检没有正常跑完（退出码 ${code}），见上（不算安装失败）。`);
      continue;
    }
    if (code !== 0) {
      console.error(`\n停在第 ${n} 步（${s.name}）：退出码 ${code}，原因见上。${i + 1 < steps.length ? '后面的步骤没有跑。' : ''}`);
      if (s.id === 'configure' && doInstall) console.error('安装已经做完了；修好后用菜单 5（或 setup configure）接着配。');
      return code;
    }
  }
  return 0;
}

/** setup install … / setup configure … */
function flowCmd(kind, list) {
  const allowed = kind === 'install' ? ['--rules', '--items', '--yes', '--dry-run', '--no-configure', '--no-doctor'] : ['--items', '--yes', '--dry-run', '--no-doctor'];
  const a = splitArgs(list, allowed);
  if (a.bad) {
    console.error(`不认识的参数：${a.bad}\n用法：setup ${kind === 'install' ? 'install [--rules=…] [--items=…] [--yes] [--no-configure] [--no-doctor] [--dry-run]' : 'configure [--items=…] [--yes] [--no-doctor] [--dry-run]'}`);
    return 2;
  }
  return runFlow({ doInstall: kind === 'install', doConfigure: kind === 'configure' || !a.noConfigure, doDoctor: !a.noDoctor, installArgs: a.install, configureArgs: a.configure, dry: a.dry });
}

function menu() {
  const claude = CLAUDE;
  let state = '没装';
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    state = `已装${m.version ? ` ${m.version}` : ''}（${String(m.installedAt).slice(0, 10)}）`;
  } catch { /* 没装，或不是安装器装的 */ }
  console.log(`model-router 安装器：装到 ${claude}，当前${state}\n`);
  console.log('  1  安装 / 升级（装好后接着配模型设置、体检）\n  2  卸载\n  3  试运行（只列安装会改什么，不动文件）\n  4  给 CC Switch 卡片补能力声明（第三方模型）\n  5  只配模型设置并体检（要先装好插件）\n  q  退出\n');
  for (;;) {
    const a = readLineSync('选哪个 [1]：');
    if (a === null) { console.log('\n没有输入，什么都没做。'); return 1; }
    const c = a.trim().toLowerCase() || '1';
    if (c === '1') return runFlow({ doInstall: true, doConfigure: true, doDoctor: true });
    if (c === '3') return run('install.js', ['--dry-run']);
    if (c === '4') return run('ccswitch-caps.js', []);
    if (c === '5') return runFlow({ doInstall: false, doConfigure: true, doDoctor: true });
    if (c === 'q') return 0;
    if (c === '2') {
      const y = readLineSync('确认卸载？输入 y 回车确认，直接回车取消：');
      if (y !== null && y.trim().toLowerCase() === 'y') return run('uninstall.js', []);
      console.log('取消了，什么都没改。');
      return 0;
    }
    console.log(`没有「${a.trim()}」这个选项。`);
  }
}

let code;
if (!rest.length) code = menu();
else if (rest[0] === 'install' || rest[0] === 'configure') code = flowCmd(rest[0], rest.slice(1));
else if (ACTIONS[rest[0]]) code = run(ACTIONS[rest[0]], rest.slice(1));
else { console.error(`不认识的动作：${rest[0]}\n${USAGE}`); code = 2; }
if (PAUSE) readLineSync('\n按回车关闭窗口');
process.exit(code);

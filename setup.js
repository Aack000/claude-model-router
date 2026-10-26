#!/usr/bin/env node
'use strict';
/**
 * setup —— 安装入口。双击启动器（setup.cmd / setup.ps1 / setup.command）和命令行（setup.sh）最终都跑它
 *
 * 用法：node setup.js [install|uninstall|caps] [其余参数原样交给 install.js / uninstall.js / ccswitch-caps.js]
 *   不给动作 = 菜单：1 安装·升级　2 卸载　3 试运行　4 给 CC Switch 卡片补能力声明（第三方模型，要先装好插件）
 *   例：node setup.js install --rules=clean,check　　node setup.js uninstall --dry-run　　node setup.js caps --dry-run
 *   --pause   跑完等回车再退出（双击启动器加，免得窗口一闪就关）
 *
 * 菜单这一行用同步逐字节读：不在 stdin 上留挂起的读，后面 install.js 问放行规则时，输入才不会被这里抢走
 * （Windows 控制台上父进程挂着的读会跟子进程抢同一行）；逐字节读也不会多吞管道里后面的行。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ACTIONS = { install: 'install.js', uninstall: 'uninstall.js', caps: 'ccswitch-caps.js' };
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

function run(script, pass) {
  // cwd 换到家目录：从插件目录双击 / 右键运行时，当前目录就是插件目录，Windows 上占着的目录删不掉，卸载最后删插件目录会 EBUSY
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...pass], { stdio: 'inherit', cwd: os.homedir() });
  return r.status ?? 1;
}

function menu() {
  const claude = path.join(os.homedir(), '.claude');
  let state = '没装';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(claude, 'plugins', 'model-router', '.install-manifest.json'), 'utf8'));
    state = `已装${m.version ? ` ${m.version}` : ''}（${String(m.installedAt).slice(0, 10)}）`;
  } catch { /* 没装，或不是安装器装的 */ }
  console.log(`model-router 安装器：装到 ${claude}，当前${state}\n`);
  console.log('  1  安装 / 升级\n  2  卸载\n  3  试运行（只列安装会改什么，不动文件）\n  4  给 CC Switch 卡片补能力声明（第三方模型）\n  q  退出\n');
  for (;;) {
    const a = readLineSync('选哪个 [1]：');
    if (a === null) { console.log('\n没有输入，什么都没做。'); return 1; }
    const c = a.trim().toLowerCase() || '1';
    if (c === '1') return run('install.js', []);
    if (c === '3') return run('install.js', ['--dry-run']);
    if (c === '4') return run('ccswitch-caps.js', []);
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
else if (ACTIONS[rest[0]]) code = run(ACTIONS[rest[0]], rest.slice(1));
else { console.error(`不认识的动作：${rest[0]}\n用法：setup [install|uninstall|caps] [参数…]；不带参数出菜单`); code = 2; }
if (PAUSE) readLineSync('\n按回车关闭窗口');
process.exit(code);

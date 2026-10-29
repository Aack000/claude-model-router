#!/usr/bin/env node
'use strict';
/** 旧路径转发：v2.0.0 起用量统计在 usage/ 组件里；这里只把参数和退出码原样透传，CLAUDE.md、放行规则里写的旧命令不用改 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const target = [path.join(__dirname, 'usage', 'usage-audit.js'), path.join(__dirname, 'plugins', 'usage', 'usage-audit.js')].find(fs.existsSync);
if (!target) { console.error('usage 组件没装：重跑安装入口并勾上 usage（或 node install.js --components=all，三个组件全装，不会卸掉已装的）'); process.exit(2); }
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);

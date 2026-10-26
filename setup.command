#!/usr/bin/env bash
# model-router 安装入口（macOS 访达双击）：开终端出菜单，跑完等回车再结束。
# 双击提示「无法打开」：右键 → 打开；提示没有权限：在终端跑 chmod +x setup.command。
command -v node >/dev/null 2>&1 || { echo "没找到 Node.js：先装 Node.js 18+（https://nodejs.org 或 brew install node），再重跑"; read -r -p "按回车关闭"; exit 1; }
exec node "$(dirname "$0")/setup.js" --pause "$@"

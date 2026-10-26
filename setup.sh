#!/usr/bin/env bash
# model-router 安装入口（Linux / macOS 命令行）。不带参数 = 菜单；带参数直接执行：
#   ./setup.sh install --rules=clean,check      ./setup.sh uninstall      ./setup.sh install --dry-run
# 没有执行权限就用 bash setup.sh。macOS 想在访达里双击用 setup.command。
command -v node >/dev/null 2>&1 || { echo "没找到 Node.js：先装 Node.js 18+（https://nodejs.org，或 brew install node、发行版的包管理器），再重跑"; exit 1; }
exec node "$(dirname "$0")/setup.js" "$@"

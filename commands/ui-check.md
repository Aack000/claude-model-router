---
description: 前端布局验收：ui-guard 扫描 → 硬错误派修复 → verify 回归，最多 3 轮
argument-hint: [页面地址，可省略]
---

做一次前端布局验收。页面地址：$ARGUMENTS

**前提**：本机装了 ui-guard（MCP 的 `ui_scan` / `ui_verify`，或 CLI `<ui-guard 仓库>/bin/ui-guard.js`）。没装或本轮没改前端 → 一句话说明跳过，不要建议安装，也不要自己造检查。

1. **地址**：参数优先；没给就向用户要 dev server 地址，不猜。`--actions "click:<选择器>"` 用于打开抽屉 / 气泡等只在交互后出现的状态。
2. **扫描**：`ui_scan`（或 `scan --url <地址> --viewports 375,1280 --out <报告>`）。硬错误：H1 页面溢出、H1c 文本横向裁剪、H2 文本纵向裁剪、H3 浮层越出视口、H4 按钮被遮挡点不到、H5 按钮互相重叠；S× 是疑似项。
3. **硬错误当审查发现**：每条转成发现（位置写 `selector @视口 状态`，触发场景写实测数据），按 `/route` 的规矩派修复子代理——不新增停点，主会话不直接改。疑似项只列给用户，不派活。
4. **回归**：修完 `ui_verify`（或 `verify --baseline <报告>`）核对，只认增量：`new` 必须修掉、`persisting` 说明没修好、`fixed` 是修复证据。
5. **最多 3 轮**：仍有硬错误就停下，把完整报告路径和剩余问题交给用户，不继续烧 token。

# CodexTokens —— Codex 用量面板

一个本地运行的 **Codex 用量统计面板**：扫描本机 `~/.codex/sessions` 日志，实时统计
Token 消耗、费用、API 调用次数、缓存命中率，并按 日 / 周 / 月 / 年 维度可视化。

**在线演示（示例数据，无需安装）**：`https://<你的用户名>.github.io/CodexTokens/`

## 功能特性

- **统计卡片**：充值余额（DeepSeek）、本周/今日消费、API 次数、平均单次消耗、
  Tokens 总量、每亿 Token 均价（带 ？ 弹窗：各时段官方标价 vs 我的均价 对比表 + 折线图）、缓存命中率
- **Token 消耗分布**：日视图按小时、周/月按天、年按月
- **API 调用次数折线图**：与消耗图左右并排（可切换上下、可合并为一张图）
- **任务明细**：每条用户消息 = 一个任务，显示消耗与费用；支持搜索、排序、
  列宽记忆、多选合并子任务、双击改名、任务分组、拖拽调整面板顺序
- **每 5 秒增量扫描日志**，自动刷新；窗口大小 / 面板布局 / 偏好设置重启保持
- **费用口径**：按真实账单校准的单价（默认 ¥0.039 / 百万 Token，可在
  `main.py` 的 `EFFECTIVE_PER_MILLION` 修改）折算

## 在线演示版说明

`docs/` 目录是 GitHub Pages 静态演示页：`docs/demo-data.js` 注入了模拟的
`pywebview` 桥和示例数据，浏览器打开即可体验全部界面交互（图表、弹窗、搜索、
排序等），**不读取任何本地文件，也不上传任何数据**。真实数据版请本地运行。

## 本地运行

数据只来自本机 `~/.codex/sessions/` 日志与 `~/.codex/config.toml` 中的
DeepSeek Key（仅用于查询余额），不会上传任何数据。

```bash
# 桌面版（需 pywebview）
pip install pywebview
python main.py

# 网页版（零第三方依赖）
python main.py --web            # 浏览器打开 http://127.0.0.1:8765/
```

## 打包 Windows exe

```bash
pip install pyinstaller
pyinstaller CodexTokens.spec --noconfirm
# 产物：dist/CodexTokens.exe（单文件，免安装）
```

## 目录结构

```
main.py            后端：日志增量解析 / 聚合 / 本地 HTTP 服务 / pywebview 桥
index.html         前端单页（原生 JS + SVG，无框架、无外部依赖）
docs/              GitHub Pages 在线演示页（示例数据）
CodexTokens.spec   PyInstaller 打包配置
```

## License

MIT

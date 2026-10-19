# CodexTokens —— Codex 用量面板

一个本地运行的 **Codex 用量统计面板**：扫描本机 `~/.codex/sessions` 日志，实时统计
Token 消耗、费用、API 调用次数、缓存命中率，并按 日 / 周 / 月 / 年 维度可视化。

- **公开网页版（无需安装任何东西）**：https://wooluin.github.io/CodexTokens/
- **Windows 单文件版**：见 [Releases](https://github.com/Wooluin/CodexTokens/releases)

## 公开网页版怎么用

打开网页 → 点击「选择 sessions 文件夹」→ 选中你电脑上的
`C:\Users\<你的用户名>\.codex\sessions`（macOS/Linux 为 `~/.codex/sessions`）。

页面随即在**浏览器本地**解析全部日志，展示与桌面版一致的统计：

- 统计卡片：Tokens 总量、消费金额、API 次数、平均单次消耗、每亿 Token 均价
  （带 ？ 弹窗：各时段官方标价 vs 我的均价 对比表 + 折线图）、缓存命中率
- Token 消耗分布图（日按小时 / 周月按天 / 年按月）+ API 调用次数折线图
- 任务明细：每条用户消息 = 一个任务，支持搜索、排序、合并、改名、分组视图
- 每 5 秒自动重扫新日志

**隐私**：所有解析都在你自己的浏览器里完成，日志内容与统计结果**不会上传到任何
服务器**；文件夹授权只影响本页面，可随时在浏览器站点设置里撤销。

**浏览器要求**：Chrome / Edge 桌面版（需支持 File System Access API）。

- 费用单价默认 ¥0.039 / 百万 Token（按真实账单校准）。如需自定义，可在控制台执行
  `localStorage.setItem("ct_rate", "你的单价")` 后刷新。
- 任务改名 / 合并关系保存在浏览器本地（localStorage），同样不会上传。

## 功能特性（桌面 / 网页通用）

- 日 / 周 / 月 / 年 切换，日期翻页与选择器跳转
- Token 消耗分布 + API 折线图：左右并排（可切上下、可合并为一张图）
- 面板拖拽排序、收纳、明细区高度记忆，窗口大小重启恢复
- 每亿 Token 均价卡片 + 各时段官方标价对比弹窗（表格 + 折线图）
- DeepSeek 余额显示（桌面版读取 `~/.codex/config.toml` 中的 Key 查询）

## 本地运行

数据只来自本机 `~/.codex/sessions/` 日志，不会上传任何数据。

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
docs/              GitHub Pages 公开网页版（浏览器本地解析，无后端）
  fsadapter.js       文件选择授权 + JSONL 解析 + 聚合（main.py 的 JS 复刻）
  index.html         页面本体（自动注入 fsadapter.js）
CodexTokens.spec   PyInstaller 打包配置
```

# Changelog

## Unreleased

- 修复 `/kimi-usage` 等待主 agent 空闲的问题，生成回复期间也可立即查询用量
- 修复 TUI 结果经 `sendMessage` 进入主任务 steering 队列的问题，改为 `appendEntry` + `Box` 背景卡片，即时显示且不写入 LLM 上下文
- 修复 K3/K2.8 的 off 档位误发 `none` 导致 HTTP 400，Responses 请求改为上游接受的 `off`
- 模型刷新传递并响应 pi 的中止信号，已取消的旧刷新不再覆盖最近一次刷新状态
- 修正思考档位：K3/K2.8 支持官方定义的 off 回退；K2.7 Highspeed 不再暴露或发送可调 effort
- 修正 `/kimi-refresh` 移除模型的报告文案，不再误称静态模型仍被保留
- 补齐发布包声明的 MIT `LICENSE` 文件
- 模型测试使用隔离 agent 目录，避免读取本机真实凭据

## 0.1.0 (2026-10-24)

- 初始版本：自研 provider `kimi`（OpenAI Responses 协议，baseUrl `{KIMI_API_BASE|https://api.kimi.com}/coding/v1`）
- 认证：Kimi Code OAuth 设备码登录（`/login`）+ `KIMI_API_KEY` 环境变量 / auth.json `kimi` 条目
- 静态模型目录 6 个：`k3.1-pro`、`k3.1-pro-highspeed`、`k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`
- `/kimi-usage`：套餐额度查询（移植自 pi-kimi-usage，凭据链改为 kimi 条目）
- `/kimi-refresh`：在线刷新模型列表（`GET /coding/v1/models`，未文档化），静态目录兜底

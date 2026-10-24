# Changelog

## 0.1.0 (2026-10-24)

- 初始版本：自研 provider `kimi`（OpenAI Responses 协议，baseUrl `{KIMI_API_BASE|https://api.kimi.com}/coding/v1`）
- 认证：Kimi Code OAuth 设备码登录（`/login`）+ `KIMI_API_KEY` 环境变量 / auth.json `kimi` 条目
- 静态模型目录 6 个：`k3.1-pro`、`k3.1-pro-highspeed`、`k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`
- `/kimi-usage`：套餐额度查询（移植自 pi-kimi-usage，凭据链改为 kimi 条目）
- `/kimi-refresh`：在线刷新模型列表（`GET /coding/v1/models`，未文档化），静态目录兜底

# pi-kimi-provider

为 [pi](https://github.com/earendil-works/pi) 提供的 [Kimi Code](https://www.kimi.com/code) 自研 provider：以 **OpenAI Responses 协议**（官方对 K3.1 系列推荐）接入 Kimi Code 套餐模型，支持 OAuth 设备码登录与 API Key，并提供 `/kimi-usage` 套餐额度查询、`/kimi-refresh` 模型列表刷新。

与 pi 内置的 `kimi-coding` provider **并存、互不影响**：本扩展注册独立的 provider `kimi`，凭据只读自己的条目，不回落到 `kimi-coding`。

> **免责声明**：这是非官方的社区维护集成，与 Moonshot AI / Kimi 无隶属、背书或支持关系。你需要自己的 Kimi 会员订阅（Plus 及以上档位含 Kimi Code 额度）以及 API Key 或 OAuth 登录，并遵守 Kimi 的条款、可用性与价格政策。`/kimi-usage` 与 `/kimi-refresh` 依赖的上游端点（`/coding/v1/usages`、`/coding/v1/models`）为**未文档化接口**，可能无预警变更。

## 安装

```sh
pi install git:github.com/baozi-2019/pi-kimi-provider
```

启动或重载 pi 后执行 `/login`：选择 **kimi**（与内置 `kimi-coding` 的「Kimi For Coding」区分开）→ 设备码授权，或直接粘贴 API Key，然后用 `/model` 选择 `kimi/` 前缀的模型。

更新与卸载：

```sh
pi update --extensions
pi remove git:github.com/baozi-2019/pi-kimi-provider
```

## 模型目录

内置 6 个模型，对齐[官方模型文档](https://www.kimi.com/code/docs/kimi-code/models.html)：

| 模型 ID                     | 版本                | 上下文 | 思考                               |
| --------------------------- | ------------------- | ------ | ---------------------------------- |
| `k3.1-pro`                  | K3.1 Pro            | 1M     | 强制开启，low/high/max（默认 max） |
| `k3.1-pro-highspeed`        | K3.1 Pro Highspeed  | 1M     | 同上，输出约 2–3 倍速              |
| `k3`                        | K3                  | 1M     | low/high/max（上游默认 high）      |
| `k3-256k`                   | K3（256K 版）       | 256K   | 同上                               |
| `kimi-for-coding`           | K2.8 Preview        | 1M     | low/high/max（上游默认 max）       |
| `kimi-for-coding-highspeed` | K2.7 Code Highspeed | 256K   | 固定开启，不可调档                 |

套餐不覆盖的模型或上下文会被上游拒绝（403），可用模型以你的会员档位为准（见[会员权益](https://www.kimi.com/code/docs/kimi-code/membership.html)）。

**思考档位**：K3.1 Pro 系列仅支持 low/high/max，关闭思考会被上游拒绝（HTTP 400）；K3 系列与 K2.8 也不提供 off，因为当前 Responses 上游实测同样拒绝 `off` 和 `none`，pi 会把旧的 off 设置钳制到受支持档位。K2.7 Highspeed 不暴露 effort 档位，也不发送该字段，由上游保持固定 Thinking:ON。表中的“上游默认”指未传 effort 时的服务端默认值；pi 会发送当前实际选中的档位。

**图片输入**：Responses 协议支持文本与图片输入（视频暂不支持，即使模型本身支持）。

## 认证

凭据优先级：`KIMI_API_KEY` 环境变量 > pi 认证文件中 `kimi` 条目。**不读取**内置 `kimi-coding` 的凭据。

### 登录对话框

在 pi 中执行 `/login`，选择 **kimi**：走 OAuth 设备码流程——终端显示用户码与验证链接，浏览器打开确认后自动完成；token 过期由扩展自动刷新（401/403 视为凭据失效，提示重新登录）。也可以在登录对话框直接粘贴从 [Kimi Code 控制台](https://www.kimi.com/code) 创建的 API Key。

### 环境变量

```sh
export KIMI_API_KEY="sk-kimi-..."
```

### 认证文件

`~/.pi/agent/auth.json` 的 `kimi` 条目（`/login` 写入，`api_key` 与 `oauth` 两种形态均可作为 Bearer 凭据）。

## 使用

用 `/model` 选择 `kimi/` 前缀的模型；终端可列出模型：

```sh
pi --list-models kimi
```

非交互模式：

```sh
pi -p "hello" --model kimi/k3.1-pro
```

建议同一会话固定模型与思考档位——切换会使上下文缓存失效并增加 token 消耗（官方建议）。

## 命令

| 命令            | 作用                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/kimi-usage`   | 查询套餐额度：5 小时滚动窗口 + 7 天周额度（新套餐无周额度时只显示 5 小时），进度条 + 剩余量 + 重置时间；主 agent 生成期间也可查询，5 秒防抖 |
| `/kimi-refresh` | 在线拉取模型列表（`GET /coding/v1/models`）并报告新增/移除；失败回退内置静态目录；5 秒防抖                                                  |

用量输出示例：

```text
5-hour ██████░░░░░░░░░░░░░░ 32% used · 68/100 remaining · resets 12:22
7-day  ██░░░░░░░░░░░░░░░░░░ 12% used · 88/100 remaining · resets 09-26
```

字段缺失显示 `unavailable`，不伪造零值；月总额度上游不返回，不展示（订阅页可查）。TUI 使用带 `customMessageBg` 主题背景色的持久卡片，通过 `appendEntry` 即时显示，不进入主任务的 steering 队列，也不写入 LLM 上下文；RPC 使用即时通知。

## 环境变量

| 变量                                       | 用途                                           | 默认值                  |
| ------------------------------------------ | ---------------------------------------------- | ----------------------- |
| `KIMI_API_KEY`                             | Kimi Code API Key（最高优先级）                | 无                      |
| `KIMI_API_BASE`                            | API 根地址覆盖（海外用 `https://api.kimi.ai`） | `https://api.kimi.com`  |
| `KIMI_OAUTH_HOST` / `KIMI_CODE_OAUTH_HOST` | OAuth 地址覆盖                                 | `https://auth.kimi.com` |

`KIMI_API_BASE`、`KIMI_OAUTH_HOST` 主要用于测试与本地 mock。修改后需 `/reload` 或重启生效（baseUrl 在扩展加载时确定）。

## 离线行为

模型列表以扩展内置的静态目录为兜底：在线拉取失败、`/kimi-refresh` 端点不可用或离线启动时，均回退到静态目录并给出提示，对话能力不受影响。

## 开发

```sh
npm install
npm test                 # typecheck + 全部单元测试 + pi 真实实例端到端测试
```

端到端测试 `tests/test-pi-local.mjs` 需要 `pi` 在 `PATH` 上，缺失时自动跳过。

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。用量查询与渲染移植自 [pi-kimi-usage](https://github.com/baozi-2019/pi-kimi-usage)；OAuth 设备码流程移植自 pi-ai 内置 `kimi-coding` provider（复用同一公共 OAuth client）。模型规格以 [Kimi Code 官方文档](https://www.kimi.com/code/docs/kimi-code/models.html)为准。

# pi-wecombot

> 企业微信智能机器人 WebSocket 长连接扩展 for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) 实现。

## 功能特性

- 🔗 **WebSocket 长连接** - 自动重连，断线无忧
- 🤖 **多机器人支持** - 支持配置多个机器人，快速切换
- 🏠 **全局配置共享** - 机器人列表全局共享，所有会话可见
- 🎯 **会话独立选择** - 每个会话独立选择启用哪个机器人
- 👥 **多人会话管理** - 按 req_id 区分不同用户
- 🔄 **消息自动转发** - 收到 @机器人 的消息自动处理
- 📤 **回复自动发送** - AI 回复自动发送到企业微信

## 安装

### 通过 npm（推荐）
```bash
pi install npm:pi-wecombot
```

### 通过 Git
```bash
pi install git:github.com/huang-x-h/pi-wecombot
```

## 架构设计

### 配置分层

```
┌─────────────────────────────────────────┐
│           全局配置（共享）               │
│  ~/.pi/agent/wecom-bot.json             │
│  {                                      │
│    "bots": [                            │
│      {"botId": "...", "secret": "..."}, │
│      {"botId": "...", "secret": "..."}  │
│    ]                                    │
│  }                                      │
└─────────────────────────────────────────┘
                    ▲
                    │ 所有会话共享
        ┌───────────┼───────────┐
        │           │           │
   ┌────┴────┐ ┌────┴────┐ ┌────┴────┐
   │ Session │ │ Session │ │ Session │
   │    A    │ │    B    │ │    C    │
   └────┬────┘ └────┬────┘ └────┬────┘
        │           │           │
   本会话配置    本会话配置    本会话配置
   wecom-bot-   wecom-bot-   wecom-bot-
   session-A    session-B    session-C
   .json        .json        .json
   
   {            {            {
     activeBotId  activeBotId  activeBotId
     enabled      enabled      enabled
   }            }            }
```

### 命令分类

| 命令 | 操作目标 | 说明 |
|------|---------|------|
| `wecombot-add` | **全局配置** | 添加机器人到全局列表，**所有会话可见** |
| `wecombot-remove` | **全局配置** | 从全局列表删除机器人，**影响所有会话** |
| `wecombot-list` | **全局配置** | 显示全局机器人列表（带本会话启用标记） |
| `wecombot-use` | **会话配置** | 选择本会话使用哪个机器人（**仅本会话**） |
| `wecombot-enable` | **会话配置** | 启用本会话的机器人连接（**仅本会话**） |
| `wecombot-disable` | **会话配置** | 禁用本会话的机器人连接（**仅本会话**） |
| `wecombot-status` | **混合** | 显示全局列表 + 本会话状态 |
| `wecombot-session-info` | **会话配置** | 显示本会话配置信息 |
| `wecombot-new` / `/new` | **会话联动** | 新建会话并无缝切换机器人连接，联动 pi-web 增加新会话 |

## 快速开始

### 1. 添加机器人（全局配置）

```
/wecombot-add
# 机器人名称(可选): 我的助手
# BotID: wwxxxxxxxxxxxxx
# Secret: xxxxxxxxxxxxxxx
```

> 添加后所有会话都能看到这个机器人

### 2. 查看机器人列表（全局）

```
/wecombot-list

输出示例：
全局机器人列表（共 2 个）：
▶ ✅ 助手A (ww111...)  ← ▶ 表示本会话正在使用
○ 助手B (ww222...)
本会话启用: 助手A
```

### 3. 选择本会话使用的机器人

```
/wecombot-use
# 选择机器人（仅本会话）: 助手B

✅ 本会话已切换到 助手B
```

## 完整命令说明

### 全局配置命令

#### `/wecombot-add` - 添加机器人（全局）

添加机器人到全局配置，**所有会话都能使用**。

```
/wecombot-add
  名称: 工作助手
  BotID: wwxxxxxxxxxxxxx
  Secret: xxxxxxxxxxxxxxx

✅ 已添加 工作助手（全局配置）
```

#### `/wecombot-list` - 列出机器人（全局）

显示全局机器人列表，带本会话启用标记：
- `▶` - 本会话正在使用的机器人
- `○` - 其他机器人
- `✅` - 当前已连接

```
/wecombot-list

全局机器人列表（共 3 个）：
▶ ✅ 工作助手
○ 测试助手
○ 个人助手
本会话启用: 工作助手
```

#### `/wecombot-remove` - 删除机器人（全局）

从全局配置删除机器人，**所有会话都将失去该机器人**。

```
/wecombot-remove
  输入要删除的BotID或名称: 工作助手

✅ 已删除 工作助手
```

### 会话配置命令

#### `/wecombot-use` - 切换机器人（本会话）

选择本会话使用哪个机器人，**不影响其他会话**。

```
/wecombot-use
  选择机器人（仅本会话）:
  ○ 工作助手
  ▶ 测试助手  ← 当前选择
  ○ 个人助手

✅ 本会话已切换到 测试助手
```

#### `/wecombot-enable` - 启用机器人（本会话）

启用本会话的机器人连接。

```
/wecombot-enable
✅ 本会话已启用并连接 工作助手
```

#### `/wecombot-disable` - 禁用机器人（本会话）

禁用本会话的机器人连接，**不影响其他会话**。

```
/wecombot-disable
🔌 本会话已禁用机器人并断开连接
```

#### `/wecombot-status` - 查看状态

显示混合信息：全局机器人数量 + 本会话详细状态。

```
/wecombot-status

✅ 工作助手
状态: 已连接
全局机器人: 3 个
本会话活跃会话: 2 个
会话ID: abc12345
```

#### `/wecombot-session-info` - 会话信息

显示本会话的配置详情。

```
/wecombot-session-info

会话ID: pid-1234
全局配置: ~/.pi/agent/wecom-bot.json
会话配置: ~/.pi/agent/wecom-bot-session-pid-1234.json
临时目录: ~/.pi/agent/tmp/wecom-bot/pid-1234

【全局】机器人数量: 3
【会话】启用机器人: wwxxxxxxxxxxxxx
【会话】启用状态: ✅
【会话】连接状态: 🟢 已连接
【会话】活跃消息会话: 2 个
```

#### `/new` 或 `/wecombot-new` - 新建会话并切换（联动 pi-web）

在企业微信中直接发送 `/new`（或在 Web/终端中执行 `/wecombot-new`），会自动：
1. 优先调用 pi-web 的 API（默认 `http://127.0.0.1:30141/api/agent/new`）新建一个全新的 pi session；
2. 自动将当前活跃的机器人配置继承至新 session；
3. 断开旧 session 的机器人长连，由新 session 接管 WebSocket 连接；
4. pi-web 的左侧侧边栏会联动即时出现新增的 session，后续在企微中的对话将全部路由至新 session，不再停留在旧 session 中。

> **支持指令格式**：`/new`、`/clear`、`/reset`（群聊中包含 `@机器人 /new` 亦可自动识别）。

## HTTP API 消息接口（主动接入与推送）

插件内置轻量级 HTTP 接口服务（默认监听端口 `30142`，可通过 `PI_WECOMBOT_PORT` 环境变量或 `~/.pi/agent/wecom-bot.json` 中的 `apiServer.port` 自定义），支持外部系统、自动化脚本或监控告警主动向 Pi Agent 投递消息（文本/图片），Agent 思考分析后通过 SDK 主动推送到指定企业微信用户或群聊中。

### 1. 发送消息接口

- **路径**：`POST /api/message` 或 `POST /api/send`
- **请求头**：`Content-Type: application/json`（若配置了 `apiKey`，需在 Header 附带 `X-API-Key: <key>` 或 `Authorization: Bearer <key>`）
- **请求体（JSON）**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | string | **是** | 接收目标的企微 `userid`（单聊）或 `chatid`（群聊） |
| `content` | string | 条件 | 消息正文文本（与 `images` 不能同时为空） |
| `images` | string[] | 否 | 图片列表，支持本地绝对路径、网络图片 URL 或 Base64 数据 |
| `sync` | boolean | 否 | 是否同步等待大模型完成处理并在 HTTP 响应中返回结果（默认 `false` 异步入队） |
| `timeoutMs` | number | 否 | 同步等待超时时间（毫秒，默认 `180000` 即 3 分钟） |

#### 异步发送示例（入队即返回，LLM 完成后通过企微 SDK 主动推送给目标）：
```bash
curl -X POST http://127.0.0.1:30142/api/message \
  -H "Content-Type: application/json" \
  -d '{
    "target": "woQoP7CwAAP4Jd-b_4mX1M6MoLg5mvbA",
    "content": "请检查一下昨天的销售数据报告"
  }'
```

#### 同步发送示例（等待大模型推理完，HTTP 返回回复正文，同时在企微推给用户）：
```bash
curl -X POST http://127.0.0.1:30142/api/message \
  -H "Content-Type: application/json" \
  -d '{
    "target": "woQoP7CwAAP4Jd-b_4mX1M6MoLg5mvbA",
    "content": "帮我写一个 Python 快速排序算法",
    "sync": true
  }'
```

### 2. 状态查询接口

- **路径**：`GET /api/status`
- **返回示例**：
```json
{
  "connected": true,
  "botId": "aibBqG_S6BekaSwM-iPsiTYAKSWXqBARCJE",
  "name": "工作助手",
  "sessionId": "01a11f48-4c8d-70a6-a0dd-a1cae3be0bd5",
  "queueLength": 0
}
```

## 使用场景示例

### 场景1：团队协作，共享机器人池

```
全局配置: 3 个机器人
├─ 工作助手 (BotID-A)
├─ 测试助手 (BotID-B)
└─ 个人助手 (BotID-C)

Session A (张三)          Session B (李四)
├─ 选择: 工作助手          ├─ 选择: 测试助手
├─ 状态: ✅ 已连接         ├─ 状态: ✅ 已连接
└─ 独立运行               └─ 独立运行

Session C (王五)
├─ 选择: 个人助手
├─ 状态: ✅ 已连接
└─ 独立运行
```

**特点**：
- ✅ 机器人配置一次，团队共享
- ✅ 每个人独立选择使用哪个机器人
- ✅ 互不干扰

### 场景2：多项目并行

```
Terminal 1 (项目A)        Terminal 2 (项目B)
├─ /wecombot-use          ├─ /wecombot-use
│   选择: 项目A机器人      │   选择: 项目B机器人
├─ 状态: 🤖[1234] ✅       ├─ 状态: 🤖[5678] ✅
└─ 连接 BotID-A           └─ 连接 BotID-B
```

### 场景3：工作/生活分离

```
Session 1 (工作)          Session 2 (生活)
├─ 机器人: 工作助手        ├─ 机器人: 个人助手
├─ 配置: 公司企业微信      ├─ 配置: 个人企业微信
└─ 消息: 工作群           └─ 消息: 家庭群
```

## ⚠️ 重要限制

> **同一机器人（BotID）只能在一个会话中连接**
>
> 企业微信官方限制：同一个 BotID 同时只能有一个 WebSocket 连接。

### 冲突场景

```
Session A (已连接工作助手)     Session B
├─ 状态: ✅ 工作助手            ├─ 执行 /wecombot-use 工作助手
├─ 运行中                      ├─ 连接成功
│                              │
│  ◄──── 被踢掉 ──────────────┤
│
└─ 状态: ❌ 被其他会话连接      └─ 状态: ✅ 工作助手
```

### 解决方式

1. **不同会话使用不同机器人**（推荐）
   - Session A: 工作助手 (BotID-A)
   - Session B: 个人助手 (BotID-B)

2. **手动切换**
   - 在 Session A 执行 `/wecombot-disable` 断开
   - 在 Session B 执行 `/wecombot-enable` 连接

## 配置存储

| 类型 | 路径 | 内容 | 共享方式 |
|------|------|------|---------|
| **全局配置** | `~/.pi/agent/wecom-bot.json` | 机器人列表 (botId, secret, name) | **所有会话共享** |
| **会话配置** | `~/.pi/agent/wecom-bot-session-{pi会话ID}.json` | activeBotId, enabled | **仅本会话** |
| **临时文件** | `~/.pi/agent/tmp/wecom-bot/{pi会话ID}/` | 上传文件等 | **仅本会话** |

> **会话身份说明**：会话配置键使用 pi 的会话 ID（`ctx.sessionManager.getSessionId()`），
> 同一会话文件跨重启/reload/resume 保持稳定，机器人可自动重连；
> 同目录新开其他会话因会话 ID 不同不会读取该配置，不会抢占连接。
> 可用 `PI_SESSION_ID`/`PI_INSTANCE_ID` 环境变量显式覆盖。
> 
> ⚠️ **从 v1.1.x 及更早版本升级**：旧版本会话配置文件以随机 ID 命名，
> 升级后不再匹配，需在入口会话重新执行一次 `/wecombot-use`。

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                         pi 会话 A                            │
│  ┌─────────────────┐        ┌─────────────────────────────┐ │
│  │  全局配置加载    │◄───────│  ~/.pi/agent/wecom-bot.json │ │
│  │  bots: [...]    │        │  机器人列表（共享）          │ │
│  └─────────────────┘        └─────────────────────────────┘ │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐        ┌─────────────────────────────┐ │
│  │  会话配置加载    │◄───────│ wecom-bot-session-A.json    │ │
│  │  activeBotId    │        │  activeBotId, enabled       │ │
│  │  enabled        │        │  （本会话独立）              │ │
│  └─────────────────┘        └─────────────────────────────┘ │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                       │
│  │   WSClient      │◄──────────────┐                       │
│  │   连接机器人     │               │                       │
│  └─────────────────┘               │                       │
│           │                        │                       │
│           ▼                        │                       │
│  ┌─────────────────┐               │                       │
│  │   企业微信       │◄──────────────┘                       │
│  │   智能机器人     │                                      │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## 参考

- [企业微信智能机器人开发文档](https://developer.work.weixin.qq.com/document/path/101463)
- [aibot-node-sdk](https://www.npmjs.com/package/aibot-node-sdk)

## License

MIT

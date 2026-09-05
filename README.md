# chat-team

`chat-team` 是一个连接 CWapi Agent 模式的本地多人聊天室。目标场景是：一个本地用户同时与多个连接到同一 CWapi Agent MCP 的 Web GPT 窗口进行讨论。

## 目标链路

```text
                    ┌─ Web GPT A ─┐
                    ├─ Web GPT B ─┤
chat-team <-> CWapi ├─ Web GPT C ─┤
                    └─ Web GPT ...
```

聊天室本身不运行模型，也不复制 Agent 调度逻辑。它只负责：

1. 使用 CWapi Agent Provider 的地址和 API Key 建立连接；
2. 把本地用户消息写入共享房间；
3. 读取共享房间中的 Web GPT 回复；
4. 将参与者、消息、时间和连接状态显示成普通聊天软件界面。

## 当前开发状态

前端和本地代理服务的第一版已经建立。启动后访问：

```text
http://127.0.0.1:32324
```

运行：

```powershell
npm start
```

需要 Node.js 20 或更高版本。

API Key 只保存在当前 `chat-team` 服务进程内存中，不写入浏览器存储或项目文件。浏览器 `sessionStorage` 只保存 CWapi 地址和房间名。

## CWapi 依赖

CWapi 2.0.5 当前标准 Agent Broker 是单逻辑 bridge 的 OpenAI-compatible request/response 模型。多个 Web GPT 窗口可连接同一 Agent MCP，但当前实现会重投同一 active request，并且一个 `request_id` 只接受一个不同的 completion。现有 completion event 也不携带 assistant 正文。

因此，多 Web GPT 真正作为独立聊天室成员，需要 CWapi Agent 增加一个向后兼容的 Team Room 消息总线。`chat-team` 已按以下本地接口对接：

```text
GET  /v1/team/rooms/{room}/messages?after=<sequence>
POST /v1/team/rooms/{room}/messages
Authorization: Bearer <agent-api-key>
```

预期消息结构：

```json
{
  "sequence": 12,
  "room": "main",
  "role": "assistant",
  "content": "...",
  "participant_id": "participant_...",
  "participant_name": "Web GPT 2",
  "created_at": "2026-09-05T09:00:00Z"
}
```

这个 Team Room 层应与现有 `/v1/chat/completions` 共存，不改变普通 Agent 软件的兼容行为。

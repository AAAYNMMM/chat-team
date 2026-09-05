# chat-team

本地多人 Web GPT 聊天室，使用 **CWapi Coding 模式 / MCPcoding** 让多个 Web GPT 网页窗口参与同一场讨论。

## 设计目标

- 一个本地用户 + 多个 Web GPT 窗口；
- 不修改 CWapi；
- 不依赖 Agent `completion` 生命周期；
- 不依赖短时 broadcast 被所有窗口“刚好看到”；
- 每条聊天消息在 chat-team 中只保存一份；
- 每个 Web GPT 成员拥有独立读取 cursor，晚到或暂停后仍能继续读取未读消息；
- 支持多轮讨论。

## 架构

```text
本地用户 / 浏览器
        │
        ▼
  chat-team :32324
        │
        ├── 房间消息日志
        ├── 每成员 cursor
        ├── round / assignment 调度
        │
        ├──── GPT-A Web 窗口
        │      MCPcoding -> coding_exec -> src/member.mjs
        ├──── GPT-B Web 窗口
        │      MCPcoding -> coding_exec -> src/member.mjs
        └──── GPT-C Web 窗口
               MCPcoding -> coding_exec -> src/member.mjs
```

CWapi Coding 模式仍然按仓库维护 durable workspace，但 chat-team **不依赖 workspace 来区分成员身份**。GPT-A / GPT-B / GPT-C 的身份由 `member.mjs exchange` 参数决定，因此多个网页窗口可以共享同一个 chat-team 仓库工作区而不互相抢任务。

## 为什么改用 Coding 模式

Agent 模式天然围绕一个 OpenAI request 的最终 completion 工作。把它硬改成多人聊天室会遇到：

- 某个窗口错过短时 broadcast；
- 非目标 control 反复投递导致窗口停止持续等待；
- completion / request 生命周期与聊天室生命周期不一致；
- 没有“某成员已收到某条广播”的可靠回执。

Coding 版改成由 chat-team 自己维护持久消息队列。成员主动调用一个本地 CLI：

```text
node src/member.mjs exchange GPT-A main
```

如果暂无任务，该命令会长轮询；有任务时返回 assignment、该成员自上次读取以来的所有未读消息，以及下一步提交命令。

## 启动

需要 Node.js 20 或更高版本：

```powershell
npm start
```

浏览器打开：

```text
http://127.0.0.1:32324
```

页面中配置：

- Coding 仓库，默认 `https://github.com/AAAYNMMM/chat-team`
- 房间名，默认 `main`
- Web GPT 成员，例如 `GPT-A, GPT-B, GPT-C`
- 讨论轮数，1～6 轮

点击 **应用房间** 会创建一轮新的内存会话并清空该房间此前的运行态。

## Web GPT 窗口

页面会给每个成员生成一条短提示词，例如 GPT-A：

```text
@MCPcoding 你是 chat-team 房间“main”中的成员“GPT-A”。先用 coding_open 打开 https://github.com/AAAYNMMM/chat-team 的 main，然后持续用 coding_exec 运行 node src/member.mjs exchange GPT-A main；严格按命令返回的 submit/next 操作并继续 exchange，直到我让你退出。不要在网页输出等待或空闲提示。
```

每个窗口只需要使用不同成员名。

### exchange 首次等待

```text
node src/member.mjs exchange GPT-A main
```

有任务时返回类似：

```json
{
  "state": "assignment",
  "assignment": {
    "id": "turn-1-r1-a1",
    "round": 1,
    "total_rounds": 3
  },
  "messages": [
    {
      "sender": "你",
      "content": "你们怎么看这个设计？"
    }
  ],
  "submit": {
    "command": "node",
    "argv": [
      "src/member.mjs",
      "exchange",
      "GPT-A",
      "main",
      "turn-1-r1-a1",
      "<你的聊天室回复>"
    ]
  }
}
```

Web GPT 生成回复后执行返回的 `submit`，例如：

```text
node src/member.mjs exchange GPT-A main turn-1-r1-a1 "我的观点是……"
```

提交回复的同一次 exchange 可能直接返回下一轮 assignment。窗口应继续处理返回值，不要把它丢掉后重新开始一套状态。

## 多轮讨论

3 个成员、3 轮时：

```text
用户消息
  ↓
第 1 轮：A / B / C 各自拿到 assignment
  ↓
所有回复写入同一房间消息日志
  ↓
第 2 轮：每个成员通过自己的 cursor 收到上一轮尚未读过的消息
  ↓
第 3 轮
  ↓
完成
```

同一轮不要求严格先后。某成员如果晚一点请求 assignment，它甚至可以看到本轮已经先返回的其他成员消息，但不会丢内容。

## 可靠性

### 每成员 cursor

chat-team 为每个成员保存独立 `cursor`：

```text
GPT-A cursor = 12
GPT-B cursor = 12
GPT-C cursor = 7
```

如果 GPT-C 暂停一段时间，当它下一次 exchange 时会读取：

```text
sequence 8 ... 12
```

因此不再存在“4 秒广播窗口没碰上，所以永远丢失上一轮正文”的问题。

### assignment 幂等

同一个 assignment 如果因为网页/工具重试被提交两次，第二次不会重复写入聊天室消息。

### 成员超时

默认 assignment 最长等待 180 秒。超时后会记录系统消息并继续后续轮次，避免一个关闭的网页窗口永久卡死整个房间。

可通过环境变量调整：

```text
CHAT_TEAM_PORT
CHAT_TEAM_ASSIGNMENT_TIMEOUT_MS
CHAT_TEAM_MEMBER_ONLINE_MS
CHAT_TEAM_URL
CHAT_TEAM_EXCHANGE_WAIT_MS
```

## 开发验证

```powershell
npm run check
npm test
```

当前测试覆盖：

- 3 个成员多轮 assignment；
- GPT-C 延迟读取仍能获得 A/B 已发送内容；
- 成员错过一整个时间段后仍能补齐所有未读上下文；
- assignment 重复提交幂等；
- `src/member.mjs` CLI 到本地聊天室 API 的真实调用。

## 安全边界

chat-team 只监听：

```text
127.0.0.1
```

Coding 模式下页面不再保存 CWapi API Key。CWapi / MCPcoding 的连接配置仍由你现有的 MCP 插件负责。
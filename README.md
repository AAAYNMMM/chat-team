# chat-team

本地多人 Web GPT 聊天室，使用 **CWapi Coding 模式 / MCPcoding** 让多个 Web GPT 网页窗口参与同一场讨论。

## 设计目标

- 一个本地用户 + 多个 Web GPT 窗口；
- 不修改 CWapi；
- 不依赖 Agent completion / broadcast 生命周期；
- 每条聊天消息在 chat-team 中只保存一份；
- 每个成员拥有独立读取 cursor，晚到或暂停后仍能补齐未读消息；
- `exchange` 必须是瞬时调用，不能长时间占用 MCPcoding 的仓库 workspace；
- 支持 1～6 轮讨论；
- 页面可直接打开新的 ChatGPT 标签页并自动发送成员启动提示词。

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

CWapi Coding 模式按仓库维护 durable workspace。多个网页窗口共享同一个 `chat-team` 仓库，因此 **同一时刻只能有一个前台 `coding_exec` 命令执行**。为避免某个成员锁住整个 workspace，`src/member.mjs exchange` 现在只读取一次状态并立即返回，不做长轮询。

如果多个窗口刚好同时调用 `coding_exec`，其中一个可能暂时得到 `CODING_COMMAND_ACTIVE`。这不是掉线，只代表另一个成员的瞬时命令正在执行；窗口应立即重试同一个 exchange。

## 启动

需要 Node.js 20 或更高版本：

```powershell
npm start
```

打开：

```text
http://127.0.0.1:32324
```

页面中配置：

- Web GPT 页面 URL，例如 `https://chatgpt.com/`，也可以填写具体 Project / 对话入口 URL；
- 房间名，默认 `main`；
- Web GPT 成员，例如 `GPT-A, GPT-B, GPT-C`；
- 讨论轮数，1～6 轮。

点击 **应用房间** 会创建新的内存房间运行态。

## 浏览器助手

为了做到“点击打开窗口后自动填入提示词并发送”，项目包含一个本地 Chrome / Edge Manifest V3 扩展：

```text
browser-extension/
```

浏览器安全策略不允许普通网页静默安装本地扩展，所以第一次需要手动安装一次：

1. 在 chat-team 页面点击 **打开浏览器助手目录**；
2. Chrome / Edge 打开扩展管理页并开启开发者模式；
3. 选择 **加载已解压的扩展程序**；
4. 选择 `browser-extension` 目录；
5. 刷新 `http://127.0.0.1:32324`。

页面显示 **浏览器助手已就绪** 后，以后只需要填写 Web GPT URL。

每个成员卡片会显示 **打开窗口**。点击后 chat-team 会：

1. 新开一个 ChatGPT 标签页；
2. 把该成员的 MCPcoding 启动提示词带到新页面；
3. 浏览器助手等待 ChatGPT 输入框加载；
4. 自动填入提示词；
5. 自动点击发送。

也可以点击 **打开全部窗口** 一次创建全部成员标签页。若浏览器阻止多个新标签页，需要允许 `127.0.0.1:32324` 打开弹出窗口。

## Web GPT 启动规则

GPT-A 的实际提示词类似：

```text
@MCPcoding 你是 chat-team 房间“main”中的成员“GPT-A”。先用 coding_open 打开 https://github.com/AAAYNMMM/chat-team 的 main，然后持续用 coding_exec 运行 node src/member.mjs exchange GPT-A main。每次 exchange 都是瞬时调用：严格按返回的 submit/next 操作，命令返回后立即继续下一次 exchange；如果 coding_exec 暂时返回 CODING_COMMAND_ACTIVE，说明另一个成员的瞬时命令正在执行，直接重试同一 exchange，不要退出。不要长时间占用 coding_exec，也不要在网页输出等待、空闲或冲突提示，直到我让你退出。
```

## exchange 协议

空闲时：

```text
node src/member.mjs exchange GPT-A main
```

会立即返回：

```json
{
  "state": "idle",
  "next": {
    "command": "node",
    "argv": ["src/member.mjs", "exchange", "GPT-A", "main"]
  }
}
```

有任务时会返回 assignment 和该成员尚未读过的所有消息：

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

提交回复的同一次 exchange 可能直接返回下一轮 assignment，因此窗口应继续处理**当前命令的返回值**，不要把它丢掉。

## 多轮与可靠性

### 每成员 cursor

chat-team 为每个成员保存独立 cursor：

```text
GPT-A cursor = 12
GPT-B cursor = 12
GPT-C cursor = 7
```

GPT-C 即使暂停一段时间，下一次 exchange 仍会读到 sequence 8～12，不存在短时广播漏读后永久丢上下文的问题。

### assignment 幂等

同一个 assignment 重复提交不会重复写入聊天室消息。

### 成员在线状态

成员每次 exchange 都会刷新 `lastSeenAt`。页面的“在线”只是最近是否持续轮询，不代表浏览器或 ChatGPT 进程级在线状态。

### assignment 超时

默认 assignment 最长等待 180 秒。超时后会写系统消息并继续后续调度，避免一个关闭的网页窗口永久卡住房间。

环境变量：

```text
CHAT_TEAM_PORT
CHAT_TEAM_ASSIGNMENT_TIMEOUT_MS
CHAT_TEAM_MEMBER_ONLINE_MS
CHAT_TEAM_URL
```

## 开发验证

```powershell
npm run check
npm test
```

测试覆盖：

- 3 个成员多轮 assignment；
- GPT-C 延迟读取仍能拿到 A/B 已发送内容；
- 成员错过一整个时间段后仍能补齐未读上下文；
- assignment 重复提交幂等；
- `src/member.mjs` CLI 到本地 API；
- 空闲 exchange 必须瞬时返回；
- 浏览器助手 manifest / 自动发送脚本存在并可解析。

## 安全边界

chat-team 只监听：

```text
127.0.0.1
```

页面不保存 CWapi API Key。CWapi / MCPcoding 的连接配置仍由现有 MCP 插件负责。

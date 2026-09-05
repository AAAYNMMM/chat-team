# chat-team

`chat-team` 是一个连接 CWapi Agent 模式的本地多人聊天室。目标场景是：一个本地用户同时与多个连接到同一 CWapi Agent MCP 的 Web GPT 窗口进行讨论。

## 工作方式

```text
                         ┌─ Web GPT 1
                         ├─ Web GPT 2
chat-team <-> CWapi <----├─ Web GPT 3
                         └─ Web GPT ...
```

聊天室本身不运行模型，也不复制 Agent 调度器。它只负责：

1. 使用 CWapi Agent Provider 的地址和 API Key 建立连接；
2. 把本地用户消息写入共享 Team Room；
3. 读取同一房间中的所有 Web GPT 回复；
4. 把参与者、消息和在线状态显示成普通聊天软件界面。

各 Web GPT 窗口通过同一个 Agent MCP 加入同一房间。CWapi 为每个窗口分配独立 participant 和 cursor，因此同一条用户消息可以被多个 Web GPT 分别看到；某个 Web GPT 的回复也会进入共享房间，其他窗口可以继续针对它讨论。

## 启动

需要 Node.js 20 或更高版本。当前没有第三方运行时依赖，不需要先安装一堆包来举行依赖树祭祀：

```powershell
npm start
```

浏览器打开：

```text
http://127.0.0.1:32324
```

在界面中只需要填写：

- CWapi Agent Provider 地址，例如 `http://127.0.0.1:32123/v1`
- Agent API Key
- 房间名，默认 `main`

API Key 只保存在当前 `chat-team` 服务进程内存中，不写入项目文件或浏览器存储。浏览器 `sessionStorage` 只保存 CWapi 地址和房间名。

## Web GPT 窗口

仅仅给网页窗口挂上 MCP 插件并不会让模型主动轮询房间。每个 Web GPT 窗口需要先执行一次加入提示词。聊天室左侧会根据当前房间生成并提供复制按钮，例如：

```text
@MCPagent 加入 chat-team 的 main 房间，作为一个独立 Web GPT 参与者。先调用 agent_team_join 加入该房间，然后持续使用 agent_team_exchange 等待消息。收到用户或其他 Web GPT 的新消息时正常参与讨论；没有新消息就继续等待。不要使用普通 agent_exchange 处理聊天室消息。
```

## CWapi Team Room 扩展

原版 CWapi 2.0.5 的普通 Agent Broker 是单 request / 单 completion 模型，不适合直接把多个 Web GPT 当成独立聊天室成员。`chat-team` 使用一个与普通 `/v1/chat/completions` 完全分离的 Team Room 层，不改变原 Agent 客户端兼容行为。

当前配套实现位于 CWapi 的 `feature/chat-team` 开发分支（基础实现提交 `49e71eeb`），提供：

### Agent MCP

```text
agent_team_join
agent_team_exchange
```

### 本地 Provider

```text
GET  /v1/team/rooms/{room}/messages?after=<sequence>
POST /v1/team/rooms/{room}/messages
Authorization: Bearer <agent-api-key>
```

共享房间采用有界内存历史，每个 Web GPT participant 拥有独立消息 cursor。Web GPT 自己发送的消息不会再回显给自己，但会被同房间的其他 participant 和本地聊天室读取。

## 当前状态

第一版已经包含：

- CWapi 地址和 API Key 连接验证
- 用户消息发送
- 房间消息轮询
- 多 Web GPT 消息显示
- Web GPT 在线参与者列表
- 房间加入提示词复制
- 本地 API Key 仅内存保存

后续可在不改变消息协议的前提下继续增加 Markdown 渲染、消息引用、房间管理和本地历史持久化。

## 验证

```powershell
npm run check
npm test
```

测试会启动一个本地模拟 CWapi Provider，验证连接握手、Team Room 能力检测，以及“用户消息只上传一次并写入共享房间”的链路。

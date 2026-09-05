# chat-team

`chat-team` 是一个连接 **原版 CWapi 2.0.5 Agent 模式** 的本地多人聊天室。一个本地用户可以同时与多个连接到同一个 Agent MCP 的 Web GPT 窗口讨论。

CWapi **不需要任何修改**。项目只使用 CWapi 已有接口：

```text
GET  /v1/models
POST /v1/chat/completions

agent_open
agent_exchange
```

## 工作方式

```text
                         ┌─ Web GPT A
                         ├─ Web GPT B
chat-team -> CWapi 2.0.5├─ Web GPT C
                         └─ ...
```

核心不是把完整聊天记录重复发送给每个模型，而是把请求分成两类：

### 1. 共享正文广播

用户或某个 Web GPT 的真实聊天正文只通过 CWapi 发送一次。

```text
用户：这个设计怎么样？
        ↓
一个 broadcast request
        ↓
GPT-A / GPT-B / GPT-C 都能从同一个 Agent MCP 读到
```

broadcast request 会保持一小段时间，让所有正在 `agent_exchange` 的网页窗口读取。它**不允许 completion**。广播窗口结束后，chat-team 主动取消这个 HTTP request；CWapi 会按原有客户端断开逻辑回收它。

### 2. 定向控制请求

chat-team 再发送很小的控制请求，决定当前轮到哪个窗口发言：

```text
control -> target=GPT-A
control -> target=GPT-B
control -> target=GPT-C
```

每个网页窗口启动时绑定唯一身份。只有 target 与自己身份一致的窗口才对 control request 提交 completion，其他窗口忽略。

GPT-A 的 completion 返回 chat-team 后：

1. chat-team 把 GPT-A 的回复显示在聊天室；
2. 该回复再作为一个共享正文 broadcast **发送一次**；
3. GPT-B / GPT-C 因此能看到 GPT-A 的内容；
4. 然后 chat-team 再发送 `target=GPT-B` 的控制请求。

所以一次三人讨论大致是：

```text
用户正文      × 1 broadcast
GPT-A 控制    × 1 很小的 control
GPT-A 回复    × 1 broadcast
GPT-B 控制    × 1 很小的 control
GPT-B 回复    × 1 broadcast
GPT-C 控制    × 1 很小的 control
GPT-C 回复    × 1 broadcast
```

不会把用户正文或 GPT 回复分别复制三份。

## 启动

需要 Node.js 20 或更高版本：

```powershell
npm start
```

浏览器打开：

```text
http://127.0.0.1:32324
```

界面中填写：

- CWapi Agent Provider 地址，例如 `http://127.0.0.1:32123/v1`
- Agent API Key
- 房间名
- Web GPT 成员名，例如 `GPT-A, GPT-B, GPT-C`
- 每次讨论轮数，1～3 轮

API Key 只保存在当前 chat-team 服务进程内存中，不写入项目文件或浏览器存储。浏览器只保存地址、房间名、成员名和轮数。

## Web GPT 窗口

每个 Web GPT 窗口必须绑定不同身份。界面会根据成员列表生成独立启动提示词和复制按钮。

例如 GPT-A 的窗口会收到类似规则：

```text
你是 GPT-A。
先 agent_open，然后持续 agent_exchange。

broadcast：
- 只读取并记住共享聊天正文；
- 不提交 completion / tool_call / progress；
- 继续 agent_exchange。

control：
- target != GPT-A：忽略，不提交 response；
- target == GPT-A：结合此前收到的 broadcast 参与讨论；
- 对准确 request_id 提交 completion；
- 完成后继续 agent_exchange。
```

因此每个网页 GPT 自己的 ChatGPT 对话上下文天然保存它此前看到的共享消息，不需要 chat-team 每次重发完整历史。

## 讨论轮数

默认 1 轮：

```text
用户 -> A -> B -> C -> 等用户继续
```

2 轮时：

```text
用户 -> A -> B -> C -> A -> B -> C -> 等用户继续
```

后发言的成员能看到前面成员的 broadcast，因此可以直接回应其他 Web GPT。第二轮开始后，较早发言的成员也可以回应第一轮后面的观点。

如果某成员本轮没有新的有价值内容，可以按协议返回：

```text
[[SKIP]]
```

chat-team 不显示也不广播这条跳过结果。

## 可靠性边界

原版 CWapi 没有“聊天室成员在线状态”这一概念，所以 chat-team 只能显示配置成员及当前控制请求状态，不能声称某个网页窗口一定在线。

如果目标 Web GPT 窗口没有持续执行 `agent_exchange`，它的 control request 最终会超时，聊天室显示错误后继续处理其他成员。

共享 broadcast 采用短时请求，默认保持 1.5 秒。对于已经在 `agent_exchange` 长轮询中的多个窗口，CWapi 会把同一个活动 request 重投给这些窗口。可以通过环境变量调整：

```text
CHAT_TEAM_BROADCAST_MS
CHAT_TEAM_CONTROL_TIMEOUT_MS
CHAT_TEAM_PORT
```

## 开发验证

```powershell
npm run check
npm test
```

测试覆盖：

- 只使用原版 `/v1/models` 和 `/v1/chat/completions`
- 用户正文只广播一次
- 每个 Web GPT 回复只广播一次
- 控制请求按成员 target 定向
- UTF-8 消息字节上限

## 安全边界

- 服务只监听 `127.0.0.1`
- CWapi 地址只允许 `localhost / 127.0.0.1 / ::1`
- Agent API Key 不写磁盘
- 不修改 CWapi 配置、源码或 Agent Broker
- 不使用文件或图片传输

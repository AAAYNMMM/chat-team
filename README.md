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

### 2. 同轮并发控制请求

chat-team 在每一轮把所有成员的 control **同时发出**：

```text
control -> target=GPT-A ┐
control -> target=GPT-B ├─ 同时在 flight
control -> target=GPT-C ┘
```

原版 CWapi 2.0.5 默认 `MaxInflight=4`，所以 chat-team 当前最多允许 4 个 Web GPT 成员。每个网页窗口一次 `agent_exchange` 可以看到这一批 control，只处理 target 与自己身份一致的 request；其他 request 不回复，也不在网页输出“不能抢答/等待”等提示，而是继续工具循环。

chat-team 等这一轮所有成员都返回后：

1. 分别把 GPT-A / GPT-B / GPT-C 的回复显示到聊天室；
2. 把本轮所有有效回复合并成 **一次** peer batch broadcast；
3. 所有 Web GPT 都能看到这一轮其他成员的发言；
4. 若还有下一轮，再同时发出下一批 control。

所以一次三人一轮讨论大致是：

```text
用户正文           × 1 broadcast
A/B/C 控制         × 3 并发小 control
A/B/C 回复正文     × 1 合并 broadcast
```

用户正文和每个 GPT 回复正文仍只进入共享广播一次，不会为每个窗口复制三份。

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
- Web GPT 成员名，例如 `GPT-A, GPT-B, GPT-C`，最多 4 个
- 每次讨论轮数，1～3 轮

API Key 只保存在当前 chat-team 服务进程内存中，不写入项目文件或浏览器存储。浏览器只保存地址、房间名、成员名和轮数。

## Web GPT 窗口

每个 Web GPT 窗口只需要绑定不同身份。界面会根据成员列表生成很短的启动提示词，例如：

```text
@MCPagent 你是 chat-team 房间“main”中的成员“GPT-A”。调用 agent_open 后持续 agent_exchange；聊天室规则会随第一条用户消息发送。除非我让你退出，否则不要在网页输出“等待/不能抢答/不是我的请求”等提示，只持续处理 MCP。
```

完整聊天室规则不再放进复制提示词。每次连接后的**第一条用户 broadcast** 会同时携带：

- chat-team 的完整 broadcast / control 处理规则；
- 当前房间和成员列表；
- 用户本次真实聊天正文。

规则只发送一次。之后的用户消息、Web GPT 回复 broadcast 和 control 都只携带必要正文或 target，不再重复整套规则。各 Web GPT 自己的 ChatGPT 对话上下文会继续保留此前看到的规则和共享消息，因此不需要 chat-team 每轮重发完整历史。

发送第一条用户消息前，应先让所有 Web GPT 窗口进入持续 `agent_exchange` 状态，否则尚未连接的窗口可能错过首次规则 broadcast。
## 讨论轮数

默认 1 轮：

```text
用户 -> [A / B / C 并发回答] -> 合并广播本轮回复 -> 等用户继续
```

2 轮时：

```text
用户 -> [A / B / C 第 1 轮] -> 合并广播 -> [A / B / C 第 2 轮] -> 合并广播 -> 等用户继续
```

同一轮成员彼此独立回答，不会因先后顺序“抢答”；从第 2 轮开始，每个成员都能看到上一轮全部成员的观点并继续回应。

用户选择几轮，就表示每个成员每轮都应实际发言。第 1 轮直接回答用户；第 2 轮起回应、质疑或补充上一轮其他成员观点，不再使用“无观点就跳过”的正常流程。

为兼容已经记住旧规则的网页窗口，chat-team 仍会识别旧的 `[[SKIP]]`：第一次返回空内容或 `[[SKIP]]` 时，会自动对该成员补发一次 recovery control。若补发仍失败，只记录该成员本轮错误，**不会阻止下一轮继续执行**。

## 可靠性边界

原版 CWapi 没有“聊天室成员在线状态”这一概念，所以 chat-team 只能显示配置成员及当前控制请求状态，不能声称某个网页窗口一定在线。

如果目标 Web GPT 窗口没有持续执行 `agent_exchange`，它的 control request 最终会超时，聊天室显示错误后继续处理其他成员。

共享 broadcast 采用短时请求，默认保持 4 秒。每轮成员 control 全部结束后，chat-team 默认先等待 600 ms，让刚提交 completion 的网页窗口重新进入 `agent_exchange`，再发送本轮合并 broadcast。这样比原来的 1.5 秒窗口更不容易漏掉上一轮共享回复。control 默认等待 45 秒；空回复或旧 `[[SKIP]]` 会自动补发一次。可以通过环境变量调整：

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

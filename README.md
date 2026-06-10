# Claude Traffic Light

VSCode 扩展，实时反映 Claude Code 对话状态。三种界面同时呈现：

- **状态栏圆点**：右下角彩色圆点
- **侧边栏面板**：活动栏新增一个 3D 红绿灯视图
- **独立小窗口**：可拖动可缩放的浮动窗口（150 × 450）

状态由 Claude Code 的 hook 事件驱动，零延迟。

## 状态映射

| 状态 | 颜色 | 触发时机 |
|------|------|---------|
| 空闲 | 🟢 绿 | 会话开始/结束 / 回合结束 / 空闲超时 |
| 工作中 | 🟡 黄 | 用户提问 / 工具调用 / 子代理运行 |
| 等你处理 | 🔴 红 | 权限请求 / `Notification` / 等用户输入（含 `AskUserQuestion`、`ExitPlanMode`） |

权限弹窗通常没有 hook 触发。扩展用启发式补位：`PreToolUse` 后 N 秒未收到 `PostToolUse` 即判定卡在权限等待，灯转红。N 由 `claudeTrafficLight.permissionWaitSeconds` 控制。

## 工作原理

```
Claude Code hook ──curl POST──▶ localhost:8080/api/v1/event ──▶ 扩展
                                                                  │
                                          ┌───────────────────────┼───────────────────────┐
                                          ▼                       ▼                       ▼
                                     状态栏圆点              侧边栏 webview         独立 Electron 窗口
```

扩展在本地 `127.0.0.1:8080` 起一个 HTTP 服务，接收 Claude Code hook 事件。同一个端口还提供：
- `GET /__status` — 拉取当前状态（独立窗口启动时一次拉取）
- `GET /__events` — Server-Sent Events 流，状态变化实时推送给独立窗口
- `GET /__id`、`POST /__yield` — 多窗口选举使用（见下文）

## 安装

从 vsix 安装：

```
code --install-extension claude-traffic-light-0.6.0.vsix
```

或在 VSCode 命令面板：`Extensions: Install from VSIX...`。

## 配置 Claude Code Hook

在 `~/.claude/settings.json` 中为想反映状态的事件挂上 hook：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "p=$(cat); curl -s -m 1 -X POST http://localhost:8080/api/v1/event -H 'Content-Type: application/json' -d \"$p\""
          }
        ]
      }
    ]
  }
}
```

把同样的 hook 块复制给以下事件：`SessionStart`、`SessionEnd`、`Stop`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`SubagentStop`、`Notification`。

`p=$(cat)` 把 hook 的完整 stdin payload 透传过来——里面带有 `tool_name` 等字段，扩展据此识别 `AskUserQuestion` 等"等待用户"工具，把灯切红。

## 设置

| 设置 | 默认 | 说明 |
|------|------|------|
| `claudeTrafficLight.port` | `8080` | 接收 hook 事件的本地端口 |
| `claudeTrafficLight.idleResetSeconds` | `0` | 空闲多少秒后自动回绿灯（`0` = 禁用）。仅 server 角色生效，避免多窗口竞写 |
| `claudeTrafficLight.permissionWaitSeconds` | `1` | `PreToolUse` 后多少秒未收到 `PostToolUse` 即判定等待权限，灯转红（`0` = 禁用此启发式） |
| `claudeTrafficLight.standaloneWindow.enabled` | `true` | 是否启用独立小窗口 |
| `claudeTrafficLight.standaloneWindow.alwaysOnTop` | `true` | 独立窗口启动时是否置顶。运行时可点窗口右上角图钉切换 |
| `claudeTrafficLight.standaloneWindow.display` | `""` | X server 的 DISPLAY，例如 `10.0.0.1:0`。留空继承 extension host 的 `DISPLAY`。仅 Linux/远程容器场景需要 |
| `claudeTrafficLight.standaloneWindow.electronDistOverride` | `""` | 指向另一份 Electron `dist/` 目录。用于扩展安装在不可执行二进制的网络文件系统（如 yrfs）时，把 dist 副本放到本地盘。环境变量 `CLAUDE_TRAFFIC_LIGHT_ELECTRON_DIST` 优先级更高 |

## 命令

- `Claude Traffic Light: 开关服务` — 在 server / client 之间切换
- `Claude Traffic Light: 查看状态` — 显示当前状态、端口、角色

## 独立小窗口

启用后，扩展在 server 角色下 spawn 一个 Electron 子进程：

- 大小 150 × 450，可缩放，最小 80 × 240
- 默认位置：主显示器左上角；拖动/缩放后写入 `~/.claude-traffic-light-window.json`，下次恢复
- 右上角两个按钮：图钉（切换置顶）、× （关闭窗口；状态栏和侧边栏继续工作）
- 透明无边框，整个灯壳是拖动区

> **Linux + X11 转发场景**：如果在远程容器里跑扩展、X 显示推到本机的 XQuartz / VcXsrv 这类 X server，`alwaysOnTop` 由本机窗口管理器决定是否生效，可能压不住宿主原生窗口。这是 X11 转发的固有限制。

## 多 VSCode 窗口

只有一个窗口能绑 `8080`，所以多窗口之间需要协调：

- **server**：绑住端口的窗口，直接接收 hook 事件，把状态写到 `os.tmpdir()/claude-traffic-light-state.json`，并通过 SSE 推送给独立窗口
- **client**：监听共享文件，被动跟随 server

新窗口激活时主动发 `POST /__yield` 让现任 server 让位——保证"最近 reload 的窗口"成为 server，不需要手动清理僵尸进程。独立窗口随 server 走：旧 server 让位时关掉自己的窗口，新 server 起一个新的。

如果 8080 被本扩展之外的程序占用，扩展会弹一次性提示，并继续以 client 模式工作（通过共享文件同步状态）。

## 开发

```bash
npm install
npm run compile           # 一次性编译
npm run watch             # 增量编译
npx vsce package          # 打成 vsix
```

按 `F5` 启动 Extension Development Host 调试。`.vscode/launch.json` 已配好 `CLAUDE_TRAFFIC_LIGHT_ELECTRON_DIST` 环境变量，应对扩展工作目录在网络文件系统上跑不动 Electron 二进制的情况。

## 开源协议

MIT

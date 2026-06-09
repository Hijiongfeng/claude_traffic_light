# Claude Traffic Light

VSCode 状态栏红绿灯，实时反映 Claude Code 对话状态。装上即用，零延迟。

## 效果

状态栏右侧出现一个圆点，随对话状态变色：

| 状态 | 圆点 | 触发时机 |
|------|------|----------|
| 🟢 空闲 | 绿 | 会话开始或结束 / 回合结束 / 空闲 |
| 🟡 工作中 | 黄 | 你提问 / 调用工具 / 子代理运行 |
| 🔴 等你处理 | 红 | 请求权限 / 等你输入(问你问题) |

## 工作原理

插件激活时在本地 `127.0.0.1:8080` 起一个 HTTP 服务，接收 Claude Code 的 hook 事件并更新状态栏圆点。

```
Claude Code hook → curl POST localhost:8080 → 插件 → 状态栏圆点变色
```

## 配置 Claude Code Hook

在 `~/.claude/settings.json` 的 `hooks` 字段中，为每个事件配置 HTTP 回调：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 1 -X POST http://localhost:8080/api/v1/event -H 'Content-Type: application/json' -d '{\"event\":\"UserPromptSubmit\"}'"
          }
        ]
      }
    ]
  }
}
```

可配置的事件：`SessionStart` `SessionEnd` `Stop` `UserPromptSubmit` `PreToolUse` `PostToolUse` `SubagentStop` `Notification`

## 设置项

| 设置 | 默认 | 说明 |
|------|------|------|
| `claudeTrafficLight.port` | 8080 | 接收 hook 事件的本地端口 |
| `claudeTrafficLight.idleResetSeconds` | 0 | 空闲多少秒后自动回绿灯（0 = 禁用） |

## 命令

- `Claude Traffic Light: 开关服务` — 启停 HTTP 服务
- `Claude Traffic Light: 查看状态` — 显示当前状态和端口

## 开源协议

MIT

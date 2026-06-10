import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

/** 灯的状态定义 */
type LightState = 'idle' | 'busy' | 'error';

interface LightStyle {
  icon: string;        // 状态栏圆点
  color: string;       // 主题颜色 ID
  text: string;        // 提示文字
}

const STYLES: Record<LightState, LightStyle> = {
  idle:  { icon: '$(circle-filled)', color: 'charts.green',  text: '空闲' },
  busy:  { icon: '$(circle-filled)', color: 'charts.yellow', text: '工作中' },
  error: { icon: '$(circle-filled)', color: 'charts.red',    text: '等你处理' },
};

/**
 * Claude Code 事件 → 灯状态 的映射(均为 Claude Code 真实的 hook 事件名)
 *
 * 黄(busy): PostToolUse 表示"一次工具调用结束",但此时整个回合可能还没结束
 *   (还要调下一个工具/继续组织回复),所以它仍是 busy。SubagentStop 同理,
 *   子代理结束后主回合通常还在继续,保持 busy。
 * 绿(idle): 只有 Stop(整个回合结束) / 会话边界才回到 idle。配合 idleResetSeconds
 *   兜底,即使 Stop 偶尔没触发,黄灯也会在无活动后自动回绿。
 * 红(error): Notification 是 Claude 在"等你"的时机——请求工具权限,或长时间
 *   等待你输入。即"问你问题/需要你处理"。Claude Code 没有专门的报错 hook,
 *   真正的错误通常以权限请求或停滞的形式经由 Notification 体现。
 *   AskUserQuestion 工具调用同样属于"等你回答",也走红灯;它经 PreToolUse 触发,
 *   需要看 tool_name 来识别(见 handleEvent)。
 */
const EVENT_MAP: Record<string, LightState> = {
  SessionStart:     'idle',
  SessionEnd:       'idle',
  Stop:             'idle',
  UserPromptSubmit: 'busy',
  PreToolUse:       'busy',
  PostToolUse:      'busy',
  SubagentStop:     'busy',
  Notification:     'error',
};

/** 这些工具一旦 PreToolUse 触发就视为"等用户输入",直接红灯 */
const USER_INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** 标识本插件身份,用于探测端口占用者是不是我们自己 */
const APP_ID = 'claude-traffic-light';
/** 多窗口共享的状态文件 */
const STATE_FILE = path.join(os.tmpdir(), 'claude-traffic-light-state.json');

let statusBarItem: vscode.StatusBarItem;
let server: http.Server | undefined;
let currentState: LightState = 'idle';
let idleTimer: NodeJS.Timeout | undefined;
let reelectTimer: NodeJS.Timeout | undefined;
/** PreToolUse 后等 PostToolUse 的超时计时器:超时则判定在等权限,转红灯 */
let permissionWaitTimer: NodeJS.Timeout | undefined;
let stateWatcher: fs.FSWatcher | undefined;
let output: vscode.OutputChannel;
let role: 'server' | 'client' | 'none' = 'none';
let conflictReported = false;
let trafficLightProvider: TrafficLightViewProvider;
/** 已连接的 SSE 客户端响应对象,用于推送状态变更 */
let sseClients: Set<http.ServerResponse> = new Set();
/** Electron 独立窗口子进程,只在 server 角色下存活 */
let standaloneProc: ChildProcess | undefined;
/** 扩展安装路径,spawn Electron 子进程时拼路径用 */
let extensionPath: string = '';

class TrafficLightViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(currentState);
  }

  updateState(state: LightState) {
    this.view?.webview.postMessage({ state });
  }

  private getHtml(state: LightState): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  display: flex; justify-content: center; align-items: center;
  min-height: 100vh; background: #0d0d0d;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.traffic-light {
  display: flex; flex-direction: column; align-items: center;
  padding: 32px 24px;
  border-radius: 48px;
  background:
    linear-gradient(135deg, #2b3137 0%, #1e2228 30%, #151719 70%, #0f1113 100%);
  box-shadow:
    0 30px 80px rgba(0,0,0,0.9),
    inset 0 2px 4px rgba(255,255,255,0.08),
    inset 0 -4px 12px rgba(0,0,0,0.6);
  border: 4px solid #242930;
  gap: 28px;
  width: min(85%, 140px);
  position: relative;
}
.traffic-light::before {
  content: '';
  position: absolute;
  top: 12px; left: 50%;
  transform: translateX(-50%);
  width: 40%;
  height: 8px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
  border-radius: 4px;
  box-shadow: 0 1px 2px rgba(255,255,255,0.05);
}
.light-container {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, #1a1d21 0%, #0d0f11 70%);
  box-shadow:
    inset 0 6px 12px rgba(0,0,0,0.8),
    inset 0 -2px 4px rgba(255,255,255,0.02);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12%;
}
.light {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  position: relative;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  background: #0a0a0a;
  box-shadow:
    inset 0 4px 10px rgba(0,0,0,0.9),
    inset 0 -2px 6px rgba(255,255,255,0.03),
    0 2px 4px rgba(0,0,0,0.5);
}
/* 玻璃反光层 */
.light::before {
  content: '';
  position: absolute;
  top: 8%;
  left: 15%;
  width: 45%;
  height: 45%;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 40%,
    rgba(255,255,255,0.6) 0%,
    rgba(255,255,255,0.3) 30%,
    transparent 70%);
  opacity: 0;
  transition: opacity 0.4s ease;
  filter: blur(1px);
}
.light.active::before { opacity: 1; }

/* 外层光晕 */
.light::after {
  content: '';
  position: absolute;
  top: -40%;
  left: -40%;
  width: 180%;
  height: 180%;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.4s ease;
  pointer-events: none;
}

.light.red.active {
  background:
    radial-gradient(circle at 45% 40%,
      #ff5555 0%,
      #ff3333 15%,
      #ee1111 35%,
      #cc0000 60%,
      #880000 85%,
      #440000 100%);
  box-shadow:
    0 0 40px rgba(255,51,51,0.8),
    0 0 80px rgba(255,51,51,0.4),
    inset 0 -4px 12px rgba(0,0,0,0.5),
    inset 0 2px 6px rgba(255,85,85,0.6);
}
.light.red.active::after {
  opacity: 1;
  background: radial-gradient(circle,
    rgba(255,51,51,0.4) 0%,
    rgba(255,51,51,0.2) 30%,
    rgba(255,51,51,0.05) 60%,
    transparent 100%);
}

.light.yellow.active {
  background:
    radial-gradient(circle at 45% 40%,
      #ffee44 0%,
      #ffdd22 15%,
      #ffcc00 35%,
      #dd9900 60%,
      #996600 85%,
      #553300 100%);
  box-shadow:
    0 0 40px rgba(255,221,34,0.9),
    0 0 80px rgba(255,221,34,0.5),
    inset 0 -4px 12px rgba(0,0,0,0.5),
    inset 0 2px 6px rgba(255,238,68,0.7);
}
.light.yellow.active::after {
  opacity: 1;
  background: radial-gradient(circle,
    rgba(255,221,34,0.5) 0%,
    rgba(255,221,34,0.25) 30%,
    rgba(255,221,34,0.08) 60%,
    transparent 100%);
}

.light.green.active {
  background:
    radial-gradient(circle at 45% 40%,
      #44ff88 0%,
      #22ff66 15%,
      #00ee44 35%,
      #00bb33 60%,
      #007722 85%,
      #003311 100%);
  box-shadow:
    0 0 40px rgba(34,255,102,0.9),
    0 0 80px rgba(34,255,102,0.5),
    inset 0 -4px 12px rgba(0,0,0,0.5),
    inset 0 2px 6px rgba(68,255,136,0.7);
}
.light.green.active::after {
  opacity: 1;
  background: radial-gradient(circle,
    rgba(34,255,102,0.5) 0%,
    rgba(34,255,102,0.25) 30%,
    rgba(34,255,102,0.08) 60%,
    transparent 100%);
}

.light:not(.active) {
  background:
    radial-gradient(circle at 45% 40%,
      #2a2a2a 0%,
      #1a1a1a 40%,
      #0d0d0d 100%);
  opacity: 0.25;
  box-shadow: inset 0 4px 10px rgba(0,0,0,0.95);
}
.label {
  margin-top: 8px;
  color: #6b7280;
  font-size: 9px;
  text-align: center;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  font-weight: 700;
  text-shadow: 0 1px 3px rgba(0,0,0,0.9);
  opacity: 0.8;
}
</style></head>
<body>
<div class="traffic-light">
  <div class="light-container">
    <div class="light red" id="red"></div>
  </div>
  <div class="light-container">
    <div class="light yellow" id="yellow"></div>
  </div>
  <div class="light-container">
    <div class="light green" id="green"></div>
  </div>
  <div class="label" id="label"></div>
</div>
<script>
const stateMap = {
  idle:  { light: 'green',  label: 'Ready' },
  busy:  { light: 'yellow', label: 'Working' },
  error: { light: 'red',    label: 'Waiting' }
};
function setState(s) {
  const cfg = stateMap[s] || stateMap.idle;
  document.querySelectorAll('.light').forEach(el => el.classList.remove('active'));
  document.getElementById(cfg.light).classList.add('active');
  document.getElementById('label').textContent = cfg.label;
}
setState('${state}');
window.addEventListener('message', e => { if (e.data.state) setState(e.data.state); });
</script>
</body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Claude Traffic Light');
  extensionPath = context.extensionPath;

  trafficLightProvider = new TrafficLightViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeTrafficLight.panel', trafficLightProvider)
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeTrafficLight.showStatus';
  context.subscriptions.push(statusBarItem);
  applyState('idle');
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTrafficLight.showStatus', () => {
      const port = getPort();
      const roleText = role === 'server' ? '服务端(占用端口)' : role === 'client' ? '客户端(文件同步)' : '未连接';
      vscode.window.showInformationMessage(
        `Claude Traffic Light: ${STYLES[currentState].text} | 端口 ${port} | 角色: ${roleText}`
      );
    }),
    vscode.commands.registerCommand('claudeTrafficLight.toggle', () => {
      if (server) {
        stopServer();
        vscode.window.showInformationMessage('Claude Traffic Light: 已停止服务,转为客户端模式');
        startClient();
      } else {
        tryBecomeServer(true);
      }
    })
  );

  // 启动:先看共享文件里有没有现成状态,再尝试抢占端口
  readSharedState();
  startClient();           // 所有窗口都监听共享文件
  tryBecomeServer(true);   // 激活时主动抢占:若是本插件其他实例占着,顶替它
}

export function deactivate() {
  stopServer();
  stopClient();
  if (reelectTimer) clearTimeout(reelectTimer);
  if (idleTimer) clearTimeout(idleTimer);
  if (permissionWaitTimer) clearTimeout(permissionWaitTimer);
  stopStandaloneWindow();
}

function getPort(): number {
  return vscode.workspace.getConfiguration('claudeTrafficLight').get<number>('port', 8080);
}

/** 更新状态栏显示(不写文件) */
function applyState(state: LightState) {
  currentState = state;
  const style = STYLES[state];
  statusBarItem.text = `${style.icon} Claude`;
  statusBarItem.color = new vscode.ThemeColor(style.color);
  statusBarItem.tooltip = `Claude 状态: ${style.text}`;
  trafficLightProvider?.updateState(state);

  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  // idle 兜底只由 server 负责:client 跟随 server 的广播即可,
  // 否则每个窗口都各自倒计时写文件,会形成多窗口竞写互相覆盖。
  const resetSec = vscode.workspace
    .getConfiguration('claudeTrafficLight')
    .get<number>('idleResetSeconds', 0);
  if (resetSec > 0 && state !== 'idle' && role === 'server') {
    idleTimer = setTimeout(() => setStateAndBroadcast('idle'), resetSec * 1000);
  }
}

/** 服务端收到事件:更新自己 + 写共享文件广播给其他窗口 */
function setStateAndBroadcast(state: LightState) {
  applyState(state);
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ state, ts: Date.now() }));
  } catch (e) {
    output.appendLine(`写共享状态失败: ${e}`);
  }
  pushSse({ state });
}

/** 把一帧数据写给所有 SSE 客户端;失败的连接顺手清理掉 */
function pushSse(data: unknown) {
  if (sseClients.size === 0) return;
  const frame = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(sseClients)) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
      try { res.end(); } catch { /* ignore */ }
    }
  }
}

/** 关掉所有 SSE 长连接(server 让位/停服时调用) */
function closeAllSseClients() {
  for (const res of Array.from(sseClients)) {
    try { res.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
}

/** 客户端/启动时:从共享文件读当前状态 */
function readSharedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.state && STYLES[data.state as LightState]) {
        applyState(data.state);
      }
    }
  } catch { /* 忽略 */ }
}

function handleEvent(payload: any) {
  const eventName = payload?.hook_event_name ?? payload?.event;
  if (typeof eventName !== 'string') {
    output.appendLine(`[${new Date().toLocaleTimeString()}] 收到无效 payload`);
    return;
  }
  let state = EVENT_MAP[eventName];
  // PreToolUse + 等用户输入类工具 → 直接红灯
  // (这类工具的 PostToolUse 由通用 PreToolUse→busy 自然回到黄灯,符合"用户答完继续工作"的语义)
  if (eventName === 'PreToolUse' && typeof payload.tool_name === 'string' && USER_INPUT_TOOLS.has(payload.tool_name)) {
    state = 'error';
  }
  const detail = payload.tool_name ? ` (${payload.tool_name})` : '';
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${eventName}${detail} → ${state ?? '(未映射)'}`);
  if (state) setStateAndBroadcast(state);

  // 权限弹窗启发式:Kiro IDE 等环境的"Allow this bash command?"弹窗不触发任何 hook,
  // 但表现为 PreToolUse 之后迟迟不来 PostToolUse。借此推断"卡在权限等待":
  // PreToolUse 启动计时器,N 秒内若 PostToolUse 没来则切红灯;
  // PostToolUse 到了就取消计时器。USER_INPUT_TOOLS 已经直接红了,无需再走这里。
  if (permissionWaitTimer) { clearTimeout(permissionWaitTimer); permissionWaitTimer = undefined; }
  if (eventName === 'PreToolUse' && state === 'busy') {
    const waitSec = vscode.workspace
      .getConfiguration('claudeTrafficLight')
      .get<number>('permissionWaitSeconds', 3);
    if (waitSec > 0) {
      permissionWaitTimer = setTimeout(() => {
        permissionWaitTimer = undefined;
        // 只有还停留在 busy 才升级为 error;若中途已经变成 idle/error 就不动
        if (currentState === 'busy') setStateAndBroadcast('error');
      }, waitSec * 1000);
    }
  }
}

/** 客户端模式:监听共享文件变化,跟随服务端更新状态栏 */
function startClient() {
  stopClient();
  if (role !== 'server') role = 'client';
  try {
    if (!fs.existsSync(STATE_FILE)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ state: currentState, ts: Date.now() }));
    }
    stateWatcher = fs.watch(STATE_FILE, () => readSharedState());
    output.appendLine('客户端模式: 正在监听共享状态文件');
  } catch (e) {
    output.appendLine(`监听共享文件失败: ${e}`);
  }
}

function stopClient() {
  if (stateWatcher) { stateWatcher.close(); stateWatcher = undefined; }
}

/**
 * 尝试抢占端口当服务端。
 * - 抢到 → server 角色,直接收 hook 事件
 * - 端口被占 → 探测占用者是不是本插件:
 *     是 → 若 aggressive=true(刚激活/用户主动 toggle),发送 /__yield 顶替对方;
 *          否则(后台轮询竞选)安静当 client,等对方自然退出。
 *     否 → 报错提示用户
 */
function tryBecomeServer(aggressive = false) {
  const port = getPort();
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__id') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: APP_ID }));
      return;
    }
    // 独立窗口启动时拉一次当前状态,避免黑屏等首个事件
    if (req.method === 'GET' && req.url === '/__status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: currentState }));
      return;
    }
    // SSE 长连接:state 变化时由 pushSse 推送给所有订阅者
    if (req.method === 'GET' && req.url === '/__events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ state: currentState })}\n\n`);
      sseClients.add(res);
      const cleanup = () => { sseClients.delete(res); };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }
    // 让位:收到此请求的 server 主动释放端口,给新激活的实例。
    // 设计意图:让"最近 reload 的窗口"成为 server,无需用户手动清理僵尸进程。
    if (req.method === 'POST' && req.url === '/__yield') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'yielding' }));
      output.appendLine('收到 /__yield 请求,让位给新实例');
      stopServer();
      startClient();
      // 让位后也调度一次回选:万一发起 yield 的实例自己崩了/没绑成,本窗口能再接管。
      scheduleReelection(5000);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/event') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const eventName = data?.hook_event_name ?? data?.event;
          if (typeof eventName === 'string') {
            handleEvent(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', event: eventName }));
            return;
          }
        } catch (e) {
          output.appendLine(`解析失败: ${e}`);
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error' }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      probeOccupant(port, aggressive);
    } else {
      vscode.window.showErrorMessage(`Claude Traffic Light: 服务出错 ${err.message}`);
    }
  });

  srv.listen(port, '127.0.0.1', () => {
    server = srv;
    role = 'server';
    stopClient();
    conflictReported = false;
    if (reelectTimer) { clearTimeout(reelectTimer); reelectTimer = undefined; }
    // 刚从 client 升为 server:若当前是非 idle 态,补注册一次 idle 兜底
    // (client 角色时 applyState 不会注册,见 applyState 内的 role 判断)。
    applyState(currentState);
    output.appendLine(`服务端模式: http://127.0.0.1:${port}/api/v1/event`);
    startStandaloneWindow();
  });
}

/** 探测端口占用者是否为本插件的另一个实例 */
function probeOccupant(port: number, aggressive: boolean) {
  const req = http.get({ host: '127.0.0.1', port, path: '/__id', timeout: 1500 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.app === APP_ID) {
          conflictReported = false;
          if (aggressive) {
            // 让现任 server 主动让位,然后重试绑定
            output.appendLine('端口被本插件另一窗口占用,发送 /__yield 顶替');
            yieldOccupantAndRetake(port);
          } else {
            role = 'client';
            startClient();
            // 占端口的是本插件的另一个窗口。安静当 client,但定期回头竞选:
            // 一旦那个 server 窗口关闭、端口释放,本窗口就能接管,hook 不中断。
            scheduleReelection(5000);
            output.appendLine('端口已被本插件的另一个窗口占用,本窗口转为客户端(文件同步),指示灯正常工作');
          }
          return;
        }
      } catch { /* 落到下面报错 */ }
      reportPortConflict(port);
    });
  });
  req.on('error', () => reportPortConflict(port));
  req.on('timeout', () => { req.destroy(); reportPortConflict(port); });
}

/** 让现任 server 让位,等端口释放后重新尝试绑定 */
function yieldOccupantAndRetake(port: number) {
  const req = http.request({
    host: '127.0.0.1', port, path: '/__yield',
    method: 'POST', timeout: 1500,
  }, (res) => {
    res.on('data', () => {/* drain */});
    res.on('end', () => {
      // 给对方一点时间真正关闭 socket,再重试绑定
      setTimeout(() => tryBecomeServer(false), 300);
    });
  });
  req.on('error', () => {
    // 老版本可能没有 /__yield 端点;退回到普通客户端 + 慢轮询
    output.appendLine('对方不响应 /__yield(可能是旧版本),退回客户端模式');
    role = 'client';
    startClient();
    scheduleReelection(5000);
  });
  req.on('timeout', () => {
    req.destroy();
    role = 'client';
    startClient();
    scheduleReelection(5000);
  });
  req.end();
}

/** 端口被非本插件的程序占用 → 报错(仅一次),并定期重试 */
function reportPortConflict(port: number) {
  output.appendLine(`端口 ${port} 被其他程序占用`);
  // 只在首次冲突时弹窗,避免周期性重试反复打扰用户。
  if (!conflictReported) {
    conflictReported = true;
    vscode.window.showErrorMessage(
      `Claude Traffic Light: 端口 ${port} 被其他程序占用。指示灯仍会通过文件同步显示,但本窗口无法直接接收 hook。可在设置改 claudeTrafficLight.port 或关掉占用程序。`
    );
  }
  role = 'client';
  startClient();
  scheduleReelection(30000);
}

/** 安排在 delay 毫秒后重新尝试抢占端口(仅 client 角色需要) */
function scheduleReelection(delay: number) {
  if (reelectTimer) clearTimeout(reelectTimer);
  reelectTimer = setTimeout(() => {
    reelectTimer = undefined;
    if (role !== 'server') tryBecomeServer();
  }, delay);
}

function stopServer() {
  if (server) {
    server.close();
    server = undefined;
    role = 'none';
    output.appendLine('服务端已停止');
  }
  closeAllSseClients();
  stopStandaloneWindow();
}

/** spawn Electron 子进程显示独立红绿灯窗口(仅 server 角色调用) */
function startStandaloneWindow() {
  if (standaloneProc) return; // already running
  const cfg = vscode.workspace.getConfiguration('claudeTrafficLight');
  if (!cfg.get<boolean>('standaloneWindow.enabled', true)) return;
  const alwaysOnTop = cfg.get<boolean>('standaloneWindow.alwaysOnTop', true);
  const port = getPort();

  let electronBin: string;
  // dist override 优先级:环境变量 > 配置项。两者都可以指向另一份 dist,
  // 适配 extension 装在不能 mmap 二进制的网络/特殊文件系统(如 yrfs)上时,
  // 把 dist 副本放到 overlay 盘。
  const distOverride = process.env.CLAUDE_TRAFFIC_LIGHT_ELECTRON_DIST
    || cfg.get<string>('standaloneWindow.electronDistOverride', '');
  if (distOverride && fs.existsSync(path.join(distOverride, 'electron'))) {
    electronBin = path.join(distOverride, 'electron');
  } else {
    try {
      // electron 包默认导出二进制路径
      electronBin = require(path.join(extensionPath, 'node_modules', 'electron')) as string;
    } catch (e) {
      output.appendLine(`无法定位 Electron 二进制: ${e}`);
      return;
    }
  }
  const mainJs = path.join(extensionPath, 'standalone', 'main.js');
  if (!fs.existsSync(mainJs)) {
    output.appendLine(`找不到 standalone 入口: ${mainJs}`);
    return;
  }
  if (!fs.existsSync(electronBin)) {
    output.appendLine(`Electron 二进制不存在: ${electronBin}`);
    return;
  }

  // 远程容器里 Electron 渲染要把窗口推到用户本机的 X server。
  // 优先用配置项;留空则继承 extension host 自己的 DISPLAY。
  const configuredDisplay = cfg.get<string>('standaloneWindow.display', '').trim();
  const display = configuredDisplay || process.env.DISPLAY || '';
  // root 用户跑 Chromium 默认会被拒,容器里也没有合适的 GPU,统统关掉
  const args = [
    mainJs,
    `--port=${port}`,
    `--alwaysOnTop=${alwaysOnTop ? 'true' : 'false'}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
  ];
  try {
    // VSCode/Claude Code 的进程环境里常常带着 ELECTRON_RUN_AS_NODE=1(因为 vscode 自己用 electron),
    // 直接透传给子进程会让 Electron 退化成 Node 模式,require('electron') 失效。
    // 这里要显式删掉,让子进程进入正经的 Electron 主进程模式。
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    if (display) childEnv.DISPLAY = display;
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.NODE_OPTIONS;

    const proc = spawn(electronBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: childEnv,
    });
    proc.stdout?.on('data', (d) => output.appendLine(`[standalone] ${String(d).trimEnd()}`));
    proc.stderr?.on('data', (d) => output.appendLine(`[standalone:err] ${String(d).trimEnd()}`));
    proc.on('exit', (code, signal) => {
      output.appendLine(`独立窗口进程退出 code=${code} signal=${signal}`);
      if (standaloneProc === proc) standaloneProc = undefined;
    });
    standaloneProc = proc;
    output.appendLine('独立窗口已启动');
  } catch (e) {
    output.appendLine(`启动独立窗口失败: ${e}`);
  }
}

/** 让独立窗口子进程退出。先 SIGTERM,1 秒后兜底 SIGKILL */
function stopStandaloneWindow() {
  const proc = standaloneProc;
  if (!proc) return;
  standaloneProc = undefined;
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 1000);
}

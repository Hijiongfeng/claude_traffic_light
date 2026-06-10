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
/** 是否已对 STATE_FILE 启用了 fs.watchFile 轮询,用于 stopClient 时正确取消 */
let stateWatching = false;
/** 服务端最近一次写共享文件的时间戳。watchFile 回调据此过滤"自己刚写"的事件,
 *  作为 stopClient 之外的兜底,防止 server 角色短暂残留 watcher 时自触发。*/
let lastSelfWriteTs = 0;
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

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      // 锁定 webview 能访问的本地资源到 media/,防止以后误引入路径越权读取扩展其他文件
      localResourceRoots: [mediaRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, currentState);
  }

  updateState(state: LightState) {
    this.view?.webview.postMessage({ state });
  }

  private getHtml(webview: vscode.Webview, state: LightState): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'traffic-light-base.css')
    );
    // CSP nonce 给页内 <script> 用,style-src 必须含 'unsafe-inline'(下方还有局部样式块)
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
<link rel="stylesheet" href="${cssUri}">
<style>
/* 侧边栏特有的发光半径(尺寸更大) */
:root {
  --glow-near: 40px;
  --glow-far: 80px;
  --container-padding: 12%;
}
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
<script nonce="${nonce}">
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

/** 给 CSP 用的随机 nonce,32 字符 base64-ish */
function makeNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Claude Traffic Light');
  extensionPath = context.extensionPath;

  trafficLightProvider = new TrafficLightViewProvider(context.extensionUri);
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

/**
 * 统一日志出口。important=true 的消息(角色切换、服务启停、错误)总是输出;
 * 其余的"逐事件"日志只有在 claudeTrafficLight.verbose 开启时才打,
 * 避免连续 PostToolUse 等高频 hook 把输出面板刷爆。
 */
function logLine(msg: string, important = false) {
  if (!important) {
    const verbose = vscode.workspace
      .getConfiguration('claudeTrafficLight')
      .get<boolean>('verbose', false);
    if (!verbose) return;
  }
  output.appendLine(msg);
}

/** 更新状态栏显示(不写文件) */
function applyState(state: LightState) {
  currentState = state;
  const style = STYLES[state];
  statusBarItem.text = `${style.icon} Claude`;
  statusBarItem.color = new vscode.ThemeColor(style.color);
  statusBarItem.tooltip = `Claude 状态: ${style.text}`;
  trafficLightProvider?.updateState(state);

  armIdleTimerIfServer();
}

/**
 * 按当前状态(重新)安排 idle 兜底倒计时。
 * 只有 server 角色才倒计时:client 跟随 server 的广播即可,否则每个窗口各自
 * 倒计时写文件,会形成多窗口竞写互相覆盖。
 * 每次调用都会先清掉旧计时器,所以可以安全地重复调用——applyState 每次状态变化时
 * 调一次,client 升格为 server 时也显式再调一次补注册。
 */
function armIdleTimerIfServer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  if (role !== 'server' || currentState === 'idle') return;
  const resetSec = vscode.workspace
    .getConfiguration('claudeTrafficLight')
    .get<number>('idleResetSeconds', 0);
  if (resetSec > 0) {
    idleTimer = setTimeout(() => setStateAndBroadcast('idle'), resetSec * 1000);
  }
}

/** 服务端收到事件:更新自己 + 写共享文件广播给其他窗口 */
function setStateAndBroadcast(state: LightState) {
  applyState(state);
  // 原子写:先写到同目录的临时文件,再 rename 覆盖。
  // 同分区内 rename 是原子的,客户端读到的永远是完整 JSON,
  // 多窗口并发写也只是"最后一个赢",不会交错出半截内容。
  const ts = Date.now();
  lastSelfWriteTs = ts;
  // pid 进临时名,避免本进程与其他进程的临时文件互相覆盖
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ state, ts }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    logLine(`写共享状态失败: ${e}`, true);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
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

/** 客户端/启动时:从共享文件读当前状态并应用 */
function readSharedState() {
  const parsed = readSharedStateRaw();
  if (parsed && parsed.state) applyState(parsed.state);
}

/** 只读不应用,返回 { state, ts } 或 null。watchFile 回调用这版本以便先比 ts。*/
function readSharedStateRaw(): { state: LightState; ts: number } | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data.state && STYLES[data.state as LightState]) {
      return { state: data.state as LightState, ts: typeof data.ts === 'number' ? data.ts : 0 };
    }
  } catch { /* JSON 半截/被替换中,等下一次回调 */ }
  return null;
}

function handleEvent(payload: any) {
  const eventName = payload?.hook_event_name ?? payload?.event;
  if (typeof eventName !== 'string') {
    logLine(`[${new Date().toLocaleTimeString()}] 收到无效 payload`);
    return;
  }
  let state = EVENT_MAP[eventName];
  // PreToolUse + 等用户输入类工具 → 直接红灯
  // (这类工具的 PostToolUse 由通用 PreToolUse→busy 自然回到黄灯,符合"用户答完继续工作"的语义)
  if (eventName === 'PreToolUse' && typeof payload.tool_name === 'string' && USER_INPUT_TOOLS.has(payload.tool_name)) {
    state = 'error';
  }
  const detail = payload.tool_name ? ` (${payload.tool_name})` : '';
  logLine(`[${new Date().toLocaleTimeString()}] ${eventName}${detail} → ${state ?? '(未映射)'}`);
  if (state) setStateAndBroadcast(state);

  // 权限弹窗启发式:Kiro IDE 等环境的"Allow this bash command?"弹窗不触发任何 hook,
  // 但表现为 PreToolUse 之后迟迟不来 PostToolUse。借此推断"卡在权限等待":
  // PreToolUse 启动计时器,N 秒内若 PostToolUse 没来则切红灯;
  // PostToolUse 到了就取消计时器。
  if (permissionWaitTimer) { clearTimeout(permissionWaitTimer); permissionWaitTimer = undefined; }
  // 注意 state === 'busy' 这个条件:USER_INPUT_TOOLS(AskUserQuestion/ExitPlanMode)
  // 在上面已经被改成 'error',所以不会进这里——它们本就是"等用户",不需要再靠超时推断。
  // 只有普通工具(state 仍为 busy)才需要这个"迟迟没 PostToolUse → 可能卡在权限弹窗"的兜底。
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

/** 客户端模式:监听共享文件变化,跟随服务端更新状态栏。
 *  server 角色不需要(也不应该)监听:自己写自己读会让 idleTimer 等副作用反复重置。
 *  用 fs.watchFile 而不是 fs.watch:Linux 上 fs.watch 在文件被 rename 替换后会失效,
 *  且经常丢事件;轮询虽多耗一点点 CPU,但跨平台稳定。*/
function startClient() {
  stopClient();
  if (role !== 'server') role = 'client';
  if (role === 'server') return; // 防御:server 不该走到这里
  try {
    if (!fs.existsSync(STATE_FILE)) {
      // 首次启动,直接写一份初始状态。这一次也算"自己写",记下 ts。
      const ts = Date.now();
      lastSelfWriteTs = ts;
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ state: currentState, ts }));
      fs.renameSync(tmp, STATE_FILE);
    }
    fs.watchFile(STATE_FILE, { interval: 500 }, (curr, prev) => {
      // mtime 没变就是 watchFile 的空心跳,跳过
      if (curr.mtimeMs === prev.mtimeMs) return;
      const parsed = readSharedStateRaw();
      if (!parsed) return;
      // 是 server 自己刚写的就跳过——避免 server→client 转换瞬间残留 watcher
      // 误把自己的写当成"对端广播"再 apply 一次。
      if (parsed.ts && parsed.ts === lastSelfWriteTs) return;
      applyState(parsed.state);
    });
    stateWatching = true;
    logLine('客户端模式: 正在轮询共享状态文件 (fs.watchFile)', true);
  } catch (e) {
    logLine(`监听共享文件失败: ${e}`, true);
  }
}

function stopClient() {
  if (stateWatching) {
    try { fs.unwatchFile(STATE_FILE); } catch { /* ignore */ }
    stateWatching = false;
  }
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
      logLine('收到 /__yield 请求,让位给新实例', true);
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
          logLine(`解析失败: ${e}`, true);
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
    // 刚从 client 升为 server:补注册一次 idle 兜底
    // (client 角色时 armIdleTimerIfServer 因 role 检查不会注册)。
    armIdleTimerIfServer();
    logLine(`服务端模式: http://127.0.0.1:${port}/api/v1/event`, true);
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
            logLine('端口被本插件另一窗口占用,发送 /__yield 顶替', true);
            yieldOccupantAndRetake(port);
          } else {
            role = 'client';
            startClient();
            // 占端口的是本插件的另一个窗口。安静当 client,但定期回头竞选:
            // 一旦那个 server 窗口关闭、端口释放,本窗口就能接管,hook 不中断。
            scheduleReelection(5000);
            logLine('端口已被本插件的另一个窗口占用,本窗口转为客户端(文件同步),指示灯正常工作', true);
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
    logLine('对方不响应 /__yield(可能是旧版本),退回客户端模式', true);
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
  logLine(`端口 ${port} 被其他程序占用`, true);
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
    logLine('服务端已停止', true);
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
      logLine(`无法定位 Electron 二进制: ${e}`, true);
      return;
    }
  }
  const mainJs = path.join(extensionPath, 'standalone', 'main.js');
  if (!fs.existsSync(mainJs)) {
    logLine(`找不到 standalone 入口: ${mainJs}`, true);
    return;
  }
  if (!fs.existsSync(electronBin)) {
    logLine(`Electron 二进制不存在: ${electronBin}`, true);
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
    proc.stdout?.on('data', (d) => logLine(`[standalone] ${String(d).trimEnd()}`));
    proc.stderr?.on('data', (d) => logLine(`[standalone:err] ${String(d).trimEnd()}`, true));
    proc.on('exit', (code, signal) => {
      logLine(`独立窗口进程退出 code=${code} signal=${signal}`, true);
      if (standaloneProc === proc) standaloneProc = undefined;
    });
    standaloneProc = proc;
    logLine('独立窗口已启动', true);
  } catch (e) {
    logLine(`启动独立窗口失败: ${e}`, true);
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

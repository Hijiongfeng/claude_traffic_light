import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

/** 标识本插件身份,用于探测端口占用者是不是我们自己 */
const APP_ID = 'claude-traffic-light';
/** 多窗口共享的状态文件 */
const STATE_FILE = path.join(os.tmpdir(), 'claude-traffic-light-state.json');

let statusBarItem: vscode.StatusBarItem;
let server: http.Server | undefined;
let currentState: LightState = 'idle';
let idleTimer: NodeJS.Timeout | undefined;
let reelectTimer: NodeJS.Timeout | undefined;
let stateWatcher: fs.FSWatcher | undefined;
let output: vscode.OutputChannel;
let role: 'server' | 'client' | 'none' = 'none';
/** 端口被外部程序占用时,只弹一次错误,避免周期性重试反复打扰 */
let conflictReported = false;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Claude Traffic Light');

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
        tryBecomeServer();
      }
    })
  );

  // 启动:先看共享文件里有没有现成状态,再尝试抢占端口
  readSharedState();
  startClient();           // 所有窗口都监听共享文件
  tryBecomeServer();       // 同时尝试抢占端口当服务端
}

export function deactivate() {
  stopServer();
  stopClient();
  if (reelectTimer) clearTimeout(reelectTimer);
  if (idleTimer) clearTimeout(idleTimer);
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

function handleEvent(eventName: string) {
  const state = EVENT_MAP[eventName];
  output.appendLine(`[${new Date().toLocaleTimeString()}] 事件: ${eventName} → ${state ?? '(未映射,忽略)'}`);
  if (state) {
    setStateAndBroadcast(state);
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
 *     是 → 安静当 client(靠文件同步),不报错
 *     否 → 报错提示用户
 */
function tryBecomeServer() {
  const port = getPort();
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__id') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: APP_ID }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/event') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (typeof data.event === 'string') {
            handleEvent(data.event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', event: data.event }));
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
      probeOccupant(port);
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
  });
}

/** 探测端口占用者是否为本插件的另一个实例 */
function probeOccupant(port: number) {
  const req = http.get({ host: '127.0.0.1', port, path: '/__id', timeout: 1500 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.app === APP_ID) {
          conflictReported = false;
          role = 'client';
          startClient();
          // 占端口的是本插件的另一个窗口。安静当 client,但定期回头竞选:
          // 一旦那个 server 窗口关闭、端口释放,本窗口就能接管,hook 不中断。
          scheduleReelection(5000);
          output.appendLine('端口已被本插件的另一个窗口占用,本窗口转为客户端(文件同步),指示灯正常工作');
          return;
        }
      } catch { /* 落到下面报错 */ }
      reportPortConflict(port);
    });
  });
  req.on('error', () => reportPortConflict(port));
  req.on('timeout', () => { req.destroy(); reportPortConflict(port); });
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
}

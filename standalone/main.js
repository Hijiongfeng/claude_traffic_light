// Electron main process for the standalone traffic-light window.
// Spawned by the VSCode extension when its host window holds the server role.
// Talks back to the extension over HTTP/SSE on the same port the extension binds.

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || '8080', 10);
const ALWAYS_ON_TOP = args.alwaysOnTop !== 'false';
const STATE_FILE = path.join(os.homedir(), '.claude-traffic-light-window.json');
const DEFAULT_WIDTH = 150;
const DEFAULT_HEIGHT = 450;

let mainWindow;
let sseRequest;
let sseReconnectTimer;
let saveTimer;
let isPinned;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadSavedBounds() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.x === 'number' && typeof data.y === 'number'
        && typeof data.width === 'number' && typeof data.height === 'number') {
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

function saveBounds(bounds) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(bounds));
    } catch { /* ignore */ }
  }, 250);
}

function pickInitialBounds() {
  const saved = loadSavedBounds();
  if (saved) return saved;
  // Default: top-left of the primary display
  const display = screen.getPrimaryDisplay();
  return {
    x: display.workArea.x + 40,
    y: display.workArea.y + 40,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

function createWindow() {
  const b = pickInitialBounds();
  isPinned = ALWAYS_ON_TOP;
  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 80,
    minHeight: 240,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: ALWAYS_ON_TOP,
    resizable: true,
    skipTaskbar: false,
    show: false, // wait until HTML is ready, avoids a white flash on first paint
    title: 'Claude Traffic Light',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (ALWAYS_ON_TOP) {
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  }

  applyPinState();

  mainWindow.loadFile(path.join(__dirname, 'window.html'));
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      applyRoundedShape();
    }
  });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    saveBounds(bounds);
  };
  mainWindow.on('move', persistBounds);
  mainWindow.on('resize', () => {
    persistBounds();
    applyRoundedShape(); // 缩放后重算窗口形状,保持圆角贴合
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
    app.quit();
  });
}

// 用一组矩形近似 CSS 里的软糖圆角 (border-radius 28%/10%)，
// 让窗口形状贴合黑色灯箱轮廓,裁掉四角透明区域。
// 注:setShape 只接受矩形,圆角靠分层矩形阶梯近似——层数越多越平滑。
function applyRoundedShape() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // setShape 用的是物理像素;在高 DPI 屏上要乘以缩放因子,否则形状会偏小
  const { width: w, height: h } = mainWindow.getBounds();
  const sf = screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor || 1;
  const W = Math.round(w * sf);
  const H = Math.round(h * sf);
  const rX = Math.round(W * 0.28); // 横向圆角半径
  const rY = Math.round(H * 0.10); // 纵向圆角半径
  const STEPS = 32;                // 圆角阶梯层数,越大越圆滑

  const shapes = [];
  const stepH = rY / STEPS;

  // 顶部圆角:每层是一个有高度的矩形条,横向按四分之一椭圆收缩
  for (let i = 0; i < STEPS; i++) {
    const yTop = Math.floor(i * stepH);
    const yBot = Math.floor((i + 1) * stepH);
    // 椭圆方程:在高度 progress 处的横向 inset
    const t = 1 - (i + 0.5) / STEPS;             // 1→0
    const xInset = Math.round(rX * (1 - Math.sqrt(1 - t * t)));
    shapes.push({ x: xInset, y: yTop, width: W - 2 * xInset, height: Math.max(1, yBot - yTop) });
  }

  // 中间主体:满宽
  shapes.push({ x: 0, y: rY, width: W, height: H - 2 * rY });

  // 底部圆角:镜像顶部
  for (let i = 0; i < STEPS; i++) {
    const yTop = H - rY + Math.floor(i * stepH);
    const yBot = H - rY + Math.floor((i + 1) * stepH);
    const t = (i + 0.5) / STEPS;                 // 0→1
    const xInset = Math.round(rX * (1 - Math.sqrt(1 - t * t)));
    shapes.push({ x: xInset, y: yTop, width: W - 2 * xInset, height: Math.max(1, yBot - yTop) });
  }

  try {
    mainWindow.setShape(shapes);
  } catch (e) {
    // setShape 在部分 Linux WM / 缺少合成器时不支持,失败就退回方形窗口(背景已透明,影响不大)
    console.error('setShape 不支持,保持方形窗口:', e.message);
  }
}

// Renderer asks main to close the window via IPC.
ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Pin / unpin always-on-top from the renderer's pin button.
ipcMain.handle('toggle-pin', () => {
  isPinned = !isPinned;
  applyPinState();
  return isPinned;
});
ipcMain.handle('get-pin-state', () => isPinned);

// Linux + X11 forwarding 下,_NET_WM_STATE_ABOVE 由本机 WM 决定是否生效。
// XQuartz/VcXsrv 这类宿主 X server 经常压不住宿主机的原生窗口,
// 这里只做尽力而为:调 setAlwaysOnTop + 切换时 moveTop 一次,不做周期性抢层级。
function applyPinState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(isPinned, isPinned ? 'pop-up-menu' : 'normal');
  if (isPinned) mainWindow.moveTop();
}

// Subscribe to extension's SSE stream and relay events to the renderer.
function connectSSE() {
  if (sseRequest) {
    try { sseRequest.destroy(); } catch { /* ignore */ }
    sseRequest = undefined;
  }
  const req = http.get({
    host: '127.0.0.1',
    port: PORT,
    path: '/__events',
    headers: { 'Accept': 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      scheduleReconnect();
      return;
    }
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        try {
          const data = JSON.parse(payload);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('state-update', data);
          }
        } catch { /* ignore malformed frame */ }
      }
    });
    res.on('end', scheduleReconnect);
    res.on('error', scheduleReconnect);
  });
  req.on('error', scheduleReconnect);
  req.setTimeout(0); // never time out — SSE is long-lived
  sseRequest = req;
}

function scheduleReconnect() {
  if (sseReconnectTimer) return;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = undefined;
    connectSSE();
  }, 1500);
}

// Pull current state once on startup so we render immediately without waiting for an event.
function fetchInitialState() {
  http.get({ host: '127.0.0.1', port: PORT, path: '/__status', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('state-update', data);
        }
      } catch { /* ignore */ }
    });
  }).on('error', () => { /* ignore */ });
}

app.whenReady().then(() => {
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    fetchInitialState();
    connectSSE();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Parent (the extension) signals shutdown via SIGTERM.
process.on('SIGTERM', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  app.quit();
});
process.on('SIGINT', () => {
  app.quit();
});

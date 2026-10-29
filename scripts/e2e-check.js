/*
 * 真机冒烟：用 Edge 加载未打包扩展，打开 generals.io，检查
 *   1) MAIN world 脚本执行了（window.__GB）
 *   2) socket 陷阱抓到了 socket.io 实例
 *   3) 面板挂上了 DOM
 *   4) 没有未捕获异常
 * 运行：node scripts/e2e-check.js
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-edge-'));

const args = [
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1280,800',
  'https://generals.io/'
];

const child = spawn(EDGE, args, { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('generals.io'));
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('没拿到调试目标');
}

function client(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onopen = () =>
      resolve({
        events,
        send(method, params = {}) {
          const msg = { id: ++id, method, params };
          ws.send(JSON.stringify(msg));
          return new Promise((res, rej) => {
            pending.set(msg.id, { res, rej });
            setTimeout(() => pending.has(msg.id) && rej(new Error('timeout ' + method)), 15000);
          });
        },
        close: () => ws.close()
      });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    };
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expression);
  return r.result.value;
}

(async () => {
  let cdp;
  try {
    const target = await getTarget();
    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    await sleep(9000);

    const report = {};
    report.page = await evaluate(cdp, 'location.href');
    report.gb = await evaluate(cdp, 'typeof window.__GB === "object" && !!window.__GB.bot');
    report.socketTrap = await evaluate(cdp, 'typeof window.socket === "object" && typeof window.socket.emit === "function"');
    report.panel = await evaluate(cdp, '!!document.getElementById("gb-autopilot-host")');
    report.state = await evaluate(
      cdp,
      'window.__GB && window.__GB.state ? ({ready: window.__GB.state.ready, type: window.__GB.state.gameType, pid: window.__GB.state.playerIndex, n: window.__GB.state.n}) : null'
    );
    report.errors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.text || e.params.exceptionDetails.exception?.description)
      .filter((t) => String(t).includes('[GBAuto]') || String(t).includes('gb-'))
      .slice(0, 5);
    report.console = cdp.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled')
      .map((e) => e.params.args.map((a) => a.value || a.description).join(' '))
      .filter((t) => t.includes('GBAuto'))
      .slice(0, 10);

    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) {}
  }
})();

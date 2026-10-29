/*
 * 极简 CDP 驱动：启动 Edge（可加载未打包扩展）+ 连接 + 求值。
 * 不引第三方依赖，只用 Node 24 自带的 fetch / WebSocket。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch({ port = 9333, url = 'https://generals.io/', extension = null } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-edge-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1280,800'
  ];
  if (extension) {
    const ext = path.resolve(extension);
    args.push(`--load-extension=${ext}`, `--disable-extensions-except=${ext}`);
  }
  args.push(url);
  const child = spawn(EDGE, args, { stdio: 'ignore' });
  return { child, port, profile };
}

async function getTarget(port, match = 'generals.io', tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes(match));
      if (page) return page;
    } catch (e) {
      /* 浏览器还没起来 */
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
            setTimeout(() => {
              if (pending.delete(msg.id)) rej(new Error('timeout ' + method));
            }, 20000);
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
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function shutdown(handle, cdp) {
  if (cdp) cdp.close();
  if (handle) {
    handle.child.kill();
    await sleep(400);
    try {
      fs.rmSync(handle.profile, { recursive: true, force: true });
    } catch (e) {
      /* 临时目录清不掉无所谓 */
    }
  }
}

module.exports = { launch, getTarget, client, evaluate, shutdown, sleep };

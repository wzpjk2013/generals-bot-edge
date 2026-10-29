/*
 * 端到端：加载扩展 → 打开 generals.io → 拦截 socket.emit →
 * 灌入合成的 game_start / game_update → 检查机器人真的下发了 attack。
 * 运行：node scripts/e2e-pipeline.js
 */
'use strict';

const path = require('node:path');
const { launch, getTarget, client, evaluate, shutdown, sleep } = require('./cdp');

const EXT = path.resolve(__dirname, '..');
const PORT = 9334;

const INJECT = `
(function () {
  const s = window.socket;
  if (!s) return { ok: false, why: 'no socket' };
  const sent = [];
  window.__GB.__sent = sent;
  const orig = s.emit;
  s.emit = function (name) { sent.push(Array.prototype.slice.call(arguments)); };

  const w = 8, h = 8, n = w * h;
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(-1);
  armies[9] = 10;      // 我方将军带 10 兵
  terrain[9] = 0;
  armies[18] = 4;      // 敌方单位
  terrain[18] = 1;
  armies[54] = 3;      // 敌方将军，故意放远：将军不许进敌方视野圈（离敌格 >= 2 步），
  terrain[54] = 1;     // 贴脸摆放会让引擎一步都走不出来，那是测地图的问题不是引擎的。
  const map = [w, h].concat(armies, terrain);

  function fire(name, payload) {
    window.__GB.feed(name, payload);
  }

  fire('game_start', {
    playerIndex: 0, generals: [9, 54], cities: [], usernames: ['bot', 'enemy'],
    map: map.slice(), game_type: 'custom', options: { modifiers: [] }, teams: []
  });
  fire('game_update', { turn: 1, map: map.slice(), generals: [9, 54], scores: [] });

  return { ok: true, emitted: sent, ready: window.__GB.state.ready, online: window.__GB.state.n };
})()
`;

const FFA_CASE = `
(function () {
  const s = window.socket;
  const sent = [];
  window.__GB.__sent = sent;
  s.emit = function (name) { sent.push(Array.prototype.slice.call(arguments)); };
  const w = 8, h = 8, n = w * h;
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(-1);
  armies[9] = 10; terrain[9] = 0;
  const map = [w, h].concat(armies, terrain);
  const fire = (name, p) => window.__GB.feed(name, p);
  fire('game_start', { playerIndex: 0, generals: [9], cities: [], usernames: ['bot'], map: map.slice(), game_type: 'ffa' });
  fire('game_update', { turn: 50, map: map.slice() });
  return { emitted: sent, blocked: window.__GB.state.gameType };
})()
`;

(async () => {
  let handle;
  let cdp;
  let failed = false;
  try {
    handle = launch({ port: PORT, extension: EXT });
    const target = await getTarget(PORT);
    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await sleep(8000);

    const first = await evaluate(cdp, INJECT);
    if (!first.ok) throw new Error('注入失败: ' + first.why);
    await sleep(900); // 等 drive() 里的 setTimeout 走子

    const after = await evaluate(
      cdp,
      `({
        ready: window.__GB.state.ready,
        n: window.__GB.state.n,
        pid: window.__GB.state.playerIndex,
        turn: window.__GB.state.turn,
        panel: document.getElementById('gb-autopilot-host').shadowRoot.getElementById('st2').textContent,
        status: document.getElementById('gb-autopilot-host').shadowRoot.getElementById('st').textContent
      })`
    );

    const attacks = await evaluate(cdp, 'window.__GB.__sent');
    first.emitted = attacks;

    const ffa = await evaluate(cdp, FFA_CASE);
    await sleep(700);
    ffa.emitted = await evaluate(cdp, 'window.__GB.__sent');

    console.log('--- 自建房间 ---');
    console.log(JSON.stringify({ inject: first, state: after }, null, 2));
    console.log('--- 公开对局 ffa ---');
    console.log(JSON.stringify(ffa, null, 2));

    if (!first.ready && !first.ok) failed = true;
    if (!Array.isArray(first.emitted) || first.emitted.length === 0) {
      console.log('FAIL: 没有下发任何 attack');
      failed = true;
    } else {
      const bad = first.emitted.filter((a) => a[0] !== 'attack' || a.length !== 5);
      if (bad.length) {
        console.log('FAIL: attack 参数形状不对', JSON.stringify(bad));
        failed = true;
      }
    }
    if (!ffa.emitted.some((a) => a[0] === 'attack')) {
      console.log('FAIL: 公开对局没有接管');
      failed = true;
    }
  } catch (e) {
    console.error('FAILED:', e.message);
    failed = true;
  } finally {
    await shutdown(handle, cdp);
  }
  process.exitCode = failed ? 1 : 0;
  if (!failed) console.log('\nPIPELINE OK');
})();

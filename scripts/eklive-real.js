/*
 * 真站验证：把仓库目录当扩展加载进 Edge，直接打开 generals.io（不换桩页），
 * 读出扩展在**真服务器数据**上的运行状态。
 *
 * 为什么必须有这个脚本：eklive-check.js 走 serveStub + GB.feed 注入，喂的是我们自己
 * 编码出来的包（arena 口径）。1.2.1 发出去真机仍然「决策/下发 0/0」，说明真服务器的
 * 消息形状或时序和我们伪造的不一样，只有真站能照出来。
 *
 * 用法：
 *   node scripts/eklive-real.js probe            只看加载状态，不进对局
 *   node scripts/eklive-real.js watch [秒数]     进 1v1 并盯着面板数据（默认 180 秒）
 *   node scripts/eklive-real.js play [秒数]      同上，但由脚本点「Play / 1v1」
 */
'use strict';

const path = require('node:path');
const cdpmod = require('./cdp');

const PORT = Number(process.env.GB_CDP_PORT || 9335);
const EXT = path.resolve(__dirname, '..');

const PROBE = `(() => {
  const out = { url: location.href, ready: document.readyState, hasGB: !!window.__GB, hasEK: !!window.__EK };
  try {
    out.ekKeys = window.__EK ? Object.keys(window.__EK).length : 0;
    out.hasBot = !!(window.__EK && window.__EK.Bot);
    out.hasFlow = !!(window.__EK && window.__EK.ArmyFlowExpanderV2);
  } catch (e) { out.ekErr = String(e && e.message || e); }
  try {
    const gb = window.__GB || {};
    out.gbKeys = Object.keys(gb);
    out.version = gb.version || null;
    out.socket = gb.socket ? 'yes' : 'no';
    const S = gb.state;
    if (S) {
      out.state = {
        ready: !!S.ready, started: !!S.started, ended: !!S.ended,
        w: S.w, h: S.h, turn: S.turn, pid: S.playerIndex,
        generals: S.generals, cities: Array.isArray(S.cities) ? S.cities.length : null,
        badDiff: S.badDiff, usernames: S.usernames, teams: S.teams,
        scores: S.scores, gameType: S.gameType
      };
    }
    const ek = gb.ekbot;
    if (ek) out.ek = ek.stats();
  } catch (e) { out.stateErr = String(e && e.message || e); }
  try {
    const el = document.querySelector('#gb-panel-host') || document.querySelector('[data-gb]');
    out.panel = el ? 'yes' : 'unknown';
    out.bodyText = (document.body && document.body.innerText || '').slice(0, 400);
  } catch (e) {}
  return out;
})()`;

// 站点默认中文，英文名只在切语言后出现，所以两套词都认。
const CLICK_1V1 = `(() => {
  const txt = (el) => ((el && (el.innerText || el.value || '')) + '').trim();
  const all = Array.from(document.querySelectorAll('button,a,div[role=button],input[type=button],.btn,.item'));
  const visible = (el) => el.offsetParent !== null;
  const named = all.filter(visible).map((el) => txt(el)).filter((t) => t && t.length < 24);
  const pick = (pred) => all.find((el) => visible(el) && pred(txt(el).toLowerCase()));
  const out = { named: Array.from(new Set(named)).slice(0, 30) };
  const rules = [
    ['1v1', (t) => t === '1v1' || t.includes('1v1')],
    ['play', (t) => t === '开始游戏' || t === 'play' || t === 'play now'],
    ['guest', (t) => t.includes('guest') || t.includes('游客')]
  ];
  for (const [name, pred] of rules) {
    const el = pick(pred);
    if (el) { el.click(); out.clicked = name + ':' + txt(el); return out; }
  }
  return out;
})()`;

function argOf(n, def) {
  const v = Number(process.argv[n]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function main() {
  const mode = process.argv[2] || 'probe';
  const handle = cdpmod.launch({ port: PORT, url: 'https://generals.io/', extension: EXT });
  let cdp = null;
  try {
    const target = await cdpmod.getTarget(PORT, 'generals.io', 120);
    cdp = await cdpmod.client(target.webSocketDebuggerUrl);
    await cdpmod.sleep(4000);
    console.log('probe#1', JSON.stringify(await cdpmod.evaluate(cdp, PROBE)));
    if (mode === 'probe') return;

    // 进对局：真站的入口是 nickname 输入 + Play。逐个尝试，成功与否都打印页面按钮名，
    // 这样失败时能看出前端改版成什么样了。
    for (let i = 0; i < 8; i++) {
      const r = await cdpmod.evaluate(cdp, CLICK_1V1);
      if (r && r.clicked) console.log('click', JSON.stringify(r));
      else {
        console.log('click#none', JSON.stringify(r));
        break;
      }
      await cdpmod.sleep(2500);
    }

    const total = argOf(3, 180) * 1000;
    const started = Date.now();
    let last = '';
    while (Date.now() - started < total) {
      await cdpmod.sleep(3000);
      const p = await cdpmod.evaluate(cdp, PROBE);
      const line = JSON.stringify({
        t: Math.round((Date.now() - started) / 1000),
        state: p.state, ek: p.ek, socket: p.socket, url: p.url
      });
      if (line !== last) console.log(line);
      last = line;
      if (p.state && p.state.ended) break;
    }
  } finally {
    if (cdp) try { await cdpmod.shutdown(handle, cdp); } catch (e) { /* 关不掉就算了 */ }
    else try { handle.child.kill(); } catch (e) { /* 同上 */ }
  }
}

main().then(() => process.exit(0), (e) => {
  console.error('FAILED', e && e.stack || e);
  process.exit(1);
});

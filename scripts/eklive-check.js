/*
 * 真机「回放一局真数据」检查：扩展装进 Edge 后，把 eklump 里录下的真对局包
 * 按 120ms 节奏灌进 GB.feed，看扩展里的引擎到底出不出招、错在哪。
 *
 * 为什么需要它：e2e-check.js 只验证「加载成功 + 面板在」，Node 侧的 ekjs/ekdiff-move
 * 又跑在 Node 里（有 process、有 require）。1.2.0 真机「决策 0 / 下发 0」正是浏览器
 * 独有问题：引擎里残留 `process.env` ⇒ 每回合 ReferenceError ⇒ 空过。
 * 这个脚本是唯一能在真浏览器环境里跑决策链路的验证。
 *
 *   node scripts/eklive-check.js                       # 默认回放 _research/ekdump/gm1.jsonl
 *   node scripts/eklive-check.js <path.jsonl> [turns]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launch, getTarget, client, evaluate, serveStub, shutdown, sleep } = require('./cdp');

const EXT = process.env.GB_EXT ? path.resolve(process.env.GB_EXT) : path.resolve(__dirname, '..');
const PORT = 9334;
const DUMP = path.resolve(
  process.argv[2] || path.join('E:', 'akcoco6de', '_research', 'ekdump', 'gm1.jsonl')
);
const MAX_TURNS = Number(process.argv[3] || 0) || Infinity;

const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>generals stub</title></head>
<body><div id="stub">generals.io 空壳页（eklive 用）</div></body></html>`;

// 把 eklump 的整流 diff（[0,len,...values,0...]）还原成平表
function decodeFullDiff(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return [];
  const len = arr[1] | 0;
  return arr.slice(2, 2 + len);
}

function loadReplay(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const recs = lines.map((s) => JSON.parse(s));
  const start = recs.find((r) => r.start);
  if (!start) throw new Error('dump 里没有 start 记录：' + file);
  const packets = recs.filter((r) => r.data).map((r) => r.data).slice(0, MAX_TURNS);
  const first = packets[0];
  return {
    playerIndex: start.startData.playerIndex,
    usernames: start.startData.usernames,
    generals: first.generals || [],
    map: decodeFullDiff(first.map_diff),
    packets
  };
}

const FEED_SCRIPT = (replay) => `
(function () {
  var GB = window.__GB;
  if (!GB) return Promise.resolve({ error: 'no __GB（扩展没注入 MAIN world）' });
  var replay = ${JSON.stringify(replay)};

  // hook.js 的 drive() 有 100ms 节流且「同一 turn 只跑一次」，所以必须真等，不能同步灌。
  var calls = [];
  if (!GB.__wrapped) {
    var orig = GB.ekbot.plan.bind(GB.ekbot);
    GB.ekbot.plan = function (S) {
      var t0 = Date.now();
      var r = orig(S);
      calls.push({ turn: S.turn, n: r ? r.length : 0, ms: Date.now() - t0, err: GB.ekbot.lastError });
      return r;
    };
    GB.__wrapped = true;
  }

  GB.feed('game_start', {
    playerIndex: replay.playerIndex,
    usernames: replay.usernames,
    teams: null,
    generals: replay.generals,
    cities: [],
    map: replay.map,
    turn: 0
  });

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    for (var i = 0; i < replay.packets.length; i++) {
      GB.feed('game_update', replay.packets[i]);
      await wait(130);
    }
    var seen = {}, errs = [];
    for (var k = 0; k < calls.length; k++) {
      var e = calls[k].err;
      if (!e) continue;
      if (!seen[e]) { seen[e] = 1; errs.push({ firstTurn: calls[k].turn, msg: String(e).slice(0, 300) }); }
    }
    return {
      fedTurns: replay.packets.length,
      callCount: calls.length,
      movedTurns: calls.filter(function (c) { return c.n > 0; }).length,
      firstMoves: calls.filter(function (c) { return c.n > 0; }).slice(0, 5)
        .map(function (c) { return c.turn + '@' + c.ms + 'ms'; }),
      errKinds: errs,
      slowTurns: calls.filter(function (c) { return c.ms > 1000; }).map(function (c) { return c.turn + ':' + c.ms; }).slice(0, 10),
      ek: GB.ekbot.stats ? GB.ekbot.stats() : null,
      panelDec: (function () {
        var h = document.getElementById('gb-autopilot-host');
        return h ? h.shadowRoot.getElementById('st3').textContent : null;
      })()
    };
  })();
})()
`;

(async () => {
  let handle;
  let cdp;
  try {
    const replay = loadReplay(DUMP);
    handle = launch({ port: PORT, extension: EXT, url: 'about:blank' });
    const target = await getTarget(PORT, 'about:blank');
    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const net = await serveStub(cdp, STUB_HTML);
    await cdp.send('Page.navigate', { url: 'https://generals.io/' });
    await sleep(4500);

    const res = await evaluate(cdp, FEED_SCRIPT(replay));
    console.log(JSON.stringify({ dump: path.basename(DUMP), stubbed: net.offline, result: res }, null, 2));
    if (res && res.errKinds && res.errKinds.length) process.exitCode = 1;
  } catch (e) {
    console.error('FAILED:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (handle) shutdown(handle);
    setTimeout(() => process.exit(), 300);
  }
})();

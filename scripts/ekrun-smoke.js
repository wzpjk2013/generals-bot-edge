/*
 * ekrun.js（扩展里用的那一层协议适配）离线冒烟。
 *
 * 为什么需要它：ekjs.js 直接调 EK.Bot，而扩展里走的是 state.js 还原的整幅地图 →
 * ekrun 重新编成服务器包 → EK.Bot。多出来的这段编码有可能把地形/城市/将军编错，
 * 那在浏览器里表现为「引擎在跑但一直不出招」，很难查。这里把同一局的数据同时喂给
 *   ① ekjs 的直连路径（serialize → EkBot）
 *   ② 扩展路径（GameState.applyUpdate → GB.ekbot.plan）
 * 逐回合比招法。两边完全一致才说明适配层是透明的。
 *
 *   node scripts/ekrun-smoke.js            默认 gc / seed 1000 / 80 回合
 *   node scripts/ekrun-smoke.js kutu 1000 120
 */
'use strict';

const path = require('path');
const A = require('./arena.js');
const { makeRefAgent } = require('./refagents.js');
const { serialize } = require('./refpy.js');
const { EkBot, loadEK } = require('./ekjs.js');

const W = A.W;
const H = A.H;
const N = A.N;

const EKROOT = path.resolve(__dirname, '..');

function loadExtension() {
  // arena.js 开头就把 window 设成了 global，所以 ek 模块（root = window || global）、
  // state.js、ekrun.js 全都挂在同一个 global.__EK / global.__GB 上，这里不用再伪造 window。
  const ek = loadEK();
  if (!ek || !ek.Bot) throw new Error('eklipz 模块没挂上');
  require(path.join(EKROOT, 'src/state.js'));
  require(path.join(EKROOT, 'src/ekrun.js'));
  return global.window.__GB;
}

function mulberry(a) {
  a |= 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function msgFor(board, me, fog, vis, turn) {
  const st = serialize(board, me, fog, vis);
  const cities = st.cities.slice();
  const generals = new Array(2).fill(-1);
  for (const g of st.generals) {
    const owner = board.owner[g];
    if (owner >= 0) generals[owner] = g;
  }
  return {
    name: turn === 1 ? 'game_start' : 'game_update',
    msg: {
      playerIndex: me,
      turn: turn,
      usernames: ['ekrun', 'them'],
      map: st.map,
      cities: cities,
      generals: generals,
      // 服务器发的是所有玩家的真实分数；用 board 的真值来模拟（只给迷雾视野会低估对手）
      scores: scoresFor(board)
    }
  };
}

function scoresFor(board) {
  const out = [];
  for (const p of [0, 1]) {
    let tiles = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (board.owner[i] !== p) continue;
      tiles++;
      total += board.armies[i];
    }
    out.push({ i: p, total: total, tiles: tiles, dead: board.generals[p] >= 0 && board.owner[board.generals[p]] !== p });
  }
  return out;
}

function run(opponent, seed, maxTurns) {
  const GB = loadExtension();
  const ek = global.__EK;
  const board = A.makeMap(mulberry(seed));
  if (!board) throw new Error('makeMap 失败');
  const ref = makeRefAgent(opponent, mulberry(seed ^ 0x9e3779b9));
  const me = 0;

  const fogs = [A.makeFog(), A.makeFog()];
  const vis0 = A.updateFog(fogs[me], board, me);
  A.updateFog(fogs[1 - me], board, 1 - me);

  // ① 直连路径
  const st0 = serialize(board, me, fogs[me], vis0);
  const startData = {
    playerIndex: me,
    usernames: ['ekrun', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'ekrun_smoke',
    game_type: 'custom',
    options: {}
  };
  const direct = new EkBot();
  direct.start(startData, packetFor(board, st0, 1));

  // ② 扩展路径：先 game_start，再每回合 game_update
  const S = new GB.GameState();
  const startMsg = msgFor(board, me, fogs[me], vis0, 1).msg;
  S.applyStart(startMsg);
  GB.ekbot.reset();

  let same = 0;
  let diff = 0;
  let firstDiff = null;
  const events = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const vis = A.updateFog(fogs[me], board, me);
    A.updateFog(fogs[1 - me], board, 1 - me);
    const st = serialize(board, me, fogs[me], vis);
    const packet = packetFor(board, st, turn);

    const mvA = direct.turn(packet);
    const keyA = mvA ? mvA.join(',') : 'pass';

    // 扩展路径用的是「整幅地图」消息（服务器给前端的形状）。turn 必须和直连路径
    // 同一口径，否则两边在地图上差一拍，比出来的分歧全是假的。
    const full = msgFor(board, me, fogs[me], vis, turn).msg;
    S.applyUpdate(full);
    const res = GB.ekbot.plan(S);
    const keyB = res && res.length ? res[0].join(',') : 'pass';

    if (keyA === keyB) same++;
    else {
      diff++;
      if (firstDiff === null) firstDiff = { turn: turn, direct: keyA, ext: keyB, err: GB.ekbot.lastError };
    }

    // 走出这一手，推进对局（只跑一边的行为，够验证编码层一致）
    if (mvA) {
      const r = A.applyMove(board, me, mvA[0], mvA[1], !!mvA[2]);
      events.push(r);
    }
    // 对手照 ekjs.js 的口径走 makeView + plan（参考 bot 吃的是「自己视角的视图」）
    const refView = A.makeView(board, 1 - me, fogs[1 - me], A.updateFog(fogs[1 - me], board, 1 - me));
    const act = ref.plan(refView);
    if (act) A.applyMove(board, 1 - me, act.from, act.to, act.split);
    // 有人将军被吃就收工（board 上没有 dead 标记，照 ekjs.js 用 owner 判）
    if (board.owner[board.generals[me]] !== me || board.owner[board.generals[1 - me]] !== 1 - me) break;
  }

  console.log('对手 ' + opponent + ' seed ' + seed + '：直连 vs 扩展 一致 ' + same + '，不一致 ' + diff);
  if (firstDiff) console.log('  首个分歧：' + JSON.stringify(firstDiff));
  const ms = GB.ekbot.stats();
  console.log('  扩展侧统计：' + JSON.stringify(ms).slice(0, 400));
  return diff === 0;
}

function packetFor(board, st, turn) {
  const out = [];
  for (const p of [0, 1]) {
    let tiles = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (board.owner[i] !== p) continue;
      tiles++;
      total += board.armies[i];
    }
    out.push({ i: p, total: total, tiles: tiles, dead: board.generals[p] >= 0 && board.owner[board.generals[p]] !== p });
  }
  return {
    turn: turn,
    map_diff: [0, st.map.length].concat(st.map),
    cities_diff: [0, st.cities.length].concat(st.cities),
    deserts_diff: [0, 0, 0],
    generals: st.generals,
    scores: out,
    stars: [0, 0]
  };
}

if (require.main === module) {
  const opponent = process.argv[2] || 'gc';
  const seed = Number(process.argv[3] || 1000);
  const maxTurns = Number(process.argv[4] || 80);
  const ok = run(opponent, seed, maxTurns);
  process.exit(ok ? 0 : 1);
}

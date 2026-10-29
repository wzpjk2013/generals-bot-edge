/*
 * 擂台：本扩展的引擎 vs strakam/generals-bots 里的参考 bot。
 *
 * 规则按 generals.io 真实对局来：
 *   - 20x20 全视野 1v1（1v1 本来就没有迷雾）
 *   - 每回合每个地格 +1，自己占的城市额外 +1（隔回合），将军当普通格
 *   - 一格一回合只能动一次；打出去的兵留 1 个在家
 *   - 吃掉对方将军即胜；1000 回合没打完算和
 *
 * 两种赛制：
 *   1 步/回合   bot API 的原生协议（参考 bot 训练时的设定），双方都只走 1 步
 *   6 步/回合   本扩展默认设置，双方都最多走 6 步（参考 bot 每回合被调用多次）
 *
 * 每个种子打两局，双方交换先后手，抵消先手优势。
 *
 * 运行：node scripts/arena.js [每格种子数]
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const { makeRefAgent } = require('./refagents.js');

const GB = global.window.__GB;
const T = GB.TILE;

const W = 20;
const H = 20;
const N = W * H;
const MAX_TURNS = 1000;
const MOUNTAIN_P = 0.18;
const CITIES = 5;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function neighbors(i) {
  const out = [];
  const x = i % W;
  const y = (i / W) | 0;
  if (y > 0) out.push(i - W);
  if (y < H - 1) out.push(i + W);
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  return out;
}

function distField(from, passable) {
  const d = new Int32Array(N).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const j of neighbors(cur)) {
      if (d[j] !== -1 || !passable[j]) continue;
      d[j] = d[cur] + 1;
      q.push(j);
    }
  }
  return d;
}

function makeMap(rng) {
  const owner = new Int16Array(N).fill(T.EMPTY);
  const armies = new Int32Array(N).fill(0);
  const mountains = new Uint8Array(N);
  const cities = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (rng() < MOUNTAIN_P) {
      mountains[i] = 1;
      owner[i] = T.MOUNTAIN;
    }
  }

  const passable = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!mountains[i]) passable[i] = 1;

  // 两个将军：互相 BFS 距离 >= 9，且都在通行格上
  let ga = -1;
  let gb = -1;
  for (let tries = 0; tries < 4000 && (ga < 0 || gb < 0); tries++) {
    const a = Math.floor(rng() * N);
    const b = Math.floor(rng() * N);
    if (a === b || !passable[a] || !passable[b]) continue;
    const d = distField(a, passable);
    if (d[b] < 9) continue;
    if (d[b] > N) continue;
    ga = a;
    gb = b;
  }
  if (ga < 0) return null;

  // 城市：离将军至少 3 步，互相不挨着
  const dA = distField(ga, passable);
  const dB = distField(gb, passable);
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < CITIES; tries++) {
    const i = Math.floor(rng() * N);
    if (!passable[i] || cities[i]) continue;
    if (dA[i] >= 0 && dA[i] < 3) continue;
    if (dB[i] >= 0 && dB[i] < 3) continue;
    let adjCity = false;
    for (const j of neighbors(i)) if (cities[j]) adjCity = true;
    if (adjCity) continue;
    cities[i] = 1;
    armies[i] = 40 + Math.floor(rng() * 12);
    placed++;
  }

  owner[ga] = 0;
  armies[ga] = 1;
  owner[gb] = 1;
  armies[gb] = 1;

  return { owner, armies, mountains, cities, generals: [ga, gb] };
}

function applyMove(board, me, from, to, split) {
  if (board.owner[from] !== me) return false;
  const a = board.armies[from];
  if (a < 2) return false;
  if (from === to) return false;
  if (board.mountains[to]) return false;
  if (!neighbors(from).includes(to)) return false;
  const sent = split ? a >> 1 : a - 1;
  if (sent < 1) return false;
  board.armies[from] = a - sent;
  if (board.owner[to] === me) {
    board.armies[to] += sent;
  } else {
    const left = sent - board.armies[to];
    if (left > 0) {
      board.owner[to] = me;
      board.armies[to] = left;
    } else {
      board.armies[to] = -left;
    }
  }
  return true;
}

function makeView(board, me) {
  const generals = new Uint8Array(N);
  generals[board.generals[0]] = 1;
  generals[board.generals[1]] = 1;
  let myGen = board.generals[me];
  return {
    w: W,
    h: H,
    armies: board.armies,
    owner: board.owner,
    cities: board.cities,
    mountains: board.mountains,
    generals,
    me,
    general: myGen
  };
}

function syncState(S, board, pid) {
  S.terrain.set(board.owner);
  S.armies.set(board.armies);
}

function landCount(board, me) {
  let c = 0;
  for (let i = 0; i < N; i++) if (board.owner[i] === me) c++;
  return c;
}

function armyCount(board, me) {
  let c = 0;
  for (let i = 0; i < N; i++) if (board.owner[i] === me) c += board.armies[i];
  return c;
}

/* 一局。opponent 是参考 bot 名字，oursSide 0/1 决定谁先手 */
function playGame(seed, opponent, ourBudget, refBudget, oursSide, trace) {
  if (refBudget === undefined) refBudget = ourBudget;
  const rng = mulberry32(seed);
  const board = makeMap(rng);
  if (!board) return null;

  const s0 = new GB.GameState();
  const s1 = new GB.GameState();
  const map = [W, H, ...Array.from(board.armies), ...Array.from(board.owner)];
  for (const [S, pid] of [
    [s0, 0],
    [s1, 1]
  ]) {
    S.applyStart({
      playerIndex: pid,
      generals: board.generals,
      cities: Array.from(board.cities)
        .map((v, i) => (v ? i : -1))
        .filter((i) => i >= 0),
      usernames: ['us', 'them'],
      map,
      game_type: 'custom'
    });
    S.turn = 0;
  }
  const states = [s0, s1];

  const refRng = mulberry32(seed ^ 0x9e3779b9);
  const ref = makeRefAgent(opponent, refRng);

  let winner = -1;
  let turns = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turns = turn + 1;

    const order = oursSide === 0 ? [0, 1] : [1, 0];
    for (const p of order) {
      const me = p;
      if (board.owner[board.generals[me]] !== me) continue; // 已经死了
      const enemy = 1 - me;
      const view = makeView(board, me);

      if (p === oursSide) {
        // 我们：引擎一次给出整回合的计划
        syncState(states[p], board, p);
        states[p].turn = turn;
        const moves = GB.bot.plan(states[p], { maxMoves: ourBudget });
        if (trace) {
          console.log(
            'T' + turn + ' 我方 gen=' + board.generals[oursSide] + ' 兵=' + board.armies[board.generals[oursSide]] +
            ' 走=' + JSON.stringify(moves)
          );
        }
        for (const [from, to] of moves) {
          applyMove(board, me, from, to, false);
          if (board.owner[board.generals[enemy]] === me) {
            winner = me;
            break;
          }
        }
      } else {
        // 参考 bot：每回合只有 1 个动作，多步赛制下反复问它
        for (let k = 0; k < refBudget; k++) {
          const act = ref.plan(view);
          if (!act) break;
          if (!applyMove(board, me, act.from, act.to, act.split)) break;
          if (trace) console.log('T' + turn + ' 对方 ' + act.from + '>' + act.to + ' split=' + act.split);
          if (board.owner[board.generals[enemy]] === me) {
            winner = me;
            break;
          }
        }
      }
      if (winner >= 0) break;
    }
    if (winner >= 0) break;

    // 增长：地格 +1，自己占的城市隔回合再 +1
    for (let i = 0; i < N; i++) {
      const o = board.owner[i];
      if (o < 0) continue;
      board.armies[i] += 1;
      if (board.cities[i] && turn % 2 === 0) board.armies[i] += 1;
    }
  }

  return {
    winner,
    turns,
    ourLand: landCount(board, oursSide),
    enemyLand: landCount(board, 1 - oursSide),
    ourArmy: armyCount(board, oursSide),
    enemyArmy: armyCount(board, 1 - oursSide)
  };
}

function wald(wins, games, success, total) {
  // 只看胜率，和棋按半局算
  return games ? (wins + 0.5 * (games - wins - total)) / games : 0;
}

function runCell(opponent, ourBudget, refBudget, seeds) {
  const acc = {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    turns: 0,
    ourLand: 0,
    enemyLand: 0,
    ourArmy: 0,
    enemyArmy: 0,
    skipped: 0
  };
  for (let s = 0; s < seeds; s++) {
    const seed = 1000 + s * 7919;
    for (const oursSide of [0, 1]) {
      const r = playGame(seed, opponent, ourBudget, refBudget, oursSide);
      if (!r) {
        acc.skipped++;
        continue;
      }
      acc.games++;
      acc.turns += r.turns;
      acc.ourLand += r.ourLand;
      acc.enemyLand += r.enemyLand;
      acc.ourArmy += r.ourArmy;
      acc.enemyArmy += r.enemyArmy;
      if (r.winner < 0) acc.draws++;
      else if (r.winner === oursSide) acc.wins++;
      else acc.losses++;
    }
  }
  return acc;
}

function pad(s, n) {
  s = String(s);
  let out = s;
  while (out.length < n) out = ' ' + out;
  return out;
}
function padEnd(s, n) {
  s = String(s);
  let out = s;
  while (out.length < n) out += ' ';
  return out;
}

function show(label, acc) {
  const g = acc.games || 1;
  const wr = (acc.wins / g) * 100;
  const dr = (acc.draws / g) * 100;
  const lr = (acc.losses / g) * 100;
  console.log(
    '  ' +
      padEnd(label, 12) +
      pad(acc.games, 5) +
      pad(acc.wins, 6) +
      pad(acc.losses, 6) +
      pad(acc.draws, 6) +
      pad(wr.toFixed(1) + '%', 8) +
      pad((acc.turns / g).toFixed(0), 8) +
      pad((acc.ourLand / g).toFixed(0), 8) +
      pad((acc.enemyLand / g).toFixed(0), 9) +
      pad((acc.ourArmy / g).toFixed(0), 9) +
      pad((acc.enemyArmy / g).toFixed(0), 9)
  );
}

function header() {
  console.log(
    '  ' +
      padEnd('对手', 12) +
      pad('局数', 4) +
      pad('胜', 5) +
      pad('负', 5) +
      pad('和', 5) +
      pad('胜率', 7) +
      pad('回合', 7) +
      pad('我方地', 7) +
      pad('对方地', 8) +
      pad('我方兵', 8) +
      pad('对方兵', 8)
  );
}

module.exports = { playGame: playGame, makeMap: makeMap };

if (require.main === module) {
  const seeds = Number(process.argv[2] || 40);
  const OPPONENTS = ['random', 'expander', 'hunter', 'harvester'];
  const MODES = [
    { our: 1, ref: 1, label: '双方 1 步/回合（参考 bot 原生协议）' },
    { our: 6, ref: 6, label: '双方 6 步/回合（本扩展默认预算）' },
    { our: 6, ref: 1, label: '我方 6 步 / 对手 1 步（对手按原生协议）' }
  ];

  console.log(
    '擂台：本扩展引擎 vs generals.io 参考 bot（' +
      W +
      'x' +
      H +
      '，每格 ' +
      seeds +
      ' 个种子 × 先后手 = ' +
      seeds * 2 +
      ' 局）'
  );
  console.log(
    '规则：1v1 全视野，格 +1/回合，城市隔回合 +1，一格一回合一动，将军死即败，' + MAX_TURNS + ' 回合未分胜负算和\n'
  );

  const summary = [];
  for (const mode of MODES) {
    console.log('== ' + mode.label + ' ==');
    header();
    for (const opp of OPPONENTS) {
      const acc = runCell(opp, mode.our, mode.ref, seeds);
      show(opp, acc);
      summary.push({ mode: mode.label, opp, acc });
    }
    console.log('');
  }

  const totalGames = summary.reduce((s, x) => s + x.acc.games, 0);
  const totalWins = summary.reduce((s, x) => s + x.acc.wins, 0);
  const totalLoss = summary.reduce((s, x) => s + x.acc.losses, 0);
  const totalDraw = summary.reduce((s, x) => s + x.acc.draws, 0);
  console.log(
    '总计 ' +
      totalGames +
      ' 局：胜 ' +
      totalWins +
      ' / 负 ' +
      totalLoss +
      ' / 和 ' +
      totalDraw +
      '，胜率 ' +
      ((totalWins / totalGames) * 100).toFixed(1) +
      '%'
  );
}

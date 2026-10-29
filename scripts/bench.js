/*
 * 性能与扩张速度基准：32x32 地图跑 200 回合，看单回合决策耗时和领地增长。
 * 运行：node scripts/bench.js
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/bot.js');

const GB = global.window.__GB;
const T = GB.TILE;

const W = 32;
const H = 32;
const N = W * H;

// 固定伪随机，保证可复现
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const armies = new Array(N).fill(0);
const terrain = new Array(N).fill(T.EMPTY);
const cities = [];

for (let i = 0; i < N; i++) {
  if (rnd() < 0.12) terrain[i] = T.MOUNTAIN;
}
for (let c = 0; c < 12; c++) {
  const i = Math.floor(rnd() * N);
  if (terrain[i] === T.EMPTY) {
    armies[i] = 20 + Math.floor(rnd() * 30);
    cities.push(i);
  }
}

// 两个玩家对角线开局
const start = [Math.floor(N * 0.2), Math.floor(N * 0.8)];
start.forEach((i, p) => {
  terrain[i] = p;
  armies[i] = 1;
});

const S = new GB.GameState();
S.applyStart({
  playerIndex: 0,
  generals: start,
  cities,
  usernames: ['a', 'b'],
  map: [W, H, ...armies, ...terrain],
  game_type: 'custom'
});

const TURNS = 200;
let totalMoves = 0;
const t0 = process.hrtime.bigint();

for (let turn = 0; turn < TURNS; turn++) {
  S.turn = turn;
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  totalMoves += moves.length;
  for (const [from, to] of moves) {
    S.armies[to] = S.armies[from] - 1 - S.armies[to];
    S.armies[from] = 0;
    S.terrain[to] = 0;
  }
  // 每回合全体 +1（将军 +2 之类简化掉）
  for (let i = 0; i < N; i++) if (S.terrain[i] === 0 || S.terrain[i] === 1) S.armies[i] += 1;
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
let owned = 0;
let army = 0;
for (let i = 0; i < N; i++) {
  if (S.terrain[i] === 0) {
    owned++;
    army += S.armies[i];
  }
}

console.log('回合数        ' + TURNS);
console.log('总走子        ' + totalMoves + '（平均 ' + (totalMoves / TURNS).toFixed(1) + '/回合）');
console.log('总耗时        ' + ms.toFixed(0) + ' ms');
console.log('单回合平均    ' + (ms / TURNS).toFixed(2) + ' ms');
console.log('已占地图      ' + owned + '/' + N + '（' + ((owned / N) * 100).toFixed(1) + '%）');
console.log('总兵力        ' + army);

const budget = 500 / 6; // 单回合预算按 60fps 里 1/6 秒算都算宽松
if (ms / TURNS > budget) {
  console.log('\nFAIL: 单回合决策超过 ' + budget.toFixed(1) + ' ms');
  process.exitCode = 1;
} else {
  console.log('\nOK');
}

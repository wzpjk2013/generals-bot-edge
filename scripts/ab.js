/*
 * 引擎 A/B：同一套代码、同一个种子，只有参数不同，两边对打。
 *
 * 这是唯一能证明「改动真的变强了」的对照——打参考 bot 不行，参考 bot 在迷雾里
 * 太弱，赢了只能说明它们更菜。A/B 里对手是自己，胜率 50% 就是没差别。
 *
 * 注意先手劣势：每个回合先走的一方在已分胜负的局里只有 ~43% 胜率（对方能看着
 * 你这一步回应）。所以每组种子跑两遍、交换先后手，把这个偏差抵消掉。
 *
 * 运行：
 *   GB_FOG=1 node scripts/ab.js 40 '{"genFogGuard":2}'
 *   GB_FOG=1 node scripts/ab.js 40 '{"genFogGuard":2}' '{"genFogGuard":0}'
 * 第一个参数是「候选」参数，第二个是「基线」参数（省略 = 默认引擎）。
 */
'use strict';

const { playGame } = require('./arena.js');

const seeds = Number(process.argv[2] || 20);
const cand = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const base = process.argv[4] ? JSON.parse(process.argv[4]) : null;
const fog = process.env.GB_FOG === '1';

let games = 0;
let wins = 0;
let losses = 0;
let draws = 0;
let turns = 0;
let candLand = 0;
let baseLand = 0;

for (let s = 0; s < seeds; s++) {
  const seed = 1000 + s * 7919;
  for (const side of [0, 1]) {
    // side=0 时候选方先手，side=1 时候选方后手——两局抵消先手劣势
    const r = playGame(seed, 'engine', 1, 1, side, false, cand, { fog, cfg2: base });
    if (!r) continue;
    games++;
    turns += r.turns;
    candLand += r.ourLand;
    baseLand += r.enemyLand;
    if (r.winner < 0) draws++;
    else if (r.winner === side) wins++;
    else losses++;
  }
}

const g = games || 1;
const decided = wins + losses || 1;
console.log(
  'A/B（' + (fog ? '迷雾' : '全视野') + '）' + games + ' 局\n' +
    '  候选 ' + JSON.stringify(cand) + '\n' +
    '  基线 ' + JSON.stringify(base) + '\n' +
    '  胜 ' + wins + ' / 负 ' + losses + ' / 和 ' + draws +
    '   胜率 ' + ((wins / g) * 100).toFixed(1) + '%' +
    '   已分胜负里 ' + ((wins / decided) * 100).toFixed(1) + '%' +
    '   平均 ' + (turns / g).toFixed(0) + ' 回合\n' +
    '  地盘 ' + (candLand / g).toFixed(1) + ' vs ' + (baseLand / g).toFixed(1)
);

/*
 * 镜像局：同一个引擎打自己，双方交换先后手。
 *
 * 意义：胜率应该贴着 50%。偏离说明引擎对「先手」或「我方/对方」有系统性偏差
 * （例如先手能抢到中间的城、或者引擎在某一边的初始位置更好）。
 * 迷雾模式下跑，它就是「迷雾将军规则改了以后到底有没有变强」最干净的对照——
 * 参考 bot 在迷雾里太弱，打它们看不出引擎的进步。
 *
 * 运行：node scripts/mirror.js [种子数]
 *       node scripts/mirror.js 40
 */
'use strict';

const { playGame } = require('./arena.js');

const seeds = Number(process.argv[2] || 40);
// 默认真实迷雾；GB_FOG=0 才是作弊的全视野
const fog = process.env.GB_FOG !== '0';
let cfg = null;
if (process.env.GB_CFG) cfg = JSON.parse(process.env.GB_CFG);

let games = 0;
let wins = 0;
let losses = 0;
let draws = 0;
let turns = 0;
let land0 = 0;
let land1 = 0;

for (let s = 0; s < seeds; s++) {
  const seed = 1000 + s * 7919;
  for (const side of [0, 1]) {
    const r = playGame(seed, 'engine', 1, 1, side, false, cfg, { fog });
    if (!r) continue;
    games++;
    turns += r.turns;
    land0 += r.ourLand;
    land1 += r.enemyLand;
    if (r.winner < 0) draws++;
    else if (r.winner === side) wins++;
    else losses++;
  }
}

const g = games || 1;
console.log(
  '镜像局（' + (fog ? '迷雾' : '全视野') + '）' + games + ' 局：胜 ' + wins + ' / 负 ' + losses + ' / 和 ' + draws +
    '，胜率 ' + ((wins / g) * 100).toFixed(1) + '%' +
    '，和棋率 ' + ((draws / g) * 100).toFixed(1) + '%' +
    '，平均 ' + (turns / g).toFixed(0) + ' 回合，' +
    '我方地 ' + (land0 / g).toFixed(1) + ' vs ' + (land1 / g).toFixed(1)
);
if (cfg) console.log('引擎参数：' + JSON.stringify(cfg));

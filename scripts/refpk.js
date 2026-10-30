/*
 * 参考 bot 互打：判断一个移植「本身有多强」，而不是「对本引擎赢多少」。
 *
 *   node scripts/refpk.js eklipz gc 40
 *   GB_FOG=0 node scripts/refpk.js eklipz gc 20     （全视野对照）
 *
 * 两边都是参考 bot，每回合各 1 步，种子和先手都对称抵消。
 * 输出 A 的胜/负/和、平均回合、终局地盘与兵力。
 */
'use strict';

const { playGame } = require('./arena.js');

const a = process.argv[2];
const b = process.argv[3] || 'gc';
const seeds = Number(process.argv[4] || 20);
const fog = process.env.GB_FOG !== '0';

if (!a) {
  console.error("用法：node scripts/refpk.js <A> [B=gc] [seeds=20]");
  process.exit(2);
}

const acc = { games: 0, wins: 0, losses: 0, draws: 0, turns: 0, aLand: 0, bLand: 0, aArmy: 0, bArmy: 0 };

for (let s = 0; s < seeds; s++) {
  const seed = 1000 + s * 7919;
  for (const aSide of [0, 1]) {
    const r = playGame(seed, b, 1, 1, aSide, false, null, { fog: fog, refA: a });
    if (!r) continue;
    acc.games++;
    acc.turns += r.turns;
    acc.aLand += aSide === 0 ? r.ourLand : r.enemyLand;
    acc.bLand += aSide === 0 ? r.enemyLand : r.ourLand;
    acc.aArmy += aSide === 0 ? r.ourArmy : r.enemyArmy;
    acc.bArmy += aSide === 0 ? r.enemyArmy : r.ourArmy;
    if (r.winner < 0) acc.draws++;
    else if (r.winner === aSide) acc.wins++;
    else acc.losses++;
  }
}

const g = acc.games || 1;
console.log(
  a + ' vs ' + b + '（' + (fog ? '迷雾' : '全视野') + '，' + acc.games + ' 局）\n' +
    '  胜 ' + acc.wins + ' / 负 ' + acc.losses + ' / 和 ' + acc.draws +
    '，胜率 ' + ((acc.wins / g) * 100).toFixed(1) + '%\n' +
    '  平均回合 ' + (acc.turns / g).toFixed(0) +
    '，地盘 ' + (acc.aLand / g).toFixed(0) + ' vs ' + (acc.bLand / g).toFixed(0) +
    '，兵力 ' + (acc.aArmy / g).toFixed(0) + ' vs ' + (acc.bArmy / g).toFixed(0)
);

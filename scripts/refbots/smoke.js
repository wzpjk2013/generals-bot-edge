/*
 * 单个移植对手的冒烟测试：
 *   $env:GB_BOT='xrz'; node scripts/refbots/smoke.js 20
 *   GB_BOT=xrz GB_OPP=szly node scripts/refbots/smoke.js 20
 *
 * 打印 我方引擎 vs 该对手 的胜率、平均回合、终局地盘/兵力。
 * 用来判断「移植是否跑得动、强弱是否合理」——100% 和 0% 都说明移植有问题。
 */
'use strict';

const { runCell } = require('../arena.js');
const { makeRefAgent } = require('../refagents.js');

const name = process.env.GB_BOT;
const opp = process.env.GB_OPP || 'gc';
const seeds = Number(process.argv[2] || 20);
const fog = process.env.GB_FOG !== '0';

if (!name) {
  console.error('缺 GB_BOT：$env:GB_BOT=\'xrz\'; node scripts/refbots/smoke.js 20');
  process.exit(2);
}

// 先确认这个构造函数能造出来、能出第一步——不然 runCell 里只会静默变成 0 胜
let probe;
try {
  const agent = makeRefAgent(name, () => 0.5);
  const view = {
    w: 3,
    h: 3,
    armies: Int32Array.from([0, 0, 0, 0, 9, 0, 0, 0, 0]),
    owner: Int16Array.from([-1, -1, -1, -1, 0, -1, -1, -1, -1]),
    cities: new Uint8Array(9),
    mountains: new Uint8Array(9),
    generals: [4, -1],
    me: 0,
    general: 4
  };
  probe = agent.plan(view);
} catch (e) {
  console.error('构造或第一步就炸了：' + (e && e.stack));
  process.exit(1);
}
console.log('探针动作：' + JSON.stringify(probe));

const acc = runCell(name, 1, 1, seeds, null, { fog });
const g = acc.games || 1;
console.log(
  '\n' + name + ' vs 本引擎（' + (fog ? '迷雾' : '全视野') + '，' + acc.games + ' 局）\n' +
    '  引擎胜 ' + acc.wins + ' / 负 ' + acc.losses + ' / 和 ' + acc.draws +
    '，引擎胜率 ' + ((acc.wins / g) * 100).toFixed(1) + '%' +
    '，分出率 ' + (((acc.wins + acc.losses) / g) * 100).toFixed(1) + '%\n' +
    '  平均回合 ' + (acc.turns / g).toFixed(0) +
    '，终局地盘 ' + (acc.ourLand / g).toFixed(0) + ' vs ' + (acc.enemyLand / g).toFixed(0) +
    '，兵力 ' + (acc.ourArmy / g).toFixed(0) + ' vs ' + (acc.enemyArmy / g).toFixed(0) +
    '\n  引擎空转回合 ' + acc.idleTurns + '/局\n'
);

// 顺手对比同参数下 gc / szly 的位置，方便判断新对手是不是「真的强」
if (!process.env.GB_OPP && name !== opp) {
  const base = runCell(opp, 1, 1, seeds, null, { fog });
  const bg = base.games || 1;
  console.log('参照：' + opp + ' 同样 ' + base.games + ' 局，引擎胜率 ' + ((base.wins / bg) * 100).toFixed(1) + '%\n');
}

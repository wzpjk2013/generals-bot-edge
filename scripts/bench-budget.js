'use strict';
// 反事实实验：真实服务器每个半回合每个玩家只消费一条攻击，所以 >1 的预算
// 在正式对局里不可达。这个脚本只用来回答「如果每回合能下 N 条命令」会怎样，
// 数字不能当作对局胜率引用。
global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const arena = require('./arena.js');

const seeds = Number(process.argv[2] || 20);
const OPPONENTS = ['random', 'expander', 'hunter', 'harvester'];
const CELLS =
  process.argv[3] === 'sweep'
    ? [1, 2, 3, 4, 5, 6, 8].map((n) => ({ our: n, ref: 6 }))
    : [
        { our: 1, ref: 1 },
        { our: 1, ref: 6 },
        { our: 6, ref: 1 },
        { our: 6, ref: 6 },
        { our: 12, ref: 12 }
      ];

for (const c of CELLS) {
  let games = 0, wins = 0, turns = 0;
  const per = {};
  for (const opp of OPPONENTS) {
    let w = 0, g = 0, t = 0;
    for (const side of [0, 1]) {
      for (let s = 1; s <= seeds; s++) {
        const r = arena.playGame(s, opp, c.our, c.ref, side);
        g++;
        if (r.winner === side) w++;
        t += r.turns;
      }
    }
    per[opp] = { win: (w / g) * 100, turns: t / g };
    games += g;
    wins += w;
    turns += t;
  }
  const line = OPPONENTS.map(
    (o) => o + ' ' + per[o].win.toFixed(0).padStart(3) + '%'
  ).join('  ');
  console.log(
    ('our ' + c.our + ' / ref ' + c.ref).padEnd(16) +
      line +
      '   | 总 ' + ((wins / games) * 100).toFixed(1) + '%' +
      '  平均回合 ' + (turns / games).toFixed(0)
  );
}

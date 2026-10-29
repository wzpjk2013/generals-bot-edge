'use strict';
global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');
const arena = require('./arena.js');
const opp = process.argv[2] || 'hunter';
const seeds = Number(process.argv[3] || 20);
let idle = 0, turns = 0, wins = 0, g = 0;
for (let s = 1; s <= seeds; s++) {
  for (const side of [0, 1]) {
    const r = arena.playGame(s, opp, 1, 1, side);
    if (!r) continue;
    g++; turns += r.turns; idle += r.idleTurns;
    if (r.winner === side) wins++;
  }
}
console.log(opp, 'games', g, 'win%', ((wins/g)*100).toFixed(1), 'avgTurns', (turns/g).toFixed(0), 'idleTurns', idle, 'idleRate', ((idle/turns)*100).toFixed(1) + '%');

'use strict';
global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');
const arena = require('./arena.js');

const opp = process.argv[2] || 'hunter';
const seeds = Number(process.argv[3] || 40);
const losses = [];
for (let s = 1; s <= seeds; s++) {
  for (const side of [0, 1]) {
    const r = arena.playGame(s, opp, 1, 1, side);
    if (r.winner !== side) losses.push({ s, side, turns: r.turns, ourLand: r.ourLand, enemyLand: r.enemyLand, ourArmy: r.ourArmy, enemyArmy: r.enemyArmy });
  }
}
console.log('losses', losses.length, 'of', seeds * 2);
for (const l of losses.slice(0, 20)) console.log(JSON.stringify(l));

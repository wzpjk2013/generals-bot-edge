'use strict';
global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');
const arena = require('./arena.js');

const seed = Number(process.argv[2] || 3);
const opp = process.argv[3] || 'hunter';
const r = arena.playGame(seed, opp, 1, 1, 0, true);
console.log('RESULT', JSON.stringify(r));

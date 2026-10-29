'use strict';
/*
 * 打一局并逐回合打印我方出子，用来肉眼检查玩法问题（集兵/来回搬/将军单推）。
 *
 *   node scripts/trace-game.js gc 7 0        # 对手 gc、种子下标 7、我方坐 0 号位
 *   node scripts/trace-game.js oim 3 1 600   # 只看前 600 回合
 */
const { playGame } = require('./arena.js');

const opp = process.argv[2] || 'gc';
const seed = 1000 + Number(process.argv[3] || 0) * 7919;
const side = Number(process.argv[4] || 0);
const cfg = process.env.GB_CFG ? JSON.parse(process.env.GB_CFG) : undefined;
const r = playGame(seed, opp, 1, 1, side, true, cfg, { fog: process.env.GB_FOG !== '0' });
console.log('结果：' + (r.winner < 0 ? '和' : r.winner === side ? '胜' : '负') + '，' + r.turns + ' 回合');

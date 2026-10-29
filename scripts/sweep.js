/*
 * 参数扫描：对指定的强对手跑一组单变量配置，输出胜率对照。
 *
 * 打弱对手（random / expander）时任何参数都「能赢」，所以扫描要对着打不过的对手做。
 * 默认扫 gc 和 szly（LocalGen-new 的两个 bot，见 refagents.js）。
 *
 * 运行：
 *   node scripts/sweep.js                     # 默认 20 种子，扫 gc / szly
 *   node scripts/sweep.js 40 gc              # 40 种子，只扫 gc
 *   GB_SWEEP='{"genWeight":0.1},{"genWeight":0.35}' node scripts/sweep.js
 */
'use strict';

const { playGame } = require('./arena.js');

const seeds = Number(process.argv[2] || 20);
const opps = process.argv[3] ? process.argv[3].split(',') : ['gc', 'szly'];
const fog = process.env.GB_FOG !== '0';

const CFGS = process.env.GB_SWEEP
  ? JSON.parse('[' + process.env.GB_SWEEP + ']')
  : [
      {},
      { genWeight: 0.1 },
      { genWeight: 0.35 },
      { genSendMin: 4 },
      { genSendMin: 10 },
      { genSafe: 1 },
      { genSafe: 3 },
      { killRatio: 1.2 },
      { killRatio: 2.0 },
      { purge: false },
      { memTtl: 15 },
      { memTtl: 80 }
    ];

function runCell(opp, cfg) {
  let g = 0;
  let w = 0;
  let l = 0;
  let d = 0;
  let t = 0;
  for (let s = 0; s < seeds; s++) {
    const seed = 1000 + s * 7919;
    for (const side of [0, 1]) {
      const r = playGame(seed, opp, 1, 1, side, false, cfg, { fog });
      if (!r) continue;
      g++;
      t += r.turns;
      if (r.winner < 0) d++;
      else if (r.winner === side) w++;
      else l++;
    }
  }
  return { g, w, l, d, t };
}

for (const opp of opps) {
  console.log('\n== 对手 ' + opp + '（' + (fog ? '迷雾' : '全视野') + '，每格 ' + seeds * 2 + ' 局）==');
  for (const cfg of CFGS) {
    const r = runCell(opp, cfg);
    const g = r.g || 1;
    console.log(
      '  ' + JSON.stringify(cfg).padEnd(28) +
        ' 胜 ' + String(r.w).padStart(4) +
        ' 负 ' + String(r.l).padStart(4) +
        ' 和 ' + String(r.d).padStart(3) +
        ' 胜率 ' + ((r.w / g) * 100).toFixed(1).padStart(5) + '%' +
        ' 平均 ' + (r.t / g).toFixed(0).padStart(4) + ' 回合'
    );
  }
}

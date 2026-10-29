/*
 * A/B：老的「推土机」（选一个目标，把最厚的一堆往前推）vs 新的分层最大流输送。
 *
 * 两个场景：
 *   closed  我方一片地被山围死，只留三个口子顶着 40 兵的硬骨头。阶段 C 头几十
 *           回合一步都吃不了，全靠输兵往前线灌。这是把输兵能力单独拎出来量的场景。
 *           指标：三块硬骨头各自被打穿的回合数（越快越好，三个都在打最好）。
 *   open    32x32 常规散山开局，看输送器会不会拖慢或搞乱正常扩张。
 *
 * 运行：node scripts/bench-ab.js
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const GB = global.window.__GB;
const T = GB.TILE;
// 每回合只有 1 条命令，所以回合预算要给足，否则大图根本走不完。
const TURNS = 600;

function buildClosed() {
  const w = 24;
  const h = 24;
  const n = w * h;
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(T.MOUNTAIN);
  const idx = (y, x) => y * w + x;

  // 我方 8x16 的封闭区域
  for (let y = 8; y <= 15; y++) {
    for (let x = 4; x <= 19; x++) {
      const i = idx(y, x);
      terrain[i] = 0;
      armies[i] = 1 + ((x + y) % 3);
    }
  }
  armies[idx(8, 4)] = 1; // 将军
  const enemies = [idx(8, 3), idx(7, 8), idx(16, 12)];
  for (const i of enemies) {
    terrain[i] = 1;
    armies[i] = 400;
  }
  return { w, h, n, armies, terrain, generals: [idx(8, 4), enemies[0]], targets: enemies };
}

function buildOpen() {
  const w = 32;
  const h = 32;
  const n = w * h;
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(T.EMPTY);
  for (let i = 0; i < n; i++) if (rnd() < 0.1) terrain[i] = T.MOUNTAIN;
  const enemies = [3 * w + 20, 26 * w + 6, 28 * w + 24];
  for (const i of enemies) {
    terrain[i] = 1;
    armies[i] = 40;
  }
  for (let y = 2; y < 12; y++) {
    for (let x = 2; x < 12; x++) {
      const i = y * w + x;
      if (terrain[i] === T.MOUNTAIN) continue;
      terrain[i] = 0;
      armies[i] = 1 + ((x + y) % 3);
    }
  }
  return { w, h, n, armies, terrain, generals: [2 * w + 2, 11 * w + 11], targets: enemies };
}

function run(scn, useFlow) {
  const S = new GB.GameState();
  S.applyStart({
    playerIndex: 0,
    generals: scn.generals,
    cities: [],
    usernames: ['me', 'enemy'],
    map: [scn.w, scn.h, ...scn.armies, ...scn.terrain],
    game_type: 'custom'
  });

  const flowMod = GB.flow;
  if (!useFlow) GB.flow = null;

  const targets = scn.targets;
  const captured = new Int32Array(targets.length).fill(-1);
  let totalMoves = 0;
  const t0 = process.hrtime.bigint();
  for (let turn = 0; turn < TURNS; turn++) {
    S.turn = turn;
    const moves = GB.bot.plan(S, { maxMoves: 1 });
    totalMoves += moves.length;
    for (const m of moves) {
      const from = m[0];
      const to = m[1];
      const a = S.armies[from];
      // 并兵（落点还是我的）加法，打敌人减法
      S.armies[to] = S.terrain[to] === 0 ? a - 1 + S.armies[to] : a - 1 - S.armies[to];
      S.armies[from] = 0;
      S.terrain[to] = 0;
    }
    for (let i = 0; i < scn.n; i++) if (S.terrain[i] === 0) S.armies[i] += 1;
    for (let k = 0; k < targets.length; k++) {
      if (captured[k] < 0 && S.terrain[targets[k]] === 0) captured[k] = turn;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  GB.flow = flowMod;

  let owned = 0;
  for (let i = 0; i < scn.n; i++) if (S.terrain[i] === 0) owned++;
  return { ms, totalMoves, captured, owned };
}

function compare(title, scn) {
  const a = run(scn, false);
  const b = run(scn, true);
  console.log('\n== ' + title + ' ==');
  const row = (label, x, y) =>
    console.log('  ' + label.padEnd(10) + String(x).padStart(12) + String(y).padStart(12));
  console.log('  ' + ''.padEnd(10) + '推土机'.padStart(10) + '  最大流');
  for (let k = 0; k < scn.targets.length; k++) {
    const fmt = (t) => (t < 0 ? '未打穿' : t + ' 回合');
    row('硬骨头 ' + (k + 1), fmt(a.captured[k]), fmt(b.captured[k]));
  }
  row('总走子', a.totalMoves, b.totalMoves);
  row('领地', a.owned + '/' + scn.n, b.owned + '/' + scn.n);
  row('ms/回合', (a.ms / TURNS).toFixed(2), (b.ms / TURNS).toFixed(2));
  return b.ms / TURNS;
}

const slowest = Math.max(
  compare('closed：围死的三个口子（只考输兵）', buildClosed()),
  compare('open：32x32 常规开局', buildOpen())
);

if (slowest > 16) {
  console.log('\nFAIL: 单回合决策超过 16ms');
  process.exitCode = 1;
} else {
  console.log('\nOK  最慢 ' + slowest.toFixed(2) + ' ms/回合');
}

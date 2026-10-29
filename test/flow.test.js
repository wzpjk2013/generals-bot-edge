/*
 * 输送器（分层最大流）回归：走廊 / 双前线分流 / 绕山 / 合法性 / 不动将军。
 * 运行：node test/flow.test.js
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const assert = require('node:assert/strict');
const GB = global.window.__GB;
const T = GB.TILE;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  FAIL ' + name);
    console.log('       ' + e.message);
    process.exitCode = 1;
  }
}

/** 直接构造 bot 的上下文，绕过 GameState，便于逐格控制 */
function mkCtx(w, h, tiles, opts = {}) {
  const n = w * h;
  const owner = new Int16Array(n).fill(T.EMPTY);
  const armies = new Int32Array(n).fill(0);
  for (const key of Object.keys(tiles)) {
    const i = Number(key);
    const spec = tiles[key];
    if (spec.mountain) {
      owner[i] = T.MOUNTAIN;
      continue;
    }
    if (spec.owner !== undefined) owner[i] = spec.owner;
    if (spec.army !== undefined) armies[i] = spec.army;
  }
  const nbr = GB.bot.neighbors({ w, h, n });
  const moves = [];
  const used = new Set();
  const ctx = {
    n,
    w,
    h,
    nbr,
    owner,
    armies,
    pid: opts.pid ?? 0,
    budget: opts.budget ?? 6,
    myGeneral: opts.myGeneral ?? -1,
    moves: () => moves,
    move(from, to, why) {
      if (moves.length >= ctx.budget) return false;
      if (used.has(from)) return false;
      if (owner[from] !== ctx.pid) return false;
      if (!GB.flow.isPassable(owner, to)) return false;
      const a = armies[from];
      if (a < 2) return false;
      const own = owner[to] === ctx.pid;
      if (!own && a - 1 <= armies[to]) return false;
      armies[to] = own ? a - 1 + armies[to] : a - 1 - armies[to];
      armies[from] = 0;
      owner[to] = ctx.pid;
      used.add(from);
      moves.push([from, to, why]);
      return true;
    }
  };
  return ctx;
}

function validate(moves, ctx, budget) {
  const seen = new Set();
  for (const [from, to] of moves) {
    assert.ok(from >= 0 && from < ctx.n, '源格越界 ' + from);
    assert.ok(to >= 0 && to < ctx.n, '目标越界 ' + to);
    assert.ok(!seen.has(from), '同一格一回合动两次: ' + from);
    seen.add(from);
    assert.ok(ctx.nbr[from].includes(to), '不是邻居: ' + from + '>' + to);
  }
  assert.ok(moves.length <= budget, '超出预算 ' + moves.length);
}

/* ---------- 1. 走廊：兵在 0，目标在右下 ---------- */
check('走廊把兵推到前沿', () => {
  // 6x1 走廊：0..4 我方，5 是敌人
  const ctx = mkCtx(6, 1, {
    0: { owner: 0, army: 30 },
    1: { owner: 0, army: 2 },
    2: { owner: 0, army: 2 },
    3: { owner: 0, army: 2 },
    4: { owner: 0, army: 2 },
    5: { owner: 1, army: 3 }
  });
  const res = GB.flow.plan(ctx);
  assert.ok(res.stats.flow > 0, '应该有流量，实际 ' + res.stats.flow);
  assert.ok(res.moves.length > 0, '应该有走子');
  validate(res.moves, ctx, ctx.budget);
  // 最靠前的运输格（4 的下一跳是前沿 4 自身；先看 3->4）
  const first = res.moves[0];
  assert.equal(first[1] - first[0], 1, '应该朝前沿方向推，实际 ' + first[0] + '>' + first[1]);
});

/* ---------- 2. 双前线：一条走廊两头都是缺口，兵应该两边都送 ---------- */
check('两个缺口各分到兵', () => {
  // 7x3，上下两排全是山，只剩中间一条 1 格的走廊
  //  0(敌,5) 1(我,2) 2(我,30) 3(我,2) 4(我,2) 5(我,2) 6(敌,5)
  const tiles = {
    0: { owner: 1, army: 5 },
    1: { owner: 0, army: 2 },
    2: { owner: 0, army: 30 },
    3: { owner: 0, army: 2 },
    4: { owner: 0, army: 2 },
    5: { owner: 0, army: 2 },
    6: { owner: 1, army: 5 }
  };
  for (let x = 0; x < 7; x++) {
    tiles[7 + x] = { mountain: true };
    tiles[14 + x] = { mountain: true };
  }
  const ctx = mkCtx(7, 3, tiles);
  const res = GB.flow.plan(ctx);
  assert.ok(res.stats.flow > 0, '应该有流量');
  validate(res.moves, ctx, ctx.budget);
  const left = res.moves.some(([f, t]) => t < f);
  const right = res.moves.some(([f, t]) => t > f);
  assert.ok(left && right, '两边都该被喂到，实际 ' + JSON.stringify(res.moves));
});

/* ---------- 3. 绕山 ---------- */
check('山挡住直路时绕行', () => {
  // 3x3:
  //  0(我,20) 1(山) 2(前沿)      <- 上排 1 是山
  //  3(我,2)  4(我,2) 5(前沿)
  //  6 7 8 敌人
  const ctx = mkCtx(3, 3, {
    0: { owner: 0, army: 20 },
    1: { mountain: true },
    3: { owner: 0, army: 2 },
    4: { owner: 0, army: 2 },
    6: { owner: 1, army: 1 },
    7: { owner: 1, army: 1 },
    8: { owner: 1, army: 1 }
  });
  const res = GB.flow.plan(ctx);
  assert.ok(res.stats.flow > 0, '应该有流量');
  validate(res.moves, ctx, ctx.budget);
  for (const [from, to] of res.moves) {
    assert.notEqual(to, 1, '不许推进山里');
  }
  // 0 号格不能直接打 2（不邻接），只能经 3/4 绕
  for (const [from] of res.moves) assert.notEqual(from, 2, '前沿格不该被当作源');
});

/* ---------- 4. 将军不搬兵 ---------- */
check('将军格不参与运输', () => {
  const ctx = mkCtx(6, 1, {
    0: { owner: 0, army: 40 },
    1: { owner: 0, army: 2 },
    2: { owner: 0, army: 2 },
    3: { owner: 0, army: 2 },
    4: { owner: 1, army: 2 }
  }, { myGeneral: 0 });
  const res = GB.flow.plan(ctx);
  for (const [from] of res.moves) assert.notEqual(from, 0, '将军不该出兵');
});

/* ---------- 5. 没有前沿就没有流量 ---------- */
check('无前沿时零流量', () => {
  const ctx = mkCtx(3, 1, {
    0: { owner: 0, army: 9 },
    1: { owner: 0, army: 9 },
    2: { owner: 0, army: 9 }
  });
  const res = GB.flow.plan(ctx);
  assert.equal(res.stats.flow, 0);
  assert.equal(res.moves.length, 0);
});

/* ---------- 6. 只有 1 兵的格子不发兵 ---------- */
check('一格兵不发兵', () => {
  const ctx = mkCtx(3, 1, {
    0: { owner: 0, army: 1 },
    1: { owner: 0, army: 1 },
    2: { owner: 1, army: 5 }
  });
  const res = GB.flow.plan(ctx);
  assert.equal(res.moves.length, 0, '兵不够时不该动');
});

/* ---------- 7. 流量受缺口与预算双重约束 ---------- */
check('流量不超过缺口总量，走子不超过预算', () => {
  const tiles = {
    0: { owner: 1, army: 5 },
    1: { owner: 0, army: 2 },
    2: { owner: 0, army: 30 },
    3: { owner: 0, army: 2 },
    4: { owner: 0, army: 2 },
    5: { owner: 0, army: 2 },
    6: { owner: 1, army: 5 }
  };
  for (let x = 0; x < 7; x++) {
    tiles[7 + x] = { mountain: true };
    tiles[14 + x] = { mountain: true };
  }
  const ctx = mkCtx(7, 3, tiles, { budget: 1 });
  const res = GB.flow.plan(ctx);
  assert.ok(res.stats.flow <= res.stats.demand, 'flow ' + res.stats.flow + ' > demand ' + res.stats.demand);
  assert.equal(res.moves.length, 1, '预算 1 只该出一条');
  // 贴着前沿的（d=1）先走，而且是流量最大的那条
  assert.equal(res.moves[0][0], 2, '该从流量最大的 d=1 格出兵，实际 from=' + res.moves[0][0]);
  assert.equal(res.moves[0][1], 1, '应该朝缺口走，实际 to=' + res.moves[0][1]);
});

/* ---------- 8. 整局跑：不产生非法走子 ---------- */
check('合成对局中走子合法', () => {
  const w = 9;
  const h = 9;
  const n = w * h;
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(T.EMPTY);
  const cities = [30];
  // 我方一大片
  for (let i = 0; i < n; i++) {
    if (i % w < 4) {
      terrain[i] = 0;
      armies[i] = 3 + (i % 5);
    } else if (i % w > 6) {
      terrain[i] = 1;
      armies[i] = 4;
    }
  }
  armies[0] = 1;
  const S = new GB.GameState();
  S.applyStart({
    playerIndex: 0,
    generals: [0, n - 1],
    cities,
    map: [w, h, ...armies, ...terrain],
    game_type: 'custom'
  });
  S.turn = 5;
  for (let t = 0; t < 12; t++) {
    const moves = GB.bot.plan(S, { maxMoves: 6 });
    // 在本地乐观副本上回放，验证每一步在“轮到它时”都是合法的
    const owner = Int16Array.from(S.terrain);
    const army = Int32Array.from(S.armies);
    const seen = new Set();
    for (const [from, to] of moves) {
      assert.ok(owner[from] === 0, '源格不是我的: ' + from + '（第 ' + t + ' 回合）');
      assert.ok(!seen.has(from), '重复出兵: ' + from);
      seen.add(from);
      assert.ok(GB.bot.neighbors(S)[from].includes(to), '不是邻居 ' + from + '>' + to);
      const merge = owner[to] === 0;
      if (!merge) assert.ok(army[from] - 1 > army[to], '兵力不足 ' + from + '>' + to);
      army[to] = merge ? army[from] - 1 + army[to] : army[from] - 1 - army[to];
      army[from] = 0;
      owner[to] = 0;
    }
  }
});

console.log('\n' + passed + ' passed');
if (process.exitCode) console.log('有失败项');

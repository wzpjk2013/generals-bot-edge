/*
 * 决策引擎离线回归：不依赖浏览器，直接喂合成地图。
 * 运行：node test/bot.test.js
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const assert = require('node:assert/strict');
const GB = global.window.__GB;
const T = GB.TILE;

/** tiles: { index: { owner: 0|1..., army: n, city: bool } } */
function makeMap(w, h, tiles) {
  const n = w * h;
  const armies = new Array(n).fill(0);
  const terrain = new Array(n).fill(T.EMPTY);
  for (const key of Object.keys(tiles)) {
    const i = Number(key);
    const spec = tiles[key];
    if (spec.owner !== undefined) terrain[i] = spec.owner;
    if (spec.army !== undefined) armies[i] = spec.army;
    if (spec.mountain) terrain[i] = T.MOUNTAIN;
  }
  return [w, h, ...armies, ...terrain];
}

function makeState(w, h, tiles, opts = {}) {
  const S = new GB.GameState();
  const cities = [];
  for (const key of Object.keys(tiles)) {
    if (tiles[key].city) cities.push(Number(key));
  }
  S.applyStart({
    playerIndex: opts.playerIndex ?? 0,
    generals: opts.generals ?? [-1],
    cities,
    map: makeMap(w, h, tiles),
    game_type: 'custom'
  });
  S.turn = opts.turn ?? 10;
  return S;
}

function delta(oldArr, newArr) {
  if (!oldArr || oldArr.length !== newArr.length) return [0, newArr.length].concat(newArr);
  const out = [];
  let same = 0;
  let i = 0;
  while (i < newArr.length) {
    if (oldArr[i] === newArr[i]) {
      same++;
      i++;
      continue;
    }
    let changed = 0;
    const vals = [];
    while (i < newArr.length && oldArr[i] !== newArr[i]) {
      changed++;
      vals.push(newArr[i]);
      i++;
    }
    out.push(same, changed, ...vals);
    same = 0;
  }
  out.push(same);
  return out;
}

/** 严格校验一条 move 是否满足游戏规则与「一格一回合一次」 */
function validate(S, moves) {
  const armies = Array.from(S.armies);
  const own = Array.from(S.terrain);
  const used = new Set();
  for (const [from, to] of moves) {
    assert.ok(Number.isInteger(from) && Number.isInteger(to), '非法下标');
    assert.ok(from >= 0 && from < S.n && to >= 0 && to < S.n, '越界');
    assert.equal(own[from], S.playerIndex, '从非我方格出兵: ' + from);
    assert.ok(!used.has(from), '同一格动了两次: ' + from);
    assert.ok(armies[from] >= 2, '一格兵不能动: ' + from);
    assert.notEqual(own[to], GB.TILE.MOUNTAIN, '打进山里');
    const merge = own[to] === S.playerIndex;
    // 并兵永远合法；打别人的格子才要求打得过
    if (!merge) assert.ok(armies[from] - 1 > armies[to], '兵力不足: ' + from + '>' + to);
    used.add(from);
    armies[to] = merge ? armies[from] - 1 + armies[to] : armies[from] - 1 - armies[to];
    armies[from] = 0;
    own[to] = S.playerIndex;
  }
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

console.log('state:');

test('串行化地图解析', () => {
  const S = makeState(3, 1, { 0: { owner: 0, army: 7 } }, { generals: [0] });
  assert.equal(S.w, 3);
  assert.equal(S.n, 3);
  assert.equal(S.armies[0], 7);
  assert.equal(S.terrain[0], 0);
  assert.equal(S.terrain[1], T.EMPTY);
  assert.equal(S.ready, true);
});

test('地图增量还原与官方 delta 编码一致', () => {
  const S = makeState(4, 1, { 0: { owner: 0, army: 7 } });
  const before = S.raw.slice();
  const after = before.slice();
  after[2] = 3;
  after[2 + 4 + 1] = 0;
  S.applyUpdate({ map_diff: delta(before, after), turn: 11 });
  assert.deepEqual(Array.from(S.raw), after);
  assert.equal(S.armies[0], 3);
  assert.equal(S.terrain[1], 0);
});

test('cities_diff 还原', () => {
  const S = makeState(4, 1, { 2: { city: true } });
  assert.deepEqual(S.cities, [2]);
  S.applyUpdate({ cities_diff: delta(S.rawCities, [2, 3]), turn: 12 });
  assert.deepEqual(S.cities, [2, 3]);
});

console.log('bot:');

test('空地扩张（沿路径推进）', () => {
  // 将军要攒到 GENERAL_SEND_MIN(6) 才出门，哪怕目标是空地：每回合抽 1 兵会让
  // 主纵队的链条每格永远卡着 1 兵，兵到不了前沿。
  const S = makeState(3, 1, { 0: { owner: 0, army: 6 } }, { generals: [0] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.ok(moves.length >= 1);
  assert.deepEqual(moves[0].slice(0, 2), [0, 1]);
  assert.equal(moves[0][2], 0, '默认只送 a-1（is50=0）：协议给的两种送法里这个在镜像 A/B 里更强');
  validate(S, moves);
});

test('将军没攒够就不出门（中期门槛 6）', () => {
  // 中期（turn >= PHASE_EARLY=50）将军要攒到 genSendMin(6) 才出门
  const S = makeState(3, 1, { 0: { owner: 0, army: 5 } }, { generals: [0], turn: 60 });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.equal(moves.length, 0);
});

test('早期将军门槛只有 3：不空等', () => {
  // 开局前 50 tick 除了将军没有兵源，凑 6 兵要 10 个 tick，那 10 手全是空过。
  // genSendEarly=3 让它在 3 兵就出门，一次送 2 个（不是一滴一滴挤）。
  const S = makeState(3, 1, { 0: { owner: 0, army: 3 } }, { generals: [0], turn: 4 });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.ok(moves.length >= 1, '早期 3 兵就该出门');
  assert.equal(moves[0][0], 0);
});

test('优先吃城市', () => {
  // 1 是我方(10)，0 空地，2 城市(守军 3)
  const S = makeState(3, 1, { 1: { owner: 0, army: 10 }, 2: { city: true, army: 3 } });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.deepEqual(moves[0].slice(0, 2), [1, 2]);
  validate(S, moves);
});

test('打不过就不打', () => {
  const S = makeState(2, 1, { 0: { owner: 0, army: 3 }, 1: { city: true, army: 40 } });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.ok(moves.every((m) => m[1] !== 1), '不应硬碰 40 守军');
});

test('敌方将军贴脸直接斩首', () => {
  const S = makeState(2, 1, {
    0: { owner: 0, army: 10 },
    1: { owner: 1, army: 4 }
  }, { generals: [0, 1] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.deepEqual(moves[0].slice(0, 2), [0, 1]);
  assert.equal(moves[0][2], 0, '斩首要整队打出去，不能只送一半');
});

test('将军打不过就守，不乱送', () => {
  const S = makeState(2, 1, {
    0: { owner: 0, army: 2 },
    1: { owner: 1, army: 5 }
  }, { generals: [0, 1] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.equal(moves.length, 0);
});

test('将军被围时邻居代打', () => {
  const S = makeState(3, 1, {
    0: { owner: 1, army: 5 },
    1: { owner: 0, army: 1 },
    2: { owner: 0, army: 30 }
  }, { generals: [1, 0] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.ok(moves.some((m) => m[1] === 0), '应吃掉贴脸的敌人: ' + JSON.stringify(moves));
});

test('将军对面压着绝对优势兵力时不白送兵', () => {
  // 7x1 直线走廊，尽头 100 兵。10 兵冲上去只是给对面喂兵，
  // 有效动作只能是我方内部并兵，不能有任何一个格子朝敌方 6 号格走。
  const tiles = {};
  for (let i = 0; i < 6; i++) tiles[i] = { owner: 0, army: i === 0 ? 10 : 1 };
  tiles[6] = { owner: 1, army: 100 };
  const S = makeState(7, 1, tiles, { generals: [0] });
  const moves = GB.bot.plan(S, { maxMoves: 1 });
  validate(S, moves);
  assert.ok(!moves.some((m) => m[1] === 6), '不该白送: ' + JSON.stringify(moves));
});

test('打不动城市时把兵朝城市汇集', () => {
  // 7x7：第一行是我方走廊，9 号是 40 兵的城市。打不动，但兵要朝那个方向流。
  const tiles = {};
  for (let i = 0; i < 7; i++) tiles[i] = { owner: 0, army: i === 0 ? 6 : 1 };
  tiles[9] = { city: true, army: 40 };
  const S = makeState(7, 7, tiles, { generals: [0] });
  const moves = GB.bot.plan(S, { maxMoves: 1 });
  validate(S, moves);
  assert.ok(moves.length > 0, '应该把兵往城市方向推: ' + JSON.stringify(moves));
  assert.ok(
    moves.some((m) => m[0] === 0),
    '该由最肥的 0 号格出兵: ' + JSON.stringify(moves)
  );
});

test('绕山走：直线被山挡时从另一侧包过去', () => {
  // 3x3，我方在 0，目标 2 被 1 号山隔开，只能 0->3->4->5->2
  const tiles = {
    0: { owner: 0, army: 30 },
    1: { mountain: true },
    3: { owner: 0, army: 1 },
    4: { owner: 0, army: 1 },
    5: { owner: 0, army: 1 },
    2: { city: true, army: 2 }
  };
  const S = makeState(3, 3, tiles, { generals: [0] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  validate(S, moves);
  assert.ok(moves.length > 0);
});

test('同代价时让兵最多的格出兵，将军不当苦力', () => {
  const S = makeState(3, 1, {
    0: { owner: 0, army: 5 },
    1: { owner: 0, army: 200 },
    2: {}
  }, { generals: [0] });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  assert.ok(moves.length > 0);
  assert.equal(moves[0][0], 1, '应由 1 号格出兵: ' + JSON.stringify(moves));
});

test('预算上限生效', () => {
  const tiles = {};
  for (let i = 0; i < 25; i++) tiles[i] = { owner: 0, army: 100 };
  const S = makeState(5, 5, tiles);
  const moves = GB.bot.plan(S, { maxMoves: 2 });
  assert.ok(moves.length <= 2, '步数应 <= 2, 实际 ' + moves.length);
});

test('同一格一回合只动一次', () => {
  const S = makeState(5, 1, { 0: { owner: 0, army: 100 }, 1: { owner: 0, army: 1 } });
  const moves = GB.bot.plan(S, { maxMoves: 6 });
  const froms = moves.map((m) => m[0]);
  assert.equal(new Set(froms).size, froms.length, '重复出兵: ' + JSON.stringify(moves));
});

test('全空局：多回合稳定推进且始终合法', () => {
  const S = makeState(8, 8, { 9: { owner: 0, army: 12 } }, { generals: [9] });
  for (let t = 0; t < 20; t++) {
    const moves = GB.bot.plan(S, { maxMoves: 6 });
    validate(S, moves);
    // 把走子效果写回，模拟服务器回合推进
    for (const [from, to] of moves) {
      S.armies[to] = S.armies[from] - 1 - S.armies[to];
      S.armies[from] = 0;
      S.terrain[to] = 0;
    }
    for (let i = 0; i < S.n; i++) if (S.terrain[i] === 0) S.armies[i] += 1;
    S.turn++;
  }
  let owned = 0;
  for (let i = 0; i < S.n; i++) if (S.terrain[i] === 0) owned++;
  assert.ok(owned > 1, '20 回合应有扩张, 实际 ' + owned);
});

console.log('\n' + passed + ' passed');

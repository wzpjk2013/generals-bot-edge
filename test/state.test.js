/*
 * 状态还原回归：服务器到底发什么、我们能不能把它拼回来。
 *
 * 这几条是从一次真机事故里长出来的：面板上「事件 174 / 决策 0 / 未开局」——
 * 包全收到了，但状态永远 ready 不了，一回合都没决策。
 * 原因是 game_start **不带 map**，地图只出现在第一个 game_update 的 map_diff 里，
 * 而首帧的 diff 按 delta() 的约定就是全量编码 [0, len, ...]；我们当初要求「有 base 才 patch」，
 * 于是首帧被丢掉、之后每帧都是相对上一帧的增量，永远拼不出第一张图。
 *
 * 运行：node test/state.test.js
 */
'use strict';

global.window = global;
require('../src/state.js');

const assert = require('node:assert/strict');
const GB = global.window.__GB;

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

/** 官方 bundle 里的 y.delta（照抄，用来造"服务器会发的那种包"） */
function delta(t, e) {
  if (!t || t.length !== e.length) return [0, e.length].concat(e);
  var n = [],
    r = true,
    i = 0;
  for (var o = 0; o < e.length; o++) {
    if (r && t[o] !== e[o]) {
      n.push(i);
      i = 0;
      r = false;
    } else if (!r && t[o] === e[o]) {
      n.push(i);
      Array.prototype.push.apply(n, e.slice(o - i, o));
      r = true;
      i = 0;
    }
    i++;
  }
  n.push(i);
  if (!r) Array.prototype.push.apply(n, e.slice(e.length - i));
  return n;
}

function serialized(w, h, armies, terrain) {
  return [w, h].concat(armies, terrain);
}

function applyDelta(oldRaw, raw) {
  return GB.patchArray(oldRaw, delta(oldRaw, raw));
}

const W = 5;
const H = 4;
const N = W * H;

check('patchArray：old 为空时吃下全量编码（= 首帧 map_diff）', () => {
  const raw = serialized(W, H, new Array(N).fill(3), new Array(N).fill(-1));
  const diff = delta(null, raw);
  assert.deepEqual(diff.slice(0, 2), [0, raw.length], '旧实现要求的全量编码形状变了');
  const out = GB.patchArray(null, diff);
  assert.deepEqual(out, raw);
});

check('patchArray：有 base 时只搬变化段', () => {
  const a = serialized(W, H, new Array(N).fill(0), new Array(N).fill(-1));
  const b = a.slice();
  b[2 + 7] = 42; // 第 7 格兵数变了
  const out = GB.patchArray(a, delta(a, b));
  assert.deepEqual(out, b);
});

check('patchArray：diff 为空 / null 时不炸', () => {
  assert.equal(GB.patchArray([1, 2], null), null);
  assert.equal(GB.patchArray(null, []), null);
});

check('game_start 不带 map：ready 仍然是 false（这是对的，别急着报运行中）', () => {
  const S = new GB.GameState();
  // 服务器真实字段：playerIndex / usernames / teams / game_type / options，没有 map
  S.applyStart({
    playerIndex: 1,
    playerColors: [0, 1],
    usernames: ['me', 'them'],
    teams: [0, 1],
    game_type: 'custom',
    options: { modifiers: [] }
  });
  assert.equal(S.started, true);
  assert.equal(S.playerIndex, 1);
  assert.equal(S.ready, false, 'game_start 里没有 map，不能 ready');
  assert.equal(S.n, 0);
});

check('第一个 game_update 的 map_diff 就是全量：拼得出来才 ready', () => {
  const S = new GB.GameState();
  S.applyStart({ playerIndex: 0, usernames: ['a', 'b'], teams: [0, 1], game_type: 'custom' });

  const armies = new Array(N).fill(0);
  const terrain = new Array(N).fill(-1);
  armies[6] = 10;
  terrain[6] = 0;
  const raw = serialized(W, H, armies, terrain);

  S.applyUpdate({ turn: 10, map_diff: delta(null, raw), generals: [6, -1], cities_diff: delta(null, []) });
  assert.equal(S.ready, true, '首帧 map_diff 必须能拼出地图');
  assert.equal(S.w, W);
  assert.equal(S.h, H);
  assert.equal(S.n, N);
  assert.equal(S.armies[6], 10);
  assert.equal(S.terrain[6], 0);
  assert.deepEqual(S.cities, []);
  assert.equal(S.badDiff, 0);
});

check('第二帧增量：叠在首帧上，地图跟着变', () => {
  const S = new GB.GameState();
  S.applyStart({ playerIndex: 0 });
  const armies = new Array(N).fill(0);
  const terrain = new Array(N).fill(-1);
  armies[6] = 10;
  terrain[6] = 0;
  S.applyUpdate({ turn: 10, map_diff: delta(null, serialized(W, H, armies, terrain)) });
  assert.equal(S.ready, true);

  // 下一步：6 号的 10 兵打到 7 号，7 号变成我的、兵 9
  const armies2 = armies.slice();
  const terrain2 = terrain.slice();
  armies2[6] = 0;
  armies2[7] = 9;
  terrain2[7] = 0;
  S.applyUpdate({ turn: 12, map_diff: delta(S.raw, serialized(W, H, armies2, terrain2)) });
  assert.equal(S.armies[6], 0);
  assert.equal(S.armies[7], 9);
  assert.equal(S.terrain[7], 0);
  assert.equal(S.turn, 12);
  assert.equal(S.badDiff, 0);
});

check('cities_diff 首帧同样可以没有 base', () => {
  const S = new GB.GameState();
  S.applyStart({ playerIndex: 0 });
  const armies = new Array(N).fill(0);
  const terrain = new Array(N).fill(-1);
  S.applyUpdate({ turn: 2, map_diff: delta(null, serialized(W, H, armies, terrain)), cities_diff: delta(null, [7, 19]) });
  assert.deepEqual(S.cities, [7, 19]);
  // 再一帧：城被吃掉一座
  S.applyUpdate({ turn: 4, cities_diff: delta(S.rawCities, [19]) });
  assert.deepEqual(S.cities, [19]);
});

check('一整局连续 60 帧增量不漂：每一步都从上一帧 raw 上叠', () => {
  const S = new GB.GameState();
  S.applyStart({ playerIndex: 0 });

  // 一条己方走廊：每帧把 1 个兵往下游挪一格，走完回头，保证每帧都有实际变化
  const path = [6, 7, 8, 9, 14, 19];
  let armies = new Array(N).fill(0);
  let terrain = new Array(N).fill(-1);
  for (const i of path) terrain[i] = 0;
  armies[6] = 10;

  let k = 0;
  let sent = 0;
  for (let t = 0; t < 60; t++) {
    if (t > 0) {
      const from = path[k % path.length];
      const to = path[(k + 1) % path.length];
      if (armies[from] > 1) {
        armies = armies.slice();
        armies[from] -= 1;
        armies[to] += 1;
        sent++;
      }
      k++;
    }
    S.applyUpdate({ turn: t * 2, map_diff: delta(S.raw, serialized(W, H, armies, terrain)) });
    assert.equal(S.ready, true, '第 ' + t + ' 帧丢了 ready');
    assert.deepEqual(Array.from(S.armies), armies, '第 ' + t + ' 帧兵数漂了');
    assert.deepEqual(Array.from(S.terrain), terrain, '第 ' + t + ' 帧地形漂了');
  }
  assert.ok(sent > 30, '这段自测本身没造出足够多的变化: ' + sent);
  assert.equal(S.badDiff, 0);
});

console.log('\n' + passed + ' passed');
if (process.exitCode) console.log('有失败项');

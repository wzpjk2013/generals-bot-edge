/*
 * JS 移植版 vs 原版 Python 的逐格比对。
 *
 *   node scripts/ekdiff.js _research/ekdump/g1000.jsonl
 *
 * 把 ekdump.js 录下来的服务器串行化数据灌进 src/eklipz 的 Map，逐字段对照
 * Python 在同一回合的 dump。字段名、格子坐标、双方数值全打出来——移植的每一处
 * 语义偏差都会在这里现形，不靠猜。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'src', 'eklipz');
global.__EK = global.__EK || {};
require(path.join(PKG, 'tile.js'));
require(path.join(PKG, 'mapmatrix.js'));
require(path.join(PKG, 'mapmove.js'));
require(path.join(PKG, 'map.js'));
const EK = global.__EK;

function fmtTile(i, n) {
  const w = n.cols;
  return '(' + (i % w) + ',' + Math.floor(i / w) + ')';
}

function main() {
  const file = process.argv[2];
  const maxTurns = Number(process.argv[3] || '0');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const startData = {
    playerIndex: lines[0] ? JSON.parse(lines[0]).data.scores.length && 0 : 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diff',
    game_type: 'custom',
    options: {}
  };
  let map = null;
  const keyStats = {};
  let turnsDone = 0;
  let firstBad = null;
  let prevMove = null;

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (startData.playerIndex !== (rec.dump ? rec.dump.player : 0)) startData.playerIndex = rec.dump.player;
    // 原版 Map.__init__(start_data, data) 里就吞了第一包，所以第一包在 Python 那边
    // 是被应用过两次的（一次建表、一次 apply_server_update）。这里必须照做，
    // 否则 T0 那一回合的 gainedSight / oldOwner 全都对不上。
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
    } else {
      // 原版是「上一回合决策时把 move 写进 map.last_player_index_submitted_move，
      // 下一次 apply_server_update 时用它先消化掉自己的那一步」。不喂这一项，
      // 自家移动会永远落在 unexplainedDelta 里，dFrom/dTo 全对不上。
      if (prevMove) {
        const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const dest = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = [src, dest, !!prevMove[4]];
      } else {
        // 原版 find_move 每回合先无条件清空这一项，再在有招时写。留着上一回合的
        // 旧招会让迷雾推断多消化掉一次自家移动，正是 T25 那个 -1 的来源。
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move || null;
    turnsDone++;

    const py = rec.dump;
    if (!py) continue;
    const n = map.cols * map.rows;
    const diffs = [];

    for (const key in py.f) {
      const pyv = py.f[key];
      let bad = 0;
      const examples = [];
      for (let i = 0; i < n; i++) {
        // 迷雾预测格上的 player/army 是 ArmyTracker 在决策期写进去的臆测值，
        // 地图层不该替它背锅——只在看得见的格子上比较归属与兵数。
        const fogPredOnly =
          (key === 'player' || key === 'army' || key === 'dOldOwner' || key === 'dOldArmy') && !py.f.visible[i];
        if (fogPredOnly) continue;
        // 地图级字段直接按 tile 顺序取
        const jsv = readJsField(map, key, i);
        if (jsv !== pyv[i]) {
          bad++;
          if (examples.length < 4) examples.push(fmtTile(i, map) + ' py=' + pyv[i] + ' js=' + jsv);
        }
      }
      keyStats[key] = keyStats[key] || { bad: 0, turns: 0, examples: [] };
      keyStats[key].turns += bad;
      keyStats[key].bad = Math.max(keyStats[key].bad, bad);
      if (bad && keyStats[key].examples.length < 6) keyStats[key].examples.push('T' + rec.turn + ' ' + examples.join(' | '));
      if (bad && !firstBad) firstBad = { turn: rec.turn, key: key, examples: examples };
      if (bad) diffs.push(key + '×' + bad);
    }

    const cmp = (name, pyArr, jsArr) => {
      keyStats[name] = keyStats[name] || { bad: 0, turns: 0, examples: [] };
      const a = pyArr || [];
      let bad = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== jsArr[i]) bad++;
      if (a.length !== jsArr.length) bad += 10000;
      if (bad) {
        keyStats[name].bad = Math.max(keyStats[name].bad, bad);
        if (keyStats[name].examples.length < 6)
          keyStats[name].examples.push('T' + rec.turn + ' 长度py=' + a.length + ' js=' + jsArr.length);
        diffs.push(name + '×' + bad);
      }
    };
    cmp('genDist', py.genDist, genDistRaw(map, py.player));
    cmp(
      'pathable',
      py.pathable,
      Array.from(map.pathable_tiles)
        .map((t) => t.tile_index)
        .sort((a, b) => a - b)
    );
    cmp(
      'reachable',
      py.reachable,
      Array.from(map.reachable_tiles)
        .map((t) => t.tile_index)
        .sort((a, b) => a - b)
    );
    cmp(
      'cities',
      py.cities,
      map.tiles_by_index.filter((t) => t.isCity).map((t) => t.tile_index)
    );

    if (diffs.length && maxTurns && turnsDone >= maxTurns) break;
  }

  console.log('比对了 ' + turnsDone + ' 回合（' + file + '）');
  const rows = Object.keys(keyStats).map((k) => ({ k: k, s: keyStats[k] }));
  rows.sort((a, b) => b.s.bad - a.s.bad);
  for (const r of rows) {
    if (!r.s.bad) continue;
    console.log('  ✗ ' + r.k.padEnd(16) + ' 最坏 ' + String(r.s.bad).padStart(4) + ' 格/回合   ' + r.s.examples.slice(0, 2).join('  ;  '));
  }
  const clean = rows.filter((r) => !r.s.bad).map((r) => r.k);
  console.log('  ✓ 全对：' + (clean.join(', ') || '（无）'));
}

function readJsField(map, key, i) {
  const t = map.tiles_by_index[i];
  const d = t.delta;
  switch (key) {
    case 'tile':
      return t.tile;
    case 'player':
      return t.player();
    case 'army':
      return t.army;
    case 'city':
      return t.isCity ? 1 : 0;
    case 'general':
      return t.isGeneral ? 1 : 0;
    case 'visible':
      return t.visible ? 1 : 0;
    case 'discovered':
      return t.discovered ? 1 : 0;
    case 'lastSeen':
      return t.lastSeen;
    case 'mountain':
      return t.isMountain ? 1 : 0;
    case 'dArmy':
      return d.armyDelta;
    case 'dUnexplained':
      return d.unexplainedDelta;
    case 'dOldOwner':
      return d.oldOwner;
    case 'dOldArmy':
      return d.oldArmy;
    case 'dGainedSight':
      return d.gainedSight ? 1 : 0;
    case 'dLostSight':
      return d.lostSight ? 1 : 0;
    case 'dDiscovered':
      return d.discovered ? 1 : 0;
    case 'dExpected':
      return d.expectedDelta;
    case 'dMovedHere':
      return d.armyMovedHere ? 1 : 0;
    case 'dImperfect':
      return d.imperfectArmyDelta ? 1 : 0;
    case 'dFrom':
      return d.fromTile ? d.fromTile.tile_index : -1;
    case 'dTo':
      return d.toTile ? d.toTile.tile_index : -1;
    case 'dArmyMovedHere':
      return d.armyMovedHere ? 1 : 0;
    default:
      return -999;
  }
}

function genDistRaw(map, playerIndex) {
  const gen = map.generals[map.player_index];
  if (!gen) return new Array(map.cols * map.rows).fill(-1);
  const mat = map.distance_mapper.get_tile_dist_matrix(gen);
  return Array.from(mat.raw);
}

main();

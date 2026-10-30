/*
 * DangerAnalyzer 逐字段比对：同一串服务器数据，Python 原版跑一遍、JS 移植跑一遍，
 * 比 analyze 的五条威胁、按发起格分组的威胁表、每格查询、以及 convert_to_dist_dict 的三种参数组合。
 *
 * node scripts/ekdiff-danger.js _research/ekdump/g1000b.jsonl _research/danger1000b.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
require(path.join(ROOT, 'tile.js'));
require(path.join(ROOT, 'mapmatrix.js'));
require(path.join(ROOT, 'search.js'));
require(path.join(ROOT, 'path.js'));
require(path.join(ROOT, 'map.js'));
require(path.join(ROOT, 'mapmove.js'));
require(path.join(ROOT, 'armyanalyzer.js'));
require(path.join(ROOT, 'danger.js'));
const EK = global.__EK;

function round6(v) {
  return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
}

function threatDump(threat) {
  if (threat === null || threat === undefined) return null;
  const pathTiles = threat.path.tileList;
  const out = {
    turns: threat.turns,
    threatValue: threat.threatValue,
    threatPlayer: threat.threatPlayer,
    threatType: threat.threatType,
    path: pathTiles.map((t) => t.tile_index),
    value: round6(threat.path.value),
    tail: threat.path.tail.tile.tile_index,
    saveTile: threat.saveTile === null || threat.saveTile === undefined ? null : threat.saveTile.tile_index,
    aaA: threat.armyAnalysis ? threat.armyAnalysis.tileA.tile_index : null,
    aaB: threat.armyAnalysis ? threat.armyAnalysis.tileB.tile_index : null
  };
  return out;
}

function distDumps(threat) {
  if (threat === null || threat === undefined) return null;
  const out = {};
  const variants = {
    def: {},
    nonChoke: { allowNonChoke: true },
    raw: { offset: 0, allowNonChoke: false, stripBad: false }
  };
  for (const name of Object.keys(variants)) {
    const opts = variants[name];
    const d = threat.convert_to_dist_dict(
      opts.offset === undefined ? -1 : opts.offset,
      opts.allowNonChoke === undefined ? false : opts.allowNonChoke,
      opts.stripBad === undefined ? true : opts.stripBad
    );
    const arr = [];
    d.forEach((v, t) => arr.push([t.tile_index, Math.trunc(v)]));
    arr.sort((a, b) => a[0] - b[0]);
    out[name] = arr;
  }
  return out;
}

function groupedDump(grouped) {
  const out = [];
  grouped.forEach((threats, startTile) => {
    out.push([startTile.tile_index, threats.map(threatDump)]);
  });
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// 逐层比对，报出「哪个字段 / 哪个格子」不一致，而不是只知道整体不同
function diffValues(py, js, where, sink) {
  if (sink.length >= 20) return;
  if (py === null || py === undefined) {
    if (js !== null && js !== undefined) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (js === null || js === undefined) {
    sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (Array.isArray(py) || Array.isArray(js)) {
    if (!Array.isArray(py) || !Array.isArray(js)) {
      sink.push(`${where}: 一边是数组 py=${typeof py} js=${typeof js}`);
      return;
    }
    if (py.length !== js.length) sink.push(`${where}.length: py=${py.length} js=${js.length}`);
    const n = Math.min(py.length, js.length);
    for (let i = 0; i < n; i++) diffValues(py[i], js[i], `${where}[${i}]`, sink);
    return;
  }
  if (typeof py === 'object') {
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of keys) diffValues(py[k], js[k], `${where}.${k}`, sink);
    return;
  }
  if (py !== js) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
}

function pickDefenseTiles(map, turn) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!t || seen.has(t.tile_index)) return;
    seen.add(t.tile_index);
    out.push(t);
  };
  const me = map.player_index;
  if (map.generals[me]) add(map.generals[me]);
  const myTiles = map.players[me].tiles.slice().sort((a, b) => {
    if (b.army !== a.army) return b.army - a.army;
    return a.tile_index - b.tile_index;
  });
  for (const t of myTiles.slice(0, 3)) add(t);
  const all = map.tiles_by_index;
  if (all.length) add(all[turn % all.length]);
  return out;
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const d of oracle.dumps) byTurn.set(d.turn, d);

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'danger',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  const fieldStats = {};
  let firstBad = null;

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined && startData.playerIndex !== rec.dump.player) {
      startData.playerIndex = rec.dump.player;
    }
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (mis > 0) console.log(`警告: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致`);
    } else {
      if (prevMove) {
        const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const dest = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = [src, dest, !!prevMove[4]];
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move;

    const pyDump = byTurn.get(rec.turn);
    if (!pyDump) continue;
    total++;
    if (pyDump.error) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'python 侧报错' };
      continue;
    }

    const defenseTiles = pickDefenseTiles(map, rec.turn);
    const armies = new Map();
    let entry;
    try {
      const da = new EK.DangerAnalyzer(map);
      da.analyze(defenseTiles, pyDump.depth, armies);
      const grouped = da.get_threats_grouped_by_tile(armies);
      const byTile = defenseTiles.map((t) => [
        t.tile_index,
        da.get_threats_by_tile(t, armies).map(threatDump)
      ]);
      entry = {
        turn: rec.turn,
        player: map.player_index,
        depth: pyDump.depth,
        defense: defenseTiles.map((t) => t.tile_index),
        scan: {
          playerTiles: da.playerTiles.map((lst) => lst.map((t) => t.tile_index)),
          largeVisible: da.largeVisibleEnemyTiles.map((t) => t.tile_index)
        },
        analyze: {
          fastest: threatDump(da.fastestThreat),
          city: threatDump(da.fastestCityThreat),
          potential: threatDump(da.fastestPotentialThreat),
          highest: threatDump(da.highestThreat),
          vision: threatDump(da.fastestVisionThreat),
          anyThreat: da.anyThreat,
          nonGeneralTargets: da.nonGeneralTargets.map((t) => t.tile_index)
        },
        grouped: groupedDump(grouped),
        byTile: byTile,
        dist: {
          fastest: distDumps(da.fastestThreat),
          city: distDumps(da.fastestCityThreat),
          potential: distDumps(da.fastestPotentialThreat),
          vision: distDumps(da.fastestVisionThreat)
        }
      };
    } catch (e) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'JS 抛异常: ' + e.message + '\n' + (e.stack || '') };
      continue;
    }

    const sink = [];
    diffValues(pyDump, entry, `T${rec.turn}`, sink);
    if (sink.length > 0) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, diffs: sink.slice(0, 6) };
      for (const s of sink) {
        const field = s.split(':')[0].replace(/\[\d+\]/g, '');
        if (!fieldStats[field]) fieldStats[field] = [];
        if (fieldStats[field].length < 4) fieldStats[field].push(s);
      }
    }
  }

  console.log(`回合总数 ${total}，不一致 ${bad}，一致率 ${(((total - bad) / total) * 100).toFixed(1)}%`);
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const line2 of fieldStats[k]) console.log(`    ${line2.slice(0, 300)}`);
  }
  if (firstBad) console.log('首个不一致:', JSON.stringify(firstBad).slice(0, 2000));
}

main();

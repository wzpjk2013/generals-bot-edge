/*
 * ArmyAnalyzer 逐格比对：同一串服务器数据，Python 原版跑一遍、JS 移植跑一遍，
 * 比 chokeWidths / interceptChokes / interceptDistances / interceptTurns /
 * pathWay 归属 五个矩阵。
 *
 * node scripts/ekdiff-aa.js _research/ekdump/g1000b.jsonl _research/aa1000b.json
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
const EK = global.__EK;

const FIELD_MATRICES = ['chokeWidths', 'interceptChokes', 'interceptDistances', 'interceptTurns', 'pathWayOf'];

function flattenJs(matrix, tiles) {
  const out = [];
  for (const t of tiles) {
    const v = matrix.raw[t.tile_index];
    out.push(v === undefined ? null : v);
  }
  return out;
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const a of oracle.analyses) {
    if (!byTurn.has(a.turn)) byTurn.set(a.turn, []);
    byTurn.get(a.turn).push(a);
  }

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'aa',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  let worst = null;
  const fieldStats = {};

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined && startData.playerIndex !== rec.dump.player) {
      startData.playerIndex = rec.dump.player;
    }
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      // 索引对齐自检：两边 tiles_by_index 顺序不同的话，逐格比对全是假差异。
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (mis > 0) console.log(`警告: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致`);
      else console.log(`索引对齐 ok（${tileCoords.length} 格）`);
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

    const analyses = byTurn.get(rec.turn);
    if (!analyses) continue;

    for (const a of analyses) {
      if (a.error) continue;
      const ta = map.get_tile_by_tile_index(a.a[1] * map.cols + a.a[0]);
      const tb = map.get_tile_by_tile_index(a.b[1] * map.cols + a.b[0]);
      let aa;
      try {
        aa = new EK.ArmyAnalyzer(map, ta, tb, -1, null, 100, {
          scanOrder: oracle.scanOrder ? oracle.scanOrder[String(rec.turn)] : null
        });
      } catch (e) {
        bad++;
        total++;
        if (!worst) worst = { turn: rec.turn, a: a.a, b: a.b, why: 'JS 抛异常: ' + e.message };
        continue;
      }
      const tiles = map.tiles_by_index;
      const jsVals = {
        chokeWidths: flattenJs(aa.chokeWidths, tiles),
        interceptChokes: flattenJs(aa.interceptChokes, tiles),
        interceptDistances: flattenJs(aa.interceptDistances, tiles),
        interceptTurns: flattenJs(aa.interceptTurns, tiles),
        pathWayOf: flattenJs(aa.pathWayLookupMatrix, tiles).map((pw) => (pw === null ? null : pw.distance))
      };
      let diffs = 0;
      for (const field of FIELD_MATRICES) {
        const py = a[field];
        const js = jsVals[field];
        let d = 0;
        for (let i = 0; i < py.length; i++) {
          if (py[i] !== js[i]) {
            d++;
            if (!fieldStats[field]) fieldStats[field] = [];
            if (fieldStats[field].length < 5) {
              const t = tiles[i];
              fieldStats[field].push(`T${rec.turn} (${t.x},${t.y}) py=${py[i]} js=${js[i]}`);
            }
          }
        }
        diffs += d;
      }
      if (aa.shortestPathWay.distance !== a.shortestDist) {
        diffs++;
        if (fieldStats.shortestDist === undefined) fieldStats.shortestDist = [];
        if (fieldStats.shortestDist.length < 5) {
          fieldStats.shortestDist.push(`T${rec.turn} py=${a.shortestDist} js=${aa.shortestPathWay.distance}`);
        }
      }
      total++;
      if (diffs > 0) {
        bad++;
        if (!worst) worst = { turn: rec.turn, a: a.a, b: a.b, diffs };
      }
    }
  }

  console.log(`分析总数 ${total}，不一致 ${bad}，一致率 ${(((total - bad) / total) * 100).toFixed(1)}%`);
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const line2 of fieldStats[k]) console.log(`    ${line2}`);
  }
  if (worst) console.log('首个不一致:', JSON.stringify(worst));
}

main();

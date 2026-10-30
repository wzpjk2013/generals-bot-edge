/*
 * TileIslandBuilder 逐回合逐格比对：同一串服务器数据回放进 Python 原版和 JS 移植版，
 * 比的是岛的**结构**（每格归属 + 每个岛的字段 + 排序），不是 unique_id / name
 * —— 那两个在原版里是进程级自增，跨进程不可复现。
 *
 * node scripts/ekdiff-island.js _research/ekdump/g1000b.jsonl _research/island-g1000b.json
 *
 * 顺序必须和 ekdump_island.py 一致：每个回合先 recalculate / update / recalculate(by-distance)
 * 三棵 builder 各构建一次再 snapshot。回合 0 之前必须先 recalculate 初始化。
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
require(path.join(ROOT, 'tileisland.js'));
const EK = global.__EK;

let mismatches = 0;
let printed = 0;
let cellsTotal = 0;
let cellsMatch = 0;
const MAX_PRINT = 40;
const diffCounts = new Map();

function record(where, pv, jv) {
  mismatches++;
  diffCounts.set(where, (diffCounts.get(where) || 0) + 1);
  if (printed < MAX_PRINT) {
    printed++;
    const fmt = (v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : JSON.stringify(v));
    console.log(`  DIFF ${where}\n    py=${fmt(pv)}\n    js=${fmt(jv)}`);
  }
}

function cmpValue(where, pv, jv) {
  if (pv === null || pv === undefined || jv === null || jv === undefined) {
    if (!(pv === null || pv === undefined) || !(jv === null || jv === undefined)) record(where, pv, jv);
    return;
  }
  if (Array.isArray(pv) || Array.isArray(jv)) {
    if (!Array.isArray(pv) || !Array.isArray(jv)) return record(where, pv, jv);
    if (pv.length !== jv.length) return record(where + '.length', pv.length, jv.length);
    for (let i = 0; i < pv.length; i++) cmpValue(where + '[' + i + ']', pv[i], jv[i]);
    return;
  }
  if (typeof pv === 'object' || typeof jv === 'object') {
    if (typeof pv !== 'object' || typeof jv !== 'object') return record(where, pv, jv);
    const keys = new Set(Object.keys(pv).concat(Object.keys(jv)));
    for (const k of Array.from(keys).sort()) {
      // border_tiles 的键是"邻居岛 id"，同样用 canonical id（最小 tile_index）
      cmpValue(where + '.' + k, pv[k], jv[k]);
    }
    return;
  }
  if (pv !== jv) record(where, pv, jv);
}

function canon(island) {
  if (island === null || island === undefined) return null;
  let m = Infinity;
  island.tile_set.forEach((t) => {
    if (t.tile_index < m) m = t.tile_index;
  });
  return m === Infinity ? null : m;
}

function tilesOf(island) {
  const out = [];
  island.tile_set.forEach((t) => out.push(t.tile_index));
  return out.sort((a, b) => a - b);
}

function islandDict(island, builder) {
  if (island === null || island === undefined) return null;
  const borderTiles = {};
  const lookup = builder.get_island_border_tile_lookup(island);
  // 边界表的键是 unique_id，跨进程不可复现；换成 canonical id 才能比
  for (const k of Object.keys(lookup)) {
    const bi = builder.tile_islands_by_unique_id[k];
    borderTiles[bi === undefined || bi === null ? 'p' + k : String(canon(bi))] = Array.from(lookup[k])
      .map((t) => t.tile_index)
      .sort((a, b) => a - b);
  }
  return {
    team: island.team,
    tiles: tilesOf(island),
    tile_count: island.tile_count,
    sum_army: island.sum_army,
    tile_count_all_adjacent_friendly: island.tile_count_all_adjacent_friendly,
    sum_army_all_adjacent_friendly: island.sum_army_all_adjacent_friendly,
    cities: island.cities.map((t) => t.tile_index).sort((a, b) => a - b),
    tiles_by_army: island.tiles_by_army.map((t) => t.tile_index),
    parent: canon(island.full_island),
    children: island.child_islands === null || island.child_islands === undefined ? null : island.child_islands.map(canon).sort((a, b) => a - b),
    border_islands: island.border_islands.items().map(canon).sort((a, b) => a - b),
    border_tiles: borderTiles
  };
}

function snapshot(builder, tiles, teams) {
  const leafIds = [];
  const parentIds = [];
  for (const t of tiles) {
    const isl = builder.tile_island_lookup.raw[t.tile_index];
    leafIds.push(isl === null || isl === undefined ? null : canon(isl));
    parentIds.push(isl === null || isl === undefined || isl.full_island === null ? null : canon(isl.full_island));
  }

  const islands = {};
  const parents = {};
  for (const isl of builder.all_tile_islands.items()) {
    islands[String(canon(isl))] = islandDict(isl, builder);
    const p = isl.full_island;
    if (p !== null && p !== undefined) {
      const c = canon(p);
      if (!(String(c) in parents)) {
        parents[String(c)] = { team: p.team, tiles: tilesOf(p), tile_count: p.tile_count, sum_army: p.sum_army };
      }
    }
  }

  const uniqueTeams = Array.from(new Set(teams)).sort((a, b) => a - b);
  const largeByTeam = {};
  const largeDistByTeam = {};
  for (const team of uniqueTeams) {
    const idx = team < 0 ? builder.large_tile_islands_by_team_id.length - 1 : team;
    const set = builder.large_tile_islands_by_team_id[idx];
    largeByTeam[String(team)] = set === null || set === undefined ? [] : Array.from(set).map(canon).sort((a, b) => a - b);
    const dm = builder.large_tile_island_distances_by_team_id[idx];
    largeDistByTeam[String(team)] = dm === null || dm === undefined ? null : tiles.map((t) => dm.raw[t.tile_index]);
  }

  const byTeam = {};
  for (const team of uniqueTeams) {
    const idx = team < 0 ? builder.tile_islands_by_team_id.length - 1 : team;
    byTeam[String(team)] = builder.tile_islands_by_team_id[idx].map(canon);
  }
  const byPlayer = {};
  for (let pi = 0; pi < builder.tile_islands_by_player.length; pi++) {
    byPlayer[String(pi)] = builder.tile_islands_by_player[pi].map(canon);
  }

  return {
    leafIds,
    parentIds,
    islandCount: builder.all_tile_islands.length(),
    has_islands: builder.all_tile_islands !== null && builder.all_tile_islands !== undefined,
    islands,
    parents,
    largeByTeam,
    largeDistByTeam,
    byTeam,
    byPlayer,
    allOrder: builder.all_tile_islands.items().map(canon)
  };
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  if (!jsonl || !oracleFile) {
    console.log('用法: node scripts/ekdiff-island.js <dump.jsonl> <island-*.json>');
    process.exit(2);
  }

  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'island',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let bRecalc = null;
  let bUpdate = null;
  let bDistance = null;
  let checkedTurns = 0;
  let teams = null;

  for (let li = 0; li < lines.length; li++) {
    const rec = JSON.parse(lines[li]);
    if (li === 0 && rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;

    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (tileCoords.length !== map.tiles_by_index.length) {
        console.log(`失败: tiles_by_index 长度 ${map.tiles_by_index.length} != python ${tileCoords.length}`);
        process.exit(1);
      }
      if (mis > 0) {
        console.log(`失败: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致，逐格比对无意义`);
        process.exit(1);
      }
      console.log(`索引对齐 ok（${tileCoords.length} 格）`);
      teams = EK.Map.get_teams_array(map);
    } else {
      if (prevMove) {
        const srcTile = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const destTile = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = [srcTile, destTile, !!prevMove[4]];
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move;

    if (bRecalc === null) {
      bRecalc = new EK.TileIslandBuilder(map, null);
      bUpdate = new EK.TileIslandBuilder(map, null);
      bDistance = new EK.TileIslandBuilder(map, null);
      bRecalc.recalculate_tile_islands(null);
      bUpdate.recalculate_tile_islands(null);
      bDistance.recalculate_tile_islands(null, EK.IslandBuildMode.BuildByDistance);
    } else {
      bRecalc.recalculate_tile_islands(null);
      bUpdate.update_tile_islands(null);
      bDistance.recalculate_tile_islands(null, EK.IslandBuildMode.BuildByDistance);
    }

    const exp = oracle.turns[checkedTurns];
    if (!exp) {
      console.log(`失败: JS 多出第 ${checkedTurns} 回合（turn ${rec.turn}）`);
      process.exit(1);
    }
    if (exp.turn !== rec.turn) {
      console.log(`失败: 回合对不齐，oracle turn ${exp.turn} vs js turn ${rec.turn}`);
      process.exit(1);
    }

    const tiles = map.tiles_by_index;
    const where = `t${exp.turn}`;
    const builders = { recalc: bRecalc, update: bUpdate, distance: bDistance };
    for (const key of ['recalc', 'update', 'distance']) {
      const e = exp[key];
      if (!e || e.error) {
        record(where + '.' + key, e && e.error ? e.error.split('\n').slice(-2).join(' ') : null, '<js-ran>');
        continue;
      }
      let jsSnap;
      try {
        jsSnap = snapshot(builders[key], tiles, teams);
      } catch (err) {
        record(where + '.' + key + '.<threw>', '<py-ok>', String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : err));
        continue;
      }
      // 逐格统计叶岛归属命中率：这是最直观的"一致率"，一个格一个数
      for (let ci = 0; ci < e.leafIds.length; ci++) {
        cellsTotal++;
        if (e.leafIds[ci] === jsSnap.leafIds[ci]) cellsMatch++;
        else if (printed < MAX_PRINT && mismatches === 0) {
          console.log(`  CELL ${where}.${key} tile ${ci}: py=${e.leafIds[ci]} js=${jsSnap.leafIds[ci]}`);
        }
      }
      cmpValue(where + '.' + key, {
        leafIds: e.leafIds,
        parentIds: e.parentIds,
        islandCount: e.islandCount,
        has_islands: e.has_islands,
        islands: e.islands,
        parents: e.parents,
        largeByTeam: e.largeByTeam,
        largeDistByTeam: e.largeDistByTeam,
        byTeam: e.byTeam,
        byPlayer: e.byPlayer,
        allOrder: e.allOrder
      }, jsSnap);
    }
    checkedTurns++;
  }

  if (checkedTurns !== oracle.turns.length) {
    console.log(`失败: JS 只回放了 ${checkedTurns} 回合，oracle 有 ${oracle.turns.length}`);
    process.exit(1);
  }

  const total = checkedTurns * 3;
  const rate = cellsTotal === 0 ? '0' : ((100 * cellsMatch) / cellsTotal).toFixed(4);
  if (mismatches > 0) {
    const rows = Array.from(diffCounts.entries()).sort((a, b) => b[1] - a[1]);
    console.log('按字段汇总（最多 40 行）:');
    for (const [k, v] of rows.slice(0, 40)) console.log(`  ${v}\t${k}`);
  }
  console.log(`回放 ${checkedTurns} 回合 / ${total} 次构建，逐格 ${cellsMatch}/${cellsTotal}`);
  console.log(`不一致 ${mismatches}，一致率 ${rate}%`);
  if (mismatches > 0) process.exit(1);
}

main();

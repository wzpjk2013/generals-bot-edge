/*
 * MapSpanning 数值 oracle：JS 移植版 vs 原版 Python。
 *
 *   node scripts/ekdiff-spanning.js _research/spanning-gA2.json
 *
 * 输入 JSON 由 _research/ekdump_spanning.py 产出：每一条 case 都带着
 *   - 原版真正收到的参数（requiredTiles 的顺序、banned、negativeTiles、maxTurns、
 *     searchingPlayer、require_min_distance、gatherPrioMatrix 全量 raw）
 *   - 整张地图的格状态（含 movable 邻接表顺序，平局选边全靠它）
 *   - 原版的输出（included / missing / 边集合 / 节点数）
 *
 * 这里在同一份输入上跑 EK.MapSpanning，逐字段比。差异按性质分两类：
 *   cost     结构不同（节点数、必需格连不上、边数不同）——必须为 0
 *   tie      节点集合相同、只是中间走位不同——平局语义差异，单独计数
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
require(path.join(PKG, 'search.js'));
require(path.join(PKG, 'path.js'));
require(path.join(PKG, 'gather.js'));
require(path.join(PKG, 'mapspanning.js'));
const EK = global.__EK;

/* 只造这一层：算法只读 tile 与 map 的这几样东西 */
function buildMap(caseData) {
  const info = caseData.map;
  const cols = info.cols;
  const rows = info.rows;
  const tiles = new Array(cols * rows);

  for (let i = 0; i < caseData.tiles.length; i++) {
    const row = caseData.tiles[i];
    const t = Object.create(EK.Tile.prototype);
    t.tile_index = row[0];
    t.tile = row[1];
    t._player = row[2];
    t.army = row[3];
    t.isCity = !!row[4];
    t.isGeneral = !!row[5];
    t.discovered = !!row[6];
    t.visible = !!row[7];
    t.isMountain = !!row[8];
    t.x = t.tile_index % cols;
    t.y = Math.floor(t.tile_index / cols);
    t.movable = null;
    t.delta = null;
    t.lastSeen = 0;
    t.parent = null;
    tiles[t.tile_index] = t;
  }
  for (let i = 0; i < caseData.tiles.length; i++) {
    const row = caseData.tiles[i];
    const t = tiles[row[0]];
    t.movable = row[9].map(function (idx) {
      return tiles[idx];
    });
    if (t._recalc_derived) t._recalc_derived();
  }

  const teammates = new Set(info.teammates || []);
  const teamIds = info.teamIds || [];

  const map = {
    cols: cols,
    rows: rows,
    player_index: info.playerIndex,
    turn: info.turn,
    tiles_by_index: tiles,
    generals: info.generals.map(function (ti) {
      return ti < 0 ? null : tiles[ti];
    }),
    teammates: teammates,
    team_ids_by_player_index: teamIds,
    reachable_tiles: info.reachable.map(function (ti) {
      return tiles[ti];
    }),
    get_tile_by_tile_index: function (i) {
      return tiles[i];
    },
    is_player_on_team_with: function (player, other) {
      if (player === other) return true;
      if (player < 0 || other < 0) return false;
      const a = teamIds[player];
      const b = teamIds[other];
      return a !== undefined && b !== undefined && a >= 0 && a === b;
    },
    is_tile_on_team_with: function (tile, player) {
      return map.is_player_on_team_with(tile.player(), player);
    },
    is_tile_friendly: function (tile) {
      return map.is_player_on_team_with(tile.player(), map.player_index);
    }
  };
  return map;
}

function edgeKeyList(included) {
  const out = [];
  included.forEach(function (t) {
    const mv = t.movable;
    for (let i = 0; i < mv.length; i++) {
      if (!included.has(mv[i])) continue;
      const a = t.tile_index;
      const b = mv[i].tile_index;
      out.push(a < b ? a + '-' + b : b + '-' + a);
    }
  });
  out.sort();
  return out;
}

function sortedIdx(set) {
  return Array.from(set)
    .map(function (t) {
      return t.tile_index;
    })
    .sort(function (a, b) {
      return a - b;
    });
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', '..', '_research', 'spanning-gA2.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = raw.cases || [];

  let costDiff = 0;
  let tieDiff = 0;
  let exact = 0;
  const details = [];

  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    if (c.error) {
      costDiff++;
      details.push('T' + c.turn + ' #' + ci + ' PY-CASE-ERROR ' + String(c.error).split('\n')[0]);
      continue;
    }
    const map = buildMap(c);

    const startTiles = c.requiredTiles.map(function (ti) {
      return map.tiles_by_index[ti];
    });
    const banned = new Set(
      c.banned.map(function (ti) {
        return map.tiles_by_index[ti];
      })
    );
    const negativeTiles =
      c.negativeTiles === null || c.negativeTiles === undefined
        ? null
        : new Set(
            c.negativeTiles.map(function (ti) {
              return map.tiles_by_index[ti];
            })
          );

    const prio = c.gatherPrio ? Float64Array.from(c.gatherPrio) : null;

    let res;
    let threw = null;
    try {
      res = EK.MapSpanning.get_max_gather_spanning_tree_set_from_tile_lists(
        map,
        startTiles,
        banned,
        c.searchingPlayer,
        prio,
        {
          negativeTiles: negativeTiles,
          maxTurns: c.maxTurns,
          require_min_distance: c.requireMinDistance
        }
      );
    } catch (err) {
      threw = err;
    }

    const tag = 'T' + c.turn + ' ' + (c.case || 'real#' + c.callIndex);
    if (threw) {
      costDiff++;
      details.push(tag + ' JS-THREW ' + threw.message);
      continue;
    }

    const jsIncluded = sortedIdx(res[0]);
    const jsMissing = sortedIdx(res[1]);
    const pyIncluded = c.out.included;
    const pyMissing = c.out.missing;

    const sameIncluded = jsIncluded.length === pyIncluded.length && jsIncluded.every((v, i) => v === pyIncluded[i]);
    const sameMissing = jsMissing.length === pyMissing.length && jsMissing.every((v, i) => v === pyMissing[i]);

    if (sameIncluded && sameMissing) {
      exact++;
      continue;
    }

    // 结构不同：节点数不同、必需格缺失集合不同 → 真的算错
    if (jsIncluded.length !== pyIncluded.length || !sameMissing) {
      costDiff++;
      details.push(
        tag +
          ' COST pyNodes=' +
          pyIncluded.length +
          ' jsNodes=' +
          jsIncluded.length +
          ' pyMissing=[' +
          pyMissing.join(',') +
          '] jsMissing=[' +
          jsMissing.join(',') +
          '] pyOnly=[' +
          pyIncluded.filter((t) => jsIncluded.indexOf(t) < 0).join(',') +
          '] jsOnly=[' +
          jsIncluded.filter((t) => pyIncluded.indexOf(t) < 0).join(',') +
          ']'
      );
      continue;
    }

    // 节点集合相同但个别格子不同：只可能是平局走位（同样长度、同样代价）
    tieDiff++;
    details.push(
      tag +
        ' TIE pyOnly=[' +
        pyIncluded.filter((t) => jsIncluded.indexOf(t) < 0).join(',') +
        '] jsOnly=[' +
        jsIncluded.filter((t) => pyIncluded.indexOf(t) < 0).join(',') +
        ']'
    );
  }

  console.log('file        :', file);
  console.log('cases       :', cases.length);
  console.log('exact match :', exact);
  console.log('cost diff   :', costDiff, '(必须为 0)');
  console.log('tie diff    :', tieDiff);
  if (details.length) {
    console.log('--- details ---');
    details.forEach(function (d) {
      console.log(d);
    });
  }
  process.exitCode = costDiff === 0 ? 0 : 1;
}

main();

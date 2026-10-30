/*
 * Gather 逐位比对：同一串服务器数据，Python 原版 Gather 跑一遍做 oracle，
 * JS 移植版跑同一条主链，比 value 矩阵 / 剪枝后的 tile 集合 / 树的每个节点 /
 * plan 的每个数值 / 首招与出招序列。
 *
 * node scripts/ekdiff-gather.js _research/ekdump/g5000.jsonl _research/gather-g5000.json
 *
 * 不加容差：浮点也必须逐位相同。差一点点就说明某处公式或求和顺序不一样。
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
require(path.join(ROOT, 'gather.js'));
const EK = global.__EK;

function sameNum(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a === b;
}

function sameArr(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Array.isArray(a[i]) || Array.isArray(b[i])) {
      if (!sameArr(a[i], b[i])) return false;
    } else if (!sameNum(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function moveTuple(m) {
  if (!m) return null;
  return [m.source.tile_index, m.dest.tile_index, !!m.move_half];
}

function treeRows(rootNodes) {
  const rows = [];
  for (const node of EK.GatherTreeNode.iterate_tree_nodes(rootNodes)) {
    rows.push([
      node.tile.tile_index,
      node.toTile === null || node.toTile === undefined ? -1 : node.toTile.tile_index,
      node.value,
      node.points,
      node.gatherTurns,
      node.trunkValue,
      node.trunkDistance,
      node.children.length
    ]);
  }
  return rows;
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const g of oracle.groups) {
    if (!byTurn.has(g.turn)) byTurn.set(g.turn, []);
    byTurn.get(g.turn).push(g);
  }

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'gather',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  let skipped = 0;
  const fieldStats = {};
  const worsts = [];

  function note(field, msg) {
    if (!fieldStats[field]) fieldStats[field] = [];
    if (fieldStats[field].length < 4) fieldStats[field].push(msg);
  }

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      // 索引对齐自检：两边格子顺序不同的话，逐格比对全是假差异。
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

    const groups = byTurn.get(rec.turn);
    if (!groups) continue;

    const asPlayer = map.player_index;
    const tiles = map.tiles_by_index;
    const valueMatrix = EK.Gather.build_gather_capture_pure_value_matrix(
      map, asPlayer, null, null, null, false, false, false);
    const valRow = [];
    for (let i = 0; i < tiles.length; i++) valRow.push(valueMatrix.raw[tiles[i].tile_index]);

    for (const g of groups) {
      total++;
      if (g.error) {
        skipped++;
        total--;
        continue;
      }
      let diffs = 0;
      let firstWhy = null;
      const why = (m) => {
        if (!firstWhy) firstWhy = m;
        diffs++;
      };

      if (!sameArr(g.val, valRow)) {
        let n = 0;
        let sample = null;
        for (let i = 0; i < valRow.length; i++) {
          if (!sameNum(g.val[i], valRow[i])) {
            n++;
            if (!sample) {
              const t = tiles[i];
              sample = `(${t.x},${t.y}) py=${g.val[i]} js=${valRow[i]}`;
            }
          }
        }
        note('val', `T${rec.turn} 差 ${n} 格, 首例 ${sample}`);
        why('val 矩阵不一致');
      }

      const rootTile = map.GetTile(g.root[0], g.root[1]);
      const region = EK.Gather.friendly_connected_region(map, new Set([rootTile]), asPlayer);
      if (region.size !== g.regionCount) {
        note('region', `T${rec.turn} py=${g.regionCount} js=${region.size}`);
        why('连通区域不一致');
      }

      const rootTiles = new Set([rootTile]);
      let plan = null;
      try {
        EK.Gather.prune_raw_connected_nodes_to_turns__dfs(
          rootTiles, region, g.toTurns, asPlayer, valueMatrix, null, false);
        plan = EK.Gather.convert_contiguous_tile_tree_to_gather_capture_plan(
          map, rootTiles, region, asPlayer, null, valueMatrix, true, false, true, null, null, null);
      } catch (e) {
        note('throw', `T${rec.turn} ${e.message}`);
        bad++;
        if (worsts.length < 5) worsts.push({ turn: rec.turn, root: g.root, toTurns: g.toTurns, why: 'JS 抛异常: ' + e.message });
        continue;
      }

      const jsTiles = Array.from(region, (t) => t.tile_index).sort((a, b) => a - b);
      if (!sameArr(g.gatherTiles, jsTiles)) {
        let n = 0;
        const jsSet = new Set(jsTiles);
        for (const x of g.gatherTiles) if (!jsSet.has(x)) n++;
        note('gatherTiles', `T${rec.turn} toTurns=${g.toTurns} py${g.gatherTiles.length}/js${jsTiles.length} 缺 ${n}`);
        why('剪枝后的 tile 集合不一致');
      }

      const jsTree = treeRows(plan.root_nodes);
      if (!sameArr(g.tree, jsTree)) {
        let n = 0;
        const len = Math.max(g.tree.length, jsTree.length);
        let sample = null;
        for (let i = 0; i < len; i++) {
          if (!sameArr(g.tree[i], jsTree[i])) {
            n++;
            if (!sample) sample = `#${i} py=${JSON.stringify(g.tree[i])} js=${JSON.stringify(jsTree[i])}`;
          }
        }
        note('tree', `T${rec.turn} 差 ${n}/${len} 节点, 首例 ${sample}`);
        why('树形/节点值不一致');
      }

      const jsPlan = {
        turns: plan._turns,
        econValue: plan._econ_value,
        gathered_army: plan.gathered_army,
        gather_capture_points: plan.gather_capture_points,
        gather_turns: plan.gather_turns,
        friendly_city_count: plan.friendly_city_count || 0,
        enemy_city_count: plan.enemy_city_count || 0,
        tileList: plan.tileList.map((t) => t.tile_index),
        tileSetSorted: Array.from(plan.tileSet, (t) => t.tile_index).sort((a, b) => a - b)
      };
      for (const k of Object.keys(jsPlan)) {
        if (!sameArr(g.plan[k], jsPlan[k])) {
          note(k, `T${rec.turn} py=${JSON.stringify(g.plan[k]).slice(0, 120)} js=${JSON.stringify(jsPlan[k]).slice(0, 120)}`);
          why('plan.' + k + ' 不一致');
        }
      }

      if (!sameArr(g.firstMove, moveTuple(plan.get_first_move()))) {
        note('firstMove', `T${rec.turn} py=${JSON.stringify(g.firstMove)} js=${JSON.stringify(moveTuple(plan.get_first_move()))}`);
        why('首招不一致');
      }
      const jsMoves = plan.get_move_list().map(moveTuple);
      if (!sameArr(g.moveList, jsMoves)) {
        note('moveList', `T${rec.turn} py${g.moveList.length}/js${jsMoves.length}`);
        why('出招序列不一致');
      }

      if (diffs > 0) {
        bad++;
        if (worsts.length < 5) worsts.push({ turn: rec.turn, root: g.root, toTurns: g.toTurns, why: firstWhy, diffs: diffs });
      }
    }
  }

  console.log(`比对组数 ${total}，跳过 ${skipped}，不一致 ${bad}，一致率 ${(((total - bad) / Math.max(1, total)) * 100).toFixed(1)}%`);
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const s of fieldStats[k]) console.log(`    ${s}`);
  }
  if (worsts.length) console.log('前几个不一致:', JSON.stringify(worsts, null, 1));
}

main();

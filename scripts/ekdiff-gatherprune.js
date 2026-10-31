'use strict';

/*
 * GatherPrune / GatherSteiner / NetworkXHelpers 的逐字段比对。
 *
 *   node scripts/ekdiff-gatherprune.js E:\akcoco6de\_research\ekdump\g3000.jsonl E:\akcoco6de\_research\gp-py-3000.json
 *
 * 建树规则必须与 oracle（_research/ekdump_gatherprune.py 的 build_tree）逐位一致：
 * 从将军沿我方连通区 BFS 到 TREE_BFS_DEPTH，按 (-army, tile_index) 取前 TREE_SELECT_COUNT 格，
 * 再把它们的祖先路径并成一棵树，子节点一律按 tile_index 升序挂。
 * 只有这样，两边跑同一套剪枝才会得到同一棵树——比对的是算法，不是建树。
 *
 * 遍历顺序说明：Python 的 `for adj in tile.movable` 是固定邻居序，但候选集排序显式使用了
 * (-army, tile_index)，BFS 队列顺序也由此确定；JS 侧比较函数显式写死同一口径，不依赖
 * 引擎的 sort 稳定性以外的任何隐含顺序。
 */

const fs = require('fs');
const path = require('path');

const EK = require('../src/eklipz/tile.js');
require('../src/eklipz/mapmatrix.js');
require('../src/eklipz/map.js');
require('../src/eklipz/mapmove.js');
require('../src/eklipz/search.js');
require('../src/eklipz/gather.js');
require('../src/eklipz/nx.js');
require('../src/eklipz/gatherprune.js');

const TREE_BFS_DEPTH = 10;
const TREE_SELECT_COUNT = 24;

function sortedByTileIndex(tiles) {
  return tiles.slice().sort((a, b) => a.tile_index - b.tile_index);
}

function tileAt(map, idx) {
  return map.tiles_by_index[idx];
}

function myGeneralTile(map) {
  const me = map.player_index;
  const g = map.generals[me];
  if (g) return g;
  const mine = map.get_all_tiles().filter((t) => t.player() === me && t.army > 0);
  if (mine.length === 0) return null;
  mine.sort((a, b) => (b.army - a.army) || (a.tile_index - b.tile_index));
  return mine[0];
}

function buildTree(map, root) {
  const me = map.player_index;
  const parent = new Map();
  parent.set(root, null);
  const order = [root];
  const dist = new Map();
  dist.set(root, 0);
  let head = 0;
  while (head < order.length) {
    const cur = order[head++];
    if (dist.get(cur) >= TREE_BFS_DEPTH) continue;
    for (const adj of sortedByTileIndex(cur.movable)) {
      if (parent.has(adj)) continue;
      if (adj.isObstacle) continue;
      parent.set(adj, cur);
      dist.set(adj, dist.get(cur) + 1);
      order.push(adj);
    }
  }

  const candidates = order.filter((t) => t !== root);
  candidates.sort((a, b) => (b.army - a.army) || (a.tile_index - b.tile_index));
  const selected = candidates.slice(0, TREE_SELECT_COUNT);

  const needed = new Set([root]);
  for (const t of selected) {
    let cur = t;
    while (cur !== null && cur !== undefined && !needed.has(cur)) {
      needed.add(cur);
      cur = parent.get(cur);
    }
  }

  const GT = EK.GatherTreeNode;
  const nodes = new Map();
  for (const t of sortedByTileIndex(Array.from(needed))) nodes.set(t, new GT(t, null));

  const roots = [];
  for (const t of sortedByTileIndex(Array.from(needed))) {
    const p = parent.get(t);
    if (p === null || p === undefined || !needed.has(p)) {
      roots.push(nodes.get(t));
      continue;
    }
    const parentNode = nodes.get(p);
    const node = nodes.get(t);
    node.toTile = p;
    node.toGather = parentNode;
    parentNode.children.push(node);
  }

  return { roots, needed };
}

function dumpNode(node, out) {
  out.push({
    i: node.tile.tile_index,
    v: node.value,
    t: node.gatherTurns,
    tv: node.trunkValue,
    td: node.trunkDistance,
    c: node.children.map((c) => c.tile.tile_index),
    p: node.pruned.map((c) => c.tile.tile_index),
  });
  for (const child of node.children) dumpNode(child, out);
}

function treeSummary(roots) {
  const nodes = [];
  const ordered = sortedByTileIndex(roots.map((r) => r.tile));
  for (const t of ordered) {
    const root = roots.find((r) => r.tile === t);
    if (root) dumpNode(root, nodes);
  }
  const remaining = nodes.map((n) => n.i).sort((a, b) => a - b);
  const pruned = [];
  for (const n of nodes) for (const p of n.p) pruned.push(p);
  return {
    count: nodes.length,
    value: nodes.reduce((s, n) => s + n.v, 0),
    remaining,
    pruned,
    nodes,
  };
}

function cloneRoots(roots) {
  return roots.map((r) => r.deep_clone());
}

function valueFunc() {
  return function (tile, fromPrio) {
    const carry = (fromPrio === null || fromPrio === undefined) ? 0.0 : Number(fromPrio) * 0.5;
    return Number(tile.army) + carry;
  };
}

function dumpMove(m) {
  if (!m) return null;
  return [m.source.tile_index, m.dest.tile_index, !!m.move_half];
}

function buildEdges(g) {
  // 无向图：端点存储方向取决于邻接表插入顺序，两边不可能一致，
  // 统一成 (min, max) 再排序，比「边集 + 边权」而不是存储方向。
  const edges = [];
  const list = g.edges(true);
  for (const e of list) {
    const u = e[0];
    const v = e[1];
    const a = u <= v ? u : v;
    const b = u <= v ? v : u;
    const attrs = e[2] || {};
    const w = attrs.weight === undefined || attrs.weight === null ? null : Math.round(Number(attrs.weight) * 1e6) / 1e6;
    edges.push([a, b, w]);
  }
  edges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || ((a[2] === null ? -1 : a[2]) - (b[2] === null ? -1 : b[2])));
  return edges;
}

function runTurn(map, turn) {
  const me = map.player_index;
  const general = myGeneralTile(map);
  if (!general) return { turn, error: 'no general tile' };

  const { roots, needed } = buildTree(map, general);
  const valueMatrix = new EK.MapMatrix(map, 0);
  for (const t of map.get_all_tiles()) {
    valueMatrix.raw[t.tile_index] = t.player() === me ? t.army : 0;
  }

  const teams = map.team_ids_by_player_index;
  const out = {
    turn,
    player: me,
    general: general.tile_index,
    rootTiles: Array.from(needed).map((t) => t.tile_index).sort((a, b) => a - b),
    variants: {},
    steiner: null,
    edges: {},
  };

  const recalc = EK.GatherPrune.recalculate_tree_values([], roots, null, me, teams, false, null, null, false);
  out.recalc = [recalc[0], recalc[1]];
  const preTree = [];
  for (const t of sortedByTileIndex(roots.map((r) => r.tile))) {
    const root = roots.find((r) => r.tile === t);
    if (root) dumpNode(root, preTree);
  }
  out.preTree = preTree;

  const runVariant = (name, fn) => {
    try {
      const cRoots = cloneRoots(roots);
      const res = fn(cRoots);
      if (Array.isArray(res)) {
        out.variants[name] = { ret: [res[0], res[1]], tree: treeSummary(res[2]) };
      } else {
        out.variants[name] = { ret: null, tree: treeSummary(res) };
      }
    } catch (ex) {
      out.variants[name] = { error: String((ex && ex.message) || ex) };
    }
  };

  const P = EK.GatherPrune;
  runVariant('turns_8', (r) => P.prune_mst_to_turns_with_values(r, 8, me, null, true, null, null, null, null, null, true, null, null, false));
  runVariant('turns_15', (r) => P.prune_mst_to_turns_with_values(r, 15, me, null, true, null, null, null, null, null, true, null, null, false));
  const prefer = new Set(Array.from(needed).filter((t) => t.army > 3));
  runVariant('turns_8_prefer', (r) => P.prune_mst_to_turns_with_values(r, 8, me, null, true, null, null, null, prefer, null, true, null, null, true));
  runVariant('army_40', (r) => P.prune_mst_to_army_with_values(r, 40, me, teams, turn, 0, null, true, null, null, null, true, false));
  runVariant('army_120_large_first', (r) => P.prune_mst_to_army_with_values(r, 120, me, teams, turn, 0, null, true, null, null, null, true, true));
  runVariant('army_huge', (r) => P.prune_mst_to_army_with_values(r, 1000000000, me, teams, turn, 0, null, true, null, null, null, true, false));
  runVariant('max_army_per_turn_30', (r) => P.prune_mst_to_max_army_per_turn_with_values(r, 30, me, teams, 0, null, true, null, null, null, true, true, 0));
  const keepTiles = new Set(sortedByTileIndex(Array.from(needed)).slice(0, 14));
  runVariant('to_tiles', (r) => P.prune_mst_to_tiles_with_values(r, keepTiles, me, null, true, null, null, null, null, null));

  try {
    out.treeMoves = EK.GatherPrune.get_tree_moves(cloneRoots(roots), valueFunc(), 20, false).map(dumpMove);
  } catch (ex) {
    out.treeMoves = { error: String((ex && ex.message) || ex) };
  }
  try {
    out.treeMove = dumpMove(EK.GatherPrune.get_tree_move(cloneRoots(roots), valueFunc(), false));
  } catch (ex) {
    out.treeMove = { error: String((ex && ex.message) || ex) };
  }

  try {
    const cRoots = cloneRoots(roots);
    const mv = new EK.MapMatrix(map, 0);
    for (const t of map.get_all_tiles()) {
      mv.raw[t.tile_index] = t.player() === me ? t.army : (0 - t.army);
    }
    const res = EK.GatherPrune.recalculate_tree_values_from_matrix([], cRoots, mv, null, null, false);
    const mt = [];
    for (const t of sortedByTileIndex(cRoots.map((r) => r.tile))) {
      const root = cRoots.find((r) => r.tile === t);
      if (root) dumpNode(root, mt);
    }
    out.recalcFromMatrix = { ret: [res[0], res[1]], nodes: mt };
  } catch (ex) {
    out.recalcFromMatrix = { error: String((ex && ex.message) || ex) };
  }

  try {
    const steiner = EK.GatherSteiner.build_network_x_steiner_tree(map, needed, valueMatrix, me, 10000, null);
    out.steiner = Array.from(steiner).map((t) => t.tile_index).sort((a, b) => a - b);
  } catch (ex) {
    out.steiner = { error: String((ex && ex.message) || ex) };
  }

  const tryGraph = (name, fn) => {
    try {
      out.edges[name] = buildEdges(fn());
    } catch (ex) {
      out.edges[name] = { error: String((ex && ex.message) || ex) };
    }
  };
  tryGraph('subtract', () => EK.NetworkXHelpers.build_networkX_graph_flat_weight_mod_subtract(map, valueMatrix, 10000, null, needed));
  tryGraph('noObstacles', () => EK.NetworkXHelpers.build_networkX_graph_no_obstacles_no_weights(map, null, needed));
  tryGraph('scale', () => EK.NetworkXHelpers.build_networkX_graph_flat_weight_mod_scale(map, valueMatrix, 0.0, 1.0, null, needed));

  return out;
}

/* ------------------------------------------------------------------ 比对 */

function diffValues(py, js, out, prefix) {
  if (py === js) return;
  if (py === null || py === undefined || js === null || js === undefined) {
    out.push(`${prefix}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (Array.isArray(py) && Array.isArray(js)) {
    if (py.length !== js.length) out.push(`${prefix}.length: py=${py.length} js=${js.length}`);
    const n = Math.min(py.length, js.length);
    for (let i = 0; i < n; i++) diffValues(py[i], js[i], out, `${prefix}[${i}]`);
    return;
  }
  if (typeof py === 'object' && typeof js === 'object') {
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of Array.from(keys).sort()) diffValues(py[k], js[k], out, `${prefix}.${k}`);
    return;
  }
  if (typeof py === 'number' && typeof js === 'number') {
    if (Math.abs(py - js) < 1e-9) return;
  }
  out.push(`${prefix}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));

  const byTurn = new Map();
  for (const d of oracle) byTurn.set(d.turn, d);

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'gatherprune',
    game_type: 'custom',
    options: {},
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  let compared = 0;
  let firstBad = null;
  const fieldStats = {};

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined && startData.playerIndex !== rec.dump.player) {
      startData.playerIndex = rec.dump.player;
    }
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
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
    if (rec.turn === undefined) continue;

    const pyDump = byTurn.get(rec.turn);
    if (!pyDump) continue;
    total++;

    if (pyDump.error) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'python 侧报错: ' + pyDump.error };
      continue;
    }

    let jsRes;
    try {
      jsRes = runTurn(map, rec.turn);
    } catch (ex) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'js 抛错: ' + ((ex && ex.stack) || ex) };
      continue;
    }

    const diffs = [];
    const fields = ['general', 'rootTiles', 'recalc', 'preTree', 'variants', 'treeMoves', 'treeMove', 'recalcFromMatrix', 'steiner', 'edges'];
    for (const f of fields) {
      const local = [];
      diffValues(pyDump[f], jsRes[f], local, f);
      if (local.length > 0) {
        fieldStats[f] = (fieldStats[f] || 0) + local.length;
        for (const d of local.slice(0, 4)) diffs.push(`T${rec.turn}.${d}`);
        if (local.length > 4) diffs.push(`T${rec.turn}.${f}: 另 ${local.length - 4} 条同类差异`);
      }
    }

    if (diffs.length === 0) {
      compared++;
    } else {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: diffs.slice(0, 12).join('\n') };
    }
  }

  if (firstBad) {
    console.log('首个不一致:');
    console.log('  turn ' + firstBad.turn + ' — ' + firstBad.why);
  }
  if (Object.keys(fieldStats).length > 0) {
    console.log('差异按字段汇总: ' + JSON.stringify(fieldStats));
  }
  const rate = total === 0 ? 0 : (compared / total) * 100;
  console.log(`回合总数 ${total}，不一致 ${total - compared}，一致率 ${rate.toFixed(1)}%`);
}

main();

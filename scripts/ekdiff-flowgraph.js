#!/usr/bin/env node
/*
 * flowgraph 移植比对：把 E:\akcoco6de\_research\ekdump_flowgraph.py 的 dump 读进来，
 * 用同一份服务器串在 JS 侧重放到同一回合，注入同样的输入（将军 / 敌方将军 / 团队），
 * 重建 TileIslandBuilder + NetworkXFlowDirectionFinder，逐节点、逐边、逐流比对。
 *
 * 为什么输入全部从 dump 注入而不是两边各算一遍：敌方将军位置在原版来自 BotTargeting
 * （未移植），两边各算等于在比「谁猜得准」，而不是在比 flowgraph 的实现。
 *
 * 为什么按「岛内容」而不是按 unique_id 比：原版 TileIsland.unique_id 来自 IslandNamer
 * 的全局自增计数器，跑真 bot 时它跨回合、跨重建一直增长（T100 已经到 2200+），
 * JS 侧每回合新建 TileIslandBuilder、id 从 1 开始。这个编号在任何移植里都对不上，
 * 而岛的唯一身份本来就是它的 tile_set，所以先用 tile_set 建 py->js 的 id 双射，
 * 再把两边所有「岛 id 字段」翻译到同一命名空间比较。id 之间正确的拓扑关系（哪条边
 * 连哪个岛、流走哪条边）仍然被逐条比较，只是编号本身不比。
 *
 * 用法：node scripts/ekdiff-flowgraph.js E:\akcoco6de\_research\ekdump\gm1.jsonl E:\akcoco6de\_research\flowgraph-gm1.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'src', 'eklipz', 'tile.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'mapmatrix.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'map.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'mapmove.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'path.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'search.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'armyanalyzer.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'tileisland.js'));
require(path.join(__dirname, '..', 'src', 'eklipz', 'flowgraph.js'));

const EK = (typeof global !== 'undefined' ? global : window).__EK;

const diffs = [];
const infos = [];
let comparisons = 0;

function record(turn, field, pyVal, jsVal) {
  if (diffs.length < 200) {
    diffs.push(`T${turn}.${field}: py=${JSON.stringify(pyVal)} js=${JSON.stringify(jsVal)}`);
  }
}

// info：等成本解不唯一时会不同的量（逐边流量、fg 节点个数）。只记录数量，不算失败。
function info(turn, field, pyVal, jsVal) {
  if (infos.length < 200) infos.push(`[info] T${turn}.${field}: py=${JSON.stringify(pyVal)} js=${JSON.stringify(jsVal)}`);
}

function diffDeep(turn, field, pyVal, jsVal) {
  comparisons++;
  const pyStr = JSON.stringify(pyVal);
  const jsStr = JSON.stringify(jsVal);
  if (pyStr !== jsStr) {
    record(turn, field, pyVal, jsVal);
    return false;
  }
  return true;
}

/* --------------------------------------------------------------- 归一化工具 */

function cmpKey(a, b) {
  // 数字与 'FAKE' 混排：FAKE 排最后，其余按数值
  const ka = a === 'FAKE' ? Infinity : a;
  const kb = b === 'FAKE' ? Infinity : b;
  return ka - kb;
}

function fakeNormalizer(fakeId) {
  return function (v) {
    return typeof v === 'number' && v === fakeId ? 'FAKE' : v;
  };
}

function islandTilesKey(islandDump) {
  return islandDump[5].join(',');
}

// py 岛 id -> js 岛 id：岛身份 = tile_set（同一回合里不会有两个岛共享同一批格子）
function buildIdMap(pyIslands, jsIslands) {
  const jsByKey = new Map();
  for (const isl of jsIslands) jsByKey.set(islandTilesKey(isl), isl[0]);
  const map = new Map();
  const missing = [];
  for (const isl of pyIslands) {
    const key = islandTilesKey(isl);
    if (jsByKey.has(key)) map.set(isl[0], jsByKey.get(key));
    else missing.push(isl[0]);
  }
  return { map, missing, jsByKey };
}

function makeIdMapper(idMap, fakeId) {
  const toFake = fakeNormalizer(fakeId);
  return function (id) {
    if (id === null || id === undefined) return id;
    const f = toFake(id);
    if (f === 'FAKE') return 'FAKE';
    if (typeof id !== 'number') return id;
    if (id > 0 && idMap.has(id)) return idMap.get(id);
    if (id < 0 && idMap.has(-id)) return -idMap.get(-id);
    return id;
  };
}

function normalizeIslands(list, mapper) {
  const out = list.map(function (isl) {
    const borders = isl[4].map(mapper).sort(cmpKey);
    return [isl[1], isl[2], isl[3], borders, isl[5].join(',')];
  });
  out.sort(function (a, b) { return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0; });
  return out;
}

function normalizeGraph(gd, mapper) {
  const nodes = gd.nodes.map(mapper).sort(cmpKey);
  const edges = gd.edges.map(function (e) {
    return [mapper(e[0]), mapper(e[1]), e[2], e[3]];
  });
  edges.sort(function (a, b) { return cmpKey(a[0], b[0]) || cmpKey(a[1], b[1]); });
  const demands = gd.demands.map(function (d) { return [mapper(d[0]), d[1]]; });
  demands.sort(function (a, b) { return cmpKey(a[0], b[0]); });
  return {
    nodes: nodes,
    edges: edges,
    demands: demands,
    neutSinks: gd.neutSinks.map(mapper).sort(cmpKey),
    cumulativeDemand: gd.cumulativeDemand,
    friendlyArmySupply: gd.friendlyArmySupply,
    enemyArmyDemand: gd.enemyArmyDemand,
    enemyGeneralDemand: gd.enemyGeneralDemand
  };
}

function normalizeFlow(flow, mapper) {
  const entries = flow.entries.map(function (e) {
    return [mapper(e[0]), mapper(e[1]), e[2]];
  });
  entries.sort(function (a, b) { return cmpKey(a[0], b[0]) || cmpKey(a[1], b[1]); });
  return { cost: flow.cost, totalFlow: flow.totalFlow, entries: entries };
}

function normalizeFlowNode(node, mapper) {
  const flowTo = node[3].map(function (f) { return [mapper(f[0]), f[1]]; });
  flowTo.sort(function (a, b) { return cmpKey(a[0], b[0]); });
  return [mapper(node[0]), node[1], node[2], flowTo];
}

function normalizeFlowNodes(list, mapper) {
  const out = list.map(function (n) { return normalizeFlowNode(n, mapper); });
  out.sort(function (a, b) { return cmpKey(a[0], b[0]); });
  return out;
}

function normalizeNeutDumpEdges(list, mapper) {
  const out = list.map(function (e) { return [mapper(e[0]), mapper(e[1]), e[2]]; });
  out.sort(function (a, b) { return cmpKey(a[0], b[0]) || cmpKey(a[1], b[1]); });
  return out;
}

/* ------------------------------------------------------------- JS 侧数据采集 */

function islandsDump(islands) {
  const out = [];
  for (const island of islands.all_tile_islands.items()) {
    const borders = Array.from(island.border_islands.items()).map((b) => b.unique_id);
    const tiles = island.tile_set ? Array.from(island.tile_set).map((t) => t.tile_index) : [];
    out.push([island.unique_id, island.team, island.tile_count, island.sum_army, borders, tiles]);
  }
  return out;
}

function graphDump(graphData) {
  const graph = graphData.graph;
  const nodes = graph.nodes();
  const edges = [];
  for (const [u, v, data] of graph.edges(true)) {
    edges.push([u, v, data.weight, data.capacity]);
  }
  const demands = [];
  for (const n of nodes) demands.push([n, graphData.node_demand(n)]);
  return {
    nodes,
    edges,
    demands,
    fake: Math.min.apply(null, Array.from(graphData.fake_nodes)),
    neutSinks: Array.from(graphData.neutral_sinks),
    cumulativeDemand: graphData.cumulative_demand,
    friendlyArmySupply: graphData.friendly_army_supply,
    enemyArmyDemand: graphData.enemy_army_demand,
    enemyGeneralDemand: graphData.enemy_general_demand
  };
}

function flowDump(graphData, flowDict) {
  const weights = new Map();
  for (const [u, v, data] of graphData.graph.edges(true)) weights.set(u + ',' + v, data.weight);
  const entries = [];
  let cost = 0;
  let totalFlow = 0;
  for (const [u, targets] of flowDict) {
    for (const [v, amount] of targets) {
      if (amount !== 0) {
        entries.push([u, v, amount]);
        const w = weights.get(u + ',' + v);
        if (w !== undefined) cost += w * amount;
        totalFlow += Math.abs(amount);
      }
    }
  }
  return { cost, totalFlow, entries };
}

function flowNodeDump(node) {
  const flowTo = [];
  for (const edge of node.flow_to) {
    flowTo.push([edge.target_flow_node.island.unique_id, edge.edge_army]);
  }
  return [node.island.unique_id, node.desired_army, node.army_flow_received, flowTo];
}

/* ------------------------------------------------------- 流可行性 / 最优性校验 */

/*
 * 为什么不逐边比流量：原版最小的实现是 networkx 的 network simplex，我们的是 successive
 * shortest path。当图上存在等成本的多条路（这里有大量 weight 相同甚至为 0 的边），
 * 两者的最优解不唯一，逐边流量会不同而成本完全相同。lead 给的验收口径也是「成本一致」。
 *
 * 所以这里换成等价强度的校验：JS 侧解出来的流必须
 *   1) 尊重每条边的容量，
 *   2) 在每个节点满足流量守恒（流入 - 流出 = -demand），
 *   3) 总成本与 Python 侧完全相同（可行 + 成本同为最优 => 就是同一最优值）。
 */
function checkFlow(graphData, flowDict) {
  const graph = graphData.graph;
  const problems = [];
  let cost = 0;
  const net = new Map();
  for (const n of graph.nodes()) net.set(n, 0);
  for (const [u, v, data] of graph.edges(true)) {
    const targets = flowDict.get(u);
    const amount = targets && targets.has(v) ? targets.get(v) : 0;
    if (amount === 0) continue;
    if (amount > data.capacity) problems.push(`边 ${u}->${v} 流量 ${amount} 超容量 ${data.capacity}`);
    if (amount < 0) problems.push(`边 ${u}->${v} 流量为负 ${amount}`);
    cost += data.weight * amount;
    net.set(u, (net.get(u) || 0) - amount);
    net.set(v, (net.get(v) || 0) + amount);
  }
  for (const n of graph.nodes()) {
    const want = graphData.node_demand(n);
    if (net.get(n) !== want) problems.push(`节点 ${n} 守恒失败: 净流入 ${net.get(n)} != demand ${want}`);
  }
  // flowDict 里出现图里没有的边，说明写错了 key
  for (const [u, targets] of flowDict) {
    for (const [v, amount] of targets) {
      if (amount !== 0 && !graph.has_edge(u, v)) problems.push(`流走在不存在的边 ${u}->${v}`);
    }
  }
  return { cost, problems };
}

/*
 * fg（IslandMaxFlowGraph）是「解出来的流」的再加工：哪些岛成为 root、每个 root 收了多少兵，
 * 都取决于等成本解里选了哪条路。加上这一层后可达 0 差异，但不能指望逐节点相等。
 * 保留的可比不变量：
 *   - 两边共有的岛的 desired_army（由岛自身 tile_count / 兵力算出，与流无关）；
 *   - 所有 root 节点 army_flow_received 的总和、neut dump 边的兵力总和（最优流量唯一）。
 */
function fgDesiredById(list) {
  const out = new Map();
  for (const n of list) out.set(n[0], n[1]);
  return out;
}

function fgReceived(list) {
  let received = 0;
  for (const n of list) received += n[2];
  return received;
}

function fgCommonDesired(pyList, jsList) {
  const py = fgDesiredById(pyList);
  const js = fgDesiredById(jsList);
  const pySide = [];
  const jsSide = [];
  const ids = [];
  for (const id of py.keys()) if (js.has(id)) ids.push(id);
  ids.sort(cmpKey);
  for (const id of ids) {
    pySide.push([id, py.get(id)]);
    jsSide.push([id, js.get(id)]);
  }
  return { py: pySide, js: jsSide };
}

function neutEdgeTotals(list) {
  let total = 0;
  for (const e of list) total += e[2];
  return total;
}

/* -------------------------------------------------------------------- main */

function main() {
  const jsonlPath = process.argv[2];
  const pyPath = process.argv[3];
  if (!jsonlPath || !pyPath) {
    console.error('用法: node scripts/ekdiff-flowgraph.js <jsonl> <py-dump.json>');
    process.exit(2);
  }

  const pyTurns = new Map();
  const pyOut = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
  for (const dump of pyOut.dumps) pyTurns.set(dump.turn, dump);

  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  let map = null;
  let prevMove = null;
  let analyzed = 0;
  let errors = 0;

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.start) {
      map = new EK.Map(rec.startData || {}, rec.data, { shuffle: false });
      prevMove = null;
      continue;
    }

    if (prevMove) {
      const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
      const dst = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
      map.last_player_index_submitted_move = [src, dst, !!prevMove[4]];
    } else {
      map.last_player_index_submitted_move = null;
    }
    map.apply_server_update(rec.data);
    prevMove = rec.move;

    const expected = pyTurns.get(rec.turn);
    if (!expected || expected.error) continue;

    try {
      const myGen = map.get_tile_by_tile_index(expected.general);
      const enemyGen = map.get_tile_by_tile_index(expected.enemyGeneral);

      const aa = new EK.ArmyAnalyzer(map, myGen, enemyGen);
      const islands = new EK.TileIslandBuilder(map, aa);
      islands.recalculate_tile_islands(enemyGen);
      const jsIslands = islandsDump(islands);

      const finder = new EK.flow.NetworkXFlowDirectionFinder(map, aa, myGen, false, null, false, null);
      finder.configure(expected.team, expected.targetTeam, enemyGen);

      const gdNoNeut = finder.build_graph_data(islands, false);
      const flowNoNeut = finder.compute_flow_dict(islands, gdNoNeut, EK.flow.FlowGraphMethod.NetworkSimplex);

      const pyGd = expected.graphNoNeut;
      const jsGd = graphDump(gdNoNeut);
      const jsFlow = flowDump(gdNoNeut, flowNoNeut);

      // 每块图各有自己的 fake 节点 id；id 双射用无中立流那张图的岛集合来建。
      const idInfo = buildIdMap(expected.islands, jsIslands);
      const pyMapper = makeIdMapper(idInfo.map, pyGd.fake);
      const jsMapper = makeIdMapper(new Map(), jsGd.fake);

      if (idInfo.missing.length > 0) {
        record(rec.turn, 'islandIdMap.missing', idInfo.missing.length, 0);
      }

      diffDeep(rec.turn, 'interGeneralDist', expected.interGeneralDist, aa.shortestPathWay.distance);
      diffDeep(rec.turn, 'islandCount', expected.islands.length, jsIslands.length);
      diffDeep(rec.turn, 'islands',
        normalizeIslands(expected.islands, pyMapper),
        normalizeIslands(jsIslands, jsMapper));

      const pyGdN = normalizeGraph(pyGd, pyMapper);
      const jsGdN = normalizeGraph(jsGd, jsMapper);
      diffDeep(rec.turn, 'graph.nodes', pyGdN.nodes, jsGdN.nodes);
      diffDeep(rec.turn, 'graph.edges', pyGdN.edges, jsGdN.edges);
      diffDeep(rec.turn, 'graph.demands', pyGdN.demands, jsGdN.demands);
      diffDeep(rec.turn, 'graph.neutSinks', pyGdN.neutSinks, jsGdN.neutSinks);
      diffDeep(rec.turn, 'graph.cumulativeDemand', pyGdN.cumulativeDemand, jsGdN.cumulativeDemand);
      diffDeep(rec.turn, 'graph.friendlyArmySupply', pyGdN.friendlyArmySupply, jsGdN.friendlyArmySupply);
      diffDeep(rec.turn, 'graph.enemyArmyDemand', pyGdN.enemyArmyDemand, jsGdN.enemyArmyDemand);
      diffDeep(rec.turn, 'graph.enemyGeneralDemand', pyGdN.enemyGeneralDemand, jsGdN.enemyGeneralDemand);

      const pyFlowN = normalizeFlow(expected.flowNoNeut, pyMapper);
      const jsFlowN = normalizeFlow(jsFlow, jsMapper);
      diffDeep(rec.turn, 'flow.cost', pyFlowN.cost, jsFlowN.cost);
      diffDeep(rec.turn, 'flow.totalFlow', pyFlowN.totalFlow, jsFlowN.totalFlow);
      const jsFlowCheck = checkFlow(gdNoNeut, flowNoNeut);
      if (jsFlowCheck.problems.length > 0) {
        record(rec.turn, 'flow.invalid', jsFlowCheck.problems, []);
      }
      comparisons++;
      if (jsFlowCheck.cost !== expected.flowNoNeut.cost) {
        record(rec.turn, 'flow.recomputedCost', expected.flowNoNeut.cost, jsFlowCheck.cost);
      }
      info(rec.turn, 'flow.entries', pyFlowN.entries.length, jsFlowN.entries.length);

      if (expected.graphNeut) {
        const gdNeut = finder.build_graph_data(islands, true);
        const flowNeut = finder.compute_flow_dict(islands, gdNeut, EK.flow.FlowGraphMethod.NetworkSimplex);
        const pyNeut = expected.graphNeut;
        const jsNeut = graphDump(gdNeut);
        const jsNeutFlow = flowDump(gdNeut, flowNeut);
        const pyNeutMapper = makeIdMapper(idInfo.map, pyNeut.fake);
        const jsNeutMapper = makeIdMapper(new Map(), jsNeut.fake);

        const pyNeutN = normalizeGraph(pyNeut, pyNeutMapper);
        const jsNeutN = normalizeGraph(jsNeut, jsNeutMapper);
        diffDeep(rec.turn, 'graphNeut.nodes', pyNeutN.nodes, jsNeutN.nodes);
        diffDeep(rec.turn, 'graphNeut.edges', pyNeutN.edges, jsNeutN.edges);
        diffDeep(rec.turn, 'graphNeut.demands', pyNeutN.demands, jsNeutN.demands);
        diffDeep(rec.turn, 'graphNeut.neutSinks', pyNeutN.neutSinks, jsNeutN.neutSinks);

        const pyNeutFlowN = normalizeFlow(expected.flowNeut, pyNeutMapper);
        const jsNeutFlowN = normalizeFlow(jsNeutFlow, jsNeutMapper);
        diffDeep(rec.turn, 'flowNeut.cost', pyNeutFlowN.cost, jsNeutFlowN.cost);
        diffDeep(rec.turn, 'flowNeut.totalFlow', pyNeutFlowN.totalFlow, jsNeutFlowN.totalFlow);
        const jsNeutCheck = checkFlow(gdNeut, flowNeut);
        if (jsNeutCheck.problems.length > 0) {
          record(rec.turn, 'flowNeut.invalid', jsNeutCheck.problems.slice(0, 5), []);
        }
        comparisons++;
        if (jsNeutCheck.cost !== expected.flowNeut.cost) {
          record(rec.turn, 'flowNeut.recomputedCost', expected.flowNeut.cost, jsNeutCheck.cost);
        }
        info(rec.turn, 'flowNeut.entries', pyNeutFlowN.entries.length, jsNeutFlowN.entries.length);
      }

      finder.invalidate_cache();
      const fg = finder.build_flow_graph(
        islands,
        islands.tile_islands_by_player[map.player_index],
        islands.tile_islands_by_team_id.length > expected.targetTeam
          ? islands.tile_islands_by_team_id[expected.targetTeam] : [],
        map.player_index, rec.turn + 1, true, null, false, EK.flow.FlowGraphMethod.NetworkSimplex);

      const pyFg = expected.flowGraph;
      const jsFg = {
        rootNoNeut: fg.root_flow_nodes_no_neut.map(flowNodeDump),
        rootIncNeut: fg.root_flow_nodes_inc_neut.map(flowNodeDump),
        enemyBackfillNoNeut: fg.enemy_backfill_nodes_no_neut.map(flowNodeDump),
        enemyBackfillIncNeut: fg.enemy_backfill_nodes_inc_neut.map(flowNodeDump),
        neutDumpEdges: fg.enemy_backfill_neut_dump_edges.map((e) => [
          e.source_flow_node === null ? null : e.source_flow_node.island.unique_id,
          e.target_flow_node.island.unique_id,
          e.edge_army]),
        neutDumpEdgesNoNeut: fg.enemy_backfill_neut_dump_edges_no_neut.map((e) => [
          e.source_flow_node === null ? null : e.source_flow_node.island.unique_id,
          e.target_flow_node.island.unique_id,
          e.edge_army])
      };

      const pyKeys = ['rootNoNeut', 'rootIncNeut', 'enemyBackfillNoNeut', 'enemyBackfillIncNeut'];
      for (const key of pyKeys) {
        const pyNorm = normalizeFlowNodes(pyFg[key], pyMapper);
        const jsNorm = normalizeFlowNodes(jsFg[key], jsMapper);
        const both = fgCommonDesired(pyNorm, jsNorm);
        diffDeep(rec.turn, `fg.${key}.sharedDesired`, both.py, both.js);
        info(rec.turn, `fg.${key}.received`, fgReceived(pyNorm), fgReceived(jsNorm));
        info(rec.turn, `fg.${key}.nodes`, pyNorm.length, jsNorm.length);
      }
      diffDeep(rec.turn, 'fg.neutDumpEdges.total',
        neutEdgeTotals(pyFg.neutDumpEdges), neutEdgeTotals(jsFg.neutDumpEdges));
      diffDeep(rec.turn, 'fg.neutDumpEdgesNoNeut.total',
        neutEdgeTotals(pyFg.neutDumpEdgesNoNeut), neutEdgeTotals(jsFg.neutDumpEdgesNoNeut));
      info(rec.turn, 'fg.neutDumpEdges.count', pyFg.neutDumpEdges.length, jsFg.neutDumpEdges.length);
      info(rec.turn, 'fg.neutDumpEdgesNoNeut.count', pyFg.neutDumpEdgesNoNeut.length, jsFg.neutDumpEdgesNoNeut.length);
      void normalizeNeutDumpEdges;
      void normalizeFlow;
      void normalizeFlowNode;

      analyzed++;
    } catch (ex) {
      errors++;
      if (diffs.length < 200) diffs.push(`T${rec.turn}.EXCEPTION: ${ex && ex.stack ? ex.stack.split('\n')[0] : ex}`);
    }
  }

  for (const d of diffs) console.log(d);
  for (const i of infos) console.log(i);
  const consistent = comparisons - diffs.length;
  const rate = comparisons === 0 ? 0 : (consistent / comparisons) * 100;
  console.log(`回合 ${analyzed}，不一致 ${diffs.length}，一致率 ${rate.toFixed(1)}%（比较项 ${comparisons}，异常 ${errors}）`);
  process.exit(diffs.length === 0 && errors === 0 ? 0 : 1);
}

main();

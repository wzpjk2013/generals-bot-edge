/**
 * ekdiff-flowmincost.js —— 流扩张最小费用图与最小费用流 的 JS↔Python 逐项比对
 *
 * 用法：
 *   node scripts\ekdiff-flowmincost.js ..\_research\flowmincost-gm1.json
 *
 * 数据来源：_research\ekdump_flowmincost.py 导出的 oracle。每个回合里有若干次
 * `build_graph_data` 调用（每次含完整弧表 + 该次调用的输入），我们用它重建出
 * 与 python 完全相同的 island/tile 视图，再走 JS 侧 `EK.flow.DirectOrToolsGraphBuilder`
 * 与 `EK.flow.MinCostFlow`，逐项比对：
 *   1. 弧表（start/end/cap/cost）—— cost 必须逐项一致（fake node 的随机 id 归一化后再比）
 *   2. 节点供给表
 *   3. flow dict —— 成本必须一致；只有路径选择不同但成本相同时归到「仅平局不同」
 *
 * 为什么要 fake id 归一化：原版用 random.randint 生成 fake node id，每次运行都不同，
 * 但它只作为「伪节点」的标识参与拓扑，不参与数值。归一化后两边才可比。
 */

'use strict';

var path = require('path');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
function loadModule(relPath) {
  return require(path.join(ROOT, relPath));
}

// flowgraph.js 由并行的 mapmove-port 同事在改，可能暂时语法坏了；坏了也要能比对图与流，
// 因此这里做了降级：拿不到基类就自己造一个最小 classify，仅用于比对（会在输出里标注）。
loadModule('src/eklipz/tile.js');
loadModule('src/eklipz/mapmatrix.js');
loadModule('src/eklipz/search.js');
loadModule('src/eklipz/path.js');
var flowgraphOk = true;
try {
  loadModule('src/eklipz/flowgraph.js');
} catch (e) {
  flowgraphOk = false;
  process.stderr.write('警告: flowgraph.js 加载失败（' + e.message + '），基类改用内置兜底\n');
}
loadModule('src/eklipz/flowmincost.js');

var EK = global.__EK;
if (!EK || !EK.flow || !EK.flow.DirectOrToolsGraphBuilder) {
  throw new Error('EK.flow.DirectOrToolsGraphBuilder 缺失，检查 flowmincost.js');
}

var FAKE = '__FAKE__';

// ---------------- 从 oracle payload 重建 JS 侧视图 ----------------

function buildTiles(row) {
  var tiles = [];
  for (var i = 0; i < row.tiles.length; i++) {
    var r = row.tiles[i];
    // player 做成方法：map.js 的 Tile.player() 就是方法，原版 port 出来的代码都按方法调；
    // 我们自己 builder 里的 playerOf(tile) 两种都吃。
    var playerValue = r[4];
    tiles[r[0]] = {
      tile_index: r[0],
      x: r[1],
      y: r[2],
      army: r[3],
      player: makePlayerFn(playerValue),
      playerValue: playerValue,
      isCity: !!r[5],
      isGeneral: !!r[6],
      isMountain: !!r[7],
      visible: !!r[8],
      // python 的 isObstacle 就是 army < 0（山 -2 / 迷雾障碍 -4）
      isObstacle: r[3] < 0,
      movable: [],
    };
  }
  // movables：四邻域 + 跳过障碍，与 python Tile.movable 一致
  var cols = row.cols;
  for (var j = 0; j < tiles.length; j++) {
    var t = tiles[j];
    if (!t) continue;
    var cand = [];
    if (t.x > 0) cand.push(tileAt(tiles, cols, t.x - 1, t.y));
    if (t.x < cols - 1) cand.push(tileAt(tiles, cols, t.x + 1, t.y));
    if (t.y > 0) cand.push(tileAt(tiles, cols, t.x, t.y - 1));
    if (t.y < row.rows - 1) cand.push(tileAt(tiles, cols, t.x, t.y + 1));
    for (var c = 0; c < cand.length; c++) {
      if (cand[c] && !cand[c].isObstacle) t.movable.push(cand[c]);
    }
  }
  return tiles;
}

function tileAt(tiles, cols, x, y) {
  return tiles[y * cols + x];
}

function makePlayerFn(v) {
  var fn = function () { return v; };
  fn.valueOf = function () { return v; };
  return fn;
}

function buildIslands(row, tiles) {
  var byId = new Map();
  var payload = row.islands || [];
  for (var i = 0; i < payload.length; i++) {
    var p = payload[i];
    var isl = {
      unique_id: p.id,
      team: p.team,
      tile_count: p.tileCount,
      sum_army: p.sumArmy,
      tiles_by_army: [],
      tile_set: new Set(),
      border_islands: [],
      _borderIds: p.borderIds,
      _tileIndices: p.tileIndices,
    };
    for (var j = 0; j < p.tileIndices.length; j++) {
      isl.tile_set.add(tiles[p.tileIndices[j]]);
    }
    for (var k = 0; k < p.tilesByArmy.length; k++) {
      isl.tiles_by_army.push(tiles[p.tilesByArmy[k]]);
    }
    byId.set(p.id, isl);
  }
  for (var m = 0; m < payload.length; m++) {
    var isl2 = byId.get(payload[m].id);
    for (var n = 0; n < payload[m].borderIds.length; n++) {
      var b = byId.get(payload[m].borderIds[n]);
      if (b) isl2.border_islands.push(b);
    }
  }
  var lookup = { raw: [] };
  for (var t = 0; t < tiles.length; t++) {
    lookup.raw[t] = null;
  }
  for (var q = 0; q < payload.length; q++) {
    var isl3 = byId.get(payload[q].id);
    for (var r2 = 0; r2 < payload[q].tileIndices.length; r2++) {
      lookup.raw[payload[q].tileIndices[r2]] = isl3;
    }
  }
  var list = [];
  payload.forEach(function (p2) { list.push(byId.get(p2.id)); });
  list.sort(function (a, b2) { return a.unique_id - b2.unique_id; });
  return {
    all_tile_islands: list,
    tile_island_lookup: lookup,
    tile_islands_by_unique_id: byId,
    get_all_tile_islands: function () { return list; },
  };
}

function buildIntergeneralAnalysis(row, inputs, tiles) {
  // flowgraph 的 classify 用 `pathwayTiles.has(tile对象)` 判「在走廊上」，所以这里必须放 tile 对象；
  // 放 tile_index 会让所有走廊格都被当成「不在走廊上」，中立岛容量算多，sink 少一个。
  var pathwayTiles = new Set();
  for (var i = 0; i < inputs.pathwayTiles.length; i++) {
    var pt = tiles[inputs.pathwayTiles[i]];
    if (pt) pathwayTiles.add(pt);
  }
  return {
    aMap: { raw: row.aMap },
    bMap: { raw: row.bMap },
    shortestPathWay: {
      distance: inputs.pathwayDistance,
      distanceFloat: inputs.pathwayDistance,
      tiles: pathwayTiles,
      hasTile: function (t) {
        return pathwayTiles.has(typeof t === 'number' ? tiles[t] : t);
      },
    },
    inter_general_distance: row.interGeneralDistance,
  };
}

function buildMapObj(row, tiles, overrides) {
  var players = [];
  for (var i = 0; i < 16; i++) players[i] = { general: null, tiles: [] };
  for (var t = 0; t < tiles.length; t++) {
    var tile = tiles[t];
    if (!tile) continue;
    var pi = tile.playerValue;
    if (pi >= 0 && players[pi]) players[pi].tiles.push(tile);
    if (tile.isGeneral && pi >= 0 && players[pi] && !players[pi].general) players[pi].general = tile;
  }
  players[row.playerIndex].general = overrides.friendlyGeneralTile;
  var targetIdx = row.targetPlayer >= 0 ? row.targetPlayer : 1 - row.playerIndex;
  players[targetIdx].general = overrides.enemyGeneralTile;
  return {
    friendly_team: overrides.team,
    player_index: row.playerIndex,
    players: players,
    reachable_tiles: null, // python 不过滤不可达岛，这里也必须为 null，否则图会少岛
    turn: row.turn,
    rows: row.rows,
    cols: row.cols,
    tiles_by_index: tiles,
    get_teams_array: function () { return [0, 1]; },
    get_team_stats_by_team_id: function () {
      return { livingPlayers: overrides.livingPlayers.slice() };
    },
    is_player_on_team_with: function (a, b) { return a === b; },
  };
}

// ---------------- 比对工具 ----------------

function arcKey(start, end, fakeSet) {
  var s = fakeSet.has(start) ? FAKE : String(start);
  var e = fakeSet.has(end) ? FAKE : String(end);
  return s + '->' + e;
}

function jsArcsById(g) {
  // JS 图里的 start_nodes/end_nodes 与 python 一样是「node_ids 的下标」，这里翻成原始 node id
  var arcs = [];
  for (var i = 0; i < g.start_nodes.length; i++) {
    arcs.push({
      start: g.node_ids[g.start_nodes[i]],
      end: g.node_ids[g.end_nodes[i]],
      cap: g.capacities[i],
      cost: g.unit_costs[i],
    });
  }
  return arcs;
}

function compareArcs(pyGraph, jsGraph) {
  var pyFake = new Set(pyGraph.fakeNodes || []);
  var jsFake = new Set(jsGraph.fake_nodes || []);
  var jsArcs = jsArcsById(jsGraph);
  var py = new Map();
  for (var i = 0; i < pyGraph.startNodes.length; i++) {
    // python 的 start_nodes / end_nodes 存的是 node_ids 的下标，不是原始 node id
    var ps = pyGraph.nodeIds[pyGraph.startNodes[i]];
    var pe = pyGraph.nodeIds[pyGraph.endNodes[i]];
    var k = arcKey(ps, pe, pyFake);
    if (!py.has(k)) py.set(k, []);
    py.get(k).push([pyGraph.capacities[i], pyGraph.unitCosts[i]]);
  }
  var js = new Map();
  for (var j = 0; j < jsArcs.length; j++) {
    var a = jsArcs[j];
    var k2 = arcKey(a.start, a.end, jsFake);
    if (!js.has(k2)) js.set(k2, []);
    js.get(k2).push([a.cap, a.cost]);
  }
  var diffs = [];
  var keys = new Set();
  py.forEach(function (v, k) { keys.add(k); });
  js.forEach(function (v, k) { keys.add(k); });
  keys.forEach(function (k) {
    var pv = (py.get(k) || []).map(function (x) { return x.join('/'); }).sort();
    var jv = (js.get(k) || []).map(function (x) { return x.join('/'); }).sort();
    if (pv.length !== jv.length || pv.join('|') !== jv.join('|')) {
      diffs.push({ key: k, py: pv, js: jv });
    }
  });
  diffs.sort(function (a2, b2) { return a2.key < b2.key ? -1 : a2.key > b2.key ? 1 : 0; });
  return { pyCount: pyGraph.startNodes.length, jsCount: jsArcs.length, diffs: diffs };
}

function compareSupplies(pyGraph, jsGraph) {
  var pyFake = new Set(pyGraph.fakeNodes || []);
  var jsFake = new Set(jsGraph.fake_nodes || []);
  var py = new Map();
  for (var i = 0; i < pyGraph.nodeIds.length; i++) {
    var id = pyGraph.nodeIds[i];
    py.set(pyFake.has(id) ? FAKE : String(id), pyGraph.nodeSupplies[i]);
  }
  var js = new Map();
  for (var j = 0; j < jsGraph.node_ids.length; j++) {
    var id2 = jsGraph.node_ids[j];
    js.set(jsFake.has(id2) ? FAKE : String(id2), jsGraph.node_supplies[j]);
  }
  var diffs = [];
  var keys = new Set();
  py.forEach(function (v, k) { keys.add(k); });
  js.forEach(function (v, k) { keys.add(k); });
  keys.forEach(function (k) {
    var a = py.has(k) ? py.get(k) : '(缺)';
    var b = js.has(k) ? js.get(k) : '(缺)';
    if (String(a) !== String(b)) diffs.push({ key: k, py: a, js: b });
  });
  return diffs;
}

function flowCost(flows, arcIndex) {
  // flows: Map(from -> Map(to -> amount))；用 JS 侧弧表的 cost 折算总成本
  var total = 0;
  flows.forEach(function (targets, from) {
    targets.forEach(function (amount, to) {
      var c = arcIndex.get(from + '>' + to);
      if (c === undefined) throw new Error('flow 里出现了弧表没有的弧 ' + from + '>' + to);
      total += c * amount;
    });
  });
  return total;
}

function normalizeFlowRows(rows, fakeSet) {
  var out = new Map();
  for (var i = 0; i < rows.length; i++) {
    var from = rows[i][0];
    var fk = fakeSet.has(from) ? FAKE : String(from);
    var inner = new Map();
    var targets = rows[i][1];
    for (var j = 0; j < targets.length; j++) {
      var to = targets[j][0];
      var tk = fakeSet.has(to) ? FAKE : String(to);
      inner.set(tk, targets[j][1]);
    }
    out.set(fk, inner);
  }
  return out;
}

function compareFlows(pyRows, jsFlows, fakePy, fakeJs, arcIndexJs, arcIndexPy) {
  var py = normalizeFlowRows(pyRows, new Set(fakePy));
  var js = new Map();
  jsFlows.forEach(function (targets, from) {
    var fk = fakeJs.has(from) ? FAKE : String(from);
    var inner = new Map();
    targets.forEach(function (amount, to) {
      var tk = fakeJs.has(to) ? FAKE : String(to);
      inner.set(tk, amount);
    });
    js.set(fk, inner);
  });
  var diffs = [];
  var keys = new Set();
  py.forEach(function (v, k) { keys.add(k); });
  js.forEach(function (v, k) { keys.add(k); });
  keys.forEach(function (k) {
    var pv = py.get(k) || new Map();
    var jv = js.get(k) || new Map();
    var sub = new Set();
    pv.forEach(function (v2, k2) { sub.add(k2); });
    jv.forEach(function (v2, k2) { sub.add(k2); });
    sub.forEach(function (k2) {
      var a = pv.has(k2) ? pv.get(k2) : 0;
      var b = jv.has(k2) ? jv.get(k2) : 0;
      if (a !== b) diffs.push({ arc: k + '>' + k2, py: a, js: b });
    });
  });
  if (!diffs.length) return { same: true, costMismatch: false, diffs: diffs };
  // 流量不同：比较总成本，相同则只是平局选路不同
  function costOf(map, arcIndex) {
    var total = 0;
    map.forEach(function (targets, from) {
      targets.forEach(function (amount, to) {
        var key = from + '>' + to;
        var c = arcIndex.get(key);
        if (c === undefined) return null; // 含 fake 的弧在归一化后查不到，跳过（对两侧一样）
        total += c * amount;
      });
    });
    return total;
  }
  // 平局只是换了等成本的路径；真正影响下游扩张的是「每个岛净流出多少兵」，
  // 因此按岛的输出端口（-id）统计流出量再比一次，这才是语义等价的判据。
  function islandOutflow(map) {
    var out = new Map();
    map.forEach(function (targets, from) {
      var f = Number(from);
      if (!(f < 0)) return;
      var id = -f;
      var sum = 0;
      targets.forEach(function (amount, to) {
        if (to === FAKE) return;
        sum += amount;
      });
      if (sum !== 0) out.set(id, (out.get(id) || 0) + sum);
    });
    return out;
  }
  var pyOut = islandOutflow(py);
  var jsOut = islandOutflow(js);
  var islandDiffs = [];
  var ids = new Set();
  pyOut.forEach(function (v, k) { ids.add(k); });
  jsOut.forEach(function (v, k) { ids.add(k); });
  ids.forEach(function (id) {
    var a = pyOut.get(id) || 0;
    var b = jsOut.get(id) || 0;
    if (a !== b) islandDiffs.push(id + ':' + a + '/' + b);
  });
  var pyCost = costOf(py, arcIndexPy);
  var jsCost = costOf(js, arcIndexJs);
  return {
    same: false, costMismatch: pyCost !== jsCost, diffs: diffs,
    pyCost: pyCost, jsCost: jsCost, islandDiffs: islandDiffs
  };
}

// ---------------- 主流程 ----------------

function main() {
  var file = process.argv[2];
  if (!file) {
    process.stderr.write('用法: node scripts\\ekdiff-flowmincost.js <oracle.json>\n');
    process.exit(2);
  }
  var oracle = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  var builder = new EK.flow.DirectOrToolsGraphBuilder();
  var computer = new EK.flow.OrToolsFlowComputer();

  var totalBuilds = 0;
  var arcInvalidBuilds = 0;
  var supplyInvalidBuilds = 0;
  var flowSame = 0;
  var flowTieOnly = 0;
  var flowCostBad = 0;
  var solveFailed = 0;

  function report(kind, turn, buildIdx, detail) {
    process.stdout.write('  [' + kind + '] turn ' + turn + ' build#' + buildIdx + ' ' + detail + '\n');
  }

  for (var ti = 0; ti < oracle.turns.length; ti++) {
    var row = oracle.turns[ti];
    var tiles = buildTiles(row);
    var islands = buildIslands(row, tiles);

    var builds = row.builds || [];
    for (var bi = 0; bi < builds.length; bi++) {
      var b = builds[bi];
      var g = b.graph;
      var inputs = g.inputs;
      var interAnalysis = buildIntergeneralAnalysis(row, inputs, tiles);
      var friendlyGeneralTile = tiles[inputs.friendlyGeneral];
      var enemyGeneralTile = tiles[inputs.enemyGeneral];
      var mapObj = buildMapObj(row, tiles, {
        team: inputs.team,
        friendlyGeneralTile: friendlyGeneralTile,
        enemyGeneralTile: enemyGeneralTile,
        livingPlayers: inputs.livingPlayers || [row.playerIndex],
      });
      var armyOverride = inputs.armyOverride ? { raw: inputs.armyOverride } : null;
      var negativeTiles = new Set();
      for (var nt = 0; nt < inputs.negativeTiles.length; nt++) {
        negativeTiles.add(tiles[inputs.negativeTiles[nt]]);
      }

      totalBuilds++;
      var jsGraph;
      try {
        jsGraph = builder.build(
          islands,
          interAnalysis,
          mapObj,
          inputs.team,
          inputs.targetTeam,
          friendlyGeneralTile,
          enemyGeneralTile,
          false,
          !!b.useNeutralFlow,
          armyOverride,
          negativeTiles.size ? negativeTiles : null,
          null,
          null,
          null
        );
      } catch (e) {
        report('构建异常', row.turn, bi, e.message + '\n' + (e.stack || '').split('\n')[1]);
        arcInvalidBuilds++;
        continue;
      }

      // 结构性指标：fake node 数量、neutral sinks 集合、累计需求，任何一项不同都意味着图语义跑了偏
      var structBad = [];
      if ((g.fakeNodes || []).length !== jsGraph.fake_nodes.size) {
        structBad.push('fakeNodes py=' + g.fakeNodes.length + ' js=' + jsGraph.fake_nodes.size);
      }
      if (g.cumulativeDemand !== jsGraph.cumulative_demand) {
        structBad.push('cumulativeDemand py=' + g.cumulativeDemand + ' js=' + jsGraph.cumulative_demand);
      }
      var pySinks = (g.neutralSinks || []).join(',');
      var jsSinks = Array.from(jsGraph.neutral_sinks || []).sort(function (a, b3) { return a - b3; }).join(',');
      if (pySinks !== jsSinks) {
        structBad.push('neutralSinks 数量 py=' + (g.neutralSinks || []).length + ' js=' + (jsGraph.neutral_sinks ? jsGraph.neutral_sinks.size : 0));
      }
      if (g.friendlyArmySupply !== jsGraph.friendly_army_supply) {
        structBad.push('friendlyArmySupply py=' + g.friendlyArmySupply + ' js=' + jsGraph.friendly_army_supply);
      }
      if (g.enemyGeneralDemand !== jsGraph.enemy_general_demand) {
        structBad.push('enemyGeneralDemand py=' + g.enemyGeneralDemand + ' js=' + jsGraph.enemy_general_demand);
      }
      if (structBad.length) {
        arcInvalidBuilds++;
        report('结构指标不一致', row.turn, bi, structBad.join(' | '));
      }

      var arcCmp = compareArcs(g, jsGraph);
      if (arcCmp.diffs.length) {
        arcInvalidBuilds++;
        report('弧不一致', row.turn, bi,
          'py=' + arcCmp.pyCount + ' js=' + arcCmp.jsCount + ' 差异弧 ' + arcCmp.diffs.length);
        arcCmp.diffs.slice(0, 6).forEach(function (d) {
          process.stdout.write('      ' + d.key + ' py=' + JSON.stringify(d.py) + ' js=' + JSON.stringify(d.js) + '\n');
        });
      }

      var supDiffs = compareSupplies(g, jsGraph);
      if (supDiffs.length) {
        supplyInvalidBuilds++;
        report('供给不一致', row.turn, bi, '差异节点 ' + supDiffs.length);
        supDiffs.slice(0, 6).forEach(function (d) {
          process.stdout.write('      ' + d.key + ' py=' + d.py + ' js=' + d.js + '\n');
        });
      }

      // ---- 最小费用流
      var pyFlows = (b.flows && b.flows[0]) || null;
      if (!pyFlows) continue;

      var jsFlows;
      try {
        jsFlows = computer.compute_flow(islands, jsGraph);
      } catch (e) {
        solveFailed++;
        report('求解异常', row.turn, bi, e.message);
        continue;
      }
      if (!jsFlows) {
        solveFailed++;
        report('求解失败', row.turn, bi,
          'nodeIds=' + jsGraph.node_ids.length + ' arcs=' + jsGraph.start_nodes.length);
        continue;
      }

      var arcIndexJs = new Map();
      var jsArcs = jsArcsById(jsGraph);
      for (var a4 = 0; a4 < jsArcs.length; a4++) {
        arcIndexJs.set(jsArcs[a4].start + '>' + jsArcs[a4].end, jsArcs[a4].cost);
      }
      var arcIndexPy = new Map();
      for (var a5 = 0; a5 < g.startNodes.length; a5++) {
        var ps = g.nodeIds[g.startNodes[a5]];
        var pe = g.nodeIds[g.endNodes[a5]];
        arcIndexPy.set(ps + '>' + pe, g.unitCosts[a5]);
      }

      var flowCmp = compareFlows(pyFlows, jsFlows, g.fakeNodes, jsGraph.fake_nodes, arcIndexJs, arcIndexPy);
      if (flowCmp.same) {
        flowSame++;
      } else if (flowCmp.costMismatch) {
        flowCostBad++;
        report('流量成本不一致', row.turn, bi,
          'pyCost=' + flowCmp.pyCost + ' jsCost=' + flowCmp.jsCost + ' 差异弧 ' + flowCmp.diffs.length);
        flowCmp.diffs.slice(0, 6).forEach(function (d) {
          process.stdout.write('      ' + d.arc + ' py=' + d.py + ' js=' + d.js + '\n');
        });
      } else {
        flowTieOnly++;
        var islDiff = flowCmp.islandDiffs || [];
        report('仅平局不同', row.turn, bi,
          '成本相同(' + flowCmp.pyCost + ')，差异弧 ' + flowCmp.diffs.length +
          '，岛级流出量差异 ' + islDiff.length + '/' + (row.islands || []).length);
        if (islDiff.length) {
          process.stdout.write('      ' + islDiff.slice(0, 6).join('  ') +
            (islDiff.length > 6 ? '  …' : '') + '\n');
        }
      }
    }
  }

  var totalFlowCmp = flowSame + flowTieOnly + flowCostBad;
  process.stdout.write('\n');
  process.stdout.write('构建次数 ' + totalBuilds + '，弧不一致 ' + arcInvalidBuilds +
    '，供给不一致 ' + supplyInvalidBuilds + '，求解失败 ' + solveFailed + '\n');
  process.stdout.write('流比对 ' + totalFlowCmp + ' 次：逐项一致 ' + flowSame +
    '，仅平局不同 ' + flowTieOnly + '，成本不一致 ' + flowCostBad + '\n');
  if (!flowgraphOk) {
    process.stdout.write('注意：flowgraph.js 未加载成功，island 角色分类用的是内置兜底实现\n');
  }
  var bad = arcInvalidBuilds + supplyInvalidBuilds + flowCostBad + solveFailed;
  process.exitCode = bad === 0 ? 0 : 1;
}

main();

/**
 * flowmincost.js — OR-Tools SimpleMinCostFlow 的 JS 等价实现 + 原版默认流扩张方向求解器。
 *
 * 对应 python：
 *   BehaviorAlgorithms/Flow/OrToolsFlowDirectionFinder.py  (DirectOrToolsGraphBuilder / OrToolsFlowComputer / OrToolsFlowDirectionFinder)
 * 基类 FlowDirectionFinderABC、数据类 FlowGraphModels 由 flowgraph.js（他人移植）提供，
 * 这里只在需要时按名字取，不重复实现。
 *
 * 为什么自己写最小费用流：原版用的是 ortools 的 SimpleMinCostFlow，语义是
 *   “整数容量 + 整数单价 + 每节点 supply，求总成本最小的可行流，不可行则报 INFEASIBLE”。
 * JS 侧没有 ortools，所以用 successive shortest path + Johnson 势能（Dijkstra）实现同样的语义；
 * 图规模是 island 级（几十到几百节点），性能不是瓶颈。
 *
 * 与 python 的唯一形式差异：fake node 的 id 是“确定性占位 id”而不是 random.randint。
 * fake node 在算法里仅通过 fake_nodes 集合成员判定（build_flow_nodes_from_lookups 也是按集合判定），
 * 数值本身不参与任何决策，所以不影响结果；但对比 oracle 时要把 fake node 归一化后再比。
 */
(function (root) {
  'use strict';

  var EK = root.__EK || (root.__EK = {});
  var flow = EK.flow || (EK.flow = {});

  // ---------------------------------------------------------------- 基础工具

  function trunc(v) {
    // numpy 的 int64 转换对 float 是向零截断，python 里 cost 有时是 sum_army/tile_count 浮点
    return v < 0 ? Math.ceil(v) : Math.floor(v);
  }

  function perf(perfTimer, name) {
    if (perfTimer && typeof perfTimer.begin_move_event === 'function') {
      perfTimer.begin_move_event(name);
    }
  }

  function tilePlayer(tile) {
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  // python 用 set/dict 迭代时，这里的等价物一律按 unique_id 升序，保证可复现。
  // tileisland.js 的岛集合可能是 array / Map / 带 items() 的对象，全部吃下。
  function sortedIslands(islandBuilder) {
    var all = islandBuilder.all_tile_islands;
    var list = [];
    if (all === null || all === undefined) return list;
    if (Array.isArray(all)) list = all.slice();
    else if (typeof all.items === 'function') list = all.items();
    else if (typeof all.values === 'function') list = Array.from(all.values());
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    out.sort(function (a, b) { return a.unique_id - b.unique_id; });
    return out;
  }

  // islands.tile_islands_by_unique_id 同样可能是 Map 或普通对象
  function islandById(islands, islandId) {
    var byId = islands.tile_islands_by_unique_id;
    if (byId === null || byId === undefined) return undefined;
    if (typeof byId.get === 'function') return byId.get(islandId);
    return byId[islandId];
  }

  function borderIslandsOf(island) {
    var border = island.border_islands;
    if (border === null || border === undefined) return [];
    if (Array.isArray(border)) return border;
    if (typeof border.items === 'function') return border.items();
    if (typeof border.values === 'function') return Array.from(border.values());
    return [];
  }

  // classify_islands_for_flow 返回 Map（flowgraph.js）或普通对象，统一按 id 取
  function roleOf(islandRoles, islandId) {
    if (islandRoles === null || islandRoles === undefined) return null;
    if (typeof islandRoles.get === 'function') {
      var byGet = islandRoles.get(islandId);
      return byGet === undefined ? null : byGet;
    }
    var byKey = islandRoles[islandId];
    return byKey === undefined ? null : byKey;
  }

  // ---------------------------------------------------------------- MinCostFlow

  /**
   * 语义对齐 ortools.graph.python.min_cost_flow.SimpleMinCostFlow。
   *   add_arc_with_capacity_and_unit_cost / set_node_supply / solve
   * solve() 返回 {flows: number[], optimalCost: number}，不可行（含供给不平衡）返回 null。
   * 平局：Dijkstra 用“入队序”做次级比较，同一张图同一顺序永远得到同一个解。
   */
  function MinCostFlow() {
    this._arcFrom = [];
    this._arcTo = [];
    this._arcCap = [];
    this._arcCost = [];
    this._supplyById = new Map();
  }

  MinCostFlow.prototype.addArcWithCapacityAndUnitCost = function (fromNode, toNode, capacity, unitCost) {
    var idx = this._arcFrom.length;
    this._arcFrom.push(fromNode);
    this._arcTo.push(toNode);
    this._arcCap.push(trunc(capacity));
    this._arcCost.push(trunc(unitCost));
    return idx;
  };

  // 兼容 ortools 的蛇形命名，方便照抄调用点
  MinCostFlow.prototype.add_arc_with_capacity_and_unit_cost = MinCostFlow.prototype.addArcWithCapacityAndUnitCost;

  MinCostFlow.prototype.setNodeSupply = function (node, supply) {
    this._supplyById.set(node, trunc(supply));
  };

  MinCostFlow.prototype.set_node_supply = MinCostFlow.prototype.setNodeSupply;

  // flowgraph.js（NetworkX 那条路）用的是另一套 API：add_node / add_edge / solve(demands)。
  // 两个 API 都支持，这样 flow.MinCostFlow 这个名字谁后加载都不会把对方搞坏。
  MinCostFlow.prototype.add_node = function (node, _supply) {
    if (!this._supplyById.has(node)) this._supplyById.set(node, 0);
    return node;
  };

  MinCostFlow.prototype.add_edge = function (fromNode, toNode, capacity, cost) {
    var idx = this.addArcWithCapacityAndUnitCost(fromNode, toNode, capacity, cost);
    var handle = { u: fromNode, v: toNode, cap: trunc(capacity), cost: trunc(cost), flow: 0, arcIndex: idx };
    this._edgeHandles = this._edgeHandles || [];
    this._edgeHandles.push(handle);
    return handle;
  };

  MinCostFlow.prototype._indexNodes = function () {
    var idToIdx = new Map();
    var idxToId = [];
    function intern(id) {
      if (idToIdx.has(id)) return idToIdx.get(id);
      idToIdx.set(id, idxToId.length);
      idxToId.push(id);
      return idxToId.length - 1;
    }
    for (var i = 0; i < this._arcFrom.length; i++) {
      intern(this._arcFrom[i]);
      intern(this._arcTo[i]);
    }
    this._supplyById.forEach(function (_v, id) { intern(id); });
    return { idToIdx: idToIdx, idxToId: idxToId };
  };

  /**
   * 最小费用可行流。
   *   solve()          → { flows: number[], optimalCost } 或 null（ortools SimpleMinCostFlow 语义）
   *   solve(demands)   → { edges: [{u,v,flow,cost}], cost }，不可行抛错（flowgraph.js networkx 语义）
   * demands 里 >0 表示该节点要吃 d 单位，内部转成 supply = -d。
   */
  MinCostFlow.prototype.solve = function (demands) {
    var demandsMap = null;
    if (demands !== undefined && demands !== null) {
      demandsMap = new Map();
      if (typeof demands.forEach === 'function' && typeof demands.get === 'function') {
        demands.forEach(function (d, node) { demandsMap.set(node, trunc(d)); });
      } else {
        for (var dk in demands) {
          if (Object.prototype.hasOwnProperty.call(demands, dk)) demandsMap.set(Number(dk), trunc(demands[dk]));
        }
      }
      var self2 = this;
      demandsMap.forEach(function (d, node) {
        if (!self2._supplyById.has(node)) self2._supplyById.set(node, -d);
        else self2._supplyById.set(node, self2._supplyById.get(node) - d);
      });
    }

    var solved = this._solveRaw();

    if (demandsMap !== null) {
      if (solved === null) throw new Error('MinCostFlow: 无可行流（供不足或供给不平衡）');
      var handles = this._edgeHandles || [];
      for (var h = 0; h < handles.length; h++) handles[h].flow = solved.flows[handles[h].arcIndex];
      return { edges: handles, cost: solved.optimalCost };
    }
    return solved;
  };

  MinCostFlow.prototype._solveRaw = function () {
    var arcs = this._arcFrom.length;
    var intern = this._indexNodes();
    var idToIdx = intern.idToIdx;
    var nodeCount = intern.idxToId.length;

    var supply = new Array(nodeCount);
    for (var i = 0; i < nodeCount; i++) supply[i] = 0;
    var totalSupply = 0;
    for (var s = 0; s < nodeCount; s++) {
      var sid = intern.idxToId[s];
      var sup = this._supplyById.has(sid) ? this._supplyById.get(sid) : 0;
      supply[s] = sup;
      totalSupply += sup;
    }
    if (totalSupply !== 0) return null; // UNBALANCED

    // 残量图：arc i 的正向边 2i，反向边 2i+1
    var head = new Array(nodeCount);
    for (var n = 0; n < nodeCount; n++) head[n] = -1;
    var edgeTo = [];
    var edgeCap = [];
    var edgeCost = [];
    var edgeNext = [];

    function addEdge(u, v, cap, cost) {
      var e = edgeTo.length;
      edgeTo.push(v); edgeCap.push(cap); edgeCost.push(cost); edgeNext.push(head[u]);
      head[u] = e;
      var r = edgeTo.length;
      edgeTo.push(u); edgeCap.push(0); edgeCost.push(-cost); edgeNext.push(head[v]);
      head[v] = r;
    }

    for (var a = 0; a < arcs; a++) {
      addEdge(idToIdx.get(this._arcFrom[a]), idToIdx.get(this._arcTo[a]), this._arcCap[a], this._arcCost[a]);
    }

    // 原始成本非负（构造期保证），所以初始势能全 0 就是可行势能
    var potential = new Array(nodeCount);
    for (var p = 0; p < nodeCount; p++) potential[p] = 0;

    var INF = Infinity;
    var dist = new Array(nodeCount);
    var prevEdge = new Array(nodeCount);
    var pqNode = [];
    var pqDist = [];
    var pqSeq = [];

    function pqPush(node, d, seq) {
      pqNode.push(node); pqDist.push(d); pqSeq.push(seq);
      var i = pqNode.length - 1;
      while (i > 0) {
        var parent = (i - 1) >> 1;
        if (pqDist[parent] < pqDist[i] || (pqDist[parent] === pqDist[i] && pqSeq[parent] <= pqSeq[i])) break;
        swap(i, parent);
        i = parent;
      }
    }

    function swap(i, j) {
      var tn = pqNode[i]; pqNode[i] = pqNode[j]; pqNode[j] = tn;
      var td = pqDist[i]; pqDist[i] = pqDist[j]; pqDist[j] = td;
      var ts = pqSeq[i]; pqSeq[i] = pqSeq[j]; pqSeq[j] = ts;
    }

    function pqPop() {
      var top = pqNode[0];
      var last = pqNode.length - 1;
      pqNode[0] = pqNode[last]; pqDist[0] = pqDist[last]; pqSeq[0] = pqSeq[last];
      pqNode.pop(); pqDist.pop(); pqSeq.pop();
      var i = 0;
      var n = pqNode.length;
      while (true) {
        var l = 2 * i + 1, r = l + 1, best = i;
        if (l < n && (pqDist[l] < pqDist[best] || (pqDist[l] === pqDist[best] && pqSeq[l] < pqSeq[best]))) best = l;
        if (r < n && (pqDist[r] < pqDist[best] || (pqDist[r] === pqDist[best] && pqSeq[r] < pqSeq[best]))) best = r;
        if (best === i) break;
        swap(i, best);
        i = best;
      }
      return top;
    }

    var seqCounter = 0;

    // 交替从 supply 最高的源出发增广，直到所有供需归零
    var guard = 0;
    var guardLimit = 200000;
    while (true) {
      var startNode = -1;
      for (var q = 0; q < nodeCount; q++) {
        if (supply[q] > 0) { startNode = q; break; }
      }
      if (startNode < 0) break; // 全部平衡
      if (++guard > guardLimit) return null;

      for (var d0 = 0; d0 < nodeCount; d0++) { dist[d0] = INF; prevEdge[d0] = -1; }
      pqNode.length = 0; pqDist.length = 0; pqSeq.length = 0;
      dist[startNode] = 0;
      pqPush(startNode, 0, seqCounter++);

      while (pqNode.length > 0) {
        var u = pqPop();
        // reduced cost 保持非负，所以第一次弹出即最短
        for (var e = head[u]; e !== -1; e = edgeNext[e]) {
          if (edgeCap[e] <= 0) continue;
          var v = edgeTo[e];
          var rc = edgeCost[e] + potential[u] - potential[v];
          var nd = dist[u] + rc;
          if (nd < dist[v]) {
            dist[v] = nd;
            prevEdge[v] = e;
            pqPush(v, nd, seqCounter++);
          }
        }
      }

      var sinkNode = -1;
      for (var q2 = 0; q2 < nodeCount; q2++) {
        if (supply[q2] < 0 && dist[q2] < INF) { sinkNode = q2; break; }
      }
      if (sinkNode < 0) return null; // INFEASIBLE：还有供给找不到需求

      for (var pv = 0; pv < nodeCount; pv++) {
        if (dist[pv] < INF) potential[pv] += dist[pv];
      }

      var bottleneck = supply[startNode];
      if (-supply[sinkNode] < bottleneck) bottleneck = -supply[sinkNode];
      var cursor = sinkNode;
      while (cursor !== startNode) {
        var pe = prevEdge[cursor];
        if (pe < 0) return null;
        if (edgeCap[pe] < bottleneck) bottleneck = edgeCap[pe];
        cursor = edgeTo[pe ^ 1];
      }
      if (bottleneck <= 0) return null;

      cursor = sinkNode;
      while (cursor !== startNode) {
        var pe2 = prevEdge[cursor];
        edgeCap[pe2] -= bottleneck;
        edgeCap[pe2 ^ 1] += bottleneck;
        cursor = edgeTo[pe2 ^ 1];
      }
      supply[startNode] -= bottleneck;
      supply[sinkNode] += bottleneck;
    }

    var flows = new Array(arcs);
    var optimalCost = 0;
    for (var ai = 0; ai < arcs; ai++) {
      var originalCap = this._arcCap[ai];
      var remaining = edgeCap[2 * ai];
      var used = originalCap - remaining;
      flows[ai] = used;
      optimalCost += used * this._arcCost[ai];
    }
    return { flows: flows, optimalCost: optimalCost };
  };

  // ---------------------------------------------------------------- GraphData

  function OrToolsGraphData(opts) {
    opts = opts || {};
    this.start_nodes = opts.start_nodes || [];
    this.end_nodes = opts.end_nodes || [];
    this.capacities = opts.capacities || [];
    this.unit_costs = opts.unit_costs || [];
    this.node_ids = opts.node_ids || [];
    this.node_supplies = opts.node_supplies || [];
    this.node_to_idx = opts.node_to_idx || new Map();
    this.idx_to_node = opts.idx_to_node || new Map();
    this.demand_lookup = opts.demand_lookup || {};
    this.neutral_sinks = opts.neutral_sinks || new Set();
    this.fake_nodes = opts.fake_nodes || new Set();
    this.cumulative_demand = opts.cumulative_demand || 0;
    this.disconnected_component_island_ids = opts.disconnected_component_island_ids || new Set();
    this.directed_repair_source_island_ids = opts.directed_repair_source_island_ids || new Set();
    this.directed_repair_sink_island_ids = opts.directed_repair_sink_island_ids || new Set();
    this.overflow_dump_target_island_ids = opts.overflow_dump_target_island_ids || new Set();
    this.debug_fake_escape_arc_indexes = opts.debug_fake_escape_arc_indexes || new Set();
    this.debug_fake_escape_usage_by_island = {};
    this.flow_diag_island_ids = new Set();
    this.friendly_army_supply = 0;
    this.enemy_army_demand = 0;
    this.enemy_general_demand = 0;
  }

  // 原版常量
  var DEBUG_OR_TOOLS_FAKE_NODE_ESCAPE_ARCS = true;
  var DEBUG_OR_TOOLS_FAKE_NODE_ESCAPE_COST = 1000000;

  // ---------------------------------------------------------------- 图构建

  function DirectOrToolsGraphBuilder() {
    this.log_debug = false;
    this._fakeIdCounter = 0;
  }

  // python 用 random.randint(1000000, 9000000) 造 fake node id。这里用确定性的递增占位 id，
  // 只保证不与真 island id、也不与其他 fake node 冲突（id 数值不参与任何决策）。
  DirectOrToolsGraphBuilder.prototype._nextFakeNodeId = function (usedNodes, islands) {
    var candidate = 1000000 + this._fakeIdCounter++;
    while (usedNodes.has(candidate) || islandById(islands, candidate) !== undefined) {
      candidate = 1000000 + this._fakeIdCounter++;
    }
    return candidate;
  };

  DirectOrToolsGraphBuilder.prototype._buildFlowPathIslandConstraints = function (islands, constrainedFlowPaths) {
    var constrainedSourceIslandIds = new Set();
    var allowedDestinationsBySource = new Map();
    if (!constrainedFlowPaths || constrainedFlowPaths.length === 0) {
      return { constrainedSourceIslandIds: constrainedSourceIslandIds, allowedDestinationsBySource: allowedDestinationsBySource };
    }
    for (var pi = 0; pi < constrainedFlowPaths.length; pi++) {
      var moves = constrainedFlowPaths[pi].get_move_list();
      for (var mi = 0; mi < moves.length; mi++) {
        var move = moves[mi];
        var sourceIsland = islands.tile_island_lookup.raw[move.source.tile_index];
        var destIsland = islands.tile_island_lookup.raw[move.dest.tile_index];
        if (sourceIsland === null || sourceIsland === undefined) continue;
        if (destIsland === null || destIsland === undefined) continue;
        var sourceIslandId = sourceIsland.unique_id;
        constrainedSourceIslandIds.add(sourceIslandId);
        if (sourceIslandId === destIsland.unique_id) continue;
        var allowed = allowedDestinationsBySource.get(sourceIslandId);
        if (allowed === undefined) {
          allowed = new Set();
          allowedDestinationsBySource.set(sourceIslandId, allowed);
        }
        allowed.add(destIsland.unique_id);
      }
    }
    return { constrainedSourceIslandIds: constrainedSourceIslandIds, allowedDestinationsBySource: allowedDestinationsBySource };
  };

  DirectOrToolsGraphBuilder.prototype._isBorderEdgeBlockedByFlowPathConstraints = function (sourceIsland, destIsland, constraints) {
    if (!constraints.constrainedSourceIslandIds.has(sourceIsland.unique_id)) return false;
    var allowed = constraints.allowedDestinationsBySource.get(sourceIsland.unique_id);
    if (allowed === undefined) return true;
    return !allowed.has(destIsland.unique_id);
  };

  DirectOrToolsGraphBuilder.prototype._isBorderEdgeBlockedByThreatBlockingTiles = function (sourceIsland, destIsland, threatBlockingTiles) {
    if (!threatBlockingTiles) return false;
    var destTileSet = destIsland.tile_set;
    var iter = sourceIsland.tile_set.values();
    var step = iter.next();
    while (!step.done) {
      var sourceTile = step.value;
      var blockInfo = lookupTileKeyed(threatBlockingTiles, sourceTile);
      if (blockInfo) {
        var blocked = blockInfo.blocked_destinations || [];
        for (var bi = 0; bi < blocked.length; bi++) {
          if (destTileSet.has(blocked[bi])) return true;
        }
      }
      step = iter.next();
    }
    return false;
  };

  // threat_blocking_tiles 在 python 是 dict[Tile, ...]；JS 侧可能给 Map 也可能给按 tile_index 的普通对象
  function lookupTileKeyed(dictLike, tile) {
    if (!dictLike) return null;
    if (typeof dictLike.get === 'function') {
      var byGet = dictLike.get(tile);
      if (byGet !== undefined) return byGet;
      return dictLike.get(tile.tile_index) || null;
    }
    var v = dictLike[tile.tile_index];
    if (v !== undefined) return v;
    v = dictLike[tile];
    return v === undefined ? null : v;
  }

  /**
   * build() —— 逐段对应 python DirectOrToolsGraphBuilder.build：
   *   Phase1 每岛 demand / supply / split 边
   *   Phase2 边界边 + neutral sinks
   *   Phase3 fake node + demand saturation + overflow dump
   *   Phase3.5 连通性修复
   *   Phase3.6 单向可达性修复（SCC 终端盈余 + 有向可达）
   *   Phase4 节点索引数组 + debug escape arcs
   * 只跳过纯日志（logbook 输出 + log_debug 门控的可行性 max-flow 诊断，那些不影响图）。
   */
  DirectOrToolsGraphBuilder.prototype.build = function (
    islands,
    intergeneralAnalysis,
    mapObj,
    team,
    targetTeam,
    friendlyGeneral,
    enemyGeneral,
    useBackpressureFromEnemyGeneral,
    useNeutralFlow,
    armyOverrideMatrix,
    negativeTiles,
    threatBlockingTiles,
    constrainedFlowPaths,
    perfTimer
  ) {
    var self = this;
    var allIslands = sortedIslands(islands);

    var targetGeneralIsland = islands.tile_island_lookup.raw[enemyGeneral.tile_index];
    var frGeneralIsland = islands.tile_island_lookup.raw[friendlyGeneral.tile_index];
    var flowPathConstraints = this._buildFlowPathIslandConstraints(islands, constrainedFlowPaths);
    var hasRealTargetTeam = targetTeam !== -1;

    // 不可达 island 完全不进图（否则会出现孤立组件导致 INFEASIBLE）
    var excludedIslandIds = new Set();
    var reachableTiles = mapObj.reachable_tiles;
    for (var ei = 0; ei < allIslands.length; ei++) {
      var sampleTile = allIslands[ei].tiles_by_army[0];
      if (reachableTiles && sampleTile && !reachableTiles.has(sampleTile)) {
        excludedIslandIds.add(allIslands[ei].unique_id);
      }
    }

    function getIslandArmySum(island) {
      var armySum;
      if (!armyOverrideMatrix) {
        armySum = island.sum_army;
      } else {
        armySum = 0;
        var it = island.tile_set.values();
        var s = it.next();
        while (!s.done) {
          armySum += armyOverrideMatrix.raw[s.value.tile_index];
          s = it.next();
        }
      }
      if (island.team === team && negativeTiles) {
        var it2 = island.tile_set.values();
        var s2 = it2.next();
        while (!s2.done) {
          var t2 = s2.value;
          if (negativeTiles.has(t2)) {
            armySum -= armyOverrideMatrix ? armyOverrideMatrix.raw[t2.tile_index] : t2.army;
          }
          s2 = it2.next();
        }
      }
      return armySum;
    }

    var demands = {};
    var cumulativeDemand = 0;
    var friendlyArmySupply = 0;
    var enemyArmyDemand = 0;
    var enemyGeneralDemand = targetGeneralIsland.sum_army + targetGeneralIsland.tile_count;

    perf(perfTimer, 'OrTools build classify_islands');
    var islandRoles = flowBoundaryCall(this, 'classify_islands_for_flow', [islands, intergeneralAnalysis, mapObj, team, targetTeam]);

    var nodeSupplyMap = new Map();
    var arcStarts = [];
    var arcEnds = [];
    var arcCaps = [];
    var arcCosts = [];
    var allNodeIds = new Set();

    function pushArc(startNode, endNode, cap, cost) {
      arcStarts.push(startNode);
      arcEnds.push(endNode);
      arcCaps.push(cap);
      arcCosts.push(trunc(cost));
      allNodeIds.add(startNode);
      allNodeIds.add(endNode);
    }

    // ---------------- Phase 1
    perf(perfTimer, 'OrTools build phase1 demands and in/out nodes per island');
    for (var i1 = 0; i1 < allIslands.length; i1++) {
      var island = allIslands[i1];
      if (excludedIslandIds.has(island.unique_id)) continue;
      var islandArmySum = getIslandArmySum(island);
      var cost1 = island.tile_count;
      var demand = island.tile_count - islandArmySum;
      var hasDemandAttr = false;
      if (island.team === team) {
        hasDemandAttr = true;
        cumulativeDemand += demand;
        friendlyArmySupply += islandArmySum - island.tile_count;
        cost1 = Math.max(2, 30 - Math.floor(island.sum_army / island.tile_count));
      } else if (island.team === targetTeam) {
        hasDemandAttr = true;
        demand = islandArmySum + island.tile_count;
        cumulativeDemand += demand;
        enemyArmyDemand += demand;
      } else if (island.team === -1) {
        var role1 = roleOf(islandRoles, island.unique_id);
        if (!role1 || !role1.is_neutral_sink_no_neut || useNeutralFlow) {
          hasDemandAttr = true;
          cumulativeDemand += demand;
          cost1 = Math.max(1, cost1) * 2;
        }
      }

      // 原版的 hack：split 边成本被无条件清零（上面那些 cost 计算全部作废）
      cost1 = 0;

      demands[island.unique_id] = demand;
      nodeSupplyMap.set(island.unique_id, hasDemandAttr ? -demand : 0);
      nodeSupplyMap.set(-island.unique_id, 0);

      allNodeIds.add(island.unique_id);
      allNodeIds.add(-island.unique_id);

      arcStarts.push(island.unique_id);
      arcEnds.push(-island.unique_id);
      arcCaps.push(100000);
      arcCosts.push(trunc(cost1));
    }

    // ---------------- Phase 2
    perf(perfTimer, 'OrTools build phase2 border edges');
    var neutSinks = new Set();
    for (var i2 = 0; i2 < allIslands.length; i2++) {
      var island2 = allIslands[i2];
      if (excludedIslandIds.has(island2.unique_id)) continue;
      var role2 = roleOf(islandRoles, island2.unique_id);
      var borderList2 = borderIslandsOf(island2);

      for (var nb = 0; nb < borderList2.length; nb++) {
        var movableIsland = borderList2[nb];
        if (movableIsland === null || movableIsland === undefined) continue;
        if (excludedIslandIds.has(movableIsland.unique_id)) continue;
        if (this._isBorderEdgeBlockedByThreatBlockingTiles(island2, movableIsland, threatBlockingTiles)) continue;
        if (this._isBorderEdgeBlockedByFlowPathConstraints(island2, movableIsland, flowPathConstraints)) continue;

        var src = -island2.unique_id;
        var dst = movableIsland.unique_id;
        var edgeCost = 30;
        if (island2.team === team) {
          if (hasRealTargetTeam && movableIsland.team === targetTeam) {
            edgeCost = movableIsland.sum_army / movableIsland.tile_count;
          } else if (movableIsland.team === team) {
            edgeCost = trunc(100 / Math.max(1, movableIsland.sum_army / movableIsland.tile_count));
          } else if (movableIsland.team === -1) {
            edgeCost += 0;
          }
        } else if (island2.team === -1) {
          if (movableIsland.team === team) {
            edgeCost += Math.floor(20 / Math.max(1, movableIsland.sum_army / movableIsland.tile_count));
          } else if (hasRealTargetTeam && movableIsland.team === targetTeam) {
            edgeCost = movableIsland.sum_army / movableIsland.tile_count;
          } else if (movableIsland.team === -1) {
            edgeCost += 0;
          }
        } else if (hasRealTargetTeam && island2.team === targetTeam) {
          if (movableIsland.team === team) {
            edgeCost += Math.floor(20000 / Math.max(1, movableIsland.sum_army / movableIsland.tile_count));
          } else if (hasRealTargetTeam && movableIsland.team === targetTeam) {
            edgeCost = Math.floor(movableIsland.sum_army / movableIsland.tile_count);
          } else if (movableIsland.team === -1) {
            edgeCost += 10;
          }
        }

        pushArc(src, dst, 100000, edgeCost);
      }

      var sinkFlag = useNeutralFlow ? role2.is_neutral_sink_with_neut : role2.is_neutral_sink_no_neut;
      if (sinkFlag) neutSinks.add(island2.unique_id);
    }

    // ---------------- Phase 3
    perf(perfTimer, 'OrTools build phase3 fill input arrays');
    var fakeNode = this._nextFakeNodeId(allNodeIds, islands);
    nodeSupplyMap.set(fakeNode, cumulativeDemand);
    allNodeIds.add(fakeNode);

    function unblockedBorderCount(isl) {
      var count = 0;
      var borders = borderIslandsOf(isl);
      for (var b = 0; b < borders.length; b++) {
        var bIsl = borders[b];
        if (bIsl === null || bIsl === undefined) continue;
        if (!self._isBorderEdgeBlockedByThreatBlockingTiles(isl, bIsl, threatBlockingTiles)) count++;
      }
      return count;
    }

    var frGeneralUnblockedCount = unblockedBorderCount(frGeneralIsland);
    var frFakeSinkIsland = frGeneralIsland;
    if (frGeneralUnblockedCount === 0) {
      // 友方首都没有可用边界边时，退到最近的、有可用边界边的友方城市
      var friendlyCitiesWithEdges = [];
      for (var ci = 0; ci < allIslands.length; ci++) {
        var cityIsland = allIslands[ci];
        if (excludedIslandIds.has(cityIsland.unique_id)) continue;
        if (cityIsland.team !== team) continue;
        var hasCity = false;
        var cit = cityIsland.tile_set.values();
        var cs = cit.next();
        while (!cs.done) {
          if (cs.value.isCity) { hasCity = true; break; }
          cs = cit.next();
        }
        if (!hasCity) continue;
        var cityUnblocked = unblockedBorderCount(cityIsland);
        if (cityUnblocked <= 0) continue;
        var minDist = Infinity;
        var ct = cityIsland.tile_set.values();
        var cstep = ct.next();
        while (!cstep.done) {
          var ctv = cstep.value;
          var dd = (ctv.x - friendlyGeneral.x) * (ctv.x - friendlyGeneral.x) + (ctv.y - friendlyGeneral.y) * (ctv.y - friendlyGeneral.y);
          if (dd < minDist) minDist = dd;
          cstep = ct.next();
        }
        friendlyCitiesWithEdges.push([minDist, cityIsland, cityUnblocked]);
      }
      if (friendlyCitiesWithEdges.length > 0) {
        friendlyCitiesWithEdges.sort(function (a, b) { return a[0] - b[0]; });
        frFakeSinkIsland = friendlyCitiesWithEdges[0][1];
      } else {
        var movableTilesWithEdges = [];
        for (var mi2 = 0; mi2 < friendlyGeneral.movable.length; mi2++) {
          var mTile = friendlyGeneral.movable[mi2];
          var mIsland = islands.tile_island_lookup.raw[mTile.tile_index];
          if (mIsland === null || mIsland === undefined) continue;
          if (mIsland.team !== team) continue;
          if (excludedIslandIds.has(mIsland.unique_id)) continue;
          var unblocked2 = 0;
          var mBorders = borderIslandsOf(mIsland);
          for (var bb = 0; bb < mBorders.length; bb++) {
            var bbIsl = mBorders[bb];
            if (bbIsl === null || bbIsl === undefined) continue;
            if (self._isBorderEdgeBlockedByThreatBlockingTiles(mIsland, bbIsl, threatBlockingTiles)) continue;
            if (bbIsl.unique_id === frGeneralIsland.unique_id) continue;
            unblocked2++;
          }
          if (unblocked2 <= 0) continue;
          var mDist = (mTile.x - enemyGeneral.x) * (mTile.x - enemyGeneral.x) + (mTile.y - enemyGeneral.y) * (mTile.y - enemyGeneral.y);
          movableTilesWithEdges.push([mDist, mTile, mIsland, unblocked2]);
        }
        if (movableTilesWithEdges.length > 0) {
          movableTilesWithEdges.sort(function (a, b) { return a[0] - b[0]; });
          frFakeSinkIsland = movableTilesWithEdges[0][2];
        }
      }
    }

    var fakeNodeExcessSupply = Math.max(0, cumulativeDemand);
    var fakeNodeEnemyGeneralFallbackCapacity = Math.floor((fakeNodeExcessSupply * 35) / 100);
    var friendlyFallbackCapacity = fakeNodeExcessSupply - fakeNodeEnemyGeneralFallbackCapacity;

    // pressure islands：友方 army>=6 的格子按 (army desc, tile_index asc)，首个是 fake sink 岛，最多 11 个
    var pressureIslandsById = new Map();
    pressureIslandsById.set(frFakeSinkIsland.unique_id, frFakeSinkIsland);
    var pressureTiles = [];
    for (var pi2 = 0; pi2 < allIslands.length; pi2++) {
      var pIsland = allIslands[pi2];
      if (pIsland.team !== team) continue;
      var pt = pIsland.tile_set.values();
      var ps = pt.next();
      while (!ps.done) {
        if (ps.value.army >= 6) pressureTiles.push(ps.value);
        ps = pt.next();
      }
    }
    pressureTiles.sort(function (a, b) {
      if (b.army !== a.army) return b.army - a.army;
      return a.tile_index - b.tile_index;
    });
    for (var pt2 = 0; pt2 < pressureTiles.length; pt2++) {
      if (pressureIslandsById.size >= 11) break;
      var pHome = islands.tile_island_lookup.raw[pressureTiles[pt2].tile_index];
      if (pHome === null || pHome === undefined) continue;
      if (excludedIslandIds.has(pHome.unique_id)) continue;
      pressureIslandsById.set(pHome.unique_id, pHome);
    }
    var pressureIslands = [];
    pressureIslandsById.forEach(function (v) { pressureIslands.push(v); });
    var friendlyPressureCapacitiesById = new Map();
    var pressureIslandCount = pressureIslands.length;
    var basePressureCapacity = pressureIslandCount > 0 ? Math.floor(friendlyFallbackCapacity / pressureIslandCount) : 0;
    var remainderPressureCapacity = friendlyFallbackCapacity - basePressureCapacity * pressureIslandCount;
    for (var p3 = 0; p3 < pressureIslands.length; p3++) {
      friendlyPressureCapacitiesById.set(pressureIslands[p3].unique_id, basePressureCapacity);
    }
    if (pressureIslands.length > 0) {
      var firstPressureId = pressureIslands[0].unique_id;
      friendlyPressureCapacitiesById.set(firstPressureId, friendlyPressureCapacitiesById.get(firstPressureId) + remainderPressureCapacity);
    }

    // neutral sink -> fake node
    var neutSinkCost = useNeutralFlow ? 10 : 0;
    if (useNeutralFlow) {
      neutSinks.forEach(function (neutSinkId) {
        pushArc(fakeNode, neutSinkId, 100000, neutSinkCost);
      });
    }

    var backpressureWeight = useBackpressureFromEnemyGeneral ? 0 : 10000;

    pushArc(-targetGeneralIsland.unique_id, fakeNode, 100000, backpressureWeight);
    pushArc(-frFakeSinkIsland.unique_id, fakeNode, 1000000, 0);
    pushArc(fakeNode, targetGeneralIsland.unique_id, fakeNodeEnemyGeneralFallbackCapacity, backpressureWeight);
    friendlyPressureCapacitiesById.forEach(function (capacity, islandId) {
      pushArc(fakeNode, islandId, capacity, 0);
    });

    // overflow dump：保证可行性的高价逃生通道
    var OVERFLOW_DUMP_COST = 100000;
    var overflowDumpCapacity = 100000;
    pushArc(fakeNode, targetGeneralIsland.unique_id, overflowDumpCapacity, OVERFLOW_DUMP_COST);
    pushArc(fakeNode, frFakeSinkIsland.unique_id, overflowDumpCapacity, OVERFLOW_DUMP_COST);

    var overflowDumpTargetIslandIds = new Set();
    if (cumulativeDemand > 0) {
      overflowDumpTargetIslandIds.add(targetGeneralIsland.unique_id);
      overflowDumpTargetIslandIds.add(frFakeSinkIsland.unique_id);
    }

    var directedRepairSourceIslandIds = new Set();
    var directedRepairSinkIslandIds = new Set();
    var allFakeNodeIds = new Set();
    allFakeNodeIds.add(fakeNode);
    var disconnectedComponentIslandIds = new Set();

    // ---------------- Phase 3.5 连通性修复
    perf(perfTimer, 'OrTools build phase3.5 connectivity repair');
    var adjacency = new Map();
    function addAdj(a, b) {
      var la = adjacency.get(a);
      if (la === undefined) { la = []; adjacency.set(a, la); }
      la.push(b);
      var lb = adjacency.get(b);
      if (lb === undefined) { lb = []; adjacency.set(b, lb); }
      lb.push(a);
    }
    for (var ai2 = 0; ai2 < arcStarts.length; ai2++) {
      var sn = arcStarts[ai2];
      var en = arcEnds[ai2];
      if (islandById(islands, Math.abs(sn)) === undefined) continue;
      if (islandById(islands, Math.abs(en)) === undefined) continue;
      addAdj(sn, en);
    }

    var visited = new Set();
    function bfsComponent(seed) {
      if (visited.has(seed)) return [];
      var component = [];
      var queue = [seed];
      var qh = 0;
      visited.add(seed);
      while (qh < queue.length) {
        var node = queue[qh++];
        component.push(node);
        var neighbours = adjacency.get(node);
        if (neighbours === undefined) continue;
        for (var ni = 0; ni < neighbours.length; ni++) {
          if (!visited.has(neighbours[ni])) {
            visited.add(neighbours[ni]);
            queue.push(neighbours[ni]);
          }
        }
      }
      return component;
    }

    var aMap = intergeneralAnalysis.aMap;
    bfsComponent(targetGeneralIsland.unique_id);
    for (var ci2 = 0; ci2 < allIslands.length; ci2++) {
      var compIsland = allIslands[ci2];
      if (excludedIslandIds.has(compIsland.unique_id)) continue;
      if (visited.has(compIsland.unique_id)) continue;
      var componentNodes = bfsComponent(compIsland.unique_id);
      var componentIslandIds = [];
      for (var cn = 0; cn < componentNodes.length; cn++) {
        var cnid = componentNodes[cn];
        if (cnid > 0 && islandById(islands, cnid) !== undefined) componentIslandIds.push(cnid);
      }
      if (componentIslandIds.length === 0) continue;

      var chosenIsland = null;
      var chosenDist = Infinity;
      for (var cci = 0; cci < componentIslandIds.length; cci++) {
        var candidateIsland = islandById(islands, componentIslandIds[cci]);
        var d = aMap.raw[candidateIsland.tiles_by_army[0].tile_index];
        if (d < chosenDist) { chosenDist = d; chosenIsland = candidateIsland; }
      }

      var compFakeNode = this._nextFakeNodeId(allNodeIds, islands);
      pushArc(compFakeNode, chosenIsland.unique_id, 100000, 10000);
      pushArc(-chosenIsland.unique_id, compFakeNode, 100000, 10000);
      pushArc(compFakeNode, fakeNode, 100000, 10000);
      pushArc(fakeNode, compFakeNode, 100000, 10000);

      nodeSupplyMap.set(compFakeNode, 0);
      allNodeIds.add(compFakeNode);
      allFakeNodeIds.add(compFakeNode);
      disconnectedComponentIslandIds.add(chosenIsland.unique_id);
    }

    // ---------------- Phase 3.6 单向可达性修复
    perf(perfTimer, 'OrTools build phase3.6 directed reachability BFS repair');
    var forwardAdj = new Map();
    var reverseAdj = new Map();
    function addDirected(mapObj2, a, b) {
      var list = mapObj2.get(a);
      if (list === undefined) { list = []; mapObj2.set(a, list); }
      list.push(b);
    }
    for (var ai3 = 0; ai3 < arcStarts.length; ai3++) {
      addDirected(forwardAdj, arcStarts[ai3], arcEnds[ai3]);
      addDirected(reverseAdj, arcEnds[ai3], arcStarts[ai3]);
    }

    function directedReach(adjacencyMap, seeds) {
      var reached = new Set();
      var queue = [];
      var qh = 0;
      for (var si = 0; si < seeds.length; si++) {
        if (!reached.has(seeds[si])) {
          reached.add(seeds[si]);
          queue.push(seeds[si]);
        }
      }
      while (qh < queue.length) {
        var node = queue[qh++];
        var neighbours = adjacencyMap.get(node);
        if (neighbours === undefined) continue;
        for (var ni2 = 0; ni2 < neighbours.length; ni2++) {
          if (!reached.has(neighbours[ni2])) {
            reached.add(neighbours[ni2]);
            queue.push(neighbours[ni2]);
          }
        }
      }
      return reached;
    }

    var sourceNodes = [];
    var sinkNodes = [];
    allNodeIds.forEach(function (nodeId) {
      var supply = nodeSupplyMap.has(nodeId) ? nodeSupplyMap.get(nodeId) : 0;
      if (supply > 0) sourceNodes.push(nodeId);
      else if (supply < 0) sinkNodes.push(nodeId);
    });
    sourceNodes.sort(function (a, b) { return a - b; });
    sinkNodes.sort(function (a, b) { return a - b; });

    var forwardReachableFromSources = directedReach(forwardAdj, sourceNodes);
    var backwardReachableFromSinks = directedReach(reverseAdj, sinkNodes);

    var realForwardAdj = new Map();
    var realReverseAdj = new Map();
    for (var ai4 = 0; ai4 < arcStarts.length; ai4++) {
      var s4 = arcStarts[ai4];
      var e4 = arcEnds[ai4];
      if (allFakeNodeIds.has(Math.abs(s4)) || allFakeNodeIds.has(Math.abs(e4))) continue;
      addDirected(realForwardAdj, s4, e4);
      addDirected(realReverseAdj, e4, s4);
    }
    var realSinkNodes = [];
    for (var rsn = 0; rsn < sinkNodes.length; rsn++) {
      if (!allFakeNodeIds.has(Math.abs(sinkNodes[rsn]))) realSinkNodes.push(sinkNodes[rsn]);
    }
    var realBackwardReachableFromSinks = directedReach(realReverseAdj, realSinkNodes);

    var DIRECTED_REPAIR_COST = 100000;
    var directedRepairSources = [];
    var directedRepairSinks = [];

    // Tarjan SCC：找“没有出边且净供给为正”的闭合分量，给它的真实源加一条排到 fake node 的高价边
    var sccIndexByNode = new Map();
    var sccLowlinkByNode = new Map();
    var sccStack = [];
    var sccNodesOnStack = new Set();
    var sccComponents = [];
    var sccNextIndex = 0;

    function strongconnect(nodeId) {
      sccIndexByNode.set(nodeId, sccNextIndex);
      sccLowlinkByNode.set(nodeId, sccNextIndex);
      sccNextIndex++;
      sccStack.push(nodeId);
      sccNodesOnStack.add(nodeId);

      var targets = realForwardAdj.get(nodeId);
      if (targets !== undefined) {
        for (var ti = 0; ti < targets.length; ti++) {
          var targetNodeId = targets[ti];
          if (!sccIndexByNode.has(targetNodeId)) {
            strongconnect(targetNodeId);
            sccLowlinkByNode.set(nodeId, Math.min(sccLowlinkByNode.get(nodeId), sccLowlinkByNode.get(targetNodeId)));
          } else if (sccNodesOnStack.has(targetNodeId)) {
            sccLowlinkByNode.set(nodeId, Math.min(sccLowlinkByNode.get(nodeId), sccIndexByNode.get(targetNodeId)));
          }
        }
      }

      if (sccLowlinkByNode.get(nodeId) !== sccIndexByNode.get(nodeId)) return;
      var componentNodes2 = [];
      while (true) {
        var stackNodeId = sccStack.pop();
        sccNodesOnStack.delete(stackNodeId);
        componentNodes2.push(stackNodeId);
        if (stackNodeId === nodeId) break;
      }
      sccComponents.push(componentNodes2);
    }

    perf(perfTimer, 'OrTools build phase3.6 SCC terminal surplus repair');
    var sccNodeSeeds = new Set();
    realForwardAdj.forEach(function (_v, k) { sccNodeSeeds.add(k); });
    realReverseAdj.forEach(function (_v, k) { sccNodeSeeds.add(k); });
    sccNodeSeeds.forEach(function (nodeId) {
      if (!sccIndexByNode.has(nodeId)) strongconnect(nodeId);
    });

    var sccIdByNode = new Map();
    for (var sci = 0; sci < sccComponents.length; sci++) {
      for (var scn = 0; scn < sccComponents[sci].length; scn++) {
        sccIdByNode.set(sccComponents[sci][scn], sci);
      }
    }
    var sccHasOutgoingEdge = new Array(sccComponents.length);
    for (var sh = 0; sh < sccHasOutgoingEdge.length; sh++) sccHasOutgoingEdge[sh] = false;
    realForwardAdj.forEach(function (targetNodeIds, sourceNodeId) {
      var sourceSccId = sccIdByNode.get(sourceNodeId);
      for (var tni = 0; tni < targetNodeIds.length; tni++) {
        if (sourceSccId !== sccIdByNode.get(targetNodeIds[tni])) sccHasOutgoingEdge[sourceSccId] = true;
      }
    });

    for (var scc2 = 0; scc2 < sccComponents.length; scc2++) {
      if (sccHasOutgoingEdge[scc2]) continue;
      var sccNetSupply = 0;
      for (var sn2 = 0; sn2 < sccComponents[scc2].length; sn2++) {
        var nid2 = sccComponents[scc2][sn2];
        sccNetSupply += nodeSupplyMap.has(nid2) ? nodeSupplyMap.get(nid2) : 0;
      }
      if (sccNetSupply <= 0) continue;
      for (var s3 = 0; s3 < sccComponents[scc2].length; s3++) {
        var sourceNode3 = sccComponents[scc2][s3];
        if ((nodeSupplyMap.has(sourceNode3) ? nodeSupplyMap.get(sourceNode3) : 0) <= 0) continue;
        if (allFakeNodeIds.has(sourceNode3)) continue;
        if (islandById(islands, sourceNode3) === undefined) continue;
        pushArc(sourceNode3, fakeNode, 100000, DIRECTED_REPAIR_COST);
        directedRepairSources.push(sourceNode3);
        directedRepairSourceIslandIds.add(sourceNode3);
      }
    }

    for (var sd = 0; sd < sourceNodes.length; sd++) {
      var sourceNodeD = sourceNodes[sd];
      if (allFakeNodeIds.has(sourceNodeD)) continue;
      if (realBackwardReachableFromSinks.has(sourceNodeD)) continue;
      pushArc(sourceNodeD, fakeNode, 100000, DIRECTED_REPAIR_COST);
      directedRepairSources.push(sourceNodeD);
      directedRepairSourceIslandIds.add(sourceNodeD);
    }
    for (var sk = 0; sk < sinkNodes.length; sk++) {
      var sinkNodeK = sinkNodes[sk];
      if (forwardReachableFromSources.has(sinkNodeK)) continue;
      if (allFakeNodeIds.has(Math.abs(sinkNodeK))) continue;
      pushArc(fakeNode, sinkNodeK, 100000, DIRECTED_REPAIR_COST);
      allNodeIds.add(sinkNodeK);
      directedRepairSinks.push(sinkNodeK);
      directedRepairSinkIslandIds.add(sinkNodeK);
    }
    for (var sr = 0; sr < sourceNodes.length; sr++) {
      var sourceNodeR = sourceNodes[sr];
      if (backwardReachableFromSinks.has(sourceNodeR)) continue;
      if (allFakeNodeIds.has(sourceNodeR)) continue;
      pushArc(-sourceNodeR, fakeNode, 100000, DIRECTED_REPAIR_COST);
      allNodeIds.add(-sourceNodeR);
      directedRepairSources.push(sourceNodeR);
    }

    // ---------------- Phase 4
    var debugFakeEscapeArcIndexes = new Set();
    if (DEBUG_OR_TOOLS_FAKE_NODE_ESCAPE_ARCS) {
      perf(perfTimer, 'OrTools build debug fake escape arcs');
      var escapeNodes = [];
      allNodeIds.forEach(function (n) { escapeNodes.push(n); });
      escapeNodes.sort(function (a, b) { return a - b; });
      for (var eni = 0; eni < escapeNodes.length; eni++) {
        var escapeNodeId = escapeNodes[eni];
        if (escapeNodeId === 0) continue;
        if (allFakeNodeIds.has(Math.abs(escapeNodeId))) continue;
        debugFakeEscapeArcIndexes.add(arcStarts.length);
        pushArc(escapeNodeId, fakeNode, 100000, DEBUG_OR_TOOLS_FAKE_NODE_ESCAPE_COST);
        debugFakeEscapeArcIndexes.add(arcStarts.length);
        pushArc(fakeNode, escapeNodeId, 100000, DEBUG_OR_TOOLS_FAKE_NODE_ESCAPE_COST);
      }
    }

    perf(perfTimer, 'OrTools build phase4 node index arrays');
    allNodeIds.delete(0);
    var nodeList = [];
    allNodeIds.forEach(function (n) { nodeList.push(n); });
    nodeList.sort(function (a, b) { return a - b; });
    var nodeToIdx = new Map();
    var idxToNode = new Map();
    for (var nli = 0; nli < nodeList.length; nli++) {
      nodeToIdx.set(nodeList[nli], nli);
      idxToNode.set(nli, nodeList[nli]);
    }
    var nodeSupplies = new Array(nodeList.length);
    for (var nsi = 0; nsi < nodeSupplies.length; nsi++) nodeSupplies[nsi] = 0;
    nodeSupplyMap.forEach(function (supply, nid) {
      var idx = nodeToIdx.get(nid);
      if (idx !== undefined) nodeSupplies[idx] = supply;
    });

    var startNodes = new Array(arcStarts.length);
    var endNodes = new Array(arcEnds.length);
    for (var an = 0; an < arcStarts.length; an++) {
      startNodes[an] = nodeToIdx.get(arcStarts[an]);
      endNodes[an] = nodeToIdx.get(arcEnds[an]);
    }

    var result = new OrToolsGraphData({
      start_nodes: startNodes,
      end_nodes: endNodes,
      capacities: arcCaps,
      unit_costs: arcCosts,
      node_ids: nodeList,
      node_supplies: nodeSupplies,
      node_to_idx: nodeToIdx,
      idx_to_node: idxToNode,
      demand_lookup: demands,
      neutral_sinks: neutSinks,
      fake_nodes: allFakeNodeIds,
      cumulative_demand: cumulativeDemand,
      disconnected_component_island_ids: disconnectedComponentIslandIds,
      directed_repair_source_island_ids: directedRepairSourceIslandIds,
      directed_repair_sink_island_ids: directedRepairSinkIslandIds,
      overflow_dump_target_island_ids: overflowDumpTargetIslandIds,
      debug_fake_escape_arc_indexes: debugFakeEscapeArcIndexes
    });
    result.friendly_army_supply = friendlyArmySupply;
    result.enemy_army_demand = enemyArmyDemand;
    result.enemy_general_demand = enemyGeneralDemand;
    return result;
  };

  // ---------------------------------------------------------------- FlowComputer

  function OrToolsFlowComputer(perfTimer, logDebug) {
    this.perf_timer = perfTimer;
    this.log_debug = !!logDebug;
  }

  /**
   * 跑最小费用流并把解翻成 NX 风格的 {source_node_id: {target_node_id: amount}}。
   * 与 python 的差别只有一点：python 把供给不平衡/不可行当成 OrToolsSolveError 抛出去，
   * 这里返回 null（原版上层靠这个降级）。
   */
  OrToolsFlowComputer.prototype.compute_flow = function (islands, graphData) {
    var solver = new MinCostFlow();
    for (var a = 0; a < graphData.start_nodes.length; a++) {
      solver.addArcWithCapacityAndUnitCost(
        graphData.start_nodes[a],
        graphData.end_nodes[a],
        graphData.capacities[a],
        graphData.unit_costs[a]
      );
    }
    for (var n = 0; n < graphData.node_ids.length; n++) {
      solver.setNodeSupply(n, graphData.node_supplies[n]);
    }
    perf(this.perf_timer, 'OrTools solve');
    var solved = solver.solve();
    if (solved === null) return null;

    var flowDict = new Map();
    var fakeNodes = graphData.fake_nodes;
    var idxToNode = graphData.idx_to_node;
    var debugUsage = {};
    graphData.debug_fake_escape_arc_indexes.forEach(function (arcIdx) {
      var fromOrig = idxToNode.get(graphData.start_nodes[arcIdx]);
      var toOrig = idxToNode.get(graphData.end_nodes[arcIdx]);
      if (fromOrig === undefined || toOrig === undefined) return;
      var amount = solved.flows[arcIdx];
      if (amount <= 0) return;
      var fromIsFake = fakeNodes.has(Math.abs(fromOrig));
      var toIsFake = fakeNodes.has(Math.abs(toOrig));
      if (fromIsFake && !toIsFake && toOrig > 0) debugUsage[toOrig] = (debugUsage[toOrig] || 0) + amount;
      else if (!fromIsFake && toIsFake && fromOrig > 0) debugUsage[fromOrig] = (debugUsage[fromOrig] || 0) - amount;
      else if (!fromIsFake && toIsFake && fromOrig < 0) debugUsage[-fromOrig] = (debugUsage[-fromOrig] || 0) - amount;
      else if (fromIsFake && !toIsFake && toOrig < 0) debugUsage[-toOrig] = (debugUsage[-toOrig] || 0) + amount;
    });
    graphData.debug_fake_escape_usage_by_island = debugUsage;

    for (var ai = 0; ai < solved.flows.length; ai++) {
      var flowAmount = solved.flows[ai];
      if (flowAmount <= 0) continue;
      var fromOrig2 = idxToNode.get(graphData.start_nodes[ai]);
      var toOrig2 = idxToNode.get(graphData.end_nodes[ai]);
      if (fromOrig2 === undefined || toOrig2 === undefined) continue;
      var fromIsFake2 = fakeNodes.has(Math.abs(fromOrig2));
      var toIsFake2 = fakeNodes.has(Math.abs(toOrig2));
      if (fromIsFake2 && toIsFake2) continue; // fake->fake 不进入 flow dict
      var targets = flowDict.get(fromOrig2);
      if (targets === undefined) {
        targets = new Map();
        flowDict.set(fromOrig2, targets);
      }
      targets.set(toOrig2, (targets.get(toOrig2) || 0) + flowAmount);
    }
    return flowDict;
  };

  // ---------------------------------------------------------------- 基类桥接

  // flowgraph.js（他人移植）提供基类；这里按名字取，保证两边加载顺序无关。
  function baseProto() {
    var ABC = flow.FlowDirectionFinderABC;
    if (!ABC) throw new Error('EK.flow.FlowDirectionFinderABC 未加载：flowmincost.js 需要 flowgraph.js');
    return ABC.prototype;
  }

  function flowBoundaryCall(self, methodName, args) {
    var proto = baseProto();
    var fn = proto[methodName];
    if (typeof fn !== 'function') {
      throw new Error('EK.flow.FlowDirectionFinderABC.prototype.' + methodName + ' 缺失');
    }
    return fn.apply(self, args);
  }

  var FlowDirectionFinderABC = flow.FlowDirectionFinderABC;
  if (typeof FlowDirectionFinderABC !== 'function') {
    // 还没加载 flowgraph.js：先挂一个占位基类，方法在调用时再解析真实基类，避免加载顺序依赖
    FlowDirectionFinderABC = function FlowDirectionFinderABCLazyBase() {};
    FlowDirectionFinderABC.prototype.classify_islands_for_flow = function () {
      return flowBoundaryCall(this, 'classify_islands_for_flow', arguments);
    };
    FlowDirectionFinderABC.prototype.build_flow_nodes_from_lookups = function () {
      return flowBoundaryCall(this, 'build_flow_nodes_from_lookups', arguments);
    };
    FlowDirectionFinderABC.prototype.configure = function () {};
    FlowDirectionFinderABC.prototype.invalidate_cache = function () {};
  }

  // ---------------------------------------------------------------- Finder

  function OrToolsFlowDirectionFinder(map, intergeneralAnalysis, perfTimer, logDebug, useBackpressure, friendlyGeneral, invalidFlowRenderer) {
    this.map = map;
    this.perf_timer = perfTimer;
    this.log_debug = !!logDebug;
    this.use_backpressure_from_enemy_general = !!useBackpressure;
    this.friendly_general = friendlyGeneral;
    this.invalid_flow_renderer = invalidFlowRenderer || null;
    this.army_override_matrix = null;
    this.negative_tiles = null;
    this.threat_blocking_tiles = null;
    this.constrained_flow_paths = null;

    this._intergeneral_analysis = intergeneralAnalysis;
    this._nx_finder = null;

    this.team = map.friendly_team;
    var teams = typeof map.get_teams_array === 'function'
      ? map.get_teams_array(map)
      : (EK.Map && EK.Map.get_teams_array ? EK.Map.get_teams_array(map) : [0, 1]);
    var otherTeams = teams.filter(function (t) { return t !== this.team; }, this);
    this.target_team = otherTeams.length > 0 ? otherTeams[0] : -1;
    this._enemy_general = null;

    this.ortools_graph_data = null;
    this.ortools_graph_data_no_neut = null;
    this._last_built_graphs_turn = -1;
  }

  OrToolsFlowDirectionFinder.prototype = Object.create(FlowDirectionFinderABC.prototype);
  OrToolsFlowDirectionFinder.prototype.constructor = OrToolsFlowDirectionFinder;

  OrToolsFlowDirectionFinder.prototype.configure = function (team, targetTeam, enemyGeneral) {
    this.team = team;
    this.target_team = targetTeam;
    this.enemy_general = enemyGeneral;
  };

  OrToolsFlowDirectionFinder.prototype.invalidate_cache = function () {
    this.ortools_graph_data = null;
    this.ortools_graph_data_no_neut = null;
    if (this._nx_finder !== null && this._nx_finder !== undefined && typeof this._nx_finder.invalidate_cache === 'function') {
      this._nx_finder.invalidate_cache();
    }
  };

  Object.defineProperty(OrToolsFlowDirectionFinder.prototype, 'graph_data', {
    get: function () { return this.ortools_graph_data; }
  });

  Object.defineProperty(OrToolsFlowDirectionFinder.prototype, 'graph_data_no_neut', {
    get: function () { return this.ortools_graph_data_no_neut; }
  });

  Object.defineProperty(OrToolsFlowDirectionFinder.prototype, 'enemy_general', {
    get: function () { return this._enemy_general; },
    set: function (value) { this._enemy_general = value; }
  });

  OrToolsFlowDirectionFinder.prototype.ensure_graph_data_available = function (islands, allowNeutralFlow) {
    var turnStale = this._last_built_graphs_turn < this.map.turn;
    if (this.ortools_graph_data_no_neut === null || turnStale) {
      perf(this.perf_timer, 'OrTools build_graph_data no_neut');
      this.ortools_graph_data_no_neut = this.build_graph_data(islands, false);
      this._last_built_graphs_turn = this.map.turn;
    }
    if (allowNeutralFlow && (this.ortools_graph_data === null || turnStale)) {
      perf(this.perf_timer, 'OrTools build_graph_data inc_neut');
      this.ortools_graph_data = this.build_graph_data(islands, true);
    }
  };

  OrToolsFlowDirectionFinder.prototype.build_graph_data = function (islands, useNeutralFlow) {
    if (this._enemy_general === null || this._enemy_general === undefined) {
      this._enemy_general = this._intergeneral_analysis.tileB;
    }
    var enemyGeneral = this._enemy_general;
    if (enemyGeneral === null || enemyGeneral === undefined) {
      throw new Error('enemy general is None');
    }
    var builder = new DirectOrToolsGraphBuilder();
    builder.log_debug = this.log_debug;
    return builder.build(
      islands,
      this._intergeneral_analysis,
      this.map,
      this.team,
      this.target_team,
      this.friendly_general,
      enemyGeneral,
      this.use_backpressure_from_enemy_general,
      useNeutralFlow,
      this.army_override_matrix,
      this.negative_tiles,
      this.threat_blocking_tiles,
      this.constrained_flow_paths,
      this.perf_timer
    );
  };

  OrToolsFlowDirectionFinder.prototype.compute_flow_dict = function (islands, graphData, method, renderOnException) {
    var computer = new OrToolsFlowComputer(this.perf_timer, this.log_debug);
    return computer.compute_flow(islands, graphData);
  };

  OrToolsFlowDirectionFinder.prototype.build_flow_graph = function (
    islands,
    ourIslands,
    targetIslands,
    searchingPlayer,
    turns,
    blockGatherFromEnemyBorders,
    negativeTiles,
    includeNeutralDemand,
    method
  ) {
    if (negativeTiles !== this.negative_tiles) {
      this.negative_tiles = negativeTiles;
      this.invalidate_cache();
    }
    perf(this.perf_timer, 'OrTools ensure_graph_data_available');
    this.ensure_graph_data_available(islands, includeNeutralDemand);

    var graphDataWithNeut = this.ortools_graph_data;
    var graphDataNoNeut = this.ortools_graph_data_no_neut;

    perf(this.perf_timer, 'OrTools compute_flow_dict no_neut');
    var noNeutFlowDict = this.compute_flow_dict(islands, graphDataNoNeut, method);
    if (noNeutFlowDict === null) return null;
    var withNeutFlowDict = null;
    if (includeNeutralDemand) {
      perf(this.perf_timer, 'OrTools compute_flow_dict inc_neut');
      withNeutFlowDict = this.compute_flow_dict(islands, graphDataWithNeut, method);
      if (withNeutFlowDict === null) return null;
    }

    var enemyGeneral = this.enemy_general || this._intergeneral_analysis.tileB;
    var targetGeneralIsland = islands.tile_island_lookup.raw[enemyGeneral.tile_index];

    var withNeutGraphLookup = new Map();
    var noNeutGraphLookup = new Map();
    var islandList = sortedIslands(islands);
    var IslandFlowNodeCtor = flow.IslandFlowNode;
    if (typeof IslandFlowNodeCtor !== 'function') {
      throw new Error('EK.flow.IslandFlowNode 未加载：flowmincost.js 需要 flowgraph.js');
    }
    perf(this.perf_timer, 'OrTools build graph_lookups');
    for (var ii = 0; ii < islandList.length; ii++) {
      var isl = islandList[ii];
      var demandNoNeut = graphDataNoNeut.demand_lookup[isl.unique_id] || 0;
      noNeutGraphLookup.set(isl.unique_id, new IslandFlowNodeCtor(isl, demandNoNeut));
      if (includeNeutralDemand) {
        var demandWithNeut = graphDataWithNeut.demand_lookup[isl.unique_id] || 0;
        withNeutGraphLookup.set(isl.unique_id, new IslandFlowNodeCtor(isl, demandWithNeut));
      }
    }

    perf(this.perf_timer, 'OrTools build_flow_nodes_from_lookups no_neut');
    var noNeutResult = flowBoundaryCall(this, 'build_flow_nodes_from_lookups', [
      ourIslands, targetGeneralIsland, targetIslands, noNeutFlowDict, noNeutGraphLookup, graphDataNoNeut, this.log_debug
    ]);
    var backfillNeutNoNeutEdges = noNeutResult[0];
    var enemyBackfillNoNeutFlowNodes = noNeutResult[1];
    var finalRootNoNeutFlowNodes = noNeutResult[2];

    var backfillNeutEdges = [];
    var enemyBackfillFlowNodes = [];
    var finalRootFlowNodes = [];
    if (includeNeutralDemand) {
      perf(this.perf_timer, 'OrTools build_flow_nodes_from_lookups inc_neut');
      var neutResult = flowBoundaryCall(this, 'build_flow_nodes_from_lookups', [
        ourIslands, targetGeneralIsland, targetIslands, withNeutFlowDict, withNeutGraphLookup, graphDataWithNeut, this.log_debug
      ]);
      backfillNeutEdges = neutResult[0];
      enemyBackfillFlowNodes = neutResult[1];
      finalRootFlowNodes = neutResult[2];
    }

    perf(this.perf_timer, 'OrTools alloc+populate tile MapMatrix lookups');
    var MapMatrixCtor = EK.MapMatrix;
    var noNeutFlowNodeLookup = new MapMatrixCtor(this.map, null);
    var incNeutFlowNodeLookup = new MapMatrixCtor(this.map, null);
    noNeutGraphLookup.forEach(function (flowNode) {
      flowNode.island.tile_set.forEach(function (t) {
        noNeutFlowNodeLookup.raw[t.tile_index] = flowNode;
      });
    });
    if (includeNeutralDemand) {
      withNeutGraphLookup.forEach(function (flowNode) {
        flowNode.island.tile_set.forEach(function (t) {
          incNeutFlowNodeLookup.raw[t.tile_index] = flowNode;
        });
      });
    }

    perf(this.perf_timer, 'OrTools IslandMaxFlowGraph ctor');
    var IslandMaxFlowGraphCtor = flow.IslandMaxFlowGraph;
    if (typeof IslandMaxFlowGraphCtor !== 'function') {
      throw new Error('EK.flow.IslandMaxFlowGraph 未加载：flowmincost.js 需要 flowgraph.js');
    }
    var result = new IslandMaxFlowGraphCtor(
      finalRootNoNeutFlowNodes,
      finalRootFlowNodes,
      enemyBackfillNoNeutFlowNodes,
      enemyBackfillFlowNodes,
      backfillNeutNoNeutEdges,
      backfillNeutEdges,
      noNeutFlowNodeLookup,
      incNeutFlowNodeLookup,
      noNeutGraphLookup,
      withNeutGraphLookup
    );
    result.debug_fake_escape_usage_by_island = graphDataNoNeut.debug_fake_escape_usage_by_island;
    return result;
  };

  // flowgraph.js 也导出了 flow.MinCostFlow（networkx 那条路用它），本类同时支持两套 API，
  // 所以谁后加载都不会把对方弄坏；OrToolsMinCostFlow 是给本文件内部/外部明确指名的别名。
  flow.MinCostFlow = MinCostFlow;
  flow.OrToolsMinCostFlow = MinCostFlow;
  flow.SimpleMinCostFlow = MinCostFlow;
  flow.OrToolsGraphData = OrToolsGraphData;
  flow.DirectOrToolsGraphBuilder = DirectOrToolsGraphBuilder;
  flow.OrToolsFlowComputer = OrToolsFlowComputer;
  flow.OrToolsFlowDirectionFinder = OrToolsFlowDirectionFinder;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

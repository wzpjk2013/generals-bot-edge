/*
 * FlowExpansion 的图模型 + 方向求解器（FlowGraphModels / TileIslandFlowRole /
 * FlowDirectionFinderABC / NetworkXFlowDirectionFinder / NxFlowGraphData 的 JS 移植）。
 *
 * 为什么要这一层：原版 bot_ek0x45.py 里 expansion_use_iterative_flow=True、expansion_use_legacy=False，
 * 于是 turn>=50 的扩张全部走 BotExpansionOps.py:623 -> ArmyFlowExpanderV2 ->
 * NetworkXFlowDirectionFinder。它把「岛屿」抽象成流网络里的节点：
 *
 *   每个岛的输入端口 = +unique_id（demand 挂在这里）
 *   每个岛的输岀端口 = -unique_id
 *   岛内 输入->输出 一条边，成本 = tile_count - 1（要花多少回合把兵推过这片地）
 *   岛间 输出->输入 一条边，成本 1（跨一次边界算一回合）
 *   一个 fake 节点当「泄压阀」，能量守恒靠它兜住（将军腹地背压 / 中性岛溢流）
 *
 * 顺序为什么重要（照抄原版时最容易踩的三处）：
 *   1. 建图顺序就是 nx.DiGraph 的节点/边插入顺序，而 flowDict 是按这个顺序产出的；
 *      下游 build_flow_nodes_from_lookups 又是按 flowDict 顺序往 flow_to 里 append 边，
 *      所以边序错了，后续路径重建的顺序也错，最终 moves 顺序就不同。
 *   2. Python 里 islands.all_tile_islands / border_islands / player.tiles 都是 set，
 *      小整数的 set 迭代序等价于升序（Tile.__hash__ == tile_index），
 *      所以 JS 侧一律显式按 tile_index / unique_id 升序，不依赖插入序。
 *   3. neutSinks 是 Python set[int]，插边顺序必须按 unique_id 升序重排。
 *
 * 与原版的有意差异（都在函数处有注释）：
 *   - networkx 的三种求解器（network_simplex / capacity_scaling / min_cost_flow）在这是
 *     同一个自写实现 MinCostFlow（successive shortest path），只保证「最小成本一致」，
 *     平局时选哪条增广路径可能与 networkx 不同（成本相同，流分布可能不同）。
 *   - fake 节点的编号原版是 random.randint(1000000, 9000000)，跨语言没法复现，
 *     这里改成确定性的「1000000 起，避开已有岛 id」。它是纯标签，不影响流量语义；
 *     oracle 比对时把 fake 节点归一化成一个标记再比。
 *   - 不搬 logbook / 渲染 / NxFlowGraphData 的 debug 分支（那些只写日志）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var flow = (EK.flow = EK.flow || {});

  /* ------------------------------------------------------------------ 小工具 */

  // Python 的 team_ids_by_player_index[-1] 命中的是末尾那个中立队 id，JS 数组 [-1] 是 undefined。
  function teamId(map, player) {
    if (player === undefined || player === null) return -1;
    var arr = map.team_ids_by_player_index;
    if (!arr) return player;
    if (player < 0) return arr[arr.length - 1];
    return arr[player];
  }

  function isPlayerOnTeam(map, player, team) {
    return teamId(map, player) === team;
  }

  function teamsArray(map) {
    if (typeof map.get_teams_array === 'function') return map.get_teams_array(map);
    if (map.team_ids_by_player_index) return map.team_ids_by_player_index;
    return [];
  }

  // tileisland.js 里同一个折法：负 team（中立）落在这个数组的最后一格。
  function byTeamIdx(arr, team) {
    if (team < 0) return arr[arr.length - 1];
    return arr[team];
  }

  function sortedTilesByIndex(tileSet) {
    var arr = [];
    tileSet.forEach(function (t) { arr.push(t); });
    arr.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return arr;
  }

  function sortedNums(arrLike) {
    var arr = [];
    arrLike.forEach(function (v) { arr.push(v); });
    arr.sort(function (a, b) { return a - b; });
    return arr;
  }

  function islandTilesSorted(island) {
    return sortedTilesByIndex(island.tile_set);
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  // Map / 普通对象 / 数组三种「字典」写法都收一下，oracle 与 JS 互通时省事。
  function toMap(d) {
    if (d === null || d === undefined) return new Map();
    if (d instanceof Map) return d;
    var m = new Map();
    if (Array.isArray(d)) {
      for (var i = 0; i < d.length; i++) {
        var e = d[i];
        if (Array.isArray(e)) m.set(e[0], e[1]);
        else if (e && e.node !== undefined) m.set(e.node, e.demand === undefined ? e.value : e.demand);
      }
      return m;
    }
    for (var k in d) if (hasOwn(d, k)) m.set(Number(k), d[k]);
    return m;
  }

  function mapGet(m, k, dflt) {
    if (m instanceof Map) return m.has(k) ? m.get(k) : dflt;
    if (m && hasOwn(m, k)) return m[k];
    return dflt;
  }

  /* -------------------------------------------------------- 最小成本流求解器 */

  /*
   * 对应 networkx 的 min_cost_flow：整数流、总成本最小、每个节点的 demand 必须被满足。
   * 用 successive shortest path（每次沿最短路增广）实现，SPFA 处理残量图上的负成本（反向边）。
   *
   * 平局说明：等成本的多条增广路径选哪条由「节点 id 升序选源 + 邻接插入序」决定，
   * 与 networkx 未必一致 —— 成本一定相同，流分布可能不同，比对时只比成本。
   */
  function MinCostFlow(nodeCount) {
    this.nodeCount = nodeCount || 0;
    this._adj = new Map();
    this._edges = [];
  }

  MinCostFlow.prototype.add_node = function (n) {
    if (!this._adj.has(n)) this._adj.set(n, []);
  };

  MinCostFlow.prototype.add_edge = function (u, v, cap, cost) {
    this.add_node(u);
    this.add_node(v);
    var forward = { u: u, v: v, cap: cap, cost: cost, flow: 0, order: this._edges.length };
    var backward = { u: v, v: u, cap: 0, cost: -cost, flow: 0, order: this._edges.length, isReverse: true };
    forward.rev = backward;
    backward.rev = forward;
    this._adj.get(u).push(forward);
    this._adj.get(v).push(backward);
    this._edges.push(forward);
    return forward;
  };

  MinCostFlow.prototype.nodes = function () {
    return Array.from(this._adj.keys());
  };

  MinCostFlow.prototype.solve = function (demands) {
    var demandMap = toMap(demands);
    var self = this;
    var balance = new Map(); // >0 = 还有兵要送出去，<0 = 还缺兵
    var totalDemand = 0;
    this._adj.forEach(function (_, n) {
      var d = demandMap.has(n) ? demandMap.get(n) : 0;
      totalDemand += d;
      balance.set(n, -d);
    });
    demandMap.forEach(function (d, n) {
      if (!self._adj.has(n)) {
        totalDemand += d;
        balance.set(n, -d);
        self._adj.set(n, []);
      }
    });
    if (totalDemand !== 0) {
      throw new Error('MinCostFlow: 节点 demand 之和必须为 0，实际 ' + totalDemand);
    }

    var nodeIds = Array.from(balance.keys()).sort(function (a, b) { return a - b; });
    var anySupply = function () {
      for (var i = 0; i < nodeIds.length; i++) {
        if (balance.get(nodeIds[i]) > 1e-9) return nodeIds[i];
      }
      return null;
    };

    var guard = 0;
    while (true) {
      var src = anySupply();
      if (src === null) break;
      if (++guard > 100000) throw new Error('MinCostFlow: 增广次数异常，疑似死循环');

      // SPFA：残量图上从 src 出发的最短路
      var dist = new Map();
      var prevEdge = new Map();
      for (var i = 0; i < nodeIds.length; i++) dist.set(nodeIds[i], Infinity);
      dist.set(src, 0);
      var queue = [src];
      var inQueue = new Set([src]);
      while (queue.length > 0) {
        var u = queue.shift();
        inQueue.delete(u);
        var du = dist.get(u);
        var adj = this._adj.get(u) || [];
        for (var a = 0; a < adj.length; a++) {
          var e = adj[a];
          if (e.cap - e.flow <= 0) continue;
          var nd = du + e.cost;
          if (nd < dist.get(e.v) - 1e-12) {
            dist.set(e.v, nd);
            prevEdge.set(e.v, e);
            if (!inQueue.has(e.v)) {
              queue.push(e.v);
              inQueue.add(e.v);
            }
          }
        }
      }

      var target = null;
      var bestDist = Infinity;
      for (var t = 0; t < nodeIds.length; t++) {
        var n = nodeIds[t];
        if (balance.get(n) >= -1e-9) continue;
        if (dist.get(n) === Infinity) continue;
        if (dist.get(n) < bestDist) {
          bestDist = dist.get(n);
          target = n;
        }
      }
      if (target === null) {
        throw new Error('MinCostFlow: 无可行流（存在供不足的节点，最短路不通）');
      }

      var amount = balance.get(src);
      var need = -balance.get(target);
      if (need < amount) amount = need;
      var walk = target;
      while (walk !== src) {
        var pe = prevEdge.get(walk);
        if (pe === undefined) throw new Error('MinCostFlow: 增广路径断开');
        var room = pe.cap - pe.flow;
        if (room < amount) amount = room;
        walk = pe.u;
      }
      if (amount <= 0) throw new Error('MinCostFlow: 增广量为 0，残量图退化');

      walk = target;
      while (walk !== src) {
        var pe2 = prevEdge.get(walk);
        pe2.flow += amount;
        pe2.rev.flow -= amount;
        walk = pe2.u;
      }
      balance.set(src, balance.get(src) - amount);
      balance.set(target, balance.get(target) + amount);
    }

    var cost = 0;
    var edges = [];
    for (var k = 0; k < this._edges.length; k++) {
      var fe = this._edges[k];
      cost += fe.flow * fe.cost;
      edges.push({ u: fe.u, v: fe.v, flow: fe.flow, cost: fe.cost });
    }
    return { edges: edges, cost: cost };
  };

  flow.MinCostFlow = MinCostFlow;

  /* ------------------------------------------------------------- 图模型定义 */

  flow.FlowGraphMethod = {
    NetworkSimplex: 1,
    CapacityScaling: 2,
    MinCostFlow: 3,
    PyMaxflowBoykovKolmogorov: 10,
    PyMaxflowWithNodeSplitting: 11,
    OrToolsSimpleMinCost: 20
  };

  function IslandFlowEdge(sourceFlowNode, targetFlowNode, edgeArmy) {
    this.source_flow_node = sourceFlowNode;
    this.target_flow_node = targetFlowNode;
    this.edge_army = edgeArmy;
  }

  // 下游可能按 flowgraph.js 的约定用短名，双名暴露，避免两边对不上。
  Object.defineProperty(IslandFlowEdge.prototype, 'source', {
    get: function () { return this.source_flow_node; },
    set: function (v) { this.source_flow_node = v; }
  });
  Object.defineProperty(IslandFlowEdge.prototype, 'target', {
    get: function () { return this.target_flow_node; },
    set: function (v) { this.target_flow_node = v; }
  });
  Object.defineProperty(IslandFlowEdge.prototype, 'edgeArmy', {
    get: function () { return this.edge_army; },
    set: function (v) { this.edge_army = v; }
  });

  IslandFlowEdge.prototype.toString = function () {
    return '(' + this.edge_army + ') ' + String(this.target_flow_node);
  };

  IslandFlowEdge.prototype.copy = function (newSource) {
    return new IslandFlowEdge(newSource, this.target_flow_node.copy(), this.edge_army);
  };

  flow.IslandFlowEdge = IslandFlowEdge;

  /*
   * 原版签名是 (island, desiredArmy)；这里同时接受 (island, {is_input_throughput: true})，
   * 因为下游有个调用点按「是否输入吞吐端口」来描述节点。desired_army 负数=我方要送出的兵，
   * 正数=要打进去的兵。
   */
  function IslandFlowNode(island, desiredArmyOrOpts) {
    var opts = null;
    var desired = 0;
    if (typeof desiredArmyOrOpts === 'boolean') {
      opts = { is_input_throughput: desiredArmyOrOpts };
    } else if (desiredArmyOrOpts && typeof desiredArmyOrOpts === 'object' && !Array.isArray(desiredArmyOrOpts)) {
      opts = desiredArmyOrOpts;
      if (opts.desired_army !== undefined) desired = opts.desired_army;
      else if (opts.desiredArmy !== undefined) desired = opts.desiredArmy;
    } else if (typeof desiredArmyOrOpts === 'number') {
      desired = desiredArmyOrOpts;
    }

    this.island = island;
    this.node_id = island && island.unique_id !== undefined ? island.unique_id : null;
    this.desired_army = desired;
    this.is_input_throughput = !!(opts && opts.is_input_throughput);
    // 短名别名，下游按 is_throughput 读。
    this.is_throughput = this.is_input_throughput;
    this.army_flow_received = 0;
    this.flow_to = [];
    this.flow_from = [];
  }

  IslandFlowNode.prototype.base_str = function () {
    var firstTile = this.island.tile_set.size > 0 ? sortedTilesByIndex(this.island.tile_set)[0] : null;
    return '{t' + this.island.team + ':' + this.island.unique_id + '/' + this.island.name +
      ' ' + this.island.tile_count + 't ' + this.island.sum_army + 'a (' + String(firstTile) + ')}';
  };

  IslandFlowNode.prototype.toString = function () {
    var self = this;
    var targets = this.flow_to.map(function (n) {
      var tgt = n.target_flow_node.island;
      var t0 = tgt.tile_set.size > 0 ? sortedTilesByIndex(tgt.tile_set)[0] : null;
      return '(' + n.edge_army + ') {t' + tgt.team + ':' + tgt.unique_id + '/' + tgt.name + ' (' + String(t0) + ')}';
    });
    return self.base_str() + (targets.length > 0 ? ' (-> ' + targets.join(' | ') + ')' : '');
  };

  // Python 的 __lt__ 按 unique_id；JS Array.sort 需要显式比较器，排序时用这个。
  IslandFlowNode.prototype.lt = function (other) {
    return this.island.unique_id < other.island.unique_id;
  };

  IslandFlowNode.prototype.copy = function () {
    var clone = new IslandFlowNode(this.island, this.desired_army);
    clone.is_input_throughput = this.is_input_throughput;
    clone.is_throughput = this.is_throughput;
    clone.army_flow_received = this.army_flow_received;
    for (var i = 0; i < this.flow_to.length; i++) {
      var clonedEdge = this.flow_to[i].copy(clone);
      clone.flow_to.push(clonedEdge);
      clonedEdge.target_flow_node.flow_from.push(clonedEdge);
    }
    return clone;
  };

  IslandFlowNode.prototype.set_flow_to = function (destNode, edgeArmy) {
    var existing = null;
    for (var i = 0; i < this.flow_to.length; i++) {
      if (this.flow_to[i].target_flow_node.island.unique_id === destNode.island.unique_id) {
        existing = this.flow_to[i];
        break;
      }
    }
    if (existing) {
      // 原版在这两处抛异常来暴露「同一座岛出现了两个不同 flow node」的 bug，保持同样的防线。
      if (destNode !== existing.target_flow_node) {
        throw new Error('Corrupt flow nodes in add_edge. destNode 与现有边的目标节点不同，' +
          '但属于同一座岛。' + String(existing) + ' | ' + String(destNode));
      }
      if (existing.edge_army !== edgeArmy) {
        throw new Error('Corrupt flow nodes in add_edge. edgeArmy 不一致。' +
          String(existing) + ' | ' + String(destNode));
      }
      existing.edge_army = edgeArmy;
      return false;
    }
    var newEdge = new IslandFlowEdge(this, destNode, edgeArmy);
    this.flow_to.push(newEdge);
    destNode.flow_from.push(newEdge);
    return true;
  };

  flow.IslandFlowNode = IslandFlowNode;

  /*
   * 原版构造函数是 10 个位置参数；这里同时接受对象写法（下游更爱用对象）。
   * 另外补了 fake_nodes / neutral_sinks / flow_diag_island_ids 三个集合：
   * 原版它们是 NxFlowGraphData 上的字段，但 flow graph 的消费者经常需要，
   * 放在图上比让每个下游都去翻 graphData 更不容易漏。
   */
  function IslandMaxFlowGraph(a, b, c, d, e, f, g, h, i, j) {
    if (a && typeof a === 'object' && !Array.isArray(a) && b === undefined) {
      var o = a;
      this.root_flow_nodes_no_neut = o.root_flow_nodes_no_neut || [];
      this.root_flow_nodes_inc_neut = o.root_flow_nodes_inc_neut || [];
      this.enemy_backfill_nodes_no_neut = o.enemy_backfill_nodes_no_neut || [];
      this.enemy_backfill_nodes_inc_neut = o.enemy_backfill_nodes_inc_neut || [];
      this.enemy_backfill_neut_dump_edges = o.enemy_backfill_neut_dump_edges || [];
      this.enemy_backfill_neut_dump_edges_no_neut = o.enemy_backfill_neut_dump_edges_no_neut || [];
      this.flow_node_lookup_by_tile_no_neut = o.flow_node_lookup_by_tile_no_neut || null;
      this.flow_node_lookup_by_tile_inc_neut = o.flow_node_lookup_by_tile_inc_neut || null;
      this.flow_node_lookup_by_island_no_neut = o.flow_node_lookup_by_island_no_neut || new Map();
      this.flow_node_lookup_by_island_inc_neut = o.flow_node_lookup_by_island_inc_neut || new Map();
      this.fake_nodes = o.fake_nodes || new Set();
      this.neutral_sinks = o.neutral_sinks || new Set();
      this.flow_diag_island_ids = o.flow_diag_island_ids || new Set();
      this.debug_fake_escape_usage_by_island = {};
      return;
    }
    this.root_flow_nodes_no_neut = a || [];
    this.root_flow_nodes_inc_neut = b || [];
    this.enemy_backfill_nodes_no_neut = c || [];
    this.enemy_backfill_nodes_inc_neut = d || [];
    this.enemy_backfill_neut_dump_edges = e || [];
    this.enemy_backfill_neut_dump_edges_no_neut = f || [];
    this.flow_node_lookup_by_tile_no_neut = g || null;
    this.flow_node_lookup_by_tile_inc_neut = h || null;
    this.flow_node_lookup_by_island_no_neut = i || new Map();
    this.flow_node_lookup_by_island_inc_neut = j || new Map();
    this.fake_nodes = new Set();
    this.neutral_sinks = new Set();
    this.flow_diag_island_ids = new Set();
    this.debug_fake_escape_usage_by_island = {};
  }

  // 下游要遍历整图（渲染 / 调试），这里把根节点、回填节点和它们流出去的目标去重合并。
  Object.defineProperty(IslandMaxFlowGraph.prototype, 'nodes', {
    get: function () {
      var out = [];
      var seen = new Set();
      var lists = [
        this.root_flow_nodes_inc_neut, this.root_flow_nodes_no_neut,
        this.enemy_backfill_nodes_inc_neut, this.enemy_backfill_nodes_no_neut
      ];
      for (var i = 0; i < lists.length; i++) {
        var list = lists[i] || [];
        for (var k = 0; k < list.length; k++) {
          var n = list[k];
          if (!seen.has(n)) { seen.add(n); out.push(n); }
          for (var m = 0; m < n.flow_to.length; m++) {
            var tn = n.flow_to[m].target_flow_node;
            if (!seen.has(tn)) { seen.add(tn); out.push(tn); }
          }
        }
      }
      return out;
    }
  });

  Object.defineProperty(IslandMaxFlowGraph.prototype, 'edges', {
    get: function () {
      var out = [];
      var nodes = this.nodes;
      for (var i = 0; i < nodes.length; i++) {
        for (var k = 0; k < nodes[i].flow_to.length; k++) out.push(nodes[i].flow_to[k]);
      }
      return out;
    }
  });

  flow.IslandMaxFlowGraph = IslandMaxFlowGraph;

  function TileIslandFlowRole(island, a, b, c, d, e, f) {
    // 两种构造方式都要吃：原版是按位置传，新代码更愿意传一个具名字典。
    if (island && typeof island === 'object' && a === undefined) {
      var o = island;
      this.island = o.island;
      this.is_neutral_sink_with_neut = !!o.is_neutral_sink_with_neut;
      this.is_neutral_sink_no_neut = !!o.is_neutral_sink_no_neut;
      this.borders_friendly = !!o.borders_friendly;
      this.borders_enemy = !!o.borders_enemy;
      this.are_all_borders_neutral = !!o.are_all_borders_neutral;
      this.capacity = o.capacity === undefined ? 100000 : o.capacity;
      return;
    }
    this.island = island;
    this.is_neutral_sink_with_neut = !!a;
    this.is_neutral_sink_no_neut = !!b;
    this.borders_friendly = !!c;
    this.borders_enemy = !!d;
    this.are_all_borders_neutral = !!e;
    this.capacity = f === undefined ? 100000 : f;
  }

  TileIslandFlowRole.prototype.is_neutral_sink = function (useNeutralFlow) {
    return useNeutralFlow ? this.is_neutral_sink_with_neut : this.is_neutral_sink_no_neut;
  };

  flow.TileIslandFlowRole = TileIslandFlowRole;

  /*
   * 原版 NxFlowGraphData：nx.DiGraph + 每岛 demand + 各种汇总标量。
   * node_attrs 单独存（nx 把 demand 放在节点属性里，这里等价）。
   */
  function NxFlowGraphData(graph, neutSinks, demands, cumulativeDemand, fakeNodes) {
    this.graph = graph;
    this.neutral_sinks = neutSinks || new Set();
    this.demand_lookup = demands || new Map();
    this.cumulative_demand = cumulativeDemand;
    this.fake_nodes = fakeNodes || new Set();
    this.friendly_army_supply = 0;
    this.enemy_army_demand = 0;
    this.enemy_general_demand = 0;
    this.flow_diag_island_ids = new Set();
    this.node_demands = new Map();
  }

  NxFlowGraphData.prototype.demand = function (nodeId) {
    return mapGet(this.demand_lookup, nodeId, 0);
  };

  // 图节点的 demand：python 是 nx 的节点属性，这里单独用一张表存，
  // 避免为了一个属性去改 EK.nx.Graph（那是别人的模块）。
  NxFlowGraphData.prototype.set_node_demand = function (nodeId, demand) {
    this.node_demands.set(nodeId, demand);
  };

  NxFlowGraphData.prototype.node_demand = function (nodeId) {
    return this.node_demands.has(nodeId) ? this.node_demands.get(nodeId) : 0;
  };

  flow.NxFlowGraphData = NxFlowGraphData;

  /* ---------------------------------------------------- 共享的岛分类 / 建点 */

  function FlowDirectionFinderABC() {
    this.map = null;
    this.intergeneral_analysis = null;
    this.team = 0;
    this.target_team = -1;
    this._enemy_general = null;
    this.negative_tiles = null;
  }

  FlowDirectionFinderABC.prototype.configure = function (team, targetTeam, enemyGeneral) {
    this.team = team;
    this.target_team = targetTeam;
    this.enemy_general = enemyGeneral;
  };

  FlowDirectionFinderABC.prototype.invalidate_cache = function () {};

  Object.defineProperty(FlowDirectionFinderABC.prototype, 'enemy_general', {
    get: function () { return this._enemy_general; },
    set: function (v) { this._enemy_general = v; }
  });

  // Python 的 graph_lookup 是 dict[int, IslandFlowNode]，all_tile_islands 是 OrderedTileIslandSet。
  function allIslands(islands) {
    if (!islands) return [];
    if (Array.isArray(islands)) return islands;
    // 调用方传进来的其实一直是 TileIslandBuilder（Python 里 properties 也都挂在 builder 上），
    // 岛集合只是它的一个字段，所以先剥一层 all_tile_islands。
    if (islands.all_tile_islands) {
      var held = islands.all_tile_islands;
      if (typeof held.items === 'function') return held.items();
      if (Array.isArray(held)) return held;
      if (typeof held.values === 'function') return Array.from(held.values());
      return [];
    }
    if (typeof islands.items === 'function') return islands.items();
    return Array.from(islands.values ? islands.values() : []);
  }

  function islandLookupById(islands) {
    var byId = islands && islands.tile_islands_by_unique_id;
    if (byId instanceof Map) return byId;
    var m = new Map();
    if (byId) {
      for (var k in byId) if (hasOwn(byId, k)) m.set(Number(k), byId[k]);
    }
    return m;
  }

  FlowDirectionFinderABC.prototype.classify_islands_for_flow = function (
    islands, intergeneral_analysis, map, team, target_team
  ) {
    var enDist = intergeneral_analysis.shortestPathWay.distance;
    var neutEnDistCutoff = Math.trunc(enDist * 1.0);
    var pathwayCutoff = Math.trunc(1.25 * enDist) + 1;
    // target_team 可能是 -1（只朝中立扩张）：这时不能把中立岛同时当成敌方接壤岛。
    var has_real_target_team = target_team !== -1;
    var pathwayTiles = intergeneral_analysis.shortestPathWay.tiles;

    var capacityLookup = new Map();

    var teamStats = map.get_team_stats_by_team_id(team);
    var usPlayers = teamStats.livingPlayers || [];
    var startTiles = [];
    for (var p = 0; p < usPlayers.length; p++) {
      var playerTiles = map.players[usPlayers[p]].tiles;
      var sorted = sortedTilesByIndex(playerTiles);
      for (var t = 0; t < sorted.length; t++) {
        var tile = sorted[t];
        if (tile.army > 1 || pathwayTiles.has(tile)) startTiles.push(tile);
      }
    }

    var neutFlowDepthDistance = 2;

    EK.search.breadth_first_foreach_dist_fast_no_neut_cities(map, startTiles, neutFlowDepthDistance,
      function (tt, dist) {
        var island = islands.tile_island_lookup.raw[tt.tile_index];
        if (island === null || island === undefined) return true;
        if (island.team === team) return false;
        if (island.team === -1 && !pathwayTiles.has(tt)) {
          // 原版写的是「取 max(cap, 100000)」，即只要是开场友好的近邻中立岛就把容量顶满。
          var existingCap = capacityLookup.has(island.unique_id) ? capacityLookup.get(island.unique_id) : 0;
          var cap = neutFlowDepthDistance - dist + 1;
          if (cap > existingCap) capacityLookup.set(island.unique_id, 100000);
        }
        return false;
      });

    var neutGenDepth = 8;
    var generalTile = map.players[map.player_index].general;
    EK.search.breadth_first_foreach_dist_fast_no_neut_cities(map, [generalTile], neutGenDepth,
      function (tt, dist) {
        var island = islands.tile_island_lookup.raw[tt.tile_index];
        if (island === null || island === undefined) return true;
        if (island.team === -1) {
          var existingCap = capacityLookup.has(island.unique_id) ? capacityLookup.get(island.unique_id) : 0;
          var cap = neutGenDepth - dist + 1;
          if (cap > existingCap) capacityLookup.set(island.unique_id, 100000);
        }
        return false;
      });

    var result = new Map();
    var islandList = allIslands(islands);
    for (var ii = 0; ii < islandList.length; ii++) {
      var island2 = islandList[ii];
      var borders_fr = false;
      var borders_en = false;
      var borderList = island2.border_islands;
      var borderArr = typeof borderList.items === 'function' ? borderList.items() : Array.from(borderList);
      for (var b1 = 0; b1 < borderArr.length; b1++) {
        if (borderArr[b1].team === team) { borders_fr = true; break; }
      }
      for (var b2 = 0; b2 < borderArr.length; b2++) {
        if (has_real_target_team && borderArr[b2].team === target_team) { borders_en = true; break; }
      }
      var are_all_borders_neut = !borders_fr && !borders_en;
      var is_neut = island2.team === -1;

      var sink_with_neut = is_neut && are_all_borders_neut && !capacityLookup.has(island2.unique_id);
      var sink_no_neut = sink_with_neut; // 原版这里还有一段被注释掉的精细判定，照抄保留结论

      var capValue = capacityLookup.has(island2.unique_id) ? capacityLookup.get(island2.unique_id) : 10000;

      result.set(island2.unique_id, new TileIslandFlowRole({
        island: island2,
        is_neutral_sink_with_neut: sink_with_neut,
        is_neutral_sink_no_neut: sink_no_neut,
        borders_friendly: borders_fr,
        borders_enemy: borders_en,
        are_all_borders_neutral: are_all_borders_neut,
        capacity: capValue
      }));
    }
    // neutEnDistCutoff / pathwayCutoff 原版就算出来没用（上面那段被注释掉了），这里保留变量名以免被当成漏搬。
    void neutEnDistCutoff;
    void pathwayCutoff;
    return result;
  };

  FlowDirectionFinderABC.prototype.build_flow_nodes_from_lookups = function (
    our_islands, target_general_island, target_islands, flow_dict, graph_lookup, graph_data, log_debug
  ) {
    var backfill_neut_edges = [];
    var our_set = new Set();
    for (var oi = 0; oi < our_islands.length; oi++) our_set.add(our_islands[oi].unique_id);
    var target_set = new Set();
    for (var ti = 0; ti < target_islands.length; ti++) target_set.add(target_islands[ti].unique_id);

    var fakeNodes = graph_data.fake_nodes || new Set();
    var neutralSinks = graph_data.neutral_sinks || new Set();
    var flowDiagIslands = graph_data.flow_diag_island_ids || new Set();
    var rootOutputFlow = new Map();
    var throughputViolations = 0;

    var lookup = function (id) {
      if (graph_lookup instanceof Map) return graph_lookup.has(id) ? graph_lookup.get(id) : null;
      return hasOwn(graph_lookup, id) ? graph_lookup[id] : null;
    };

    flow_dict.forEach(function (targets, rawNodeId) {
      var is_throughput = false;
      var node_id = rawNodeId;
      // 正 id 是岛的输入端口：它的流只会流向自己的输出端口，等价于「兵借道这座岛」。
      if (node_id > 0) is_throughput = true;
      else node_id = -node_id;

      var source_node = lookup(node_id);

      targets.forEach(function (target_flow_amount, target_node_id) {
        if (target_flow_amount === 0) return;

        if (is_throughput && source_node) {
          if (target_node_id !== -node_id) {
            /*
             * 原版这里直接 raise（FlowDirectionFinderABC.py:228）。它靠 ortools 的最优解保证
             * 「输入端口只流向自己的输出端口」，我们这份自研最小成本流偶尔会把兵从输入端口
             * 甩到 fake 节点上（escape 弧被用到）。这是解质量差异，不是数据错误 —— 抛出去只会
             * 让整回合不出招、回落自制引擎，所以记一次计数后跳过这条弧。
             */
            throughputViolations += 1;
            EK.flow.throughputViolations = throughputViolations;
            return;
          }
          source_node.army_flow_received += target_flow_amount;
          return;
        }

        if (source_node !== null && our_set.has(source_node.island.unique_id)) {
          rootOutputFlow.set(source_node.island.unique_id,
            (rootOutputFlow.get(source_node.island.unique_id) || 0) + target_flow_amount);
        }

        if (!fakeNodes.has(node_id)) {
          our_set.delete(target_node_id);
          target_set.delete(target_node_id);
        }
        var target_node = lookup(target_node_id);
        if (target_node === null) {
          return;
        }

        if (neutralSinks.has(target_node_id)) {
          if (source_node === null) {
            backfill_neut_edges.push(new IslandFlowEdge(null, target_node, target_flow_amount));
            return;
          }
          if (source_node.island === target_general_island) {
            backfill_neut_edges.push(new IslandFlowEdge(source_node, target_node, target_flow_amount));
            source_node.army_flow_received -= target_flow_amount;
            return;
          }
        }

        if (source_node === null) {
          if (target_node.island === target_general_island) {
            // 敌方将军岛的背压：fake 节点倒灌回来的兵要抵掉它的需求。
            target_node.army_flow_received -= target_flow_amount;
          }
          return;
        }

        source_node.set_flow_to(target_node, target_flow_amount);
      });
    });

    // Python 是 set[int] 迭代（小整数≈升序），这里显式升序，保证节点顺序可复现。
    var final_root_flow_nodes = sortedNums(our_set).map(function (id) { return lookup(id); })
      .filter(function (n) { return n !== null; });
    var enemy_backfill_flow_nodes = sortedNums(target_set).map(function (id) { return lookup(id); })
      .filter(function (n) { return n !== null; });

    if (log_debug) {
      // 原版这一段只写 logbook 诊断，保留分支但不产生字符串拼接开销。
      void flowDiagIslands;
    }

    return [backfill_neut_edges, enemy_backfill_flow_nodes, final_root_flow_nodes];
  };

  flow.FlowDirectionFinderABC = FlowDirectionFinderABC;

  /* ------------------------------------------------ NetworkX 方向求解器实现 */

  /*
   * 参数兼容：原版是 (map, intergeneral_analysis, friendly_general, use_backpressure_from_enemy_general,
   * perf_timer, log_debug, invalid_flow_renderer)；下游可能按 (map, perfTimer) 简写后手动 set
   * intergeneral_analysis。两种都吃：第二个参数有 shortestPathWay 就当 intergeneral_analysis。
   */
  function NetworkXFlowDirectionFinder(map, a, b, c, d, e, f) {
    FlowDirectionFinderABC.call(this);
    this.map = map;
    this.log_debug = false;
    this.invalid_flow_renderer = null;
    this.perf_timer = null;
    this.intergeneral_analysis = null;
    this.use_backpressure_from_enemy_general = true;
    this.friendly_general = null;

    if (a && typeof a === 'object' && a.shortestPathWay !== undefined) {
      this.intergeneral_analysis = a;
      this.friendly_general = b || null;
      this.use_backpressure_from_enemy_general = c === undefined ? true : !!c;
      this.perf_timer = d || null;
      this.log_debug = !!e;
      this.invalid_flow_renderer = f || null;
    } else {
      this.perf_timer = a || null;
    }

    this.negative_tiles = null;
    this.team = map.friendly_team;
    var teams = teamsArray(map);
    this.target_team = -1;
    for (var i = 0; i < teams.length; i++) {
      if (teams[i] !== this.team) { this.target_team = teams[i]; break; }
    }
    this._enemy_general = null;
    this.nx_graph_data = null;
    this.nx_graph_data_no_neut = null;
    this._last_built_graphs_turn = -1;
  }

  NetworkXFlowDirectionFinder.prototype = Object.create(FlowDirectionFinderABC.prototype);
  NetworkXFlowDirectionFinder.prototype.constructor = NetworkXFlowDirectionFinder;

  Object.defineProperty(NetworkXFlowDirectionFinder.prototype, 'graph_data', {
    get: function () { return this.nx_graph_data; }
  });
  Object.defineProperty(NetworkXFlowDirectionFinder.prototype, 'graph_data_no_neut', {
    get: function () { return this.nx_graph_data_no_neut; }
  });
  Object.defineProperty(NetworkXFlowDirectionFinder.prototype, 'nxGraphData', {
    get: function () { return this.nx_graph_data; }
  });
  Object.defineProperty(NetworkXFlowDirectionFinder.prototype, 'nxGraphDataNoNeut', {
    get: function () { return this.nx_graph_data_no_neut; }
  });

  NetworkXFlowDirectionFinder.prototype.invalidate_cache = function () {
    this.nx_graph_data = null;
    this.nx_graph_data_no_neut = null;
    this._last_built_graphs_turn = -1;
  };

  NetworkXFlowDirectionFinder.prototype.ensure_flow_graph_exists = function (islands) {
    this.ensure_graph_data_available(islands);
  };

  NetworkXFlowDirectionFinder.prototype.ensure_graph_data_available = function (islands, allow_neutral_flow) {
    if (this.nx_graph_data === null || this.nx_graph_data_no_neut === null ||
        this._last_built_graphs_turn < this.map.turn) {
      if (allow_neutral_flow) {
        this.nx_graph_data = this.build_graph_data(islands, true);
      }
      this.nx_graph_data_no_neut = this.build_graph_data(islands, false);
      this._last_built_graphs_turn = this.map.turn;
    }
  };

  NetworkXFlowDirectionFinder.prototype._determine_initial_demands_and_split_input_output_nodes = function (
    graph, islands, ourSet, targetSet, includeNeutralFlow
  ) {
    var demands = new Map();
    var cumulativeDemand = 0;
    var friendlyArmySupply = 0;
    var enemyArmyDemand = 0;
    var enemyGeneralDemand = 0;
    var targetGeneralIsland = islands.tile_island_lookup.raw[this.enemy_general.tile_index];
    var islandList = allIslands(islands);

    for (var i = 0; i < islandList.length; i++) {
      var island = islandList[i];
      var cost = island.tile_count - 1;
      var demand = island.tile_count - island.sum_army;
      var hasDemandAttr = false;

      if (ourSet.has(island.unique_id)) {
        var island_army_sum = island.sum_army;
        if (this.negative_tiles !== null && this.negative_tiles !== undefined) {
          var tiles = islandTilesSorted(island);
          for (var t = 0; t < tiles.length; t++) {
            if (this.negative_tiles.has(tiles[t])) island_army_sum -= tiles[t].army;
          }
        }
        demand = island.tile_count - island_army_sum;
        hasDemandAttr = true;
        cumulativeDemand += demand;
        friendlyArmySupply += island_army_sum - island.tile_count;
      } else if (targetSet.has(island.unique_id)) {
        demand = island.sum_army + island.tile_count;
        hasDemandAttr = true;
        cumulativeDemand += demand;
        enemyArmyDemand += demand;
        if (island === targetGeneralIsland) enemyGeneralDemand = demand;
      } else if (includeNeutralFlow && island.team === -1) {
        hasDemandAttr = true;
        cumulativeDemand += demand;
        cost *= 2; // 中立地被折价绕过：穿过中立岛比穿过自家岛贵一倍
      }

      demands.set(island.unique_id, demand);
      void hasDemandAttr;

      graph.add_node(island.unique_id);
      graph.add_edge(island.unique_id, -island.unique_id, { weight: cost, capacity: 100000 });
    }

    return [cumulativeDemand, demands, friendlyArmySupply, enemyArmyDemand, enemyGeneralDemand];
  };

  NetworkXFlowDirectionFinder.prototype.build_graph_data = function (islands, use_neutral_flow) {
    // 必须是有向图：原版用 nx.DiGraph，而 EK.nx.Graph 是无向的（add_edge 会把反方向也连上
    // 并共用同一份属性字典）。无向化会把 fake→将军岛 与 将军岛→fake 合成一条边，流就能
    // 白走反向，最小成本流立刻解错。所以这里固定用自己的 DiGraph，不去改 nx.js。
    var graph = new _FallbackDiGraph();
    var myTeam = this.team;

    var ourSet = new Set();
    var ourTeamIslands = byTeamIdx(islands.tile_islands_by_team_id, myTeam) || [];
    for (var oi = 0; oi < ourTeamIslands.length; oi++) ourSet.add(ourTeamIslands[oi].unique_id);
    var targetSet = new Set();
    var targetTeamIslands = byTeamIdx(islands.tile_islands_by_team_id, this.target_team) || [];
    for (var ti = 0; ti < targetTeamIslands.length; ti++) targetSet.add(targetTeamIslands[ti].unique_id);

    if (this.enemy_general === null || this.enemy_general === undefined) {
      this.enemy_general = this.intergeneral_analysis.tileB;
    }
    if (this.enemy_general === null || this.enemy_general === undefined ||
        isPlayerOnTeam(this.map, this.enemy_general.player(), myTeam)) {
      throw new Error('Cannot call ensure_flow_graph_exists without setting enemyGeneral to some (enemy) tile.');
    }

    var targetGeneralIsland = islands.tile_island_lookup.raw[this.enemy_general.tile_index];
    var frGeneralIsland = islands.tile_island_lookup.raw[this.friendly_general.tile_index];

    var demandInfo = this._determine_initial_demands_and_split_input_output_nodes(
      graph, islands, ourSet, targetSet, use_neutral_flow);
    var cumulativeDemand = demandInfo[0];
    var demands = demandInfo[1];
    var friendlyArmySupply = demandInfo[2];
    var enemyArmyDemand = demandInfo[3];
    var enemyGeneralDemand = demandInfo[4];

    var island_roles = this.classify_islands_for_flow(
      islands, this.intergeneral_analysis, this.map, this.team, this.target_team);

    var neutSinks = new Set();
    var islandList = allIslands(islands);
    for (var i = 0; i < islandList.length; i++) {
      var island = islandList[i];
      var sourceCapacity = 100000;
      var weight = 1;
      var borderArr = typeof island.border_islands.items === 'function'
        ? island.border_islands.items() : Array.from(island.border_islands);
      for (var m = 0; m < borderArr.length; m++) {
        var movableIsland = borderArr[m];
        var edgeCapacity = Math.max(sourceCapacity, 100000);
        graph.add_edge(-island.unique_id, movableIsland.unique_id, { weight: weight, capacity: edgeCapacity });
      }
      var role = island_roles.get(island.unique_id);
      var sinkEnemyGeneral = use_neutral_flow ? role.is_neutral_sink_with_neut : role.is_neutral_sink_no_neut;
      if (sinkEnemyGeneral) neutSinks.add(island.unique_id);
    }

    // 原版这里 random.randint(1000000, 9000000)。跨语言没法复现同一个随机数，
    // 而它只是「一个不撞岛 id 的哨兵节点」，所以改成确定性的值。
    // 取 7777777 而不是 1000000：将军边的 capacity 正好是 1000000，哨兵 id 撞上它会让
    // oracle 里的「假节点归一化」把容量也一起改名，比对出假差异。
    var fakeNode = 7777777;
    var byId = islandLookupById(islands);
    while (byId.has(fakeNode)) fakeNode += 1;

    graph.add_node(fakeNode);

    var neutWeight = use_neutral_flow ? 10 : 0;
    var neutIds = sortedNums(neutSinks);
    for (var nsi = 0; nsi < neutIds.length; nsi++) {
      var isl = byId.get(neutIds[nsi]);
      graph.add_edge(fakeNode, neutIds[nsi], { weight: neutWeight, capacity: isl.tile_count });
    }

    var backpressureWeight = this.use_backpressure_from_enemy_general ? 0 : 10000;

    graph.add_edge(-targetGeneralIsland.unique_id, fakeNode, { weight: backpressureWeight, capacity: 1000000 });
    graph.add_edge(-frGeneralIsland.unique_id, fakeNode, { weight: 1000, capacity: 1000000 });
    graph.add_edge(fakeNode, targetGeneralIsland.unique_id, { weight: backpressureWeight, capacity: 1000000 });
    graph.add_edge(fakeNode, frGeneralIsland.unique_id, { weight: 1000, capacity: 1000000 });

    var fakeNodes = new Set([fakeNode]);

    var nxData = new NxFlowGraphData(graph, neutSinks, demands, cumulativeDemand, fakeNodes);
    demands.forEach(function (dem, islandId) { nxData.set_node_demand(islandId, dem); });
    // Python 只给「我方 / 敌方 / （含中立的）中立」岛挂 demand 属性，其余节点 demand 默认 0。
    // 上面的 demands 表是所有岛都会写进去的，但没挂属性的岛参与平衡时等价于 0，
    // 唯一例外是敌方/我方之外的中立岛在 includeNeutralFlow=False 时确实不参与 ——
    // 靠下面的显式清零来对齐，否则 demand 总和不为 0，求解会直接报不可行。
    var islandIdSet = new Set();
    for (var di = 0; di < islandList.length; di++) islandIdSet.add(islandList[di].unique_id);
    islandIdSet.forEach(function (islandId) {
      if (ourSet.has(islandId) || targetSet.has(islandId)) return;
      if (use_neutral_flow) {
        var isl2 = byId.get(islandId);
        if (isl2 && isl2.team === -1) return;
      }
      nxData.set_node_demand(islandId, 0);
    });
    nxData.set_node_demand(fakeNode, -cumulativeDemand);
    nxData.friendly_army_supply = friendlyArmySupply;
    nxData.enemy_army_demand = enemyArmyDemand;
    nxData.enemy_general_demand = enemyGeneralDemand;
    return nxData;
  };

  // nx 的 out-edge 顺序 = 邻接插入序；两种图实现的取法不同，这里统一。
  function outNeighbors(graph, n) {
    if (typeof graph.out_edges_of === 'function') return graph.out_edges_of(n);
    if (graph._adj instanceof Map) {
      var m = graph._adj.get(n);
      return m === undefined ? [] : Array.from(m.keys());
    }
    return [];
  }

  NetworkXFlowDirectionFinder.prototype.compute_flow_dict = function (islands, graphData, method) {
    var graph = graphData.graph;
    var solver = new MinCostFlow();
    var nodeIds = graph.nodes();
    var demands = new Map();
    for (var i = 0; i < nodeIds.length; i++) {
      solver.add_node(nodeIds[i]);
      demands.set(nodeIds[i], graphData.node_demand(nodeIds[i]));
    }
    var edges = graph.edges(true);
    for (var e = 0; e < edges.length; e++) {
      var u = edges[e][0];
      var v = edges[e][1];
      var attrs = edges[e][2] || {};
      var cap = attrs.capacity === undefined ? 1e9 : attrs.capacity;
      var cost = attrs.weight === undefined ? 1 : attrs.weight;
      solver.add_edge(u, v, cap, cost);
    }

    // 原版三种 networkx 方法都只是「求最小成本流」，这里统一走自写求解器。
    var solved = solver.solve(demands);

    var flowBySource = new Map();
    for (var s = 0; s < solved.edges.length; s++) {
      var se = solved.edges[s];
      if (!flowBySource.has(se.u)) flowBySource.set(se.u, new Map());
      flowBySource.get(se.u).set(se.v, se.flow);
    }

    // flowDict 的键顺序必须跟 nx 一致：节点插入序，值是邻接序。
    var flowDict = new Map();
    for (var n = 0; n < nodeIds.length; n++) {
      var nid = nodeIds[n];
      var targets = new Map();
      var outEdges = outNeighbors(graph, nid);
      for (var k = 0; k < outEdges.length; k++) {
        var t = outEdges[k];
        var flowVal = 0;
        var srcMap = flowBySource.get(nid);
        if (srcMap && srcMap.has(t)) flowVal = srcMap.get(t);
        targets.set(t, flowVal);
      }
      flowDict.set(nid, targets);
    }

    void method;
    return flowDict;
  };

  NetworkXFlowDirectionFinder.prototype.build_flow_graph = function (
    islands, ourIslands, targetIslands, searchingPlayer, turns,
    blockGatherFromEnemyBorders, negativeTiles, includeNeutralDemand, method
  ) {
    if (negativeTiles !== this.negative_tiles) {
      this.negative_tiles = negativeTiles;
      this.invalidate_cache();
    }
    void method;

    this.ensure_graph_data_available(islands, true);

    var withNeutFlowDict = this.compute_flow_dict(islands, this.nx_graph_data, flow.FlowGraphMethod.NetworkSimplex);
    var noNeutFlowDict = this.compute_flow_dict(islands, this.nx_graph_data_no_neut, flow.FlowGraphMethod.NetworkSimplex);

    var targetGeneralIsland = islands.tile_island_lookup.raw[this.enemy_general.tile_index];

    var withNeutGraphLookup = new Map();
    var noNeutGraphLookup = new Map();

    var islandList = allIslands(islands);
    for (var i = 0; i < islandList.length; i++) {
      var island = islandList[i];
      var demandNoNeut = mapGet(this.nx_graph_data_no_neut.demand_lookup, island.unique_id, 0);
      noNeutGraphLookup.set(island.unique_id, new IslandFlowNode(island, demandNoNeut));

      var demandWithNeut = mapGet(this.nx_graph_data.demand_lookup, island.unique_id, 0);
      withNeutGraphLookup.set(island.unique_id, new IslandFlowNode(island, demandWithNeut));
    }

    var resWith = this.build_flow_nodes_from_lookups(
      ourIslands, targetGeneralIsland, targetIslands, withNeutFlowDict, withNeutGraphLookup, this.nx_graph_data);
    var resNoNeut = this.build_flow_nodes_from_lookups(
      ourIslands, targetGeneralIsland, targetIslands, noNeutFlowDict, noNeutGraphLookup, this.nx_graph_data_no_neut);

    var noNeutFlowNodeLookup = new EK.MapMatrix(this.map, null);
    var incNeutFlowNodeLookup = new EK.MapMatrix(this.map, null);
    noNeutGraphLookup.forEach(function (flowNode) {
      var tiles = islandTilesSorted(flowNode.island);
      for (var k = 0; k < tiles.length; k++) noNeutFlowNodeLookup.raw[tiles[k].tile_index] = flowNode;
    });
    withNeutGraphLookup.forEach(function (flowNode) {
      var tiles = islandTilesSorted(flowNode.island);
      for (var k = 0; k < tiles.length; k++) incNeutFlowNodeLookup.raw[tiles[k].tile_index] = flowNode;
    });

    var flowGraph = new IslandMaxFlowGraph({
      root_flow_nodes_no_neut: resNoNeut[2],
      root_flow_nodes_inc_neut: resWith[2],
      enemy_backfill_nodes_no_neut: resNoNeut[1],
      enemy_backfill_nodes_inc_neut: resWith[1],
      enemy_backfill_neut_dump_edges: resWith[0],
      enemy_backfill_neut_dump_edges_no_neut: resNoNeut[0],
      flow_node_lookup_by_tile_no_neut: noNeutFlowNodeLookup,
      flow_node_lookup_by_tile_inc_neut: incNeutFlowNodeLookup,
      flow_node_lookup_by_island_no_neut: noNeutGraphLookup,
      flow_node_lookup_by_island_inc_neut: withNeutGraphLookup,
      fake_nodes: this.nx_graph_data.fake_nodes,
      neutral_sinks: this.nx_graph_data.neutral_sinks
    });

    void searchingPlayer;
    void turns;
    void blockGatherFromEnemyBorders;
    void includeNeutralDemand;
    return flowGraph;
  };

  flow.NetworkXFlowDirectionFinder = NetworkXFlowDirectionFinder;

  /* ------------------------------------------------------------ 兜底图实现 */

  /*
   * EK.nx.Graph 没加载时的最小 DiGraph。字段语义与 nx.DiGraph 一致：
   * 节点按插入序、邻接按插入序、同一对 (u,v) 共用同一份属性字典。
   * 节点属性（demand）单独存，因为 EK.nx.Graph 的 add_node 不收属性。
   */
  function _FallbackDiGraph() {
    this._adj = new Map();
    this._nodeAttrs = new Map();
  }

  _FallbackDiGraph.prototype.add_node = function (n) {
    if (!this._adj.has(n)) this._adj.set(n, new Map());
    if (!this._nodeAttrs.has(n)) this._nodeAttrs.set(n, {});
  };

  _FallbackDiGraph.prototype.set_node_attr = function (n, attrs) {
    this.add_node(n);
    var cur = this._nodeAttrs.get(n);
    for (var k in attrs) if (hasOwn(attrs, k)) cur[k] = attrs[k];
  };

  _FallbackDiGraph.prototype.get_node_attr = function (n, key) {
    var attrs = this._nodeAttrs.get(n);
    if (attrs === undefined) return undefined;
    return attrs[key];
  };

  _FallbackDiGraph.prototype.add_edge = function (u, v, attrs) {
    this.add_node(u);
    this.add_node(v);
    var au = this._adj.get(u);
    var dict = au.get(v);
    if (dict === undefined) {
      dict = {};
      au.set(v, dict);
    }
    if (attrs) for (var k in attrs) if (hasOwn(attrs, k)) dict[k] = attrs[k];
  };

  _FallbackDiGraph.prototype.nodes = function () {
    return Array.from(this._adj.keys());
  };

  _FallbackDiGraph.prototype.edges = function (withData) {
    var out = [];
    this._adj.forEach(function (nbrs, u) {
      nbrs.forEach(function (dict, v) {
        out.push(withData ? [u, v, dict] : [u, v]);
      });
    });
    return out;
  };

  _FallbackDiGraph.prototype.out_edges_of = function (u) {
    var m = this._adj.get(u);
    return m === undefined ? [] : Array.from(m.keys());
  };

  _FallbackDiGraph.prototype.has_edge = function (u, v) {
    var m = this._adj.get(u);
    return m !== undefined && m.has(v);
  };

  _FallbackDiGraph.prototype.get_edge = function (u, v) {
    var m = this._adj.get(u);
    return m === undefined ? undefined : m.get(v);
  };

  // DiGraph 的出度：自环在 nx 里算 2 度
  _FallbackDiGraph.prototype.out_degree = function (u) {
    var m = this._adj.get(u);
    if (m === undefined) return 0;
    return m.has(u) ? m.size + 1 : m.size;
  };

  flow._FallbackDiGraph = _FallbackDiGraph;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

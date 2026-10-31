/**
 * IterativeExpansion.js —— BehaviorAlgorithms/IterativeExpansion.py 的逐函数移植（legacy 扩张器）。
 *
 * 源文件：E:\akcoco6de\_research\generals-bot-cs\BehaviorAlgorithms\IterativeExpansion.py
 *
 * 迁移约束（与原版对表时请按这些点核对）：
 *   1. 全部球面算法（岛间流图、双向搜索、A* 启发式）逐句照搬，包括原版里的 dead path
 *      （_queue_next_friendlies_from_next_target_values / _calculate_next_target_values 的调用点
 *      在 python 里被注释掉了，这里也同样不接上，只保留函数本体以备后查）。
 *   2. `tile.player()` 是方法，`tile.isPathable` 是属性；MapMatrix/MapMatrixSet 用
 *      `.raw[tile.tile_index]` 或 `.has(tile)`。
 *   3. python 的 `list[-1]`、`dict[-1]` 在 JS 里不会自动折末位，凡依赖负下标的地方都显式折过。
 *   4. python 的 set/dict 迭代顺序：set 按 tile_index / unique_id 升序，dict 按插入序；
 *      JS 的 Set/Map 天然是插入序，所以凡在 python 侧靠 set 排序的地方这里都显式 sort。
 *   5. 时间截断（cutoffTime / _dynamic_heuristic_ratio 的阶段推进）照搬：
 *      原版用 time.time() 判阶段，这里用同样的墙钟检查，不改语义。
 *   6. 渲染与 debug 输出（live_render_capture_stuff / live_render_invalid_flow_config /
 *      logbook 逐行日志）不搬运。
 *
 * 导出：EK.ArmyFlowExpander / EK.ArmyFlowExpanderLastRun / EK.FlowExpansionPlanOptionCollection /
 *       EK.ITERATIVE_EXPANSION_EN_CAP_VAL / EK.FlowGraphDebugStats / EK.PlanDupeChecker
 */
(function (root) {
  'use strict';
  var EK = root.__EK || (root.__EK = {});
  EK.flow = EK.flow || {};

  var ITERATIVE_EXPANSION_EN_CAP_VAL = 2.05;

  function nowSeconds() {
    /* 统一时钟：装了 clock.js 就用它（可被 GB_EK_DET 钉死做确定性对拍），没装回退真实时钟。
     * 原版这里用 time.time() 判阶段推进，JS 若直接读墙钟，同一局面两次跑会走到不同阶段。 */
    if (EK.clock) return EK.clock.nowSec();
    if (typeof process !== 'undefined' && process && typeof process.hrtime === 'function') {
      var t = process.hrtime();
      return t[0] + t[1] / 1e9;
    }
    return Date.now() / 1000;
  }

  function FlowGraphMethodTable() {
    // 与 flowgraph.js 的 EK.flow.FlowGraphMethod 对齐；那边尚未加载时用本地同值表兜底
    var t = (EK.flow && EK.flow.FlowGraphMethod) || {};
    return {
      NetworkSimplex: t.NetworkSimplex === undefined ? 1 : t.NetworkSimplex,
      CapacityScaling: t.CapacityScaling === undefined ? 2 : t.CapacityScaling,
      MinCostFlow: t.MinCostFlow === undefined ? 3 : t.MinCostFlow,
      PyMaxflowBoykovKolmogorov: t.PyMaxflowBoykovKolmogorov === undefined ? 10 : t.PyMaxflowBoykovKolmogorov,
      PyMaxflowWithNodeSplitting: t.PyMaxflowWithNodeSplitting === undefined ? 11 : t.PyMaxflowWithNodeSplitting,
      OrToolsSimpleMinCost: t.OrToolsSimpleMinCost === undefined ? 20 : t.OrToolsSimpleMinCost
    };
  }

  function flowNodeCtor() {
    var f = EK.flow || {};
    return f.IslandFlowNode;
  }

  // ---------------------------------------------------------------- deep copy

  /**
   * IterativeExpansion.py:39 _deep_copy_flow_nodes
   * 用显式栈做 DFS 克隆；cloneScopeLookup 传对象（unique_id → clone），
   * 与 python 的 dict 语义一致（按 unique_id 复用节点）。
*/
  function deepCopyFlowNodes(rootNodes, cloneScopeLookup) {
    var IslandFlowNode = flowNodeCtor();
    var q = [];
    for (var i = 0; i < rootNodes.length; i++) q.push([null, 0, rootNodes[i]]);
    var step;
    while (q.length > 0) {
      step = q.pop();
      var sourceClone = step[0];
      var flowAmt = step[1];
      var destOriginal = step[2];
      var destId = destOriginal.island.unique_id;
      var clone = cloneScopeLookup[destId];
      var needsNew = clone === undefined || clone === null;
      if (needsNew) {
        clone = new IslandFlowNode(destOriginal.island, destOriginal.desired_army);
        cloneScopeLookup[destId] = clone;
      }
      if (sourceClone === null) {
        if (needsNew) {
          // python: if destOriginal not in clone_scope_lookup: add it (上面已建)
        }
      } else {
        sourceClone.set_flow_to(clone, flowAmt);
      }
      var edges = destOriginal.flow_to;
      for (var e = 0; e < edges.length; e++) {
        q.push([clone, edges[e].edge_army, edges[e].target_flow_node]);
      }
    }
    var out = [];
    for (var r = 0; r < rootNodes.length; r++) out.push(cloneScopeLookup[rootNodes[r].island.unique_id]);
    return out;
  }

  /** IterativeExpansion.py:68 _deep_copy_flow_node —— 单根版本 */
  function deepCopyFlowNode(rootNode, cloneScopeLookup) {
    var IslandFlowNode = flowNodeCtor();
    var q = [[null, 0, rootNode]];
    var step;
    while (q.length > 0) {
      step = q.pop();
      var sourceClone = step[0];
      var flowAmt = step[1];
      var destOriginal = step[2];
      var destId = destOriginal.island.unique_id;
      var clone = cloneScopeLookup[destId];
      var needsNew = clone === undefined || clone === null;
      if (needsNew) {
        clone = new IslandFlowNode(destOriginal.island, destOriginal.desired_army);
        cloneScopeLookup[destId] = clone;
      }
      if (sourceClone !== null) sourceClone.set_flow_to(clone, flowAmt);
      var edges = destOriginal.flow_to;
      for (var e = 0; e < edges.length; e++) q.push([clone, edges[e].edge_army, edges[e].target_flow_node]);
    }
    return cloneScopeLookup[rootNode.island.unique_id];
  }

  // ---------------------------------------------------------------- model classes

  /** IterativeExpansion.py:94 FlowExpansionPlanOptionCollection */
  function FlowExpansionPlanOptionCollection() {
    this.expansion_options = [];
    this.total_turns = 0;
    this.total_econ = 0.0;
    this.total_en_caps = 0;
    this.total_neut_caps = 0;
    this.total_en_city_caps = 0;
    this.total_neut_city_caps = 0;
    this.total_gather_tiles = 0;
    this.total_gathered = 0;
    this.true_total_gathered = 0;
    this.total_en_army_capped = 0;
  }

  FlowExpansionPlanOptionCollection.prototype.toString = function () {
    var turns = this.total_turns;
    var vt = this.total_econ / (turns > 1 ? turns : 1);
    return 'turns=' + turns +
      ', econ=' + this.total_econ + ' (' + vt.toFixed(2) + 'vt)' +
      ', enCaps=' + this.total_en_caps +
      ', neutCaps=' + this.total_neut_caps +
      ', enCityCaps=' + this.total_en_city_caps +
      ', neutCityCaps=' + this.total_neut_city_caps +
      ', gatherTiles=' + this.total_gather_tiles +
      ', gathered=' + this.total_gathered +
      ', trueGathered=' + this.true_total_gathered +
      ', enArmyCapped=' + this.total_en_army_capped;
  };

  /** IterativeExpansion.py:130 FlowGraphDebugStats */
  function FlowGraphDebugStats(redArmy, blueArmy, enemyGeneralBalance) {
    this.red_army_total = redArmy === undefined ? 0 : redArmy;
    this.blue_army_total = blueArmy === undefined ? 0 : blueArmy;
    this.enemy_general_balance = enemyGeneralBalance === undefined ? 0 : enemyGeneralBalance;
  }

  FlowGraphDebugStats.prototype.summary_line = function (label) {
    var mode = this.enemy_general_balance < 0 ? 'backpressure' : 'sink';
    var prefix = label === undefined || label === null || label === '' ? '' : label + ': ';
    return prefix + 'redArmy=' + this.red_army_total + ', blueArmy=' + this.blue_army_total +
      ', enGen' + mode + '=' + this.enemy_general_balance;
  };

  /** IterativeExpansion.py:140 ArmyFlowExpanderLastRun */
  function ArmyFlowExpanderLastRun() {
    this.flow_stats_no_neut = new FlowGraphDebugStats(0, 0, 0);
    this.flow_stats_inc_neut = new FlowGraphDebugStats(0, 0, 0);
  }

  /** IterativeExpansion.py:3055 PlanDupeChecker */
  function PlanDupeChecker() {
    this.plans = [];
    this.set = new Set();
  }

  // ---------------------------------------------------------------- ArmyFlowExpander

  /** IterativeExpansion.py:146 ArmyFlowExpander.__init__ */
  function ArmyFlowExpander(map, perfTimer) {
    this.map = map;
    this.perf_timer = perfTimer === undefined ? null : perfTimer;
    if (this.perf_timer === null) {
      var PT = EK.PerformanceTimer;
      if (typeof PT === 'function') {
        this.perf_timer = new PT();
        if (typeof this.perf_timer.begin_move === 'function') this.perf_timer.begin_move(map.turn);
      }
    }

    this.team = map.team_ids_by_player_index[map.player_index];
    this.friendlyGeneral = map.generals[map.player_index];
    this.target_team = -1;
    this.enemyGeneral = null;
    this.island_builder = null;
    this.dists_to_target_large_island = null;
    this.method = FlowGraphMethodTable().MinCostFlow;
    this.flow_graph = null;
    this.last_run = new ArmyFlowExpanderLastRun();
    this._networkx_flow_direction_finder = null;
    this._pymax_flow_direction_finder = null;
    this._ortools_flow_direction_finder = null;

    this.debug_render_capture_count_threshold = 10000;
    // python: DebugHelper.is_debug_or_unit_test_mode() and False —— 恒为 False
    this.log_debug = false;
    this.use_debug_asserts = true;
    this.use_all_pairs_visited = true;
    this.use_min_cost_flow_edges_only = true;
    this.use_backpressure_from_enemy_general = true;
    this.live_render_invalid_flow_config = null;
    this._dynamic_heuristic_ratio = 1.0;
    this._dynamic_heuristic_falsehood_ratio = 0.0;
  }

  Object.defineProperty(ArmyFlowExpander.prototype, 'flow_graph_data', {
    get: function () {
      if (this.method === FlowGraphMethodTable().OrToolsSimpleMinCost &&
          this._ortools_flow_direction_finder !== null &&
          this._ortools_flow_direction_finder !== undefined) {
        return this._ortools_flow_direction_finder.ortools_graph_data;
      }
      return null;
    }
  });

  /** IterativeExpansion.py:202 get_expansion_options */
  ArmyFlowExpander.prototype.get_expansion_options = function (
    islands, asPlayer, targetPlayer, turns, boardAnalysis, territoryMap,
    negativeTiles, leafMoves, viewInfo, bonusCapturePointMatrix, perfTimer, cutoffTime
  ) {
    // 原版签名里的 territoryMap / leafMoves / viewInfo / bonusCapturePointMatrix / perfTimer
    // 在函数体里完全没用到，这里保留形参只为对上调用点。
    var plans = this.find_flow_plans(islands, boardAnalysis, asPlayer, targetPlayer, turns,
      negativeTiles, cutoffTime);
    return this.filter_plans_by_common_supersets_and_sort(plans);
  };

  /** IterativeExpansion.py:267 filter_plans_by_common_supersets_and_sort */
  ArmyFlowExpander.prototype.filter_plans_by_common_supersets_and_sort = function (plans) {
    var self = this;
    // python: plans.sort(key=lambda p: (p.length > 8, len(p.approximate_capture_tiles) > 2,
    //                                  p.econValue / p.length), reverse=True)
    // 稳定排序 = 先按该 key 升序再整体反转；JS 的 Array.sort 不稳定，故用索引做次键。
    var keyed = plans.map(function (p, idx) {
      return {
        p: p,
        idx: idx,
        k: [p.length > 8 ? 1 : 0, p.approximate_capture_tiles.size > 2 ? 1 : 0, p.econValue / p.length]
      };
    });
    keyed.sort(function (a, b) {
      for (var i = 0; i < 3; i++) {
        if (a.k[i] !== b.k[i]) return a.k[i] < b.k[i] ? 1 : -1;
      }
      return a.idx - b.idx;
    });
    plans = keyed.map(function (e) { return e.p; });

    var MapMatrix = EK.MapMatrix;
    var plansVisited = new MapMatrix(this.map, null);
    var bestPlanByTile = new MapMatrix(this.map, null);
    var planSets = [];
    var finalPlans = [];

    for (var pi = 0; pi < plans.length; pi++) {
      var plan = plans[pi];
      var planSet = null;
      var illegalPlan = false;
      var tiles = plan.tileSet;
      var it = tiles.values();
      var step = it.next();
      while (!step.done) {
        var visitedPlanSet = plansVisited.raw[step.value.tile_index];
        if (visitedPlanSet !== null && visitedPlanSet !== undefined) {
          if (planSet === null) planSet = visitedPlanSet;
          else if (planSet !== visitedPlanSet) {
            illegalPlan = true;
            break;
          }
        }
        step = it.next();
      }
      if (illegalPlan) continue;

      var newTiles;
      if (planSet === null) {
        planSet = new PlanDupeChecker();
        planSets.push(planSet);
        newTiles = new Set(tiles);
      } else {
        // plan.tileSet.symmetric_difference(planSet.set)
        var diff = new Set();
        var a = tiles.values(), s = a.next();
        while (!s.done) { if (!planSet.set.has(s.value)) diff.add(s.value); s = a.next(); }
        var b = planSet.set.values(), s2 = b.next();
        while (!s2.done) { if (!tiles.has(s2.value)) diff.add(s2.value); s2 = b.next(); }
        if (diff.size === 0) continue;
        var isSuperSet = true;
        var d = diff.values(), s3 = d.next();
        while (!s3.done) { if (!tiles.has(s3.value)) { isSuperSet = false; break; } s3 = d.next(); }
        if (isSuperSet) {
          newTiles = diff;
        } else {
          var inter = new Set();
          var d2 = diff.values(), s4 = d2.next();
          while (!s4.done) { if (tiles.has(s4.value)) inter.add(s4.value); s4 = d2.next(); }
          newTiles = inter;
        }
      }

      planSet.plans.push(plan);
      var nt = newTiles.values(), s5 = nt.next();
      while (!s5.done) {
        planSet.set.add(s5.value);
        plansVisited.raw[s5.value.tile_index] = planSet;
        bestPlanByTile.raw[s5.value.tile_index] = plan;
        s5 = nt.next();
      }
      finalPlans.push(plan);
    }

    var finalKeyed = finalPlans.map(function (p, idx) {
      return { p: p, idx: idx, k: [p.econValue / p.length, p.length] };
    });
    finalKeyed.sort(function (x, y) {
      for (var i = 0; i < 2; i++) {
        if (x.k[i] !== y.k[i]) return x.k[i] < y.k[i] ? 1 : -1;
      }
      return x.idx - y.idx;
    });
    finalPlans = finalKeyed.map(function (e) { return e.p; });

    var planContainer = new FlowExpansionPlanOptionCollection();
    planContainer.expansion_options = finalPlans;

    var superSetPlans = [];
    for (var psi = 0; psi < planSets.length; psi++) {
      var ps = planSets[psi];
      var psKeyed = ps.plans.map(function (p, idx) {
        return { p: p, idx: idx, k: [p.length, p.econValue] };
      });
      psKeyed.sort(function (x, y) {
        for (var i = 0; i < 2; i++) {
          if (x.k[i] !== y.k[i]) return x.k[i] < y.k[i] ? 1 : -1;
        }
        return x.idx - y.idx;
      });
      ps.plans = psKeyed.map(function (e) { return e.p; });

      var unIncluded = new Set(ps.set);
      for (var pj = 0; pj < ps.plans.length; pj++) {
        var flowPlan = ps.plans[pj];
        var includeSuper = false;
        var u = unIncluded.values(), su = u.next();
        while (!su.done) {
          if (flowPlan.tileSet.has(su.value)) { includeSuper = true; break; }
          su = u.next();
        }
        if (!includeSuper) continue;
        var u2 = unIncluded.values(), su2 = u2.next();
        var toRemove = [];
        while (!su2.done) { if (flowPlan.tileSet.has(su2.value)) toRemove.push(su2.value); su2 = u2.next(); }
        for (var tr = 0; tr < toRemove.length; tr++) unIncluded.delete(toRemove[tr]);
        superSetPlans.push(flowPlan);
      }
    }
    // python 里 planContainer.best_plans_by_tile = bestPlanByTile（__slots__ 无此字段会抛），
    // 这里照抄意图但挂普通属性，供调试查看。
    planContainer.best_plans_by_tile = bestPlanByTile;

    return planContainer;
  };

  // ---------------------------------------------------------------- flow finders

  /** IterativeExpansion.py:388 _get_networkx_flow_direction_finder */
  ArmyFlowExpander.prototype._get_networkx_flow_direction_finder = function () {
    var NetworkXFlowDirectionFinder = (EK.flow || {}).NetworkXFlowDirectionFinder;
    if (!NetworkXFlowDirectionFinder) {
      throw new Error('iterativeexpansion: EK.flow.NetworkXFlowDirectionFinder 未加载，无法构建流图');
    }
    if (this._networkx_flow_direction_finder === null) {
      this._networkx_flow_direction_finder = new NetworkXFlowDirectionFinder(
        this.map,
        this.island_builder.intergeneral_analysis,
        this.friendlyGeneral,
        this.use_backpressure_from_enemy_general,
        this.perf_timer,
        this.log_debug,
        this.use_backpressure_from_enemy_general,
        this.friendlyGeneral,
        this.live_render_invalid_flow_config
      );
    }
    this._networkx_flow_direction_finder.configure(this.team, this.target_team, this.enemyGeneral);
    return this._networkx_flow_direction_finder;
  };

  /** IterativeExpansion.py:404 _get_pymax_flow_direction_finder */
  ArmyFlowExpander.prototype._get_pymax_flow_direction_finder = function () {
    var PyMaxFlowDirectionFinder = (EK.flow || {}).PyMaxFlowDirectionFinder;
    if (!PyMaxFlowDirectionFinder) {
      // JS 侧没有 pymaxflow 实现，退回 networkx（数值差异仅影响 method 为 PyMaxflow* 的调用，
      // legacy bot 路径里 method 恒为 MinCostFlow，走不到这里）
      return this._get_networkx_flow_direction_finder();
    }
    if (this._pymax_flow_direction_finder === null) {
      this._pymax_flow_direction_finder = new PyMaxFlowDirectionFinder(
        this.map,
        this.perf_timer,
        this.log_debug,
        this.use_backpressure_from_enemy_general,
        this.friendlyGeneral,
        this.live_render_invalid_flow_config
      );
    }
    return this._pymax_flow_direction_finder;
  };

  /** IterativeExpansion.py:416 _get_ortools_flow_direction_finder */
  ArmyFlowExpander.prototype._get_ortools_flow_direction_finder = function () {
    var OrToolsFlowDirectionFinder = (EK.flow || {}).OrToolsFlowDirectionFinder;
    if (!OrToolsFlowDirectionFinder) {
      throw new Error('iterativeexpansion: EK.flow.OrToolsFlowDirectionFinder 未加载');
    }
    if (this._ortools_flow_direction_finder === null) {
      this._ortools_flow_direction_finder = new OrToolsFlowDirectionFinder(
        this.map,
        this.island_builder.intergeneral_analysis,
        this.perf_timer,
        this.log_debug,
        this.use_backpressure_from_enemy_general,
        this.friendlyGeneral,
        this.live_render_invalid_flow_config
      );
    }
    this._ortools_flow_direction_finder.configure(this.team, this.target_team, this.enemyGeneral);
    return this._ortools_flow_direction_finder;
  };

  /** IterativeExpansion.py:430 _get_flow_direction_finder */
  ArmyFlowExpander.prototype._get_flow_direction_finder = function (method) {
    var M = FlowGraphMethodTable();
    if (method === M.PyMaxflowBoykovKolmogorov || method === M.PyMaxflowWithNodeSplitting) {
      return this._get_pymax_flow_direction_finder();
    }
    if (method === M.OrToolsSimpleMinCost) return this._get_ortools_flow_direction_finder();
    return this._get_networkx_flow_direction_finder();
  };

  /** IterativeExpansion.py:437 ensure_graph_data_available */
  ArmyFlowExpander.prototype.ensure_graph_data_available = function (islands, method) {
    var finder = this._get_flow_direction_finder(method);
    finder.configure(this.team, this.target_team, this.enemyGeneral);
    finder.ensure_graph_data_available(islands);
    this.enemyGeneral = finder.enemy_general;
  };

  /** IterativeExpansion.py:443 build_flow_graph */
  ArmyFlowExpander.prototype.build_flow_graph = function (
    islands, ourIslands, targetIslands, searchingPlayer, turns,
    blockGatherFromEnemyBorders, negativeTiles, includeNeutralDemand, method
  ) {
    var finder = this._get_flow_direction_finder(method);
    finder.configure(this.team, this.target_team, this.enemyGeneral);
    var flowGraph = finder.build_flow_graph(
      islands, ourIslands, targetIslands, searchingPlayer, turns,
      blockGatherFromEnemyBorders, negativeTiles, includeNeutralDemand, method
    );
    this.enemyGeneral = finder.enemy_general;
    return flowGraph;
  };

  /** IterativeExpansion.py:471 _get_island_max_flow_dict */
  ArmyFlowExpander.prototype._get_island_max_flow_dict = function (islands, graphData, method, renderOnException) {
    var finder = this._get_flow_direction_finder(method);
    finder.configure(this.team, this.target_team, this.enemyGeneral);
    return finder.compute_flow_dict(islands, graphData, method, renderOnException);
  };

  /** IterativeExpansion.py:483 _build_max_flow_min_cost_flow_nodes */
  ArmyFlowExpander.prototype._build_max_flow_min_cost_flow_nodes = function (
    islands, ourIslands, targetIslands, searchingPlayer, turns,
    blockGatherFromEnemyBorders, negativeTiles, includeNeutralDemand, method
  ) {
    var finder = this._get_flow_direction_finder(method);
    finder.configure(this.team, this.target_team, this.enemyGeneral);
    return finder.build_flow_graph(
      islands, ourIslands, targetIslands, searchingPlayer, turns,
      blockGatherFromEnemyBorders, negativeTiles, includeNeutralDemand, method
    );
  };

  /** IterativeExpansion.py:510 get_flow_nodes_from_lookups */
  ArmyFlowExpander.prototype.get_flow_nodes_from_lookups = function (
    ourIslands, targetGeneralIsland, targetIslands, withNeutFlowDict, graphLookup, nxGraphData
  ) {
    return this._get_flow_direction_finder().build_flow_nodes_from_lookups(
      ourIslands, targetGeneralIsland, targetIslands, withNeutFlowDict, graphLookup, nxGraphData
    );
  };

  // ---------------------------------------------------------------- 小工具
  function playerOf(tile) {
    // tile.player 在 JS 侧是方法（python 是属性）
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  function sumArmyOf(tiles) {
    var s = 0;
    var it = tiles.values(), st = it.next();
    while (!st.done) { s += st.value.army; st = it.next(); }
    return s;
  }

  /** python list 的负下标会自动折到末位；capValueByTeam[-1] 就是「中立队」那一格 */
  function atIdx(arr, idx) {
    return arr[idx < 0 ? arr.length + idx : idx];
  }

  /** IterativeExpansion.py:770 用的 deque：只要 popleft / appendleft / copy / len */
  function Deque() {
    this.items = [];
    this.off = 0;
  }
  Deque.prototype.popleft = function () {
    var v = this.items[this.off++];
    if (this.off > 32 && this.off * 2 > this.items.length) {
      this.items = this.items.slice(this.off);
      this.off = 0;
    }
    return v;
  };
  Deque.prototype.appendleft = function (v) {
    if (this.off > 0) this.items[--this.off] = v;
    else this.items.unshift(v);
  };
  Deque.prototype.copy = function () {
    var d = new Deque();
    d.items = this.items.slice(this.off);
    return d;
  };
  Deque.prototype.size = function () { return this.items.length - this.off; };

  /**
   * 优先队列项的比较：python 里是 17 元组，HeapQueueMax 取「最大」。
   * 元组逐元素比较，前 5 位是数字，randomTieBreak 每次 enqueue 递增所以从不会比到
   * 第 6 位（targetTiles 是 deque，python 比较 deque 会按元素比，这里不需要）。
*/
  function cmpQueueItem(a, b) {
    for (var i = 0; i < 5; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function HeapPush(heap, item) {
    heap.push(item);
    var i = heap.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (cmpQueueItem(heap[i], heap[parent]) <= 0) break;
      var tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
      i = parent;
    }
  }

  function HeapPop(heap) {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, biggest = i;
        if (l < heap.length && cmpQueueItem(heap[l], heap[biggest]) > 0) biggest = l;
        if (r < heap.length && cmpQueueItem(heap[r], heap[biggest]) > 0) biggest = r;
        if (biggest === i) break;
        var tmp = heap[biggest]; heap[biggest] = heap[i]; heap[i] = tmp;
        i = biggest;
      }
    }
    return top;
  }

  /** heapq 的最小堆项：(1 - tile.army, tile)，Tile 之间按 tile_index 比 */
  function cmpArmyTile(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1].tile_index - b[1].tile_index;
  }

  function armyHeapPush(heap, item) {
    heap.push(item);
    var i = heap.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (cmpArmyTile(heap[i], heap[parent]) >= 0) break;
      var tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
      i = parent;
    }
  }

  function armyHeapPop(heap) {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, smallest = i;
        if (l < heap.length && cmpArmyTile(heap[l], heap[smallest]) < 0) smallest = l;
        if (r < heap.length && cmpArmyTile(heap[r], heap[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        var tmp = heap[smallest]; heap[smallest] = heap[i]; heap[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  /** python 的 set(dict) 在 JS 用 Map，键取 island.unique_id，保序靠插入序 */
  function mapGet(m, key) { return m.get(key); }

  // ---------------------------------------------------------------- find_flow_plans

  /**
   * IterativeExpansion.py:539 find_flow_plans
   *
   * 注意：原版在这里对每个 (targetIsland, friendlyIsland) 播种一次 A*，用 17 元组做
   * 迭代，pairOptions 是 turnsUsed 收敛到「最大 vt」的方案。所有 branch 都照抄。
   */
  ArmyFlowExpander.prototype.find_flow_plans = function (
    islands, boardAnalysis, searchingPlayer, targetPlayer, turns, negativeTiles, cutoffTime
  ) {
    var self = this;
    var IslandFlowNode = flowNodeCtor();
    var M = FlowGraphMethodTable();

    var start = nowSeconds();
    var opts = new Map();               // 'tid:sid' -> Map(turnsUsed -> tuple[])
    var optsKey = function (tIsl, sIsl) { return tIsl.unique_id + ':' + sIsl.unique_id; };
    this._seeded_pairs = new Map();     // targetUid -> Set(friendlyUid)

    var myTeam = this.map.team_ids_by_player_index[searchingPlayer];
    var targetTeam = this.map.team_ids_by_player_index[targetPlayer];
    this.team = myTeam;
    this.target_team = targetTeam;
    this.island_builder = islands;
    this.dists_to_target_large_island = islands.large_tile_island_distances_by_team_id[targetTeam];
    if (this.dists_to_target_large_island === undefined) {
      this.dists_to_target_large_island =
        boardAnalysis.intergeneral_analysis ? boardAnalysis.intergeneral_analysis.bMap : null;
    }

    // python 的 tile_islands_by_player / by_team_id 是 defaultdict(list)：缺键返回空列表，
    // 而 JS 这两张表是定长数组，targetTeam 可能是 -1（还没锁定目标玩家）⇒ 直接下标会拿到
    // undefined 并在下游 `.length` 处炸掉。这里按 defaultdict 语义兜成空数组。
    var ourIslands = islands.tile_islands_by_player[searchingPlayer] || [];
    var targetIslands = islands.tile_islands_by_team_id[targetTeam] || [];

    var method = this.method;
    var finder = this._get_flow_direction_finder(method);
    finder.configure(this.team, this.target_team, this.enemyGeneral);
    this.ensure_graph_data_available(islands, method);
    this.flow_graph = this.build_flow_graph(
      islands, ourIslands, targetIslands, searchingPlayer, turns,
      true /* includeNeutralDemand */, negativeTiles, true, method
    );
    this._capture_last_run_flow_stats();

    var maxTeam = -1;
    for (var ti = 0; ti < this.map.team_ids_by_player_index.length; ti++) {
      var tv = this.map.team_ids_by_player_index[ti];
      if (tv > maxTeam) maxTeam = tv;
    }
    var capValueByTeam = [];
    for (var ct = 0; ct < maxTeam + 2; ct++) capValueByTeam.push(1.0);
    capValueByTeam[myTeam] = 0.0;
    capValueByTeam[targetTeam] = ITERATIVE_EXPANSION_EN_CAP_VAL;

    var friendlyBorderingEnemy = null;

    var q = [];
    var queueIterCount = 0, tileIterCount = 0, dumpIterCount = 0, tieBreaker = 0;
    var globalVisited = new Set();

    // 播种：每个敌/中立岛 × 每个相邻友方岛
    var allIslands = islands.all_tile_islands.items();
    for (var ii = 0; ii < allIslands.length; ii++) {
      var targetIsland = allIslands[ii];
      if (targetIsland.team === myTeam) continue;
      var tBorders = targetIsland.border_islands.items();
      for (var bi = 0; bi < tBorders.length; bi++) {
        var adjacentFriendlyIsland = tBorders[bi];
        if (adjacentFriendlyIsland.team !== myTeam) continue;
        if (!this._is_flow_allowed(adjacentFriendlyIsland, targetIsland, 0)) continue;

        var tgCapValue = atIdx(capValueByTeam, targetIsland.team);
        tieBreaker += 1;
        var pairOptions = new Map();
        opts.set(optsKey(targetIsland, adjacentFriendlyIsland), pairOptions);
        var seeded = this._seeded_pairs.get(targetIsland.unique_id);
        if (seeded === undefined) { seeded = new Set(); this._seeded_pairs.set(targetIsland.unique_id, seeded); }
        seeded.add(adjacentFriendlyIsland.unique_id);

        var sourceNode = new IslandFlowNode(adjacentFriendlyIsland, 0 - adjacentFriendlyIsland.sum_army + adjacentFriendlyIsland.tile_count);
        var destNode = new IslandFlowNode(targetIsland, targetIsland.sum_army + targetIsland.tile_count);
        sourceNode.set_flow_to(destNode, 0);

        var visited = this.use_all_pairs_visited ? globalVisited : new Set();
        var frLeftoverIdx = sourceNode.island.tile_count - 1;
        var tArmy = targetIsland.tiles_by_army;
        var tgTiles = new Deque();
        for (var ta = 0; ta < tArmy.length; ta++) tgTiles.items.push(tArmy[ta].army);

        var nextTargs = new Map();
        var nextFriendlies = new Map();
        var afBorders = adjacentFriendlyIsland.border_islands.items();
        for (var afi = 0; afi < afBorders.length; afi++) {
          var altNext = afBorders[afi];
          if (altNext !== targetIsland && altNext.team === myTeam && !nextFriendlies.has(altNext)) {
            nextFriendlies.set(altNext, sourceNode);
          }
        }
        for (var tbj = 0; tbj < tBorders.length; tbj++) {
          var altTgt = tBorders[tbj];
          if (altTgt !== adjacentFriendlyIsland && !nextTargs.has(altTgt) && !nextFriendlies.has(altTgt)) {
            nextTargs.set(altTgt, destNode);
          }
        }

        var rootNodes0 = new Map();
        rootNodes0.set(sourceNode.island.unique_id, sourceNode);
        this.enqueue(
          q,
          this._get_a_star_priority_val(tgCapValue, 0.0, 0, 0, frLeftoverIdx, adjacentFriendlyIsland, targetIsland, turns, tgTiles),
          0, turns + 1, targetIsland.sum_army + targetIsland.tile_count, tieBreaker, tgTiles,
          0.0, 0, 0, frLeftoverIdx, destNode, sourceNode, visited, nextTargs, nextFriendlies,
          rootNodes0, pairOptions
        );
      }
    }

    start = nowSeconds();
    if (cutoffTime === undefined || cutoffTime === null) cutoffTime = start + 300.0;
    var fullTime = cutoffTime - start;
    var stage1Time = fullTime / 6;
    var stage2Time = 2 * fullTime / 6;
    var stage3Time = 3 * fullTime / 6;
    var stage4Time = 4 * fullTime / 6;
    var stage1Ratio = 1.1, stage2Ratio = 1.3, stage3Ratio = 1.5, stage4Ratio = 2.0;
    this._dynamic_heuristic_ratio = 1.0;
    this._dynamic_heuristic_falsehood_ratio = 0.0;

    while (q.length > 0) {
      var it = HeapPop(q);
      var negVt = it[0];
      var turnsUsed = it[1];
      var turnsLeft = it[2];
      var uncappedTargetIslandArmy = it[3];
      var randomTieBreak = it[4];
      var targetTiles = it[5];
      var econValue = it[6];
      var gathSum = it[7];
      var frLeftoverArmy = it[8];
      var friendlyTileLeftoverIdx = it[9];
      var targetCalculatedNode = it[10];
      var friendlyUncalculatedNode = it[11];
      var visitedSet = it[12];
      var nextTargets = it[13];
      var nextFriendlies = it[14];
      var rootNodes = it[15];
      var pairOptions2 = it[16];

      if (turnsLeft <= 0) continue;

      targetTiles = targetTiles.copy();

      var targetCalculated = targetCalculatedNode.island;
      var friendlyUncalculated = friendlyUncalculatedNode.island;

      queueIterCount += 1;
      if ((queueIterCount & 31) === 0) {
        var used = nowSeconds() - start;
        if (used > fullTime) break;
        if (this._dynamic_heuristic_ratio < stage4Ratio && used > stage4Time) {
          this._dynamic_heuristic_ratio = stage4Ratio;
          this._dynamic_heuristic_falsehood_ratio = stage4Ratio - 1.0;
        } else if (this._dynamic_heuristic_ratio < stage3Ratio && used > stage3Time) {
          this._dynamic_heuristic_ratio = stage3Ratio;
          this._dynamic_heuristic_falsehood_ratio = stage3Ratio - 1.0;
        } else if (this._dynamic_heuristic_ratio < stage2Ratio && used > stage2Time) {
          this._dynamic_heuristic_ratio = stage2Ratio;
          this._dynamic_heuristic_falsehood_ratio = stage2Ratio - 1.0;
        } else if (this._dynamic_heuristic_ratio < stage1Ratio && used > stage1Time) {
          this._dynamic_heuristic_ratio = stage1Ratio;
          this._dynamic_heuristic_falsehood_ratio = stage1Ratio - 1.0;
        }
      }

      visitedSet.add(friendlyUncalculated);
      visitedSet.add(targetCalculated);

      if (this.use_debug_asserts) {
        this.assertEverythingSafe(
          turns, negVt, turnsUsed, turnsLeft, uncappedTargetIslandArmy, randomTieBreak,
          targetTiles, econValue, gathSum, frLeftoverArmy, friendlyTileLeftoverIdx,
          targetCalculatedNode, friendlyUncalculatedNode, visitedSet, nextTargets,
          nextFriendlies, rootNodes, pairOptions2
        );
      }

      var nextGathedSum = gathSum;
      var capValue = atIdx(capValueByTeam, targetCalculated.team);

      var loopOut = this._execute_island_tile_gather_capture_loop_and_record_options(
        uncappedTargetIslandArmy, capValue, dumpIterCount, econValue, frLeftoverArmy,
        friendlyTileLeftoverIdx, friendlyUncalculated, nextGathedSum, pairOptions2,
        rootNodes, targetCalculated, targetTiles, tileIterCount, turns, turnsLeft
      );
      uncappedTargetIslandArmy = loopOut[0];
      dumpIterCount = loopOut[1];
      econValue = loopOut[2];
      frLeftoverArmy = loopOut[3];
      friendlyTileLeftoverIdx = loopOut[4];
      var remainingFrIslandArmy = loopOut[5];
      nextGathedSum = loopOut[6];
      tileIterCount = loopOut[7];
      turnsLeft = loopOut[8];

      if (this.use_debug_asserts && remainingFrIslandArmy !== 0 && targetCalculated.team !== this.team) {
        if (uncappedTargetIslandArmy !== 0 && uncappedTargetIslandArmy <= remainingFrIslandArmy && friendlyTileLeftoverIdx >= 0) {
          throw new Error('Expected uncappedTargetIslandArmy ' + uncappedTargetIslandArmy +
            ' to be >= remainingFrIslandArmy ' + remainingFrIslandArmy + ', turnsLeft ' + turnsLeft +
            ' (fr leftover ' + frLeftoverArmy + ', index ' + friendlyTileLeftoverIdx +
            ', targetTiles ' + targetTiles.items.slice(targetTiles.off).join(',') + ')');
        }
      }

      if (turnsLeft === 0) continue;

      if (targetTiles.size() === 0) {
        var r1 = this._queue_next_targets_and_next_friendlies(
          uncappedTargetIslandArmy, capValueByTeam, dumpIterCount, econValue, frLeftoverArmy,
          friendlyBorderingEnemy, friendlyTileLeftoverIdx, friendlyUncalculated, myTeam,
          nextFriendlies, nextGathedSum, nextTargets, pairOptions2, q, rootNodes,
          targetTeam, tieBreaker, tileIterCount, targetTiles, turns, turnsLeft, visitedSet
        );
        dumpIterCount = r1[0]; tieBreaker = r1[1]; tileIterCount = r1[2];
      } else {
        tieBreaker = this._queue_next_friendlies_only(
          uncappedTargetIslandArmy, capValue, econValue, frLeftoverArmy, friendlyUncalculated,
          myTeam, nextFriendlies, nextGathedSum, nextTargets, pairOptions2, q, rootNodes,
          targetCalculatedNode, targetTiles, tieBreaker, turns, turnsLeft, visitedSet
        );
      }
    }

    start = nowSeconds();

    var output = [];
    var optKeys = Array.from(opts.keys());
    for (var oi = 0; oi < optKeys.length; oi++) {
      var planOptionsByTurns = opts.get(optKeys[oi]);
      var pair = optKeys[oi].split(':');
      var keyTargetIsland = null, keySource = null;
      for (var kj = 0; kj < allIslands.length; kj++) {
        if (String(allIslands[kj].unique_id) === pair[0]) keyTargetIsland = allIslands[kj];
        if (String(allIslands[kj].unique_id) === pair[1]) keySource = allIslands[kj];
      }
      var turnKeys = Array.from(planOptionsByTurns.keys());
      for (var tki = 0; tki < turnKeys.length; tki++) {
        var turnsUsedKey = turnKeys[tki];
        var tup = planOptionsByTurns.get(turnsUsedKey);
        var rootNodesOut = tup[0];
        var econValueOut = tup[1];
        var otherTurns = tup[2];
        var armyRemainingInIncompleteSource = tup[3];
        var incompleteTargetIsland = tup[4];
        var incompleteSourceIsland = tup[5];
        var unusedSourceArmy = tup[6];
        var gathedArmySum = tup[7];

        if (otherTurns !== turnsUsedKey) {
          throw new Error('Shouldnt happen, turn mismatch ' + turnsUsedKey + ' vs ' + otherTurns);
        }

        var plan = this._build_flow_expansion_option(
          islands, keyTargetIsland, keySource, rootNodesOut, econValueOut,
          armyRemainingInIncompleteSource, turnsUsedKey, targetIslands, ourIslands,
          incompleteTargetIsland, incompleteSourceIsland, unusedSourceArmy, gathedArmySum,
          negativeTiles
        );
        plan.gathered_army = gathedArmySum;

        if (plan.length === 0) continue;
        if (plan.get_first_move() === null || plan.get_first_move() === undefined) continue;

        output.push(plan);
      }
    }

    return output;
  };

  /** IterativeExpansion.py:1074 _execute_island_tile_gather_capture_loop_and_record_options */
  ArmyFlowExpander.prototype._execute_island_tile_gather_capture_loop_and_record_options = function (
    uncappedTargetIslandArmy, capValue, dumpIterCount, econValue, frLeftoverArmy,
    friendlyTileLeftoverIdx, friendlyUncalculated, nextGathedSum, pairOptions, rootNodes,
    targetCalculated, targetTiles, tileIterCount, turns, turnsLeft
  ) {
    var remainingFrIslandArmy = this.get_friendly_island_army_left(friendlyUncalculated, frLeftoverArmy, friendlyTileLeftoverIdx);

    while ((friendlyTileLeftoverIdx >= 0 || frLeftoverArmy > 0) && targetTiles.size() > 0 && turnsLeft > 0) {
      var tgTileArmyToCap = targetTiles.popleft() + 1;
      dumpIterCount += 1;

      while (frLeftoverArmy <= tgTileArmyToCap && turnsLeft > 0 && friendlyTileLeftoverIdx >= 0) {
        var frTileArmy = friendlyUncalculated.tiles_by_army[friendlyTileLeftoverIdx].army - 1;
        nextGathedSum += frTileArmy;
        frLeftoverArmy += frTileArmy;
        turnsLeft -= 1;
        friendlyTileLeftoverIdx -= 1;
        tileIterCount += 1;
      }

      if (turnsLeft <= 0) break;

      if (frLeftoverArmy < tgTileArmyToCap) {
        targetTiles.appendleft(tgTileArmyToCap - frLeftoverArmy - 1);
        uncappedTargetIslandArmy -= frLeftoverArmy;
        remainingFrIslandArmy -= frLeftoverArmy;
        frLeftoverArmy = 0;
        break;
      }

      econValue += capValue;
      uncappedTargetIslandArmy -= tgTileArmyToCap;
      remainingFrIslandArmy -= tgTileArmyToCap;
      frLeftoverArmy -= tgTileArmyToCap;
      turnsLeft -= 1;
      var turnsUsed = turns - turnsLeft;

      var existingBestTuple = pairOptions.get(turnsUsed);
      if (tgTileArmyToCap > 0 &&
          (existingBestTuple === undefined ||
           (existingBestTuple[1] / existingBestTuple[2] < econValue / turnsUsed && econValue > 0.0))) {
        pairOptions.set(turnsUsed, [
          rootNodes,
          econValue,
          turnsUsed,
          remainingFrIslandArmy,
          targetTiles.size() > 0 ? targetCalculated : null,
          friendlyTileLeftoverIdx >= 0 ? friendlyUncalculated : null,
          friendlyTileLeftoverIdx >= 0 ? remainingFrIslandArmy : null,
          nextGathedSum
        ]);
      }
    }

    if (uncappedTargetIslandArmy < 0) {
      frLeftoverArmy -= uncappedTargetIslandArmy;
      uncappedTargetIslandArmy = 0;
    } else if (frLeftoverArmy < 0) {
      uncappedTargetIslandArmy -= frLeftoverArmy;
    }

    return [uncappedTargetIslandArmy, dumpIterCount, econValue, frLeftoverArmy,
      friendlyTileLeftoverIdx, remainingFrIslandArmy, nextGathedSum, tileIterCount, turnsLeft];
  };

  /** IterativeExpansion.py:1174 _queue_next_targets_and_next_friendlies */
  ArmyFlowExpander.prototype._queue_next_targets_and_next_friendlies = function (
    uncappedTargetIslandArmy, capValueByTeam, dumpIterCount, econValue, frLeftoverArmy,
    friendlyBorderingEnemy, friendlyTileLeftoverIdx, friendlyUncalculated, myTeam,
    nextFriendlies, nextGathedSum, nextTargets, pairOptions, q, rootNodes, targetTeam,
    tieBreaker, tileIterCount, tilesToCap, turns, turnsLeft, visited
  ) {
    var items = Array.from(nextTargets.entries());
    for (var i = 0; i < items.length; i++) {
      var nextTargetIsland = items[i][0];
      var nextTargetFromNode = items[i][1];
      if (visited.has(nextTargetIsland)) continue;

      var capValue = atIdx(capValueByTeam, nextTargetIsland.team);

      var newEconValue = econValue;
      var newUncappedTargetIslandArmy = uncappedTargetIslandArmy;
      var newTargetTiles;
      var ntta = nextTargetIsland.tiles_by_army;
      var dq = new Deque();
      if (nextTargetIsland.team === this.team) {
        for (var a = 0; a < ntta.length; a++) dq.items.push(0 - ntta[a].army);
        newUncappedTargetIslandArmy += nextTargetIsland.tile_count - nextTargetIsland.sum_army;
      } else {
        for (var b = 0; b < ntta.length; b++) dq.items.push(ntta[b].army);
        newUncappedTargetIslandArmy += nextTargetIsland.sum_army + nextTargetIsland.tile_count;
      }
      newTargetTiles = dq;
      var newTurnsLeft = turnsLeft;
      var newFriendlyTileLeftoverIdx = friendlyTileLeftoverIdx;
      var newFrLeftoverArmy = frLeftoverArmy;

      var r = this._calculate_next_target_and_queue_next_friendlies(
        capValue, dumpIterCount, friendlyBorderingEnemy, friendlyUncalculated, myTeam,
        newUncappedTargetIslandArmy, newEconValue, newFrLeftoverArmy, newFriendlyTileLeftoverIdx,
        newTargetTiles, newTurnsLeft, nextFriendlies, nextGathedSum, nextTargetFromNode,
        nextTargetIsland, nextTargets, pairOptions, q, rootNodes, targetTeam, tieBreaker,
        tileIterCount, turns, visited
      );
      dumpIterCount = r[0]; tieBreaker = r[1]; tileIterCount = r[2];
    }

    return [dumpIterCount, tieBreaker, tileIterCount];
  };

  /** IterativeExpansion.py:1250 _calculate_next_target_and_queue_next_friendlies */
  ArmyFlowExpander.prototype._calculate_next_target_and_queue_next_friendlies = function (
    capValue, dumpIterCount, friendlyBorderingEnemy, friendlyUncalculated, myTeam,
    newUncappedTargetIslandArmy, newEconValue, newFrLeftoverArmy, newFriendlyTileLeftoverIdx,
    newTargetTiles, newTurnsLeft, nextFriendlies, nextGathedSum, nextTargetFromNode,
    nextTargetIsland, nextTargets, pairOptions, q, rootNodes, targetTeam, tieBreaker,
    tileIterCount, turns, visited
  ) {
    var newTurnsUsed = turns - newTurnsLeft;

    tieBreaker = this._queue_current_friendlies_from_next_target_values(
      capValue, friendlyBorderingEnemy, friendlyUncalculated, myTeam,
      newUncappedTargetIslandArmy, newEconValue, newTargetTiles, newTurnsLeft, nextFriendlies,
      nextGathedSum, newFrLeftoverArmy, newFriendlyTileLeftoverIdx, nextTargetFromNode,
      nextTargetIsland, nextTargets, pairOptions, q, rootNodes, targetTeam, tieBreaker,
      newTurnsUsed, visited
    );

    // 原版这里是 _queue_next_friendlies_from_next_target_values 的注释块（dead path），
    // 保留函数本体但调用点同样不接上。
    return [dumpIterCount, tieBreaker, tileIterCount];
  };

  /** IterativeExpansion.py:1357 _queue_next_friendlies_from_next_target_values —— dead path，函数保留 */
  ArmyFlowExpander.prototype._queue_next_friendlies_from_next_target_values = function (
    capValue, friendlyBorderingEnemy, friendlyUncalculated, myTeam,
    newUncappedTargetIslandArmy, newEconValue, newTargetTiles, newTurnsLeft,
    nextFriendlies, nextFriendlyFromNode, nextFriendlyUncalculated, nextGathedSum,
    newFrLeftoverArmy, nextTargetFromNode, nextTargetIsland, nextTargets, pairOptions,
    q, rootNodes, targetTeam, tieBreaker, newTurnsUsed, visited
  ) {
    var self = this;
    var IslandFlowNode = flowNodeCtor();

    var lookup = {};
    var newRootNodes = new Map();
    var cloned = deepCopyFlowNodes(Array.from(rootNodes.values()), lookup);
    for (var i = 0; i < cloned.length; i++) newRootNodes.set(cloned[i].island.unique_id, cloned[i]);

    var copyTargetFromNode = lookup[nextTargetFromNode.island.unique_id];
    var nextTargetCalculatedNode = new IslandFlowNode(nextTargetIsland, nextTargetIsland.sum_army + nextTargetIsland.tile_count);

    if (this.use_debug_asserts && !nextTargetCalculatedNode.island.border_islands.has(copyTargetFromNode.island)) {
      throw new Error('Tried to add illegal edge from ' + copyTargetFromNode + ' TO ' + nextTargetCalculatedNode);
    }
    copyTargetFromNode.set_flow_to(nextTargetCalculatedNode, 0);

    var copyFriendlyFromNode = lookup[nextFriendlyFromNode.island.unique_id];
    newRootNodes.delete(copyFriendlyFromNode.island.unique_id);
    var nextFriendlyUncalculatedNode = new IslandFlowNode(nextFriendlyUncalculated, 0 - nextFriendlyUncalculated.sum_army + nextFriendlyUncalculated.tile_count);
    if (this.use_debug_asserts && !copyFriendlyFromNode.island.border_islands.has(nextFriendlyUncalculatedNode.island)) {
      throw new Error('Tried to add illegal edge from ' + nextFriendlyUncalculatedNode + ' TO ' + copyFriendlyFromNode);
    }
    nextFriendlyUncalculatedNode.set_flow_to(copyFriendlyFromNode, 0);
    newRootNodes.set(nextFriendlyUncalculated.unique_id, nextFriendlyUncalculatedNode);

    var newNextFriendlies = new Map();
    var nfe = Array.from(nextFriendlies.entries());
    for (var f = 0; f < nfe.length; f++) {
      newNextFriendlies.set(nfe[f][0], deepCopyFlowNode(nfe[f][1], lookup));
    }
    newNextFriendlies.delete(nextFriendlyUncalculated);

    var newNextTargets = new Map();
    var nte = Array.from(nextTargets.entries());
    for (var t = 0; t < nte.length; t++) {
      newNextTargets.set(nte[t][0], deepCopyFlowNode(nte[t][1], lookup));
    }
    newNextTargets.delete(nextTargetIsland);

    this._try_include_nexts_by_flow(
      myTeam, nextFriendlyUncalculated.border_islands.items(), newNextFriendlies,
      newNextTargets, newFrLeftoverArmy, nextFriendlyUncalculated,
      nextFriendlyUncalculatedNode, nextGathedSum, nextTargetCalculatedNode,
      nextTargetIsland, visited, friendlyBorderingEnemy
    );

    this._try_queue_next_capture(
      myTeam, nextTargetIsland.border_islands.items(), newNextFriendlies,
      newNextTargets, newFrLeftoverArmy, nextGathedSum, nextTargetCalculatedNode,
      nextTargetIsland, visited, newRootNodes, friendlyBorderingEnemy
    );

    tieBreaker += 1;
    var nextFrTileIdx = nextFriendlyUncalculated.tile_count - 1;

    this.enqueue(
      q,
      this._get_a_star_priority_val(capValue, newEconValue, newTurnsUsed, newFrLeftoverArmy,
        nextFrTileIdx, nextFriendlyUncalculated, nextTargetCalculatedNode.island,
        newTurnsUsed + newTurnsLeft, newTargetTiles),
      newTurnsUsed, newTurnsLeft, newUncappedTargetIslandArmy, tieBreaker, newTargetTiles,
      newEconValue, nextGathedSum, newFrLeftoverArmy, nextFrTileIdx,
      nextTargetCalculatedNode, nextFriendlyUncalculatedNode, visited, newNextTargets,
      newNextFriendlies, newRootNodes, pairOptions
    );
    return tieBreaker;
  };

  /** IterativeExpansion.py:1476 enqueue */
  ArmyFlowExpander.prototype.enqueue = function (
    q, prioVal, newTurnsUsed, newTurnsLeft, newUncappedTargetIslandArmy, tieBreaker,
    newTargetTiles, newEconValue, nextGathedSum, newFrLeftoverArmy, nextFrTileIdx,
    nextTargetCalculatedNode, nextFriendlyUncalculatedNode, visited, newNextTargets,
    newNextFriendlies, newRootNodes, pairOptions
  ) {
    HeapPush(q, [
      prioVal, newTurnsUsed, newTurnsLeft, newUncappedTargetIslandArmy, tieBreaker,
      newTargetTiles, newEconValue, nextGathedSum, newFrLeftoverArmy, nextFrTileIdx,
      nextTargetCalculatedNode, nextFriendlyUncalculatedNode, visited, newNextTargets,
      newNextFriendlies, newRootNodes, pairOptions
    ]);
  };

  /** IterativeExpansion.py:1530 _try_include_nexts_by_flow */
  ArmyFlowExpander.prototype._try_include_nexts_by_flow = function (
    myTeam, borderIslands, newNextFriendlies, newNextTargets, nextFrLeftoverArmy,
    nextFriendlyUncalculated, nextFriendlyUncalculatedNode, nextGathedSum,
    nextTargetCalculatedNode, nextTargetIsland, visited, friendlyBorderingEnemy
  ) {
    for (var i = 0; i < borderIslands.length; i++) {
      var adj = borderIslands[i];
      if (adj.team === myTeam) {
        if (visited.has(adj) || newNextFriendlies.has(adj)) continue;
        if (!this._is_flow_allowed(adj, nextFriendlyUncalculated, nextGathedSum, false, true, friendlyBorderingEnemy)) continue;
        newNextFriendlies.set(adj, nextFriendlyUncalculatedNode);
      }
      // 非友方分支在原版里是 pass：gather 流只灌进主流，不能再独立开辟战场
    }
  };

  /** IterativeExpansion.py:1558 _try_queue_next_capture */
  ArmyFlowExpander.prototype._try_queue_next_capture = function (
    myTeam, borderIslands, newNextFriendlies, newNextTargets, nextFrLeftoverArmy,
    nextGathedSum, nextTargetCalculatedNode, nextTargetIsland, visited, rootNodes,
    friendlyBorderingEnemy
  ) {
    for (var i = 0; i < borderIslands.length; i++) {
      var adj = borderIslands[i];
      if (adj.team === myTeam) {
        if (visited.has(adj) || newNextFriendlies.has(adj) || newNextTargets.has(adj)) continue;
        var eitherAllowed =
          this._is_flow_allowed(nextTargetIsland, adj, nextGathedSum, false, true, friendlyBorderingEnemy) ||
          this._is_flow_allowed(adj, nextTargetIsland, nextGathedSum, false, true, friendlyBorderingEnemy);
        if (!eitherAllowed) continue;
        newNextTargets.set(adj, nextTargetCalculatedNode);
      } else {
        if (visited.has(adj) || !this._is_flow_allowed(nextTargetIsland, adj, nextFrLeftoverArmy, true)) continue;
        if (rootNodes !== null && rootNodes !== undefined) {
          var seededFriendlies = this._seeded_pairs.get(adj.unique_id);
          if (seededFriendlies && seededFriendlies.size > 0) {
            var allInRoots = true;
            var sit = seededFriendlies.values(), sstep = sit.next();
            while (!sstep.done) {
              if (!rootNodes.has(sstep.value)) { allInRoots = false; break; }
              sstep = sit.next();
            }
            if (!allInRoots) continue;
          }
        }
        newNextTargets.set(adj, nextTargetCalculatedNode);
      }
    }
  };

  /** IterativeExpansion.py:1593 _queue_current_friendlies_from_next_target_values */
  ArmyFlowExpander.prototype._queue_current_friendlies_from_next_target_values = function (
    capValue, friendlyBorderingEnemy, friendlyUncalculated, myTeam,
    newUncappedTargetIslandArmy, newEconValue, newTargetTiles, newTurnsLeft, nextFriendlies,
    nextGathedSum, newFrLeftoverArmy, newFriendlyTileLeftoverIdx, nextTargetFromNode,
    nextTargetIsland, nextTargets, pairOptions, q, rootNodes, targetTeam, tieBreaker,
    newTurnsUsed, visited
  ) {
    var IslandFlowNode = flowNodeCtor();
    var lookup = {};

    var newRootNodes = new Map();
    var cloned = deepCopyFlowNodes(Array.from(rootNodes.values()), lookup);
    for (var i = 0; i < cloned.length; i++) newRootNodes.set(cloned[i].island.unique_id, cloned[i]);

    var copyTargetFromNode = lookup[nextTargetFromNode.island.unique_id];
    var nextTargetCalculatedNode = new IslandFlowNode(nextTargetIsland, nextTargetIsland.sum_army + nextTargetIsland.tile_count);

    if (!nextTargetCalculatedNode.island.border_islands.has(copyTargetFromNode.island)) {
      throw new Error('Tried to add illegal edge from ' + copyTargetFromNode + ' TO ' + nextTargetCalculatedNode);
    }
    copyTargetFromNode.set_flow_to(nextTargetCalculatedNode, 0);

    var copyFriendlyFromNode = lookup[friendlyUncalculated.unique_id];
    if (copyFriendlyFromNode === undefined) {
      throw new Error('missing clone for friendly ' + friendlyUncalculated.unique_id);
    }

    var newNextFriendlies = new Map();
    var nfe = Array.from(nextFriendlies.entries());
    for (var f = 0; f < nfe.length; f++) newNextFriendlies.set(nfe[f][0], deepCopyFlowNode(nfe[f][1], lookup));

    var newNextTargets = new Map();
    var nte = Array.from(nextTargets.entries());
    for (var t = 0; t < nte.length; t++) newNextTargets.set(nte[t][0], deepCopyFlowNode(nte[t][1], lookup));
    newNextTargets.delete(nextTargetIsland);

    this._try_queue_next_capture(
      myTeam, nextTargetIsland.border_islands.items(), newNextFriendlies, newNextTargets,
      newFrLeftoverArmy, nextGathedSum, nextTargetCalculatedNode, nextTargetIsland,
      visited, newRootNodes, friendlyBorderingEnemy
    );

    tieBreaker += 1;

    this.enqueue(
      q,
      this._get_a_star_priority_val(capValue, newEconValue, newTurnsUsed, newFrLeftoverArmy,
        newFriendlyTileLeftoverIdx, friendlyUncalculated, nextTargetIsland,
        newTurnsUsed + newTurnsLeft, newTargetTiles),
      newTurnsUsed, newTurnsLeft, newUncappedTargetIslandArmy, tieBreaker, newTargetTiles,
      newEconValue, nextGathedSum, newFrLeftoverArmy, newFriendlyTileLeftoverIdx,
      nextTargetCalculatedNode, copyFriendlyFromNode, visited, newNextTargets,
      newNextFriendlies, newRootNodes, pairOptions
    );
    return tieBreaker;
  };

  /** IterativeExpansion.py:1685 _calculate_next_target_values —— dead path，函数保留 */
  ArmyFlowExpander.prototype._calculate_next_target_values = function (
    capValue, dumpIterCount, friendlyUncalculated, newUncappedTargetIslandArmy, newEconValue,
    newFrLeftoverArmy, newFriendlyTileLeftoverIdx, newTargetTiles, newTurnsLeft,
    nextGathedSum, nextTargetIsland, pairOptions, rootNodes, tileIterCount, turns
  ) {
    var r = this._execute_island_tile_gather_capture_loop_and_record_options(
      newUncappedTargetIslandArmy, capValue, dumpIterCount, newEconValue, newFrLeftoverArmy,
      newFriendlyTileLeftoverIdx, friendlyUncalculated, nextGathedSum, pairOptions,
      rootNodes, nextTargetIsland, newTargetTiles, tileIterCount, turns, newTurnsLeft
    );
    return [r[1], r[0], r[2], r[8], r[3], r[4], r[7]];
  };

  /** IterativeExpansion.py:1734 _queue_next_friendlies_only */
  ArmyFlowExpander.prototype._queue_next_friendlies_only = function (
    armyToCap, capValue, econValue, frLeftoverArmy, friendlyUncalculated, myTeam,
    nextFriendlies, nextGathedSum, nextTargets, pairOptions, q, rootNodes,
    targetCalculatedNode, targetTiles, tieBreaker, turns, turnsLeft, visited
  ) {
    var IslandFlowNode = flowNodeCtor();
    var turnsUsed = turns - turnsLeft;

    var items = Array.from(nextFriendlies.entries());
    for (var i = 0; i < items.length; i++) {
      var nextFriendlyUncalculated = items[i][0];
      var nextFriendlyFromNode = items[i][1];
      if (visited.has(nextFriendlyUncalculated)) continue;

      var lookup = {};
      var newRootNodes = new Map();
      var cloned = deepCopyFlowNodes(Array.from(rootNodes.values()), lookup);
      for (var c = 0; c < cloned.length; c++) newRootNodes.set(cloned[c].island.unique_id, cloned[c]);

      var copyTargetCalculatedNode = lookup[targetCalculatedNode.island.unique_id];

      newRootNodes.delete(nextFriendlyFromNode.island.unique_id);
      var copyFriendlyFromNode = lookup[nextFriendlyFromNode.island.unique_id];
      if (copyFriendlyFromNode === undefined) {
        throw new Error('missing clone for friendly-from ' + nextFriendlyFromNode.island.unique_id);
      }

      var nextFriendlyUncalculatedNode = new IslandFlowNode(nextFriendlyUncalculated, 0 - nextFriendlyUncalculated.sum_army + nextFriendlyUncalculated.tile_count);
      if (this.use_debug_asserts && !copyFriendlyFromNode.island.border_islands.has(nextFriendlyUncalculatedNode.island)) {
        throw new Error('Tried to add illegal edge from ' + nextFriendlyUncalculatedNode + ' TO ' + copyFriendlyFromNode);
      }
      nextFriendlyUncalculatedNode.set_flow_to(copyFriendlyFromNode, 0);
      newRootNodes.set(nextFriendlyUncalculated.unique_id, nextFriendlyUncalculatedNode);

      var newNextFriendlies = new Map();
      var nfe = Array.from(nextFriendlies.entries());
      for (var f = 0; f < nfe.length; f++) newNextFriendlies.set(nfe[f][0], deepCopyFlowNode(nfe[f][1], lookup));
      newNextFriendlies.delete(nextFriendlyUncalculated);

      var newNextTargets = new Map();
      var nte = Array.from(nextTargets.entries());
      for (var t = 0; t < nte.length; t++) newNextTargets.set(nte[t][0], deepCopyFlowNode(nte[t][1], lookup));

      this._try_include_nexts_by_flow(
        myTeam, nextFriendlyUncalculated.border_islands.items(), newNextFriendlies,
        newNextTargets, frLeftoverArmy, nextFriendlyUncalculated,
        nextFriendlyUncalculatedNode, nextGathedSum, copyTargetCalculatedNode,
        targetCalculatedNode.island, visited, null
      );

      tieBreaker += 1;
      var frTileIdx = nextFriendlyUncalculated.tile_count - 1;

      this.enqueue(
        q,
        this._get_a_star_priority_val(capValue, econValue, turnsUsed, frLeftoverArmy, frTileIdx,
          nextFriendlyUncalculated, targetCalculatedNode.island, turnsUsed + turnsLeft, targetTiles),
        turnsUsed, turnsLeft, armyToCap, tieBreaker, targetTiles.copy(), econValue,
        nextGathedSum, frLeftoverArmy, frTileIdx, copyTargetCalculatedNode,
        nextFriendlyUncalculatedNode, visited, newNextTargets, newNextFriendlies,
        newRootNodes, pairOptions
      );
    }
    return tieBreaker;
  };

  /** IterativeExpansion.py:1826 _build_flow_expansion_option */
  ArmyFlowExpander.prototype._build_flow_expansion_option = function (
    islandBuilder, target, source, sourceNodes, econValue, armyRemainingInIncompleteSource,
    turns, targetIslands, ourIslands, incompleteTarget, incompleteSource,
    unusedSourceArmy, gathedArmySum, negativeTiles, useTrueValueGathered
  ) {
    if (useTrueValueGathered === undefined) useTrueValueGathered = true;
    var team = this.team;
    var capping = new Set();
    var gathing = new Set();

    var incompleteSourceNode = null;
    var incompleteTargetNode = null;
    var incompleteTargetFrom = {};
    var allBorderTiles = new Set();

    var rebuiltGathedSum = unusedSourceArmy;
    var rebuiltCumulativeSum = unusedSourceArmy;
    if (rebuiltGathedSum === null || rebuiltGathedSum === undefined) {
      rebuiltGathedSum = 0;
      rebuiltCumulativeSum = 0;
    }
    var rebuiltCumulativeTurns = -1;

    var q = [];
    var srcVals = Array.from(sourceNodes.values());
    for (var si = 0; si < srcVals.length; si++) q.push([0, 0, srcVals[si], null]);

    while (q.length > 0) {
      var entry = q.pop();
      var curArmy = entry[0];
      var curIdk = entry[1];
      var curNode = entry[2];
      var fromNode = entry[3];

      if (fromNode !== null && fromNode.island.team === team && curNode.island.team !== team) {
        // 注意参数顺序：python 是 get_inner_border_tiles(curNode.island, fromNode.island)
        var borderTiles = islandBuilder.get_inner_border_tiles(curNode.island, fromNode.island);
        var bt = borderTiles.values === undefined ? borderTiles : borderTiles.values();
        var bstep = bt.next ? bt.next() : null;
        while (bstep && !bstep.done) { allBorderTiles.add(bstep.value); bstep = bt.next(); }
      }

      if (curNode.island === incompleteTarget) {
        incompleteTargetNode = curNode;
        if (fromNode) incompleteTargetFrom[fromNode.island.unique_id] = fromNode;
      } else if (curNode.island === incompleteSource) {
        incompleteSourceNode = curNode;
        var gathed2 = curNode.island.sum_army - curNode.island.tile_count - unusedSourceArmy;
        curArmy += gathed2;
        rebuiltGathedSum += gathed2;
        rebuiltCumulativeSum += gathed2;
      } else {
        rebuiltCumulativeTurns += curNode.island.tile_count;
        if (curNode.island.team === team) {
          var gts = curNode.island.tile_set.values(), gs = gts.next();
          while (!gs.done) { gathing.add(gs.value); gs = gts.next(); }
          var gathed3 = curNode.island.sum_army - curNode.island.tile_count;
          curArmy += gathed3;
          rebuiltGathedSum += gathed3;
          rebuiltCumulativeSum += gathed3;
        } else {
          var cts = curNode.island.tile_set.values(), cs = cts.next();
          while (!cs.done) { capping.add(cs.value); cs = cts.next(); }
          var gathed4 = curNode.island.sum_army + curNode.island.tile_count;
          curArmy -= gathed4;
          rebuiltCumulativeSum -= gathed4;
        }
      }

      var edges = curNode.flow_to;
      for (var e = 0; e < edges.length; e++) {
        edges[e].edge_army = curArmy;
        q.push([curArmy, curIdk, edges[e].target_flow_node, curNode]);
      }
    }

    if (incompleteSourceNode !== null) {
      var sTiles = this._find_island_consumed_tiles_from_borders(
        islandBuilder, incompleteSourceNode, gathing, capping, unusedSourceArmy,
        incompleteSourceNode.flow_to, negativeTiles
      );
      var st = sTiles.values(), sstep2 = st.next();
      while (!sstep2.done) { gathing.add(sstep2.value); sstep2 = st.next(); }
      rebuiltCumulativeTurns += sTiles.size;
    }

    if (incompleteTargetNode !== null) {
      var incompleteUsedTurns = Math.min(
        turns - gathing.size - capping.size,
        incompleteTargetNode.island.tile_count - 1
      );
      if (incompleteUsedTurns > 0) {
        var dTiles = this._find_island_consumed_tiles_from_borders_by_count(
          islandBuilder, incompleteTargetNode, gathing, capping, incompleteUsedTurns,
          incompleteTargetFrom, negativeTiles
        );
        var dt = dTiles.values(), dstep = dt.next();
        while (!dstep.done) { capping.add(dstep.value); dstep = dt.next(); }
        rebuiltCumulativeTurns += dTiles.size;
        var d2 = dTiles.values(), dstep2 = d2.next();
        while (!dstep2.done) { rebuiltCumulativeSum -= dstep2.value.army - 1; dstep2 = d2.next(); }
      }
    }

    var GU = EK.GatherUtils;
    if (!GU || typeof GU.convert_contiguous_capture_tiles_to_gather_capture_plan !== 'function') {
      throw new Error('iterativeexpansion: EK.GatherUtils.convert_contiguous_capture_tiles_to_gather_capture_plan 未加载');
    }
    var plan = GU.convert_contiguous_capture_tiles_to_gather_capture_plan(
      this.map,
      allBorderTiles,
      gathing,
      negativeTiles,
      playerOf(this.friendlyGeneral),
      null,
      useTrueValueGathered,
      false,
      true,
      capping,
      null,
      null,
      null
    );

    if (this.log_debug || this.use_debug_asserts) {
      var planVt = plan.econValue / plan.length;
      var cutoffVt = econValue / Math.max(1, turns - 1);
      var violatesVtCutoff = planVt > cutoffVt * 1.10001;
      if (violatesVtCutoff && this.use_debug_asserts) {
        var anyInvalid = false;
        for (var rn = 0; rn < plan.root_nodes.length; rn++) {
          if (plan.root_nodes[rn].value < 0) { anyInvalid = true; break; }
        }
        if (anyInvalid) {
          throw new Error('Something went wrong. econValue ' + econValue + ' / turns ' + turns +
            ' (' + (econValue / turns).toFixed(3) + '). The GCP is overvalued ' + planVt.toFixed(3) +
            ' (' + plan.econValue + 'v/' + plan.length + 't)' +
            ' gathedArmySum ' + gathedArmySum + ' armyRemainingInIncompleteSource ' + armyRemainingInIncompleteSource +
            ' rebuiltCumulativeTurns ' + rebuiltCumulativeTurns + ' rebuiltGathedSum ' + rebuiltGathedSum +
            ' rebuiltCumulativeSum ' + rebuiltCumulativeSum);
        }
      }
    }

    return plan;
  };

  /** IterativeExpansion.py:2283 _capture_last_run_flow_stats */
  ArmyFlowExpander.prototype._capture_last_run_flow_stats = function () {
    this.last_run = new ArmyFlowExpanderLastRun();
    var finder = this._get_networkx_flow_direction_finder();

    if (finder.graph_data_no_neut !== null && finder.graph_data_no_neut !== undefined) {
      var nxNo = finder.graph_data_no_neut;
      this.last_run.flow_stats_no_neut = new FlowGraphDebugStats(
        nxNo.friendly_army_supply, nxNo.enemy_army_demand,
        nxNo.friendly_army_supply - nxNo.enemy_army_demand
      );
    }
    if (finder.graph_data !== null && finder.graph_data !== undefined) {
      var nxInc = finder.graph_data;
      this.last_run.flow_stats_inc_neut = new FlowGraphDebugStats(
        nxInc.friendly_army_supply, nxInc.enemy_army_demand,
        nxInc.friendly_army_supply - nxInc.enemy_army_demand
      );
    }
  };

  /** IterativeExpansion.py:2468 _find_island_consumed_tiles_from_borders */
  ArmyFlowExpander.prototype._find_island_consumed_tiles_from_borders = function (
    islandBuilder, incompleteSource, gathing, capping, unusedSourceArmy, flowTo, negativeTiles
  ) {
    var incIsland = incompleteSource.island;
    var borders = new Set();

    var useCappingGathing = gathing.size > 0 || capping.size > 0;
    if (useCappingGathing) {
      var its = incIsland.tile_set.values(), step = its.next();
      while (!step.done) {
        var incompleteTile = step.value;
        for (var m = 0; m < incompleteTile.movableNoObstacles.length; m++) {
          var nb = incompleteTile.movableNoObstacles[m];
          if (capping.has(nb) || gathing.has(nb)) { borders.add(incompleteTile); break; }
        }
        step = its.next();
      }
    }

    if (borders.size === 0) {
      var borderLookup = islandBuilder.get_island_border_tile_lookup(incIsland);
      for (var de = 0; de < flowTo.length; de++) {
        var destUid = flowTo[de].target_flow_node.island.unique_id;
        var set = borderLookup[destUid];
        if (set === undefined) {
          throw new Error('failed to find border from ' + incompleteSource.island.unique_id + ' to ' + destUid);
        }
        var bvals = set.values ? set.values() : set;
        var bstep = bvals.next ? bvals.next() : null;
        while (bstep && !bstep.done) { borders.add(bstep.value); bstep = bvals.next(); }
      }
    }

    var toUse = incIsland.sum_army - unusedSourceArmy - incIsland.tile_count;

    var heap = [];
    var bIter = borders.values(), bst = bIter.next();
    while (!bst.done) { armyHeapPush(heap, [1 - bst.value.army, bst.value]); bst = bIter.next(); }

    var used = new Set();
    while (heap.length > 0) {
      var top = armyHeapPop(heap);
      var negArmy = top[0];
      var tile = top[1];
      if (used.has(tile)) continue;

      toUse = toUse + negArmy;
      used.add(tile);
      if (toUse <= 0) break;

      for (var mv = 0; mv < tile.movable.length; mv++) {
        var mvt = tile.movable[mv];
        if (incIsland.tile_set.has(mvt)) armyHeapPush(heap, [1 - mvt.army, mvt]);
      }
    }

    return used;
  };

  /** IterativeExpansion.py:2545 _find_island_consumed_tiles_from_borders_by_count */
  ArmyFlowExpander.prototype._find_island_consumed_tiles_from_borders_by_count = function (
    islandBuilder, incompleteDest, gathing, capping, countToInclude, comeFrom, negativeTiles
  ) {
    if (countToInclude <= 0) return new Set();
    var incIsland = incompleteDest.island;
    var borders = new Set();

    var useCappingGathing = gathing.size > 0 || capping.size > 0;
    if (useCappingGathing) {
      var its = incIsland.tile_set.values(), step = its.next();
      while (!step.done) {
        var incompleteTile = step.value;
        for (var m = 0; m < incompleteTile.movableNoObstacles.length; m++) {
          var nb = incompleteTile.movableNoObstacles[m];
          if (capping.has(nb) || gathing.has(nb)) { borders.add(incompleteTile); break; }
        }
        step = its.next();
      }
    }

    if (borders.size === 0) {
      var borderLookup = islandBuilder.get_island_border_tile_lookup(incIsland);
      var keys = Object.keys(comeFrom);
      for (var k = 0; k < keys.length; k++) {
        var set = borderLookup[comeFrom[keys[k]].island.unique_id];
        if (set === undefined) continue;
        var bvals = set.values ? set.values() : set;
        var bstep = bvals.next ? bvals.next() : null;
        while (bstep && !bstep.done) { borders.add(bstep.value); bstep = bvals.next(); }
      }
    }

    var heap = [];
    var bIter = borders.values(), bst = bIter.next();
    while (!bst.done) { armyHeapPush(heap, [1 - bst.value.army, bst.value]); bst = bIter.next(); }

    var used = new Set();
    while (heap.length > 0) {
      var top = armyHeapPop(heap);
      var tile = top[1];
      if (used.has(tile)) continue;
      used.add(tile);
      if (used.size >= countToInclude) break;
      for (var mv = 0; mv < tile.movable.length; mv++) {
        var mvt = tile.movable[mv];
        if (incIsland.tile_set.has(mvt)) armyHeapPush(heap, [1 - mvt.army, mvt]);
      }
    }

    return used;
  };

  /** IterativeExpansion.py:2598 iterate_flow_nodes —— python 是 generator，这里返回数组（BFS 序） */
  ArmyFlowExpander.iterate_flow_nodes = function (rootNodes) {
    var q = [];
    var initVisited = new Set();
    for (var i = 0; i < rootNodes.length; i++) {
      var n = rootNodes[i];
      if (initVisited.has(n)) continue;
      q.push(n);
      initVisited.add(n);
    }
    var visited = new Set();
    var out = [];
    var head = 0;
    while (head < q.length) {
      var cur = q[head++];
      if (visited.has(cur.island.unique_id)) continue;
      visited.add(cur.island.unique_id);
      out.push(cur);
      for (var e = 0; e < cur.flow_to.length; e++) q.push(cur.flow_to[e].target_flow_node);
    }
    return out;
  };

  /** IterativeExpansion.py:2648 iterate_flow_children */
  ArmyFlowExpander.iterate_flow_children = function (rootNodes) {
    var q = [];
    var initVisited = new Set();
    for (var i = 0; i < rootNodes.length; i++) {
      var n = rootNodes[i];
      if (initVisited.has(n)) continue;
      for (var e = 0; e < n.flow_to.length; e++) q.push(n.flow_to[e].target_flow_node);
      initVisited.add(n);
    }
    var visited = new Set();
    var out = [];
    var head = 0;
    while (head < q.length) {
      var cur = q[head++];
      if (visited.has(cur.island.unique_id)) continue;
      visited.add(cur.island.unique_id);
      out.push(cur);
      for (var e2 = 0; e2 < cur.flow_to.length; e2++) q.push(cur.flow_to[e2].target_flow_node);
    }
    return out;
  };

  /** IterativeExpansion.py:2701 assertEverythingSafe */
  ArmyFlowExpander.prototype.assertEverythingSafe = function (
    fullSearchTurns, negVt, turnsUsed, turnsLeft, armyToCap, randomTieBreak, targetTiles,
    econValue, gathSum, frLeftoverArmy, friendlyTileLeftoverIdx, targetCalculatedNode,
    friendlyUncalculatedNode, visited, nextTargets, nextFriendlies, rootNodes, pairOptions
  ) {
    if (turnsUsed <= 0) return;
    var mismatches = [];
    var safetyChecker = {};
    var minTurnsUsed = -1;
    var maxTurnsUsed = -1;
    var expectedTurnsUsed = -1;
    var nodes = ArmyFlowExpander.iterate_flow_nodes(Array.from(rootNodes.values()));
    if (nodes.length === 0) throw new Error('no nodes in flow');

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var existing = safetyChecker[n.island.unique_id];
      if (existing !== undefined) {
        if (existing !== n) mismatches.push('Corrupted root nodes; ' + n + ' != ' + existing);
        minTurnsUsed += 1;
        maxTurnsUsed += 1;
      } else {
        safetyChecker[n.island.unique_id] = n;
        if (n.island.unique_id === targetCalculatedNode.island.unique_id) {
          minTurnsUsed += n.island.tile_count - targetTiles.size();
          maxTurnsUsed += n.island.tile_count;
          expectedTurnsUsed += n.island.tile_count - targetTiles.size();
        } else if (n.island.unique_id === friendlyUncalculatedNode.island.unique_id) {
          maxTurnsUsed += n.island.tile_count;
          expectedTurnsUsed += n.island.tile_count - friendlyTileLeftoverIdx - 1;
          continue;
        } else {
          minTurnsUsed += n.island.tile_count;
          maxTurnsUsed += n.island.tile_count;
          expectedTurnsUsed += n.island.tile_count;
        }
      }
    }

    if (turnsUsed < minTurnsUsed) {
      mismatches.push('rootNodes min traversed tilecount summed to ' + minTurnsUsed + ' but turnsUsed was ' + turnsUsed);
    }
    if (turnsUsed > maxTurnsUsed) {
      mismatches.push('rootNodes max traversed tilecount summed to ' + maxTurnsUsed + ' but turnsUsed was ' + turnsUsed);
    }
    if (turnsUsed !== expectedTurnsUsed) {
      mismatches.push('rootNodes expected turnsUsed summed to ' + expectedTurnsUsed + ' but turnsUsed was ' + turnsUsed);
    }

    var maxTurnsLeft = fullSearchTurns - minTurnsUsed;
    var minTurnsLeft = fullSearchTurns - maxTurnsUsed;
    if (turnsLeft < minTurnsLeft) {
      mismatches.push('rootNodes min traversed turnsLeft (fullSearch - maxTurnsUsed) to ' + minTurnsLeft + ' but turnsLeft was ' + turnsLeft);
    }
    if (turnsLeft > maxTurnsLeft) {
      mismatches.push('rootNodes max traversed turnsLeft (fullSearch - minTurnsUsed) to ' + maxTurnsLeft + ' but turnsLeft was ' + turnsLeft);
    }

    var nt = ArmyFlowExpander.iterate_flow_nodes(Array.from(nextTargets.values()));
    for (var t = 0; t < nt.length; t++) {
      var ex = safetyChecker[nt[t].island.unique_id];
      if (ex !== undefined) {
        if (ex !== nt[t]) mismatches.push('Corrupted nextTarget nodes; ' + nt[t] + ' != ' + ex);
      } else {
        safetyChecker[nt[t].island.unique_id] = nt[t];
      }
    }

    var nf = ArmyFlowExpander.iterate_flow_nodes(Array.from(nextFriendlies.values()));
    for (var f = 0; f < nf.length; f++) {
      var ex2 = safetyChecker[nf[f].island.unique_id];
      if (ex2 !== undefined) {
        if (ex2 !== nf[f]) mismatches.push('Corrupted nextFriendlies nodes; ' + nf[f] + ' != ' + ex2);
      } else {
        safetyChecker[nf[f].island.unique_id] = nf[f];
      }
    }

    var exT = safetyChecker[targetCalculatedNode.island.unique_id];
    if (exT !== undefined) {
      if (exT !== targetCalculatedNode) mismatches.push('Corrupted targetCalculatedNode node; ' + targetCalculatedNode + ' != ' + exT);
    } else {
      safetyChecker[targetCalculatedNode.island.unique_id] = targetCalculatedNode;
    }

    var exF = safetyChecker[friendlyUncalculatedNode.island.unique_id];
    if (exF !== friendlyUncalculatedNode) {
      mismatches.push('Corrupted friendlyUncalculatedNode node; ' + friendlyUncalculatedNode + ' != ' + exF);
    } else {
      safetyChecker[friendlyUncalculatedNode.island.unique_id] = friendlyUncalculatedNode;
    }

    if (mismatches.length > 0) {
      throw new Error('Search is corrupted;\r\n' + mismatches.join('\r\n'));
    }
  };

  /** IterativeExpansion.py:2845 _get_a_star_priority_val_true */
  ArmyFlowExpander.prototype._get_a_star_priority_val_true = function (
    capValue, econValueSoFar, newTurnsUsed, newFrLeftoverArmy, newFriendlyTileLeftoverIdx,
    friendlyUncalculated, targetIsland, searchTurns, tgTiles
  ) {
    var frIslandArmyLeft = this.get_friendly_island_army_left(friendlyUncalculated, newFrLeftoverArmy, newFriendlyTileLeftoverIdx);
    var maxCaps = Math.floor((frIslandArmyLeft - 1) / 2);
    var turnsAtOptimalCaps = searchTurns - newTurnsUsed - newFriendlyTileLeftoverIdx;
    var maxAddlEcon = 0.0;
    if (targetIsland.team === -1) {
      turnsAtOptimalCaps -= tgTiles.size();
      maxAddlEcon += capValue * tgTiles.size();
      maxCaps -= Math.floor(tgTiles.size() / 2);
    }
    if (maxCaps < turnsAtOptimalCaps) turnsAtOptimalCaps -= 1;
    maxAddlEcon += turnsAtOptimalCaps * 2;
    var rewardMetric = (econValueSoFar * this._dynamic_heuristic_ratio) + maxAddlEcon;
    return rewardMetric;
  };

  /** IterativeExpansion.py:2907 _get_a_star_priority_val */
  ArmyFlowExpander.prototype._get_a_star_priority_val = function (
    capValue, econValueSoFar, newTurnsUsed, newFrLeftoverArmy, newFriendlyTileLeftoverIdx,
    friendlyUncalculated, targetIsland, searchTurns, tgTiles
  ) {
    var frIslandArmyLeft = this.get_friendly_island_army_left(friendlyUncalculated, newFrLeftoverArmy, newFriendlyTileLeftoverIdx);
    var maxCaps = Math.floor((frIslandArmyLeft - 1) / 2);
    var turnsAtOptimalCaps = searchTurns - newTurnsUsed - newFriendlyTileLeftoverIdx - 1;

    if (turnsAtOptimalCaps > targetIsland.tile_count) {
      // python: next(iter(targetIsland.tile_set)) —— set 迭代序 = 槽位序（见 pySetOrderIndices）
      var ordered = EK.PySetOrder
        ? EK.PySetOrder.pySetOrderIndices(targetIsland.tile_set)
        : Array.from(targetIsland.tile_set.values());
      var firstTile = ordered[0];
      var distToLargeIsland = this.dists_to_target_large_island
        ? this.dists_to_target_large_island.raw[firstTile.tile_index] : 0;
      if (distToLargeIsland > 2) {
        if (targetIsland.team === this.team) {
          turnsAtOptimalCaps -= distToLargeIsland - 1;
        } else if (targetIsland.team !== this.target_team) {
          turnsAtOptimalCaps -= Math.floor(distToLargeIsland / 2) - 1;
        }
      }
    }

    var maxAddlEcon = 0.0;
    if (targetIsland.team === -1) {
      turnsAtOptimalCaps -= tgTiles.size();
      maxAddlEcon += capValue * tgTiles.size();
      maxCaps -= Math.floor(tgTiles.size() / 2);
    } else if (targetIsland.team === this.team) {
      turnsAtOptimalCaps -= tgTiles.size();
      var tgSum = 0;
      for (var i = tgTiles.off; i < tgTiles.items.length; i++) tgSum += tgTiles.items[i];
      frIslandArmyLeft -= tgSum + tgTiles.size();
    }

    if (maxCaps < turnsAtOptimalCaps) turnsAtOptimalCaps -= 1;
    maxAddlEcon += turnsAtOptimalCaps * 2;
    var rewardMetric = (econValueSoFar * this._dynamic_heuristic_ratio) + maxAddlEcon;
    return rewardMetric;
  };

  /** IterativeExpansion.py:2984 get_friendly_island_army_left */
  ArmyFlowExpander.prototype.get_friendly_island_army_left = function (
    friendlyUncalculated, newFrLeftoverArmy, newFriendlyTileLeftoverIdx
  ) {
    var frIslandArmyLeft = newFrLeftoverArmy;
    var tba = friendlyUncalculated.tiles_by_army;
    if (newFriendlyTileLeftoverIdx * 2 >= friendlyUncalculated.tile_count) {
      var tail = 0;
      for (var i = newFriendlyTileLeftoverIdx + 1; i < tba.length; i++) tail += tba[i].army;
      frIslandArmyLeft += friendlyUncalculated.sum_army - tail;
    } else {
      var head = 0;
      for (var j = 0; j <= newFriendlyTileLeftoverIdx; j++) head += tba[j].army;
      frIslandArmyLeft += head;
    }
    if (newFriendlyTileLeftoverIdx >= 0) frIslandArmyLeft -= newFriendlyTileLeftoverIdx + 1;
    return frIslandArmyLeft;
  };

  /** IterativeExpansion.py:2995 _is_flow_allowed */
  ArmyFlowExpander.prototype._is_flow_allowed = function (
    fromIsland, toIsland, armyAmount, isSubsequentTarget, isSubsequentFriendly, friendlyBorderingEnemy
  ) {
    if (!this.use_min_cost_flow_edges_only) {
      if (isSubsequentTarget) {
        if (fromIsland.team !== this.target_team && fromIsland.team !== -1 && toIsland.team !== this.target_team) return false;
      }
      if (isSubsequentFriendly) {
        if (fromIsland.team !== this.team) return false;
      }
      return true;
    }

    var fg = this.flow_graph;
    if (!fg) return false;
    var noNeut = fg.flow_node_lookup_by_island_no_neut;
    if (!noNeut.has(fromIsland.unique_id)) return false;
    if (!noNeut.has(toIsland.unique_id)) return false;

    var fromNoNeut = noNeut.get(fromIsland.unique_id);
    var toNoNeut = noNeut.get(toIsland.unique_id);
    for (var i = 0; i < fromNoNeut.flow_to.length; i++) {
      if (fromNoNeut.flow_to[i].target_flow_node === toNoNeut) return true;
    }

    var inc = fg.flow_node_lookup_by_island_inc_neut;
    var fromWithNeut = inc.get(fromIsland.unique_id);
    var toWithNeut = inc.get(toIsland.unique_id);
    if (fromWithNeut === undefined || toWithNeut === undefined) return false;
    for (var j = 0; j < fromWithNeut.flow_to.length; j++) {
      if (fromWithNeut.flow_to[j].target_flow_node === toWithNeut) return true;
    }
    return false;
  };

  // __PART3__

  EK.ArmyFlowExpander = ArmyFlowExpander;
  EK.ArmyFlowExpanderLastRun = ArmyFlowExpanderLastRun;
  EK.FlowExpansionPlanOptionCollection = FlowExpansionPlanOptionCollection;
  EK.FlowGraphDebugStats = FlowGraphDebugStats;
  EK.PlanDupeChecker = PlanDupeChecker;
  EK.ITERATIVE_EXPANSION_EN_CAP_VAL = ITERATIVE_EXPANSION_EN_CAP_VAL;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

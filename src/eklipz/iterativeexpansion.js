/**
 * IterativeExpansion.js —— BehaviorAlgorithms/IterativeExpansion.py 的逐函数移植（legacy 扩张器）。
 *
 * 源文件：E:\akcoco6de\_research\generals-bot-cs\BehaviorAlgorithms\IterativeExpansion.py
 *
 * 迁移约束（与原版对表时请按这些点核对）：
 *   1. 所有球面算法（岛间流图、双向搜索、A* 启发式）逐句照搬，包括原版里的 dead path
 *      （_queue_next_friendlies_from_next_target_values / _calculate_next_target_values 的调用点
 *      在 python 里被注释掉了，这里也同样不接上，只保留函数本体以备后查）。
 *   2. `tile.player()` 是方法，`tile.isPathable` 是属性；MapMatrix/MapMatrixSet 用
 *      `.raw[tile.tile_index]` 与 `.has(tile)`。
 *   3. python 的 `list[-1]`、`dict[-1]` 在 JS 里不会自动折末位，凡依赖负下标的地方都显式折过。
 *   4. python 的 set/dict 迭代顺序：set 按 tile_index / unique_id 升序，dict 按插入序；
 *      JS 的 Set/Map 天然是插入序，所以凡是 python 侧靠 set 排序的地方这里都显式 sort。
 *   5. 时间截断（cutoffTime / _dynamic_heuristic_ratio 的阶段推进）照搬：
 *      原版用 time.time() 判阶段，这里用同样的墙钟检查，不改语义。
 *   6. 渲染与 debug 输出（live_render_capture_stuff / live_render_invalid_flow_config /
 *      logbook 逐行日志）不搬。
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
    // python: DebugHelper.is_debug_or_unit_test_mode() and False —— 恒 False
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
      // legacy bot 路径上 method 恒为 MinCostFlow，走不到这里）
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

  // __PART2__

  EK.ArmyFlowExpander = ArmyFlowExpander;
  EK.ArmyFlowExpanderLastRun = ArmyFlowExpanderLastRun;
  EK.FlowExpansionPlanOptionCollection = FlowExpansionPlanOptionCollection;
  EK.FlowGraphDebugStats = FlowGraphDebugStats;
  EK.PlanDupeChecker = PlanDupeChecker;
  EK.ITERATIVE_EXPANSION_EN_CAP_VAL = ITERATIVE_EXPANSION_EN_CAP_VAL;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

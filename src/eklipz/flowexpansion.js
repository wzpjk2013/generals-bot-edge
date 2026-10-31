/*
 * FlowExpansion.js —— ArmyFlowExpanderV2 的 JS 移植。
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\BehaviorAlgorithms\FlowExpansion.py（3633 行）
 *
 * 它在整条 bot 里的位置：turn >= 50 之后，BotExpansionOps.build_expansion_plan 会调
 * get_expansion_options(...) 拿到一批「这个回合周期内可以执行的扩张计划」，再把它们当作
 * additional_options 塞进 ExpandUtils.get_round_plan_with_expansion(skipKnapsacking=True)。
 * 也就是说：这里产出的是候选计划，不是最终出招。
 *
 * 算法的四层：
 *   原理——把「我方岛屿 → 敌方/中立岛屿」看成一个多源流网络，用最小费用流决定每个边界
 *         通道（border pair）能吸到多少后方兵力、能捅到多深的目标链。
 *   组成——1) flow graph（岛屿级有向图，边上带流量）；2) 每个 border pair 的
 *         upstream 流（我方后方补给岛）与 downstream 流（目标链）；
 *   流程——3) 按回合给每条链做「采集/攻占」查找表（第 t 回合能采集多少兵、攻占多少经济）；
 *         4) 用分组背包（同一 border pair 内互斥、跨组共用岛屿互斥）在回合预算里挑一组链，
 *         再把挑中的链物化成 GatherCapturePlan。
 *   参数——EN_CAP_VAL = 2.05（敌方每格经济价值，中立每格 1.0）；敌方每城额外 +6 经济；
 *         多等 2 回合采集，敌方每座活城多涨 1 兵（_get_effective_gathered_army）。
 *
 * 本文件只做一件事：把上面的流程照抄成 JS。渲染、logbook、viewInfo 全部删掉；
 * 诊断（FE_DIAG_* / _diag_* 一族）没有搬，因为它们的开关常量恒 False。
 *
 * 近似与取舍（都在正文对应位置留了注释）：
 *   1) 原版 materialize 用 Gather.GatherUtils.build_capture_mst_from_root_and_contiguous_tiles
 *      建「截获 MST」。本仓 gather.js 没移植它，所以在 findable 本文件里**自己逐行移植**了一份
 *      （_build_capture_mst_from_root_and_contiguous_tiles），包括它那套沿袭的 `thing` 优先级
 *      与沿树累加的 nextArmy。
 *   2) 原版 materialize 末尾对任何 plan 构建异常都 raise AssertionError（除了
 *      GATHER_CAPTURE_PLAN_NO_MOVE_ERROR）。JS 侧改成：单个计划失败就跳过并累计到
 *      this.last_run.materialize_failures，最后在 last_run 上留一行摘要；因为 JS 的
 *      GatherCapturePlan 与 Python 在「无可走招」边界上不保证逐字节一致，硬 raise 会让
 *      整局崩掉，而这一层的产物本来就只是候选计划。
 *   3) `_post_optimize_locally` 原版就是 `return baseline_solution` 的空壳，照抄。
 *   4) trade：原版 `use_simple_flow_stream_maximization` 恒 True，所以后优化永远不跑。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var flow = EK.flow || (EK.flow = {});

  // ---------------------------------------------------------------------------
  // 依赖解析
  // 本仓 eklipz 各文件之间没有 require：谁先加载谁挂 EK。所以这里一律在调用点解析，
  // 加载期不缓存任何引用（否则会拿到别人还没挂上去的 undefined）。
  // ---------------------------------------------------------------------------
  function req(name, value) {
    if (value === undefined || value === null) {
      throw new Error('flowexpansion.js 需要 ' + name + '，请检查加载顺序（flowmodels → flowgraph → flowmincost → flowknapsack → flowexpansion）');
    }
    return value;
  }

  function enCapVal() {
    var v = EK.ITERATIVE_EXPANSION_EN_CAP_VAL;
    if (v === undefined && EK.flow && EK.flow.ITERATIVE_EXPANSION_EN_CAP_VAL !== undefined) {
      v = EK.flow.ITERATIVE_EXPANSION_EN_CAP_VAL;
    }
    return v === undefined ? 2.05 : v;
  }

  // ---------------------------------------------------------------------------
  // Python 元组比较 / heapq 语义
  // 原版把所有优先队列元素都写成元组喂 heapq。CPython 的元组比较是「逐元素 ==，遇到不等
  // 立刻用该元素的 < 定胜负」。本文件里的队首元素都是纯数值或「数值 + 唯一 id」，
  // 所以只要逐项比数值就和 Python 完全等价（唯一 id 保证永远比不到对象那一项）。
  // ---------------------------------------------------------------------------
  function cmpNumArrays(a, b) {
    var n = a.length < b.length ? a.length : b.length;
    for (var i = 0; i < n; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length - b.length;
  }

  function PyHeap() {
    this._items = []; // {key: number[], val: any}
  }

  PyHeap.prototype.length = function () { return this._items.length; };
  PyHeap.prototype.peek = function () { return this._items.length ? this._items[0].val : null; };

  PyHeap.prototype.push = function (key, val) {
    var items = this._items;
    items.push({ key: key, val: val });
    this._siftdown(0, items.length - 1);
  };

  PyHeap.prototype.pop = function () {
    var items = this._items;
    var last = items.pop();
    if (!items.length) return last.val;
    var returnItem = items[0];
    items[0] = last;
    this._siftup(0);
    return returnItem.val;
  };

  PyHeap.prototype._siftdown = function (startpos, pos) {
    var items = this._items;
    var newitem = items[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = items[parentpos];
      if (cmpNumArrays(newitem.key, parent.key) < 0) {
        items[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    items[pos] = newitem;
  };

  PyHeap.prototype._siftup = function (pos) {
    var items = this._items;
    var endpos = items.length;
    var startpos = pos;
    var newitem = items[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      // CPython: 平局取右孩子，这条细节会改变出队顺序，必须照抄
      if (rightpos < endpos && cmpNumArrays(items[childpos].key, items[rightpos].key) >= 0) {
        childpos = rightpos;
      }
      items[pos] = items[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    items[pos] = newitem;
    this._siftdown(startpos, pos);
  };

  /*
   * 截获 MST 的堆：Python 那边元素是 `(thing, army, tile, fromTile, fromNode, fromDepth)`，
   * 而元组比较会在 `tile` 这一层「不可比」（两格 army 相等但 tile_index 不同时，
   * `==` 假、`<` 也假），直接终止比较；这跟纯数值的 cmpNumArrays 不是一回事，
   * 出队顺序会不同，所以单独给一个按 Python 元组语义比较的堆。
   */
  function pyTileLess(a, b) {
    var n = a.length < b.length ? a.length : b.length;
    for (var i = 0; i < n; i++) {
      var x = a[i];
      var y = b[i];
      if (x !== null && y !== null && x.tile_index !== undefined && y.tile_index !== undefined) {
        if (x.tile_index === y.tile_index) continue;
        // 元组比较到此为止：只按 army 定胜负，相等就是不可比（返回 false）
        return x.army < y.army;
      }
      if (x === y) continue;
      if (x === null || x === undefined) return true;
      if (y === null || y === undefined) return false;
      return x < y;
    }
    return false;
  }

  function PyTupleHeap() {
    this._items = [];
  }

  PyTupleHeap.prototype.length = function () { return this._items.length; };

  PyTupleHeap.prototype.push = function (val) {
    var items = this._items;
    items.push(val);
    var pos = items.length - 1;
    while (pos > 0) {
      var parentpos = (pos - 1) >> 1;
      if (pyTileLess(items[pos], items[parentpos])) {
        var tmp = items[pos]; items[pos] = items[parentpos]; items[parentpos] = tmp;
        pos = parentpos;
        continue;
      }
      break;
    }
  };

  PyTupleHeap.prototype.pop = function () {
    var items = this._items;
    if (!items.length) return null;
    var last = items.pop();
    if (!items.length) return last;
    var top = items[0];
    items[0] = last;
    var pos = 0;
    var endpos = items.length;
    var newitem = items[0];
    var childpos = 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      // CPython heapq：左不严格小于右时取右孩子，这条平局规则会改变出队顺序
      if (rightpos < endpos && !pyTileLess(items[childpos], items[rightpos])) childpos = rightpos;
      items[pos] = items[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    items[pos] = newitem;
    // 复刻 _siftdown(startpos=0, pos)
    while (pos > 0) {
      var parentpos2 = (pos - 1) >> 1;
      if (pyTileLess(items[pos], items[parentpos2])) {
        var tmp2 = items[pos]; items[pos] = items[parentpos2]; items[parentpos2] = tmp2;
        pos = parentpos2;
        continue;
      }
      break;
    }
    return top;
  };

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  function playerOf(tile) {
    // Python 里 tile.player 是属性；JS 的 EK.Tile 把它做成方法
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  function islandTiles(island) {
    return island.tile_set;
  }

  function borderIslands(island) {
    var b = island.border_islands;
    if (!b) return [];
    if (b._items) return b._items;
    if (Array.isArray(b)) return b;
    return [];
  }

  function safePerf(perfTimer, label) {
    if (perfTimer && typeof perfTimer.begin_move_event === 'function') {
      try { return perfTimer.begin_move_event(label); } catch (e) { return null; }
    }
    return null;
  }

  function endPerf(evt) {
    if (evt && typeof evt.end === 'function') { try { evt.end(); } catch (e) { /* 计时失败不影响决策 */ } }
  }

  function sumTilesArmy(expander, tileSet) {
    var total = 0;
    var it = tileSet.values();
    var step = it.next();
    while (!step.done) {
      total += expander._get_tile_army(step.value);
      step = it.next();
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // 数据类
  // ---------------------------------------------------------------------------
  function FlowBorderPairKey(friendlyIslandId, targetIslandId) {
    this.friendly_island_id = friendlyIslandId;
    this.target_island_id = targetIslandId;
    // Python 的 __hash__ = (7*a) ^ (37*b)；这里只用它当 Map 的键
    this.key = friendlyIslandId + '->' + targetIslandId;
  }
  FlowBorderPairKey.prototype.toString = function () { return this.key; };

  function FlowStreamIslandContribution(opts) {
    this.island_id = opts.island_id;
    this.is_friendly = !!opts.is_friendly;
    this.flow_node = opts.flow_node;
    this.tile_count = opts.tile_count;
    this.army_amount = opts.army_amount;
    this.marginal_flow = opts.marginal_flow;
    this.sort_score = opts.sort_score;
    this.is_crossing = !!opts.is_crossing;
    this.downstream_econ_potential = opts.downstream_econ_potential || 0.0;
    this.downstream_enemy_tile_potential = opts.downstream_enemy_tile_potential || 0;
    this.downstream_enemy_city_potential = opts.downstream_enemy_city_potential || 0;
    this.downstream_capture_army_potential = opts.downstream_capture_army_potential || 0;
    this.downstream_enemy_army_potential = opts.downstream_enemy_army_potential || 0;
  }

  function TargetStreamNodePotential() {
    this.gathered_upstream_army = 0;
    this.gathered_upstream_tile_count = 0;
    this.gathered_upstream_city_count = 0;
    this.captured_upstream_target_army = 0;
    this.captured_upstream_target_tile_count = 0;
    this.captured_upstream_target_city_count = 0;
    this.captured_upstream_neut_army = 0;
    this.captured_upstream_neut_tile_count = 0;
    this.captured_upstream_neut_city_count = 0;
    this.captured_upstream_econ_value = 0.0;

    this.gathered_downstream_army = 0;
    this.gathered_downstream_tile_count = 0;
    this.gathered_downstream_city_count = 0;
    this.captured_downstream_target_army = 0;
    this.captured_downstream_target_tile_count = 0;
    this.captured_downstream_target_city_count = 0;
    this.captured_downstream_neut_army = 0;
    this.captured_downstream_neut_tile_count = 0;
    this.captured_downstream_neut_city_count = 0;
    this.captured_downstream_econ_value = 0.0;
  }

  function FlowTurnsEntry(opts) {
    this.turns = opts.turns;
    this.required_army = opts.required_army;
    this.econ_value = opts.econ_value;
    this.army_remaining = opts.army_remaining === undefined ? 0 : opts.army_remaining;
    this.gathered_army = opts.gathered_army === undefined ? 0 : opts.gathered_army;
    this.included_friendly_flow_nodes = opts.included_friendly_flow_nodes || [];
    this.included_target_flow_nodes = opts.included_target_flow_nodes || [];
    this.incomplete_friendly_island_id = opts.incomplete_friendly_island_id === undefined ? null : opts.incomplete_friendly_island_id;
    this.incomplete_friendly_tile_count = opts.incomplete_friendly_tile_count === undefined ? 0 : opts.incomplete_friendly_tile_count;
    this.incomplete_target_island_id = opts.incomplete_target_island_id === undefined ? null : opts.incomplete_target_island_id;
    this.incomplete_target_tile_count = opts.incomplete_target_tile_count === undefined ? 0 : opts.incomplete_target_tile_count;
  }

  FlowTurnsEntry.prototype.with_econ_value = function (econValue) {
    return new FlowTurnsEntry({
      turns: this.turns,
      required_army: this.required_army,
      econ_value: econValue,
      army_remaining: this.army_remaining,
      gathered_army: this.gathered_army,
      included_friendly_flow_nodes: this.included_friendly_flow_nodes,
      included_target_flow_nodes: this.included_target_flow_nodes,
      incomplete_friendly_island_id: this.incomplete_friendly_island_id,
      incomplete_friendly_tile_count: this.incomplete_friendly_tile_count,
      incomplete_target_island_id: this.incomplete_target_island_id,
      incomplete_target_tile_count: this.incomplete_target_tile_count
    });
  };

  function ExternalPlanOption(plan, turns, econValue, tileSet, groupId) {
    this.plan = plan;
    this.turns = turns;
    this.econ_value = econValue;
    this.tile_set = tileSet;
    this.group_id = groupId;
  }

  function EnrichedFlowTurnsEntry(captureEntry, gatherEntry, gatherIndex, turns, density) {
    this.capture_entry = captureEntry;
    this.gather_entry = gatherEntry;
    this.gather_index = gatherIndex;
    this.turns = turns;
    this.combined_value_density = density;
  }

  function FlowArmyTurnsLookupTable(borderPair, captureEntries, gatherEntries, capturePrefix, gatherPrefix) {
    this.border_pair = borderPair;
    this.capture_entries_by_turn = captureEntries;
    this.gather_entries_by_turn = gatherEntries;
    this.best_capture_entries_prefix = capturePrefix;
    this.best_gather_entries_prefix = gatherPrefix;
    this.enriched_capture_entries = [];
  }

  // ---------------------------------------------------------------------------
  // ArmyFlowExpanderV2
  // ---------------------------------------------------------------------------
  function ArmyFlowExpanderV2(map, perfTimer) {
    this.map = map;
    this.perf_timer = perfTimer || null;
    this.team = map.team_ids_by_player_index[map.player_index];
    this.target_team = -1;
    this.friendlyGeneral = map.generals[map.player_index];
    this.enemyGeneral = null;
    this.island_builder = null;

    this.method = flow.FlowGraphMethod ? flow.FlowGraphMethod.OrToolsSimpleMinCost : 'OrToolsSimpleMinCost';
    this.use_simple_flow_stream_maximization = true;
    this.plan_solver = (EK.PlanSolver || flow.PlanSolver) ? (EK.PlanSolver || flow.PlanSolver).CpSat : 'CpSat';
    this.log_debug = false;
    this.debug_render_capture_count_threshold = 10000;
    this.use_debug_asserts = false;
    this.live_render_invalid_flow_config = null;

    this.flow_graph = null;
    this.last_run = EK.ArmyFlowExpanderLastRun ? new EK.ArmyFlowExpanderLastRun() : {};
    this.last_run.materialize_failures = this.last_run.materialize_failures || 0;
    this.last_lookup_tables = null;

    this._networkx_finder = null;
    this._pymax_finder = null;
    this._ortools_finder = null;

    this.use_backpressure_from_enemy_general = false;
    this._target_crossable_cache = new Set();
    this._flow_stream_node_potentials = null;
    this._flow_stream_node_potentials_graph = null;
    this._allow_neut_only_flow = false;

    this.bonus_capture_point_matrix = null;
    this.army_override_matrix = null;
    this.negative_tiles = null;
    this.threat_blocking_tiles = null;
    this.constrained_flow_paths = null;
    this.enemy_attack_path_tiles = null;

    this.debug_fake_escape_usage_by_island = {};
  }

  ArmyFlowExpanderV2.prototype.reset_for_turn = function (map, perfTimer) {
    this.map = map;
    this.perf_timer = perfTimer || null;
    this.team = map.team_ids_by_player_index[map.player_index];
    this.friendlyGeneral = map.generals[map.player_index] || this.friendlyGeneral;

    this.enemyGeneral = null;
    this.flow_graph = null;
    this.last_lookup_tables = null;
    this._target_crossable_cache = new Set();
    this._flow_stream_node_potentials = null;
    this._flow_stream_node_potentials_graph = null;
    this.bonus_capture_point_matrix = null;
    this.army_override_matrix = null;
    this.negative_tiles = null;
    this.threat_blocking_tiles = null;
    this.constrained_flow_paths = null;
    this.enemy_attack_path_tiles = null;
    this.debug_fake_escape_usage_by_island = {};

    // finder 实例留着（它的图数据可以跨回合复用），但要换掉回合相关状态
    var finders = [this._networkx_finder, this._pymax_finder, this._ortools_finder];
    for (var i = 0; i < finders.length; i++) {
      var f = finders[i];
      if (!f) continue;
      f.map = map;
      f.friendly_general = this.friendlyGeneral;
      if (typeof f.invalidate_cache === 'function') f.invalidate_cache();
    }
  };

  // ---------------------------------------------------------------------------
  // Phase 0：入口
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype.get_expansion_options = function (
    islands, asPlayer, targetPlayer, turns, boardAnalysis, territoryMap,
    negativeTiles, leafMoves, viewInfo, bonusCapturePointMatrix, perfTimer,
    cutoffTime, additionalOptions, armyOverrideMatrix, threatBlockingTiles,
    constrainedFlowPaths, enemyAttackPathTiles
  ) {
    if (perfTimer) this.perf_timer = perfTimer;

    this.target_team = this.map.team_ids_by_player_index[targetPlayer];
    if (this.enemyGeneral === null || this.enemyGeneral === undefined) {
      this.enemyGeneral = this.map.generals[targetPlayer] || null;
    }
    this.island_builder = islands;
    this.bonus_capture_point_matrix = bonusCapturePointMatrix || null;
    this.negative_tiles = negativeTiles || null;
    this.threat_blocking_tiles = threatBlockingTiles || null;
    this.constrained_flow_paths = constrainedFlowPaths || null;
    this.enemy_attack_path_tiles = enemyAttackPathTiles || null;
    // 原版只有在显式给了 override 矩阵时才覆盖，别把上一回合的残留带进来
    this.army_override_matrix = armyOverrideMatrix || null;

    var externalOptions = this._convert_additional_options_to_external(additionalOptions, turns);

    var evt = safePerf(this.perf_timer, 'FE_ENSURE_FLOW_GRAPH');
    this._ensure_flow_graph_exists(islands, turns, negativeTiles);
    endPerf(evt);

    if (!this.flow_graph) {
      // 流图建不出来（通常是没有可通向目标的边）：返回空集合，下游会当「这回合没 flow 计划」
      return this.build_plan_collection_with_calculated_stats([], turns);
    }

    var targetCrossable = this._detect_target_crossable_friendly_islands(islands, turns);
    var borderPairs = this._enumerate_border_pairs(islands, this.flow_graph, targetCrossable);

    var lookupTables = this._process_flow_into_flow_army_turns(borderPairs, this.flow_graph, targetCrossable, turns);
    this._postprocess_flow_stream_gather_capture_lookup_pairs(lookupTables);
    this.last_lookup_tables = lookupTables;

    var solution = this._solve_grouped_knapsack(lookupTables, turns, externalOptions);

    var plans = this._materialize_plans(solution);
    // 有调用方（预载脚本）靠这个排查「为什么一个计划都没产出」
    this.debug_stats = {
      border_pairs: borderPairs.length,
      lookup_tables: lookupTables.length,
      enriched: lookupTables.reduce(function (n, t) { return n + ((t.enriched_capture_entries || []).length); }, 0),
      external: externalOptions.length,
      solution: solution ? solution.size : 0,
      plans: plans.length,
      materialize_failures: (this.last_run && this.last_run.materialize_failures) || 0,
      materialize_errors: (this.last_run && this.last_run.materialize_errors) || [],
    };
    return this.build_plan_collection_with_calculated_stats(plans, turns);
  };

  ArmyFlowExpanderV2.prototype.build_plan_collection_with_calculated_stats = function (plans, turns) {
    var Ctor = EK.FlowExpansionPlanOptionCollection;
    if (!Ctor && EK.flow) Ctor = EK.flow.FlowExpansionPlanOptionCollection;
    req('EK.FlowExpansionPlanOptionCollection', Ctor);
    var collection = new Ctor();

    var teams = this.map.team_ids_by_player_index;
    var totalTurns = 0;
    var totalEcon = 0.0;
    var totalEnCaps = 0;
    var totalNeutCaps = 0;
    var totalEnCityCaps = 0;
    var totalNeutCityCaps = 0;
    var totalGatherTiles = 0;
    var totalGathered = 0;
    var trueTotalGathered = 0;
    var totalEnArmyCapped = 0;

    for (var p = 0; p < plans.length; p++) {
      var plan = plans[p];
      if (!plan) continue;
      totalTurns += plan.length === undefined ? 0 : plan.length;
      totalEcon += plan.econValue === undefined ? 0 : plan.econValue;

      var tileSet = plan.tileSet || plan.tiles || null;
      if (!tileSet) continue;
      var tiles = tileSet.values ? Array.from(tileSet.values()) : tileSet;
      for (var i = 0; i < tiles.length; i++) {
        var tile = tiles[i];
        var tileTeam = teams[playerOf(tile)];
        var army = this._get_tile_army(tile);
        if (tileTeam === this.team) {
          totalGatherTiles += 1;
          totalGathered += army - 1;
          trueTotalGathered += army - 1;
        } else {
          trueTotalGathered -= army + 1;
          if (tileTeam === this.target_team) {
            totalEnCaps += 1;
            if (tile.isCity) totalEnCityCaps += 1;
            totalEnArmyCapped += army;
          } else {
            totalNeutCaps += 1;
            if (tile.isCity) totalNeutCityCaps += 1;
          }
        }
      }
    }

    collection.expansion_options = plans;
    collection.total_turns = totalTurns;
    collection.total_econ = totalEcon;
    collection.total_en_caps = totalEnCaps;
    collection.total_neut_caps = totalNeutCaps;
    collection.total_en_city_caps = totalEnCityCaps;
    collection.total_neut_city_caps = totalNeutCityCaps;
    collection.total_gather_tiles = totalGatherTiles;
    collection.total_gathered = totalGathered;
    collection.true_total_gathered = trueTotalGathered;
    collection.total_en_army_capped = totalEnArmyCapped;

    // 原版这里 raise；JS 只做标记，免得整局因为一次超预算直接崩掉
    if (totalTurns > turns) collection.overflowed_turn_budget = true;
    return collection;
  };

  // ---------------------------------------------------------------------------
  // Phase 1：流图
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._get_flow_direction_finder = function (method) {
    if (method === undefined || method === null) method = this.method;
    var GM = flow.FlowGraphMethod || {};
    var isPyMax = (method === GM.PyMaxflowBoykovKolmogorov || method === GM.PyMaxflowWithNodeSplitting);
    if (isPyMax) {
      req('EK.flow.PyMaxFlowDirectionFinder', flow.PyMaxFlowDirectionFinder);
    }
    if (method === GM.OrToolsSimpleMinCost) {
      var Finder = req('EK.flow.OrToolsFlowDirectionFinder', flow.OrToolsFlowDirectionFinder);
      if (!this._ortools_finder) {
        this._ortools_finder = new Finder(this.map, this.island_builder.intergeneral_analysis,
          this.perf_timer, this.log_debug, this.use_backpressure_from_enemy_general,
          this.friendlyGeneral, this.live_render_invalid_flow_config);
      }
      this._ortools_finder.army_override_matrix = this.army_override_matrix;
      if (this._ortools_finder.threat_blocking_tiles !== this.threat_blocking_tiles) {
        this._ortools_finder.threat_blocking_tiles = this.threat_blocking_tiles;
        if (typeof this._ortools_finder.invalidate_cache === 'function') this._ortools_finder.invalidate_cache();
      }
      if (this._ortools_finder.constrained_flow_paths !== this.constrained_flow_paths) {
        this._ortools_finder.constrained_flow_paths = this.constrained_flow_paths;
        if (typeof this._ortools_finder.invalidate_cache === 'function') this._ortools_finder.invalidate_cache();
      }
      this._ortools_finder.configure(this.team, this.target_team, this.enemyGeneral);
      return this._ortools_finder;
    }
    if (isPyMax) {
      var PyFinder = flow.PyMaxFlowDirectionFinder;
      if (!this._pymax_finder) {
        this._pymax_finder = new PyFinder(this.map, this.island_builder.intergeneral_analysis,
          this.perf_timer, this.log_debug, this.use_backpressure_from_enemy_general,
          this.friendlyGeneral, this.live_render_invalid_flow_config);
      }
      this._pymax_finder.configure(this.team, this.target_team, this.enemyGeneral);
      return this._pymax_finder;
    }
    var NxFinder = req('EK.flow.NetworkXFlowDirectionFinder', flow.NetworkXFlowDirectionFinder);
    if (!this._networkx_finder) {
      this._networkx_finder = new NxFinder(this.map, this.island_builder.intergeneral_analysis,
        this.perf_timer, this.log_debug, this.use_backpressure_from_enemy_general,
        this.friendlyGeneral, this.live_render_invalid_flow_config);
    }
    this._networkx_finder.configure(this.team, this.target_team, this.enemyGeneral);
    return this._networkx_finder;
  };

  ArmyFlowExpanderV2.prototype._ensure_flow_graph_exists = function (islands, turns, negativeTiles) {
    var evt = safePerf(this.perf_timer, 'FE_ENSURE_FLOW_GRAPH_EXISTS');
    var finder = this._get_flow_direction_finder(this.method);
    var ourIslands = islands.tile_islands_by_player[this.map.player_index] || [];
    var targetIslands = islands.tile_islands_by_team_id[this.target_team] || [];

    this.flow_graph = finder.build_flow_graph(
      islands, ourIslands, targetIslands, this.map.player_index,
      turns, true /* blockGatherFromEnemyBorders */, negativeTiles,
      this._allow_neut_only_flow, this.method
    );
    if (this.flow_graph) {
      this.debug_fake_escape_usage_by_island = Object.assign({}, this.flow_graph.debug_fake_escape_usage_by_island || {});
      if (this.enemyGeneral === null || this.enemyGeneral === undefined) {
        this.enemyGeneral = finder.enemy_general || this.enemyGeneral;
      }
    }
    endPerf(evt);
  };

  ArmyFlowExpanderV2.prototype._lookupForNoNeut = function (flowGraph) {
    return flowGraph.flow_node_lookup_by_island_no_neut || new Map();
  };

  ArmyFlowExpanderV2.prototype._enumerate_border_pairs = function (islands, flowGraph, targetCrossableIslands) {
    var evt = safePerf(this.perf_timer, 'FE_ENUMERATE_BORDER_PAIRS');
    var noNeutLookup = this._lookupForNoNeut(flowGraph);
    var incNeutLookup = this._allow_neut_only_flow ? (flowGraph.flow_node_lookup_by_island_inc_neut || null) : null;

    var ourIslands = islands.tile_islands_by_team_id[this.team] || [];
    var islandsByUniqueId = islands.tile_islands_by_unique_id || {};
    var pairs = [];
    var seen = new Set();

    for (var i = 0; i < ourIslands.length; i++) {
      var friendlyIsland = ourIslands[i];
      if (!friendlyIsland) continue;
      if (targetCrossableIslands.has(friendlyIsland.unique_id)) continue;

      var lookups = [noNeutLookup];
      if (incNeutLookup) lookups.push(incNeutLookup);

      for (var li = 0; li < lookups.length; li++) {
        var friendlyNode = lookups[li].get(friendlyIsland.unique_id);
        if (!friendlyNode) continue;
        var edges = friendlyNode.flow_to || [];
        for (var ei = 0; ei < edges.length; ei++) {
          var edge = edges[ei];
          var targetIsland = edge.target_flow_node.island;
          // 己队但不可穿越的岛不是攻占目标（那是自己的地）
          if (targetIsland.team === this.team && !targetCrossableIslands.has(targetIsland.unique_id)) continue;
          if (targetIsland.team !== this.target_team && targetIsland.team !== -1) continue;
          var pairKey = friendlyIsland.unique_id + '->' + targetIsland.unique_id;
          if (this._is_blocked_by_threat_blocking_tiles_pair(friendlyIsland, targetIsland)) {
            // 原版这里 raise；威胁封锁只是「别从这条路走」，跳过比崩掉合理
            continue;
          }
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            pairs.push({
              pair: new FlowBorderPairKey(friendlyIsland.unique_id, targetIsland.unique_id),
              edgeArmySum: 0
            });
          }
          for (var pi = 0; pi < pairs.length; pi++) {
            if (pairs[pi].pair.key === pairKey) { pairs[pi].edgeArmySum += edge.edge_army; break; }
          }
        }
      }
    }

    // 原版按 (流量和, 目标岛 tile_count_all_adjacent_friendly) 降序；流量高的先建表，
    // 后面的组在背包里天然排前面，顺序会影响 conflict-resolution 的选择，所以必须保序。
    pairs.sort(function (a, b) {
      if (b.edgeArmySum !== a.edgeArmySum) return b.edgeArmySum - a.edgeArmySum;
      var ia = islandsByUniqueId[a.pair.target_island_id];
      var ib = islandsByUniqueId[b.pair.target_island_id];
      var ca = ia ? ia.tile_count_all_adjacent_friendly : 0;
      var cb = ib ? ib.tile_count_all_adjacent_friendly : 0;
      return cb - ca;
    });

    var result = pairs.map(function (p) { return p.pair; });
    endPerf(evt);
    return result;
  };

  ArmyFlowExpanderV2.prototype._is_blocked_by_threat_blocking_tiles_pair = function (friendlyIsland, targetIsland) {
    if (!this.threat_blocking_tiles) return false;
    var info = this.threat_blocking_tiles.get ? this.threat_blocking_tiles.get(friendlyIsland.tiles_by_army[0]) : null;
    if (!info) return false;
    var it = targetIsland.tile_set.values();
    var step = it.next();
    while (!step.done) {
      if (info.blocked_destinations && info.blocked_destinations.has && info.blocked_destinations.has(step.value)) return true;
      step = it.next();
    }
    return false;
  };

  ArmyFlowExpanderV2.prototype._is_blocked_by_threat_blocking_tiles = function (plan) {
    if (!this.threat_blocking_tiles) return false;
    var moves = [];
    if (typeof plan.get_move_list === 'function') {
      moves = plan.get_move_list() || [];
    }
    if (!moves.length && typeof plan.get_first_move === 'function') {
      var fm = plan.get_first_move();
      if (fm) moves = [fm];
    }
    for (var i = 0; i < moves.length; i++) {
      var move = moves[i];
      if (!move) continue;
      var blockInfo = this.threat_blocking_tiles.get ? this.threat_blocking_tiles.get(move.source) : null;
      if (!blockInfo) continue;
      if (blockInfo.blocked_destinations && blockInfo.blocked_destinations.has && blockInfo.blocked_destinations.has(move.dest)) {
        return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // target-crossable（「可以踩过去」的己方岛）
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._detect_target_crossable_friendly_islands = function (islands, turns) {
    var evt = safePerf(this.perf_timer, 'FE_DETECT_CROSSABLE');
    var ourTeamIslands = islands.tile_islands_by_team_id[this.team] || [];
    var that = this;

    var totalFriendlyTiles = 0;
    for (var i = 0; i < ourTeamIslands.length; i++) totalFriendlyTiles += ourTeamIslands[i].tile_count;
    var maxCrossableParentTiles = totalFriendlyTiles / 3;

    function isSmallEnough(island) {
      var parentTileCount = island.full_island ? island.full_island.tile_count : island.tile_count;
      return parentTileCount <= maxCrossableParentTiles;
    }

    function hasNoMoreArmyThanNeighboringEnemies(island) {
      var borderEnemyArmy = 0;
      var borders = borderIslands(island);
      for (var bi = 0; bi < borders.length; bi++) {
        if (borders[bi].team === that.target_team) borderEnemyArmy += borders[bi].sum_army;
      }
      return borderEnemyArmy >= island.sum_army;
    }

    var result = new Set();
    var noNeutLookup = this._lookupForNoNeut(this.flow_graph);
    var incNeutLookup = this._allow_neut_only_flow ? (this.flow_graph.flow_node_lookup_by_island_inc_neut || null) : null;

    function countFlowSources(island, lookup) {
      var node = lookup ? lookup.get(island.unique_id) : null;
      if (!node) return { nonFriendly: 0, friendly: 0 };
      var nonFriendly = 0;
      var friendly = 0;
      var edges = node.flow_from || [];
      for (var e = 0; e < edges.length; e++) {
        var srcIsland = edges[e].source_flow_node.island;
        if (srcIsland.team !== that.team) nonFriendly += 1;
        else friendly += 1;
      }
      return { nonFriendly: nonFriendly, friendly: friendly };
    }

    for (var a = 0; a < islands.all_tile_islands._items.length; a++) {
      var island = islands.all_tile_islands._items[a];
      if (!island || island.team !== this.team) continue;
      var counts = countFlowSources(island, noNeutLookup);
      var inc = incNeutLookup ? countFlowSources(island, incNeutLookup) : { nonFriendly: 0, friendly: 0 };
      var nonFriendly = counts.nonFriendly + inc.nonFriendly;
      var friendly = counts.friendly + inc.friendly;
      if (nonFriendly <= friendly) continue;
      if (!isSmallEnough(island)) continue;
      if (!hasNoMoreArmyThanNeighboringEnemies(island)) continue;
      result.add(island.unique_id);
    }

    // 传播：贴着敌方岛、且自身够小够弱的己方岛，只要能通过另一块 crossable 岛接过去，也算
    var changed = true;
    while (changed) {
      changed = false;
      for (var b = 0; b < islands.all_tile_islands._items.length; b++) {
        var isl = islands.all_tile_islands._items[b];
        if (!isl || isl.team !== this.team) continue;
        if (result.has(isl.unique_id)) continue;
        if (!isSmallEnough(isl)) continue;
        if (!hasNoMoreArmyThanNeighboringEnemies(isl)) continue;
        var borders = borderIslands(isl);
        var bordersEnemy = false;
        var bordersInSet = false;
        for (var c = 0; c < borders.length; c++) {
          if (borders[c].team === this.target_team) bordersEnemy = true;
          if (result.has(borders[c].unique_id)) bordersInSet = true;
        }
        if (bordersEnemy && bordersInSet) {
          result.add(isl.unique_id);
          changed = true;
        }
      }
    }

    this._target_crossable_cache = result;
    endPerf(evt);
    return result;
  };

  // ---------------------------------------------------------------------------
  // 数值访问器（army_override_matrix 在 JS 侧也可能被传进来）
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._get_tile_army = function (tile) {
    if (this.army_override_matrix) return this.army_override_matrix.raw[tile.tile_index];
    return tile.army;
  };

  ArmyFlowExpanderV2.prototype._get_island_army = function (island) {
    if (this.army_override_matrix) {
      var total = 0;
      var it = island.tile_set.values();
      var step = it.next();
      while (!step.done) { total += this.army_override_matrix.raw[step.value.tile_index]; step = it.next(); }
      return total;
    }
    return island.sum_army;
  };

  // ---------------------------------------------------------------------------
  // Phase 1.5：流势能（每个 flow_graph 只算一次）
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._get_or_compute_flow_stream_node_potentials = function (flowGraph, targetCrossableIslands) {
    if (this._flow_stream_node_potentials && this._flow_stream_node_potentials_graph === flowGraph) {
      return this._flow_stream_node_potentials;
    }
    var evt = safePerf(this.perf_timer, 'FE_PRECOMPUTE_NODE_POTENTIALS');
    var noNeutLookup = this._lookupForNoNeut(flowGraph);
    this._precompute_flow_stream_node_potentials(noNeutLookup, targetCrossableIslands);
    this._flow_stream_node_potentials_graph = flowGraph;
    endPerf(evt);
    return this._flow_stream_node_potentials;
  };

  ArmyFlowExpanderV2.prototype._precompute_flow_stream_node_potentials = function (lookup, targetCrossableIslands) {
    this._flow_stream_node_potentials = new Map();
    lookup.forEach(function (node, islandId) {
      this._flow_stream_node_potentials.set(islandId, new TargetStreamNodePotential());
    }, this);
    this.pre_process_flow_stream_upstream_potentials(lookup, targetCrossableIslands);
    this.pre_process_flow_stream_downstream_potentials(lookup, targetCrossableIslands);
  };

  ArmyFlowExpanderV2.prototype._get_or_create_node_potential = function (islandId) {
    var pot = this._flow_stream_node_potentials.get(islandId);
    if (!pot) {
      pot = new TargetStreamNodePotential();
      this._flow_stream_node_potentials.set(islandId, pot);
    }
    return pot;
  };

  ArmyFlowExpanderV2.prototype._accumulate_island_upstream = function (pot, island, targetCrossableIslands) {
    if (island.team === this.team) {
      pot.gathered_upstream_army += this._get_island_army(island);
      pot.gathered_upstream_tile_count += island.tile_count;
      var anyCityOrGeneral = false;
      var it = island.tile_set.values();
      var step = it.next();
      while (!step.done) {
        if (step.value.isCity || step.value.isGeneral) { anyCityOrGeneral = true; break; }
        step = it.next();
      }
      if (anyCityOrGeneral) pot.gathered_upstream_city_count += 1;
    } else if (island.team === this.target_team) {
      pot.captured_upstream_target_army += this._get_island_army(island);
      pot.captured_upstream_target_tile_count += island.tile_count;
      var enemyCity = false;
      var it2 = island.tile_set.values();
      var step2 = it2.next();
      while (!step2.done) { if (step2.value.isCity) { enemyCity = true; break; } step2 = it2.next(); }
      if (enemyCity) pot.captured_upstream_target_city_count += 1;
    } else if (island.team === -1) {
      pot.captured_upstream_neut_army += this._get_island_army(island);
      pot.captured_upstream_neut_tile_count += island.tile_count;
      var neutCity = false;
      var it3 = island.tile_set.values();
      var step3 = it3.next();
      while (!step3.done) { if (step3.value.isCity) { neutCity = true; break; } step3 = it3.next(); }
      if (neutCity) pot.captured_upstream_neut_city_count += 1;
    }
    pot.captured_upstream_econ_value += this._calculate_island_econ_value(island, targetCrossableIslands);
  };

  ArmyFlowExpanderV2.prototype._accumulate_island_downstream = function (pot, island, targetCrossableIslands) {
    if (island.team === this.team) {
      pot.gathered_downstream_army += this._get_island_army(island);
      pot.gathered_downstream_tile_count += island.tile_count;
      var anyCityOrGeneral = false;
      var it = island.tile_set.values();
      var step = it.next();
      while (!step.done) {
        if (step.value.isCity || step.value.isGeneral) { anyCityOrGeneral = true; break; }
        step = it.next();
      }
      if (anyCityOrGeneral) pot.gathered_downstream_city_count += 1;
    } else if (island.team === this.target_team) {
      pot.captured_downstream_target_army += this._get_island_army(island);
      pot.captured_downstream_target_tile_count += island.tile_count;
      var enemyCity = false;
      var it2 = island.tile_set.values();
      var step2 = it2.next();
      while (!step2.done) { if (step2.value.isCity) { enemyCity = true; break; } step2 = it2.next(); }
      if (enemyCity) pot.captured_downstream_target_city_count += 1;
    } else if (island.team === -1) {
      pot.captured_downstream_neut_army += this._get_island_army(island);
      pot.captured_downstream_neut_tile_count += island.tile_count;
      var neutCity = false;
      var it3 = island.tile_set.values();
      var step3 = it3.next();
      while (!step3.done) { if (step3.value.isCity) { neutCity = true; break; } step3 = it3.next(); }
      if (neutCity) pot.captured_downstream_neut_city_count += 1;
    }
    pot.captured_downstream_econ_value += this._calculate_island_econ_value(island, targetCrossableIslands);
  };

  ArmyFlowExpanderV2.prototype.pre_process_flow_stream_upstream_potentials = function (lookup, targetCrossableIslands) {
    // Kahn 拓扑：沿 flow_to 方向把「上游能提供什么」往前推
    var inDegree = new Map();
    var outEdges = new Map();
    var nodeById = new Map();
    lookup.forEach(function (node, islandId) {
      nodeById.set(islandId, node);
      inDegree.set(islandId, (node.flow_from || []).length);
      outEdges.set(islandId, node.flow_to || []);
    });

    var queue = [];
    nodeById.forEach(function (node, islandId) {
      if (inDegree.get(islandId) === 0) queue.push(islandId);
    });

    var visitedEdges = new Set();
    var head = 0;
    while (head < queue.length) {
      var curId = queue[head++];
      var curNode = nodeById.get(curId);
      var curPot = this._get_or_create_node_potential(curId);
      this._accumulate_island_upstream(curPot, curNode.island, targetCrossableIslands);

      var edges = outEdges.get(curId) || [];
      for (var i = 0; i < edges.length; i++) {
        var toId = edges[i].target_flow_node.island.unique_id;
        var toPot = this._get_or_create_node_potential(toId);
        toPot.gathered_upstream_army += curPot.gathered_upstream_army;
        toPot.gathered_upstream_tile_count += curPot.gathered_upstream_tile_count;
        toPot.gathered_upstream_city_count += curPot.gathered_upstream_city_count;
        toPot.captured_upstream_target_army += curPot.captured_upstream_target_army;
        toPot.captured_upstream_target_tile_count += curPot.captured_upstream_target_tile_count;
        toPot.captured_upstream_target_city_count += curPot.captured_upstream_target_city_count;
        toPot.captured_upstream_neut_army += curPot.captured_upstream_neut_army;
        toPot.captured_upstream_neut_tile_count += curPot.captured_upstream_neut_tile_count;
        toPot.captured_upstream_neut_city_count += curPot.captured_upstream_neut_city_count;
        toPot.captured_upstream_econ_value += curPot.captured_upstream_econ_value;

        visitedEdges.add(curId + '->' + toId);
        var toNode = nodeById.get(toId);
        if (!toNode) continue;
        var fromEdges = toNode.flow_from || [];
        var allSeen = true;
        for (var f = 0; f < fromEdges.length; f++) {
          if (!visitedEdges.has(fromEdges[f].source_flow_node.island.unique_id + '->' + toId)) { allSeen = false; break; }
        }
        if (allSeen) queue.push(toId);
      }
    }
  };

  ArmyFlowExpanderV2.prototype.pre_process_flow_stream_downstream_potentials = function (lookup, targetCrossableIslands) {
    // 镜像：沿 flow_from 反向把「下游能打到什么」往后推
    var outDegree = new Map();
    var inEdges = new Map();
    var nodeById = new Map();
    lookup.forEach(function (node, islandId) {
      nodeById.set(islandId, node);
      outDegree.set(islandId, (node.flow_to || []).length);
      inEdges.set(islandId, node.flow_from || []);
    });

    var queue = [];
    nodeById.forEach(function (node, islandId) {
      if (outDegree.get(islandId) === 0) queue.push(islandId);
    });

    var visitedEdges = new Set();
    var head = 0;
    while (head < queue.length) {
      var curId = queue[head++];
      var curNode = nodeById.get(curId);
      var curPot = this._get_or_create_node_potential(curId);
      this._accumulate_island_downstream(curPot, curNode.island, targetCrossableIslands);

      var edges = inEdges.get(curId) || [];
      for (var i = 0; i < edges.length; i++) {
        var fromId = edges[i].source_flow_node.island.unique_id;
        var fromPot = this._get_or_create_node_potential(fromId);
        fromPot.gathered_downstream_army += curPot.gathered_downstream_army;
        fromPot.gathered_downstream_tile_count += curPot.gathered_downstream_tile_count;
        fromPot.gathered_downstream_city_count += curPot.gathered_downstream_city_count;
        fromPot.captured_downstream_target_army += curPot.captured_downstream_target_army;
        fromPot.captured_downstream_target_tile_count += curPot.captured_downstream_target_tile_count;
        fromPot.captured_downstream_target_city_count += curPot.captured_downstream_target_city_count;
        fromPot.captured_downstream_neut_army += curPot.captured_downstream_neut_army;
        fromPot.captured_downstream_neut_tile_count += curPot.captured_downstream_neut_tile_count;
        fromPot.captured_downstream_neut_city_count += curPot.captured_downstream_neut_city_count;
        fromPot.captured_downstream_econ_value += curPot.captured_downstream_econ_value;

        visitedEdges.add(fromId + '->' + curId);
        var fromNode = nodeById.get(fromId);
        if (!fromNode) continue;
        var toEdges = fromNode.flow_to || [];
        var allSeen = true;
        for (var t = 0; t < toEdges.length; t++) {
          if (!visitedEdges.has(fromId + '->' + toEdges[t].target_flow_node.island.unique_id)) { allSeen = false; break; }
        }
        if (allSeen) queue.push(fromId);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Phase 1.6：经济价值
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._calculate_island_econ_value = function (island, targetCrossableIslands) {
    var isCrossing = targetCrossableIslands && targetCrossableIslands.has ? targetCrossableIslands.has(island.unique_id) : false;
    if (isCrossing) return 0.0;

    var baseValue;
    if (island.team === -1) baseValue = island.tile_count * 1.0;
    else if (island.team === this.target_team) baseValue = island.tile_count * enCapVal();
    else return 0.0;

    if (this.bonus_capture_point_matrix) {
      var it = island.tile_set.values();
      var step = it.next();
      while (!step.done) {
        baseValue += this.bonus_capture_point_matrix.raw[step.value.tile_index];
        step = it.next();
      }
    }
    return baseValue;
  };

  // ---------------------------------------------------------------------------
  // Phase 1.7：流构建
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._build_upstream_stream = function (startNode, targetCrossableIslands) {
    var stream = [];
    var visited = new Set();
    var heap = new PyHeap();
    var startIsland = startNode.island;
    if (startIsland.team === this.team) {
      var startHeuristic = startIsland.sum_army / Math.max(startIsland.tile_count, 1);
      heap.push([-startHeuristic, startIsland.unique_id, 0], { node: startNode, upstreamArmy: startIsland.sum_army });
      visited.add(startIsland.unique_id);
    }

    while (heap.length() > 0) {
      var item = heap.pop();
      var currentNode = item.node;
      var upstreamArmy = item.upstreamArmy;
      stream.push(currentNode);

      var edges = currentNode.flow_from || [];
      for (var i = 0; i < edges.length; i++) {
        var srcNode = edges[i].source_flow_node;
        var srcIsland = srcNode.island;
        if (visited.has(srcIsland.unique_id)) continue;
        if (srcIsland.team !== this.team) continue;
        var heuristic = srcIsland.sum_army / Math.max(srcIsland.tile_count, 1);
        var totalUpstreamArmy = upstreamArmy + srcIsland.sum_army;
        visited.add(srcIsland.unique_id);
        heap.push([-heuristic, srcIsland.unique_id, stream.length], { node: srcNode, upstreamArmy: totalUpstreamArmy });
      }
    }
    return stream;
  };

  ArmyFlowExpanderV2.prototype._build_downstream_stream = function (
    startNode, targetCrossableIslands, flowGraph, maxStreamSize, borderPair, nodePotentials
  ) {
    var that = this;
    var visited = new Set();
    visited.add(startNode.island.unique_id);
    var stream = [startNode];

    var heap = new PyHeap();
    var seq = 0;
    var flowLookup = this._lookupForNoNeut(flowGraph);
    var downstreamPotentials = nodePotentials || this._get_or_compute_flow_stream_node_potentials(flowGraph, targetCrossableIslands);

    function enqueueCandidate(destNode, routedFlowAmount, sourceKind) {
      var destIsland = destNode.island;
      if (visited.has(destIsland.unique_id)) return;

      var isTarget = destIsland.team === that.target_team ||
        destIsland.team === -1 ||
        (targetCrossableIslands.has && targetCrossableIslands.has(destIsland.unique_id));
      if (!isTarget) return;

      var econValue = that._calculate_island_econ_value(destIsland, targetCrossableIslands);
      var armySum = Math.max(that._get_island_army(destIsland), 1);
      var dp = downstreamPotentials.get(destIsland.unique_id);
      var dpEcon = dp ? dp.captured_downstream_econ_value : 0.0;
      var dpCities = dp ? dp.captured_downstream_target_city_count : 0;
      var dpEnemyTiles = dp ? dp.captured_downstream_target_tile_count : 0;

      var heuristic;
      if (routedFlowAmount > 0) {
        heuristic = routedFlowAmount * 1000 + dpEcon * 10 + dpCities * 250 + dpEnemyTiles;
      } else {
        heuristic = econValue / armySum + dpEcon + dpCities * 100 + dpEnemyTiles * 0.5;
      }

      seq += 1;
      heap.push([-heuristic, destIsland.unique_id, seq], { node: destNode, sourceKind: sourceKind });
    }

    function enqueueDownstream(node) {
      var routedDestinationIds = new Set();
      var edges = node.flow_to || [];
      for (var i = 0; i < edges.length; i++) {
        var edge = edges[i];
        routedDestinationIds.add(edge.target_flow_node.island.unique_id);
        enqueueCandidate(edge.target_flow_node, edge.edge_army, 'flow_to');
      }
      var fallbackKind = routedDestinationIds.size ? 'border_adj' : 'flowless_border_adj';
      var borders = borderIslands(node.island);
      for (var b = 0; b < borders.length; b++) {
        var neighborIsland = borders[b];
        if (visited.has(neighborIsland.unique_id)) continue;
        if (routedDestinationIds.has(neighborIsland.unique_id)) continue;
        var neighborNode = flowLookup.get(neighborIsland.unique_id);
        if (!neighborNode) continue;
        enqueueCandidate(neighborNode, 0, fallbackKind);
      }
    }

    enqueueDownstream(startNode);

    while (heap.length() > 0 && stream.length < maxStreamSize) {
      var item = heap.pop();
      var currentNode = item.node;
      if (visited.has(currentNode.island.unique_id)) continue;
      visited.add(currentNode.island.unique_id);
      stream.push(currentNode);
      enqueueDownstream(currentNode);
    }

    return { stream: stream, nodePotentials: downstreamPotentials };
  };

  ArmyFlowExpanderV2.prototype._build_border_pair_stream_data = function (
    borderPair, flowGraph, targetCrossableIslands, turnBudget, nodePotentials
  ) {
    var noNeutLookup = this._lookupForNoNeut(flowGraph);
    var incNeutLookup = this._allow_neut_only_flow ? (flowGraph.flow_node_lookup_by_island_inc_neut || null) : null;

    var friendlyNode = null;
    var targetNode = null;
    var lookups = [noNeutLookup];
    if (incNeutLookup) lookups.push(incNeutLookup);
    for (var li = 0; li < lookups.length; li++) {
      if (!friendlyNode) friendlyNode = lookups[li].get(borderPair.friendly_island_id) || null;
      if (!targetNode) targetNode = lookups[li].get(borderPair.target_island_id) || null;
    }
    if (!friendlyNode || !targetNode) return null;

    var friendlyStream = this._build_upstream_stream(friendlyNode, targetCrossableIslands);
    var downstream = this._build_downstream_stream(targetNode, targetCrossableIslands, flowGraph, turnBudget, borderPair, nodePotentials);
    var targetStream = downstream.stream;

    var econValuePotential = 0.0;
    var capArmyPotential = 0;
    for (var i = 0; i < targetStream.length; i++) {
      var ti = targetStream[i].island;
      econValuePotential += this._calculate_island_econ_value(ti, targetCrossableIslands);
      capArmyPotential += ti.sum_army + ti.tile_count;
    }

    var gatherTileCount = 0;
    var gatherArmySum = 0;
    for (var f = 0; f < friendlyStream.length; f++) {
      gatherTileCount += friendlyStream[f].island.tile_count;
      gatherArmySum += friendlyStream[f].island.sum_army;
    }

    return {
      friendly_stream: friendlyStream,
      target_stream: targetStream,
      target_node_potentials: downstream.nodePotentials,
      friendly_node: friendlyNode,
      target_node: targetNode,
      econ_value_potential: econValuePotential,
      cap_army_potential: capArmyPotential,
      gather_tile_count: gatherTileCount,
      gather_turns_potential: gatherTileCount - 1,
      gather_army_potential: gatherArmySum - gatherTileCount
    };
  };

  // ---------------------------------------------------------------------------
  // Phase 1.8：贡献度（谁先提供兵、谁先被打）
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._is_hard_negative_tile = function (tile) {
    if (!this.negative_tiles || !this.negative_tiles.has || !this.negative_tiles.has(tile)) return false;
    if (!this.threat_blocking_tiles) return true;
    return !(this.threat_blocking_tiles.has && this.threat_blocking_tiles.has(tile));
  };

  ArmyFlowExpanderV2.prototype._get_hard_negative_tiles = function () {
    if (!this.negative_tiles) return null;
    if (!this.threat_blocking_tiles) return this.negative_tiles;
    var out = new Set();
    var it = this.negative_tiles.values();
    var step = it.next();
    while (!step.done) {
      if (!(this.threat_blocking_tiles.has && this.threat_blocking_tiles.has(step.value))) out.add(step.value);
      step = it.next();
    }
    return out;
  };

  ArmyFlowExpanderV2.prototype._get_friendly_island_supply_army = function (island) {
    var armyAmount = 0;
    var it = island.tile_set.values();
    var step = it.next();
    while (!step.done) { armyAmount += this._get_tile_army(step.value); step = it.next(); }
    if (this.negative_tiles) {
      var it2 = island.tile_set.values();
      var step2 = it2.next();
      while (!step2.done) {
        if (this._is_hard_negative_tile(step2.value)) armyAmount -= this._get_tile_army(step2.value);
        step2 = it2.next();
      }
    }
    return armyAmount;
  };

  ArmyFlowExpanderV2.prototype._get_friendly_tile_gather_contribution = function (tile) {
    if (this._is_hard_negative_tile(tile)) return 0;
    return this._get_tile_army(tile) - 1;
  };

  ArmyFlowExpanderV2.prototype._compute_friendly_contributions = function (friendlyStream) {
    var contributions = [];
    for (var i = 0; i < friendlyStream.length; i++) {
      var node = friendlyStream[i];
      var armyAmount = this._get_friendly_island_supply_army(node.island);
      var tileCount = node.island.tile_count;
      var effectiveRatio = tileCount > 0 ? armyAmount / tileCount : 0.0;

      var flowMagnitude = 0;
      var edges = node.flow_to || [];
      for (var e = 0; e < edges.length; e++) flowMagnitude += edges[e].edge_army;

      var sortScore = effectiveRatio * 1000 + flowMagnitude * 0.1;
      contributions.push(new FlowStreamIslandContribution({
        island_id: node.island.unique_id,
        is_friendly: true,
        flow_node: node,
        tile_count: tileCount,
        army_amount: armyAmount,
        marginal_flow: Math.trunc(flowMagnitude),
        sort_score: sortScore,
        is_crossing: false
      }));
    }
    return contributions;
  };

  ArmyFlowExpanderV2.prototype._compute_target_contributions = function (targetStream, targetNodePotentials) {
    var contributions = [];
    for (var i = 0; i < targetStream.length; i++) {
      var node = targetStream[i];
      var island = node.island;
      var isCrossing = island.team === this.team && this._target_crossable_cache.has(island.unique_id);
      var armyCost = isCrossing ? 0 : this._get_island_army(island);
      var tileCount = island.tile_count;

      var armyPerTile = tileCount > 0 ? armyCost / tileCount : Infinity;
      var costScore = 1.0 / Math.max(0.1, armyPerTile);

      var typeBonus;
      if (isCrossing) typeBonus = 0.0;
      else if (island.team === this.target_team) typeBonus = enCapVal();
      else typeBonus = 1.0;

      var flowMagnitude = 0;
      var edges = node.flow_to || [];
      for (var e = 0; e < edges.length; e++) flowMagnitude += edges[e].edge_army;

      var nodePotential = targetNodePotentials ? targetNodePotentials.get(island.unique_id) : null;
      var dpEcon = 0.0, dpEnemyTiles = 0, dpCities = 0, dpCaptureArmy = 0, dpEnemyArmy = 0;
      if (nodePotential) {
        dpEcon = nodePotential.captured_downstream_econ_value;
        dpEnemyTiles = nodePotential.captured_downstream_target_tile_count;
        dpCities = nodePotential.captured_downstream_target_city_count;
        dpCaptureArmy = nodePotential.captured_downstream_target_army +
          nodePotential.captured_downstream_target_tile_count +
          nodePotential.captured_downstream_neut_army +
          nodePotential.captured_downstream_neut_tile_count;
        dpEnemyArmy = nodePotential.captured_downstream_target_army;
      }

      var sortScore = costScore + typeBonus + flowMagnitude * 0.1 + dpEcon + dpCities * 50 + dpEnemyTiles * 0.25;
      contributions.push(new FlowStreamIslandContribution({
        island_id: island.unique_id,
        is_friendly: isCrossing,
        flow_node: node,
        tile_count: tileCount,
        army_amount: armyCost,
        marginal_flow: Math.trunc(flowMagnitude),
        sort_score: sortScore,
        is_crossing: isCrossing,
        downstream_econ_potential: dpEcon,
        downstream_enemy_tile_potential: dpEnemyTiles,
        downstream_enemy_city_potential: dpCities,
        downstream_capture_army_potential: dpCaptureArmy,
        downstream_enemy_army_potential: dpEnemyArmy
      }));
    }
    return contributions;
  };

  ArmyFlowExpanderV2.prototype._preprocess_flow_stream_tilecounts = function (streamData) {
    var friendlyContributions = this._compute_friendly_contributions(streamData.friendly_stream);
    var targetContributions = this._compute_target_contributions(streamData.target_stream, streamData.target_node_potentials);

    // 采集侧按「自己先出谁」排序；攻占侧必须保留物理顺序——排序会把必经的中立格排到
    // 高价值敌格之后，产出根本无法走通的计划。
    friendlyContributions.sort(function (a, b) { return b.sort_score - a.sort_score; });
    return [friendlyContributions, targetContributions];
  };

  // ---------------------------------------------------------------------------
  // Phase 2：采集/攻占查找表
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._generate_capture_lookup_table = function (borderPair, targetContributions, streamData, turnBudget, prioMat) {
    var lookup = new Array(turnBudget + 1);
    for (var i = 0; i < lookup.length; i++) lookup[i] = null;
    lookup[0] = new FlowTurnsEntry({
      turns: 0, required_army: 0, econ_value: 0.0, army_remaining: 0, gathered_army: 0,
      included_friendly_flow_nodes: [], included_target_flow_nodes: [],
      incomplete_target_island_id: null, incomplete_target_tile_count: 0
    });

    var currentTurn = 0;
    var currentArmyCost = 0;
    var currentEconValue = 0.0;
    var includedTargetNodes = [];
    var maxTurns = turnBudget;

    for (var ci = 0; ci < targetContributions.length; ci++) {
      var node = targetContributions[ci].flow_node;
      var island = node.island;
      includedTargetNodes.push(node);

      var tiles = island.tiles_by_army;
      var i2 = 0;
      for (var t = 0; t < tiles.length; t++) {
        var tile = tiles[t];
        currentTurn += 1;
        if (currentTurn > turnBudget) break;
        i2 += 1;
        if (targetContributions[ci].is_crossing) {
          currentArmyCost -= this._get_tile_army(tile);
        } else {
          if (prioMat) currentEconValue += prioMat.raw[tile.tile_index];
          currentArmyCost += this._get_tile_army(tile);
          currentEconValue += (island.team === this.target_team ? enCapVal() : 1.0);
        }
        lookup[currentTurn] = new FlowTurnsEntry({
          turns: currentTurn,
          required_army: currentArmyCost + currentTurn,
          econ_value: currentEconValue,
          army_remaining: 0,
          gathered_army: 0,
          included_friendly_flow_nodes: [],
          included_target_flow_nodes: includedTargetNodes.slice(),
          incomplete_target_island_id: island.tile_count > i2 ? island.unique_id : null,
          incomplete_target_tile_count: i2 > 0 ? Math.max(island.tile_count - i2, 0) : island.tile_count
        });
      }
      if (currentTurn > maxTurns) break;
    }
    return lookup;
  };

  ArmyFlowExpanderV2.prototype._generate_gather_lookup_table = function (borderPair, friendlyContributions, streamData, turnBudget) {
    var lookup = new Array(turnBudget + 1);
    for (var z = 0; z < lookup.length; z++) lookup[z] = null;

    var contributionByIslandId = new Map();
    for (var c = 0; c < friendlyContributions.length; c++) {
      contributionByIslandId.set(friendlyContributions[c].island_id, friendlyContributions[c]);
    }

    var asPlayer = typeof this.friendlyGeneral.player === 'function' ? this.friendlyGeneral.player() : this.friendlyGeneral.player;
    var maxTurns = turnBudget;

    var startNode = streamData.friendly_node;
    if (!startNode) throw new Error('FE_GATHER_LOOKUP missing friendly_node');

    function queuePriority(node, depth) {
      var contribution = contributionByIslandId.get(node.island.unique_id);
      var score = contribution ? contribution.sort_score : 0.0;
      return score / Math.max(depth + 1, 1);
    }

    var heap = new PyHeap();
    var bfsVisited = new Set();
    var currentTurn = 0;
    var currentGatheredArmy = 0;
    var includedFriendlyNodes = [];
    var bfsSequence = 1;

    var initialDepth = startNode.island.tile_count - 1;
    heap.push([-queuePriority(startNode, initialDepth), initialDepth, startNode.island.unique_id, 0], {
      node: startNode, depth: initialDepth
    });

    while (heap.length() > 0) {
      var item = heap.pop();
      var node = item.node;
      var depth = item.depth;
      var island = node.island;
      if (bfsVisited.has(island.unique_id)) continue;
      if (depth > maxTurns) continue;
      bfsVisited.add(island.unique_id);

      var contribution = contributionByIslandId.get(island.unique_id);
      if (!contribution) throw new Error('FE_GATHER_LOOKUP missing contribution for island ' + island.unique_id);

      includedFriendlyNodes.push(node);

      var tiles = island.tiles_by_army;
      var reversed = [];
      for (var r = tiles.length - 1; r >= 0; r--) reversed.push(tiles[r]);
      var i = 0;
      var primaryTile = tiles[0];
      for (var t = 0; t < reversed.length; t++) {
        if (currentTurn > maxTurns) break;
        i += 1;
        var tileContribution = this._get_friendly_tile_gather_contribution(reversed[t]);
        currentGatheredArmy += tileContribution;
        if (tileContribution <= 0) { currentTurn += 1; continue; }
        // 原版判的是「岛上最高兵格的归属」而不是当前格——照抄，否则己方岛里混进队友
        // 将军格时两边会分叉
        if (playerOf(primaryTile) !== asPlayer) { currentTurn += 1; continue; }
        lookup[currentTurn] = new FlowTurnsEntry({
          turns: currentTurn,
          required_army: 0,
          econ_value: 0.0,
          army_remaining: 0,
          gathered_army: currentGatheredArmy,
          included_friendly_flow_nodes: includedFriendlyNodes.slice(),
          included_target_flow_nodes: [],
          incomplete_friendly_island_id: island.tile_count > i ? island.unique_id : null,
          incomplete_friendly_tile_count: island.tile_count - i
        });
        currentTurn += 1;
      }

      if (currentTurn > maxTurns) continue;

      var fromEdges = node.flow_from || [];
      for (var e = 0; e < fromEdges.length; e++) {
        var srcNode = fromEdges[e].source_flow_node;
        var srcIsland = srcNode.island;
        if (srcIsland.team !== this.team) continue;
        if (bfsVisited.has(srcIsland.unique_id)) continue;
        var nextDepth = depth + srcIsland.tile_count;
        bfsSequence += 1;
        heap.push([-queuePriority(srcNode, nextDepth), nextDepth, srcIsland.unique_id, bfsSequence], {
          node: srcNode, depth: nextDepth
        });
      }
    }

    return lookup;
  };

  ArmyFlowExpanderV2.prototype._build_prefix_table = function (lookup) {
    var prefix = new Array(lookup.length);
    var best = null;
    for (var i = 0; i < lookup.length; i++) {
      var entry = lookup[i];
      if (entry !== null && entry !== undefined) {
        if (best === null || (entry.econ_value > best.econ_value || entry.gathered_army > best.gathered_army)) {
          best = entry;
        }
      }
      prefix[i] = best;
    }
    return prefix;
  };

  ArmyFlowExpanderV2.prototype._process_flow_into_flow_army_turns = function (borderPairs, flowGraph, targetCrossableIslands, turnBudget) {
    var evt = safePerf(this.perf_timer, 'FE_PROCESS_FLOW_INTO_LOOKUPS');
    var lookupTables = [];
    var nodePotentials = this._get_or_compute_flow_stream_node_potentials(flowGraph, targetCrossableIslands);

    var streamDataByBorderPair = [];
    for (var i = 0; i < borderPairs.length; i++) {
      var borderPair = borderPairs[i];
      var streamData = this._build_border_pair_stream_data(borderPair, flowGraph, targetCrossableIslands, turnBudget, nodePotentials);
      if (!streamData) continue;
      streamDataByBorderPair.push({ pair: borderPair, data: streamData });
    }

    // 采集潜力大、目标链短的先建表：背包是顺序敏感的，顺序必须稳
    streamDataByBorderPair.sort(function (a, b) {
      var aTargetTiles = 0, bTargetTiles = 0;
      for (var x = 0; x < a.data.target_stream.length; x++) aTargetTiles += a.data.target_stream[x].island.tile_count;
      for (var y = 0; y < b.data.target_stream.length; y++) bTargetTiles += b.data.target_stream[y].island.tile_count;
      var av = a.data.gather_turns_potential / Math.max(aTargetTiles, 1);
      var bv = b.data.gather_turns_potential / Math.max(bTargetTiles, 1);
      return av - bv;
    });

    for (var s = 0; s < streamDataByBorderPair.length; s++) {
      var pair = streamDataByBorderPair[s].pair;
      var data = streamDataByBorderPair[s].data;

      var contribs = this._preprocess_flow_stream_tilecounts(data);
      var friendlyContribs = contribs[0];
      var targetContribs = contribs[1];

      var captureLookup = this._generate_capture_lookup_table(pair, targetContribs, data, turnBudget, this.bonus_capture_point_matrix);
      var gatherLookup = this._generate_gather_lookup_table(pair, friendlyContribs, data, turnBudget);

      lookupTables.push(new FlowArmyTurnsLookupTable(
        pair,
        captureLookup,
        gatherLookup,
        this._build_prefix_table(captureLookup),
        this._build_prefix_table(gatherLookup)
      ));
    }

    endPerf(evt);
    return lookupTables;
  };

  // ---------------------------------------------------------------------------
  // Phase 3：把攻占条目和采集条目配对
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._count_active_enemy_cities_in_capture_entry = function (captureEntry) {
    var activeCount = 0;
    var captureTurn = 0;
    var nodes = captureEntry.included_target_flow_nodes;
    for (var n = 0; n < nodes.length; n++) {
      var island = nodes[n].island;
      var tiles = island.tiles_by_army;
      for (var t = 0; t < tiles.length; t++) {
        captureTurn += 1;
        if (captureTurn > captureEntry.turns) return activeCount;
        if (island.team === this.target_team && tiles[t].isCity) activeCount += 1;
      }
    }
    return activeCount;
  };

  ArmyFlowExpanderV2.prototype._get_effective_gathered_army_for_capture_entry = function (captureEntry, gatherEntry) {
    var activeEnemyCityCount = this._count_active_enemy_cities_in_capture_entry(captureEntry);
    if (activeEnemyCityCount <= 0) return gatherEntry.gathered_army;
    // 敌方城每回合 +1 兵：多等 2 回合采集，每座活城吃掉 1 兵
    var delayedCityGrowthPenalty = activeEnemyCityCount * Math.floor(gatherEntry.turns / 2);
    return gatherEntry.gathered_army - delayedCityGrowthPenalty;
  };

  ArmyFlowExpanderV2.prototype._capture_entry_includes_enemy_city = function (captureEntry) {
    var nodes = captureEntry.included_target_flow_nodes;
    for (var n = 0; n < nodes.length; n++) {
      var island = nodes[n].island;
      if (island.team !== this.target_team) continue;
      var it = island.tile_set.values();
      var step = it.next();
      while (!step.done) {
        if (step.value.isCity) return true;
        step = it.next();
      }
    }
    return false;
  };

  ArmyFlowExpanderV2.prototype._find_all_gather_support_entries = function (captureEntry, gatherEntries) {
    var required = captureEntry.required_army;
    var out = [];
    for (var i = 0; i < gatherEntries.length; i++) {
      var gatherEntry = gatherEntries[i];
      if (!gatherEntry) continue;
      if (this._get_effective_gathered_army_for_capture_entry(captureEntry, gatherEntry) < required) continue;
      out.push(gatherEntry);
    }
    return out;
  };

  ArmyFlowExpanderV2.prototype._find_minimum_gather_support = function (captureEntry, gatherEntries) {
    var required = captureEntry.required_army;
    if (required <= 0) return gatherEntries[0];
    var best = null;
    var bestTurn = Infinity;
    for (var i = 0; i < gatherEntries.length; i++) {
      var gatherEntry = gatherEntries[i];
      if (!gatherEntry) continue;
      if (this._get_effective_gathered_army_for_capture_entry(captureEntry, gatherEntry) < required) continue;
      if (i >= bestTurn) continue;
      best = gatherEntry;
      bestTurn = i;
    }
    return best;
  };

  ArmyFlowExpanderV2.prototype._capture_entry_attacks_expected_enemy_path = function (captureEntry) {
    if (!this.enemy_attack_path_tiles) return false;
    var captureTurn = 0;
    var nodes = captureEntry.included_target_flow_nodes;
    for (var n = 0; n < nodes.length; n++) {
      var island = nodes[n].island;
      var tiles = island.tiles_by_army;
      for (var t = 0; t < tiles.length; t++) {
        captureTurn += 1;
        if (captureTurn > captureEntry.turns) return false;
        if (this.enemy_attack_path_tiles.has && this.enemy_attack_path_tiles.has(tiles[t])) return true;
      }
    }
    return false;
  };

  ArmyFlowExpanderV2.prototype._find_enemy_path_gather_support_entries = function (captureEntry, gatherEntries, minimumGatherSupport) {
    if (!minimumGatherSupport) return [];
    var maxGatherTurns = gatherEntries.length - 1 - captureEntry.turns;
    if (maxGatherTurns <= minimumGatherSupport.turns) return [minimumGatherSupport];

    var minimumEffective = this._get_effective_gathered_army_for_capture_entry(captureEntry, minimumGatherSupport);
    var candidates = [];
    for (var i = 0; i < gatherEntries.length; i++) {
      var gatherEntry = gatherEntries[i];
      if (!gatherEntry) continue;
      if (gatherEntry.turns <= minimumGatherSupport.turns) continue;
      if (gatherEntry.turns > maxGatherTurns) continue;
      var effective = this._get_effective_gathered_army_for_capture_entry(captureEntry, gatherEntry);
      if (effective < captureEntry.required_army) continue;
      var extraTurns = gatherEntry.turns - minimumGatherSupport.turns;
      var marginalArmy = effective - minimumEffective;
      if (marginalArmy < 8) continue;
      candidates.push({ density: marginalArmy / extraTurns, marginal: marginalArmy, entry: gatherEntry });
    }
    candidates.sort(function (a, b) {
      if (b.density !== a.density) return b.density - a.density;
      if (b.marginal !== a.marginal) return b.marginal - a.marginal;
      return b.entry.turns - a.entry.turns;
    });
    var supportEntries = [minimumGatherSupport];
    for (var c = 0; c < candidates.length && c < 2; c++) supportEntries.push(candidates[c].entry);
    return supportEntries;
  };

  ArmyFlowExpanderV2.prototype._calculate_enemy_path_over_gather_bonus = function (captureEntry, supportingGatherEntry, minimumGatherSupport) {
    if (!minimumGatherSupport || supportingGatherEntry.turns <= minimumGatherSupport.turns) return 0.0;
    if (!this._capture_entry_attacks_expected_enemy_path(captureEntry)) return 0.0;
    var effective = this._get_effective_gathered_army_for_capture_entry(captureEntry, supportingGatherEntry);
    var minimumEffective = this._get_effective_gathered_army_for_capture_entry(captureEntry, minimumGatherSupport);
    var marginalArmy = Math.max(0, effective - minimumEffective);
    return Math.min(4.0, marginalArmy * 0.1);
  };

  ArmyFlowExpanderV2.prototype._calculate_enemy_city_bonus_for_capture_entry = function (captureEntry, gatherEntry, captureEntries) {
    var stats = null;
    if (typeof this.map.get_team_stats_by_team_id === 'function') stats = this.map.get_team_stats_by_team_id(this.target_team);
    var enemyCityCount = stats && stats.cityCount !== undefined ? stats.cityCount : 0;
    if (enemyCityCount <= 0) return 0.0;

    var cityArmiesReached = [];
    var capturedEnemyCityCount = 0;
    var captureTurn = 0;
    var nodes = captureEntry.included_target_flow_nodes;
    for (var n = 0; n < nodes.length; n++) {
      var island = nodes[n].island;
      var tiles = island.tiles_by_army;
      for (var t = 0; t < tiles.length; t++) {
        var tile = tiles[t];
        captureTurn += 1;
        if (captureTurn > captureEntry.turns) break;
        if (!tile.isCity || island.team !== this.target_team) continue;
        capturedEnemyCityCount += 1;
        var requiredEntry = captureEntries[captureTurn];
        if (!requiredEntry) continue;
        var armyReachingCity = this._get_effective_gathered_army_for_capture_entry(captureEntry, gatherEntry) - requiredEntry.required_army;
        if (armyReachingCity > 0) cityArmiesReached.push(armyReachingCity);
      }
      if (captureTurn >= captureEntry.turns) break;
    }

    if (capturedEnemyCityCount <= 0) return 0.0;
    var flatCityCaptureBonus = 6.0 * capturedEnemyCityCount;
    if (!cityArmiesReached.length) return flatCityCaptureBonus;

    var sum = 0;
    for (var a = 0; a < cityArmiesReached.length; a++) sum += cityArmiesReached[a];
    var averageArmyReachingCity = sum / cityArmiesReached.length;
    var cityArmyBonus = Math.floor(averageArmyReachingCity / Math.max(0.2, enemyCityCount - 2));
    return flatCityCaptureBonus + cityArmyBonus;
  };

  ArmyFlowExpanderV2.prototype._postprocess_flow_stream_gather_capture_lookup_pairs = function (lookupTables) {
    var evt = safePerf(this.perf_timer, 'FE_POSTPROCESS_LOOKUPS');
    for (var lt = 0; lt < lookupTables.length; lt++) {
      var lookupTable = lookupTables[lt];
      var captureEntries = lookupTable.capture_entries_by_turn;
      var gatherEntries = lookupTable.gather_entries_by_turn;
      var enrichedCaptures = [];

      for (var captureTurn = 0; captureTurn < captureEntries.length; captureTurn++) {
        var captureEntry = captureEntries[captureTurn];
        if (!captureEntry || captureTurn === 0) continue;

        var minimumGatherSupport = null;
        var supportingGatherEntries;
        if (this._capture_entry_includes_enemy_city(captureEntry)) {
          supportingGatherEntries = this._find_all_gather_support_entries(captureEntry, gatherEntries);
        } else {
          minimumGatherSupport = this._find_minimum_gather_support(captureEntry, gatherEntries);
          if (this._capture_entry_attacks_expected_enemy_path(captureEntry)) {
            supportingGatherEntries = this._find_enemy_path_gather_support_entries(captureEntry, gatherEntries, minimumGatherSupport);
          } else {
            supportingGatherEntries = minimumGatherSupport ? [minimumGatherSupport] : [];
          }
        }

        if (!supportingGatherEntries || !supportingGatherEntries.length) {
          // 原版这里 break：后面的攻占条目只会更贵，不可能有支持
          break;
        }

        for (var sg = 0; sg < supportingGatherEntries.length; sg++) {
          var supporting = supportingGatherEntries[sg];
          var captureEconValue = captureEntry.econ_value +
            this._calculate_enemy_city_bonus_for_capture_entry(captureEntry, supporting, captureEntries);
          captureEconValue += this._calculate_enemy_path_over_gather_bonus(captureEntry, supporting, minimumGatherSupport);

          var turns = captureEntry.turns + supporting.turns;
          var density = turns > 0 ? captureEconValue / turns : 0.0;

          enrichedCaptures.push(new EnrichedFlowTurnsEntry(
            captureEntry.with_econ_value(captureEconValue),
            supporting,
            supporting.turns,
            turns,
            density
          ));
        }
      }
      lookupTable.enriched_capture_entries = enrichedCaptures;
    }
    endPerf(evt);
  };

  // ---------------------------------------------------------------------------
  // 外部计划（拦截等）并入
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._convert_additional_options_to_external = function (additionalOptions, turns) {
    var externalOptions = [];
    if (!additionalOptions || !additionalOptions.length) return externalOptions;
    var groupId = 1000000;

    for (var i = 0; i < additionalOptions.length; i++) {
      var opt = additionalOptions[i];
      if (!opt) continue;
      var requiredDelay = opt.requiredDelay === undefined ? 0 : opt.requiredDelay;
      var totalTurns = (opt.length === undefined ? 0 : opt.length) + requiredDelay;
      if (totalTurns > turns) continue;
      var econValue = opt.econValue === undefined ? 0 : opt.econValue;
      if (econValue <= 0) continue;
      if (this._is_blocked_by_threat_blocking_tiles(opt)) continue;

      var tileSet = new Set();
      if (opt.tileSet) {
        var src = opt.tileSet.values ? Array.from(opt.tileSet.values()) : opt.tileSet;
        for (var t = 0; t < src.length; t++) tileSet.add(src[t]);
      }
      externalOptions.push(new ExternalPlanOption(opt, totalTurns, econValue, tileSet, groupId));
      groupId += 1;
    }
    return externalOptions;
  };

  // ---------------------------------------------------------------------------
  // Phase 4：分组背包
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._solve_grouped_knapsack = function (lookupTables, turnBudget, externalOptions) {
    var evt = safePerf(this.perf_timer, 'FE_SOLVE_KNAPSACK');
    var Knap = (flow.GatherCaptureGroupKnapsacker) || null;
    var solveTilePlanOptions = (Knap && Knap.solve_tile_plan_options) || (EK.flow && EK.flow.solve_tile_plan_options);
    var solveGrouped = (Knap && Knap.solve_grouped_knapsack_input) || (EK.flow && EK.flow.solve_grouped_knapsack_input);
    var PlanSolver = EK.PlanSolver || flow.PlanSolver || { CpSat: 'CpSat', MkcpPlusGreedyConflictResolution: 'MkcpPlusGreedyConflictResolution' };

    var items = [];
    var groups = [];
    var weights = [];
    var values = [];
    var econValues = [];
    var friendlyIslandSets = [];
    var targetIslandSets = [];
    var itemTileSets = [];
    var isExternalItem = new Set();

    var goodLookupTables = [];
    var groupLookup = new Map();
    var groupSubsets = new Map();
    var groupIdx = 0;
    for (var i = 0; i < lookupTables.length; i++) {
      var lt = lookupTables[i];
      if (!lt.enriched_capture_entries || !lt.enriched_capture_entries.length) continue;
      goodLookupTables.push(lt);
      groupLookup.set(lt.border_pair.key, groupIdx);
      groupSubsets.set(groupIdx, [lt.border_pair.friendly_island_id, lt.border_pair.target_island_id]);
      groupIdx += 1;
    }

    goodLookupTables.sort(function (a, b) {
      return groupLookup.get(a.border_pair.key) - groupLookup.get(b.border_pair.key);
    });

    for (var g = 0; g < goodLookupTables.length; g++) {
      var table = goodLookupTables[g];
      var groupIndex = groupLookup.get(table.border_pair.key);
      for (var e = 0; e < table.enriched_capture_entries.length; e++) {
        var enriched = table.enriched_capture_entries[e];
        items.push(enriched);
        groups.push(groupIndex);
        weights.push(enriched.turns);
        values.push(Math.trunc(1000 * enriched.capture_entry.econ_value) - enriched.turns);
        econValues.push(enriched.capture_entry.econ_value);

        var friendlyIds = [];
        var fNodes = enriched.gather_entry.included_friendly_flow_nodes;
        for (var f = 0; f < fNodes.length; f++) friendlyIds.push(fNodes[f].island.unique_id);
        friendlyIslandSets.push(friendlyIds.slice().sort(function (a, b) { return a - b; }));

        var targetIds = [];
        var tNodes = enriched.capture_entry.included_target_flow_nodes;
        for (var tn = 0; tn < tNodes.length; tn++) targetIds.push(tNodes[tn].island.unique_id);
        targetIslandSets.push(targetIds.slice().sort(function (a, b) { return a - b; }));

        var tileIds = [];
        var allNodes = fNodes.concat(tNodes);
        for (var an = 0; an < allNodes.length; an++) {
          var isl = allNodes[an].island;
          var it = isl.tile_set.values();
          var step = it.next();
          while (!step.done) { tileIds.push(step.value.tile_index); step = it.next(); }
        }
        tileIds.sort(function (a, b) { return a - b; });
        itemTileSets.push(tileIds);
      }
    }

    if (externalOptions && externalOptions.length) {
      for (var x = 0; x < externalOptions.length; x++) {
        var ext = externalOptions[x];
        var idx = items.length;
        items.push(ext);
        groups.push(ext.group_id);
        weights.push(ext.turns);
        values.push(Math.trunc(1000 * ext.econ_value) - ext.turns);
        econValues.push(ext.econ_value);
        friendlyIslandSets.push([]);
        targetIslandSets.push([]);
        var extTileIds = [];
        var tilesArr = ext.tile_set.values ? Array.from(ext.tile_set.values()) : ext.tile_set;
        for (var et = 0; et < tilesArr.length; et++) extTileIds.push(tilesArr[et].tile_index);
        extTileIds.sort(function (a, b) { return a - b; });
        itemTileSets.push(extTileIds);
        isExternalItem.add(idx);
      }
    }

    var solution = new Map();
    if (!items.length) { endPerf(evt); return solution; }

    var chosenIndices = [];
    if (this.plan_solver !== PlanSolver.MkcpPlusGreedyConflictResolution) {
      var tilePlanOptions = [];
      for (var oi = 0; oi < items.length; oi++) {
        var optionTiles = new Set();
        var rawTileIds = itemTileSets[oi];
        for (var rt = 0; rt < rawTileIds.length; rt++) optionTiles.add(this.map.tiles_by_index[rawTileIds[rt]]);
        tilePlanOptions.push({
          item: items[oi],
          length: weights[oi],
          tileSet: optionTiles,
          econValue: econValues[oi]
        });
      }
      req('EK.flow.solve_tile_plan_options', solveTilePlanOptions);
      var tilePlanResult = solveTilePlanOptions(tilePlanOptions, turnBudget, this.plan_solver, enCapVal(), this.perf_timer);
      chosenIndices = tilePlanResult.chosen_indices || [];
      this._knapsack_dbg = {
        status: tilePlanResult.solver_status,
        max_value: tilePlanResult.max_value,
        chosen: chosenIndices.length,
        items: items.length,
        budget: turnBudget,
        max_weight: weights.length ? Math.max.apply(null, weights) : 0,
        min_weight: weights.length ? Math.min.apply(null, weights) : 0,
        max_value_item: values.length ? Math.max.apply(null, values) : 0,
        sample: values.slice(0, 5),
        sample_w: weights.slice(0, 5),
      };
    } else {
      req('EK.flow.solve_grouped_knapsack_input', solveGrouped);
      var groupedInput = {
        turn_budget: turnBudget,
        groups: groups,
        weights: weights,
        values: values,
        econ_values: econValues,
        friendly_island_sets: friendlyIslandSets,
        target_island_sets: targetIslandSets,
        item_tile_sets: itemTileSets,
        is_external_item: isExternalItem,
        max_iterations: 32
      };
      var groupedResult = solveGrouped(groupedInput, true);
      chosenIndices = groupedResult.chosen_indices || [];
    }

    for (var ci = 0; ci < chosenIndices.length; ci++) {
      var chosenIndex = chosenIndices[ci];
      var chosenItem = items[chosenIndex];
      if (isExternalItem.has(chosenIndex)) {
        solution.set('external_' + chosenItem.group_id, chosenItem);
        continue;
      }
      for (var lt2 = 0; lt2 < lookupTables.length; lt2++) {
        var table2 = lookupTables[lt2];
        var found = false;
        for (var ee = 0; ee < table2.enriched_capture_entries.length; ee++) {
          if (table2.enriched_capture_entries[ee] === chosenItem) { found = true; break; }
        }
        if (found) { solution.set(table2.border_pair.key, chosenItem); break; }
      }
    }

    endPerf(evt);
    return solution;
  };

  // ---------------------------------------------------------------------------
  // Phase 5：物化成 GatherCapturePlan
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._materialize_plans = function (solution) {
    if (!solution || !solution.size) return [];
    var evt = safePerf(this.perf_timer, 'FE_MATERIALIZE_PLANS');

    var plans = [];
    var planErrors = [];
    var asPlayer = typeof this.friendlyGeneral.player === 'function' ? this.friendlyGeneral.player() : this.friendlyGeneral.player;

    var keys = Array.from(solution.keys());
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var item = solution.get(key);

      if (item instanceof ExternalPlanOption) {
        if (item.plan) plans.push(item.plan);
        continue;
      }

      var enriched = item;
      var captureEntry = enriched.capture_entry;
      var gatherEntry = enriched.gather_entry;

      var gathing = new Set();
      var captureIslandIds = new Set();
      var tNodes = captureEntry.included_target_flow_nodes;
      for (var tn = 0; tn < tNodes.length; tn++) captureIslandIds.add(tNodes[tn].island.unique_id);

      var friendlyIslandIds = new Set();
      var fNodes = gatherEntry.included_friendly_flow_nodes;
      for (var fn = 0; fn < fNodes.length; fn++) friendlyIslandIds.add(fNodes[fn].island.unique_id);

      // 1) 采集侧：整岛收，或者按「离攻占边界最近」的连通块收部分格
      for (var gi = 0; gi < fNodes.length; gi++) {
        var island = fNodes[gi].island;
        var gatherableTiles = island.tile_set;
        if (island.team === this.team) {
          var hasOtherPlayer = false;
          var it0 = island.tile_set.values();
          var s0 = it0.next();
          while (!s0.done) { if (playerOf(s0.value) !== asPlayer) { hasOtherPlayer = true; break; } s0 = it0.next(); }
          if (hasOtherPlayer) {
            gatherableTiles = new Set();
            var it1 = island.tile_set.values();
            var s1 = it1.next();
            while (!s1.done) { if (!s1.value.isGeneral) gatherableTiles.add(s1.value); s1 = it1.next(); }
          }
        }

        if (gatherEntry.incomplete_friendly_island_id !== null &&
          island.unique_id === gatherEntry.incomplete_friendly_island_id) {
          var tilesToGather = island.tile_count - gatherEntry.incomplete_friendly_tile_count;
          if (tilesToGather <= 0) continue;
          var otherFriendly = new Set(friendlyIslandIds);
          otherFriendly.delete(island.unique_id);
          var partial = this._select_partial_gather_tiles(island, captureIslandIds, tilesToGather, otherFriendly, gathing);
          var pit = partial.values();
          var ps = pit.next();
          while (!ps.done) {
            if (gatherableTiles.has(ps.value)) gathing.add(ps.value);
            ps = pit.next();
          }
        } else {
          var git = gatherableTiles.values();
          var gs = git.next();
          while (!gs.done) { gathing.add(gs.value); gs = git.next(); }
        }
      }

      if (!gathing.size && this.island_builder) {
        var frIsland = this.island_builder.tile_islands_by_unique_id
          ? this.island_builder.tile_islands_by_unique_id[solutionKeyFriendlyId(key)]
          : null;
        if (frIsland) {
          var fit = frIsland.tile_set.values();
          var fs = fit.next();
          while (!fs.done) { gathing.add(fs.value); fs = fit.next(); }
        }
      }
      if (gathing.size) {
        var connectedGathing = this._connect_allied_gather_components_to_owned_tiles(gathing, asPlayer);
        if (!connectedGathing.size) { planErrors.push({ key: key, error: 'gathing disconnected' }); continue; }
        gathing = connectedGathing;
      }

      // 2) 攻占侧：己队的 crossable 岛是过路采集，不算攻占
      var capping = new Set();
      for (var tni = 0; tni < tNodes.length; tni++) {
        var tIsland = tNodes[tni].island;
        if (tIsland.team === this.team) {
          var tit = tIsland.tile_set.values();
          var ts = tit.next();
          while (!ts.done) { if (!ts.value.isGeneral) gathing.add(ts.value); ts = tit.next(); }
          continue;
        }
        if (captureEntry.incomplete_target_island_id !== null &&
          tIsland.unique_id === captureEntry.incomplete_target_island_id) {
          var tilesToCapture = tIsland.tile_count - captureEntry.incomplete_target_tile_count;
          if (tilesToCapture <= 0) continue;
          var friendlyForSelection = new Set(gathing);
          var cit = capping.values();
          var cs = cit.next();
          while (!cs.done) { friendlyForSelection.add(cs.value); cs = cit.next(); }
          var partialCapture = this._select_partial_capture_tiles(tIsland, friendlyForSelection, tilesToCapture);
          var pct = partialCapture.values();
          var pcs = pct.next();
          while (!pcs.done) { capping.add(pcs.value); pcs = pct.next(); }
        } else {
          var fullIt = tIsland.tile_set.values();
          var fstep = fullIt.next();
          while (!fstep.done) { capping.add(fstep.value); fstep = fullIt.next(); }
        }
      }
      if (gathing.size) {
        var connected2 = this._connect_allied_gather_components_to_owned_tiles(gathing, asPlayer);
        if (!connected2.size) { planErrors.push({ key: key, error: 'gathing disconnected 2' }); continue; }
        gathing = connected2;
      }

      if (!gathing.size && !capping.size) { planErrors.push({ key: key, error: 'no tiles' }); continue; }

      // 3) 根节点取「离敌方将军最远的攻占格」：从它们往回收兵，才推得动整条链
      var genDistsRaw = this.island_builder.intergeneral_analysis.aMap.raw;
      var furthestTiles = new Set();
      if (gathing.size && capping.size) {
        var cit2 = capping.values();
        var ct = cit2.next();
        while (!ct.done) {
          var t = ct.value;
          var isFurthest = true;
          var movables = t.movable || [];
          for (var mi = 0; mi < movables.length; mi++) {
            var adj = movables[mi];
            if (capping.has(adj) && genDistsRaw[t.tile_index] < genDistsRaw[adj.tile_index]) { isFurthest = false; break; }
          }
          if (isFurthest) furthestTiles.add(t);
          ct = cit2.next();
        }
      }
      var rootTiles = furthestTiles.size ? furthestTiles : gathing;

      try {
        var plan = this._build_gather_capture_plan(rootTiles, gathing, capping, asPlayer);
        if (!plan) { planErrors.push({ key: key, error: 'null plan' }); continue; }
        plan._turns = enriched.turns;
        plan.econValue = captureEntry.econ_value;
        plans.push(plan);
      } catch (err) {
        planErrors.push({ key: key, error: err && err.message ? err.message : String(err) });
        continue;
      }
    }

    this.last_run.materialize_failures = planErrors.length;
    this.last_run.materialize_attempts = solution.size;
    this.last_run.materialize_errors = planErrors.slice(0, 4);
    endPerf(evt);
    return plans;
  };

  function solutionKeyFriendlyId(key) {
    var idx = String(key).indexOf('->');
    if (idx < 0) return -1;
    return parseInt(String(key).slice(0, idx), 10);
  }

  /*
   * 截获 MST：Gather\GatherUtils.py:741-945 的逐行移植。
   *
   * 为什么不能直接用 gather.build_mst_from_root_and_contiguous_tiles：普通 MST 只走
   * 最短连接，而原版这棵树的优先级是 `(thing - dist_t) / 2`，`thing` 会随路径沿袭，
   * 树会为了「顺路多截获高价值敌格」而故意偏航，同时 `nextArmy` 沿树累加负值。
   * 计划里的兵力走向与 gathered_army 都由这棵树决定，不照搬就对不上原版。
   */
  ArmyFlowExpanderV2.prototype._build_capture_mst_from_root_and_contiguous_tiles =
    function (tiles, searchingPlayer, intergeneralAnalysis) {
      var map = this.map;
      var teams = map.team_ids_by_player_index;
      var searchingTeam = teams[searchingPlayer];
      var mapMatrixCtor = req('EK.MapMatrix', EK.MapMatrix);

      var dists = new mapMatrixCtor(map, undefined);
      var genDistsRaw = intergeneralAnalysis && intergeneralAnalysis.aMap
        ? intergeneralAnalysis.aMap.raw
        : new Array(map.tiles_by_index.length).fill(0);

      // 找「离敌方将军最远的攻占格」当根：它的邻居里没有比自己更远的（同样是敌/中立）才算
      var allFurthestTiles = [];
      var tileIt = tiles.values();
      var tileStep = tileIt.next();
      while (!tileStep.done) {
        var t = tileStep.value;
        var tPlayer = playerOf(t);
        if (tPlayer >= 0 && teams[tPlayer] === searchingTeam) { tileStep = tileIt.next(); continue; }
        var isFurthest = true;
        var movables = t.movable || [];
        for (var mi = 0; mi < movables.length; mi++) {
          var adj = movables[mi];
          var adjPlayer = playerOf(adj);
          if ((adjPlayer < 0 || teams[adjPlayer] !== searchingTeam)
              && genDistsRaw[t.tile_index] < genDistsRaw[adj.tile_index]
              && tiles.has(adj)) {
            isFurthest = false;
            break;
          }
        }
        if (isFurthest) allFurthestTiles.push(t);
        tileStep = tileIt.next();
      }

      if (!allFurthestTiles.length) {
        throw new Error('build_capture_mst_from_root_and_contiguous_tiles 没有可用的根格');
      }
      // sorted(..., key=genDists, reverse=True)[0]：距离最大者，平手取遍历序靠前者
      var startTile = allFurthestTiles[0];
      for (var fi = 1; fi < allFurthestTiles.length; fi++) {
        if (genDistsRaw[allFurthestTiles[fi].tile_index] > genDistsRaw[startTile.tile_index]) {
          startTile = allFurthestTiles[fi];
        }
      }

      // 从根在 tiles 内 BFS 出每格到根的步数；顺便验证输入的连通性
      var qq = [startTile];
      var qqDist = [0];
      var qqHead = 0;
      var unvisited = new Set(tiles);
      var maxDist = -1;
      while (qqHead < qq.length) {
        var curTile = qq[qqHead];
        var curDist = qqDist[qqHead];
        qqHead++;
        if (dists.raw[curTile.tile_index] !== undefined && dists.raw[curTile.tile_index] !== null) continue;
        unvisited.delete(curTile);
        dists.raw[curTile.tile_index] = curDist;
        if (curDist > maxDist) maxDist = curDist;
        var curMovables = curTile.movable || [];
        for (var ci = 0; ci < curMovables.length; ci++) {
          var nxt = curMovables[ci];
          if (tiles.has(nxt)) { qq.push(nxt); qqDist.push(curDist + 1); }
        }
      }

      if (unvisited.size) {
        // 原版在 allowReconnection=False 时直接抛；这里保持同样的响亮失败
        throw new Error('the input tiles were not fully connected to one another (' + unvisited.size + ' disconnected)');
      }
      var patchIt = tiles.values();
      var patchStep = patchIt.next();
      while (!patchStep.done) {
        if (dists.raw[patchStep.value.tile_index] === undefined || dists.raw[patchStep.value.tile_index] === null) {
          dists.raw[patchStep.value.tile_index] = maxDist;
        }
        patchStep = patchIt.next();
      }

      var GatherTreeNodeCtor = req('EK.GatherTreeNode', EK.GatherTreeNode);
      var q = new PyTupleHeap();
      q.push([-genDistsRaw[startTile.tile_index], 0 - startTile.army, startTile, null, null, 0]);
      if (!q.length()) return [];

      var nodes = [];
      var visitedNodes = new mapMatrixCtor(map, undefined);
      while (q.length()) {
        var entry = q.pop();
        var thing = entry[0];
        var army = entry[1];
        var tile = entry[2];
        var fromTile = entry[3];
        var fromNode = entry[4];
        var fromDepth = entry[5];

        if (visitedNodes.raw[tile.tile_index] !== undefined && visitedNodes.raw[tile.tile_index] !== null) continue;

        var node = new GatherTreeNodeCtor(tile, fromTile);
        node.gatherTurns = fromDepth;
        visitedNodes.raw[tile.tile_index] = node;
        node.data = army;
        nodes.push(node);

        if (fromNode) {
          fromNode.children.push(node);
          node.toGather = fromNode;
        }

        var tmovables = tile.movable || [];
        for (var ti = 0; ti < tmovables.length; ti++) {
          var nt = tmovables[ti];
          if (!tiles.has(nt)) continue;
          var ntPlayer = playerOf(nt);
          var nextArmy = teams[ntPlayer] !== searchingTeam ? army + 0 - nt.army : army + nt.army;
          nextArmy -= 1;
          var distT = dists.raw[nt.tile_index];
          var priority = (distT === undefined || distT === null) ? thing / 2 : (thing - distT) / 2;
          q.push([priority, nextArmy, nt, tile, node, fromDepth + 1]);
        }
      }

      var roots = [];
      for (var ni = 0; ni < nodes.length; ni++) {
        if (nodes[ni].toTile === null || nodes[ni].toTile === undefined) roots.push(nodes[ni]);
      }
      return roots;
    };

  ArmyFlowExpanderV2.prototype._build_gather_capture_plan = function (rootTiles, gathing, capping, asPlayer) {
    // Gather\GatherUtils.py:420 convert_contiguous_capture_tiles_to_gather_capture_plan
    var PlanCtor = req('EK.GatherCapturePlan', EK.GatherCapturePlan);

    var allTiles = new Set(gathing);
    var capIt = capping.values();
    var capStep = capIt.next();
    while (!capStep.done) { allTiles.add(capStep.value); capStep = capIt.next(); }

    var rootNodes = this._build_capture_mst_from_root_and_contiguous_tiles(
      allTiles, asPlayer, this.island_builder ? this.island_builder.intergeneral_analysis : null);

    var plan = PlanCtor.build_from_root_nodes(
      this.map,
      rootNodes,
      this._get_hard_negative_tiles(),
      asPlayer,
      true /* onlyCalculateFriendlyArmy = not useTrueValueGathered */,
      null /* priorityMatrix */,
      false /* includeGatherPriorityAsEconValues */,
      true /* includeCapturePriorityAsEconValues */,
      capping,
      null /* viewInfo */,
      false /* cloneNodes */,
      null /* tilesToHalf */,
      this.island_builder ? this.island_builder.intergeneral_analysis : null
    );

    if (plan) {
      var friendlyTeam = this.map.team_ids_by_player_index[asPlayer];
      var frTiles = [];
      var ait = allTiles.values();
      var astep = ait.next();
      while (!astep.done) {
        if (this.map.team_ids_by_player_index[playerOf(astep.value)] === friendlyTeam) frTiles.push(astep.value);
        astep = ait.next();
      }
      var gatheredArmy = 0;
      for (var i = 0; i < frTiles.length; i++) gatheredArmy += frTiles[i].army;
      plan.gathered_army = gatheredArmy - frTiles.length;

      // 原版在这里硬断言：造出来的计划必须至少有一招，否则说明上游算错了
      if (typeof plan.get_first_move === 'function' && plan.get_first_move() === null) {
        throw new Error('GATHER_CAPTURE_PLAN_NO_MOVE_ERROR plan created with no moves');
      }
    }
    return plan;
  };


  // ---------------------------------------------------------------------------
  // 采集连通性：把「和我们现有地块不相连的己方采集块」接回家
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._find_owned_entry_path_for_allied_gather = function (gatherTiles, asPlayer) {
    if (!gatherTiles || !gatherTiles.size) return new Set();

    var queue = [];
    var visited = new Set();
    var parentByTile = new Map();

    var it = gatherTiles.values();
    var step = it.next();
    while (!step.done) {
      queue.push(step.value);
      visited.add(step.value);
      parentByTile.set(step.value, null);
      step = it.next();
    }

    var head = 0;
    while (head < queue.length) {
      var tile = queue[head++];
      if (playerOf(tile) === asPlayer) {
        var path = new Set();
        var cur = tile;
        while (cur) {
          path.add(cur);
          cur = parentByTile.get(cur);
        }
        return path;
      }
      var movables = tile.movable || [];
      for (var i = 0; i < movables.length; i++) {
        var adj = movables[i];
        if (visited.has(adj)) continue;
        var adjPlayer = playerOf(adj);
        if (adjPlayer < 0) continue;
        if (this.map.team_ids_by_player_index[adjPlayer] !== this.team) continue;
        if (adjPlayer !== asPlayer && adj.isGeneral) continue;
        visited.add(adj);
        parentByTile.set(adj, tile);
        queue.push(adj);
      }
    }
    return new Set();
  };

  ArmyFlowExpanderV2.prototype._connect_allied_gather_components_to_owned_tiles = function (gatherTiles, asPlayer) {
    if (!gatherTiles || !gatherTiles.size) return new Set();

    var remaining = new Set(gatherTiles);
    var connectedTiles = new Set(gatherTiles);

    while (remaining.size) {
      var component = new Set();
      var first = remaining.values().next().value;
      remaining.delete(first);
      var queue = [first];
      var head = 0;
      while (head < queue.length) {
        var tile = queue[head++];
        component.add(tile);
        var movables = tile.movable || [];
        for (var i = 0; i < movables.length; i++) {
          var adj = movables[i];
          if (remaining.has(adj)) {
            remaining.delete(adj);
            queue.push(adj);
          }
        }
      }

      var hasOwned = false;
      var cit = component.values();
      var cs = cit.next();
      while (!cs.done) { if (playerOf(cs.value) === asPlayer) { hasOwned = true; break; } cs = cit.next(); }
      if (hasOwned) continue;

      var entryPath = this._find_owned_entry_path_for_allied_gather(component, asPlayer);
      if (!entryPath.size) return new Set();
      var eit = entryPath.values();
      var es = eit.next();
      while (!es.done) { connectedTiles.add(es.value); es = eit.next(); }
    }

    return connectedTiles;
  };

  // ---------------------------------------------------------------------------
  // 部分攻占：从「贴着己方的入口格」往岛内 BFS，取前 N 格
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._select_partial_capture_tiles = function (island, friendlyTiles, tilesToCapture) {
    if (tilesToCapture >= island.tile_count) return new Set(island.tile_set);
    if (tilesToCapture <= 0) return new Set();

    var entryPoints = new Set();
    var it = island.tile_set.values();
    var step = it.next();
    while (!step.done) {
      var tile = step.value;
      var movables = tile.movable || [];
      for (var i = 0; i < movables.length; i++) {
        if (friendlyTiles.has(movables[i])) { entryPoints.add(tile); break; }
      }
      step = it.next();
    }
    if (!entryPoints.size) {
      var it2 = island.tile_set.values();
      var s2 = it2.next();
      while (!s2.done) { entryPoints.add(s2.value); s2 = it2.next(); }
    }

    var entry = minByXY(entryPoints);
    var queue = [[entry, 0]];
    var distances = new Map();
    distances.set(entry, 0);
    var selected = new Set();
    var head = 0;

    while (head < queue.length && selected.size < tilesToCapture) {
      var pair = queue[head++];
      var t = pair[0];
      var dist = pair[1];
      selected.add(t);
      var mov = t.movable || [];
      for (var m = 0; m < mov.length; m++) {
        var neighbor = mov[m];
        if (!island.tile_set.has(neighbor)) continue;
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, dist + 1);
        queue.push([neighbor, dist + 1]);
      }
    }
    return selected;
  };

  function minByXY(tileSet) {
    var best = null;
    var it = tileSet.values();
    var step = it.next();
    while (!step.done) {
      var t = step.value;
      if (best === null || t.x < best.x || (t.x === best.x && t.y < best.y)) best = t;
      step = it.next();
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // 部分采集：从「贴着攻占岛 / 采集链相邻岛」的出口格往岛内 BFS
  // ---------------------------------------------------------------------------
  ArmyFlowExpanderV2.prototype._select_partial_gather_tiles = function (island, captureIslandIds, tilesToGather, otherFriendlyIslandIds, connectedTiles) {
    if (tilesToGather >= island.tile_count) return new Set(island.tile_set);
    if (tilesToGather <= 0) return new Set();

    var lookup = this.island_builder.tile_island_lookup;
    var connectedExitPoints = new Set();
    var exitPoints = new Set();

    var it = island.tile_set.values();
    var step = it.next();
    while (!step.done) {
      var tile = step.value;
      var movables = tile.movable || [];
      for (var i = 0; i < movables.length; i++) {
        var neighbor = movables[i];
        var neighborIsland = lookup.raw[neighbor.tile_index];
        if (!neighborIsland) continue;
        if (connectedTiles && connectedTiles.has && connectedTiles.has(neighbor)) {
          connectedExitPoints.add(tile);
          break;
        }
        if (captureIslandIds.has(neighborIsland.unique_id)) { exitPoints.add(tile); break; }
        if (otherFriendlyIslandIds && otherFriendlyIslandIds.has(neighborIsland.unique_id)) { exitPoints.add(tile); break; }
      }
      step = it.next();
    }

    if (connectedExitPoints.size) exitPoints = connectedExitPoints;

    if (!exitPoints.size) {
      // 没有任何出口：退化成「岛边界格」（有邻居不在本岛）
      var it2 = island.tile_set.values();
      var s2 = it2.next();
      while (!s2.done) {
        var t2 = s2.value;
        var mov2 = t2.movable || [];
        for (var j = 0; j < mov2.length; j++) {
          var nIsland = lookup.raw[mov2[j].tile_index];
          if (!nIsland || nIsland.unique_id !== island.unique_id) { exitPoints.add(t2); break; }
        }
        s2 = it2.next();
      }
    }

    if (!exitPoints.size) throw new Error('FE_PARTIAL_GATHER no exit_points on island ' + island.unique_id);

    var exitTile = minByXY(exitPoints);
    var queue = [[exitTile, 0]];
    var distances = new Map();
    distances.set(exitTile, 0);
    var selected = new Set();
    var head = 0;

    while (head < queue.length && selected.size < tilesToGather) {
      var pair = queue[head++];
      var t3 = pair[0];
      var d3 = pair[1];
      selected.add(t3);
      var mov3 = t3.movable || [];
      for (var k = 0; k < mov3.length; k++) {
        var nb = mov3[k];
        if (!island.tile_set.has(nb)) continue;
        if (distances.has(nb)) continue;
        distances.set(nb, d3 + 1);
        queue.push([nb, d3 + 1]);
      }
    }
    return selected;
  };

  ArmyFlowExpanderV2.prototype._post_optimize_locally = function (baselineSolution) {
    // 原版就是 TODO 空壳，行为等价
    return baselineSolution;
  };

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  flow.ArmyFlowExpanderV2 = ArmyFlowExpanderV2;
  EK.ArmyFlowExpanderV2 = ArmyFlowExpanderV2;

  flow.FlowBorderPairKey = FlowBorderPairKey;
  flow.FlowStreamIslandContribution = FlowStreamIslandContribution;
  flow.TargetStreamNodePotential = TargetStreamNodePotential;
  flow.FlowTurnsEntry = FlowTurnsEntry;
  flow.EnrichedFlowTurnsEntry = EnrichedFlowTurnsEntry;
  flow.ExternalPlanOption = ExternalPlanOption;
  flow.FlowArmyTurnsLookupTable = FlowArmyTurnsLookupTable;
  flow.PyHeap = PyHeap;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

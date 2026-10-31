/* =====================================================================
 * EK.ExpandHooks —— 把已移植的搜索器/查询器接到 BotExpansionOps 上
 *
 * 为什么需要这一层：BotExpansionOps 是「调用方」，ExpandUtils / EarlyExpandUtils
 * 是「搜索器」，原版是直接 import 调用；移植时为了不让两边互相依赖，调用点统一
 * 走 call_hook(bot, name, fallback, ...args)，签名形状是 `this = hooks`、
 * 第一参数 = bot。**在此之前没有任何地方设置 EK.ExpandHooks**，所以每回合
 * build_expansion_plan 都拿到 null 降级成空计划 —— 表现为 T50 之后土地完全不涨。
 *
 * 这一层同时负责把调用点丢掉的关键字参数补回去（原版是 kwargs，JS 调用点只能
 * 传位置参数，位置含义与 callee 的真实签名并不一致）：
 *   - optimize_first_25：第 5 个位置参数有的是 cutoff（时长），第 6 个有的是
 *     cramped（bool），有的是 prune_cutoff（int，py:179 还带 shuffle_launches=True）。
 *   - get_start_expand_captures：调用点把 launchTurn 塞在第 6 位，而真实签名第 6 位
 *     是 alreadyOwned ⇒ 必须按类型重排，否则 launchTurn 会当成「已拥有格子集合」。
 *   - recalculate_max_plan：调用点少传了 map（真实签名第 3 位），必须补。
 *   - get_round_plan_with_expansion：一处是两个位置参数，三处是 opts 对象。
 *
 * 时钟：EarlyExpandUtils.nowSeconds() 恒返回 0（确定性优先），所以那里的
 * cutoff_time 语义等价于「时长」，调用点传进来的 timeLimit 直接透传即可。
 *
 * 没接的：get_flow_expansion_options（BehaviorAlgorithms/FlowExpansion 未移植，
 * 原版这条是迭代流扩张的另一条路线）、get_watchman_path /
 * get_revealed_count_and_max_kill_turns_and_positive_path（WatchmanRouteUtils 未移植）。
 * 缺了它们对应分支按 null 跳过，不影响其余决策。
 * ===================================================================== */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function mapOf(bot) {
    return (bot && (bot._map || bot.map)) || null;
  }

  function negs(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Set) return v;
    if (Array.isArray(v)) return new Set(v);
    if (typeof v.has === 'function') return v;
    return new Set(v);
  }

  // 原版 map.players[x].tiles 是 set，JS 侧统一是数组或 Set
  function ownTiles(bot, playerIndex) {
    var map = mapOf(bot);
    var p = map && map.players ? map.players[playerIndex] : null;
    if (!p || !p.tiles) return [];
    return Array.isArray(p.tiles) ? p.tiles : Array.from(p.tiles);
  }

  /* ------------------------------------------------------------------ *
   * BotCombatQueries.get_largest_tiles_as_armies（未单独移植，就地搬）
   * 排序键 (army-1)/(pathway.distance+5) 是原版口径，pathway 缺失时 distance=100
   * ------------------------------------------------------------------ */
  function get_largest_tiles_as_armies(bot, player, limit) {
    var map = mapOf(bot);
    var ia = bot.board_analysis ? bot.board_analysis.intergeneral_analysis : null;
    var pwMatrix = ia ? ia.pathWayLookupMatrix : null;
    var tiles = ownTiles(bot, player).slice();
    var keyed = tiles.map(function (t, i) {
      var pw = pwMatrix ? pwMatrix.raw[t.tile_index] : null;
      var dist = 100;
      if (pw !== null && pw !== undefined && pw.distance !== undefined) dist = pw.distance;
      return { t: t, k: (t.army - 1) / (dist + 5), i: i };
    });
    // Python sorted(reverse=True) 是稳定的：同分保持原序
    keyed.sort(function (a, b) {
      if (a.k !== b.k) return b.k - a.k;
      return a.i - b.i;
    });
    var out = [];
    var n = limit === undefined || limit === null ? keyed.length : limit;
    for (var j = 0; j < keyed.length && out.length < n; j++) {
      var tile = keyed[j].t;
      if (tile.army <= 1) continue;
      out.push(bot.get_army_at(tile, true));
    }
    void map;
    return out;
  }

  var ExpandHooks = {
    /* ---- EarlyExpandUtils ------------------------------------------- */

    // call: (bot, source, distMap, skipTiles, timeLimit, cramped|pruneCutoff)
    optimize_first_25: function (bot, source, distMap, skipTiles, timeLimit, last) {
      var cutoffTime = timeLimit === undefined || timeLimit === null ? null : timeLimit;
      var pruneCutoff = -1;
      var cramped = false;
      var shuffleLaunches = false;
      if (typeof last === 'boolean') {
        cramped = last;
      } else if (typeof last === 'number') {
        // py:179 optimize_first_25(..., prune_cutoff=plan.tile_captures, shuffle_launches=True)
        pruneCutoff = last;
        shuffleLaunches = true;
      }
      return EK.EarlyExpandUtils.optimize_first_25(
        mapOf(bot), source, distMap, null, false,
        negs(skipTiles), false, cutoffTime, pruneCutoff, cramped, shuffleLaunches
      );
    },

    // call: (bot, coreTile, coreArmy, curTurn, planPaths, launchTurn)
    get_start_expand_captures: function (bot, general, generalArmy, curTurn, expandPaths, launchTurn) {
      var lt = typeof launchTurn === 'number' ? launchTurn : -1;
      return EK.EarlyExpandUtils.get_start_expand_captures(
        mapOf(bot), general, generalArmy, curTurn, expandPaths, null, lt, false
      );
    },

    // call: (bot, plan1, plan2, distToGenMap, tileWeightMap, visited)
    recalculate_max_plan: function (bot, plan1, plan2, distToGenMap, tileWeightMap, visited) {
      return EK.EarlyExpandUtils.recalculate_max_plan(
        plan1, plan2, mapOf(bot), distToGenMap, tileWeightMap, visited, false
      );
    },

    /* ---- ExpandUtils ------------------------------------------------ */

    // call: (bot, {opts}) 或 (bot, turns, negativeTiles)
    get_round_plan_with_expansion: function (bot, a, b) {
      var map = mapOf(bot);
      var opts;
      if (a !== null && typeof a === 'object') {
        opts = a;
      } else {
        // py BotExpansionOps.py:265 —— searchingPlayer 是将军持有者，扩展搜索必开
        opts = {
          turns: a,
          negativeTiles: negs(b),
          includeExpansionSearch: true
        };
      }
      opts = opts || {};
      var searchingPlayer = opts.searchingPlayer;
      if (searchingPlayer === undefined || searchingPlayer === null) {
        searchingPlayer = bot.general ? bot.general.player() : map.player_index;
      }
      var targetPlayer = opts.targetPlayer;
      if (targetPlayer === undefined || targetPlayer === null) targetPlayer = bot.targetPlayer;
      var turns = opts.turns;
      return EK.ExpandUtils.get_round_plan_with_expansion(
        map,
        searchingPlayer,
        targetPlayer,
        turns,
        bot.board_analysis,
        bot.territories ? bot.territories.territoryMap : null,
        bot.tileIslandBuilder,
        opts
      );
    },

    /* ---- 直接转调 --------------------------------------------------- */

    // py: BotCombatOps.check_for_attack_launch_move(bot, negativeTiles)
    check_for_attack_launch_move: function (bot, expNegs) {
      if (!EK.BotCombatOps || typeof EK.BotCombatOps.check_for_attack_launch_move !== 'function') return null;
      return EK.BotCombatOps.check_for_attack_launch_move(bot, negs(expNegs) || new Set());
    },

    // py: BotTargeting.get_target_player_possible_general_location_tiles_sorted(bot, elimNearbyRange=2, player=-2, ...)
    get_target_player_possible_general_location_tiles_sorted: function (bot, elimNearbyRange, player) {
      return EK.BotTargeting.get_target_player_possible_general_location_tiles_sorted(
        bot, elimNearbyRange, player
      );
    },

    // py: BotDefense.determine_fog_defense_amount_available_for_tiles(bot, targetTiles, enPlayer, ...)
    determine_fog_defense_amount_available_for_tiles: function (bot, targetTiles, enPlayer) {
      return EK.BotDefense.determine_fog_defense_amount_available_for_tiles(bot, targetTiles, enPlayer);
    },

    get_largest_tiles_as_armies: get_largest_tiles_as_armies,

    _get_furthest_apart_3_enemy_general_locations: function (bot, player) {
      return EK.BotTargeting._get_furthest_apart_3_enemy_general_locations(bot, player);
    },

    /* ---- 迭代流扩张（原版默认路径）---------------------------------- */

    // call: (bot, opts) —— 语义照 BotModules/BotExpansionOps.py:623-753
    get_flow_expansion_options: function (bot, opts) {
      return get_flow_expansion_options(bot, opts);
    }
  };

  /* ------------------------------------------------------------------ *
   * 迭代流扩张：ArmyFlowExpanderV2.get_expansion_options
   *
   * 为什么必须接：原版 bot.expansion_use_iterative_flow=True（bot_ek0x45.py:376），
   * turn>=50 的扩张**默认**走这条流场求解，产出的 options 直接当 addlOptions 交给
   * ExpandUtils.get_round_plan_with_expansion（py:812-842）。接不上就永远是空计划
   * ⇒ T50 之后土地不涨。
   *
   * 为什么要在 hook 里做参数重排：调用点传的是一个 opts 对象，而
   * ArmyFlowExpanderV2.get_expansion_options 是 18 个位置参数，中间还有几项
   * （leafMoves / viewInfo / perfTimer / 约束流路）在 JS 侧另有来源。
   * ------------------------------------------------------------------ */

  // py FlowExpansion.py:232 get_tile_army_mapmatrix
  function tileArmyMatrix(map) {
    var m = new EK.MapMatrix(map, 0);
    var tiles = map.get_all_tiles();
    for (var i = 0; i < tiles.length; i++) m.raw[tiles[i].tile_index] = tiles[i].army;
    return m;
  }

  function tileListOf(path) {
    if (!path) return [];
    var l = path.tileList || path.tiles;
    if (!l) return [];
    return Array.isArray(l) ? l : Array.from(l);
  }

  function get_flow_expansion_options(bot, opts) {
    opts = opts || {};
    var expanderCtor = EK.ArmyFlowExpanderV2;
    if (typeof expanderCtor !== 'function') return null;
    var map = mapOf(bot);
    if (!map) return null;

    var expander = bot._flow_expander;
    if (!expander) {
      expander = new expanderCtor(map, bot.perf_timer || null);
      bot._flow_expander = expander;
    } else if (typeof expander.reset_for_turn === 'function') {
      expander.reset_for_turn(map, bot.perf_timer || null);
    }

    expander.friendlyGeneral = bot.general;
    expander.enemyGeneral = bot.targetPlayerExpectedGeneralLocation;
    expander.debug_render_capture_count_threshold = 10000;
    expander.use_debug_asserts = false;

    var remainingCycleTurns = opts.remainingCycleTurns;
    var bonusMatrix = opts.bonusCapturePointMatrix || null;
    var bonusForFlow = bonusMatrix;
    var armyOverrideMatrix = tileArmyMatrix(map);

    // 迷雾里的敌方来路：把「最后几个看不见的格」按预测兵数覆盖，并加经济奖励
    // （py:646-694 的 FE fog override）
    var targetPlayer = bot.targetPlayer;
    var validTarget = targetPlayer !== null && targetPlayer !== undefined
      && targetPlayer >= 0 && targetPlayer < map.team_ids_by_player_index.length;
    var ot = bot.opponent_tracker;
    if (validTarget && bot.target_player_gather_path && ot
        && typeof ot.did_player_already_attack_this_round === 'function'
        && !ot.did_player_already_attack_this_round(targetPlayer)) {
      var fogTiles = [];
      var distToEnFog = 0;
      var foundFog = false;
      var mainPath = tileListOf(bot.shortest_path_to_target_player);
      for (var i = 0; i < mainPath.length && fogTiles.length < 5; i++) {
        var pt = mainPath[i];
        if (!pt.visible) { fogTiles.push(pt); foundFog = true; }
        if (!foundFog) distToEnFog += 1;
      }
      var enPath = tileListOf(bot.enemy_attack_path);
      for (var j = enPath.length - 1; j >= 0 && fogTiles.length < 10; j--) {
        var et = enPath[j];
        if (!et.visible) fogTiles.push(et);
        if (!foundFog) distToEnFog += 1;
      }

      if (fogTiles.length > 0 && typeof ot.get_predicted_attack_turn_by_dist_to_fog === 'function'
          && typeof ot.get_approximate_fog_army_risk === 'function') {
        var maxTurns = Math.max(1, ot.get_predicted_attack_turn_by_dist_to_fog(targetPlayer, distToEnFog));
        var inTurns = Math.min(20, maxTurns);
        var predictedArmy = ot.get_approximate_fog_army_risk(targetPlayer, null, inTurns);
        var perTileArmy = Math.floor(predictedArmy / fogTiles.length);
        if (bonusMatrix && typeof bonusMatrix.copy === 'function') {
          bonusForFlow = bonusMatrix.copy();
        }
        var econBonus = Math.floor(remainingCycleTurns / 2) + 5;
        var econPerTile = econBonus / fogTiles.length;
        for (var k = 0; k < fogTiles.length; k++) {
          var fi = fogTiles[k].tile_index;
          armyOverrideMatrix.raw[fi] = perTileArmy;
          if (bonusForFlow) bonusForFlow.raw[fi] += econPerTile;
        }
      }
    }

    // 外部计划（拦截图/城/叶招）连同叶招一起交给流求解器统一装箱
    var additionalOptions = (opts.additional_options || []).slice();
    if (opts.allowLeafMoves !== false && Array.isArray(bot.captureLeafMoves)) {
      for (var li = 0; li < bot.captureLeafMoves.length; li++) {
        var leafMove = bot.captureLeafMoves[li];
        if (leafMove.source.army - 1 <= leafMove.dest.army) continue;
        var leafPath = new EK.Path(leafMove.source.army - leafMove.dest.army - 1);
        leafPath.add_next(leafMove.source);
        leafPath.add_next(leafMove.dest);
        leafPath.econValue = leafMove.dest.player() !== -1
          ? EK.ITERATIVE_EXPANSION_EN_CAP_VAL : 1.0;
        leafPath.econValue += bonusMatrix ? bonusMatrix.raw[leafMove.dest.tile_index] : 0;
        additionalOptions.push(leafPath);
      }
    }

    // cutoffTime 在 JS 侧的 flow 实现里不参与决策（没有时间预算分支），传 null 即可
    var enemyAttackPathTiles = bot.enemy_attack_path
      ? (bot.enemy_attack_path.tileSet || null) : null;

    var collection = expander.get_expansion_options(
      bot.tileIslandBuilder,          // islands
      bot.player.index,               // asPlayer
      targetPlayer,                   // targetPlayer
      remainingCycleTurns,            // turns
      bot.board_analysis,             // boardAnalysis
      bot.territories ? bot.territories.territoryMap : null, // territoryMap
      opts.negativeTiles || null,     // negativeTiles
      null,                           // leafMoves（已并入 additionalOptions）
      null,                           // viewInfo（渲染层不需要）
      bonusForFlow,                   // bonusCapturePointMatrix
      bot.perf_timer || null,         // perfTimer
      null,                           // cutoffTime
      additionalOptions,              // additionalOptions
      armyOverrideMatrix,             // armyOverrideMatrix
      opts.blocking_tile_info || bot.blocking_tile_info || null, // threatBlockingTiles
      null,                           // constrainedFlowPaths
      enemyAttackPathTiles            // enemyAttackPathTiles
    );

    bot.last_flow_expander = expander;
    bot.last_flow_opt_collection = collection;
    if (!collection || !collection.expansion_options) return null;
    return Array.from(collection.expansion_options);
  }

  EK.ExpandHooks = ExpandHooks;
  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

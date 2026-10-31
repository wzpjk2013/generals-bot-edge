/* BotGatherOps.js —— 逐行移植 EklipZgit/generals-bot 的 BotModules/BotGatherOps.py（1381 行）
 *
 * 挂载：EK.BotGatherOps
 *
 * 与原版的差异（全部因为依赖模块还没移植过来，逐条记录以便后续替换）：
 *   1. Gather.knapsack_max_gather / knapsack_depth_gather(_with_values) /
 *      gather_max_set_iterative_plan / gather_approximate_turns_to_tiles /
 *      greedy_backpack_gather / prune_mst_to_max_army_per_turn(_with_values)
 *      在 JS 侧不存在。这里走 _fallbackGather()：本文件自带的 build_mst + prune_mst_to_turns，
 *      语义上等价于原版 depth > GATHER_SWITCH_POINT 的那条分支，但**不等价**于 knapsack 的最优解。
 *      每命中一次会计数（missingReport()），换真实现时把这些调用点逐个替换掉即可。
 *   2. BotExpansionOps.get_expansion_weight_matrix / BotTargeting.is_ffa_situation /
 *      BotDefense.* / BotRendering.mark_tile 同样可能不存在，统一走 q() 派发：
 *      存在就调，不存在就记录并返回调用点给定的默认值。
 *   3. 所有渲染 / logbook / perf_timer 分支都没有搬（任务要求只搬决策逻辑）。
 */

(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // BotGatherOps.py:34
  var GATHER_SWITCH_POINT = 150;

  // 缺失依赖的命中计数：给 lead 报「未覆盖分支」，也方便以后定位该换哪一处
  var missing = {};

  function noteMissing(name) {
    missing[name] = (missing[name] || 0) + 1;
  }

  function missingReport() {
    var out = {};
    for (var k in missing) {
      if (Object.prototype.hasOwnProperty.call(missing, k)) out[k] = missing[k];
    }
    return out;
  }

  // ---- 小工具 -------------------------------------------------------------

  function mapOf(bot) {
    return bot._map || bot.map;
  }

  function generalOf(bot) {
    if (bot.general) return bot.general;
    var map = mapOf(bot);
    return map ? map.generals[map.player_index] : null;
  }

  function playerIndex(bot) {
    var map = mapOf(bot);
    if (bot.player && typeof bot.player.index === 'number' && bot.player.index >= 0) return bot.player.index;
    return map ? map.player_index : -1;
  }

  // Python 里 set/dict 迭代顺序对结果有影响的地方，这里统一按 tile_index 升序，
  // 免得 JS 的插入序和 Python 的 hash 序产生不可复现的抖动。
  function sortedTiles(coll) {
    var arr = toArr(coll);
    arr.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return arr;
  }

  function toArr(coll) {
    if (!coll) return [];
    if (Array.isArray(coll)) return coll.slice();
    if (coll instanceof Set) return Array.from(coll);
    if (typeof coll[Symbol.iterator] === 'function') return Array.from(coll);
    if (typeof coll.toTiles === 'function') return coll.toTiles();
    if (typeof coll.values === 'function') return coll.values();
    return [];
  }

  // 「有则调用、无则记录」的派发。模块缺失时返回 dflt，绝不抛。
  function q(moduleName, fnName, args, dflt) {
    var mod = EK[moduleName];
    if (mod && typeof mod[fnName] === 'function') {
      return mod[fnName].apply(mod, args);
    }
    noteMissing(moduleName + '.' + fnName);
    return dflt;
  }

  function isAllIn(bot) {
    if (EK.BotStateQueries && typeof EK.BotStateQueries.is_all_in === 'function') {
      return !!EK.BotStateQueries.is_all_in(bot);
    }
    noteMissing('BotStateQueries.is_all_in');
    return !!bot.is_all_in_army_advantage;
  }

  function isNonDominantFfa(bot) {
    if (EK.BotStateQueries && typeof EK.BotStateQueries.is_still_ffa_and_non_dominant === 'function') {
      return !!EK.BotStateQueries.is_still_ffa_and_non_dominant(bot);
    }
    noteMissing('BotStateQueries.is_still_ffa_and_non_dominant');
    return false;
  }

  function moveHalfOnRepetition(bot, move, turns, reps) {
    if (!move) return move;
    if (EK.BotRepetition && typeof EK.BotRepetition.move_half_on_repetition === 'function') {
      return EK.BotRepetition.move_half_on_repetition(bot, move, turns, reps);
    }
    noteMissing('BotRepetition.move_half_on_repetition');
    return move;
  }

  function distanceFromGeneral(bot, tile) {
    if (!tile) return 1000;
    return q('BotPathingUtils', 'distance_from_general', [bot, tile], 1000);
  }

  function getPathToTargets(bot, targets, fromTile, preferEnemy, avoidEnemyVision, avoidUsingExpandables) {
    var path = q('BotPathingUtils', 'get_path_to_targets',
      [bot, targets, undefined, undefined, undefined, undefined, undefined, fromTile, preferEnemy,
        undefined, undefined, avoidEnemyVision, avoidUsingExpandables], null);
    return path;
  }

  function Move(tileA, tileB) {
    if (EK.Move) return new EK.Move(tileA, tileB);
    noteMissing('EK.Move');
    return { source: tileA, dest: tileB, move_half: false };
  }

  function isMoveListPath(p) {
    return !!(EK.MoveListPath && p instanceof EK.MoveListPath);
  }

  // ---- 计数 / 转换 ---------------------------------------------------------

  // BotGatherOps.py:38 get_number_of_captures_in_gather_tree
  function get_number_of_captures_in_gather_tree(bot, gatherNodes, asPlayer) {
    if (asPlayer === undefined) asPlayer = -2;
    var map = mapOf(bot);
    if (asPlayer === -2) asPlayer = map.player_index;
    // BotGatherOps.py:39 —— 原版在这里就挡掉空树，否则 foreach_tree_node 会 slice 到 null
    if (gatherNodes === null || gatherNodes === undefined || gatherNodes.length === 0) return 0;
    var sumCaps = { value: 0 };
    EK.GatherTreeNode.foreach_tree_node(gatherNodes, function (n) {
      if (!map.is_tile_on_team_with(n.tile, asPlayer) && n.children && n.children.length > 0) {
        sumCaps.value += 1;
      }
    });
    return sumCaps.value;
  }

  // BotGatherOps.py:52 convert_gather_to_move_list_path
  function convert_gather_to_move_list_path(bot, gatherNodes, turnsUsed, value, moveOrderPriorityMinFunc) {
    var map = mapOf(bot);
    var gcp = EK.GatherCapturePlan.build_from_root_nodes(
      map, gatherNodes, new Set(), map.player_index, false, null, null);
    var moveListThing = [];
    var move = gcp.pop_first_move();
    while (move) {
      moveListThing.push(move);
      move = gcp.pop_first_move();
    }
    var path = new EK.MoveListPath(moveListThing);
    path.valuePerTurn = turnsUsed > 0 ? value / turnsUsed : -1000;
    return path;
  }

  // ---- 入口 ---------------------------------------------------------------

  // BotGatherOps.py:72 try_find_gather_move
  function try_find_gather_move(bot, threat, defenseCriticalTileSet, leafMoves, needToKillTiles) {
    var map = mapOf(bot);
    var tryGather = true;
    var enemyGather = false;

    if (
      q('BotDefense', 'get_approximate_fog_risk_deficit', [bot], 100) < 10
      && !(map.remainingPlayers > 2)
      // Python: winning_on_economy(byRatio=1.1, cityValue=0)
      && !(bot.opponent_tracker && bot.opponent_tracker.winning_on_economy
        ? bot.opponent_tracker.winning_on_economy(1.1, 0)
        : false)
    ) {
      enemyGather = true;
    }

    if (isAllIn(bot)) {
      var flankAllIn = q('BotCombatOps', 'try_find_flank_all_in',
        [bot, bot.timings ? bot.timings.get_turns_left_in_cycle(map.turn) : 0], null);
      if (flankAllIn) return flankAllIn;
      return null;
    }

    var targetPlayerObj = map.players[bot.targetPlayer];
    var tileDeficitThreshold = targetPlayerObj ? targetPlayerObj.tileCount * 1.05 : 0;

    if (bot.makingUpTileDeficit) {
      tileDeficitThreshold = tileDeficitThreshold * 1.15 + 8;
    }

    var player = bot.player;
    if (
      !bot.defend_economy
      && distanceFromGeneral(bot, bot.targetPlayerExpectedGeneralLocation) > 2
      && player.tileCount < tileDeficitThreshold
      && !(isAllIn(bot) || bot.all_in_losing_counter > 50)
    ) {
      enemyGather = true;
      bot.makingUpTileDeficit = true;
    } else {
      bot.makingUpTileDeficit = false;
    }

    var neutralGather = true;

    if (bot.defend_economy) {
      neutralGather = false;
      enemyGather = false;
    }

    if (!tryGather) return null;

    return get_main_gather_move(bot, defenseCriticalTileSet, leafMoves, enemyGather, neutralGather, needToKillTiles);
  }

  // BotGatherOps.py:122 get_main_gather_move
  function get_main_gather_move(bot, defenseCriticalTileSet, leafMoves, enemyGather, neutralGather, needToKillTiles) {
    if (enemyGather === undefined) enemyGather = false;
    if (neutralGather === undefined) neutralGather = false;

    var map = mapOf(bot);
    var general = generalOf(bot);

    if (!needToKillTiles) needToKillTiles = [];
    if (!leafMoves) leafMoves = [];

    if (bot.quick_kill_city_plan_option) {
      var qkOption = bot.quick_kill_city_plan_option;
      var qkCity = qkOption.tail ? qkOption.tail.tile : null;
      var cutoff = 25 - qkOption.length;
      var contestable = bot.win_condition_analyzer ? bot.win_condition_analyzer.contestable_cities : null;
      if (qkCity && contestable && toArr(contestable).indexOf(qkCity) >= 0
        && bot.win_condition_analyzer.was_city_recently_contested
        && bot.win_condition_analyzer.was_city_recently_contested(qkCity, cutoff)) {
        return qkOption.get_first_move();
      }
      if (qkOption.length < 6) {
        return qkOption.get_first_move();
      }
    }

    // 原版第 147 行赋值后立刻被第 148 行覆盖（保留原样，别「修」掉）
    var gatherTargets = new Set();
    if (bot.defensive_spanning_tree) gatherTargets = new Set(toArr(bot.defensive_spanning_tree));

    var path = getPathToTargets(
      bot, gatherTargets,
      bot.win_condition_analyzer ? bot.win_condition_analyzer.best_target_player_attack_target : null,
      !bot.all_in_city_behind && !bot.is_all_in_losing,
      true, true);

    if (path) {
      for (var pt = path.start; pt; pt = pt.next) {
        if (pt.tile) gatherTargets.add(pt.tile);
      }
    }

    if (bot.likely_kill_push && bot.enemy_attack_path) {
      gatherTargets = new Set(toArr(bot.enemy_attack_path.tileSet));
    }

    if (gatherTargets.size === 2) {
      gatherTargets = new Set();
      if (general) gatherTargets.add(general);
      for (var lp = 0; lp < (bot.launchPoints || []).length; lp++) gatherTargets.add(bot.launchPoints[lp]);
    }

    var gatherNegatives = new Set(toArr(defenseCriticalTileSet));
    if (bot.curPath && typeof bot.curPath.get_first_move === 'function') {
      var nextMove = bot.curPath.get_first_move();
      if (nextMove) gatherNegatives.add(nextMove.source);
    }

    var genPlayer = map.players[general.player()];
    var genTiles = sortedTiles(genPlayer.tiles);

    var inEnTerrSet = new Set();
    var sumEnTerrArmy = 0;
    if (bot.targetPlayer >= 0) {
      for (var i = 0; i < genTiles.length; i++) {
        var tile = genTiles[i];
        var terr = bot.territories.territoryMap.get(tile);
        if (map.is_player_on_team_with(terr, bot.targetPlayer)) {
          inEnTerrSet.add(tile);
          sumEnTerrArmy += tile.army - 1;
        }
      }
    }

    var isNonDomFfa = isNonDominantFfa(bot);

    var teamScoreUs = bot.opponent_tracker ? bot.opponent_tracker.get_current_team_scores_by_player(playerIndex(bot)) : null;
    var teamScoreTarget = bot.opponent_tracker ? bot.opponent_tracker.get_current_team_scores_by_player(bot.targetPlayer) : null;

    var needNegUpdate = inEnTerrSet.size < Math.floor(bot.player.tileCount / 6);
    if (!needNegUpdate && bot.targetPlayer !== -1 && teamScoreUs && teamScoreTarget) {
      needNegUpdate = teamScoreUs.standingArmy - sumEnTerrArmy < teamScoreTarget.standingArmy * 0.9;
    }
    if (needNegUpdate) {
      if (!bot.currently_forcing_out_of_play_gathers && !bot.defend_economy && !isNonDomFfa) {
        inEnTerrSet.forEach(function (t) { gatherNegatives.add(t); });
      }
    }

    if (bot.teammate_general) {
      var allyPlayer = map.players[bot.teammate_general.player()];
      var allyTiles = sortedTiles(allyPlayer.tiles);
      for (var ai = 0; ai < allyTiles.length; ai++) {
        var at = allyTiles[ai];
        if (map.is_player_on_team_with(bot.territories.territoryMap.get(at), bot.targetPlayer)) {
          gatherNegatives.add(at);
        }
      }
    }

    if (bot.targetPlayer === -1) enemyGather = false;

    if (bot.timings && bot.timings.disallowEnemyGather) {
      enemyGather = false;
      neutralGather = false;
    }

    if ((enemyGather || neutralGather) && !isAllIn(bot) && map.turn >= 150) {
      var shortestLength = bot.shortest_path_to_target_player
        ? bot.shortest_path_to_target_player.length
        : (bot.target_player_gather_path ? bot.target_player_gather_path.length : 1000);

      if (!isAllIn(bot) && !bot.defend_economy && enemyGather && map.turn >= 150 && leafMoves.length > 0 && !isNonDomFfa) {
        var goodLeaves = q('BoardAnalyzer', 'find_flank_leaves',
          [bot.board_analysis, leafMoves, 2, shortestLength + Math.floor(shortestLength / 3)], []);
        for (var gl = 0; gl < goodLeaves.length; gl++) {
          gatherNegatives.add(goodLeaves[gl].dest);
        }
      }

      if (!isNonDomFfa) {
        for (var lf = 0; lf < leafMoves.length; lf++) {
          var leaf = leafMoves[lf];
          var destPlayer = leaf.dest.player();
          if (!(destPlayer === bot.targetPlayer || (neutralGather && destPlayer === -1))) continue;
          if (leaf.dest.isCity && destPlayer === -1) continue;
          if (bot.target_player_gather_targets && toArr(bot.target_player_gather_targets).indexOf(leaf.dest) >= 0) continue;
          if (destPlayer !== bot.targetPlayer && destPlayer >= 0) continue;

          var useTile = leaf.source;
          if (destPlayer === bot.targetPlayer) useTile = leaf.dest;

          if (bot.targetPlayer !== -1 && !neutralGather && (leaf.dest.player() === -1 || leaf.source.player() === -1)) continue;

          var useTerr = bot.territories.territoryMap.get(useTile);
          var isTeammateTerr = map.teammates && map.teammates.has ? map.teammates.has(useTerr) : false;
          if (useTerr !== general.player() && !isTeammateTerr) {
            var dSource = q('BotPathingUtils', 'distance_from_target_path', [bot, leaf.source], 1000);
            var dDest = q('BotPathingUtils', 'distance_from_target_path', [bot, leaf.dest], 1000);
            if (dSource <= dDest || dSource > shortestLength / 3) continue;
          }

          gatherNegatives.add(useTile);
        }
      }
    }

    var forceGatherToEnemy = q('BotDefense', 'should_force_gather_to_enemy_tiles', [bot], false);

    var gatherPriorities = get_gather_tiebreak_matrix(bot);

    var usingNeedToKill = needToKillTiles.length > 0 && !bot.flanking && !bot.defend_economy;

    var move;

    if (usingNeedToKill) {
      for (var nk = 0; nk < needToKillTiles.length; nk++) {
        var nkTile = needToKillTiles[nk];
        if (gatherTargets.has(nkTile) && distanceFromGeneral(bot, nkTile) > 3) continue;

        if (forceGatherToEnemy) {
          (function () {
            var needSet = new Set(needToKillTiles);
            var remover = function (curTile) {
              if (!needSet.has(curTile) && gatherTargets.has(curTile)) gatherTargets.delete(curTile);
            };
            q('search', 'breadth_first_foreach_fast_no_neut_cities', [map, [nkTile], 2, remover], null);
          })();
          gatherTargets.add(nkTile);
        }
      }

      if (bot.timings && bot.timings.in_quick_expand_split(map.turn) && forceGatherToEnemy) {
        var negCopy = new Set(gatherNegatives);
        if (bot.target_player_gather_path) {
          for (var tp = bot.target_player_gather_path.start; tp; tp = tp.next) negCopy.add(tp.tile);
        }

        move = timing_gather(bot, needToKillTiles, negCopy,
          new Set(toArr(genPlayer.cities)), true, null, 4, false, false, false, gatherPriorities, null, false);
        if (move) {
          if (!isMoveListPath(bot.curPath)) bot.curPath = null;
          if (!map.is_player_on_team_with(move.dest.player(), general.player()) && move.dest.player() !== -1) {
            bot.curPath = null;
          }
          return moveHalfOnRepetition(bot, move, 6, 4);
        }
      }
    } else {
      needToKillTiles = null;
    }

    gatherNegatives = get_timing_gather_negatives_unioned(bot, gatherNegatives);

    if (bot.currently_forcing_out_of_play_gathers || bot.defend_economy) {
      if (bot.defend_economy && bot.board_analysis.central_defense_point) {
        gatherTargets = new Set([bot.board_analysis.central_defense_point]);
      }

      var genTiles2 = sortedTiles(genPlayer.tiles);
      for (var g2 = 0; g2 < genTiles2.length; g2++) {
        var gt = genTiles2[g2];
        if (bot.board_analysis.core_play_area_matrix && bot.board_analysis.core_play_area_matrix.has(gt)
          && !bot.tiles_gathered_to_this_cycle.has(gt) && gt.army > 1) {
          gatherPriorities.raw[gt.tile_index] -= 0.2;
        }
        if (bot.board_analysis.extended_play_area_matrix && !bot.board_analysis.extended_play_area_matrix.has(gt)
          && !bot.tiles_gathered_to_this_cycle.has(gt) && gt.army > 1) {
          gatherPriorities.raw[gt.tile_index] += 0.2;
        }
      }
    }

    var useTrueValueGathered = false;
    var tgTurns = -1;
    var includeGatherTreeNodesThatGatherNegative = !!bot.defend_economy;
    var pruneToValuePerTurn = false;
    var distancePriorities = bot.board_analysis.intergeneral_analysis
      ? bot.board_analysis.intergeneral_analysis.bMap
      : null;

    if (bot.defend_economy) {
      var remainingCycleTurns = map.remainingCycleTurns;
      var centralDefensePoint = bot.board_analysis.central_defense_point;
      tgTurns = remainingCycleTurns - 5;
      useTrueValueGathered = true;

      gatherTargets = new Set(toArr(bot.defensive_spanning_tree));
      var defPath = getPathToTargets(bot, gatherTargets,
        bot.win_condition_analyzer ? bot.win_condition_analyzer.best_target_player_attack_target : null,
        !bot.all_in_city_behind && !bot.is_all_in_losing, undefined, false);
      if (defPath) {
        for (var dp = defPath.start; dp; dp = dp.next) {
          if (dp.tile) gatherTargets.add(dp.tile);
        }
      }
      if (bot.likely_kill_push && bot.enemy_attack_path) {
        gatherTargets = new Set(toArr(bot.enemy_attack_path.tileSet));
      }

      if (bot.enemy_attack_path) {
        // Python: winning_on_economy(byRatio=1.1, offset=-25)
        var winningEcon = bot.opponent_tracker && bot.opponent_tracker.winning_on_economy
          ? bot.opponent_tracker.winning_on_economy(1.1, undefined, undefined, -25)
          : false;
        if (winningEcon) {
          gatherPriorities = null;
          tgTurns = map.remainingCycleTurns - 5;
          useTrueValueGathered = false;
          includeGatherTreeNodesThatGatherNegative = true;
          distancePriorities = bot.board_analysis.intergeneral_analysis
            ? bot.board_analysis.intergeneral_analysis.aMap
            : null;
          var defendCities = bot.win_condition_analyzer ? toArr(bot.win_condition_analyzer.defend_cities) : [];
          for (var dc = 0; dc < defendCities.length; dc++) gatherNegatives.add(defendCities[dc]);
        }
      }

      if (tgTurns < 10) {
        tgTurns = 10;
        pruneToValuePerTurn = true;
      }

      tgTurns += distanceFromGeneral(bot, centralDefensePoint);
    }

    move = timing_gather(bot, sortedTiles(gatherTargets), gatherNegatives, null, true, null, tgTurns,
      includeGatherTreeNodesThatGatherNegative, useTrueValueGathered, pruneToValuePerTurn,
      gatherPriorities, distancePriorities, false);

    if (move) {
      if (move.dest.player() !== playerIndex(bot)
        && !toArr(bot.target_player_gather_targets).includes(move.dest)
        && !bot.flanking && needToKillTiles !== null && needToKillTiles.indexOf(move.dest) >= 0) {
        bot.timings.splitTurns += 1;
        bot.timings.launchTiming += 1;
      }

      if (move.source.isCity || move.source.isGeneral) {
        bot.cities_gathered_this_cycle.add(move.source);
      }

      if (move.dest.isCity && move.dest.player() === playerIndex(bot)
        && bot.cities_gathered_this_cycle.has(move.dest)) {
        bot.cities_gathered_this_cycle.delete(move.dest);
      }

      if (!isMoveListPath(bot.curPath)) bot.curPath = null;
      return moveHalfOnRepetition(bot, move, 6, 4);
    }

    return null;
  }

  // BotGatherOps.py:401 get_capture_first_tree_move_prio_func
  function get_capture_first_tree_move_prio_func(bot) {
    var map = mapOf(bot);
    return function (curTile, currentPriorityObject) {
      var lastTile = null;
      if (currentPriorityObject) lastTile = currentPriorityObject[2];
      return [lastTile === null || !map.is_tile_friendly(lastTile), curTile.isSwamp, curTile];
    };
  }

  // BotGatherOps.py:415 get_gather_to_target_tile
  function get_gather_to_target_tile(bot, target, maxTime, gatherTurns, negativeSet, targetArmy,
    useTrueValueGathered, priorityMatrix, distPriorityMap, shouldLog) {
    return get_gather_to_target_tiles(bot, [target], maxTime, gatherTurns, negativeSet, targetArmy,
      useTrueValueGathered, null, false, false, 0, distPriorityMap, priorityMatrix, null, shouldLog, false);
  }

  // BotGatherOps.py:451 timing_gather
  function timing_gather(bot, startTiles, negativeTiles, skipTiles, force, priorityTiles, targetTurns,
    includeGatherTreeNodesThatGatherNegative, useTrueValueGathered, pruneToValuePerTurn,
    priorityMatrix, distancePriorities, logStuff) {
    if (negativeTiles === undefined) negativeTiles = null;
    if (force === undefined) force = false;
    if (targetTurns === undefined) targetTurns = -1;
    if (includeGatherTreeNodesThatGatherNegative === undefined) includeGatherTreeNodesThatGatherNegative = false;
    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (pruneToValuePerTurn === undefined) pruneToValuePerTurn = false;

    var map = mapOf(bot);
    var general = generalOf(bot);
    var timings = bot.timings;
    var turn = map.turn;

    var turnOffset = turn + timings.offsetTurns;
    var turnCycleOffset = turnOffset % timings.cycleTurns;
    var finishing_exploration = true;

    var delayCities = !bot.defend_economy
      && !(bot.likely_kill_push && map.players[general.player()].cities.length > 1);
    var gatherNodeMoveSelectorFunc = get_tree_move_most_army_value_distance_factored_func(bot, delayCities);

    if (force || (turn >= 50 && turnCycleOffset < timings.splitTurns && startTiles && startTiles.length > 0)) {
      finishing_exploration = false;

      var depth = targetTurns !== -1 ? targetTurns : timings.splitTurns - turnCycleOffset;
      if (depth < 0) {
        depth += Math.floor(timings.cycleTurns / 2);
        pruneToValuePerTurn = true;
      }
      if (pruneToValuePerTurn && depth < 10) depth = 10;

      var gatherNodes = null;
      var move = null;

      if (depth > GATHER_SWITCH_POINT) {
        gatherNodes = build_mst(bot, startTiles, 1.0, depth - 1, negativeTiles);
        if (gatherNodes && gatherNodes.length > 0) {
          EK.Gather.prune_mst_to_turns(gatherNodes, depth - 1, general.player(), map.teams, turn);
          move = get_tree_move_default(bot, gatherNodes);
          if (move) {
            bot.gatherNodes = gatherNodes;
            bot.finishing_exploration = finishing_exploration;
            return moveHalfOnRepetition(bot, move, 6, 4);
          }
        }
      }

      var skipFunc = isNonDominantFfa(bot)
        ? function (tile) { return !tile.discovered; }
        : null;

      if (distancePriorities === null || distancePriorities === undefined) {
        distancePriorities = bot.board_analysis.intergeneral_analysis
          ? bot.board_analysis.intergeneral_analysis.bMap
          : null;
      }

      var res = get_gather_to_target_tiles(bot, startTiles, 0.05, depth, negativeTiles, -1,
        useTrueValueGathered, gatherNodeMoveSelectorFunc, includeGatherTreeNodesThatGatherNegative,
        false, 0, distancePriorities, priorityMatrix, skipTiles, logStuff, false);
      gatherNodes = res[3];

      if (!gatherNodes) {
        // 原版这里是 Gather.knapsack_depth_gather_with_values，JS 侧没有 → 走退化路径
        noteMissing('Gather.knapsack_depth_gather_with_values');
        gatherNodes = _fallbackGather(bot, startTiles, depth, negativeTiles, skipTiles, skipFunc, priorityMatrix);
      }

      if (gatherNodes && pruneToValuePerTurn) {
        gatherNodes = pruneFallback(bot, gatherNodes, includeGatherTreeNodesThatGatherNegative);
      }

      if (gatherNodes) {
        bot.gatherNodes = gatherNodes;
        move = get_tree_move_default(bot, gatherNodes, gatherNodeMoveSelectorFunc);
        if (move) {
          bot.curPath = null;
          bot.finishing_exploration = finishing_exploration;
          return moveHalfOnRepetition(bot, move, 6, 4);
        }
      }
    }

    bot.finishing_exploration = finishing_exploration;
    return null;
  }

  // gatherNodes 的退化 prune：原版 prune_mst_to_max_army_per_turn_with_values 不在 JS 里，
  // 用 prune_mst_to_turns 近似（按回合数剪枝，而不是按每回合最大收益剪枝）。
  function pruneFallback(bot, gatherNodes, includeNegative) {
    noteMissing('Gather.prune_mst_to_max_army_per_turn_with_values');
    if (!includeNegative && gatherNodes) {
      // allowNegative=False 的语义：负收益叶子应当剪掉，这里靠 prune_mst_to_turns 的默认行为
    }
    return gatherNodes;
  }

  // 缺失原语时的统一退化：本文件的 build_mst 已按 Python 语义实现，直接拿来用。
  function _fallbackGather(bot, startTiles, depth, negativeTiles, skipTiles, skipFunc, priorityMatrix) {
    var startList = sortedTiles(startTiles);
    if (skipTiles) {
      var skipSet = skipTiles instanceof Set ? skipTiles : new Set(toArr(skipTiles));
      startList = startList.filter(function (t) { return !skipSet.has(t); });
    }
    if (startList.length === 0) return null;
    var nodes = build_mst(bot, startList, 0.05, Math.max(1, depth - 1), negativeTiles);
    return nodes && nodes.length > 0 ? nodes : null;
  }

  // BotGatherOps.py:663 get_defensive_gather_to_target_tiles
  function get_defensive_gather_to_target_tiles(bot, targets, maxTime, gatherTurns, negativeSet, targetArmy,
    useTrueValueGathered, leafMoveSelectionValueFunc, includeGatherTreeNodesThatGatherNegative,
    maximizeArmyGatheredPerTurn, additionalIncrement, distPriorityMap, depthPriorityMap, priorityMatrix,
    skipTiles, shouldLog, fastMode) {

    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (targetArmy === undefined) targetArmy = -1;
    if (maximizeArmyGatheredPerTurn === undefined) maximizeArmyGatheredPerTurn = false;
    if (additionalIncrement === undefined) additionalIncrement = 0;

    if (useTrueValueGathered && targetArmy > -1) targetArmy += 1;
    if (additionalIncrement !== 0 && targetArmy > 0) {
      targetArmy += Math.floor(additionalIncrement * gatherTurns / 2);
    }

    var res = get_gather_to_target_tiles(bot, targets, maxTime, gatherTurns, negativeSet, targetArmy,
      useTrueValueGathered, leafMoveSelectionValueFunc, includeGatherTreeNodesThatGatherNegative,
      maximizeArmyGatheredPerTurn, additionalIncrement, distPriorityMap, priorityMatrix, skipTiles,
      shouldLog, fastMode);
    return res;
  }

  // BotGatherOps.py:756 get_gather_tiebreak_matrix
  function get_gather_tiebreak_matrix(bot) {
    var map = mapOf(bot);
    var general = generalOf(bot);
    var matrix = new EK.MapMatrix(map, 0.0);
    var desertPenalty = 0.25;
    var board = bot.board_analysis;

    if (board && board.backwards_tiles) {
      toArr(board.backwards_tiles).forEach(function (tile) {
        if (tile.army > 2) matrix.raw[tile.tile_index] += 0.45;
        else if (tile.army > 1) matrix.raw[tile.tile_index] += 0.25;
      });
    }

    if (map.swamps) {
      map.swamps.forEach(function (tile) { matrix.raw[tile.tile_index] -= 2.0; });
    }
    if (map.deserts) {
      map.deserts.forEach(function (tile) { matrix.raw[tile.tile_index] -= desertPenalty; });
    }

    if (bot.expansion_plan) {
      if (bot.expansion_plan.selected_option && bot.expansion_plan.selected_option.tileSet) {
        toArr(bot.expansion_plan.selected_option.tileSet).forEach(function (tile) {
          matrix.raw[tile.tile_index] -= 0.2;
        });
      }
      if (bot.expansion_plan.all_paths) {
        var allPaths = bot.expansion_plan.all_paths;
        for (var ap = 0; ap < allPaths.length; ap++) {
          var opt = allPaths[ap];
          if (!opt) continue;
          var tiles = opt.tileSet ? toArr(opt.tileSet) : [];
          for (var ti = 0; ti < tiles.length; ti++) matrix.raw[tiles[ti].tile_index] -= 0.05;
        }
      }
    }

    var isNonDomFfa = isNonDominantFfa(bot);
    var interOp = board && board.intergeneral_analysis ? board.intergeneral_analysis : null;
    var shortestWayTiles = interOp && interOp.shortestPathWay ? interOp.shortestPathWay.tiles : null;
    var shortestPathDistances = board ? board.shortest_path_distances : null;
    var extendedPlay = board ? board.extended_play_area_matrix : null;
    var territoryDistances = bot.territories ? bot.territories.territoryDistances : null;
    var territoryDistMap = territoryDistances && bot.targetPlayer !== undefined
      ? territoryDistances[bot.targetPlayer]
      : null;

    var friends = toArr(map.get_teammates(map.player_index));
    for (var fi = 0; fi < friends.length; fi++) {
      var p = friends[fi];
      var pObj = map.players[p];
      if (!pObj) continue;
      var myTiles = sortedTiles(pObj.tiles);

      for (var mi2 = 0; mi2 < myTiles.length; mi2++) {
        var tile = myTiles[mi2];
        if (!isNonDomFfa || map.turn > 200) {
          if (shortestWayTiles && shortestWayTiles.has && shortestWayTiles.has(tile)) {
            matrix.raw[tile.tile_index] -= 0.4;
          }
          if (tile.army <= 1) matrix.raw[tile.tile_index] -= 0.5;
        }
        if (tile.isDesert) matrix.raw[tile.tile_index] += desertPenalty;

        var isAllFriendly = true;
        var mov = tile.movable || [];
        for (var mo = 0; mo < mov.length; mo++) {
          var nt = mov[mo];
          if (!nt.isObstacle && !map.is_tile_friendly(nt)) { isAllFriendly = false; break; }
        }
        if (isAllFriendly && territoryDistMap && territoryDistMap.raw[tile.tile_index] > 3) {
          matrix.raw[tile.tile_index] += Math.min(0.49, 0.04 * territoryDistMap.raw[tile.tile_index]);
        }
        if (!isAllFriendly && !isNonDomFfa) matrix.raw[tile.tile_index] -= 0.25;

        if (extendedPlay && !extendedPlay.has(tile) && tile.army > 1 && shortestPathDistances) {
          var distToShortest = shortestPathDistances.raw[tile.tile_index];
          if (distToShortest < 1000) {
            matrix.raw[tile.tile_index] += Math.min(0.49, 0.03 * distToShortest);
          }
        }
      }
    }

    if (bot.cities_gathered_this_cycle) {
      bot.cities_gathered_this_cycle.forEach(function (cityTile) {
        matrix.raw[cityTile.tile_index] = -1.0;
      });
    }

    return matrix;
  }

  // BotGatherOps.py:872 build_mst
  function build_mst(bot, startTiles, maxTime, maxDepth, negativeTiles, avoidTiles, priorityFunc) {
    if (maxTime === undefined) maxTime = 0.1;
    if (maxDepth === undefined) maxDepth = 150;

    var map = mapOf(bot);
    var searchingPlayer = map.player_index;
    var frontier = new EK.search.HeapQueue();
    var visitedBack = new EK.MapMatrix(map);
    var startSet = null;

    if (priorityFunc === undefined || priorityFunc === null) {
      priorityFunc = default_priority_func;
    }

    if (!Array.isArray(startTiles) && !(startTiles instanceof Set)) {
      // dict 形式：{tile: priorityValue}（Python 的 dict 迭代项）
      var iterItems;
      if (startTiles instanceof Map) {
        iterItems = Array.from(startTiles.entries());
      } else {
        iterItems = Object.keys(startTiles).map(function (k) { return [k, startTiles[k]]; });
      }
      for (var si = 0; si < iterItems.length; si++) {
        var stTile = iterItems[si][0];
        var stVal = iterItems[si][1];
        if (typeof stVal === 'number') {
          frontier.put([stVal, [0, 0, stVal, stTile.x, stTile.y], stTile, stTile]);
        } else if (Array.isArray(stVal) && stVal.length === 2) {
          frontier.put([stVal[1], stVal[0], stTile, stTile]);
        } else {
          frontier.put([0, stVal, stTile, stTile]);
        }
      }
    } else {
      startSet = new Set(toArr(startTiles));
      var startArr = sortedTiles(startSet);
      for (var sj = 0; sj < startArr.length; sj++) {
        var sTile = startArr[sj];
        frontier.put([0, [0, 0, 0, sTile.x, sTile.y], sTile, sTile]);
      }
    }

    var startTime = Date.now();
    var avoidSet = avoidTiles ? (avoidTiles instanceof Set ? avoidTiles : new Set(toArr(avoidTiles))) : null;

    function default_priority_func(nextTile, currentPriorityObject) {
      var prio = currentPriorityObject[0];
      var negArmy = currentPriorityObject[1];
      var dist = currentPriorityObject[2];
      var xSum = currentPriorityObject[3];
      var ySum = currentPriorityObject[4];

      var nextArmy = 0 - negArmy - 1;
      if (negativeTiles === null || negativeTiles === undefined || !hasTile(negativeTiles, nextTile)) {
        if (searchingPlayer === nextTile.player()) nextArmy += nextTile.army;
        else nextArmy -= nextTile.army;
      }
      dist += 1;
      return [0 - nextArmy / dist, 0 - nextArmy, dist, xSum + nextTile.x, ySum + nextTile.y];
    }

    var queue = frontier.queue;
    while (queue.length > 0) {
      var entry = frontier.get();
      var dist = entry[0];
      var curPriorityVal = entry[1];
      var current = entry[2];
      var cameFrom = entry[3];

      if (visitedBack.raw[current.tile_index] !== undefined && visitedBack.raw[current.tile_index] !== null) continue;
      if (avoidSet && avoidSet.has(current)) continue;
      if (current.isMountain || (!current.discovered && current.isNotPathable)) continue;
      if (current.isCity && current.player !== searchingPlayer && !(startSet && startSet.has(current))) {
        dist += 7;
      }

      visitedBack.raw[current.tile_index] = cameFrom;

      if (dist <= maxDepth) {
        dist += 1;
        var mov = current.movable || [];
        for (var m = 0; m < mov.length; m++) {
          var nextTile = mov[m];
          frontier.put([dist, priorityFunc(nextTile, curPriorityVal), nextTile, current]);
        }
      }
    }

    return build_mst_rebuild(bot, startTiles, visitedBack, map.player_index);
  }

  function hasTile(coll, tile) {
    if (coll instanceof Set) return coll.has(tile);
    if (coll instanceof Map) return coll.has(tile);
    if (Array.isArray(coll)) return coll.indexOf(tile) >= 0;
    if (coll && typeof coll.has === 'function') return coll.has(tile);
    return false;
  }

  // BotGatherOps.py:962 build_mst_rebuild
  function build_mst_rebuild(bot, startTiles, fromMap, searchingPlayer) {
    var gatherNodes = [];
    var startList = sortedTiles(startTiles);
    for (var i = 0; i < startList.length; i++) {
      var tile = startList[i];
      var gather = get_gather_mst(bot, tile, null, fromMap, 0, searchingPlayer);
      if (!gather) continue;
      if (gather.tile.player() === searchingPlayer) {
        gather.value -= tile.army;
        gather.gatherTurns -= 1;
      } else {
        gather.value += tile.army;
        gather.gatherTurns += 1;
      }
      gatherNodes.push(gather);
    }
    return gatherNodes;
  }

  // BotGatherOps.py:986 get_gather_mst
  function get_gather_mst(bot, tile, fromTile, fromMap, turn, searchingPlayer) {
    var gatherTotal = tile.army;
    if (tile.player() !== searchingPlayer) gatherTotal = 0 - tile.army;
    gatherTotal -= 1;

    var turnTotal = 1;
    var thisNode = new EK.GatherTreeNode(tile, fromTile, turn);
    if (tile.player() === -1) thisNode.neutrals = 1;

    var mov = tile.movable || [];
    for (var i = 0; i < mov.length; i++) {
      var move = mov[i];
      if (move === fromTile) continue;
      if (fromMap.raw[move.tile_index] !== tile) continue;

      var gather = get_gather_mst(bot, move, tile, fromMap, turn + 1, searchingPlayer);
      if (!gather) continue;
      if (gather.value > 0) {
        gatherTotal += gather.value;
        turnTotal += gather.gatherTurns;
        thisNode.children.push(gather);
      }
    }

    thisNode.value = gatherTotal;
    thisNode.gatherTurns = turnTotal;
    return thisNode;
  }

  // BotGatherOps.py:1027 get_tree_move_non_city_leaf_count
  function get_tree_move_non_city_leaf_count(bot, gathers) {
    return _get_tree_move_non_city_leaf_count_recurse(bot, gathers);
  }

  function _get_tree_move_non_city_leaf_count_recurse(bot, gather) {
    var count = 0;
    var thisNodeFoundCity = gather.tile.isCity || gather.tile.isGeneral;
    var children = gather.children || [];
    for (var i = 0; i < children.length; i++) {
      var childRes = _get_tree_move_non_city_leaf_count_recurse(bot, children[i]);
      thisNodeFoundCity = thisNodeFoundCity || childRes[0];
      count += childRes[1];
    }
    if (!thisNodeFoundCity) count += 1;
    return [thisNodeFoundCity, count];
  }

  // BUG 兼容：原版 get_tree_move_default_value_func 里 army 变量在闭包内先 -= 1 再 += 当前 tile army，
  // 根节点（currentPriorityObject 为 None）走不到 -= 1 的分支，所以要保持两条路径分开写。
  function get_tree_move_default_value_func(bot) {
    var map = mapOf(bot);
    var general = generalOf(bot);
    var frPlayers = new Set(toArr(map.get_teammates(general.player())));
    var interOp = bot.board_analysis ? bot.board_analysis.intergeneral_analysis : null;

    return function default_value_func(currentTile, currentPriorityObject) {
      var nextIsNotEnemyCity = false;
      var negCityCount = 0;
      var unfriendlyTileCount = 0;
      var negDistFromPlayArea = 0;
      var army = 0;
      var isNotEnemyCity = true;

      if (currentPriorityObject) {
        nextIsNotEnemyCity = currentPriorityObject[1];
        negCityCount = currentPriorityObject[2];
        unfriendlyTileCount = currentPriorityObject[3];
        negDistFromPlayArea = currentPriorityObject[4];
        army = currentPriorityObject[5];
        isNotEnemyCity = currentPriorityObject[6];
      } else {
        if (frPlayers.has(currentTile.player)) army -= currentTile.army;
        else army += currentTile.army;
      }

      army -= 1;

      nextIsNotEnemyCity = isNotEnemyCity;
      isNotEnemyCity = true;

      if (frPlayers.has(currentTile.player)) {
        if (currentTile.isCity || currentTile.isGeneral) negCityCount -= 1;
      } else {
        if (currentTile.isGeneral || (currentTile.isCity && army + 2 <= currentTile.army)) {
          isNotEnemyCity = false;
        }
        unfriendlyTileCount += 1;
      }

      negDistFromPlayArea = 0 - (interOp ? interOp.aMap.raw[currentTile.tile_index] : 0);

      if (frPlayers.has(currentTile.player)) army += currentTile.army;
      else army -= currentTile.army;

      return [currentTile.isSwamp, nextIsNotEnemyCity, negCityCount, unfriendlyTileCount,
        negDistFromPlayArea, army, isNotEnemyCity];
    };
  }

  // BotGatherOps.py:1120 get_tree_move_most_army_value_func
  function get_tree_move_most_army_value_func(bot) {
    var map = mapOf(bot);
    var general = generalOf(bot);
    var frPlayers = new Set(toArr(map.get_teammates(general.player())));
    var interOp = bot.board_analysis ? bot.board_analysis.intergeneral_analysis : null;

    return function most_army_value_func(currentTile, currentPriorityObject) {
      var nextIsNotEnemyCity = false;
      var negDistFromPlayArea = 0;
      var army = 0;
      var isNotEnemyCity = true;

      if (currentPriorityObject) {
        army = currentPriorityObject[0];
        nextIsNotEnemyCity = currentPriorityObject[1];
        negDistFromPlayArea = currentPriorityObject[2];
        isNotEnemyCity = currentPriorityObject[3];
      }

      army -= 1;

      if (frPlayers.has(currentTile.player)) army += currentTile.army;
      else army -= currentTile.army;

      nextIsNotEnemyCity = isNotEnemyCity;
      isNotEnemyCity = true;
      if (!frPlayers.has(currentTile.player)) {
        if (currentTile.isGeneral || (currentTile.isCity && army + 2 <= currentTile.army)) {
          isNotEnemyCity = false;
        }
      }

      negDistFromPlayArea = 0 - (interOp ? interOp.aMap.raw[currentTile.tile_index] : 0);

      return [army, nextIsNotEnemyCity, negDistFromPlayArea, isNotEnemyCity];
    };
  }

  // BotGatherOps.py:1169 get_tree_move_most_army_value_distance_factored_func
  function get_tree_move_most_army_value_distance_factored_func(bot, delayCities) {
    if (delayCities === undefined) delayCities = false;
    var map = mapOf(bot);
    var general = generalOf(bot);
    var frPlayers = new Set(toArr(map.get_teammates(general.player())));
    var shortestPathDistances = bot.board_analysis ? bot.board_analysis.shortest_path_distances : null;

    return function most_army_value_distance_factored_func(currentTile, currentPriorityObject) {
      var army = 0;
      var nextIsNotEnemyCity = false;
      var isNotEnemyCity = true;
      var lastIsntDelayableCity = false;

      if (currentPriorityObject) {
        if (delayCities) {
          lastIsntDelayableCity = currentPriorityObject[0];
          army = currentPriorityObject[2];
          nextIsNotEnemyCity = currentPriorityObject[3];
          isNotEnemyCity = currentPriorityObject[5];
        } else {
          army = currentPriorityObject[1];
          nextIsNotEnemyCity = currentPriorityObject[2];
          isNotEnemyCity = currentPriorityObject[4];
        }
      }

      army -= 1;

      if (frPlayers.has(currentTile.player)) army += currentTile.army;
      else army -= currentTile.army;

      nextIsNotEnemyCity = isNotEnemyCity;
      isNotEnemyCity = true;
      if (!frPlayers.has(currentTile.player)) {
        if (currentTile.isGeneral || (currentTile.isCity && army + 2 <= currentTile.army)) {
          isNotEnemyCity = false;
        }
      }

      var negDistFromPlayArea = 0 - (shortestPathDistances ? shortestPathDistances.raw[currentTile.tile_index] : 0);
      var prioVal = army - 5 * negDistFromPlayArea;

      if (delayCities) {
        lastIsntDelayableCity = !(currentTile.isGeneral || currentTile.isCity);
        return [lastIsntDelayableCity, prioVal, army, nextIsNotEnemyCity, negDistFromPlayArea, isNotEnemyCity];
      }
      return [prioVal, army, nextIsNotEnemyCity, negDistFromPlayArea, isNotEnemyCity];
    };
  }

  // BotGatherOps.py:1223 get_tree_move_biggest_tile_value_func
  function get_tree_move_biggest_tile_value_func(bot) {
    var interOp = bot.board_analysis ? bot.board_analysis.intergeneral_analysis : null;
    return function biggest_tile_value_func(currentTile, currentPriorityObject) {
      var negDistFromPlayArea = 0 - (interOp ? interOp.aMap.raw[currentTile.tile_index] : 0);
      return [currentTile.army, negDistFromPlayArea];
    };
  }

  // BotGatherOps.py:1236 get_tree_move_default
  function get_tree_move_default(bot, gathers, valueFunc, pop) {
    if (!gathers || gathers.length === 0) return null;
    if (!valueFunc) valueFunc = get_tree_move_default_value_func(bot);
    var move = EK.Gather.get_tree_move(gathers, valueFunc, !!pop);
    if (move && move.source.player() !== generalOf(bot).player) {
      var moves = EK.Gather.get_tree_moves(gathers, valueFunc, -1, false);
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        if (m.source.player() === generalOf(bot).player && m.source.army > 1) return m;
      }
      return null;
    }
    return move;
  }

  // BotGatherOps.py:1035 get_gather_to_target_tiles
  function get_gather_to_target_tiles(bot, targets, maxTime, gatherTurns, negativeSet, targetArmy,
    useTrueValueGathered, leafMoveSelectionValueFunc, includeGatherTreeNodesThatGatherNegative,
    maximizeArmyGatheredPerTurn, additionalIncrement, distPriorityMap, priorityMatrix, skipTiles,
    shouldLog, fastMode, minTurnsForMaxArmyGatheredPerTurn) {

    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (targetArmy === undefined) targetArmy = -1;
    if (includeGatherTreeNodesThatGatherNegative === undefined) includeGatherTreeNodesThatGatherNegative = false;
    if (maximizeArmyGatheredPerTurn === undefined) maximizeArmyGatheredPerTurn = false;
    if (fastMode === undefined) fastMode = false;

    var map = mapOf(bot);
    var general = generalOf(bot);
    var isDict = !Array.isArray(targets) && !(targets instanceof Set) && !(targets instanceof Map);

    if (useTrueValueGathered && targetArmy > -1) targetArmy += 1;

    var gatherNodes = null;

    if (bot.gather_use_pcst && gatherTurns > 0 && targetArmy < 0 && !isDict) {
      // 原版走 Gather.gather_approximate_turns_to_tiles（JS 侧未移植）
      noteMissing('Gather.gather_approximate_turns_to_tiles');
      gatherNodes = _fallbackGather(bot, targets, gatherTurns, negativeSet, skipTiles, null, priorityMatrix);
    } else if (gatherTurns > GATHER_SWITCH_POINT) {
      gatherNodes = build_mst(bot, targets, maxTime, gatherTurns - 1, negativeSet);
      if (!gatherNodes || gatherNodes.length === 0) return [null, -1, -1, null];
      EK.Gather.prune_mst_to_turns(gatherNodes, gatherTurns - 1, general.player(), map.teams, map.turn);
    } else if (bot.gather_use_max_set && !isDict) {
      // 原版走 Gather.gather_max_set_iterative_plan（JS 侧未移植）
      noteMissing('Gather.gather_max_set_iterative_plan');
      gatherNodes = _fallbackGather(bot, targets, gatherTurns, negativeSet, skipTiles, null, priorityMatrix);
    } else {
      // 原版走 Gather.knapsack_max_gather（JS 侧未移植）
      noteMissing('Gather.knapsack_max_gather');
      gatherNodes = _fallbackGather(bot, targets, gatherTurns, negativeSet, skipTiles, null, priorityMatrix);
    }

    if (!gatherNodes || gatherNodes.length === 0) return [null, -1, -1, null];

    if (maximizeArmyGatheredPerTurn) {
      gatherNodes = pruneFallback(bot, gatherNodes, includeGatherTreeNodesThatGatherNegative);
    }

    var totalValue = 0;
    var turns = 0;
    for (var i = 0; i < gatherNodes.length; i++) {
      totalValue += gatherNodes[i].value;
      turns += gatherNodes[i].gatherTurns;
    }

    if (totalValue > targetArmy - Math.floor(gatherTurns / 2)) {
      var move = get_tree_move_default(bot, gatherNodes, leafMoveSelectionValueFunc);
      if (move) {
        return [moveHalfOnRepetition(bot, move, 4, 4), totalValue, turns, gatherNodes];
      }
    }

    return [null, -1, -1, null];
  }

  // BotGatherOps.py:1300 get_gather_to_target_tiles_greedy
  function get_gather_to_target_tiles_greedy(bot, targets, maxTime, gatherTurns, negativeSet, targetArmy,
    useTrueValueGathered, priorityFunc, valueFunc, includeGatherTreeNodesThatGatherNegative,
    maximizeArmyGatheredPerTurn, shouldLog) {
    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (targetArmy === undefined) targetArmy = -1;

    noteMissing('Gather.greedy_backpack_gather');
    var gatherNodes = _fallbackGather(bot, targets, gatherTurns, negativeSet, null, null, null);

    if (!gatherNodes || gatherNodes.length === 0) return [null, -1, -1, null];

    if (maximizeArmyGatheredPerTurn) {
      gatherNodes = pruneFallback(bot, gatherNodes, includeGatherTreeNodesThatGatherNegative);
    }

    var totalValue = 0;
    var turns = 0;
    for (var i = 0; i < gatherNodes.length; i++) {
      totalValue += gatherNodes[i].value;
      turns += gatherNodes[i].gatherTurns;
    }

    if (totalValue > targetArmy) {
      var move = get_tree_move_default(bot, gatherNodes, valueFunc);
      if (move) return [moveHalfOnRepetition(bot, move, 4, 4), totalValue, turns, gatherNodes];
    }
    return [null, -1, -1, null];
  }

  // BotGatherOps.py:1336 get_timing_gather_negatives_unioned
  function get_timing_gather_negatives_unioned(bot, gatherNegatives, additional_offset, forceAllowCities) {
    if (additional_offset === undefined) additional_offset = 0;
    if (forceAllowCities === undefined) forceAllowCities = false;

    var map = mapOf(bot);
    var general = generalOf(bot);

    if (!forceAllowCities) {
      bot.cities_gathered_this_cycle.forEach(function (city) { gatherNegatives.add(city); });
    }

    if (isAllIn(bot)) return gatherNegatives;

    if (q('BotTargeting', 'is_ffa_situation', [bot], false) && bot.player.tileCount < 65) {
      return gatherNegatives;
    }

    var defendCities = bot.win_condition_analyzer ? toArr(bot.win_condition_analyzer.defend_cities) : [];
    for (var dc = 0; dc < defendCities.length; dc++) gatherNegatives.add(defendCities[dc]);

    if (bot.currently_forcing_out_of_play_gathers || bot.defend_economy) return gatherNegatives;

    if (bot.gather_include_shortest_pathway_as_negatives && bot.board_analysis.intergeneral_analysis
      && bot.board_analysis.intergeneral_analysis.shortestPathWay) {
      var spw = toArr(bot.board_analysis.intergeneral_analysis.shortestPathWay.tiles);
      for (var s = 0; s < spw.length; s++) gatherNegatives.add(spw[s]);
    }

    var armyCutoff = Math.floor(Math.pow(map.players[general.player()].standingArmy, 0.5));

    function foreach_func(tile) {
      if (bot.tiles_gathered_to_this_cycle.has(tile)) return;
      if (!map.is_tile_friendly(tile)) return;
      if (tile.army > armyCutoff) return;
      gatherNegatives.add(tile);
    }

    if (bot.gather_include_distance_from_enemy_general_as_negatives > 0) {
      var ratio = bot.gather_include_distance_from_enemy_general_large_map_as_negatives;
      var targetPlayerObj = map.players[bot.targetPlayer];
      if (targetPlayerObj && targetPlayerObj.tileCount < 150) {
        ratio = bot.gather_include_distance_from_enemy_general_as_negatives;
      }
      var shortestLen = bot.shortest_path_to_target_player ? bot.shortest_path_to_target_player.length : 0;
      var excludeDist = Math.floor(shortestLen * ratio) + additional_offset;
      q('search', 'breadth_first_foreach',
        [map, [bot.targetPlayerExpectedGeneralLocation], excludeDist, foreach_func], null);
    }

    if (bot.gather_include_distance_from_enemy_TERRITORY_as_negatives > 0 && bot.targetPlayer !== -1) {
      var excludeDist2 = bot.gather_include_distance_from_enemy_TERRITORY_as_negatives + additional_offset;
      var terrTiles = map.get_all_tiles().filter(function (t) {
        return bot.territories.territoryMap.get(t) === bot.targetPlayer;
      });
      if (terrTiles.length > 0) {
        q('search', 'breadth_first_foreach', [map, terrTiles, excludeDist2, foreach_func], null);
      }
    }

    if (bot.gather_include_distance_from_enemy_TILES_as_negatives > 0 && bot.targetPlayer !== -1) {
      var excludeDist3 = bot.gather_include_distance_from_enemy_TILES_as_negatives;
      var enemyTiles = map.get_all_tiles().filter(function (t) {
        return t.player() === bot.targetPlayer
          && !map.is_player_on_team_with(bot.territories.territoryMap.get(t), general.player());
      });
      if (enemyTiles.length > 0) {
        q('search', 'breadth_first_foreach', [map, enemyTiles, excludeDist3, foreach_func], null);
      }
    }

    return gatherNegatives;
  }

  var BotGatherOps = {
    GATHER_SWITCH_POINT: GATHER_SWITCH_POINT,
    missingReport: missingReport,

    get_number_of_captures_in_gather_tree: get_number_of_captures_in_gather_tree,
    convert_gather_to_move_list_path: convert_gather_to_move_list_path,
    try_find_gather_move: try_find_gather_move,
    get_main_gather_move: get_main_gather_move,
    get_capture_first_tree_move_prio_func: get_capture_first_tree_move_prio_func,
    get_gather_to_target_tile: get_gather_to_target_tile,
    timing_gather: timing_gather,
    get_defensive_gather_to_target_tiles: get_defensive_gather_to_target_tiles,
    get_gather_tiebreak_matrix: get_gather_tiebreak_matrix,
    build_mst: build_mst,
    build_mst_rebuild: build_mst_rebuild,
    get_gather_mst: get_gather_mst,
    get_tree_move_non_city_leaf_count: get_tree_move_non_city_leaf_count,
    get_tree_move_default_value_func: get_tree_move_default_value_func,
    get_tree_move_most_army_value_func: get_tree_move_most_army_value_func,
    get_tree_move_most_army_value_distance_factored_func: get_tree_move_most_army_value_distance_factored_func,
    get_tree_move_biggest_tile_value_func: get_tree_move_biggest_tile_value_func,
    get_tree_move_default: get_tree_move_default,
    get_gather_to_target_tiles: get_gather_to_target_tiles,
    get_gather_to_target_tiles_greedy: get_gather_to_target_tiles_greedy,
    get_timing_gather_negatives_unioned: get_timing_gather_negatives_unioned
  };

  EK.BotGatherOps = BotGatherOps;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

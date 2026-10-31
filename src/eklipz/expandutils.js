// ExpandUtils — JS port of EklipZgit/generals-bot ExpandUtils.py
// 搬运原则：数值/顺序/分支与原版逐行对应；日志、ViewInfo 渲染、perfTimer 事件不上屏。
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // ExpandUtils 从 ArmyInterceptor 导入的常量（ArmyInterceptor.py:28/30）
  var TARGET_CAP_VALUE = 2.1;
  var NEUTRAL_CAP_VALUE = 1.0;
  var ENEMY_TILE_CAP_VALUE = 2.05;
  var ENEMY_EXPANSION_TILE_PENALTY = 0.85;

  function opt(o, k, d) {
    if (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined) return o[k];
    return d;
  }

  function floorDiv(a, b) { return Math.floor(a / b); }

  // Python 的数组容器在 JS 里可能是 Set 或数组，统一判成员
  function hasTile(coll, tile) {
    if (!coll) return false;
    if (coll instanceof Set) return coll.has(tile);
    return coll.indexOf(tile) !== -1;
  }

  // Python 里 team 数组用负索引取“最后一项”（-1 = 中立队）
  function teamSlot(arr, team) {
    if (!arr) return undefined;
    var idx = team < 0 ? arr.length + team : team;
    return arr[idx];
  }

  function teamOf(teams, player) {
    if (player < 0) return teamSlot(teams, player);
    return teams[player];
  }

  // map.py:892 的 is_player_on_team_with 在 map.js 里没有移植
  function isPlayerOnTeamWith(map, p1, p2) {
    var tids = map.team_ids_by_player_index;
    if (p1 < 0 || p2 < 0) return false;
    return teamOf(tids, p1) === teamOf(tids, p2);
  }

  function getTeamsArray(map) {
    if (EK.Map && EK.Map.get_teams_array) return EK.Map.get_teams_array(map);
    return map.team_ids_by_player_index;
  }

  function S() { return EK.search; }

  function where(coll, f) { return S().where(coll, f); }
  function anyWhere(coll, f) { return S().any_where(coll, f); }
  function countWhere(coll, f) { return S().count(coll, f); }

  // Python sorted(key=..., reverse=True)：稳定排序，同键保持原顺序
  function sortedByKey(arr, keyFn, reverse) {
    var decorated = [];
    for (var i = 0; i < arr.length; i++) decorated.push({ k: keyFn(arr[i]), i: i, v: arr[i] });
    decorated.sort(function (a, b) {
      if (a.k < b.k) return reverse ? 1 : -1;
      if (a.k > b.k) return reverse ? -1 : 1;
      return a.i - b.i;
    });
    var out = [];
    for (var j = 0; j < decorated.length; j++) out.push(decorated[j].v);
    return out;
  }

  function sortedByTupleKey(arr, keyFn) {
    // keyFn 返回数字数组，按元素字典序比较（模拟 Python 元组排序）
    var decorated = [];
    for (var i = 0; i < arr.length; i++) decorated.push({ k: keyFn(arr[i]), i: i, v: arr[i] });
    decorated.sort(function (a, b) {
      var n = Math.min(a.k.length, b.k.length);
      for (var t = 0; t < n; t++) {
        if (a.k[t] < b.k[t]) return -1;
        if (a.k[t] > b.k[t]) return 1;
      }
      return a.i - b.i;
    });
    var out = [];
    for (var j = 0; j < decorated.length; j++) out.push(decorated[j].v);
    return out;
  }

  function findLastIndex(arr, pred) {
    for (var i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
    return -1;
  }

  // ---------------------------------------------------------------------
  // RoundPlan
  // ---------------------------------------------------------------------
  function RoundPlan(enTilesCaptured, neutTilesCaptured, selectedOption, allOptions, turn) {
    this.turns_used = 0;
    this.en_tiles_captured = enTilesCaptured;
    this.neut_tiles_captured = neutTilesCaptured;
    this.selected_option = selectedOption;
    this.all_paths = allOptions;
    this.plan_tiles = new Set();
    this.calculated_turn = turn;
    this.includes_intercept = false;
    var cumulativeValue = 0.0;
    for (var i = 0; i < allOptions.length; i++) {
      var so = allOptions[i];
      cumulativeValue += so.econValue;
      this.turns_used += so.length;
      var tiles = so.tileSet;
      var it = tiles instanceof Set ? tiles.values() : tiles;
      for (var r = it.next(); !r.done; r = it.next()) this.plan_tiles.add(r.value);
    }
    this.cumulative_econ_value = cumulativeValue;
  }

  function planCapturesCity(plan, friendlyPlayers) {
    var it = plan.tileSet instanceof Set ? plan.tileSet.values() : plan.tileSet;
    for (var r = it.next(); !r.done; r = it.next()) {
      var tile = r.value;
      if (tile.isCity && friendlyPlayers.indexOf(tile.player()) === -1) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // KnapsackUtils.solve_multiple_choice_knapsack（GB_PURE_PY_KNAPSACK=1 走纯 Python 版）
  // ---------------------------------------------------------------------
  function solveMultipleChoiceKnapsack(items, capacity, weights, values, groups, noLog, longRuntimeThreshold) {
    if (longRuntimeThreshold === undefined) longRuntimeThreshold = 0.005;
    var groupStartEnds = [];
    if (groups[0] !== 0) {
      throw new Error('Groups must start with 0 and increment by one for each new group. Items should be ordered by group.');
    }

    var lastGroup = -1;
    var lastGroupIndex = 0;
    var maxGroupSize = 0;
    var curGroupSize = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      if (group > lastGroup) {
        if (curGroupSize > maxGroupSize) maxGroupSize = curGroupSize;
        if (lastGroup > -1) {
          groupStartEnds.push([lastGroupIndex, gi]);
          curGroupSize = 0;
        }
        if (group > lastGroup + 1) {
          throw new Error('Groups must have no gaps. if you have group 0, and 2, group 1 must be included between them.');
        }
        lastGroupIndex = gi;
        lastGroup = group;
      }
      curGroupSize += 1;
    }
    groupStartEnds.push([lastGroupIndex, groups.length]);
    if (curGroupSize > maxGroupSize) maxGroupSize = curGroupSize;

    var n = values.length;
    var K = [];
    for (var ki = 0; ki <= n; ki++) {
      var row = new Array(capacity + 1);
      for (var kj = 0; kj <= capacity; kj++) row[kj] = 0;
      K.push(row);
    }

    var maxGrSq = Math.sqrt(maxGroupSize);
    var estTime = n * capacity * maxGrSq * 0.00000022;
    if (maxGroupSize === n) estTime = n * capacity * 0.00000022;
    if (estTime > longRuntimeThreshold) {
      throw new Error('Knapsack potential long run est ' + estTime.toFixed(3) + ': the inputs are going to result in a substantial runtime');
    }

    for (var curCapacity = 0; curCapacity <= capacity; curCapacity++) {
      for (var i = 0; i <= n; i++) {
        if (i === 0 || curCapacity === 0) {
          K[i][curCapacity] = 0;
        } else if (weights[i - 1] <= curCapacity) {
          var subMax = 0;
          var prevGroup = groups[i - 1] - 1;
          var subKRow = curCapacity - weights[i - 1];
          if (prevGroup > -1) {
            var range = groupStartEnds[prevGroup];
            for (var j = range[0] + 1; j <= range[1]; j++) {
              if (groups[j - 1] === prevGroup && K[j][subKRow] > subMax) subMax = K[j][subKRow];
            }
          }
          var takeVal = subMax + values[i - 1];
          K[i][curCapacity] = takeVal > K[i - 1][curCapacity] ? takeVal : K[i - 1][curCapacity];
        } else {
          K[i][curCapacity] = K[i - 1][curCapacity];
        }
      }
    }

    var res = K[n][capacity];
    var includedItems = [];
    var w = capacity;
    var lastTakenGroup = -1;
    for (var bi = n; bi > 0; bi--) {
      if (res <= 0) break;
      if (w < 0) throw new Error('w < 0 in knapsack items determiner?? res ' + res + ' i ' + bi + ' w ' + w);
      if (res === K[bi - 1][w]) continue;
      var bGroup = groups[bi - 1];
      if (bGroup === lastTakenGroup) continue;
      lastTakenGroup = bGroup;
      includedItems.push(items[bi - 1]);
      res = res - values[bi - 1];
      w = w - weights[bi - 1];
    }

    return [K[n][capacity], includedItems];
  }

  // ---------------------------------------------------------------------
  // get_round_plan_with_expansion
  // ---------------------------------------------------------------------
  function get_round_plan_with_expansion(map, searchingPlayer, targetPlayer, turns, boardAnalysis, territoryMap, tileIslands, opts) {
    opts = opts || {};

    var additionalOptionValues = opt(opts, 'additionalOptionValues', null);
    var leafMoves = opt(opts, 'leafMoves', null);

    if (additionalOptionValues) {
      additionalOptionValues = where(additionalOptionValues, function (v) {
        return (v.requiredDelay || 0) + v.length <= turns;
      });
    }
    if (leafMoves) {
      leafMoves = where(leafMoves, function (m) {
        return m.source.player() === searchingPlayer && m.source.army > 1;
      });
    }
    if (turns <= 0) throw new Error('turns ' + turns + ' <= 0 in optimal_expansion...');

    var allowLeafMoves = opt(opts, 'allowLeafMoves', true);
    var useLeafMovesFirst = opt(opts, 'useLeafMovesFirst', false);
    var singleIterationPathTimeCap = opt(opts, 'singleIterationPathTimeCap', 0.03);
    var forceNoGlobalVisited = opt(opts, 'forceNoGlobalVisited', true);
    var forceGlobalVisitedStage1 = opt(opts, 'forceGlobalVisitedStage1', false);
    var useIterativeNegTiles = opt(opts, 'useIterativeNegTiles', false);
    var allowGatherPlanExtension = opt(opts, 'allowGatherPlanExtension', false);
    var includeExpansionSearch = opt(opts, 'includeExpansionSearch', true);
    var alwaysIncludeNonTerminatingLeavesInIteration = opt(opts, 'alwaysIncludeNonTerminatingLeavesInIteration', false);
    var smallTileExpansionTimeRatio = opt(opts, 'smallTileExpansionTimeRatio', 1.0);
    var lengthWeightOffset = opt(opts, 'lengthWeightOffset', -0.3);
    var timeLimit = opt(opts, 'time_limit', 0.2);
    var useCutoff = opt(opts, 'useCutoff', true);
    var bonusCapturePointMatrix = opt(opts, 'bonusCapturePointMatrix', null);
    var useBonusMatrix = bonusCapturePointMatrix !== null;
    var threatBlockingTiles = opt(opts, 'threatBlockingTiles', null);
    var includeExtraGenAndCityArmy = opt(opts, 'includeExtraGenAndCityArmy', false);
    var skipKnapsacking = opt(opts, 'skipKnapsacking', false);

    var paths = [];

    var originalNegativeTiles = opt(opts, 'negativeTiles', null);
    var negativeTiles = new Set(originalNegativeTiles || []);
    if (originalNegativeTiles === null) originalNegativeTiles = new Set();
    var realCapMat = bonusCapturePointMatrix;
    var realNegs = negativeTiles;
    var teams = getTeamsArray(map);
    var targetTeamId = teamOf(teams, targetPlayer);
    var friendlyTeamId = teamOf(teams, searchingPlayer);
    var targetPlayers = [];
    var friendlyPlayers = [];
    for (var ti = 0; ti < teams.length; ti++) {
      if (teams[ti] === targetTeamId) targetPlayers.push(ti);
      if (teams[ti] === friendlyTeamId) friendlyPlayers.push(ti);
    }
    var remainingTurns = turns;

    var enemyDistMap = boardAnalysis.intergeneral_analysis.bMap;
    var generalDistMap = boardAnalysis.intergeneral_analysis.aMap;

    var enemyDistPenaltyPoint = floorDiv(boardAnalysis.inter_general_distance, 3);
    if (turns < 12) enemyDistPenaltyPoint -= 1;
    if (turns < 8) enemyDistPenaltyPoint = floorDiv(boardAnalysis.inter_general_distance, 4);
    if (turns < 5) enemyDistPenaltyPoint = floorDiv(boardAnalysis.inter_general_distance, 6);
    if (turns < 3) enemyDistPenaltyPoint = 0;

    var logStuff = false;

    var postPathEvalFunction = function (path, negTiles) {
      if (path instanceof EK.Path && path.econValue === 0.0) {
        var value = 0.0;
        var last = path.start.tile;
        var nextNode = path.start.next;
        while (nextNode !== null && nextNode !== undefined) {
          var tile = nextNode.tile;
          value += getTilePathValue(map, tile, last, negTiles, targetPlayers, searchingPlayer, enemyDistMap, generalDistMap, territoryMap, enemyDistPenaltyPoint, realCapMat);
          last = tile;
          nextNode = nextNode.next;
        }
        path.econValue = value;
        return value;
      }
      return path.econValue;
    };

    var pathsCrossingTiles = new Map();
    var tryAvoidSet = new Set(negativeTiles);
    var defaultNoPathValue = [0, null];
    var multiPathDict = new Map();
    var alwaysIncludes = [];
    var includeForGath = [];

    if (additionalOptionValues !== null) {
      var addlPaths = sortedByKey(additionalOptionValues, function (p) { return p.econValue / p.length; }, true);
      for (var ai = 0; ai < addlPaths.length; ai++) {
        var option = addlPaths[ai];
        tryIncludeAltSourcedPath(map, searchingPlayer, defaultNoPathValue, multiPathDict, negativeTiles,
          option, paths, pathsCrossingTiles, postPathEvalFunction, tryAvoidSet,
          false, option.econValue, option.length);
      }
    }

    if (allowLeafMoves && leafMoves !== null) {
      if (useLeafMovesFirst) {
        includeLeafMovesInExpPlan(allowGatherPlanExtension, alwaysIncludes, defaultNoPathValue, includeForGath,
          leafMoves, map, multiPathDict, negativeTiles, paths, pathsCrossingTiles, postPathEvalFunction,
          searchingPlayer, targetPlayers, tryAvoidSet, useIterativeNegTiles, true, false);
      } else if (useBonusMatrix) {
        bonusCapturePointMatrix = bonusCapturePointMatrix.copy();
        negativeTiles = new Set(realNegs);
        for (var lmi = 0; lmi < leafMoves.length; lmi++) {
          var lm = leafMoves[lmi];
          var cost = 0.1;
          if (lm.dest.player() !== -1) cost = 0.2;
          bonusCapturePointMatrix.raw[lm.source.tile_index] -= cost;
          bonusCapturePointMatrix.raw[lm.dest.tile_index] -= cost;
        }
      }
    }

    if (allowGatherPlanExtension) {
      var gathStarts = [];
      for (var ii = 0; ii < includeForGath.length; ii++) {
        var m = includeForGath[ii];
        if (!negativeTiles.has(m.source) && !negativeTiles.has(m.dest)) gathStarts.push(m.dest);
      }
      var addlGath = executeExpansionGatherToBorders(map, gathStarts, 3, null, null, negativeTiles, null,
        searchingPlayer, null, null, null, true, true, true, null, false, null);

      var counts = new Map();
      for (var pi = 0; pi < addlGath.length; pi++) {
        var p = addlGath[pi];
        for (var tl = 0; tl < p.tileList.length; tl++) {
          var idx = p.tileList[tl].tile_index;
          counts.set(idx, (counts.get(idx) || 0) + 1);
        }
      }
      addlGath = sortedByKey(addlGath, function (pa) {
        var sum = 0;
        for (var t2 = 0; t2 < pa.tileList.length; t2++) sum += counts.get(pa.tileList[t2].tile_index) || 0;
        return sum;
      }, false);

      for (var gi2 = 0; gi2 < addlGath.length; gi2++) {
        var gp = addlGath[gi2];
        if (anyWhere(gp.tileList, function (t) { return negativeTiles.has(t); })) continue;
        tryIncludeAltSourcedPath(map, searchingPlayer, defaultNoPathValue, multiPathDict, negativeTiles,
          gp, paths, pathsCrossingTiles, postPathEvalFunction, tryAvoidSet,
          useIterativeNegTiles, null, -1);
      }
    }

    if (allowLeafMoves && leafMoves !== null && useLeafMovesFirst) {
      includeLeafMovesInExpPlan(allowGatherPlanExtension, null, defaultNoPathValue, null,
        leafMoves, map, multiPathDict, negativeTiles, paths, pathsCrossingTiles, postPathEvalFunction,
        searchingPlayer, targetPlayers, tryAvoidSet, useIterativeNegTiles, false, false);
    }

    negativeTiles = realNegs;
    if (includeExpansionSearch) {
      var blocks = new EK.MapMatrix(map, null);
      if (threatBlockingTiles) {
        threatBlockingTiles.forEach(function (threatBlockInf, tile) {
          blocks.raw[tile.tile_index] = threatBlockInf;
        });
      }
      includeOptimalExpansionOptions(
        map, multiPathDict, generalDistMap, enemyDistMap, territoryMap, targetPlayer, targetPlayers,
        friendlyPlayers, searchingPlayer, negativeTiles, bonusCapturePointMatrix, tileIslands,
        enemyDistPenaltyPoint, alwaysIncludes, tryAvoidSet, pathsCrossingTiles, useCutoff, logStuff,
        alwaysIncludeNonTerminatingLeavesInIteration, smallTileExpansionTimeRatio,
        singleIterationPathTimeCap, timeLimit, useIterativeNegTiles, forceNoGlobalVisited,
        forceGlobalVisitedStage1, postPathEvalFunction, defaultNoPathValue, blocks, turns,
        lengthWeightOffset, includeExtraGenAndCityArmy);
    }

    bonusCapturePointMatrix = realCapMat;

    if (allowLeafMoves && leafMoves !== null) {
      includeLeafMovesInExpPlan(allowGatherPlanExtension, null, defaultNoPathValue, null,
        leafMoves, map, multiPathDict, negativeTiles, paths, pathsCrossingTiles, postPathEvalFunction,
        searchingPlayer, targetPlayers, tryAvoidSet, useIterativeNegTiles, false, true);
    }

    var valueOverrides = new Map();
    if (additionalOptionValues !== null) {
      for (var vi = 0; vi < additionalOptionValues.length; vi++) {
        var o = additionalOptionValues[vi];
        if (o.length + (o.requiredDelay || 0) >= remainingTurns) continue;
        valueOverrides.set(o, [o.econValue, o.length]);
      }
    }

    if (skipKnapsacking && additionalOptionValues) {
      var maxPathsSkip = additionalOptionValues.slice();
      var pathSkip = findOptimalExpansionPathToMoveFirst(map, maxPathsSkip, tryAvoidSet, originalNegativeTiles,
        postPathEvalFunction, remainingTurns, searchingPlayer, friendlyPlayers, territoryMap, valueOverrides);
      var otherSkip = where(maxPathsSkip, function (p2) { return p2 !== pathSkip; });
      otherSkip = sortedByKey(otherSkip, function (pa) {
        return postPathEvalFunction(pa, originalNegativeTiles) / pa.length;
      }, true);
      var countsSkip = getCaptureCounts(searchingPlayer, friendlyPlayers, targetPlayers, pathSkip, otherSkip,
        originalNegativeTiles, valueOverrides, leafMoves);
      if (pathSkip !== null) otherSkip.unshift(pathSkip);
      return new RoundPlan(countsSkip[1], countsSkip[2], pathSkip, otherSkip, map.turn);
    }

    var knap = knapsackMultiPaths(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
      pathsCrossingTiles, multiPathDict, territoryMap, postPathEvalFunction,
      new Set(originalNegativeTiles), tryAvoidSet, null, valueOverrides, leafMoves);
    var maxPaths = knap[0];
    var totalValue = knap[1];

    var altKnap = knapsackMultiPathsNoCrossover(map, searchingPlayer, friendlyPlayers, targetPlayers,
      remainingTurns, pathsCrossingTiles, multiPathDict, territoryMap, postPathEvalFunction,
      new Set(originalNegativeTiles), tryAvoidSet, null, valueOverrides, leafMoves);
    var altMaxPaths = altKnap[0];
    var altTotalValue = altKnap[1];

    if (altTotalValue > totalValue) {
      maxPaths = altMaxPaths;
      totalValue = altTotalValue;
    }

    var path = findOptimalExpansionPathToMoveFirst(map, maxPaths, tryAvoidSet, originalNegativeTiles,
      postPathEvalFunction, remainingTurns, searchingPlayer, friendlyPlayers, territoryMap, valueOverrides);

    var otherPaths = where(maxPaths, function (p3) { return p3 !== path; });
    otherPaths = sortedByKey(otherPaths, function (pa) {
      return postPathEvalFunction(pa, originalNegativeTiles) / pa.length;
    }, true);

    var counts = getCaptureCounts(searchingPlayer, friendlyPlayers, targetPlayers, path, otherPaths,
      originalNegativeTiles, valueOverrides, leafMoves);

    var tilesInKnapsackOtherThanCurrent = new Set();
    if (path !== null) otherPaths.unshift(path);
    var plan = new RoundPlan(counts[1], counts[2], path, otherPaths, map.turn);

    if (path === null) return plan;

    var shouldConsiderMoveHalf = shouldConsiderPathMoveHalf(map, path, tilesInKnapsackOtherThanCurrent,
      searchingPlayer, generalDistMap, enemyDistMap,
      boardAnalysis.within_extended_play_area_threshold, boardAnalysis.within_core_play_area_threshold);

    if (!shouldConsiderMoveHalf) return plan;

    if (path instanceof EK.Path) {
      path.start.move_half = true;
      var val = path.calculate_value(searchingPlayer, map.team_ids_by_player_index, originalNegativeTiles);
      if (val <= 0) {
        path.start.move_half = false;
        path.calculate_value(searchingPlayer, map.team_ids_by_player_index, originalNegativeTiles);
      }
    }

    return plan;
  }

  // ---------------------------------------------------------------------
  // _include_optimal_expansion_options
  // ---------------------------------------------------------------------
  function includeOptimalExpansionOptions(map, multiPathDict, generalDistMap, enemyDistMap, territoryMap,
    targetPlayer, targetPlayers, friendlyPlayers, searchingPlayer, negativeTiles, bonusCapturePointMatrix,
    tileIslands, enemyDistPenaltyPoint, alwaysIncludes, tryAvoidSet, pathsCrossingTiles, useCutoff, logStuff,
    alwaysIncludeNonTerminatingLeavesInIteration, smallTileExpansionTimeRatio, singleIterationPathTimeCap,
    time_limit, useIterativeNegTiles, forceNoGlobalVisited, forceGlobalVisitedStage1, postPathEvalFunction,
    defaultNoPathValue, threatBlockingTiles, turns, lengthWeightOffset, includeExtraGenAndCityArmy) {

    var remainingTurns = turns;
    var startTime = Date.now();

    var targetTeam = -1;
    if (targetPlayer >= 0) targetTeam = map.players[targetPlayer].team;

    var largeIslandSet = teamSlot(tileIslands.large_tile_islands_by_team_id, targetTeam) || new Set();
    var distanceToLargeIslandsMap = teamSlot(tileIslands.large_tile_island_distances_by_team_id, targetTeam);
    var bonusCityAndGenArmy = 0;
    if (includeExtraGenAndCityArmy) bonusCityAndGenArmy = floorDiv(turns, 2);

    if (!distanceToLargeIslandsMap) distanceToLargeIslandsMap = teamSlot(tileIslands.large_tile_island_distances_by_team_id, -1);
    if (!distanceToLargeIslandsMap) distanceToLargeIslandsMap = enemyDistMap;

    var generalPlayer = map.players[searchingPlayer];
    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();

    var cityUsages = new Map();
    var wastedMoveCap = Math.min(7, Math.max(3, floorDiv(turns, 4))) + 1;
    var iter = [0];

    function skip_after_out_of_army(nextTile, nextVal) {
      var wastedMoves = nextVal[3];
      var tileCapturePoints = nextVal[4];
      var negArmyRemaining = nextVal[5];
      if (negArmyRemaining >= 0 || (wastedMoves > wastedMoveCap && tileCapturePoints > -5)) return true;
      if (nextTile.isCity && nextTile.isNeutral) return true;
      return false;
    }

    function value_priority_army_dist_basic(currentTile, priorityObject) {
      var distSoFar = priorityObject[0];
      var tileCapturePoints = priorityObject[4];
      var negArmyRemaining = priorityObject[5];
      var value = -1000;
      var dist = 1;
      if (negativeTiles.has(currentTile) || negArmyRemaining >= 0 || distSoFar === 0) return null;
      if (map.is_tile_on_team_with(currentTile, searchingPlayer)) return null;
      if (currentTile.isCity && currentTile.isNeutral) return null;
      if (currentTile.isDesert && currentTile.player() === -1) return null;
      if (currentTile.isSwamp) return null;

      if (distSoFar > 0 && tileCapturePoints < 0) {
        dist = distSoFar + lengthWeightOffset;
        value = 0 - tileCapturePoints;
      }
      if (value <= 0) return null;
      var valuePerTurn = value / dist;
      return [value, valuePerTurn, 0 - negArmyRemaining, 0 - distSoFar];
    }

    function default_priority_func_basic(nextTile, currentPriorityObject) {
      var distSoFar = currentPriorityObject[0];
      var fakeDistSoFar = currentPriorityObject[2];
      var wastedMoves = currentPriorityObject[3];
      var negTileCapturePoints = currentPriorityObject[4];
      var negArmyRemaining = currentPriorityObject[5];
      var negEnemyTiles = currentPriorityObject[6];
      var negNeutralTiles = currentPriorityObject[7];
      var pathPriority = currentPriorityObject[8];
      var tileSetSoFar = currentPriorityObject[9];
      var fromTile = currentPriorityObject[10];
      var hitIsland = currentPriorityObject[11];

      if (hitIsland) return null;
      if (fromTile) {
        var blocks = threatBlockingTiles.raw[fromTile.tile_index];
        if (blocks && hasTile(blocks.blocked_destinations, nextTile)) return null;
      }

      var nextTerritory = territoryMap.raw[nextTile.tile_index];
      var armyRemaining = 0 - negArmyRemaining;
      distSoFar += 1;
      fakeDistSoFar += 1;
      if (nextTile.player() === -1 && targetPlayers.indexOf(nextTerritory) === -1) fakeDistSoFar += 1;

      armyRemaining -= 1;

      if (tileSetSoFar.has(nextTile.tile_index)) return null;

      var nextTileSet = new Set(tileSetSoFar);
      nextTileSet.add(nextTile.tile_index);

      var cutoffEnemyDist = Math.abs(enemyDistMap.raw[nextTile.tile_index] - enemyDistPenaltyPoint);
      var addedPriority = 3 * (0 - Math.sqrt(cutoffEnemyDist) + 1);

      var cutoffGenDist = Math.abs(generalDistMap.raw[nextTile.tile_index]);
      addedPriority += 3 * (Math.sqrt(cutoffGenDist) - 1);

      if (negativeTiles === null || !negativeTiles.has(nextTile)) {
        if (friendlyPlayers.indexOf(nextTile.player()) !== -1) {
          armyRemaining += nextTile.army;
        } else {
          if (nextTile.player() === -1 && nextTile.army < 0) negTileCapturePoints += nextTile.army;
          armyRemaining -= nextTile.army;
        }
      }
      if (armyRemaining <= 0) return null;

      var usefulMove = !negativeTiles.has(nextTile);

      if (tryAvoidSet.has(nextTile) || negativeTiles.has(nextTile) || tileSetSoFar.has(nextTile) || nextTile.isSwamp) {
        addedPriority -= 1;
        usefulMove = false;
        wastedMoves += 0.5;
      } else if (targetPlayer !== -1 && targetPlayers.indexOf(nextTile.player()) !== -1) {
        if (!nextTile.isDesert) {
          addedPriority += 8;
          negTileCapturePoints -= 2.0;
          distSoFar -= 0.99;
        }
        negEnemyTiles -= 1;
      } else if (nextTile.player() === -1) {
        negNeutralTiles -= 1;
        negTileCapturePoints -= 1;
        addedPriority += 2;
      } else {
        addedPriority -= 1;
        usefulMove = false;
        wastedMoves += 0.5;
      }

      if (tryAvoidSet.has(nextTile)) {
        addedPriority -= 5;
        negTileCapturePoints += 0.2;
      }
      if (nextTile.isSwamp) {
        negTileCapturePoints += 1.1;
        distSoFar += 2.1;
      }

      if (bonusCapturePointMatrix !== null && bonusCapturePointMatrix !== undefined) {
        var bonusPoints = bonusCapturePointMatrix.raw[nextTile.tile_index];
        if (bonusPoints < 0.0 || usefulMove) negTileCapturePoints -= bonusPoints;
        if (bonusPoints < -10) return null;
      }

      iter[0] += 1;
      var newPathPriority = pathPriority - addedPriority;
      var prioPerTurn = negTileCapturePoints / (distSoFar + wastedMoves);

      var hitIslandNow = false;
      if (negEnemyTiles + negNeutralTiles > 3) {
        var island = tileIslands.tile_island_lookup.raw[nextTile.tile_index];
        if (island && largeIslandSet.has(island) && armyRemaining > 10) hitIslandNow = true;
      }

      return [
        distSoFar,
        prioPerTurn,
        fakeDistSoFar,
        wastedMoves,
        negTileCapturePoints,
        0 - armyRemaining,
        negEnemyTiles,
        negNeutralTiles,
        newPathPriority,
        nextTileSet,
        nextTile,
        hitIslandNow
      ];
    }

    function initial_value_func_default(tile) {
      var startingSet = new Set();
      startingSet.add(tile.tile_index);
      var enemyExpansionValue = 0;
      var negTileCapturePoints = 0;

      var tileArmy = tile.army;

      var cityUsage = cityUsages.get(tile);
      if (cityUsage !== undefined) {
        tileArmy = 5;
      } else if ((tile.isCity || tile.isGeneral) && tile.player() === searchingPlayer) {
        tileArmy += bonusCityAndGenArmy;
      }

      for (var mi = 0; mi < tile.movable.length; mi++) {
        var adj = tile.movable[mi];
        if (!map.is_tile_on_team_with(adj, searchingPlayer) && adj.player() !== -1 && adj.army > 2 && adj.army < 10 && !negativeTiles.has(adj)) {
          enemyExpansionValue += floorDiv(adj.army - 1, 2);
          negTileCapturePoints += ENEMY_EXPANSION_TILE_PENALTY;
        }
      }

      return [0, -10000, 0, 0, negTileCapturePoints, 0 - tileArmy, 0, 0, 0, startingSet, tile, false];
    }

    var tileMinValueCutoff = 2;
    var sortedByArmyTiles = sortedByTupleKey(
      where(generalPlayer.tiles, function (tile) { return tile.army > tileMinValueCutoff && !negativeTiles.has(tile); }),
      function (tile) { return [0 - tile.army, distanceToLargeIslandsMap.raw[tile.tile_index]]; });

    if (sortedByArmyTiles.length <= 4) {
      tileMinValueCutoff = 1;
      sortedByArmyTiles = sortedByTupleKey(
        where(generalPlayer.tiles, function (tile) { return tile.army > tileMinValueCutoff && !negativeTiles.has(tile); }),
        function (tile) { return [0 - tile.army, distanceToLargeIslandsMap.raw[tile.tile_index]]; });
    }

    if (sortedByArmyTiles.length === 0) return [null, []];

    var largeToBeConcernedWith = Math.min(10, 1 + floorDiv(map.players[searchingPlayer].tileCount, 10));
    var zoneTiles = [];
    for (var zi = 0; zi < Math.min(sortedByArmyTiles.length, largeToBeConcernedWith); zi++) {
      var zt = sortedByArmyTiles[zi];
      if (zt.army > 4) zoneTiles.push(zt);
    }

    var sortedByDistToZoneTiles = sortedByKey(zoneTiles,
      function (tile) { return 0 - distanceToLargeIslandsMap.raw[tile.tile_index]; }, false);

    var fullCutoff = 20;
    var cutoffFactor = 5;
    var valPerTurnCutoff = 0.5;
    var valPerTurnCutoffScaledown = 0.6;
    if (!useCutoff) {
      cutoffFactor = 20;
      valPerTurnCutoff = 0.25;
      valPerTurnCutoffScaledown = 0.3;
    }

    var stage2 = time_limit / 2;
    var breakStage = 3 * time_limit / 4;

    var overrideGlobalVisitedOneCycle = false;
    var standingArmyGlobalVisitedOverrideThresh = map.players[searchingPlayer].standingArmy;
    var linearOffset = 15;
    if (standingArmyGlobalVisitedOverrideThresh > linearOffset) {
      standingArmyGlobalVisitedOverrideThresh = linearOffset +
        Math.pow(standingArmyGlobalVisitedOverrideThresh - linearOffset, 0.75);
    }
    if (sortedByArmyTiles.length > 0 && sortedByArmyTiles[0].army >= standingArmyGlobalVisitedOverrideThresh) {
      overrideGlobalVisitedOneCycle = true;
    }

    var inStage2 = false;
    var firstIteration = true;
    var iteration = 0;
    var delayedAdds = [];
    var breakNextFullCutoff = false;

    for (;;) {
      iteration += 1;
      if (remainingTurns <= 0) break;

      if (cutoffFactor > fullCutoff) {
        if (breakNextFullCutoff || !overrideGlobalVisitedOneCycle) break;
        breakNextFullCutoff = true;
      }

      if (sortedByArmyTiles.length === 0) break;

      var timeUsed = (Date.now() - startTime) / 1000;
      if (timeUsed > breakStage && inStage2) break;
      if (timeUsed > stage2) {
        inStage2 = true;
        cutoffFactor = fullCutoff;
      }

      var endIdx = Math.min(sortedByArmyTiles.length,
        floorDiv(cutoffFactor * sortedByArmyTiles.length, fullCutoff) + 1);
      if (endIdx < 3) endIdx = Math.min(sortedByArmyTiles.length, 3);

      var tilePercentile = where(sortedByArmyTiles, function (t) { return !negativeTiles.has(t); }).slice(0, endIdx);
      if (tilePercentile.length === 0) {
        cutoffFactor += 3;
        continue;
      }

      var smallTiles = where(tilePercentile, function (tile) { return tile.army < 15; });
      if (smallTiles.length > tilePercentile.length - 2) {
        if (firstIteration) {
          var firstArmy = tilePercentile[0].army;
          tilePercentile = where(tilePercentile, function (t) { return t.army > floorDiv(firstArmy, 2); });
        } else {
          overrideGlobalVisitedOneCycle = true;
        }
      }

      var tilesLargerThanAverage = tilePercentile;

      if (alwaysIncludeNonTerminatingLeavesInIteration && !firstIteration) {
        for (var aii = 0; aii < alwaysIncludes.length; aii++) {
          var at = alwaysIncludes[aii];
          if (!negativeTiles.has(at) && !tryAvoidSet.has(at)) tilesLargerThanAverage.push(at);
        }
      }

      var searchTime = Math.min(time_limit - timeUsed, singleIterationPathTimeCap);

      var startDict = new Map();
      for (var si = 0; si < tilesLargerThanAverage.length; si++) {
        var st = tilesLargerThanAverage[si];
        if (negativeTiles.has(st)) continue;
        startDict.set(st, [initial_value_func_default(st), 0]);
      }

      var useGlobalVisited = !forceNoGlobalVisited;
      if (forceGlobalVisitedStage1 && !inStage2) useGlobalVisited = true;
      if (overrideGlobalVisitedOneCycle) {
        useGlobalVisited = false;
        overrideGlobalVisitedOneCycle = false;
      }

      var startCopy = new Map(startDict);
      negativeTiles.forEach(function (t) { startCopy.delete(t); });

      var maxDepth = 25;

      var newPathDict = S().breadth_first_dynamic_max_per_tile_per_distance(map, startCopy,
        value_priority_army_dist_basic, {
          maxTurns: remainingTurns,
          maxDepth: Math.min(remainingTurns, maxDepth),
          noNeutralCities: true,
          negativeTiles: negativeTiles,
          searchingPlayer: searchingPlayer,
          priorityFunc: default_priority_func_basic,
          useGlobalVisitedSet: useGlobalVisited,
          skipFunc: skip_after_out_of_army,
          logResultValues: logStuff,
          fullOnly: false,
          noLog: true
        });

      var newPaths = processNewExpansionPaths(cityUsages, defaultNoPathValue, enemyDistMap, friendlyPlayers,
        largeIslandSet, multiPathDict, negativeTiles, newPathDict, postPathEvalFunction, searchingPlayer,
        tileIslands, turns, valPerTurnCutoff, map);

      cutoffFactor += 3;
      valPerTurnCutoff = valPerTurnCutoff * valPerTurnCutoffScaledown;

      if (newPaths.length === 0) {
        overrideGlobalVisitedOneCycle = true;
      } else {
        for (var npi = 0; npi < newPaths.length; npi++) {
          var np = newPaths[npi][1];
          var shouldDelay = checkShouldDelay(map, np, distanceToLargeIslandsMap, sortedByDistToZoneTiles);
          if (shouldDelay) {
            delayedAdds.push(np);
          } else {
            addPathToTryAvoidPathsCrossingTiles(np, negativeTiles, tryAvoidSet, pathsCrossingTiles, useIterativeNegTiles);
          }
        }
      }

      firstIteration = false;
    }

    for (var di = 0; di < delayedAdds.length; di++) {
      addPathToTryAvoidPathsCrossingTiles(delayedAdds[di], negativeTiles, tryAvoidSet, pathsCrossingTiles, useIterativeNegTiles);
    }
  }

  // ---------------------------------------------------------------------
  // _process_new_expansion_paths
  // ---------------------------------------------------------------------
  function processNewExpansionPaths(cityUsages, defaultNoPathValue, enemyDistMap, friendlyPlayers,
    largeIslandSet, multiPathDict, negativeTiles, newPathDict, postPathEvalFunction, searchingPlayer,
    tileIslands, turns, valPerTurnCutoff, map) {

    var newPaths = [];
    newPathDict.forEach(function (tilePaths, tile) {
      var curTileDict = multiPathDict.get(tile);
      if (curTileDict === undefined) {
        curTileDict = new Map();
        multiPathDict.set(tile, curTileDict);
      }

      var anyPathInc = false;
      var values = new Map();
      for (var i = 0; i < tilePaths.length; i++) {
        var p = tilePaths[i];
        var v = postPathEvalFunction(p, negativeTiles);
        values.set(p, v);
        var vpt = v / p.length;
        if (v >= 0.2 && vpt >= valPerTurnCutoff) anyPathInc = true;
      }

      if (!anyPathInc) {
        multiPathDict.set(tile, curTileDict);
        return;
      }

      for (var ti = 0; ti < tilePaths.length; ti++) {
        var path = tilePaths[ti];
        var visited = new Set();
        var value = values.get(path);
        var friendlyCityCount = 0;
        var node = path.start;
        var reachedIsland = tileIslands.tile_island_lookup.raw[path.tail.tile.tile_index];
        if (!reachedIsland || !largeIslandSet.has(reachedIsland)) reachedIsland = null;

        while (node !== null && node !== undefined) {
          var islandInSet = false;
          if (!negativeTiles.has(node.tile) && (islandInSet || !visited.has(node.tile))) {
            visited.add(node.tile);
            if (friendlyPlayers.indexOf(node.tile.player()) !== -1 && (node.tile.isCity || node.tile.isGeneral)) {
              friendlyCityCount += 1;
            }
          }
          node = node.next;
        }

        var remainingArmy = path.value;
        var curDist = path.length;
        var fullIsland = null;
        var tilesInIsland = [];
        if (reachedIsland) {
          tilesInIsland = reachedIsland.tiles_by_army;
          fullIsland = reachedIsland;
          var seenIslandIds = new Set();
          while (fullIsland.full_island) {
            if (seenIslandIds.has(fullIsland.unique_id) || fullIsland.full_island === fullIsland) break;
            seenIslandIds.add(fullIsland.unique_id);
            fullIsland = fullIsland.full_island;
          }
        }

        var tilesInIslandIdx = 2;
        var curValue = value;
        var islandCapValue = ENEMY_TILE_CAP_VALUE;
        if (reachedIsland && reachedIsland.team === -1) islandCapValue = 1.0;

        for (;;) {
          var existing = curTileDict.get(curDist);
          var existingMax = existing === undefined ? defaultNoPathValue[0] : existing[0];
          if (curValue > existingMax) {
            path.econValue = curValue;
            var n2 = path.start;
            while (n2 !== null && n2 !== undefined) {
              if ((n2.tile.isGeneral && n2.tile.player() === searchingPlayer) ||
                (n2.tile.isCity && map.is_tile_on_team_with(n2.tile, searchingPlayer))) {
                cityUsages.set(n2.tile, (cityUsages.get(n2.tile) || 0) + 1);
              }
              n2 = n2.next;
            }
            curTileDict.set(curDist, [curValue, path]);
            newPaths.push([curValue, path]);
          }

          if (tilesInIslandIdx >= tilesInIsland.length) {
            tilesInIslandIdx = 0;
            if (reachedIsland && reachedIsland.full_island) {
              if (reachedIsland.full_island === reachedIsland) {
                reachedIsland = null;
              } else {
                reachedIsland = reachedIsland.full_island;
              }
              if (reachedIsland !== null) {
                tilesInIsland = reachedIsland.tiles_by_army.slice(4);
                if (tilesInIsland.length === 0) break;
              } else {
                break;
              }
            } else {
              break;
            }
          }

          var nextTile = tilesInIsland[tilesInIslandIdx];
          curValue = curValue + islandCapValue;
          remainingArmy -= nextTile.army + 1;
          if (remainingArmy < 1) break;
          if (curDist > turns) break;

          if (reachedIsland) {
            path = path.clone();
            var closest = null;
            for (var mvi = 0; mvi < path.tail.tile.movable.length; mvi++) {
              var t = path.tail.tile.movable[mvi];
              if (!path.tileSet.has(t) && fullIsland.tile_set.has(t) &&
                (closest === null || enemyDistMap.raw[closest.tile_index] > enemyDistMap.raw[t.tile_index])) {
                closest = t;
              }
            }
            if (!closest) closest = path.tail.prev.tile;
            path.add_next(closest);
            path.value = remainingArmy;
          }

          tilesInIslandIdx += 1;
          curDist += 1;
        }
      }

      multiPathDict.set(tile, curTileDict);
    });

    return newPaths;
  }

  // ---------------------------------------------------------------------
  // _check_should_delay
  // ---------------------------------------------------------------------
  function checkShouldDelay(map, path, distanceToLargeIslandsMap, sortedByDistToZoneTiles) {
    var tile = path.start.tile;
    var tileDist = distanceToLargeIslandsMap.raw[tile.tile_index];
    for (var i = 0; i < sortedByDistToZoneTiles.length; i++) {
      var otherTile = sortedByDistToZoneTiles[i];
      if (tile === otherTile) continue;
      var otherDist = distanceToLargeIslandsMap.raw[otherTile.tile_index];
      var manhatDist = map.manhattan_dist(tile, otherTile);
      if (tileDist > otherDist) break;
      if (manhatDist < 3) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // _include_leaf_moves_in_exp_plan
  // ---------------------------------------------------------------------
  function includeLeafMovesInExpPlan(allowGatherPlanExtension, alwaysIncludes, defaultNoPathValue, includeForGath,
    leafMoves, map, multiPathDict, negativeTiles, paths, pathsCrossingTiles, postPathEvalFunction,
    searchingPlayer, targetPlayers, tryAvoidSet, useIterativeNegTiles, skipNeutrals, bypassLeafValueSkip) {

    for (var i = 0; i < leafMoves.length; i++) {
      var leafMove = leafMoves[i];
      if (!negativeTiles.has(leafMove.source) && !negativeTiles.has(leafMove.dest) &&
        (leafMove.dest.player() === -1 || targetPlayers.indexOf(leafMove.dest.player()) !== -1)) {

        if (leafMove.dest.isCity && leafMove.dest.isNeutral) continue;

        if (leafMove.source.army - 1 <= leafMove.dest.army) {
          if (targetPlayers.indexOf(leafMove.dest.player()) !== -1 && allowGatherPlanExtension &&
            includeForGath !== null && leafMove.source.army > 1) {
            includeForGath.push(leafMove);
          }
          continue;
        }

        if (moveCanCapMore(leafMove)) {
          if (alwaysIncludes !== null) alwaysIncludes.push(leafMove.source);
          continue;
        }

        if (!bypassLeafValueSkip && leafMove.source.army - leafMove.dest.army >= 3) continue;
        if (skipNeutrals && leafMove.dest.isNeutral) continue;

        var path = new EK.Path(leafMove.source.army - leafMove.dest.army - 1);
        path.add_next(leafMove.source);
        path.add_next(leafMove.dest);
        tryIncludeAltSourcedPath(map, searchingPlayer, defaultNoPathValue, multiPathDict, negativeTiles,
          path, paths, pathsCrossingTiles, postPathEvalFunction, tryAvoidSet, useIterativeNegTiles, null, -1);
      }
    }
  }

  // ---------------------------------------------------------------------
  // _execute_expansion_gather_to_borders
  // ---------------------------------------------------------------------
  function executeExpansionGatherToBorders(map, startTiles, depth, valueFunc, baseCaseFunc, negativeTiles,
    skipTiles, searchingPlayer, priorityFunc, skipFunc, priorityTiles, ignoreStartTile, incrementBackward,
    preferNeutral, distPriorityMap, shouldLog, priorityMatrix) {

    var useTrueValueGathered = true;
    var includeGatherTreeNodesThatGatherNegative = false;

    if (searchingPlayer === undefined) searchingPlayer = -2;
    negativeTiles = new Set(negativeTiles || []);

    var teams = getTeamsArray(map);

    if (searchingPlayer === -2) {
      if (startTiles instanceof Map) {
        var firstKey = startTiles.keys().next();
        searchingPlayer = firstKey.done ? -1 : firstKey.value.player();
      } else {
        searchingPlayer = startTiles[0].player();
      }
    }

    if (valueFunc === null || valueFunc === undefined) {
      valueFunc = function default_value_func_max_gathered_per_turn(currentTile, priorityObject) {
        var threatDist = priorityObject[0];
        var depthDist = priorityObject[1];
        var realDist = priorityObject[2];
        var negGatheredSum = priorityObject[4];
        var negArmySum = priorityObject[5];

        if (negArmySum >= 0 && !includeGatherTreeNodesThatGatherNegative) return null;
        if (currentTile.army < 2 || currentTile.player() !== searchingPlayer) return null;

        var value = 0 - negGatheredSum;
        var vt = 0;
        if (realDist > 0) vt = value / realDist;

        return [vt, 0 - threatDist, 0 - negGatheredSum, 0 - depthDist, realDist];
      };
    }

    if (priorityFunc === null || priorityFunc === undefined) {
      priorityFunc = function default_priority_func(nextTile, currentPriorityObject) {
        var threatDist = currentPriorityObject[0];
        var depthDist = currentPriorityObject[1];
        var realDist = currentPriorityObject[2];
        var negGatheredSum = currentPriorityObject[4];
        var negArmySum = currentPriorityObject[5];
        var numPrioTiles = currentPriorityObject[6];

        negArmySum += 1;
        negGatheredSum += 1;
        if (!negativeTiles.has(nextTile)) {
          if (teamOf(teams, searchingPlayer) === teamOf(teams, nextTile.player())) {
            negArmySum -= nextTile.army;
            negGatheredSum -= nextTile.army;
          } else {
            negArmySum += nextTile.army;
            if (useTrueValueGathered) negGatheredSum += nextTile.army;
          }
        }

        if (priorityMatrix) negGatheredSum += priorityMatrix.raw[nextTile.tile_index];
        if (nextTile.isSwamp) {
          negGatheredSum += 1;
          negArmySum += 1;
        }

        if (priorityTiles !== null && priorityTiles !== undefined && hasTile(priorityTiles, nextTile)) numPrioTiles += 1;
        realDist += 1;
        depthDist += 1;
        return [threatDist + 1, depthDist, realDist, numPrioTiles / Math.max(1, depthDist), negGatheredSum, negArmySum, numPrioTiles];
      };
    }

    if (baseCaseFunc === null || baseCaseFunc === undefined) {
      baseCaseFunc = function default_base_case_func(tile, startingDist) {
        var startArmy = tile.army;
        var initialDistance = 0;
        if (distPriorityMap) initialDistance = distPriorityMap.raw[tile.tile_index];
        return [0 - initialDistance, startingDist, 0, 0, 0, startArmy, 0];
      };
    }

    var startTilesDict = new Map();
    if (startTiles instanceof Map) {
      var isIntMap = true;
      startTiles.forEach(function (v) { if (typeof v !== 'number') isIntMap = false; });
      if (isIntMap) {
        startTiles.forEach(function (distance, tile) {
          startTilesDict.set(tile, [baseCaseFunc(tile, distance), distance]);
          negativeTiles.add(tile);
        });
      } else {
        startTilesDict = startTiles;
        startTiles.forEach(function (v, tile) { negativeTiles.add(tile); });
      }
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        startTilesDict.set(tile, [baseCaseFunc(tile, 0), 0]);
        negativeTiles.add(tile);
      }
    }

    var valuePerTurnPathPerTilePerDistance = S().breadth_first_dynamic_max_per_tile_per_distance(map,
      startTilesDict, valueFunc, {
        maxTime: 0.003,
        maxTurns: startTilesDict.size * 2,
        maxDepth: depth,
        noNeutralCities: true,
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: skipFunc,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        logResultValues: shouldLog,
        ignoreNonPlayerArmy: !useTrueValueGathered,
        ignoreIncrement: true,
        useGlobalVisitedSet: false
      });

    var paths = [];
    valuePerTurnPathPerTilePerDistance.forEach(function (pathList) {
      for (var pi = 0; pi < pathList.length; pi++) {
        var path = pathList[pi].get_reversed();
        if (path.value > 3) continue;
        paths.push(path);
      }
    });

    return paths;
  }

  // ---------------------------------------------------------------------
  // path_has_cities_and_should_wait
  // ---------------------------------------------------------------------
  function pathHasCitiesAndShouldWait(path, friendlyPlayers, negativeTiles, territoryMap, remainingTurns) {
    var cityCount = 0;
    for (var i = 0; i < path.tileList.length; i++) {
      var t = path.tileList[i];
      if ((t.isCity || t.isGeneral) && friendlyPlayers.indexOf(t.player()) !== -1) cityCount += 1;
    }
    if (cityCount === 0) return false;

    var assumeTerritoryTileValue = 1;
    if (remainingTurns > 20) assumeTerritoryTileValue = 2;

    var pathWorstCaseTurns = 0;
    var curArmy = 0;
    var turn = 0;
    var worstCaseArmy = 0;
    for (var ti = 0; ti < path.tileList.length; ti++) {
      var tile = path.tileList[ti];
      var tileRealArmyCost = tile.army;
      var tileArmyCost = tileRealArmyCost;
      if (friendlyPlayers.indexOf(tile.player()) !== -1) {
        tileRealArmyCost = 0 - tile.army;
      } else if (tile.isNeutral) {
        tileArmyCost = tileRealArmyCost;
        var tileProbPlayer = territoryMap.raw[tile.tile_index];
        if (tileProbPlayer === -1) {
          for (var mi = 0; mi < tile.adjacents.length; mi++) {
            var m = tile.adjacents[mi];
            if (!m.isNeutral) tileProbPlayer = m.player();
          }
        }
        if (!tile.discovered && tileProbPlayer !== -1) tileArmyCost += assumeTerritoryTileValue;
      }

      var nextWorstCaseArmy = worstCaseArmy - tileRealArmyCost + 1;
      var nextArmy = curArmy - tileArmyCost + 1;

      if (curArmy > 0 && nextArmy <= 0 && pathWorstCaseTurns === 0) pathWorstCaseTurns = turn;

      curArmy = nextArmy;
      worstCaseArmy = nextWorstCaseArmy;
      turn += 1;
    }

    return true;
  }

  // ---------------------------------------------------------------------
  // _group_expand_paths_by_crossovers / _merge_path_groups_recurse
  // ---------------------------------------------------------------------
  function groupExpandPathsByCrossovers(pathsCrossingTiles, multiTilePlanInterfaceDict, groupPruneThreshold) {
    var pathGroupLookup = new Map();
    var allPaths = [];
    var i = 0;
    multiTilePlanInterfaceDict.forEach(function (distDict) {
      distDict.forEach(function (valTuple) {
        var path = valTuple[1];
        allPaths.push(path);
        pathGroupLookup.set(path, i);
        i += 1;
      });
    });

    for (var pi = 0; pi < allPaths.length; pi++) {
      var path = allPaths[pi];
      var groupNumber = pathGroupLookup.get(path);
      mergePathGroupsRecurse(groupNumber, path, pathGroupLookup, pathsCrossingTiles);
    }

    var pathsGrouped = new Map();
    for (var pj = 0; pj < allPaths.length; pj++) {
      var p = allPaths[pj];
      var g = pathGroupLookup.get(p);
      var groupList = pathsGrouped.get(g);
      if (groupList === undefined) {
        groupList = new Set();
        pathsGrouped.set(g, groupList);
      }
      groupList.add(p);
    }

    var final = new Map();
    pathsGrouped.forEach(function (pathSet, g) {
      if (pathSet.size > groupPruneThreshold) {
        var lookupByDist = new Map();
        pathSet.forEach(function (path) {
          var existing = lookupByDist.get(path.length);
          if (existing === undefined || existing.econValue < path.econValue) {
            lookupByDist.set(path.length, path);
          }
        });
        final.set(g, Array.from(lookupByDist.values()));
      } else {
        final.set(g, Array.from(pathSet));
      }
    });

    return final;
  }

  function mergePathGroupsRecurse(groupNumber, path, pathGroupLookup, pathsCrossingTiles) {
    var crossedGroups = new Set();
    var limit = Math.min(10, path.tileList.length);
    for (var i = 0; i < limit; i++) {
      var tile = path.tileList[i];
      var crossing = pathsCrossingTiles.get(tile);
      if (!crossing) continue;
      var snapshot = crossing.slice();
      for (var j = 0; j < snapshot.length; j++) {
        var crossedPath = snapshot[j];
        if (crossedPath === path) continue;
        var crossedPathGroup = pathGroupLookup.get(crossedPath);
        if (crossedPathGroup === undefined) continue;
        if (groupNumber === crossedPathGroup) continue;
        if (crossedGroups.has(crossedPathGroup)) continue;
        pathGroupLookup.set(crossedPath, groupNumber);
        crossedGroups.add(crossedPathGroup);
        mergePathGroupsRecurse(groupNumber, crossedPath, pathGroupLookup, pathsCrossingTiles);
      }
    }
  }

  // ---------------------------------------------------------------------
  // _get_tile_path_value
  // ---------------------------------------------------------------------
  function getTilePathValue(map, tile, lastTile, negativeTiles, targetPlayers, searchingPlayer, enemyDistMap,
    generalDistMap, territoryMap, enemyDistPenaltyPoint, bonusCapturePointMatrix) {

    var value = 0.0;
    if (negativeTiles.has(tile)) {
      value -= 0.1;
    } else {
      if (targetPlayers.indexOf(tile.player()) !== -1) {
        value += ENEMY_TILE_CAP_VALUE;
        if (tile.isCity && tile.army < 10) value += 15 - tile.army;
      } else if (!tile.discovered && targetPlayers.indexOf(territoryMap.raw[tile.tile_index]) !== -1) {
        value += 0.025;
      } else if (!tile.visible && targetPlayers.indexOf(territoryMap.raw[tile.tile_index]) !== -1) {
        value += 0.01;
      }

      if (tile.player() === -1) {
        value += 1.0 - tile.army;
        if (tile.isCity && tile.army < 10) value += 25 - tile.army;
      }

      if (tile.isSwamp) value -= 2.0;
      if (!tile.discovered) value += 0.01;
      if (bonusCapturePointMatrix) value += bonusCapturePointMatrix.raw[tile.tile_index];

      var sourceEnDist = enemyDistMap.raw[lastTile.tile_index];
      var destEnDist = enemyDistMap.raw[tile.tile_index];
      var sourceGenDist = generalDistMap.raw[lastTile.tile_index];
      var destGenDist = generalDistMap.raw[tile.tile_index];

      var sourceDistSum = sourceEnDist + sourceGenDist;
      var destDistSum = destEnDist + destGenDist;

      if (destDistSum >= enemyDistPenaltyPoint) {
        if (destDistSum < sourceDistSum) value += 0.005;
      }
      if (destDistSum === sourceDistSum) value += 0.01;
      if (Math.abs(destEnDist - destGenDist) <= Math.abs(sourceEnDist - sourceGenDist)) {
        value += Math.abs(destEnDist - destGenDist) / 400;
      }
    }
    return value;
  }

  // ---------------------------------------------------------------------
  // add_path_to_try_avoid_paths_crossing_tiles / move_can_cap_more
  // ---------------------------------------------------------------------
  function addPathToTryAvoidPathsCrossingTiles(path, negativeTiles, tryAvoidSet, pathsCrossingTiles, addToNegativeTiles) {
    var it = path.tileSet instanceof Set ? path.tileSet.values() : path.tileSet;
    for (var r = it.next(); !r.done; r = it.next()) {
      var t = r.value;
      tryAvoidSet.add(t);
      if (addToNegativeTiles) negativeTiles.add(t);
      var tileCrossList = pathsCrossingTiles.get(t);
      if (!tileCrossList) {
        tileCrossList = [];
        pathsCrossingTiles.set(t, tileCrossList);
      }
      tileCrossList.push(path);
    }
  }

  function moveCanCapMore(leafMove) {
    var capAmt = leafMove.source.army - leafMove.dest.army - 1;
    for (var i = 0; i < leafMove.dest.movable.length; i++) {
      var nextCap = leafMove.dest.movable[i];
      if (nextCap === leafMove.source) continue;
      if (nextCap.player() !== leafMove.source.player() && capAmt - 1 > nextCap.army) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // knapsack_multi_paths / knapsack_multi_paths_no_crossover
  // ---------------------------------------------------------------------
  function knapsackMultiPaths(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
    pathsCrossingTiles, multiPathDict, territoryMap, postPathEvalFunction, negativeTiles, tryAvoidSet,
    perfTimer, valueOverrides, leafMoves) {

    var rebuilt = groupExpandPathsByCrossovers(pathsCrossingTiles, multiPathDict, Math.min(remainingTurns, 20));
    return extractPathsFromKnapsackGroups(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
      rebuilt, negativeTiles, postPathEvalFunction, territoryMap, tryAvoidSet, valueOverrides, perfTimer, leafMoves);
  }

  function knapsackMultiPathsNoCrossover(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
    pathsCrossingTiles, multiPathDict, territoryMap, postPathEvalFunction, negativeTiles, tryAvoidSet,
    perfTimer, valueOverrides, leafMoves) {

    var groups = new Map();
    multiPathDict.forEach(function (pathsByDist, tile) {
      if (pathsByDist.size === 0) return;
      var groupPaths = [];
      pathsByDist.forEach(function (pathTuple, dist) {
        var p = pathTuple[1];
        if ((tile.isCity || tile.isGeneral) && dist < floorDiv(remainingTurns, 2)) {
          var groupTile = tile;
          var it = p.tileSet instanceof Set ? p.tileSet.values() : p.tileSet;
          for (var r = it.next(); !r.done; r = it.next()) {
            var t = r.value;
            if (!isPlayerOnTeamWith(map, tile.player(), t.player())) {
              groupTile = t;
              break;
            }
          }
          var existingGroup = groups.get(groupTile);
          if (!existingGroup) {
            existingGroup = [];
            groups.set(groupTile, existingGroup);
          }
          existingGroup.push(p);
          return;
        }
        groupPaths.push(p);
      });
      groups.set(tile, groupPaths);
    });

    return extractPathsFromKnapsackGroups(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
      groups, negativeTiles, postPathEvalFunction, territoryMap, tryAvoidSet, valueOverrides, perfTimer, leafMoves);
  }

  function getMultipleChoiceExpansionKnapsackValConverter(valueOverrides, postPathEvalFunction, negativeTiles) {
    return function multiple_choice_knapsack_expansion_path_value_converter(p) {
      var floatVal = -10000;
      var dist = p.length;
      if (valueOverrides) {
        var tpl = valueOverrides.get(p);
        if (tpl !== undefined) {
          floatVal = tpl[0];
          dist = tpl[1];
        }
      }
      if (floatVal === -10000) floatVal = postPathEvalFunction(p, negativeTiles);
      var intVal = Math.trunc(floatVal * 10000.0);
      return [intVal, dist];
    };
  }

  function extractPathsFromKnapsackGroups(map, searchingPlayer, friendlyPlayers, targetPlayers, remainingTurns,
    groups, negativeTiles, postPathEvalFunction, territoryMap, tryAvoidSet, valueOverrides, perfTimer, leafMoves) {

    var valFunc = getMultipleChoiceExpansionKnapsackValConverter(valueOverrides, postPathEvalFunction, negativeTiles);
    var knapResult = expansionKnapsackGatherIteration(remainingTurns, groups, perfTimer, false, valFunc);
    var totalValue = knapResult[0];
    var maxPaths = knapResult[1];

    var effectiveTotalValue = 0;
    var effectiveNegativeTiles = new Set(negativeTiles);

    for (var i = 0; i < maxPaths.length; i++) {
      var selectedPath = maxPaths[i];
      if (selectedPath instanceof EK.Path) selectedPath.econValue = 0.0;

      var pathValue = null;
      if (valueOverrides) {
        var overrides = valueOverrides.get(selectedPath);
        if (overrides !== undefined) pathValue = overrides[0];
      }

      if (pathValue === null) {
        pathValue = postPathEvalFunction(selectedPath, effectiveNegativeTiles);
        var its = selectedPath.tileSet instanceof Set ? selectedPath.tileSet.values() : selectedPath.tileSet;
        for (var r = its.next(); !r.done; r = its.next()) effectiveNegativeTiles.add(r.value);
      } else {
        for (var ti = 0; ti < selectedPath.tileList.length; ti++) {
          var t = selectedPath.tileList[ti];
          if (!effectiveNegativeTiles.has(t)) {
            effectiveNegativeTiles.add(t);
          } else {
            if (targetPlayers.indexOf(t.player()) !== -1) {
              pathValue -= TARGET_CAP_VALUE;
            } else if (t.player() === -1) {
              pathValue -= NEUTRAL_CAP_VALUE;
            }
          }
        }
      }

      effectiveTotalValue += Math.trunc(pathValue * 10000.0);
    }

    return [maxPaths, effectiveTotalValue];
  }

  // ---------------------------------------------------------------------
  // _try_include_alt_sourced_path
  // ---------------------------------------------------------------------
  function tryIncludeAltSourcedPath(map, searchingPlayer, defaultNoPathValue, multiPathDict, negativeTiles,
    planOption, planOptions, pathsCrossingTiles, postPathEvalFunction, tryAvoidSet, useIterativeNegTiles,
    baseValueOverride, turnOverride) {

    if (turnOverride === undefined) turnOverride = -1;
    var value = baseValueOverride;
    if (value === null || value === undefined) value = postPathEvalFunction(planOption, negativeTiles);

    if (value <= 0) return;

    var cityCount = 0;
    var it = planOption.tileSet instanceof Set ? planOption.tileSet.values() : planOption.tileSet;
    for (var r = it.next(); !r.done; r = it.next()) {
      var tile = r.value;
      if ((tile.isGeneral || tile.isCity) && isPlayerOnTeamWith(map, tile.player(), searchingPlayer)) cityCount += 1;
    }

    planOptions.push([cityCount, value, planOption]);
    addPathToTryAvoidPathsCrossingTiles(planOption, negativeTiles, tryAvoidSet, pathsCrossingTiles, useIterativeNegTiles);

    var firstMove = planOption.get_first_move();
    if (firstMove === null || firstMove === undefined) return;

    var startTile = firstMove.source;
    var curTileDict = multiPathDict.get(startTile);
    if (!curTileDict) {
      curTileDict = new Map();
      multiPathDict.set(startTile, curTileDict);
    }
    if (turnOverride === -1) turnOverride = planOption.length;

    var existing = curTileDict.get(turnOverride);
    var existingMax = existing === undefined ? defaultNoPathValue[0] : existing[0];
    if (value > existingMax) {
      curTileDict.set(planOption.length, [value, planOption]);
    }
  }

  // ---------------------------------------------------------------------
  // _get_capture_counts
  // ---------------------------------------------------------------------
  function getCaptureCounts(searchingPlayer, friendlyPlayers, targetPlayers, mainPath, otherPaths,
    negativeTiles, valueOverrides, leafMoves) {

    var allPaths = [];
    if (mainPath !== null) allPaths.push(mainPath);
    for (var i = 0; i < otherPaths.length; i++) allPaths.push(otherPaths[i]);
    allPaths = sortedByKey(allPaths, function (p) { return p.length; }, true);

    var visitedByPaths = new Set();
    var visited = new Set(negativeTiles);
    var enemyCapped = 0;
    var neutralCapped = 0;
    var turnsUsed = 0;
    var removedTurns = 0;
    var candidateRemoves = [];

    for (var pi = 0; pi < allPaths.length; pi++) {
      var path = allPaths[pi];
      var pTurnsUsed = -1;
      var pNeutCap = 0;
      var pEnCap = 0;
      var validTiles = 0;

      for (var ti = 0; ti < path.tileList.length; ti++) {
        var tile = path.tileList[ti];
        pTurnsUsed += 1;
        if (visitedByPaths.has(tile)) continue;
        validTiles += 1;
        visitedByPaths.add(tile);
        if (visited.has(tile)) continue;
        visited.add(tile);

        if (friendlyPlayers.indexOf(tile.player()) === -1) {
          if (targetPlayers.indexOf(tile.player()) === -1) {
            pNeutCap += 1;
          } else {
            pEnCap += 1;
          }
        }
      }

      if (validTiles === 0) {
        removedTurns += path.length;
        var rmIdx = otherPaths.indexOf(path);
        if (rmIdx !== -1) {
          otherPaths.splice(rmIdx, 1);
          continue;
        }
      }

      if (validTiles < floorDiv(2 * path.length, 3) && (pNeutCap + 2 * pEnCap) / pTurnsUsed < 1.0) {
        candidateRemoves.push([pTurnsUsed, pNeutCap, pEnCap, validTiles, path]);
        continue;
      } else if (validTiles > 0 && valueOverrides) {
        var overrides = valueOverrides.get(path);
        if (overrides !== undefined) {
          var overVal = overrides[0];
          var overTurns = overrides[1];
          var totalCapSoFar = pEnCap * 2 + pNeutCap;
          var missing = Math.trunc(overVal - totalCapSoFar);
          if (missing > 0) pEnCap += floorDiv(missing, 2);
          pTurnsUsed = overTurns;
        }
      }

      turnsUsed += pTurnsUsed;
      neutralCapped += pNeutCap;
      enemyCapped += pEnCap;
    }

    if (leafMoves && leafMoves.length > 0) {
      var leafIdx = 0;
      while (removedTurns > 0 && leafIdx < leafMoves.length) {
        var move = leafMoves[leafIdx];
        if (!visited.has(move.source) && !visited.has(move.dest)) {
          var newPath = new EK.Path();
          newPath.add_next(move.source);
          newPath.add_next(move.dest);
          if (move.dest.player() === -1) {
            newPath.econValue = 1.0;
            neutralCapped += 1;
          } else {
            newPath.econValue = 2.0;
            enemyCapped += 1;
          }
          turnsUsed += 1;
          visited.add(move.source);
          visited.add(move.dest);
          otherPaths.push(newPath);
          removedTurns -= 1;
        }
        leafIdx += 1;
      }

      var sortedRemoves = sortedByTupleKey(candidateRemoves, function (cr) {
        return [cr[0], cr[1], cr[2], cr[3], cr[4].length];
      });

      for (var ci = 0; ci < sortedRemoves.length; ci++) {
        var cand = sortedRemoves[ci];
        var candTurns = cand[0];
        var candNeut = cand[1];
        var candEn = cand[2];
        var candValid = cand[3];
        var candPath = cand[4];

        var leavesToAdd = [];
        while (leavesToAdd.length < candTurns && leafIdx < leafMoves.length) {
          var mv = leafMoves[leafIdx];
          if (!visited.has(mv.source) && !visited.has(mv.dest)) {
            leavesToAdd.push(mv);
            visited.add(mv.source);
            visited.add(mv.dest);
          }
          leafIdx += 1;
        }

        if (leavesToAdd.length === candPath.length) {
          var rmIdx2 = otherPaths.indexOf(candPath);
          if (rmIdx2 !== -1) otherPaths.splice(rmIdx2, 1);

          for (var li = 0; li < leavesToAdd.length; li++) {
            var lm = leavesToAdd[li];
            var np = new EK.Path();
            np.add_next(lm.source);
            np.add_next(lm.dest);
            if (lm.dest.player() === -1) {
              np.econValue = 1.0;
              neutralCapped += 1;
            } else {
              np.econValue = 2.0;
              enemyCapped += 1;
            }
            turnsUsed += 1;
            visited.add(lm.source);
            visited.add(lm.dest);
            otherPaths.push(np);
          }
        }

        if (candValid > 0 && valueOverrides) {
          var overrides2 = valueOverrides.get(candPath);
          if (overrides2 !== undefined) {
            var overVal2 = overrides2[0];
            var overTurns2 = overrides2[1];
            var totalCapSoFar2 = candEn * 2 + candNeut;
            var missing2 = Math.trunc(overVal2 - totalCapSoFar2);
            if (missing2 > 0) candEn += floorDiv(missing2, 2);
            candTurns = overTurns2;
          }
        }

        turnsUsed += candTurns;
        neutralCapped += candNeut;
        enemyCapped += candEn;
      }
    }

    return [turnsUsed, enemyCapped, neutralCapped, visited];
  }

  // ---------------------------------------------------------------------
  // _get_uncertainty_capture_rating
  // ---------------------------------------------------------------------
  function getUncertaintyCaptureRating(friendlyPlayers, path, deferCityGen) {
    if (EK.InterceptionOptionInfo && path instanceof EK.InterceptionOptionInfo) {
      if ((path.requiredDelay || 0) <= 0) return 200 - path.length;
      return -200 + path.length;
    }

    var rating = 0;
    var firstTile = path.tileList[0];
    if (firstTile.isCity || firstTile.isGeneral) {
      rating -= 1.0 / (firstTile.army + 1) + 0.1 * path.length;
      if (deferCityGen) rating -= 30;
    }

    for (var i = 1; i < path.tileList.length; i++) {
      var t = path.tileList[i];
      if (t.visible) {
        if (friendlyPlayers.indexOf(t.player()) !== -1) {
          if (t.isGeneral || t.isCity) {
            rating += 0.1;
            if (deferCityGen) rating -= 2.1;
          }
          if (t.army === 1) rating -= 0.3;
        } else if (friendlyPlayers.indexOf(t.player()) === -1 && t.isCity) {
          rating += 50;
        }
        continue;
      }

      if (t.player() === -1) {
        rating += 0.1;
        if (!t.discovered) rating += 0.1;
      } else if (friendlyPlayers.indexOf(t.player()) === -1) {
        rating += 0.05;
        if (!t.discovered) rating += 0.3;
        if (t.isCity) rating += 50;
      }
    }

    return rating;
  }

  // ---------------------------------------------------------------------
  // find_optimal_expansion_path_to_move_first
  // ---------------------------------------------------------------------
  function findOptimalExpansionPathToMoveFirst(map, maxPaths, negativeTiles, originalNegativeTiles,
    postPathEvalFunction, remainingTurns, searchingPlayer, friendlyPlayers, territoryMap, valueOverrides) {

    var deferringCityGen = true;
    var waitingPaths = new Set();
    var pathVals = new Map();
    var pathTurns = new Map();
    var pathUncertaintyRatings = new Map();
    var cityCapturePaths = new Set();

    for (var i = 0; i < maxPaths.length; i++) {
      var p = maxPaths[i];
      var thisVal = postPathEvalFunction(p, originalNegativeTiles);
      var thisTurns = p.length;
      if (valueOverrides) {
        var overrides = valueOverrides.get(p);
        if (overrides !== undefined) {
          thisVal = overrides[0];
          thisTurns = overrides[1];
        }
      }

      var thisUncertainty = getUncertaintyCaptureRating(friendlyPlayers, p, deferringCityGen);
      thisUncertainty = thisUncertainty / (thisTurns + 1);

      pathVals.set(p, thisVal);
      pathTurns.set(p, thisTurns);
      pathUncertaintyRatings.set(p, thisUncertainty);
      if (planCapturesCity(p, friendlyPlayers)) cityCapturePaths.add(p);

      if (valueOverrides && valueOverrides.has(p)) continue;
      var shouldWait = (p.requiredDelay || 0) > 0 ||
        pathHasCitiesAndShouldWait(p, friendlyPlayers, negativeTiles, territoryMap, remainingTurns);
      if (shouldWait) waitingPaths.add(p);
    }

    var sumWaiting = 0;
    waitingPaths.forEach(function (wp) { sumWaiting += wp.length; });

    if (sumWaiting > remainingTurns - 1) waitingPaths = new Set();
    if (waitingPaths.size === maxPaths.length) waitingPaths = new Set();

    var maxVal = -10000;
    var maxVt = -1000;
    var maxUncertainty = -10000;
    var path = null;

    for (var pi = 0; pi < maxPaths.length; pi++) {
      var pp = maxPaths[pi];
      var v = pathVals.get(pp);
      var turns = pathTurns.get(pp);
      var vt = v / turns;
      var uncert = pathUncertaintyRatings.get(pp);
      var thisCityCapturePriority = cityCapturePaths.has(pp) ? 1 : 0;
      var maxCityCapturePriority = path !== null && cityCapturePaths.has(path) ? 1 : 0;

      if (thisCityCapturePriority > maxCityCapturePriority ||
        (thisCityCapturePriority === maxCityCapturePriority && uncert + vt > maxUncertainty + maxVt)) {
        if (!waitingPaths.has(pp)) {
          path = pp;
          maxVal = v;
          maxVt = vt;
          maxUncertainty = uncert;
        }
      }
    }

    return path;
  }

  // ---------------------------------------------------------------------
  // prune helpers
  // ---------------------------------------------------------------------
  function pruneWorstPathsGreedily(valuePerTurnPathPerTile, valueFunc, attempt, shorterBias) {
    var sum = 0;
    var cnt = 0;
    valuePerTurnPathPerTile.forEach(function (pathList) {
      for (var i = 0; i < pathList.length; i++) {
        var res = valueFunc(pathList[i]);
        sum += res[0] / res[1];
        cnt += 1;
      }
    });
    var avg = sum / cnt;

    var cutoff = avg - (shorterBias ? 0.60 : 0.40) / attempt;

    var newDict = new Map();
    valuePerTurnPathPerTile.forEach(function (pathList, group) {
      var newList = [];
      for (var i = 0; i < pathList.length; i++) {
        var res = valueFunc(pathList[i]);
        var value = res[0];
        var dist = res[1];
        if (shorterBias && dist > 7) dist = 7 + Math.pow(dist - 7, 1.05);
        var valPerTurn = value / dist;
        if (valPerTurn > cutoff) newList.push(pathList[i]);
      }
      if (newList.length > 0) newDict.set(group, newList);
    });

    return newDict;
  }

  function pruneWorstPathsTwoThirdsMedian(valuePerTurnPathPerTile, valueFunc, attempt) {
    var all = [];
    valuePerTurnPathPerTile.forEach(function (pathList) {
      for (var i = 0; i < pathList.length; i++) {
        var res = valueFunc(pathList[i]);
        var value = res[0];
        var dist = res[1];
        var newDist = dist;
        var vt = value / dist;
        var weightVt = vt;
        if (dist > 7) {
          newDist = 7 + Math.pow(dist - 7, 1.05);
          weightVt = value / newDist;
        }
        all.push({ weightVt: weightVt, vt: vt, negDist: 0 - dist, path: pathList[i] });
      }
    });

    var allSorted = sortedByTupleKey(all, function (a) { return [a.weightVt, a.vt, a.negDist]; }).reverse();
    var cutoff = allSorted[floorDiv(2 * allSorted.length, 3)].weightVt;

    var newDict = new Map();
    valuePerTurnPathPerTile.forEach(function (pathList, group) {
      var newList = [];
      for (var i = 0; i < pathList.length; i++) {
        var res = valueFunc(pathList[i]);
        var value = res[0];
        var dist = res[1];
        if (dist > 7) dist = 7 + Math.pow(dist - 7, 1.05);
        var valPerTurn = value / dist;
        if (valPerTurn >= cutoff) newList.push(pathList[i]);
      }
      if (newList.length > 0) newDict.set(group, newList);
    });

    return newDict;
  }

  // ---------------------------------------------------------------------
  // expansion_knapsack_gather_iteration
  // ---------------------------------------------------------------------
  function expansionKnapsackGatherIteration(turns, valuePerTurnPathPerTile, perfTimer, shouldLog, valueFunc) {
    var totalValue = 0;
    var maxKnapsackedPaths = [];
    var pathValLookup = new Map();

    function buildInputs(fromCache) {
      var groups = [];
      var paths = [];
      var values = [];
      var weights = [];
      var groupIdx = 0;
      valuePerTurnPathPerTile.forEach(function (pathGroup) {
        if (pathGroup.length === 0) return;
        for (var i = 0; i < pathGroup.length; i++) {
          var path = pathGroup[i];
          groups.push(groupIdx);
          paths.push(path);
          var vd;
          if (fromCache) {
            vd = pathValLookup.get(path);
          } else {
            vd = valueFunc(path);
            pathValLookup.set(path, vd);
          }
          values.push(vd[0]);
          weights.push(vd[1]);
        }
        groupIdx += 1;
      });
      return { groups: groups, paths: paths, values: values, weights: weights };
    }

    var inputs = buildInputs(false);
    if (inputs.paths.length === 0) return [0, []];

    var error = true;
    var attempts = 0;
    while (error && attempts < 5) {
      attempts += 1;
      try {
        var solved = solveMultipleChoiceKnapsack(inputs.paths, turns, inputs.weights, inputs.values, inputs.groups, true, 0.005);
        totalValue = solved[0];
        maxKnapsackedPaths = solved[1];
        error = false;
      } catch (ex) {
        valuePerTurnPathPerTile = pruneWorstPathsTwoThirdsMedian(valuePerTurnPathPerTile, valueFunc, attempts);
        inputs = buildInputs(true);
        if (inputs.paths.length === 0) return [0, []];
      }
    }

    var sorted = sortedByKey(maxKnapsackedPaths, function (p) {
      return pathValLookup.get(p)[0] / Math.max(1, p.length);
    }, true);

    return [totalValue, sorted];
  }

  // ---------------------------------------------------------------------
  // should_consider_path_move_half
  // ---------------------------------------------------------------------
  function shouldConsiderPathMoveHalf(map, path, negativeTiles, player, playerDistMap, enemyDistMap,
    withinGenPathThreshold, tilesOnMainPathDist) {

    var firstMove = path.get_first_move();
    if (firstMove.move_half) return true;

    var src = firstMove.source;
    var dest = firstMove.dest;
    if (src.player() !== dest.player()) {
      var capAmt = src.army - 1 - dest.army;
      var halfCapAmt = EK.Tile.get_move_half_amount(src.army) - dest.army;
      var halfCapLeftBehind = src.army - halfCapAmt;
      var canCapWithSplit = halfCapAmt > 0;
      var moreCapTile = null;
      if (canCapWithSplit) {
        var canCapMoreOnPathWithNoSplit = false;
        for (var di = 0; di < dest.movable.length; di++) {
          var nextCap = dest.movable[di];
          if (nextCap === src) continue;
          if (nextCap.player() !== src.player() && capAmt - 1 > nextCap.army) {
            canCapMoreOnPathWithNoSplit = true;
            moreCapTile = nextCap;
            break;
          }
        }

        var canCapMoreAdjToSrcWithSplit = false;
        for (var sj = 0; sj < src.movable.length; sj++) {
          var nextSrcCap = src.movable[sj];
          if (nextSrcCap === moreCapTile || nextSrcCap === dest) continue;
          if (nextSrcCap.player() !== src.player() && halfCapLeftBehind - 1 > nextSrcCap.army) {
            canCapMoreAdjToSrcWithSplit = true;
          }
        }

        if (capAmt < 7 && canCapMoreAdjToSrcWithSplit && !canCapMoreOnPathWithNoSplit && canCapWithSplit) {
          return true;
        }
      }
    }

    var largeTileThreshold = Math.trunc(Math.pow(Math.max(16, map.players[player].standingArmy), 0.5));

    var pathTile = path.get_first_move().source;
    var pathTileDistSum = enemyDistMap.raw[pathTile.tile_index] + playerDistMap.raw[pathTile.tile_index];

    function filter_alternate_movables(tile) {
      if (tile.isMountain) return false;
      if (tile.isCity && tile.player() !== player) return false;
      if (negativeTiles.has(tile)) return false;
      if (path.tileSet.has(tile)) return false;
      if (tile.player() === player) return false;

      var tileDistSum = enemyDistMap.raw[tile.tile_index] + playerDistMap.raw[tile.tile_index];
      var tileNotTooFarToFlank = tileDistSum < withinGenPathThreshold;
      var tileShouldTakeEverything = tileDistSum < tilesOnMainPathDist;

      var altMovableMovingAwayFromPath = pathTileDistSum < tileDistSum;
      if (altMovableMovingAwayFromPath && !tileNotTooFarToFlank) return false;

      var capArmy = floorDiv(pathTile.army, 2);
      var altCappable = new Set();

      function filter_alternate_path(altTile) {
        if (altTile.isMountain) return;
        if (negativeTiles.has(altTile)) return;
        if (path.tileSet.has(altTile)) return;
        if (altTile.isCity && altTile.player() !== player) return;
        if (altTile.player() === player) return;
        if (altTile.isNeutral && capArmy > 3) return;
        if (altTile === tile) return;

        var altTileDistSum = enemyDistMap.raw[altTile.tile_index] + playerDistMap.raw[altTile.tile_index];
        var movingTowardPath = altTileDistSum < tileDistSum;
        var movingParallelToPath = altTileDistSum === tileDistSum;
        if (movingTowardPath || tileShouldTakeEverything || (tileNotTooFarToFlank && movingParallelToPath)) {
          altCappable.add(altTile);
        }
      }

      S().breadth_first_foreach(map, [tile], 5, filter_alternate_path, null, true);

      var canCapTile = capArmy - 1 > tile.army;
      var isEnemyTileThatCanRecapture = tile.player() >= 0 && tile.army > 2;
      var canProbablyCaptureNearbyTiles = altCappable.size > floorDiv(capArmy, 2);

      var altPathSplitThresh = largeTileThreshold * 2;

      if ((canCapTile && canProbablyCaptureNearbyTiles && pathTile.army < altPathSplitThresh) ||
        (isEnemyTileThatCanRecapture && pathTile.army < largeTileThreshold)) {
        return true;
      }

      return false;
    }

    if (countWhere(pathTile.movable, filter_alternate_movables) > 0) return true;

    return false;
  }

  // ---------------------------------------------------------------------
  // exports
  // ---------------------------------------------------------------------
  EK.ExpandUtils = {
    RoundPlan: RoundPlan,
    get_round_plan_with_expansion: get_round_plan_with_expansion,
    _include_optimal_expansion_options: includeOptimalExpansionOptions,
    _process_new_expansion_paths: processNewExpansionPaths,
    _check_should_delay: checkShouldDelay,
    _include_leaf_moves_in_exp_plan: includeLeafMovesInExpPlan,
    _execute_expansion_gather_to_borders: executeExpansionGatherToBorders,
    path_has_cities_and_should_wait: pathHasCitiesAndShouldWait,
    _group_expand_paths_by_crossovers: groupExpandPathsByCrossovers,
    _merge_path_groups_recurse: mergePathGroupsRecurse,
    _get_tile_path_value: getTilePathValue,
    add_path_to_try_avoid_paths_crossing_tiles: addPathToTryAvoidPathsCrossingTiles,
    move_can_cap_more: moveCanCapMore,
    knapsack_multi_paths: knapsackMultiPaths,
    knapsack_multi_paths_no_crossover: knapsackMultiPathsNoCrossover,
    get_multiple_choice_expansion_knapsack_val_converter: getMultipleChoiceExpansionKnapsackValConverter,
    extract_paths_from_knapsack_groups: extractPathsFromKnapsackGroups,
    _try_include_alt_sourced_path: tryIncludeAltSourcedPath,
    _get_capture_counts: getCaptureCounts,
    _get_uncertainty_capture_rating: getUncertaintyCaptureRating,
    find_optimal_expansion_path_to_move_first: findOptimalExpansionPathToMoveFirst,
    _prune_worst_paths_greedily: function (a, b, c) { return pruneWorstPathsGreedily(a, b, c, false); },
    _prune_worst_paths_greedily__shorter_bias: function (a, b, c) { return pruneWorstPathsGreedily(a, b, c, true); },
    _prune_worst_paths__two_thirds_median: pruneWorstPathsTwoThirdsMedian,
    expansion_knapsack_gather_iteration: expansionKnapsackGatherIteration,
    should_consider_path_move_half: shouldConsiderPathMoveHalf,
    solve_multiple_choice_knapsack: solveMultipleChoiceKnapsack,
    isPlayerOnTeamWith: isPlayerOnTeamWith,
    TARGET_CAP_VALUE: TARGET_CAP_VALUE,
    NEUTRAL_CAP_VALUE: NEUTRAL_CAP_VALUE,
    ENEMY_TILE_CAP_VALUE: ENEMY_TILE_CAP_VALUE
  };

  EK.knapsack = { solve_multiple_choice_knapsack: solveMultipleChoiceKnapsack };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

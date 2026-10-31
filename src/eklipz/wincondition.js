/* eslint-disable */
/*
 * WinConditionAnalyzer —— 逐函数对照 Strategy/WinConditionAnalyzer.py（1452 行）的移植。
 *
 * 依赖（全部现成，运行时从全局 EK 取，避免文件加载顺序耦合）：
 *   EK.OpponentTracker      opponenttracker.js
 *   EK.BoardAnalyzer        board.js
 *   EK.CityAnalyzer         city.js
 *   EK.TerritoryClassifier  territory.js
 *   EK.search.*             search.js（全位置参数 + opts）
 *   EK.GatherTreeNode / EK.GatherCapturePlan / EK.GatherPrune   gather.js
 *   EK.Path                 path.js
 *
 * 与原版的三处已知差异（都是为了在本仓库里跑得起来，见文件末尾 REPORT 注释）：
 *   1. 原版攻城/守城计划走 Gather.knapsack_max_gather_with_values（GatherMaxIterative
 *      的多次选择背包）。本仓库没有这个求解器（gather.js 头部明确说没搬），这里用
 *      原版自己的「单条最大 v/t 路径迭代」分支（_get_single_line_iterative_starter_max）
 *      的语义实现 planSoftMaxGather()，树结构与 prune 门槛和原版一致，但迭代到的是
 *      贪心最优而非背包最优。
 *   2. ViewInfo / __getstate__ / __setstate__ / 渲染不搬（原版 WinConditionAnalyzer
 *      也没有 __getstate__，只有 city_contestation_history 的 dump/load）。
 *   3. WinCondition 用字符串常量而非 Enum：botmain.js 里写的是
 *      viable_win_conditions.has('DefendContestedFriendlyCity')，数值枚举会静默失配。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ================================================================== *
   * WinCondition
   * ================================================================== */

  var WinCondition = {
    WinOnEconomy: 0,
    KillAllIn: 1,
    DefendEconomicLead: 2,
    DefendContestedFriendlyCity: 3,
    ContestEnemyCity: 4
  };
  // name → 数值，同时用字符串做 key 供 botmain 的 .has('X') 写法使用。
  var WIN_CONDITION_BY_NAME = {
    WinOnEconomy: 0,
    KillAllIn: 1,
    DefendEconomicLead: 2,
    DefendContestedFriendlyCity: 3,
    ContestEnemyCity: 4
  };
  var WIN_CONDITION_NAMES = {};
  for (var _wcName in WIN_CONDITION_BY_NAME) WIN_CONDITION_NAMES[WIN_CONDITION_BY_NAME[_wcName]] = _wcName;

  /* ================================================================== *
   * CityOwnershipTransfer
   * ================================================================== */

  function CityOwnershipTransfer(player, turn, army) {
    this.player = player;
    this.turn = turn;
    this.army = army;
  }

  CityOwnershipTransfer.prototype.serialize = function () {
    return this.player + ':' + this.turn + ':' + this.army;
  };

  CityOwnershipTransfer.deserialize = function (data) {
    var parts = String(data).split(':');
    return new CityOwnershipTransfer(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
  };

  /* ================================================================== *
   * 小工具（与原版语义一一对应）
   * ================================================================== */

  // Python 的 round() 是银行家舍入；JS Math.round 是 .5 向上。城市防守估算里
  // 0.45 * 8 = 3.6 这种非 .5 值占多数，但 0.25 * 偶数 会正好落到 .5，必须对齐。
  function pyRound(v) {
    var floor = Math.floor(v);
    var diff = v - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  // BehaviorAlgorithms/IterativeExpansion.py:36
  var ITERATIVE_EXPANSION_EN_CAP_VAL = 2.05;

  function isNone(v) {
    return v === null || v === undefined;
  }

  function toArr(v) {
    if (isNone(v)) return [];
    if (Array.isArray(v)) return v;
    if (v instanceof Set || (v && typeof v.values === 'function' && typeof v.has === 'function')) {
      return Array.from(v.values());
    }
    if (v instanceof Map) return Array.from(v.values());
    return [];
  }

  // Python set 迭代顺序不定，但本仓库约定按 tile_index 升序，保证可复现。
  function sortedTiles(iterable) {
    var arr = toArr(iterable);
    arr.sort(function (a, b) {
      return (a.tile_index | 0) - (b.tile_index | 0);
    });
    return arr;
  }

  function playerOf(tile) {
    if (isNone(tile)) return -1;
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  function isPlayerOnTeamWith(map, a, b) {
    if (a === b) return true;
    if (a === -1 || b === -1) return false;
    return map.is_player_on_team_with(a, b);
  }

  function isTileOnTeamWith(map, tile, player) {
    return map.is_tile_on_team_with(tile, player);
  }

  // map.players[i].cities 在原版是 List，JS 侧是数组；统一取数组。
  function playerCities(map, player) {
    if (player < 0 || isNone(map.players) || isNone(map.players[player])) return [];
    return map.players[player].cities || [];
  }

  function remainingCycleTurns(map) {
    if (typeof map.remainingCycleTurns === 'number') return map.remainingCycleTurns;
    return 50 - (map.turn % 50);
  }

  function cycleTurn(map) {
    if (typeof map.cycleTurn === 'number') return map.cycleTurn;
    return map.turn % 50;
  }

  /* ================================================================== *
   * 计划树构造工具（本地实现，不往 gather.js 里加东西）
   * ================================================================== */

  // python Path.convert_to_tree_nodes(map, asPlayer)：把一条 Path 变成单链
  // GatherTreeNode 列表，value 用路径上累计的 army 变化。
  function convertPathToTreeNodes(path, map, asPlayer) {
    var GatherTreeNode = EK.GatherTreeNode;
    if (isNone(path) || isNone(path.tileList) || path.tileList.length === 0) return null;

    var tiles = path.tileList;
    var root = null;
    var prev = null;
    var running = 0;
    var turns = path.length;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var node = new GatherTreeNode(t, prev === null ? null : prev.tile, 0);
      node.gatherTurns = turns - i;
      if (i > 0) {
        var eff = 1;
        if (isPlayerOnTeamWith(map, playerOf(t), asPlayer)) eff -= t.army;
        running -= eff;
        node.value = path.value + running;
      } else {
        node.value = path.value;
      }
      node.trunkValue = running;
      node.trunkDistance = i;
      if (prev === null) {
        root = node;
      } else {
        prev.children.push(node);
      }
      prev = node;
    }
    return root;
  }

  /* ================================================================== *
   * 计划剪枝：prune_mst_to_turns_with_values / prune_mst_to_max_army_per_turn_with_values
   * 直接坐 EK.GatherPrune.prune_mst_until 上（原版也是这么实现的）。
   * ================================================================== */

  function pruneMstToTurnsWithValues(rootNodes, turns, searchingPlayer, opts) {
    opts = opts || {};
    var GatherPrune = EK.GatherPrune;

    var invalidMoveFunc = opts.invalidMoveFunc || function (node) {
      if (node.tile.army <= 1) return true;
      if (playerOf(node.tile) !== searchingPlayer && node.children.length === 0) return true;
      return false;
    };

    var pruneOrderFunc = function (node) {
      var rawValPerTurn = -100;
      if (node.gatherTurns > 0) rawValPerTurn = node.value / node.gatherTurns;
      return [rawValPerTurn, node.value, 0 - node.trunkDistance];
    };

    var overpruneCutoff = isNone(opts.overpruneCutoff) ? turns : opts.overpruneCutoff;

    var untilFunc = function (node, prioObj, turnsLeft) {
      return turnsLeft <= turns;
    };

    var pruneOverrideFunc = function (node, prioObj, turnsLeft) {
      return turnsLeft - node.gatherTurns < overpruneCutoff;
    };

    return GatherPrune.prune_mst_until(
      rootNodes,
      untilFunc,
      pruneOrderFunc,
      invalidMoveFunc,
      true,                       // pruneBranches
      pruneOverrideFunc,          // pruneOverrideFunc
      null,                       // viewInfo
      true,                       // noLog
      opts.gatherTreeNodeLookupToPrune || null,
      opts.tileDictToPrune || null,
      opts.preferPrune || null,
      null,                       // parentPruneFunc
      opts.allowNegative === undefined ? true : opts.allowNegative,
      null,                       // logEntries
      null                        // pruneCallbackFunc
    );
  }

  function pruneMstToMaxArmyPerTurnWithValues(rootNodes, minArmy, searchingPlayer, teams, opts) {
    opts = opts || {};
    var GatherPrune = EK.GatherPrune;
    var GatherTreeNode = EK.GatherTreeNode;

    var additionalIncrement = opts.additionalIncrement || 0;
    var minTurns = opts.minTurns || 0;
    var allowNegative = opts.allowNegative === undefined ? true : opts.allowNegative;
    var allowBranchPrune = opts.allowBranchPrune === undefined ? true : opts.allowBranchPrune;

    var cityCounter = 0 - additionalIncrement;
    var cityGatherDepthCounter = 0;
    var citySkipTiles = new Set();
    var totalValue = 0;
    var totalTurns = 0;

    for (var i = 0; i < rootNodes.length; i++) {
      var n = rootNodes[i];
      if ((n.tile.isCity || n.tile.isGeneral) && !n.tile.isNeutral) {
        if (teams[playerOf(n.tile)] === teams[searchingPlayer]) citySkipTiles.add(n.tile);
      }
      totalTurns += n.gatherTurns;
      totalValue += n.value;
    }

    if (totalTurns === 0) return [0, 0, rootNodes];

    // 原版：gather 总量本来就不够 minArmy 时直接原样返回，不剪。
    if (totalValue < minArmy) return [totalTurns, totalValue, rootNodes];

    var cityCounterFunc = function (node) {
      if ((node.tile.isGeneral || node.tile.isCity) && !node.tile.isNeutral && !citySkipTiles.has(node.tile)) {
        if (teams[playerOf(node.tile)] === teams[searchingPlayer]) {
          cityCounter += 1;
          cityGatherDepthCounter += node.trunkDistance;
        } else {
          cityCounter -= 1;
        }
      }
      if (node.tile.isSwamp) {
        if (!node.tile.isNeutral) cityCounter -= 1;
      }
    };
    GatherTreeNode.foreach_tree_node(rootNodes, cityCounterFunc);

    var invalidMoveFunc = opts.invalidMoveFunc || function (node) {
      if (node.tile.army <= 1) return true;
      if (playerOf(node.tile) !== searchingPlayer) return true;
      return false;
    };

    var curValuePerTurn = totalValue / totalTurns;

    var untilFunc = function (node, prioObj, turnsLeft, curValue) {
      var turnsLeftIfPruned = turnsLeft - node.gatherTurns;
      if (turnsLeftIfPruned <= minTurns) return true;
      var cityIncrementAmount = cityCounter * Math.floor((turnsLeftIfPruned - 1) / 2);
      cityIncrementAmount -= Math.floor(cityGatherDepthCounter / 2);
      var armyLeftIfPruned = curValue - node.value + cityIncrementAmount;
      var pruneValPerTurn = armyLeftIfPruned / turnsLeftIfPruned;
      if (pruneValPerTurn < curValuePerTurn || armyLeftIfPruned < minArmy) return true;

      if (teams[playerOf(node.tile)] === teams[searchingPlayer]) {
        if (node.tile.isCity || node.tile.isGeneral) {
          cityGatherDepthCounter -= node.trunkDistance;
          cityCounter -= 1;
        } else if (node.tile.isSwamp) {
          cityGatherDepthCounter -= node.trunkDistance;
          cityCounter += 1;
        }
      }

      curValuePerTurn = pruneValPerTurn;
      return false;
    };

    var pruneOrderFunc = function (node) {
      if (node.gatherTurns === 0 || node.trunkDistance === 0) return [-1, -1, -1];
      return [node.value / node.gatherTurns, node.trunkValue / node.trunkDistance, node.trunkDistance];
    };

    return GatherPrune.prune_mst_until(
      rootNodes,
      untilFunc,
      pruneOrderFunc,
      invalidMoveFunc,
      allowBranchPrune,
      null,                        // pruneOverrideFunc
      null,                        // viewInfo
      opts.noLog === undefined ? true : opts.noLog,
      opts.gatherTreeNodeLookupToPrune || null,
      null,                        // tileDictToPrune
      opts.preferPrune || null,
      null,                        // parentPruneFunc
      allowNegative,
      null,
      null
    );
  }

  /* ================================================================== *
   * 从起点迭代攒树（原版 _get_sub_knapsack_max_gather 的单路径分支）
   * ================================================================== */

  // 默认 valueFunc / priorityFunc / baseCaseFunc：逐字照抄
  // GatherMaxIterative.knapsack_max_gather_with_values 里的闭包。
  function makeKnapsackFuncs(ctx) {
    var searchingPlayer = ctx.searchingPlayer;
    var friendlyPlayers = ctx.friendlyPlayers;
    var negativeTiles = ctx.negativeTiles;
    var useTrueValueGathered = !!ctx.useTrueValueGathered;
    var includeGatherTreeNodesThatGatherNegative = !!ctx.includeGatherTreeNodesThatGatherNegative;
    var priorityMatrix = ctx.priorityMatrix || null;

    function valueFunc(currentTile, priorityObject) {
      var negArmySum = priorityObject[4];
      var negGatheredSum = priorityObject[3];
      var realDist = priorityObject[2];

      if (negArmySum >= 0 && !includeGatherTreeNodesThatGatherNegative) return null;
      if (negGatheredSum >= 0) return null;
      if (currentTile.army < 2 || playerOf(currentTile) !== searchingPlayer) return null;

      var val = -1000;
      if (realDist > 0) val = 0 - negGatheredSum;

      return [val, 0 - negGatheredSum, 0 - negArmySum, realDist];
    }

    function pathValueFunc(path, valueObj) {
      return valueObj[1];
    }

    function priorityFunc(nextTile, currentPriorityObject) {
      var realDist = currentPriorityObject[2];
      var negGatheredSum = currentPriorityObject[3];
      var negArmySum = currentPriorityObject[4];
      var numPrioTiles = currentPriorityObject[5];

      negArmySum += 1;
      negGatheredSum += 1;
      if (nextTile.isSwamp) {
        if (playerOf(nextTile) !== searchingPlayer || nextTile.army === 1) {
          negArmySum += 1;
          negGatheredSum += 1;
          realDist += 4;
          numPrioTiles -= 2;
        }
      }
      if (!negativeTiles.has(nextTile)) {
        if (friendlyPlayers.indexOf(playerOf(nextTile)) >= 0) {
          negArmySum -= nextTile.army;
          negGatheredSum -= nextTile.army;
        } else {
          negArmySum += nextTile.army;
          if (useTrueValueGathered) negGatheredSum += nextTile.army;
        }
      }
      if (!isNone(priorityMatrix)) {
        negGatheredSum -= priorityMatrix.raw[nextTile.tile_index];
      }
      realDist += 1;
      var prioVal = -100000;
      if (realDist > 0) prioVal = 10000 + negGatheredSum / realDist + 0.05 * (realDist * realDist);

      return [prioVal, 0 - numPrioTiles / Math.max(1, realDist), realDist, negGatheredSum, negArmySum, numPrioTiles];
    }

    function baseCaseFunc(tile, startingDist) {
      return [-100000000000.0, 0, 0, 0, 0, 0];
    }

    return {
      valueFunc: valueFunc,
      pathValueFunc: pathValueFunc,
      priorityFunc: priorityFunc,
      baseCaseFunc: baseCaseFunc
    };
  }

  // 一轮：从当前 startTilesDict 找一条最大 v/t 路径，把它整条并进树。
  // 语义对齐 _extend_tree_node_lookup + _add_tree_nodes_to_start_tiles_dict_recurse_max。
  function extendTreeFromPath(path, state, funcs, map, searchingPlayer) {
    var GatherTreeNode = EK.GatherTreeNode;
    var startTilesDict = state.startTilesDict;
    var lookup = state.lookup;

    var tiles = path.tileList;
    if (isNone(tiles) || tiles.length < 2) return false;
    var tailTile = tiles[tiles.length - 1];
    if (tailTile.army <= 1 || playerOf(tailTile) !== searchingPlayer) return false;

    var startTile = tiles[0];
    var distEntry = startTilesDict.get(startTile);
    var distance = isNone(distEntry) ? 0 : distEntry[1];

    var current = lookup.get(startTile);
    if (isNone(current)) {
      current = new GatherTreeNode(startTile, null, distance);
      lookup.set(startTile, current);
      startTilesDict.set(startTile, [funcs.baseCaseFunc(startTile, distance), distance]);
    }

    var addlDist = 1;
    for (var i = 1; i < tiles.length; i++) {
      var tile = tiles[i];

      var existing = null;
      for (var ci = 0; ci < current.children.length; ci++) {
        if (current.children[ci].tile.tile_index === tile.tile_index) {
          existing = current.children[ci];
          break;
        }
      }
      if (existing !== null) {
        current = existing;
        addlDist += 1;
        continue;
      }

      var newDist = distance + addlDist;
      var node = new GatherTreeNode(tile, current.tile, newDist);
      node.trunkDistance = current.trunkDistance + 1;
      current.children.push(node);
      lookup.set(tile, node);
      // 路径中间的格子也进 startTilesDict：下一轮迭代从这里继续长。
      startTilesDict.set(tile, [funcs.baseCaseFunc(tile, newDist), newDist]);
      current = node;
      addlDist += 1;
    }

    return true;
  }

  // 自底向上重算 value / gatherTurns（子树聚合）。原版由 _extend_tree_node_lookup
  // 在建树时就地累加，这里改成一次性后算，语义等价、状态更干净。
  //   value       = 子树里「我方格子加兵、敌方/中立减兵」的和
  //   gatherTurns = 进子树要花的回合数
  function recomputeTreeValues(rootNodes, map, searchingPlayer) {
    function walk(node) {
      var v = 0;
      var t = 0;
      for (var i = 0; i < node.children.length; i++) {
        var sub = walk(node.children[i]);
        v += sub[0];
        t += sub[1];
      }
      if (isPlayerOnTeamWith(map, playerOf(node.tile), searchingPlayer)) v += node.tile.army;
      else v -= node.tile.army;
      node.value = v;
      node.gatherTurns = node.toTile === null ? t : t + 1;
      return [v, node.gatherTurns];
    }
    for (var r = 0; r < rootNodes.length; r++) walk(rootNodes[r]);
  }

  // 迭代攒树 + 逐步剪枝。对应 _knapsack_max_gather_iterative_prune 的骨架：
  // 每轮找一条最大 v/t 路径 → 并入树 → 树按 turns 剪到 pruneToTurns。
  function iterativeMaxGather(map, startTiles, turns, opts) {
    opts = opts || {};
    var searchingPlayer = opts.searchingPlayer === undefined ? -2 : opts.searchingPlayer;
    var negativeTiles = opts.negativeTiles ? new Set(opts.negativeTiles) : new Set();
    var skipTiles = opts.skipTiles || null;
    var priorityMatrix = opts.priorityMatrix || null;
    var distPriorityMap = opts.distPriorityMap || null;
    var useTrueValueGathered = !!opts.useTrueValueGathered;
    var includeGatherTreeNodesThatGatherNegative = !!opts.includeGatherTreeNodesThatGatherNegative;
    var fastMode = !!opts.fastMode;
    var maxIterations = opts.maxIterations === undefined ? 24 : opts.maxIterations;

    if (searchingPlayer === -2) {
      var firstStart = toArr(startTiles)[0];
      searchingPlayer = isNone(firstStart) ? map.player_index : playerOf(firstStart);
    }

    var friendlyPlayers = map.get_teammates(searchingPlayer);
    var teams = EK.Map.get_teams_array ? EK.Map.get_teams_array(map) : (map.team_ids_by_player_index || []);

    var ctx = {
      searchingPlayer: searchingPlayer,
      friendlyPlayers: friendlyPlayers,
      negativeTiles: negativeTiles,
      useTrueValueGathered: useTrueValueGathered,
      includeGatherTreeNodesThatGatherNegative: includeGatherTreeNodesThatGatherNegative,
      priorityMatrix: priorityMatrix
    };
    var funcs = makeKnapsackFuncs(ctx);

    var startTilesDict = new Map();
    var startArr = toArr(startTiles);
    for (var i = 0; i < startArr.length; i++) {
      var t = startArr[i];
      startTilesDict.set(t, [funcs.baseCaseFunc(t, 0), 0]);
      negativeTiles.add(t);
    }
    var origStartTiles = Array.from(startTilesDict.keys());

    var state = {
      startTilesDict: startTilesDict,
      lookup: new Map(),
      negativeTiles: negativeTiles,
      useTrueValueGathered: useTrueValueGathered
    };
    for (var s = 0; s < origStartTiles.length; s++) {
      var st = origStartTiles[s];
      state.lookup.set(st, new EK.GatherTreeNode(st, null, 0));
    }

    var fullTurns = turns;
    var turnsSoFar = 0;
    var lastPrunedTo = 0;
    var maxPerIteration = fastMode
      ? Math.max(Math.min(7, Math.floor(3 * fullTurns / 4)), Math.floor(fullTurns / 2))
      : Math.max(Math.min(4, Math.floor(fullTurns / 2)), Math.floor(fullTurns / 4));
    if (maxPerIteration < 1) maxPerIteration = 1;

    var totalValue = 0;
    var rootNodes = [];
    var itr = 0;

    while (lastPrunedTo < fullTurns && itr < maxIterations) {
      itr += 1;
      var turnsToGather = fullTurns - turnsSoFar;

      var path = EK.search.breadth_first_dynamic_max(
        map, startTilesDict, funcs.valueFunc, {
          maxTurns: turnsToGather,
          maxDepth: 10000,
          noNeutralCities: true,
          negativeTiles: negativeTiles,
          skipTiles: skipTiles,
          searchingPlayer: searchingPlayer,
          priorityFunc: funcs.priorityFunc,
          ignoreStartTile: true,
          incrementBackward: !!opts.incrementBackward,
          preferNeutral: !!opts.preferNeutral,
          priorityMatrix: priorityMatrix,
          ignoreNonPlayerArmy: !useTrueValueGathered,
          ignoreIncrement: true,
          pathValueFunc: funcs.pathValueFunc,
          priorityMatrixSkipStart: true,
          maxTime: Infinity
        }
      );

      if (isNone(path)) break;
      if (!extendTreeFromPath(path, state, funcs, map, searchingPlayer)) break;

      turnsSoFar += path.length;
      totalValue = path.value;

      if (itr > 1 && maxPerIteration > 1) {
        maxPerIteration = fastMode
          ? Math.floor(3 * maxPerIteration / 4) + 1
          : Math.floor(3 * maxPerIteration / 5) + 1;
      }
      if (maxPerIteration < 1) maxPerIteration = 1;

      var pruneToTurns = lastPrunedTo + maxPerIteration;
      var overpruneCutoff = Math.max(Math.floor(pruneToTurns / 2), lastPrunedTo - maxPerIteration);

      rootNodes = [];
      for (var r = 0; r < origStartTiles.length; r++) {
        var rn = state.lookup.get(origStartTiles[r]);
        if (!isNone(rn)) rootNodes.push(rn);
      }
      recomputeTreeValues(rootNodes, map, searchingPlayer);

      var pruned = pruneMstToTurnsWithValues(rootNodes, pruneToTurns, searchingPlayer, {
        allowNegative: includeGatherTreeNodesThatGatherNegative,
        overpruneCutoff: overpruneCutoff,
        gatherTreeNodeLookupToPrune: state.lookup,
        tileDictToPrune: startTilesDict
      });
      turnsSoFar = pruned[0];
      totalValue = pruned[1];
      rootNodes = pruned[2];
      lastPrunedTo = pruneToTurns;
    }

    rootNodes = [];
    for (var r2 = 0; r2 < origStartTiles.length; r2++) {
      var rn2 = state.lookup.get(origStartTiles[r2]);
      if (!isNone(rn2)) rootNodes.push(rn2);
    }
    recomputeTreeValues(rootNodes, map, searchingPlayer);

    var totalTurns = 0;
    totalValue = 0;
    for (var g = 0; g < rootNodes.length; g++) {
      totalTurns += rootNodes[g].gatherTurns;
      totalValue += rootNodes[g].value;
    }

    return {
      value: Math.round(totalValue),
      turns: totalTurns,
      rootNodes: rootNodes,
      lookup: state.lookup,
      startTilesDict: startTilesDict
    };
  }

  /* ================================================================== *
   * WinConditionSet：botmain 用 .has('DefendContestedFriendlyCity')（字符串），
   * Python 侧存的是枚举。这里两者都认，存的仍是数值，迭代也仍是数值。
   * ================================================================== */

  function normWinCondition(v) {
    if (typeof v === 'string' && WIN_CONDITION_BY_NAME[v] !== undefined) return WIN_CONDITION_BY_NAME[v];
    return v;
  }

  // Set 的内部槽必须由 Set 自己初始化，所以用 Reflect.construct 拿到真 Set 实例，
  // 原型挂在 WinConditionSet 上，再覆写 add/has 做名字↔数值归一。
  function WinConditionSet(iterable) {
    var inst = Reflect.construct(Set, [], WinConditionSet);
    if (iterable) {
      var arr = Array.from(iterable);
      for (var i = 0; i < arr.length; i++) Set.prototype.add.call(inst, normWinCondition(arr[i]));
    }
    return inst;
  }
  WinConditionSet.prototype = Object.create(Set.prototype);
  WinConditionSet.prototype.constructor = WinConditionSet;
  WinConditionSet.prototype.add = function (v) {
    Set.prototype.add.call(this, normWinCondition(v));
    return this;
  };
  WinConditionSet.prototype.has = function (v) {
    return Set.prototype.has.call(this, normWinCondition(v));
  };

  EK.WinConditionSet = WinConditionSet;

  /* ================================================================== *
   * 计划对象的小访问器（GatherCapturePlan 的 JS 版字段名与 python 略有出入）
   * ================================================================== */

  function planTurns(plan) {
    if (isNone(plan)) return 0;
    if (typeof plan.length === 'number') return plan.length;
    return plan._turns || 0;
  }

  function planGatherTurns(plan) {
    if (isNone(plan)) return 0;
    if (!isNone(plan.gather_turns)) return plan.gather_turns;
    return plan._turns || 0;
  }

  function planTiles(plan) {
    if (isNone(plan)) return [];
    if (!isNone(plan.tileList)) return plan.tileList;
    return plan.tiles || [];
  }

  function emptyPlan(map) {
    return new EK.GatherCapturePlan([], map, 0.0, 0, 0, 0.0, 0, 0, null, 0, 0,
      map === null ? -1 : map.player_index, null);
  }

  /* ================================================================== *
   * WinConditionAnalyzer
   * ================================================================== */

  function WinConditionAnalyzer(map, opponentTracker, cityAnalyzer, territories, boardAnalyzer) {
    this.map = map;
    this.opponent_tracker = opponentTracker;
    this.city_analyzer = cityAnalyzer;
    this.territories = territories;
    this.board_analysis = boardAnalyzer;

    this.viable_win_conditions = new WinConditionSet();
    this.last_viable_win_conditions = new WinConditionSet();

    this.is_contesting_cities = false;
    this.target_player = -1;
    this.target_player_location = map.get_tile_by_tile_index !== undefined ? map.GetTile(0, 0) : null;
    this.best_target_player_attack_target = this.target_player_location;

    this.recommended_offense_plan_turns = 0;
    this.recommended_city_defense_plan_turns = 0;
    this.our_best_attack_plan = null;
    this.all_in_plan = null;

    this.projected_loss_all_in_active = false;
    this.projected_loss_all_in_target = null;

    this._verbose_logging_enabled = false;
    this.contestable_city_offense_plans = new Map();
    this.city_contestation_history = new Map();

    this.most_forward_defense_city = null;
    this.contestable_cities = new Set();
    this.defend_cities = new Set();

    this.basic_defense_general_moves = 0;
    this.basic_defense_general_turns = 0;
    this.basic_defense_general_army = 0;
    this.basic_defense_general_tiles = new Set();

    this.basic_defense_forward_moves = 0;
    this.basic_defense_forward_turns = 0;
    this.basic_defense_forward_army = 0;
    this.basic_defense_forward_tiles = new Set();

    // 原版是 logbook.info；botmain 会把它换成自己的日志器。
    this.info = function () {};
  }

  var WCA = WinConditionAnalyzer.prototype;

  /* ------------------------------------------------------------ 记录与落盘 */

  WCA.record_city_capture = function (city, player, turn, army) {
    if (isNone(city) || !city.isCity) return;
    if (isNone(turn)) turn = this.map.turn;
    if (isNone(army)) army = city.army;

    var history = this.city_contestation_history.get(city);
    if (isNone(history)) {
      history = [];
      this.city_contestation_history.set(city, history);
    }
    if (history.length > 0) {
      var last = history[history.length - 1];
      if (last.player === player && last.turn === turn && last.army === army) return;
    }
    history.push(new CityOwnershipTransfer(player, turn, army));
  };

  WCA.get_city_contestation_count = function (city, within_last_turns) {
    var history = this.city_contestation_history.get(city);
    if (isNone(history) || history.length === 0) return 0;
    if (isNone(within_last_turns)) return history.length;
    var count = 0;
    var cutoff = this.map.turn - within_last_turns;
    for (var i = 0; i < history.length; i++) {
      if (history[i].turn > cutoff) count += 1;
    }
    return count;
  };

  WCA.was_city_recently_contested = function (city, capture_cutoff_ago_turns) {
    if (isNone(capture_cutoff_ago_turns)) capture_cutoff_ago_turns = 20;
    var history = this.city_contestation_history.get(city);
    if (isNone(history) || history.length === 0) return false;
    return history[history.length - 1].turn > this.map.turn - capture_cutoff_ago_turns;
  };

  // 对应 python：按 (x,y) 升序输出 `ot_city_{x}_{y}=p:t:a|p:t:a`。
  WCA.dump_city_contestation_history = function () {
    var items = [];
    this.city_contestation_history.forEach(function (history, city) {
      items.push([city, history]);
    });
    items.sort(function (a, b) {
      if (a[0].x !== b[0].x) return a[0].x - b[0].x;
      return a[0].y - b[0].y;
    });

    var out = [];
    for (var i = 0; i < items.length; i++) {
      var city = items[i][0];
      var history = items[i][1];
      if (isNone(history) || history.length === 0) continue;
      var parts = [];
      for (var h = 0; h < history.length; h++) parts.push(history[h].serialize());
      out.push('ot_city_' + city.x + '_' + city.y + '=' + parts.join('|'));
    }
    return out;
  };

  WCA.dump_projected_loss_all_in_state = function () {
    var out = ['wca_projected_loss_all_in_active=' + (this.projected_loss_all_in_active ? 'True' : 'False')];
    if (!isNone(this.projected_loss_all_in_target)) {
      out.push('wca_projected_loss_all_in_target=' + this.projected_loss_all_in_target.x + ',' +
        this.projected_loss_all_in_target.y);
    }
    return out;
  };

  function dataValue(data, key) {
    if (isNone(data)) return undefined;
    if (typeof data.has === 'function' && typeof data.get === 'function') {
      if (!data.has(key)) return undefined;
      return data.get(key);
    }
    return data[key];
  }

  function dataKeys(data) {
    if (isNone(data)) return [];
    if (typeof data.keys === 'function') return Array.from(data.keys());
    return Object.keys(data);
  }

  WCA.load_city_contestation_history_from_map_data = function (data) {
    this.city_contestation_history = new Map();
    var keys = dataKeys(data);
    for (var i = 0; i < keys.length; i++) {
      var key = String(keys[i]);
      if (key.indexOf('ot_city_') !== 0) continue;
      var coordsRaw = key.substring(8);
      var xy = coordsRaw.split('_');
      var city = this.map.GetTile(parseInt(xy[0], 10), parseInt(xy[1], 10));
      var raw = dataValue(data, keys[i]);
      var history = [];
      if (!isNone(raw) && String(raw).length > 0) {
        var parts = String(raw).split('|');
        for (var p = 0; p < parts.length; p++) history.push(CityOwnershipTransfer.deserialize(parts[p]));
      }
      this.city_contestation_history.set(city, history);
    }
  };

  WCA.load_projected_loss_all_in_state_from_map_data = function (data) {
    var rawActive = dataValue(data, 'wca_projected_loss_all_in_active');
    if (!isNone(rawActive)) {
      this.projected_loss_all_in_active = String(rawActive).toLowerCase().trim() === 'true';
    }
    var rawTarget = dataValue(data, 'wca_projected_loss_all_in_target');
    if (!isNone(rawTarget)) {
      var xy = String(rawTarget).split(',');
      this.projected_loss_all_in_target = this.map.GetTile(parseInt(xy[0], 10), parseInt(xy[1], 10));
    } else {
      this.projected_loss_all_in_target = null;
    }
  };

  WCA._refresh_verbose_logging_enabled = function () {
    this._verbose_logging_enabled = false;
  };

  WCA._format_attack_debug_tiles = function (tiles) {
    var lines = [];
    var arr = toArr(tiles);
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      lines.push(t.x + ',' + t.y + ':p' + playerOf(t) + ':a' + t.army + ':vis' + t.visible + ':disc' + t.discovered);
    }
    lines.sort();
    return lines.join(' | ');
  };

  /* ------------------------------------------------------------ analyze */

  WCA.analyze = function (targetPlayer, targetPlayerExpectedGeneralLocation, perfTimer) {
    var self = this;
    function event(fn) {
      if (isNone(perfTimer) || typeof perfTimer.begin_move_event !== 'function') return fn();
      return perfTimer.begin_move_event('WCA ' + fn.name);
    }

    this._refresh_verbose_logging_enabled();

    this.last_viable_win_conditions = new WinConditionSet(this.viable_win_conditions);
    this.viable_win_conditions = new WinConditionSet();
    this.contestable_cities = new Set();
    this.defend_cities = new Set();
    this.target_player = targetPlayer;
    this.target_player_location = targetPlayerExpectedGeneralLocation;
    this.best_target_player_attack_target = targetPlayerExpectedGeneralLocation;

    if (targetPlayer === -1) {
      this.viable_win_conditions.add(WinCondition.WinOnEconomy);
      return;
    }

    if (!isNone(this.all_in_plan)) this.viable_win_conditions.add(WinCondition.KillAllIn);
    if (this.projected_loss_all_in_active) this.viable_win_conditions.add(WinCondition.KillAllIn);

    this._get_rough_offense(perfTimer);

    var ableToContestEnemyCity = this.is_able_to_contest_enemy_city(perfTimer);
    if (ableToContestEnemyCity) {
      this.viable_win_conditions.add(WinCondition.ContestEnemyCity);
      this.is_contesting_cities = true;

      var enScores = this.opponent_tracker.get_current_team_scores_by_player(this.target_player);
      if (!isNone(enScores) && enScores.cityCount === 2) {
        this.viable_win_conditions.add(WinCondition.KillAllIn);
      }
    }

    if (this.is_able_to_win_or_recover_economically()) {
      this.viable_win_conditions.add(WinCondition.WinOnEconomy);
    } else {
      this.viable_win_conditions.add(WinCondition.KillAllIn);
    }

    if (this.is_winning_and_defending_economic_lead_wont_lose_economy()) {
      this.viable_win_conditions.add(WinCondition.DefendEconomicLead);
    }

    if (this.is_threat_of_loss_to_city_contest(perfTimer) &&
        this.viable_win_conditions.has(WinCondition.WinOnEconomy)) {
      this.viable_win_conditions.add(WinCondition.DefendContestedFriendlyCity);
    }

    void self;
    void event;
  };

  WCA.is_able_to_contest_enemy_city = function (perfTimer) {
    var map = this.map;
    var board = this.board_analysis;
    var ot = this.opponent_tracker;
    var inter = board.intergeneral_analysis;
    var rawADists = inter.aMap.raw;
    var rawBDists = inter.bMap.raw;

    var thisCycleTurn = cycleTurn(map);
    var remainingTurns = remainingCycleTurns(map);

    if (thisCycleTurn === 0) this.is_contesting_cities = false;

    var enTargetCities = this.city_analyzer.get_sorted_enemy_scores();
    var frArmyStats = ot.get_current_cycle_stats_by_player(map.player_index);
    var enArmyStats = ot.get_current_cycle_stats_by_player(this.target_player);

    if (isNone(enArmyStats)) {
      this.is_contesting_cities = false;
      return false;
    }

    var frScores = ot.get_current_team_scores_by_player(map.player_index);
    var enScores = ot.get_current_team_scores_by_player(this.target_player);

    if (isNone(enScores) || isNone(frScores)) {
      this.is_contesting_cities = false;
      return false;
    }
    if (enScores.cityCount === enArmyStats.players.length) {
      this.is_contesting_cities = false;
      return false;
    }

    var currentlyOwnedContestedEnCities = [];
    this.city_analyzer.owned_contested_cities.forEach(function (c) {
      if (!this.territories.is_tile_in_friendly_territory(c)) currentlyOwnedContestedEnCities.push(c);
    }, this);

    var ourCities = playerCities(map, map.player_index);
    for (var i = 0; i < ourCities.length; i++) {
      var city = ourCities[i];
      if (currentlyOwnedContestedEnCities.indexOf(city) >= 0) continue;
      if (rawBDists[city.tile_index] * 2 < rawADists[city.tile_index]) {
        currentlyOwnedContestedEnCities.push(city);
      }
    }

    var baseFrCities = frScores.cityCount - currentlyOwnedContestedEnCities.length;
    var baseEnCities = enScores.cityCount + currentlyOwnedContestedEnCities.length;

    var contestableCities = [];
    for (var t = 0; t < enTargetCities.length; t++) {
      var enCity = enTargetCities[t][0];
      if (!isTileOnTeamWith(map, enCity, this.target_player)) continue;
      if (rawBDists[enCity.tile_index] > 0.5 * rawADists[enCity.tile_index]) contestableCities.push(enCity);
    }
    if (contestableCities.length > 2) contestableCities = contestableCities.slice(0, 2);

    var baselineWinRequirement = 0.5;
    if (this.is_contesting_cities) baselineWinRequirement = 0.2;

    var cityCapsRequiredToReachWinningStatus = baselineWinRequirement +
      enScores.tileCount / 25 - frScores.tileCount / 25 + baseEnCities - baseFrCities;

    var cityCaps = currentlyOwnedContestedEnCities.length;
    var ableToContest = false;
    if (cityCaps >= cityCapsRequiredToReachWinningStatus) ableToContest = true;

    currentlyOwnedContestedEnCities.forEach(function (c) {
      this.contestable_cities.add(c);
    }, this);

    this.contestable_city_offense_plans = new Map();

    var ourOffense = 0;
    if (!isNone(this.our_best_attack_plan)) ourOffense = this.our_best_attack_plan.gathered_army;

    var baseAttackTime = Math.max(
      Math.min(inter.inter_general_distance, remainingTurns),
      this.recommended_offense_plan_turns
    );

    var self = this;

    if (contestableCities.length > 0) {
      for (var ci = 0; ci < contestableCities.length; ci++) {
        var targetCity = contestableCities[ci];
        var ourDistanceToCity = rawADists[targetCity.tile_index];
        var attackTime = Math.max(8, Math.min(baseAttackTime, ourDistanceToCity + 8));
        var enemyDistanceToCity = rawBDists[targetCity.tile_index];

        var ourOffensePlan = this.get_dynamic_turns_approximate_attack_plan_against(
          targetCity, attackTime, map.player_index);
        // 原版先记 ogAttackTime 再用 plan.length 覆盖 attackTime（ogAttackTime 之后没用到）。
        attackTime = planTurns(ourOffensePlan);
        ourOffensePlan.econValue = 0.0;

        var tiles = planTiles(ourOffensePlan);
        for (var pt = 0; pt < tiles.length; pt++) {
          var pTile = tiles[pt];
          var pPlayer = playerOf(pTile);
          if (ot._team_lookup_by_player[pPlayer] === enArmyStats.team) {
            ourOffensePlan.econValue += ITERATIVE_EXPANSION_EN_CAP_VAL;
          } else if (pPlayer === -1) {
            ourOffensePlan.econValue += 1.0;
          }
        }

        ourOffense = ourOffensePlan.gathered_army;

        var isFogPrediction = !targetCity.discovered && targetCity.isTempFogPrediction;
        if (isFogPrediction) ourOffense = Math.trunc(ourOffense * 0.9) - 6;

        ourOffensePlan.econValue += ot.estimate_city_contest_econ_value(
          map.player_index, this.target_player, ourOffense);

        this.contestable_city_offense_plans.set(targetCity, ourOffensePlan);

        var numRecentContests = this.get_city_contest_counts_by_player_team_in_last_turns(
          targetCity, this.target_player, 100);

        var rawDistPart = pyRound(0.45 * enemyDistanceToCity);
        var contestHistPart = pyRound(0.25 * enemyDistanceToCity * numRecentContests);
        var contestTimesDistance = rawDistPart + contestHistPart;
        var fogDefenseTurns = attackTime - contestTimesDistance;

        var enDefense = 0;
        if (fogDefenseTurns > 0) {
          enDefense = ot.get_approximate_fog_army_risk(this.target_player, null, fogDefenseTurns);
        }

        var visibleDef = this.get_dynamic_turns_visible_defense_against(
          [targetCity], fogDefenseTurns, this.target_player, undefined, ourOffense);
        var bestVisibleDefenseTurns = visibleDef[0];
        var bestVisibleDefenseValue = visibleDef[1];

        if (bestVisibleDefenseTurns > 0) {
          var visibleVt = bestVisibleDefenseValue / bestVisibleDefenseTurns;
          var fogVt = enDefense / attackTime;
          if (visibleVt > fogVt) {
            var remainingFogDefenseTurns = attackTime - bestVisibleDefenseTurns;
            var remainingFogDefense = ot.get_approximate_fog_army_risk(
              this.target_player, null, remainingFogDefenseTurns);
            enDefense = bestVisibleDefenseValue + remainingFogDefense;
          }
        }

        if (ourOffense > enDefense) {
          this.contestable_cities.add(targetCity);
          cityCaps += 1;
          if (cityCaps >= cityCapsRequiredToReachWinningStatus) ableToContest = true;
        } else {
          this.contestable_city_offense_plans.delete(targetCity);
        }
      }
    } else if (!isNone(this.target_player_location)) {
      var defenseExtraTurns = 0;
      if (!this.target_player_location.isGeneral) {
        var targetPlayerObj = map.players[this.target_player];
        var tilesWeHaveSeen = 0;
        var allTiles = targetPlayerObj.tiles || [];
        for (var ti = 0; ti < allTiles.length; ti++) {
          if (allTiles[ti].discovered) tilesWeHaveSeen += 1;
        }
        var tileCountUnseen = targetPlayerObj.tileCount - tilesWeHaveSeen;
        defenseExtraTurns = 1 + Math.trunc(tileCountUnseen / 2);
      }

      var fallbackFogTurns = baseAttackTime + defenseExtraTurns;
      var fallbackEnDefense = ot.get_approximate_fog_army_risk(this.target_player, 4, fallbackFogTurns);

      var fallbackVisible = this.get_dynamic_turns_visible_defense_against(
        [this.target_player_location], baseAttackTime, this.target_player, undefined, ourOffense);
      var fbVisTurns = fallbackVisible[0];
      var fbVisValue = fallbackVisible[1];

      if (fbVisTurns > 0) {
        var fbVisibleVt = fbVisValue / fbVisTurns;
        var fbFogVt = fallbackEnDefense / baseAttackTime;
        if (fbVisibleVt > fbFogVt) {
          var fbRemainingFogTurns = baseAttackTime - fbVisTurns;
          var fbRemainingFog = ot.get_approximate_fog_army_risk(this.target_player, 2, fbRemainingFogTurns);
          fallbackEnDefense = fbVisValue + fbRemainingFog;
        }
      }

      if (ourOffense > fallbackEnDefense) {
        this.contestable_cities.add(this.target_player_location);
        cityCaps += 1;
        if (cityCaps >= cityCapsRequiredToReachWinningStatus) ableToContest = true;
      }
    }

    this.is_contesting_cities = ableToContest;

    var bestAttackCity = null;
    var bestDist = Infinity;
    this.contestable_cities.forEach(function (c) {
      if (!c.isCity) return;
      if (!(rawBDists[c.tile_index] < rawADists[c.tile_index])) return;
      if (!(rawADists[c.tile_index] < inter.inter_general_distance)) return;
      if (rawADists[c.tile_index] < bestDist) {
        bestDist = rawADists[c.tile_index];
        bestAttackCity = c;
      }
    });

    this.best_target_player_attack_target = isNone(bestAttackCity)
      ? this.target_player_location
      : bestAttackCity;

    void self;
    void perfTimer;
    return ableToContest;
  };

  WCA.is_able_to_win_or_recover_economically = function () {
    var ot = this.opponent_tracker;
    var map = this.map;

    var frScoreMinus2 = ot.get_last_cycle_score_by_player(map.player_index, 0);
    var frScoreMinus1 = ot.get_last_cycle_score_by_player(map.player_index, 1);
    var enScoreMinus2 = ot.get_last_cycle_score_by_player(this.target_player, 0);
    var enScoreMinus1 = ot.get_last_cycle_score_by_player(this.target_player, 1);

    var frStatsMinus2 = ot.get_last_cycle_stats_by_player(map.player_index, 0);
    var frStatsMinus1 = ot.get_last_cycle_stats_by_player(map.player_index, 1);
    var enStatsMinus2 = ot.get_last_cycle_stats_by_player(this.target_player, 0);
    var enStatsMinus1 = ot.get_last_cycle_stats_by_player(this.target_player, 1);

    if (isNone(frScoreMinus2) || isNone(frScoreMinus1) || isNone(enScoreMinus2) || isNone(enScoreMinus1) ||
        isNone(frStatsMinus2) || isNone(frStatsMinus1) || isNone(enStatsMinus2) || isNone(enStatsMinus1)) {
      return true;
    }

    var losingByTwoCyclesAgo = this.get_economic_diff_against_target_player(2);
    var losingByOneCyclesAgo = this.get_economic_diff_against_target_player(1);

    if (losingByTwoCyclesAgo < -1 && losingByTwoCyclesAgo > losingByOneCyclesAgo + 1) return false;
    return true;
  };

  WCA.get_city_contest_counts_by_player_team_in_last_turns = function (city, player, last_turns) {
    if (isNone(last_turns)) last_turns = 100;
    var history = this.city_contestation_history.get(city);
    if (isNone(history) || history.length === 0) return 0;

    var teams = this.map.team_ids_by_player_index;
    var frTeam = teams[player];
    var stopTurn = this.map.turn - last_turns;
    var count = 0;

    for (var i = history.length - 1; i >= 0; i--) {
      var entry = history[i];
      if (entry.turn < stopTurn) break;
      if (teams[entry.player] === frTeam) count += 1;
    }
    return count;
  };

  WCA.get_city_contest_army_amounts_by_player_team_in_last_turns = function (city, player, last_turns) {
    if (isNone(last_turns)) last_turns = 100;
    var history = this.city_contestation_history.get(city);
    if (isNone(history) || history.length === 0) return 0;

    var teams = this.map.team_ids_by_player_index;
    var frTeam = teams[player];
    var stopTurn = this.map.turn - last_turns;
    var total = 0;

    for (var i = history.length - 1; i >= 0; i--) {
      var entry = history[i];
      if (entry.turn < stopTurn) break;
      if (teams[entry.player] === frTeam) total += entry.army;
    }
    return total;
  };

  WCA.is_winning_and_defending_economic_lead_wont_lose_economy = function () {
    return this.opponent_tracker.winning_on_economy(1.04, undefined, undefined, -10);
  };

  WCA.force_kill_all_in_if_projected_round_loss = function (bot, expansionPlan, enemyExpansionPlan,
    economyRatioRequired, armyRatioRequired, minimumEconomyGap) {
    if (isNone(economyRatioRequired)) economyRatioRequired = 0.90;
    if (isNone(armyRatioRequired)) armyRatioRequired = 0.90;
    if (isNone(minimumEconomyGap)) minimumEconomyGap = 10.0;

    if (this.target_player === -1) return false;
    var ot = this.opponent_tracker;
    var ourStats = ot.get_current_team_scores_by_player(this.map.player_index);
    var enemyStats = ot.get_current_team_scores_by_player(this.target_player);
    if (isNone(ourStats) || isNone(enemyStats)) return false;

    var cityValue = Math.trunc(remainingCycleTurns(this.map) / 2);

    var ourProjectedEconomy = ourStats.tileCount + ourStats.cityCount * cityValue;
    var enemyProjectedEconomy = enemyStats.tileCount + enemyStats.cityCount * cityValue;

    if (!isNone(expansionPlan)) ourProjectedEconomy += expansionPlan.cumulative_econ_value;
    if (!isNone(enemyExpansionPlan)) enemyProjectedEconomy += enemyExpansionPlan.cumulative_econ_value;

    var ourProjectedArmy = ourStats.standingArmy + ourProjectedEconomy;
    var enemyProjectedArmy = enemyStats.standingArmy + enemyProjectedEconomy;

    var projectedEconomyGap = enemyProjectedEconomy - ourProjectedEconomy;

    var economyLost = ourProjectedEconomy < enemyProjectedEconomy * economyRatioRequired &&
      projectedEconomyGap >= minimumEconomyGap;
    var armyLost = ourProjectedArmy < enemyProjectedArmy * armyRatioRequired;

    if (!economyLost || !armyLost) return false;

    var BotKillTiming = (EK.BotModules || {}).BotKillTiming;
    if (isNone(BotKillTiming) || typeof BotKillTiming.find_all_in_option !== 'function') return false;

    var allInPlan = BotKillTiming.find_all_in_option(bot);
    if (isNone(allInPlan)) return false;

    this.all_in_plan = allInPlan;
    this.viable_win_conditions = new WinConditionSet([WinCondition.KillAllIn]);
    this.projected_loss_all_in_active = true;
    this.projected_loss_all_in_target = allInPlan.tail.tile;

    bot.is_all_in_losing = true;
    bot.all_in_losing_counter = Math.max(bot.all_in_losing_counter || 0, 1);
    return true;
  };

  WCA.is_threat_of_loss_to_city_contest = function (perfTimer) {
    var ot = this.opponent_tracker;
    var map = this.map;
    var board = this.board_analysis;
    var inter = board.intergeneral_analysis;
    var rawADists = inter.aMap.raw;
    var rawBDists = inter.bMap.raw;

    var weAreSlightlyAhead = false;
    if (this.last_viable_win_conditions.has(WinCondition.DefendContestedFriendlyCity)) {
      weAreSlightlyAhead = ot.winning_on_economy(1.03, undefined, undefined, -4);
    } else {
      weAreSlightlyAhead = ot.winning_on_economy(1.1, undefined, undefined, -10);
    }

    var oldDefTurns = this.recommended_city_defense_plan_turns;
    this.recommended_city_defense_plan_turns = 0;

    var mostForwardCity = null;
    var mostForwardDist = inter.inter_general_distance - 4;
    var self = this;
    this.city_analyzer.player_city_scores.forEach(function (score, city) {
      var cityDist = self.get_tile_dist_to_enemy(city);
      if (cityDist < mostForwardDist) {
        mostForwardDist = cityDist;
        mostForwardCity = city;
      }
    });
    this.most_forward_defense_city = mostForwardCity;

    if (!weAreSlightlyAhead) return false;

    var sumArmyOnDefCities = 0;
    this.defend_cities.forEach(function (city) {
      sumArmyOnDefCities += city.army;
    });

    var fogRisk = ot.get_approximate_fog_army_risk(this.target_player, 5, 10);
    if (fogRisk < sumArmyOnDefCities) return false;

    var maxThreat = 0;
    var maxThreatTurns = 9;
    var analyzedCount = 0;

    var ourCities = playerCities(map, map.player_index).slice();
    ourCities.sort(function (a, b) {
      return rawBDists[a.tile_index] - rawBDists[b.tile_index];
    });

    for (var i = 0; i < ourCities.length; i++) {
      var city = ourCities[i];
      var isEnemySide = rawBDists[city.tile_index] * 1.2 < rawADists[city.tile_index];
      var isContested = this.was_city_recently_contested(city);
      if (!isEnemySide && !isContested) continue;
      if (!isContested) continue;

      analyzedCount += 1;
      if (analyzedCount > 4) break;

      var threatAllowedTurns = oldDefTurns - 1;
      if (threatAllowedTurns < 5) threatAllowedTurns = 20;

      var approxThreatRes = this.get_dynamic_turns_approximate_attack_against(
        city, threatAllowedTurns, this.target_player);
      var approxThreatTurns = approxThreatRes[0];
      var approxThreat = approxThreatRes[1];

      var approxDefRes = this.get_dynamic_turns_visible_defense_against(
        [city], threatAllowedTurns, map.player_index, undefined, approxThreat);
      var approxDef = approxDefRes[1];

      if (approxThreat > approxDef + city.army) {
        this.defend_cities.add(city);
        if (approxThreat - city.army > maxThreat) {
          maxThreat = approxThreat - city.army;
          maxThreatTurns = Math.max(1, approxThreatTurns);
        }
      }
    }

    var numRiskyCities = this.defend_cities.size;
    var sortOfWinningEconCurrently = ot.winning_on_economy(0.9);
    var wouldStillBeWinningIfLostRiskies = ot.winning_on_economy(1.0, undefined, undefined, -50 * numRiskyCities);

    this.recommended_city_defense_plan_turns = maxThreatTurns;

    var couldLose = numRiskyCities > 0 && sortOfWinningEconCurrently && !wouldStillBeWinningIfLostRiskies;
    void perfTimer;
    return couldLose;
  };

  /* ------------------------------------------------------------ 计划构造 */

  // 原版 Gather.knapsack_max_gather_with_values(map, tiles, turns, negativeTiles, **kwargs)
  WCA._knapsack_max_gather = function (tiles, turns, negativeTiles, asPlayer, opts) {
    opts = opts || {};
    var negs = new Set(negativeTiles || []);
    var tileArr = toArr(tiles);
    for (var i = 0; i < tileArr.length; i++) negs.add(tileArr[i]);

    return iterativeMaxGather(this.map, tileArr, turns, {
      searchingPlayer: asPlayer,
      negativeTiles: negs,
      priorityMatrix: null,
      distPriorityMap: this.board_analysis && this.board_analysis.intergeneral_analysis
        ? this.board_analysis.intergeneral_analysis.bMap
        : null,
      useTrueValueGathered: !!opts.useTrueValueGathered,
      includeGatherTreeNodesThatGatherNegative: !!opts.includeGatherTreeNodesThatGatherNegative,
      incrementBackward: !!opts.incrementBackward,
      fastMode: !!opts.fastMode,
      maxIterations: opts.maxIterations
    });
  };

  WCA.get_approximate_attack_against = function (tiles, inTurns, asPlayer, timeLimit, opts) {
    var plan = this.get_approximate_attack_plan_against(tiles, inTurns, asPlayer, timeLimit, opts);
    return plan.gathered_army;
  };

  WCA.get_approximate_attack_plan_against = function (tiles, inTurns, asPlayer, timeLimit, opts) {
    opts = opts || {};
    var map = this.map;
    var board = this.board_analysis;
    var ot = this.opponent_tracker;

    if (isNone(timeLimit)) timeLimit = 0.005;
    var forceFogRisk = !!opts.forceFogRisk;
    var fogPenaltyTurns = opts.fogPenaltyTurns || 0;
    var preferValuePerTurn = !!opts.preferValuePerTurn;
    var negativeTiles = new Set(opts.negativeTiles || []);

    var knap = this._knapsack_max_gather(tiles, inTurns - 1, negativeTiles, asPlayer, {
      includeGatherTreeNodesThatGatherNegative: true,
      incrementBackward: false,
      useTrueValueGathered: false,
      fastMode: true
    });

    var value = knap.value;
    var gatherNodes = knap.rootNodes;

    var useFog = !map.is_player_friendly(asPlayer) && !map.has_crystal_clear;

    var pruned = pruneMstToMaxArmyPerTurnWithValues(
      EK.GatherTreeNode.clone_nodes(gatherNodes), 1, asPlayer,
      EK.Map.get_teams_array(map), { additionalIncrement: 0 });

    var prunedGatherTurns = pruned[0];
    var prunedValue = pruned[1];
    var prunedGatherNodes = pruned[2];

    var bestValue = 0;
    var bestPlan = [];
    var bestFogRisk = 0;
    var bestTurns = 1;

    var gatheredFogRisk = 0;
    if (useFog) {
      gatheredFogRisk = this.get_additional_fog_gather_risk_for_gather_nodes(
        gatherNodes, asPlayer, inTurns, forceFogRisk, fogPenaltyTurns);
    }
    var gatherValWithRisk = value + gatheredFogRisk;
    if (gatherValWithRisk > bestValue) {
      bestValue = gatherValWithRisk;
      bestPlan = gatherNodes;
      bestFogRisk = gatheredFogRisk;
      bestTurns = knap.turns > 0 ? knap.turns : 1;
    }

    var prunedFogRisk = 0;
    if (useFog) {
      prunedFogRisk = this.get_additional_fog_gather_risk_for_gather_nodes(
        prunedGatherNodes, asPlayer, inTurns, forceFogRisk, fogPenaltyTurns);
    }
    var prunedValueWithRisk = prunedValue + prunedFogRisk;
    if (prunedValueWithRisk > bestValue) {
      bestValue = prunedValueWithRisk;
      bestPlan = prunedGatherNodes;
      bestFogRisk = prunedFogRisk;
      bestTurns = prunedGatherTurns > 0 ? prunedGatherTurns : 1;
    } else if (preferValuePerTurn && prunedGatherTurns > 0 &&
               prunedValueWithRisk / prunedGatherTurns > bestValue / bestTurns) {
      bestValue = prunedValueWithRisk;
      bestPlan = prunedGatherNodes;
      bestFogRisk = prunedFogRisk;
      bestTurns = prunedGatherTurns;
    }

    var maxAttack = null;
    if (useFog) {
      maxAttack = this.get_best_attack_path_from_fog_by_army_per_turn(tiles, asPlayer, inTurns, negativeTiles);
    } else {
      maxAttack = this.get_best_attack_path_from_anywhere_by_army_per_turn(tiles, asPlayer, inTurns, negativeTiles);
    }

    if (!isNone(maxAttack)) {
      var attackPathRiskVal = Math.trunc(maxAttack.value);
      var fakeGathNodes = [convertPathToTreeNodes(maxAttack, map, asPlayer)];
      if (!isNone(fakeGathNodes[0])) {
        if (attackPathRiskVal > bestValue ||
            (preferValuePerTurn && attackPathRiskVal / Math.max(1, maxAttack.length) > bestValue / bestTurns)) {
          bestValue = attackPathRiskVal;
          bestPlan = fakeGathNodes;
          bestTurns = Math.max(1, maxAttack.length);
        }

        if (useFog) {
          var pathFogRisk = this.get_additional_fog_gather_risk_for_gather_nodes(
            fakeGathNodes, asPlayer, inTurns, forceFogRisk, fogPenaltyTurns);
          var pathWithRisk = attackPathRiskVal + pathFogRisk;
          if ((preferValuePerTurn && pathWithRisk / inTurns > bestValue / bestTurns) ||
              (!preferValuePerTurn && pathWithRisk > bestValue)) {
            bestValue = pathWithRisk;
            bestPlan = fakeGathNodes;
            bestFogRisk = pathFogRisk;
            bestTurns = inTurns;
          }
        }
      }
    } else if (useFog && forceFogRisk) {
      var fogOnlyRisk = ot.get_approximate_fog_army_risk(asPlayer, null, inTurns - fogPenaltyTurns);
      if (fogOnlyRisk > bestValue) {
        bestValue = fogOnlyRisk;
        bestPlan = [];
        bestFogRisk = 0;
        bestTurns = inTurns;
      }
    }

    var plan = EK.GatherCapturePlan.build_from_root_nodes(
      map, bestPlan, negativeTiles, asPlayer,
      false, null, false, false, null, null, false);

    var fogTurns = bestTurns - planTurns(plan);
    if (fogTurns > 0) plan.include_additional_fog_gather(fogTurns, bestFogRisk);
    plan.gathered_army = bestValue;

    void timeLimit;
    return plan;
  };

  WCA.get_dynamic_turns_visible_defense_against = function (tiles, maxTurns, asPlayer, timeLimit, minArmy) {
    var plan = this.get_dynamic_turns_visible_defense_plan_against(tiles, maxTurns, asPlayer, timeLimit, minArmy);
    return [planTurns(plan), plan.gathered_army];
  };

  WCA.get_dynamic_turns_visible_defense_plan_against = function (tiles, maxTurns, asPlayer, timeLimit, minArmy) {
    var map = this.map;
    if (isNone(minArmy)) minArmy = 1;

    var negs = new Set();
    var ourTiles = (map.players[asPlayer] && map.players[asPlayer].tiles) || [];
    for (var i = 0; i < ourTiles.length; i++) {
      if (!ourTiles[i].visible) negs.add(ourTiles[i]);
    }

    var knap = this._knapsack_max_gather(tiles, maxTurns, negs, asPlayer, {
      includeGatherTreeNodesThatGatherNegative: false,
      useTrueValueGathered: true,
      fastMode: true
    });

    var value = knap.value;
    if (value > 0) {
      var pruned = pruneMstToMaxArmyPerTurnWithValues(
        EK.GatherTreeNode.clone_nodes(knap.rootNodes), minArmy, asPlayer,
        EK.Map.get_teams_array(map), { allowBranchPrune: false, additionalIncrement: 0 });

      var prunedNodes = pruned[2];

      var nodeArr = EK.GatherTreeNode.iterate_tree_nodes(prunedNodes);
      for (var n = 0; n < nodeArr.length; n++) {
        var node = nodeArr[n];
        if (isTileOnTeamWith(map, node.tile, asPlayer)) value += node.tile.army - 1;
      }

      var plan = EK.GatherCapturePlan.build_from_root_nodes(
        map, prunedNodes, negs, asPlayer,
        false, null, false, false, null, null, false);
      return plan;
    }

    void timeLimit;
    return emptyPlan(map);
  };

  WCA.get_dynamic_turns_approximate_attack_against = function (tile, maxTurns, asPlayer, timeLimit, negTiles, minTurns) {
    var plan = this.get_dynamic_turns_approximate_attack_plan_against(
      tile, maxTurns, asPlayer, timeLimit, negTiles, minTurns);
    return [planTurns(plan), plan.gathered_army];
  };

  WCA.get_dynamic_turns_approximate_attack_plan_against = function (tile, maxTurns, asPlayer, timeLimit, negativeTiles, minTurns) {
    var map = this.map;
    if (isNone(minTurns)) minTurns = 0;

    var curTiles = [tile];
    var knap = this._knapsack_max_gather(curTiles, maxTurns, negativeTiles, asPlayer, {
      includeGatherTreeNodesThatGatherNegative: false,
      useTrueValueGathered: true,
      fastMode: true
    });

    var attackVal = knap.value;
    var gatherNodes = knap.rootNodes;
    var playerHasFog = !map.is_player_on_team_with(map.player_index, asPlayer);

    var finalTurns = maxTurns;
    var finalAttack = Math.max(0, attackVal);
    var finalNodes = gatherNodes;
    var finalFogRisk = 0;

    if (attackVal > 0) {
      var pruned = pruneMstToMaxArmyPerTurnWithValues(
        EK.GatherTreeNode.clone_nodes(gatherNodes), 1, asPlayer,
        EK.Map.get_teams_array(map), { minTurns: minTurns, allowNegative: false, allowBranchPrune: false });

      var prunedTurns = pruned[0];
      var prunedValue = pruned[1];
      var prunedNodes = pruned[2];

      var pruneFogRisk = 0;
      if (playerHasFog) {
        pruneFogRisk = this.get_additional_fog_gather_risk_for_gather_nodes(
          prunedNodes, asPlayer, prunedTurns);
      }
      // 原版在这里把 fogRisk 加了两次（prunedValue += pruneFogRisk 之后又 += 一次），照抄。
      prunedValue += pruneFogRisk;
      var attackPruned = prunedValue + pruneFogRisk;

      if (prunedTurns > 0 && attackPruned / prunedTurns > attackVal / maxTurns) {
        finalTurns = prunedTurns;
        finalAttack = Math.max(0, attackPruned);
        finalNodes = prunedNodes;
        finalFogRisk = pruneFogRisk;
      }
    }

    var plan = EK.GatherCapturePlan.build_from_root_nodes(
      map, finalNodes, new Set(negativeTiles || []), asPlayer,
      false, null, false, false, null, null, false);

    var fogTurns = finalTurns - planTurns(plan);
    if (fogTurns > 0) plan.include_additional_fog_gather(fogTurns, finalFogRisk);
    plan.gathered_army = finalAttack;

    void timeLimit;
    return plan;
  };

  WCA.get_dynamic_approximate_attack_defense = function (tile, maxTurns, asPlayer, fromPlayer) {
    var res = this.get_dynamic_approximate_attack_defense_plans(tile, maxTurns, asPlayer, fromPlayer);
    return [planTurns(res[0]), res[0].gathered_army, res[1].gathered_army];
  };

  WCA.get_dynamic_approximate_attack_defense_plans = function (tile, maxTurns, asPlayer, fromPlayer) {
    var attackPlan = this.get_dynamic_turns_approximate_attack_plan_against(tile, maxTurns, fromPlayer);
    var defPlan = this.get_dynamic_turns_visible_defense_plan_against(
      [tile], maxTurns, asPlayer, undefined, attackPlan.gathered_army);
    return [attackPlan, defPlan];
  };

  WCA.is_city_forward_relative_to_central_point = function (city) {
    var board = this.board_analysis;
    var inter = board.intergeneral_analysis;
    var centralPoint = board.central_defense_point;
    if (isNone(centralPoint)) return false;
    return inter.bMap.raw[city.tile_index] < inter.bMap.raw[centralPoint.tile_index];
  };

  WCA.get_tile_dist_to_enemy = function (tile) {
    return this.board_analysis.intergeneral_analysis.bMap.raw[tile.tile_index];
  };

  WCA.get_additional_fog_gather_risk_for_gather_nodes = function (gatherNodes, asPlayer, inTurns,
    forceFogRisk, fogPenaltyTurns) {
    if (isNone(fogPenaltyTurns)) fogPenaltyTurns = 0;
    if (isNone(forceFogRisk)) forceFogRisk = false;

    var map = this.map;
    var ot = this.opponent_tracker;

    if (map.is_player_on_team_with(asPlayer, map.player_index)) return 0;

    var numFogTiles = 0;
    var gatheredFogTilesArmy = 0;
    var turnsUsed = 0;

    var nodes = toArr(gatherNodes);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.tile.visible) {
        numFogTiles += 1;
        if (isPlayerOnTeamWith(map, playerOf(n.tile), asPlayer)) gatheredFogTilesArmy += n.tile.army - 1;
      }
      turnsUsed += n.gatherTurns;
    }

    if (turnsUsed === 0 || numFogTiles === 0) return 0;

    var turnsLeft = inTurns - turnsUsed;
    var expectedArmyFromFog = ot.get_approximate_fog_army_risk(asPlayer, null, turnsLeft - fogPenaltyTurns) -
      gatheredFogTilesArmy;
    var distPenalty = Math.max(0, 8 - turnsLeft);

    if (numFogTiles > Math.trunc(inTurns / 7) + 1) {
      return Math.max(0, expectedArmyFromFog - distPenalty);
    }

    if (forceFogRisk) {
      if (numFogTiles > 0) return Math.max(0, expectedArmyFromFog - distPenalty);
      return Math.max(0, expectedArmyFromFog - 10 - distPenalty);
    }

    return 0;
  };

  WCA.get_economic_diff_against_target_player = function (cyclesAgo) {
    if (isNone(cyclesAgo)) cyclesAgo = 0;
    var ot = this.opponent_tracker;
    var map = this.map;

    var frStats = null;
    var enStats = null;
    var frScore = null;
    var enScore = null;

    if (cyclesAgo === 0) {
      frStats = ot.get_current_cycle_stats_by_player(map.player_index);
      enStats = ot.get_current_cycle_stats_by_player(this.target_player);
      frScore = ot.get_current_team_scores_by_player(map.player_index);
      enScore = ot.get_current_team_scores_by_player(this.target_player);
    } else {
      frStats = ot.get_last_cycle_stats_by_player(map.player_index, cyclesAgo - 1);
      enStats = ot.get_last_cycle_stats_by_player(this.target_player, cyclesAgo - 1);
      frScore = ot.get_last_cycle_score_by_player(map.player_index, cyclesAgo - 1);
      enScore = ot.get_last_cycle_score_by_player(this.target_player, cyclesAgo - 1);
    }

    if (isNone(frStats) || isNone(enStats) || isNone(frScore) || isNone(enScore)) return 0;

    var frEcon = frScore.tileCount + (frScore.cityCount - frStats.cities_gained) * 25;
    var enEcon = enScore.tileCount + (enScore.cityCount - enStats.cities_gained) * 25;
    return frEcon - enEcon;
  };

  WCA.get_best_attack_path_from_fog_by_army_per_turn = function (tiles, asPlayer, inTurns, negativeTiles) {
    return this._get_best_attack_path_by_army_per_turn(tiles, asPlayer, inTurns, negativeTiles, true);
  };

  WCA.get_best_attack_path_from_anywhere_by_army_per_turn = function (tiles, asPlayer, inTurns, negativeTiles) {
    return this._get_best_attack_path_by_army_per_turn(tiles, asPlayer, inTurns, negativeTiles, false);
  };

  WCA._get_best_attack_path_by_army_per_turn = function (tiles, asPlayer, inTurns, negativeTiles, fogOnly) {
    var map = this.map;
    var board = this.board_analysis;

    var negs = new Set(negativeTiles || []);
    var tileArr = toArr(tiles);
    for (var i = 0; i < tileArr.length; i++) negs.add(tileArr[i]);

    var flankMatrix = board.flankable_fog_area_matrix || null;

    function valueFunc(tile, prioObj) {
      var depth = prioObj[0];
      var negArmySum = prioObj[1];
      if (fogOnly) {
        if (isNone(flankMatrix) || !flankMatrix.has(tile)) return null;
        if (tile.visible) return null;
        if (playerOf(tile) !== asPlayer) return null;
      }
      if (depth === 0) return null;
      if (negArmySum > 0) return -(negArmySum);
      return (-negArmySum) / depth;
    }

    function priorityFunc(nextTile, prioObj) {
      var depth = prioObj[0];
      var negArmySum = prioObj[1];
      if (!negs.has(nextTile) && nextTile.visible) {
        if (isPlayerOnTeamWith(map, playerOf(nextTile), asPlayer)) negArmySum -= nextTile.army;
        else negArmySum += nextTile.army;
      }
      negArmySum += 1;
      return [depth + 1, negArmySum];
    }

    // 非默认 priorityFunc 必须走字典形态的 startTiles（原版 startTiles = {tile: ((0,0), 0)}），
    // 传数组会被 search.js 直接抛错。
    var startTiles = new Map();
    for (var s = 0; s < tileArr.length; s++) startTiles.set(tileArr[s], [[0, 0], 0]);

    var path = EK.search.breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxTurns: inTurns,
      maxDepth: inTurns,
      noNeutralCities: true,
      negativeTiles: negs,
      searchingPlayer: asPlayer,
      priorityFunc: priorityFunc,
      ignoreStartTile: false
    });

    if (isNone(path)) return null;
    return typeof path.get_reversed === 'function' ? path.get_reversed() : path;
  };

  WCA.calculate_basic_defense_against_general = function (defensiveSpanningTree, general, sketchiestFlankPath, timeLimit) {
    if (isNone(timeLimit)) timeLimit = 0.05;
    var map = this.map;
    var inter = this.board_analysis.intergeneral_analysis;

    this.basic_defense_general_moves = 0;
    this.basic_defense_general_turns = 0;
    this.basic_defense_general_army = 0;
    this.basic_defense_general_tiles = new Set();

    var tree = toArr(defensiveSpanningTree);
    if (tree.length === 0) return;

    if (!isNone(sketchiestFlankPath) && !isNone(sketchiestFlankPath.tail)) {
      this.basic_defense_general_moves = inter.aMap.raw[sketchiestFlankPath.tail.tile.tile_index];
    } else {
      this.basic_defense_general_moves = Math.max(5, Math.trunc(inter.inter_general_distance / 3));
    }

    var maxDefenseMoves = Math.min(this.basic_defense_general_moves, 25);
    if (maxDefenseMoves <= 0) return;

    var plan = this.get_dynamic_turns_visible_defense_plan_against(
      [general], maxDefenseMoves, map.player_index, timeLimit, 1);

    this.basic_defense_general_turns = planTurns(plan);
    this.basic_defense_general_army = plan.gathered_army;
    this.basic_defense_general_tiles = plan.tileSet ? new Set(plan.tileSet) : new Set();
  };

  WCA.calculate_basic_defense_against_forward_spanning_tree = function (defensiveSpanningTree, forwardPoint, timeLimit) {
    if (isNone(timeLimit)) timeLimit = 0.05;
    var map = this.map;
    var inter = this.board_analysis.intergeneral_analysis;

    this.basic_defense_forward_moves = 0;
    this.basic_defense_forward_turns = 0;
    this.basic_defense_forward_army = 0;
    this.basic_defense_forward_tiles = new Set();

    var tree = toArr(defensiveSpanningTree);
    if (tree.length === 0) return;
    if (isNone(forwardPoint)) return;

    this.basic_defense_forward_moves = inter.aMap.raw[forwardPoint.tile_index];
    var maxDefenseMoves = Math.min(this.basic_defense_forward_moves, 25);
    if (maxDefenseMoves <= 0) return;

    var plan = this.get_dynamic_turns_visible_defense_plan_against(
      [forwardPoint], maxDefenseMoves, map.player_index, timeLimit, 1);

    this.basic_defense_forward_turns = planTurns(plan);
    this.basic_defense_forward_army = plan.gathered_army;
    this.basic_defense_forward_tiles = plan.tileSet ? new Set(plan.tileSet) : new Set();
  };

  WCA._get_rough_offense = function (perfTimer) {
    var map = this.map;
    var board = this.board_analysis;

    var attackTime = Math.max(10, Math.min(remainingCycleTurns(map),
      board.inter_general_distance + 5));
    this.our_best_attack_plan = null;

    if (!isNone(this.target_player_location) && !this.target_player_location.isObstacle) {
      this.our_best_attack_plan = this.get_dynamic_turns_approximate_attack_plan_against(
        this.target_player_location, attackTime, map.player_index);
      attackTime = planGatherTurns(this.our_best_attack_plan);
    }

    this.recommended_offense_plan_turns = attackTime;
    void perfTimer;
  };

  EK.WinConditionAnalyzer = WinConditionAnalyzer;

  EK.WinCondition = WinCondition;
  EK.WinConditionNames = WIN_CONDITION_NAMES;
  EK.WIN_CONDITION_BY_NAME = WIN_CONDITION_BY_NAME;
  EK.CityOwnershipTransfer = CityOwnershipTransfer;

  // 内部工具也给出去，ekdiff/oracle 脚本要用同一条路径。
  EK.winConditionInternals = {
    pyRound: pyRound,
    sortedTiles: sortedTiles,
    playerOf: playerOf,
    isPlayerOnTeamWith: isPlayerOnTeamWith,
    pruneMstToTurnsWithValues: pruneMstToTurnsWithValues,
    pruneMstToMaxArmyPerTurnWithValues: pruneMstToMaxArmyPerTurnWithValues,
    iterativeMaxGather: iterativeMaxGather,
    convertPathToTreeNodes: convertPathToTreeNodes,
    remainingCycleTurns: remainingCycleTurns,
    cycleTurn: cycleTurn
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

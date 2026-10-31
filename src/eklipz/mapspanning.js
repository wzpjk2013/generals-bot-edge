/*
 * MapSpanning —— 移植自 Human.exe / generals-bot-cs 的 Algorithms/MapSpanningUtils.py
 *   原版：E:\akcoco6de\_research\generals-bot-cs\Algorithms\MapSpanningUtils.py（482 行）
 *
 * 为什么需要这个文件：BotDefense._get_defensive_spanning_tree 与
 * BotCityOps 的若干「把若干必需格连成一片」的地方调的都是这里的
 * get_max_gather_spanning_tree_set_from_tile_lists，之前 JS 侧零移植，
 * defensive_spanning_tree 恒为空 Set（见 _research/m3-regression.md 根因 B）。
 *
 * 与 EK.Gather.get_spanning_tree_set_from_tile_lists_with_cost_per 的关系：
 *   那个就是本文件同名函数（py:95-189）的移植，已经过 oracle 对齐，所以这里
 *   直接复用、不复制代码；本文件只补 py:237-450 的「最大集兵版」以及 py:453-482
 *   的两个树尾裁剪工具。两者是兄弟关系（max_gather 版内部先调一次非 max 版拿
 *   bare minimum），不是父子。
 *
 * 刻意不移植（都是死代码或纯日志）：
 *   - TileNode / TileGraph / get_map_as_graph：py 自己标了 "Unused"，全仓库无调用点。
 *   - logbook 全部日志（LOG_VERBOSE 分支）：不影响任何一个返回值。
 *   - time.perf_counter 计时：只用于日志。
 *
 * 参数命名：lead 要求导出形状固定为
 *   (map, startTiles, requiredTiles, asPlayer, valueFunc, opts)
 * 对应 py 的位置参数是
 *   (map, requiredTiles, bannedSet,      searchingPlayer, gatherPrioMatrix, ...)
 * 即 startTiles 才是 py 的 requiredTiles（既是要连起来的必需格，也是 BFS 的起点集），
 * 第二个参数是 bannedSet。opts 里可给 negativeTiles / maxTurns / require_min_distance。
 * valueFunc 两种都吃：MapMatrix（读 .raw[tile_index]）或 function(tile)->number。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var ms = (EK.MapSpanning = EK.MapSpanning || {});

  // Tile 集合的迭代序统一按 tile_index 升序：Python 侧 Tile.__hash__ = tile_index，
  // set 的遍历序基本就是索引序，乱序遍历会让 BFS 起点的堆插入序漂移。
  function sortedByTileIndex(iterable) {
    var arr = Array.isArray(iterable) ? iterable.slice() : Array.from(iterable);
    arr.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    return arr;
  }

  function toArrayInOrder(iterable) {
    if (Array.isArray(iterable)) return iterable.slice();
    return sortedByTileIndex(iterable);
  }

  // py 里 gatherPrioMatrix 只被当成「按 tile_index 取一个 float」的东西用；
  // 但 defense.js 那边可能会直接传函数，两种都接住，省得调用点各自适配。
  function makePrioLookup(valueFunc) {
    if (!valueFunc) return null;
    if (typeof valueFunc === 'function') {
      return function (tile) {
        return valueFunc(tile);
      };
    }
    // MapMatrix / 裸数组 / Float64Array 都能按索引取；少了这个分支，typed array
    // 会被静默当成 0，优先级矩阵整场失效而外部看不出任何报错。
    var raw =
      valueFunc.raw ||
      valueFunc.matrix ||
      (typeof valueFunc.length === 'number' && typeof valueFunc !== 'string' ? valueFunc : null);
    if (raw) {
      return function (tile) {
        var v = raw[tile.tile_index];
        return v === undefined || v === null ? 0.0 : v;
      };
    }
    return function () {
      return 0.0;
    };
  }

  /* --------------------------------------------------- py:63 get_spanning_tree_from_tile_lists */

  function get_spanning_tree_from_tile_lists(map, requiredTiles, bannedTiles) {
    var res = EK.Gather.get_spanning_tree_set_from_tile_lists_with_cost_per(map, requiredTiles, bannedTiles);
    return [Array.from(res[0]), res[1]];
  }

  /* --------------------------------------------------- py:81 get_spanning_tree_set_from_tile_lists */

  function get_spanning_tree_set_from_tile_lists(map, requiredTiles, bannedSet) {
    var res = EK.Gather.get_spanning_tree_set_from_tile_lists_with_cost_per(map, requiredTiles, bannedSet);
    return [res[0], res[1]];
  }

  /* --------------------------------------------------- py:408 _include_all_adj_required_max_gather */

  /*
   * py 用 `q = [node]` + `while q: q.pop()`（后进先出），所以是深度优先地把
   * 「相邻且仍然缺失」的必需格一路吞进来。注意它跟非 max 版不同：非 max 版会往
   * missingIncludedSet 里塞 costPer，这里塞的是 usefulStartSet 的默认优先级对象。
   */
  function _include_all_adj_required_max_gather(node, includedSet, usefulStartSet, missingIncludedSet, prioLookup, baseTuple, fromNode) {
    var q = [node];
    while (q.length > 0) {
      var tile = q.pop();
      if (includedSet.has(tile)) continue;

      includedSet.add(tile);
      // py 原注释掉的 usefulStartSet.add(tile) 说明它想用 dict 存默认优先级，
      // 这里必须用 dict 语义（Map），因为 BFS 的 startTiles 分支要读 [prioObj, distance]。
      usefulStartSet.set(tile, baseTuple);

      missingIncludedSet.delete(tile);

      var movable = tile.movable;
      for (var m = 0; m < movable.length; m++) {
        var adj = movable[m];
        if (!missingIncludedSet.has(adj)) continue;
        q.push(adj);
      }
    }
  }

  /* --------------------------------------------------- py:237 get_max_gather_spanning_tree_set_from_tile_lists */

  /*
   * 返回 [includedSet, missingIncluded]。includedSet 里的每个格子都在给下来的
   * maxTurns 内可以被连成一片（只算「摆兵步数」，不是真实行军耗时），
   * missingIncluded 是连不上／被 maxTurns 挤掉的必需格。
   *
   * opts:
   *   negativeTiles          py 同名参数；缺省 = missingIncluded
   *   maxTurns               默认 1000
   *   require_min_distance   true 时把 maxTurns 压成 bareMinTurns（只走最省路径）
   *   searchingPlayer        仅当 asPlayer 为 -1/undefined 时才有意义
   */
  function get_max_gather_spanning_tree_set_from_tile_lists(map, startTiles, requiredTiles, asPlayer, valueFunc, opts) {
    opts = opts || {};

    var requiredList = toArrayInOrder(startTiles || []);
    var banned = requiredTiles instanceof Set ? requiredTiles : new Set(requiredTiles || []);
    var negativeTiles = opts.negativeTiles === undefined ? null : opts.negativeTiles;
    var maxTurns = opts.maxTurns === undefined || opts.maxTurns === null ? 1000 : opts.maxTurns;
    var searchingPlayer = asPlayer === undefined || asPlayer === null ? -1 : asPlayer;
    var requireMinDistance = !!opts.require_min_distance;

    var prioLookup = makePrioLookup(valueFunc);

    // 先用「不做任何优先级优化」的版本拿到 bare minimum 连接集与每个必需格到
    // 连接集的距离。bareMinTurns 就是这棵最小树的大小，作为 maxTurns 的下界。
    var minRes = EK.Gather.get_spanning_tree_set_from_tile_lists_with_cost_per(map, requiredList, banned);
    var minIncluded = minRes[0];
    var costPer = minRes[2];

    var bareMinTurns = minIncluded.size;
    if (requireMinDistance) maxTurns = bareMinTurns;
    var excessTurns = maxTurns - bareMinTurns;

    var includedSet = new Set();
    var missingIncluded = new Set(requiredList);

    // 必需格本身不该拿「集兵价值」，否则会优先绕去高价值必需格而不是去连接它们；
    // 把它们一律当负值，目标就只剩「中途挑高价值格」。
    if (negativeTiles === null || negativeTiles === undefined) {
      negativeTiles = new Set(missingIncluded);
    } else {
      negativeTiles = new Set(negativeTiles);
      missingIncluded.forEach(function (t) {
        negativeTiles.add(t);
      });
    }

    if (searchingPlayer === -1) searchingPlayer = map.player_index;

    for (var ri = 0; ri < requiredList.length; ri++) banned.delete(requiredList[ri]);

    if (requiredList.length === 0) return [includedSet, missingIncluded];

    var baseTuple = [[-100000, 0, 0.0, 0], 0];

    var root = requiredList[0];
    // py: `usefulStartSet = {t: baseTuple for t in includedSet}`，此刻 includedSet 还是空的，
    // 所以这里就是空的 Map，不用复制。
    var usefulStartSet = new Map();

    _include_all_adj_required_max_gather(root, includedSet, usefulStartSet, missingIncluded, prioLookup, baseTuple, null);

    var findFunc = function (t, prio) {
      return missingIncluded.has(t);
    };

    var iter = 0;
    while (missingIncluded.size > 0) {
      iter++;

      var expectedMinRemaining = 0;
      var closestDist = maxTurns;
      var closest = null;
      // 这里只需要两个聚合值，遍历序不影响结果（closest 仅用于日志，py 也一样）。
      missingIncluded.forEach(function (tile) {
        var cost = costPer.get(tile);
        if (cost === undefined || cost === null) cost = 0;
        expectedMinRemaining += cost;
        if (cost > 1 && cost < closestDist) {
          closestDist = cost;
          closest = tile;
        }
      });

      var costSoFar = includedSet.size;
      var excessTurnsLeft = maxTurns - (costSoFar + expectedMinRemaining);

      // 闭包捕获本轮的两个量：excessTurnsLeft 决定「还有多少富余步数可以绕路去
      // 吃高价值格」，所以每轮都要重算，不能提到循环外。
      var prioFunc = (function (excessTurnsLeftLocal) {
        return function (tile, prioObj) {
          var cost = prioObj[0];
          var dist = prioObj[1];
          var negGatherPoints = prioObj[2];
          var negGather = prioObj[3];

          if (!negativeTiles.has(tile)) {
            var prioVal = prioLookup === null ? 0.0 : prioLookup(tile);
            if (map.is_tile_on_team_with(tile, searchingPlayer)) {
              negGather -= tile.army - 1;
              negGatherPoints -= tile.army - 1;
              negGatherPoints -= prioVal;
            } else {
              negGather += tile.army + 1;
              negGatherPoints += 1;
              negGatherPoints -= prioVal;
            }
          }

          var newCost = dist + 1;
          var costWeight = excessTurnsLeftLocal - (dist + 1);
          if (costWeight > 0 && negGatherPoints < 0) {
            var excessCostRat = costWeight / excessTurnsLeftLocal;
            // costDivisor 在 py 里算出来又从没用过，删掉不影响行为（保留注释说明省得以后误以为漏抄）。
            newCost -= costWeight * excessCostRat;
          }

          return [newCost, dist + 1, negGatherPoints, negGather];
        };
      })(excessTurnsLeft);

      var path = EK.search.breadth_first_dynamic(map, usefulStartSet, findFunc, {
        negativeTiles: negativeTiles,
        skipTiles: banned,
        priorityFunc: prioFunc,
        noLog: true
      });

      if (!path) {
        // 中立城在无视野时不可通行，会导致整条链断掉；原版退一步允许穿过中立城。
        path = EK.search.breadth_first_dynamic(map, usefulStartSet, findFunc, {
          negativeTiles: negativeTiles,
          skipTiles: banned,
          priorityFunc: prioFunc,
          noNeutralCities: false,
          noLog: true
        });
        if (!path) break;
      }

      var lastTile = null;
      var tl = path.tileList;
      for (var k = 0; k < tl.length; k++) {
        _include_all_adj_required_max_gather(tl[k], includedSet, usefulStartSet, missingIncluded, prioLookup, baseTuple, lastTile);
        lastTile = tl[k];
      }
      // py 在 max 版里**不**记录 costPer[lastTile]（非 max 版才记），照抄。
    }

    return [includedSet, missingIncluded];
  }

  /* --------------------------------------------------- py:453 / py:474 树尾裁剪 */

  function is_end_node_in_spanning_tree(n, nodes) {
    var num = 0;
    var movable = n.movable;
    for (var m = 0; m < movable.length; m++) {
      if (nodes.has(movable[m])) {
        num++;
        if (num > 1) return false;
      }
    }
    return true;
  }

  function trim_spanning_tree_ends_as_new_set(toTrim, trimDepth, minRemainingCount) {
    var remainingNodes = new Set(toTrim);
    for (var iteration = 0; iteration < trimDepth; iteration++) {
      var ends = [];
      remainingNodes.forEach(function (n) {
        if (is_end_node_in_spanning_tree(n, remainingNodes)) ends.push(n);
      });
      for (var i = 0; i < ends.length; i++) {
        remainingNodes.delete(ends[i]);
        if (remainingNodes.size === minRemainingCount) return remainingNodes;
      }
    }
    return remainingNodes;
  }

  /* ---------------------------------------------------------------- 导出 */

  ms.sortedByTileIndex = sortedByTileIndex;
  ms.get_spanning_tree_from_tile_lists = get_spanning_tree_from_tile_lists;
  ms.get_spanning_tree_set_from_tile_lists = get_spanning_tree_set_from_tile_lists;
  ms.get_max_gather_spanning_tree_set_from_tile_lists = get_max_gather_spanning_tree_set_from_tile_lists;
  ms._include_all_adj_required_max_gather = _include_all_adj_required_max_gather;
  ms.trim_spanning_tree_ends_as_new_set = trim_spanning_tree_ends_as_new_set;
  ms.is_end_node_in_spanning_tree = is_end_node_in_spanning_tree;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

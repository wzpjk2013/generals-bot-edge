/*
 * gathermax.js —— Gather 背包迭代族（三条入口）的 JS 移植。
 *
 * 原版（全部在 E:\akcoco6de\_research\generals-bot-cs\Gather\）：
 *   GatherMaxIterativeSet.py   2424 行  → EK.GatherMaxSet.gather_max_set_iterative_plan
 *   GatherMaxIterative.py      1638 行  → EK.GatherMaxIterative.knapsack_max_gather
 *   GatherDepthIterative.py    1681 行  → EK.GatherDepthIterative.knapsack_depth_gather
 * 这三个正是本仓 gatherops.js:1130-1137 与 botmain.js:1721 现在打 noteMissing 降级掉的调用点。
 *
 * 算法的四层（以 Set 版为准，另两版同构）：
 *   原理——把「用有限的回合数，从一组起点出发，吃掉尽可能多的兵力/地形」看成一个
 *         带回合预算的连通子图问题。原版不求解精确最优，而是「反复做局部最优搜索 + 剪枝到
 *         更少的格子 + 重连回连通」，迭代逼近。
 *   组成——(1) 子问题：给定起点字典，用动态 BFS 找「每回合收益最大」的路径集合，再用分组背包
 *         在回合预算里挑一组（同一起点组内互斥）；(2) 剪枝族：按价值从低到高把格子剪掉，
 *         同时保证根节点连通（朴素剪 / 割点剪 / 启发式割点剪）；(3) 重连族：剪过头之后
 *         用 Steiner / 动态森林 / PCST 三条路之一把散块重新连起来；(4) 主循环把 (1)(2)(3)
 *         每轮剪掉 maxPerIteration 回合的量，记录历史最优。
 *   流程——gather_max_set_iterative_plan → _knapsack_max_set_gather_iterative_prune（主循环）
 *         → 每轮 _get_sub_knapsack_max_set_gather（BFS + 背包）→ prune_set_to_turns_and_reconnect_with_values
 *         → 收尾 Gather.convert_contiguous_tile_tree_to_gather_capture_plan 建 GatherCapturePlan。
 *   参数——背包值放大 1000 倍（`factor`），权重是 path.length（回合数）；
 *         `_get_sub_knapsack_max_set_gather` 在 `len(startTilesDict) < remainingTurns // 10` 时
 *         退化成单路径 BFS（起手回合用得着）；每次迭代 maxPerIteration 从
 *         `max(min(4, fullTurns//2), fullTurns//2 - 1)` 起步再逐步收缩。
 *
 * 【已知偏差，必须知道的一条】
 *   `prune_set_to_turns_and_reconnect_with_values` 的三条重连分支里，default 分支走
 *   `GatherSteiner.get_prize_collecting_gather_mapmatrix_single_iteration`，原版最后一步是
 *   `pcst_fast(...)`（C++ 扩展，Goemans-Williamson + strong pruning，内部走 max-flow，
 *   平局顺序无法从外部复现）。本仓没有等价实现，这里用**自写的贪心 prize-collecting**
 *   顶替（`_pcst_greedy_solve`），但建图部分（prize 缩放、边 cost、rootTiles 补 0 成本边、
 *   顶点/边 append 次序）完全照抄原版，root 也固定取第一个 rootTile，所以当最优解唯一时
 *   结果与原版一致；不唯一时可能挑到另一个同样优的集合。详见 _reconnect_fast_pcst。
 *
 * 【其它近似】
 *   1) 原版遍历 Python set 的地方（toPrune / rootTiles / reconnectedSubset 等）顺序由 hash 表
 *      决定。rootTiles 用 `pySetOrder()` 复刻 CPython 表布局（hash(Tile)=tile_index、
 *      perturb 探测、装载率过 3/5 扩容），其余集合一律按 tile_index 升序；
 *      只在「价值完全相等、需要靠 set 顺序决胜负」时可能与原版不同。
 *   2) liveRenderer / viewInfo / logbook 全部删掉（原版这些分支在真实对局里都不写数据）。
 *   3) `_debug_print_diff_between_start_dict_and_tree_nodes` 只打日志，不搬。
 *   4) GatherMaxIterative / GatherDepthIterative 走的是「树节点」版，不复用 Set 版的剪枝族，
 *      但它们没有 prune/reconnect 那条 pcst 依赖，所以能逐行对着移植。
 *   5) 时间预算默认关掉：`cutoffTime` 不传就是 `Infinity`，决策完全不看时钟（同一局面必然
 *      同一结果）；只有显式传一个「epoch 秒」时间戳才会按原版超时收缩/跳出。
 *      主循环本身由 `lastPrunedTo < fullTurns` 兜底，天然有界；depth 版另有与原版相同的
 *      `itr.value > 250` 死循环护栏。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  /* 统一时钟取值：clock.js 装了就用它（可被 GB_EK_DET 钉死），没装回退真实时钟。
   * 为什么不直接写 EK.clock：工具脚本加载模块的清单各不相同，写死依赖会在没加载 clock.js 的场景下直接抛。 */
  function clockNowMs() { return EK.clock ? EK.clock.nowMs() : Date.now(); }
  function clockNowSec() { return EK.clock ? EK.clock.nowSec() : Date.now() / 1000; }

  var GatherMaxSet = (EK.GatherMaxSet = EK.GatherMaxSet || {});
  var GatherMaxIterative = (EK.GatherMaxIterative = EK.GatherMaxIterative || {});
  var GatherDepthIterative = (EK.GatherDepthIterative = EK.GatherDepthIterative || {});

  // ---------------------------------------------------------------------------
  // 依赖解析：本仓 eklipz 各文件靠加载顺序互相挂 EK，谁先加载谁在，所以一律调用点解析。
  // ---------------------------------------------------------------------------
  function need(name, value) {
    if (value === undefined || value === null) {
      throw new Error('gathermax.js 需要 ' + name + '，请检查模块加载顺序（tile → map → mapmatrix → path → search → fastdisjointset → gather → gathermax）');
    }
    return value;
  }
  // 原版 MapBase.get_teams_array(map)；本仓挂在 EK.Map 静态方法上（botmain.js:532 也这么取）
  function teamsOf(map) {
    if (typeof map.get_teams_array === 'function') return map.get_teams_array(map);
    if (EK.Map && typeof EK.Map.get_teams_array === 'function') return EK.Map.get_teams_array(map);
    throw new Error('gathermax.js 需要 EK.Map.get_teams_array');
  }

  function searchMod() { return need('EK.search', EK.search); }
  function gatherMod() { return need('EK.Gather', EK.Gather); }
  function mapMatrixCtor() { return need('EK.MapMatrix', EK.MapMatrix); }

  // ---------------------------------------------------------------------------
  // Python 元组比较 / heapq 语义
  // 原版把 (值, Tile) 塞进 heapq。Python 的元组比较是「先 == 再 <」：Tile.__eq__ 比 tile_index，
  // Tile.__lt__ 只比 army。所以两个 army 相等的 Tile 互不小于也不相等 —— 堆里就靠插入顺序兜底。
  // 想复刻这个行为，比较函数必须区分「==」和「<」，不能只写一个 cmp。
  // ---------------------------------------------------------------------------
  function isTileObj(v) {
    return v !== null && typeof v === 'object' && v.tile_index !== undefined;
  }

  function pyEq(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!pyEq(a[i], b[i])) return false;
      return true;
    }
    if (isTileObj(a) && isTileObj(b)) return a.tile_index === b.tile_index;
    if (a === null || a === undefined) return b === null || b === undefined;
    return a === b;
  }

  function pyLess(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) {
        if (pyEq(a[i], b[i])) continue;
        return pyLess(a[i], b[i]);
      }
      return a.length < b.length;
    }
    if (isTileObj(a) && isTileObj(b)) {
      if (a.tile_index === b.tile_index) return false;
      return a.army < b.army;
    }
    if (a === null || a === undefined) return !(b === null || b === undefined);
    if (b === null || b === undefined) return false;
    return a < b;
  }

  // CPython heapq：_siftup 里「左孩子不小于右孩子时选右孩子」，平局偏向右边。
  function heapPush(heap, item) {
    var i = heap.length;
    heap.push(item);
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (!pyLess(item, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  }

  function heapPop(heap) {
    var last = heap.pop();
    if (heap.length === 0) return last;
    var ret = heap[0];
    var n = heap.length;
    var i = 0;
    for (;;) {
      var child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && !pyLess(heap[child], heap[child + 1])) child += 1;
      if (!pyLess(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return ret;
  }

  // 原版 `sum(1 for x in ...)` 之类的小工具；不要在 Set 上用 EK.search.count（它只按 length 走）。
  function countWhere(arr, fn) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n += 1;
    return n;
  }

  function sumOf(arr, fn) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += fn(arr[i]);
    return s;
  }

  // Python set 的迭代顺序不可复现；这里统一升序，见文件头「近似 1」。返回新数组，不改入参。
  function tilesAsc(tiles) {
    var out = [];
    if (tiles === null || tiles === undefined) return out;
    if (Array.isArray(tiles)) out = tiles.slice();
    else if (typeof tiles.forEach === 'function' && typeof tiles.has === 'function') tiles.forEach(function (t) { out.push(t); });
    else out = tiles.slice ? tiles.slice() : Array.prototype.slice.call(tiles);
    out.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return out;
  }

  function mapKeysAsc(dict) {
    var out = [];
    dict.forEach(function (_v, t) { out.push(t); });
    out.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return out;
  }

  function pyFloorDivInt(a, b) {
    return Math.floor(a / b);
  }

  // SearchUtils.Counter
  function Counter(value) {
    this.value = value === undefined ? 0 : value;
  }
  Counter.prototype.add = function (n) {
    this.value += n;
  };

  function matrix(map, initVal) {
    var MM = mapMatrixCtor();
    return new MM(map, initVal);
  }

  function makeSet(map, tiles) {
    var S = need('EK.MapMatrixSet', EK.MapMatrixSet);
    return new S(map, tiles === undefined || tiles === null ? null : tiles);
  }

  function pathValueOf(path) {
    var v = path.value;
    return typeof v === 'number' ? v : 0;
  }

  // ---------------------------------------------------------------------------
  // GatherMaxIterativeSet._knapsack_max_set_gather_iteration（GatherMaxIterativeSet.py:29）
  // ---------------------------------------------------------------------------
  function knapsack_max_set_gather_iteration(turns, valuePerTurnPathPerTile, logList, valueFunc) {
    var factor = 1;
    if (valueFunc === null || valueFunc === undefined) {
      factor = 1000;
      valueFunc = function (path) { return Math.trunc(pathValueOf(path) * 1000); };
    }

    var groups = [];
    var paths = [];
    var values = [];
    var weights = [];
    var groupIdx = 0;

    // 原版 `[g for g in valuePerTurnPathPerTile.values()]` 保持 BFS 的插入顺序，
    // 这个顺序决定背包分组编号，进而影响「预算用完时先挑谁」，不能排序。
    valuePerTurnPathPerTile.forEach(function (group) {
      if (group.length > 0) {
        for (var i = 0; i < group.length; i++) {
          var p = group[i];
          groups.push(groupIdx);
          paths.push(p);
          values.push(valueFunc(p));
          weights.push(p.length);
        }
        groupIdx += 1;
      }
    });

    if (paths.length === 0) return [0, []];

    var ks = need('EK.knapsack', EK.knapsack);
    var res = ks.solve_multiple_choice_knapsack(paths, turns, weights, values, groups, logList === null || logList === undefined);
    // 原版返回 (totalValue, maxKnapsackedPaths)；JS 侧多半也是这个形状，兼容一下单值返回。
    var totalValue = Array.isArray(res) ? res[0] : res;
    var maxPaths = Array.isArray(res) ? res[1] : [];
    if (!maxPaths) maxPaths = [];
    return [pyFloorDivInt(totalValue, factor), maxPaths];
  }

  // ---------------------------------------------------------------------------
  // _get_single_line_iterative_starter_max_set（GatherMaxIterativeSet.py:167）
  // 起点太少（< 剩余回合/10）时不做背包，直接找一条「每回合收益最大」的单线。
  // ---------------------------------------------------------------------------
  function get_single_line_iterative_starter_max_set(
    fullTurns, ignoreStartTile, incrementBackward, logEntries, map, preferNeutral,
    priorityFunc, remainingTurns, searchingPlayer, shouldLog, skipFunc, skipTiles,
    startTilesDict, useTrueValueGathered, valueFunc, pathValueFunc) {

    var S = searchMod();
    var valuePerTurnPath = S.breadth_first_dynamic_max_global_visited(map, startTilesDict, valueFunc, {
      maxTurns: remainingTurns,
      maxDepth: 10000000,
      noNeutralCities: true,
      skipTiles: skipTiles,
      searchingPlayer: searchingPlayer,
      priorityFunc: priorityFunc,
      skipFunc: skipFunc,
      ignoreStartTile: ignoreStartTile,
      incrementBackward: incrementBackward,
      preferNeutral: preferNeutral,
      ignoreIncrement: true,
      pathValueFunc: pathValueFunc,
      priorityMatrixSkipStart: true,
      noLog: !shouldLog
    });

    if (valuePerTurnPath === null || valuePerTurnPath === undefined) {
      if (logEntries) logEntries.push('didnt find a max path in single line iterative starter');
      return [0, []];
    }
    return [pathValueOf(valuePerTurnPath), [valuePerTurnPath]];
  }

  // ---------------------------------------------------------------------------
  // _get_sub_knapsack_max_set_gather（GatherMaxIterativeSet.py:75）
  // 返回 (gatheredArmy:int, maxPaths:List[Path])。
  // ---------------------------------------------------------------------------
  function get_sub_knapsack_max_set_gather(
    map, startTilesDict, valueFunc, pathValueFunc, remainingTurns, fullTurns, skipTiles,
    searchingPlayer, priorityFunc, skipFunc, ignoreStartTile, incrementBackward,
    preferNeutral, logEntries, useTrueValueGathered, shouldLog) {

    var subSkip = skipFunc;

    if (startTilesDict.size < pyFloorDivInt(remainingTurns, 10)) {
      return get_single_line_iterative_starter_max_set(
        fullTurns, ignoreStartTile, incrementBackward, logEntries, map, preferNeutral,
        priorityFunc, remainingTurns, searchingPlayer, shouldLog, subSkip, skipTiles,
        startTilesDict, useTrueValueGathered, valueFunc, pathValueFunc);
    }

    var S = searchMod();
    var valuePerTurnPathPerTilePerDistance = S.breadth_first_dynamic_max_per_tile_per_distance_global_visited(
      map, startTilesDict, valueFunc, {
        maxTurns: remainingTurns,
        maxDepth: 10000,
        noNeutralCities: true,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: subSkip,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        ignoreNonPlayerArmy: !useTrueValueGathered,
        ignoreIncrement: true,
        priorityMatrixSkipStart: true,
        pathValueFunc: pathValueFunc,
        noLog: !shouldLog
      });

    var knap = knapsack_max_set_gather_iteration(
      remainingTurns, valuePerTurnPathPerTilePerDistance, shouldLog ? logEntries : null);
    return [Math.round(knap[0]), knap[1]];
  }

  // ---------------------------------------------------------------------------
  // _build_next_level_start_dict_max_set（GatherMaxIterativeSet.py:474）
  // 把这一轮挑中的路径的格子并进起点字典，并把路径上的距离累加进起点距离，
  // 下一轮 BFS 才会把这些格子当作「已经在计划里」。
  // ---------------------------------------------------------------------------
  function build_next_level_start_dict_max_set(newPaths, startTilesDict, searchingPlayer, remainingTurns, baseCaseFunc) {
    var next = new Map();
    startTilesDict.forEach(function (v, k) { next.set(k, v); });
    var hadInvalidPath = false;

    for (var pi = 0; pi < newPaths.length; pi++) {
      var valuePerTurnPath = newPaths[pi];
      var tailNode = valuePerTurnPath.tail;
      var tailTile = tailNode ? tailNode.tile : null;
      if (!tailTile || tailTile.army <= 1 || tailTile.player() !== searchingPlayer) {
        hadInvalidPath = true;
        continue;
      }
      remainingTurns -= valuePerTurnPath.length;

      var node = valuePerTurnPath.start;
      var distEntry = next.get(node.tile);
      var distance = distEntry ? distEntry[1] : 0;
      var addlDist = 1;
      node = node.next;
      while (node) {
        var newDist = distance + addlDist;
        var nextPrioObj = baseCaseFunc(node.tile, newDist);
        next.set(node.tile, [nextPrioObj, newDist]);
        addlDist += 1;
        node = node.next;
      }
    }

    return [hadInvalidPath ? null : remainingTurns, next];
  }

  // ---------------------------------------------------------------------------
  // _knapsack_max_set_gather_iterative_prune（GatherMaxIterativeSet.py:538）
  // 主循环：每轮「子背包 + 剪枝 + 重连」，记录历史最优 (bestVal, bestSet)。
  // ---------------------------------------------------------------------------
  // 原版 rootTiles 是 Python set，遍历顺序 = 哈希表槽位顺序，不是 tile_index 升序。
  // 建 MST / 累加森林值都吃这个顺序，平局时归属会跟着变，所以必须复刻表布局：
  // hash(Tile) == tile_index，冲突走 CPython 的 perturb 探测，装载率过 3/5 就扩容重插。
  function pySetOrder(items) {
    var size = 8;
    var fill = 0;
    var slots = new Array(size).fill(null);

    function insertInto(tbl, mask, tile) {
      var h = tile.tile_index;
      var maskLocal = mask;
      var i = h & maskLocal;
      if (tbl[i] === null) { tbl[i] = tile; return; }
      var perturb = h;
      while (true) {
        perturb = Math.floor(perturb / 32);
        i = (i * 5 + 1 + perturb) & maskLocal;
        if (tbl[i] === null) { tbl[i] = tile; return; }
      }
    }

    function reinsert(order) {
      slots = new Array(size).fill(null);
      fill = 0;
      for (var i = 0; i < order.length; i++) { insertInto(slots, size - 1, order[i]); fill++; }
    }

    for (var n = 0; n < items.length; n++) {
      if ((fill + 1) * 5 >= size * 3) {
        var existing = [];
        for (var s = 0; s < slots.length; s++) if (slots[s] !== null) existing.push(slots[s]);
        size = size <= 50000 ? size * 4 : size * 2;
        reinsert(existing);
      }
      insertInto(slots, size - 1, items[n]);
      fill++;
    }

    var out = [];
    for (var k = 0; k < slots.length; k++) if (slots[k] !== null) out.push(slots[k]);
    return out;
  }

  function knapsack_max_set_gather_iterative_prune(
    itr, map, startTilesDict, cutoffTime, rewardMatrix, armyCostMatrix, remainingTurns, fullTurns,
    targetArmy, valueFunc, baseCaseFunc, pathValueFunc, skipTiles, searchingPlayer, priorityFunc,
    skipFunc, perIterationFunc, incrementBackward, preferNeutral, viewInfo, logEntries,
    includeGatherTreeNodesThatGatherNegative, shouldLog, fastMode, slowMode, renderLive,
    maximizeValuePerTurn) {

    var FDS = need('EK.FastDisjointTileSetMultiSum', EK.FastDisjointTileSetMultiSum);

    var rootTiles = [];
    startTilesDict.forEach(function (_v, t) { rootTiles.push(t); });
    rootTiles = pySetOrder(rootTiles);

    var pruneReconnectCountMatrix = matrix(map, 0);

    var maxPerIteration = Math.max(Math.min(4, pyFloorDivInt(fullTurns, 2)), pyFloorDivInt(fullTurns, 2) - 1);
    if (fastMode) {
      maxPerIteration = Math.max(Math.min(7, pyFloorDivInt(3 * fullTurns, 5) - 1), pyFloorDivInt(fullTurns, 2));
    }
    var standardMode = !fastMode && !slowMode;

    var turnsSoFar = 0;
    var lastPrunedTo = 0;
    var bestSet = null;
    var bestVal = -10000;
    var bestStart = null;
    var bestTurns = 1;

    var newStartTilesDict = new Map();
    startTilesDict.forEach(function (v, k) { newStartTilesDict.set(k, v); });

    while (lastPrunedTo < fullTurns) {
      itr.add(1);
      var turnsToGather = fullTurns - turnsSoFar;
      if (perIterationFunc) perIterationFunc(newStartTilesDict);

      // forest 把「当前起点集合」按四邻连通性并起来，供后面的价值/兵力汇总使用。
      var forest = new FDS([rewardMatrix, armyCostMatrix]);
      newStartTilesDict.forEach(function (_v, tile) {
        var movable = tile.movable;
        for (var mi = 0; mi < movable.length; mi++) {
          var mv = movable[mi];
          if (newStartTilesDict.has(mv)) forest.merge(tile, mv);
        }
      });

      var sub = get_sub_knapsack_max_set_gather(
        map, newStartTilesDict, valueFunc, pathValueFunc, turnsToGather, fullTurns, skipTiles,
        searchingPlayer, priorityFunc, skipFunc, true, incrementBackward, preferNeutral,
        logEntries, false, shouldLog);
      var newGatheredArmy = sub[0];
      var newPaths = sub[1];

      if (newPaths.length === 0) break;

      var turnsUsedByNewPaths = 0;
      for (var np = 0; np < newPaths.length; np++) turnsUsedByNewPaths += newPaths[np].length;

      for (var pp = 0; pp < newPaths.length; pp++) {
        var path = newPaths[pp];
        var list = path.tileList;
        if (list.length === 0) continue;
        var last = list[0];
        for (var ti = 1; ti < list.length; ti++) {
          var t = list[ti];
          forest.merge(t, last);
          newStartTilesDict.set(t, [baseCaseFunc(t, 0), 0]);
        }
      }

      var totalTurns = turnsUsedByNewPaths + turnsSoFar;

      // 原版这里按 cutoffTime 收缩/跳出；JS 侧 cutoffTime 由调用方给，没有渲染器时同样生效。
      if (cutoffTime !== null && cutoffTime !== undefined && cutoffTime !== Infinity && clockNowSec() > cutoffTime) {
        if (totalTurns === fullTurns || itr.value > 4) break;
        maxPerIteration += 1;
        if (totalTurns === fullTurns && itr.value > 2) break;
      }

      if (itr.value > 1 && maxPerIteration > 1) {
        if (fastMode) maxPerIteration = pyFloorDivInt(5 * maxPerIteration, 7) + 1;
        else if (!slowMode) maxPerIteration = pyFloorDivInt(3 * maxPerIteration, 5) + 1;
        else maxPerIteration = 1;
      }

      var wouldBeNextTurnsLeft = fullTurns - (lastPrunedTo + maxPerIteration);
      if (maxPerIteration > 1) {
        if (standardMode) {
          if (wouldBeNextTurnsLeft < maxPerIteration) {
            maxPerIteration = Math.max(1, pyFloorDivInt(maxPerIteration, 2));
          }
        } else {
          var maxItCutoff = pyFloorDivInt(maxPerIteration, 2);
          if (wouldBeNextTurnsLeft <= maxItCutoff) {
            maxPerIteration = pyFloorDivInt(maxPerIteration, 2) + 1;
          }
        }
      }
      if (maxPerIteration < 1) maxPerIteration = 1;

      var pruneToTurns = lastPrunedTo + maxPerIteration;
      var overpruneCutoff = Math.max(pyFloorDivInt(pruneToTurns, 2), lastPrunedTo - maxPerIteration);

      var rootForestSubset = new Set();
      var gatherVal = 0;
      var armySum = 0;
      for (var rt = 0; rt < rootTiles.length; rt++) {
        var rootTile = rootTiles[rt];
        if (!forest.has(rootTile)) continue;
        var pair = forest.subset_with_values(rootTile);
        var recon = pair[0];
        var vals = pair[1];
        recon.forEach(function (t) { rootForestSubset.add(t); });
        gatherVal += vals[0];
        armySum += vals[1];
      }
      var curTurns = rootForestSubset.size - rootTiles.length;

      if (totalTurns > 0) {
        var isBestSet;
        if (maximizeValuePerTurn) {
          isBestSet = bestVal / Math.max(1, bestTurns) < gatherVal / Math.max(1, curTurns);
        } else {
          isBestSet = bestVal < gatherVal;
        }
        if (isBestSet) {
          bestVal = gatherVal;
          bestSet = new Set(rootForestSubset);
          bestStart = new Map(newStartTilesDict);
          bestTurns = curTurns;
        }

        if (bestVal / Math.max(1, bestTurns) > gatherVal * 1.04 / Math.max(1, curTurns)) {
          if (bestSet !== null) {
            newStartTilesDict = new Map(bestStart);
            rootForestSubset = new Set(bestSet);
          }
        }
      }

      if (pruneToTurns === fullTurns) break;

      var pruned = prune_set_to_turns_and_reconnect_with_values(
        map, rootTiles, rootForestSubset, pruneToTurns, fullTurns, searchingPlayer,
        rewardMatrix, armyCostMatrix, pruneReconnectCountMatrix, itr.value, skipTiles,
        baseCaseFunc, viewInfo, !shouldLog, newStartTilesDict, includeGatherTreeNodesThatGatherNegative,
        overpruneCutoff, logEntries, null);
      totalTurns = pruned[0];
      var totalValue = pruned[1];
      var prunedSet = pruned[2];

      lastPrunedTo = pruneToTurns;
      turnsSoFar = totalTurns;
      void totalValue;
      void prunedSet;
      void targetArmy;
      void renderLive;
    }

    return [bestVal, bestSet];
  }

  // ---------------------------------------------------------------------------
  // 剪枝族（GatherMaxIterativeSet.py:914-1248）
  // 所有 prune 函数都是「在保证根节点仍然连通的前提下，从 toPrune 里按价值从低到高剪格」，
  // 差别只在「怎么判断某一格可不可以剪」：朴素版用连通块判据，割点版直接看图的割点。
  // ---------------------------------------------------------------------------

  // GatherMaxIterativeSet.py:1201 —— 从 node 出发沿价值不增的方向吃掉一整块低价值区域。
  // 用 LIFO（q.pop()）而不是队列，原版就是栈，顺序会影响剪掉的边界格。
  function prune_connected_by_value(node, setToPrune, valueMatrix, rootTiles, tileDictToPrune, dropSimilarOffset, logEntries) {
    if (dropSimilarOffset === undefined) dropSimilarOffset = 0.0;
    var pruned = [];
    var cutoff = valueMatrix.raw[node.tile_index] + dropSimilarOffset;
    var q = [[node, cutoff]];

    while (q.length > 0) {
      var item = q.pop();
      var tile = item[0];
      var fromVal = item[1];
      var curVal = valueMatrix.raw[tile.tile_index];
      if (!setToPrune.has(tile)) continue;
      if (curVal > cutoff) continue;
      if (curVal > fromVal + dropSimilarOffset) continue;

      pruned.push(tile);
      setToPrune.delete(tile);
      if (tileDictToPrune) tileDictToPrune.delete(tile);

      var movable = tile.movable;
      for (var mi = 0; mi < movable.length; mi++) {
        var mv = movable[mi];
        if (!setToPrune.has(mv)) continue;
        if (rootTiles.has(mv)) continue;
        q.push([mv, curVal]);
      }
    }
    if (logEntries) logEntries.push('pruned ' + pruned.length + ' via prune_connected_by_value');
    return pruned;
  }

  // GatherMaxIterativeSet.py:914
  function prune_set_naive(rootTiles, toPrune, pruneTo, valueMatrix, pruneReconnectCountMatrix, tileDictToPrune, logEntries) {
    var pruned = [];
    var dcQueue = [];

    tilesAsc(toPrune).forEach(function (tile) {
      if (rootTiles.has(tile)) return;
      // 上一轮已经被当作「重连新增格」补回来的格子，不太该重复剪掉，所以加一点重连惩罚。
      var reconnectWeight = Math.max(0.0, pruneReconnectCountMatrix.raw[tile.tile_index] - 1.5);
      heapPush(dcQueue, [valueMatrix.raw[tile.tile_index] + reconnectWeight, tile]);
    });

    while (toPrune.size - rootTiles.size > pruneTo && dcQueue.length > 0) {
      var popped = heapPop(dcQueue);
      var t = popped[1];
      var newPruned = prune_connected_by_value(t, toPrune, valueMatrix, rootTiles, tileDictToPrune, 0.1, logEntries);
      for (var i = 0; i < newPruned.length; i++) pruned.push(newPruned[i]);
    }
    return pruned;
  }

  // GatherMaxIterativeSet.py:971 —— 只靠局部拓扑判断：在集合内只有一个邻居（叶子）或
  // 是三格拐角（另两个邻居能绕过它）就是可剪的。
  function heurPrunable(tile, toPrune) {
    var mvInSet = [];
    for (var i = 0; i < tile.movable.length; i++) {
      if (toPrune.has(tile.movable[i])) mvInSet.push(tile.movable[i]);
    }
    if (mvInSet.length === 1) return true;
    if (mvInSet.length > 2) return false;
    if (mvInSet.length === 2) {
      var a = mvInSet[0];
      var b = mvInSet[1];
      for (var x = 0; x < a.movable.length; x++) {
        var alt = a.movable[x];
        for (var y = 0; y < alt.movable.length; y++) {
          var n = alt.movable[y];
          if (n === tile) continue;
          if (b.movable.indexOf(n) !== -1) return true;
        }
      }
    }
    return false;
  }

  // GatherMaxIterativeSet.py:960 —— 自己会把格子从 toPrune 里删掉
  function heur_quick_prune_connected_set(toPrune, pruneTo, valueMatrix, rootTiles) {
    var pruned = [];
    var unprunable = new Set();
    var q = [];

    tilesAsc(toPrune).forEach(function (tile) {
      if (rootTiles.has(tile)) return;
      heapPush(q, [valueMatrix.raw[tile.tile_index], tile]);
    });

    while (q.length > 0 && toPrune.size > pruneTo) {
      var popped = heapPop(q);
      var t = popped[1];
      if (!heurPrunable(t, toPrune)) {
        unprunable.add(t);
        continue;
      }
      pruned.push(t);
      toPrune.delete(t);
      for (var i = 0; i < t.movable.length; i++) {
        var mv = t.movable[i];
        if (!unprunable.has(mv)) continue;
        unprunable.delete(mv);
        heapPush(q, [valueMatrix.raw[mv.tile_index], mv]);
      }
    }
    return pruned;
  }

  // --- networkx 等价物（只实现用得到的部分）---------------------------------

  // NetworkXHelpers.py:16 —— 四向、无权重、障碍与 banned 都不连边；孤立格必须显式 add_node，
  // 否则 remove_node 之后「度数为 1 的叶子」判断会漏。
  function build_networkx_graph_no_obstacles_no_weights(map, bannedTiles, validTiles) {
    var nx = need('EK.nx', EK.nx);
    var valid = validTiles || map.pathable_tiles;
    var g = new nx.Graph();
    var banned = bannedTiles || null;

    tilesAsc(valid).forEach(function (tile) {
      if (tile.isObstacle || (banned !== null && banned.has(tile))) return;
      var right = map.GetTile(tile.x + 1, tile.y);
      var down = map.GetTile(tile.x, tile.y + 1);
      g.add_node(tile.tile_index);
      if (right && valid.has(right)) {
        if (!right.isObstacle && (banned === null || !banned.has(right))) {
          g.add_edge(tile.tile_index, right.tile_index);
        }
      }
      if (down && valid.has(down)) {
        if (!down.isObstacle && (banned === null || !banned.has(down))) {
          g.add_edge(tile.tile_index, down.tile_index);
        }
      }
    });
    return g;
  }

  // NetworkXHelpers.py:344 —— 一条边的权重 = 两端价值之和（减掉全局最小值）按最大宽度缩放到
  // [scaleToMin, scaleToMax]，negate 时把区间翻过来：价值越高，边越短。
  function build_networkx_graph_flat_weight_mod_scale(map, weightModMatrix, scaleToMin, scaleToMax, bannedTiles, validTiles, negate) {
    var nx = need('EK.nx', EK.nx);
    if (scaleToMin === undefined || scaleToMin === null) scaleToMin = 0.0;
    if (scaleToMax === undefined || scaleToMax === null) scaleToMax = 1.0;
    if (negate === undefined || negate === null) negate = true;
    var valid = validTiles || map.pathable_tiles;
    var banned = bannedTiles || null;
    var g = new nx.Graph();

    var maxW = -Infinity;
    var minW = Infinity;
    valid.forEach(function (t) {
      var v = weightModMatrix.raw[t.tile_index] * 2;
      if (v > maxW) maxW = v;
      if (v < minW) minW = v;
    });
    if (!isFinite(maxW)) return g;
    var width = maxW - minW;

    if (negate) {
      var tmp = scaleToMin;
      scaleToMin = scaleToMax;
      scaleToMax = tmp;
    }
    var targetWidth = scaleToMax - scaleToMin;

    tilesAsc(valid).forEach(function (tile) {
      if (tile.isObstacle || (banned !== null && banned.has(tile))) return;
      var fromWeight = weightModMatrix.raw[tile.tile_index];

      var right = map.GetTile(tile.x + 1, tile.y);
      if (right && valid.has(right)) {
        if (!right.isObstacle && (banned === null || !banned.has(right))) {
          var w1 = fromWeight + weightModMatrix.raw[right.tile_index] - minW;
          var scaledVal1 = width === 0 ? scaleToMin : (w1 / width) * targetWidth + scaleToMin;
          g.add_edge(tile.tile_index, right.tile_index, { weight: scaledVal1 });
        }
      }
      var down = map.GetTile(tile.x, tile.y + 1);
      if (down && valid.has(down)) {
        if (!down.isObstacle && (banned === null || !banned.has(down))) {
          var w2 = fromWeight + weightModMatrix.raw[down.tile_index] - minW;
          var scaledVal2 = width === 0 ? scaleToMin : (w2 / width) * targetWidth + scaleToMin;
          g.add_edge(tile.tile_index, down.tile_index, { weight: scaledVal2 });
        }
      }
    });
    return g;
  }

  // nx.single_source_shortest_path_length 的键集合
  function singleSourceReachable(graph, source) {
    var seen = new Set([source]);
    var queue = [source];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head];
      head += 1;
      var nbrs = graph._adj.get(cur);
      if (!nbrs) continue;
      for (var nb of nbrs.keys()) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        queue.push(nb);
      }
    }
    return seen;
  }

  function subgraphNodes(graph, keep) {
    var nx = need('EK.nx', EK.nx);
    var g = new nx.Graph();
    keep.forEach(function (n) { g.add_node(n); });
    keep.forEach(function (n) {
      var nbrs = graph._adj.get(n);
      if (!nbrs) return;
      for (var nb of nbrs.keys()) {
        if (keep.has(nb)) g.add_edge(n, nb, graph.get_edge(n, nb));
      }
    });
    return g;
  }

  // nx.algorithms.articulation_points（Tarjan）。原版把结果塞进 set，只做成员判断，
  // 所以产出顺序不影响结果。
  function articulationPoints(graph) {
    var adj = graph._adj;
    var disc = new Map();
    var low = new Map();
    var parent = new Map();
    var result = new Set();
    var time = 0;

    var nodes = Array.from(adj.keys());

    for (var ni = 0; ni < nodes.length; ni++) {
      var startNode = nodes[ni];
      if (disc.has(startNode)) continue;

      // 迭代 DFS：递归深度在 400 格地图上没问题，但栈帧换来换去不划算，直接显式栈。
      var stack = [[startNode, null, 0]];
      var rootChildren = 0;

      while (stack.length > 0) {
        var frame = stack[stack.length - 1];
        var u = frame[0];
        var par = frame[1];

        if (frame[2] === 0) {
          disc.set(u, time);
          low.set(u, time);
          time += 1;
          parent.set(u, par);
          if (par === null) rootChildren = 0;
        }

        var nbrs = Array.from((adj.get(u) || new Map()).keys());
        var advanced = false;
        while (frame[2] < nbrs.length) {
          var v = nbrs[frame[2]];
          frame[2] += 1;
          if (v === u) continue;
          if (!disc.has(v)) {
            if (par === null) rootChildren += 1;
            stack.push([v, u, 0]);
            advanced = true;
            break;
          } else if (v !== par) {
            if (disc.get(v) < low.get(u)) low.set(u, disc.get(v));
          }
        }
        if (advanced) continue;

        stack.pop();
        if (par !== null) {
          if (low.get(u) < low.get(par)) low.set(par, low.get(u));
          // 非根节点：回边够不到祖先就是割点
          if (low.get(u) >= disc.get(par) && parent.get(par) !== null) result.add(par);
        }
      }

      if (rootChildren > 1) result.add(startNode);
      // 单节点/空图：networkx 不认为孤立点是割点
      if (rootChildren <= 1) result.delete(startNode);
    }

    return result;
  }

  // GatherMaxIterativeSet.py:1011 —— 用真正的割点集合保护连通性：只有「当前不是割点」
  // 且「剪掉后仍只剩一个邻居」的格子才允许剪。
  function prune_set_by_articulation_points(
    map, rootTiles, toPrune, pruneTo, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix,
    currentGathVal, currentArmySum, tileDictToPrune, logEntries) {

    if (pruneTo <= 0) {
      var allPruned = tilesAsc(toPrune);
      toPrune.clear();
      return [0.0, 0.0, allPruned];
    }
    var ogLen = toPrune.size;
    if (ogLen <= pruneTo) return [currentGathVal, currentArmySum, []];

    var dcQueue = [];
    tilesAsc(toPrune).forEach(function (tile) {
      if (rootTiles.has(tile)) return;
      heapPush(dcQueue, [valueMatrix.raw[tile.tile_index], tile]);
    });

    var unableToPrune = new Set();
    var nxForBcc = build_networkx_graph_no_obstacles_no_weights(map, null, toPrune);
    var unsafeToCut = new Set();
    var mustReEvaluateUnsafe = true;
    var lastPrunedToUnsafe = -1;
    var pruned = [];

    function refreshUnableToPrune() {
      tilesAsc(unableToPrune).forEach(function (t) {
        if (!toPrune.has(t)) return;
        heapPush(dcQueue, [valueMatrix.raw[t.tile_index], t]);
      });
      unableToPrune.clear();
    }

    while (toPrune.size > pruneTo) {
      if (dcQueue.length === 0) {
        mustReEvaluateUnsafe = true;
        if (toPrune.size === lastPrunedToUnsafe) break;
        lastPrunedToUnsafe = toPrune.size;
        refreshUnableToPrune();
        if (dcQueue.length === 0) break;
      }

      if (mustReEvaluateUnsafe) {
        unsafeToCut = articulationPoints(nxForBcc);
        mustReEvaluateUnsafe = false;
      }

      var popped = heapPop(dcQueue);
      var t = popped[1];
      if (!toPrune.has(t)) continue;

      if (unsafeToCut.has(t.tile_index)) {
        unableToPrune.add(t);
        continue;
      }

      var inSetNbrs = 0;
      for (var mi = 0; mi < t.movable.length; mi++) if (toPrune.has(t.movable[mi])) inSetNbrs += 1;
      mustReEvaluateUnsafe = inSetNbrs !== 1;

      toPrune.delete(t);
      nxForBcc.remove_node(t.tile_index);
      currentGathVal -= valueMatrix.raw[t.tile_index];
      currentArmySum -= armyCostMatrix.raw[t.tile_index];
      if (tileDictToPrune) tileDictToPrune.delete(t);
      pruned.push(t);

      if (dcQueue.length < 2 || (mustReEvaluateUnsafe && toPrune.size < pruneTo + 5)) {
        mustReEvaluateUnsafe = true;
        refreshUnableToPrune();
      } else if (!mustReEvaluateUnsafe) {
        for (var mj = 0; mj < t.movable.length; mj++) {
          var mv = t.movable[mj];
          if (!unableToPrune.has(mv)) continue;
          unableToPrune.delete(mv);
          heapPush(dcQueue, [valueMatrix.raw[mv.tile_index], mv]);
        }
      }
    }

    if (logEntries) logEntries.push('articulation prune removed ' + pruned.length);
    return [currentGathVal, currentArmySum, pruned];
  }

  // GatherMaxIterativeSet.py:1134
  function prune_set_by_heuristic_articulation_points(
    map, rootTiles, toPrune, pruneTo, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix,
    currentGathVal, currentArmySum, tileDictToPrune, logEntries) {

    if (pruneTo <= 0) {
      var allPruned = tilesAsc(toPrune);
      toPrune.clear();
      return [0.0, 0.0, allPruned];
    }
    var ogLen = toPrune.size;
    if (ogLen <= pruneTo) return [currentGathVal, currentArmySum, []];

    var pruned = heur_quick_prune_connected_set(toPrune, pruneTo, valueMatrix, rootTiles);
    for (var i = 0; i < pruned.length; i++) {
      var t = pruned[i];
      currentGathVal -= valueMatrix.raw[t.tile_index];
      currentArmySum -= armyCostMatrix.raw[t.tile_index];
      if (tileDictToPrune) tileDictToPrune.delete(t);
      toPrune.delete(t);
    }
    return [currentGathVal, currentArmySum, pruned];
  }

  // ---------------------------------------------------------------------------
  // 重连族（GatherMaxIterativeSet.py:1428-1974）
  // 三个分支的收尾记账完全相同（reconnectionTiles / gathVal / rawArmy / tileDictToPrune /
  // pruneReconnectCountMatrix），所以抽成 _account_reconnected。
  // ---------------------------------------------------------------------------
  function accountReconnected(reconnectedSubset, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, baseCaseFunc, tileDictToPrune) {
    var gathVal = 0;
    var rawArmy = 0;
    var reconnectionTiles = [];
    if (baseCaseFunc && tileDictToPrune) tileDictToPrune.clear();

    tilesAsc(reconnectedSubset).forEach(function (t) {
      if (!toReconnect.has(t)) reconnectionTiles.push(t);
      gathVal += valueMatrix.raw[t.tile_index];
      rawArmy += armyCostMatrix.raw[t.tile_index];
      if (baseCaseFunc && tileDictToPrune) tileDictToPrune.set(t, [baseCaseFunc(t, 0), 0]);
    });

    for (var i = 0; i < reconnectionTiles.length; i++) {
      pruneReconnectCountMatrix.raw[reconnectionTiles[i].tile_index] += 1;
    }
    return [gathVal, rawArmy];
  }

  // GatherMaxIterativeSet.py:1428 —— 用整张图的最小 Steiner 树把散块连起来。
  function reconnect_steiner_subprune(map, someRoot, rootTiles, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, reconnectTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, liveRenderer) {
    var Gather = gatherMod();
    var steinerGraph = build_networkx_graph_flat_weight_mod_scale(map, valueMatrix, 0.0, 1.0, skipTiles, null, true);

    var toReconnectInGraph = [];
    tilesAsc(toReconnect).forEach(function (t) {
      if (skipTiles && skipTiles.has(t)) return;
      if (!steinerGraph._adj.has(t.tile_index)) return;
      toReconnectInGraph.push(t);
    });

    if (toReconnectInGraph.length === 0) return [0, 0, new Set()];

    var reachable = new Set();
    for (var i = 0; i < toReconnectInGraph.length; i++) {
      var reach = singleSourceReachable(steinerGraph, toReconnectInGraph[i].tile_index);
      reach.forEach(function (n) { reachable.add(n); });
    }
    if (reachable.size > 0) steinerGraph = subgraphNodes(steinerGraph, reachable);

    var reconnectedSubset = Gather.build_network_x_steiner_tree_from_arbitrary_nx_graph(map, steinerGraph, toReconnectInGraph);
    var acc = accountReconnected(reconnectedSubset, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, baseCaseFunc, tileDictToPrune);
    void someRoot; void rootTiles; void reconnectTargetTurns; void overpruneCutoff; void liveRenderer;
    return [acc[0], acc[1], reconnectedSubset];
  }

  // pcst_fast 的替代品：在**完全照抄原版**的 prizes/costs/边序上跑贪心增长。
  // 规则：从 rootTiles 构成的树出发，每步挑「prize / cost 比值最大」的边界节点并入，
  // 比值 <= 1 即停（prize 不够付路费）。平局取 tile_index 小的，保证可复现。
  function pcstGreedySolve(prizes, edges, costs, rootTiles, map) {
    var n = prizes.length;
    var adj = new Array(n);
    for (var i = 0; i < n; i++) adj[i] = [];
    for (var e = 0; e < edges.length; e++) {
      var u = edges[e][0];
      var v = edges[e][1];
      var c = costs[e];
      if (adj[u] === undefined) adj[u] = [];
      if (adj[v] === undefined) adj[v] = [];
      adj[u].push([v, c]);
      adj[v].push([u, c]);
    }

    var inTree = new Uint8Array(n);
    var heap = [];
    function pushNeighbors(node) {
      var list = adj[node];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var nb = list[i][0];
        var c = list[i][1];
        if (inTree[nb]) continue;
        var score = c <= 0 ? Infinity : prizes[nb] / c;
        heapPush(heap, [-score, c, nb]);
      }
    }

    var seeds = [];
    if (rootTiles !== null && rootTiles !== undefined && rootTiles.length > 0) {
      for (var r = 0; r < rootTiles.length; r++) seeds.push(rootTiles[r].tile_index);
    }
    if (seeds.length === 0) {
      // 没有根时退化成「全球最高 prize」起手，原版这里是 root=-1（无根变体）
      var best = -1;
      var bestP = -Infinity;
      for (var i2 = 0; i2 < n; i2++) {
        if (adj[i2] === undefined) continue;
        if (prizes[i2] > bestP) {
          bestP = prizes[i2];
          best = i2;
        }
      }
      if (best >= 0) seeds.push(best);
    }

    for (var s = 0; s < seeds.length; s++) {
      var seed = seeds[s];
      inTree[seed] = 1;
      pushNeighbors(seed);
    }

    while (heap.length > 0) {
      var top = heapPop(heap);
      var negScore = top[0];
      var cost = top[1];
      var node = top[2];
      if (inTree[node]) continue;
      var prize = prizes[node];
      if (prize <= cost) {
        // 堆按 -score 升序 = score 降序；第一个不合格的后面都不合格（比值单调不增不会自动成立，
        // 因为它们 cost 不同，所以这里不 break，继续看下一个）。
        continue;
      }
      inTree[node] = 1;
      pushNeighbors(node);
      void negScore;
    }

    var out = new Set();
    for (var k = 0; k < n; k++) {
      if (!inTree[k]) continue;
      var tile = map.tiles_by_index[k];
      if (tile) out.add(tile);
    }
    return out;
  }

  // GatherSteiner.py:162 get_prize_collecting_gather_mapmatrix_single_iteration 的移植，
  // 除了最后一步 pcst_fast 用 pcstGreedySolve 顶替。
  function get_prize_collecting_gather_mapmatrix_single_iteration(map, valueMatrix, baselineValuePerTurn, searchingPlayer, rootTiles, mustInclude, negativeTiles, skipTiles) {
    var prizes = new Float64Array(map.tiles_by_index.length);
    for (var i = 0; i < prizes.length; i++) prizes[i] = valueMatrix.raw[i];

    if (mustInclude) {
      tilesAsc(mustInclude).forEach(function (t) { prizes[t.tile_index] += 150; });
    }

    var costBasis = Math.max(0, baselineValuePerTurn - 1);
    return pcst_iteration_internal(map, costBasis, prizes, null, skipTiles, 0.0, rootTiles, false);
  }

  // GatherSteiner.py:785
  function pcst_iteration_internal(map, costBasis, prizesIn, tileExtraCostMatrix, skipTiles, prizeOffset, rootTiles, fastMode) {
    var scaleNegativesBelow = 2;
    costBasis += scaleNegativesBelow;

    var n = map.tiles_by_index.length;
    var prizes = new Float64Array(n);
    var edges = [];
    var costs = [];

    for (var tileIndex = 0; tileIndex < n; tileIndex++) {
      var tile = map.tiles_by_index[tileIndex];
      if (!tile) continue;
      var prize = prizesIn[tileIndex];
      var extraCost = tileExtraCostMatrix ? tileExtraCostMatrix.raw[tileIndex] : 0.0;
      prize += prizeOffset;
      // 看不见的中立敌军格当作没有收益，否则会去「吃」一个虚构的负兵
      if (tile.player() === -1 && tile.army < 0) prize = 0;
      if (prize < scaleNegativesBelow) {
        prize = scaleNegativesBelow / ((scaleNegativesBelow + 1) - prize);
      }
      prizes[tileIndex] = prize;

      if (tile.isObstacle) continue;
      if (skipTiles && skipTiles.has(tile)) continue;

      var right = map.GetTile(tile.x + 1, tile.y);
      var down = map.GetTile(tile.x, tile.y + 1);

      if (right && !right.isObstacle) {
        if (!skipTiles || !skipTiles.has(right)) {
          edges.push([tileIndex, right.tile_index]);
          costs.push(Math.max(0.0, costBasis + extraCost));
        }
      }
      if (down && !down.isObstacle) {
        if (!skipTiles || !skipTiles.has(down)) {
          edges.push([tileIndex, down.tile_index]);
          costs.push(Math.max(0.0, costBasis + extraCost));
        }
      }
    }

    // 所有根之间补 0 成本边：让「同时采集到多个根」不需要真的连通
    var roots = rootTiles ? tilesAsc(rootTiles) : [];
    var last = null;
    for (var ri = 0; ri < roots.length; ri++) {
      var t = roots[ri];
      if (last !== null) {
        edges.push([t.tile_index, last.tile_index]);
        costs.push(0);
      }
      last = t;
    }
    void fastMode;

    return pcstGreedySolve(prizes, edges, costs, roots, map);
  }

  // GatherMaxIterativeSet.py:1523 —— 与 steiner 分支共用记账，只是求解器换成 PCST
  function reconnect_fast_pcst(map, someRoot, rootTiles, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, reconnectTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, baselineValuePerTurn, liveRenderer) {
    var reconnectedSubset = get_prize_collecting_gather_mapmatrix_single_iteration(
      map, valueMatrix, baselineValuePerTurn, map.player_index, rootTiles, toReconnect, null, skipTiles);
    var acc = accountReconnected(reconnectedSubset, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, baseCaseFunc, tileDictToPrune);
    void someRoot; void reconnectTargetTurns; void overpruneCutoff; void liveRenderer;
    return [acc[0], acc[1], reconnectedSubset];
  }

  // GatherMaxIterativeSet.py:1693 —— 反复用 BFS 找「从已连通的树长到未连通块」的最短路径，
  // 每加一条路径就 merge 进森林，直到森林大小够 pruneTo 或再也找不到。
  function reconnect_iterative_heuristic(map, pruneTo, partiallyDisconnectedSetToModify, rootTiles, skipTiles, valueMatrix, armyCostMatrix, bareMinTurns, doNotAllowExtraTurns, liveRenderer, logEntries) {
    var S = searchMod();
    var FDS = need('EK.FastDisjointTileSetMultiSum', EK.FastDisjointTileSetMultiSum);

    var excessTurns = pruneTo - bareMinTurns;
    var forest = new FDS([valueMatrix, armyCostMatrix]);
    var newTiles = new Set();
    var negativeTiles = null;

    var someRoot = null;
    for (var ri = 0; ri < rootTiles.length; ri++) someRoot = rootTiles[ri];

    tilesAsc(partiallyDisconnectedSetToModify).forEach(function (t) {
      for (var mi = 0; mi < t.movable.length; mi++) {
        var adj = t.movable[mi];
        if (partiallyDisconnectedSetToModify.has(adj)) forest.merge(t, adj);
      }
    });

    function findFunc(t, prio) {
      void prio;
      return forest.has(t) && !forest.connected(t, someRoot);
    }

    function prioFunc(tile, prioObj) {
      var negGatherPoints = prioObj[2];
      var originTile = prioObj[4];
      var dist = prioObj[1];
      negGatherPoints -= valueMatrix.raw[tile.tile_index];
      var newDist = dist + 1;
      var newPrio = newDist + negGatherPoints / newDist;
      if (forest.has(tile)) newPrio -= 100;
      return [newPrio, newDist, negGatherPoints, tile, originTile];
    }

    var iteration = 0;
    while (forest.subset_size(someRoot) < pruneTo) {
      iteration += 1;
      if (iteration > 10000) break; // 防御：原版靠 BFS 返回 None 收敛，这里防止病态输入死循环

      var usefulStartSet = new Map();
      tilesAsc(partiallyDisconnectedSetToModify).forEach(function (t) {
        if (forest.connected(t, someRoot)) usefulStartSet.set(t, [[-10000, 0, 0, null, t], 0]);
      });

      var path = S.breadth_first_dynamic(map, usefulStartSet, findFunc, {
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        priorityFunc: prioFunc,
        noVal: true,
        noLog: true
      });

      if (path === null || path === undefined) {
        path = S.breadth_first_dynamic(map, usefulStartSet, findFunc, {
          negativeTiles: negativeTiles,
          skipTiles: skipTiles,
          priorityFunc: prioFunc,
          noNeutralCities: false,
          noVal: true,
          noLog: true
        });
        if (path === null || path === undefined) break;
      }

      var list = path.tileList;
      if (list.length === 0) break;
      var last = list[list.length - 1];
      for (var i = 1; i < list.length - 1; i++) newTiles.add(list[i]);
      for (var j = 0; j < list.length; j++) forest.merge(list[j], last);

      void excessTurns; void doNotAllowExtraTurns; void liveRenderer; void logEntries;
    }

    return [newTiles, forest];
  }

  // GatherMaxIterativeSet.py:1606
  function reconnect_dynamic_find_forest(map, someRoot, rootTiles, toReconnect, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, reconnectTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, liveRenderer) {
    var res = reconnect_iterative_heuristic(map, reconnectTargetTurns, toReconnect, rootTiles, skipTiles, valueMatrix, armyCostMatrix, overpruneCutoff, false, liveRenderer, null);
    var reconnectionTiles = res[0];
    var forest = res[1];

    var reconnectedSubset = new Set();
    var gathVal = 0;
    var rawArmy = 0;
    for (var ri = 0; ri < rootTiles.length; ri++) {
      var rootTile = rootTiles[ri];
      if (!forest.has(rootTile)) continue;
      var pair = forest.subset_with_values(rootTile);
      pair[0].forEach(function (t) { reconnectedSubset.add(t); });
      gathVal += pair[1][0];
      rawArmy += pair[1][1];
    }

    if (baseCaseFunc && tileDictToPrune) {
      var toDrop = [];
      tileDictToPrune.forEach(function (_v, tile) {
        if (!forest.connected(tile, someRoot)) toDrop.push(tile);
      });
      for (var d = 0; d < toDrop.length; d++) tileDictToPrune.delete(toDrop[d]);
      tilesAsc(reconnectionTiles).forEach(function (t) {
        if (!forest.connected(someRoot, t)) return;
        tileDictToPrune.set(t, [baseCaseFunc(t, 0), 0]);
      });
    }

    tilesAsc(reconnectionTiles).forEach(function (t) {
      pruneReconnectCountMatrix.raw[t.tile_index] += 1;
    });

    return [gathVal, rawArmy, reconnectedSubset];
  }

  // GatherMaxIterativeSet.py:1249 —— 剪刀 + 重连的组合：先粗剪到 overpruneCutoff-5，
  // 再按「已经用了多少回合」选一条重连策略，最后两级割点剪收尾。
  function prune_set_to_turns_and_reconnect_with_values(
    map, rootTiles, toPrune, turns, finalTargetTurns, searchingPlayer, valueMatrix, armyCostMatrix,
    pruneReconnectCountMatrix, iteration, skipTiles, baseCaseFunc, viewInfo, noLog,
    tileDictToPrune, allowNegative, overpruneCutoff, logEntries, liveRenderer) {

    var rootSet = new Set(rootTiles);
    var desiredTotalNodes = turns + rootTiles.length;

    var baselineValue = 0;
    toPrune.forEach(function (t) {
      if (!rootSet.has(t)) baselineValue += valueMatrix.raw[t.tile_index];
    });
    var baselineValuePerTurn = baselineValue / Math.max(1, toPrune.size - rootTiles.length);
    var someRoot = rootTiles.length > 0 ? rootTiles[0] : null;

    var naiveTargetTurns = overpruneCutoff - 5;
    prune_set_naive(rootSet, toPrune, naiveTargetTurns, valueMatrix, pruneReconnectCountMatrix, tileDictToPrune, logEntries);

    var reconnectTargetTurns = desiredTotalNodes;
    var reconnected = null;
    var ratio = desiredTotalNodes / finalTargetTurns;

    // 分支计数是给 ekdiff-gathermax.js 分组的：原版三条分支的求解器不一样，
    // 验收必须分开报，否则 pcst 的近似会把 steiner 的精确对齐掩盖掉。
    var branch;
    if (ratio > 0.92 && (iteration & 1) === 0) {
      branch = 'steiner';
      reconnected = reconnect_steiner_subprune(map, someRoot, rootTiles, toPrune, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, reconnectTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, liveRenderer);
    } else if (ratio > 0.85 && (iteration & 2) !== 0) {
      branch = 'dynamic';
      reconnected = reconnect_dynamic_find_forest(map, someRoot, rootTiles, toPrune, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, finalTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, liveRenderer);
    } else {
      branch = 'pcst';
      reconnected = reconnect_fast_pcst(map, someRoot, rootTiles, toPrune, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, skipTiles, reconnectTargetTurns, overpruneCutoff, baseCaseFunc, tileDictToPrune, baselineValuePerTurn, liveRenderer);
    }
    branchStats[branch] = (branchStats[branch] || 0) + 1;

    var gathVal = reconnected[0];
    var rawArmy = reconnected[1];
    var reconnectedSubset = reconnected[2];

    var qpTurns = desiredTotalNodes + 6;
    var qp = prune_set_by_heuristic_articulation_points(map, rootSet, reconnectedSubset, qpTurns, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, gathVal, rawArmy, tileDictToPrune, logEntries);
    gathVal = qp[0];
    rawArmy = qp[1];

    var articPruneTargetTurns = desiredTotalNodes;
    var ap = prune_set_by_articulation_points(map, rootSet, reconnectedSubset, articPruneTargetTurns, valueMatrix, armyCostMatrix, pruneReconnectCountMatrix, gathVal, rawArmy, tileDictToPrune, logEntries);

    void searchingPlayer; void viewInfo; void noLog; void allowNegative;
    return [reconnectedSubset.size - rootTiles.length, ap[0], reconnectedSubset];
  }

  // ---------------------------------------------------------------------------
  // 入口：GatherMaxIterativeSet.gather_max_set_iterative_plan（GatherMaxIterativeSet.py:2088）
  // 返回 GatherCapturePlan（无解时 null）；调用点 BotGatherOps.py:1178 用的就是它。
  // ---------------------------------------------------------------------------
  var branchStats = { steiner: 0, dynamic: 0, pcst: 0 };

  function gather_max_set_iterative_plan(
    map, startTiles, turns, valueMatrix, armyCostMatrix, targetArmy, valueFunc, baseCaseFunc,
    pathValueFunc, skipTiles, searchingPlayer, priorityFunc, skipFunc, perIterationFunc,
    priorityTiles, ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
    includeGatherTreeNodesThatGatherNegative, shouldLog, cutoffTime, fastMode, slowMode,
    renderLive, maximizeValuePerTurn, useTrueValueGathered) {

    if (ignoreStartTile === undefined) ignoreStartTile = false;
    if (incrementBackward === undefined) incrementBackward = true;
    if (preferNeutral === undefined) preferNeutral = false;
    if (useTrueValueGathered === undefined) useTrueValueGathered = true;
    if (includeGatherTreeNodesThatGatherNegative === undefined) includeGatherTreeNodesThatGatherNegative = false;
    if (shouldLog === undefined) shouldLog = false;
    if (fastMode === undefined) fastMode = false;
    if (slowMode === undefined) slowMode = false;
    if (renderLive === undefined) renderLive = false;
    if (maximizeValuePerTurn === undefined) maximizeValuePerTurn = false;
    if (searchingPlayer === undefined || searchingPlayer === null) searchingPlayer = -2;
    if (cutoffTime === undefined) cutoffTime = Infinity;  // 不拿时钟当决策输入；要限时就显式传一个秒级时间戳

    branchStats = { steiner: 0, dynamic: 0, pcst: 0 };

    if (searchingPlayer === -2) {
      if (startTiles instanceof Map) {
        var firstKey = null;
        startTiles.forEach(function (_v, k) { if (firstKey === null) firstKey = k; });
        searchingPlayer = firstKey ? firstKey.player() : -2;
      } else {
        searchingPlayer = startTiles.length > 0 ? startTiles[0].player() : -2;
      }
    }

    var logEntries = [];

    if (valueFunc === null || valueFunc === undefined) {
      valueFunc = function (currentTile, priorityObject) {
        var realDist = priorityObject[2];
        var negGatheredSum = priorityObject[3];
        var negArmySum = priorityObject[4];
        if (negArmySum >= 0 && !includeGatherTreeNodesThatGatherNegative) return null;
        if (negGatheredSum >= 0) return null;
        if (currentTile.army < 2 || currentTile.player() !== searchingPlayer) return null;
        var val = -1000;
        if (realDist > 0) val = 0 - negGatheredSum;
        return [val, 0 - negGatheredSum, 0 - negArmySum, realDist];
      };
    }

    if (pathValueFunc === null || pathValueFunc === undefined) {
      pathValueFunc = function (path, valueObj) {
        void path;
        return valueObj[1];
      };
    }

    if (priorityFunc === null || priorityFunc === undefined) {
      priorityFunc = function (nextTile, currentPriorityObject) {
        var realDist = currentPriorityObject[2];
        var negGatheredSum = currentPriorityObject[3];
        var negArmySum = currentPriorityObject[4];
        var numPrioTiles = currentPriorityObject[5];
        negArmySum -= armyCostMatrix.raw[nextTile.tile_index];
        negGatheredSum -= valueMatrix.raw[nextTile.tile_index];
        if (priorityTiles && priorityTiles.has(nextTile)) numPrioTiles += 1;
        realDist += 1;
        var prioVal = -100000;
        if (realDist > 0) prioVal = realDist + negGatheredSum / realDist;
        return [prioVal, numPrioTiles / Math.max(1, realDist), realDist, negGatheredSum, negArmySum, numPrioTiles];
      };
    }

    if (baseCaseFunc === null || baseCaseFunc === undefined) {
      baseCaseFunc = function (tile, startingDist) {
        void tile; void startingDist;
        return [-100000000000.0, 0, 0, 0, 0, 0];
      };
    }

    var negativeTiles = new Set();
    var startTilesDict = new Map();

    if (startTiles instanceof Map) {
      var allNumbers = true;
      startTiles.forEach(function (v) { if (typeof v !== 'number') allNumbers = false; });
      if (allNumbers) {
        startTiles.forEach(function (distance, tile) {
          startTilesDict.set(tile, [baseCaseFunc(tile, distance), distance]);
        });
      } else {
        startTilesDict = startTiles;
      }
      startTilesDict.forEach(function (_v, tile) { negativeTiles.add(tile); });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var st = startTiles[i];
        startTilesDict.set(st, [baseCaseFunc(st, 0), 0]);
        negativeTiles.add(st);
      }
    }

    var itr = new Counter(0);
    var res = knapsack_max_set_gather_iterative_prune(
      itr, map, startTilesDict, cutoffTime, valueMatrix, armyCostMatrix, turns, turns,
      targetArmy, valueFunc, baseCaseFunc, pathValueFunc, skipTiles, searchingPlayer, priorityFunc,
      skipFunc, perIterationFunc, incrementBackward, preferNeutral, viewInfo, logEntries,
      includeGatherTreeNodesThatGatherNegative, shouldLog, fastMode, slowMode, renderLive,
      maximizeValuePerTurn);

    var totalValue = res[0];
    var gathSet = res[1];

    var Gather = gatherMod();
    var gcp = null;
    if (gathSet && gathSet.size > 0) {
      var rootTiles = [];
      startTilesDict.forEach(function (_v, t) { rootTiles.push(t); });
      rootTiles = pySetOrder(rootTiles);
      gcp = Gather.convert_contiguous_tile_tree_to_gather_capture_plan(
        map, rootTiles, gathSet, searchingPlayer, negativeTiles, valueMatrix,
        useTrueValueGathered, undefined, undefined, null, armyCostMatrix, null);
    }

    GatherMaxSet.last_branch_stats = branchStats;
    GatherMaxSet.last_iterations = itr.value;
    GatherMaxSet.last_total_value = totalValue;
    void distPriorityMap;

    return gcp;
  }

  // GatherMaxIterativeSet.py:2001 —— 老接口，只返回 root_nodes。
  // 注意原版这里写的是 `totalValue, usedTurns, rootNodes = gather_max_set_iterative_plan(...)`，
  // 而 plan 返回的是 GatherCapturePlan（可迭代出 PathMove），这个三元解包在 Python 侧本身就
  // 会炸；全仓没有任何调用点（真实调用点走 plan）。JS 侧按「显然的意图」实现：取 root_nodes。
  function gather_max_set_iterative(
    map, startTiles, turns, armyCostMatrix, valueMatrix, targetArmy, valueFunc, baseCaseFunc,
    negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc, priorityTiles,
    ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
    includeGatherTreeNodesThatGatherNegative, cutoffTime, shouldLog, fastMode) {

    var plan = gather_max_set_iterative_plan(
      map, startTiles, turns, valueMatrix, armyCostMatrix, targetArmy, valueFunc, baseCaseFunc,
      null, skipTiles, searchingPlayer, priorityFunc, skipFunc, null, priorityTiles,
      ignoreStartTile === undefined ? true : ignoreStartTile, incrementBackward, preferNeutral,
      viewInfo, distPriorityMap, includeGatherTreeNodesThatGatherNegative, shouldLog, cutoffTime,
      fastMode, false, false, false, true);

    void negativeTiles;
    if (!plan) return [];
    return plan.root_nodes || [];
  }

  GatherMaxSet.gather_max_set_iterative_plan = gather_max_set_iterative_plan;
  GatherMaxSet.gather_max_set_iterative = gather_max_set_iterative;
  GatherMaxSet.last_branch_stats = branchStats;

  // ===========================================================================
  // GatherMaxIterative（GatherMaxIterative.py 1638 行）
  // 与 Set 版同构，但中间态是「树节点」而不是格子集合：每轮把新路径接进 GatherTreeNode
  // 森林（_extend_tree_node_lookup），剪枝交给 GatherPrune.prune_mst_until（按每回合价值
  // 从低到高剪叶子，并把 value/gatherTurns 沿 toTile 链往上冒泡）。
  // ===========================================================================
  function nodeOf(tile, toTile, stateObj) {
    var Ctor = need('EK.GatherTreeNode', EK.GatherTreeNode);
    return new Ctor(tile, toTile, stateObj);
  }

  function playerOfM(tile) {
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  // GatherMaxIterative.py:65 —— 与 Set 版同名函数相比多了 negativeTiles / priorityMatrix 两个透传。
  function get_sub_knapsack_max_gather(
    map, startTilesDict, valueFunc, baseCaseFunc, pathValueFunc, maxTime, remainingTurns,
    fullTurns, noNeutralCities, negativeTiles, skipTiles, searchingPlayer, priorityFunc,
    skipFunc, ignoreStartTile, incrementBackward, preferNeutral, logEntries,
    useTrueValueGathered, priorityMatrix, shouldLog) {

    void maxTime;
    var S = need('EK.search', EK.search);
    var subSkip = skipFunc;

    if (startTilesDict.size < Math.floor(remainingTurns / 10)) {
      return get_single_line_iterative_starter_max(
        fullTurns, ignoreStartTile, incrementBackward, logEntries, map, negativeTiles,
        preferNeutral, priorityFunc, priorityMatrix, remainingTurns, searchingPlayer, shouldLog,
        subSkip, skipTiles, startTilesDict, useTrueValueGathered, valueFunc, pathValueFunc);
    }

    var valuePerTurnPathPerTilePerDistance = S.breadth_first_dynamic_max_per_tile_per_distance_global_visited(
      map, startTilesDict, valueFunc, {
        maxTurns: remainingTurns,
        maxDepth: 10000,
        noNeutralCities: true,
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: subSkip,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        priorityMatrix: priorityMatrix,
        ignoreNonPlayerArmy: !useTrueValueGathered,
        ignoreIncrement: true,
        priorityMatrixSkipStart: true,
        pathValueFunc: pathValueFunc
      });

    var gatheredArmy, maxPaths;
    var res = knapsack_max_set_gather_iteration(remainingTurns, valuePerTurnPathPerTilePerDistance,
      shouldLog ? logEntries : null);
    gatheredArmy = res[0];
    maxPaths = res[1];

    void noNeutralCities;
    return [Math.round(gatheredArmy), maxPaths];
  }

  // GatherMaxIterative.py:162
  function get_single_line_iterative_starter_max(
    fullTurns, ignoreStartTile, incrementBackward, logEntries, map, negativeTiles, preferNeutral,
    priorityFunc, priorityMatrix, remainingTurns, searchingPlayer, shouldLog, skipFunc, skipTiles,
    startTilesDict, useTrueValueGathered, valueFunc, pathValueFunc) {

    var S = need('EK.search', EK.search);
    var valuePerTurnPath = S.breadth_first_dynamic_max_global_visited(
      map, startTilesDict, valueFunc, {
        maxTurns: remainingTurns,
        maxDepth: 10000000,
        noNeutralCities: true,
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: skipFunc,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        priorityMatrix: priorityMatrix,
        ignoreNonPlayerArmy: !useTrueValueGathered,
        ignoreIncrement: true,
        pathValueFunc: pathValueFunc,
        priorityMatrixSkipStart: true
      });

    void fullTurns;
    if (valuePerTurnPath === null || valuePerTurnPath === undefined) {
      if (logEntries) logEntries.push('didnt find a max path');
      return [0, []];
    }
    return [valuePerTurnPath.value, [valuePerTurnPath]];
  }

  // GatherMaxIterative.py:279 —— 把一批新路径接进树森林，同时把路径价值/回合数沿父链冒泡。
  function extend_tree_node_lookup(newPaths, gatherTreeNodeLookup, startTilesDict, searchingPlayer,
    teams, negativeTiles, logEntries, useTrueValueGathered, shouldLog, force, priorityMatrix) {

    var distanceLookup = new Map();
    startTilesDict.forEach(function (v, tile) { distanceLookup.set(tile, v[1]); });

    for (var pi = 0; pi < newPaths.length; pi++) {
      var valuePerTurnPath = newPaths[pi];
      var tailTile = valuePerTurnPath.tail.tile;
      if (tailTile.army <= 1 || playerOfM(tailTile) !== searchingPlayer) continue;

      if (shouldLog) logEntries.push('Adding valuePerTurnPath ' + valuePerTurnPath.toString());

      var pathNode = valuePerTurnPath.start;
      var distance = distanceLookup.get(pathNode.tile);
      var addlDist = 1;

      var currentGatherTreeNode = gatherTreeNodeLookup.get(pathNode.tile);
      if (currentGatherTreeNode === undefined || currentGatherTreeNode === null) {
        // 原版这里在非 force 模式直接抛断言；真实对局走 force=False 会炸，这里按 force 的
        // 兜底路径建一个根节点，保证不中断（原版 force 分支做的事完全一样）。
        currentGatherTreeNode = nodeOf(pathNode.tile, null, distance);
        gatherTreeNodeLookup.set(pathNode.tile, currentGatherTreeNode);
      }

      var gatherTreeNodePathAddingOnTo = currentGatherTreeNode;
      var runningValue = valuePerTurnPath.value;
      var runningTrunkDist = gatherTreeNodePathAddingOnTo.trunkDistance || 0;
      var runningTrunkValue = gatherTreeNodePathAddingOnTo.trunkValue || 0;

      pathNode = pathNode.next;
      var iter = 0;
      while (pathNode !== null && pathNode !== undefined) {
        iter += 1;
        if (iter > 600) throw new Error('Infinite looped in extend_tree_node_lookup');
        runningTrunkDist += 1;
        var newDist = distance + addlDist;
        distanceLookup.set(pathNode.tile, newDist);

        var nextGatherTreeNode = nodeOf(pathNode.tile, currentGatherTreeNode.tile, newDist);
        var tileEffect = 1;
        var pTile = pathNode.tile;

        if (negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(pTile)) {
          var pPlayer = playerOfM(pTile);
          if (teams[pPlayer] === teams[searchingPlayer]) {
            tileEffect -= pTile.army;
          } else if (useTrueValueGathered) {
            tileEffect += pTile.army;
          }
        }

        runningTrunkValue -= tileEffect;
        nextGatherTreeNode.value = runningValue;
        nextGatherTreeNode.trunkValue = runningTrunkValue;
        nextGatherTreeNode.trunkDistance = runningTrunkDist;
        nextGatherTreeNode.gatherTurns = valuePerTurnPath.length - addlDist + 1;
        runningValue += tileEffect;
        if (priorityMatrix) runningValue -= priorityMatrix.raw[pTile.tile_index];

        var alreadyThere = false;
        for (var ci = 0; ci < currentGatherTreeNode.children.length; ci++) {
          if (currentGatherTreeNode.children[ci].tile === nextGatherTreeNode.tile) {
            alreadyThere = true;
            break;
          }
        }
        if (!alreadyThere) {
          currentGatherTreeNode.children.push(nextGatherTreeNode);
          for (var pri = 0; pri < currentGatherTreeNode.pruned.length; pri++) {
            if (currentGatherTreeNode.pruned[pri].tile === nextGatherTreeNode.tile) {
              currentGatherTreeNode.pruned.splice(pri, 1);
              break;
            }
          }
        }
        currentGatherTreeNode = nextGatherTreeNode;
        gatherTreeNodeLookup.set(pTile, currentGatherTreeNode);
        addlDist += 1;
        pathNode = pathNode.next;
      }

      // 把这条路径的价值/回合数往根方向冒泡（原版注释：bubble the value of the path and turns up the tree）
      var curGatherTreeNode = gatherTreeNodePathAddingOnTo;
      var biter = 0;
      while (true) {
        biter += 1;
        curGatherTreeNode.value += valuePerTurnPath.value;
        curGatherTreeNode.gatherTurns += valuePerTurnPath.length;
        if (curGatherTreeNode.toTile === null) break;

        var nextNode = gatherTreeNodeLookup.get(curGatherTreeNode.toTile);
        if (nextNode !== null && nextNode !== undefined && nextNode.toTile === curGatherTreeNode.tile) {
          // 原版这里发现环就把 toTile 置空并 break
          curGatherTreeNode.toTile = null;
          break;
        }
        if (biter > 600 && nextNode) throw new Error('Infinite looped in extend_tree_node_lookup (bubble)');
        if (nextNode === null || nextNode === undefined) break;
        curGatherTreeNode = nextNode;
      }
    }

    return gatherTreeNodeLookup;
  }

  // GatherMaxIterative.py:536
  function add_tree_nodes_to_start_tiles_dict_recurse_max(rootNode, startTilesDict,
    searchingPlayer, remainingTurns, baseCaseFunc, dist) {

    void searchingPlayer; void remainingTurns;
    var added = 0;
    var entry = startTilesDict.get(rootNode.tile);
    if (entry === undefined || entry === null) {
      startTilesDict.set(rootNode.tile, [baseCaseFunc(rootNode.tile, dist), dist]);
      added += 1;
    }
    for (var i = 0; i < rootNode.children.length; i++) {
      added += add_tree_nodes_to_start_tiles_dict_recurse_max(rootNode.children[i], startTilesDict,
        searchingPlayer, remainingTurns, baseCaseFunc, dist + 1);
    }
    return added;
  }

  // GatherMaxIterative.py:778
  function knapsack_max_gather_iterative_prune(itr, map, startTilesDict, cutoffTime, remainingTurns,
    fullTurns, targetArmy, valueFunc, baseCaseFunc, pathValueFunc, negativeTiles, skipTiles,
    searchingPlayer, priorityFunc, skipFunc, perIterationFunc, priorityTiles, ignoreStartTile,
    incrementBackward, preferNeutral, viewInfo, distPriorityMap, useTrueValueGathered,
    priorityMatrix, logEntries, includeGatherTreeNodesThatGatherNegative, shouldLog, fastMode, slowMode) {

    var origStartTilesDict = new Map(startTilesDict);

    // 注意 Max 版的分母与 Set 版不同：//2 起步、fastMode 用 3*fullTurns//4
    var maxPerIteration = Math.max(Math.min(4, Math.floor(fullTurns / 2)), Math.floor(fullTurns / 4));
    if (fastMode) maxPerIteration = Math.max(Math.min(7, Math.floor(3 * fullTurns / 4)), Math.floor(fullTurns / 2));

    var teams = teamsOf(map);
    var standardMode = !fastMode && !slowMode;

    var turnsSoFar = 0;
    var totalValue = 0;
    var newStartTilesDict = new Map(startTilesDict);
    var gatherTreeNodeLookup = new Map();
    startTilesDict.forEach(function (data, tile) {
      gatherTreeNodeLookup.set(tile, nodeOf(tile, null, data[1]));
    });

    var lastPrunedTo = 0;
    if (logEntries === null || logEntries === undefined) logEntries = [];
    var startTime = Date.now() / 1000;

    var totalTurns = 0;
    var rootNodes = [];

    while (lastPrunedTo < fullTurns) {
      itr.add(1);
      var turnsToGather = fullTurns - turnsSoFar;
      logEntries.push('Sub Knap (iter ' + itr.value + ' ' + ((Date.now() / 1000 - startTime) * 1000).toFixed(1) + 'ms in) turns ' + turnsToGather);

      if (perIterationFunc) perIterationFunc(newStartTilesDict);

      var subRes = get_sub_knapsack_max_gather(
        map, newStartTilesDict, valueFunc, baseCaseFunc, pathValueFunc, 1000, turnsToGather,
        fullTurns, true, negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc, true,
        incrementBackward, preferNeutral, logEntries, useTrueValueGathered, priorityMatrix, shouldLog);

      var newGatheredArmy = subRes[0];
      var newPaths = subRes[1];

      if (newPaths.length === 0) {
        logEntries.push('no new paths found, breaking knapsack stuff');
        break;
      }

      extend_tree_node_lookup(newPaths, gatherTreeNodeLookup, newStartTilesDict, searchingPlayer,
        teams, negativeTiles, logEntries, useTrueValueGathered, shouldLog, false, priorityMatrix);

      var turnsUsedByNewPaths = 0;
      for (var i = 0; i < newPaths.length; i++) turnsUsedByNewPaths += newPaths[i].length;
      var calculatedLeftOverTurns = remainingTurns - turnsUsedByNewPaths;

      for (var j = 0; j < newPaths.length; j++) {
        var rootNode = gatherTreeNodeLookup.get(newPaths[j].start.tile);
        if (rootNode !== null && rootNode !== undefined) {
          var entry = newStartTilesDict.get(rootNode.tile);
          add_tree_nodes_to_start_tiles_dict_recurse_max(rootNode, newStartTilesDict,
            searchingPlayer, calculatedLeftOverTurns, baseCaseFunc, entry[1]);
        }
      }

      rootNodes = [];
      origStartTilesDict.forEach(function (_v, tile) {
        var g = gatherTreeNodeLookup.get(tile);
        if (g !== null && g !== undefined) rootNodes.push(g);
      });

      totalTurns = turnsUsedByNewPaths + turnsSoFar;

      var now = clockNowSec();
      if (cutoffTime !== Infinity && now > cutoffTime) {
        if (totalTurns === fullTurns || itr.value > 4) break;
        maxPerIteration = maxPerIteration + 1;
        if (totalTurns === fullTurns && itr.value > 2) break;
      }

      if (itr.value > 1 && maxPerIteration > 1) {
        if (fastMode) maxPerIteration = Math.floor(3 * maxPerIteration / 4) + 1;
        else if (!slowMode) maxPerIteration = Math.floor(3 * maxPerIteration / 5) + 1;
        else maxPerIteration = 1;
      }

      var wouldBeNextTurnsLeft = fullTurns - (lastPrunedTo + maxPerIteration);
      if (maxPerIteration > 1) {
        if (standardMode) {
          var maxItCutoff = maxPerIteration;
          if (wouldBeNextTurnsLeft < maxItCutoff) maxPerIteration = Math.max(1, Math.floor(maxPerIteration / 2));
        } else {
          var maxItCutoff2 = Math.floor(maxPerIteration / 2);
          if (wouldBeNextTurnsLeft <= maxItCutoff2) maxPerIteration = Math.floor(maxPerIteration / 2) + 1;
        }
      }
      if (maxPerIteration < 1) maxPerIteration = 1;

      var pruneToTurns = lastPrunedTo + maxPerIteration;
      var overpruneCutoff = Math.max(Math.floor(pruneToTurns / 2), lastPrunedTo - maxPerIteration);

      var GP = need('EK.GatherPrune', EK.GatherPrune);
      var pruned = GP.prune_mst_to_turns_with_values(rootNodes, pruneToTurns, searchingPlayer,
        viewInfo, !shouldLog, gatherTreeNodeLookup, newStartTilesDict, null, null, null,
        includeGatherTreeNodesThatGatherNegative, overpruneCutoff, logEntries, false);

      totalTurns = pruned[0];
      totalValue = pruned[1];
      rootNodes = pruned[2];

      lastPrunedTo = pruneToTurns;
      turnsSoFar = totalTurns;
      void newGatheredArmy;
    }

    void targetArmy; void priorityTiles; void ignoreStartTile; void distPriorityMap;
    return [totalValue, rootNodes];
  }

  // ---------------------------------------------------------------------------
  // 入口：GatherMaxIterative.knapsack_max_gather / knapsack_max_gather_with_values
  // ---------------------------------------------------------------------------
  function knapsack_max_gather_with_values(map, startTiles, turns, targetArmy, valueFunc,
    baseCaseFunc, pathValueFunc, negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc,
    perIterationFunc, priorityTiles, ignoreStartTile, incrementBackward, preferNeutral, viewInfo,
    distPriorityMap, useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, shouldLog,
    useRecurse, priorityMatrix, cutoffTime, fastMode, slowMode) {

    if (ignoreStartTile === undefined) ignoreStartTile = false;
    if (incrementBackward === undefined) incrementBackward = true;
    if (preferNeutral === undefined) preferNeutral = false;
    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (includeGatherTreeNodesThatGatherNegative === undefined) includeGatherTreeNodesThatGatherNegative = false;
    if (shouldLog === undefined) shouldLog = false;
    if (fastMode === undefined) fastMode = false;
    if (slowMode === undefined) slowMode = false;
    if (cutoffTime === undefined) cutoffTime = Infinity;  // 不拿时钟当决策输入；要限时就显式传一个秒级时间戳

    var teams = teamsOf(map);

    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();
    else negativeTiles = new Set(negativeTiles);

    if (searchingPlayer === undefined || searchingPlayer === null || searchingPlayer === -2) {
      if (startTiles instanceof Map) {
        var first = null;
        startTiles.forEach(function (_v, k) { if (first === null) first = k; });
        searchingPlayer = first ? playerOfM(first) : -2;
      } else {
        searchingPlayer = startTiles.length > 0 ? playerOfM(startTiles[0]) : -2;
      }
    }

    var logEntries = [];
    var friendlyPlayers = map.get_teammates(searchingPlayer);

    if (valueFunc === null || valueFunc === undefined) {
      valueFunc = function (currentTile, priorityObject) {
        var realDist = priorityObject[2];
        var negGatheredSum = priorityObject[3];
        var negArmySum = priorityObject[4];
        if (negArmySum >= 0 && !includeGatherTreeNodesThatGatherNegative) return null;
        if (negGatheredSum >= 0) return null;
        if (currentTile.army < 2 || playerOfM(currentTile) !== searchingPlayer) return null;
        var val = -1000;
        if (realDist > 0) val = 0 - negGatheredSum;
        return [val, 0 - negGatheredSum, 0 - negArmySum, realDist];
      };
    }

    if (pathValueFunc === null || pathValueFunc === undefined) {
      pathValueFunc = function (path, valueObj) { void path; return valueObj[1]; };
    }

    if (priorityFunc === null || priorityFunc === undefined) {
      // 与 Set 版的区别：+1 起步、swamp 惩罚、prioVal 里带 0.05*realDist² 的「往远处走」项
      priorityFunc = function (nextTile, currentPriorityObject) {
        var realDist = currentPriorityObject[2];
        var negGatheredSum = currentPriorityObject[3];
        var negArmySum = currentPriorityObject[4];
        var numPrioTiles = currentPriorityObject[5];

        negArmySum += 1;
        negGatheredSum += 1;
        if (nextTile.isSwamp) {
          if (playerOfM(nextTile) !== searchingPlayer || nextTile.army === 1) {
            negArmySum += 1;
            negGatheredSum += 1;
            realDist += 4;
            numPrioTiles -= 2;
          }
        }
        if (!negativeTiles.has(nextTile)) {
          var np = playerOfM(nextTile);
          if (friendlyPlayers.indexOf(np) !== -1) {
            negArmySum -= nextTile.army;
            negGatheredSum -= nextTile.army;
          } else {
            negArmySum += nextTile.army;
            if (useTrueValueGathered) negGatheredSum += nextTile.army;
          }
        }
        if (priorityMatrix) negGatheredSum -= priorityMatrix.raw[nextTile.tile_index];
        if (priorityTiles && priorityTiles.has(nextTile)) numPrioTiles += 1;
        realDist += 1;
        var prioVal = -100000;
        if (realDist > 0) prioVal = 10000 + negGatheredSum / realDist + 0.05 * (realDist * realDist);
        return [prioVal, 0 - numPrioTiles / Math.max(1, realDist), realDist, negGatheredSum, negArmySum, numPrioTiles];
      };
    }

    if (baseCaseFunc === null || baseCaseFunc === undefined) {
      baseCaseFunc = function (tile, startingDist) {
        void tile; void startingDist;
        return [-100000000000.0, 0, 0, 0, 0, 0];
      };
    }

    var startTilesDict = new Map();
    if (startTiles instanceof Map) {
      var allNumbers = true;
      startTiles.forEach(function (v) { if (typeof v !== 'number') allNumbers = false; });
      if (allNumbers) {
        startTiles.forEach(function (distance, tile) {
          startTilesDict.set(tile, [baseCaseFunc(tile, distance), distance]);
          negativeTiles.add(tile);
        });
      } else {
        startTilesDict = startTiles;
        startTilesDict.forEach(function (_v, tile) { negativeTiles.add(tile); });
      }
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        startTilesDict.set(startTiles[i], [baseCaseFunc(startTiles[i], 0), 0]);
        negativeTiles.add(startTiles[i]);
      }
    }

    var itr = new Counter(0);
    var totalValue, rootNodes;

    if (!useRecurse) {
      var res = knapsack_max_gather_iterative_prune(itr, map, startTilesDict, cutoffTime, turns, turns,
        targetArmy, valueFunc, baseCaseFunc, pathValueFunc, negativeTiles, skipTiles, searchingPlayer,
        priorityFunc, skipFunc, perIterationFunc, priorityTiles, ignoreStartTile, incrementBackward,
        preferNeutral, viewInfo, distPriorityMap, useTrueValueGathered, priorityMatrix, logEntries,
        includeGatherTreeNodesThatGatherNegative, shouldLog, fastMode, slowMode);
      totalValue = res[0];
      rootNodes = res[1];
    } else {
      // 原版 useRecurse=True 走 _knapsack_max_gather_recurse。bot 的两个调用点都不传 useRecurse，
      // 这条分支从不执行，所以没搬（真要搬得把 _knapsack_max_gather_recurse 一起移植）。
      throw new Error('gathermax.js: knapsack_max_gather_with_values(useRecurse=true) 未移植');
    }

    var totalTurns = 0;
    for (var r = 0; r < rootNodes.length; r++) totalTurns += rootNodes[r].gatherTurns;

    void teams; void logEntries;
    GatherMaxIterative.last_iterations = itr.value;
    return [totalValue, totalTurns, rootNodes];
  }

  // GatherMaxIterative.py:1154 —— 只返回 rootNodes。调用点 gatherops.js:1135 / botmain.js:1721。
  function knapsack_max_gather(map, startTiles, turns, targetArmy, valueFunc, baseCaseFunc,
    negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc, priorityTiles,
    ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
    useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, priorityMatrix, cutoffTime,
    shouldLog, fastMode) {

    if (ignoreStartTile === undefined) ignoreStartTile = true;

    // 也允许按名调用：形参有 20 多个位置，调用方（对拍脚本 / 未来接线）按位置写极易错位
    if (map !== null && typeof map === 'object' && map.tile_index === undefined && map.map !== undefined) {
      var ao = map;
      return knapsack_max_gather(ao.map, ao.startTiles, ao.turns, ao.targetArmy, ao.valueFunc,
        ao.baseCaseFunc, ao.negativeTiles, ao.skipTiles, ao.searchingPlayer, ao.priorityFunc,
        ao.skipFunc, ao.priorityTiles, ao.ignoreStartTile, ao.incrementBackward, ao.preferNeutral,
        ao.viewInfo, ao.distPriorityMap, ao.useTrueValueGathered,
        ao.includeGatherTreeNodesThatGatherNegative, ao.priorityMatrix, ao.cutoffTime,
        ao.shouldLog, ao.fastMode);
    }

    var res = knapsack_max_gather_with_values(map, startTiles, turns, targetArmy, valueFunc,
      baseCaseFunc, null, negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc, null,
      priorityTiles, ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
      useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, shouldLog, false,
      priorityMatrix, cutoffTime, fastMode, false);

    return res[2];
  }

  GatherMaxIterative.knapsack_max_gather = knapsack_max_gather;
  GatherMaxIterative.knapsack_max_gather_with_values = knapsack_max_gather_with_values;
  GatherMaxIterative.last_iterations = 0;
  GatherMaxIterative._extend_tree_node_lookup = extend_tree_node_lookup;

  // ===========================================================================
  // GatherDepthIterative（GatherDepthIterative.py 1681 行）
  // 与 Max 版的差别（照抄时必须分清，别当成同一份）：
  //   1) BFS 的 maxDepth 是 fullTurns 而不是 10000/10000000 —— 这是「depth」的由来，
  //      它把搜索限制在回合预算深度内，所以每个节点都要带 depthDist。
  //   2) 优先级对象是 8 元组 (depthHeuristicDist, depthDist, realDist, threatDist,
  //      negPrioTilesPerTurn, negGatheredSum, negArmySum, numPrioTiles)。
  //   3) 剪枝时多传 parentPruneFunc = _start_tiles_prune_helper(startTilesDict, ...)，
  //      用被剪节点的 gatherTurns 反向修正原始起点字典里的 distance。
  //   4) `_get_sub_knapsack_gather` 没有「起点太少退化成单路径」那一支（原版注释掉了）。
  // ===========================================================================
  function get_sub_knapsack_gather_depth(map, startTilesDict, valueFunc, baseCaseFunc,
    pathValueFunc, maxTime, remainingTurns, fullTurns, noNeutralCities, negativeTiles, skipTiles,
    searchingPlayer, priorityFunc, skipFunc, ignoreStartTile, incrementBackward, preferNeutral,
    logEntries, useTrueValueGathered, priorityMatrix, shouldLog) {

    void maxTime; void noNeutralCities; void baseCaseFunc;
    var S = need('EK.search', EK.search);
    var valuePerTurnPathPerTilePerDistance = S.breadth_first_dynamic_max_per_tile_per_distance_global_visited(
      map, startTilesDict, valueFunc, {
        maxTurns: remainingTurns,
        // 关键差异：depth 版把深度压在回合预算上，Max 版给的是 10000
        maxDepth: fullTurns,
        noNeutralCities: true,
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: skipFunc,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        ignoreNonPlayerArmy: !useTrueValueGathered,
        ignoreIncrement: true,
        pathValueFunc: pathValueFunc
      });

    var res = knapsack_max_set_gather_iteration(remainingTurns, valuePerTurnPathPerTilePerDistance,
      shouldLog ? logEntries : null);
    void priorityMatrix;
    return [Math.round(res[0]), res[1]];
  }

  // GatherDepthIterative.py:1090
  function start_tiles_prune_helper(startTilesDict, parentTile, gatherNodeBeingPruned) {
    var entry = startTilesDict.get(parentTile);
    if (entry !== undefined && entry !== null) {
      startTilesDict.set(parentTile, [entry[0], entry[1] - gatherNodeBeingPruned.gatherTurns]);
    }
  }

  // GatherDepthIterative.py:751
  function knapsack_levels_gather_iterative_depth_prune(itr, map, startTilesDict, cutoffTime,
    remainingTurns, fullTurns, targetArmy, valueFunc, baseCaseFunc, pathValueFunc, negativeTiles,
    skipTiles, searchingPlayer, priorityFunc, skipFunc, perIterationFunc, priorityTiles,
    ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
    useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, priorityMatrix, logEntries,
    shouldLog, fastMode, slowMode) {

    var origStartTilesDict = new Map(startTilesDict);

    var maxPerIteration = Math.max(Math.min(4, Math.floor(fullTurns / 2)), Math.floor(fullTurns / 4));
    if (fastMode) maxPerIteration = Math.max(Math.min(7, Math.floor(3 * fullTurns / 4)), Math.floor(fullTurns / 2));

    var teams = teamsOf(map);
    var standardMode = !fastMode && !slowMode;

    var turnsSoFar = 0;
    var totalValue = 0;
    var newStartTilesDict = new Map(startTilesDict);
    var gatherTreeNodeLookup = new Map();
    startTilesDict.forEach(function (data, tile) {
      gatherTreeNodeLookup.set(tile, nodeOf(tile, null, data[1]));
    });

    var lastPrunedTo = 0;
    if (logEntries === null || logEntries === undefined) logEntries = [];
    var startTime = Date.now() / 1000;

    var rootNodes = [];
    var totalTurns = 0;

    while (lastPrunedTo < fullTurns) {
      itr.add(1);
      var turnsToGather = fullTurns - turnsSoFar;
      logEntries.push('Sub Knap (iter ' + itr.value + ' ' + ((Date.now() / 1000 - startTime) * 1000).toFixed(1) + 'ms in) turns ' + turnsToGather);

      if (perIterationFunc) perIterationFunc(newStartTilesDict);
      // 原版的死循环护栏：超过 250 轮直接抛，这里保留同阈值以免静默跑飞
      if (itr.value > 250) {
        throw new Error('Infinite looped :( fullTurns ' + fullTurns + ', turnsSoFar ' + turnsSoFar +
          ', turnsToGather ' + turnsToGather + ', lastPrunedTo ' + lastPrunedTo);
      }

      var subRes = get_sub_knapsack_gather_depth(map, newStartTilesDict, valueFunc, baseCaseFunc,
        pathValueFunc, 1000, turnsToGather, fullTurns, true, negativeTiles, skipTiles,
        searchingPlayer, priorityFunc, skipFunc, true, incrementBackward, preferNeutral,
        logEntries, useTrueValueGathered, priorityMatrix, shouldLog);

      var newGatheredArmy = subRes[0];
      var newPaths = subRes[1];

      if (newPaths.length === 0) {
        logEntries.push('no new paths found, breaking knapsack stuff');
        break;
      }

      extend_tree_node_lookup(newPaths, gatherTreeNodeLookup, newStartTilesDict, searchingPlayer,
        teams, negativeTiles, logEntries, useTrueValueGathered, shouldLog, false, priorityMatrix);

      var turnsUsedByNewPaths = 0;
      for (var i = 0; i < newPaths.length; i++) turnsUsedByNewPaths += newPaths[i].length;
      var calculatedLeftOverTurns = remainingTurns - turnsUsedByNewPaths;

      for (var j = 0; j < newPaths.length; j++) {
        var rootNode = gatherTreeNodeLookup.get(newPaths[j].start.tile);
        if (rootNode !== null && rootNode !== undefined) {
          var tEntry = newStartTilesDict.get(rootNode.tile);
          add_tree_nodes_to_start_tiles_dict_recurse_max(rootNode, newStartTilesDict,
            searchingPlayer, calculatedLeftOverTurns, baseCaseFunc, tEntry[1]);
        }
      }

      rootNodes = [];
      origStartTilesDict.forEach(function (_v, tile) {
        var g = gatherTreeNodeLookup.get(tile);
        if (g !== null && g !== undefined) rootNodes.push(g);
      });

      totalTurns = turnsUsedByNewPaths + turnsSoFar;

      var now = clockNowSec();
      if (cutoffTime !== Infinity && now > cutoffTime) {
        if (totalTurns === fullTurns || itr.value > 4) break;
        maxPerIteration = maxPerIteration + 1;
        if (totalTurns === fullTurns && itr.value > 2) break;
      }

      if (itr.value > 1 && maxPerIteration > 1) {
        if (fastMode) maxPerIteration = Math.floor(3 * maxPerIteration / 4) + 1;
        else if (!slowMode) maxPerIteration = Math.floor(3 * maxPerIteration / 5) + 1;
        else maxPerIteration = 1;
      }

      var wouldBeNextTurnsLeft = fullTurns - (lastPrunedTo + maxPerIteration);
      if (maxPerIteration > 1) {
        if (standardMode) {
          if (wouldBeNextTurnsLeft < maxPerIteration) {
            maxPerIteration = Math.max(1, Math.floor(maxPerIteration / 2));
          }
        } else {
          var maxItCutoff2 = Math.floor(maxPerIteration / 2);
          if (wouldBeNextTurnsLeft <= maxItCutoff2) maxPerIteration = Math.floor(maxPerIteration / 2) + 1;
        }
      }
      if (maxPerIteration < 1) maxPerIteration = 1;

      var pruneToTurns = lastPrunedTo + maxPerIteration;
      var overpruneCutoff = Math.max(Math.floor(pruneToTurns / 2), lastPrunedTo - maxPerIteration);

      // 这里的 parentPruneFunc 用**原始** startTilesDict（原版就是这么传的），
      // 它把被剪节点的 gatherTurns 从起点 distance 里扣掉，供下一轮 baseCaseFunc 用。
      var GP = need('EK.GatherPrune', EK.GatherPrune);
      var pruned = GP.prune_mst_to_turns_with_values(rootNodes, pruneToTurns, searchingPlayer,
        viewInfo, !shouldLog, gatherTreeNodeLookup, newStartTilesDict, null, null,
        function (t, prunedNode) { start_tiles_prune_helper(startTilesDict, t, prunedNode); },
        includeGatherTreeNodesThatGatherNegative, overpruneCutoff, logEntries, false);

      totalTurns = pruned[0];
      totalValue = pruned[1];
      rootNodes = pruned[2];

      lastPrunedTo = pruneToTurns;
      turnsSoFar = totalTurns;
      void newGatheredArmy;
    }

    void targetArmy; void priorityTiles; void ignoreStartTile; void distPriorityMap;
    return [totalValue, rootNodes];
  }

  // GatherDepthIterative.py:1222
  function knapsack_depth_gather_with_values(map, startTiles, turns, targetArmy, valueFunc,
    baseCaseFunc, pathValueFunc, negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc,
    perIterationFunc, priorityTiles, ignoreStartTile, incrementBackward, preferNeutral, viewInfo,
    distPriorityMap, depthPriorityMap, useTrueValueGathered,
    includeGatherTreeNodesThatGatherNegative, shouldLog, useRecurse, priorityMatrix, cutoffTime,
    fastMode, slowMode) {

    if (ignoreStartTile === undefined) ignoreStartTile = false;
    if (incrementBackward === undefined) incrementBackward = true;
    if (preferNeutral === undefined) preferNeutral = false;
    if (useTrueValueGathered === undefined) useTrueValueGathered = false;
    if (includeGatherTreeNodesThatGatherNegative === undefined) includeGatherTreeNodesThatGatherNegative = false;
    if (shouldLog === undefined) shouldLog = false;
    if (fastMode === undefined) fastMode = false;
    if (slowMode === undefined) slowMode = false;
    if (cutoffTime === undefined) cutoffTime = Infinity;  // 不拿时钟当决策输入；要限时就显式传一个秒级时间戳

    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();
    else negativeTiles = new Set(negativeTiles);

    var teams = teamsOf(map);
    var friendlyPlayers = map.get_teammates(searchingPlayer);

    if (searchingPlayer === undefined || searchingPlayer === null || searchingPlayer === -2) {
      if (startTiles instanceof Map) {
        var firstTile = null;
        startTiles.forEach(function (_v, k) { if (firstTile === null) firstTile = k; });
        searchingPlayer = firstTile ? playerOfM(firstTile) : -2;
      } else {
        searchingPlayer = startTiles.length > 0 ? playerOfM(startTiles[0]) : -2;
      }
      friendlyPlayers = map.get_teammates(searchingPlayer);
    }

    var logEntries = [];
    // depth 版的 valueFunc/baseCaseFunc 靠这张表在「同一格不同深度」之间共享优先级对象；
    // perIterationFunc 每轮清空，这是原版的剪枝手段，漏掉会让搜索深度行为完全不同。
    var priosByTile = new Map();

    if (valueFunc === null || valueFunc === undefined) {
      valueFunc = function (currentTile, priorityObject) {
        var depthHeuristicDist = priorityObject[0];
        var depthDist = priorityObject[1];
        var realDist = priorityObject[2];
        var threatDist = priorityObject[3];
        var negGatheredSum = priorityObject[5];
        var negArmySum = priorityObject[6];

        priosByTile.set(currentTile.tile_index + ':' + depthDist, priorityObject);

        if (negArmySum >= 0 && !includeGatherTreeNodesThatGatherNegative) return null;
        if (negGatheredSum >= 0) return null;
        if (currentTile.army < 2 || playerOfM(currentTile) !== searchingPlayer) return null;

        var value = 0 - negGatheredSum;
        var val = 0;
        if (realDist > 0) val = value;

        return [val, 0 - realDist, 0 - depthHeuristicDist, 0 - threatDist,
          0 - negGatheredSum, 0 - depthDist];
      };
    }

    if (pathValueFunc === null || pathValueFunc === undefined) {
      pathValueFunc = function (path, valueObj) {
        void path;
        return valueObj[4];
      };
    }

    if (priorityFunc === null || priorityFunc === undefined) {
      priorityFunc = function (nextTile, currentPriorityObject) {
        var depthHeuristicDist = currentPriorityObject[0];
        var depthDist = currentPriorityObject[1];
        var realDist = currentPriorityObject[2];
        var threatDist = currentPriorityObject[3];
        var negGatheredSum = currentPriorityObject[5];
        var negArmySum = currentPriorityObject[6];
        var numPrioTiles = currentPriorityObject[7];

        negArmySum += 1;
        negGatheredSum += 1;
        if (nextTile.isSwamp) {
          negArmySum += 2;
          negGatheredSum += 2;
        }
        if (!negativeTiles.has(nextTile)) {
          var np = playerOfM(nextTile);
          if (friendlyPlayers.indexOf(np) !== -1) {
            negArmySum -= nextTile.army;
            negGatheredSum -= nextTile.army;
          } else {
            negArmySum += nextTile.army;
            if (useTrueValueGathered) negGatheredSum += nextTile.army;
          }
        }
        if (priorityMatrix) negGatheredSum -= priorityMatrix.raw[nextTile.tile_index];
        if (priorityTiles && priorityTiles.has(nextTile)) numPrioTiles += 1;
        realDist += 1;
        depthDist += 1;
        depthHeuristicDist = depthDist;
        if (depthPriorityMap) depthHeuristicDist += depthPriorityMap.raw[nextTile.tile_index];

        return [depthHeuristicDist, depthDist, realDist, threatDist + 1,
          0 - numPrioTiles / Math.max(1, realDist), negGatheredSum, negArmySum, numPrioTiles];
      };
    }

    if (baseCaseFunc === null || baseCaseFunc === undefined) {
      baseCaseFunc = function (tile, startingDist) {
        var initialDistance = 0;
        if (distPriorityMap) initialDistance = distPriorityMap.raw[tile.tile_index];
        var depthHeuristicDist = startingDist;
        if (depthPriorityMap) depthHeuristicDist += depthPriorityMap.raw[tile.tile_index];
        var armyNegSum = 0;
        var gathNegSum = 0;
        if (useTrueValueGathered && friendlyPlayers.indexOf(playerOfM(tile)) === -1) {
          gathNegSum += tile.army;
          armyNegSum += tile.army;
        }
        var prioObj = [depthHeuristicDist, startingDist, 0, 0 - initialDistance, 0,
          gathNegSum, armyNegSum, 0];

        var fromPrio = priosByTile.get(tile.tile_index + ':' + startingDist);
        if (fromPrio !== undefined && fromPrio !== null) {
          prioObj = [fromPrio[0], fromPrio[1], 0, fromPrio[3], 0, 0, 0, 0];
        }
        return prioObj;
      };

      perIterationFunc = function () { priosByTile.clear(); };
    }

    var startTilesDict = new Map();
    if (startTiles instanceof Map) {
      var allNumbers = true;
      startTiles.forEach(function (v) { if (typeof v !== 'number') allNumbers = false; });
      if (allNumbers) {
        startTiles.forEach(function (distance, tile) {
          startTilesDict.set(tile, [baseCaseFunc(tile, distance), distance]);
          negativeTiles.add(tile);
        });
      } else {
        startTilesDict = startTiles;
        startTilesDict.forEach(function (_v, tile) { negativeTiles.add(tile); });
      }
    } else {
      for (var si = 0; si < startTiles.length; si++) {
        startTilesDict.set(startTiles[si], [baseCaseFunc(startTiles[si], 0), 0]);
        negativeTiles.add(startTiles[si]);
      }
    }

    var itr = new Counter(0);

    if (useRecurse) {
      // 原版 useRecurse=True 走 _knapsack_levels_gather_recurse（深度递归版）。bot 的两个
      // 调用点都不传 useRecurse，这条分支从不执行，所以没搬。
      throw new Error('gathermax.js: knapsack_depth_gather_with_values(useRecurse=true) 未移植');
    }

    var prunedRes = knapsack_levels_gather_iterative_depth_prune(itr, map, startTilesDict,
      cutoffTime, turns, turns, targetArmy, valueFunc, baseCaseFunc, pathValueFunc, negativeTiles,
      skipTiles, searchingPlayer, priorityFunc, skipFunc, perIterationFunc, priorityTiles,
      ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
      useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, priorityMatrix, logEntries,
      shouldLog, fastMode, slowMode);

    var totalValue = prunedRes[0];
    var rootNodes = prunedRes[1];

    var totalTurns = 0;
    for (var r = 0; r < rootNodes.length; r++) totalTurns += rootNodes[r].gatherTurns;

    void teams;
    GatherDepthIterative.last_iterations = itr.value;
    return [totalValue, totalTurns, rootNodes];
  }

  // GatherDepthIterative.py:1128 —— 只返回 rootNodes。调用点 BotGatherOps.py:646 / bot_ek0x45.py:1578
  function knapsack_depth_gather(map, startTiles, turns, targetArmy, valueFunc, baseCaseFunc,
    pathValueFunc, negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc,
    perIterationFunc, priorityTiles, ignoreStartTile, incrementBackward, preferNeutral, viewInfo,
    distPriorityMap, depthPriorityMap, useTrueValueGathered,
    includeGatherTreeNodesThatGatherNegative, shouldLog, priorityMatrix, cutoffTime, fastMode,
    slowMode) {

    // 同上：按名调用支持（depth 版比 max 版多 depthPriorityMap，位置更容易错）
    if (map !== null && typeof map === 'object' && map.tile_index === undefined && map.map !== undefined) {
      var ao = map;
      return knapsack_depth_gather(ao.map, ao.startTiles, ao.turns, ao.targetArmy, ao.valueFunc,
        ao.baseCaseFunc, ao.pathValueFunc, ao.negativeTiles, ao.skipTiles, ao.searchingPlayer,
        ao.priorityFunc, ao.skipFunc, ao.perIterationFunc, ao.priorityTiles, ao.ignoreStartTile,
        ao.incrementBackward, ao.preferNeutral, ao.viewInfo, ao.distPriorityMap,
        ao.depthPriorityMap, ao.useTrueValueGathered,
        ao.includeGatherTreeNodesThatGatherNegative, ao.shouldLog, ao.priorityMatrix,
        ao.cutoffTime, ao.fastMode, ao.slowMode);
    }

    var res = knapsack_depth_gather_with_values(map, startTiles, turns, targetArmy, valueFunc,
      baseCaseFunc, pathValueFunc, negativeTiles, skipTiles, searchingPlayer, priorityFunc,
      skipFunc, perIterationFunc, priorityTiles, ignoreStartTile, incrementBackward, preferNeutral,
      viewInfo, distPriorityMap, depthPriorityMap, useTrueValueGathered,
      includeGatherTreeNodesThatGatherNegative, shouldLog, false, priorityMatrix, cutoffTime,
      fastMode, slowMode);
    return res[2];
  }

  GatherDepthIterative.knapsack_depth_gather = knapsack_depth_gather;
  GatherDepthIterative.knapsack_depth_gather_with_values = knapsack_depth_gather_with_values;
  GatherDepthIterative.last_iterations = 0;

  EK.GatherMaxSetInternals = {
    knapsack_max_set_gather_iteration: knapsack_max_set_gather_iteration,
    get_sub_knapsack_max_set_gather: get_sub_knapsack_max_set_gather,
    get_single_line_iterative_starter_max_set: get_single_line_iterative_starter_max_set,
    build_next_level_start_dict_max_set: build_next_level_start_dict_max_set,
    knapsack_max_set_gather_iterative_prune: knapsack_max_set_gather_iterative_prune,
    Counter: Counter,
    pyLess: pyLess,
    pyEq: pyEq,
    heapPush: heapPush,
    heapPop: heapPop,
    tilesAsc: tilesAsc,
    countWhere: countWhere,
    sumOf: sumOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

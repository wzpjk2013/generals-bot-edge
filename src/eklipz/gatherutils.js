/* GatherUtils —— Gather/GatherUtils.py（1634 行）的 JS 移植。
 *
 * 原版算法：一组「把若干块相连 tile 变成可执行 gather 计划」的构造器。每条主链都是
 * 「先算出一块要占据的 tile 集合（PCST / Steiner / MST / 贪心装箱）→ 把这块集合
 * 连成一棵树 → 用 GatherCapturePlan.build_from_root_nodes 把树变成带回合数、
 * 兵数、经济价值的计划」。树形决定之后每一 tick 的出招，所以这里所有「队列里先放
 * 哪一格、平局怎么排」的顺序都必须与原版一致。
 *
 * 函数来源与归属（哪些直接复用 src/eklipz/gather.js 已有的同源实现）：
 *   gather_approximate_turns_to_tiles            ← 本文件（gather.js 里没有）
 *   greedy_backpack_gather / _values             ← 本文件（含 recalculate_tree_values）
 *   build_capture_mst_from_root_and_contiguous_tiles（+_old、reconnect） ← 本文件
 *   convert_contiguous_capture_tiles_to_gather_capture_plan            ← 本文件
 *   build_mst_to_root_from_path_and_contiguous_tiles                   ← 本文件
 *   _prune_bad / _log_tree_structure                                   ← 本文件
 *   is_friendly_tile / build_gather_capture_pure_value_matrix /
 *   build_mst_from_root_and_contiguous_tiles /
 *   convert_contiguous_tile_tree_to_gather_capture_plan /
 *   prune_raw_connected_nodes_to_turns__dfs|__bfs / postOrderIterative /
 *   build_max_value_gather_tree_linking_specific_nodes / gath_set_quick /
 *   get_prize_collecting_gather_mapmatrix                              ← 转发 EK.Gather
 *     （这八个在 gather.js 里已逐行移植并做过 oracle，再抄一份只会漂移）
 *
 * 与原版仅存在的差异（都是被迫的）：
 *  1. Python 的 set 迭代顺序是 hash 序，不可复现。JS 里凡是「遍历一个 tile 集合」
 *     的地方一律先 sortedByTileIndex，再按同一规则做 tie-break。凡是原版靠 set
 *     顺序取「第一个」的地方（reconnect 的 goal、最远格的候选），平局键都补上
 *     tile_index 升序。
 *  2. HeapQueue 的比较：原版把 Tuple 塞进 heapq，第二元素是 Tile，Python 的
 *     Tile.__lt__ 只比 army，等比返回 0，于是同权元组靠 heapq 的内部顺序决定。
 *     JS 的 EK.search.HeapQueue 用 cmpVals，对 tile 同样只比 army，行为等价；
 *     但撞到完全相等的元组时两边堆内位置可能不同 —— 这会体现为「同距离格的
 *     兄弟顺序」偶发不同，不影响总回合数与总兵值。
 *  3. build_capture_mst_... 原版在 disconnected 输入且不允许重连时抛异常，这里
 *     同样抛（这是逻辑错误，不该吞）。
 *  4. convert_contiguous_capture_tiles_to_gather_capture_plan 原版在
 *     get_first_move() 为 None 时抛 AssertionError 并拼一大段复现信息；这里只
 *     返回计划本身，不抛 —— 上层（botmain）每回合都在跑，抛异常会打死整局。
 *  5. 原版 logbook.info 全部移除；GatherDebug.USE_DEBUG_ASSERTS 分支同理。
 *  6. build_capture_mst_from_root_and_contiguous_tiles 多一个可选尾参 forceStartTile，
 *     convert_contiguous_capture_tiles_to_gather_capture_plan 多一个可选尾参
 *     forceStartTile（透传）。只为 oracle 对齐：原版选起点时 `next(iter(sorted(...)))`
 *     的平局由 python set 迭代序决定，JS 复现不了；diff 脚本把原版实际选中的起点
 *     传进来。实战调用方不传，行为等价于原版。
 *  7. BFS 的队列方向：原版是 deque.appendleft + pop（FIFO），若写成 JS 的 push/pop
 *     就变成 DFS，dists 不再是「到起点的最短跳数」，而后面每个节点的 priority 都
 *     由 dists 决定 —— 整棵树会歪（实测 T24 起 78/97 的父子关系反了）。这里用
 *     unshift + pop 保持 FIFO。
 *
 * 内层辅助（recalculate_tree_values 与它的递归体）也放在本文件：gather.js 的文件
 * 头明确写了「recalculate_tree_values 系列没有搬」，而 greedy_backpack_gather_values
 * 的最后一步就是靠它把树的 value / gatherTurns 重算出来，所以只能一起补上。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function GatherUtils() { }

  /* ------------------------------------------------------------------ 工具 */

  function sortedByTileIndex(tiles) {
    if (!tiles) return [];
    var arr = [];
    if (typeof tiles.length === 'number' && !tiles.has) {
      for (var i = 0; i < tiles.length; i++) arr.push(tiles[i]);
    } else {
      var it = tiles.values();
      var step = it.next();
      while (!step.done) {
        arr.push(step.value);
        step = it.next();
      }
    }
    arr.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return arr;
  }

  function teamsArray(map) {
    return map.team_ids_by_player_index;
  }

  function numOr(v, dflt) {
    return (v === undefined || v === null) ? dflt : v;
  }

  /* ------------------------------------------------- 1. 主入口（最高优先级）
   *
   * 原版签名是 18 个位置参数；JS 侧（gatherops.js / combatops.js）按名字调用更清楚，
   * 所以主入口吃 opts 对象，同时兼容「第二个参数直接给 rootTiles」的位置调用。
   */
  function gather_approximate_turns_to_tiles(map, optsOrRootTiles, approximateTargetTurns, asPlayer, maxTurns,
                                             minTurns, gatherMatrix, captureMatrix, negativeTiles,
                                             prioritizeCaptureHighArmyTiles, skipTiles, tilesToHalf,
                                             useTrueValueGathered, includeGatherPriorityAsEconValues,
                                             includeCapturePriorityAsEconValues, logDebug, timeLimit,
                                             viewInfo) {
    var opts;
    if (optsOrRootTiles && typeof optsOrRootTiles === 'object' &&
      (optsOrRootTiles.rootTiles !== undefined || optsOrRootTiles.approximateTargetTurns !== undefined)) {
      opts = optsOrRootTiles;
    } else {
      opts = {
        rootTiles: optsOrRootTiles,
        approximateTargetTurns: approximateTargetTurns,
        asPlayer: asPlayer,
        maxTurns: maxTurns,
        minTurns: minTurns,
        gatherMatrix: gatherMatrix,
        captureMatrix: captureMatrix,
        negativeTiles: negativeTiles,
        prioritizeCaptureHighArmyTiles: prioritizeCaptureHighArmyTiles,
        skipTiles: skipTiles,
        tilesToHalf: tilesToHalf,
        useTrueValueGathered: useTrueValueGathered,
        includeGatherPriorityAsEconValues: includeGatherPriorityAsEconValues,
        includeCapturePriorityAsEconValues: includeCapturePriorityAsEconValues,
        logDebug: logDebug,
        timeLimit: timeLimit,
        viewInfo: viewInfo
      };
    }

    var rootTiles = opts.rootTiles;
    var approxTurns = numOr(opts.approximateTargetTurns, 0);
    var maxT = numOr(opts.maxTurns, 2000);
    var userMaxTurns = false; // 原版 maxTurns 有默认值，这里保留给 get_prize_collecting 用
    var asP = opts.asPlayer;
    if (asP === undefined || asP === null || asP === -1) asP = map.player_index;
    var gMat = opts.gatherMatrix || null;
    var cMat = opts.captureMatrix || null;
    var neg = opts.negativeTiles || null;
    var skip = opts.skipTiles || null;
    var half = opts.tilesToHalf || null;
    var useTrue = opts.useTrueValueGathered === undefined ? true : !!opts.useTrueValueGathered;
    var inclGatherEcon = !!opts.includeGatherPriorityAsEconValues;
    var inclCaptureEcon = opts.includeCapturePriorityAsEconValues === undefined
      ? true : !!opts.includeCapturePriorityAsEconValues;
    var timeLim = opts.timeLimit === undefined ? 0.05 : opts.timeLimit;
    var viewInfo = opts.viewInfo || null;

    // 原版这个矩阵是「只给 plan 估值用的加权矩阵」，与传进 PCST 的 gather/capture
    // 优先级分开：友好格只加 gatherMatrix，非友好格只加 captureMatrix。
    var weightMatrix = new EK.MapMatrix(map, 0.0);
    var allTiles = sortedByTileIndex(map.get_all_tiles());
    for (var i = 0; i < allTiles.length; i++) {
      var t = allTiles[i];
      if (map.is_tile_on_team_with(t, asP)) {
        if (gMat) weightMatrix.raw[t.tile_index] += gMat.raw[t.tile_index];
      } else {
        if (cMat) weightMatrix.raw[t.tile_index] += cMat.raw[t.tile_index];
      }
    }

    var steinerNodes = EK.Gather.get_prize_collecting_gather_mapmatrix(
      map, asP, approxTurns, maxT, gMat, cMat, rootTiles, neg,
      !!opts.prioritizeCaptureHighArmyTiles, skip,
      opts.hintIncludeTiles || null, half,
      opts.enemyArmyCostFactor, opts.enemyArmyLimit);

    if (!steinerNodes || steinerNodes.length === 0) return null;

    var steinerSet = steinerNodes instanceof Set ? steinerNodes : new Set(steinerNodes);

    return EK.Gather.convert_contiguous_tile_tree_to_gather_capture_plan(
      map, rootTiles, steinerSet, asP, neg, weightMatrix, useTrue,
      inclGatherEcon, inclCaptureEcon, half, null, viewInfo);
  }

  /* ------------------------------------- 2. capture MST（从任意 tile 集合连长出来）
   *
   * 与 build_mst_from_root_and_contiguous_tiles 的区别：那个是从「我方根格」往外
   * 长，这个是「从最远的敌方格往回长」，且用 HeapQueue 让「更靠近我方将军」的分支
   * 先展开，得到的树形完全不同。它被 convert_contiguous_capture_tiles_to_gather_
   * capture_plan 使用（也就是采集链、攻城链的实际树）。
   */
  function build_capture_mst_from_root_and_contiguous_tiles_old(map, tiles, searchingPlayer, ignoreTiles) {
    var visited = new EK.MapMatrixSet(map, ignoreTiles || null);
    var q = new EK.search.HeapQueue();
    var teams = teamsArray(map);
    var searchingTeam = teams[searchingPlayer];

    var tileArr = sortedByTileIndex(tiles);
    for (var i = 0; i < tileArr.length; i++) {
      var tile = tileArr[i];
      var army = tile.army;
      if (teams[tile.player()] !== searchingTeam) army = 0 - tile.army;
      else continue;
      q.put([army, tile, null, null, 0]);
    }
    if (q.size === 0) return [];

    var nodes = [];
    while (q.size > 0) {
      var item = q.get();
      var army2 = item[0];
      var t2 = item[1];
      var fromTile = item[2];
      var fromNode = item[3];
      var fromDepth = item[4];
      if (visited.raw[t2.tile_index]) continue;

      var newNode = new EK.GatherTreeNode(t2, fromTile);
      nodes.push(newNode);
      visited.raw[t2.tile_index] = true;
      if (fromNode !== null) {
        fromNode.children.push(newNode);
        newNode.toGather = fromNode;
      }
      for (var m = 0; m < t2.movable.length; m++) {
        var mt = t2.movable[m];
        if (!tiles.has(mt)) continue;
        var nextArmy = teams[mt.player()] !== searchingTeam ? army2 + 0 - mt.army : army2 + mt.army;
        nextArmy -= 1;
        q.put([nextArmy, mt, t2, newNode, fromDepth + 1]);
      }
    }

    var roots = [];
    for (var r = 0; r < nodes.length; r++) if (nodes[r].toTile === null) roots.push(nodes[r]);
    return roots;
  }

  /* 连通性检查 + 重连 + MST。分三段：
   *   1) 从「离将军最远的那个集合内格子」开始 BFS，确认整个 tiles 集合连通；
   *   2) 不连通时（且允许重连）把断开的块用 A* / 受限 BFS 接回来；
   *   3) 用 HeapQueue 按 (离将军越近越先, 兵越少越先) 把树长出来。
   */
  function build_capture_mst_from_root_and_contiguous_tiles(map, tiles, searchingPlayer, ignoreTiles,
                                                           allowedReconnectTiles, allowReconnection,
                                                           intergeneral_analysis, forceStartTile) {
    var dists = new EK.MapMatrix(map, null);
    var teams = teamsArray(map);
    var searchingTeam = teams[searchingPlayer];

    var genDistsRaw = intergeneral_analysis
      ? intergeneral_analysis.aMap.raw
      : new Array(map.tiles_by_index.length).fill(0);

    // 「最远格」= 集合里没有任何一个相邻的、同样不在我方的、离将军更远的格。
    var tileArr = sortedByTileIndex(tiles);
    var allFurthest = [];
    for (var i = 0; i < tileArr.length; i++) {
      var t = tileArr[i];
      if (t.player() >= 0 && teams[t.player()] === searchingTeam) continue;
      var isFurthest = true;
      for (var a = 0; a < t.movable.length; a++) {
        var adj = t.movable[a];
        var adjNotOurs = adj.player() < 0 || teams[adj.player()] !== searchingTeam;
        if (adjNotOurs && genDistsRaw[t.tile_index] < genDistsRaw[adj.tile_index] && tiles.has(adj)) {
          isFurthest = false;
          break;
        }
      }
      if (isFurthest) allFurthest.push(t);
    }
    if (allFurthest.length === 0) {
      throw new Error('build_capture_mst_from_root_and_contiguous_tiles: no furthest tile found for tiles ' +
        tileArr.length);
    }
    // 原版 next(iter(sorted(..., reverse=True)))，平局取 set 顺序；这里平局取 tile_index 小。
    allFurthest.sort(function (x, y) {
      var dx = genDistsRaw[x.tile_index];
      var dy = genDistsRaw[y.tile_index];
      if (dx !== dy) return dy - dx;
      return x.tile_index - y.tile_index;
    });
    // forceStartTile 只给 oracle 对齐用：原版平局靠 python set 迭代序选起点，JS 复现不了，
    // diff 脚本把原版实际选中的起点传进来。
    var startTile = forceStartTile || allFurthest[0];

    var qq = [];
    qq.push([startTile, 0]);
    var maxDistTile = null;
    var maxDist = -1;
    var unvisited = new Set(tileArr);

    while (qq.length > 0) {
      var cur = qq.pop();
      var ct = cur[0];
      var cdist = cur[1];
      if (dists.raw[ct.tile_index] !== null && dists.raw[ct.tile_index] !== undefined) continue;
      unvisited.delete(ct);
      dists.raw[ct.tile_index] = cdist;
      if (cdist > maxDist) {
        maxDist = cdist;
        maxDistTile = ct;
      }
      for (var m2 = 0; m2 < ct.movable.length; m2++) {
        var mv = ct.movable[m2];
        // 原版是 deque.appendleft + pop（FIFO），用 push/pop 会变成 DFS，
        // dists 就不是最短跳数了 —— 后面 priority 全依赖它，树形会整棵歪掉。
        if (tiles.has(mv)) qq.unshift([mv, cdist + 1]);
      }
    }

    if (unvisited.size > 0) {
      if (!allowReconnection) {
        throw new Error('the input tiles were not fully connected to one another. disconnected tiles ' +
          sortedByTileIndex(unvisited).map(function (x) { return x.x + ',' + x.y; }).join(' | '));
      }
      return reconnect_then_build_capture_mest_from_root_and_contiguous_tiles(
        allowReconnection, allowedReconnectTiles || null, ignoreTiles || null, map,
        searchingPlayer, tiles, unvisited);
    }

    for (var f = 0; f < tileArr.length; f++) {
      var ft = tileArr[f];
      if (dists.raw[ft.tile_index] === null || dists.raw[ft.tile_index] === undefined) {
        dists.raw[ft.tile_index] = maxDist;
      }
    }

    var q = new EK.search.HeapQueue();
    q.put([-genDistsRaw[startTile.tile_index], 0 - startTile.army, startTile, null, null, 0]);
    if (q.size === 0) return [];

    var nodes = [];
    var visitedNodes = new EK.MapMatrix(map, null);

    while (q.size > 0) {
      var it = q.get();
      var thing = it[0];
      var army = it[1];
      var tile = it[2];
      var fromTile = it[3];
      var fromNode = it[4];
      var fromDepth = it[5];
      if (visitedNodes.raw[tile.tile_index] !== null && visitedNodes.raw[tile.tile_index] !== undefined) continue;

      var node = new EK.GatherTreeNode(tile, fromTile);
      node.gatherTurns = fromDepth;
      visitedNodes.raw[tile.tile_index] = node;
      node.data = army;
      nodes.push(node);

      if (fromNode !== null) {
        fromNode.children.push(node);
        node.toGather = fromNode;
      }

      for (var n = 0; n < tile.movable.length; n++) {
        var nt = tile.movable[n];
        if (!tiles.has(nt)) continue;
        var nextArmy = teams[nt.player()] !== searchingTeam ? army + 0 - nt.army : army + nt.army;
        nextArmy -= 1;
        var distT = dists.raw[nt.tile_index];
        var priority = (distT !== null && distT !== undefined) ? (thing - distT) / 2 : thing / 2;
        q.put([priority, nextArmy, nt, tile, node, fromDepth + 1]);
      }
    }

    var roots = [];
    for (var r2 = 0; r2 < nodes.length; r2++) if (nodes[r2].toTile === null) roots.push(nodes[r2]);
    return roots;
  }

  function reconnect_then_build_capture_mest_from_root_and_contiguous_tiles(allowReconnection,
                                                                          allowedReconnectTiles, ignoreTiles,
                                                                          map, searchingPlayer, tiles,
                                                                          unvisited) {
    var frTiles = sortedByTileIndex(tiles).filter(function (t) { return t.player() === searchingPlayer; });
    var goal = sortedByTileIndex(unvisited)[0];

    if (allowedReconnectTiles) {
      var frSet = new Set(frTiles);
      var parent = new Map();
      parent.set(goal.tile_index, null);
      var bfs = [goal];
      var reachedFr = null;
      while (bfs.length > 0) {
        var cur = bfs.pop();
        if (frSet.has(cur)) {
          reachedFr = cur;
          break;
        }
        for (var i = 0; i < cur.movable.length; i++) {
          var nxt = cur.movable[i];
          if (parent.has(nxt.tile_index)) continue;
          if (nxt.isMountain || (!nxt.discovered && nxt.isNotPathable)) continue;
          if (nxt.isCostlyNeutral) continue;
          if (!allowedReconnectTiles.has(nxt) && !frSet.has(nxt)) continue;
          parent.set(nxt.tile_index, cur);
          bfs.push(nxt);
        }
      }
      if (reachedFr === null) {
        throw new Error('Unable to recover disconnected inputs under allowedReconnectTiles restriction; no path from any friendly tile to ' +
          goal.x + ',' + goal.y);
      }
      var node = reachedFr;
      while (node !== null && node !== undefined) {
        tiles.add(node);
        node = parent.get(node.tile_index);
      }
    } else {
      var addPath = EK.search.a_star_find(frTiles, goal, { noLog: true });
      if (addPath === null || addPath === undefined) {
        throw new Error('Unable to recover disconnected inputs, aStar find was unable to find a path to reconnect.');
      }
      var list = addPath.tileList;
      for (var p = 0; p < list.length; p++) tiles.add(list[p]);
    }

    return build_capture_mst_from_root_and_contiguous_tiles(map, tiles, searchingPlayer, ignoreTiles,
      allowedReconnectTiles, allowReconnection);
  }

  function _log_tree_structure(node, indent) {
    indent = indent || '';
    var lines = [];
    lines.push('[MST_DEBUG]' + indent + node.tile.x + ',' + node.tile.y + ' (army=' + node.tile.army +
      ', player=' + node.tile.player() + ', children=' + node.children.length + ')');
    for (var i = 0; i < node.children.length; i++) {
      lines.push.apply(lines, _log_tree_structure(node.children[i], indent + '  '));
    }
    return lines;
  }

  /* 把一个节点的最强子节点提升成它的父：采集顺序上「先吃兵多的方向」。
   * 递归条件照抄原版（子节点不是我方的、或者子节点自己还挂着 toGather 时才往下走）。
   */
  function _prune_bad(curNode, searchingTeam, teams, nodeLookup) {
    var bestChild = null;
    var bestArmy = -10000;
    for (var i = 0; i < curNode.children.length; i++) {
      var child = curNode.children[i];
      var army = child.tile.army;
      if (teams[child.tile.player()] !== searchingTeam) army = 0 - child.tile.army;
      army -= 1;
      if (army > bestArmy) {
        bestChild = child;
        bestArmy = army;
      }
    }
    if (bestChild === null) throw new Error('_prune_bad: no best child for ' + curNode.tile.x + ',' + curNode.tile.y);

    var idx = curNode.children.indexOf(bestChild);
    curNode.children.splice(idx, 1);
    curNode.toGather = bestChild;
    if (teams[bestChild.tile.player()] !== searchingTeam || bestChild.toGather !== null) {
      _prune_bad(bestChild, searchingTeam, teams, nodeLookup);
    }
    bestChild.children.push(curNode);
    bestChild.toGather = null;
  }

  /* ------------------------------------------------ 3. capture plan 装配
   * tiles 是「要被占据的连续块」，captures 是要顺路吃掉的格子（合并进同一棵树）。
   */
  function convert_contiguous_capture_tiles_to_gather_capture_plan(map, rootTiles, tiles, negativeTiles,
                                                                  searchingPlayer, priorityMatrix,
                                                                  useTrueValueGathered,
                                                                  includeGatherPriorityAsEconValues,
                                                                  includeCapturePriorityAsEconValues,
                                                                  captures, viewInfo,
                                                                  allowedReconnectTiles,
                                                                  intergeneral_analysis,
                                                                  forceStartTile) {
    if (useTrueValueGathered === undefined) useTrueValueGathered = true;
    if (includeGatherPriorityAsEconValues === undefined) includeGatherPriorityAsEconValues = false;
    if (includeCapturePriorityAsEconValues === undefined) includeCapturePriorityAsEconValues = true;

    var allTiles = new Set(tiles);
    if (captures) {
      captures.forEach(function (c) { allTiles.add(c); });
    }

    var rootNodes = build_capture_mst_from_root_and_contiguous_tiles(map, allTiles, searchingPlayer, null,
      allowedReconnectTiles || null, false, intergeneral_analysis || null, forceStartTile || null);

    var plan = EK.GatherCapturePlan.build_from_root_nodes(map, rootNodes, negativeTiles, searchingPlayer,
      !useTrueValueGathered, priorityMatrix, includeGatherPriorityAsEconValues,
      includeCapturePriorityAsEconValues, captures || null, viewInfo || null, false, null,
      intergeneral_analysis || null, null);

    var frTeam = map.team_ids_by_player_index[searchingPlayer];
    var frTiles = [];
    allTiles.forEach(function (t) {
      if (map.team_ids_by_player_index[t.player()] === frTeam) frTiles.push(t);
    });
    var sum = 0;
    for (var i = 0; i < frTiles.length; i++) sum += frTiles[i].army;
    plan.gathered_army = sum - frTiles.length;

    // 原版在这里对 get_first_move() === None 抛 AssertionError（附一整段复现用
    // 参数 dump）。这里不抛：本函数每回合都会被调用，抛异常会终结整局；调用方
    // 拿到 has_more_moves 为 false 的计划自然会忽略。
    return plan;
  }

  /* ---------------------------------------------- 4. 从一条路径当成根长树
   * 把 rootPath 的 tileList 全部当根（都会变成「起始格」），沿路上把相邻节点串成
   * 一条链，返回最末端那个节点（调用方拿它当 gather 的根）。
   */
  function build_mst_to_root_from_path_and_contiguous_tiles(map, rootPath, tiles, maxDepth,
                                                            reversePath, searchingPlayer) {
    if (searchingPlayer === undefined) searchingPlayer = -1;
    var inputList = rootPath.tileList;

    var rootTiles = EK.Gather.build_mst_from_root_and_contiguous_tiles(map, inputList, tiles, maxDepth,
      null, searchingPlayer);

    if (reversePath) rootTiles = rootTiles.slice().reverse();

    var prev = null;
    for (var i = 0; i < rootTiles.length; i++) {
      var node = rootTiles[i];
      if (prev) {
        node.children.push(prev);
        prev.toTile = node.tile;
        prev.toGather = node;
      }
      prev = node;
    }

    return rootTiles[rootTiles.length - 1];
  }

  /* ------------------------------------------- 5. recalculate_tree_values 系列
   * Python 侧在 GatherPrune.py；gather.js 没搬。greedy_backpack_gather_values 的
   * 返回值就来自这两个函数，所以补在这里。
   */
  function _recalculate_tree_values_recurse(currentNode, negativeTiles, searchingPlayer, teams,
                                            onlyCalculateFriendlyArmy, priorityMatrix, viewInfo) {
    var isStartNode = false;
    var turns = 1;
    var sum = -1;
    var currentTile = currentNode.tile;

    if (currentNode.toTile === null) {
      isStartNode = true;
      sum = 0;
      turns = 0;
    }

    if ((!negativeTiles || !negativeTiles.has(currentTile)) && !isStartNode) {
      if (teams[currentTile.player()] === teams[searchingPlayer]) sum += currentTile.army;
      else if (!onlyCalculateFriendlyArmy) sum -= currentTile.army;
    }

    if (priorityMatrix && !isStartNode) {
      sum += priorityMatrix.raw[currentTile.tile_index];
    }

    for (var i = 0; i < currentNode.children.length; i++) {
      var child = currentNode.children[i];
      _recalculate_tree_values_recurse(child, negativeTiles, searchingPlayer, teams,
        onlyCalculateFriendlyArmy, priorityMatrix, viewInfo);
      sum += child.value;
      turns += child.gatherTurns;
    }

    currentNode.value = sum;
    currentNode.gatherTurns = turns;
  }

  function recalculate_tree_values(logEntries, rootNodes, negativeTiles, searchingPlayer, teams,
                                   onlyCalculateFriendlyArmy, priorityMatrix, viewInfo) {
    if (onlyCalculateFriendlyArmy === undefined) onlyCalculateFriendlyArmy = false;
    var totalValue = 0;
    var totalTurns = 0;
    var i;
    for (i = 0; i < rootNodes.length; i++) {
      _recalculate_tree_values_recurse(rootNodes[i], negativeTiles, searchingPlayer, teams,
        onlyCalculateFriendlyArmy, priorityMatrix, viewInfo);
      totalValue += rootNodes[i].value;
      totalTurns += rootNodes[i].gatherTurns;
    }

    // 第二遍只重算主干累计值（trunkValue / trunkDistance），用于平局与剪枝排序。
    var queue = [];
    for (i = rootNodes.length - 1; i >= 0; i--) {
      var rn = rootNodes[i];
      rn.trunkValue = 0;
      rn.trunkDistance = 0;
      queue.push(rn);
    }
    while (queue.length > 0) {
      var current = queue.pop();
      for (var c = 0; c < current.children.length; c++) {
        var child = current.children[c];
        var trunkValue = current.trunkValue;
        var trunkDistance = current.trunkDistance + 1;
        if (!negativeTiles || !negativeTiles.has(child.tile)) {
          if (teams[child.tile.player()] === teams[searchingPlayer]) trunkValue += child.tile.army;
          else if (!onlyCalculateFriendlyArmy) trunkValue -= child.tile.army;
        }
        trunkValue -= 1;
        child.trunkValue = trunkValue;
        child.trunkDistance = trunkDistance;
      }
      // 原版是 appendleft + pop（即先深后广），这里用 unshift 等价于 appendleft 的
      // 出栈顺序：新节点进队首，pop 从队首取，等价于 DFS。
      for (var c2 = current.children.length - 1; c2 >= 0; c2--) queue.unshift(current.children[c2]);
    }

    return [totalTurns, totalValue];
  }

  /* --------------------------------------------- 6. 贪心装箱 gather（legacy）
   * 每次走一遍「兵/回合最大」的 BFS 路径，把路径上的格子变成 startTiles 继续找，
   * 直到回合用完。最后把树交给 recalculate_tree_values 算总兵值与回合。
   */
  var PRIO_KEYS = 9;

  function _default_value_func_max_gathered_per_turn(searchingPlayer) {
    // priorityObject: [realDist, negPrioTilesPerTurn, negGatheredSum, negArmySum,
    //                  negDistanceSum, dist, xSum, ySum, numPrioTiles]
    return function (currentTile, poi) {
      var realDist = poi[0];
      var negPrioTilesPerTurn = poi[1];
      var negGatheredSum = poi[2];
      var negArmySum = poi[3];
      var negDistanceSum = poi[4];
      var dist = poi[5];
      var xSum = poi[6];
      var ySum = poi[7];
      var numPrioTiles = poi[8];
      if (negArmySum >= 0 || currentTile.player() !== searchingPlayer) return null;
      var value = 0 - (negGatheredSum / Math.max(1, realDist));
      return [value, dist, 0 - negDistanceSum, 0 - negGatheredSum, realDist, 0 - xSum, 0 - ySum];
    };
  }

  function _default_priority_func(searchingPlayer, negativeTiles, distPriorityMap, priorityTiles,
                                  useTrueValueGathered) {
    return function (nextTile, poi) {
      var realDist = poi[0];
      var negPrioTilesPerTurn = poi[1];
      var negGatheredSum = poi[2];
      var negArmySum = poi[3];
      var negDistanceSum = poi[4];
      var dist = poi[5];
      var xSum = poi[6];
      var ySum = poi[7];
      var numPrioTiles = poi[8];
      negArmySum += 1;
      negGatheredSum += 1;
      if (!negativeTiles || !negativeTiles.has(nextTile)) {
        if (nextTile.player() === searchingPlayer) {
          negArmySum -= nextTile.army;
          negGatheredSum -= nextTile.army;
        } else {
          negArmySum += nextTile.army;
          if (useTrueValueGathered) negGatheredSum += nextTile.army;
        }
      }
      if (distPriorityMap) negDistanceSum -= distPriorityMap.raw ? distPriorityMap.raw[nextTile.tile_index]
        : distPriorityMap[nextTile];
      if (priorityTiles && priorityTiles.has(nextTile)) numPrioTiles += 1;
      realDist += 1;
      return [realDist, numPrioTiles / realDist, negGatheredSum, negArmySum, negDistanceSum,
        dist + 1, xSum + nextTile.x, ySum + nextTile.y, numPrioTiles];
    };
  }

  function _default_base_case_func(searchingPlayer, distPriorityMap, useTrueValueGathered) {
    return function (tile, startingDist) {
      var startArmy = 0;
      if (useTrueValueGathered && tile.player() !== searchingPlayer) startArmy = tile.army;
      var initialDistance = 0;
      if (distPriorityMap) {
        initialDistance = distPriorityMap.raw ? distPriorityMap.raw[tile.tile_index]
          : distPriorityMap[tile];
      }
      return [0, 0, 0, startArmy, 0 - initialDistance, startingDist, tile.x, tile.y, 0];
    };
  }

  function greedy_backpack_gather(map, startTiles, turns, targetArmy, valueFunc, baseCaseFunc, negativeTiles,
                                  skipTiles, searchingPlayer, priorityFunc, skipFunc, priorityTiles,
                                  ignoreStartTile, incrementBackward, preferNeutral, viewInfo,
                                  distPriorityMap, useTrueValueGathered,
                                  includeGatherTreeNodesThatGatherNegative, shouldLog) {
    var res = greedy_backpack_gather_values(map, startTiles, turns, targetArmy, valueFunc, baseCaseFunc,
      negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc, priorityTiles,
      ignoreStartTile, incrementBackward, preferNeutral, viewInfo, distPriorityMap,
      useTrueValueGathered, includeGatherTreeNodesThatGatherNegative, shouldLog);
    return res[2];
  }

  function greedy_backpack_gather_values(map, startTiles, turns, targetArmy, valueFunc, baseCaseFunc,
                                         negativeTiles, skipTiles, searchingPlayer, priorityFunc, skipFunc,
                                         priorityTiles, ignoreStartTile, incrementBackward, preferNeutral,
                                         viewInfo, distPriorityMap, useTrueValueGathered,
                                         includeGatherTreeNodesThatGatherNegative, shouldLog) {
    var negativeTilesOrig = negativeTiles || null;
    var neg = negativeTiles ? new Set(negativeTiles) : new Set();
    var teams = teamsArray(map);

    if (searchingPlayer === undefined || searchingPlayer === -2) {
      if (startTiles instanceof Map) {
        var firstKey = startTiles.keys().next();
        searchingPlayer = firstKey.value.player();
      } else if (startTiles.length !== undefined) {
        searchingPlayer = startTiles[0].player();
      } else {
        var one = startTiles.values().next();
        searchingPlayer = one.value.player();
      }
    }

    if (!valueFunc) valueFunc = _default_value_func_max_gathered_per_turn(searchingPlayer);
    if (!priorityFunc) {
      priorityFunc = _default_priority_func(searchingPlayer, neg, distPriorityMap, priorityTiles,
        useTrueValueGathered);
    }
    if (!baseCaseFunc) {
      baseCaseFunc = _default_base_case_func(searchingPlayer, distPriorityMap, useTrueValueGathered);
    }

    // startTilesDict：tile -> [priorityObject, distance]。原版接受 list 或 dict。
    var startTilesDict = new Map();
    if (startTiles instanceof Map) {
      var vals = Array.from(startTiles.keys());
      // 原版按 dict 迭代序处理；这里按 tile_index 规整，保证可复现。
      vals.sort(function (a, b) { return a.tile_index - b.tile_index; });
      for (var si = 0; si < vals.length; si++) {
        var st = vals[si];
        var dv = startTiles.get(st);
        if (typeof dv === 'number') startTilesDict.set(st, [baseCaseFunc(st, dv), dv]);
        else startTilesDict.set(st, dv);
        neg.add(st);
      }
    } else {
      var list = sortedByTileIndex(startTiles);
      for (var sj = 0; sj < list.length; sj++) {
        startTilesDict.set(list[sj], [baseCaseFunc(list[sj], 0), 0]);
        neg.add(list[sj]);
      }
    }

    var gatherTreeNodeLookup = new Map();
    var remainingTurns = turns;
    var valuePerTurnPath = null;
    var itr = 0;

    while (true) {
      // 原版第 4 个位置参数是 maxTime、第 5 个是 maxTurns（都用 remainingTurns），
      // maxDepth 另给 turns。写成 opts 对象时键名照这个对应，顺序不会错位。
      valuePerTurnPath = EK.search.breadth_first_dynamic_max_global_visited(map, startTilesDict, valueFunc, {
        maxTime: 0.1,
        maxTurns: remainingTurns,
        maxDepth: turns,
        forceFriendly: true,
        noNeutralCities: true,
        negativeTiles: neg,
        skipTiles: skipTiles,
        searchingPlayer: searchingPlayer,
        priorityFunc: priorityFunc,
        skipFunc: skipFunc,
        ignoreStartTile: ignoreStartTile,
        incrementBackward: incrementBackward,
        preferNeutral: preferNeutral,
        logResultValues: true,
        ignoreNonPlayerArmy: !useTrueValueGathered
      });

      if (!valuePerTurnPath) break;
      if (valuePerTurnPath.tail.tile.army <= 1 || valuePerTurnPath.tail.tile.player() !== searchingPlayer) break;

      remainingTurns = remainingTurns - valuePerTurnPath.length;
      itr += 1;

      var node = valuePerTurnPath.start;
      var startPrio = startTilesDict.get(node.tile);
      var distance = startPrio ? startPrio[1] : 0;
      var addlDist = 1;
      var currentGatherTreeNode;
      if (gatherTreeNodeLookup.has(node.tile)) {
        currentGatherTreeNode = gatherTreeNodeLookup.get(node.tile);
      } else {
        currentGatherTreeNode = new EK.GatherTreeNode(node.tile, null, distance);
        currentGatherTreeNode.gatherTurns = 1;
      }
      var runningValue = valuePerTurnPath.value - node.tile.army;
      currentGatherTreeNode.value += runningValue;
      runningValue -= node.tile.army;
      gatherTreeNodeLookup.set(node.tile, currentGatherTreeNode);
      neg.add(node.tile);

      node = node.next;
      while (node !== null && node !== undefined) {
        var newDist = distance + addlDist;
        var nextPrioObj = baseCaseFunc(node.tile, newDist);
        startTilesDict.set(node.tile, [nextPrioObj, newDist]);
        neg.add(node.tile);
        var nextGatherTreeNode = new EK.GatherTreeNode(node.tile, currentGatherTreeNode.tile, newDist);
        nextGatherTreeNode.value = runningValue;
        nextGatherTreeNode.gatherTurns = 1;
        runningValue -= node.tile.army;
        currentGatherTreeNode.children.push(nextGatherTreeNode);
        currentGatherTreeNode = nextGatherTreeNode;
        gatherTreeNodeLookup.set(node.tile, currentGatherTreeNode);
        addlDist += 1;
        node = node.next;
      }

      if (remainingTurns <= 0) break;
    }

    var rootNodes = [];
    gatherTreeNodeLookup.forEach(function (n) {
      if (n.toTile === null) rootNodes.push(n);
    });
    // 不排序：原版 where(dict.values()) 保留插入序，根节点顺序会直接决定
    // recalculate_tree_values 的累加顺序与下游 prune 的平局，改成按 tile_index
    // 排就和原版分叉了。

    var res = recalculate_tree_values([], rootNodes, negativeTilesOrig, searchingPlayer, teams,
      !useTrueValueGathered, null, viewInfo);

    return [res[1], res[0], rootNodes];
  }

  /* --------------------------------------------------------------- 转发层 */
  GatherUtils.gather_approximate_turns_to_tiles = gather_approximate_turns_to_tiles;
  GatherUtils.greedy_backpack_gather = greedy_backpack_gather;
  GatherUtils.greedy_backpack_gather_values = greedy_backpack_gather_values;
  GatherUtils.build_capture_mst_from_root_and_contiguous_tiles = build_capture_mst_from_root_and_contiguous_tiles;
  GatherUtils.build_capture_mst_from_root_and_contiguous_tiles_old = build_capture_mst_from_root_and_contiguous_tiles_old;
  GatherUtils.reconnect_then_build_capture_mest_from_root_and_contiguous_tiles =
    reconnect_then_build_capture_mest_from_root_and_contiguous_tiles;
  GatherUtils.convert_contiguous_capture_tiles_to_gather_capture_plan =
    convert_contiguous_capture_tiles_to_gather_capture_plan;
  GatherUtils.build_mst_to_root_from_path_and_contiguous_tiles = build_mst_to_root_from_path_and_contiguous_tiles;
  GatherUtils._prune_bad = _prune_bad;
  GatherUtils._log_tree_structure = _log_tree_structure;
  GatherUtils.recalculate_tree_values = recalculate_tree_values;
  GatherUtils._recalculate_tree_values_recurse = _recalculate_tree_values_recurse;

  // 以下在 gather.js 已有同源实现（做过 oracle），这里只做引用，避免两份实现漂移。
  GatherUtils.is_friendly_tile = function (map, tile, searchingPlayer) {
    return EK.Gather.is_friendly_tile(map, tile, searchingPlayer);
  };
  GatherUtils.build_gather_capture_pure_value_matrix = function () {
    return EK.Gather.build_gather_capture_pure_value_matrix.apply(null, arguments);
  };
  GatherUtils.build_mst_from_root_and_contiguous_tiles = function () {
    return EK.Gather.build_mst_from_root_and_contiguous_tiles.apply(null, arguments);
  };
  GatherUtils.convert_contiguous_tile_tree_to_gather_capture_plan = function () {
    return EK.Gather.convert_contiguous_tile_tree_to_gather_capture_plan.apply(null, arguments);
  };
  GatherUtils.prune_raw_connected_nodes_to_turns__dfs = function () {
    return EK.Gather.prune_raw_connected_nodes_to_turns__dfs.apply(null, arguments);
  };
  GatherUtils.prune_raw_connected_nodes_to_turns__bfs = function () {
    return EK.Gather.prune_raw_connected_nodes_to_turns__bfs.apply(null, arguments);
  };
  GatherUtils.postOrderIterative = function () {
    return EK.Gather.postOrderIterative.apply(null, arguments);
  };
  GatherUtils.build_max_value_gather_tree_linking_specific_nodes = function () {
    return EK.Gather.build_max_value_gather_tree_linking_specific_nodes.apply(null, arguments);
  };
  GatherUtils.gath_set_quick = function () {
    return EK.Gather.gath_set_quick.apply(null, arguments);
  };
  GatherUtils.get_prize_collecting_gather_mapmatrix = function () {
    return EK.Gather.get_prize_collecting_gather_mapmatrix.apply(null, arguments);
  };
  GatherUtils.sortedByTileIndex = sortedByTileIndex;

  EK.GatherUtils = GatherUtils;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

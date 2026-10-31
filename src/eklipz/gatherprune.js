/*
 * GatherPrune / GatherSteiner / GathSetPruneReconnect —— 集兵树的剪枝与 Steiner 装配层
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\Gather\
 *   GatherPrune.py            剪枝引擎（本文件的主要工作）
 *   GatherSteiner.py          mehlhorn 近似 Steiner 树 + prize-collecting 变体
 *   GathSetPruneReconnect.py  「先挑集合 → Steiner 连起来 → 反复剪最低值格 + 重连」
 *   GatherPrizeSteiner.py     Chat-GPT 草稿（原样照搬，见文件末尾说明）
 *   NetworkXHelpers.py        八种建图函数（边权口径各异）
 *
 * 为什么剪枝顺序必须逐位对齐：剪枝是**就地修改**传入的树（原版注释写得很直白：
 * "These are NOT copied and WILL be modified"）。每剪掉一个叶子，就沿 toTile 链把
 * value / gatherTurns 一路减上去，堆里其它节点的优先级依赖这些被改过的值。所以
 * 「谁先出堆」不是性能问题而是结果问题：堆的平局行为、升序/降序遍历、元组逐项比较，
 * 任何一处换个写法，最终留下的 tree 就是另一棵。原版唯一的平局裁决来自
 * CPython heapq 的 _siftdown / _siftup —— 这里是逐行复刻，不加减任何兜底键。
 *
 * 与原版的有意差异（只有这几处，正文不再重复）：
 *  1. 日志 / viewInfo / renderLive / perf 计时全部去掉：只影响观感。
 *  2. `pcst_fast` 是 C++ 扩展，纯 Python 里没有回退实现，也没有等价的 JS 实现。
 *     GatherSteiner 里依赖它的 {@see get_prize_collecting_gather_mapmatrix} 家族
 *     直接抛错（`pcst_unavailable`），不做「近似替代」——近似会让同一输入产生
 *     不同集合，比明确失败更难排查。gather.js 里那份贪心替代仅供本地探索，
 *     不进本模块的导出面。
 *  3. GathSetPruneReconnect 的实现落在 gather.js（先被移植在那里），本文件只做
 *     重新导出 + 显式声明顺序口径，避免同一算法两处实现互相漂移。
 *
 * 原版怪癖（照抄，不要「修」）：
 *  a) prune_mst_to_army_with_values 里收集 citySkipTiles 的判定是
 *     `teams[tile.player] == [searchingPlayer]`：左边是 int、右边是 list，
 *     Python 里恒 False，所以 citySkipTiles 永远是空集。@see _pyTeamIsSearchingList
 *  b) 同一个函数里第二处判定写成 `teams[tile.player] == teams[searchingPlayer]`，
 *     这才是有效比较。两处写法不同是原版的样子。
 *  c) prune_mst_to_turns 的 untilFunc 比较的是 `turnsLeft <= turns`（剩余节点数），
 *     不是「已剪掉多少」。gather.js 里旧版写成 count <= turns，语义相反。
 *
 * 坐标 / 接口：tile.player() 是方法；tile.isPathable / isObstacle / isNeutral /
 * isCity / isGeneral / isSwamp 都是属性。集合一律原生 Set<Tile>（同一 tile_index
 * 在 map 内只有一个对象，按身份比较即可）。矩阵是 EK.MapMatrix，读 `.raw[idx]`。
 * 树的节点复用 EK.Gather.GatherTreeNode（gather.js 已导出）。
 *
 * 遍历顺序：Python 里 `for t in someSet` 在 tile_index 0..399 域上恰好等于
 * tile_index 升序（Tile.__hash__ 就是 tile_index），所以凡是要还原原版集合序的
 * 地方一律用 sortedByTileIndex 显式排序，不依赖 JS 的插入序。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ------------------------------------------------------------------ 取依赖 */

  function GatherTreeNodeClass() {
    var t = EK.GatherTreeNode;
    if (!t) throw new Error('gatherprune: 需要 EK.GatherTreeNode（先加载 src/eklipz/gather.js）');
    return t;
  }

  function moveClass() {
    if (EK.Move) return EK.Move;
    // gather.js 没加载时给一个同形状的实现，字段名与原版 Move(source, dest, move_half) 一致。
    return function Move(source, dest, move_half) {
      this.source = source;
      this.dest = dest;
      this.move_half = !!move_half;
    };
  }

  function getNx() {
    if (!EK.nx) throw new Error('gatherprune: 需要 EK.nx（先加载 src/eklipz/nx.js）');
    return EK.nx;
  }

  function sortedByTileIndex(iterable) {
    var arr = [];
    if (iterable === null || iterable === undefined) return arr;
    if (typeof iterable.forEach === 'function') {
      iterable.forEach(function (t) { arr.push(t); });
    } else {
      for (var i = 0; i < iterable.length; i++) arr.push(iterable[i]);
    }
    arr.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return arr;
  }

  // map.team_ids_by_player_index[-1] 在 Python 里是数组末位，JS 里是 undefined。
  function teamOf(teams, player) {
    if (!teams) return player;
    var v = teams[player];
    if (v === undefined && player === -1) return teams[teams.length - 1];
    return v;
  }

  // 原版 `teams[p] == [searchingPlayer]`：int 与 list 相比恒 False。
  function _pyTeamIsSearchingList() {
    return false;
  }

  function matrixRaw(m, tile) {
    if (m === null || m === undefined) return 0;
    if (m.raw) return m.raw[tile.tile_index];
    return m[tile];
  }

  function sumNodeValues(nodes) {
    var v = 0;
    for (var i = 0; i < nodes.length; i++) v += nodes[i].value;
    return v;
  }

  /* --------------------------------------------------------------- 元组与堆 */

  // Python 元组比较：逐项、bool 当 int、对象落到 GatherTreeNode.__lt__（只比 value）。
  function cmpVal(a, b) {
    if (a === b) return 0;
    if (typeof a === 'boolean') a = a ? 1 : 0;
    if (typeof b === 'boolean') b = b ? 1 : 0;
    if (a === b) return 0;
    if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : -1;
    if (b === null || b === undefined) return 1;
    if (Array.isArray(a) && Array.isArray(b)) return cmpTuple(a, b);
    if (typeof a === 'object' && typeof b === 'object') {
      var av = a.value === undefined ? 0 : a.value;
      var bv = b.value === undefined ? 0 : b.value;
      return av < bv ? -1 : av > bv ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function cmpTuple(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var c = cmpVal(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }

  // CPython heapq 的 _siftdown / _siftup。并列优先级「相等不交换」，谁先出堆由堆结构决定，
  // 加序号兜底会让剪枝顺序与原版整体分叉（原版就是靠这个隐含顺序稳定输出的）。
  function Heap(isMax) {
    this.queue = [];
    this.isMax = !!isMax;
  }
  Heap.prototype._lt = function (a, b) {
    return cmpVal(a.k, b.k) < 0;
  };
  Heap.prototype._siftdown = function (startpos, pos) {
    var q = this.queue;
    var newitem = q[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = q[parentpos];
      var up = this.isMax ? this._lt(parent, newitem) : this._lt(newitem, parent);
      if (up) {
        q[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    q[pos] = newitem;
  };
  Heap.prototype._siftup = function (pos) {
    var q = this.queue;
    var endpos = q.length;
    var startpos = pos;
    var newitem = q[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      if (rightpos < endpos) {
        var takeRight = this.isMax
          ? !this._lt(q[rightpos], q[childpos])
          : !this._lt(q[childpos], q[rightpos]);
        if (takeRight) childpos = rightpos;
      }
      q[pos] = q[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    q[pos] = newitem;
    this._siftdown(startpos, pos);
  };
  Heap.prototype.put = function (k) {
    this.queue.push({ k: k });
    this._siftdown(0, this.queue.length - 1);
  };
  Heap.prototype.get = function () {
    var q = this.queue;
    var last = q.pop();
    if (q.length === 0) return last.k;
    var top = q[0];
    q[0] = last;
    this._siftup(0);
    return top.k;
  };
  Heap.prototype.isEmpty = function () {
    return this.queue.length === 0;
  };

  /* -------------------------------------------------------------- GatherPrune */

  // python: toGather.children.remove(curGather) 走 __eq__（比 tile），删第一个匹配项。
  function removeChildByTile(parent, child) {
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].tile === child.tile) {
        parent.children.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function get_tree_moves(gathers, valueFunc, limit, pop) {
    if (limit === undefined || limit === null) limit = 10000;
    if (!gathers || gathers.length === 0) return [];

    var q = [];
    var head = 0;
    var list = gathers;
    if (!pop) {
      list = [];
      for (var c = 0; c < gathers.length; c++) list.push(gathers[c].deep_clone());
    }
    for (var g = 0; g < list.length; g++) {
      var basePrio = valueFunc(list[g].tile, null);
      q.push([basePrio, list[g]]);
    }

    var moveQ = new Heap(true);
    var prioLookup = new Map();

    while (head < q.length) {
      var item = q[head++];
      var curPrio = item[0];
      var curGather = item[1];
      prioLookup.set(curGather.tile, curPrio);

      if (curGather.children.length === 0) {
        moveQ.put([curPrio, curGather]);
      } else {
        for (var i = 0; i < curGather.children.length; i++) {
          var gather = curGather.children[i];
          gather.toGather = curGather;
          var nextPrio = valueFunc(gather.tile, curPrio);
          q.push([nextPrio, gather]);
        }
      }
    }

    var Move = moveClass();
    var moves = [];
    var iter = 0;
    while (!moveQ.isEmpty()) {
      var top = moveQ.get();
      var curGather2 = top[1];
      var toGather = curGather2.toGather;
      if (toGather !== null && toGather !== undefined) {
        moves.push(new Move(curGather2.tile, toGather.tile, curGather2.half));
        removeChildByTile(toGather, curGather2);
        iter += 1;
        if (iter >= limit) break;

        if (toGather.children.length === 0) {
          var fromPrio = prioLookup.has(toGather.toTile) ? prioLookup.get(toGather.toTile) : null;
          var curPrio3 = valueFunc(toGather.tile, fromPrio);
          moveQ.put([curPrio3, toGather]);
        }
      }
    }

    return moves;
  }

  function get_tree_move(gathers, valueFunc, pop) {
    var moves = get_tree_moves(gathers, valueFunc, 1, pop);
    return moves.length > 0 ? moves[0] : null;
  }

  // 剪枝引擎本体。untilFunc(node, prioObj, turnsLeft, curValue) 返回 true 表示「够了，别再剪」。
  // 注意它是**每弹出一个节点就调用一次**，返回 true 只跳过这一个节点，不是跳出循环——
  // 原版注释写"Thus we should break"，但代码是 continue，照抄。
  function prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc, pruneBranches,
                           pruneOverrideFunc, viewInfo, noLog, gatherTreeNodeLookupToPrune,
                           tileDictToPrune, preferPrune, parentPruneFunc, allowNegative,
                           logEntries, pruneCallbackFunc) {
    var GT = GatherTreeNodeClass();
    if (pruneBranches === undefined) pruneBranches = false;
    if (noLog === undefined) noLog = true;
    if (allowNegative === undefined) allowNegative = true;

    var nodeMap = new Map();
    var pruneHeap = new Heap(false);
    var iter = 0;

    GatherTreeNode_foreach(GT, rootNodes, function (current) {
      nodeMap.set(current.tile, current);
      if (current.toTile !== null && (current.children.length === 0 || pruneBranches)) {
        var validMove = true;
        if (invalidMoveFunc(current) && current.children.length === 0) validMove = false;
        pruneHeap.put([
          validMove,
          preferPrune === null || preferPrune === undefined || !preferPrune.has(current.tile),
          pruneOrderFunc(current, null),
          current
        ]);
      }
    });

    var curValue = sumNodeValues(rootNodes);
    var count = nodeMap.size - rootNodes.length;
    var initialCount = nodeMap.size;
    var childRecurseQueue = [];
    var childHead = 0;

    while (!pruneHeap.isEmpty()) {
      var popped = pruneHeap.get();
      var prioObj = popped[2];
      var current = popped[3];
      iter += 1;
      if (iter > initialCount * 3) break;

      if (current.toTile === null) continue;
      if (!nodeMap.has(current.tile)) continue;

      var validMoveNow = !invalidMoveFunc(current);
      if (validMoveNow || current.children.length > 0) {
        if (untilFunc(current, prioObj, count, curValue)) continue;
      }

      if (pruneOverrideFunc && pruneOverrideFunc(current, prioObj, count, curValue)) continue;

      if (!allowNegative && _would_prune_cause_negative_root(current, nodeMap, null)) continue;

      if (validMoveNow) {
        var doubleCheckPrioObj = pruneOrderFunc(current, prioObj);
        if (cmpVal(doubleCheckPrioObj, prioObj) > 0) {
          pruneHeap.put([
            validMoveNow,
            preferPrune === null || preferPrune === undefined || !preferPrune.has(current.tile),
            doubleCheckPrioObj,
            current
          ]);
          continue;
        }
      }

      curValue -= current.value;
      var parent = nodeMap.has(current.toTile) ? nodeMap.get(current.toTile) : null;
      var realParent = parent;

      if (parent !== null) {
        removeChildByTile(parent, current);
        parent.pruned.push(current);
      }

      var vis = new Set();
      var last = null;
      while (parent !== null && !vis.has(parent.tile.tile_index)) {
        vis.add(parent.tile.tile_index);
        parent.value -= current.value;
        parent.gatherTurns -= current.gatherTurns;
        if (parentPruneFunc) parentPruneFunc(parent.tile, current);
        if (parent.toTile === null) {
          parent = null;
          break;
        }
        last = parent;
        parent = nodeMap.has(parent.toTile) ? nodeMap.get(parent.toTile) : null;
        if (parent === null) {
          last.toTile = null;
          last.toGather = null;
        }
      }
      // 还剩下 parent 只可能是环；原版在 USE_DEBUG_ASSERTS 下抛，否则断链收场。
      if (parent !== null && last !== null) {
        last.toTile = null;
        last.toGather = null;
      }

      childRecurseQueue.push(current);
      var childIter = 0;
      while (childHead < childRecurseQueue.length) {
        var toDrop = childRecurseQueue[childHead++];
        childIter += 1;
        if (childIter > initialCount * 3) break;
        if (gatherTreeNodeLookupToPrune) gatherTreeNodeLookupToPrune.delete(toDrop.tile);
        if (tileDictToPrune) tileDictToPrune.delete(toDrop.tile);
        nodeMap.delete(toDrop.tile);
        count -= 1;
        if (pruneCallbackFunc) pruneCallbackFunc(toDrop, count, curValue);
        for (var ci = 0; ci < toDrop.children.length; ci++) childRecurseQueue.push(toDrop.children[ci]);
      }

      if (realParent !== null && realParent.children.length === 0 && realParent.toTile !== null) {
        var parentValidMove = !invalidMoveFunc(realParent);
        var nextPrioObj = pruneOrderFunc(realParent, prioObj);
        pruneHeap.put([
          parentValidMove,
          preferPrune === null || preferPrune === undefined || !preferPrune.has(realParent.tile),
          nextPrioObj,
          realParent
        ]);
      }
    }

    var totalValue = sumNodeValues(rootNodes);
    return [count, totalValue, rootNodes];
  }

  // gather.js 的 foreach_tree_node 带 i>500 的环检测，但它是静态挂在 GatherTreeNode 上的；
  // 这里不直接引用，是为了让 GatherTreeNode 可以被替换成同形状对象（oracle 用）。
  function GatherTreeNode_foreach(GT, rootNodes, func) {
    if (GT && typeof GT.foreach_tree_node === 'function') return GT.foreach_tree_node(rootNodes, func);
    var q = rootNodes.slice();
    var i = 0;
    while (q.length > 0) {
      var n = q.shift();
      i++;
      if (i > 500) throw new Error('foreach_tree_node infinite looped');
      func(n);
      for (var c = 0; c < n.children.length; c++) q.push(n.children[c]);
    }
  }

  // 沿 toTile 爬到最顶祖先，看剪掉 current 之后它会不会变负。
  function _would_prune_cause_negative_root(current, nodeMap, logEntries) {
    var parent = nodeMap.has(current.toTile) ? nodeMap.get(current.toTile) : null;
    var nextParent = parent;
    while (nextParent !== null && nextParent !== undefined) {
      parent = nextParent;
      nextParent = nodeMap.has(nextParent.toTile) ? nodeMap.get(nextParent.toTile) : null;
    }
    if (parent === null || parent === undefined) {
      parent = current;
    }
    return parent.value - current.value < 0;
  }

  function _default_invalid_move_level1(node, searchingPlayer) {
    if (node.tile.army <= 1) return true;
    return node.tile.player() !== searchingPlayer;
  }

  function _default_invalid_move_leaf(node, searchingPlayer) {
    if (node.tile.army <= 1) return true;
    if (node.tile.player() !== searchingPlayer && node.children.length === 0) return true;
    return false;
  }

  function _prune_func_val_per_turn(node) {
    if (node.gatherTurns > 0) return node.value / node.gatherTurns;
    return -100;
  }

  function prune_mst_to_turns(rootNodes, turns, searchingPlayer, viewInfo, noLog,
                              gatherTreeNodeLookupToPrune, tileDictToPrune, preferPrune,
                              allowNegative, invalidMoveFunc, forcePrunePreferPrune) {
    var res = prune_mst_to_turns_with_values(rootNodes, turns, searchingPlayer, viewInfo, noLog,
      gatherTreeNodeLookupToPrune, tileDictToPrune, invalidMoveFunc, preferPrune, null,
      allowNegative, null, null, forcePrunePreferPrune);
    return res[2];
  }

  function prune_mst_to_turns_with_values(rootNodes, turns, searchingPlayer, viewInfo, noLog,
                                          gatherTreeNodeLookupToPrune, tileDictToPrune,
                                          invalidMoveFunc, preferPrune, parentPruneFunc,
                                          allowNegative, overpruneCutoff, logEntries,
                                          forcePrunePreferPrune) {
    if (noLog === undefined) noLog = true;
    if (allowNegative === undefined) allowNegative = true;
    if (invalidMoveFunc === null || invalidMoveFunc === undefined) {
      invalidMoveFunc = function (node) { return _default_invalid_move_leaf(node, searchingPlayer); };
    }

    var pruneFunc = function (node, curPrioObj) {
      return [_prune_func_val_per_turn(node), node.value, 0 - node.trunkDistance];
    };

    if (overpruneCutoff === null || overpruneCutoff === undefined) overpruneCutoff = turns;

    var pruneOverrideFunc = function (node, _p, turnsLeft, curValue) {
      return turnsLeft - node.gatherTurns < overpruneCutoff;
    };

    var pruneCallbackFunc = null;
    var untilFunc;
    if (!forcePrunePreferPrune) {
      untilFunc = function (node, _p, turnsLeft, curValue) {
        return turnsLeft <= turns;
      };
    } else {
      var mustPrune = new Set(preferPrune || []);
      untilFunc = function (node, _p, turnsLeft, curValue) {
        return turnsLeft <= turns && mustPrune.size === 0;
      };
      pruneCallbackFunc = function (node) {
        mustPrune.delete(node.tile);
      };
    }

    var res = prune_mst_until(rootNodes, untilFunc, pruneFunc, invalidMoveFunc, true,
      pruneOverrideFunc, viewInfo, noLog, gatherTreeNodeLookupToPrune, tileDictToPrune,
      preferPrune, parentPruneFunc, allowNegative, logEntries, pruneCallbackFunc);
    return res;
  }

  function prune_mst_to_tiles(rootNodes, tiles, searchingPlayer, viewInfo, noLog,
                              gatherTreeNodeLookupToPrune, tileDictToPrune, preferPrune,
                              invalidMoveFunc) {
    var res = prune_mst_to_tiles_with_values(rootNodes, tiles, searchingPlayer, viewInfo, noLog,
      gatherTreeNodeLookupToPrune, tileDictToPrune, invalidMoveFunc, preferPrune, null);
    return res[2];
  }

  function prune_mst_to_tiles_with_values(rootNodes, tiles, searchingPlayer, viewInfo, noLog,
                                          gatherTreeNodeLookupToPrune, tileDictToPrune,
                                          invalidMoveFunc, preferPrune, parentPruneFunc) {
    if (noLog === undefined) noLog = true;
    if (invalidMoveFunc === null || invalidMoveFunc === undefined) {
      invalidMoveFunc = function (node) { return _default_invalid_move_leaf(node, searchingPlayer); };
    }
    var pruneFunc = function (node, curPrioObj) {
      return [_prune_func_val_per_turn(node), node.value, 0 - node.trunkDistance];
    };
    var untilFunc = function (node) { return tiles.has(node.tile); };
    var overrideFunc = function (node) { return tiles.has(node.tile); };

    return prune_mst_until(rootNodes, untilFunc, pruneFunc, invalidMoveFunc, false,
      overrideFunc, viewInfo, noLog, gatherTreeNodeLookupToPrune, tileDictToPrune,
      preferPrune, parentPruneFunc, true, null, null);
  }

  function prune_mst_to_army(rootNodes, army, searchingPlayer, teams, turn, viewInfo, noLog,
                             gatherTreeNodeLookupToPrune, invalidMoveFunc, preferPrune,
                             allowNegative, pruneLargeTilesFirst) {
    var res = prune_mst_to_army_with_values(rootNodes, army, searchingPlayer, teams, turn, 0,
      viewInfo, noLog, gatherTreeNodeLookupToPrune, invalidMoveFunc, preferPrune,
      allowNegative, pruneLargeTilesFirst);
    return res[2];
  }

  function prune_mst_to_army_with_values(rootNodes, army, searchingPlayer, teams, turn,
                                         additionalIncrement, viewInfo, noLog,
                                         gatherTreeNodeLookupToPrune, invalidMoveFunc,
                                         preferPrune, allowNegative, pruneLargeTilesFirst) {
    if (additionalIncrement === undefined || additionalIncrement === null) additionalIncrement = 0;
    if (noLog === undefined) noLog = true;
    if (allowNegative === undefined) allowNegative = true;
    if (pruneLargeTilesFirst === undefined) pruneLargeTilesFirst = false;

    var turnIncFactor = (1 + turn) & 1;

    var cityCounter = { value: 0 - additionalIncrement };
    var cityGatherDepthCounter = { value: 0 };
    var citySkipTiles = new Set();
    for (var r = 0; r < rootNodes.length; r++) {
      var n = rootNodes[r];
      if ((n.tile.isCity || n.tile.isGeneral) && !n.tile.isNeutral) {
        // 原版这里比的是 teams[player] == [searchingPlayer]，恒 False（见文件头 a）。
        if (_pyTeamIsSearchingList(teamOf(teams, n.tile.player()), searchingPlayer)) {
          citySkipTiles.add(n.tile);
        }
      }
    }

    var cityCounterAddFunc = function (node) {
      if ((node.tile.isGeneral || node.tile.isCity) && !node.tile.isNeutral && !citySkipTiles.has(node.tile)) {
        if (teamOf(teams, node.tile.player()) === teamOf(teams, searchingPlayer)) {
          cityCounter.value += 1;
          cityGatherDepthCounter.value += node.trunkDistance;
        } else {
          cityCounter.value -= 1;
          cityGatherDepthCounter.value += node.trunkDistance;
        }
      }
      for (var c = 0; c < node.children.length; c++) cityCounterAddFunc(node.children[c]);
    };

    for (var r2 = 0; r2 < rootNodes.length; r2++) cityCounterAddFunc(rootNodes[r2]);

    var setCountersToPruneCitiesRecurse = function (node) {
      for (var c = 0; c < node.children.length; c++) setCountersToPruneCitiesRecurse(node.children[c]);
      if ((node.tile.isCity || node.tile.isGeneral) && !node.tile.isNeutral) {
        if (teamOf(teams, node.tile.player()) === teamOf(teams, searchingPlayer)) {
          cityGatherDepthCounter.value -= node.trunkDistance;
          cityCounter.value -= 1;
        } else {
          cityGatherDepthCounter.value += node.trunkDistance;
          cityCounter.value += 1;
        }
      }
    };

    if (invalidMoveFunc === null || invalidMoveFunc === undefined) {
      invalidMoveFunc = function (node) { return _default_invalid_move_level1(node, searchingPlayer); };
    }

    var getCurrentCityIncAmount = function (gatherTurnsLeft) {
      // Python // 是向下取整，JS 需要显式 floor（负数时 Math.trunc 会错）。
      var amount = Math.floor((cityCounter.value * (gatherTurnsLeft - turnIncFactor)) / 2);
      amount -= Math.floor(cityGatherDepthCounter.value / 2);
      return amount;
    };

    var untilFunc = function (node, _p, turnsLeft, curValue) {
      var turnsLeftIfPruned = turnsLeft - node.gatherTurns;
      // 先按「假设已经剪掉这个城市」记账，再算剩多少兵。
      setCountersToPruneCitiesRecurse(node);
      var cityIncrementAmount = getCurrentCityIncAmount(turnsLeftIfPruned);
      var armyLeftIfPruned = curValue - node.value + cityIncrementAmount;
      if (armyLeftIfPruned < army) {
        // 不剪，把城市增量加回去。
        cityCounterAddFunc(node);
        return true;
      }
      return false;
    };

    var pruneLargeTilesFirstFunc = function (node, curObj) {
      var trunkValuePerTurn = node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0;
      return [0 - node.value, trunkValuePerTurn, node.trunkDistance];
    };
    var pruneWorstValuePerTurnFunc = function (node, curObj) {
      var trunkValuePerTurn = node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0;
      return [node.value / node.gatherTurns, trunkValuePerTurn, node.trunkDistance];
    };

    var prioFunc = pruneLargeTilesFirst ? pruneLargeTilesFirstFunc : pruneWorstValuePerTurnFunc;

    var res = prune_mst_until(rootNodes, untilFunc, prioFunc, invalidMoveFunc, false,
      null, viewInfo, noLog, gatherTreeNodeLookupToPrune, null, preferPrune, null,
      allowNegative, null, null);

    var finalIncValue = getCurrentCityIncAmount(res[0]);
    var gathValue = res[1] + finalIncValue;
    return [res[0], gathValue, res[2]];
  }

  function prune_mst_to_max_army_per_turn(rootNodes, minArmy, searchingPlayer, teams, viewInfo, noLog,
                                          gatherTreeNodeLookupToPrune, invalidMoveFunc, preferPrune,
                                          allowNegative, allowBranchPrune) {
    var res = prune_mst_to_max_army_per_turn_with_values(rootNodes, minArmy, searchingPlayer, teams, 0,
      viewInfo, noLog, gatherTreeNodeLookupToPrune, invalidMoveFunc, preferPrune, allowNegative,
      allowBranchPrune, 0);
    return res[2];
  }

  function prune_mst_to_max_army_per_turn_with_values(rootNodes, minArmy, searchingPlayer, teams,
                                                     additionalIncrement, viewInfo, noLog,
                                                     gatherTreeNodeLookupToPrune, invalidMoveFunc,
                                                     preferPrune, allowNegative, allowBranchPrune,
                                                     minTurns) {
    var GT = GatherTreeNodeClass();
    if (additionalIncrement === undefined || additionalIncrement === null) additionalIncrement = 0;
    if (noLog === undefined) noLog = true;
    if (allowNegative === undefined) allowNegative = true;
    if (allowBranchPrune === undefined) allowBranchPrune = true;
    if (minTurns === undefined || minTurns === null) minTurns = 0;

    var cityCounter = { value: 0 - additionalIncrement };
    var cityGatherDepthCounter = { value: 0 };
    var citySkipTiles = new Set();
    var totalValue = 0;
    var totalTurns = 0;
    for (var r = 0; r < rootNodes.length; r++) {
      var n = rootNodes[r];
      if ((n.tile.isCity || n.tile.isGeneral) && !n.tile.isNeutral) {
        if (teamOf(teams, n.tile.player()) === teamOf(teams, searchingPlayer)) citySkipTiles.add(n.tile);
      }
      totalTurns += n.gatherTurns;
      totalValue += n.value;
    }

    if (totalTurns === 0) return [0, 0, rootNodes];
    if (totalValue < minArmy) return [totalTurns, totalValue, rootNodes];

    var cityCounterFunc = function (node) {
      if ((node.tile.isGeneral || node.tile.isCity) && !node.tile.isNeutral && !citySkipTiles.has(node.tile)) {
        if (teamOf(teams, node.tile.player()) === teamOf(teams, searchingPlayer)) {
          cityCounter.value += 1;
          cityGatherDepthCounter.value += node.trunkDistance;
        } else {
          cityCounter.value -= 1;
        }
      }
      if (node.tile.isSwamp && !node.tile.isNeutral) cityCounter.value -= 1;
    };
    GatherTreeNode_foreach(GT, rootNodes, cityCounterFunc);

    if (invalidMoveFunc === null || invalidMoveFunc === undefined) {
      invalidMoveFunc = function (node) { return _default_invalid_move_level1(node, searchingPlayer); };
    }

    var curValuePerTurn = { value: totalValue / totalTurns };

    var untilFunc = function (node, _p, turnsLeft, curValue) {
      var turnsLeftIfPruned = turnsLeft - node.gatherTurns;
      if (turnsLeftIfPruned <= minTurns) return true;
      var cityIncrementAmount = cityCounter.value * Math.floor((turnsLeftIfPruned - 1) / 2);
      cityIncrementAmount -= Math.floor(cityGatherDepthCounter.value / 2);
      var armyLeftIfPruned = curValue - node.value + cityIncrementAmount;
      var pruneValPerTurn = armyLeftIfPruned / turnsLeftIfPruned;
      if (pruneValPerTurn < curValuePerTurn.value || armyLeftIfPruned < minArmy) return true;

      if (teamOf(teams, node.tile.player()) === teamOf(teams, searchingPlayer)) {
        if (node.tile.isCity || node.tile.isGeneral) {
          cityGatherDepthCounter.value -= node.trunkDistance;
          cityCounter.value -= 1;
        } else if (node.tile.isSwamp) {
          cityGatherDepthCounter.value -= node.trunkDistance;
          cityCounter.value += 1;
        }
      }
      curValuePerTurn.value = pruneValPerTurn;
      return false;
    };

    var pruneOrderFunc = function (node, curObj) {
      if (node.gatherTurns === 0 || node.trunkDistance === 0) return [-1, -1, -1];
      return [node.value / node.gatherTurns, node.trunkValue / node.trunkDistance, node.trunkDistance];
    };

    return prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc, allowBranchPrune,
      null, viewInfo, noLog, gatherTreeNodeLookupToPrune, null, preferPrune, null,
      allowNegative, null, null);
  }

  // 递归重算 value / gatherTurns：起点节点（toTile 为 null）从 0 起算，其余从 -1 起：
  // -1 代表「走进去之后要留一个兵占着这条路」。
  function _recalculate_tree_values_recurse(currentNode, negativeTiles, searchingPlayer, teams,
                                            onlyCalculateFriendlyArmy, priorityMatrix,
                                            viewInfo, shouldAssert) {
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
      if (teamOf(teams, currentTile.player()) === teamOf(teams, searchingPlayer)) {
        sum += currentTile.army;
      } else if (!onlyCalculateFriendlyArmy) {
        sum -= currentTile.army;
      }
    }

    if (priorityMatrix && !isStartNode) sum += matrixRaw(priorityMatrix, currentTile);

    for (var c = 0; c < currentNode.children.length; c++) {
      var child = currentNode.children[c];
      _recalculate_tree_values_recurse(child, negativeTiles, searchingPlayer, teams,
        onlyCalculateFriendlyArmy, priorityMatrix, viewInfo, shouldAssert);
      sum += child.value;
      turns += child.gatherTurns;
    }

    currentNode.value = sum;
    currentNode.gatherTurns = turns;
  }

  function recalculate_tree_values(logEntries, rootNodes, negativeTiles, searchingPlayer, teams,
                                   onlyCalculateFriendlyArmy, priorityMatrix, viewInfo, shouldAssert) {
    var totalValue = 0;
    var totalTurns = 0;
    for (var i = 0; i < rootNodes.length; i++) {
      _recalculate_tree_values_recurse(rootNodes[i], negativeTiles, searchingPlayer, teams,
        !!onlyCalculateFriendlyArmy, priorityMatrix || null, viewInfo, !!shouldAssert);
      totalValue += rootNodes[i].value;
      totalTurns += rootNodes[i].gatherTurns;
    }

    // trunk 值自顶向下重算；原版用 deque 的 appendleft + pop（FIFO），这里等价于队列。
    var queue = [];
    var head = 0;
    for (var r = 0; r < rootNodes.length; r++) {
      rootNodes[r].trunkValue = 0;
      rootNodes[r].trunkDistance = 0;
      queue.push(rootNodes[r]);
    }
    while (head < queue.length) {
      var current = queue[head++];
      for (var c = 0; c < current.children.length; c++) {
        var child2 = current.children[c];
        var trunkValue = current.trunkValue;
        var trunkDistance = current.trunkDistance + 1;
        if (!negativeTiles || !negativeTiles.has(child2.tile)) {
          if (teamOf(teams, child2.tile.player()) === teamOf(teams, searchingPlayer)) {
            trunkValue += child2.tile.army;
          } else if (!onlyCalculateFriendlyArmy) {
            trunkValue -= child2.tile.army;
          }
        }
        trunkValue -= 1;
        child2.trunkValue = trunkValue;
        child2.trunkDistance = trunkDistance;
        queue.push(child2);
      }
    }

    return [totalTurns, totalValue];
  }

  function _recalculate_tree_values_matrix_recurse(currentNode, valueMatrix, negativeTiles,
                                                  viewInfo, shouldAssert) {
    var isStartNode = false;
    var turns = 1;
    var sum = -1;
    var currentTile = currentNode.tile;

    if (currentNode.toTile === null) {
      isStartNode = true;
      sum = 0;
      turns = 0;
    }

    if ((negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(currentTile)) && !isStartNode) {
      sum += matrixRaw(valueMatrix, currentTile);
    }

    for (var c = 0; c < currentNode.children.length; c++) {
      var child = currentNode.children[c];
      _recalculate_tree_values_matrix_recurse(child, valueMatrix, negativeTiles, viewInfo, shouldAssert);
      sum += child.value;
      turns += child.gatherTurns;
    }

    currentNode.value = sum;
    currentNode.gatherTurns = turns;
  }

  function recalculate_tree_values_from_matrix(logEntries, rootNodes, valueMatrix, negativeTiles,
                                               viewInfo, shouldAssert) {
    var totalValue = 0;
    var totalTurns = 0;
    for (var i = 0; i < rootNodes.length; i++) {
      _recalculate_tree_values_matrix_recurse(rootNodes[i], valueMatrix, negativeTiles, viewInfo, !!shouldAssert);
      totalValue += rootNodes[i].value;
      totalTurns += rootNodes[i].gatherTurns;
    }

    var queue = [];
    var head = 0;
    for (var r = 0; r < rootNodes.length; r++) {
      rootNodes[r].trunkValue = 0;
      rootNodes[r].trunkDistance = 0;
      queue.push(rootNodes[r]);
    }
    while (head < queue.length) {
      var current = queue[head++];
      for (var c = 0; c < current.children.length; c++) {
        var child2 = current.children[c];
        var trunkValue2 = current.trunkValue;
        var trunkDistance2 = current.trunkDistance + 1;
        if (!negativeTiles || !negativeTiles.has(child2.tile)) {
          trunkValue2 += matrixRaw(valueMatrix, child2.tile);
        }
        trunkValue2 -= 1;
        child2.trunkValue = trunkValue2;
        child2.trunkDistance = trunkDistance2;
        queue.push(child2);
      }
    }

    return [totalTurns, totalValue];
  }

  var GatherPrune = {
    get_tree_moves: get_tree_moves,
    get_tree_move: get_tree_move,
    prune_mst_until: prune_mst_until,
    prune_mst_to_turns: prune_mst_to_turns,
    prune_mst_to_turns_with_values: prune_mst_to_turns_with_values,
    prune_mst_to_tiles: prune_mst_to_tiles,
    prune_mst_to_tiles_with_values: prune_mst_to_tiles_with_values,
    prune_mst_to_army: prune_mst_to_army,
    prune_mst_to_army_with_values: prune_mst_to_army_with_values,
    prune_mst_to_max_army_per_turn: prune_mst_to_max_army_per_turn,
    prune_mst_to_max_army_per_turn_with_values: prune_mst_to_max_army_per_turn_with_values,
    _would_prune_cause_negative_root: _would_prune_cause_negative_root,
    recalculate_tree_values: recalculate_tree_values,
    recalculate_tree_values_from_matrix: recalculate_tree_values_from_matrix
  };

  /* ----------------------------------------------------------- NetworkXHelpers */

  function _validTilesOrDefault(map, validTiles) {
    return (validTiles && validTiles.size > 0) ? validTiles : map.pathable_tiles;
  }

  function _rightDown(map, tile) {
    return [map.GetTile(tile.x + 1, tile.y), map.GetTile(tile.x, tile.y + 1)];
  }

  function _banned(bannedTiles, t) {
    return bannedTiles !== null && bannedTiles !== undefined && bannedTiles.has(t);
  }

  function build_networkX_graph_no_obstacles_no_weights(map, bannedTiles, validTiles) {
    var nx = getNx();
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle || _banned(bannedTiles, tile)) continue;
      var rd = _rightDown(map, tile);
      var right = rd[0];
      var down = rd[1];
      var tileIndex = tile.tile_index;
      // 原版会显式 add_node：孤立格没有边，但必须能被后续剪枝看见。
      g.add_node(tileIndex);
      if (right && valid.has(right) && !right.isObstacle && !_banned(bannedTiles, right)) {
        g.add_edge(tileIndex, right.tile_index);
      }
      if (down && valid.has(down) && !down.isObstacle && !_banned(bannedTiles, down)) {
        g.add_edge(tileIndex, down.tile_index);
      }
    }
    return g;
  }

  function build_networkX_graph_flat_weight_mod_subtract(map, weightModMatrix, baseWeight, bannedTiles, validTiles) {
    var nx = getNx();
    if (baseWeight === undefined || baseWeight === null) baseWeight = 1;
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var fromWeight = baseWeight;
      if (tile.isObstacle || _banned(bannedTiles, tile)) fromWeight += baseWeight * 1000;
      fromWeight -= matrixRaw(weightModMatrix, tile);
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;
      if (rd[0] && valid.has(rd[0])) {
        var wr = fromWeight;
        if (rd[0].isObstacle || _banned(bannedTiles, rd[0])) wr += baseWeight * 1000;
        wr -= matrixRaw(weightModMatrix, rd[0]);
        g.add_edge(tileIndex, rd[0].tile_index, { weight: wr });
      }
      if (rd[1] && valid.has(rd[1])) {
        var wd = fromWeight;
        if (rd[1].isObstacle || _banned(bannedTiles, rd[1])) wd += baseWeight * 1000;
        wd -= matrixRaw(weightModMatrix, rd[1]);
        g.add_edge(tileIndex, rd[1].tile_index, { weight: wd });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_weight_mod_divide_min_offset(map, weightModMatrix, baseOffset, bannedTiles, validTiles) {
    var nx = getNx();
    if (baseOffset === undefined || baseOffset === null) baseOffset = 0;
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    if (tiles.length === 0) return g;
    var minW = Infinity;
    for (var m = 0; m < tiles.length; m++) {
      var v = matrixRaw(weightModMatrix, tiles[m]);
      if (v < minW) minW = v;
    }
    var offset = -minW;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle || _banned(bannedTiles, tile)) continue;
      var fromWeight = baseOffset;
      fromWeight += matrixRaw(weightModMatrix, tile) + offset;
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;
      if (rd[0] && valid.has(rd[0]) && !rd[0].isObstacle && !_banned(bannedTiles, rd[0])) {
        var w = fromWeight + matrixRaw(weightModMatrix, rd[0]) + offset;
        if (w <= 0.0) w = 0.0000000001;
        g.add_edge(tileIndex, rd[0].tile_index, { weight: 1 / w });
      }
      if (rd[1] && valid.has(rd[1]) && !rd[1].isObstacle && !_banned(bannedTiles, rd[1])) {
        var w2 = fromWeight + matrixRaw(weightModMatrix, rd[1]) + offset;
        if (w2 <= 0.0) w2 = 0.0000000001;
        g.add_edge(tileIndex, rd[1].tile_index, { weight: 1 / w2 });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_weight_mod_divide_min_offset_squared(map, weightModMatrix, baseOffset, bannedTiles, validTiles) {
    var nx = getNx();
    if (baseOffset === undefined || baseOffset === null) baseOffset = 0;
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    if (tiles.length === 0) return g;
    var minW = Infinity;
    for (var m = 0; m < tiles.length; m++) {
      var v = matrixRaw(weightModMatrix, tiles[m]);
      if (v < minW) minW = v;
    }
    var offset = -minW;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle || _banned(bannedTiles, tile)) continue;
      var fromWeight = baseOffset;
      fromWeight += matrixRaw(weightModMatrix, tile) + offset;
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;
      if (rd[0] && valid.has(rd[0]) && !rd[0].isObstacle && !_banned(bannedTiles, rd[0])) {
        var w = fromWeight + matrixRaw(weightModMatrix, rd[0]) + offset;
        if (w <= 0.0) w = 0.0000001;
        g.add_edge(tileIndex, rd[0].tile_index, { weight: 1000 / w / w });
      }
      if (rd[1] && valid.has(rd[1]) && !rd[1].isObstacle && !_banned(bannedTiles, rd[1])) {
        var w2 = fromWeight + matrixRaw(weightModMatrix, rd[1]) + offset;
        if (w2 <= 0.0) w2 = 0.0000001;
        g.add_edge(tileIndex, rd[1].tile_index, { weight: 1000 / w2 / w2 });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_weight_mod_divide_neg_scale(map, weightModMatrix, baseOffset, bannedTiles, validTiles) {
    var nx = getNx();
    if (baseOffset === undefined || baseOffset === null) baseOffset = 0;
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle || _banned(bannedTiles, tile)) continue;
      var fromWeight = baseOffset;
      fromWeight += matrixRaw(weightModMatrix, tile);
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;
      if (rd[0] && valid.has(rd[0]) && !rd[0].isObstacle && !_banned(bannedTiles, rd[0])) {
        var w = fromWeight + matrixRaw(weightModMatrix, rd[0]);
        g.add_edge(tileIndex, rd[0].tile_index, { weight: w > 0 ? 1 / w : -w });
      }
      if (rd[1] && valid.has(rd[1]) && !rd[1].isObstacle && !_banned(bannedTiles, rd[1])) {
        var w2 = fromWeight + matrixRaw(weightModMatrix, rd[1]);
        g.add_edge(tileIndex, rd[1].tile_index, { weight: w2 > 0 ? 1 / w2 : -w2 });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_weight_mod_scale(map, weightModMatrix, scaleToMin, scaleToMax,
                                                     bannedTiles, validTiles, negate) {
    var nx = getNx();
    if (scaleToMin === undefined || scaleToMin === null) scaleToMin = 0.0;
    if (scaleToMax === undefined || scaleToMax === null) scaleToMax = 1.0;
    if (negate === undefined) negate = true;
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    if (tiles.length === 0) return g;
    var maxW = -Infinity;
    var minW = Infinity;
    for (var m = 0; m < tiles.length; m++) {
      var v = matrixRaw(weightModMatrix, tiles[m]) * 2;
      if (v > maxW) maxW = v;
      if (v < minW) minW = v;
    }
    var width = maxW - minW;
    if (negate) {
      var tmp = scaleToMin;
      scaleToMin = scaleToMax;
      scaleToMax = tmp;
    }
    var targetWidth = scaleToMax - scaleToMin;

    var scale = function (weight) {
      var scaled = weight / width;
      return scaled * targetWidth + scaleToMin;
    };

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle || _banned(bannedTiles, tile)) continue;
      var fromWeight = matrixRaw(weightModMatrix, tile);
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;
      if (rd[0] && valid.has(rd[0]) && !rd[0].isObstacle && !_banned(bannedTiles, rd[0])) {
        g.add_edge(tileIndex, rd[0].tile_index, { weight: scale(fromWeight + matrixRaw(weightModMatrix, rd[0]) - minW) });
      }
      if (rd[1] && valid.has(rd[1]) && !rd[1].isObstacle && !_banned(bannedTiles, rd[1])) {
        g.add_edge(tileIndex, rd[1].tile_index, { weight: scale(fromWeight + matrixRaw(weightModMatrix, rd[1]) - minW) });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_value_and_weight_mod(map, weightModMatrix, valueMatrix, baseWeight,
                                                         bannedTiles, validTiles, valuePropName) {
    var nx = getNx();
    if (baseWeight === undefined || baseWeight === null) baseWeight = 1;
    if (valuePropName === undefined || valuePropName === null) valuePropName = 'value';
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var fromWeight = baseWeight;
      if (tile.isObstacle || _banned(bannedTiles, tile)) fromWeight += baseWeight * 1000;
      fromWeight -= matrixRaw(weightModMatrix, tile);
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;

      var props = {};
      props[valuePropName] = matrixRaw(valueMatrix, tile);
      g.add_node(tileIndex, props);

      if (rd[0] && valid.has(rd[0])) {
        var wr = fromWeight;
        if (rd[0].isObstacle || _banned(bannedTiles, rd[0])) wr += baseWeight * 1000;
        wr -= matrixRaw(weightModMatrix, rd[0]);
        g.add_edge(tileIndex, rd[0].tile_index, { weight: wr });
      }
      if (rd[1] && valid.has(rd[1])) {
        var wd = fromWeight;
        if (rd[1].isObstacle || _banned(bannedTiles, rd[1])) wd += baseWeight * 1000;
        wd -= matrixRaw(weightModMatrix, rd[1]);
        g.add_edge(tileIndex, rd[1].tile_index, { weight: wd });
      }
    }
    return g;
  }

  function build_networkX_graph_flat_value(map, valueMatrix, baseWeight, bannedTiles, validTiles, valuePropName) {
    var nx = getNx();
    if (baseWeight === undefined || baseWeight === null) baseWeight = 1;
    if (valuePropName === undefined || valuePropName === null) valuePropName = 'value';
    var valid = _validTilesOrDefault(map, validTiles);
    var g = new nx.Graph();
    var tiles = sortedByTileIndex(valid);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var fromWeight = baseWeight;
      if (tile.isObstacle || _banned(bannedTiles, tile)) fromWeight += baseWeight * 1000;
      var rd = _rightDown(map, tile);
      var tileIndex = tile.tile_index;

      var props = {};
      props[valuePropName] = matrixRaw(valueMatrix, tile);
      g.add_node(tileIndex, props);

      if (rd[0] && valid.has(rd[0])) {
        var wr = fromWeight;
        if (rd[0].isObstacle || _banned(bannedTiles, rd[0])) wr += baseWeight * 1000;
        g.add_edge(tileIndex, rd[0].tile_index, { weight: wr });
      }
      if (rd[1] && valid.has(rd[1])) {
        var wd = fromWeight;
        if (rd[1].isObstacle || _banned(bannedTiles, rd[1])) wd += baseWeight * 1000;
        g.add_edge(tileIndex, rd[1].tile_index, { weight: wd });
      }
    }
    return g;
  }

  var NetworkXHelpers = {
    build_networkX_graph_no_obstacles_no_weights: build_networkX_graph_no_obstacles_no_weights,
    build_networkX_graph_flat_weight_mod_subtract: build_networkX_graph_flat_weight_mod_subtract,
    build_networkX_graph_flat_weight_mod_divide_min_offset: build_networkX_graph_flat_weight_mod_divide_min_offset,
    build_networkX_graph_flat_weight_mod_divide_min_offset_squared: build_networkX_graph_flat_weight_mod_divide_min_offset_squared,
    build_networkX_graph_flat_weight_mod_divide_neg_scale: build_networkX_graph_flat_weight_mod_divide_neg_scale,
    build_networkX_graph_flat_weight_mod_scale: build_networkX_graph_flat_weight_mod_scale,
    build_networkX_graph_flat_value_and_weight_mod: build_networkX_graph_flat_value_and_weight_mod,
    build_networkX_graph_flat_value: build_networkX_graph_flat_value
  };

  /* ------------------------------------------------------------- GatherSteiner */

  function build_network_x_steiner_tree_from_arbitrary_nx_graph(map, g, requiredTiles) {
    var nx = getNx();
    var terminalNodes = [];
    var req = sortedByTileIndex(requiredTiles);
    for (var i = 0; i < req.length; i++) terminalNodes.push(req[i].tile_index);
    var steinerTree = nx.steiner_tree(g, terminalNodes, 'weight');
    var out = new Set();
    var nodes = steinerTree.nodes();
    for (var n = 0; n < nodes.length; n++) out.add(map.tiles_by_index[nodes[n]]);
    return out;
  }

  // 单个 mehlhorn 近似树，不迭代。重量口径：baseWeight - 两端价值之和（障碍额外加罚）。
  function build_network_x_steiner_tree(map, requiredTiles, weightMod, searchingPlayer, baseWeight, bannedTiles) {
    if (baseWeight === undefined || baseWeight === null) baseWeight = 1;
    var g = build_networkX_graph_flat_weight_mod_subtract(map, weightMod, baseWeight, bannedTiles, null);
    return build_network_x_steiner_tree_from_arbitrary_nx_graph(map, g, requiredTiles);
  }

  // prize-collecting 家族依赖 C++ 扩展 pcst_fast，没有 JS 等价实现。
  // 明确抛错而不是近似：近似会让同一输入出不同集合，比失败更难追。
  function _pcstUnavailable() {
    var err = new Error('gatherprune: GatherSteiner 的 prize-collecting 族依赖 pcst_fast（C++ 扩展），本移植未提供等价实现');
    err.code = 'pcst_unavailable';
    throw err;
  }

  var GatherSteiner = {
    build_network_x_steiner_tree: build_network_x_steiner_tree,
    build_network_x_steiner_tree_from_arbitrary_nx_graph: build_network_x_steiner_tree_from_arbitrary_nx_graph,
    get_prize_collecting_gather_mapmatrix: _pcstUnavailable,
    get_prize_collecting_gather_mapmatrix_set_module: _pcstUnavailable,
    _pcst_gradient_search: _pcstUnavailable,
    _pcst_gradient_quadrant_search: _pcstUnavailable,
    _pcst_gradient_descent_prize_basis: _pcstUnavailable,
    _pcst_iteration_internal: _pcstUnavailable
  };

  /* ------------------------------------------------- GathSetPruneReconnect 族 */

  // 实现在 gather.js（先移植在那里，且已按 Python 逐行核过顺序敏感点）。
  // 这里重新导出，保证调用方只需要认一个入口，也避免两处实现各自漂移。
  var GatherSetModule = EK.GatherSetPrune || EK.Gather || {};

  function _missingSetPrune(name) {
    return function () {
      throw new Error('gatherprune: 缺少 ' + name + '，需要先加载 src/eklipz/gather.js');
    };
  }

  var GathSetPruneReconnect = {
    get_gather_plan_set_prune: GatherSetModule.get_gather_plan_set_prune || _missingSetPrune('get_gather_plan_set_prune'),
    _k_prune_reconnect_greedy: GatherSetModule._k_prune_reconnect_greedy || _missingSetPrune('_k_prune_reconnect_greedy'),
    _reconnect: GatherSetModule._reconnect || _missingSetPrune('_reconnect'),
    _prune_connected: GatherSetModule._prune_connected || _missingSetPrune('_prune_connected'),
    get_spanning_tree_set_from_tile_lists_with_cost_per:
      (EK.Gather && EK.Gather.get_spanning_tree_set_from_tile_lists_with_cost_per) || _missingSetPrune('get_spanning_tree_set_from_tile_lists_with_cost_per')
  };

  /* --------------------------------------------------------- GatherPrizeSteiner */

  // 原版是 ChatGPT 草稿（文件头写着 TODO WRITTEN BY CHAT GPT / TODO ACTUALLY USE THIS），
  // 而且 Gather/__init__.py 里连 import 都注释掉了。照原样搬运：能调用，但一跑到
  // `u in active_sets`（Tile 对 frozenset 集合）就会抛错。不做「修好」——修了就不是
  // 同一份算法，也没人验证过它该产生什么结果。

  function powerset(iterable) { // 只用于 subsets 那行从未被读取的代码
    var s = Array.prototype.slice.call(iterable);
    var out = [];
    var n = 1 << s.length;
    for (var mask = 0; mask < n; mask++) {
      var combo = [];
      for (var i = 0; i < s.length; i++) if (mask & (1 << i)) combo.push(s[i]);
      out.push(combo);
    }
    return out;
  }

  function merge_active_sets(active_sets, edge) {
    var u = edge[0];
    var v = edge[1];
    var mergedSet = null;
    var list = Array.from(active_sets);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.has(u) || s.has(v)) {
        if (mergedSet === null) {
          mergedSet = s;
          active_sets.delete(s);
        } else {
          var merged = new Set(mergedSet);
          s.forEach(function (x) { merged.add(x); });
          mergedSet = merged;
          active_sets.delete(s);
        }
      }
    }
    active_sets.add(mergedSet);
    return active_sets;
  }

  function pcst_gw(root, penalties) {
    var forest = new Set();
    var active_sets = new Set();
    var dead_sets = new Set();
    var y_s = new Map();
    penalties.forEach(function (_v, t) {
      active_sets.add(new Set([t]));
    });
    active_sets.forEach(function (s) { y_s.set(s, 0); });

    var penaltiesOf = function (s) {
      var sum = 0;
      s.forEach(function (v) { sum += penalties.get(v) || 0; });
      return sum;
    };
    var ySumOfSubsets = function (target) {
      var sum = 0;
      active_sets.forEach(function (t) {
        var subset = true;
        t.forEach(function (x) { if (!target.has(x)) subset = false; });
        if (subset) sum += y_s.get(t) || 0;
      });
      return sum;
    };

    var edges = [];
    penalties.forEach(function (_v, u) {
      for (var i = 0; i < u.movable.length; i++) {
        if (u !== u.movable[i]) edges.push([u, u.movable[i]]);
      }
    });

    var find_min_delta = function () {
      var delta1 = Infinity;
      active_sets.forEach(function (s) {
        var v = penaltiesOf(s) - ySumOfSubsets(s);
        if (v < delta1) delta1 = v;
      });
      var delta2 = Infinity;
      for (var e = 0; e < edges.length; e++) {
        var u = edges[e][0];
        var v = edges[e][1];
        var inU = active_sets.has(u);
        var inV = active_sets.has(v);
        if (inU !== inV) {
          var target = new Set([u, v]);
          var val = 1 - ySumOfSubsets(target);
          if (val < delta2) delta2 = val;
        }
      }
      return Math.min(delta1, delta2);
    };

    while (active_sets.size > 1) {
      var delta = find_min_delta();
      var toRemove = [];
      active_sets.forEach(function (s) {
        y_s.set(s, (y_s.get(s) || 0) + delta);
        if (penaltiesOf(s) - ySumOfSubsets(s) <= 0) toRemove.push(s);
      });
      for (var r = 0; r < toRemove.length; r++) {
        active_sets.delete(toRemove[r]);
        dead_sets.add(toRemove[r]);
      }
      var mergedSomething = false;
      for (var e2 = 0; e2 < edges.length; e2++) {
        var u2 = edges[e2][0];
        var v2 = edges[e2][1];
        var pair = new Set([u2, v2]);
        if (ySumOfSubsets(pair) >= 1) {
          // 用一个可比较的键代表这条边（Python 里加的是 (u, v) 元组）。
          forest.add(u2.tile_index + ',' + v2.tile_index);
          merge_active_sets(active_sets, [u2, v2]);
          mergedSomething = true;
        }
      }
      if (!mergedSomething && active_sets.size > 1) break;
    }

    var final_tree = new Set(forest);
    dead_sets.forEach(function (s) {
      var touching = [];
      final_tree.forEach(function (e) {
        var parts = e.split(',');
        if (s.has(Number(parts[0])) || s.has(Number(parts[1]))) touching.push(e);
      });
      if (touching.length === 1) final_tree.delete(touching[0]);
    });

    return [final_tree, dead_sets];
  }

  function calculate_cost(tree, penalties) {
    var cost = tree.size;
    penalties.forEach(function (penalty, node) {
      if (!tree.has(node)) cost += penalty;
    });
    return cost;
  }

  function minimum_spanning_tree(nodes) {
    return nodes;
  }

  function iterative_pcst(root, penalties, beta) {
    var penalties_beta = new Map();
    penalties.forEach(function (penalty, node) { penalties_beta.set(node, penalty / beta); });
    var gw = pcst_gw(root, penalties_beta);
    var tree_gw = gw[0];
    var dead_nodes = gw[1];

    var live_nodes = new Set();
    penalties.forEach(function (_p, v) { if (!dead_nodes.has(v)) live_nodes.add(v); });
    var tree_st = minimum_spanning_tree(live_nodes);

    var allDead = true;
    dead_nodes.forEach(function (node) { if ((penalties.get(node) || 0) !== 0) allDead = false; });
    if (allDead) {
      return calculate_cost(tree_gw, penalties) <= calculate_cost(tree_st, penalties) ? tree_gw : tree_st;
    }
    dead_nodes.forEach(function (node) { penalties.set(node, 0); });
    var tree_it = iterative_pcst(root, penalties, beta);
    var best = tree_gw;
    var bestCost = calculate_cost(best, penalties);
    var stCost = calculate_cost(tree_st, penalties);
    if (stCost < bestCost) { best = tree_st; bestCost = stCost; }
    var itCost = calculate_cost(tree_it, penalties);
    if (itCost < bestCost) best = tree_it;
    return best;
  }

  var GatherPrizeSteiner = {
    pcst_gw: pcst_gw,
    merge_active_sets: merge_active_sets,
    powerset: powerset,
    iterative_pcst: iterative_pcst,
    calculate_cost: calculate_cost,
    minimum_spanning_tree: minimum_spanning_tree
  };

  /* ------------------------------------------------------------------ 导出 */

  EK.GatherPrune = GatherPrune;
  EK.GathSetPruneReconnect = GathSetPruneReconnect;
  EK.GatherSteiner = GatherSteiner;
  EK.GatherPrizeSteiner = GatherPrizeSteiner;
  EK.NetworkXHelpers = NetworkXHelpers;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

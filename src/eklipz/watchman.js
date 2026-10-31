/*
 * Watchman 路线（原版 Algorithms/WatchmanRouteUtils.py，909 行）的 JS 移植。
 *
 * 这是「守望路线」问题：从一格出发，用最短的路线把一批迷雾格看开。
 * 原版用 pivot A* 抽象：先把待看格按「最不被看见」贪心挑成互不相邻的 pivot，
 * 每个 pivot 的 watcher 集合算一个 component；搜索时只要走进某 component 的
 * watcher，就把那个 component 从「还没覆盖」里去掉。启发值取 component 的
 * watcher 到当前格的距离，避免逐格暴力。
 *
 * 搬运范围：
 *   - get_watchman_path / PivotWRP / PivotIterativeWRP / PivotComponent /
 *     FrontierAStarNode / get_revealed_count_and_max_kill_turns_and_positive_path
 *   - 跳过 BasicAStarWRP / BasicAStarNode（原版注释自称 dumb，且不在此路径上）
 *   - 跳过 connect_graph / get_tsp_path / mst_heuristic / tsp_heuristic：原版
 *     __init__ 里 connect_graph 已被注释掉，实际只走纯 pivot-A* 分支；这几个
 *     函数依赖 networkx 与全对最短路，搬过来只有死重量。
 *
 * 与原版的三处刻意差异：
 *   1. Python 的 set 迭代序是哈希表序。这里所有集合都按显式顺序处理：待看格
 *      按调用方传入顺序、component 按 pivot 构建顺序，堆元素相等时按插入序号
 *      决胜，保证同一输入永远同一条路线。
 *   2. 原版 unseen 是 set[Tile]，用 hash((tile_index, tuple(unseen))) 去重。
 *      这里用 Uint32 位图加位串签名，语义等价（同格且同剩余集合才算同节点）。
 *   3. deterministicTime 开关：oracle 比对时把墙钟钉成 0，等价于「永不超时、
 *      完全展开」；线上仍然按真实墙钟提前退出。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 原版 PivotWRP.longest_crossing 初值。connect_graph 不会被调用，所以恒为它。
  var LONGEST_CROSSING = 20;

  /* ---------------- 待看格位图 ---------------- */

  function Unseen(wordCount) {
    this.words = new Uint32Array(wordCount);
    this.count = 0;
  }

  Unseen.prototype.clone = function () {
    var u = new Unseen(this.words.length);
    u.words.set(this.words);
    u.count = this.count;
    return u;
  };

  Unseen.prototype.hasIndex = function (idx) {
    var w = idx >>> 5;
    return (this.words[w] & (1 << (idx & 31))) !== 0;
  };

  Unseen.prototype.addIndex = function (idx) {
    var w = idx >>> 5;
    var bit = 1 << (idx & 31);
    if ((this.words[w] & bit) === 0) {
      this.words[w] |= bit;
      this.count += 1;
      return true;
    }
    return false;
  };

  Unseen.prototype.removeIndex = function (idx) {
    var w = idx >>> 5;
    var bit = 1 << (idx & 31);
    if ((this.words[w] & bit) !== 0) {
      this.words[w] &= ~bit;
      this.count -= 1;
      return true;
    }
    return false;
  };

  // 节点去重键，等价于 Python 的 hash((tile_index, tuple(unseen)))
  Unseen.prototype.key = function () {
    var out = '';
    for (var i = 0; i < this.words.length; i++) out += this.words[i].toString(36) + '.';
    return out;
  };

  function unseenFromTiles(tiles, tileCount) {
    var u = new Unseen((tileCount + 31) >>> 5);
    for (var i = 0; i < tiles.length; i++) u.addIndex(tiles[i].tile_index);
    return u;
  }

  /* ---------------- 堆（比较顺序照 Python heapq） ---------------- */

  function HeapNode(total, negCost, node) {
    this.total = total;
    this.negCost = negCost;
    this.node = node;
  }

  // Python 比较的是元组 (total_estimated_cost, node)，而 node.__lt__ 是
  // (total, 0 - cost)；两者全等时 __lt__ 两向皆 False。这里刻意不加序号，
  // 靠复刻 heapq 的 sift 顺序（相等时把右孩子往上提）拿到同样的出堆次序。
  function heapLess(a, b) {
    if (a.total !== b.total) return a.total < b.total;
    return a.negCost < b.negCost;
  }

  function siftDown(less, items, startpos, pos) {
    var newitem = items[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = items[parentpos];
      if (less(newitem, parent)) {
        items[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    items[pos] = newitem;
  }

  function siftUp(less, items, pos) {
    var endpos = items.length;
    var startpos = pos;
    var newitem = items[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      if (rightpos < endpos && !less(items[childpos], items[rightpos])) childpos = rightpos;
      items[pos] = items[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    items[pos] = newitem;
    siftDown(less, items, startpos, pos);
  }

  function Heap() {
    this.items = [];
  }

  Heap.prototype.push = function (total, negCost, node) {
    this.items.push(new HeapNode(total, negCost, node));
    siftDown(heapLess, this.items, 0, this.items.length - 1);
  };

  Heap.prototype.pop = function () {
    var items = this.items;
    if (items.length === 0) return null;
    var last = items.pop();
    if (items.length === 0) return last;
    var top = items[0];
    items[0] = last;
    siftUp(heapLess, items, 0);
    return top;
  };

  Heap.prototype.size = function () {
    return this.items.length;
  };

  // pivots 用的最小堆：(numUnseenAdj, tile)，并列时 Python 落到 Tile.__lt__（只比 army）
  function PivotHeap() {
    this.items = [];
  }

  function pivotLess(a, b) {
    if (a.n !== b.n) return a.n < b.n;
    return a.army < b.army;
  }

  PivotHeap.prototype.push = function (numUnseenAdj, tile) {
    this.items.push({ n: numUnseenAdj, army: tile.army, tile: tile });
    siftDown(pivotLess, this.items, 0, this.items.length - 1);
  };

  PivotHeap.prototype.pop = function () {
    var items = this.items;
    if (items.length === 0) return null;
    var last = items.pop();
    if (items.length === 0) return last;
    var top = items[0];
    items[0] = last;
    siftUp(pivotLess, items, 0);
    return top;
  };

  /* ---------------- 图元 ---------------- */

  function PivotComponent(pivot, frontierNodes) {
    this.pivot = pivot;
    this.frontier_nodes = frontierNodes;
  }

  function isUntraversable(map, t) {
    if (t.isObstacle) return true;
    // 预测出来的迷雾城不算可通行，城墙城/低cost城玩法除外
    return (
      t.isCity &&
      t.isTempFogPrediction &&
      !map.is_walled_city_game &&
      !map.is_low_cost_city_game
    );
  }

  function FrontierNode(tile, unseen, unseenComponents, path, costSoFar, army) {
    this.tile = tile;
    this.unseen = unseen;
    this.unseen_components = unseenComponents;
    this.path = path;
    this.cost_so_far = costSoFar;
    this.heuristic_cost_remaining = 0;
    this.total_estimated_cost = 0;
    this.army = army === undefined ? 0 : army;
    this._key = null;
  }

  FrontierNode.prototype.key = function () {
    if (this._key === null) this._key = this.tile.tile_index + '|' + this.unseen.key();
    return this._key;
  };

  /* ---------------- PivotWRP ---------------- */

  function PivotWRP(map, start, toDiscover, initialArmy) {
    this.map = map;
    this.start = start;
    this.to_discover = toDiscover;
    this.initial_army = initialArmy;
    this.tile_count = map.tiles_by_index.length;
    this.pivot_set = this.build_pivots(toDiscover);
    this.component_lookup = null;
    this.components = null;
    this.frontiers = null;
    this.longest_crossing = LONGEST_CROSSING;
    this.build_frontiers();
  }

  PivotWRP.prototype.build_pivots = function (toDiscover) {
    var map = this.map;
    var pivots = [];
    var validRemaining = new Set();
    var i;
    for (i = 0; i < toDiscover.length; i++) validRemaining.add(toDiscover[i].tile_index);

    var heap = new PivotHeap();
    for (i = 0; i < toDiscover.length; i++) {
      var t = toDiscover[i];
      var numUnseenAdj = 0;
      for (var a = 0; a < t.adjacents.length; a++) {
        var adj = t.adjacents[a];
        if (isUntraversable(map, adj)) continue;
        if (!validRemaining.has(adj.tile_index)) continue;
        numUnseenAdj += 1;
      }
      heap.push(numUnseenAdj, t);
    }

    while (heap.items.length > 0) {
      var item = heap.pop();
      var tile = item.tile;
      if (!validRemaining.has(tile.tile_index)) continue;
      pivots.push(tile);
      for (var x = 0; x < tile.adjacents.length; x++) {
        var adjTiles = tile.adjacents[x].adjacents;
        for (var y = 0; y < adjTiles.length; y++) validRemaining.delete(adjTiles[y].tile_index);
      }
      validRemaining.delete(tile.tile_index);
    }

    return pivots;
  };

  PivotWRP.prototype.build_frontiers = function () {
    var map = this.map;
    var frontiers = new Set();
    var lookup = new Array(this.tile_count);
    for (var z = 0; z < lookup.length; z++) lookup[z] = null;
    var components = [];

    for (var p = 0; p < this.pivot_set.length; p++) {
      var pivot = this.pivot_set[p];
      var watchers = [];
      for (var a = 0; a < pivot.adjacents.length; a++) {
        var t = pivot.adjacents[a];
        if (isUntraversable(map, t)) continue;

        // 只有当某个相邻格能从 pivot 之外的地方进来，它才算「观察点」
        var canOnlyPathInThroughAnotherAdj = true;
        for (var m = 0; m < t.movable.length; m++) {
          var fromTile = t.movable[m];
          if (isUntraversable(map, fromTile)) continue;
          var inPivotAdj = false;
          for (var pa = 0; pa < pivot.adjacents.length; pa++) {
            if (pivot.adjacents[pa] === fromTile) {
              inPivotAdj = true;
              break;
            }
          }
          if (!inPivotAdj && fromTile !== pivot) {
            canOnlyPathInThroughAnotherAdj = false;
            break;
          }
        }

        if (canOnlyPathInThroughAnotherAdj) continue;
        watchers.push(t);
      }

      if (watchers.length === 0) continue; // 原版这里只记日志并跳过该 pivot

      var component = new PivotComponent(pivot, watchers);
      for (var w = 0; w < watchers.length; w++) {
        frontiers.add(watchers[w].tile_index);
        lookup[watchers[w].tile_index] = component;
      }
      lookup[pivot.tile_index] = component;
      components.push(component);
    }

    this.frontiers = frontiers;
    this.components = components;
    this.component_lookup = lookup;
  };

  PivotWRP.prototype.heuristic = function (node) {
    var h = Math.floor(node.unseen.count / 3);
    if (h < this.longest_crossing) {
      var dmapper = this.map.distance_mapper;
      for (var c = 0; c < node.unseen_components.length; c++) {
        var component = node.unseen_components[c];
        var best = Infinity;
        for (var i = 0; i < component.frontier_nodes.length; i++) {
          var d = dmapper.get_distance_between_dual_cache(component.frontier_nodes[i], node.tile);
          if (d < best) best = d;
        }
        if (best > h) h = best;
      }
    }
    return h;
  };

  /* ---------------- 唯一被 get_watchman_path 调用的求解器 ---------------- */

  function PivotIterativeWRP(map, start, toDiscover, initialArmy, deterministicTime) {
    PivotWRP.call(this, map, start, toDiscover, initialArmy);
    this.deterministic_time = !!deterministicTime;
  }

  PivotIterativeWRP.prototype = Object.create(PivotWRP.prototype);
  PivotIterativeWRP.prototype.constructor = PivotIterativeWRP;

  function rebuildLenThreshs(cutoffThresh, w) {
    var out = new Array(cutoffThresh + 2);
    for (var i = 0; i < out.length; i++) out[i] = i + (cutoffThresh - i) * w;
    return out;
  }

  PivotIterativeWRP.prototype.solve = function (cutoffTime) {
    var deterministic = this.deterministic_time;
    var now = deterministic
      ? function () {
          return 0;
        }
      : function () {
          return Date.now() / 1000;
        };
    if (!cutoffTime) cutoffTime = now() + 1000;

    var bestPath = null;
    var bestUnseen = 1000;
    var bestTurns = 0;

    var cutoffThresh = 100;
    var w = 3.0;
    var start = now();
    var tileCount = this.tile_count;

    var quickIterCutoff = Math.max(0.003, (cutoffTime - start) * 0.1);
    var nextIterCutoffTime = Math.min(cutoffTime, start + Math.min(start + 1.0, quickIterCutoff));

    while (w >= 1.0 && cutoffTime >= now()) {
      var startUnseen = unseenFromTiles(this.to_discover, tileCount);
      var startNode = new FrontierNode(this.start, startUnseen, this.components.slice(), [this.start], 0, 0);
      var openList = new Heap();
      openList.push(startNode.total_estimated_cost, 0, startNode);
      var closedSet = new Set();
      var iteration = 0;

      // lenThreshs[i]：走到 i 步时允许的最大估总值
      var lenThreshs = rebuildLenThreshs(cutoffThresh, w);

      while (openList.size() > 0) {
        iteration += 1;
        var popped = openList.pop();
        if (popped === null) break;
        var currentNode = popped.node;

        if (closedSet.has(currentNode.key())) continue;

        var unseenCount = currentNode.unseen.count;

        if (unseenCount < bestUnseen) {
          bestTurns = currentNode.path.length - 1;
          bestPath = currentNode.path;
          bestUnseen = unseenCount;
        }

        if (unseenCount === 0) {
          var curTurns = currentNode.path.length - 1;
          if (bestPath === null || curTurns < cutoffThresh) {
            bestPath = currentNode.path;
            cutoffThresh = curTurns;
            bestTurns = curTurns;
            bestUnseen = unseenCount;
          }
          lenThreshs = rebuildLenThreshs(cutoffThresh, w);
          break;
        }

        if ((iteration & 63) === 0 && nextIterCutoffTime < now()) {
          nextIterCutoffTime = cutoffTime;
          break;
        }

        closedSet.add(currentNode.key());

        var movables = currentNode.tile.movable;
        for (var mi = 0; mi < movables.length; mi++) {
          var neighbor = movables[mi];
          if (isUntraversable(this.map, neighbor)) continue;

          var component = this.component_lookup[neighbor.tile_index];
          var unseenComp = currentNode.unseen_components;
          if (component) {
            unseenComp = unseenComp.filter(function (c) {
              return c !== component;
            });
          }

          var newUnseen = currentNode.unseen.clone();
          var adjacents = neighbor.adjacents;
          for (var ai = 0; ai < adjacents.length; ai++) newUnseen.removeIndex(adjacents[ai].tile_index);

          var neighborNode = new FrontierNode(
            neighbor,
            newUnseen,
            unseenComp,
            currentNode.path.concat(neighbor),
            currentNode.cost_so_far + 1,
            0
          );

          if (closedSet.has(neighborNode.key())) continue;

          neighborNode.heuristic_cost_remaining = this.heuristic(neighborNode) * w;
          neighborNode.total_estimated_cost =
            neighborNode.cost_so_far + neighborNode.heuristic_cost_remaining;

          var thresh = lenThreshs[neighborNode.cost_so_far];
          // 原版这里会 IndexError（假定 cost 不超过 cutoffThresh+1）；越界当不剪枝
          if (thresh !== undefined && neighborNode.total_estimated_cost >= thresh) continue;

          openList.push(neighborNode.total_estimated_cost, -neighborNode.cost_so_far, neighborNode);
        }
      }

      w = w - 0.5;
      nextIterCutoffTime = cutoffTime;
    }

    if (!bestPath) return null;

    var finalPath = new EK.Path();
    for (var pi = 0; pi < bestPath.length; pi++) finalPath.add_next(bestPath[pi]);
    return finalPath;
  };

  /* ---------------- 对外入口 ---------------- */

  function get_watchman_path(map, startTile, toDiscover, timeLimit, initialArmy, deterministicTime) {
    if (timeLimit === undefined || timeLimit === null) timeLimit = 1000.0;
    if (initialArmy === undefined || initialArmy === null) initialArmy = -1;
    if (initialArmy === -1) initialArmy = startTile.army;

    // 原版是 set(toDiscover)：去重，保持调用方顺序（见文件头差异 1）
    var tiles = [];
    var seen = new Set();
    for (var i = 0; i < toDiscover.length; i++) {
      var t = toDiscover[i];
      if (!t || seen.has(t.tile_index)) continue;
      seen.add(t.tile_index);
      tiles.push(t);
    }

    var startTime = deterministicTime ? 0 : Date.now() / 1000;
    var wrp = new PivotIterativeWRP(map, startTile, tiles, initialArmy, deterministicTime);
    var path = wrp.solve(startTime + timeLimit);

    if (path === null || path.length === 0) return null;
    return path;
  }

  function get_revealed_count_and_max_kill_turns_and_positive_path(
    map,
    path,
    toReveal,
    cutoffKillArmy,
    maxKillTurnsDistanceOffsetCutoff
  ) {
    if (cutoffKillArmy === undefined) cutoffKillArmy = 0;
    if (maxKillTurnsDistanceOffsetCutoff === undefined) maxKillTurnsDistanceOffsetCutoff = 15;

    var unrevealed = new Set();
    for (var r0 = 0; r0 < toReveal.length; r0++) unrevealed.add(toReveal[r0].tile_index);
    var ogLen = unrevealed.size;

    if (path === null || path === undefined || ogLen === 0) {
      return {
        revealedCount: 0,
        maxKillTurns: 1000,
        minKillTurns: 1000,
        avgKillTurns: 1000.0,
        killDistMap: new EK.MapMatrix(map, 1000),
        positivePath: path === undefined ? null : path,
      };
    }

    var distMap = new EK.MapMatrix(map, 1000);
    var visited = new Set();
    var wentPositive = false;
    var army = 0;
    var finalArmy = 0;
    var idx = 0;
    var tileList = path.tileList;
    var len = tileList.length;

    for (idx = 0; idx < len; idx++) {
      var t = tileList[idx];
      if (visited.has(t.tile_index)) continue;

      if (map.is_tile_friendly(t)) army += t.army;
      else army -= t.army;
      army -= 1;

      if (army <= cutoffKillArmy) {
        if (wentPositive) break;
      } else {
        wentPositive = true;
      }

      finalArmy = army;
      visited.add(t.tile_index);

      for (var a = 0; a < t.adjacents.length; a++) {
        var adj = t.adjacents[a];
        if (unrevealed.has(adj.tile_index)) {
          unrevealed.delete(adj.tile_index);
          distMap.raw[adj.tile_index] = map.distance_mapper.get_distance_between(t, adj) + idx;
        }
      }

      if (unrevealed.size === 1) {
        var lastTileIndex = unrevealed.values().next().value;
        unrevealed.delete(lastTileIndex);
        distMap.raw[lastTileIndex] =
          map.distance_mapper.get_distance_between(t, map.tiles_by_index[lastTileIndex]) + idx;
      }
    }

    // 原版在 break 时用当前下标截断路径；跑完整个循环则下标是 len-1 == path.length，不截断
    var lastIndex = Math.min(idx, len - 1);
    if (lastIndex < path.length) path = path.get_subsegment(lastIndex);

    var maxKillTurns = -Infinity;
    var minKillTurns = Infinity;
    var total = 0;
    for (var r = 0; r < toReveal.length; r++) {
      var v = distMap.raw[toReveal[r].tile_index];
      if (v > maxKillTurns) maxKillTurns = v;
      if (v < minKillTurns) minKillTurns = v;
      total += v;
    }
    var avgKillTurns = total / ogLen;

    path.value = finalArmy;

    var positivePath = revealedCountOf(ogLen, unrevealed.size) === 0 || !wentPositive ? null : path;

    return {
      revealedCount: ogLen - unrevealed.size,
      maxKillTurns: maxKillTurns,
      minKillTurns: minKillTurns,
      avgKillTurns: avgKillTurns,
      killDistMap: distMap,
      positivePath: positivePath,
    };
  }

  function revealedCountOf(ogLen, remaining) {
    return ogLen - remaining;
  }

  var wm = (EK.Watchman = EK.Watchman || {});
  wm.PivotWRP = PivotWRP;
  wm.PivotIterativeWRP = PivotIterativeWRP;
  wm.PivotComponent = PivotComponent;
  wm.FrontierAStarNode = FrontierNode;
  wm.get_watchman_path = get_watchman_path;
  wm.get_revealed_count_and_max_kill_turns_and_positive_path =
    get_revealed_count_and_max_kill_turns_and_positive_path;
})(typeof window !== 'undefined' ? window : global);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : global).__EK;
}

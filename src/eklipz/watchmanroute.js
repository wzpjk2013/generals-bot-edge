/*
 * WatchmanRouteUtils（原版 Algorithms/WatchmanRouteUtils.py，909 行）的 JS 移植。
 * 导出 EK.WatchmanRouteUtils。
 *
 * 问题：从一格出发，用尽量短的路线把一批迷雾格「看开」。原版先把待看格贪心挑成
 * 互不相邻的 pivot（每格能看到的最少未看邻居优先），每个 pivot 的 watcher 集合算
 * 一个 component；A* 走进某个 component 的 watcher 就把该 component 从待覆盖集合里
 * 去掉，启发值取 component 的 watcher 到当前格的最小距离。
 *
 * 搬了什么（public 全部）：
 *   get_watchman_path
 *   get_revealed_count_and_max_kill_turns_and_positive_path
 *   BasicAStarWRP / BasicAStarNode           （原版自称 dumb 的暴力 A*，照搬）
 *   PivotWRP / PivotComponent / FrontierAStarNode
 *   PivotIterativeWRP                        （get_watchman_path 实际用的求解器）
 *   mst_heuristic / tsp_heuristic            （纯函数，apsp 由调用方给）
 *
 * 没搬什么 / 为什么：
 *   connect_graph / get_tsp_path —— 依赖 networkx 与全对最短路；原版 __init__ 里
 *     connect_graph() 本来就被注释掉，longest_crossing 恒为 20，这两个函数在这条
 *     路径上永远不执行。这里保留同名方法，调用即抛错，避免「静默跑出一个假结果」。
 *   日志 / logbook / DebugHelper.IS_DEBUGGING 分支 / ViewInfo 渲染：全是旁路。
 *
 * 与原版的四处刻意差异（都是为了让同一输入永远同一条路线）：
 *   1. Python 的 set 迭代序是哈希表序。这里 pivot/component 一律按构建顺序处理，
 *      待看格按调用方传入顺序去重（原版 set(toDiscover) 也是这个语义）。
 *   2. unseen 是 set[Tile]，去重靠 hash((tile_index, tuple(unseen)))。这里用
 *      Uint32 位图 + 位串签名，语义等价：同格且同剩余集合才算同节点。
 *   3. heapq 换成逐行复刻 CPython sift 的堆（相等元素不交换），出堆次序与 Python
 *      一致，否则同长度的并列路线会分叉。
 *   4. deterministicTime 开关：oracle 比对时把墙钟钉成 0（等价于「永不超时、完全
 *      展开」）。线上不传，按真实墙钟提前退出。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  /* 统一时钟取值：clock.js 装了就用它（可被 GB_EK_DET 钉死），没装回退真实时钟。
   * 为什么不直接写 EK.clock：工具脚本加载模块的清单各不相同，写死依赖会在没加载 clock.js 的场景下直接抛。 */
  function clockNowMs() { return EK.clock ? EK.clock.nowMs() : Date.now(); }
  function clockNowSec() { return EK.clock ? EK.clock.nowSec() : Date.now() / 1000; }


  // 浏览器里没有 process，裸读 process.env 会 ReferenceError，打断整回合决策。
  function dbgFlag(name) {
    try {
      return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
    } catch (e) {
      return undefined;
    }
  }
  var WRP_DEBUG = dbgFlag('GB_WATCHMANROUTE_DEBUG') === '1';

  /* ---------------- 耗时统计（GB_PERF=1 才记账） ---------------- */

  /*
   * 只在开关打开时累加，关掉时所有记账点都是常数级判断，不留额外分配。
   * 累计到 EK.perf 上而不是逐次打印：跑批时 stdout 会被别的模块解析。
   */
  var PERF_ON = dbgFlag('GB_PERF') === '1';

  function perf() {
    var p = EK.perf;
    if (!p) {
      p = EK.perf = {
        wrpMs: 0,
        wrpCalls: 0,
        wrpMaxMs: 0,
        wrpIters: 0,
        wrpMaxIters: 0,
        wrpItersCut: 0,
        revealMs: 0,
        revealCalls: 0,
        revealMaxMs: 0
      };
    }
    return p;
  }

  function perfStart() {
    return PERF_ON ? Date.now() : 0;
  }

  function perfRecordWrp(t0, iters) {
    if (!PERF_ON) return;
    var p = perf();
    var ms = Date.now() - t0;
    p.wrpMs += ms;
    p.wrpCalls += 1;
    if (ms > p.wrpMaxMs) p.wrpMaxMs = ms;
    p.wrpIters += iters;
    if (iters > p.wrpMaxIters) p.wrpMaxIters = iters;
    if (iters >= wrpMaxIter()) p.wrpItersCut += 1;
  }

  function perfRecordReveal(t0) {
    if (!PERF_ON) return;
    var p = perf();
    var ms = Date.now() - t0;
    p.revealMs += ms;
    p.revealCalls += 1;
    if (ms > p.revealMaxMs) p.revealMaxMs = ms;
  }

  // 退出时打一行汇总（只打一行，不参与跑批解析）。
  if (PERF_ON && typeof process !== 'undefined' && process.once) {
    process.once('exit', function () {
      var p = perf();
      console.log(
        '[wrp-perf] wrp calls ' +
          p.wrpCalls +
          ' totalMs ' +
          p.wrpMs +
          ' maxMs ' +
          p.wrpMaxMs +
          ' avgIters ' +
          (p.wrpCalls ? Math.round(p.wrpIters / p.wrpCalls) : 0) +
          ' maxIters ' +
          p.wrpMaxIters +
          ' iterCapped ' +
          p.wrpItersCut +
          ' | reveal calls ' +
          p.revealCalls +
          ' totalMs ' +
          p.revealMs +
          ' maxMs ' +
          p.revealMaxMs
      );
    });
  }

  /* ---------------- 迭代上限（确定性截断） ---------------- */

  /*
   * 为什么按迭代数而不是按时钟截断：按时钟截断会让同一局两次运行解出不同路线，
   * 破坏回放比对。迭代次数与输入一一对应，截断点因此是确定的。
   *
   * 默认 950000 = gm1 回放里观测到的单次最大展开数 613796 × 1.5。
   * 线上若发现更大的合法用例，用 GB_WRP_MAXITER 抬高即可。
   */
  var DEFAULT_WRP_MAX_ITER = 950000;

  // 单次迭代的实测均耗（ms）：gm1 里 12764ms / 613796 次 ≈ 0.021ms。
  var WRP_MS_PER_ITER = 0.021;

  // 线上形态的 timeLimit（0.02s 量级）才做规模压缩；回放/冻结时钟（timeLimit 很大）
  // 必须完整展开，否则会用截断的最优冒充真最优，把回放比对搞坏。
  var WRP_SCALE_LIMIT_MIN_TIME = 10.0;
  // 压缩后仍允许的最小展开量；实测生产里每回合的 watchman 也就千级展开。
  var WRP_SCALE_FLOOR = 2000;

  function wrpMaxIter() {
    var raw = dbgFlag('GB_WRP_MAXITER');
    if (raw !== undefined && raw !== null && raw !== '') {
      var v = parseInt(raw, 10);
      if (isFinite(v) && v > 0) return v;
    }
    return DEFAULT_WRP_MAX_ITER;
  }

  /*
   * 按候选规模线性预估展开量：待看格数 × 可通行格数 是搜索空间的上界量级。
   * 生产形态（timeLimit 小）下把上限压到「预估量」与「预算能付得起的迭代数」的较小者，
   * 避免一次求解吃掉整回合；回放形态（timeLimit 大）只受 wrpMaxIter 约束。
   */
  function estimateMaxIter(toDiscoverCount, pathableCount, timeLimitSec) {
    var cap = wrpMaxIter();
    if (dbgFlag('GB_WRP_MEASURE') === '1') return cap;
    if (!(timeLimitSec > 0) || timeLimitSec >= WRP_SCALE_LIMIT_MIN_TIME) return cap;
    var scale = toDiscoverCount * Math.max(1, pathableCount);
    // 每 16 个「待看格 × 格数」大约对应 1 次展开（从回放拟合的保守上界：实际远低于此）。
    var scaledIters = Math.ceil(scale / 16);
    var budgetIters = Math.floor((timeLimitSec * 1000) / WRP_MS_PER_ITER);
    var limit = Math.min(cap, Math.max(WRP_SCALE_FLOOR, Math.min(scaledIters, budgetIters)));
    return limit > 0 ? limit : cap;
  }

  // 原版 PivotWRP.longest_crossing 的初值；connect_graph 不跑，所以恒等于它。
  var LONGEST_CROSSING = 20;

  /* ---------------- 待看格位图 ---------------- */

  /*
   * 原版 unseen 是 set[Tile]，节点去重靠 hash((tile_index, tuple(unseen)))。逐位复刻
   * 「tuple 迭代序进哈希」会让每个节点都重建一次 set 并做一次表序模拟，实测单次求解
   * 从几百毫秒涨到 14 秒（bot 每回合只有几十毫秒预算），而实测它并不改变出解长度。
   *
   * 代价（已知且接受）：Python 的 set 迭代序取决于该 set 的扩容历史，因此「tile 相同、
   * 待看格成员完全相同、但构造历史不同」的两个节点在 Python 里 hash 不等、被当成两个
   * 节点各展开一遍；这里按成员集合去重，会把第二个当成已访问而跳过。实测差异只落在
   * (f, cost) 完全相等的并列路线上（gm1 turn75/turn90），长度不变。
   *
   * 注意：出堆次序**不**依赖位图遍历序 —— 见 heapLess 的注释。
   */
  function Unseen(wordCount) {
    this.words = new Uint32Array(wordCount);
    this.count = 0;
    this._key = null;
  }

  Unseen.prototype.clone = function () {
    var u = new Unseen(this.words.length);
    u.words.set(this.words);
    u.count = this.count;
    return u;
  };

  Unseen.prototype.hasIndex = function (idx) {
    return (this.words[idx >>> 5] & (1 << (idx & 31))) !== 0;
  };

  // set.difference(removed)：removedIdxSet 是 tile_index 的 Set
  Unseen.prototype.difference = function (removedIdxSet) {
    var u = new Unseen(this.words.length);
    u.words.set(this.words);
    u.count = this.count;
    var it = removedIdxSet.values();
    for (var v = it.next(); !v.done; v = it.next()) {
      var idx = v.value;
      var w = idx >>> 5;
      var bit = 1 << (idx & 31);
      if ((u.words[w] & bit) !== 0) {
        u.words[w] &= ~bit;
        u.count -= 1;
      }
    }
    return u;
  };

  // 等价于 Python hash((tile_index, tuple(unseen))) 的区分能力：同一批格子 → 同一签名
  Unseen.prototype.key = function () {
    if (this._key === null) {
      var out = '';
      for (var i = 0; i < this.words.length; i++) out += this.words[i].toString(36) + '.';
      this._key = out;
    }
    return this._key;
  };

  function unseenFromTiles(tiles, tileCount) {
    var u = new Unseen((tileCount + 31) >>> 5);
    var seen = new Set();
    for (var i = 0; i < tiles.length; i++) {
      var idx = tiles[i].tile_index;
      // 原版存的是 set[Tile]，重复传入不该重复计数
      if (seen.has(idx)) continue;
      seen.add(idx);
      u.words[idx >>> 5] |= 1 << (idx & 31);
      u.count += 1;
    }
    return u;
  }

  /* ---------------- CPython set 迭代序模拟 ---------------- */

  /*
   * 原版 toDiscover / pivot_set 都是 set[Tile]，遍历序是 CPython 哈希表槽位序，
   * 不是插入序、也不总是升序（tile_index 超过表长时会回绕）。pivot 选择里的
   * heapq 并列、以及 component 的构建顺序都吃这个序，路线并列时就会分叉，所以
   * 这里按 CPython set_add_entry / set_table_resize 逐行模拟，输入是插入序，
   * 输出是迭代序。
   */
  function pySetOrderIndices(insertOrder) {
    var size = 8;
    var tab = new Array(size);
    for (var z = 0; z < size; z++) tab[z] = -1;
    var fill = 0;
    var used = 0;
    var mask = size - 1;

    function place(table, m, v) {
      // CPython: i = hash & mask; perturb = hash; 冲突时 i = (i*5 + 1 + perturb) & mask; perturb >>= 5
      var perturb = v;
      var i = v & m;
      for (;;) {
        if (table[i] === -1) {
          table[i] = v;
          return;
        }
        if (table[i] === v) return;
        i = (i * 5 + 1 + perturb) & m;
        perturb = perturb >>> 5;
      }
    }

    function resize() {
      var minused = used * 4;
      var newsize = 8;
      while (newsize <= minused) newsize <<= 1;
      var next = new Array(newsize);
      for (var q = 0; q < newsize; q++) next[q] = -1;
      var nmask = newsize - 1;
      for (var s = 0; s < size; s++) {
        if (tab[s] !== -1) place(next, nmask, tab[s]);
      }
      tab = next;
      size = newsize;
      mask = nmask;
      fill = used;
    }

    for (var k = 0; k < insertOrder.length; k++) {
      var v = insertOrder[k];
      if (fill * 5 >= mask * 3) resize();
      if (tab.indexOf(v) >= 0) continue; // set 语义：重复插入不改变表
      place(tab, mask, v);
      fill += 1;
      used += 1;
    }

    var out = [];
    for (var i2 = 0; i2 < size; i2++) {
      if (tab[i2] !== -1) out.push(tab[i2]);
    }
    return out;
  }

  /* ---------------- 堆：复刻 CPython heapq 的出堆次序 ---------------- */

  function HeapEntry(total, negCost, node) {
    this.total = total;
    this.negCost = negCost;
    this.node = node;
  }

  // Python 比较的是元组 (total_estimated_cost, node)，node.__lt__ 是
  // (total, 0 - cost_so_far)；两者全等时 __lt__ 双向皆假。刻意不加序号，
  // 靠复刻 sift 顺序（相等时把右孩子往上提）拿到同样的出堆次序。
  //
  // 出堆次序因此只由三件事决定：total / negCost / **入堆顺序**。而入堆顺序来自
  // tile.movable 的迭代序（map.js 与 base/client/map.py:1150-1191 同序）与
  // shortcut 的 component 判定，都不依赖位图遍历序。位图只影响节点去重（见 Unseen 注释）。
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

  function Heap(less) {
    this.items = [];
    this.less = less || heapLess;
  }

  Heap.prototype.push = function (entry) {
    this.items.push(entry);
    siftDown(this.less, this.items, 0, this.items.length - 1);
  };

  Heap.prototype.pop = function () {
    var items = this.items;
    if (items.length === 0) return null;
    var last = items.pop();
    if (items.length === 0) return last;
    var top = items[0];
    items[0] = last;
    siftUp(this.less, items, 0);
    return top;
  };

  Heap.prototype.size = function () {
    return this.items.length;
  };

  // pivots 用 (numUnseenAdj, tile)；并列时 Python 落到 Tile.__lt__（只比 army）。
  function pivotEntryLess(a, b) {
    if (a.n !== b.n) return a.n < b.n;
    return a.army < b.army;
  }

  function PivotEntry(n, tile) {
    this.n = n;
    this.army = tile.army;
    this.tile = tile;
  }

  /* ---------------- 图元 ---------------- */

  function isUntraversable(map, t) {
    if (t.isObstacle) return true;
    // 预测出来的迷雾城不算可通行；城墙城 / 低 cost 城玩法例外
    return (
      t.isCity &&
      t.isTempFogPrediction &&
      !map.is_walled_city_game &&
      !map.is_low_cost_city_game
    );
  }

  function BasicAStarNode(tile, unseen, path, costSoFar) {
    this.tile = tile;
    this.unseen = unseen;
    this.path = path || [tile];
    this.cost_so_far = costSoFar || 0;
    this.heuristic_cost_remaining = 0;
    this.total_estimated_cost = 0;
    this._key = null;
  }

  BasicAStarNode.prototype.key = function () {
    if (this._key === null) this._key = this.tile.tile_index + '|' + this.unseen.key();
    return this._key;
  };

  function PivotComponent(pivot, frontierNodes) {
    this.pivot = pivot;
    this.frontier_nodes = frontierNodes;
  }

  function FrontierAStarNode(tile, unseen, unseenComponents, path, costSoFar, army) {
    this.tile = tile;
    this.unseen = unseen;
    this.unseen_components = unseenComponents;
    this.path = path || [tile];
    this.cost_so_far = costSoFar || 0;
    this.heuristic_cost_remaining = 0;
    this.total_estimated_cost = 0;
    this.army = army === undefined ? 0 : army;
    this._key = null;
  }

  FrontierAStarNode.prototype.key = function () {
    if (this._key === null) this._key = this.tile.tile_index + '|' + this.unseen.key();
    return this._key;
  };

  /* ---------------- BasicAStarWRP：原版自称 dumb 的暴力 A* ---------------- */

  function BasicAStarWRP(map, start, toDiscover) {
    this.map = map;
    this.start = start;
    this.to_discover = toDiscover;
    this.open_list = new Heap(heapLess);
    this.closed_set = new Set();
    this.tile_count = map.tiles_by_index.length;
    this.start_node = new BasicAStarNode(start, unseenFromTiles(toDiscover, this.tile_count), null, 0);
    this.open_list.push(new HeapEntry(this.start_node.total_estimated_cost, 0, this.start_node));
  }

  BasicAStarWRP.prototype.heuristic = function (node) {
    // 逐格看边界：每个未看格周围「能站人且不属于未看集」的最小距离取最大
    var h = 0;
    var map = this.map;
    var unseenIdx = node.unseen;
    for (var i = 0; i < map.tiles_by_index.length; i++) {
      if (!unseenIdx.hasIndex(i)) continue;
      var tile = map.tiles_by_index[i];
      var best = Infinity;
      for (var a = 0; a < tile.adjacents.length; a++) {
        var t = tile.adjacents[a];
        if (isUntraversable(map, t)) continue;
        var d = map.get_distance_between(node.tile, t);
        if (d < best) best = d;
      }
      if (best > h) h = best;
    }
    return h;
  };

  BasicAStarWRP.prototype.solve = function () {
    var bestPath = null;
    var iteration = 0;
    while (this.open_list.size() > 0) {
      iteration += 1;
      var popped = this.open_list.pop();
      if (popped === null) break;
      var currentNode = popped.node;

      if (currentNode.unseen.count === 0) {
        bestPath = currentNode.path;
        break;
      }

      this.closed_set.add(currentNode.key());

      var movables = currentNode.tile.movable;
      for (var mi = 0; mi < movables.length; mi++) {
        var neighbor = movables[mi];
        if (isUntraversable(this.map, neighbor)) continue;

        // 原版 unseen - set(neighbor.adjacents)：按源集合迭代序过滤
        var removed = new Set();
        for (var ai = 0; ai < neighbor.adjacents.length; ai++) {
          removed.add(neighbor.adjacents[ai].tile_index);
        }
        var newUnseen = currentNode.unseen.difference(removed);

        var neighborNode = new BasicAStarNode(
          neighbor,
          newUnseen,
          currentNode.path.concat(neighbor),
          currentNode.cost_so_far + 1
        );

        if (this.closed_set.has(neighborNode.key())) continue;

        neighborNode.heuristic_cost_remaining = this.heuristic(neighborNode);
        neighborNode.total_estimated_cost =
          neighborNode.cost_so_far + neighborNode.heuristic_cost_remaining;

        this.open_list.push(
          new HeapEntry(neighborNode.total_estimated_cost, -neighborNode.cost_so_far, neighborNode)
        );
      }
    }

    if (!bestPath) return null;

    var finalPath = new EK.Path();
    for (var pi = 0; pi < bestPath.length; pi++) finalPath.add_next(bestPath[pi]);
    return finalPath;
  };

  /* ---------------- PivotWRP ---------------- */

  function PivotWRP(map, start, toDiscover, initialArmy) {
    this.map = map;
    this.start = start;
    this.to_discover = toDiscover;
    this.initial_army = initialArmy === undefined ? 100000 : initialArmy;
    this.tile_count = map.tiles_by_index.length;
    this.pivot_set = this.build_pivots(toDiscover);
    this.component_lookup = null;
    this.components = null;
    this.frontiers = null;
    this.all_pairs_shortest_paths = null;
    this.longest_crossing = LONGEST_CROSSING;
    this.build_frontiers();
    this.start_node = null;
  }

  PivotWRP.prototype.build_pivots = function (toDiscover) {
    var map = this.map;
    var pivots = [];
    var validRemaining = new Set();
    var i;
    for (i = 0; i < toDiscover.length; i++) validRemaining.add(toDiscover[i].tile_index);

    var heap = new Heap(pivotEntryLess);
    // 原版 for t in toDiscover 走 set 迭代序；堆插入序会决定并列元素的出堆次序
    var toDiscoverIdx = toDiscover.map(function (t) {
      return t.tile_index;
    });
    var orderedIdx = pySetOrderIndices(toDiscoverIdx);
    for (i = 0; i < orderedIdx.length; i++) {
      var t = map.tiles_by_index[orderedIdx[i]];
      var numUnseenAdj = 0;
      for (var a = 0; a < t.adjacents.length; a++) {
        var adj = t.adjacents[a];
        if (isUntraversable(map, adj)) continue;
        if (!validRemaining.has(adj.tile_index)) continue;
        numUnseenAdj += 1;
      }
      heap.push(new PivotEntry(numUnseenAdj, t));
    }

    while (heap.size() > 0) {
      var item = heap.pop();
      var tile = item.tile;
      // 原版只在 tile 还在 validRemainingPivots 里时才采纳
      if (!validRemaining.has(tile.tile_index)) continue;
      pivots.push(tile);
      // 采纳后把「pivot 的邻居的邻居」全部从候选里划掉，保证 pivot 互不相邻
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
    // 原版 self.pivot_set 是 set[Tile]（hash = tile_index），遍历走哈希表序
    var pivotInsertIdx = this.pivot_set.map(function (t) {
      return t.tile_index;
    });
    var pivotLookup = new Map();
    for (var pv = 0; pv < this.pivot_set.length; pv++) {
      pivotLookup.set(this.pivot_set[pv].tile_index, this.pivot_set[pv]);
    }
    var pivots = pySetOrderIndices(pivotInsertIdx).map(function (idx) {
      return pivotLookup.get(idx);
    });

    for (var p = 0; p < pivots.length; p++) {
      var pivot = pivots[p];
      var watchers = [];
      for (var a = 0; a < pivot.adjacents.length; a++) {
        var t = pivot.adjacents[a];
        if (isUntraversable(map, t)) continue;

        // 只有当这格能从 pivot 之外的地方进来，它才算观察点；否则必然顺路经过
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

      // 原版这里 logbook.error 并跳过该 pivot（DebugHelper 打开时才 AssertionError）
      if (watchers.length === 0) continue;

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
    // 每步最多看到 3 个新格，所以未看格数/3 是单点下界
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

  // 基类 solve 带 army 记账（PivotIterativeWRP 覆盖了它，这里照搬备用）。
  PivotWRP.prototype.solve = function (cutoffTime) {
    var now = this._now
      ? this._now
      : function () {
          return clockNowSec();
        };
    if (!cutoffTime) cutoffTime = now() + 1000;

    var bestTurns = -1;
    var bestPath = null;
    var bestUnseen = 1000;

    var startNode = new FrontierAStarNode(
      this.start,
      unseenFromTiles(this.to_discover, this.tile_count),
      this.components.slice(),
      [this.start],
      0,
      this.initial_army
    );
    this.start_node = startNode;

    var openList = new Heap(heapLess);
    openList.push(new HeapEntry(startNode.total_estimated_cost, 0, startNode));
    var closedSet = new Set();
    var frPlayers = this.map.get_teammates(this.start.player());
    var iteration = 0;

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

      if (unseenCount === 0) break;

      if ((iteration & 63) === 0 && cutoffTime < now()) {
        if (WRP_DEBUG) {
          console.log('[wrp] PivotWRP.solve early exit iter ' + iteration + ' unseen ' + bestUnseen);
        }
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

        var newPath = currentNode.path.concat(neighbor);
        // 走回头路不改 army：原版用 is 比较前一格
        var repeat =
          currentNode.path.length > 1 && neighbor === currentNode.path[currentNode.path.length - 2];
        var newArmy = currentNode.army;
        if (!repeat) {
          if (frPlayers.indexOf(neighbor.player()) >= 0) newArmy += neighbor.army;
          else newArmy -= neighbor.army;
          newArmy -= 1;
        }

        if (newArmy <= 2) continue;

        // 原版 unseen - set(neighbor.adjacents)：按源集合迭代序过滤
        var removed = new Set();
        for (var ai = 0; ai < neighbor.adjacents.length; ai++) {
          removed.add(neighbor.adjacents[ai].tile_index);
        }
        var newUnseen = currentNode.unseen.difference(removed);

        var neighborNode = new FrontierAStarNode(
          neighbor,
          newUnseen,
          unseenComp,
          newPath,
          currentNode.cost_so_far + 1,
          newArmy
        );

        if (closedSet.has(neighborNode.key())) continue;

        neighborNode.heuristic_cost_remaining = this.heuristic(neighborNode);
        neighborNode.total_estimated_cost =
          neighborNode.cost_so_far + neighborNode.heuristic_cost_remaining - newArmy / 100;

        openList.push(
          new HeapEntry(neighborNode.total_estimated_cost, -neighborNode.cost_so_far, neighborNode)
        );
      }
    }

    if (!bestPath) return null;

    var finalPath = new EK.Path();
    for (var pi = 0; pi < bestPath.length; pi++) finalPath.add_next(bestPath[pi]);
    return finalPath;
  };

  // 未移植：依赖 networkx，原版 __init__ 里就没调用。留着同名桩是为了让误调用立刻暴露。
  PivotWRP.prototype.connect_graph = function () {
    throw new Error('WatchmanRouteUtils.connect_graph is not ported (needs networkx, never called in Python)');
  };

  PivotWRP.prototype.get_tsp_path = function () {
    throw new Error('WatchmanRouteUtils.get_tsp_path is not ported (needs networkx, never called in Python)');
  };

  /* ---------------- PivotIterativeWRP：唯一被 get_watchman_path 调用的求解器 ---------------- */

  function PivotIterativeWRP(map, start, toDiscover, initialArmy, deterministicTime) {
    PivotWRP.call(this, map, start, toDiscover, initialArmy);
    this.deterministic_time = !!deterministicTime;
    this._now = this.deterministic_time
      ? function () {
          return 0;
        }
      : null;
  }

  PivotIterativeWRP.prototype = Object.create(PivotWRP.prototype);
  PivotIterativeWRP.prototype.constructor = PivotIterativeWRP;

  function rebuildLenThreshs(cutoffThresh, w) {
    var out = new Array(cutoffThresh + 2);
    for (var i = 0; i < out.length; i++) out[i] = i + (cutoffThresh - i) * w;
    return out;
  }

  PivotIterativeWRP.prototype.solve = function (cutoffTime) {
    var now = this._now
      ? this._now
      : function () {
          return clockNowSec();
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
    var iterations = 0;
    // 确定性截断：按迭代数，不按时钟。到上限就带着当前最优返回。
    var maxIter = estimateMaxIter(
      this.to_discover.length,
      this.map.pathable_tiles ? this.map.pathable_tiles.length : this.tile_count,
      cutoffTime - start
    );
    var hitIterCap = false;

    while (w >= 1.0 && cutoffTime >= now()) {
      if (hitIterCap) break;
      var startNode = new FrontierAStarNode(
        this.start,
        unseenFromTiles(this.to_discover, tileCount),
        this.components.slice(),
        [this.start],
        0,
        0
      );
      var openList = new Heap(heapLess);
      openList.push(new HeapEntry(startNode.total_estimated_cost, 0, startNode));
      var closedSet = new Set();
      var iteration = 0;
      // lenThreshs[i]：走到 i 步时允许的最大估总值
      var lenThreshs = rebuildLenThreshs(cutoffThresh, w);

      while (openList.size() > 0) {
        if (iterations >= maxIter) {
          hitIterCap = true;
          break;
        }
        iteration += 1;
        iterations += 1;
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
          // 只有比当前阈值更短才替换；阈值同时收紧 lenThreshs
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

          // 原版 unseen - set(neighbor.adjacents)：按源集合迭代序过滤
          var removed = new Set();
          for (var ai = 0; ai < neighbor.adjacents.length; ai++) {
            removed.add(neighbor.adjacents[ai].tile_index);
          }
          var newUnseen = currentNode.unseen.difference(removed);

          var neighborNode = new FrontierAStarNode(
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

          openList.push(
            new HeapEntry(neighborNode.total_estimated_cost, -neighborNode.cost_so_far, neighborNode)
          );
        }
      }

      w = w - 0.5;
      nextIterCutoffTime = cutoffTime;
    }

    this.last_iterations = iterations;
    this.last_hit_iter_cap = hitIterCap;

    if (WRP_DEBUG) {
      console.log(
        '[wrp] iterative done iters ' +
          iterations +
          ' pivots ' +
          this.pivot_set.length +
          ' bestUnseen ' +
          bestUnseen +
          ' bestTurns ' +
          bestTurns
      );
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

    // 原版是 set(toDiscover)：先去重（首次出现位置即插入序），再按 CPython 哈希
    // 表序遍历 —— pivot 选择的并列、component 构建序都吃这个序。
    var byIndex = new Map();
    var insertOrder = [];
    for (var i = 0; i < toDiscover.length; i++) {
      var t = toDiscover[i];
      if (!t || byIndex.has(t.tile_index)) continue;
      byIndex.set(t.tile_index, t);
      insertOrder.push(t.tile_index);
    }
    var tiles = pySetOrderIndices(insertOrder).map(function (idx) {
      return byIndex.get(idx);
    });

    var startTime = deterministicTime ? 0 : Date.now() / 1000;
    var perfT0 = perfStart();
    var wrp = new PivotIterativeWRP(map, startTile, tiles, initialArmy, deterministicTime);
    var path = wrp.solve(startTime + timeLimit);
    perfRecordWrp(perfT0, wrp.last_iterations || 0);

    if (WRP_DEBUG) {
      console.log(
        '[wrp] get_watchman_path reveal ' +
          tiles.length +
          ' budget ' +
          timeLimit +
          ' pivots ' +
          wrp.pivot_set.length +
          ' len ' +
          (path === null ? -1 : path.length)
      );
    }

    if (path === null || path.length === 0) return null;
    return path;
  }

  /*
   * 返回一个「数组 + 命名属性」的混合体：
   *   [revealedCount, maxKillTurns, minKillTurns, avgKillTurns, killDistMap, positivePath]
   * 数组下标/解构与 Python 的 6 元组一一对应，属性名给 JS 调用方看得懂。
   */
  function revealedResult(r, mx, mn, avg, distMap, path) {
    var out = [r, mx, mn, avg, distMap, path];
    out.revealedCount = r;
    out.maxKillTurns = mx;
    out.minKillTurns = mn;
    out.avgKillTurns = avg;
    out.killDistMap = distMap;
    out.positivePath = path;
    return out;
  }

  function get_revealed_count_and_max_kill_turns_and_positive_path(
    map,
    path,
    toReveal,
    cutoffKillArmy,
    maxKillTurnsDistanceOffsetCutoff
  ) {
    var perfT0 = perfStart();
    var out = _revealedCore(map, path, toReveal, cutoffKillArmy, maxKillTurnsDistanceOffsetCutoff);
    perfRecordReveal(perfT0);
    return out;
  }

  function _revealedCore(map, path, toReveal, cutoffKillArmy, maxKillTurnsDistanceOffsetCutoff) {
    if (cutoffKillArmy === undefined || cutoffKillArmy === null) cutoffKillArmy = 0;
    if (maxKillTurnsDistanceOffsetCutoff === undefined || maxKillTurnsDistanceOffsetCutoff === null) {
      maxKillTurnsDistanceOffsetCutoff = 15;
    }

    if (path === null || path === undefined) {
      return revealedResult(0, 1000, 1000, 1000.0, new EK.MapMatrix(map, 1000), path === undefined ? null : path);
    }

    var unrevealed = new Set();
    for (var r0 = 0; r0 < toReveal.length; r0++) unrevealed.add(toReveal[r0].tile_index);
    var ogLen = unrevealed.size;
    if (ogLen === 0) {
      return revealedResult(0, 1000, 1000, 1000.0, new EK.MapMatrix(map, 1000), path);
    }

    var distMap = new EK.MapMatrix(map, 1000);
    var visited = new Set();
    var wentPositive = false;
    var army = 0;
    var finalArmy = army;
    var tileList = path.tileList;
    var len = tileList.length;
    // 原版用 enumerate 的 i；循环没 break 时 i 停在 len-1（见下方截断判断）
    var i = -1;

    for (var k = 0; k < len; k++) {
      i = k;
      var t = tileList[k];
      if (visited.has(t.tile_index)) continue;

      if (map.is_tile_friendly(t)) army += t.army;
      else army -= t.army;
      army -= 1;

      // 兵力跌破阈值：只要之前正过就直接砍断，没正过就继续走（还没到有意义的段）
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
          distMap.raw[adj.tile_index] =
            map.distance_mapper.get_distance_between(t, adj) + i;
        }
      }

      if (unrevealed.size === 1) {
        var lastIdx = unrevealed.values().next().value;
        unrevealed.delete(lastIdx);
        distMap.raw[lastIdx] =
          map.distance_mapper.get_distance_between(t, map.tiles_by_index[lastIdx]) + i;
      }
    }

    if (i < path.length) path = path.get_subsegment(i);

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

    var revealedCount = ogLen - unrevealed.size;

    path.value = finalArmy;

    if (revealedCount === 0 || !wentPositive) path = null;

    return revealedResult(revealedCount, maxKillTurns, minKillTurns, avgKillTurns, distMap, path);
  }

  /* ---------------- apsp 上的两个下界（原版死代码，但 public，照搬） ---------------- */

  function apspGet(apsp, u, v) {
    if (typeof apsp === 'function') return apsp(u, v);
    if (apsp && typeof apsp.get === 'function') {
      var inner = apsp.get(u);
      if (inner === undefined) return apsp.get(u.tile_index)[v.tile_index];
      return typeof inner === 'function' ? inner(v) : inner[v.tile_index];
    }
    throw new Error('mst/tsp_heuristic requires apsp as function(u,v) or Map(tile -> row)');
  }

  function mst_heuristic(remaining_tiles, start_tile, apsp) {
    if (!remaining_tiles || remaining_tiles.length === 0) return 0;
    var vertices = [start_tile].concat(remaining_tiles);
    var minCost = Infinity;
    for (var i = 0; i < vertices.length; i++) {
      for (var j = i + 1; j < vertices.length; j++) {
        var cost = apspGet(apsp, vertices[i], vertices[j]);
        if (cost < minCost) minCost = cost;
      }
    }
    return minCost;
  }

  function tsp_heuristic(remaining_tiles, start_tile, apsp) {
    if (!remaining_tiles || remaining_tiles.length === 0) return 0;
    var vertices = [start_tile].concat(remaining_tiles);
    var minCost = Infinity;
    var n = vertices.length;
    var used = new Array(n);
    var perm = new Array(n);
    function rec(depth, cost) {
      if (cost >= minCost) return;
      if (depth === n) {
        if (cost < minCost) minCost = cost;
        return;
      }
      for (var i = 0; i < n; i++) {
        if (used[i]) continue;
        used[i] = true;
        perm[depth] = vertices[i];
        var add = depth === 0 ? 0 : apspGet(apsp, perm[depth - 1], vertices[i]);
        rec(depth + 1, cost + add);
        used[i] = false;
      }
    }
    rec(0, 0);
    return minCost;
  }

  var WRP = (EK.WatchmanRouteUtils = EK.WatchmanRouteUtils || {});
  WRP.get_watchman_path = get_watchman_path;
  WRP.get_revealed_count_and_max_kill_turns_and_positive_path =
    get_revealed_count_and_max_kill_turns_and_positive_path;
  WRP.BasicAStarWRP = BasicAStarWRP;
  WRP.BasicAStarNode = BasicAStarNode;
  WRP.PivotWRP = PivotWRP;
  WRP.PivotIterativeWRP = PivotIterativeWRP;
  WRP.PivotComponent = PivotComponent;
  WRP.FrontierAStarNode = FrontierAStarNode;
  WRP.mst_heuristic = mst_heuristic;
  WRP.tsp_heuristic = tsp_heuristic;
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof globalThis !== 'undefined' ? globalThis : this).__EK;
}

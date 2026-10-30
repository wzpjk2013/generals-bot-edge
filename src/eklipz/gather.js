/*
 * Gather —— 移植自 Human.exe / generals-bot-cs 的 ekzipz 集兵规划包
 *   原版目录：E:\akcoco6de\_research\generals-bot-cs\Gather\
 *     GatherUtils.py       build_mst / prune_raw_connected_nodes_to_turns__dfs / 价值矩阵
 *     GatherCapturePlan.py plan 对象、逐节点估值、截获估值
 *     GatherPrune.py       prune_mst_until、get_tree_moves（最终出招顺序）
 *     Models/GatherTreeNode.py
 *
 * 算法一句话：先把「哪些格子值得收」变成一个带权 tile 集合（价值 = 友方 army-1，
 * 敌方 -army-1），再用 DFS 逐个剪掉最不值钱的叶子把集合收缩到目标回合数，
 * 然后在 root 上建一棵连续 MST，递归算每个节点的 value / gatherTurns / trunkValue，
 * 最后从叶子最大优先堆里逐个出招（get_tree_moves）。
 *
 * 简化 / 未移植清单（都在文件头集中说明，正文不再重复贴理由）：
 *  1. networkx 相关整块跳过：`GatherSteiner.build_network_x_steiner_tree`、
 *     `GatherSteiner.get_prize_collecting_gather_mapmatrix`、
 *     `GathSetPruneReconnect.get_gather_plan_set_prune` / `_k_prune_reconnect_greedy`、
 *     `GatherUtils.build_max_value_gather_tree_linking_specific_nodes` /
 *     `gath_set_quick`、`GatherMaxIterativeSet` 里 29-2000 行的 prune/reconnect 家族、
 *     `ExactPerfectSteinerGather`、`ChatGptDpGather`（后者是 __init__ 的 cutesy 入口）。
 *     上游替代路径：凡是要「先定 tile 集合再建树」的地方，一律走
 *     `build_gather_capture_pure_value_matrix` + `prune_raw_connected_nodes_to_turns__dfs`
 *     + `convert_contiguous_tile_tree_to_gather_capture_plan`，这条链是纯局部搜索、
 *     只用 map.movable，不依赖任何最小生成森林求解器。
 *  2. `build_capture_mst_from_root_and_contiguous_tiles`（截获 MSt，741 行起）不移植：
 *     它靠 ArmyAnalyzer 的 intergeneral_analysis 挑起点，而且只在截获规划里用；
 *     GatherCapturePlan 的截获估值 `_include_capture_estimation_in_calculation`
 *     照原样搬了，需要时传 captures 即可。
 *  3. `greedy_backpack_gather(_values)`、`knapsack_max_gather`、
 *     `knapsack_depth_gather`、`gather_max_set_iterative` 这几个「背包迭代」求解器
 *     不移植：它们的价值全部落在「挑哪个 tile 集合」这一步，而集合已经由第 1 条
 *     的剪枝链给出；出树以后的计算跟本文件完全一致。
 *  4. `prune_mst_to_army_with_values` 的城市增量会计
 *     （cityCounter / cityGatherDepthCounter）没搬：`build_from_root_nodes` 里唯一
 *     的调用是 `prune_mst_to_army(rootNodes, 1000000000, ...)`，1e9 的 army 目标让
 *     原版 untilFunc 恒返回 True，一个节点都不会被剪（见 GatherPrune.py:423 的
 *     `armyLeftIfPruned < army`），所以这里按「army 阈值」实现，行为在该调用点上
 *     与原版逐字节等价。真要按 army 剪到别的值，需要补回城市计数。
 *  5. 日志 / viewInfo / renderLive / FastDisjointTileSetSum / 计时 cutoff 全部丢掉，
 *     这些只影响观感与超时，不影响任何一条走子。
 *  6. 原版 `_prune_bad`、`build_mst_to_root_from_path_and_contiguous_tiles`、
 *     `recalculate_tree_values*`、`prune_mst_to_tiles`、`prune_mst_to_max_army_per_turn`
 *     没搬：前两个只被跳过路径调用，后几个是给 bot 的其他模块做二次分析的入口。
 *
 * 坐标 / 接口：本文件的 tile 就是 EK.Tile（`tile.player()` 是方法不是属性），
 * 集合用 JS Set<Tile>（同一个 tile_index 在 map 里只有一个对象，按身份比较即可）。
 * Python 的 `x in set` / `len(set)` / `set.discard` 在这里都是原生 Set 操作。
 * 全文件没有随机数：原版唯一的不确定性是 prune_raw_connected_nodes_to_turns__bfs
 * 里的 random.shuffle(movable)，而 dfs 版没有，所以对外只推荐 dfs 版。
 *
 * 堆必须照抄 heapq：原版出招顺序靠 HeapQueueMax（heapq_max 包，底层是 CPython 的
 * _siftdown_max / _siftup_max），并列优先级时「相等不交换」，谁先出堆取决于堆结构。
 * 加一个入堆序号兜底看着更稳，实际会让 firstMove 大面积分叉（实测 348 组里 93 组）。
 * 同理元组比较必须逐项递归 —— 嵌套数组若落进「对象比 .value」分支，所有优先级都判相等。
 * 这两条是移植里唯一的坑，改动这块前先跑 scripts/ekdiff-gather.js。
 *
 * 验收：scripts/ekdiff-gather.js 对 g1000 / g1000b / g3000 / g5000 四份回放，
 * 逐组比价值矩阵 400 格、区间集合、树的每个节点、plan 全部数值、首招与整串出招，
 * 全部 0 差异（数值不加容差）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------------------------------------------------------- 基础类型 */

  // Python 的 Move(source, dest, move_half=False)，出招的口径跟引擎一致。
  function Move(source, dest, move_half) {
    this.source = source;
    this.dest = dest;
    this.move_half = !!move_half;
  }
  Move.prototype.toString = function () {
    return '(' + this.source.x + ',' + this.source.y + ')->(' + this.dest.x + ',' + this.dest.y + ')' + (this.move_half ? 'H' : '');
  };

  // 对应 Models/GatherTreeNode.py。deep_clone 故意不复制 pruned / points / half，
  // 原版就是这样，照抄是为了让 get_tree_move 出来的 half 一直是 false。
  function GatherTreeNode(tile, toTile, stateObj) {
    this.tile = tile;
    this.toTile = toTile === undefined ? null : toTile;
    this.toGather = null;
    this.half = false;
    this.value = 0;
    this.points = 0.0;
    this.trunkValue = 0;
    this.trunkDistance = 0;
    this.stateObj = stateObj === undefined ? null : stateObj;
    this.gatherTurns = 0;
    this.children = [];
    this.pruned = [];
  }

  GatherTreeNode.prototype.deep_clone = function (dupeCache) {
    if (dupeCache === undefined) dupeCache = {};
    var key = this.tile.tile_index;
    if (dupeCache[key]) throw new Error('GatherTreeNode.deep_clone found a cycle at ' + this.tile);
    dupeCache[key] = true;
    var out = new GatherTreeNode(this.tile, this.toTile, this.stateObj);
    out.value = this.value;
    out.trunkValue = this.trunkValue;
    out.gatherTurns = this.gatherTurns;
    out.trunkDistance = this.trunkDistance;
    out.children = [];
    for (var i = 0; i < this.children.length; i++) {
      var child = this.children[i].deep_clone(dupeCache);
      child.toGather = out;
      out.children.push(child);
    }
    delete dupeCache[key];
    return out;
  };

  GatherTreeNode.prototype.toString = function () {
    return '[' + this.tile + '->' + this.toTile + ' t' + this.gatherTurns + ' v' + this.value +
      ' tv' + this.trunkValue + ', ch' + this.children.length + ']';
  };

  // BFS。原版对 i > 500 直接抛异常来抓环，这里保留同样的上限。
  GatherTreeNode.foreach_tree_node = function (treeNodes, forEachFunc) {
    var q = treeNodes.slice();
    var i = 0;
    while (q.length > 0) {
      var node = q.shift();
      i++;
      if (i > 500) throw new Error('foreach_tree_node infinite looped');
      forEachFunc(node);
      for (var c = 0; c < node.children.length; c++) q.push(node.children[c]);
    }
  };

  GatherTreeNode.iterate_tree_nodes = function (rootNodes) {
    var out = [];
    GatherTreeNode.foreach_tree_node(rootNodes, function (n) {
      out.push(n);
    });
    return out;
  };

  GatherTreeNode.clone_nodes = function (gatherNodes) {
    var out = [];
    for (var i = 0; i < gatherNodes.length; i++) out.push(gatherNodes[i].deep_clone());
    return out;
  };

  GatherTreeNode.get_tree_leaves = function (gathers) {
    var out = [];
    for (var i = 0; i < gathers.length; i++) {
      var n = gathers[i];
      if (n.children.length === 0) {
        if (n.toTile !== null) out.push(n);
      } else {
        var sub = GatherTreeNode.get_tree_leaves(n.children);
        for (var k = 0; k < sub.length; k++) out.push(sub[k]);
      }
    }
    return out;
  };

  /* ------------------------------------------------------------ 队列与堆 */

  // 原版用 collections.deque 的 appendleft/pop 组合：appendleft 往左塞、pop 从右取，
  // 也就是 FIFO（BFS）。用 unshift/pop 一比一对应，节点最多几百个，O(n) 移动无所谓。
  function Deque() {
    this.items = [];
  }
  Deque.prototype.appendleft = function (x) {
    this.items.unshift(x);
  };
  Deque.prototype.append = function (x) {
    this.items.push(x);
  };
  Deque.prototype.pop = function () {
    return this.items.pop();
  };
  Deque.prototype.popleft = function () {
    return this.items.shift();
  };
  Deque.prototype.length = function () {
    return this.items.length;
  };
  Object.defineProperty(Deque.prototype, 'size', {
    get: function () {
      return this.items.length;
    }
  });

  // Python 的元组比较：逐项、bool 当 int、对象落到 GatherTreeNode 的 __lt__（比 value）。
  function cmpVal(a, b) {
    if (a === b) return 0;
    if (typeof a === 'boolean') a = a ? 1 : 0;
    if (typeof b === 'boolean') b = b ? 1 : 0;
    if (a === b) return 0;
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    // 嵌套元组要按元组比较；漏了这一条的话数组会被当成 GatherTreeNode 比 value，
    // 结果是所有元组都判相等（优先级整体失效，firstMove 全错）。
    if (Array.isArray(a) && Array.isArray(b)) return cmpTuple(a, b);
    if (typeof a === 'object' && typeof b === 'object') {
      // GatherTreeNode：原版 __lt__ / __gt__ 只比 value。
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

  // 二叉堆，逐行照抄 CPython heapq 的 _siftdown / _siftup（max 版用 heapq 的 _siftdown_max /
  // _siftup_max，即 heapq_max 包最终指向的那两个实现）。
  // 关键是并列优先级时「相等不交换」：谁先出堆取决于堆结构，加序号兜底会让走子顺序
  // 与原版整体分叉（实测 348 组里 93 组的 firstMove 全错）。所以这里不许有任何 tie-break。
  function Heap(isMax) {
    this.queue = [];
    this.isMax = !!isMax;
  }
  // 语义：a < b（Python 元组比较）。
  Heap.prototype._pyLt = function (a, b) {
    return cmpTuple(a.k, b.k) < 0;
  };
  Heap.prototype._siftdown = function (startpos, pos) {
    var q = this.queue;
    var newitem = q[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = q[parentpos];
      // heapq: newitem < parent；heapq_max: parent < newitem。
      var up = this.isMax ? this._pyLt(parent, newitem) : this._pyLt(newitem, parent);
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
      // heapq 选更小的孩子（!(左<右) 就取右）；heapq_max 选更大的孩子（!(右<左) 就取右）。
      if (rightpos < endpos) {
        var takeRight = this.isMax
          ? !this._pyLt(q[rightpos], q[childpos])
          : !this._pyLt(q[childpos], q[rightpos]);
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

  /* ---------------------------------------------------------------- 小工具 */

  function tileInSet(set, tile) {
    if (set === null || set === undefined) return false;
    return set.has(tile);
  }

  function teammatesOf(map, searchingPlayer) {
    var fr = map.get_teammates(searchingPlayer);
    if (!fr) return [searchingPlayer];
    var out = [];
    for (var i = 0; i < fr.length; i++) out.push(fr[i]);
    if (out.indexOf(searchingPlayer) < 0) out.push(searchingPlayer);
    return out;
  }

  // GatherUtils.is_friendly_tile：自己人或者同队。
  function is_friendly_tile(map, tile, searchingPlayer) {
    if (tile.player() === searchingPlayer) return true;
    return map.is_tile_on_team_with(tile, searchingPlayer);
  }

  function sumNodeValues(nodes) {
    var v = 0;
    for (var i = 0; i < nodes.length; i++) v += nodes[i].value;
    return v;
  }

  /* ------------------------------------------------------- GatherCapturePlan */

  function GatherCapturePlan(rootNodes, map, econValue, turnsTotalInclCap, gatherValue,
                             gatherCapturePoints, gatherTurns, requiredDelay, minValueFunc,
                             friendlyCityCount, enemyCityCount, asPlayer, gatherTarget) {
    var player = asPlayer === undefined ? -1 : asPlayer;
    if (player === -1) player = map.player_index;
    this.player = player;
    this.root_nodes = rootNodes || [];
    this.gathered_army = gatherValue || 0;
    this.gather_capture_points = gatherCapturePoints || 0.0;
    this._econ_value = econValue || 0.0;
    this._turns = turnsTotalInclCap || 0;
    this.gather_turns = gatherTurns || 0;
    this.friendly_city_count = friendlyCityCount === undefined ? null : friendlyCityCount;
    this.enemy_city_count = enemyCityCount === undefined ? null : enemyCityCount;
    this.fog_gather_turns = 0;
    this.fog_gather_army = 0;
    this.gather_target = gatherTarget === undefined ? null : gatherTarget;
    this._requiredDelay = requiredDelay || 0;
    this._tileList = null;
    this._tileSet = null;
    this._map = map;
    this.value_func = minValueFunc || null;
    this.has_more_moves = this.root_nodes.length > 0;
    this.approximate_capture_tiles = new Set();
    this._move_list = null;
    this.leaves = [];

    if (!this.value_func) this.value_func = makeDefaultValueFunc(map, player);

    if (this.friendly_city_count === null || this.enemy_city_count === null) {
      this.friendly_city_count = 0;
      this.enemy_city_count = 0;
      var frPlayers = teammatesOf(map, player);
      var self = this;
      GatherTreeNode.foreach_tree_node(this.root_nodes, function (node) {
        if (node.tile.isCity) {
          if (frPlayers.indexOf(node.tile.player()) >= 0) self.friendly_city_count += 1;
          else if (node.tile.player() >= 0) self.enemy_city_count += 1;
        }
      });
    }
  }

  // 默认的出招优先函数：城市优先推迟、其次是离将军远的。返回的是个 5 元组，
  // HeapQueueMax 直接拿元组比大小，所以每个分量都得跟原版同序。
  function makeDefaultValueFunc(map, asPlayer) {
    var frPlayers = teammatesOf(map, asPlayer);
    return function default_value_func(currentTile, currentPriorityObject) {
      var negCityCount = 0;
      var army = 0;
      var unfriendlyTileCount = 0;
      var curIsOurCity = true;
      if (currentPriorityObject !== null && currentPriorityObject !== undefined) {
        var obj = currentPriorityObject;
        negCityCount = obj[1];
        unfriendlyTileCount = obj[2];
        army = obj[3];
        curIsOurCity = obj[4];
        army -= 1;
      }
      var nextIsOurCity = curIsOurCity;
      curIsOurCity = true;
      if (frPlayers.indexOf(currentTile.player()) >= 0) {
        if (currentTile.isGeneral || currentTile.isCity) negCityCount -= 1;
        army += currentTile.army;
      } else {
        if (currentTile.isGeneral || (currentTile.isCity && army + 2 <= currentTile.army)) curIsOurCity = false;
        unfriendlyTileCount += 1;
        army -= currentTile.army;
      }
      return [nextIsOurCity, negCityCount, unfriendlyTileCount, army, curIsOurCity];
    };
  }

  Object.defineProperty(GatherCapturePlan.prototype, 'length', {
    get: function () {
      return this._turns;
    }
  });

  Object.defineProperty(GatherCapturePlan.prototype, 'econValue', {
    get: function () {
      return this._econ_value;
    },
    set: function (v) {
      this._econ_value = v;
    }
  });

  Object.defineProperty(GatherCapturePlan.prototype, 'requiredDelay', {
    get: function () {
      return this._requiredDelay;
    }
  });

  Object.defineProperty(GatherCapturePlan.prototype, 'tileSet', {
    get: function () {
      if (this._tileSet === null) {
        if (this._tileList !== null) {
          this._tileSet = new Set(this._tileList);
        } else {
          var set = new Set(this.approximate_capture_tiles);
          GatherTreeNode.foreach_tree_node(this.root_nodes, function (n) {
            set.add(n.tile);
          });
          this._tileSet = set;
        }
      }
      return this._tileSet;
    }
  });

  // 注意 reverse()：原版 tileList 是「BFS 序整体反转」，出招顺序依赖它。
  Object.defineProperty(GatherCapturePlan.prototype, 'tileList', {
    get: function () {
      if (this._tileList === null) {
        var list = [];
        var set = new Set();
        var nodes = GatherTreeNode.iterate_tree_nodes(this.root_nodes);
        for (var i = 0; i < nodes.length; i++) {
          list.push(nodes[i].tile);
          set.add(nodes[i].tile);
        }
        list.reverse();
        var it = this.approximate_capture_tiles.values();
        var step = it.next();
        while (!step.done) {
          if (!set.has(step.value)) {
            list.push(step.value);
            set.add(step.value);
          }
          step = it.next();
        }
        this._tileList = list;
        this._tileSet = set;
      }
      return this._tileList;
    }
  });

  GatherCapturePlan.prototype.tiles = function () {
    var out = [];
    var nodes = GatherTreeNode.iterate_tree_nodes(this.root_nodes);
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].tile);
    var it = this.approximate_capture_tiles.values();
    var step = it.next();
    while (!step.done) {
      out.push(step.value);
      step = it.next();
    }
    return out;
  };

  GatherCapturePlan.prototype.include_additional_fog_gather = function (fogTurns, fogGatherValue) {
    this._turns += fogTurns;
    this.gather_turns += fogTurns;
    this.gathered_army += fogGatherValue;
    this.gather_capture_points += fogGatherValue;
    this.fog_gather_turns += fogTurns;
    this.fog_gather_army += fogGatherValue;
  };

  GatherCapturePlan.prototype.include_approximate_capture_tiles = function (captures) {
    var preCount = this.approximate_capture_tiles.size;
    var it = captures.values();
    var step = it.next();
    while (!step.done) {
      this.approximate_capture_tiles.add(step.value);
      step = it.next();
    }
    if (this.approximate_capture_tiles.size !== preCount) {
      this._tileSet = null;
      this._tileList = null;
    }
  };

  GatherCapturePlan.prototype.get_first_move = function () {
    if (!this.value_func) throw new Error('cannot call get_first_move when value_func is None');
    return GatherPrune.get_tree_move(this.root_nodes, this.value_func, false);
  };

  GatherCapturePlan.prototype.pop_first_move = function () {
    if (!this.value_func) throw new Error('cannot call pop move when value_func is None');
    var move = GatherPrune.get_tree_move(this.root_nodes, this.value_func, true);
    this._move_list = null;
    return move;
  };

  GatherCapturePlan.prototype.get_move_list = function () {
    if (this._move_list !== null) return this._move_list;
    if (!this.value_func) throw new Error('cannot call get_move_list when value_func is null');
    this._move_list = GatherPrune.get_tree_moves(this.root_nodes, this.value_func, 10000, false);
    return this._move_list;
  };

  GatherCapturePlan.prototype.toString = function () {
    var vt = (this._econ_value / Math.max(1, this._turns)).toFixed(2);
    return this._econ_value.toFixed(2) + 'v/' + this._turns + 't (' + vt + 'vt), armyGath ' +
      this.gathered_army + ', del ' + this._requiredDelay;
  };

  GatherCapturePlan.build_from_root_nodes = function (map, rootNodes, negativeTiles, searchingPlayer,
                                                      onlyCalculateFriendlyArmy, priorityMatrix,
                                                      includeGatherPriorityAsEconValues,
                                                      includeCapturePriorityAsEconValues,
                                                      captures, viewInfo, cloneNodes, tilesToHalf,
                                                      intergeneral_analysis, overrideArmyCostsFromMatrix) {
    if (onlyCalculateFriendlyArmy === undefined) onlyCalculateFriendlyArmy = false;
    if (includeGatherPriorityAsEconValues === undefined) includeGatherPriorityAsEconValues = false;
    if (includeCapturePriorityAsEconValues === undefined) includeCapturePriorityAsEconValues = true;
    if (cloneNodes) rootNodes = GatherTreeNode.clone_nodes(rootNodes);

    // 原版这里故意传一个空 rootNodes 列表给构造函数，估值全部手算。
    var plan = new GatherCapturePlan([], map, 0.0, 0, 0, 0.0, 0, 0, null, 0, 0, searchingPlayer, null);
    plan._turns = 0;
    var frPlayers = teammatesOf(map, searchingPlayer);

    for (var i = 0; i < rootNodes.length; i++) {
      GatherCapturePlan._recalculate_gather_plan_values(plan, rootNodes[i], negativeTiles,
        searchingPlayer, frPlayers, onlyCalculateFriendlyArmy, priorityMatrix,
        includeGatherPriorityAsEconValues, includeCapturePriorityAsEconValues,
        overrideArmyCostsFromMatrix, tilesToHalf);
    }

    rootNodes = GatherPrune.prune_mst_to_army(rootNodes, 1000000000, searchingPlayer,
      map.team_ids_by_player_index, map.turn, null);
    plan.root_nodes = rootNodes;

    for (var r = 0; r < rootNodes.length; r++) plan._turns += rootNodes[r].gatherTurns;

    if (captures && captures.size > 0) {
      GatherCapturePlan._include_capture_estimation_in_calculation(plan, captures, searchingPlayer,
        frPlayers, negativeTiles, onlyCalculateFriendlyArmy, priorityMatrix,
        includeCapturePriorityAsEconValues, intergeneral_analysis);
    }

    // 叶子 + 主干价值：trunkValue 是从 root 到本格累计的「净收益」，每格恒减 1。
    var leaves = [];
    var queue = new Deque();
    for (var t = 0; t < rootNodes.length; t++) {
      rootNodes[t].trunkValue = 0;
      rootNodes[t].trunkDistance = 0;
      queue.appendleft(rootNodes[t]);
    }
    while (queue.size > 0) {
      var current = queue.pop();
      if (current.children.length === 0) leaves.push(current);
      for (var c = 0; c < current.children.length; c++) {
        var child = current.children[c];
        var trunkValue = current.trunkValue;
        var trunkDistance = current.trunkDistance + 1;
        if (!negativeTiles || !negativeTiles.has(child.tile)) {
          if (frPlayers.indexOf(child.tile.player()) >= 0) trunkValue += child.tile.army;
          else if (!onlyCalculateFriendlyArmy) trunkValue -= child.tile.army;
        }
        trunkValue -= 1;
        child.trunkValue = trunkValue;
        child.trunkDistance = trunkDistance;
        queue.appendleft(child);
      }
    }
    plan.leaves = leaves;
    return plan;
  };

  GatherCapturePlan._recalculate_gather_plan_values = function (plan, currentNode, negativeTiles,
                                                               searchingPlayer, frPlayers,
                                                               onlyCalculateFriendlyArmy,
                                                               priorityMatrix,
                                                               includeGatherPriorityAsEconValues,
                                                               includeCapturePriorityAsEconValues,
                                                               overrideArmyCostsFromMatrix,
                                                               tilesToHalf) {
    if (onlyCalculateFriendlyArmy === undefined) onlyCalculateFriendlyArmy = false;
    if (includeGatherPriorityAsEconValues === undefined) includeGatherPriorityAsEconValues = false;
    if (includeCapturePriorityAsEconValues === undefined) includeCapturePriorityAsEconValues = true;

    var isStartNode = false;
    // 每格留 1 兵，所以起点是 0、往下每个节点先欠 1。
    var turns = 1;
    var sumArmy = -1;
    var sumPoints = -1;
    var econValue = 0.0;
    var currentTile = currentNode.tile;
    var isTileFriendly = frPlayers.indexOf(currentTile.player()) >= 0;

    if (currentNode.toTile === null) {
      isStartNode = true;
      turns = 0;
      sumArmy = 0;
      sumPoints = 0;
    }

    if (!negativeTiles || !negativeTiles.has(currentTile)) {
      if (isTileFriendly) {
        if (!isStartNode) {
          if (!tilesToHalf || !tilesToHalf.has(currentTile)) {
            sumArmy += overrideArmyCostsFromMatrix === null || overrideArmyCostsFromMatrix === undefined
              ? currentTile.army
              : overrideArmyCostsFromMatrix.raw[currentTile.tile_index] + 1;
          } else {
            var rawAmt = overrideArmyCostsFromMatrix === null || overrideArmyCostsFromMatrix === undefined
              ? currentTile.army
              : overrideArmyCostsFromMatrix.raw[currentTile.tile_index] + 1;
            sumArmy += Math.floor(rawAmt / 2);
            currentNode.half = true;
          }
          if (currentTile.isCity) plan.friendly_city_count += 1;
        }
      } else {
        if (!onlyCalculateFriendlyArmy && !isStartNode) {
          sumArmy -= overrideArmyCostsFromMatrix === null || overrideArmyCostsFromMatrix === undefined
            ? currentTile.army
            : overrideArmyCostsFromMatrix.raw[currentTile.tile_index] + 1;
        }
        if (currentTile.player() >= 0) {
          econValue += 2.05;
          if (currentTile.isCity) plan.enemy_city_count += 1;
        } else {
          if (currentTile.isCity) econValue += 5;
          econValue += 1.0;
        }
      }
    }

    if (priorityMatrix) {
      var prioVal = priorityMatrix.raw[currentTile.tile_index];
      if (!isStartNode) {
        sumPoints += prioVal;
        if (isTileFriendly) {
          if (includeGatherPriorityAsEconValues) econValue += prioVal;
        } else if (includeCapturePriorityAsEconValues) {
          econValue += prioVal;
        }
      } else if (!isTileFriendly && includeCapturePriorityAsEconValues) {
        econValue += prioVal;
      }
    }

    // econValue 必须在递归子节点之前入账，否则子节点的经济值会被重复累计。
    sumPoints += sumArmy;
    plan.gathered_army += sumArmy;
    plan.econValue += econValue;
    plan.gather_capture_points += sumPoints;
    if (isTileFriendly) plan.gather_turns += turns;

    for (var i = 0; i < currentNode.children.length; i++) {
      var child = currentNode.children[i];
      GatherCapturePlan._recalculate_gather_plan_values(plan, child, negativeTiles, searchingPlayer,
        frPlayers, onlyCalculateFriendlyArmy, priorityMatrix, includeGatherPriorityAsEconValues,
        includeCapturePriorityAsEconValues, overrideArmyCostsFromMatrix, tilesToHalf);
      sumArmy += child.value;
      sumPoints += child.points;
      turns += child.gatherTurns;
    }

    currentNode.value = sumArmy;
    currentNode.points = sumPoints;
    currentNode.gatherTurns = turns;
  };

  GatherCapturePlan._include_capture_estimation_in_calculation = function (plan, captures, searchingPlayer,
                                                                         frPlayers, negativeTiles,
                                                                         onlyCalculateFriendlyArmy,
                                                                         priorityMatrix,
                                                                         includeCapturePriorityAsEconValues,
                                                                         intergeneral_analysis) {
    if (onlyCalculateFriendlyArmy === undefined) onlyCalculateFriendlyArmy = false;
    if (includeCapturePriorityAsEconValues === undefined) includeCapturePriorityAsEconValues = true;

    var remaining = new Set();
    var pit = captures.values();
    var pstep = pit.next();
    var tileSet = plan.tileSet;
    while (!pstep.done) {
      if (!tileSet.has(pstep.value)) remaining.add(pstep.value);
      pstep = pit.next();
    }
    plan.include_approximate_capture_tiles(remaining);

    var lookup = new Map();
    var nodes = GatherTreeNode.iterate_tree_nodes(plan.root_nodes);
    for (var n = 0; n < nodes.length; n++) lookup.set(nodes[n].tile, nodes[n]);

    var q = new Deque();
    var cit = remaining.values();
    var cstep = cit.next();
    while (!cstep.done) {
      var cap = cstep.value;
      for (var m = 0; m < cap.movable.length; m++) {
        var node = lookup.get(cap.movable[m]);
        if (node) q.append([cap, node, node.value + node.tile.army - 1]);
      }
      cstep = cit.next();
    }

    var vis = new Set();
    while (q.size > 0) {
      var item = q.popleft();
      var toCap = item[0];
      var fromRoot = item[1];
      var armyAmt = item[2];

      if (vis.has(toCap.tile_index) || !remaining.has(toCap)) continue;
      vis.add(toCap.tile_index);

      var sumArmy = -1;
      var sumPoints = -1;
      var econValue = 0.0;
      armyAmt -= 1;
      var currentTile = toCap;
      var isTileFriendly = frPlayers.indexOf(currentTile.player()) >= 0;

      if (!negativeTiles || !negativeTiles.has(currentTile)) {
        if (isTileFriendly) {
          sumArmy += currentTile.army;
          armyAmt += currentTile.army;
          if (currentTile.isCity) plan.friendly_city_count += 1;
        } else {
          armyAmt -= currentTile.army;
          if (!onlyCalculateFriendlyArmy) sumArmy -= currentTile.army;
          if (currentTile.player() >= 0) {
            econValue += 2.05;
            if (currentTile.isCity) plan.enemy_city_count += 1;
          } else {
            econValue += 1.0;
          }
        }
      }

      if (priorityMatrix) {
        var prioVal = priorityMatrix.raw[currentTile.tile_index];
        sumPoints += prioVal;
        if (includeCapturePriorityAsEconValues) econValue += prioVal;
      }

      sumPoints += sumArmy;
      plan.gathered_army += sumArmy;
      plan.gather_capture_points += sumPoints;
      plan._turns += 1;
      if (isTileFriendly) plan.gather_turns += 1;

      fromRoot.value += sumArmy;
      fromRoot.points += sumPoints;
      fromRoot.gatherTurns += 1;
      if (armyAmt < 0) plan.gather_turns += 1;

      for (var mv = 0; mv < toCap.movable.length; mv++) q.append([toCap.movable[mv], fromRoot, armyAmt]);
    }
  };

  /* -------------------------------------------------------------- GatherUtils */

  // 价值矩阵：友方格 army-1（每格留 1 兵），敌方格按 useTrueValueGathered 取 -army-1
  // 或者按「占下来值多少」取 +army。剪枝和优先级都用它当权。
  function build_gather_capture_pure_value_matrix(map, asPlayer, negativeTiles, gatherMatrix,
                                                 captureMatrix, useTrueValueGathered,
                                                 prioritizeCaptureHighArmyTiles, logDebug) {
    if (asPlayer === undefined || asPlayer === -1) asPlayer = map.player_index;
    var weightMatrix = new EK.MapMatrix(map, 0.0);
    var tiles = map.get_all_tiles();
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (negativeTiles && negativeTiles.has(t)) {
        weightMatrix.raw[t.tile_index] = 0.0;
      } else if (map.is_tile_on_team_with(t, asPlayer)) {
        weightMatrix.raw[t.tile_index] += t.army - 1;
        if (gatherMatrix) weightMatrix.raw[t.tile_index] += gatherMatrix.raw[t.tile_index];
      } else {
        if (useTrueValueGathered) weightMatrix.raw[t.tile_index] -= t.army + 1;
        else if (prioritizeCaptureHighArmyTiles) weightMatrix.raw[t.tile_index] += t.army;
        if (captureMatrix) weightMatrix.raw[t.tile_index] += captureMatrix.raw[t.tile_index];
      }
    }
    return weightMatrix;
  }

  // 在 root 上拉一棵「只走 tiles 集合内」的连续 MST。原版靠 appendleft/pop 的
  // 组合做到「根和友方格走 BFS、非友方格立刻深挖」，顺序必须照抄，树形才会一样。
  function build_mst_from_root_and_contiguous_tiles(map, rootTiles, tiles, maxDepth, ignoreTiles, searchingPlayer) {
    if (maxDepth === undefined || maxDepth === null) maxDepth = 1000;
    if (searchingPlayer === undefined) searchingPlayer = -1;
    var visited = new EK.MapMatrixSet(map, null);
    if (ignoreTiles) {
      var iit = ignoreTiles.values();
      var istep = iit.next();
      while (!istep.done) {
        visited.add(istep.value);
        istep = iit.next();
      }
    }
    var q = new Deque();
    var roots = [];
    var rit = rootTiles.values();
    var rstep = rit.next();
    while (!rstep.done) {
      q.appendleft([rstep.value, null, null, 0]);
      rstep = rit.next();
    }
    if (q.size === 0) return [];

    var rootNodes = [];
    while (q.size > 0) {
      var item = q.pop();
      var tile = item[0];
      var fromTile = item[1];
      var fromNode = item[2];
      var fromDepth = item[3];
      if (visited.has(tile)) continue;
      if (fromTile) {
        q.append([tile, fromTile, fromNode, fromDepth]);
        break;
      }
      var newNode = new GatherTreeNode(tile, null);
      rootNodes.push(newNode);
      visited.add(tile);
      for (var m = 0; m < tile.movable.length; m++) {
        var mt = tile.movable[m];
        if (tiles.has(mt)) q.appendleft([mt, tile, newNode, 1]);
      }
    }
    roots = rootNodes;

    while (q.size > 0) {
      var it2 = q.pop();
      var tile2 = it2[0];
      var fromTile2 = it2[1];
      var fromNode2 = it2[2];
      var fromDepth2 = it2[3];
      if (visited.has(tile2)) continue;
      if (fromDepth2 > maxDepth) break;
      var node2 = new GatherTreeNode(tile2, fromTile2);
      visited.add(tile2);
      if (fromNode2) fromNode2.children.push(node2);
      for (var m2 = 0; m2 < tile2.movable.length; m2++) {
        var mt2 = tile2.movable[m2];
        if (!tiles.has(mt2)) continue;
        // 友方格先探（BFS），非友方格当场深挖。这个分档决定了树形。
        if (mt2.player() === searchingPlayer) q.appendleft([mt2, tile2, node2, fromDepth2 + 1]);
        else q.append([mt2, tile2, node2, fromDepth2 + 1]);
      }
    }
    return roots;
  }

  function convert_contiguous_tile_tree_to_gather_capture_plan(map, rootTiles, tiles, searchingPlayer,
                                                             negativeTiles, priorityMatrix,
                                                             useTrueValueGathered,
                                                             includeGatherPriorityAsEconValues,
                                                             includeCapturePriorityAsEconValues,
                                                             tilesToHalf, override_army_cost_matrix,
                                                             viewInfo) {
    if (useTrueValueGathered === undefined) useTrueValueGathered = true;
    var rootNodes = build_mst_from_root_and_contiguous_tiles(map, rootTiles, tiles, 1000, null, searchingPlayer);
    return GatherCapturePlan.build_from_root_nodes(map, rootNodes, negativeTiles, searchingPlayer,
      !useTrueValueGathered, priorityMatrix, includeGatherPriorityAsEconValues,
      includeCapturePriorityAsEconValues, null, viewInfo, false, tilesToHalf, null,
      override_army_cost_matrix);
  }

  // 把连续 tile 集合收到 toTurns 个：每轮找「从 root 出发的 DFS 叶子」里权最低的剪掉。
  // 只要集合是从 root 出发连通的一块，剪叶子不会破坏连通性。
  function prune_raw_connected_nodes_to_turns__dfs(rootTiles, tilesBeingPruned, toTurns, asPlayer,
                                                   weightMatrix, negativeTiles, logDebug) {
    var startCount = tilesBeingPruned.size;
    while (tilesBeingPruned.size - rootTiles.size > toTurns) {
      var visited = new Set();
      var s1 = [];
      var rit = rootTiles.values();
      var rstep = rit.next();
      while (!rstep.done) {
        s1.push(rstep.value);
        rstep = rit.next();
      }
      var prunable = [];
      while (s1.length > 0) {
        var tile = s1.pop();
        if (visited.has(tile)) continue;
        visited.add(tile);
        var anyIncl = false;
        for (var m = 0; m < tile.movable.length; m++) {
          var adj = tile.movable[m];
          if (!visited.has(adj) && tilesBeingPruned.has(adj)) {
            anyIncl = true;
            s1.push(adj);
          }
        }
        if (!anyIncl) prunable.push(tile);
      }
      if (prunable.length === 0) {
        throw new Error('prune_raw_connected_nodes_to_turns__dfs found nothing prunable');
      }
      // 原版 prunable.sort(key=weight) 是稳定排序，等权的按 DFS 出栈序，照抄。
      prunable.sort(function (a, b) {
        var av = weightMatrix.raw[a.tile_index];
        var bv = weightMatrix.raw[b.tile_index];
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
      var tileToPrune = prunable[0];
      rootTiles.delete(tileToPrune);
      tilesBeingPruned.delete(tileToPrune);
      if (rootTiles.size === 0) {
        throw new Error('pruned root tiles to 0 tiles remaining, startCount ' + startCount);
      }
    }
  }

  // 原版 __bfs 版里有 random.shuffle(movable)，非确定性；这里顺手也去掉随机
  // （Python 侧 oracle 用 random.seed(0) 固定），否则两边永远对不上。
  function prune_raw_connected_nodes_to_turns__bfs(rootTiles, tilesBeingPruned, toTurns, asPlayer,
                                                   weightMatrix, negativeTiles, logDebug,
                                                   opts) {
    var order = (opts && opts.order) || null;
    var startCount = tilesBeingPruned.size;
    while (tilesBeingPruned.size - rootTiles.size > toTurns) {
      var visited = new Set();
      var s1 = new Deque();
      var rit = rootTiles.values();
      var rstep = rit.next();
      while (!rstep.done) {
        s1.append([rstep.value, null]);
        rstep = rit.next();
      }
      var prunable = new Set();
      while (s1.size > 0) {
        var item = s1.popleft();
        var tile = item[0];
        if (visited.has(tile)) continue;
        visited.add(tile);
        var anyIncl = false;
        var movable = order ? order(tile) : tile.movable;
        for (var m = 0; m < movable.length; m++) {
          var adj = movable[m];
          if (tilesBeingPruned.has(adj)) {
            if (!visited.has(adj)) {
              anyIncl = true;
              s1.append([adj, tile]);
            }
          }
        }
        if (!anyIncl) prunable.add(tile);
      }
      var list = [];
      var pit = prunable.values();
      var pstep = pit.next();
      while (!pstep.done) {
        list.push(pstep.value);
        pstep = pit.next();
      }
      list.sort(function (a, b) {
        var av = weightMatrix.raw[a.tile_index];
        var bv = weightMatrix.raw[b.tile_index];
        if (av < bv) return -1;
        if (av > bv) return 1;
        return a.tile_index - b.tile_index;
      });
      if (list.length === 0) throw new Error('prune_raw_connected_nodes_to_turns__bfs found nothing prunable');
      var tileToPrune = list[0];
      rootTiles.delete(tileToPrune);
      tilesBeingPruned.delete(tileToPrune);
      if (rootTiles.size === 0) {
        throw new Error('pruned root tiles to 0 tiles remaining, startCount ' + startCount);
      }
    }
  }

  function postOrderIterative(rootTiles) {
    var visited = new Set();
    var s1 = [];
    var s2 = [];
    var rit = rootTiles.values();
    var rstep = rit.next();
    while (!rstep.done) {
      s1.push(rstep.value);
      rstep = rit.next();
    }
    while (s1.length > 0) {
      var tile = s1.pop();
      if (visited.has(tile)) continue;
      s2.push(tile);
      visited.add(tile);
      for (var m = 0; m < tile.movable.length; m++) {
        var adj = tile.movable[m];
        if (!visited.has(adj)) s1.push(adj);
      }
    }
    s2.reverse();
    return s2;
  }

  /* -------------------------------------------------------------- GatherPrune */

  function get_tree_moves(gathers, valueFunc, limit, pop) {
    if (limit === undefined) limit = 10000;
    if (!gathers || gathers.length === 0) return [];
    var q = new Deque();
    if (!pop) {
      var cloned = [];
      for (var c = 0; c < gathers.length; c++) cloned.push(gathers[c].deep_clone());
      gathers = cloned;
    }
    for (var g = 0; g < gathers.length; g++) {
      var basePrio = valueFunc(gathers[g].tile, null);
      q.append([basePrio, gathers[g]]);
    }
    var moveQ = new Heap(true);
    var prioLookup = new Map();
    while (q.size > 0) {
      var item = q.popleft();
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
          q.append([nextPrio, gather]);
        }
      }
    }
    var moves = [];
    var iter = 0;
    while (!moveQ.isEmpty()) {
      var top = moveQ.get();
      var curPrio2 = top[0];
      var curGather2 = top[1];
      var toGather = curGather2.toGather;
      if (toGather !== null) {
        moves.push(new Move(curGather2.tile, toGather.tile, curGather2.half));
        // Python list.remove 按 __eq__（比 tile）删第一个匹配项。
        for (var k = 0; k < toGather.children.length; k++) {
          if (toGather.children[k].tile === curGather2.tile) {
            toGather.children.splice(k, 1);
            break;
          }
        }
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

  // 原版 prune_mst_to_army_with_values 的 untilFunc 里有一段城市增量会计，
  // 见文件头第 4 条：build_from_root_nodes 只会传 1e9，等价于不剪。这里按
  // 「剪完还能剩多少兵」判，cityIncrement 恒 0，行为在该调用点与原文一致。
  function prune_mst_to_army(rootNodes, army, searchingPlayer, teams, turn, viewInfo,
                             gatherTreeNodeLookupToPrune, invalidMoveFunc, preferPrune,
                             allowNegative, pruneLargeTilesFirst) {
    if (invalidMoveFunc === undefined || invalidMoveFunc === null) {
      invalidMoveFunc = function (node) {
        if (node.tile.army <= 1) return true;
        return node.tile.player() !== searchingPlayer;
      };
    }
    if (allowNegative === undefined) allowNegative = true;
    if (pruneLargeTilesFirst === undefined) pruneLargeTilesFirst = false;

    var untilFunc = function (node, prioObj, count, curValue) {
      var armyLeftIfPruned = curValue - node.value;
      return armyLeftIfPruned < army;
    };
    var pruneOrderFunc = function (node, prioObj) {
      if (pruneLargeTilesFirst) {
        return [0 - node.value, node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0, node.trunkDistance];
      }
      var valPerTurn = node.gatherTurns > 0 ? node.value / node.gatherTurns : 0;
      return [valPerTurn, node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0, node.trunkDistance];
    };
    var res = prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc, false, null,
      viewInfo, true, gatherTreeNodeLookupToPrune, null, preferPrune, null, allowNegative, null, null);
    return res[2];
  }

  function prune_mst_to_turns(rootNodes, turns, searchingPlayer, teams, turn) {
    var invalidMoveFunc = function (node) {
      if (node.tile.army <= 1) return true;
      return node.tile.player() !== searchingPlayer && node.children.length === 0;
    };
    var overpruneCutoff = turns;
    var pruneOrderFunc = function (node, prioObj) {
      var rawValPerTurn = node.gatherTurns > 0 ? node.value / node.gatherTurns : -100;
      return [rawValPerTurn, node.value, 0 - node.trunkDistance];
    };
    var untilFunc = function (node, prioObj, count, curValue) {
      return count <= turns;
    };
    var pruneOverrideFunc = function (node, prioObj, count, curValue) {
      return count - node.gatherTurns < overpruneCutoff;
    };
    var res = prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc, true,
      pruneOverrideFunc, null, true, null, null, null, null, true, null, null);
    return res[2];
  }

  // 剪枝引擎本体。原版注释写得很清楚：不做拷贝、直接改传入的树；
  // 剪掉一个叶子就沿 toTile 链把 value / gatherTurns 一路减上去。
  function prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc, pruneBranches,
                           pruneOverrideFunc, viewInfo, noLog, gatherTreeNodeLookupToPrune,
                           tileDictToPrune, preferPrune, parentPruneFunc, allowNegative,
                           logEntries, pruneCallbackFunc) {
    if (pruneBranches === undefined) pruneBranches = false;
    if (noLog === undefined) noLog = true;
    if (allowNegative === undefined) allowNegative = true;

    var nodeMap = new Map();
    var pruneHeap = new Heap(false);
    var iter = 0;

    GatherTreeNode.foreach_tree_node(rootNodes, function (current) {
      nodeMap.set(current.tile, current);
      if (current.toTile !== null && (current.children.length === 0 || pruneBranches)) {
        var validMove = true;
        if (invalidMoveFunc(current) && current.children.length === 0) validMove = false;
        pruneHeap.put([validMove, preferPrune === null || preferPrune === undefined || !preferPrune.has(current.tile),
          pruneOrderFunc(current, null), current]);
      }
    });

    var curValue = sumNodeValues(rootNodes);
    var count = nodeMap.size - rootNodes.length;
    var initialCount = nodeMap.size;
    var childRecurseQueue = new Deque();

    while (!pruneHeap.isEmpty()) {
      var popped = pruneHeap.get();
      var validMove = popped[0];
      var prioObj = popped[2];
      var current = popped[3];
      iter += 1;
      if (iter > initialCount * 3) break;

      if (current.toTile === null) continue;
      if (!nodeMap.has(current.tile)) continue;

      validMove = !invalidMoveFunc(current);
      if (validMove || current.children.length > 0) {
        if (untilFunc(current, prioObj, count, curValue)) continue;
      }

      if (pruneOverrideFunc && pruneOverrideFunc(current, prioObj, count, curValue)) continue;

      if (!allowNegative && wouldPruneCauseNegativeRoot(current, nodeMap)) continue;

      if (validMove) {
        var doubleCheckPrioObj = pruneOrderFunc(current, prioObj);
        if (cmpTuple(doubleCheckPrioObj, prioObj) > 0) {
          pruneHeap.put([validMove, preferPrune === null || preferPrune === undefined || !preferPrune.has(current.tile),
            doubleCheckPrioObj, current]);
          continue;
        }
      }

      curValue -= current.value;
      var parent = nodeMap.has(current.toTile) ? nodeMap.get(current.toTile) : null;
      var realParent = parent;

      if (parent !== null) {
        for (var ci = 0; ci < parent.children.length; ci++) {
          if (parent.children[ci].tile === current.tile) {
            parent.children.splice(ci, 1);
            break;
          }
        }
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

      childRecurseQueue.append(current);
      var childIter = 0;
      while (childRecurseQueue.size > 0) {
        var toDrop = childRecurseQueue.popleft();
        childIter += 1;
        if (childIter > initialCount * 3) break;
        if (gatherTreeNodeLookupToPrune) gatherTreeNodeLookupToPrune.delete(toDrop.tile);
        if (tileDictToPrune) tileDictToPrune.delete(toDrop.tile);
        nodeMap.delete(toDrop.tile);
        count -= 1;
        if (pruneCallbackFunc) pruneCallbackFunc(toDrop, count, curValue);
        for (var cc = 0; cc < toDrop.children.length; cc++) childRecurseQueue.append(toDrop.children[cc]);
      }

      if (realParent !== null && realParent.children.length === 0 && realParent.toTile !== null) {
        var parentValidMove = !invalidMoveFunc(realParent);
        var nextPrioObj = pruneOrderFunc(realParent, prioObj);
        pruneHeap.put([parentValidMove,
          preferPrune === null || preferPrune === undefined || !preferPrune.has(realParent.tile),
          nextPrioObj, realParent]);
      }
    }

    var totalValue = sumNodeValues(rootNodes);
    return [count, totalValue, rootNodes];
  }

  // 一路往上层走，看剪掉 current 之后顶层 root 会不会变负。
  function wouldPruneCauseNegativeRoot(current, nodeMap) {
    var parent = current;
    var nextParent = nodeMap.has(parent.toTile) ? nodeMap.get(parent.toTile) : null;
    while (nextParent !== null && nextParent !== undefined) {
      parent = nextParent;
      nextParent = nodeMap.has(parent.toTile) ? nodeMap.get(parent.toTile) : null;
    }
    return parent.value - current.value < 0;
  }

  /* ------------------------------------------------------------------- 汇总 */

  // 一条龙：价值矩阵 → 剪到 targetTurns → 建 MST → 出 plan。
  // 这是 oracle 与移植版共用的主链，也是 bot 侧唯一需要调的入口。
  function gather_to_tile_plan(map, rootTiles, targetTurns, asPlayer, opts) {
    opts = opts || {};
    if (asPlayer === undefined || asPlayer === -1) asPlayer = map.player_index;
    var valueMatrix = build_gather_capture_pure_value_matrix(map, asPlayer, opts.negativeTiles || null,
      opts.gatherMatrix || null, opts.captureMatrix || null,
      !!opts.useTrueValueGathered, !!opts.prioritizeCaptureHighArmyTiles, false);
    var tiles = opts.tiles || null;
    if (!tiles) {
      tiles = friendly_connected_region(map, rootTiles, asPlayer);
    } else {
      tiles = new Set(tiles);
    }
    var roots = new Set(rootTiles);
    prune_raw_connected_nodes_to_turns__dfs(roots, tiles, targetTurns, asPlayer, valueMatrix, null, false);
    return convert_contiguous_tile_tree_to_gather_capture_plan(map, roots, tiles, asPlayer,
      opts.negativeTiles || null, valueMatrix, true, false, true, null, null, null);
  }

  // 「root 出发、只走自己人格子」的连通块，剪不动的格子不能进集合（剪叶子依赖连通）。
  function friendly_connected_region(map, rootTiles, asPlayer) {
    var out = new Set();
    var q = [];
    var rit = rootTiles.values();
    var rstep = rit.next();
    while (!rstep.done) {
      q.push(rstep.value);
      rstep = rit.next();
    }
    while (q.length > 0) {
      var tile = q.shift();
      if (out.has(tile)) continue;
      if (!map.is_tile_on_team_with(tile, asPlayer)) continue;
      out.add(tile);
      for (var m = 0; m < tile.movable.length; m++) {
        var adj = tile.movable[m];
        if (!out.has(adj) && map.is_tile_on_team_with(adj, asPlayer)) q.push(adj);
      }
    }
    return out;
  }

  var GatherPrune = {
    get_tree_moves: get_tree_moves,
    get_tree_move: get_tree_move,
    prune_mst_until: prune_mst_until,
    prune_mst_to_army: prune_mst_to_army,
    prune_mst_to_turns: prune_mst_to_turns
  };

  var Gather = {
    is_friendly_tile: is_friendly_tile,
    build_gather_capture_pure_value_matrix: build_gather_capture_pure_value_matrix,
    build_mst_from_root_and_contiguous_tiles: build_mst_from_root_and_contiguous_tiles,
    convert_contiguous_tile_tree_to_gather_capture_plan: convert_contiguous_tile_tree_to_gather_capture_plan,
    prune_raw_connected_nodes_to_turns__dfs: prune_raw_connected_nodes_to_turns__dfs,
    prune_raw_connected_nodes_to_turns__bfs: prune_raw_connected_nodes_to_turns__bfs,
    postOrderIterative: postOrderIterative,
    get_tree_moves: get_tree_moves,
    get_tree_move: get_tree_move,
    prune_mst_until: prune_mst_until,
    prune_mst_to_army: prune_mst_to_army,
    prune_mst_to_turns: prune_mst_to_turns,
    gather_to_tile_plan: gather_to_tile_plan,
    friendly_connected_region: friendly_connected_region
  };

  EK.Move = Move;
  EK.GatherTreeNode = GatherTreeNode;
  EK.GatherCapturePlan = GatherCapturePlan;
  EK.GatherPrune = GatherPrune;
  EK.Gather = Gather;
  EK.gather = Gather;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

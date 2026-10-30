/*
 * SearchUtils —— 逐行移植自 generals-bot/SearchUtils.py 里 BFS / 最短路径那一层。
 *
 * 只搬了 ArmyTracker / ExpandUtils / Gather / BotDefense 真正调用的那批
 * （调用点统计见文件末尾导出的函数名；未搬的在报告里列了原因）：
 *   - 通用件：HeapQueue / HeapQueueMax / Counter / where / any_where / count
 *   - 队列族：breadth_first_find_queue / breadth_first_find_dist_queue
 *   - foreach 族：breadth_first_foreach(+with_state / with_dist / fast_* 变体)
 *   - 动态搜索族：breadth_first_dynamic / breadth_first_dynamic_max(_per_tile /
 *     _per_tile_per_distance)，三者的默认实现都走 *_global_visited 版本
 *   - 距离场：build_distance_map_matrix 系列 + extend_distance_map_matrix
 *   - 反向搜索：dest_breadth_first_target（BotDefense 用）
 *   - 直线距离 a*：a_star_find（GatherUtils 用）
 *
 * 与 Python 的差异只有三处，都是语义等价的：
 *   1) heapq 的比较：Python 靠 tuple 逐元素比较；这里用 cmpVals 显式做同样的事，
 *      并且在优先级完全打平时退化到 tile_index（Python 会在那儿抛 TypeError）。
 *   2) 日志（logbook）全部去掉，但 noLog 之类的参数照旧接受，免得调用点要改。
 *   3) 计时阈值改用 Date.now()，传 maxTime: Infinity 即可完全确定性。
 *
 * tile.player 在 Python 是 property，JS 移植成了方法，所以这里一律写 tile.player()。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var UNREACHABLE = 1000;
  var INF = Infinity;

  function opt(o, name, dflt) {
    if (o === undefined || o === null) return dflt;
    var v = o[name];
    return v === undefined ? dflt : v;
  }

  function newPath(armyRemaining) {
    return new EK.Path(armyRemaining);
  }

  /* ==================================================================
   * 比较 / 容器
   * ================================================================== */

  /*
   * Python tuple 的逐元素比较。BFS 的优先级对象全是元组，而且 valueFunc 的返回值
   * 本身也是元组（默认 value func 返回 (0-army/dist, 0-negEnemyTileCount)），
   * 用 JS 的 > 去比数组会退化成字符串比较，必须走这里。
   */
  function cmpVals(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;

    var ta = typeof a;
    var tb = typeof b;
    if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'string' && tb === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'boolean' && tb === 'boolean') return a === b ? 0 : a ? 1 : -1;

    if (Array.isArray(a) && Array.isArray(b)) {
      var n = a.length < b.length ? a.length : b.length;
      for (var i = 0; i < n; i++) {
        var c = cmpVals(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }

    // Tile / PathMove 之类的对象：按 Python Tile.__lt__ 只比 army，平局返回 0
    if (a.tile_index !== undefined && b.tile_index !== undefined) {
      var aa = a.army === undefined ? 0 : a.army;
      var ba = b.army === undefined ? 0 : b.army;
      return aa < ba ? -1 : aa > ba ? 1 : 0;
    }
    if (a.tile !== undefined && b.tile !== undefined) return cmpVals(a.tile, b.tile);
    return 0;
  }

  function isGreater(a, b) {
    return cmpVals(a, b) > 0;
  }
  function isLess(a, b) {
    return cmpVals(a, b) < 0;
  }

  /* heapq 的等价物。元素本身可以是任意可比较值，用 cmpVals 决定顺序。 */
  function HeapQueue() {
    this.queue = [];
  }
  HeapQueue.prototype.put = function (item) {
    var q = this.queue;
    q.push(item);
    var i = q.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (cmpVals(q[i], q[parent]) >= 0) break;
      var tmp = q[i];
      q[i] = q[parent];
      q[parent] = tmp;
      i = parent;
    }
  };
  function _siftdown(q, startpos, pos) {
    var newitem = q[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = q[parentpos];
      if (cmpVals(newitem, parent) < 0) {
        q[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    q[pos] = newitem;
  }

  function _siftup(q, pos) {
    var endpos = q.length;
    var startpos = pos;
    var newitem = q[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      if (rightpos < endpos && !(cmpVals(q[childpos], q[rightpos]) < 0)) childpos = rightpos;
      q[pos] = q[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    q[pos] = newitem;
    _siftdown(q, startpos, pos);
  }

  HeapQueue.prototype.get = function () {
    var q = this.queue;
    var lastelt = q.pop();
    if (q.length === 0) return lastelt;
    var returnitem = q[0];
    q[0] = lastelt;
    _siftup(q, 0);
    return returnitem;
  };
  Object.defineProperty(HeapQueue.prototype, 'size', {
    get: function () {
      return this.queue.length;
    }
  });
  Object.defineProperty(HeapQueue.prototype, 'empty', {
    get: function () {
      return this.queue.length === 0;
    }
  });

  /* heapq_max 的等价物：比较反向。
   *
   * 必须逐位照抄 CPython 的 _siftdown_max/_siftup_max：并列优先级时候选人「相等不交换」，
   * 出队顺序完全由堆结构决定。换成常规「下沉取最大值」写法，平局就会挑到别的元素，
   * GatherPrune 里 348 组里有 93 组首招直接错。
   */
  function HeapQueueMax() {
    this.queue = [];
  }
  function _siftdown_max(q, startpos, pos) {
    var newitem = q[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = q[parentpos];
      if (cmpVals(newitem, parent) > 0) {
        q[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    q[pos] = newitem;
  }
  function _siftup_max(q, pos) {
    var endpos = q.length;
    var startpos = pos;
    var newitem = q[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      // 注意 CPython 这里写成 `not heap[rightpos] < heap[childpos]`，不是对称的 <
      if (rightpos < endpos && !(cmpVals(q[rightpos], q[childpos]) < 0)) childpos = rightpos;
      q[pos] = q[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    q[pos] = newitem;
    _siftdown_max(q, startpos, pos);
  }
  HeapQueueMax.prototype._put = function (item) {
    var q = this.queue;
    q.push(item);
    _siftdown_max(q, 0, q.length - 1);
  };
  HeapQueueMax.prototype.put = function (item) {
    this._put(item);
  };
  HeapQueueMax.prototype.get = function () {
    var q = this.queue;
    var lastelt = q.pop();
    if (q.length === 0) return lastelt;
    var returnitem = q[0];
    q[0] = lastelt;
    _siftup_max(q, 0);
    return returnitem;
  };
  Object.defineProperty(HeapQueueMax.prototype, 'size', {
    get: function () {
      return this.queue.length;
    }
  });

  /*
   * deque 的等价物。Python 里 appendleft + pop / appendleft + popleft / append 混着用，
   * 语义分别是 FIFO 和 FIFO，这里用「数组 + head 指针」实现 O(1) 出队。
   */
  function Deque() {
    this.arr = [];
    this.head = 0;
  }
  Deque.prototype._compact = function () {
    if (this.head > 0) {
      this.arr = this.arr.slice(this.head);
      this.head = 0;
    }
  };
  Deque.prototype.appendleft = function (v) {
    this._compact();
    this.arr.unshift(v);
  };
  Deque.prototype.append = function (v) {
    this.arr.push(v);
  };
  Deque.prototype.popleft = function () {
    var v = this.arr[this.head++];
    if (this.head > 1024 && this.head * 2 > this.arr.length) this._compact();
    return v;
  };
  Deque.prototype.pop = function () {
    return this.arr.pop();
  };
  Object.defineProperty(Deque.prototype, 'size', {
    get: function () {
      return this.arr.length - this.head;
    }
  });
  Object.defineProperty(Deque.prototype, 'empty', {
    get: function () {
      return this.arr.length - this.head === 0;
    }
  });

  function Counter(value) {
    this.value = value;
  }
  Counter.prototype.add = function (value) {
    this.value = this.value + value;
  };
  Counter.prototype.toString = function () {
    return String(this.value);
  };

  /* ==================================================================
   * 通用小工具
   * ================================================================== */

  function where(enumerable, filterFunc) {
    var results = [];
    for (var i = 0; i < enumerable.length; i++) if (filterFunc(enumerable[i])) results.push(enumerable[i]);
    return results;
  }

  function any_where(enumerable, filterFunc) {
    for (var i = 0; i < enumerable.length; i++) if (filterFunc(enumerable[i])) return true;
    return false;
  }

  function count(enumerable, filterFunc) {
    var matched = 0;
    for (var i = 0; i < enumerable.length; i++) if (filterFunc(enumerable[i])) matched += 1;
    return matched;
  }

  // 以下三个在原始 SearchUtils.py 里并不存在（全仓 grep 无命中），是搬 BFS 时
  // 顺手补的等价小工具，供后续模块直接用。
  function min_where(enumerable, filterFunc, keyFunc) {
    var best = null;
    var bestKey = null;
    for (var i = 0; i < enumerable.length; i++) {
      var item = enumerable[i];
      if (filterFunc && !filterFunc(item)) continue;
      var k = keyFunc ? keyFunc(item) : item;
      if (best === null || isLess(k, bestKey)) {
        best = item;
        bestKey = k;
      }
    }
    return best;
  }

  function max_where(enumerable, filterFunc, keyFunc) {
    var best = null;
    var bestKey = null;
    for (var i = 0; i < enumerable.length; i++) {
      var item = enumerable[i];
      if (filterFunc && !filterFunc(item)) continue;
      var k = keyFunc ? keyFunc(item) : item;
      if (best === null || isGreater(k, bestKey)) {
        best = item;
        bestKey = k;
      }
    }
    return best;
  }

  function first_or_none(enumerable, filterFunc) {
    for (var i = 0; i < enumerable.length; i++) if (!filterFunc || filterFunc(enumerable[i])) return enumerable[i];
    return null;
  }

  function first_or_default(enumerable, filterFunc, dflt) {
    for (var i = 0; i < enumerable.length; i++) if (!filterFunc || filterFunc(enumerable[i])) return enumerable[i];
    return dflt === undefined ? null : dflt;
  }

  /* ---- MapBase 的 helper：JS 版 Map 还没移植 is_player_on_team_with ---- */
  function isPlayerOnTeamWith(map, player1, player2) {
    if (typeof map.is_player_on_team_with === 'function') return map.is_player_on_team_with(player1, player2);
    return map.team_ids_by_player_index[player1] === map.team_ids_by_player_index[player2];
  }


  /* negativeTiles 在调用点可能是 Set / MapMatrixSet / 普通数组 */
  function negHas(negativeTiles, tile) {
    if (negativeTiles === null || negativeTiles === undefined) return false;
    if (typeof negativeTiles.has === 'function') return negativeTiles.has(tile);
    return negativeTiles.indexOf(tile) >= 0;
  }

  function hasSkip(skipTiles, tile) {
    if (skipTiles === null || skipTiles === undefined) return false;
    if (typeof skipTiles.has === 'function') return skipTiles.has(tile);
    return skipTiles.indexOf(tile) >= 0;
  }

  /* skipTiles 可能是 Set / MapMatrix / MapMatrixSet / 数组，统一转成带 has() 的东西 */
  function toSkipSet(skipTiles) {
    if (!skipTiles) return null;
    if (typeof skipTiles.has === 'function') return skipTiles;
    if (Array.isArray(skipTiles)) return new Set(skipTiles);
    return new Set(Array.from(skipTiles));
  }

  function isEmptyColl(coll) {
    if (coll === null || coll === undefined) return true;
    if (coll.size !== undefined) return coll.size === 0;
    if (coll.length !== undefined) return coll.length === 0;
    return false;
  }

  /* ==================================================================
   * dest_breadth_first_target —— 反向搜到「刚好剩 targetArmy 兵」的起点
   * ================================================================== */

  function dest_breadth_first_target(map, goalList, opts) {
    opts = opts || {};
    var targetArmy = opt(opts, 'targetArmy', 1);
    var maxDepth = opt(opts, 'maxDepth', 20);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var noNeutralCities = opt(opts, 'noNeutralCities', true);
    var skipTiles = opt(opts, 'skipTiles', null);
    var ignoreGoalArmy = opt(opts, 'ignoreGoalArmy', false);
    var additionalIncrement = opt(opts, 'additionalIncrement', 0.0);
    var preferCapture = opt(opts, 'preferCapture', false);

    if (searchingPlayer === -2) searchingPlayer = map.player_index;

    if (map.teammates && map.teammates.size > 0 && searchingPlayer === map.player_index) {
      var skipBase = [];
      if (skipTiles) {
        if (Array.isArray(skipTiles)) skipBase = skipTiles;
        else if (typeof skipTiles.keys === 'function') skipBase = skipTiles.keys();
        else skipBase = Array.from(skipTiles);
      }
      skipTiles = new Set(skipBase);
      map.teammates.forEach(function (tId) {
        var gen = map.generals[tId];
        if (gen && gen.isGeneral && gen.player() === tId) skipTiles.add(gen);
      });
    }

    var frontier = new HeapQueue();
    var visited = new EK.MapMatrix(map, null);
    var goalSet = new Set();
    var goalEntries = [];

    var isDict = !Array.isArray(goalList);
    if (isDict) {
      goalList.forEach(function (val, goal) {
        goalEntries.push({
          goal: goal,
          startDist: val[0],
          goalTargetArmy: val[1],
          goalIncModifier: val[2]
        });
        goalSet.add(goal);
      });
    } else {
      for (var gi = 0; gi < goalList.length; gi++) {
        goalEntries.push({ goal: goalList[gi], startDist: 0, goalTargetArmy: 1, goalIncModifier: 0 });
        goalSet.add(goalList[gi]);
      }
    }

    for (var e = 0; e < goalEntries.length; e++) {
      var entry = goalEntries[e];
      var goal = entry.goal;
      if (goal.isMountain) continue;

      var goalInc;
      var startArmy;
      var startDist;

      if (isDict) {
        var goalTargetArmy = entry.goalTargetArmy;
        goalInc = entry.goalIncModifier + additionalIncrement;
        if (!isPlayerOnTeamWith(map, searchingPlayer, goal.player())) {
          startArmy = 0 + goalTargetArmy;
        } else {
          startArmy = 0 - goalTargetArmy;
        }
        if (ignoreGoalArmy) {
          if (!isPlayerOnTeamWith(map, searchingPlayer, goal.player())) {
            if (!negHas(negativeTiles, goal)) startArmy -= goal.army;
          } else {
            if (!negHas(negativeTiles, goal)) startArmy += goal.army;
          }
        }
        startDist = entry.startDist;
        frontier.put([[startDist, 0, 0 - startArmy], goal, startDist, startArmy, Math.trunc(goalInc * 2), null]);
      } else {
        // 修掉 off-by-one：我们进格子立刻扣 1 兵，但目标格不该扣
        goalInc = additionalIncrement;
        startArmy = 1;
        if (ignoreGoalArmy && !negHas(negativeTiles, goal)) {
          if (!isPlayerOnTeamWith(map, searchingPlayer, goal.player())) {
            if (goal.army > 0) startArmy -= goal.army;
          } else {
            startArmy += goal.army;
          }
        }
        startDist = 0;
        frontier.put([[0, 0, 0 - startArmy], goal, 0, startArmy, Math.trunc(goalInc * 2), null]);
      }
    }

    var foundGoal = false;
    var foundArmy = -1000;
    var foundDist = -1;
    var endNode = null;
    var baseTurn = map.turn;
    var noNegs = negativeTiles === null || negativeTiles === undefined || (negativeTiles.size !== undefined && negativeTiles.size === 0);

    while (!frontier.empty) {
      var node = frontier.get();
      var prioVals = node[0];
      var current = node[1];
      var dist = node[2];
      var army = node[3];
      var goalInc = node[4];
      var fromTile = node[5];

      if (visited.raw[current.tile_index] !== null) continue;
      if (skipTiles && hasSkip(skipTiles, current)) continue;
      if (
        current.isMountain ||
        (noNeutralCities && current.isCostlyNeutral && !goalSet.has(current)) ||
        (!current.discovered && current.isNotPathable)
      ) {
        continue;
      }

      var negCaptures = prioVals[1];
      var prioArmy = prioVals[2];

      var nextArmy = army - 1;
      var isInc = ((baseTurn + dist) & 1) === 0 && dist > 0;

      var isTeam = isPlayerOnTeamWith(map, searchingPlayer, current.player());
      if (preferCapture && !isTeam) negCaptures -= 1;

      // nextArmy 的语义是「你必须带着这么多兵走到我旁边，这次进攻才杀得掉」
      if ((current.isCity && current.player() !== -1) || current.isGeneral) {
        if (isTeam) goalInc -= 1;
        else goalInc += 1;
      }

      var notNegativeTile = noNegs || !negHas(negativeTiles, current);

      if (current.army > 0) {
        if (isTeam) {
          if (notNegativeTile) nextArmy += current.army;
        } else {
          if (notNegativeTile) nextArmy -= current.army;
          else nextArmy -= 1;
        }
      }

      if (current.isSwamp) nextArmy -= 2;

      var newDist = dist + 1;

      visited.raw[current.tile_index] = [nextArmy, fromTile];

      if (nextArmy >= targetArmy && nextArmy > foundArmy && current.player() === searchingPlayer && current.army > 1) {
        foundDist = newDist;
        foundArmy = nextArmy;
        endNode = current;
        break;
      }

      if (isInc) nextArmy -= goalInc;

      if (newDist <= maxDepth && !foundGoal) {
        var movable = current.movable;
        for (var mi = 0; mi < movable.length; mi++) {
          frontier.put([
            [newDist, negCaptures, 0 - nextArmy],
            movable[mi],
            newDist,
            nextArmy,
            goalInc,
            current
          ]);
        }
      }
    }

    if (foundDist < 0) return null;

    var cur = endNode;
    var dist2 = foundDist;
    var nodes = [];
    var army2 = foundArmy;

    while (cur !== null) {
      nodes.push([army2, cur]);
      var vis = visited.raw[cur.tile_index];
      army2 = vis[0];
      cur = vis[1];
      dist2 -= 1;
    }
    nodes.reverse();

    var startNode = nodes[0][1];

    // 朝「对我们不利」的方向取整：宁可多带兵
    if (searchingPlayer === map.player_index) foundArmy = Math.floor(foundArmy);
    else foundArmy = Math.ceil(foundArmy);

    var pathObject = newPath(foundArmy);
    pathObject.add_next(startNode);

    var dist3 = foundDist;
    for (var ni = 1; ni < nodes.length; ni++) {
      var curNode = nodes[ni][1];
      if (curNode !== null) {
        pathObject.add_start(curNode);
        dist3 -= 1;
      }
    }

    while (pathObject.start !== null && (pathObject.start.tile.army <= 1 || pathObject.start.tile.player() !== searchingPlayer)) {
      pathObject.remove_start();
      pathObject.requiredDelay += 1;
    }

    if (pathObject.length <= 0) return null;

    return pathObject;
  }

  /* ==================================================================
   * a_star_find
   * ================================================================== */

  function shortestPathHeurTile(goal, cur) {
    return Math.abs(goal.x - cur.x) + Math.abs(goal.y - cur.y);
  }

  function euclidean_distance(v, goal) {
    return Math.sqrt(Math.pow(v.x - goal.x, 2) + Math.pow(v.y - goal.y, 2));
  }

  function a_star_find(startTiles, goal, opts) {
    opts = opts || {};
    var maxDepth = opt(opts, 'maxDepth', 200);
    var allowNeutralCities = opt(opts, 'allowNeutralCities', false);

    var frontier = new HeapQueue();
    // 原版用 dict[tile_index]；这里用原生 Map 存 tile_index -> fromTile，
    // 因为 Python 靠 `in came_from` 区分「没入队」和「入队且 from=None（起点）」，
    // 用 MapMatrix 会把 null 和「没有」混在一起。
    var cameFrom = new Map();
    var visited = new Set();
    var starts = [];

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (startDist, start) {
        starts.push([startDist, start]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) starts.push([0, startTiles[i]]);
    }

    for (var s = 0; s < starts.length; s++) {
      var startDist = starts[s][0];
      var start = starts[s][1];
      frontier.put([startDist + shortestPathHeurTile(goal, start), startDist, start]);
      cameFrom.set(start.tile_index, null);
      visited.add(start.tile_index);
    }

    var depthEvaluated = 0;

    while (!frontier.empty) {
      var node = frontier.get();
      var dist = node[1];
      var current = node[2];

      if (dist > depthEvaluated) depthEvaluated = dist;
      if (current === goal) break;

      var newCost = dist + 1;
      if (dist < maxDepth) {
        var movable = current.movable;
        for (var m = 0; m < movable.length; m++) {
          var next = movable[m];
          if (next.isMountain || (!next.discovered && next.isNotPathable)) continue;
          if (next.isCostlyNeutral && !allowNeutralCities) continue;
          if (visited.has(next.tile_index)) continue;

          var priority = newCost + shortestPathHeurTile(goal, next);
          frontier.put([priority, newCost, next]);
          cameFrom.set(next.tile_index, current);
          visited.add(next.tile_index);
        }
      }
    }

    if (!visited.has(goal.tile_index)) return null;

    var pathObject = newPath();
    pathObject.add_next(goal);
    var cur = goal;
    while (cameFrom.get(cur.tile_index) !== null) {
      cur = cameFrom.get(cur.tile_index);
      pathObject.add_start(cur);
    }

    return pathObject;
  }

  /* ==================================================================
   * breadth_first_find_queue —— goalFunc(current, army, dist) 的动态目标 BFS
   * ================================================================== */

  function breadth_first_find_queue(map, startTiles, goalFunc, opts) {
    opts = opts || {};
    var maxDepth = opt(opts, 'maxDepth', 200);
    var noNeutralCities = opt(opts, 'noNeutralCities', false);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var skipTiles = opt(opts, 'skipTiles', null);
    var bypassDefaultSkipLogic = opt(opts, 'bypassDefaultSkipLogic', false);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var ignoreStartTile = opt(opts, 'ignoreStartTile', false);

    if (searchingPlayer === -2) searchingPlayer = map.player_index;

    var frontier = new Deque();
    var nodeValues = new EK.MapMatrix(map, null); // (army, fromTile)

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        var startDist = val[0];
        var startArmy = val[1];
        if (tile.isMountain && !bypassDefaultSkipLogic) return;
        var goalInc = 0;
        if ((tile.isCity || tile.isGeneral) && tile.player() !== -1) goalInc = -0.5;
        startArmy = tile.army - 1;
        if (tile.player() !== searchingPlayer) {
          startArmy = 0 - tile.army - 1;
          goalInc = -1 * goalInc;
        }
        if (ignoreStartTile) startArmy = 0;
        nodeValues.raw[tile.tile_index] = [startArmy, null];
        frontier.appendleft([tile, startDist, startArmy, goalInc]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (tile.isMountain && !bypassDefaultSkipLogic) continue;
        var goalInc2 = 0;
        var startArmy2 = tile.army - 1;
        if (tile.player() !== searchingPlayer) startArmy2 = 0 - tile.army - 1;
        nodeValues.raw[tile.tile_index] = [startArmy2, null];
        if ((tile.isCity || tile.isGeneral) && tile.player() !== -1) goalInc2 = 0.5;
        if (ignoreStartTile) startArmy2 = 0;
        frontier.appendleft([tile, 0, startArmy2, goalInc2]);
      }
    }

    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var st = 0; st < skipArr.length; st++) nodeValues.raw[skipArr[st].tile_index] = [null, null];
    }

    var foundGoal = false;
    var foundArmy = -100000;
    var foundDist = 1000;
    var endNode = null;

    while (!frontier.empty && !foundGoal) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      var army = entry[2];
      var goalIncNow = entry[3];

      if (dist <= maxDepth && !foundGoal) {
        var movable = current.movable;
        var newDist = dist + 1;
        for (var mi = 0; mi < movable.length; mi++) {
          var nextTile = movable[mi];
          var curTuple = nodeValues.raw[nextTile.tile_index];
          if (
            curTuple !== null ||
            (!bypassDefaultSkipLogic &&
              (nextTile.isMountain ||
                (noNeutralCities && nextTile.isCostlyNeutral) ||
                (!nextTile.discovered && nextTile.isNotPathable)))
          ) {
            continue;
          }

          var inc = !((nextTile.isCity && nextTile.player() !== -1) || nextTile.isGeneral) ? 0 : dist / 2;
          var nextArmy = army - 1;
          if (!negHas(negativeTiles, nextTile)) {
            if (searchingPlayer === nextTile.player()) nextArmy += nextTile.army + inc;
            else nextArmy -= nextTile.army + inc;
          }
          nodeValues.raw[nextTile.tile_index] = [nextArmy, current];
          if (goalFunc(nextTile, nextArmy, newDist)) {
            foundGoal = true;
            foundDist = newDist;
            foundArmy = nextArmy;
            endNode = nextTile;
            break;
          }
          frontier.appendleft([nextTile, newDist, nextArmy, goalIncNow]);
        }
      }
    }

    if (foundDist >= 1000) return null;

    var node = endNode;
    var nodes = [];
    var army2 = foundArmy;

    while (node !== null) {
      nodes.push([army2, node]);
      var nv = nodeValues.raw[node.tile_index];
      army2 = nv[0];
      node = nv[1];
    }

    var pathObject = newPath(foundArmy);
    var revNodes = nodes.slice().reverse();
    for (var ri = 0; ri < revNodes.length; ri++) {
      var curNode = revNodes[ri][1];
      if (curNode !== null) pathObject.add_next(curNode);
    }

    return pathObject;
  }

  function breadth_first_find_dist_queue(startTiles, goalFunc, opts) {
    opts = opts || {};
    var maxDepth = opt(opts, 'maxDepth', 200);
    var noNeutralCities = opt(opts, 'noNeutralCities', false);
    var skipTiles = opt(opts, 'skipTiles', null);
    var bypassDefaultSkipLogic = opt(opts, 'bypassDefaultSkipLogic', false);

    var frontier = new Deque();
    var visited = new Set();

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (startDist, tile) {
        if (tile.isMountain && !bypassDefaultSkipLogic) return;
        frontier.appendleft([tile, startDist]);
        visited.add(tile.tile_index);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (tile.isMountain && !bypassDefaultSkipLogic) continue;
        frontier.appendleft([tile, 0]);
        visited.add(tile.tile_index);
      }
    }

    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) visited.add(skipArr[s].tile_index);
    }

    var foundDist = 1000;
    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];

      if (goalFunc(current, dist)) {
        foundDist = dist;
        break;
      }

      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (
          visited.has(nextTile.tile_index) ||
          (!bypassDefaultSkipLogic &&
            (nextTile.isMountain ||
              (noNeutralCities && nextTile.isCostlyNeutral) ||
              (!nextTile.discovered && nextTile.isNotPathable)))
        ) {
          continue;
        }
        visited.add(nextTile.tile_index);
        frontier.appendleft([nextTile, dist + 1]);
      }
    }

    return foundDist;
  }

  /* ==================================================================
   * breadth_first_foreach 家族
   *
   * foreachFunc 同时是 skip 函数：返回 true 表示不再向邻居扩散。
   * 默认（bypassDefaultSkip=false）跳过山和未发现障碍物。
   * ================================================================== */

  function breadth_first_foreach(map, startTiles, maxDepth, foreachFunc, skipTiles, noLog, bypassDefaultSkip) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();
    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) globalVisited.add(skipArr[s].tile_index);
    }

    for (var i = 0; i < startTiles.length; i++) {
      var tile = startTiles[i];
      if (tile.isMountain) continue;
      frontier.appendleft([tile, 0]);
      globalVisited.add(tile.tile_index);
    }

    var dist = 0;
    while (!frontier.empty) {
      var entry = frontier.popleft();
      var current = entry[0];
      dist = entry[1];
      if (dist > maxDepth) break;
      if (!bypassDefaultSkip && (current.isMountain || (!current.discovered && current.isNotPathable)) && dist > 0) continue;

      if (foreachFunc(current)) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (!globalVisited.has(nextTile.tile_index)) {
          globalVisited.add(nextTile.tile_index);
          frontier.append([nextTile, newDist]);
        }
      }
    }
  }

  function breadth_first_foreach_with_state(map, startTiles, maxDepth, foreachFunc, skipTiles, noLog, bypassDefaultSkip) {
    var isDict = startTiles !== null && !Array.isArray(startTiles) && typeof startTiles.forEach === 'function';
    var size = isDict ? startTiles.size : startTiles.length;
    if (size === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();
    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) globalVisited.add(skipArr[s].tile_index);
    }

    if (isDict) {
      startTiles.forEach(function (startVal, tile) {
        frontier.appendleft([tile, 0, startVal]);
        globalVisited.add(tile.tile_index);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        frontier.appendleft([startTiles[i], 0, null]);
        globalVisited.add(startTiles[i].tile_index);
      }
    }

    var dist = 0;
    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      dist = entry[1];
      var state = entry[2];
      if (dist > maxDepth) break;
      if (!bypassDefaultSkip && (current.isMountain || (!current.discovered && current.isNotPathable)) && dist > 0) continue;

      var nextState = foreachFunc(current, state);
      if (!nextState) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var next = movable[m];
        if (!globalVisited.has(next.tile_index)) {
          globalVisited.add(next.tile_index);
          frontier.appendleft([next, newDist, nextState]);
        }
      }
    }
  }

  /* startTiles: Map<Tile, [startDist, startVal]> —— 按 startDist 排序的小顶堆 */
  function breadth_first_foreach_with_state_and_start_dist(map, startTiles, maxDepth, foreachFunc, skipTiles, noLog, bypassDefaultSkip) {
    var size = startTiles !== null && !Array.isArray(startTiles) && typeof startTiles.forEach === 'function' ? startTiles.size : startTiles.length;
    if (size === 0) return;

    var frontier = new HeapQueue();
    var globalVisited = new Set();
    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) globalVisited.add(skipArr[s].tile_index);
    }

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        frontier.put([val[0], val[1], tile]);
      });
    } else {
      throw new Error('startTiles must be dict here');
    }

    var dist = 0;
    while (!frontier.empty) {
      var entry = frontier.get();
      dist = entry[0];
      var state = entry[1];
      var current = entry[2];

      if (globalVisited.has(current.tile_index)) continue;
      if (dist > maxDepth) break;
      globalVisited.add(current.tile_index);
      if (!bypassDefaultSkip && (current.isMountain || (!current.discovered && current.isNotPathable)) && dist > 0) continue;

      var nextState = foreachFunc(current, state);
      if (!nextState) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var next = movable[m];
        if (!globalVisited.has(next.tile_index)) frontier.put([newDist, nextState, next]);
      }
    }
  }

  function breadth_first_foreach_dist(map, startTiles, maxDepth, foreachFunc, skipTiles, noLog, bypassDefaultSkip) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();
    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) globalVisited.add(skipArr[s].tile_index);
    }

    for (var i = 0; i < startTiles.length; i++) {
      var tile = startTiles[i];
      if (tile.isMountain) continue;
      frontier.appendleft([tile, 0]);
      globalVisited.add(tile.tile_index);
    }

    var dist = 0;
    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      dist = entry[1];
      if (dist > maxDepth) break;
      if (!bypassDefaultSkip && (current.isMountain || (!current.discovered && current.isNotPathable))) continue;

      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (!globalVisited.has(nextTile.tile_index)) {
          frontier.appendleft([nextTile, newDist]);
          globalVisited.add(nextTile.tile_index);
        }
      }
    }
  }

  /* 中立城也走，山和未发现障碍物不走（靠 isNotPathable 判） */
  function breadth_first_foreach_dist_fast_incl_neut_cities(map, startTiles, maxDepth, foreachFunc) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      frontier.appendleft([startTiles[i], 0]);
      globalVisited.add(startTiles[i].tile_index);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      if (current.isNotPathable) continue;
      if (dist > maxDepth) break;
      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (globalVisited.has(nextTile.tile_index)) continue;
        globalVisited.add(nextTile.tile_index);
        frontier.appendleft([nextTile, newDist]);
      }
    }
  }

  function breadth_first_foreach_dist_fast_with_start_dist_incl_neut_cities(map, startTiles, maxDepth, foreachFunc) {
    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      frontier.appendleft([startTiles[i][1], startTiles[i][0], 0]);
      globalVisited.add(startTiles[i][1].tile_index);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      var depth = entry[2];
      if (current.isNotPathable) continue;
      if (depth > maxDepth) break;
      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      var newDepth = depth + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var n = movable[m];
        if (globalVisited.has(n.tile_index)) continue;
        globalVisited.add(n.tile_index);
        frontier.appendleft([n, newDist, newDepth]);
      }
    }
  }

  function breadth_first_foreach_dist_fast_no_neut_cities(map, startTiles, maxDepth, foreachFunc) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      var tile = startTiles[i];
      if (tile.isMountain) continue;
      frontier.appendleft([tile, 0]);
      globalVisited.add(tile.tile_index);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      if (newDist > maxDepth) continue;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (globalVisited.has(nextTile.tile_index)) continue;
        globalVisited.add(nextTile.tile_index);
        if (nextTile.isObstacle) continue;
        frontier.appendleft([nextTile, newDist]);
      }
    }
  }

  function breadth_first_foreach_dist_fast_no_default_skip(map, startTiles, maxDepth, foreachFunc) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      frontier.appendleft([startTiles[i], 0]);
      globalVisited.add(startTiles[i].tile_index);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      if (newDist > maxDepth) continue;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (globalVisited.has(nextTile.tile_index)) continue;
        globalVisited.add(nextTile.tile_index);
        frontier.appendleft([nextTile, newDist]);
      }
    }
  }

  function breadth_first_foreach_dist_fast_free_swamp_no_default_skip(map, startTiles, maxDepth, foreachFunc) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      frontier.appendleft([startTiles[i], 0]);
      globalVisited.add(startTiles[i].tile_index);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      if (newDist > maxDepth) continue;
      // 沼泽不占距离
      if (current.isSwamp) newDist -= 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (globalVisited.has(nextTile.tile_index)) continue;
        globalVisited.add(nextTile.tile_index);
        frontier.appendleft([nextTile, newDist]);
      }
    }
  }

  function breadth_first_foreach_fast_no_neut_cities(map, startTiles, maxDepth, foreachFunc) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) {
      var tile = startTiles[i];
      if (tile.isMountain) continue;
      globalVisited.add(tile.tile_index);
      frontier.appendleft([tile, 0]);
    }

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      if (foreachFunc(current)) continue;

      var newDist = dist + 1;
      if (newDist > maxDepth) continue;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var nextTile = movable[m];
        if (nextTile.isObstacle) continue;
        if (globalVisited.has(nextTile.tile_index)) continue;
        globalVisited.add(nextTile.tile_index);
        frontier.appendleft([nextTile, newDist]);
      }
    }
  }

  function breadth_first_foreach_dist_revisit_callback(map, startTiles, maxDepth, foreachFunc, revisitFunc, skipTiles, noLog, bypassDefaultSkip) {
    if (startTiles.length === 0) return;

    var frontier = new Deque();
    var globalVisited = new EK.MapMatrix(map, null);
    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) globalVisited.raw[skipArr[s].tile_index] = 1000;
    }

    for (var i = 0; i < startTiles.length; i++) {
      var tile = startTiles[i];
      if (tile.isMountain) continue;
      frontier.appendleft([tile, 0]);
      globalVisited.raw[tile.tile_index] = 0;
    }

    var dist = 0;
    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      dist = entry[1];
      var prevDist = globalVisited.raw[current.tile_index];
      if (prevDist) {
        if (prevDist < dist) revisitFunc(current, dist);
        continue;
      }
      if (dist > maxDepth) break;
      if (!bypassDefaultSkip && (current.isMountain || (!current.discovered && current.isNotPathable))) continue;

      if (foreachFunc(current, dist)) continue;

      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) frontier.appendleft([movable[m], newDist]);
    }
  }

  /* ==================================================================
   * 距离场
   * ================================================================== */

  function build_distance_map_matrix(map, startTiles) {
    var distanceMap = new EK.MapMatrix(map, UNREACHABLE);
    var raw = distanceMap.raw;
    var frontier = new Deque();

    for (var i = 0; i < startTiles.length; i++) {
      raw[startTiles[i].tile_index] = 0;
      frontier.append([startTiles[i], 0]);
    }

    while (!frontier.empty) {
      var entry = frontier.popleft();
      var current = entry[0];
      var dist = entry[1];
      var newDist = dist + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var n = movable[m];
        if (raw[n.tile_index] !== UNREACHABLE) continue;
        raw[n.tile_index] = newDist;
        if (n.isObstacle) continue;
        frontier.append([n, newDist]);
      }
    }

    return distanceMap;
  }

  function build_distance_map_matrix_with_max_depth(map, startTiles, maxDepth) {
    var distanceMap = new EK.MapMatrix(map, UNREACHABLE);
    var raw = distanceMap.raw;
    var frontier = new Deque();

    for (var i = 0; i < startTiles.length; i++) {
      raw[startTiles[i].tile_index] = 0;
      frontier.append([startTiles[i], 0]);
    }

    while (!frontier.empty) {
      var entry = frontier.popleft();
      var current = entry[0];
      var dist = entry[1];
      var newDist = dist + 1;
      if (newDist > maxDepth) break;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var n = movable[m];
        if (raw[n.tile_index] !== UNREACHABLE) continue;
        raw[n.tile_index] = newDist;
        if (n.isObstacle) continue;
        frontier.append([n, newDist]);
      }
    }

    return distanceMap;
  }

  function build_distance_map_matrix_with_skip(map, startTiles, skipTiles, maxDepth) {
    if (maxDepth === undefined) maxDepth = 1000;
    if (isEmptyColl(skipTiles)) {
      return build_distance_map_matrix_with_max_depth(map, startTiles, maxDepth);
    }

    var skipSet = toSkipSet(skipTiles);

    var distanceMap = new EK.MapMatrix(map, UNREACHABLE);
    var raw = distanceMap.raw;
    var frontier = new Deque();

    for (var i = 0; i < startTiles.length; i++) {
      raw[startTiles[i].tile_index] = 0;
      frontier.append([startTiles[i], 0]);
    }

    while (!frontier.empty) {
      var entry = frontier.popleft();
      var current = entry[0];
      var dist = entry[1];
      var newDist = dist + 1;
      if (newDist > maxDepth) break;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var n = movable[m];
        if (raw[n.tile_index] !== UNREACHABLE) continue;
        raw[n.tile_index] = newDist;
        if (n.isObstacle || skipSet.has(n)) continue;
        frontier.append([n, newDist]);
      }
    }

    return distanceMap;
  }

  function extend_distance_map_matrix(map, startTiles, toExtend, skipTiles, maxDepth) {
    if (maxDepth === undefined) maxDepth = 1000;
    var skipSet = null;
    if (skipTiles) {
      skipSet = toSkipSet(skipTiles);
    }

    var mapper;
    if (skipSet === null) {
      mapper = function (tile, dist) {
        if (toExtend.raw[tile.tile_index] < dist) return true;
        toExtend.raw[tile.tile_index] = dist;
        return tile.isCostlyNeutral;
      };
    } else {
      mapper = function (tile, dist) {
        if (toExtend.raw[tile.tile_index] < dist) return true;
        if (skipSet.has(tile)) return true;
        toExtend.raw[tile.tile_index] = dist;
        return tile.isCostlyNeutral;
      };
    }

    breadth_first_foreach_dist_fast_incl_neut_cities(map, startTiles, maxDepth, mapper);
  }

  /* startTiles: [[startDist, Tile], ...] */
  function build_distance_map_matrix_with_start_dist(map, startTiles, skipTiles, maxDepth) {
    if (maxDepth === undefined) maxDepth = 1000;

    var distanceMap = new EK.MapMatrix(map, UNREACHABLE);
    var skipSet = null;
    if (skipTiles) skipSet = toSkipSet(skipTiles);

    var mapper;
    if (skipSet === null) {
      mapper = function (tile, dist) {
        distanceMap.raw[tile.tile_index] = dist;
        return tile.isCostlyNeutral;
      };
    } else {
      mapper = function (tile, dist) {
        if (skipSet.has(tile)) return true;
        distanceMap.raw[tile.tile_index] = dist;
        return tile.isCostlyNeutral;
      };
    }

    var frontier = new Deque();
    var globalVisited = new Set();

    for (var i = 0; i < startTiles.length; i++) frontier.appendleft([startTiles[i][1], startTiles[i][0], 0]);

    while (!frontier.empty) {
      var entry = frontier.pop();
      var current = entry[0];
      var dist = entry[1];
      var depth = entry[2];
      if (current.isNotPathable) continue;
      if (globalVisited.has(current.tile_index)) continue;
      if (depth > maxDepth) break;
      globalVisited.add(current.tile_index);

      if (mapper(current, dist)) continue;

      var newDist = dist + 1;
      var newDepth = depth + 1;
      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) frontier.appendleft([movable[m], newDist, newDepth]);
    }

    return distanceMap;
  }

  /* ==================================================================
   * breadth_first_dynamic
   * ================================================================== */

  function breadth_first_dynamic(map, startTiles, goalFunc, opts) {
    opts = opts || {};
    var maxDepth = opt(opts, 'maxDepth', 100);
    var noNeutralCities = opt(opts, 'noNeutralCities', true);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var skipTiles = opt(opts, 'skipTiles', null);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var priorityFunc = opt(opts, 'priorityFunc', null);
    var ignoreStartTile = opt(opts, 'ignoreStartTile', false);
    var incrementBackward = opt(opts, 'incrementBackward', false);
    var noVal = opt(opts, 'noVal', false);

    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();

    function default_priority_func(nextTile, currentPriorityObject) {
      var dist = currentPriorityObject[0];
      var negArmySum = currentPriorityObject[3];
      var goalIncrement = currentPriorityObject[6];
      dist += 1;
      if (!isPlayerOnTeamWith(map, nextTile.player(), searchingPlayer)) negArmySum += nextTile.army;
      else negArmySum -= nextTile.army;

      // 永远留 1 兵；因为是负数所以 +1
      negArmySum += 1;
      negArmySum -= goalIncrement;
      return [dist, 0, 0, negArmySum, nextTile.x, nextTile.y, goalIncrement];
    }

    if (searchingPlayer === -2) searchingPlayer = map.player_index;
    if (priorityFunc === null) priorityFunc = default_priority_func;

    var frontier = new HeapQueue();
    var visited = new Map();

    if (skipTiles) {
      var skipArr = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < skipArr.length; s++) visited.set(skipArr[s], null);
    }

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        var startPriorityObject = val[0];
        var distance = val[1];
        frontier.put([startPriorityObject, distance, tile, null]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (priorityFunc !== default_priority_func) {
          throw new Error('yo you need to do the dictionary start if you are gonna pass a nonstandard priority func.');
        }
        if (tile.isMountain) continue;
        var dist = 0;
        var negCityCount = 0;
        var negEnemyTileCount = 0;
        var negArmySum = 0;
        var goalIncrement = 0;

        if (!ignoreStartTile && tile.isCity) negCityCount = -1;
        if (!ignoreStartTile && tile.player() !== searchingPlayer && tile.player() !== -1) negEnemyTileCount = -1;
        if (!ignoreStartTile && tile.player() === searchingPlayer) negArmySum = 1 - tile.army;
        else negArmySum = tile.army + 1;
        if (!ignoreStartTile) {
          if (tile.player() !== -1 && (tile.isCity || tile.isGeneral)) {
            goalIncrement = 0.5;
            if (tile.player() !== searchingPlayer) goalIncrement *= -1;
          }
        }

        var startVal = [dist, negCityCount, negEnemyTileCount, negArmySum, tile.x, tile.y, goalIncrement];
        frontier.put([startVal, dist, tile, null]);
      }
    }

    var foundGoal = false;
    var foundDist = 1000;
    var endNode = null;
    var depthEvaluated = 0;
    var foundVal = null;

    while (!frontier.empty) {
      var node = frontier.get();
      var prioVals = node[0];
      var dist = node[1];
      var current = node[2];
      var parent = node[3];

      if (visited.has(current)) continue;
      visited.set(current, parent);

      if (goalFunc(current, prioVals) && (foundVal === null || isLess(prioVals, foundVal))) {
        foundGoal = true;
        foundDist = dist;
        foundVal = prioVals;
        endNode = current;
      }
      if (dist > depthEvaluated) {
        depthEvaluated = dist;
        if (foundGoal) break;
      }
      if (dist <= maxDepth && !foundGoal) {
        var movable = current.movable;
        for (var m = 0; m < movable.length; m++) {
          var nextTile = movable[m];
          if (
            nextTile.isMountain ||
            (noNeutralCities && nextTile.isCostlyNeutral) ||
            (!nextTile.discovered && nextTile.isNotPathable)
          ) {
            continue;
          }
          var newDist = dist + 1;
          var nextVal = priorityFunc(nextTile, prioVals);
          if (nextVal !== null) frontier.put([nextVal, newDist, nextTile, current]);
        }
      }
    }

    if (foundDist >= 1000) return null;

    var tile2 = endNode;
    var tileList = [];
    while (tile2 !== null && tile2 !== undefined) {
      tileList.push(tile2);
      tile2 = visited.get(tile2);
    }
    var pathObject = newPath();
    tileList.reverse();
    for (var t = 0; t < tileList.length; t++) {
      if (tileList[t] !== null && tileList[t] !== undefined) pathObject.add_next(tileList[t]);
    }

    if (!noVal) {
      pathObject.calculate_value(
        searchingPlayer,
        map.team_ids_by_player_index,
        null,
        false,
        false,
        incrementBackward,
        false
      );
    }
    return pathObject;
  }

  /* ==================================================================
   * breadth_first_dynamic_max（默认实现 = *_global_visited）
   * ================================================================== */


  function breadth_first_dynamic_max(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    if (opt(opts, 'useGlobalVisitedSet', true) && !opt(opts, 'forceOld', false)) {
      return breadth_first_dynamic_max_global_visited(map, startTiles, valueFunc, opts);
    }
    throw new Error(
      'breadth_first_dynamic_max: the useGlobalVisitedSet=false / forceOld=true list-copying variant is dead code ' +
        'in the original (docstring says NEVER pass true) and was not ported.'
    );
  }

  function breadth_first_dynamic_max_per_tile(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    if (opt(opts, 'useGlobalVisitedSet', true) && !opt(opts, 'forceOld', false)) {
      return breadth_first_dynamic_max_per_tile_global_visited(map, startTiles, valueFunc, opts);
    }
    throw new Error('breadth_first_dynamic_max_per_tile: forceOld variant not ported (dead code).');
  }

  function breadth_first_dynamic_max_per_tile_per_distance(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    if (opt(opts, 'useGlobalVisitedSet', true) && !opt(opts, 'forceOld', false)) {
      return breadth_first_dynamic_max_per_tile_per_distance_global_visited(map, startTiles, valueFunc, opts);
    }
    throw new Error('breadth_first_dynamic_max_per_tile_per_distance: forceOld variant not ported (dead code).');
  }

  function breadth_first_dynamic_max_global_visited(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    var maxTurns = opt(opts, 'maxTurns', 100);
    var maxDepth = opt(opts, 'maxDepth', 100);
    var noNeutralCities = opt(opts, 'noNeutralCities', false);
    var noNeutralUndiscoveredObstacles = opt(opts, 'noNeutralUndiscoveredObstacles', true);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var skipTiles = opt(opts, 'skipTiles', null);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var priorityFunc = opt(opts, 'priorityFunc', null);
    var skipFunc = opt(opts, 'skipFunc', null);
    var ignoreStartTile = opt(opts, 'ignoreStartTile', false);
    var incrementBackward = opt(opts, 'incrementBackward', false);
    var preferNeutral = opt(opts, 'preferNeutral', false);
    var fullOnly = opt(opts, 'fullOnly', false);
    var fullOnlyArmyDistFunc = opt(opts, 'fullOnlyArmyDistFunc', null);
    var boundFunc = opt(opts, 'boundFunc', null);
    var maxIterations = opt(opts, 'maxIterations', INF);
    var priorityMatrix = opt(opts, 'priorityMatrix', null);
    var priorityMatrixSkipStart = opt(opts, 'priorityMatrixSkipStart', true);
    var priorityMatrixSkipEnd = opt(opts, 'priorityMatrixSkipEnd', false);
    var pathValueFunc = opt(opts, 'pathValueFunc', null);
    var ignoreNonPlayerArmy = opt(opts, 'ignoreNonPlayerArmy', false);
    var ignoreIncrement = opt(opts, 'ignoreIncrement', true);

    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();

    if (valueFunc === null || valueFunc === undefined) {
      valueFunc = function default_value_func(curTile, currentPriorityObject) {
        var dist = currentPriorityObject[0];
        var negEnemyTileCount = currentPriorityObject[2];
        var negArmySum = currentPriorityObject[3];
        if (dist === 0) return null;
        return [0 - negArmySum / dist, 0 - negEnemyTileCount];
      };
    }

    if (fullOnly) {
      var oldValFunc = valueFunc;
      valueFunc = function newValFunc(current, prioVals) {
        var res = fullOnlyArmyDistFunc(current, prioVals);
        var army = res[0];
        var dist = res[1];
        var tileSet = res[2];

        var validMoveCount = 0;
        var adjacents = current.movable;
        for (var ai = 0; ai < adjacents.length; ai++) {
          var adj = adjacents[ai];
          var skipMt = adj.isMountain || adj.isCostlyNeutral;
          var skipSearching = adj.player() === searchingPlayer;
          var skipArmy = army - adj.army < 2;
          var skipVisited = tileSet.has(adj) || negHas(negativeTiles, adj);
          if (!(skipMt || skipSearching || skipArmy || skipVisited)) validMoveCount += 1;
        }

        if (validMoveCount > 0 && dist < maxDepth) return null;
        return oldValFunc(current, prioVals);
      };
    }

    if (searchingPlayer === -2) searchingPlayer = map.player_index;

    var nonDefaultPrioFunc = true;
    if (priorityFunc === null || priorityFunc === undefined) {
      nonDefaultPrioFunc = false;
      priorityFunc = function default_priority_func(nextTile, currentPriorityObject) {
        var dist = currentPriorityObject[0];
        var negCityCount = currentPriorityObject[1];
        var negEnemyTileCount = currentPriorityObject[2];
        var negArmySum = currentPriorityObject[3];
        var sumX = currentPriorityObject[4];
        var sumY = currentPriorityObject[5];
        var goalIncrement = currentPriorityObject[6];
        dist += 1;
        if (nextTile.isCity) negCityCount -= 1;
        if (nextTile.player() !== searchingPlayer && (nextTile.player() !== -1 || (preferNeutral && !nextTile.isCity))) {
          negEnemyTileCount -= 1;
        }

        if (!negHas(negativeTiles, nextTile)) {
          if (isPlayerOnTeamWith(map, nextTile.player(), searchingPlayer)) negArmySum -= nextTile.army;
          else negArmySum += nextTile.army;
        }
        negArmySum += 1;
        negArmySum -= goalIncrement;
        return [dist, negCityCount, negEnemyTileCount, negArmySum, sumX + nextTile.x, sumY + nextTile.y, goalIncrement];
      };
    }

    var frontier = new HeapQueue();
    var fromTileLookup = new EK.MapMatrix(map, null); // (prioVals, parent)

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        var startPriorityObject = val[0];
        var distance = val[1];
        frontier.put([startPriorityObject, distance, 0, tile, null]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (nonDefaultPrioFunc) {
          throw new Error('yo you need to do the dictionary start if you are gonna pass a nonstandard priority func.');
        }
        if (tile.isMountain) continue;
        var dist = 0;
        var negCityCount = 0;
        var negEnemyTileCount = 0;
        var negArmySum = 0;
        var goalIncrement = 0;

        if (!ignoreStartTile && tile.isCity) negCityCount = -1;
        if (!ignoreStartTile && tile.player() !== searchingPlayer && tile.player() !== -1) negEnemyTileCount = -1;
        if (!ignoreStartTile && tile.player() === searchingPlayer) negArmySum = 1 - tile.army;
        else negArmySum = tile.army + 1;
        if (!ignoreStartTile) {
          if (tile.player() !== -1 && (tile.isCity || tile.isGeneral)) {
            goalIncrement = 0.5;
            if (tile.player() !== searchingPlayer) goalIncrement *= -1;
          }
        }

        var startVal = [dist, negCityCount, negEnemyTileCount, negArmySum, tile.x, tile.y, goalIncrement];
        frontier.put([startVal, dist, 0, tile, null]);
      }
    }

    var startTime = Date.now();
    var iter = 0;
    var foundDist = 1000;
    var endNode = null;
    var maxValue = null;
    var maxPrio = null;

    while (!frontier.empty) {
      iter += 1;
      if ((iter & 128) === 0 && (Date.now() - startTime) / 1000 > opt(opts, 'maxTime', 0.2)) break;
      if (iter > maxIterations) break;

      var node = frontier.get();
      var prioVals = node[0];
      var dist = node[1];
      var curTurns = node[2];
      var current = node[3];
      var parent = node[4];

      var fromVal = fromTileLookup.raw[current.tile_index];
      if (fromVal) continue;
      fromTileLookup.raw[current.tile_index] = [prioVals, parent];

      var newValue = valueFunc(current, prioVals);
      if (newValue !== null && newValue !== undefined && (maxValue === null || isGreater(newValue, maxValue))) {
        foundDist = dist;
        maxValue = newValue;
        maxPrio = prioVals;
        endNode = current;
      }

      if (dist >= maxDepth || curTurns >= maxTurns) continue;
      dist += 1;
      curTurns += 1;

      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var next = movable[m];
        if (next === parent) continue;
        if (
          next.isMountain ||
          (noNeutralCities && next.isCostlyNeutral) ||
          (next.isUndiscoveredObstacle && noNeutralUndiscoveredObstacles)
        ) {
          continue;
        }
        var nextVal = priorityFunc(next, prioVals);
        if (nextVal !== null) {
          if (boundFunc) {
            if (boundFunc(next, nextVal, maxPrio)) continue;
          }
          if (skipFunc && skipFunc(next, nextVal)) continue;
          frontier.put([nextVal, dist, curTurns, next, current]);
        }
      }
    }

    if (foundDist >= 1000) return null;

    var pathObject = newPath();
    var tile = endNode;
    for (;;) {
      if (tile === null || tile === undefined) break;
      pathObject.add_start(tile);
      var fromData = fromTileLookup.raw[tile.tile_index];
      if (!fromData) break;
      var prevTile = fromData[1];
      if (prevTile === tile) throw new Error('self referential fromTile ' + prevTile + ' -> ' + tile);
      tile = prevTile;
    }

    if (pathObject.length === 0) return null;

    if (pathValueFunc) {
      pathObject.value = pathValueFunc(pathObject, maxValue);
    } else {
      var pathNegs = negativeTiles;
      if (ignoreStartTile) {
        var negWithStart = new Set(negativeTiles);
        if (Array.isArray(startTiles)) {
          for (var si = 0; si < startTiles.length; si++) negWithStart.add(startTiles[si]);
        } else startTiles.forEach(function (v, st) {
          negWithStart.add(st);
        });
        pathNegs = negWithStart;
      }
      pathObject.calculate_value(searchingPlayer, map.team_ids_by_player_index, pathNegs, ignoreNonPlayerArmy, ignoreIncrement, incrementBackward, false);
      // 注意参数顺序：negativeTiles, ignoreNonPlayerArmy, ignoreIncrement, incrementBackwards, doNotSaveToPath

      var matrixStart = priorityMatrixSkipStart ? 1 : 0;
      var matrixEndOffset = priorityMatrixSkipEnd ? 0 : -1;
      if (priorityMatrix) {
        for (var pi = matrixStart; pi < pathObject.length - matrixEndOffset; pi++) {
          pathObject.value += priorityMatrix.raw[pathObject.tileList[pi].tile_index];
        }
      }
    }

    return pathObject;
  }

  function breadth_first_dynamic_max_per_tile_global_visited(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    var maxTurns = opt(opts, 'maxTurns', 100);
    var maxDepth = opt(opts, 'maxDepth', 100);
    var noNeutralCities = opt(opts, 'noNeutralCities', false);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var skipTiles = opt(opts, 'skipTiles', null);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var priorityFunc = opt(opts, 'priorityFunc', null);
    var skipFunc = opt(opts, 'skipFunc', null);
    var ignoreStartTile = opt(opts, 'ignoreStartTile', false);
    var incrementBackward = opt(opts, 'incrementBackward', false);
    var preferNeutral = opt(opts, 'preferNeutral', false);
    var fullOnly = opt(opts, 'fullOnly', false);
    var fullOnlyArmyDistFunc = opt(opts, 'fullOnlyArmyDistFunc', null);
    var boundFunc = opt(opts, 'boundFunc', null);
    var maxIterations = opt(opts, 'maxIterations', INF);
    var priorityMatrix = opt(opts, 'priorityMatrix', null);
    var priorityMatrixSkipStart = opt(opts, 'priorityMatrixSkipStart', false);
    var priorityMatrixSkipEnd = opt(opts, 'priorityMatrixSkipEnd', false);
    var ignoreNonPlayerArmy = opt(opts, 'ignoreNonPlayerArmy', false);
    var ignoreIncrement = opt(opts, 'ignoreIncrement', true);

    if (negativeTiles === null || negativeTiles === undefined) negativeTiles = new Set();

    function default_priority_func(nextTile, currentPriorityObject) {
      var dist = currentPriorityObject[0];
      var negCityCount = currentPriorityObject[1];
      var negEnemyTileCount = currentPriorityObject[2];
      var negArmySum = currentPriorityObject[3];
      var sumX = currentPriorityObject[4];
      var sumY = currentPriorityObject[5];
      var goalIncrement = currentPriorityObject[6];
      dist += 1;
      if (nextTile.isCity) negCityCount -= 1;
      if (nextTile.player() !== searchingPlayer && (nextTile.player() !== -1 || (preferNeutral && !nextTile.isCity))) {
        negEnemyTileCount -= 1;
      }
      if (!negHas(negativeTiles, nextTile)) {
        if (nextTile.player() === searchingPlayer) negArmySum -= nextTile.army;
        else negArmySum += nextTile.army;
      }
      negArmySum += 1;
      negArmySum -= goalIncrement;
      return [dist, negCityCount, negEnemyTileCount, negArmySum, sumX + nextTile.x, sumY + nextTile.y, goalIncrement];
    }

    if (fullOnly) {
      var oldValFunc = valueFunc;
      valueFunc = function (current, prioVals) {
        var res = fullOnlyArmyDistFunc(current, prioVals);
        var army = res[0];
        var dist = res[1];
        var tileSet = res[2];
        var validMoveCount = 0;
        var adjacents = current.movable;
        for (var ai = 0; ai < adjacents.length; ai++) {
          var adj = adjacents[ai];
          var skipMt = adj.isMountain || adj.isCostlyNeutral;
          var skipSearching = adj.player() === searchingPlayer;
          var skipArmy = army - adj.army < 2;
          var skipVisited = tileSet.has(adj) || negHas(negativeTiles, adj);
          if (!(skipMt || skipSearching || skipArmy || skipVisited)) validMoveCount += 1;
        }
        if (validMoveCount > 0 && dist < maxDepth) return null;
        return oldValFunc(current, prioVals);
      };
    }

    if (searchingPlayer === -2) searchingPlayer = map.player_index;
    if (priorityFunc === null || priorityFunc === undefined) priorityFunc = default_priority_func;

    var frontier = new HeapQueue();
    var fromTileLookup = new EK.MapMatrix(map, null);

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        frontier.put([val[0], val[1], 0, tile, null, tile]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (priorityFunc !== default_priority_func) {
          throw new Error('yo you need to do the dictionary start if you are gonna pass a nonstandard priority func.');
        }
        if (tile.isMountain) continue;
        var dist = 0;
        var negCityCount = 0;
        var negEnemyTileCount = 0;
        var negArmySum = 0;
        var goalIncrement = 0;

        if (!ignoreStartTile && tile.isCity) negCityCount = -1;
        if (!ignoreStartTile && tile.player() !== searchingPlayer && tile.player() !== -1) negEnemyTileCount = -1;
        if (!ignoreStartTile && tile.player() === searchingPlayer) negArmySum = 1 - tile.army;
        else negArmySum = tile.army + 1;
        if (!ignoreStartTile) {
          if (tile.player() !== -1 && (tile.isCity || tile.isGeneral)) {
            goalIncrement = 0.5;
            if (tile.player() !== searchingPlayer) goalIncrement *= -1;
          }
        }

        var startVal = [dist, negCityCount, negEnemyTileCount, negArmySum, tile.x, tile.y, goalIncrement];
        frontier.put([startVal, dist, 0, tile, null, tile]);
      }
    }

    var startTime = Date.now();
    var iter = 0;
    var foundDist = 1000;
    var maxValues = new Map();
    var maxPrios = new Map();
    var endNodes = new Map();

    while (!frontier.empty) {
      iter += 1;
      if (iter >= maxIterations) break;
      if ((iter & 64) === 0 && (Date.now() - startTime) / 1000 > opt(opts, 'maxTime', 0.2)) break;

      var node = frontier.get();
      var prioVals = node[0];
      var dist = node[1];
      var curTurns = node[2];
      var current = node[3];
      var parent = node[4];
      var startTile = node[5];

      var fromVal = fromTileLookup.raw[current.tile_index];
      if (fromVal) continue;
      if (skipTiles && hasSkip(skipTiles, current)) continue;

      fromTileLookup.raw[current.tile_index] = [prioVals, parent];

      var newValue = valueFunc(current, prioVals);
      if (newValue !== null && newValue !== undefined && (maxValues.get(startTile) === undefined || isGreater(newValue, maxValues.get(startTile)))) {
        foundDist = dist;
        maxValues.set(startTile, newValue);
        maxPrios.set(startTile, prioVals);
        endNodes.set(startTile, current);
      }

      if (dist >= maxDepth || curTurns >= maxTurns) continue;
      dist += 1;
      curTurns += 1;

      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var next = movable[m];
        if (next === parent) continue;
        if (
          next.isMountain ||
          (noNeutralCities && next.isCostlyNeutral) ||
          (!next.discovered && next.isNotPathable)
        ) {
          continue;
        }
        var nextPrio = priorityFunc(next, prioVals);
        if (nextPrio !== null) {
          if (boundFunc) {
            var boundPrio = maxPrios.has(startTile) ? maxPrios.get(startTile) : null;
            if (boundPrio !== null && boundFunc(next, nextPrio, boundPrio)) continue;
          }
          if (skipFunc && skipFunc(next, nextPrio)) continue;
          frontier.put([nextPrio, dist, curTurns, next, current, startTile]);
        }
      }
    }

    if (foundDist >= 1000) return new Map();

    var matrixStart = priorityMatrixSkipStart ? 1 : 0;
    var matrixEndOffset = priorityMatrixSkipEnd ? 0 : -1;

    var maxPaths = new Map();
    maxValues.forEach(function (value, startTile) {
      var tile = endNodes.get(startTile);
      var pathObject = newPath();

      for (;;) {
        if (tile === null || tile === undefined) break;
        pathObject.add_start(tile);
        var fromData = fromTileLookup.raw[tile.tile_index];
        if (!fromData) break;
        var prevTile = fromData[1];
        if (prevTile === tile) throw new Error('self referential fromTile ' + prevTile + ' -> ' + tile);
        tile = prevTile;
      }

      if (pathObject.length === 0) return;

      maxPaths.set(startTile, pathObject);

      pathObject.calculate_value(searchingPlayer, map.team_ids_by_player_index, negativeTiles, ignoreNonPlayerArmy, ignoreIncrement, incrementBackward, false);

      if (priorityMatrix) {
        for (var pi = matrixStart; pi < pathObject.length - matrixEndOffset; pi++) {
          pathObject.value += priorityMatrix.raw[pathObject.tileList[pi].tile_index];
        }
      }
    });

    return maxPaths;
  }

  function breadth_first_dynamic_max_per_tile_per_distance_global_visited(map, startTiles, valueFunc, opts) {
    opts = opts || {};
    var maxTurns = opt(opts, 'maxTurns', 100);
    var maxDepth = opt(opts, 'maxDepth', 100);
    var noNeutralCities = opt(opts, 'noNeutralCities', false);
    var negativeTiles = opt(opts, 'negativeTiles', null);
    var skipTiles = opt(opts, 'skipTiles', null);
    var searchingPlayer = opt(opts, 'searchingPlayer', -2);
    var priorityFunc = opt(opts, 'priorityFunc', null);
    var skipFunc = opt(opts, 'skipFunc', null);
    var ignoreStartTile = opt(opts, 'ignoreStartTile', false);
    var incrementBackward = opt(opts, 'incrementBackward', false);
    var fullOnly = opt(opts, 'fullOnly', false);
    var fullOnlyArmyDistFunc = opt(opts, 'fullOnlyArmyDistFunc', null);
    var boundFunc = opt(opts, 'boundFunc', null);
    var maxIterations = opt(opts, 'maxIterations', INF);
    var pathValueFunc = opt(opts, 'pathValueFunc', null);
    var priorityMatrix = opt(opts, 'priorityMatrix', null);
    var priorityMatrixSkipStart = opt(opts, 'priorityMatrixSkipStart', true);
    var priorityMatrixSkipEnd = opt(opts, 'priorityMatrixSkipEnd', false);
    var ignoreNonPlayerArmy = opt(opts, 'ignoreNonPlayerArmy', false);
    var ignoreIncrement = opt(opts, 'ignoreIncrement', true);

    if (fullOnly) {
      var oldValFunc = valueFunc;
      valueFunc = function (current, prioVals) {
        var res = fullOnlyArmyDistFunc(current, prioVals);
        var army = res[0];
        var dist = res[1];
        var tileSet = res[2];
        var validMoveCount = 0;
        var adjacents = current.movable;
        for (var ai = 0; ai < adjacents.length; ai++) {
          var adj = adjacents[ai];
          var skipMt = adj.isMountain || adj.isCostlyNeutral;
          var skipSearching = adj.player() === searchingPlayer;
          var skipArmy = army - adj.army < 2;
          var skipVisited = tileSet.has(adj) || negHas(negativeTiles, adj);
          if (!(skipMt || skipSearching || skipArmy || skipVisited)) validMoveCount += 1;
        }
        if (validMoveCount > 0 && dist < maxDepth) return null;
        return oldValFunc(current, prioVals);
      };
    }

    if (searchingPlayer === -2) searchingPlayer = map.player_index;
    if (priorityFunc === null || priorityFunc === undefined) {
      throw new Error('priorityFunc cannot be null');
    }

    var frontier = new HeapQueue();
    var fromTileLookup = new EK.MapMatrix(map, null);
    var maxValuesDict = new Map(); // startTile -> Map(dist -> [value, prioVals, tile])

    if (!Array.isArray(startTiles)) {
      startTiles.forEach(function (val, tile) {
        var startDict = new Map();
        maxValuesDict.set(tile, startDict);
        frontier.put([val[0], val[1], 0, tile, null, startDict]);
      });
    } else {
      for (var i = 0; i < startTiles.length; i++) {
        var tile = startTiles[i];
        if (tile.isMountain) continue;
        var dist = 0;
        var negCityCount = 0;
        var negEnemyTileCount = 0;
        var negArmySum = 0;
        var goalIncrement = 0;

        if (!ignoreStartTile && tile.isCity) negCityCount = -1;
        if (!ignoreStartTile && tile.player() !== searchingPlayer && tile.player() !== -1) negEnemyTileCount = -1;
        if (!ignoreStartTile && tile.player() === searchingPlayer) negArmySum = 1 - tile.army;
        else negArmySum = tile.army + 1;
        if (!ignoreStartTile) {
          if (tile.player() !== -1 && (tile.isCity || tile.isGeneral)) {
            goalIncrement = 0.5;
            if (tile.player() !== searchingPlayer) goalIncrement *= -1;
          }
        }

        var startDict2 = new Map();
        maxValuesDict.set(tile, startDict2);
        var startVal = [dist, negCityCount, negEnemyTileCount, negArmySum, tile.x, tile.y, goalIncrement];
        frontier.put([startVal, dist, 0, tile, null, startDict2]);
      }
    }

    var startTime = Date.now();
    var iter = 0;
    var foundDist = 1000;

    while (!frontier.empty) {
      iter += 1;
      if ((iter & 63) === 0) {
        if ((Date.now() - startTime) / 1000 > opt(opts, 'maxTime', 0.2) || iter > maxIterations) break;
      }

      var node = frontier.get();
      var prioVals = node[0];
      var dist = node[1];
      var curTurns = node[2];
      var current = node[3];
      var parent = node[4];
      var maxDict = node[5];

      var fromVal = fromTileLookup.raw[current.tile_index];
      if (fromVal !== null) continue;

      if (skipTiles && hasSkip(skipTiles, current)) continue;

      fromTileLookup.raw[current.tile_index] = [prioVals, parent];

      var newValue = valueFunc(current, prioVals);

      if (newValue) {
        var maxMinusOne = null;
        var maxMinusOneStuff = maxDict.get(dist - 1);
        if (maxMinusOneStuff) maxMinusOne = maxMinusOneStuff[0];
        if (maxMinusOne === null || isLess(maxMinusOne, newValue)) {
          var val = null;
          var valStuff = maxDict.get(dist);
          if (valStuff) val = valStuff[0];

          if (val === null || isGreater(newValue, val)) {
            foundDist = dist;
            maxDict.set(dist, [newValue, prioVals, current]);
          }
        }
      }

      if (dist >= maxDepth || curTurns >= maxTurns) continue;
      var ogDist = dist;
      dist += 1;
      curTurns += 1;

      var movable = current.movable;
      for (var m = 0; m < movable.length; m++) {
        var next = movable[m];
        if (next === parent) continue;
        if (
          next.isMountain ||
          (noNeutralCities && next.isCostlyNeutral) ||
          (!next.discovered && next.isNotPathable)
        ) {
          continue;
        }
        var nextPrio = priorityFunc(next, prioVals);
        if (nextPrio !== null) {
          if (boundFunc) {
            var maxPrioStuff = maxDict.get(ogDist);
            if (maxPrioStuff) {
              if (boundFunc(next, nextPrio, maxPrioStuff[1])) continue;
            }
          }
          if (skipFunc && skipFunc(next, nextPrio)) continue;
          frontier.put([nextPrio, dist, curTurns, next, current, maxDict]);
        }
      }
    }

    if (foundDist >= 1000) return new Map();

    var matrixStart = priorityMatrixSkipStart ? 1 : 0;
    var matrixEndOffset = priorityMatrixSkipEnd ? 0 : -1;
    var maxPaths = new Map();

    maxValuesDict.forEach(function (table, startTile) {
      var pathListForTile = [];
      table.forEach(function (valObj, dist) {
        var pathObject = newPath();
        var val = valObj[0];
        var tile = valObj[2];

        for (;;) {
          if (tile === null || tile === undefined) break;
          pathObject.add_start(tile);
          var fromData = fromTileLookup.raw[tile.tile_index];
          if (!fromData) break;
          var prevTile = fromData[1];
          if (prevTile === tile) throw new Error('self referential fromTile ' + prevTile + ' -> ' + tile);
          tile = prevTile;
        }

        if (pathValueFunc) {
          pathObject.value = pathValueFunc(pathObject, val);
        } else {
          var pathNegs = negativeTiles;
          if (ignoreStartTile) {
            var negWithStart = new Set(negativeTiles);
            if (Array.isArray(startTiles)) {
              for (var si = 0; si < startTiles.length; si++) negWithStart.add(startTiles[si]);
            } else startTiles.forEach(function (v, st) {
              negWithStart.add(st);
            });
            pathNegs = negWithStart;
          }
          pathObject.calculate_value(searchingPlayer, map.team_ids_by_player_index, pathNegs, ignoreNonPlayerArmy, ignoreIncrement, incrementBackward, false);

          if (priorityMatrix) {
            for (var pi = matrixStart; pi < pathObject.length - matrixEndOffset; pi++) {
              pathObject.value += priorityMatrix.raw[pathObject.tileList[pi].tile_index];
            }
          }
        }

        if (pathObject.length === 0) return;
        pathListForTile.push(pathObject);
      });
      maxPaths.set(startTile, pathListForTile);
    });

    return maxPaths;
  }

  /* ==================================================================
   * 便捷入口：等价于「从 start 到 goal 的 BFS 最短路」，给冒烟脚本 / 调试用。
   * 原版没有这个函数名，是 a_star_find 的薄封装（同样跳山、不穿贵中立城）。
   * ================================================================== */

  function shortest_path(start, goal, opts) {
    opts = opts || {};
    return a_star_find([start], goal, opts);
  }

  function do_bfs(map, startTiles, maxDepth, foreachFunc) {
    return breadth_first_foreach(map, startTiles, maxDepth === undefined ? 200 : maxDepth, foreachFunc || function () {
      return false;
    });
  }

  EK.search = {
    // 容器 / 工具
    HeapQueue: HeapQueue,
    HeapQueueMax: HeapQueueMax,
    Deque: Deque,
    Counter: Counter,
    where: where,
    any_where: any_where,
    count: count,
    min_where: min_where,
    max_where: max_where,
    first_or_none: first_or_none,
    first_or_default: first_or_default,
    cmpVals: cmpVals,

    // 兼容入口
    shortest_path: shortest_path,
    do_bfs: do_bfs,

    // 原版函数
    dest_breadth_first_target: dest_breadth_first_target,
    a_star_find: a_star_find,
    euclidean_distance: euclidean_distance,
    breadth_first_find_queue: breadth_first_find_queue,
    breadth_first_find_dist_queue: breadth_first_find_dist_queue,
    breadth_first_dynamic: breadth_first_dynamic,
    breadth_first_dynamic_max: breadth_first_dynamic_max,
    breadth_first_dynamic_max_global_visited: breadth_first_dynamic_max_global_visited,
    breadth_first_dynamic_max_per_tile: breadth_first_dynamic_max_per_tile,
    breadth_first_dynamic_max_per_tile_global_visited: breadth_first_dynamic_max_per_tile_global_visited,
    breadth_first_dynamic_max_per_tile_per_distance: breadth_first_dynamic_max_per_tile_per_distance,
    breadth_first_dynamic_max_per_tile_per_distance_global_visited:
      breadth_first_dynamic_max_per_tile_per_distance_global_visited,

    breadth_first_foreach: breadth_first_foreach,
    breadth_first_foreach_with_state: breadth_first_foreach_with_state,
    breadth_first_foreach_with_state_and_start_dist: breadth_first_foreach_with_state_and_start_dist,
    breadth_first_foreach_dist: breadth_first_foreach_dist,
    breadth_first_foreach_dist_fast_incl_neut_cities: breadth_first_foreach_dist_fast_incl_neut_cities,
    breadth_first_foreach_dist_fast_with_start_dist_incl_neut_cities:
      breadth_first_foreach_dist_fast_with_start_dist_incl_neut_cities,
    breadth_first_foreach_dist_fast_no_neut_cities: breadth_first_foreach_dist_fast_no_neut_cities,
    breadth_first_foreach_dist_fast_no_default_skip: breadth_first_foreach_dist_fast_no_default_skip,
    breadth_first_foreach_dist_fast_free_swamp_no_default_skip:
      breadth_first_foreach_dist_fast_free_swamp_no_default_skip,
    breadth_first_foreach_fast_no_neut_cities: breadth_first_foreach_fast_no_neut_cities,
    breadth_first_foreach_dist_revisit_callback: breadth_first_foreach_dist_revisit_callback,

    build_distance_map_matrix: build_distance_map_matrix,
    build_distance_map_matrix_with_max_depth: build_distance_map_matrix_with_max_depth,
    build_distance_map_matrix_with_skip: build_distance_map_matrix_with_skip,
    build_distance_map_matrix_with_start_dist: build_distance_map_matrix_with_start_dist,
    extend_distance_map_matrix: extend_distance_map_matrix
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

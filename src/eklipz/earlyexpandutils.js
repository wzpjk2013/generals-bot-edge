/*
 * EarlyExpandUtils — 开局前 25 格扩张规划（原版 EklipZ / generals-bot-cs）
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\EarlyExpandUtils.py（2543 行）
 * 移植范围：1–1308 行（全部活代码）。1309 行之后的 __reverse 整族、optimize_first_25__start_end_precalc、
 * build_liberty_plan_recurse / build_expansion_plan_mst_iterative / _build_mst_plan_recurse /
 * build_initial_mst_gather_root 在全仓没有任何生产调用者（只被彼此或被注释掉的 unit test 调），
 * 因此没有移植，见文件末的「未移植」说明。
 *
 * 算法一句话：给「一次从将军出发的兵线」找一条 / 多段路径，使得到第 50 回合时吃到的地块数最大。
 *   - 候选组合 = (出发时将军兵数 genArmy, 允许浪费的步数 forceWasted)，见 optimize_first_25 里那两张表；
 *   - 每一段用 _optimize_25_launch_segment 做一次带路径感知的启发式最优先搜索（10 元组优先级对象）；
 *   - 每个候选的评分 = __evaluate_plan_value 的四元组（吃到的地块数, 视野收益, -权重和, 离将军距离和），
 *     按 Python 元组字典序比较，取最大的那个。
 *   所以这不是最短路，而是「按权重地图朝敌人方向贪心 + 用 repeat/浪费预算控制节奏」的组合搜索。
 *
 * 与原版的差异（都是为了确定性，oracle 两侧一致）：
 *   1. 原版到处用 time.perf_counter() 做预算切分，同一台机器两次跑结果都可能不同。这里**完全不要时间预算**：
 *      所有 cutoff 比较都拿 Infinity 当「现在」，等价于原版「时间永远够用」。oracle 侧把 perf_counter 冻在 0.0
 *      得到同样效果（0.0 > cutoff 恒假），于是两边都是「跑满」的确定性版本。
 *   2. 原版遍历 set 的地方（planTileSet）顺序是对象 hash 序，跨进程不可复现。这里一律按 tile_index 升序。
 *      __evaluate_plan_value 的 visibilityValue 是唯一受这个顺序影响的量，oracle 侧对同名函数做了同样排序。
 *   3. 原版 Python 的 `arr[-1]` / 负下标（team=-1 伪玩家、pathList[-1]）在这里显式折算，不依赖 JS 的负下标。
 *   4. try_random_skips 真分支用 random.choice，原版 ALLOW_RANDOM_SKIPS=False 且顶层从不传 try_random_skips=True，
 *      是死分支；这里实现成可注入 rng（默认 Math.random），跑不到。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* 原版 DebugHelper.IS_DEBUGGING / DEBUG_ASSERTS / ALLOW_RANDOM_SKIPS */
  var DEBUG_ASSERTS = false;
  var ALLOW_RANDOM_SKIPS = false;
  var IS_DEBUGGING = false;

  var EMPTY_COMBINATION = [0, 0, 0, 0];

  /* ==================================================================
   * 小工具
   * ================================================================== */

  /* Python 元组比较：逐元素，第一个不等的元素定胜负。评分元组里混着 float 和 int，
   * 直接拿 JS 的 [] > [] 会退化成字符串比较，必须逐个比。 */
  function cmpTuple(a, b) {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (Array.isArray(a) && Array.isArray(b)) {
      var n = a.length < b.length ? a.length : b.length;
      for (var i = 0; i < n; i++) {
        var c = cmpTuple(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  /* 逐元素的 Python 相等：Tile 按 tile_index 比（Tile.__eq__），list 逐项递归，
   * None 只等于 None。元组比较的「先 == 再 <」规则要靠它。 */
  function pyEqual(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
      return (a === null || a === undefined) && (b === null || b === undefined);
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!pyEqual(a[i], b[i])) return false;
      return true;
    }
    if (typeof a === 'object' && typeof b === 'object') return a.tile_index === b.tile_index;
    return a === b;
  }

  /* Python 的 a < b。Tile 只比 army（Tile.__lt__），None 比任何东西都小，
   * 序列按第一个不相等的元素递归决定。 */
  function pyLess(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      var n = a.length < b.length ? a.length : b.length;
      for (var i = 0; i < n; i++) {
        if (!pyEqual(a[i], b[i])) return pyLess(a[i], b[i]);
      }
      return a.length < b.length;
    }
    if (a && typeof a === 'object' && b && typeof b === 'object') return a.army < b.army;
    if (a === null || a === undefined) return !(b === null || b === undefined);
    return a < b;
  }

  /* 关键差异点：Python 的元组比较在「两个元素 == 为假」时立刻返回那个 < 的结果，
   * 不再看后面的元素。两个 army 相等但 tile_index 不同的 Tile，< 和 > 都是 False
   * （不可比），元组比较就此结束。而 search.js 的 cmpVals 把这种情况当成「相等」继续
   * 往后比，会拿后面的 number 元素定胜负 —— 那会让 BFS 的堆序和原版不同，
   * 路径选择跟着漂。这里实现严格版。
   * 注意：对不可比的一对，a<b 与 b<a 都返回 false，所以两个方向都给 1。 */
  function pyCmp(a, b) {
    if (pyEqual(a, b)) return 0;
    return pyLess(a, b) ? -1 : 1;
  }

  /* CPython heapq 的逐行等价物（push=_siftdown、pop=_siftup，平局取右孩子），
   * 只是比较器换成 pyCmp。search.js 的 HeapQueue 除比较器外与本类完全一致，
   * 但那个比较器不满足 Python 元组语义，见 pyCmp 注释。 */
  function PyHeap() {
    this.q = [];
  }
  PyHeap.prototype._siftdown = function (startpos, pos) {
    var q = this.q;
    var newitem = q[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = q[parentpos];
      if (pyLess(newitem, parent)) {
        q[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    q[pos] = newitem;
  };
  PyHeap.prototype._siftup = function (pos) {
    var q = this.q;
    var endpos = q.length;
    var startpos = pos;
    var newitem = q[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      if (rightpos < endpos && !pyLess(q[childpos], q[rightpos])) childpos = rightpos;
      q[pos] = q[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    q[pos] = newitem;
    this._siftdown(startpos, pos);
  };
  PyHeap.prototype.put = function (item) {
    this.q.push(item);
    this._siftdown(0, this.q.length - 1);
  };
  PyHeap.prototype.get = function () {
    var q = this.q;
    var lastelt = q.pop();
    if (q.length === 0) return lastelt;
    var returnitem = q[0];
    q[0] = lastelt;
    this._siftup(0);
    return returnitem;
  };
  Object.defineProperty(PyHeap.prototype, 'size', {
    get: function () {
      return this.q.length;
    },
  });

  /* Python 的 a // b（向下取整），allowWastedMoves 可能是负数，不能用 |0 或 Math.round */
  function floorDiv(a, b) {
    return Math.floor(a / b);
  }

  /* tile_weight_map / dist_map 都是 MapMatrix 形状：raw[tile_index]。
   * 原版 __getitem__ 按 Tile 取，这里统一走 raw，省掉一次查表。 */
  function matGet(matrix, tile) {
    return matrix.raw[tile.tile_index];
  }

  function tilesOfPlayer(map, player) {
    var p = map.players[player];
    return p ? p.tiles : [];
  }

  /* 原版 map.get_teammates_no_self：同队且不含自己。JS map.js 有同名字段但没有 getter */
  function teammatesNoSelf(map, player) {
    var arr = map._teammates_by_player_no_self;
    if (arr && arr[player] !== undefined) return arr[player];
    var teams = map.team_ids_by_player_index;
    var team = player >= 0 && player < teams.length ? teams[player] : -1;
    var out = [];
    for (var i = 0; i < map.players.length; i++) {
      if (i !== player && map.players[i].team === team) out.push(i);
    }
    return out;
  }

  function normalizeTileMinimizationMaps(tileMinimizationMap) {
    if (Array.isArray(tileMinimizationMap)) {
      if (tileMinimizationMap.length === 0) {
        throw new Error('optimize_first_25 requires at least one tile minimization map');
      }
      return tileMinimizationMap.slice();
    }
    return [tileMinimizationMap];
  }

  function getTileMinimizationMapForSegment(maps, segmentIndex) {
    var idx = segmentIndex < maps.length ? segmentIndex : maps.length - 1;
    return maps[idx];
  }

  function anyWhere(list, pred) {
    for (var i = 0; i < list.length; i++) if (pred(list[i])) return true;
    return false;
  }

  /* ==================================================================
   * CityExpansionPlan
   * ================================================================== */

  function CityExpansionPlan(tileCaptures, planPaths, launchTurn, coreTile) {
    this.core_tile = coreTile;
    this.tile_captures = tileCaptures;
    this.launch_turn = launchTurn;
    this.plan_paths = planPaths == null ? [] : planPaths;
    this.intended_deserts = new Set();
    for (var i = 0; i < this.plan_paths.length; i++) {
      var p = this.plan_paths[i];
      if (!p) continue;
      var list = p.tileList;
      for (var k = 0; k < list.length; k++) {
        if (list[k].isDesert) this.intended_deserts.add(list[k]);
      }
    }
  }

  /* ==================================================================
   * get_start_expand_captures
   *
   * 把「一串路径」按回合展开成一份行进日志，数出来到第 50 回合为止能吃到多少格。
   * 返回值是 len(alreadyVisited) + len(enCapped) * 1.2 —— 原版就是这么算的浮点值，
   * 所有评分的第一维都是它，所以必须一字节不差地照抄（包括那个 1.2）。
   * ================================================================== */
  function get_start_expand_captures(map, general, generalArmy, curTurn, expandPaths, alreadyOwned, launchTurn, noLog) {
    if (alreadyOwned === undefined) alreadyOwned = null;
    if (launchTurn === undefined) launchTurn = -1;
    if (noLog === undefined) noLog = false;

    if (!expandPaths || expandPaths.length === 0) return 0;

    var genPlayer = general.player();

    var alreadyVisited;
    if (alreadyOwned) {
      alreadyVisited = new Set(alreadyOwned);
    } else {
      alreadyVisited = new Set(tilesOfPlayer(map, genPlayer));
    }

    var numCapped = 0;
    var enCapped = new Set();

    var curGenArmy = generalArmy;
    var pathIdx = 0;
    var p = expandPaths[pathIdx];
    if (launchTurn !== -1) {
      while (p === null && pathIdx + 1 < expandPaths.length) {
        pathIdx += 1;
        p = expandPaths[pathIdx];
      }
      while (curTurn < launchTurn) {
        curTurn += 1;
        if ((curTurn & 1) === 0) curGenArmy += 1;
      }
    }

    var curMoves = null;
    if (p !== null) curMoves = p.get_move_list();

    var curMoveIdx = 0;
    var movingArmy = 0;

    var teamPlayers = teammatesNoSelf(map, genPlayer);

    var turn = curTurn;
    while (turn <= 50) {
      var movingGen = false;
      var pathComplete = false;
      if (curMoves === null) {
        pathIdx += 1;
        if (pathIdx >= expandPaths.length) break;
        pathComplete = true;
        movingArmy = 0;
      } else {
        var move = curMoves[curMoveIdx];
        if (!move) break;
        if (move.source === general) {
          movingArmy = curGenArmy;
          movingGen = true;
        } else if (move.dest.isGeneral && teamPlayers.indexOf(move.dest.player()) >= 0) {
          throw new Error('Pathed into another general....? ' + move);
        }

        curMoveIdx += 1;

        var nextTile = move.dest;
        var wasVisited = alreadyVisited.has(nextTile);
        alreadyVisited.add(nextTile);

        if (nextTile.isSwamp) {
          // 原版：落点回合是偶数要额外掉一兵（到达那回合本来就吃沼泽惩罚）
          if (turn % 2 === 0) movingArmy -= 1;
        } else if (wasVisited) {
          // 已经数过的格子不再计入
        } else if (nextTile.isDesert) {
          movingArmy -= 1;
        } else if (nextTile.player() === genPlayer) {
          movingArmy += nextTile.army;
          movingArmy -= 1;
        } else if (teamPlayers.indexOf(nextTile.player()) >= 0) {
          movingArmy += nextTile.army;
          movingArmy -= 1;
        } else {
          numCapped += 1;
          movingArmy -= nextTile.army + 1;
          if (nextTile.player() >= 0) enCapped.add(nextTile);
        }

        if (curMoveIdx >= curMoves.length) {
          pathIdx += 1;
          if (pathIdx >= expandPaths.length) break;
          pathComplete = true;
        }
      }

      if (pathComplete) {
        p = expandPaths[pathIdx];
        curMoves = null;
        if (p !== null) {
          curMoves = p.get_move_list();
          curMoveIdx = 0;
        }
      }

      if (movingGen) curGenArmy = 1;
      if ((turn & 1) === 1) curGenArmy += 1;

      turn += 1;
    }

    return alreadyVisited.size + enCapped.size * 1.2;
  }

  /* ==================================================================
   * __evaluate_plan_value
   *
   * 四元组：吃到多少格 / 视野与相邻空地收益 / 权重和的相反数 / 距离将军的总和。
   * 字典序比较，所以第一维相同才看后面几维。
   * ================================================================== */
  function evaluatePlanValue(map, general, generalArmy, curTurn, pathList, distToGenMap, tileWeightMap, alreadyOwned, launchTurn, noLog) {
    if (launchTurn === undefined) launchTurn = -1;
    if (noLog === undefined) noLog = false;

    var adjAvailable = 0;

    var planTileSet = new Set();
    var visibleTileSet = new Set(alreadyOwned);
    var it = alreadyOwned.values();
    var cur = it.next();
    while (!cur.done) {
      var adjs = cur.value.adjacents;
      for (var i = 0; i < adjs.length; i++) visibleTileSet.add(adjs[i]);
      cur = it.next();
    }

    for (var pi = 0; pi < pathList.length; pi++) {
      var path = pathList[pi];
      if (path === null || path === undefined) continue;
      var tl = path.tileList;
      for (var ti = 0; ti < tl.length; ti++) {
        visibleTileSet.add(tl[ti]);
        planTileSet.add(tl[ti]);
      }
    }

    var tileWeightSum = 0;
    var genDistSum = 0;
    var visibilityValue = 0.0;

    // 顺序敏感的求和：谁先被加进 visibleTileSet 会影响后面格子有多少「新视野」。
    // Python 是 set 的 hash 序（不可复现），这里统一 tile_index 升序，oracle 侧同样处理。
    var planTiles = Array.from(planTileSet);
    planTiles.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });

    for (var k = 0; k < planTiles.length; k++) {
      var tile = planTiles[k];
      tileWeightSum += matGet(tileWeightMap, tile);
      genDistSum += matGet(distToGenMap, tile);

      var tadj = tile.adjacents;
      for (var aj = 0; aj < tadj.length; aj++) {
        var adj = tadj[aj];
        if (!visibleTileSet.has(adj)) {
          visibleTileSet.add(adj);
          if (!adj.isObstacle) {
            // 原版这里的 8 是个魔法数（作者自己在注释里骂过），照抄
            var reward = 8 - matGet(tileWeightMap, adj);
            if (reward > 0) visibilityValue += reward;
          }
        }
      }
    }

    var countFunc = function (t) {
      if (
        !planTileSet.has(t) &&
        !alreadyOwned.has(t) &&
        !t.isNotPathable &&
        !t.isCity &&
        t.player() === -1 &&
        t.army === 0
      ) {
        adjAvailable += 1;
      }
    };

    EK.search.breadth_first_foreach_fast_no_neut_cities(map, Array.from(planTileSet), 3, countFunc);

    var pathValue = get_start_expand_captures(map, general, generalArmy, curTurn, pathList, alreadyOwned, launchTurn, noLog);

    return [pathValue, adjAvailable + Math.trunc(visibilityValue), 0 - tileWeightSum, genDistSum];
  }

  /* ==================================================================
   * recalculate_max_plan
   * ================================================================== */
  function recalculate_max_plan(plan1, plan2, map, distToGenMap, tileWeightMap, visited, noLog) {
    if (noLog === undefined) noLog = false;

    var launchVal1 = evaluatePlanValue(map, plan1.core_tile, plan1.core_tile.army, map.turn, plan1.plan_paths, distToGenMap, tileWeightMap, visited, -1, noLog);
    plan1.tile_captures = launchVal1[0];

    var launchVal2 = evaluatePlanValue(map, plan2.core_tile, plan2.core_tile.army, map.turn, plan2.plan_paths, distToGenMap, tileWeightMap, visited, -1, noLog);
    plan2.tile_captures = launchVal2[0];

    if (cmpTuple(launchVal1, launchVal2) >= 0) return plan1;
    return plan2;
  }

  /* ==================================================================
   * optimize_first_25
   * ================================================================== */
  function optimize_first_25(map, general, tileMinimizationMap, debugViewInfo, noRecurse, skipTiles, noLog, cutoffTime, pruneCutoff, cramped, shuffleLaunches) {
    if (debugViewInfo === undefined) debugViewInfo = null;
    if (noRecurse === undefined) noRecurse = false;
    if (skipTiles === undefined) skipTiles = null;
    if (noLog === undefined) noLog = !DEBUG_ASSERTS;
    if (cutoffTime === undefined) cutoffTime = null;
    if (pruneCutoff === undefined) pruneCutoff = -1;
    if (cramped === undefined) cramped = false;
    if (shuffleLaunches === undefined) shuffleLaunches = false;

    var distToGenMap = map.distance_mapper.get_tile_dist_matrix(general);
    var tileMinimizationMaps = normalizeTileMinimizationMaps(tileMinimizationMap);
    var evaluationTileMinimizationMap = tileMinimizationMaps[0];

    // 原版只把「城市 / 将军 / 只有 1 兵」的自家格子当已拥有 —— 目的是让规划器保留这些格子的兵。
    var alreadyOwned = new Set();
    var ownTiles = tilesOfPlayer(map, general.player());
    for (var oi = 0; oi < ownTiles.length; oi++) {
      var ot = ownTiles[oi];
      if (ot.isCity || ot.isGeneral || ot.army <= 1) alreadyOwned.add(ot);
    }

    var mapTurnAtStart = map.turn;
    var genArmyAtStart = general.army;

    var maxResultPaths = null;
    var maxVal = null;
    var maxTiles = pruneCutoff;

    if (pruneCutoff === -1) {
      if (map.turn > 13) {
        // 先跑一条「零浪费」的基线当底，避免后面所有候选都不如它
        var launchResult = _sub_optimize_remaining_cycle_expand_from_cities(map, general, general.army, distToGenMap, tileMinimizationMaps, map.turn, -20, maxTiles, null, alreadyOwned, skipTiles, false, false, debugViewInfo, false, false, 0, noLog);
        var launchVal = evaluatePlanValue(map, general, genArmyAtStart, map.turn, launchResult, distToGenMap, evaluationTileMinimizationMap, alreadyOwned, -1, noLog);
        maxVal = launchVal;
        maxResultPaths = launchResult;
        maxTiles = launchVal[0];
      } else {
        pruneCutoff = 16;
      }
    }

    var combinationsWithMaxOptimal;
    if (cramped) {
      // 空间被挤住时将军能攒到更高兵数，配置表随之变化
      combinationsWithMaxOptimal = [
        null,
        [11, 8],
        [10, 10],
        [13, 2],
        null,
        null,
        [8, 10],
        null,
        [7, 14],
        null,
        null,
        [9, 10],
        [14, 0],
        [15, 0],
      ];
    } else {
      // [出发时将军兵数, 允许浪费步数]
      combinationsWithMaxOptimal = [
        [13, 2],
        [11, 6],
        [10, 8],
        null,
        [9, 10],
        [12, 4],
        [14, 0],
      ];
    }

    if (shuffleLaunches) shuffleInPlace(combinationsWithMaxOptimal);

    // 已经拥有多格（兵力充足 / 中期）时改用「非预先编排」的浪费步数
    if (alreadyOwned.size > 1) {
      return optimize_city_expand(alreadyOwned, cutoffTime, debugViewInfo, distToGenMap, genArmyAtStart, general, map, mapTurnAtStart, noLog, pruneCutoff, shuffleLaunches, skipTiles, tileMinimizationMaps);
    }

    // 原版这里按 cutoff_time 切时间片；本移植不要时间预算，perCutoff 恒为「现在」= 之后所有比较都为假
    var startTime = nowSeconds();

    var i = 0;
    for (var ci = 0; ci < combinationsWithMaxOptimal.length; ci++) {
      var comboTuple = combinationsWithMaxOptimal[ci];
      i += 1;
      if (comboTuple === null) continue;
      var genArmy = comboTuple[0];
      var optimalWastedMoves = comboTuple[1];
      var launchTurn = (genArmy - 1) * 2;
      var perCutoff = startTime;

      if (mapTurnAtStart > launchTurn) continue;

      var launchResult2 = _sub_optimize_remaining_cycle_expand_from_cities(
        map,
        general,
        genArmy,
        distToGenMap,
        tileMinimizationMaps,
        launchTurn,
        optimalWastedMoves + 3,
        maxTiles,
        perCutoff,
        alreadyOwned,
        skipTiles,
        false,
        false,
        debugViewInfo,
        true, // 原版注释：required to pass test_can_attempt_backwards_initial_paths_for_higher_land_count
        false,
        0,
        noLog
      );
      for (var w = mapTurnAtStart; w < launchTurn; w++) launchResult2.unshift(null);
      var launchVal2 = evaluatePlanValue(map, general, genArmyAtStart, map.turn, launchResult2, distToGenMap, evaluationTileMinimizationMap, alreadyOwned, -1, noLog);
      if (maxVal === null || cmpTuple(launchVal2, maxVal) > 0) {
        maxVal = launchVal2;
        maxResultPaths = launchResult2;
        maxTiles = launchVal2[0];
        if (genArmy <= 8) {
          // 更晚的候选出发兵数只会更小，提前收
          break;
        }
      }
    }

    var launchTurnOut = mapTurnAtStart;
    maxTiles = 0;
    if (maxResultPaths !== null && !anyWhere(maxResultPaths, function (pt) { return pt !== null; })) {
      maxResultPaths = [];
      maxVal = EMPTY_COMBINATION;
    }
    if (maxResultPaths !== null) {
      for (var li = 0; li < maxResultPaths.length; li++) {
        if (maxResultPaths[li] !== null) break;
        launchTurnOut += 1;
      }
      maxTiles = maxVal[0];
    }

    // 原版在 return 前做一致性断言：评分第一维必须等于重新展开得到的值。
    var val = get_start_expand_captures(map, general, general.army, mapTurnAtStart, maxResultPaths, alreadyOwned, -1, false);
    if (val !== maxTiles) {
      throw new Error('maxTiles ' + maxTiles + ' did not match expand val ' + val);
    }

    return new CityExpansionPlan(maxTiles, maxResultPaths, launchTurnOut, general);
  }

  /* ==================================================================
   * optimize_city_expand（已拥有多格时的分支）
   * ================================================================== */
  function optimize_city_expand(alreadyOwned, cutoffTime, debugViewInfo, distToGenMap, genArmyAtStart, general, map, mapTurnAtStart, noLog, pruneCutoff, shuffleLaunches, skipTiles, tileMinimizationMaps) {
    var turnInCycle = mapTurnAtStart % 50;
    var turnsLeft = 50 - turnInCycle;
    var allowWasted = 3;
    var tileCount = tilesOfPlayer(map, general.player()).length;
    if (map.turn < 50) {
      var capsLeftForPerfect = 25 - tileCount;
      allowWasted = turnsLeft - capsLeftForPerfect;
    } else {
      var totalGenArmy = general.army + floorDiv(turnsLeft, 2);
      var capsLeftForPerfect2 = totalGenArmy;
      allowWasted = Math.max(3, turnsLeft - capsLeftForPerfect2);
    }
    var result = _sub_optimize_remaining_cycle_expand_from_cities(
      map,
      general,
      genArmyAtStart,
      distToGenMap,
      tileMinimizationMaps,
      turnInCycle,
      allowWasted,
      pruneCutoff,
      cutoffTime,
      alreadyOwned,
      skipTiles,
      shuffleLaunches,
      true, // dont_force_first
      debugViewInfo,
      true, // try_bi_directional_first_launch
      false,
      0,
      noLog
    );
    var val = get_start_expand_captures(map, general, genArmyAtStart, turnInCycle, result, alreadyOwned, -1, false);
    return new CityExpansionPlan(val, result, mapTurnAtStart, general);
  }

  /* ==================================================================
   * _sub_optimize_first_25_specific_wasted
   *
   * 一个 (将军兵数, 强制浪费步数) 组合的一次完整尝试：
   *   1. 先找第一段（从将军出发的那条线）_optimize_25_launch_segment；
   *   2. 再从落点继续递归（立即出发 / 等一回合 两种时机都试）；
   *   3. 等一回合如果更好，就在路径前补 None（None = 这一回合不动）。
   * ================================================================== */
  function _sub_optimize_first_25_specific_wasted(map, general, genArmy, distToGenMap, tileWeightMaps, turn, forceWastedMoves, allowWastedMoves, pruneBelow, visitedSet, cutoffTime, additionalOneLevelSkips, skipTiles, shuffleLaunches, dontForceFirst, debugViewInfo, tryRandomSkips, segmentIndex, noLog) {
    if (additionalOneLevelSkips === undefined) additionalOneLevelSkips = null;
    if (skipTiles === undefined) skipTiles = null;
    if (shuffleLaunches === undefined) shuffleLaunches = false;
    if (dontForceFirst === undefined) dontForceFirst = false;
    if (debugViewInfo === undefined) debugViewInfo = null;
    if (tryRandomSkips === undefined) tryRandomSkips = false;
    if (segmentIndex === undefined) segmentIndex = 0;
    if (noLog === undefined) noLog = !DEBUG_ASSERTS;

    var pathList = [];
    var curAttemptGenArmy = genArmy;

    var curTurn = turn;
    var capped = EMPTY_COMBINATION;

    if (IS_DEBUGGING) cutoffTime = nowSeconds() + 1000.0;

    if (nowSeconds() > cutoffTime) return [capped, pathList];

    visitedSet = new Set(visitedSet);

    if (!dontForceFirst) {
      if (curAttemptGenArmy <= 1) {
        throw new Error('Someone ran a sub_optimize_specific_wasted with gen army 1 lol');
      }

      var skipToUse = skipTiles;
      if (additionalOneLevelSkips) {
        if (skipTiles) {
          skipToUse = new Set(skipTiles);
          var sk = additionalOneLevelSkips.values();
          var skc = sk.next();
          while (!skc.done) {
            skipToUse.add(skc.value);
            skc = sk.next();
          }
        } else {
          skipToUse = additionalOneLevelSkips;
        }
      }

      var tileWeightMap = getTileMinimizationMapForSegment(tileWeightMaps, segmentIndex);
      var path1 = _optimize_25_launch_segment(map, general, curAttemptGenArmy, 50 - curTurn, distToGenMap, forceWastedMoves, tileWeightMap, visitedSet, skipToUse, debugViewInfo, false, noLog);

      if (path1 === null) {
        pathList.push(null);
        return [capped, pathList];
      }

      capped = evaluatePlanValue(map, general, curAttemptGenArmy, curTurn, [path1], distToGenMap, tileWeightMap, visitedSet, -1, noLog);

      if (capped[0] === 0) {
        pathList.push(null);
        return [capped, pathList];
      }

      pathList.push(path1);

      var p1tiles = path1.tileList;
      for (var ti = 0; ti < p1tiles.length; ti++) {
        var t = p1tiles[ti];
        if (visitedSet.has(t) && t !== general) {
          allowWastedMoves -= 1;
          // 打敌人格子要多花兵，于是原版反过来给一个「浪费预算」补偿
        } else if (t.player() >= 0 && t !== general) {
          allowWastedMoves += 1;
        }
        visitedSet.add(t);
      }

      curAttemptGenArmy = 1;
      for (var sl = 0; sl < path1.length; sl++) {
        curTurn += 1;
        if ((curTurn & 1) === 0) curAttemptGenArmy += 1;
      }
    }

    if (curTurn >= 50) return [capped, pathList];

    allowWastedMoves = Math.max(0, allowWastedMoves);

    // 立即出发
    var maxOptimized = _sub_optimize_remaining_cycle_expand_from_cities(map, general, curAttemptGenArmy, distToGenMap, tileWeightMaps, curTurn, allowWastedMoves, pruneBelow, cutoffTime, visitedSet, skipTiles, shuffleLaunches, false, debugViewInfo, false, tryRandomSkips, segmentIndex + 1, noLog);
    var maxValue = evaluatePlanValue(map, general, curAttemptGenArmy, curTurn, maxOptimized, distToGenMap, getTileMinimizationMapForSegment(tileWeightMaps, segmentIndex), visitedSet, -1, noLog);

    var isSuboptimalLaunchTurn = (curTurn & 1) === 1;
    // 奇数回合出发会少拿一次将军增兵，原则上该等到偶数回合；这里两种时机都试
    if (curTurn <= 47) {
      curAttemptGenArmy += 1;
      curTurn += 1;
      allowWastedMoves -= 1;
      if (!isSuboptimalLaunchTurn) {
        curTurn += 1;
        allowWastedMoves -= 1;
      }
      var withOneWait = _sub_optimize_remaining_cycle_expand_from_cities(map, general, curAttemptGenArmy, distToGenMap, tileWeightMaps, curTurn, allowWastedMoves, Math.max(maxValue[0], pruneBelow), cutoffTime, visitedSet, skipTiles, shuffleLaunches, false, debugViewInfo, false, false, segmentIndex + 1, noLog);
      var oneWaitVal = evaluatePlanValue(map, general, curAttemptGenArmy, curTurn, withOneWait, distToGenMap, getTileMinimizationMapForSegment(tileWeightMaps, segmentIndex), visitedSet, -1, noLog);
      if (cmpTuple(oneWaitVal, maxValue) >= 0) {
        maxOptimized = withOneWait;
        maxValue = oneWaitVal;
        pathList.push(null);
        if (!isSuboptimalLaunchTurn) pathList.push(null);
      }
    }

    if (maxValue[0] === 0) return [maxValue, [null]];

    for (var mi = 0; mi < maxOptimized.length; mi++) pathList.push(maxOptimized[mi]);

    return [maxValue, pathList];
  }

  /* ==================================================================
   * _sub_optimize_remaining_cycle_expand_from_cities
   *
   * 穷举「这一轮剩余时间里允许浪费多少步」，每种浪费预算跑一次完整尝试，取评分最高的路径表。
   * forced 列表的构造顺序（先从 baseline 往上、再从下往上）会影响平局谁先入账，必须照抄。
   * ================================================================== */
  function _sub_optimize_remaining_cycle_expand_from_cities(map, general, genArmy, distToGenMap, tileWeightMaps, turn, maxAllowWastedMoves, pruneBelow, cutoffTime, visitedSet, skipTiles, shuffleLaunches, dontForceFirst, debugViewInfo, tryBiDirectionalFirstLaunch, tryRandomSkips, segmentIndex, noLog) {
    if (visitedSet === undefined) visitedSet = null;
    if (skipTiles === undefined) skipTiles = null;
    if (shuffleLaunches === undefined) shuffleLaunches = false;
    if (dontForceFirst === undefined) dontForceFirst = false;
    if (debugViewInfo === undefined) debugViewInfo = null;
    if (tryBiDirectionalFirstLaunch === undefined) tryBiDirectionalFirstLaunch = false;
    if (tryRandomSkips === undefined) tryRandomSkips = false;
    if (segmentIndex === undefined) segmentIndex = 0;
    if (noLog === undefined) noLog = !DEBUG_ASSERTS;

    tileWeightMaps = normalizeTileMinimizationMaps(tileWeightMaps);
    var maxCombinationValue = EMPTY_COMBINATION;
    var maxCombinationPathList = [null];
    if (visitedSet === null || visitedSet.size === 0) {
      visitedSet = new Set(tilesOfPlayer(map, general.player()));
    }

    if (skipTiles === null && ALLOW_RANDOM_SKIPS) skipTiles = new Set();

    turn = turn % 50;

    var allowWastedMoves = maxAllowWastedMoves;

    var skipMoveCount = 0;
    if (!dontForceFirst) {
      if (genArmy === 1) {
        // 兵只有 1 的话这一回合动不了，得先等一次增兵
        genArmy = 2;
        turn += 1;
        allowWastedMoves -= 1;
        skipMoveCount += 1;
        if ((turn & 1) === 1) {
          turn += 1;
          allowWastedMoves -= 1;
          skipMoveCount += 1;
        }
      }
    }
    var turnsLeft = 50 - turn;

    if (turnsLeft <= 0) return [];

    var minWastedMovesThisLaunch = Math.max(0, floorDiv(allowWastedMoves, 2) - 2);

    var maxForce = allowWastedMoves + 4;
    // 不许回头重走整条出发线，否则就是把已吃过的格子再数一遍
    var visitLen = visitedSet.size;
    if (visitLen > 6 && maxForce > visitLen - 1) maxForce = visitLen - 1;

    var forced = [];
    var baseline = Math.max(0, allowWastedMoves - 1);
    if (baseline > 5) baseline = 5;

    var curLess = baseline - 1;
    var curMore = baseline;
    while (true) {
      if (curMore < maxForce) {
        forced.push(curMore);
        curMore += 1;
      }
      if (curLess >= minWastedMovesThisLaunch) {
        forced.push(curLess);
        curLess -= 1;
      } else if (curMore >= maxForce) {
        break;
      }
    }

    var oldForced = forced;
    forced = [];

    for (var fi = 0; fi < oldForced.length; fi++) {
      var forceWasted0 = oldForced[fi];
      var bestCaseResult0 = visitedSet.size + turnsLeft - forceWasted0;
      if (bestCaseResult0 < pruneBelow) continue;
      forced.push(forceWasted0);
    }

    if (forced.length === 0) return maxCombinationPathList;

    if (shuffleLaunches) shuffleInPlace(forced);

    var nextStart = nowSeconds();
    var totalTime = cutoffTime - nextStart;
    var timeEach = totalTime / forced.length;
    var divisions = 1;

    if (tryBiDirectionalFirstLaunch) divisions += 1;
    if (ALLOW_RANDOM_SKIPS && tryRandomSkips) divisions += 1;

    var addlLevelsRandSkips = false;
    if (tryRandomSkips && turnsLeft > 20) addlLevelsRandSkips = true;

    timeEach = timeEach / divisions;
    timeEach *= Math.max(3, forced.length - 5);

    var reduc = totalTime / (forced.length * divisions + 4 * divisions);
    var minTimeEach = 0.003;

    for (var ii = 0; ii < forced.length; ii++) {
      var forceWastedMoves = forced[ii];
      var bestCaseResult = visitedSet.size + turnsLeft - forceWastedMoves;
      if (bestCaseResult < pruneBelow) continue;

      if (nowSeconds() > cutoffTime) break;

      var newCutoff = Math.min(cutoffTime, nextStart + timeEach);
      timeEach = Math.max(minTimeEach, timeEach - reduc);

      var res = _sub_optimize_first_25_specific_wasted(map, general, genArmy, distToGenMap, tileWeightMaps, turn, forceWastedMoves, allowWastedMoves, pruneBelow, visitedSet, newCutoff, null, skipTiles, shuffleLaunches, dontForceFirst, debugViewInfo, addlLevelsRandSkips, segmentIndex, noLog);
      var value = res[0];
      var pathList = res[1];

      if (cmpTuple(value, maxCombinationValue) > 0) {
        maxCombinationValue = value;
        maxCombinationPathList = pathList;
        pruneBelow = Math.max(pruneBelow, value[0]);
      }

      nextStart = nowSeconds();

      if (tryRandomSkips) {
        // 原版 ALLOW_RANDOM_SKIPS=False + 顶层从不传 try_random_skips=True，此分支跑不到
        if (pathList.length > 1) {
          var path = null;
          for (var pj = 0; pj < pathList.length; pj++) {
            if (pathList[pj] === null) continue;
            path = pathList[pj];
            break;
          }
          if (path !== null) {
            var pathLen = path.length;
            if (pathLen > 5) {
              newCutoff = Math.min(cutoffTime, nextStart + timeEach);
              timeEach = Math.max(minTimeEach, timeEach - reduc);
              var pickable = path.tileList.slice(1, Math.min(pathLen - 1, 6));
              // 原版 random.choice(path.tileList[1:min(pathLen-1,6)])
              var rch = theRng();
              var randomSkip = (rch && typeof rch.choice === 'function')
                ? rch.choice(pickable)
                : pickable[Math.floor(Math.random() * pickable.length)];
              var altSkip = new Set([randomSkip]);

              var altRes = _sub_optimize_first_25_specific_wasted(map, general, genArmy, distToGenMap, tileWeightMaps, turn, forceWastedMoves, allowWastedMoves, pruneBelow, visitedSet, newCutoff, altSkip, skipTiles, shuffleLaunches, dontForceFirst, debugViewInfo, addlLevelsRandSkips, segmentIndex, noLog);
              nextStart = nowSeconds();

              if (cmpTuple(altRes[0], maxCombinationValue) > 0) {
                maxCombinationValue = altRes[0];
                maxCombinationPathList = altRes[1];
                pruneBelow = Math.max(pruneBelow, altRes[0][0]);
              }
            }
          }
        }
      }

      if (tryBiDirectionalFirstLaunch) {
        // 用「第一段走过的格子全当跳过」再跑一次：试试从另一个方向切进去
        if (pathList.length > 1) {
          var path2 = null;
          for (var pk = 0; pk < pathList.length; pk++) {
            if (pathList[pk] === null) continue;
            path2 = pathList[pk];
            break;
          }
          if (path2 !== null) {
            var skips = path2.tileSet;

            newCutoff = Math.min(cutoffTime, nextStart + timeEach);
            timeEach = Math.max(minTimeEach, timeEach - reduc);

            var altRes2 = _sub_optimize_first_25_specific_wasted(map, general, genArmy, distToGenMap, tileWeightMaps, turn, forceWastedMoves, allowWastedMoves, pruneBelow, visitedSet, newCutoff, skips, skipTiles, shuffleLaunches, dontForceFirst, debugViewInfo, addlLevelsRandSkips, segmentIndex, noLog);
            nextStart = nowSeconds();

            if (cmpTuple(altRes2[0], maxCombinationValue) > 0) {
              maxCombinationValue = altRes2[0];
              maxCombinationPathList = altRes2[1];
              pruneBelow = Math.max(pruneBelow, altRes2[0][0]);
            }
          }
        }
      }
    }

    if (maxCombinationPathList.length > 0) {
      for (var sm = 0; sm < skipMoveCount; sm++) maxCombinationPathList.unshift(null);
    }

    return maxCombinationPathList;
  }

  /* ==================================================================
   * _optimize_25_launch_segment
   *
   * 一段的启发式最优先搜索。优先级对象是 10 元组（顺序必须与 prio_func 返回的一一对应）：
   *   [repeatAvoider, distToGen, negTileWeight, pathCappedNeg, -adjWeight, repeats, cappedAdj,
   *    maxGenDist, armyLeft, curForceWastedMoves]
   * 越小越先展开（HeapQueue 取最小），所以「先展开离将军远的」由 distToGen 这个位置实现。
   * 评分（value_func，越大越好）用其中的 pathCappedNeg / repeats / cappedAdj / distToGen / adjWeight。
   * ================================================================== */
  function _optimize_25_launch_segment(map, general, genArmy, turnsLeft, distanceToGenMap, forceWastedMoves, tileWeightMap, visitedSet, skipTiles, debugViewInfo, useGlobalVisitedSet, noLog) {
    if (skipTiles === undefined) skipTiles = null;
    if (debugViewInfo === undefined) debugViewInfo = null;
    if (useGlobalVisitedSet === undefined) useGlobalVisitedSet = false;
    if (noLog === undefined) noLog = !DEBUG_ASSERTS;

    var searchingPlayer = map.player_index;
    var friendlyPlayers = map.get_teammates(searchingPlayer) || [];

    // 中期允许更多重复（用来跨过自己的地追敌人），前期要省
    var repeatsCutoff = 0;
    if (map.turn > 50) repeatsCutoff = floorDiv(turnsLeft, 4);

    if (genArmy <= 1) return null;

    var searchCounter = 0;

    var valueFunc = function (currentTile, priorityObject, pathList) {
      var currentGenDist = priorityObject[1];
      var pathCappedNeg = priorityObject[3];
      var negAdjWeight = priorityObject[4];
      var repeats = priorityObject[5];
      var cappedAdj = priorityObject[6];
      var curForceWastedMoves = priorityObject[9];

      var tileValue = 0 - matGet(tileWeightMap, currentTile);
      var repeatsVal = 0 - Math.abs(repeats - curForceWastedMoves);

      // 整条路径全是重复格子，没有意义
      if (repeats === pathList.length - 1) return null;
      if (pathCappedNeg === 0) return null;
      if (visitedSet.has(currentTile)) return null;
      if (friendlyPlayers.indexOf(currentTile.player()) >= 0) return null;

      return [0 - pathCappedNeg, repeatsVal, 0 - cappedAdj, currentGenDist, tileValue - negAdjWeight / 3];
    };

    var adjCapableRewards = [-0.3, 0.0, 0.1, 0.2];

    var prioFunc = function (nextTile, currentPriorityObject, pathList) {
      var repeatAvoider = currentPriorityObject[0];
      var closerToEnemyNeg = currentPriorityObject[2];
      var pathCappedNeg = currentPriorityObject[3];
      var negAdjWeight = currentPriorityObject[4];
      var repeats = currentPriorityObject[5];
      var cappedAdj = currentPriorityObject[6];
      var maxGenDist = currentPriorityObject[7];
      var armyLeft = currentPriorityObject[8];
      var curForceWastedMoves = currentPriorityObject[9];

      if (nextTile.isGeneral) return null;

      var visited = visitedSet.has(nextTile);
      if (!visited) {
        if (nextTile.isSwamp) {
          pathCappedNeg += 1;
          armyLeft -= 1;
          repeats -= 1;
        } else if (nextTile.isDesert) {
          // 沙漠在 generals.io 里不存在，原版这里什么都不做
        } else if (nextTile.player() === -1) {
          pathCappedNeg -= 1;
        } else if (friendlyPlayers.indexOf(nextTile.player()) < 0) {
          pathCappedNeg -= 2.05;
          repeats -= 1;
          curForceWastedMoves -= 1;
          armyLeft -= nextTile.army;
        } else {
          armyLeft += nextTile.army;
          repeats += 1;
        }
        armyLeft -= 1;
      } else {
        repeats += 1;
      }

      if (debugViewInfo) {
        searchCounter += 1;
        debugViewInfo.bottomLeftGridText.raw[nextTile.tile_index] = searchCounter;
      }

      closerToEnemyNeg = matGet(tileWeightMap, nextTile);

      // 重复步数离「允许浪费」越远越差，0 是最理想的
      repeatAvoider = Math.abs(curForceWastedMoves - repeats);
      if (nextTile.isSwamp) repeatAvoider += 4;
      if (nextTile.isDesert && !visited) repeatAvoider += 2;

      var distToGen = matGet(distanceToGenMap, nextTile);
      var adjWeight = 0 - negAdjWeight;

      if (1 < distToGen && distToGen < 5 && pathList.length) {
        // 靠近将军时优先留出连片的空地，别把自己围死
        var adjAdjust = 0.0;
        var mov1 = nextTile.movable;
        var lastTile = pathList[pathList.length - 1][0];
        var prevTile = pathList.length >= 2 ? pathList[pathList.length - 2][0] : null;
        for (var m1 = 0; m1 < mov1.length; m1++) {
          var t1 = mov1[m1];
          if (t1.isObstacle || t1.player() !== -1 || visitedSet.has(t1) || t1 === lastTile || t1 === prevTile || (t1.isGeneral && t1.tile_index !== general.tile_index)) continue;
          var adjCapable = 0;
          var mov2 = t1.movable;
          for (var m2 = 0; m2 < mov2.length; m2++) {
            var t2 = mov2[m2];
            if (t2.isObstacle || t2.player() !== -1 || visitedSet.has(t2) || t2 === nextTile || t2 === lastTile || t2 === prevTile || (t2.isGeneral && t2.tile_index !== general.tile_index)) continue;
            adjCapable += 1;
          }
          adjAdjust += adjCapableRewards[adjCapable];
        }
        adjWeight += adjAdjust;
        repeatAvoider -= adjAdjust;
      }

      if (armyLeft > 4) {
        var mov3 = nextTile.movable;
        for (var m3 = 0; m3 < mov3.length; m3++) {
          var t3 = mov3[m3];
          var valid = !visitedSet.has(t3) && t3.player() === -1 && !t3.isNotPathable && !t3.isCity;
          if (valid && matGet(distanceToGenMap, t3) >= distToGen) adjWeight += 1;
          if (valid && matGet(distanceToGenMap, t3) > distToGen) adjWeight += 1;
        }
      }

      if (distToGen < 4 && !visited && !useGlobalVisitedSet) {
        cappedAdj += 1;
        repeatAvoider += 1;
      }

      if (debugViewInfo) debugViewInfo.midRightGridText.raw[nextTile.tile_index] = adjWeight;

      maxGenDist = Math.max(maxGenDist, distToGen);

      return [repeatAvoider, distToGen, closerToEnemyNeg, pathCappedNeg, 0 - adjWeight, repeats, cappedAdj, maxGenDist, armyLeft, curForceWastedMoves];
    };

    var countSearchedAroundGen = 0;
    var loopingGeneralSearchCutoff = 500;

    var skipFunc = function (nextTile, currentPriorityObject, pathList) {
      var genDist = currentPriorityObject[1];
      var repeats = currentPriorityObject[5];
      var maxGenDist = currentPriorityObject[7];
      var armyLeft = currentPriorityObject[8];
      var curForceWastedMoves = currentPriorityObject[9];

      if (skipTiles !== null && skipTiles.has(nextTile)) return true;

      if (repeats - curForceWastedMoves > repeatsCutoff) return true;

      if (maxGenDist > genDist) {
        countSearchedAroundGen += 1;
        if (maxGenDist > 5) return true;
        if (countSearchedAroundGen > loopingGeneralSearchCutoff) return true;
      }

      for (var i = pathList.length - 1; i >= 0; i--) {
        if (nextTile === pathList[i][0]) return true;
      }

      return armyLeft <= 0;
    };

    var startVals = new Map();
    startVals.set(general, [[0, 0, -1000, 0, 0, 0, 0, 0, genArmy, forceWastedMoves], 0]);

    return bfsDynamicMaxIncludePath(map, startVals, valueFunc, {
      priorityFunc: prioFunc,
      skipFunc: skipFunc,
      maxTurns: turnsLeft,
      maxDepth: 100,
      noNeutralCities: true,
      searchingPlayer: searchingPlayer,
      includePath: true,
    });
  }

  /* ==================================================================
   * breadth_first_dynamic_max 的「带 nodeList」旧变体
   *
   * 原版 SearchUtils.breadth_first_dynamic_max 在 useGlobalVisitedSet=False 时走的是
   * 复制 nodeList 的那一版（本仓 search.js 只移植了 global-visited 版，注释里把它当死代码，
   * 但 EarlyExpandUtils 恰恰用的是旧版），所以在这里重写一份，逐行照 Python 1312-1496。
   * 与 global-visited 版的关键差别：
   *   - 不做全局去重（同一个格子可以经不同路径反复展开），靠 skipFunc 里的「路径内不回头」兜住；
   *   - valueFunc / priorityFunc / skipFunc 第三个参数是**当前路径**（nodeList），
   *     评分要按路径长度算「重复步数」，不给路径这段就没法移植；
   *   - 截断用 len(nodeList) > maxTurns（路径长度），不是深度；
   *   - 最终 Path 是从 maxList 全量重建，不是回溯 parent。
   * ================================================================== */
  function bfsDynamicMaxIncludePath(map, startVals, valueFunc, opts) {
    opts = opts || {};
    var maxTurns = opts.maxTurns === undefined ? 100 : opts.maxTurns;
    var maxDepth = opts.maxDepth === undefined ? 100 : opts.maxDepth;
    var noNeutralCities = !!opts.noNeutralCities;
    var noNeutralUndiscoveredObstacles = opts.noNeutralUndiscoveredObstacles === undefined ? true : !!opts.noNeutralUndiscoveredObstacles;
    var skipTiles = opts.skipTiles || null;
    var searchingPlayer = opts.searchingPlayer === undefined ? map.player_index : opts.searchingPlayer;
    var priorityFunc = opts.priorityFunc;
    var skipFunc = opts.skipFunc || null;
    var includePath = !!opts.includePath;
    var negativeTiles = opts.negativeTiles || new Set();
    var ignoreNonPlayerArmy = !!opts.ignoreNonPlayerArmy;
    var ignoreIncrement = opts.ignoreIncrement === undefined ? true : !!opts.ignoreIncrement;
    var incrementBackward = !!opts.incrementBackward;

    var frontier = new PyHeap();

    var keys = Array.from(startVals.keys());
    for (var ki = 0; ki < keys.length; ki++) {
      var tile = keys[ki];
      var sv = startVals.get(tile);
      var startPriorityObject = sv[0];
      var distance = sv[1];
      var startVal = startPriorityObject;
      frontier.put([startVal, distance, tile, null, [[tile, startVal]]]);
    }

    var foundDist = 1000;
    var maxValue = null;
    var maxPrio = null;
    var maxList = null;

    while (frontier.size > 0) {
      var node = frontier.get();
      var prioVals = node[0];
      var dist = node[1];
      var current = node[2];
      var parent = node[3];
      var nodeList = node[4];

      if (skipTiles && skipTiles.has(current)) continue;

      var newValue = includePath ? valueFunc(current, prioVals, nodeList) : valueFunc(current, prioVals);
      if (newValue !== null && newValue !== undefined) {
        if (maxValue === null || cmpTuple(newValue, maxValue) > 0) {
          foundDist = dist;
          maxValue = newValue;
          maxPrio = prioVals;
          maxList = nodeList;
        }
      }

      if (dist >= maxDepth || nodeList.length > maxTurns) continue;
      dist += 1;

      var movables = current.movable;
      for (var mi = 0; mi < movables.length; mi++) {
        var next = movables[mi];
        if (next === parent) continue;
        if (next.isMountain || (noNeutralCities && next.isCostlyNeutral) || (next.isUndiscoveredObstacle && noNeutralUndiscoveredObstacles)) continue;

        var nextVal = includePath ? priorityFunc(next, prioVals, nodeList) : priorityFunc(next, prioVals);
        if (nextVal === null || nextVal === undefined) continue;

        if (skipFunc && skipFunc(next, nextVal, nodeList)) continue;

        var newNodeList = nodeList.slice();
        newNodeList.push([next, nextVal]);
        frontier.put([nextVal, dist, next, current, newNodeList]);
      }
    }

    if (foundDist >= 1000 || maxList === null) return null;

    var Path = EK.Path;
    var pathObject = new Path();
    for (var li = 0; li < maxList.length; li++) {
      var entry = maxList[li];
      if (entry[0] !== null && entry[0] !== undefined) pathObject.add_next(entry[0]);
    }

    pathObject.calculate_value(searchingPlayer, map.team_ids_by_player_index, negativeTiles, ignoreNonPlayerArmy, ignoreIncrement, incrementBackward, false);

    if (pathObject.length === 0) return null;
    return pathObject;
  }

  /* ==================================================================
   * 时间：本移植不要时间预算，统一返回 0，等价于原版「时间永远够用」
   * ================================================================== */
  function nowSeconds() {
    return 0;
  }

  // 原版这里直接调模块级 random（random.shuffle / random.choice），对拍时靠
  // random.seed(0) 固定。所以默认必须走 EK.rng（MT19937 逐位复刻），
  // 否则 shuffle 出来的顺序和原版不同、扩张计划就分叉。
  var _rng = null;
  function theRng() {
    if (_rng) return _rng;
    return EK.rng || (EK.PyRandom ? new EK.PyRandom(0) : null);
  }

  function shuffleInPlace(arr) {
    var r = theRng();
    if (r && typeof r.shuffle === 'function') { r.shuffle(arr); return; }
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  /* ==================================================================
   * 导出
   * ================================================================== */

  var EarlyExpandUtils = {
    DEBUG_ASSERTS: DEBUG_ASSERTS,
    ALLOW_RANDOM_SKIPS: ALLOW_RANDOM_SKIPS,
    EMPTY_COMBINATION: EMPTY_COMBINATION,
    CityExpansionPlan: CityExpansionPlan,
    get_start_expand_captures: get_start_expand_captures,
    recalculate_max_plan: recalculate_max_plan,
    optimize_first_25: optimize_first_25,
    optimize_city_expand: optimize_city_expand,
    // 原版双下划线开头的私有名，这里保留同名（单下划线）方便 oracle 对齐
    _evaluate_plan_value: evaluatePlanValue,
    _sub_optimize_first_25_specific_wasted: _sub_optimize_first_25_specific_wasted,
    _sub_optimize_remaining_cycle_expand_from_cities: _sub_optimize_remaining_cycle_expand_from_cities,
    _optimize_25_launch_segment: _optimize_25_launch_segment,
    _bfs_dynamic_max_include_path: bfsDynamicMaxIncludePath,
    _normalize_tile_minimization_maps: normalizeTileMinimizationMaps,
    _get_tile_minimization_map_for_segment: getTileMinimizationMapForSegment,
    _set_rng: function (fn) {
      _rng = fn;
    },
  };

  EK.EarlyExpandUtils = EarlyExpandUtils;

  /* ==================================================================
   * 未移植（原版 1309–2543 行，全仓无生产调用者）
   *
   *   _sub_optimize_first_25_specific_wasted__reverse / _sub_optimize_remaining_cycle_expand_from_cities__reverse /
   *   _optimize_25_launch_segment__reverse / _optimize_25_launch_segments_by_tile_by_dist__reverse /
   *   _get_reverse_prio_funcs —— TODO REVERSE 实验族，只互相调用；
   *   optimize_first_25__start_end_precalc —— 无调用者；
   *   build_liberty_plan_recurse / build_expansion_plan_mst_iterative / _build_mst_plan_recurse /
   *   build_initial_mst_gather_root —— 只被注释掉的 unit test 调用。
   *
   * 影响：没有。bot 的生产路径（BotModules/BotExpansionOps.py:142/179/166/187）只碰
   * optimize_first_25 / get_start_expand_captures / recalculate_max_plan 三个入口。
   * ================================================================== */

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

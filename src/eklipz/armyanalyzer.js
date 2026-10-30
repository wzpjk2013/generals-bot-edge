/*
 * ArmyAnalyzer —— 移植自 generals-bot/ArmyAnalyzer.py（396 行）。
 *
 * 作用：给定两支军队/两个格子 A、B，算出
 *   - pathWays：A 到 B 之间每一条「最短路等值带」（aMap + bMap == distance 的连通块）；
 *   - chokeWidths：走过某格时，这副棋盘上还有几个相邻格同样可能是部队所在 =>
 *     窄口（choke）宽度，等于「绕路去另一头要多花几步」；
 *   - interceptChokes / interceptDistances / interceptTurns：对方部队走这条路时，
 *     我从这里拦截「最坏情况下要多走几步」以及「必须在第几回合到」。
 *
 * 这三个矩阵是 BotDefense / ArmyInterceptor / DangerAnalyzer 做防守决策的全部依据，
 * 所以语义必须逐格对得上：PathWay 的归属是由 scan 顺序决定的（谁的 distance 小谁先占），
 * 除了 distance 之外不参与任何比较。
 *
 * 与 Python 的差异（都为等价）：
 *   - itertools.chain / dict 迭代换成显式数组，chokeCounterMap 用 Map（key 是 "a,b" 字符串）；
 *   - logbook 日志与计时统计去掉，只留 NumAnalysisBuilt 之类的静态计数；
 *   - tile.player() 是方法，赋值走 setPlayer。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // TILE_OBSTACLE 是 -4（迷雾障碍），不是 -2（山）。抄错这一位会把迷雾障碍
  // 当成可递归的普通格子，pathway 会多吞 42 格。
  var TILE_OBSTACLE = EK.Tile ? EK.Tile.TILE_OBSTACLE : -4;

  function PathWay(distance) {
    this.distance = distance;
    this.tiles = new Set();
    this.seed_tile = null;
  }
  PathWay.prototype.add_tile = function (tile) {
    this.tiles.add(tile);
  };

  var INF_PATH_WAY = new PathWay(1000);

  function ArmyAnalyzer(map, armyA, armyB, bypassRetraverseThreshold, bypassRetraverseThresholdPathTiles, maxDist, opts) {
    if (bypassRetraverseThreshold === undefined) bypassRetraverseThreshold = -1;
    if (maxDist === undefined) maxDist = 100;
    // scanOrder 只给 oracle 用：原版 pathable_tiles 是 Python set，迭代顺序由哈希桶决定，
    // 等距格子谁先占 pathway 会因此不同。实战不传这个，走插入序。
    this.scanOrder = opts && opts.scanOrder ? opts.scanOrder : null;
    this.map = map;
    // Army 或 Tile 都吃；Army 认 .tile。
    this.tileA = armyA && armyA.tile !== undefined && typeof armyA.tile === 'object' ? armyA.tile : armyA;
    this.tileB = armyB && armyB.tile !== undefined && typeof armyB.tile === 'object' ? armyB.tile : armyB;

    this.pathWayLookupMatrix = new EK.MapMatrix(map, null);
    this.pathWays = [];
    this.shortestPathWay = INF_PATH_WAY;
    this.chokeWidths = new EK.MapMatrix(map, null);
    this.interceptChokes = new EK.MapMatrix(map, null);
    this.interceptTurns = new EK.MapMatrix(map, null);
    this.interceptDistances = new EK.MapMatrix(map, null);
    this.tileDistancesLookup = {};

    if (bypassRetraverseThreshold <= 0) {
      this.aMap = map.distance_mapper.get_tile_dist_matrix(this.tileA);
      this.bMap = map.distance_mapper.get_tile_dist_matrix(this.tileB);
    } else {
      var self = this;
      var skip = new Set();
      var mates = map.get_teammates(this.tileB.player());
      for (var mi = 0; mi < mates.length; mi++) {
        var pTiles = map.players[mates[mi]].tiles;
        for (var ti = 0; ti < pTiles.length; ti++) skip.add(pTiles[ti].tile_index);
      }
      if (bypassRetraverseThresholdPathTiles) {
        for (var pi = 0; pi < bypassRetraverseThresholdPathTiles.length; pi++) {
          skip.delete(bypassRetraverseThresholdPathTiles[pi].tile_index);
        }
      }
      var starts = [];
      var pathable = Array.from(map.pathable_tiles);
      for (var si = 0; si < pathable.length; si++) {
        var st = pathable[si];
        if (map.is_tile_on_team_with(st, self.tileA.player()) || st === self.tileB) starts.push(st);
      }
      EK.search.breadth_first_foreach_fast_no_neut_cities(
        map,
        starts,
        bypassRetraverseThreshold,
        function (tile) {
          skip.delete(tile.tile_index);
        }
      );
      // 原版传的是 tile 集合，JS 侧 skip 里存的是 tile_index，转回去。
      var skipTiles = new Set();
      skip.forEach(function (idx) {
        skipTiles.add(map.tiles_by_index[idx]);
      });
      this.aMap = EK.search.build_distance_map_matrix_with_skip(map, [this.tileA], skipTiles);
      this.bMap = EK.search.build_distance_map_matrix_with_skip(map, [this.tileB], skipTiles);
    }

    this.scan(maxDist);
    ArmyAnalyzer.NumAnalysisBuilt++;
  }

  ArmyAnalyzer.TimeSpentBuildingPathwaysChokeWidthsAndMinPath = 0;
  ArmyAnalyzer.TimeSpentBuildingInterceptChokes = 0;
  ArmyAnalyzer.TimeSpentInInit = 0;
  ArmyAnalyzer.NumAnalysisBuilt = 0;

  ArmyAnalyzer.prototype.scan = function (maxDist) {
    if (maxDist === undefined) maxDist = 100;
    this.build_chokes_and_pathways(maxDist);
    this.build_intercept_chokes();
  };

  ArmyAnalyzer.prototype.build_chokes_and_pathways = function (maxDist) {
    if (maxDist === undefined) maxDist = 100;
    var maxDistOffset = this.bMap.raw[this.tileA.tile_index] + maxDist;
    var chokeCounterMap = new Map();
    var self = this;

    var candidates;
    if (this.scanOrder) {
      candidates = [];
      for (var oi = 0; oi < this.scanOrder.length; oi++) candidates.push(this.map.tiles_by_index[this.scanOrder[oi]]);
    } else {
      // 原版是 `for tile in self.map.pathable_tiles`，而 pathable_tiles 是 Python set、
      // Tile.__hash__ == tile_index，所以实际迭代顺序就是 tile_index 升序。JS 的 Set
      // 是插入序，必须显式排序，否则迷雾边会漂（g5000 实测：乱序差 344~605 格，升序 0）。
      candidates = Array.from(this.map.pathable_tiles).sort(function (a, b) {
        return a.tile_index - b.tile_index;
      });
    }
    candidates.push(this.tileA);

    for (var ci = 0; ci < candidates.length; ci++) {
      var tile = candidates[ci];
      if (this.pathWayLookupMatrix.raw[tile.tile_index]) continue;

      var path = this.build_pathway(tile, maxDistOffset);
      if (path === INF_PATH_WAY) continue;
      this.pathWays.push(path);

      chokeCounterMap.clear();
      var pathTiles = Array.from(path.tiles);
      var i, pathTile, key;
      for (i = 0; i < pathTiles.length; i++) {
        pathTile = pathTiles[i];
        if (pathTile.isObstacle) continue;
        if (pathTile.isTempFogPrediction && pathTile.isCity && !pathTile.discovered) continue;
        key = this._get_choke_key(pathTile);
        chokeCounterMap.set(key, (chokeCounterMap.get(key) || 0) + 1);
      }
      // 必须两趟：choke key 不是格子唯一的，先把同批计数全部累加，再统一写宽度。
      for (i = 0; i < pathTiles.length; i++) {
        pathTile = pathTiles[i];
        if (pathTile.isObstacle) continue;
        if (pathTile.isTempFogPrediction && pathTile.isCity && !pathTile.discovered) continue;
        this.chokeWidths.raw[pathTile.tile_index] = chokeCounterMap.get(this._get_choke_key(pathTile));
      }
    }

    this.shortestPathWay = this.pathWayLookupMatrix.raw[this.tileA.tile_index];
    if (this.shortestPathWay === null || this.shortestPathWay === undefined) {
      throw new Error('ArmyAnalyzer: tileA 没有归属的 pathWay（' + this.tileA + '）');
    }
  };

  ArmyAnalyzer.prototype.build_pathway = function (tile, maxDist) {
    var distance = this.aMap.raw[tile.tile_index] + this.bMap.raw[tile.tile_index];
    if (distance > maxDist) {
      this.pathWayLookupMatrix.raw[tile.tile_index] = INF_PATH_WAY;
      return INF_PATH_WAY;
    }
    var path = new PathWay(distance);
    path.seed_tile = tile;
    this._build_pathway_recurse(path, tile);
    return path;
  };

  ArmyAnalyzer.prototype._build_pathway_recurse = function (path, currentTile) {
    if (this.pathWayLookupMatrix.raw[currentTile.tile_index]) return;
    if (this.aMap.raw[currentTile.tile_index] + this.bMap.raw[currentTile.tile_index] !== path.distance) return;

    path.tiles.add(currentTile);
    this.pathWayLookupMatrix.raw[currentTile.tile_index] = path;

    for (var i = 0; i < currentTile.movable.length; i++) {
      var adjacentTile = currentTile.movable[i];
      if (this.pathWayLookupMatrix.raw[adjacentTile.tile_index]) continue;
      if (
        adjacentTile.isMountain ||
        (adjacentTile.tile === TILE_OBSTACLE && !adjacentTile.discovered && !adjacentTile.isCity) ||
        (adjacentTile.isCity && adjacentTile.player() === -1)
      ) {
        continue;
      }
      this._build_pathway_recurse(path, adjacentTile);
    }
  };

  ArmyAnalyzer.prototype._get_choke_key = function (tile) {
    // key 里带上路径 (aDist,bDist)，等于强制同一 choke 必须属于同一条 pathway。
    return this.aMap.raw[tile.tile_index] + ',' + this.bMap.raw[tile.tile_index];
  };

  ArmyAnalyzer.prototype.build_intercept_chokes = function () {
    var q = [this.tileB];
    var distancesLookup = {};

    var visited = new Set();
    visited.add(this.tileB.tile_index);
    var pw = this.pathWayLookupMatrix.raw[this.tileA.tile_index];
    if (pw === null || pw === undefined) return;

    var shortestDist = pw.distance;

    while (q.length > 0) {
      var nextTile = q.shift();
      if (this.pathWayLookupMatrix.raw[nextTile.tile_index] !== pw) continue;

      var nextBDist = this.bMap.raw[nextTile.tile_index];
      pw = this.pathWayLookupMatrix.raw[nextTile.tile_index];

      var offsetDist = nextBDist + pw.distance - shortestDist;
      if (!distancesLookup[offsetDist]) distancesLookup[offsetDist] = [];
      distancesLookup[offsetDist].push(nextTile);

      for (var i = 0; i < nextTile.movable.length; i++) {
        var t = nextTile.movable[i];
        if (t.isObstacle) continue;
        if (visited.has(t.tile_index)) continue;
        visited.add(t.tile_index);
        var nPw = this.pathWayLookupMatrix.raw[t.tile_index];
        if (nPw === null || nPw === undefined) continue;
        if (nPw.distance >= pw.distance) q.push(t);
      }
    }

    var zeroChokes = [];
    var oneChokes = new Set();

    for (var r = 0; r <= this.shortestPathWay.distance; r++) {
      var curSet = distancesLookup[r];
      if (!curSet || curSet.length === 0) continue;
      if (curSet.length === 1) {
        zeroChokes.push(curSet[0]);
        continue;
      }
      if (curSet.length === 2) {
        var anyOne = false;
        var firstMovable = curSet[0].movable;
        var secondMovable = curSet[1].movable;
        for (var m = 0; m < firstMovable.length; m++) {
          var mt = firstMovable[m];
          if (mt.isObstacle) continue;
          if (secondMovable.indexOf(mt) >= 0) {
            oneChokes.add(mt);
            anyOne = true;
          }
        }
        if (anyOne) continue;
      }
    }

    this.tileDistancesLookup = distancesLookup;

    var shortestSet = this.shortestPathWay.tiles;
    var self = this;

    function foreachFunc(tile, stateObj) {
      var dist = stateObj[0];
      var interceptMoves = stateObj[1];
      self.interceptChokes.raw[tile.tile_index] = dist;
      self.interceptDistances.raw[tile.tile_index] = interceptMoves;
      // 允许把最短路旁边的格子也纳入，才能找到「一格之外的共同分叉拦截点」。
      if (!shortestSet.has(tile)) return null;
      return [dist + 1, interceptMoves + 1, tile];
    }

    var threatDist = this.shortestPathWay.distance;
    var startTiles = new Map();
    /* Tile -> [startDist, [prioStartDist, interceptMoves, fromTile]] */

    // oneChoke 必须先放，再被 zeroChoke 覆盖（同一格两者都成立时以 zeroChoke 为准）。
    oneChokes.forEach(function (oneChoke) {
      startTiles.set(oneChoke, [1, [1, 0, null]]);
    });

    var furthestZeroChoke = 0;
    for (var zi = 0; zi < zeroChokes.length; zi++) {
      var zeroChoke = zeroChokes[zi];
      if (zeroChoke !== this.tileA) {
        var zdist = this.bMap.raw[zeroChoke.tile_index];
        if (zdist > furthestZeroChoke) furthestZeroChoke = zdist;
      }
      // 通常我们比对手晚一回合到 zero choke 也能守住。
      var turn = -1;
      startTiles.set(zeroChoke, [turn, [turn, 0, null]]);
    }

    EK.search.breadth_first_foreach_with_state_and_start_dist(this.map, startTiles, 20, foreachFunc, null, true);

    for (var z2 = 0; z2 < zeroChokes.length; z2++) {
      var zc = zeroChokes[z2];
      if (zc.isGeneral) {
        // 必须比对手早一回合到将军格才算安全。
        this.interceptChokes.raw[zc.tile_index] = 1;
        for (var gm = 0; gm < zc.movable.length; gm++) {
          var gmt = zc.movable[gm];
          var existingVal = this.interceptChokes.raw[gmt.tile_index];
          if (existingVal !== null && existingVal !== undefined) {
            this.interceptChokes.raw[gmt.tile_index] = existingVal + 1;
          }
        }
      }
    }

    var icTiles = Array.from(this.map.pathable_tiles);
    for (var ii = 0; ii < icTiles.length; ii++) {
      var icTile = icTiles[ii];
      var chokeDist = this.interceptChokes.raw[icTile.tile_index];
      if (chokeDist === null || chokeDist === undefined) continue;
      var aDist = this.aMap.raw[icTile.tile_index];
      var bDist = this.bMap.raw[icTile.tile_index];
      var interceptTurns = threatDist - aDist + 1;
      if (bDist >= threatDist) {
        // 已经在自家将军后面了。
        interceptTurns -= bDist - threatDist + 1;
      }
      this.interceptTurns.raw[icTile.tile_index] = interceptTurns;
    }

    this.fix_choke_widths(this.shortestPathWay.tiles);
  };

  ArmyAnalyzer.prototype.fix_choke_widths = function (shortestTiles) {
    var self = this;

    function foreachFunc(tile, stateObj) {
      if (shortestTiles.has(tile)) return null;
      var prevCw = stateObj[0];
      var newCw = prevCw + 1;
      self.chokeWidths.raw[tile.tile_index] = newCw;
      return [newCw, 0];
    }

    var startTiles = new Map();
    shortestTiles.forEach(function (tile) {
      var ourDist = self.chokeWidths.raw[tile.tile_index];
      if (ourDist === null || ourDist === undefined) return;
      for (var i = 0; i < tile.movable.length; i++) {
        var adj = tile.movable[i];
        var existing = startTiles.get(adj);
        if (!existing || existing[0] > ourDist) startTiles.set(adj, [ourDist, [ourDist, 0]]);
      }
    });

    EK.search.breadth_first_foreach_with_state_and_start_dist(this.map, startTiles, 20, foreachFunc, null, true);
  };

  ArmyAnalyzer.prototype.is_choke = function (tile) {
    var chokeMoves = this.interceptDistances.raw[tile.tile_index];
    return chokeMoves !== null && chokeMoves !== undefined && chokeMoves === 0;
  };

  ArmyAnalyzer.prototype.is_one_behind_safe_choke = function (tile) {
    return this.interceptChokes.raw[tile.tile_index] === -1;
  };

  ArmyAnalyzer.prototype.is_two_move_capture_choke = function (tile) {
    var chokeMoves = this.interceptDistances.raw[tile.tile_index];
    return chokeMoves !== null && chokeMoves !== undefined && chokeMoves <= 2;
  };

  ArmyAnalyzer.build_from_path = function (map, path, bypassRetraverse, maxDist) {
    if (bypassRetraverse === undefined) bypassRetraverse = false;
    if (maxDist === undefined) maxDist = 10000;

    var tileA = path.tail.tile;
    var tileB = path.start.tile;
    if (path.length !== map.distance_mapper.get_distance_between(tileB, tileA)) {
      // 中点不是最短路的场景：把 A 挪到从 B 出发仍然沿最短路前进的最后一个节点。
      var i = 0;
      var node = path.start;
      var prev = null;
      while (node !== null && node !== undefined && map.distance_mapper.get_distance_between(tileB, node.tile) === i) {
        i += 1;
        prev = node;
        node = node.next;
      }
      tileA = prev.tile;
    }

    var bypassRetraverseThreshold = -1;
    var bypassPath = null;
    if (bypassRetraverse) {
      bypassRetraverseThreshold = 2;
      bypassPath = path.tileList;
    }

    return new ArmyAnalyzer(map, tileA, tileB, bypassRetraverseThreshold, bypassPath, maxDist);
  };

  EK.PathWay = PathWay;
  EK.INF_PATH_WAY = INF_PATH_WAY;
  EK.ArmyAnalyzer = ArmyAnalyzer;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

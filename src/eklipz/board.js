/*
 * BoardAnalyzer + DefensiveChokePoint —— 逐行移植自 generals-bot/BoardAnalyzer.py。
 *
 * 这个模块回答三个问题，整个 bot_ek0x45 的进攻/防守都建立在答案上：
 *   1. 我和对面将军之间的那块「板面」长什么样：两将军最短路上每一格离两边各几步、
 *      哪几格是咽喉（choke）、绕后（flank）能从哪儿切进去；
 *   2. 我方腹地里哪些格子是「内向单通道」（敌人只能从这一个口进来），
 *      据此给每个要守的格子算出一个防守站位（DefensiveChokePoint）；
 *   3. 城墙（中立城 / 山）被打穿以后，对谁更有利（wall breach score），
 *      用来判断「这一格该不该先占」。
 *
 * 顺序很要命：rebuild_intergeneral_analysis 先算出两将军距离场和 play area
 * 阈值，再 rescan_chokes —— 因为 chokes 里「离敌人最近的 3 座城」是拿
 * intergeneral_analysis.bMap 排的；反过来调就会用上一回合残余的旧分析。
 *
 * ArmyAnalyzer 单独在 src/eklipz/armyanalyzer.js（原版就是 ArmyAnalyzer.py 独立模块）。
 * 本文件只取别名（见文件内 `var ArmyAnalyzer = EK.ArmyAnalyzer`），不复制实现：
 * 两份实现必然各自漂，改一处忘了另一处就是无穷的暗 bug。那个模块已用逐格 oracle
 * 对齐 Python 原版（g1000b/g1000/g3000/g5000 共 330 回合 / 1320 个分析 / 0 差异），
 * 本文件去重后又复跑了 territory-diff g5000（5 个回合 board 矩阵全 0 差异）。
 *
 * 故意没搬：TileIslandBuilder 相关的可视化分支（原版 BoardAnalyzer 也没用）、
 * 所有 logbook 日志、ArmyAnalyzer.build_from_path（依赖 Path 的 build_from_path
 * 场景，BoardAnalyzer 用不到）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function MM(map, init) {
    return new EK.MapMatrix(map, init);
  }
  function MMS(map) {
    return new EK.MapMatrixSet(map);
  }
  function S() {
    return EK.search;
  }

  function teamId(map, p) {
    var arr = map.team_ids_by_player_index;
    var idx = p === null || p === undefined ? -1 : p;
    if (idx < 0) return arr[arr.length - 1];
    return arr[idx];
  }

  function isPlayerOnTeamWith(map, p1, p2) {
    return teamId(map, p1) === teamId(map, p2);
  }

  function isTileOnTeamWith(map, tile, player) {
    return teamId(map, tile.player()) === teamId(map, player);
  }

  /* ================================================================== *
   * ArmyAnalyzer（ArmyAnalyzer.py）—— 独立模块别名
   * ================================================================== */

  // 实现在 src/eklipz/armyanalyzer.js（逐格 oracle 已对齐 Python 原版：4 份 dump /
  // 1320 个分析 / 0 差异）。这里只取别名，别再复制一份实现，两份会各自漂。
  var ArmyAnalyzer = EK.ArmyAnalyzer;
  var PathWay = EK.PathWay;
  var INF_PATH_WAY = EK.INF_PATH_WAY;

  /* ================================================================== *
   * DefensiveChokePoint（BoardAnalyzer.py:24）
   * ================================================================== */

  function DefensiveChokePoint(defendedTile, x, y, distanceFromSource, chokeTiles) {
    this.defended_tile = defendedTile;
    this.x = x;
    this.y = y;
    this.distance_from_source = distanceFromSource;
    this.choke_tiles = chokeTiles;
  }

  /* ================================================================== *
   * BoardAnalyzer
   * ================================================================== */

  function BoardAnalyzer(map, general, teammateGeneral) {
    this.map = map;
    this.general = general;
    this.teammate_general = teammateGeneral === undefined ? null : teammateGeneral;
    this.should_rescan = true;

    // 只有一条向外通道的格子：往外走必须经过它
    this.innerChokes = MMS(map);
    // 只有一条向内通道的格子：敌人进来必须经过它
    this.outerChokes = MMS(map);

    this.central_defense_point = map.players[map.player_index].general;

    this.defensive_chokes_by_tile = new Map();
    this.defensive_furthest_choke_tiles_by_defensive_tile = new Map();

    this.friendly_city_distances = new Map();

    this.defense_centrality_sums = MM(map, 250);

    this.intergeneral_analysis = null;

    this.core_play_area_matrix = null;
    this.extended_play_area_matrix = null;
    this.shortest_path_distances = null;

    this.largest_player_tiles = [];
    this.furthest_large_ungathered_player_tiles = [];

    // 对面可能从这些迷雾格发起绕后
    this.flankable_fog_area_matrix = null;
    this.flank_danger_play_area_matrix = null;

    this.backwards_tiles = new Set();

    this.general_distances = MM(map, null);
    this.all_possible_enemy_spawns = new Set();
    this.friendly_general_distances = MM(map, null);
    this.teammate_distances = MM(map, null);

    this.inter_general_distance = 10;
    this.within_core_play_area_threshold = 1;
    this.within_extended_play_area_threshold = 2;
    this.within_flank_danger_play_area_threshold = 4;

    this.enemy_wall_breach_scores = MM(map, null);
    this.friendly_wall_breach_scores = MM(map, null);

    this.rescan_chokes();
  }

  BoardAnalyzer.prototype.rescan_chokes = function (cities_in_play) {
    var self = this;
    this.should_rescan = false;

    var oldInner = this.innerChokes;
    var oldOuter = this.outerChokes;
    void oldInner;
    void oldOuter;
    this.innerChokes = MMS(this.map);
    this.outerChokes = MMS(this.map);

    var cities = this.map.players[this.map.player_index].cities.slice();
    var i;

    this.general_distances = this.map.distance_mapper.get_tile_dist_matrix(this.general);

    if (this.teammate_general !== null && this.map.teammates.has(this.teammate_general.player())) {
      this.teammate_distances = this.map.distance_mapper.get_tile_dist_matrix(this.teammate_general);
      this.friendly_general_distances = S().build_distance_map_matrix(this.map, [this.teammate_general, this.general]);
      var mateCities = this.map.players[this.teammate_general.player()].cities;
      for (i = 0; i < mateCities.length; i++) cities.push(mateCities[i]);
    } else {
      this.friendly_general_distances = this.general_distances;
    }

    // 只保留我们自己 / 队友的城，敌城不能当「我方城距离」的源
    if (cities_in_play !== null && cities_in_play !== undefined) {
      var play = cities_in_play.forEach ? cities_in_play : new Set(cities_in_play);
      var friendlyCitiesInPlay = [];
      var selfGenPlayer = this.general.player();
      play.forEach(function (c) {
        if (c.player() === selfGenPlayer || (self.teammate_general !== null && c.player() === self.teammate_general.player()))
          friendlyCitiesInPlay.push(c);
      });
      if (friendlyCitiesInPlay.length > 0) cities = friendlyCitiesInPlay;
    }

    var closestCities = cities;
    if (this.intergeneral_analysis !== null) {
      // 只要离敌人最近的 3 座城：再远的城防守上没意义，还会白算距离场
      var bMap = this.intergeneral_analysis.bMap;
      closestCities = cities
        .slice()
        .sort(function (a, b) {
          return bMap.raw[a.tile_index] - bMap.raw[b.tile_index];
        })
        .slice(0, 3);
    }

    this.friendly_city_distances = new Map();
    for (i = 0; i < closestCities.length; i++) {
      var city = closestCities[i];
      this.friendly_city_distances.set(city, this.map.distance_mapper.get_tile_dist_matrix(city));
    }

    var pathable = [];
    this.map.pathable_tiles.forEach(function (t) {
      pathable.push(t);
    });
    for (i = 0; i < pathable.length; i++) {
      var tile = pathable[i];
      var tileDist = this.friendly_general_distances.raw[tile.tile_index];

      var movableInnerCount = 0;
      var movableOuterCount = 0;
      for (var m = 0; m < tile.movable.length; m++) {
        var adjDist = this.friendly_general_distances.raw[tile.movable[m].tile_index];
        if (tileDist === adjDist - 1) movableInnerCount++;
        if (tileDist === adjDist + 1) movableOuterCount++;
      }
      if (movableInnerCount === 1) this.outerChokes.raw[tile.tile_index] = true;
      // 看 movableInner 是为了别把死胡同当成 choke
      if (movableOuterCount === 1) this.innerChokes.raw[tile.tile_index] = true;
    }

    this._update_player_bulk_tile_tracking();
  };

  BoardAnalyzer.prototype._update_player_bulk_tile_tracking = function () {
    var player = this.map.players[this.map.player_index];
    var playerTiles = player.tiles.slice();
    playerTiles.sort(function (a, b) {
      return b.army - a.army;
    });

    var excludeTargetCount = 4 + player.cities.length;
    // 最厚的几堆是主纵队，不能当「可以抽调的散兵」
    var excluded = [];
    if (excludeTargetCount > 0 && playerTiles.length > 0) {
      if (playerTiles.length <= excludeTargetCount) {
        excluded = playerTiles;
      } else {
        var boundaryArmy = playerTiles[excludeTargetCount - 1].army;
        var nextArmy = playerTiles[excludeTargetCount].army;
        if (nextArmy === boundaryArmy) {
          excluded = playerTiles.filter(function (tile) {
            return tile.army > boundaryArmy;
          });
        } else {
          excluded = playerTiles.filter(function (tile) {
            return tile.army >= boundaryArmy;
          });
        }
      }
    }

    var excludedIdx = new Set();
    for (var e = 0; e < excluded.length; e++) excludedIdx.add(excluded[e].tile_index);
    var remaining = [];
    for (var i = 0; i < playerTiles.length; i++) {
      if (!excludedIdx.has(playerTiles[i].tile_index)) remaining.push(playerTiles[i]);
    }

    this.largest_player_tiles = excluded;

    if (remaining.length === 0 || this.extended_play_area_matrix === null) {
      this.furthest_large_ungathered_player_tiles = [];
      return;
    }

    var extendedPlayAreaTiles = [];
    var ext = this.extended_play_area_matrix;
    var pathable = [];
    this.map.pathable_tiles.forEach(function (t) {
      pathable.push(t);
    });
    for (var p = 0; p < pathable.length; p++) {
      if (ext.raw[pathable[p].tile_index]) extendedPlayAreaTiles.push(pathable[p]);
    }
    if (extendedPlayAreaTiles.length === 0) {
      this.furthest_large_ungathered_player_tiles = [];
      return;
    }

    var largestRemainingCount = Math.min(remaining.length, Math.max(10, Math.ceil(remaining.length * 0.2)));
    var largestRemaining = remaining.slice(0, largestRemainingCount);
    var playAreaDistances = S().build_distance_map_matrix(this.map, extendedPlayAreaTiles);
    var pd = playAreaDistances;
    this.furthest_large_ungathered_player_tiles = largestRemaining.slice().sort(function (a, b) {
      var ka = pd.raw[a.tile_index];
      var kb = pd.raw[b.tile_index];
      if (ka !== kb) return kb - ka;
      if (a.army !== b.army) return b.army - a.army;
      return b.tile_index - a.tile_index;
    });
  };

  BoardAnalyzer.prototype._get_defensive_choke_point = function (defendedTile) {
    if (this.intergeneral_analysis === null) {
      var chokePoint0 = new DefensiveChokePoint(defendedTile, defendedTile.x, defendedTile.y, 0, [defendedTile]);
      this.defensive_chokes_by_tile.set(defendedTile, chokePoint0);
      var set0 = new Set();
      set0.add(defendedTile);
      this.defensive_furthest_choke_tiles_by_defensive_tile.set(defendedTile, set0);
      return chokePoint0;
    }

    var enemyDistMap = this.intergeneral_analysis.bMap;
    var baseLength = enemyDistMap.raw[defendedTile.tile_index];
    var startTiles = this._get_defensive_choke_start_tiles(defendedTile, baseLength);
    var layers = this._build_defensive_choke_layers(startTiles, baseLength);

    // 从最远的一层往回找：最远的「全部可见且连通」的一层就是该守的线
    var bestDistance = 0;
    var bestLayer = [defendedTile];
    for (var distance = layers.length - 1; distance >= 0; distance--) {
      var layerTiles = layers[distance];
      var visible = this._are_tiles_visible(layerTiles);
      var contiguous = this._are_tiles_contiguous(layerTiles);
      if (visible && contiguous) {
        bestDistance = distance;
        bestLayer = layerTiles;
        break;
      }
    }

    var sumX = 0;
    var sumY = 0;
    for (var i = 0; i < bestLayer.length; i++) {
      sumX += bestLayer[i].x;
      sumY += bestLayer[i].y;
    }

    var chokePoint = new DefensiveChokePoint(defendedTile, sumX / bestLayer.length, sumY / bestLayer.length, bestDistance, bestLayer);
    this.defensive_chokes_by_tile.set(defendedTile, chokePoint);
    var bestSet = new Set();
    for (var b = 0; b < bestLayer.length; b++) bestSet.add(bestLayer[b]);
    this.defensive_furthest_choke_tiles_by_defensive_tile.set(defendedTile, bestSet);
    return chokePoint;
  };

  BoardAnalyzer.prototype._get_defensive_choke_start_tiles = function (defendedTile, baseLength) {
    var startTiles = [];
    var q = [[defendedTile, 0]];
    var visited = new Set();
    visited.add(defendedTile.tile_index);
    var enemyDistMap = this.intergeneral_analysis.bMap;

    var head = 0;
    while (head < q.length) {
      var entry = q[head++];
      var tile = entry[0];
      var dist = entry[1];
      if (dist > 2) continue;

      var enemyDist = enemyDistMap.raw[tile.tile_index];
      if (enemyDist >= baseLength && tile.visible && !tile.isObstacle) startTiles.push(tile);

      if (dist === 2) continue;
      for (var i = 0; i < tile.movable.length; i++) {
        var nextTile = tile.movable[i];
        if (visited.has(nextTile.tile_index)) continue;
        visited.add(nextTile.tile_index);
        q.push([nextTile, dist + 1]);
      }
    }

    if (startTiles.length === 0) startTiles.push(defendedTile);
    return startTiles;
  };

  BoardAnalyzer.prototype._build_defensive_choke_layers = function (startTiles, baseLength) {
    void baseLength;
    var q = [];
    var visited = new Set();
    for (var s = 0; s < startTiles.length; s++) {
      q.push([startTiles[s], 0]);
      visited.add(startTiles[s].tile_index);
    }
    var layers = [];
    var enemyDistMap = this.intergeneral_analysis.bMap;

    var head = 0;
    while (head < q.length) {
      var entry = q[head++];
      var tile = entry[0];
      var dist = entry[1];
      if (tile.isObstacle) continue;

      var enemyDist = enemyDistMap.raw[tile.tile_index];
      while (layers.length <= dist) layers.push([]);
      layers[dist].push(tile);
      if (!tile.visible) continue;

      for (var i = 0; i < tile.movable.length; i++) {
        var nextTile = tile.movable[i];
        if (visited.has(nextTile.tile_index)) continue;
        if (nextTile.isObstacle) continue;
        var nextEnemyDist = enemyDistMap.raw[nextTile.tile_index];
        // 只往「离敌人更近」的方向铺，也就是朝我方将军方向撤退的那条线
        if (nextEnemyDist > enemyDist) continue;
        visited.add(nextTile.tile_index);
        q.push([nextTile, dist + 1]);
      }
    }

    return layers;
  };

  BoardAnalyzer.prototype._are_tiles_visible = function (tiles) {
    for (var i = 0; i < tiles.length; i++) if (!tiles[i].visible) return false;
    return true;
  };

  BoardAnalyzer.prototype._are_tiles_contiguous = function (tiles) {
    if (tiles.length <= 1) return true;

    var tileIndexes = new Set();
    for (var i = 0; i < tiles.length; i++) tileIndexes.add(tiles[i].tile_index);
    var visited = new Set();
    visited.add(tiles[0].tile_index);
    var q = [tiles[0]];

    var head = 0;
    while (head < q.length) {
      var tile = q[head++];
      for (var m = 0; m < tile.movable.length; m++) {
        var nextTile = tile.movable[m];
        if (!tileIndexes.has(nextTile.tile_index)) continue;
        if (visited.has(nextTile.tile_index)) continue;
        visited.add(nextTile.tile_index);
        q.push(nextTile);
      }
    }

    return visited.size === tileIndexes.size;
  };

  BoardAnalyzer.prototype._get_distance_to_defensive_choke_point = function (tile, chokePoint) {
    return Math.abs(tile.x - chokePoint.x) + Math.abs(tile.y - chokePoint.y);
  };

  BoardAnalyzer.prototype.rebuild_intergeneral_analysis = function (opponentGeneral, possibleSpawns, cities_in_play) {
    this.intergeneral_analysis = new ArmyAnalyzer(this.map, this.general, opponentGeneral);

    this.enemy_wall_breach_scores = MM(this.map, null);
    this.friendly_wall_breach_scores = MM(this.map, null);
    var enemyDistMap = this.intergeneral_analysis.bMap;
    var generalDistMap = this.intergeneral_analysis.aMap;
    var general = this.general;

    this.inter_general_distance = enemyDistMap.raw[general.tile_index];

    if (possibleSpawns !== null && possibleSpawns !== undefined) this.rescan_useful_fog(possibleSpawns);

    this.within_core_play_area_threshold = Math.trunc((this.inter_general_distance + 1) * 1.1);
    this.within_extended_play_area_threshold = Math.trunc((this.inter_general_distance + 2) * 1.2);
    this.within_flank_danger_play_area_threshold = Math.trunc((this.inter_general_distance + 3) * 1.4);

    this.core_play_area_matrix = MMS(this.map);
    this.extended_play_area_matrix = MMS(this.map);
    this.flank_danger_play_area_matrix = MMS(this.map);

    this.build_play_area_matrices(enemyDistMap, generalDistMap);

    this.rescan_chokes(cities_in_play);
  };

  BoardAnalyzer.prototype.build_play_area_matrices = function (enemyDistMap, generalDistMap) {
    this.backwards_tiles = new Set();
    var shortestPathDist = this.intergeneral_analysis.shortestPathWay.distance;
    var friendlies = this.map.get_teammates(this.general.player());
    var i;

    if (this.intergeneral_analysis.shortestPathWay.tiles.size > 0) {
      this.shortest_path_distances = S().build_distance_map_matrix(
        this.map,
        Array.from(this.intergeneral_analysis.shortestPathWay.tiles)
      );
    } else {
      this.shortest_path_distances = S().build_distance_map_matrix(this.map, [this.general]);
    }

    var reachable = [];
    this.map.reachable_tiles.forEach(function (t) {
      reachable.push(t);
    });
    for (i = 0; i < reachable.length; i++) {
      var tile = reachable[i];
      var tIndex = tile.tile_index;

      // 中立城既是障碍也是可打穿的墙，单独给它一个「打穿以后谁更赚」的分数
      if (tile.isObstacle && !tile.isMountain) {
        this.enemy_wall_breach_scores.raw[tIndex] = this._get_wall_breach_score_enemy(tile);
        this.friendly_wall_breach_scores.raw[tIndex] = this._get_wall_breach_score_friendly(tile);
      }

      if (!tile.isPathable) continue;

      var enDist = enemyDistMap.raw[tIndex];
      var frDist = generalDistMap.raw[tIndex];
      var pathwayDist = enDist + frDist;

      if (pathwayDist < this.within_extended_play_area_threshold) this.extended_play_area_matrix.raw[tIndex] = true;
      if (pathwayDist < this.within_core_play_area_threshold) this.core_play_area_matrix.raw[tIndex] = true;

      if (
        pathwayDist <= this.within_flank_danger_play_area_threshold &&
        frDist / (enDist + 1) < 0.7 // 已经深入敌境的格子不算「我们可能被绕后」的区域
      ) {
        this.flank_danger_play_area_matrix.raw[tIndex] = true;
      }

      if (friendlies.indexOf(tile.player()) >= 0) {
        var trueShortest = this.shortest_path_distances.raw[tile.tile_index];
        var sumThing = enDist - shortestPathDist + trueShortest;
        if (sumThing > 0) this.backwards_tiles.add(tile);
      }
    }
  };

  BoardAnalyzer.prototype.get_flank_pathways = function (filterOutPlayers) {
    var flankDistToCheck = Math.trunc(this.intergeneral_analysis.shortestPathWay.distance * 1.5);
    var flankPathTiles = new Set();
    var pathWays = this.intergeneral_analysis.pathWays;
    for (var p = 0; p < pathWays.length; p++) {
      var pathway = pathWays[p];
      if (!(pathway.distance < flankDistToCheck && pathway.tiles.size >= this.intergeneral_analysis.shortestPathWay.distance))
        continue;
      var iter = pathway.tiles.values();
      var nx = iter.next();
      while (!nx.done) {
        var tile = nx.value;
        nx = iter.next();
        if (
          filterOutPlayers === null ||
          filterOutPlayers === undefined ||
          filterOutPlayers.indexOf(tile.player()) < 0
        ) {
          flankPathTiles.add(tile);
        }
      }
    }
    return flankPathTiles;
  };

  /*
   * leafMoves 里的每一步都当作「绕后的最后一跳」来筛：必须是沿着同一条或更短的
   * 通路朝对面将军走，而且不能太靠后（离对面将军不能比我们现在的位置还远一个
   * 四分之一路程以上）。minAltPathCount 原版只写在注释里、没有参与判定，这里
   * 保留参数但同样不参与，免得调用方以为它有效。
   */
  BoardAnalyzer.prototype.find_flank_leaves = function (leafMoves, minAltPathCount, maxAltLength) {
    void minAltPathCount;
    var goodLeaves = [];
    var analysis = this.intergeneral_analysis;
    var cutoffDist = Math.floor(analysis.shortestPathWay.distance / 4);

    for (var i = 0; i < leafMoves.length; i++) {
      var move = leafMoves[i];
      var neutralCity = move.dest.isCity && move.dest.player() === -1;
      var srcLookup = analysis.pathWayLookupMatrix.raw[move.source.tile_index];
      var destLookup = analysis.pathWayLookupMatrix.raw[move.dest.tile_index];
      if (neutralCity || srcLookup === null || srcLookup === undefined || destLookup === null || destLookup === undefined)
        continue;

      if (srcLookup.distance <= maxAltLength) {
        if (srcLookup.distance >= destLookup.distance) {
          // 走到更短的通路上，或沿着同距离通路横向走
          var gettingFurtherFromOurGen =
            analysis.aMap.raw[move.source.tile_index] < analysis.aMap.raw[move.dest.tile_index];
          var reasonablyCloseToTheirGeneral =
            analysis.bMap.raw[move.dest.tile_index] < cutoffDist + analysis.aMap.raw[analysis.tileB.tile_index];
          if (gettingFurtherFromOurGen && reasonablyCloseToTheirGeneral) goodLeaves.push(move);
        }
      }
    }

    return goodLeaves;
  };

  BoardAnalyzer.prototype.rescan_useful_fog = function (possibleSpawns) {
    var self = this;
    var map = this.map;
    this.flankable_fog_area_matrix = MM(map, false);

    var enPlayers = S().where(map.players, function (p) {
      return !isPlayerOnTeamWith(map, self.general.player(), p.index) && !p.dead;
    });

    var startTiles = new Set();
    var hasPerfectInfo = true;
    var i;
    for (i = 0; i < enPlayers.length; i++) {
      var p = enPlayers[i];
      if (S().count(p.cities, function (c) {
        return c.discovered;
      }) + 1 < p.cityCount) {
        hasPerfectInfo = false;
      }
    }
    var indexes = [];
    for (i = 0; i < enPlayers.length; i++) indexes.push(enPlayers[i].index);

    var reachable = [];
    map.reachable_tiles.forEach(function (t) {
      reachable.push(t);
    });
    for (i = 0; i < reachable.length; i++) {
      var t = reachable[i];
      if (t.visible) continue;
      for (var k = 0; k < indexes.length; k++) {
        var matrix = possibleSpawns[indexes[k]];
        if (matrix && matrix.raw[t.tile_index]) {
          startTiles.add(t);
          break;
        }
      }
    }

    this.all_possible_enemy_spawns = startTiles;
    var startList = Array.from(startTiles);
    // 离敌人将军很近的可见格没那么值得当成绕后跳板，按距离打折
    var Counter = S().Counter;
    var discountVisibleNearEnemyGen = new Counter(Math.trunc(this.inter_general_distance * 0.35));

    function foreachFunc(tile, dist) {
      var countsForFlankable = !tile.visible || dist < discountVisibleNearEnemyGen.value;
      if (hasPerfectInfo && tile.isObstacle) return true;
      if (!countsForFlankable) return true;
      if (tile.isMountain || (tile.isNeutral && tile.isCity && tile.visible)) return true;
      self.flankable_fog_area_matrix.raw[tile.tile_index] = true;
      return false;
    }

    S().breadth_first_foreach_dist_fast_no_default_skip(
      map,
      [this.intergeneral_analysis.tileB],
      Math.trunc(this.inter_general_distance * 1.4),
      foreachFunc
    );

    discountVisibleNearEnemyGen.value = 0;
    S().breadth_first_foreach_dist_fast_no_default_skip(map, startList, Math.trunc(this.inter_general_distance * 1.2), foreachFunc);
  };

  BoardAnalyzer.prototype.get_wall_breach_expandability = function (tile, asPlayer) {
    if (!tile.isObstacle) return 0;
    var enScore = this.enemy_wall_breach_scores.raw[tile.tile_index];
    var frScore = this.friendly_wall_breach_scores.raw[tile.tile_index];
    if (enScore === null || enScore === undefined || frScore === null || frScore === undefined) return 0;

    if (isTileOnTeamWith(this.map, this.intergeneral_analysis.tileB, asPlayer)) return enScore - frScore;
    else if (isTileOnTeamWith(this.map, this.intergeneral_analysis.tileA, asPlayer)) return frScore - enScore;
    return 0;
  };

  BoardAnalyzer.prototype._get_wall_breach_score_combined = function (tile) {
    return this._get_wall_breach_score_enemy(tile) + this._get_wall_breach_score_friendly(tile);
  };

  /* 从敌人视角看：打穿这格能省下多少距离（他们更乐意走的路） */
  BoardAnalyzer.prototype._get_wall_breach_score_enemy = function (tile) {
    var maxEnSavings = 0;
    for (var i = 0; i < tile.movable.length; i++) {
      var adj = tile.movable[i];
      if (adj.isObstacle) continue;
      for (var j = 0; j < tile.movable.length; j++) {
        var otherAdj = tile.movable[j];
        if (otherAdj.isObstacle) continue;
        if (otherAdj === adj) continue;
        var enDistA = this.intergeneral_analysis.bMap.raw[adj.tile_index];
        var enDistB = this.intergeneral_analysis.bMap.raw[otherAdj.tile_index];
        // -2：量到的两个邻格本来就相隔 2 步
        maxEnSavings = Math.max(maxEnSavings, Math.abs(enDistA - enDistB) - 2);
      }
    }
    return maxEnSavings;
  };

  /* 从我们视角看：打穿这格能省下多少距离（对手可能利用它偷袭我们将军） */
  BoardAnalyzer.prototype._get_wall_breach_score_friendly = function (tile) {
    var maxGenSavings = 0;
    for (var i = 0; i < tile.movable.length; i++) {
      var adj = tile.movable[i];
      if (adj.isObstacle) continue;
      for (var j = 0; j < tile.movable.length; j++) {
        var otherAdj = tile.movable[j];
        if (otherAdj.isObstacle) continue;
        if (otherAdj === adj) continue;
        var gDistA = this.intergeneral_analysis.aMap.raw[adj.tile_index];
        var gDistB = this.intergeneral_analysis.aMap.raw[otherAdj.tile_index];
        maxGenSavings = Math.max(maxGenSavings, Math.abs(gDistA - gDistB) - 2);
      }
    }
    return maxGenSavings;
  };

  EK.PathWay = PathWay;
  EK.ArmyAnalyzer = ArmyAnalyzer;
  EK.DefensiveChokePoint = DefensiveChokePoint;
  EK.BoardAnalyzer = BoardAnalyzer;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

/*
 * CityAnalyzer.py 的逐行移植：CityScoreData + CityAnalyzer。
 *
 * 依赖全部走 EK 上已有的基础设施：
 *   - map.js     : MapBase（turn / players / swamps / is_2v2 / team_ids / distance_mapper / is_tile_enemy）
 *   - tile.js    : Tile（player() 是方法，isNeutral / isCostlyNeutral / turn_captured 都是字段）
 *   - search.js  : breadth_first_foreach_dist / ..._fast_no_neut_cities / Counter
 *   - board.js   : BoardAnalyzer（intergeneral_analysis.aMap/bMap/shortestPathWay）
 *   - mapmatrix  : MapMatrix / MapMatrixSet
 * ArmyTracker 尚未交付，本文件不引用它（Python 原版也没用）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ==================================================================
   * 小工具
   * ================================================================== */

  // Python 的 team_ids_by_player_index 末尾额外挂了一个 -1（中立队伍的 team id），
  // 所以索引 -1 是合法访问；JS 数组不认负索引，这里还原 Python 的取法。
  function teamId(map, p) {
    var arr = map.team_ids_by_player_index;
    var idx = p === null || p === undefined ? -1 : p;
    if (idx < 0) return arr[arr.length - 1];
    return arr[idx];
  }

  function isPlayerOnTeamWith(map, player1, player2) {
    return teamId(map, player1) === teamId(map, player2);
  }

  function isTileOnTeamWith(map, tile, player) {
    return teamId(map, tile.player()) === teamId(map, player);
  }

  // Utils/ScaleUtils.py: rescale_value
  function rescaleValue(valToScale, valueMin, valueMax, newScaleMin, newScaleMax) {
    var leftSpan = valueMax - valueMin;
    var rightSpan = newScaleMax - newScaleMin;
    if (leftSpan === 0) leftSpan = 1;
    var valueScaled = (valToScale - valueMin) / leftSpan;
    return newScaleMin + valueScaled * rightSpan;
  }

  /*
   * heapq 的等价物，但比较规则按 Python 的 tuple 走：先 cost、再 trueDist、再 Tile。
   * Python 的 Tile.__lt__ 只比 army，且比较出平局时 heapq 不会报错（只是顺序不定），
   * 为了确定性这里再补 tile_index / throughTile 兜底。
   * 不直接用 EK.search.HeapQueue 是因为它把 Tile 一律按 tile_index 比较，和原版不同。
   */
  function ReachabilityHeap() {
    this.arr = [];
  }
  function heapCmp(a, b) {
    for (var i = 0; i < 2; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    if (a[2].army !== b[2].army) return a[2].army < b[2].army ? -1 : 1;
    if (a[2].tile_index !== b[2].tile_index) return a[2].tile_index < b[2].tile_index ? -1 : 1;
    var at = a[3] === null ? -1 : a[3].tile_index;
    var bt = b[3] === null ? -1 : b[3].tile_index;
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  }
  ReachabilityHeap.prototype.push = function (item) {
    var q = this.arr;
    q.push(item);
    var i = q.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (heapCmp(q[i], q[parent]) >= 0) break;
      var tmp = q[i];
      q[i] = q[parent];
      q[parent] = tmp;
      i = parent;
    }
  };
  ReachabilityHeap.prototype.pop = function () {
    var q = this.arr;
    var top = q[0];
    var last = q.pop();
    if (q.length > 0) {
      q[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1;
        var r = l + 1;
        var smallest = i;
        if (l < q.length && heapCmp(q[l], q[smallest]) < 0) smallest = l;
        if (r < q.length && heapCmp(q[r], q[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        var tmp = q[i];
        q[i] = q[smallest];
        q[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  };
  Object.defineProperty(ReachabilityHeap.prototype, 'size', {
    get: function () {
      return this.arr.length;
    }
  });

  /*
   * SearchUtils.build_reachability_cost_map_matrix 的移植。
   * 只有沼泽图 / 城墙城图会用它；1v1 普通图走 MapMatrix 空实现，所以这段逻辑
   * 在现有四个 dump 里从未被执行，靠代码审读对齐而不是靠 oracle。
   */
  function buildReachabilityCostMapMatrix(map, startTiles, maxDepth) {
    if (maxDepth === undefined) maxDepth = 1000;
    var costMap = new EK.MapMatrix(map, 10000);
    var throughMap = new EK.MapMatrix(map, null);

    // 真距离 / 当前格 / 通往它的“收费站”格（穿过的中立城或沼泽入口）
    var frontier = new EK.search.Deque();
    var nextFrontier = new ReachabilityHeap();
    var globalVisited = new Set();

    var i;
    for (i = 0; i < startTiles.length; i++) {
      var startTile = startTiles[i];
      nextFrontier.push([0, 0, startTile, null]);
      globalVisited.add(startTile.tile_index);
      costMap.raw[startTile.tile_index] = 0;
    }

    while (nextFrontier.size > 0) {
      var entry = nextFrontier.pop();
      var cost = entry[0];
      var startDist = entry[1];
      var throughCaptureTile = entry[3];

      frontier.append([startDist, entry[2], throughCaptureTile]);

      while (!frontier.empty) {
        var cur = frontier.popleft();
        var dist = cur[0];
        var current = cur[1];
        var throughTile = cur[2];

        if (dist > maxDepth) continue;

        var nextDist = dist + 1;
        var movable = current.movable;
        for (var m = 0; m < movable.length; m++) {
          var n = movable[m];
          if (globalVisited.has(n.tile_index)) continue;
          globalVisited.add(n.tile_index);

          costMap.raw[n.tile_index] = cost;
          throughMap.raw[n.tile_index] = throughTile;

          if (!n.isCostlyNeutral && n.isNotPathable) continue;

          if (n.isSwamp) {
            nextFrontier.push([cost + 1 + n.army, nextDist, n, throughTile]);
          } else if (n.player() === -1 && n.army > 0) {
            nextFrontier.push([cost + n.army, nextDist, n, n]);
          } else {
            frontier.appendleft([nextDist, n, throughTile]);
          }
        }
      }
    }

    return { throughMap: throughMap, costMap: costMap };
  }

  /* ==================================================================
   * CityScoreData
   * ================================================================== */

  var CITY_SCORE_FIELDS = [
    'city_expandability_score',
    'city_defensability_score',
    'city_general_defense_score',
    'city_relevance_score',
    'intergeneral_distance_differential',
    'general_distances_ratio',
    'general_distances_ratio_squared_capped',
    'friendly_city_nearby_score',
    'enemy_city_nearby_score',
    'neutral_city_nearby_score',
    'neighboring_city_relevance',
    'distance_from_player_general',
    'distance_from_enemy_general',
    'intergeneral_distance_through_city'
  ];

  function CityScoreData(tile) {
    this.tile = tile;

    this.city_expandability_score = 0.0;
    this.city_defensability_score = 0.0;
    this.city_general_defense_score = 0.0;
    this.city_relevance_score = 0.0;

    // 以下都是算上面四个分数用的中间量
    this.intergeneral_distance_differential = 0;
    this.general_distances_ratio = 1.0;
    this.general_distances_ratio_squared_capped = 1.0;

    this.friendly_city_nearby_score = 0;
    this.enemy_city_nearby_score = 0;
    this.neutral_city_nearby_score = 0;

    this.neighboring_city_relevance = 0;

    this.distance_from_player_general = 1000;
    this.distance_from_enemy_general = 1000;
    this.intergeneral_distance_through_city = 1000;
  }

  CityScoreData.prototype.get_weighted_neutral_value = function (log) {
    return (
      this.city_defensability_score *
      this.city_relevance_score *
      this.city_expandability_score *
      this.city_general_defense_score
    );
  };

  CityScoreData.prototype.get_weighted_enemy_capture_value = function (log) {
    var totalScore = this.city_defensability_score * this.city_relevance_score;
    if (!this.tile.discovered) totalScore = totalScore / 2;
    return totalScore;
  };

  // 给 oracle 用：字段顺序固定，方便逐字段 diff
  CityScoreData.prototype.to_list = function () {
    var out = [this.tile.tile_index];
    for (var i = 0; i < CITY_SCORE_FIELDS.length; i++) out.push(this[CITY_SCORE_FIELDS[i]]);
    return out;
  };

  /* ==================================================================
   * CityAnalyzer
   * ================================================================== */

  function CityAnalyzer(map, playerGeneral) {
    this.map = map;
    this.general = playerGeneral;

    this.city_scores = new Map();
    this.player_city_scores = new Map();
    this.enemy_city_scores = new Map();
    this.undiscovered_mountain_scores = new Map();
    this.owned_contested_cities = new Set();
    this.enemy_contested_cities = new Set();
    this.cities_in_play = new Set();
    this.last_scan_turn = -1;
    this.large_neutral_negatives = new Set();

    this.reachability_costs_matrix = null;
    this.reachable_from_matrix = null;

    this.last_targeted_neut_city = null;
    this.win_condition_analyzer = null;

    this.ensure_reachability_matrix_built(false);
  }

  // Python 的 __getstate__ / __setstate__（多进程 pickle 用），这里保留同名方法和 JS 风格的别名
  CityAnalyzer.prototype.__getstate__ = function () {
    var state = {};
    for (var k in this) {
      if (!Object.prototype.hasOwnProperty.call(this, k)) continue;
      if (k === 'map') continue;
      state[k] = this[k];
    }
    return state;
  };

  CityAnalyzer.prototype.__setstate__ = function (state) {
    if (!Object.prototype.hasOwnProperty.call(state, 'last_scan_turn')) state.last_scan_turn = -1;
    for (var k in state) {
      if (!Object.prototype.hasOwnProperty.call(state, k)) continue;
      this[k] = state[k];
    }
    this.map = null;
  };

  CityAnalyzer.prototype.get_state = CityAnalyzer.prototype.__getstate__;
  CityAnalyzer.prototype.set_state = CityAnalyzer.prototype.__setstate__;

  CityAnalyzer.prototype.re_scan = function (board_analysis) {
    this.last_scan_turn = this.map.turn;
    this.city_scores = new Map();
    this.player_city_scores = new Map();
    this.enemy_city_scores = new Map();
    this.undiscovered_mountain_scores = new Map();
    this.owned_contested_cities = new Set();
    this.enemy_contested_cities = new Set();
    this.large_neutral_negatives = new Set();
    this.cities_in_play = new Set();

    if (this.reachability_costs_matrix === null) this.ensure_reachability_matrix_built(true);

    var allyDistMap = null;
    var teammate = null;

    if (this.map.is_2v2) {
      // Python 遍历 set 取第一个；集合里是小整数，迭代序即升序，这里照抄成取最小值
      var teammateIdx = null;
      this.map.teammates.forEach(function (t) {
        if (teammateIdx === null || t < teammateIdx) teammateIdx = t;
      });
      if (teammateIdx !== null) {
        teammate = this.map.players[teammateIdx];
        if (!teammate.dead) allyDistMap = this.map.distance_mapper.get_tile_dist_matrix(teammate.general);
      }
    }

    var self = this;
    var expensiveCities = [];
    var numCities = [0];

    function foreachFunc(tile, dist) {
      if (tile.player() === -1 && tile.army < 0 && (0 - tile.army) / (dist + 1) >= 4) {
        self.large_neutral_negatives.add(tile);
      }

      if (tile.isMountain) return true;

      if (!tile.isCity) return false;

      numCities[0] += 1;

      var score = new CityScoreData(tile);
      var isCostlyCity = tile.army > 5 || self.map.is_tile_enemy(tile);
      var isNegCity = tile.army <= 0;
      var isFriendly = isTileOnTeamWith(self.map, tile, board_analysis.general.player());

      if (isCostlyCity && expensiveCities.length < 30) {
        expensiveCities.push(tile);
        self._calculate_nearby_city_scores(tile, board_analysis, score);
      } else {
        if (isNegCity) {
          score.neutral_city_nearby_score = 100 - tile.army;
          score.friendly_city_nearby_score = 50 - tile.army;
        } else {
          score.neutral_city_nearby_score = 50000 / (1 + tile.army);
          score.friendly_city_nearby_score = 20000 / (1 + tile.army);
        }
      }

      self._calculate_distance_scores(tile, board_analysis, score);
      self._calculate_relevance_score(tile, board_analysis, score);

      if (isCostlyCity && expensiveCities.length < 30) {
        self._calculate_danger_score(tile, board_analysis, score);
        self._calculate_expandability_score(tile, board_analysis, score);
      } else {
        score.city_defensability_score = 20000.0 / numCities[0];
        score.city_expandability_score = 2000.0 / numCities[0];
        if (isCostlyCity) {
          score.city_general_defense_score = 10.0 / numCities[0];
        } else {
          score.city_general_defense_score = 20.0 / numCities[0];
        }
      }

      if (allyDistMap !== null) {
        self._calculate_2v2_score(tile, board_analysis, allyDistMap, teammate, score);
      }

      if (tile.isNeutral) {
        if (self.last_targeted_neut_city === tile) {
          score.city_relevance_score += 50;
          score.city_relevance_score *= 1.05;
        }

        self.city_scores.set(tile, score);
      } else if (isFriendly) {
        self.player_city_scores.set(tile, score);
        if (self.is_contested(tile)) self.owned_contested_cities.add(tile);
        // 城市“在局中”= 它离敌方将军不比我们自己的将军更远
        var intergeneral = board_analysis.intergeneral_analysis;
        var centralDefenseEnemyGeneralThreshold = intergeneral.bMap.raw[board_analysis.general.tile_index];
        var isCityInPlay = score.distance_from_enemy_general <= centralDefenseEnemyGeneralThreshold;
        if (isCityInPlay) self.cities_in_play.add(tile);
      } else {
        self.enemy_city_scores.set(tile, score);
        if (self.is_contested(tile)) self.enemy_contested_cities.add(tile);
      }
      return undefined;
    }

    EK.search.breadth_first_foreach_dist(
      this.map,
      this.map.players[this.general.player()].tiles,
      30,
      foreachFunc,
      null,
      false,
      true
    );
  };

  CityAnalyzer.prototype.reset_reachability = function () {
    this.reachability_costs_matrix = null;
    this.reachable_from_matrix = null;
  };

  CityAnalyzer.prototype.ensure_reachability_matrix_built = function (force) {
    if (this.reachability_costs_matrix !== null && !force) return;
    if (this.map.swamps.size > 0 || this.map.is_walled_city_game) {
      var built = buildReachabilityCostMapMatrix(this.map, [this.general]);
      this.reachable_from_matrix = built.throughMap;
      this.reachability_costs_matrix = built.costMap;
    } else {
      this.reachability_costs_matrix = new EK.MapMatrix(this.map, 0);
      this.reachable_from_matrix = new EK.MapMatrix(this.map, null);
    }
  };

  CityAnalyzer.prototype._calculate_distance_scores = function (city, board_analysis, score) {
    var movable = city.movable;
    for (var i = 0; i < movable.length; i++) {
      var adj = movable[i];
      if (adj.isObstacle) continue;
      score.distance_from_player_general = Math.min(
        score.distance_from_player_general,
        board_analysis.intergeneral_analysis.aMap.raw[adj.tile_index] + 1
      );
      score.distance_from_enemy_general = Math.min(
        score.distance_from_enemy_general,
        board_analysis.intergeneral_analysis.bMap.raw[adj.tile_index] + 1
      );
    }

    var currentShortest = board_analysis.intergeneral_analysis.shortestPathWay.distance;

    score.intergeneral_distance_through_city =
      score.distance_from_enemy_general + score.distance_from_player_general;

    score.intergeneral_distance_differential = currentShortest - score.intergeneral_distance_through_city;

    score.general_distances_ratio =
      score.distance_from_player_general / Math.max(1, score.distance_from_enemy_general);

    // 平方让权重更极端，再用 0.1 兜底，免得把“在我们背后”的城市抬得太高
    var distanceRatioSquared = score.general_distances_ratio * score.general_distances_ratio;
    distanceRatioSquared = Math.max(distanceRatioSquared, 0.1);

    score.general_distances_ratio_squared_capped = distanceRatioSquared;
  };

  CityAnalyzer.prototype._calculate_danger_score = function (tile, board_analysis, score) {
    var scaleOffset;
    if (this.map.turn > 200 || !tile.isNeutral) {
      scaleOffset = 10;
    } else {
      scaleOffset = Math.max(0, tile.army - 34);
    }

    score.city_general_defense_score =
      0.2 +
      1.0 /
        Math.max(1, score.distance_from_player_general + scaleOffset) /
        Math.max(0.2, score.general_distances_ratio);

    var tilesNearbyFriendlyCounter = new EK.search.Counter(3);
    var tilesNearbyEnemyCounter = new EK.search.Counter(3);
    var self = this;
    function scoreNearbyTerritoryFunc(curTile, distance) {
      if (curTile.isNeutral || curTile.isObstacle) return;
      if (isTileOnTeamWith(self.map, curTile, board_analysis.general.player())) {
        tilesNearbyFriendlyCounter.add(1);
      } else {
        tilesNearbyEnemyCounter.add(1);
      }
    }

    var maxDist = Math.min(15, Math.floor(board_analysis.intergeneral_analysis.shortestPathWay.distance / 4));
    this.foreach_around_city(tile, board_analysis, maxDist, scoreNearbyTerritoryFunc);

    score.city_defensability_score =
      (score.friendly_city_nearby_score + Math.floor(tilesNearbyFriendlyCounter.value / 2)) /
      score.general_distances_ratio_squared_capped /
      tilesNearbyEnemyCounter.value;
  };

  CityAnalyzer.prototype._calculate_nearby_city_scores = function (tile, board_analysis, score) {
    var nearbyFriendlyCityScore = new EK.search.Counter(0);
    var nearbyEnemyCityScore = new EK.search.Counter(0);
    var nearbyNeutralCityScore = new EK.search.Counter(0);
    var maxDist = Math.min(15, Math.floor(board_analysis.intergeneral_analysis.shortestPathWay.distance / 3));
    var frPlayer = board_analysis.general.player();
    var self = this;

    function scoreNearbyCitiesFunc(curTile, distance) {
      if (curTile === tile) return;
      var isFriendly = isTileOnTeamWith(self.map, curTile, frPlayer);
      if (curTile.isCity || curTile.isGeneral) {
        if (isFriendly) {
          nearbyFriendlyCityScore.value += maxDist - distance;
        } else if (curTile.player() === -1) {
          var distMult = maxDist - distance;
          if (curTile.army < 4) {
            nearbyNeutralCityScore.value +=
              distMult * rescaleValue(Math.min(curTile.army, -100), -100, 4, 40, 5);
          } else if (curTile.army < 40) {
            nearbyNeutralCityScore.value += distMult * rescaleValue(curTile.army, 4, 40, 4, 1);
          } else {
            nearbyNeutralCityScore.value += distMult;
          }
        } else {
          nearbyEnemyCityScore.value += maxDist - distance;
        }
      } else if (curTile.player() >= 0) {
        var distMult2 = maxDist - distance;
        if (isFriendly) {
          nearbyFriendlyCityScore.value += 0.1 * distMult2 * (curTile.army - 1);
        } else {
          nearbyEnemyCityScore.value += 0.1 * distMult2 * (curTile.army - 1);
        }
      }
    }

    this.foreach_around_city(tile, board_analysis, maxDist, scoreNearbyCitiesFunc);

    score.enemy_city_nearby_score = nearbyEnemyCityScore.value;
    score.neutral_city_nearby_score = nearbyNeutralCityScore.value;
    score.friendly_city_nearby_score = nearbyFriendlyCityScore.value;
  };

  CityAnalyzer.prototype._calculate_relevance_score = function (tile, board_analysis, score) {
    score.neighboring_city_relevance =
      (2 * score.friendly_city_nearby_score + score.neutral_city_nearby_score) /
      (score.enemy_city_nearby_score + 2);

    // 基准偏移让贴着将军的城市不至于比隔一格的分数高出数量级
    var baseOffset = -5;
    // 例如 +baseOffset 表示正好在主路径上，15 表示绕出去很远
    var differentialNormalizedPositive =
      0 - Math.min(baseOffset, score.intergeneral_distance_differential + baseOffset);
    var pathRelevance = score.neighboring_city_relevance / differentialNormalizedPositive;
    var playerProximityRelevance = Math.max(0.0, 1.0 - score.general_distances_ratio) * 0.35;
    pathRelevance += playerProximityRelevance;
    if (pathRelevance < 0) pathRelevance = 0;

    score.city_relevance_score = pathRelevance;
  };

  CityAnalyzer.prototype._calculate_expandability_score = function (tile, board_analysis, score) {
    var initExpValue = 40;
    if (tile.isNeutral) initExpValue = Math.max(1, 60 - tile.army);
    var expCounter = new EK.search.Counter(initExpValue);
    var cityDist = score.distance_from_player_general;
    // 那些原本不可达、或者被长墙隔开的格子要设上限，不能被当成大金矿
    var cap = 8;
    var self = this;

    function scoreNearbyExpandabilityFunc(curTile, distance) {
      if (!curTile.isNeutral || curTile.isCity || curTile.isMountain) return;

      var tileNewDist = distance + cityDist;
      var oldDist = Math.min(
        tileNewDist + cap,
        board_analysis.intergeneral_analysis.aMap.raw[curTile.tile_index]
      );
      // 正数表示经过这座城能更早摸到该格
      var tileExplorabilityDifferential = oldDist - tileNewDist;
      if (tileExplorabilityDifferential >= 0) {
        expCounter.add(tileExplorabilityDifferential);
      }

      expCounter.add(0.4);
    }

    var maxDist = Math.min(15, Math.floor(board_analysis.intergeneral_analysis.shortestPathWay.distance / 4));
    this.foreach_around_city(tile, board_analysis, maxDist, scoreNearbyExpandabilityFunc);

    score.city_expandability_score = expCounter.value;
  };

  CityAnalyzer.prototype._calculate_2v2_score = function (tile, board_analysis, ally_dist_map, teammate, score) {
    var usDistFromCity = board_analysis.intergeneral_analysis.aMap.raw[tile.tile_index];
    var allyDistFromUs = board_analysis.intergeneral_analysis.aMap.raw[teammate.general.tile_index];
    var allyDistFromCity = ally_dist_map.raw[tile.tile_index];

    var cityDistSum = usDistFromCity + allyDistFromCity;
    if (cityDistSum < allyDistFromUs) {
      score.city_expandability_score += 100;
      score.city_relevance_score *= 2;
      score.city_defensability_score *= 2;
      score.city_general_defense_score *= 2;
    }
  };

  CityAnalyzer.prototype.foreach_around_city = function (tile, board_analysis, maxDist, foreachFunc) {
    function newForeach(t, dist) {
      foreachFunc(t, dist);
      return t.isObstacle && t !== tile;
    }

    EK.search.breadth_first_foreach_dist(board_analysis.map, [tile], maxDist, newForeach, null, true, true);
  };

  /*
   * Python 的 sorted(..., reverse=True, key=...) 是稳定排序：分数相同的城市保持
   * 插入顺序（= BFS 访问顺序）。JS 的 Array#sort 也稳定，所以直接用值比较即可。
   */
  function sortScoresDesc(scoreMap, keyFunc) {
    var arr = [];
    scoreMap.forEach(function (score, tile) {
      arr.push([tile, score, keyFunc(score)]);
    });
    arr.sort(function (a, b) {
      return b[2] - a[2];
    });
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push([arr[i][0], arr[i][1]]);
    return out;
  }

  CityAnalyzer.prototype.get_sorted_neutral_scores = function () {
    return sortScoresDesc(this.city_scores, function (s) {
      return s.get_weighted_neutral_value(true);
    });
  };

  CityAnalyzer.prototype.get_sorted_enemy_scores = function () {
    return sortScoresDesc(this.enemy_city_scores, function (s) {
      return s.get_weighted_enemy_capture_value(true);
    });
  };

  CityAnalyzer.prototype.is_contested = function (city, captureCutoffAgoTurns, enemyTerritorySearchDepth) {
    if (captureCutoffAgoTurns === undefined) captureCutoffAgoTurns = 20;
    if (enemyTerritorySearchDepth === undefined) enemyTerritorySearchDepth = 4;

    if (
      this.win_condition_analyzer !== null &&
      this.win_condition_analyzer.was_city_recently_contested(city, captureCutoffAgoTurns)
    ) {
      return true;
    }

    if (city.turn_captured > this.map.turn - captureCutoffAgoTurns) return true;

    var countFriendlyNear = new EK.search.Counter(0);
    var countEnemyNear = new EK.search.Counter(0);
    var self = this;

    function counterFunc(tile, dist) {
      if (isTileOnTeamWith(self.map, tile, city.player())) {
        countFriendlyNear.add(1);
      } else if (tile.player() >= 0) {
        countEnemyNear.add(1);
      }
    }

    EK.search.breadth_first_foreach_dist_fast_no_neut_cities(this.map, [city], enemyTerritorySearchDepth, counterFunc);

    if (countEnemyNear.value > countFriendlyNear.value) return true;

    return false;
  };

  EK.CityScoreData = CityScoreData;
  EK.CityAnalyzer = CityAnalyzer;
  EK.city = {
    CityScoreData: CityScoreData,
    CityAnalyzer: CityAnalyzer,
    CityScoreFields: CITY_SCORE_FIELDS,
    rescale_value: rescaleValue,
    is_player_on_team_with: isPlayerOnTeamWith,
    build_reachability_cost_map_matrix: buildReachabilityCostMapMatrix
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

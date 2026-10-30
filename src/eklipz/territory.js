/*
 * TerritoryClassifier —— 逐行移植自 generals-bot/Territory.py。
 *
 * 作用：把整张图按「谁的势力范围」切成一块块 territory（不是归属，是势力）。
 * 关键在于它**不是**看格子归属，而是对每个需要重算的格子做一次 5 步 BFS，
 * 把周围格子按归属加权投票，投出这个格子算谁的势力。权重（3/5/0.3/0.25/0.8/
 * 0.06/0.014）是原版调出来的，一个字都不能动——它决定了迷雾里一块黑地
 * 算谁的、以及我们敢不敢把它当成「自家后院」来运兵。
 *
 * 重算时机同样不能改：needToUpdateAroundTiles 只装「新出现的东西周围的格子」
 * （构造时先塞 pathable_tiles，之后由 revealed_tile / 调用方塞），
 * should_recalculate 就靠它非空来判断。全图重算是 O(N × 5 步 BFS)，每回合都做会拖垮决策。
 *
 * 边界判定（is_tile_in_friendly/enemy/player_territory）全部走 get_tile_territory，
 * 其中 friendly 用 team 比较而不是 player 比较，2v2 下队友的领地也算友方。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function MM(map, init) {
    return new EK.MapMatrix(map, init);
  }
  function S() {
    return EK.search;
  }

  // Python 的 team_ids_by_player_index 末尾补了 -1，专门给 index = -1 用；
  // JS 数组的 [-1] 是 undefined，必须绕回最后一个元素。
  function teamId(map, p) {
    var arr = map.team_ids_by_player_index;
    var idx = p === null || p === undefined ? -1 : p;
    if (idx < 0) return arr[arr.length - 1];
    return arr[idx];
  }

  function isPlayerOnTeamWith(map, p1, p2) {
    return teamId(map, p1) === teamId(map, p2);
  }

  function isPlayerOnTeam(map, p, team) {
    return teamId(map, p) === team;
  }

  function TerritoryClassifier(map) {
    this.map = map;
    this.lastCalculatedTurn = -1;
    this.territoryMap = MM(map, -1);
    this.needToUpdateAroundTiles = new Set();

    // 原版 list(set(get_teams_array(map)))，顺序只影响 territoryTeamDistances 的
    // 初始化长度；后面按 team 值直接下标赋值，所以顺序不参与任何判定。
    var seen = {};
    var teams = [];
    var arr = map.team_ids_by_player_index;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (seen[t] !== undefined) continue;
      seen[t] = true;
      teams.push(t);
    }
    this.team_indexes = teams;

    this.territoryDistances = [];
    for (var p = 0; p < map.players.length; p++) this.territoryDistances.push(MM(map, 1000));
    this.territoryTeamDistances = [];
    for (var ti = 0; ti < this.team_indexes.length; ti++) this.territoryTeamDistances.push(MM(map, 1000));

    var self = this;
    map.pathable_tiles.forEach(function (tile) {
      self.needToUpdateAroundTiles.add(tile);
    });
  }

  TerritoryClassifier.prototype.should_recalculate = function (turn) {
    return this.needToUpdateAroundTiles.size > 0;
  };

  /*
   * 新发现的格子按「发现时属于谁」给周围未发现格打上势力印记，
   * 防止中立势力靠着一堆黑地慢慢爬过来。紧接着 scan() 会把这个格子本身的
   * 势力值覆盖成真实投票结果，所以这里的写入只在同一轮扫描里起作用。
   */
  TerritoryClassifier.prototype.revealed_tile = function (tile) {
    this.territoryMap.raw[tile.tile_index] = tile.player();
    if (tile.player() === -1 || tile.player() === this.map.player_index) return;
    for (var i = 0; i < tile.movable.length; i++) {
      var movable = tile.movable[i];
      if (!movable.discovered && !movable.isObstacle) this.territoryMap.raw[movable.tile_index] = tile.player();
    }
  };

  TerritoryClassifier.prototype.scan = function () {
    var map = this.map;
    var playersLen = map.players.length;
    // counts[x][y] = 每个玩家的票数；末尾多一格给「中立」
    var counts = [];
    for (var cx = 0; cx < map.cols; cx++) {
      var col = [];
      for (var cy = 0; cy < map.rows; cy++) {
        var zeroes = [];
        for (var z = 0; z <= playersLen; z++) zeroes.push(0);
        col.push(zeroes);
      }
      counts.push(col);
    }
    var undiscoveredCounterDepth = 5;
    var neutralNewIndex = playersLen;
    var self = this;

    function foreach_near_updated_tiles(evaluatingTile) {
      if (evaluatingTile.player() !== -1 && evaluatingTile.player() !== map.player_index) {
        for (var m = 0; m < evaluatingTile.movable.length; m++) {
          var movable = evaluatingTile.movable[m];
          if (!movable.discovered && !movable.isObstacle) {
            self.territoryMap.raw[movable.tile_index] = evaluatingTile.player();
            counts[evaluatingTile.x][evaluatingTile.y][evaluatingTile.player()] += 3;
            counts[movable.x][movable.y][evaluatingTile.player()] += 5;
          }
        }
      }

      // 这一格自己的票箱；countFunc 每走到一个格子就往这里记一笔
      var bucket = counts[evaluatingTile.x][evaluatingTile.y];

      function countFunc(tile) {
        if (tile.isObstacle) return tile.player() === -1 && tile.discovered;

        var currentTerritory = self.territoryMap.raw[tile.tile_index];
        if (!evaluatingTile.discovered) {
          // 已划好的势力值权重要高，让势力块不容易被翻转
          if (currentTerritory !== -1) {
            // 绝不让「我们」拥有未发现的领土，否则会连锁扩散成自家后院
            if (tile.discovered && !evaluatingTile.discovered && currentTerritory !== map.player_index) {
              bucket[currentTerritory] += 0.3;
            } else if (currentTerritory === map.player_index) {
              bucket[neutralNewIndex] += 0.06;
            }
          } else {
            // 只有「已发现的中立格」才给中立投票，且只在评估中立格时
            bucket[neutralNewIndex] += 0.014;
          }
        } else {
          // 未发现的格子投给**评估格自己**的玩家（不是这个格子的玩家）：
          // 原版是 counts[ex][ey][evaluatingTile.player] += 0.25。
          // 玩家为 -1 时 Python 的 [ -1 ] 命中中立票箱，JS 必须显式折回。
          if (!tile.discovered) {
            var evaluatingPlayer = evaluatingTile.player();
            bucket[evaluatingPlayer === -1 ? neutralNewIndex : evaluatingPlayer] += 0.25;
          } else {
            var pIndex = tile.player();
            if (pIndex !== -1 && pIndex !== map.player_index) bucket[pIndex] += 1;
            else if (pIndex !== -1) bucket[pIndex] += 0.8; // 我方格子权重低：我们看得见的多
          }
        }

        return tile.player() === -1 && tile.discovered;
      }

      S().breadth_first_foreach(map, [evaluatingTile], undiscoveredCounterDepth, countFunc, null, true);

      var maxPlayer = -1;
      var maxValue = 0;
      for (var pIndex = 0; pIndex < bucket.length; pIndex++) {
        var value = bucket[pIndex];
        if (value > maxValue) {
          maxPlayer = pIndex;
          maxValue = value;
        }
      }
      // 中立项折回 -1
      if (maxPlayer === neutralNewIndex) maxPlayer = -1;

      self.territoryMap.raw[evaluatingTile.tile_index] = maxPlayer;

      return evaluatingTile.isMountain;
    }

    // 顺序**必须**按 tile_index 升序：原版 startTiles = list(self.needToUpdateAroundTiles)
    // 是 set 迭代，而 Tile.__hash__ 就是 tile_index（实测 hash(tile) == tile.tile_index），
    // 所以 CPython 的 set 迭代出来的就是升序。scan 本身会边评估边往 territoryMap 里写
    // 势力值，后面的格子会读前面的结果，顺序一变迷雾边的归属就跟着变（g5000 实测
    // 换成插入顺序会有 524 格不一致，升序则 0 格）。
    var startTiles = Array.from(this.needToUpdateAroundTiles);
    startTiles.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    S().breadth_first_foreach(map, startTiles, undiscoveredCounterDepth, foreach_near_updated_tiles);
    this.needToUpdateAroundTiles = new Set();

    // 势力图变了，按玩家 / 按队伍重建距离场（下游全靠这两组矩阵做「离自己地盘几步」）
    var p;
    for (p = 0; p < map.players.length; p++) {
      if (map.players[p].dead) continue;
      var playerStartTiles = [];
      for (var i = 0; i < map.tiles_by_index.length; i++) {
        var tile = map.tiles_by_index[i];
        if (this.territoryMap.raw[tile.tile_index] === map.players[p].index) playerStartTiles.push(tile);
      }
      this.territoryDistances[map.players[p].index] = S().build_distance_map_matrix(map, playerStartTiles);
    }

    for (var t = 0; t < this.team_indexes.length; t++) {
      var team = this.team_indexes[t];
      var teamStartTiles = [];
      var pathable = map.pathable_tiles;
      var iter = pathable.values();
      var nx = iter.next();
      while (!nx.done) {
        var ptile = nx.value;
        nx = iter.next();
        if (isPlayerOnTeam(map, this.territoryMap.raw[ptile.tile_index], team)) teamStartTiles.push(ptile);
      }
      this.territoryTeamDistances[team] = S().build_distance_map_matrix(map, teamStartTiles);
    }
  };

  TerritoryClassifier.prototype.is_tile_in_friendly_territory = function (tile) {
    var territory = this.get_tile_territory(tile);
    if (territory === -1) return false;
    return isPlayerOnTeamWith(this.map, territory, this.map.player_index);
  };

  TerritoryClassifier.prototype.is_tile_in_enemy_territory = function (tile) {
    var territory = this.get_tile_territory(tile);
    return territory >= 0 && !isPlayerOnTeamWith(this.map, territory, this.map.player_index);
  };

  TerritoryClassifier.prototype.is_tile_in_player_territory = function (tile, player) {
    var territory = this.get_tile_territory(tile);
    return isPlayerOnTeamWith(this.map, territory, player);
  };

  TerritoryClassifier.prototype.get_tile_territory = function (tile) {
    return this.territoryMap.raw[tile.tile_index];
  };

  EK.TerritoryClassifier = TerritoryClassifier;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

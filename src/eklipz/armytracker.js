/*
 * ArmyTracker / Army —— 逐行移植自 generals-bot/ArmyTracker.py + Army.py。
 *
 * 这是迷雾军力推断的状态机本体：每回合把「上一回合我们以为的军队」和「这一回合
 * 地图/对手给出的 delta」对齐，把猜测推进到迷雾里，并把迷雾格上的归属与兵数
 * 改写成我们的臆测值（tile.player / tile.army）。ekdiff 里剩下的 player/army/
 * dOldOwner/dOldArmy 差异全靠这一层。
 *
 * 移植边界（原文里存在、但这里故意没搬的东西）：
 *   1. OpponentTracker：全部为 null。凡是原文只用来向 opponent_tracker 发通知、
 *      或读取它算出来的「迷雾格数量分布」的地方，都在调用点注释标了 [OPPONENT]。
 *   2. BoardAnalyzer：_boardAnalysis 恒为 null。find_next_fog_city_candidate_near_tile
 *      依赖它算 wall breach 分数，因此该函数在 _boardAnalysis 为 null 时直接返回
 *      null（等价于「这张图找不到雾中城市候选」），见处注释 [BOARD]。
 *   3. 所有 render / print / ViewInfo / logbook 调试分支。log_debug 保留为字段，
 *      但它的分支体全部删除（只保留控制流）。
 *   4. perf_timer：原版的 begin_move_event 是 with 上下文管理器，这里只留空壳，
 *      不做超时中断——对追踪状态没有任何影响。
 *
 * 调用入口（原版 bot_ek0x45.py:674 / 722 / 784）：
 *     tracker.scan_movement_and_emergences(lastMove, turn, boardAnalysis)
 *     tracker.update_fog_prediction(playerIdx, fogTileCounts, predictedGenTile)
 *     tracker.verify_player_tile_and_army_counts_valid()
 * update() / recalculate() 是给新调用方的别名，参数同 scan_movement_and_emergences。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var Tile = EK.Tile;
  var Path = EK.Path;
  var MapMatrix = EK.MapMatrix;
  var MapMatrixSet = EK.MapMatrixSet;

  function S() {
    return EK.search;
  }

  var TILE_OBSTACLE = EK.TILE.OBSTACLE;
  var MAX_ALLY_SPAWN_DISTANCE = 5;
  var MIN_ALLY_SPAWN_DISTANCE = 0;

  /* ------------------------------------------------------------------ *
   * 通用小工具
   * ------------------------------------------------------------------ */

  /*
   * Python 的 players[-1] 会取到最后一个玩家。原文好几处（move_army_into_fog 里
   * 处理 neutral 目标格、_limit... 处理 -1 队伍成员）真的靠这个负索引取到人，
   * 照抄索引语义，不要「修」成 players[-1] === undefined。
   */
  function pAt(map, idx) {
    if (idx >= 0) return map.players[idx];
    return map.players[map.players.length + idx];
  }

  /*
   * 按玩家索引的数组（unrecaptured_emergence_events / emergenceLocationMap 等）同样是
   * Python 负索引语义：player 可能是 -1（中立格作为「涌现来源」），原文就落到最后一个元素。
   */
  function byPlayer(arr, idx) {
    if (!arr || arr.length === 0) return undefined;
    if (idx >= 0) return arr[idx];
    return arr[arr.length + idx >= 0 ? arr.length + idx : arr.length - 1];
  }

  /*
   * byPlayer 只能用在「拿得到返回值」的地方；`this.emergenceLocationMap[player]` 这种
   * 裸下标有几十处，逐个改又容易漏。给按玩家建的数组套一层负下标代理，一次对齐
   * Python 的 list[-1] 语义（读取取末元素，写入写末元素），其余属性原样透传。
   */
  function pyArray(arr) {
    if (typeof Proxy !== 'function' || !arr) return arr;
    return new Proxy(arr, {
      get: function (target, prop, recv) {
        if (typeof prop === 'string' && prop.length > 1 && prop.charAt(0) === '-') {
          var n = Number(prop);
          if (!isNaN(n) && n < 0) {
            var k = target.length + n;
            return target[k >= 0 ? k : target.length - 1];
          }
        }
        return Reflect.get(target, prop, recv);
      },
      set: function (target, prop, value) {
        if (typeof prop === 'string' && prop.length > 1 && prop.charAt(0) === '-') {
          var n = Number(prop);
          if (!isNaN(n) && n < 0) {
            var k = target.length + n;
            target[k >= 0 ? k : target.length - 1] = value;
            return true;
          }
        }
        return Reflect.set(target, prop, value);
      }
    });
  }

  function isPlayerOnTeamWith(map, p1, p2) {
    return map.team_ids_by_player_index[p1] === map.team_ids_by_player_index[p2];
  }
  function ownsTilePlayer(map, p) {
    return p === map.player_index || map.teammates.has(p);
  }

  function distBetween(map, a, b) {
    return map.distance_mapper.get_distance_between(a, b);
  }

  /* map.py is_tile_visible_to：视野是「相邻格属于该玩家的队伍」推出来的 */
  function tileIsVisibleTo(map, tile, player) {
    var team = map.team_ids_by_player_index[player];
    for (var i = 0; i < tile.adjacents.length; i++) {
      if (map.team_ids_by_player_index[tile.adjacents[i].player()] === team) return true;
    }
    return false;
  }

  /* map.py reset_wrong_undiscovered_fog_guess */
  function mapResetWrongUndiscoveredFogGuess(map, curTile) {
    var resetAsCity = false;
    if (!curTile.discovered) {
      if (curTile.isCity && (map.is_low_cost_city_game || map.is_walled_city_game)) resetAsCity = true;
    }
    curTile.reset_wrong_undiscovered_fog_guess();
    if (resetAsCity) {
      if (map.walled_city_base_value === null) map.walled_city_base_value = 40;
      curTile.isCity = true;
      curTile.setPlayer(-1);
      curTile.army = map.walled_city_base_value;
    }
  }

  /* map.py get_team_stats 里被用到的两个字段 */
  function getTeamStats(map, teamPlayer) {
    var targetTeam = teamPlayer === -1 ? -1 : map.players[teamPlayer].team;
    var teamPlayers = map._teammates_by_team[targetTeam] || [];
    var cityCount = 0;
    for (var i = 0; i < teamPlayers.length; i++) cityCount += pAt(map, teamPlayers[i]).cityCount;
    return { cityCount: cityCount, teamPlayers: teamPlayers };
  }

  /* map.py 的 _teammates_by_player_no_self 在 JS 侧没建，这里按同样语义现算 */
  function getTeammatesNoSelf(map, player) {
    var all = map.get_teammates(player) || [];
    var self = player;
    return all.filter(function (p) { return p !== self; });
  }

  function removeFromArray(arr, item) {
    var at = arr.indexOf(item);
    if (at >= 0) arr.splice(at, 1);
  }

  function toArray(coll) {
    if (coll === null || coll === undefined) return [];
    if (Array.isArray(coll)) return coll;
    // MapMatrix/MapMatrixSet 不是 iterable，Python 里那些 set 被搬成了平表索引。
    if (coll.raw && typeof coll.toTiles === 'function') return coll.toTiles();
    if (coll.raw && typeof coll.keys === 'function') return coll.keys();
    return Array.from(coll);
  }

  function removeFromCollection(coll, item) {
    if (coll === null || coll === undefined) return;
    if (typeof coll.delete === 'function') {
      coll.delete(item);
      return;
    }
    if (typeof coll.discard === 'function') coll.discard(item);
  }

  function flattenPathTiles(paths) {
    var out = new Set();
    for (var i = 0; i < paths.length; i++) {
      var tl = paths[i].tileList;
      for (var k = 0; k < tl.length; k++) out.add(tl[k]);
    }
    return out;
  }

  function NullPerfTimer() {}
  NullPerfTimer.prototype.begin_move_event = function () {
    return null;
  };

  /* ------------------------------------------------------------------ *
   * Army（Army.py）
   * ------------------------------------------------------------------ */

  var ARMY_LETTER_START = 65; // 'A'
  var ARMY_LETTER_END = 122; // 'z'
  var armyCurLetter = ARMY_LETTER_START;

  function armyGetLetter() {
    var ch = armyCurLetter;
    if (ch + 1 > ARMY_LETTER_END) {
      armyCurLetter = ARMY_LETTER_START;
    } else {
      armyCurLetter = ch + 1;
      while (armyCurLetter === 91 || armyCurLetter === 92 || armyCurLetter === 93 || armyCurLetter === 94 || armyCurLetter === 95 || armyCurLetter === 96) {
        armyCurLetter += 1;
      }
    }
    return String.fromCharCode(ch);
  }

  function FogTileRevert(tile, army, player, isTempFogPrediction) {
    this.tile = tile;
    this.army = army;
    this.player = player;
    this.isTempFogPrediction = isTempFogPrediction;
  }

  function Army(tile, name) {
    this.tile = tile;
    this.path = new Path();
    this.player = tile.player();
    this.visible = tile.visible;
    this.value = 0; /* 恒等于 tile.army - 1，原文如此 */
    this.expectedPaths = [];
    this.entangledArmies = [];
    this.entangledValue = null;
    this.scrapped = false;
    this.last_moved_turn = 0;
    this.last_seen_turn = 0;
    this.fogTileReverts = new Map();
    this.name = name || armyGetLetter();
    this.update_tile(tile);
  }

  Army.get_letter = armyGetLetter;

  Army.prototype.update_tile = function (tile) {
    if (this.path.tail === null || this.path.tail.tile !== tile) this.path.add_next(tile);
    if (this.tile !== tile) this.tile = tile;
    this.update();
  };

  Army.prototype.update = function () {
    if (this.tile.visible) {
      this.value = this.tile.army - 1;
      this.entangledValue = null;
    }
    this.visible = this.tile.visible;
  };

  Army.prototype.get_split_for_fog = function (fogTiles) {
    var split = [];
    if (this.entangledValue === null) this.entangledValue = this.value;
    for (var i = 0; i < fogTiles.length; i++) {
      var splitArmy = this.clone();
      splitArmy.entangledValue = this.value;
      if (this.entangledValue !== null) splitArmy.entangledValue = this.entangledValue;
      split.push(splitArmy);
    }
    for (var e = 0; e < this.entangledArmies.length; e++) {
      var existing = this.entangledArmies[e];
      for (var s = 0; s < split.length; s++) existing.entangledArmies.push(split[s]);
    }
    for (var k = 0; k < split.length; k++) {
      var self = split[k];
      var others = S().where(split, function (army) {
        return army !== self;
      });
      for (var o = 0; o < others.length; o++) self.entangledArmies.push(others[o]);
    }
    this.scrapped = true;
    return split;
  };

  Army.prototype.clone = function () {
    var newDude = new Army(this.tile, this.name);
    if (this.path !== null) newDude.path = this.path.clone();
    newDude.player = this.player;
    newDude.visible = this.visible;
    newDude.value = this.value;
    newDude.last_moved_turn = this.last_moved_turn;
    newDude.last_seen_turn = this.last_seen_turn;
    newDude.fogTileReverts = new Map(this.fogTileReverts);
    for (var i = 0; i < this.expectedPaths.length; i++) {
      var clone = this.expectedPaths[i].clone();
      if (clone === null || clone === undefined) throw new Error('expected path clone failed');
      newDude.expectedPaths.push(clone);
    }
    newDude.entangledArmies = this.entangledArmies.slice();
    newDude.scrapped = this.scrapped;
    newDude.entangledValue = this.entangledValue;
    return newDude;
  };

  Army.prototype.record_fog_tile_revert = function (tile) {
    if (!this.fogTileReverts.has(tile)) {
      this.fogTileReverts.set(tile, new FogTileRevert(tile, tile.army, tile.player(), tile.isTempFogPrediction));
    }
  };

  Army.prototype.absorb_fog_tile_reverts = function (other) {
    var self = this;
    other.fogTileReverts.forEach(function (revert, tile) {
      if (!self.fogTileReverts.has(tile)) self.fogTileReverts.set(tile, revert);
    });
  };

  Army.prototype.include_path = function (path) {
    if (path === null || path === undefined) return;

    var foundMatch = false;
    for (var i = 0; i < this.expectedPaths.length; i++) {
      var existingPath = this.expectedPaths[i];
      if (existingPath === null) {
        this.expectedPaths.splice(i, 1);
        i -= 1;
        continue;
      }
      var pathNode = path.start;
      var existingPathNode = existingPath.start;
      var isPathMatch = true;
      while (pathNode !== null && pathNode !== undefined && existingPathNode !== null && existingPathNode !== undefined) {
        if (pathNode.tile !== existingPathNode.tile) {
          isPathMatch = false;
          break;
        }
        pathNode = pathNode.next;
        existingPathNode = existingPathNode.next;
      }
      if (pathNode !== null && pathNode !== undefined) isPathMatch = false;
      if (existingPathNode !== null && existingPathNode !== undefined) isPathMatch = false;
      if (isPathMatch) {
        foundMatch = true;
        break;
      }
    }
    if (!foundMatch) this.expectedPaths.push(path);
  };

  Army.prototype.toString = function () {
    return '[' + this.name + ' ' + this.tile + ' p' + this.player + ' v' + this.value + (this.scrapped ? ' scr' : '') + ']';
  };

  /* ------------------------------------------------------------------ *
   * PlayerAggressionTracker（原文里的空壳，给外部读 aggression 用）
   * ------------------------------------------------------------------ */

  function PlayerAggressionTracker(index) {
    this.player = index;
    this.is_aggressive = false;
    this.confidence = 0;
    this.last_move_turn = 0;
    this.estimated_tiles = 0;
    this.estimated_score = 0;
  }

  /* ------------------------------------------------------------------ *
   * ArmyTracker
   * ------------------------------------------------------------------ */

  function ArmyTracker(map, perfTimer, opponentTracker) {
    var i;
    this.connectedByPlayer = [];
    this.coreConnectedByPlayer = [];
    for (i = 0; i < map.players.length; i++) {
      this.connectedByPlayer.push(new Set());
      this.coreConnectedByPlayer.push(new Set());
    }

    this.perf_timer = perfTimer || new NullPerfTimer();
    this.player_moves_this_turn = new Set();
    this.map = map;
    this.opponent_tracker = opponentTracker || null;
    this.general = map.generals[map.player_index];

    this.log_debug = false;

    this.armies = new Map(); /* Tile -> Army */

    this.initial_expansion_tile_counts = [];
    this.should_recalc_fog_land_by_player = [];
    for (i = 0; i < this.map.players.length; i++) {
      this.initial_expansion_tile_counts.push(0);
      this.should_recalc_fog_land_by_player.push(true);
    }

    this.unaccounted_tile_diffs = new Map();

    this.valid_general_positions_by_player = [];
    this.tiles_ever_owned_by_player = [];
    this.seen_tiles_by_player = [];
    this.visible_tiles_by_player = [];
    this.uneliminated_emergence_events = [];
    this.unrecaptured_emergence_events = [];
    this.discovered_enemy_land_connector_tiles = [];
    this.uneliminated_emergence_event_city_perfect_info = [];
    for (i = 0; i < this.map.players.length; i++) {
      this.valid_general_positions_by_player.push(new MapMatrixSet(map));
      var ever = new Set();
      var pl = this.map.players[i];
      for (var ti = 0; ti < pl.tiles.length; ti++) {
        if (pl.tiles[ti].visible || pl.tiles[ti].discovered) ever.add(pl.tiles[ti]);
      }
      this.tiles_ever_owned_by_player.push(ever);
      this.seen_tiles_by_player.push(new MapMatrixSet(map));
      this.visible_tiles_by_player.push(new MapMatrixSet(map));
      this.uneliminated_emergence_events.push(new Map());
      this.unrecaptured_emergence_events.push(new Set());
      this.discovered_enemy_land_connector_tiles.push(new Set());
      this.uneliminated_emergence_event_city_perfect_info.push(new Set());
    }
    /* neutral 看不到任何东西，但索引 -1 要能安全访问 */
    this.seen_tiles_by_player.push(new MapMatrixSet(map));
    this.visible_tiles_by_player.push(new MapMatrixSet(map));
    /* 套负下标代理：几十处裸下标（emergenceLocationMap[player] 等）一次对齐 py 语义 */
    this.valid_general_positions_by_player = pyArray(this.valid_general_positions_by_player);
    this.tiles_ever_owned_by_player = pyArray(this.tiles_ever_owned_by_player);
    this.seen_tiles_by_player = pyArray(this.seen_tiles_by_player);
    this.visible_tiles_by_player = pyArray(this.visible_tiles_by_player);
    this.uneliminated_emergence_events = pyArray(this.uneliminated_emergence_events);
    this.unrecaptured_emergence_events = pyArray(this.unrecaptured_emergence_events);
    this.discovered_enemy_land_connector_tiles = pyArray(this.discovered_enemy_land_connector_tiles);
    this.uneliminated_emergence_event_city_perfect_info = pyArray(
      this.uneliminated_emergence_event_city_perfect_info
    );
    this.player_launch_timings = pyArray(this.player_launch_timings);
    for (var tIdx = 0; tIdx < this.map.tiles_by_index.length; tIdx++) {
      var t = this.map.tiles_by_index[tIdx];
      for (var vIdx = 0; vIdx < t.visibleTo.length; vIdx++) {
        var v = t.visibleTo[vIdx];
        var vp = v.player();
        if (vp >= 0) {
          this.visible_tiles_by_player[vp].raw[t.tile_index] = true;
          if (v.visible) this.seen_tiles_by_player[vp].raw[t.tile_index] = true;
        }
      }
    }

    this.pathed_fog_emergence_tiles = new Set();
    this.seen_player_lookup = [];
    for (i = 0; i < this.map.players.length; i++) this.seen_player_lookup.push(false);

    this.is_long_spawns = this.map.players.length === 2;
    this.min_spawn_distance = 9;
    if (this.is_long_spawns) this.min_spawn_distance = 15;
    if (this.map.is_2v2) this.min_spawn_distance = 15;
    if (this.map.is_custom_map) this.min_spawn_distance = 1;

    this._initialize_viable_general_positions();

    this.player_launch_timings = [];
    for (i = 0; i < this.map.players.length; i++) this.player_launch_timings.push(0);
    this.skip_emergence_tile_pathings = new Set();

    this.updated_city_tiles = new Set();
    this.unconnectable_tiles = [];
    this.player_connected_tiles = [];
    for (i = 0; i < this.map.players.length; i++) {
      this.unconnectable_tiles.push(new Set());
      this.player_connected_tiles.push(new Set());
    }
    this.players_with_incorrect_tile_predictions = new Set();

    this.lastMove = null;
    this.track_threshold = 3;
    this.update_track_threshold();

    this._flipped_tiles = new Set();
    this._flipped_by_army_tracker_this_turn = [];

    this.fogPaths = [];
    this.emergenceLocationMap = [];
    for (i = 0; i < this.map.players.length; i++) this.emergenceLocationMap.push(new MapMatrix(this.map, 0.0));
    this.emergenceLocationMap = pyArray(this.emergenceLocationMap);

    this.player_targets = [];

    this.notify_unresolved_army_emerged = [];
    this.notify_army_moved = [];

    this.player_aggression_ratings = [];
    for (i = 0; i < this.map.players.length; i++) this.player_aggression_ratings.push(new PlayerAggressionTracker(i));
    this.lastTurn = -1;
    this.decremented_fog_tiles_this_turn = new Set();
    this.dropped_fog_tiles_this_turn = new Set();
    this.fog_back_push_touched_tiles_this_turn = new Set();
    this._boardAnalysis = null;
  }

  var P = ArmyTracker.prototype;

  /* ================================================================== *
   * 回合入口
   * ================================================================== */

  P.scan_movement_and_emergences = function (lastMove, turn, boardAnalysis) {
    var i, player;
    this.pathed_fog_emergence_tiles = new Set();
    this._flipped_by_army_tracker_this_turn = [];
    this._boardAnalysis = boardAnalysis || null;
    this.skip_emergence_tile_pathings = new Set();
    this.lastMove = lastMove;
    this.decremented_fog_tiles_this_turn = new Set();
    this.dropped_fog_tiles_this_turn = new Set();
    this.fog_back_push_touched_tiles_this_turn = new Set();
    this.players_with_incorrect_tile_predictions = new Set();
    for (i = 0; i < this.map.players.length; i++) {
      player = this.map.players[i];
      if (this.player_launch_timings[player.index] === 0 && player.tileCount > 1) {
        if (player.tileCount === 2) this.player_launch_timings[player.index] = this.map.turn - 1;
        else this.player_launch_timings[player.index] = 24;
      }
    }

    if (this.map.turn === 50 && !this.map.is_low_cost_city_game) {
      var usTeam = this.map.team_ids_by_player_index[this.general.player()];
      for (i = 0; i < this.map.players.length; i++) {
        player = this.map.players[i];
        if (player.team !== usTeam && player.tileCount >= 22 && player.cityCount < 2) {
          this.limit_player_spawn_by_good_start(player);
        }
      }
    }

    this._pre_army_track_handle_flipped_tiles();
    this.rescan_city_information();

    this.player_targets = this.map.players[this.map.player_index].cities.slice();
    this.player_targets.push(this.map.generals[this.map.player_index]);
    var mates = Array.from(this.map.teammates);
    for (i = 0; i < mates.length; i++) {
      var teamPlayer = this.map.players[mates[i]];
      for (var c = 0; c < teamPlayer.cities.length; c++) this.player_targets.push(teamPlayer.cities[c]);
      this.player_targets.push(teamPlayer.general);
    }

    var advancedTurn = false;
    if (turn > this.lastTurn) {
      advancedTurn = true;
      if (this.lastTurn === -1) {
        /* 地图刚加载那一回合不做任何迷雾推动，只登记新出现的军队 */
        this.lastTurn = turn;
        this.find_new_armies();
        return;
      }
      this.lastTurn = turn;
      this.player_moves_this_turn = new Set();
    } else {
      return;
    }

    for (i = 0; i < this.map.players.length; i++) {
      player = this.map.players[i];
      if (player.team === this.map.friendly_team) continue;
      if (this.has_perfect_information_of_player_cities_and_general(player.index)) {
        this._reset_player_emergences(player.index);
      }
    }

    this.fogPaths = [];

    this.track_army_movement();
    this._post_army_track_handle_flipped_tiles();
    this._flipped_tiles.clear();

    this.find_new_armies();

    if (advancedTurn) {
      this.move_fogged_army_paths();
      this.increment_fogged_armies();
    }

    var armies = Array.from(this.armies.values());
    for (i = 0; i < armies.length; i++) {
      if (armies[i].tile.visible) armies[i].last_seen_turn = this.map.turn;
    }

    for (i = 0; i < this.map.players.length; i++) {
      if (this.map.players[i].tiles.length > 0) this.seen_player_lookup[i] = true;
    }

    for (i = 0; i < this.map.players.length; i++) {
      var general = this.map.generals[i];
      if (general !== null && general !== undefined && general.player() !== i && general.isGeneral) {
        this.map.generals[i] = null;
        general.isGeneral = false;
      }
    }
  };

  /* 别名：外部按 update()/recalculate() 调用亦可，参数与扫描入口一致 */
  P.update = function (lastMove, turn, boardAnalysis) {
    return this.scan_movement_and_emergences(lastMove, turn, boardAnalysis);
  };
  P.recalculate = function (lastMove, turn, boardAnalysis) {
    return this.scan_movement_and_emergences(lastMove, turn, boardAnalysis);
  };

  /* ================================================================== *
   * limit_player_spawn_by_good_start
   * ================================================================== */

  P.limit_player_spawn_by_good_start = function (player) {
    if (player.cityCount > 1) return;
    if (player.tileCount > 25) return;
    if (player.score > 52) return;

    var depthCheck = 15;
    var realWastesAllowed = (25 - player.tileCount) * 2;
    var pIdx = player.index;

    var tilesWithBarely = [];
    var tilesCouldntGetBetter = [];
    var biggestNegative = 0;

    var allTiles = this.map.get_all_tiles();
    for (var ti = 0; ti < allTiles.length; ti++) {
      var tile = allTiles[ti];
      if (!this.valid_general_positions_by_player[pIdx].raw[tile.tile_index]) continue;

      var wastesAllowed = realWastesAllowed;
      var foundByRange = new Array(depthCheck + 1).fill(0);

      var everOwned = this.tiles_ever_owned_by_player[pIdx];
      var foreachFunc = function (t, d) {
        if (t.visible && t.player() !== player.index && !everOwned.has(t)) return true;
        foundByRange[d] += 1;
        return false;
      };

      S().breadth_first_foreach_dist_fast_no_neut_cities(this.map, [tile], depthCheck, foreachFunc);

      var avail = wastesAllowed;
      var minValid = [1, 2, 5, 8, 10, 13, 15, 17, 19, 20, 21, 22, 23, 24, 24, 24];
      var elimmed = false;

      var exactlyMets = 0;
      var barelyMets = 0;
      for (var i = 1; i <= depthCheck; i++) {
        avail += foundByRange[i];
        var cutoff = minValid[i];
        if (cutoff > avail) {
          elimmed = true;
          this.valid_general_positions_by_player[pIdx].raw[tile.tile_index] = false;
        } else {
          if (cutoff === avail && i > 2) exactlyMets += 1;
          if (cutoff > avail - 4) barelyMets += 1;
        }
      }

      if (elimmed) continue;

      tilesWithBarely.push([exactlyMets, barelyMets, tile]);
      if (player.tileCount < 25) {
        this.emergenceLocationMap[player.index].raw[tile.tile_index] += Math.min(1.5, barelyMets / 2);
      }

      var exactPenalty = Math.min(2, exactlyMets / 2);
      if (exactPenalty > biggestNegative) biggestNegative = exactPenalty;
      this.emergenceLocationMap[player.index].raw[tile.tile_index] -= exactPenalty;

      if (wastesAllowed > 0) {
        wastesAllowed -= 2;
        avail = wastesAllowed;
        for (var i2 = 1; i2 <= depthCheck; i2++) {
          avail += foundByRange[i2];
          var cutoff2 = minValid[i2];
          if (cutoff2 > avail) elimmed = true;
        }
        if (elimmed) tilesCouldntGetBetter.push(tile);
      }
    }

    var pathable = toArray(this.map.pathable_tiles);
    for (var pi = 0; pi < pathable.length; pi++) {
      if (!this.valid_general_positions_by_player[pIdx].raw[pathable[pi].tile_index]) continue;
      this.emergenceLocationMap[player.index].raw[pathable[pi].tile_index] += biggestNegative;
    }

    for (var cb = 0; cb < tilesCouldntGetBetter.length; cb++) {
      this.emergenceLocationMap[player.index].raw[tilesCouldntGetBetter[cb].tile_index] += 3;
    }
  };

  /* ================================================================== *
   * 迷雾陆地预测
   * ================================================================== */

  P.update_fog_prediction = function (playerIndex, playersExpectedFogTileCounts, predictedGeneralLocation, force) {
    var player = this.map.players[playerIndex];
    if (
      isPlayerOnTeamWith(this.map, this.map.player_index, player.index) ||
      (player.tileDelta === 0 &&
        !this.players_with_incorrect_tile_predictions.has(player.index) &&
        !force &&
        !this.should_recalc_fog_land_by_player[player.index] &&
        this.map.players[playerIndex].tiles.length !== 0)
    ) {
      return;
    }

    if (this.should_recalc_fog_land_by_player[player.index] || this.map.players[playerIndex].tiles.length === 0) {
      if (this.map.turn < 26) return;
      this._build_fog_prediction_internal(player.index, playersExpectedFogTileCounts, predictedGeneralLocation);
      this.should_recalc_fog_land_by_player[player.index] = false;
    } else {
      this._inc_slash_dec_fog_prediction_to_get_player_tile_count_right(
        player.index,
        playersExpectedFogTileCounts,
        predictedGeneralLocation
      );
    }
  };

  P.increment_fogged_armies = function () {
    if (!this.map.is_army_bonus_turn) return;
    var armies = Array.from(this.armies.values());
    for (var i = 0; i < armies.length; i++) {
      var army = armies[i];
      if (army.tile.visible) continue;
      if (army.tile.army > army.value + 1 && army.value + 1 > army.tile.army - 2) army.value += 1;
    }
  };

  P.move_fogged_army_paths = function () {
    var armyVals = [];
    var all = Array.from(this.armies.values());
    for (var ai = 0; ai < all.length; ai++) if (!all[ai].tile.visible) armyVals.push(all[ai]);

    for (var vi = 0; vi < armyVals.length; vi++) {
      var army = armyVals[vi];
      if (ownsTilePlayer(this.map, army.player)) {
        this.scrap_army(army, false);
        continue;
      }
      if (army.last_moved_turn === this.map.turn - 1) {
        if (army.entangledValue !== null && army.tile.army < Math.max(1, Math.floor(army.entangledValue * 0.8))) {
          this.scrap_army(army, false);
          continue;
        }
        army.value = army.tile.army - 1;
        continue;
      }
      if (this.player_moves_this_turn.has(army.player)) continue;

      if (!army.visible && army.last_seen_turn < this.map.turn - 10 && (army.tile.isCity || army.tile.isGeneral)) {
        continue;
      }

      var origTile = army.tile;
      var origTileArmy = army.tile.army;

      var anyNextVisible = false;
      var fogPathNexts = new Map();
      var buildFogPathNexts = function (paths) {
        var out = new Map();
        for (var p = 0; p < paths.length; p++) {
          var path = paths[p];
          if (path === null || path === undefined) continue;
          if (path.start === null || path.start === undefined) continue;
          if (path.start.next === null || path.start.next === undefined) continue;
          if (path.start.next.tile === null || path.start.next.tile === undefined) continue;
          var nextTile = path.start.next.tile;
          if (nextTile.visible) {
            anyNextVisible = true;
            /* 走不出迷雾，那就停在原地 */
            nextTile = path.start.tile;
          }
          if (!out.has(nextTile)) out.set(nextTile, []);
          out.get(nextTile).push(path);
        }
        return out;
      };

      fogPathNexts = buildFogPathNexts(army.expectedPaths);

      /* 砍掉中途碰到可见格的期望路径，避免用过期路径把迷雾军队推错格 */
      var armyTile = army.tile;
      army.expectedPaths = army.expectedPaths.filter(function (path) {
        if (path === null || path === undefined) return false;
        var tl = path.tileList;
        for (var k = 0; k < tl.length; k++) {
          if (tl[k].visible && tl[k] !== armyTile) return false;
        }
        return true;
      });
      fogPathNexts = buildFogPathNexts(army.expectedPaths);

      var anySplitPathTouchesVisibleAfterArmy = false;
      for (var sp = 0; sp < army.expectedPaths.length; sp++) {
        var sPath = army.expectedPaths[sp];
        if (sPath === null) continue;
        var sawArmyTile = false;
        var sTiles = sPath.tileList;
        for (var spt = 0; spt < sTiles.length; spt++) {
          if (sTiles[spt] === army.tile) {
            sawArmyTile = true;
            continue;
          }
          if (sawArmyTile && sTiles[spt].visible) {
            anySplitPathTouchesVisibleAfterArmy = true;
            break;
          }
        }
        if (anySplitPathTouchesVisibleAfterArmy) break;
      }

      if (fogPathNexts.size > 1 && army.entangledValue !== null && anySplitPathTouchesVisibleAfterArmy) {
        continue;
      }

      if (fogPathNexts.size > 1) {
        army.record_fog_tile_revert(army.tile);
        this.armies.delete(army.tile);

        var nextArmies = army.get_split_for_fog(Array.from(fogPathNexts.keys()));

        var self2 = this;
        fogPathNexts.forEach(function (paths, nextTile) {
          var nextArmy = nextArmies.pop();
          nextArmy.expectedPaths = [];

          if (nextTile === origTile) {
            for (var p = 0; p < paths.length; p++) nextArmy.include_path(paths[p]);
            if (!nextArmy.scrapped) self2.armies.set(nextArmy.tile, nextArmy);
            return;
          }
          for (var p2 = 0; p2 < paths.length; p2++) {
            if (nextArmy.scrapped) break;
            var path = paths[p2];
            if (path.start !== null && path.start !== undefined && path.start.next !== null && path.start.next !== undefined) {
              if (path.start.next.tile !== nextTile) continue;
            }
            nextArmy.include_path(path);
            self2._move_fogged_army_along_path(nextArmy, path, true);
            if (nextArmy.scrapped) break;
          }
          if (!nextArmy.scrapped) self2.armies.set(nextArmy.tile, nextArmy);
        });
      } else if (fogPathNexts.size === 1) {
        for (var pth = 0; pth < army.expectedPaths.length; pth++) {
          var path1 = army.expectedPaths[pth];
          if (path1 !== null && path1 !== undefined && path1.start.next !== null && path1.start.next !== undefined && path1.start.next.tile.visible) {
            if (path1.start.tile === army.tile && army.entangledValue !== null) this.scrap_army(army, true);
            continue;
          }
          this._move_fogged_army_along_path(army, path1);
        }
      }

      if (anyNextVisible) {
        /* 可见格的兵数永远不许被改写 */
        if (!origTile.visible) origTile.army = origTileArmy;
      }
    }
  };

  P.clean_up_armies = function () {
    var armies = Array.from(this.armies.values());
    for (var i = 0; i < armies.length; i++) {
      var army = armies[i];
      if (army !== null && army !== undefined && army.tile.visible) army.last_seen_turn = this.map.turn;

      if (army.scrapped) {
        if (this.armies.get(army.tile) === army) this.armies.delete(army.tile);
        continue;
      } else if (ownsTilePlayer(this.map, army.player) && !army.tile.visible) {
        this.scrap_army(army, true);
      } else if (army.tile.visible && army.entangledArmies.length > 0 && army.tile.player() === army.player) {
        if (army.tile.army * 1.2 > army.value && army.value > (army.tile.army - 1) * 0.8) {
          this.resolve_entangled_armies(army);
        } else {
          for (var e = 0; e < army.entangledArmies.length; e++) removeFromArray(army.entangledArmies[e].entangledArmies, army);
          if (this.armies.get(army.tile) === army) this.armies.delete(army.tile);
        }
        continue;
      } else if (army.tile.delta.gainedSight && (army.tile.player() === -1 || (army.tile.player() !== army.player && army.entangledArmies.length > 0))) {
        for (var e2 = 0; e2 < army.entangledArmies.length; e2++) removeFromArray(army.entangledArmies[e2].entangledArmies, army);
        if (this.armies.get(army.tile) === army) this.armies.delete(army.tile);
      }
    }
  };

  /* ================================================================== *
   * track_army_movement 主干
   * ================================================================== */

  P.track_army_movement = function () {
    var self = this;
    var trackingArmies = new Map(); /* Tile -> Army */
    var skip = new Set(); /* Tile */

    if (this.lastMove !== null && this.lastMove !== undefined) {
      var playerMoveArmy = this.get_or_create_army_at(this.lastMove.source);
      playerMoveArmy.player = this.map.player_index;
      playerMoveArmy.value = this.lastMove.source.delta.oldArmy - 1;
      this.try_track_own_move(playerMoveArmy, skip, trackingArmies);
    }

    for (var i = 0; i < this.map.players.length; i++) {
      var player = this.map.players[i];
      if (player.index === this.map.player_index) continue;
      if (player.last_move !== null && player.last_move !== undefined) {
        var src = player.last_move[0];
        var dest = player.last_move[1];

        var armyAtSrc = this.armies.get(src);
        if (armyAtSrc === undefined || armyAtSrc === null) continue;

        if (armyAtSrc.player === player.index) {
          this.army_moved(armyAtSrc, dest, trackingArmies, true, false);
          skip.add(src);
          /* 同时跳过 dest，否则 try_track_army 会把这个 delta 当成军队又走了一次 */
          skip.add(dest);
        } else {
          this.scrap_army(armyAtSrc, false);
        }
      }
    }

    this.unaccounted_tile_diffs = new Map();
    var emgKeys = Object.keys(this.map.army_emergences);
    for (var ek = 0; ek < emgKeys.length; ek++) {
      var tile = this.map.tiles_by_index[emgKeys[ek] | 0];
      if (tile === undefined) continue;
      var diffTuple = this.map.army_emergences[emgKeys[ek]];
      var emergedAmount = diffTuple[0];
      var emergingPlayer = diffTuple[1];
      if (emergingPlayer === -1) continue;

      this.should_recalc_fog_land_by_player[emergingPlayer] = true;

      this.unaccounted_tile_diffs.set(tile, emergedAmount);

      var isMoveIntoFog =
        (0 - Tile.get_move_half_amount(tile.delta.oldArmy) === emergedAmount ||
          0 - tile.delta.oldArmy + 1 === emergedAmount) &&
        emergedAmount < 0;

      var existingArmy = this.armies.get(tile);
      if (existingArmy === undefined) existingArmy = null;

      if (isMoveIntoFog) {
        if (tile.delta.gainedSight && existingArmy) {
          this.try_split_fogged_army_back_into_fog(existingArmy, trackingArmies);
          skip.add(tile);
        }
        continue;
      }

      if (tile.delta.toTile !== null && tile.delta.toTile !== undefined) {
        if (skip.has(tile.delta.toTile)) continue;
      }

      if (existingArmy && existingArmy.player === tile.player() && existingArmy.value + 1 > tile.army) {
        this.try_split_fogged_army_back_into_fog(existingArmy, trackingArmies);
        skip.add(tile);
        continue;
      }

      if (emergedAmount < 0) emergedAmount = 0 - emergedAmount;

      var emergedArmy = this.handle_unaccounted_delta(tile, emergingPlayer, emergedAmount);
      if (emergedArmy !== null && emergedArmy !== undefined) {
        if (tile.delta.toTile !== null && tile.delta.toTile !== undefined && tile.delta.toTile.player() === emergedArmy.player) {
          this.army_moved(emergedArmy, tile.delta.toTile, trackingArmies, false, false);
          skip.add(tile.delta.toTile);
        } else {
          trackingArmies.set(tile, emergedArmy);
        }
      }
      skip.add(tile);
    }

    var allTiles = this.map.get_all_tiles();
    for (var tIdx = 0; tIdx < allTiles.length; tIdx++) {
      var tile2 = allTiles[tIdx];
      if (skip.has(tile2)) continue;
      if (this.lastMove !== null && this.lastMove !== undefined && tile2 === this.lastMove.source) continue;
      if (tile2.delta.oldOwner === this.map.player_index) continue;
      if (tile2.delta.toTile === null || tile2.delta.toTile === undefined) continue;
      if (tile2.isUndiscoveredObstacle || tile2.isMountain) continue;
      if (tile2.delta.toTile.isMountain) continue;

      /*
       * 地图判定「从一个我们没有追踪军队的迷雾格出发的移动」时，真正的军队在更深的
       * 迷雾里。先回溯迷雾源头，只有当它接到一支已追踪的军队时才推进那支军队，
       * 否则会在源头再凭空造一个重复的 army。
       */
      var armyDetectedAsMove = null;
      var sourcedFromFog = false;
      if (!tile2.visible && !this.armies.has(tile2) && tile2.delta.armyDelta !== 0 && !this.skip_emergence_tile_pathings.has(tile2)) {
        var fogSourceDelta = Math.abs(tile2.delta.armyDelta);
        var fogSourceDepthLimit = this.get_emergence_max_depth_to_general_or_none(tile2.player(), tile2, fogSourceDelta, false);
        var sourceFogArmyPath = this.find_fog_source(tile2.player(), tile2, fogSourceDelta, fogSourceDepthLimit);
        if (sourceFogArmyPath !== null && sourceFogArmyPath !== undefined) {
          var leadsToTrackedArmy = false;
          var node = sourceFogArmyPath.start.next;
          while (node !== null && node !== undefined) {
            var existing = this.armies.get(node.tile);
            if (existing !== undefined && existing !== null && this.is_friendly_team(existing.player, tile2.player())) {
              leadsToTrackedArmy = true;
              break;
            }
            node = node.next;
          }
          if (leadsToTrackedArmy) {
            armyDetectedAsMove = this.resolve_fog_emergence(tile2.player(), sourceFogArmyPath, tile2);
            if (armyDetectedAsMove !== null) sourcedFromFog = true;
          }
        }
      }
      if (armyDetectedAsMove === null) armyDetectedAsMove = this.get_or_create_army_at(tile2);
      this.army_moved(armyDetectedAsMove, tile2.delta.toTile, trackingArmies, false, false);
      if (sourcedFromFog) {
        /* 源头格上残留的正 delta 会被后面的 try_track_army 当成「又走回去」，标记掉 */
        skip.add(tile2);
        if (tile2.delta.toTile !== null && tile2.delta.toTile !== undefined) skip.add(tile2.delta.toTile);
      }
      if (tile2.delta.toTile.isUndiscoveredObstacle) {
        var toTile = this.map.tiles_by_index[tile2.delta.toTile.tile_index];
        toTile.isCity = true;
        toTile.setPlayer(armyDetectedAsMove.player);
        toTile.army = armyDetectedAsMove.value;
      }
      armyDetectedAsMove.update();
      if (!tile2.delta.toTile.visible) {
        armyDetectedAsMove.value = tile2.delta.toTile.army - 1;
      }
    }

    var sortedArmies = Array.from(this.armies.values());
    var general = this.general;
    var entries = [];
    for (var sa = 0; sa < sortedArmies.length; sa++) {
      entries.push([distBetween(this.map, general, sortedArmies[sa].tile), sa, sortedArmies[sa]]);
    }
    entries.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] - b[0];
      return a[1] - b[1];
    });
    for (var se = 0; se < entries.length; se++) {
      var army = entries[se][2];
      if (army.player === this.map.player_index) {
        if (army.last_moved_turn < this.map.turn - 1 && army.tile.army < this.track_threshold) {
          this.scrap_army(army, false);
        } else {
          army.update();
        }
        continue;
      }
      this.try_track_army(army, skip, trackingArmies);
    }

    this.scrap_unmoved_low_armies();

    /*
     * 键必须取 army.tile 而不是 trackingArmies 的键：trackingArmies 里可能残留在
     * 旧格键上的 army（army_moved 已经把 army.tile 推到新格），按旧键落库会在
     * self.armies 里留两个键指向同一支军队，下一回合就会凭空多出一支幽灵军队。
     */
    trackingArmies.forEach(function (army) {
      self.armies.set(army.tile, army);
    });

    this.clean_up_armies();
  };

  P.find_visible_source = function (tile) {
    if (tile.delta.armyDelta === 0) return null;
    var i, adjacent, unexplainedAdjDelta, isMatch;

    for (i = 0; i < tile.movable.length; i++) {
      adjacent = tile.movable[i];
      unexplainedAdjDelta = this.unaccounted_tile_diffs.has(adjacent)
        ? this.unaccounted_tile_diffs.get(adjacent)
        : adjacent.delta.armyDelta;
      isMatch = tile.delta.armyDelta + unexplainedAdjDelta === 0;
      if (isMatch) return adjacent;
    }

    for (i = 0; i < tile.movable.length; i++) {
      adjacent = tile.movable[i];
      unexplainedAdjDelta = this.unaccounted_tile_diffs.has(adjacent)
        ? this.unaccounted_tile_diffs.get(adjacent)
        : adjacent.delta.armyDelta;
      isMatch = 2 >= tile.delta.armyDelta + unexplainedAdjDelta && tile.delta.armyDelta + unexplainedAdjDelta >= -2;
      if (isMatch) return adjacent;
    }

    return null;
  };

  P.army_moved = function (army, toTile, trackingArmies, dontUpdateOldFogArmyTile, allowVisiblePlayerMismatch) {
    dontUpdateOldFogArmyTile = !!dontUpdateOldFogArmyTile;
    allowVisiblePlayerMismatch = !!allowVisiblePlayerMismatch;
    var oldTile = army.tile;
    var existingArmy = this.armies.get(army.tile);
    this.armies.delete(army.tile);

    if (army.visible && toTile.was_visible_last_turn()) {
      this.player_moves_this_turn.add(army.player);
    }

    var existingTracking = trackingArmies.get(toTile);
    if (existingTracking === undefined) existingTracking = null;

    if (existingTracking === null || existingTracking.value < army.value || existingTracking.player !== toTile.player()) {
      trackingArmies.set(toTile, army);
    }

    var potentialMergeOrKilled = this.armies.get(toTile);
    if (potentialMergeOrKilled === undefined) potentialMergeOrKilled = null;
    if (potentialMergeOrKilled !== null) {
      if (potentialMergeOrKilled.player === army.player) {
        this.merge_armies(army, potentialMergeOrKilled, toTile, trackingArmies);
      } else if (toTile.visible && toTile.army <= 1 && toTile.delta.armyDelta < 0) {
        var possibleMovedTarget = null;
        var candidateMovedTargets = [];
        for (var i = 0; i < toTile.movable.length; i++) {
          var adjacent = toTile.movable[i];
          if (adjacent.isMountain || adjacent.player() !== army.player || !adjacent.visible) continue;
          candidateMovedTargets.push(adjacent);
          if (possibleMovedTarget !== null) {
            possibleMovedTarget = null;
            break;
          }
          possibleMovedTarget = adjacent;
        }
        if (possibleMovedTarget === null && candidateMovedTargets.length > 0) {
          var targetGeneral = this.map.generals[potentialMergeOrKilled.player];
          if (targetGeneral !== null && targetGeneral !== undefined) {
            var bestDist = null;
            for (var c = 0; c < candidateMovedTargets.length; c++) {
              var adj = candidateMovedTargets[c];
              var dist = Math.abs(adj.x - targetGeneral.x) + Math.abs(adj.y - targetGeneral.y);
              if (bestDist === null || dist < bestDist) {
                bestDist = dist;
                possibleMovedTarget = adj;
              } else if (dist === bestDist) {
                possibleMovedTarget = null;
              }
            }
          }
        }
        if (possibleMovedTarget !== null) {
          this.army_moved(potentialMergeOrKilled, possibleMovedTarget, trackingArmies, false, true);
        } else if (toTile.delta.toTile === null || toTile.delta.toTile === undefined) {
          this.collide_armies(army, potentialMergeOrKilled, toTile, trackingArmies);
        }
      } else if (toTile.delta.toTile === null || toTile.delta.toTile === undefined) {
        this.collide_armies(army, potentialMergeOrKilled, toTile, trackingArmies);
      }
    }

    army.update_tile(toTile);

    if (army.value < -1 || (army.player !== army.tile.player() && army.tile.visible && !allowVisiblePlayerMismatch)) {
      this.scrap_army(army, false);
    }
    if (army.tile.visible && army.entangledArmies.length > 0) this.resolve_entangled_armies(army);

    if (!oldTile.visible && !dontUpdateOldFogArmyTile) {
      oldTile.army = 1;
      oldTile.setPlayer(army.player);
      if (this.map.is_army_bonus_turn) oldTile.army += 1;
      if ((oldTile.isCity || oldTile.isGeneral) && this.map.is_city_bonus_turn) oldTile.army += 1;
    }

    if (army.scrapped) {
      army.expectedPaths = [];
    } else {
      this.armies.set(toTile, army);
      army.expectedPaths = ArmyTracker.get_army_expected_path(
        this.map,
        army,
        this.general,
        this.player_targets,
        null,
        this.log_debug
      );
    }

    if (army.last_seen_turn > this.map.turn - 6) army.last_moved_turn = this.map.turn - 1;

    for (var l = 0; l < this.notify_army_moved.length; l++) this.notify_army_moved[l](army);
  };

  P.scrap_army = function (army, scrapEntangled) {
    scrapEntangled = !!scrapEntangled;
    this.restore_fog_tile_reverts(army);
    army.scrapped = true;
    if (scrapEntangled) {
      for (var i = 0; i < army.entangledArmies.length; i++) {
        var entangledArmy = army.entangledArmies[i];
        this.restore_fog_tile_reverts(entangledArmy);
        entangledArmy.scrapped = true;
      }
      this.resolve_entangled_armies(army);
    } else {
      for (var k = 0; k < army.entangledArmies.length; k++) removeFromArray(army.entangledArmies[k].entangledArmies, army);
    }
  };

  P.restore_fog_tile_reverts = function (army) {
    var self = this;
    army.fogTileReverts.forEach(function (revert) {
      /* 可见格的兵数永远不许被改写 */
      if (revert.tile.visible) return;
      /* 已经被确认为别人的将军格的，旧快照不许把它降级回臆测归属 */
      if (revert.tile.isGeneral && revert.tile.player() !== revert.player && revert.tile.player() !== -1) return;
      revert.tile.army = revert.army;
      revert.tile.setPlayer(revert.player);
      revert.tile.isTempFogPrediction = revert.isTempFogPrediction;
    });
    army.fogTileReverts = new Map();
    void self;
  };

  P.resolve_entangled_armies = function (army) {
    if (army.entangledArmies.length > 0) {
      var resolvedByTile = new Set();
      for (var i = 0; i < army.entangledArmies.length; i++) {
        var entangledArmy = army.entangledArmies[i];
        if (this.armies.get(entangledArmy.tile) === entangledArmy) this.armies.delete(entangledArmy.tile);
        entangledArmy.scrapped = true;
        if (entangledArmy.entangledValue === null) {
          entangledArmy.entangledArmies = [];
          continue;
        }
        if (resolvedByTile.has(entangledArmy.tile)) {
          entangledArmy.entangledArmies = [];
          continue;
        }
        resolvedByTile.add(entangledArmy.tile);
        /* 可见格的兵数永远不许被改写 */
        if (!entangledArmy.tile.visible && entangledArmy.tile.army > 0) {
          var newArmy = Math.max(entangledArmy.tile.army - entangledArmy.entangledValue, 1);
          entangledArmy.tile.army = newArmy;
          if (!entangledArmy.tile.discovered && entangledArmy.tile.player() >= 0) this.reset_temp_tile_marked(entangledArmy.tile);
          /* 迷雾里还剩真实的残余军队，得给它单独留一个 tracker，只减兵数会把这支军队弄丢 */
          if (newArmy > 1) {
            var residualArmy = new Army(entangledArmy.tile);
            residualArmy.value = newArmy - 1;
            residualArmy.last_seen_turn = entangledArmy.last_seen_turn;
            residualArmy.last_moved_turn = this.map.turn - 1;
            residualArmy.expectedPaths = ArmyTracker.get_army_expected_path(
              this.map,
              residualArmy,
              this.general,
              this.player_targets,
              null,
              this.log_debug
            );
            this.armies.set(entangledArmy.tile, residualArmy);
          }
        }
        entangledArmy.entangledArmies = [];
      }
      army.entangledArmies = [];
    }
  };

  P.army_could_capture = function (army, fogTargetTile) {
    if (army.player !== fogTargetTile.player()) return army.value > fogTargetTile.army;
    return true;
  };

  P.move_army_into_fog = function (army, fogTargetTile) {
    this.armies.delete(army.tile);

    var existingTargetFoggedArmy = this.armies.get(fogTargetTile);
    if (existingTargetFoggedArmy === undefined) existingTargetFoggedArmy = null;
    if (existingTargetFoggedArmy !== null) {
      if (existingTargetFoggedArmy.entangledArmies.indexOf(army) >= 0) {
        army.scrapped = true;
        return;
      }
    }

    var movingPlayer = this.map.players[army.player];

    if (!fogTargetTile.visible) {
      army.record_fog_tile_revert(fogTargetTile);
      if (isPlayerOnTeamWith(this.map, fogTargetTile.player(), army.player)) {
        fogTargetTile.army += army.value;
        if (!fogTargetTile.isGeneral) {
          var oldPlayer = pAt(this.map, fogTargetTile.player());
          removeFromArray(oldPlayer.tiles, fogTargetTile);
          if (!fogTargetTile.discovered && fogTargetTile.player() !== army.player) fogTargetTile.isTempFogPrediction = true;
          fogTargetTile.setPlayer(army.player);
          movingPlayer.tiles.push(fogTargetTile);
        }
      } else {
        fogTargetTile.army -= army.value;
        if (fogTargetTile.army < 0) {
          fogTargetTile.army = 0 - fogTargetTile.army;
          var oldPlayer2 = pAt(this.map, fogTargetTile.player());
          removeFromArray(oldPlayer2.tiles, fogTargetTile);
          movingPlayer.tiles.push(fogTargetTile);
          fogTargetTile.setPlayer(army.player);
        }
      }
    }
    army.update_tile(fogTargetTile);
    army.value = fogTargetTile.army - 1;
    this.armies.set(fogTargetTile, army);
    for (var i = 0; i < this.notify_army_moved.length; i++) this.notify_army_moved[i](army);
  };

  /*
   * 地图告诉我们「这一格上的军队其实是往迷雾里走掉了」。把它塞回迷雾：
   * 有两个候选迷雾格就当纠缠拆开，只有一个就整体推回去。不这么做的话，
   * 留在可见格上的预测会被之后的 round 当成还在原地，造成幽灵军队。
   */
  P.try_split_fogged_army_back_into_fog = function (army, trackingArmies) {
    var potential = [];
    for (var i = 0; i < army.tile.movable.length; i++) {
      var adj = army.tile.movable[i];
      if (!adj.visible && !adj.isMountain && !adj.isUndiscoveredObstacle) potential.push(adj);
    }

    this.armies.delete(army.tile);
    trackingArmies.delete(army.tile);

    if (potential.length > 1) {
      var entangledArmies = army.get_split_for_fog(potential);
      for (var k = 0; k < potential.length; k++) {
        this._push_fogged_army_guess_back_to_fog_tile(entangledArmies[k], potential[k], trackingArmies);
      }
    } else if (potential.length === 1) {
      this._push_fogged_army_guess_back_to_fog_tile(army, potential[0], trackingArmies);
    }
  };

  P._push_fogged_army_guess_back_to_fog_tile = function (army, fogTargetTile, trackingArmies) {
    this.fog_back_push_touched_tiles_this_turn.add(fogTargetTile);

    var existingArmy = this.armies.get(fogTargetTile);
    if (existingArmy === undefined) existingArmy = null;
    if (existingArmy !== null) {
      if (existingArmy === army) {
        existingArmy = null;
      } else if (
        army.entangledArmies.indexOf(existingArmy) >= 0 ||
        existingArmy.entangledArmies.indexOf(army) >= 0
      ) {
        /* 目标格上的纠缠兄弟已经代表了这支军队，别合并出双倍兵力 */
        existingArmy.last_moved_turn = this.map.turn - 1;
        existingArmy.value = existingArmy.tile.army - 1;
        this.scrap_army(army, false);
        return;
      } else {
        this.scrap_army(army, false);
        return;
      }
    }

    var oldTile = army.tile;
    this.armies.delete(oldTile);
    trackingArmies.delete(oldTile);
    this.unaccounted_tile_diffs.delete(oldTile);
    this.unaccounted_tile_diffs.delete(fogTargetTile);

    if (oldTile.visible) {
      army.record_fog_tile_revert(oldTile);
      /* 可见格的兵力是服务器事实，绝不回写 */
    }

    army.record_fog_tile_revert(fogTargetTile);
    if (fogTargetTile.player() !== army.player && !fogTargetTile.discovered) {
      fogTargetTile.isTempFogPrediction = true;
    }
    if (fogTargetTile.player() !== army.player && !fogTargetTile.isGeneral) {
      var oldPlayer = pAt(this.map, fogTargetTile.player());
      removeFromArray(oldPlayer.tiles, fogTargetTile);
      if (this.map.players[army.player].tiles.indexOf(fogTargetTile) < 0) {
        this.map.players[army.player].tiles.push(fogTargetTile);
      }
      fogTargetTile.setPlayer(army.player);
    }

    fogTargetTile.army = Math.max(1, army.value + 1);
    army.update_tile(fogTargetTile);
    army.value = fogTargetTile.army - 1;
    army.last_moved_turn = this.map.turn - 1;
    trackingArmies.set(fogTargetTile, army);
    this.armies.set(fogTargetTile, army);
    for (var i = 0; i < this.notify_army_moved.length; i++) this.notify_army_moved[i](army);
  };

  P.get_nearby_armies = function (army, armyMap) {
    if (armyMap === undefined || armyMap === null) armyMap = this.armies;
    var nearbyArmies = [];
    for (var i = 0; i < army.tile.movable.length; i++) {
      var tile = army.tile.movable[i];
      if (armyMap.has(tile)) nearbyArmies.push(armyMap.get(tile));
      for (var k = 0; k < tile.movable.length; k++) {
        var nextTile = tile.movable[k];
        if (nextTile !== army.tile && armyMap.has(nextTile)) nearbyArmies.push(armyMap.get(nextTile));
      }
    }
    return nearbyArmies;
  };

  P.find_new_armies = function () {
    var playerLargest = [];
    for (var pl = 0; pl < this.map.players.length; pl++) playerLargest.push(null);

    if (this.map.is_army_bonus_turn) this.update_track_threshold();

    for (var i = 0; i < this.map.players.length; i++) {
      var player = this.map.players[i];
      for (var t = 0; t < player.tiles.length; t++) {
        var tile = player.tiles[t];
        if (this.fog_back_push_touched_tiles_this_turn.has(tile) && !this.armies.has(tile)) continue;

        if (!this.armies.has(tile) && !tile.visible && (tile.isCity || tile.isGeneral)) continue;

        var notOurMove =
          this.lastMove === null ||
          this.lastMove === undefined ||
          (tile !== this.lastMove.source && tile !== this.lastMove.dest);

        var tileNewlyMovedByEnemy =
          !this.armies.has(tile) &&
          !tile.delta.gainedSight &&
          tile.player() !== this.map.player_index &&
          Math.abs(tile.delta.armyDelta) > 2 &&
          tile.army > 2 &&
          notOurMove;

        var isTileValidForArmy = playerLargest[tile.player()] === tile || tile.army > this.track_threshold || tileNewlyMovedByEnemy;

        if (isTileValidForArmy) {
          var tileArmy = this.armies.get(tile);
          if (tileArmy === undefined) tileArmy = null;
          if (tileArmy === null || tileArmy.scrapped) {
            var army = this.get_or_create_army_at(tile, !tile.visible && (tile.isCity || tile.isGeneral));
            if (!army.visible) army.value = army.tile.army - 1;
            else army.last_seen_turn = this.map.turn;
          }
        }
      }
    }
  };

  P.new_army_emerged = function (emergedTile, armyEmergenceValue, emergingPlayer, distance) {
    if (emergingPlayer === undefined || emergingPlayer === null) emergingPlayer = -1;
    if (distance === undefined) distance = null;

    if (emergedTile.player() === this.map.player_index || this.map.teammates.has(emergedTile.player())) return;

    if (emergingPlayer === -1) {
      emergingPlayer = emergedTile.player();
      if (emergingPlayer === -1) throw new Error('neutral army emergence...?');
    }

    this.unrecaptured_emergence_events[emergingPlayer].add(emergedTile);

    if (!this.has_perfect_information_of_player_cities_and_general(emergingPlayer)) {
      if (distance === null) {
        distance = Math.max(10, this.min_spawn_distance) + 1;
        if (this.map.turn < 300) distance = Math.max(distance, Math.floor(this.map.turn / 4));
        else distance = 75;
      }

      armyEmergenceValue = 2 + Math.pow(armyEmergenceValue, 0.75);
      if (armyEmergenceValue > 10) armyEmergenceValue = 10;

      var armyEmergenceScaledToTurns = (5 * armyEmergenceValue) / (5 + Math.floor(this.map.turn / 25));

      var distancePlateau = Math.max(1, Math.min(distance - 1, 5));
      var self = this;
      var emergedPlayerIdx = emergedTile.player();

      var foreachFunc = function (tile, dist) {
        if (!tile.discovered) {
          var distCapped = Math.max(distancePlateau, dist);
          var emergeValue = Math.floor((distancePlateau * armyEmergenceScaledToTurns) / distCapped);
          self.emergenceLocationMap[emergedPlayerIdx].raw[tile.tile_index] += Math.max(1, emergeValue);
        }
        var visibleOrDiscNeut = tile.was_visible_last_turn() || (tile.discoveredAsNeutral && self.map.turn <= 100);
        return (tile.isObstacle || visibleOrDiscNeut) && tile !== emergedTile;
      };

      S().breadth_first_foreach_dist(this.map, [emergedTile], distance, foreachFunc, null, false, true);

      if (this.uneliminated_emergence_events[emergedPlayerIdx].size < 8) {
        this.limit_gen_position_from_emergence(this.map.players[emergedPlayerIdx], emergedTile, armyEmergenceValue);
      }
    }

    for (var i = 0; i < this.notify_unresolved_army_emerged.length; i++) this.notify_unresolved_army_emerged[i](emergedTile);
  };

  P.tile_discovered_neutral = function (neutralTile) {
    this.drop_incorrect_player_fog_around(neutralTile, neutralTile.delta.oldOwner);
  };

  P.is_friendly_team = function (p1, p2) {
    if (p1 === p2) return true;
    if (p1 < 0 || p2 < 0) return false;
    if (this.map.teams !== null && this.map.teams[p1] === this.map.teams[p2]) return true;
    return false;
  };

  P.is_enemy_team = function (p1, p2) {
    if (p1 === p2) return false;
    if (p1 < 0 || p2 < 0) return false;
    if (this.map.teams !== null && this.map.teams[p1] !== this.map.teams[p2]) return true;
    return false;
  };

  P.notify_seen_player_tile = function (tile) {
    this._flipped_tiles.add(tile);
  };

  P.notify_concrete_emergence = function (maxDist, emergingTile, confidentFromGeneral) {
    var player = emergingTile.player();
    // py 可以是 -1（中立格当作涌现来源），负索引落到最后一个玩家；JS 原样取会拿到 undefined
    var unrecaptured = byPlayer(this.unrecaptured_emergence_events, player);
    if (unrecaptured) unrecaptured.add(emergingTile);
    this._limit_general_position_to_within_tile_and_distance(player, emergingTile, maxDist, false, true, confidentFromGeneral, -1, false);
    var emgMap = byPlayer(this.emergenceLocationMap, player);
    if (!emgMap) return;
    if (confidentFromGeneral) {
      var tiles = this.map.get_all_tiles();
      for (var i = 0; i < tiles.length; i++) emgMap.raw[tiles[i].tile_index] /= 5.0;
    }

    var incTiles = [];
    var foreachFunc = function (curTile, dist) {
      if (dist === 0) return false;
      incTiles.push([curTile, dist]);
      return curTile.visible && curTile !== emergingTile;
    };
    S().breadth_first_foreach_dist(this.map, [emergingTile], maxDist, foreachFunc);

    var incAmount;
    if (incTiles.length === 0) incAmount = 20;
    else incAmount = 500 / incTiles.length;

    for (var k = 0; k < incTiles.length; k++) {
      this.emergenceLocationMap[player].raw[incTiles[k][0].tile_index] += incAmount;
    }
  };

  /* ================================================================== *
   * 迷雾源头搜索
   * ================================================================== */

  P.find_fog_source = function (armyPlayer, tile, delta, depthLimit) {
    var self = this;
    if (delta === undefined || delta === null) delta = Math.abs(tile.delta.armyDelta);

    var armyPlayerObj = this.map.players[armyPlayer];

    if (depthLimit === undefined || depthLimit === null) {
      depthLimit = this.min_spawn_distance;
      if (this.map.turn > 75) depthLimit += 15;
    }

    var missingCities = Math.max(
      0,
      armyPlayerObj.cityCount -
        1 -
        S().where(armyPlayerObj.cities, function (c) {
          return c.discovered;
        }).length
    );

    var allowVisionlessObstaclesAndCities = false;
    var candidates = S().where(tile.movable, function (adj) {
      return !adj.isNotPathable && adj.was_not_visible_last_turn();
    });

    var wasDiscoveredEnemyTile = tile.delta.oldOwner === -1 && tile.delta.gainedSight;

    var prioritizeCityWallSource = this.detect_army_likely_breached_wall(armyPlayer, tile, delta);

    var emergenceMap = this.emergenceLocationMap[armyPlayer];
    var tilesEverOwned = this.tiles_ever_owned_by_player[armyPlayer];
    var validGenPositions = this.valid_general_positions_by_player[armyPlayer];

    if (candidates.length === 0 || missingCities > 0) {
      if (missingCities > 0) allowVisionlessObstaclesAndCities = true;
      else return null;
    }

    var valFunc = function (thisTile, prioObject) {
      var distWeighted = prioObject[0];
      var dist = prioObject[1];
      var negArmy = prioObject[2];
      var turnsNegative = prioObject[3];
      var citiesConverted = prioObject[4];
      var negBonusScore = prioObject[5];
      var consecUndisc = prioObject[6];
      var meetsCriteria = prioObject[7];
      void distWeighted;
      void turnsNegative;
      void consecUndisc;

      if (dist === 0) return null;
      if (citiesConverted > missingCities) return null;
      if (!meetsCriteria) return null;

      var val = 0;
      if (negArmy > 3 * dist + 3) val = -10000 - negArmy * 10;
      else if (negArmy > 0) val = -5000 - negArmy * 10;
      else val = negArmy * 10;

      if (self.is_friendly_team(thisTile.player(), armyPlayer) && thisTile.army > 8) {
        var negMhArmy = negArmy + Math.floor(thisTile.army / 2);
        var moveHalfVal;
        if (negMhArmy > 3 * dist + 3) moveHalfVal = -10000 - negMhArmy * 10;
        else if (negMhArmy > 0) moveHalfVal = -5000 - negMhArmy * 10;
        else moveHalfVal = negMhArmy * 10;
        if (moveHalfVal > val) val = moveHalfVal;
      } else if (!thisTile.discovered) {
        var undiscValOffset = 3 - 3 / Math.max(1.0, self.emergenceLocationMap[armyPlayer].raw[thisTile.tile_index]);
        val += undiscValOffset;
      }

      var bonus = Math.max(0, 0 - negBonusScore);
      var bonusPts = Math.pow(bonus, 0.25) - 1;
      var combined = val - citiesConverted * 10 - dist + bonusPts;
      return [combined, 0 - citiesConverted];
    };

    var prioFunc = function (nextTile, prioObject) {
      var distWeighted = prioObject[0];
      var dist = prioObject[1];
      var negArmy = prioObject[2];
      var turnsNeg = prioObject[3];
      var citiesConverted = prioObject[4];
      var negBonusScore = prioObject[5];
      var consecutiveUndiscovered = prioObject[6];
      var meetsCriteria = prioObject[7];

      var theArmy = self.armies.get(nextTile);
      if (theArmy === undefined) theArmy = null;

      if (theArmy !== null) {
        consecutiveUndiscovered = 0;
        if (self.is_friendly_team(theArmy.player, armyPlayer)) negArmy -= theArmy.value;
        else negArmy += theArmy.value;
      } else if (nextTile.isUndiscoveredObstacle || (!nextTile.visible && nextTile.isCostlyNeutralCity)) {
        citiesConverted += 1;
        if (citiesConverted > missingCities) return null;

        var undiscVal = self.emergenceLocationMap[armyPlayer].raw[nextTile.tile_index];

        if (nextTile.discovered) negBonusScore -= 5;

        if (prioritizeCityWallSource) {
          if (nextTile.isUndiscoveredObstacle) {
            negBonusScore -= undiscVal;
            negBonusScore += distBetween(self.map, self.general, nextTile) * 5;
            for (var i = 0; i < nextTile.movable.length; i++) {
              var t = nextTile.movable[i];
              if (!self.map.is_tile_on_team_with(t, armyPlayer) && t.visible && !t.isObstacle) negBonusScore += 1;
            }
          } else {
            negBonusScore -= undiscVal;
          }
          dist += 1;
        } else {
          negBonusScore += 150 / (undiscVal + 1);
          dist += 5;
        }

        consecutiveUndiscovered += 1;
      } else {
        if (!nextTile.discovered) {
          consecutiveUndiscovered += 1;
          var undiscVal2 = emergenceMap.raw[nextTile.tile_index];
          negBonusScore -= undiscVal2;
        } else {
          consecutiveUndiscovered = 0;
        }
        if (self.is_friendly_team(nextTile.player(), armyPlayer)) negArmy -= nextTile.army - 1;
        else if (nextTile.discovered) negArmy += nextTile.army + 1;
      }

      if (!meetsCriteria && !nextTile.was_visible_last_turn()) {
        meetsCriteria = tilesEverOwned.has(nextTile) || validGenPositions.has(nextTile) || theArmy !== null;
      }

      if (negArmy <= 0) turnsNeg += 1;
      dist += 1;
      return [dist * citiesConverted, dist, negArmy, turnsNeg, citiesConverted, negBonusScore, consecutiveUndiscovered, meetsCriteria];
    };

    var fogSkipFunc = function (nextTile, prioObject) {
      if (prioObject === null || prioObject === undefined) return true;
      var dist = prioObject[1];
      var turnsNegative = prioObject[3];
      var citiesConverted = prioObject[4];
      var consecutiveUndiscovered = prioObject[6];

      if (citiesConverted > missingCities) return true;
      if (nextTile.isGeneral && nextTile.player() !== armyPlayer) return true;

      return (
        (nextTile.visible &&
          !nextTile.delta.gainedSight &&
          !(wasDiscoveredEnemyTile && self.is_friendly_team(nextTile.player(), tile.player()))) ||
        turnsNegative > 7 ||
        consecutiveUndiscovered > 20 ||
        dist > 30
      );
    };

    var inputTiles = new Map();
    inputTiles.set(tile, [[0, 0, delta, 0, 0, 0, 0, false], 0]);

    var fogSourcePath = S().breadth_first_dynamic_max(this.map, inputTiles, valFunc, {
      maxTurns: depthLimit,
      maxDepth: depthLimit,
      maxTime: 1.0,
      noNeutralCities: !allowVisionlessObstaclesAndCities,
      noNeutralUndiscoveredObstacles: !allowVisionlessObstaclesAndCities,
      priorityFunc: prioFunc,
      skipFunc: fogSkipFunc,
      searchingPlayer: armyPlayer,
      noLog: false
    });
    return fogSourcePath;
  };

  /* ================================================================== *
   * 城市信息（雾中城市的猜测与修正）
   * ================================================================== */

  P.find_next_fog_city_candidate_near_tile = function (
    cityPlayer,
    tile,
    cutoffDist,
    distanceWeightReduction,
    wallBreakWeight,
    emergenceWeight,
    doNotConvert,
    forceConnected
  ) {
    /*
     * [BOARD] 原文这里要读 _boardAnalysis.intergeneral_analysis.aMap 与
     * enemy_wall_breach_scores。BoardAnalyzer 未移植，_boardAnalysis 恒为 null，
     * 因此整段「找雾中城市候选」在这里退化为「找不到」。
     * 影响面：check_need_to_shift_fog_city / _find_replacement_fog_city_internal /
     * try_find_army_sink 的 tookNeutCity 分支会因此不做城市替换或转换。
     */
    if (this._boardAnalysis === null || this._boardAnalysis === undefined) return null;

    var self = this;
    var armyPlayerObj = this.map.players[cityPlayer];
    var missingCities = armyPlayerObj.cityCount - 1 - armyPlayerObj.cities.length;
    if (missingCities <= 0) return null;

    var gen = this.map.players[this.map.player_index].general;
    var genMapRaw = this._boardAnalysis.intergeneral_analysis.aMap.raw;
    var alliedPlayers = this.map.get_teammates(cityPlayer);

    var valFunc = function (thisTile, prioObject) {
      var dist = prioObject[0];
      var validLocation = prioObject[2];
      if (!validLocation) return null;

      if (forceConnected) {
        var anyConn = false;
        for (var i = 0; i < thisTile.movable.length; i++) {
          if (alliedPlayers.indexOf(thisTile.movable[i].player()) >= 0) anyConn = true;
          break;
        }
        if (!anyConn) return null;
      }

      if (thisTile.visible || thisTile === tile || dist === 0) return null;

      var isPotentialFogCity = thisTile.isCity && thisTile.isNeutral;
      isPotentialFogCity = isPotentialFogCity || thisTile.isUndiscoveredObstacle;
      if (!isPotentialFogCity) return null;

      var wallBreakBonus = self._boardAnalysis.enemy_wall_breach_scores.raw[thisTile.tile_index];
      if (!wallBreakBonus || wallBreakBonus < 3) wallBreakBonus = 0;
      else wallBreakBonus = wallBreakBonus * wallBreakWeight;

      var emergenceVal =
        (1 +
          self.emergenceLocationMap[cityPlayer].raw[thisTile.tile_index] * emergenceWeight +
          wallBreakBonus) /
        (dist + distanceWeightReduction);
      return [emergenceVal, true];
    };

    var prioFunc = function (nextTile, prioObject) {
      var dist = prioObject[0];
      var validLocation = prioObject[2];
      dist += 1;
      if (nextTile.isUndiscoveredObstacle) {
        dist += 2;
        for (var i = 0; i < nextTile.movable.length; i++) {
          var t = nextTile.movable[i];
          if (t.isObstacle) continue;
          if (genMapRaw[nextTile.tile_index] + 4 < genMapRaw[t.tile_index] && genMapRaw[t.tile_index] < 150) dist -= 2;
        }
      }
      if (!validLocation) dist += 0.5;
      if (dist > 1) validLocation = true;
      return [dist, 0, validLocation];
    };

    var fogSkipFunc = function (nextTile, prioObject) {
      if (prioObject === null || prioObject === undefined) return true;
      var dist = prioObject[0];
      return (nextTile.visible && !nextTile.delta.gainedSight) || dist > cutoffDist;
    };

    var inputTiles = new Map();
    inputTiles.set(tile, [[0, 0, true], 0]);
    for (var pi = 0; pi < this.map.players.length; pi++) {
      var cities = this.map.players[pi].cities;
      for (var c = 0; c < cities.length; c++) {
        if (cities[c].discovered) continue;
        inputTiles.set(cities[c], [[-2, 0, false], 0]);
      }
    }

    var fogSourcePath = S().breadth_first_dynamic_max(this.map, inputTiles, valFunc, {
      maxTime: 100000.0,
      noNeutralCities: false,
      noNeutralUndiscoveredObstacles: false,
      priorityFunc: prioFunc,
      skipFunc: fogSkipFunc,
      searchingPlayer: cityPlayer,
      noLog: true
    });
    if (fogSourcePath !== null && fogSourcePath !== undefined) {
      var newFogCity = fogSourcePath.tail.tile;
      if (!doNotConvert) this.convert_fog_city_to_player_owned(newFogCity, cityPlayer);
      return newFogCity;
    }
    void gen;
    return null;
  };

  P.remove_nearest_fog_city = function (cityPlayerIndex, tile, distanceIfNotExcessCities) {
    var cityPlayer = this.map.players[cityPlayerIndex];
    var extraCities = cityPlayer.cities.length + 1 - cityPlayer.cityCount;

    var skipTiles = new Set();
    var allTiles = this.map.get_all_tiles();
    for (var i = 0; i < allTiles.length; i++) {
      if (allTiles[i].discoveredAsNeutral && allTiles[i].delta.discovered) skipTiles.add(allTiles[i]);
    }

    var badCityPath = S().breadth_first_find_queue(
      this.map,
      [tile],
      function (t) {
        return t.isCity && !t.discovered && t.player() === cityPlayerIndex;
      },
      { maxDepth: 200, skipTiles: skipTiles, bypassDefaultSkipLogic: true, noLog: true }
    );

    if (badCityPath !== null && badCityPath !== undefined) {
      var badCity = badCityPath.tail.tile;
      if (extraCities > 0 || badCityPath.length <= distanceIfNotExcessCities) {
        this.reset_temp_tile_marked(badCity, false);
        extraCities -= 1;
      }
    }
  };

  P.rescan_city_information = function () {
    var updated = Array.from(this.updated_city_tiles);
    for (var i = 0; i < updated.length; i++) {
      this.check_need_to_shift_fog_city(updated[i]);
      this.check_if_this_city_was_actual_fog_city_location(updated[i]);
    }

    for (var p = 0; p < this.map.players.length; p++) {
      var cities = this.map.players[p].cities;
      for (var c = 0; c < cities.length; c++) {
        if (!cities[c].discovered) this.check_need_to_shift_fog_city(cities[c]);
      }
    }

    this.updated_city_tiles = new Set();
  };

  P.check_need_to_shift_fog_city = function (city) {
    if (!city.discovered) {
      var noFriendlies = true;
      var movable = city.movableNoObstacles();
      for (var i = 0; i < movable.length; i++) {
        if (this.map.is_tile_on_team_with(movable[i], city.player())) {
          noFriendlies = false;
          break;
        }
      }
      if (noFriendlies) return this._find_replacement_fog_city_internal(city, true);
    }

    if (city.delta.oldOwner === city.player()) return null;
    if (city.delta.oldOwner === -1) return null;
    if (city.was_visible_last_turn()) return null;

    if (this.map.players[city.delta.oldOwner].cities.length >= this.map.players[city.delta.oldOwner].cityCount + 1) return null;

    return this._find_replacement_fog_city_internal(city, true);
  };

  P._find_replacement_fog_city_internal = function (city, forceConnected) {
    var prevArmy = city.delta.oldArmy;

    var cityOwner = city.delta.oldOwner;
    if (!city.visible) cityOwner = city.player();

    var cityPlayer = this.map.players[cityOwner];

    var newCity = this.find_next_fog_city_candidate_near_tile(cityOwner, city, 12, 3, 2.0, 1.0, false, forceConnected);
    if (!city.discovered) mapResetWrongUndiscoveredFogGuess(this.map, city);
    if (!city.isCity || cityOwner !== city.player()) {
      cityPlayer.cities = S().where(cityPlayer.cities, function (c) {
        return c !== city;
      });
    }

    if (newCity) {
      newCity.army = prevArmy;
      newCity.isTempFogPrediction = true;
    }

    return newCity;
  };

  P.check_if_this_city_was_actual_fog_city_location = function (city) {
    if (!city.visible) return null;
    if (!city.isCity && !city.isGeneral) return null;
    if (city.isNeutral) return null;
    if (city.delta.oldOwner === city.player()) return null;

    this.remove_nearest_fog_city(city.player(), city, 10);
  };

  P.convert_fog_city_to_player_owned = function (tile, player, isTempFogPrediction) {
    if (isTempFogPrediction === undefined) isTempFogPrediction = true;
    if (player === -1) throw new Error('lol player -1 in convert_fog_city_to_player_owned for tile ' + tile);
    var wasUndisc = !tile.discovered;
    tile.update(this.map, player, 1, true, false);
    tile.update(this.map, TILE_OBSTACLE, 0, false, false);
    tile.delta = new EK.TileDelta();
    if (wasUndisc) {
      tile.discovered = false;
      tile.discoveredAsNeutral = false;
      tile.isTempFogPrediction = isTempFogPrediction;
    }

    this.map.players[player].cities.push(tile);
    this.map.update_reachable();
  };

  /* ================================================================== *
   * 迷雾涌现的解析
   * ================================================================== */

  P.resolve_fog_emergence = function (player, sourceFogArmyPath, fogTile) {
    var armiesFromFog = [];
    var existingArmy = this.armies.get(fogTile);
    this.armies.delete(fogTile);
    if (existingArmy !== undefined && existingArmy !== null && existingArmy.player === player) armiesFromFog.push(existingArmy);

    var node = sourceFogArmyPath.start.next;
    while (node !== null && node !== undefined) {
      var fogArmy = this.armies.get(node.tile);
      this.armies.delete(node.tile);
      if (fogArmy !== undefined && fogArmy !== null && this.is_friendly_team(fogArmy.player, player)) armiesFromFog.push(fogArmy);
      if (!node.tile.visible) {
        if (!node.tile.discovered && node.tile.player() !== player) {
          node.tile.isTempFogPrediction = true;
          this.map.players[player].tiles.push(node.tile);
        }
        node.tile.army = 1;
        node.tile.setPlayer(player);
        if (this.map.is_army_bonus_turn) node.tile.army += 1;
        if (this.map.is_city_bonus_turn && (node.tile.isCity || node.tile.isGeneral)) node.tile.army += 1;
      }
      node = node.next;
    }

    var maxArmy = null;
    var candidateArmies = S().where(armiesFromFog, function (army) {
      return army.entangledValue !== null;
    });
    if (candidateArmies.length === 0) candidateArmies = armiesFromFog;
    for (var i = 0; i < candidateArmies.length; i++) {
      if (maxArmy === null || maxArmy.value < candidateArmies[i].value) maxArmy = candidateArmies[i];
    }

    if (maxArmy !== null) {
      var revNode = sourceFogArmyPath.get_reversed().start;
      while (revNode !== null && revNode !== undefined && revNode.tile !== maxArmy.tile) revNode = revNode.next;

      if (revNode !== null && revNode !== undefined) {
        revNode = revNode.next;
        while (revNode !== null && revNode !== undefined) {
          maxArmy.update_tile(revNode.tile);
          revNode = revNode.next;
        }
      }

      for (var s = 0; s < armiesFromFog.length; s++) {
        if (armiesFromFog[s] !== maxArmy) this.scrap_army(armiesFromFog[s], true);
      }

      this.resolve_entangled_armies(maxArmy);
      if (maxArmy.scrapped) maxArmy.scrapped = false;
      maxArmy.update_tile(fogTile);
      maxArmy.update();
      maxArmy.last_moved_turn = this.map.turn - 1;
      this.armies.set(fogTile, maxArmy);
      maxArmy.path = sourceFogArmyPath;
      maxArmy.expectedPaths = [];
    } else {
      maxArmy = new Army(fogTile);
      /* 从迷雾里加载的 army 通常忽略格子兵数，但这条路径要显式尊重它 */
      if (!fogTile.visible) maxArmy.value = fogTile.army - 1;
      else maxArmy.last_seen_turn = this.map.turn;
      maxArmy.path = sourceFogArmyPath;
    }

    return maxArmy;
  };

  P.use_fog_source_path_and_increase_emergence = function (armyTile, sourceFogArmyPath, delta, emergingPlayer, depthLimit) {
    if (emergingPlayer === undefined || emergingPlayer === null) emergingPlayer = -1;
    if (depthLimit === undefined) depthLimit = null;

    var player = sourceFogArmyPath.start.tile.player();
    if (player === -1) {
      var a = this.armies.get(sourceFogArmyPath.start.tile);
      if (a !== undefined && a !== null) player = a.player;
    }

    var convertedCity = false;
    var dist = 0;
    var pathTiles = sourceFogArmyPath.tileList;
    for (var i = 0; i < pathTiles.length; i++) {
      var tile = pathTiles[i];
      var isVisionLessNeutCity = tile.isCity && tile.isNeutral && !tile.visible;
      if (tile.isUndiscoveredObstacle || isVisionLessNeutCity) {
        this.convert_fog_city_to_player_owned(tile, player);
        convertedCity = true;
      }
      if (convertedCity) {
        var increase = 1 + sourceFogArmyPath.length - dist;
        this.emergenceLocationMap[player].raw[tile.tile_index] += increase;
      }
      dist += 1;
    }

    var fogPath = sourceFogArmyPath.get_reversed();
    var emergenceValueCovered = sourceFogArmyPath.value - armyTile.army;
    this.fogPaths.push(fogPath);
    var minRatio = 0.85;
    var leeway = Math.min(4, Math.floor(this.map.turn / 50)) + 1;

    var isGoodResolution = emergenceValueCovered + leeway > delta * minRatio;
    if (!isGoodResolution) {
      var armyEmergenceValue = Math.max(4.0, delta - emergenceValueCovered);
      this.new_army_emerged(armyTile, armyEmergenceValue, emergingPlayer, depthLimit);
    } else {
      for (var k = 0; k < fogPath.tileList.length; k++) {
        if (fogPath.tileList[k].isTempFogPrediction) fogPath.tileList[k].isTempFogPrediction = false;
      }
    }

    return isGoodResolution;
  };

  P.handle_unaccounted_delta = function (tile, player, unaccountedForDelta) {
    var depthLimit = this.get_emergence_max_depth_to_general_or_none(player, tile, unaccountedForDelta, false);
    var generalDepthLimit = this.get_emergence_max_depth_to_general_or_none(player, tile, unaccountedForDelta);

    if (!this.skip_emergence_tile_pathings.has(tile)) {
      var sourceFogArmyPath = this.find_fog_source(player, tile, unaccountedForDelta, depthLimit);
      if (sourceFogArmyPath !== null && sourceFogArmyPath !== undefined) {
        var limitFromTile = tile;
        if (tile.delta.toTile !== null && tile.delta.toTile !== undefined && tile.delta.toTile.visible && !tile.visible) {
          limitFromTile = tile.delta.toTile;
        }
        this.unaccounted_tile_diffs.delete(tile);
        if (
          generalDepthLimit !== null &&
          generalDepthLimit < 60 &&
          (limitFromTile.delta.toTile === null || limitFromTile.delta.toTile === undefined || limitFromTile.delta.toTile.visible)
        ) {
          this._limit_general_position_to_within_tile_and_distance(
            player,
            limitFromTile,
            generalDepthLimit,
            true,
            true,
            null,
            unaccountedForDelta,
            false
          );
        }

        if (sourceFogArmyPath.start.tile.player() !== player) {
          if (sourceFogArmyPath.start.tile.isGeneral) throw new Error('WTF trying to path from a different general...?');
          sourceFogArmyPath.start.tile.setPlayer(player);
        }

        var wasGoodPath = this.use_fog_source_path_and_increase_emergence(tile, sourceFogArmyPath, unaccountedForDelta, -1, depthLimit);
        if (wasGoodPath) this.pathed_fog_emergence_tiles.add(tile);

        return this.resolve_fog_emergence(player, sourceFogArmyPath, tile);
      }
    }

    /* [OPPONENT] 原文这里把没解析掉的涌现通知 opponent_tracker，跳过 */
    return null;
  };

  P.get_emergence_max_depth_to_general_or_none = function (player, tile, unaccountedForDelta, useOpponentKnownFogTileArmy) {
    if (unaccountedForDelta === undefined || unaccountedForDelta === null) unaccountedForDelta = -1;
    if (useOpponentKnownFogTileArmy === undefined) useOpponentKnownFogTileArmy = true;
    if (unaccountedForDelta === -1) unaccountedForDelta = Math.abs(tile.delta.armyDelta);
    var armyPlayerObj = this.map.players[player];
    var depthLimit = null;
    var armyInFog = armyPlayerObj.standingArmy - armyPlayerObj.visibleStandingArmy;
    if (useOpponentKnownFogTileArmy) {
      armyInFog = Math.max(0, Math.min(armyInFog, armyInFog - this._get_known_non_general_fog_tile_extra_army(player, true)));
    }
    if (unaccountedForDelta > 2 * armyInFog - 4) {
      depthLimit = this._calculate_maximum_general_distance_for_raw_fog_standing_army(armyPlayerObj, armyInFog);
    }
    return depthLimit;
  };

  P._get_known_non_general_fog_tile_extra_army = function (player, assumeUnderestimation) {
    /* [OPPONENT] 依赖 opponent_tracker 的迷雾格兵数分布，未移植则该值恒为 0 */
    if (this.opponent_tracker === null) return 0;

    var fogTileCountDict = this.opponent_tracker.get_player_fog_tile_count_dict(player);
    var extraArmy = 0;
    var maxTileSize = 0;
    var keys = Object.keys(fogTileCountDict);
    for (var i = 0; i < keys.length; i++) {
      var tileArmy = keys[i] | 0;
      var tileCount = fogTileCountDict[keys[i]];
      if (tileArmy <= 1) continue;
      extraArmy += (tileArmy - 1) * tileCount;
      maxTileSize = Math.max(tileArmy, maxTileSize);
    }
    var offset = 0;
    if (assumeUnderestimation) offset = maxTileSize + 1;
    return extraArmy - offset;
  };

  P.detect_army_likely_breached_wall = function (armyPlayer, tile, delta) {
    var emgMap = this.emergenceLocationMap[armyPlayer];
    void delta;

    var reasonablePathDetector = function (sourceTile) {
      if (sourceTile.isObstacle) return false;
      if (emgMap.raw[sourceTile.tile_index] <= 0) return false;
      if (sourceTile.visible) return false;
      if (sourceTile === tile) return false;
      return true;
    };

    var reasonablePath = S().breadth_first_find_queue(this.map, [tile], reasonablePathDetector, {
      noNeutralCities: true,
      maxDepth: 6,
      noLog: true
    });
    if (reasonablePath !== null && reasonablePath !== undefined) return false;
    return true;
  };

  /* ================================================================== *
   * 军队合并 / 相撞
   * ================================================================== */

  P.merge_armies = function (largerArmy, smallerArmy, finalTile, armyDict) {
    this.armies.delete(largerArmy.tile);
    this.armies.delete(smallerArmy.tile);
    largerArmy.absorb_fog_tile_reverts(smallerArmy);
    smallerArmy.fogTileReverts = new Map();
    for (var i = 0; i < smallerArmy.entangledArmies.length; i++) largerArmy.entangledArmies.push(smallerArmy.entangledArmies[i]);
    this.scrap_army(smallerArmy, false);
    for (var k = 0; k < smallerArmy.entangledArmies.length; k++) {
      smallerArmy.entangledArmies[k].entangledArmies.push(largerArmy);
    }
    if (largerArmy.entangledValue === null) largerArmy.entangledValue = largerArmy.value;
    if (smallerArmy.entangledValue === null) smallerArmy.entangledValue = smallerArmy.value;
    largerArmy.entangledValue += smallerArmy.entangledValue;

    if (largerArmy.tile !== finalTile) largerArmy.update_tile(finalTile);

    if (armyDict === undefined || armyDict === null) armyDict = this.armies;

    armyDict.set(finalTile, largerArmy);
    largerArmy.update();
  };

  P.collide_armies = function (movingArmy, targetArmy, finalTile, armyDict) {
    this.armies.delete(movingArmy.tile);
    this.armies.delete(targetArmy.tile);
    movingArmy.absorb_fog_tile_reverts(targetArmy);
    targetArmy.fogTileReverts = new Map();

    if (!isPlayerOnTeamWith(this.map, movingArmy.player, targetArmy.player)) {
      if ((targetArmy.value < movingArmy.value && !finalTile.visible) || (finalTile.player() === movingArmy.player && finalTile.visible)) {
        targetArmy.value = 0;
        this.scrap_army(targetArmy, true);
      } else {
        targetArmy.value -= movingArmy.tile.delta.armyDelta;
      }
    } else if (finalTile.isGeneral && finalTile.player() !== movingArmy.player) {
      this.scrap_army(movingArmy, true);
    } else {
      this.scrap_army(targetArmy, true);
    }

    if (movingArmy.tile !== finalTile) movingArmy.update_tile(finalTile);

    if (armyDict === undefined || armyDict === null) armyDict = this.armies;

    armyDict.set(finalTile, movingArmy);
    movingArmy.update();
  };

  P.has_perfect_information_of_player_cities_and_general = function (player) {
    var mapPlayer = this.map.players[player];
    if (mapPlayer.general !== null && mapPlayer.general !== undefined && mapPlayer.general.isGeneral && this.has_perfect_information_of_player_cities(player)) {
      return true;
    }
    return false;
  };

  P.has_perfect_information_of_player_cities = function (player, overrideCities) {
    var mapPlayer = this.map.players[player];
    var realCities = S().where(mapPlayer.cities, function (c) {
      return c.discovered;
    });
    var cityCount = overrideCities === undefined ? null : overrideCities;
    if (cityCount === null) cityCount = mapPlayer.cityCount;
    return realCities.length >= cityCount - 1;
  };

  /* ================================================================== *
   * 单支军队的移动跟踪
   * ================================================================== */

  P.try_track_own_move = function (army, skip, trackingArmies) {
    if (this.map.last_player_index_submitted_move !== null && this.map.last_player_index_submitted_move !== undefined) {
      var src = this.map.last_player_index_submitted_move[0];
      var dest = this.map.last_player_index_submitted_move[1];
      if (src.visible) this.army_moved(army, dest, trackingArmies, false, false);
    }
  };

  P.try_track_army = function (army, skip, trackingArmies) {
    var self = this;
    var armyTile = army.tile;
    if (army.scrapped) {
      this.armies.delete(armyTile);
      return;
    }

    if (skip.has(army.tile)) return;
    if (!this.armies.has(armyTile)) return;
    if (army.tile !== armyTile) throw new Error('bitch, army key ' + armyTile + " didn't match army tile " + army);

    var armyRealTileDelta = 0 - army.tile.delta.armyDelta;
    if (armyRealTileDelta === 0 && army.tile.visible && !army.tile.delta.gainedSight) {
      army.update();
      return;
    }

    var foundLocation = false;

    if (army.visible && army.player === army.tile.player() && army.value < army.tile.army - 1) {
      this.handle_gathered_to_army(army, skip, trackingArmies);
      return;
    }

    if (army.visible && army.tile.visible && army.tile.delta.armyDelta === 0 && army.tile.player() === army.player) {
      /* 没动过 */
      army.update();
      if (!army.scrapped && !army.visible) army.value = army.tile.army - 1;
      this.check_for_should_scrap_unmoved_army(army);
      return;
    }

    for (var i = 0; i < army.tile.movable.length; i++) {
      var adjacent = army.tile.movable[i];
      if (adjacent.isMountain) continue;
      foundLocation = this.test_army_adjacent_move(army, adjacent, skip, trackingArmies);
      if (foundLocation) break;
    }

    if (!foundLocation) {
      if (!army.visible && !army.tile.visible) {
        /* 交给迷雾移动逻辑处理 */
        return;
      }
      var fogBois = [];
      var fogCount = 0;
      for (var k = 0; k < army.tile.movable.length; k++) {
        var adjacent2 = army.tile.movable[k];
        if (adjacent2.isMountain || adjacent2.isNotPathable) continue;

        /* 被揭开的军队不能往别的迷雾格走，除非那格本来就是它的 */
        var legalFogMove = army.visible || adjacent2.player() === army.player;
        if (!adjacent2.was_visible_last_turn() && this.army_could_capture(army, adjacent2) && legalFogMove) {
          var expected = army.value;
          var expectCaptured = false;
          if (isPlayerOnTeamWith(this.map, adjacent2.delta.oldOwner, army.player)) {
            expected += adjacent2.delta.oldArmy;
            expectCaptured = true;
          } else {
            expected -= adjacent2.delta.oldArmy;
            if (expected < 0) expectCaptured = true;
          }

          if (
            adjacent2.visible &&
            (!(0 - expected * 0.7 < adjacent2.army && adjacent2.army < expected * 1.3) ||
              (expectCaptured && adjacent2.player() !== army.player))
          ) {
            continue;
          }

          fogBois.push(adjacent2);
          fogCount += 1;
        }

        var expectedAdjDelta = 0;
        var adjDelta = this.unaccounted_tile_diffs.has(adjacent2)
          ? this.unaccounted_tile_diffs.get(adjacent2)
          : adjacent2.delta.armyDelta;
        if (
          (armyRealTileDelta > 0 ||
            (!army.tile.visible && adjacent2.visible && adjacent2.delta.armyDelta !== expectedAdjDelta)) &&
          adjDelta - armyRealTileDelta === army.tile.delta.expectedDelta
        ) {
          foundLocation = true;
          this.unaccounted_tile_diffs.delete(army.tile);
          this.army_moved(army, adjacent2, trackingArmies, false, false);
          break;
        }
      }

      if (!foundLocation && fogBois.length > 0 && army.player !== this.map.player_index && army.tile.was_visible_last_turn()) {
        if (fogBois.length === 1) {
          var fogTarget = fogBois[0];
          foundLocation = true;
          this.move_army_into_fog(army, fogTarget);
          if (fogCount === 1) fogTarget.setPlayer(army.player);
          this.unaccounted_tile_diffs.delete(army.tile);
          this.army_moved(army, fogTarget, trackingArmies, true, false);
        } else {
          foundLocation = true;
          var entangledArmies = army.get_split_for_fog(fogBois);
          for (var fi = 0; fi < fogBois.length; fi++) {
            this.move_army_into_fog(entangledArmies[fi], fogBois[fi]);
            this.unaccounted_tile_diffs.delete(entangledArmies[fi].tile);
            this.army_moved(entangledArmies[fi], fogBois[fi], trackingArmies, true, false);
          }
        }
        return;
      }

      if (army.player !== army.tile.player() && army.tile.was_visible_last_turn()) {
        this.scrap_army(army, true);
      }
    }

    void self;
    army.update();
  };

  P.get_or_create_army_at = function (tile, skip_expected_path) {
    skip_expected_path = !!skip_expected_path;
    var army = this.armies.get(tile);
    if (army !== undefined && army !== null) return army;

    army = new Army(tile);
    army.last_moved_turn = 0;
    if (army.tile.delta.fromTile !== null || army.tile.delta.unexplainedDelta !== 0) army.last_moved_turn = this.map.turn - 1;
    if (!tile.visible) {
      /* 只有臆测出来的迷雾城市 / 初始地图才会走到这里 */
      army.last_moved_turn = this.map.turn - 2;
      army.value = tile.army - 1;
    } else {
      army.last_seen_turn = this.map.turn;
    }

    if (!skip_expected_path) {
      army.expectedPaths = ArmyTracker.get_army_expected_path(this.map, army, this.general, this.player_targets, null, this.log_debug);
    }

    this.armies.set(tile, army);
    return army;
  };

  P.handle_gathered_to_army = function (army, skip, trackingArmies) {
    var unaccountedForDelta = Math.abs(army.tile.delta.armyDelta);
    var source = this.find_visible_source(army.tile);
    if (source === null) {
      this.handle_unaccounted_delta(army.tile, army.player, unaccountedForDelta);
    } else {
      if (this.armies.has(source)) {
        var sourceArmy = this.armies.get(source);
        var larger = sourceArmy;
        var smaller = army;
        if (sourceArmy.value < army.value) {
          larger = army;
          smaller = sourceArmy;
        }
        skip.add(larger.tile);
        skip.add(smaller.tile);
        this.merge_armies(larger, smaller, army.tile);
        return;
      } else {
        trackingArmies.set(army.tile, army);
      }
    }
    army.update();
  };

  P.test_army_adjacent_move = function (army, adjacent, skip, trackingArmies) {
    var unexplainedSourceDelta = this.unaccounted_tile_diffs.has(army.tile)
      ? this.unaccounted_tile_diffs.get(army.tile)
      : army.tile.delta.armyDelta;
    var armyRealTileDelta = 0 - unexplainedSourceDelta;
    var unexplainedAdjDelta = this.unaccounted_tile_diffs.has(adjacent) ? this.unaccounted_tile_diffs.get(adjacent) : 0;
    var positiveUnexplainedAdjDelta = 0 - unexplainedAdjDelta;
    var adjacentIncludesArmy = S().any_where(army.entangledArmies, function (a) {
      return a.tile === adjacent;
    });
    if (adjacentIncludesArmy) return false;

    if (adjacent.delta.gainedSight && adjacent.army < Math.floor(positiveUnexplainedAdjDelta / 2)) return false;

    if (armyRealTileDelta > 0 && Math.abs(unexplainedAdjDelta) - Math.abs(armyRealTileDelta) === 0) {
      this.unaccounted_tile_diffs.delete(army.tile);
      this.unaccounted_tile_diffs.delete(adjacent);
      this.army_moved(army, adjacent, trackingArmies, false, false);
      return true;
    } else if (!army.tile.visible && positiveUnexplainedAdjDelta > 1) {
      if (positiveUnexplainedAdjDelta * 1.1 - army.value > 0 && army.value > Math.floor(positiveUnexplainedAdjDelta / 2) - 1) {
        this.unaccounted_tile_diffs.set(army.tile, unexplainedSourceDelta - unexplainedAdjDelta);
        this.unaccounted_tile_diffs.delete(adjacent);
        this.army_moved(army, adjacent, trackingArmies, false, false);
        return true;
      }
    } else if (
      adjacent.delta.gainedSight &&
      armyRealTileDelta > 0 &&
      positiveUnexplainedAdjDelta * 0.9 < armyRealTileDelta &&
      armyRealTileDelta < positiveUnexplainedAdjDelta * 1.25
    ) {
      this.unaccounted_tile_diffs.delete(army.tile);
      this.unaccounted_tile_diffs.delete(adjacent);
      this.army_moved(army, adjacent, trackingArmies, false, false);
      return true;
    } else if (positiveUnexplainedAdjDelta !== 0 && Math.abs(positiveUnexplainedAdjDelta) - army.value === 0) {
      var oldTile = army.tile;
      if (oldTile.army > army.value - positiveUnexplainedAdjDelta && !oldTile.visible) {
        if (!oldTile.visible) oldTile.army = army.value - positiveUnexplainedAdjDelta + 1;
      }
      this.unaccounted_tile_diffs.delete(adjacent);
      this.army_moved(army, adjacent, trackingArmies, false, false);
      return true;
    }

    return false;
  };

  P.check_for_should_scrap_unmoved_army = function (army) {
    var thresh = this.track_threshold - 1;
    if (distBetween(this.map, this.general, army.tile) < 5) thresh = 4;
    if (distBetween(this.map, this.general, army.tile) < 2) thresh = 2;

    if ((army.tile.visible && army.value < thresh) || (!army.tile.visible && army.value < thresh)) {
      this.scrap_army(army, false);
    }
  };

  P.scrap_unmoved_low_armies = function () {
    var armies = Array.from(this.armies.values());
    for (var i = 0; i < armies.length; i++) {
      if (armies[i].last_moved_turn < this.map.turn - 1) this.check_for_should_scrap_unmoved_army(armies[i]);
    }
  };

  /* ================================================================== *
   * 期望路径预测（ArmyTracker.py 的 @classmethod 群）
   * ================================================================== */

  ArmyTracker.get_army_expected_path = function (map, army, general, playerTargets, negativeTiles, log_debug) {
    void log_debug;
    if (map.is_tile_friendly(army.tile)) return [];

    if (army.value <= 0) {
      if (army.tile.army > 1) army.value = army.tile.army - 1;
      else return [];
    }

    var remainingCycleTurns = 50 - (map.turn % 50);
    if (negativeTiles === undefined || negativeTiles === null) negativeTiles = new Set();

    var pathA = ArmyTracker.get_army_expected_path_non_flank(map, army, general, playerTargets, negativeTiles);
    if (pathA !== null && pathA !== undefined && pathA.length > 0) {
      for (var i = 0; i < pathA.tileList.length; i++) negativeTiles.add(pathA.tileList[i]);
    }
    var pathB = ArmyTracker.get_army_expected_path_flank(map, army, general, null, negativeTiles, log_debug);

    var matrices = [];
    var paths = [];
    if (pathA !== null && pathA !== undefined && pathA.length > 0) {
      paths.push(pathA);
      matrices.push(map.distance_mapper.get_tile_dist_matrix(pathA.tail.tile));
    }
    if (pathB !== null && pathB !== undefined && pathB.length > 0) {
      var hasSameTail = S().any_where(paths, function (p) {
        return p.tail.tile === pathB.tail.tile;
      });
      if (!hasSameTail) {
        paths.push(pathB);
        if (pathB.length > 2) {
          var pathC = ArmyTracker.get_army_expected_path_flank(
            map,
            army,
            general,
            pathB.tileList.slice(3),
            negativeTiles,
            log_debug
          );
          if (pathC !== null && pathC !== undefined && pathC.length > 0 && pathC.tail.tile !== pathB.tail.tile) {
            paths.push(pathC);
            matrices.push(map.distance_mapper.get_tile_dist_matrix(pathC.tail.tile));
          }
        }
        matrices.push(map.distance_mapper.get_tile_dist_matrix(pathB.tail.tile));
      }
    }

    if (matrices.length === 0) matrices.push(map.distance_mapper.get_tile_dist_matrix(general));
    var summed = MapMatrix.get_summed(matrices);

    var pathD = ArmyTracker.get_expected_enemy_expansion_path(
      map,
      army.tile,
      general,
      flattenPathTiles(paths),
      Math.max(15, remainingCycleTurns),
      summed,
      null,
      true
    );
    if (pathD !== null && pathD !== undefined && pathD.length > 0) {
      paths.push(pathD);
      MapMatrix.add_to_matrix(summed, map.distance_mapper.get_tile_dist_matrix(pathD.tail.tile));
      var pathE = ArmyTracker.get_expected_enemy_expansion_path(
        map,
        army.tile,
        general,
        flattenPathTiles(paths),
        Math.max(15, remainingCycleTurns),
        summed,
        null,
        true
      );
      if (pathE !== null && pathE !== undefined && pathE.length > 0) paths.push(pathE);
    }

    if (paths.length > 1 && paths[0].tileList.length > 1) {
      var secondTile = paths[0].tileList[1];
      var noAltExits = true;
      for (var p = 1; p < paths.length; p++) {
        if (paths[p].tileList[1] !== secondTile) {
          noAltExits = false;
          break;
        }
      }
      if (noAltExits) {
        var skips = new Set();
        skips.add(secondTile);
        var pathF = ArmyTracker.get_expected_enemy_expansion_path(
          map,
          army.tile,
          general,
          flattenPathTiles(paths),
          remainingCycleTurns,
          summed,
          skips,
          true
        );
        if (pathF !== null && pathF !== undefined && pathF.length > 0) paths.push(pathF);
      }
    }

    return paths;
  };

  ArmyTracker.get_army_expected_path_non_flank = function (map, army, general, player_targets, negativeTiles) {
    if (army.value <= 0) return null;
    if (army.tile.isCity && army.expectedPaths.length === 0 && army.tile.lastMovedTurn < map.turn - 2) return null;
    if (army.player === map.player_index || map.teammates.has(army.player)) return null;

    var armyDistFromGen = distBetween(map, general, army.tile);

    var skip = new Set();
    var skipCutoff = Math.floor((3 * army.value) / 4);

    for (var i = 0; i < map.players.length; i++) {
      var player = map.players[i];
      if (!isPlayerOnTeamWith(map, player.index, map.player_index)) continue;
      for (var t = 0; t < player.tiles.length; t++) {
        var tile = player.tiles[t];
        if (tile.army > skipCutoff && !tile.isCity && !tile.isGeneral && tileIsVisibleTo(map, tile, army.player)) skip.add(tile);
      }
    }

    var goalFunc = function (tile, armyAmt, dist) {
      void armyAmt;
      if (dist + 2 < armyDistFromGen && player_targets.indexOf(tile) >= 0) return true;
      if (tile === map.generals[map.player_index]) return true;
      return false;
    };

    if (army.entangledArmies.length > 0) {
      for (var e = 0; e < army.entangledArmies.length; e++) {
        var entangled = army.entangledArmies[e];
        skip.add(entangled.tile);
        for (var ep = 0; ep < entangled.expectedPaths.length; ep++) {
          var epTiles = entangled.expectedPaths[ep].tileList;
          for (var epi = 0; epi < epTiles.length; epi++) skip.add(epTiles[epi]);
        }
      }
    }

    var path = S().breadth_first_find_queue(map, [army.tile], goalFunc, {
      skipTiles: skip,
      maxTime: 1.0,
      maxDepth: 23,
      noNeutralCities: army.tile.army < 150,
      searchingPlayer: army.player,
      negativeTiles: negativeTiles,
      noLog: true
    });

    if (path === null || path === undefined) return null;

    return path.get_positive_subsegment(army.player, map.team_ids_by_player_index, negativeTiles, undefined);
  };

  ArmyTracker.get_army_expected_path_flank = function (map, army, general, skipTiles, negativeTiles, log_debug) {
    void log_debug;
    if (army.value <= 0) return null;
    if (army.tile.isCity && army.expectedPaths.length === 0 && army.tile.lastMovedTurn < map.turn - 2) return null;
    if (army.player === map.player_index || map.teammates.has(army.player)) return null;

    var valueFunc = function (tile) {
      if (tile.visible) return null;
      return [0 - distBetween(map, general, tile), 0];
    };

    var prioFunc = function (tile) {
      if (tile.visible) return null;
      return [distBetween(map, general, tile), 0];
    };

    var skip = new MapMatrixSet(map);
    var allTiles = map.get_all_tiles();
    for (var i = 0; i < allTiles.length; i++) {
      if (allTiles[i].visible) skip.add(allTiles[i]);
    }

    if (skipTiles !== null && skipTiles !== undefined) {
      var st = Array.isArray(skipTiles) ? skipTiles : Array.from(skipTiles);
      for (var s = 0; s < st.length; s++) skip.add(st[s]);
    }

    if (army.entangledArmies.length > 0) {
      for (var e = 0; e < army.entangledArmies.length; e++) {
        var entangled = army.entangledArmies[e];
        skip.add(entangled.tile);
        for (var ep = 0; ep < entangled.expectedPaths.length; ep++) {
          var epTiles = entangled.expectedPaths[ep].tileList;
          for (var epi = 0; epi < epTiles.length; epi++) skip.add(epTiles[epi]);
        }
      }
    }

    var startTiles = new Map();
    startTiles.set(army.tile, [[0, 0], 0]);

    var path = S().breadth_first_dynamic_max(map, startTiles, valueFunc, {
      priorityFunc: prioFunc,
      skipTiles: skip,
      maxTime: 1.0,
      maxDepth: 30,
      noNeutralCities: army.tile.army < 150,
      searchingPlayer: army.player,
      noLog: true
    });

    if (path === null || path === undefined) return null;

    return path.get_positive_subsegment(army.player, map.team_ids_by_player_index, negativeTiles, undefined);
  };

  ArmyTracker.get_expected_enemy_expansion_path = function (map, enTile, general, negativeTiles, maxTurns, prioMatrix, skipTiles, noLog) {
    if (maxTurns === undefined || maxTurns === null) maxTurns = 45;
    if (noLog === undefined) noLog = true;
    if (prioMatrix === undefined || prioMatrix === null) prioMatrix = map.distance_mapper.get_tile_dist_matrix(general);

    var valueFunc = function (curTile, prioObj) {
      void curTile;
      var dist = prioObj[0];
      var negCaps = prioObj[1];
      var negArmy = prioObj[2];
      var negPrioDist = prioObj[3];
      if (negArmy > 0) return null;
      if (dist === 0) return null;

      var weightedDist = dist + 2;
      var distDiff = maxTurns - dist;
      if (distDiff < 4 || negArmy > -10) weightedDist = dist;

      return [0 - negCaps / weightedDist, 0 - negPrioDist, dist];
    };

    var prioFunc = function (nextTile, prioObj) {
      var dist = prioObj[0];
      var negCaps = prioObj[1];
      var negArmy = prioObj[2];
      void prioObj[3];
      if (negArmy > 0) return null;

      var prioDist = prioMatrix.raw[nextTile.tile_index];

      if (map.is_tile_on_team_with(nextTile, enTile.player())) {
        negArmy -= nextTile.army;
      } else {
        negArmy += nextTile.army;
        if (negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(nextTile)) {
          if (map.is_tile_on_team_with(nextTile, general.player())) negCaps -= 2.05;
          else negCaps -= 0.7;
        }
      }

      negCaps -= 0.03 * prioDist - 0.1;
      negArmy += 1;

      return [dist + 1, negCaps, negArmy, 0 - prioDist];
    };

    var initDist = prioMatrix.raw[enTile.tile_index];
    var startTiles = new Map();
    startTiles.set(enTile, [[0, 0, 0 - enTile.army + 1, 0 - initDist], 0]);

    return S().breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxDepth: maxTurns,
      priorityFunc: prioFunc,
      searchingPlayer: enTile.player(),
      noNeutralCities: true,
      skipTiles: skipTiles === undefined ? null : skipTiles,
      noLog: noLog
    });
  };

  /* ================================================================== *
   * 迷雾格写回 / 统计校验
   * ================================================================== */

  P.reset_temp_tile_marked = function (curTile, noLog) {
    void noLog;
    if (curTile.player() >= 0 && curTile.isCity) removeFromArray(this.map.players[curTile.player()].cities, curTile);

    this._flipped_by_army_tracker_this_turn.push([curTile.player(), curTile]);
    if (curTile.player() >= 0) this.dropped_fog_tiles_this_turn.add(curTile);

    mapResetWrongUndiscoveredFogGuess(this.map, curTile);
  };

  P.verify_player_tile_and_army_counts_valid = function () {
    for (var i = 0; i < this.map.players.length; i++) {
      var player = this.map.players[i];
      var actualTileCount = player.tileCount;
      var mapTileCount = player.tiles.length;

      var emgMap = this.emergenceLocationMap[player.index];

      if (actualTileCount < mapTileCount) {
        var realDists = S().build_distance_map_matrix(this.map, Array.from(this.tiles_ever_owned_by_player[player.index]));

        var tilesAsEncountered = new (S().HeapQueue)();
        for (var t = 0; t < player.tiles.length; t++) {
          var tile = player.tiles[t];
          if (tile.discovered) continue;
          var dist = realDists.raw[tile.tile_index];
          var emergenceBonus = Math.max(0.0, emgMap.raw[tile.tile_index]);
          tilesAsEncountered.put([(emergenceBonus / (dist + 1)) - 3 * dist + tile.army, tile]);
        }

        while (mapTileCount > actualTileCount && tilesAsEncountered.queue.length > 0) {
          var popped = tilesAsEncountered.get();
          var toRemove = popped[1];
          if (!toRemove.isCity && !toRemove.isGeneral) {
            this.reset_temp_tile_marked(toRemove, true);
            mapTileCount -= 1;
            var army = this.armies.get(toRemove);
            if (army !== undefined && army !== null) this.scrap_army(army, false);
          }
        }

        player.tiles = S().where(this.map.get_all_tiles(), function (tl) {
          return tl.player() === player.index;
        });
      }

      var actualScore = player.score;
      var mapScore = 0;
      var entangledTracker = new Set();
      for (var t2 = 0; t2 < player.tiles.length; t2++) {
        var tile2 = player.tiles[t2];
        var army2 = this.armies.get(tile2);
        if (army2 !== undefined && army2 !== null && army2.entangledArmies.length > 0) {
          if (entangledTracker.has(army2.name)) continue;
          entangledTracker.add(army2.name);
        }
        mapScore += tile2.army;
      }

      if (actualScore < mapScore) {
        var tilesAsEncountered2 = new (S().HeapQueue)();
        for (var t3 = 0; t3 < player.tiles.length; t3++) {
          var tile3 = player.tiles[t3];
          var genCityDePriority = 0;
          if (tile3.isGeneral || tile3.isCity) genCityDePriority = 50;
          if (this.armies.has(tile3)) genCityDePriority += 10;

          var tileArmy = this.armies.get(tile3);
          if (tileArmy === undefined) tileArmy = null;
          if (!tile3.visible && (tileArmy === null || tileArmy.entangledArmies.length === 0)) {
            var dist3 = distBetween(this.map, this.general, tile3);
            var emergenceBonus3 = Math.max(0.0, this.emergenceLocationMap[player.index].raw[tile3.tile_index]);
            tilesAsEncountered2.put([emergenceBonus3 - tile3.lastSeen + genCityDePriority - dist3 / 10, tile3]);
          }
        }

        while (mapScore > actualScore && tilesAsEncountered2.queue.length > 0) {
          var popped2 = tilesAsEncountered2.get();
          var toReduce = popped2[1];
          var reduceTo = 1;
          if (this.map.turn % 50 < 15) reduceTo = 2;

          var reduceBy = toReduce.army - reduceTo;
          if (mapScore - reduceBy < actualScore) reduceBy = mapScore - actualScore;

          toReduce.army = toReduce.army - reduceBy;
          mapScore -= reduceBy;
          this.decremented_fog_tiles_this_turn.add(toReduce);
          var army3 = this.armies.get(toReduce);
          if (army3 !== undefined && army3 !== null) {
            army3.value = toReduce.army - 1;
            if (army3.value <= 0) this.scrap_army(army3, false);
          }
        }
      }
    }
  };

  P.get_tile_emergence_for_player = function (tile, player) {
    if (player === -1) return 0;
    return this.emergenceLocationMap[player].raw[tile.tile_index];
  };

  P.get_prediction_value = function (player, tile) {
    return this.emergenceLocationMap[player].raw[tile.tile_index];
  };

  P.get_prediction_value_x_y = function (player, x, y) {
    return this.emergenceLocationMap[player].raw[this.map.GetTile(x, y).tile_index];
  };

  P._reset_player_emergences = function (player) {
    this.emergenceLocationMap[player] = new MapMatrix(this.map, 0.0);
  };

  P.get_unique_armies_by_player = function (player) {
    var armiesIncl = new Set();
    var armies = [];
    var all = Array.from(this.armies.values());
    for (var i = 0; i < all.length; i++) {
      if (all[i].player !== player) continue;
      if (!armiesIncl.has(all[i].name)) {
        armiesIncl.add(all[i].name);
        armies.push(all[i]);
      }
    }
    return armies;
  };

  P.add_need_to_track_city = function (city) {
    this.updated_city_tiles.add(city);
  };

  P.has_player_seen = function (player, tile) {
    var everOwned = this.tiles_ever_owned_by_player[player];
    for (var i = 0; i < tile.visibleTo.length; i++) {
      if (everOwned.has(tile.visibleTo[i])) return true;
    }
    return false;
  };

  P._calculate_maximum_general_distance_for_raw_fog_standing_army = function (player, armyInFog) {
    var cityCount = player.cityCount;
    if (cityCount < 0) cityCount = 0;
    var maxDist = 0;
    var armyLeft = armyInFog;
    var turn = this.map.turn;
    for (;;) {
      if (armyLeft < 0) break;
      if ((turn & 1) === 0) armyLeft -= cityCount;
      if (turn % 50 === 0) {
        armyLeft -= player.tileCount -
          S().count(player.tiles, function (t) {
            return t.visible;
          });
      }
      turn -= 1;
      maxDist += 1;
    }
    return maxDist;
  };

  P.drop_incorrect_player_fog_around = function (neutralTile, forPlayer) {
    var self = this;
    var q = [];
    var playerTileAdvantageDepth = 3;

    var isDroppingChainedBadFog = forPlayer !== -1;
    if (isDroppingChainedBadFog) {
      var allFogTilesNearby = new Set(this.tiles_ever_owned_by_player[forPlayer]);
      var everOwned = this.tiles_ever_owned_by_player[forPlayer];
      var foreachFunc = function (t) {
        allFogTilesNearby.add(t);
        return t.visible && !everOwned.has(t);
      };
      S().breadth_first_foreach(this.map, Array.from(everOwned), playerTileAdvantageDepth, foreachFunc, null, true, false);
      allFogTilesNearby.forEach(function (tile) {
        q.push([forPlayer, tile]);
      });
    } else {
      for (var p = 0; p < this.tiles_ever_owned_by_player.length; p++) {
        var tileSet = this.tiles_ever_owned_by_player[p];
        var nearby = new Set(tileSet);
        var foreachFunc2 = function (t) {
          nearby.add(t);
          return t.visible && !tileSet.has(t);
        };
        S().breadth_first_foreach(this.map, Array.from(tileSet), playerTileAdvantageDepth, foreachFunc2, null, true, false);
        nearby.forEach(function (tile) {
          q.push([p, tile]);
        });
      }
    }

    // ArmyTracker.py:3149 —— Python 的 player_connected_tiles[-1] 取的是**最后一个玩家**的连通集，
    // JS 的负下标只会得到 undefined（曾表现为 drop_incorrect_player_fog_around 里 reading 'has'）
    var forPlayerRequiredConnected = forPlayer < 0
      ? this.player_connected_tiles[this.player_connected_tiles.length - 1]
      : this.player_connected_tiles[forPlayer];
    if (!forPlayerRequiredConnected) forPlayerRequiredConnected = new Set();

    q.push([-1, neutralTile]);

    var visited = new Set();
    var head = 0;
    while (head < q.length) {
      var curPlayer = q[head][0];
      var curTile = q[head][1];
      head += 1;

      if (visited.has(curTile)) continue;

      if (curTile.discoveredAsNeutral && !curTile.delta.gainedSight && curPlayer !== -1) continue;

      visited.add(curTile);

      if (!curTile.discovered || curTile.isTempFogPrediction) {
        if (isDroppingChainedBadFog) {
          if (curPlayer === -1 && curTile.player() === forPlayer && !forPlayerRequiredConnected.has(curTile)) {
            this.should_recalc_fog_land_by_player[curTile.player()] = true;
            this.reset_temp_tile_marked(curTile, false);
          }
          if (curPlayer === -1) this.emergenceLocationMap[forPlayer].raw[curTile.tile_index] = 0;
        } else {
          if (curTile.player() !== -1 && curPlayer !== curTile.player() && !forPlayerRequiredConnected.has(curTile)) {
            this.should_recalc_fog_land_by_player[curTile.player()] = true;
            this.reset_temp_tile_marked(curTile, false);
          }
        }
      }

      if (curTile.visible && curTile.discoveredAsNeutral && !curTile.delta.gainedSight && curTile !== neutralTile) {
        if (isDroppingChainedBadFog) {
          if (!this.tiles_ever_owned_by_player[forPlayer].has(curTile) && curTile.player() !== forPlayer) continue;
        }
      }

      if (!curTile.isUndiscoveredObstacle) {
        for (var m = 0; m < curTile.movable.length; m++) q.push([curPlayer, curTile.movable[m]]);
      }
    }
    void self;
  };

  /* ================================================================== *
   * flipped tiles（每回合地图层面翻转过的格子）
   * ================================================================== */

  P._pre_army_track_handle_flipped_tiles = function () {
    var recalcVis = new Set();
    var flipped = Array.from(this._flipped_tiles);
    var i, a;
    for (i = 0; i < flipped.length; i++) {
      var tile = flipped[i];
      recalcVis.add(tile);
      for (a = 0; a < tile.adjacents.length; a++) recalcVis.add(tile.adjacents[a]);

      if (tile.player() === -1) continue;

      this.tiles_ever_owned_by_player[tile.player()].add(tile);
      /* [OPPONENT] 原文这里通知 opponent_tracker.notify_tile_flipped_for_player，跳过 */
    }

    var recalc = Array.from(recalcVis);
    for (i = 0; i < recalc.length; i++) {
      var t = recalc[i];
      for (var p = 0; p < this.map.players.length; p++) this.visible_tiles_by_player[p].raw[t.tile_index] = false;
      if (t.player() >= 0) this.visible_tiles_by_player[t.player()].raw[t.tile_index] = true;
      for (var v = 0; v < t.visibleTo.length; v++) {
        var vis = t.visibleTo[v];
        if (vis.player() >= 0) {
          this.visible_tiles_by_player[vis.player()].raw[t.tile_index] = true;
          /* 看得见是靠视野猜的，seen 必须靠真看见 */
          if (vis.visible) this.seen_tiles_by_player[vis.player()].raw[t.tile_index] = true;
        }
      }
    }

    this._handle_flipped_discovered_as_neutrals();

    if (this.map.has_misty_veil && this.map.has_watchtower) {
      for (i = 0; i < this._flipped_by_army_tracker_this_turn.length; i++) {
        var flip = this._flipped_by_army_tracker_this_turn[i];
        var flipTile = flip[1];
        if (this.map.is_tile_friendly(flipTile)) {
          for (var mv = 0; mv < flipTile.movable.length; mv++) {
            var mvt = flipTile.movable[mv];
            if (!mvt.visible) {
              for (var pm = 0; pm < this.valid_general_positions_by_player.length; pm++) {
                this.valid_general_positions_by_player[pm].raw[mvt.tile_index] = false;
              }
            }
          }
        }
      }
    }
  };

  P._post_army_track_handle_flipped_tiles = function () {
    var self = this;
    var i, j;
    var reTilePlayers = new Set();
    for (i = 0; i < this._flipped_by_army_tracker_this_turn.length; i++) {
      var oldOwner = this._flipped_by_army_tracker_this_turn[i][0];
      var tile = this._flipped_by_army_tracker_this_turn[i][1];
      if (oldOwner >= 0) {
        reTilePlayers.add(oldOwner);
        if (!isPlayerOnTeamWith(this.map, oldOwner, tile.player())) this.unrecaptured_emergence_events[oldOwner].delete(tile);
      }
      if (tile.player() >= 0) reTilePlayers.add(tile.player());
    }

    if (reTilePlayers.size > 0) {
      reTilePlayers.forEach(function (playerIndex) {
        self.map.players[playerIndex].tiles = [];
      });
      this.map.reachable_tiles.forEach(function (reachTile) {
        if (reachTile.player() === -1 || !reTilePlayers.has(reachTile.player())) return;
        self.map.players[reachTile.player()].tiles.push(reachTile);
      });
    }

    var recheckPlayers = new Set();
    var reFogLandPlayers = new Set();

    var flipped = Array.from(this._flipped_tiles);
    for (i = 0; i < flipped.length; i++) {
      var ft = flipped[i];
      if (ft.player() !== ft.delta.oldOwner && ft.delta.gainedSight) {
        if (ft.player() !== -1) this.players_with_incorrect_tile_predictions.add(ft.player());
        if (ft.delta.oldOwner !== -1) this.players_with_incorrect_tile_predictions.add(ft.delta.oldOwner);
      }
      if (ft.delta.discovered && ft.player() !== -1) {
        recheckPlayers.add(ft.player());
        for (j = 0; j < ft.movable.length; j++) {
          var adj = ft.movable[j];
          if (adj.player() >= 0 && !this.map.is_tile_friendly(adj)) reFogLandPlayers.add(adj.player());
        }
        if (
          !this.map.is_tile_friendly(ft) &&
          S().any_where(ft.movable, function (t) {
            return !t.visible;
          })
        ) {
          this.discovered_enemy_land_connector_tiles[ft.player()].add(ft);
          reFogLandPlayers.add(ft.player());
        }

        for (var p2 = 0; p2 < this.map.players.length; p2++) {
          var emergence = this.emergenceLocationMap[p2].raw[ft.tile_index];
          for (var mv2 = 0; mv2 < ft.movable.length; mv2++) {
            var movable = ft.movable[mv2];
            if (movable.discovered) continue;
            var movableEmergence = this.emergenceLocationMap[p2].raw[movable.tile_index];
            if (emergence > movableEmergence) {
              this.emergenceLocationMap[p2].raw[movable.tile_index] = movableEmergence + Math.floor(emergence / 2);
            }
          }
        }
      } else if (
        ft.player() >= 0 &&
        S().any_where(ft.movable, function (t) {
          return !t.discovered;
        })
      ) {
        reFogLandPlayers.add(ft.player());
      }

      if (this.map.is_tile_friendly(ft)) continue;

      if (ft.delta.discovered) {
        for (var p3 = 0; p3 < this.map.players.length; p3++) this.valid_general_positions_by_player[p3].raw[ft.tile_index] = false;

        if (ft.isGeneral || (ft.isCity && ft.delta.discoveredExGeneralCity)) {
          var generalPositionPlayer = ft.player();
          if (!ft.isGeneral) generalPositionPlayer = -1;

          for (var p4 = 0; p4 < this.map.players.length; p4++) {
            var player4 = this.map.players[p4];
            if (player4.dead) continue;
            if (isPlayerOnTeamWith(this.map, player4.index, generalPositionPlayer)) {
              if (generalPositionPlayer !== player4.index && this.map.is_2v2) {
                var limitSpawnAroundAllyGen = function (t, dist) {
                  if (t.isObstacle || t.isCity) return true;
                  if (dist > MAX_ALLY_SPAWN_DISTANCE || dist < MIN_ALLY_SPAWN_DISTANCE) {
                    self.valid_general_positions_by_player[player4.index].discard(t);
                  }
                  return false;
                };
                S().breadth_first_foreach_dist(this.map, [ft], 1000, limitSpawnAroundAllyGen, null, false, true);
              }
              continue;
            }

            var playerIdx = player4.index;
            var limitSpawnAroundOtherGen = function (t) {
              self.valid_general_positions_by_player[playerIdx].discard(t);
              return false;
            };
            S().breadth_first_foreach(this.map, [ft], this.min_spawn_distance, limitSpawnAroundOtherGen, null, false, true);
          }

          if (generalPositionPlayer !== -1) {
            var allT = this.map.get_all_tiles();
            for (var gt = 0; gt < allT.length; gt++) {
              this.valid_general_positions_by_player[generalPositionPlayer].raw[allT[gt].tile_index] = false;
            }
            this.valid_general_positions_by_player[generalPositionPlayer].raw[ft.tile_index] = true;
          }
        }
      }
    }

    var mustReLimit = false;
    for (i = 0; i < flipped.length; i++) {
      if (flipped[i].player() === -1 && flipped[i].delta.discovered) {
        mustReLimit = true;
        break;
      }
    }

    if (mustReLimit) this.re_limit_gen_locations();

    for (i = 0; i < flipped.length; i++) {
      var ft2 = flipped[i];
      for (var p5 = 0; p5 < this.map.players.length; p5++) {
        var pObj = this.map.players[p5];
        if (pObj.general !== null) continue;
        if (!ft2.isGeneral || ft2.player() !== pObj.index) this.valid_general_positions_by_player[pObj.index].discard(ft2);
      }

      if (this.map.is_tile_friendly(ft2)) continue;
      if (ft2.player() === -1) continue;

      if (ft2.delta.gainedSight && ft2.delta.oldOwner === ft2.player()) {
        /* 走过去才看见的敌方格，早就属于对方了，不是涌现事件 */
        if (
          S().any_where(ft2.movable, function (t) {
            return !t.visible;
          })
        ) {
          this.discovered_enemy_land_connector_tiles[ft2.player()].add(ft2);
          reFogLandPlayers.add(ft2.player());
        }
        continue;
      }

      var skip = false;
      for (j = 0; j < ft2.movable.length; j++) {
        var mv3 = ft2.movable[j];
        if ((mv3.player() === ft2.player() || mv3.delta.oldOwner === ft2.player()) && !mv3.delta.gainedSight && mv3.discovered) skip = true;
      }
      if (skip) continue;

      if (this.pathed_fog_emergence_tiles.has(ft2)) continue;

      var pObj2 = this.map.players[ft2.player()];
      if ((pObj2.tileCount > 75 || pObj2.cityCount > 1) && !this.map.is_custom_map) continue;

      this.limit_gen_position_from_emergence(pObj2, ft2);
    }

    reFogLandPlayers.forEach(function (playerIdx2) {
      var p = self.map.players[playerIdx2];
      if (p.tileCount < 25) {
        var totalTiles = p.tileCount;
        var limitDist = totalTiles;
        var everOwned = self.tiles_ever_owned_by_player[p.index];
        everOwned.forEach(function (t) {
          if (t.player() !== p.index) {
            totalTiles += 1;
            limitDist += 1;
          }
          if (t.visible) limitDist -= 1;
        });

        var visibleElims = S().where(Array.from(everOwned), function (t) {
          return t.visible;
        });
        self._limit_general_position_to_within_tiles_and_distance(p.index, visibleElims, limitDist, false, null, -1, true);
      }
    });

    recheckPlayers.forEach(function (player) {
      self._check_over_elimination(player);
    });
  };

  P._handle_flipped_discovered_as_neutrals = function () {
    var alreadyRan = new Set();
    var flipped = Array.from(this._flipped_tiles);

    for (var i = 0; i < flipped.length; i++) {
      var tile = flipped[i];
      if (tile.delta.lostSight) {
        for (var a = 0; a < tile.adjacents.length; a++) {
          var adj = tile.adjacents[a];
          if (adj.delta.lostSight && tile.player() !== -1) this.tiles_ever_owned_by_player[tile.player()].add(adj);
        }
      }
    }

    for (var k = 0; k < flipped.length; k++) {
      var t = flipped[k];
      if (t.player() === -1 && !t.isMountain && !t.isCity && t.delta.discovered && !alreadyRan.has(t)) {
        alreadyRan.add(t);
        this.tile_discovered_neutral(t);
      }
    }

    for (var m = 0; m < flipped.length; m++) {
      var ft = flipped[m];
      for (var n = 0; n < ft.adjacents.length; n++) {
        var adj2 = ft.adjacents[n];
        if (adj2.player() === -1 && !adj2.isMountain && !adj2.isCity && adj2.delta.discovered && !alreadyRan.has(adj2)) {
          alreadyRan.add(adj2);
          this.tile_discovered_neutral(adj2);
        }
      }
    }

    if (alreadyRan.size > 0) this.re_limit_gen_locations();
  };

  /* ================================================================== *
   * 将军位置限制
   * ================================================================== */

  P.limit_gen_position_from_emergence = function (p, tile, emergenceAmount) {
    if (emergenceAmount === undefined) emergenceAmount = -1;
    var pLaunchTiming = byPlayer(this.player_launch_timings, tile.player()) || 0;

    var maxDist = this.map.turn - pLaunchTiming;
    maxDist = Math.min(maxDist, p.tileCount - 1);

    if (this.map.turn <= 100 && (pLaunchTiming > 17 || (pLaunchTiming > 13 && this.map.turn < pLaunchTiming * 3))) {
      var cycle1Trail1DistLimitAkaStartArmy = Math.floor(pLaunchTiming / 2);
      var trail1EndTurn = pLaunchTiming + cycle1Trail1DistLimitAkaStartArmy - 1;

      if (this.map.turn > trail1EndTurn + 1) {
        var expectedSecondLaunchArmy =
          Math.floor((pLaunchTiming + cycle1Trail1DistLimitAkaStartArmy) / 2) + 1 - cycle1Trail1DistLimitAkaStartArmy;
        var tilesCapturedInAddlLaunches = p.tileCount - cycle1Trail1DistLimitAkaStartArmy;
        var turnToRetraverseAndGetFurther = trail1EndTurn + cycle1Trail1DistLimitAkaStartArmy;

        if (tilesCapturedInAddlLaunches < expectedSecondLaunchArmy) {
          if (this.map.turn >= turnToRetraverseAndGetFurther) {
            var maxExtraDist = this.map.turn - turnToRetraverseAndGetFurther + 1;
            maxExtraDist = Math.min(maxExtraDist, tilesCapturedInAddlLaunches);
            if (maxDist > cycle1Trail1DistLimitAkaStartArmy + maxExtraDist) {
              maxDist = cycle1Trail1DistLimitAkaStartArmy + maxExtraDist;
            }
          } else if (trail1EndTurn < 44) {
            if (maxDist > cycle1Trail1DistLimitAkaStartArmy) maxDist = cycle1Trail1DistLimitAkaStartArmy;
          } else {
            maxDist = p.tileCount;
          }
        } else {
          if (this.map.turn <= 50) {
            if (maxDist > Math.max(tilesCapturedInAddlLaunches, cycle1Trail1DistLimitAkaStartArmy)) {
              maxDist = Math.max(tilesCapturedInAddlLaunches, cycle1Trail1DistLimitAkaStartArmy);
            }
          } else {
            if (maxDist > tilesCapturedInAddlLaunches + cycle1Trail1DistLimitAkaStartArmy) {
              maxDist = tilesCapturedInAddlLaunches + cycle1Trail1DistLimitAkaStartArmy;
            }
          }
        }

        if (maxDist < cycle1Trail1DistLimitAkaStartArmy) maxDist = cycle1Trail1DistLimitAkaStartArmy;
      } else {
        if (maxDist > cycle1Trail1DistLimitAkaStartArmy) maxDist = cycle1Trail1DistLimitAkaStartArmy;
      }
    }

    if ((tile.army > 2 && this.map.turn < 100) || (tile.army > 1 && this.map.turn < 50) || tile.was_visible_last_turn()) {
      var limitByRawStandingArmy = this.get_emergence_max_depth_to_general_or_none(p.index, tile, emergenceAmount);
      if (limitByRawStandingArmy !== null && maxDist > limitByRawStandingArmy) maxDist = limitByRawStandingArmy;
    }

    var increaseEmergence = this.map.turn < 51 || maxDist < 15;
    var unelim = this.uneliminated_emergence_events[p.index];
    var existingForTile = unelim.has(tile) ? unelim.get(tile) : 0;
    if (unelim.size === 0 || (unelim.size === 1 && existingForTile > maxDist)) {
      this.skip_emergence_tile_pathings.add(tile);
      if (tile.delta.fromTile !== null && tile.delta.fromTile !== undefined) this.skip_emergence_tile_pathings.add(tile.delta.fromTile);
      increaseEmergence = true;
    }

    this._limit_general_position_to_within_tile_and_distance(p.index, tile, maxDist, increaseEmergence, true, null, emergenceAmount, false);
  };

  P.re_limit_gen_locations = function () {
    for (var p = 0; p < this.uneliminated_emergence_events.length; p++) {
      this.re_limit_player_gen_locations(p, this.uneliminated_emergence_events[p]);
    }
  };

  P.re_limit_player_gen_locations = function (player, playerElimEvents) {
    if (player === this.map.player_index || this.map.teammates.has(player)) return;
    var self = this;
    playerElimEvents.forEach(function (prevElimDist, prevElimTile) {
      var cityPerfectInfo = self.uneliminated_emergence_event_city_perfect_info[player].has(prevElimTile);
      self._limit_general_position_to_within_tile_and_distance(player, prevElimTile, prevElimDist, false, false, cityPerfectInfo, -1, true);
    });
  };

  P._limit_general_position_to_within_tile_and_distance = function (
    player,
    tile,
    maxDist,
    alsoIncreaseEmergence,
    skipIfLongerThanExisting,
    overrideCityPerfectInfo,
    emergenceAmount,
    bypass2v2Partner
  ) {
    if (alsoIncreaseEmergence === undefined) alsoIncreaseEmergence = true;
    if (skipIfLongerThanExisting === undefined) skipIfLongerThanExisting = false;
    if (overrideCityPerfectInfo === undefined) overrideCityPerfectInfo = null;
    if (emergenceAmount === undefined) emergenceAmount = -1;
    if (bypass2v2Partner === undefined) bypass2v2Partner = false;

    if (!bypass2v2Partner && this.map.is_2v2) {
      var teammates = getTeammatesNoSelf(this.map, player);
      for (var i = 0; i < teammates.length; i++) {
        var teammate = teammates[i];
        if (!this.map.players[teammate].dead) {
          var allyMaxDist = maxDist + MAX_ALLY_SPAWN_DISTANCE;
          this._limit_general_position_to_within_tile_and_distance(
            teammate,
            tile,
            allyMaxDist,
            alsoIncreaseEmergence,
            skipIfLongerThanExisting,
            overrideCityPerfectInfo,
            emergenceAmount,
            true
          );
        }
      }
    }

    // py 用 list[-1] 表示「最后一个玩家」，notify_concrete_emergence 会带 -1 进来
    var playerUnelim = byPlayer(this.uneliminated_emergence_events, player);
    if (!playerUnelim) return;
    var existingLimit = playerUnelim.has(tile) ? playerUnelim.get(tile) : null;

    if (existingLimit !== null && existingLimit <= maxDist) {
      if (skipIfLongerThanExisting) return;
    }

    if (emergenceAmount === -1 && playerUnelim.size === 0) {
      emergenceAmount = Math.max(20, 5000 / this.map.turn);
    }

    var elims = this._limit_general_position_to_within_tiles_and_distance(
      player,
      [tile],
      maxDist,
      alsoIncreaseEmergence,
      overrideCityPerfectInfo,
      emergenceAmount,
      true
    );
    var shouldSave = elims > 0 || playerUnelim.size < 3;

    if (shouldSave && (existingLimit === null || existingLimit > maxDist)) {
      playerUnelim.set(tile, maxDist);
      var cityPerfectInfo = overrideCityPerfectInfo;
      if (cityPerfectInfo === null) cityPerfectInfo = this.has_perfect_information_of_player_cities(player);
      if (cityPerfectInfo) {
        var cityPerfectSet = byPlayer(this.uneliminated_emergence_event_city_perfect_info, player);
        if (cityPerfectSet) cityPerfectSet.add(tile);
      } else {
        var cityPerfectSet2 = byPlayer(this.uneliminated_emergence_event_city_perfect_info, player);
        if (cityPerfectSet2) cityPerfectSet2.delete(tile);
      }
    }

    if (elims > 0) this._check_over_elimination(player);
  };

  P._limit_general_position_to_within_tiles_and_distance = function (
    player,
    tiles,
    maxDist,
    alsoIncreaseEmergence,
    overrideCityPerfectInfo,
    emergenceAmount,
    dontCountSwamps
  ) {
    if (alsoIncreaseEmergence === undefined) alsoIncreaseEmergence = true;
    if (overrideCityPerfectInfo === undefined) overrideCityPerfectInfo = null;
    if (emergenceAmount === undefined) emergenceAmount = -1;
    if (dontCountSwamps === undefined) dontCountSwamps = true;

    var validSet = new Set();

    var playerLaunchTiming = byPlayer(this.player_launch_timings, player) || 0;
    var launchDist = Math.floor(playerLaunchTiming / 2) + 1;
    launchDist = Math.max(9, launchDist);
    var emFactor = 50;
    var divOffset = 1;

    if (this.map.turn > 50) {
      emFactor = 50;
      divOffset = 3;
    }

    if (emergenceAmount !== -1 && this.map.turn > 50) emFactor = emergenceAmount * 3;

    var hasPerfectInfoOfPlayerCities = overrideCityPerfectInfo;
    if (hasPerfectInfoOfPlayerCities === null || hasPerfectInfoOfPlayerCities === undefined) {
      hasPerfectInfoOfPlayerCities = this.has_perfect_information_of_player_cities(player);
    }

    // 这几张表都是按玩家下标建的；py 侧 player 可以是 -1（中立格涌现），list[-1] 取末项
    var validPositions = byPlayer(this.valid_general_positions_by_player, player);
    var emgMap = byPlayer(this.emergenceLocationMap, player);
    var everOwned = byPlayer(this.tiles_ever_owned_by_player, player);
    if (!validPositions || !emgMap || !everOwned) return 0;

    var limiter;
    if (alsoIncreaseEmergence) {
      limiter = function (t, dist) {
        if (validPositions.raw[t.tile_index]) {
          validSet.add(t.tile_index);
          var launchDistDiff = Math.abs(launchDist - dist);
          var launchDistFactor = divOffset + launchDistDiff;
          var launchEmergence = Math.floor(emFactor / launchDistFactor);
          emgMap.raw[t.tile_index] += launchEmergence;
        }
        if (t.discoveredAsNeutral && !everOwned.has(t)) return true;
        if (
          (t.isCostlyNeutralCity && (t.visible || hasPerfectInfoOfPlayerCities)) ||
          t.isMountain ||
          (t.isUndiscoveredObstacle && hasPerfectInfoOfPlayerCities) ||
          t.isGeneral
        ) {
          return true;
        }
        return false;
      };
    } else {
      limiter = function (t, dist) {
        void dist;
        if (validPositions.raw[t.tile_index]) validSet.add(t.tile_index);
        if (t.discoveredAsNeutral && !everOwned.has(t)) return true;
        if (
          (t.isCostlyNeutralCity && (t.visible || hasPerfectInfoOfPlayerCities)) ||
          t.isMountain ||
          (t.isUndiscoveredObstacle && hasPerfectInfoOfPlayerCities) ||
          t.isGeneral
        ) {
          return true;
        }
        return false;
      };
    }

    var starting = new Set();
    for (var i = 0; i < tiles.length; i++) {
      for (var m = 0; m < tiles[i].movable.length; m++) {
        var movable = tiles[i].movable[m];
        if (movable.isObstacle) continue;
        starting.add(movable);
      }
    }

    var startArr = Array.from(starting);
    if (dontCountSwamps) {
      S().breadth_first_foreach_dist_fast_free_swamp_no_default_skip(this.map, startArr, maxDist - 1, limiter);
    } else {
      S().breadth_first_foreach_dist_fast_no_default_skip(this.map, startArr, maxDist - 1, limiter);
    }

    if (validSet.size === 0) {
      this._check_over_elimination(player);
      return 0;
    }

    var elims = 0;
    for (var ti = 0; ti < this.map.tiles_by_index.length; ti++) {
      var t2 = this.map.tiles_by_index[ti];
      if (!validSet.has(t2.tile_index) && validPositions.raw[t2.tile_index]) {
        elims += 1;
        validPositions.raw[t2.tile_index] = false;
      }
    }

    return elims;
  };

  P._initialize_viable_general_positions = function () {
    var ourGens = [this.map.generals[this.map.player_index]];
    this.seen_player_lookup[this.map.player_index] = true;
    var mates = Array.from(this.map.teammates);
    for (var m = 0; m < mates.length; m++) {
      if (this.map.generals[mates[m]] !== null) ourGens.push(this.map.generals[mates[m]]);
      this.seen_player_lookup[mates[m]] = true;
    }

    for (var p = 0; p < this.map.players.length; p++) {
      var player = this.map.players[p];
      var mm = this.valid_general_positions_by_player[player.index];

      if (player.general !== null && player.general !== undefined) {
        mm.add(player.general);
        continue;
      }

      var validTiles = this.map.valid_spawns;
      if (validTiles === null || validTiles === undefined) validTiles = this.map.get_all_tiles();

      for (var t = 0; t < validTiles.length; t++) {
        var tile = validTiles[t];
        if (tile.isObstacle || tile.isCity) continue;
        if (tile.visible) continue;
        if (tile.discovered) continue;
        if (tile.isSwamp) continue;
        if (tile.isDesert) continue;
        mm.raw[tile.tile_index] = true;
      }
    }

    for (var g = 0; g < this.map.generals.length; g++) {
      var general = this.map.generals[g];
      if (general === null || general === undefined) continue;

      var distances = this.map.distance_mapper.get_tile_dist_matrix(general);

      for (var pi = 0; pi < this.map.players.length; pi++) {
        var player2 = this.map.players[pi];
        var mm2 = this.valid_general_positions_by_player[player2.index];
        if (isPlayerOnTeamWith(this.map, general.player(), player2.index)) {
          mm2.discard(general);
          continue;
        }

        var allTiles = this.map.get_all_tiles();
        for (var at = 0; at < allTiles.length; at++) {
          var tile2 = allTiles[at];
          var dist = this.map.manhattan_dist(tile2, general);
          if (dist < this.min_spawn_distance) {
            mm2.discard(tile2);
            continue;
          }
          if (distances.raw[tile2.tile_index] === 1000 && !this.map.is_custom_map) mm2.discard(tile2);
        }
      }
    }
    void ourGens;
  };

  P._check_over_elimination = function (player) {
    if (player === -1) return;
    if (this.map.players[player].dead) return;
    if (player === this.map.player_index) return;
    if (this.map.teammates.has(player)) return;

    var validGenPos = this.valid_general_positions_by_player[player];
    var numValid = 0;
    var lastValid = null;
    var genPos = this.map.pathable_tiles;
    if (this.map.valid_spawns) genPos = this.map.valid_spawns;

    var genPosArr = toArray(genPos);
    for (var i = 0; i < genPosArr.length; i++) {
      var tile = genPosArr[i];
      if (tile.player() >= 0 && tile.discovered && !tile.isGeneral) {
        validGenPos.raw[tile.tile_index] = false;
        continue;
      }
      if (validGenPos.raw[tile.tile_index]) {
        numValid += 1;
        lastValid = tile;
      }
    }

    var mustResetAndIncrease = false;
    if (numValid === 0) mustResetAndIncrease = true;

    if (numValid === 1) {
      if (lastValid.visible || lastValid.discovered) {
        if (!lastValid.isGeneral) mustResetAndIncrease = true;
      } else {
        if (!lastValid.isGeneral) {
          if (lastValid.player() !== -1 && lastValid.player() !== player) {
            mustResetAndIncrease = true;
          } else {
            lastValid.isGeneral = true;
            lastValid.setPlayer(player);
            this.map.generals[player] = lastValid;
            this.map.players[player].general = lastValid;
          }
        } else if (lastValid.player() !== player) {
          mustResetAndIncrease = true;
        }
      }
    }

    if (mustResetAndIncrease) {
      var validTiles = this.map.pathable_tiles;
      if (this.map.valid_spawns) validTiles = this.map.valid_spawns;
      var validArr = toArray(validTiles);
      for (var v = 0; v < validArr.length; v++) {
        var t2 = validArr[v];
        if (!t2.discovered && !t2.isCity && !t2.visible && !t2.isGeneral && (t2.player() === -1 || t2.player() === player)) {
          validGenPos.raw[t2.tile_index] = true;
        }
      }
      var playerEvents = byPlayer(this.uneliminated_emergence_events, player);
      if (!playerEvents) return;
      var entries = Array.from(playerEvents.entries());
      for (var e = 0; e < entries.length; e++) playerEvents.set(entries[e][0], entries[e][1] + 2);
      this.re_limit_player_gen_locations(player, playerEvents);
    }
  };

  /* ================================================================== *
   * 迷雾军队沿期望路径推进
   * ================================================================== */

  P.update_track_threshold = function () {
    var tilesRankedByArmy = S().where(
      Array.from(this.map.pathable_tiles),
      function (t) {
        return t.player() !== -1;
      }
    );
    tilesRankedByArmy.sort(function (a, b) {
      return a.army - b.army;
    });
    var percentile = 96;
    var percentileIndex = Math.floor((percentile * tilesRankedByArmy.length) / 100);
    if (percentileIndex >= tilesRankedByArmy.length) percentileIndex = tilesRankedByArmy.length - 1;
    if (percentileIndex < 0) return;
    var tileAtPercentile = tilesRankedByArmy[percentileIndex];
    if (tileAtPercentile.army - 1 > this.track_threshold) this.track_threshold = tileAtPercentile.army - 1;
  };

  P._move_fogged_army_along_path = function (army, path, armyAlreadyPopped) {
    armyAlreadyPopped = !!armyAlreadyPopped;

    var isCompletePath =
      path === null ||
      path === undefined ||
      path.start === null ||
      path.start === undefined ||
      path.start.next === null ||
      path.start.next === undefined ||
      path.start.next.tile === null ||
      path.start.next.tile === undefined;

    if (isCompletePath) removeFromArray(army.expectedPaths, path);

    if (isCompletePath || path.start.next.tile.visible) {
      army.value = army.tile.army - 1;
      /* 停在可见格上的 0 值 tracker 不是军队，别留在表里 */
      if (army.value <= 0) this.scrap_army(army, false);
      return;
    }

    var nextTile = path.start.next.tile;
    if (!nextTile.visible) {
      /* 走到自己头上会造成重复追踪 */
      if (nextTile === army.tile) return;

      var existingArmy = this.armies.get(nextTile);
      if (existingArmy !== undefined && existingArmy !== null && existingArmy === army) existingArmy = null;
      if (existingArmy === undefined) existingArmy = null;

      if (!armyAlreadyPopped) this.armies.delete(army.tile);

      var oldTile = army.tile;
      army.record_fog_tile_revert(oldTile);
      army.record_fog_tile_revert(nextTile);
      /* 可见格的兵数永远不许被改写 */
      if (!oldTile.visible) {
        oldTile.army = 1;
        if ((this.map.is_city_bonus_turn && oldTile.isCity) || oldTile.isGeneral) oldTile.army += 1;
        if (this.map.is_army_bonus_turn) oldTile.army += 1;
      }

      if (existingArmy !== null) {
        if (army.entangledArmies.indexOf(existingArmy) >= 0) {
          existingArmy.last_moved_turn = this.map.turn - 1;
          existingArmy.value = existingArmy.tile.army - 1;
          this.scrap_army(army, false);
          return;
        }
      }

      if (!nextTile.visible) {
        if (nextTile.player() === army.player) {
          nextTile.army = nextTile.army + army.value;
        } else {
          if (nextTile.player() !== army.player && !nextTile.discovered) nextTile.isTempFogPrediction = true;
          nextTile.army = nextTile.army - army.value;
        }
        if (nextTile.army < 0) nextTile.army = 0 - nextTile.army;
        if (!nextTile.isGeneral) nextTile.setPlayer(army.player);
      }

      if (existingArmy !== null) {
        if (existingArmy.player === army.player) {
          if (existingArmy.value > army.value) this.merge_armies(existingArmy, army, nextTile);
          else this.merge_armies(army, existingArmy, nextTile);
          return;
        }
      }

      army.update_tile(nextTile);
      army.value = nextTile.army - 1;
      this.armies.set(nextTile, army);
      path.remove_start();
      return;
    }
  };

  /* ================================================================== *
   * 迷雾湮灭 / 沉兵
   * ================================================================== */

  P.try_find_army_sink = function (player, annihilatedFogArmy, tookNeutCity) {
    var self = this;
    var possibleArmies = [];
    this.armies.forEach(function (army) {
      if (army.player !== player) return;
      if (army.visible) return;
      possibleArmies.push(army);
    });

    possibleArmies.sort(function (a, b) {
      return Math.abs(annihilatedFogArmy - a.value - 1) + distBetween(self.map, self.general, a.tile) -
        (Math.abs(annihilatedFogArmy - b.value - 1) + distBetween(self.map, self.general, b.tile));
    });

    var ranges = [
      [0, 5],
      [5, 9],
      [9, 15]
    ];
    for (var r = 0; r < ranges.length; r++) {
      var fromRange = ranges[r][0];
      var toRange = ranges[r][1];
      for (var i = 0; i < possibleArmies.length; i++) {
        var army = possibleArmies[i];
        var seenAgo = this.map.turn - army.last_seen_turn;
        if (seenAgo >= toRange) continue;
        if (seenAgo < fromRange) continue;
        if (tookNeutCity) {
          var cutoff = Math.min(14, 1 + seenAgo);
          var potentialCity = this.find_next_fog_city_candidate_near_tile(player, army.tile, cutoff, 3, 2.0, 1.0, false, false);
          if (potentialCity !== null) {
            this.convert_fog_city_to_player_owned(potentialCity, player);
            var split = army.get_split_for_fog([army.tile, potentialCity]);
            var ogArmySplit = split[0];
            this.armies.set(army.tile, ogArmySplit);
            army = split[1];
            army.path = new Path();
            army.update_tile(potentialCity);
            potentialCity.army = Math.max(1, army.value - annihilatedFogArmy);
            army.value = Math.max(0, army.value - annihilatedFogArmy);
            army.tile.army = army.value + 1;
            for (var e = 0; e < army.entangledArmies.length; e++) {
              army.entangledArmies[e].value = Math.max(0, army.entangledArmies[e].value - annihilatedFogArmy);
              army.entangledArmies[e].tile.army = army.entangledArmies[e].value + 1;
            }
            army.expectedPaths = ArmyTracker.get_army_expected_path(this.map, army, this.general, this.player_targets, null, this.log_debug);
            this.armies.set(army.tile, army);
            army.last_moved_turn = this.map.turn;
            return true;
          }

          this._reduce_army_sink_for_fog_annihilation(army, annihilatedFogArmy);
          return true;
        } else {
          this._reduce_army_sink_for_fog_annihilation(army, annihilatedFogArmy);
          return true;
        }
      }
    }

    return false;
  };

  P._reduce_army_sink_for_fog_annihilation = function (army, annihilatedFogArmy) {
    army.value -= annihilatedFogArmy;
    if (army.value < 0) army.value = 0;
    army.tile.army = army.value + 1;
    for (var i = 0; i < army.entangledArmies.length; i++) {
      var entangled = army.entangledArmies[i];
      entangled.value = Math.max(0, entangled.value - annihilatedFogArmy);
      entangled.tile.army = entangled.value + 1;
    }
  };

  /* ================================================================== *
   * 迷雾陆地（fog land）预测
   * ================================================================== */

  P._inc_slash_dec_fog_prediction_to_get_player_tile_count_right = function (playerIndex, playerExpectedFogTileCounts, predictedGeneralLocation) {
    var player = this.map.players[playerIndex];
    var tileDiff = player.tileCount - player.tiles.length;

    if (tileDiff > 0) {
      var counts = Object.assign({}, playerExpectedFogTileCounts);
      for (var i = 0; i < player.tiles.length; i++) {
        var tile = player.tiles[i];
        if (tile.visible) continue;
        var curCount = counts[tile.army];
        if (curCount === undefined) continue;
        if (curCount > 1) counts[tile.army] = curCount - 1;
        else delete counts[tile.army];
      }

      var connectedTiles = new Set(player.tiles);
      var setTilesToConvert = new Set();
      var connectedDark = new Set();
      connectedTiles.forEach(function (t) {
        if (!t.visible) connectedDark.add(t);
      });
      var tempPredictions = this._fill_land_from_connected_tiles_for_player(
        playerIndex,
        new Set(),
        connectedDark,
        connectedTiles,
        0,
        tileDiff,
        this.general,
        null,
        counts,
        setTilesToConvert
      );
      var self = this;
      tempPredictions.forEach(function (t) {
        self.map.players[player.index].tiles.push(t);
      });
    } else if (tileDiff < 0) {
      var removable = new (S().HeapQueue)();
      for (var t2 = 0; t2 < player.tiles.length; t2++) {
        var tile2 = player.tiles[t2];
        if (tile2.isTempFogPrediction) removable.put([0 - distBetween(this.map, this.general, tile2), tile2]);
      }

      while (tileDiff < 0 && removable.queue.length > 0) {
        var popped = removable.get();
        var removeTile = popped[1];
        this.reset_temp_tile_marked(removeTile, false);
        tileDiff += 1;
        removeFromArray(this.map.players[player.index].tiles, removeTile);
      }
    }
  };

  P._build_fog_prediction_internal = function (player, playerExpectedFogTileCounts, predictedGeneralLocation) {
    var self = this;
    var playerObj = this.map.players[player];
    if (playerObj.dead) return;

    var ourGen = this.map.generals[this.map.player_index];
    var connected = this.get_fog_connected_based_on_emergences(player, predictedGeneralLocation, null);
    var bannedTiles = connected[0];
    var connectedTiles = connected[1];
    var coreConnected = connected[2];
    var pathToUnelim = connected[3];

    this.connectedByPlayer[player] = connectedTiles;
    this.coreConnectedByPlayer[player] = coreConnected;
    if (coreConnected.size === 0 && predictedGeneralLocation !== null && predictedGeneralLocation !== undefined) {
      coreConnected.add(predictedGeneralLocation);
      connectedTiles.add(predictedGeneralLocation);
    }

    var keep = [];
    for (var i = 0; i < playerObj.tiles.length; i++) {
      var tile = playerObj.tiles[i];
      if (tile.isTempFogPrediction && !tile.discovered && !this.armies.has(tile) && !tile.isGeneral && !tile.isCity) {
        mapResetWrongUndiscoveredFogGuess(this.map, tile);
      } else {
        keep.push(tile);
        if (!tile.visible) {
          var amt = playerExpectedFogTileCounts[tile.army] || 0;
          if (amt > 0) playerExpectedFogTileCounts[tile.army] = amt - 1;
        }
      }
    }

    this.map.players[player].tiles = keep;

    var tilesToConvertToTempPlayer = new Set();

    var numTilesToFillIn = this.map.players[player].tileCount - this.map.players[player].tiles.length;

    var connectedDark = [];
    connectedTiles.forEach(function (t) {
      if (
        !t.visible ||
        S().any_where(t.movable, function (m) {
          return !m.visible;
        })
      ) {
        connectedDark.push(t);
      }
    });

    var numStartTilesToFill = Math.min(numTilesToFillIn, 24) - connectedDark.length;

    var tempPredictions = this._fill_land_from_connected_tiles_for_player(
      player,
      bannedTiles,
      connectedDark,
      connectedTiles,
      numStartTilesToFill,
      numTilesToFillIn,
      ourGen,
      pathToUnelim,
      playerExpectedFogTileCounts,
      tilesToConvertToTempPlayer
    );

    for (var t = 0; t < tempPredictions.length; t++) this.map.players[player].tiles.push(tempPredictions[t]);
    void self;
  };

  P.get_fog_connected_based_on_emergences = function (player, predictedGeneralLocation, additionalRequiredTiles) {
    var self = this;
    var tilesEverOwned = byPlayer(this.tiles_ever_owned_by_player, player);
    var uneliminated = byPlayer(this.uneliminated_emergence_events, player);
    var unrecapturedEmergenceEvents = byPlayer(this.unrecaptured_emergence_events, player);
    var validGenSpots = byPlayer(this.valid_general_positions_by_player, player);
    if (!tilesEverOwned || !uneliminated || !validGenSpots) {
      // 调用点按四元组解构（banned/connected/core/path），兜底也要给同形状的空值
      return [new MapMatrixSet(this.map), new Set(), new Set(), new Map()];
    }
    var teamStats = getTeamStats(this.map, player);
    var perfectInfo = teamStats.cityCount === teamStats.teamPlayers.length;
    var bannedTiles = new MapMatrixSet(this.map);

    var allTiles = this.map.get_all_tiles();
    for (var i = 0; i < allTiles.length; i++) {
      var tile = allTiles[i];
      if (
        (tile.discoveredAsNeutral || tile.visible) &&
        !uneliminated.has(tile) &&
        !unrecapturedEmergenceEvents.has(tile) &&
        !tilesEverOwned.has(tile)
      ) {
        bannedTiles.add(tile);
      } else if (tile.isObstacle && perfectInfo) {
        bannedTiles.add(tile);
      }
    }

    var requiredTiles = [];
    var requiredIncluded = new Set();
    uneliminated.forEach(function (dist, t) {
      void dist;
      if (!requiredIncluded.has(t)) {
        requiredIncluded.add(t);
        requiredTiles.push(t);
      }
    });

    unrecapturedEmergenceEvents.forEach(function (t) {
      if (!requiredIncluded.has(t)) {
        requiredIncluded.add(t);
        requiredTiles.push(t);
      }
    });

    if (additionalRequiredTiles !== null && additionalRequiredTiles !== undefined) {
      for (var a = 0; a < additionalRequiredTiles.length; a++) {
        var t2 = additionalRequiredTiles[a];
        if (!requiredIncluded.has(t2)) {
          requiredIncluded.add(t2);
          requiredTiles.push(t2);
        }
      }
    }

    if (requiredIncluded.size === 0) {
      tilesEverOwned.forEach(function (t) {
        if (t.isNotPathable) return;
        if (
          !S().any_where(t.movable, function (m) {
            return !m.visible;
          })
        ) {
          return;
        }
        requiredIncluded.add(t);
        requiredTiles.push(t);
      });
    }

    var treeResult = getSpanningTreeSetFromTileLists(this.map, requiredTiles, bannedTiles);
    var connectedSet = treeResult[0];
    var missingRequired = treeResult[1];
    this.unconnectable_tiles[player] = missingRequired;
    var coreConnected = trimSpanningTreeEndsAsNewSet(connectedSet, 5, Math.floor(0.49 + connectedSet.size / 3));

    this.player_connected_tiles[player] = connectedSet;

    var pathToUnelim = null;
    if (predictedGeneralLocation !== null && predictedGeneralLocation !== undefined) {
      if (!connectedSet.has(predictedGeneralLocation)) {
        pathToUnelim = S().breadth_first_find_queue(
          this.map,
          [predictedGeneralLocation],
          function (t) {
            return connectedSet.has(t);
          },
          { noNeutralCities: true, skipTiles: bannedTiles, noLog: true }
        );
      }

      if (pathToUnelim === null || pathToUnelim === undefined) {
        pathToUnelim = S().breadth_first_find_queue(
          this.map,
          toArray(validGenSpots),
          function (t) {
            return connectedSet.has(t);
          },
          { noNeutralCities: true, skipTiles: bannedTiles, noLog: true }
        );
      }
    }

    if (pathToUnelim !== null && pathToUnelim !== undefined) {
      pathToUnelim = pathToUnelim.get_reversed();
      for (var pt = 0; pt < pathToUnelim.tileList.length; pt++) {
        if (!connectedSet.has(pathToUnelim.tileList[pt])) connectedSet.add(pathToUnelim.tileList[pt]);
      }
    }

    this._connect_discovered_enemy_land_connector_tiles(player, connectedSet, bannedTiles);
    coreConnected = trimSpanningTreeEndsAsNewSet(connectedSet, 5, Math.floor(0.49 + connectedSet.size / 3));

    void self;
    return [bannedTiles, connectedSet, coreConnected, pathToUnelim];
  };

  P._connect_discovered_enemy_land_connector_tiles = function (player, connectedSet, bannedTiles) {
    var tiles = Array.from(this.discovered_enemy_land_connector_tiles[player]);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (
        tile.player() !== player ||
        !S().any_where(tile.movable, function (t) {
          return !t.visible;
        })
      ) {
        this.discovered_enemy_land_connector_tiles[player].delete(tile);
        continue;
      }
      if (connectedSet.has(tile) || connectedSet.size === 0) continue;

      var pathToConnectedLand = S().breadth_first_find_queue(
        this.map,
        [tile],
        function (t) {
          return connectedSet.has(t);
        },
        { noNeutralCities: true, skipTiles: bannedTiles, noLog: true }
      );
      if (pathToConnectedLand === null || pathToConnectedLand === undefined) continue;

      for (var p = 0; p < pathToConnectedLand.tileList.length; p++) {
        if (!connectedSet.has(pathToConnectedLand.tileList[p])) connectedSet.add(pathToConnectedLand.tileList[p]);
      }
    }
  };

  P.get_team_missing_city_count_by_player = function (player) {
    var unkCount = 0;
    var teammates = this.map.get_teammates(player);
    for (var i = 0; i < teammates.length; i++) {
      var p = this.map.players[teammates[i]];
      if (p === undefined || p.dead) continue;
      unkCount += p.cityCount - 1 - p.cities.length;
    }
    return Math.max(0, unkCount);
  };

  P._fill_land_from_connected_tiles_for_player = function (
    player,
    bannedTiles,
    connectedDark,
    connectedTiles,
    numStartTilesToFill,
    numTilesToFillIn,
    ourGen,
    pathToPotentialEnGeneral,
    playerExpectedFogTileCounts,
    outputTilesToBeConverted
  ) {
    var secondIterConnected = new Set(connectedTiles);
    if (pathToPotentialEnGeneral !== null && pathToPotentialEnGeneral !== undefined) {
      for (var i = 0; i < pathToPotentialEnGeneral.tileList.length; i++) secondIterConnected.add(pathToPotentialEnGeneral.tileList[i]);
    }
    if (pathToPotentialEnGeneral !== null && pathToPotentialEnGeneral !== undefined) {
      /* 这条禁令防止把 connectedDark 重复填充：可以路过，但不写回 */
      /* bannedTiles 是 MapMatrixSet（平表，不是 iterable），必须先摊成数组 */
      var nearGenBan = new Set(toArray(bannedTiles));
      connectedDark.forEach(function (t) {
        nearGenBan.add(t);
      });

      var approxEnGen = pathToPotentialEnGeneral.tail.tile;

      var numMissingCities = this.get_team_missing_city_count_by_player(player);
      while (numMissingCities > 0 && numMissingCities < 20) {
        var cutoffDist = Math.max(1, Math.min(10, numStartTilesToFill - outputTilesToBeConverted.size - numMissingCities));
        var potCity = this.find_next_fog_city_candidate_near_tile(player, approxEnGen, cutoffDist, 5, 4, 1.0, false, false);
        if (potCity === null) break;
        numMissingCities -= 1;
        outputTilesToBeConverted.add(potCity);
        this.determine_tiles_to_fill_in(outputTilesToBeConverted, nearGenBan, outputTilesToBeConverted, numStartTilesToFill + 1);
      }

      nearGenBan.delete(pathToPotentialEnGeneral.tail.tile);
      this.determine_tiles_to_fill_in([approxEnGen], nearGenBan, outputTilesToBeConverted, numStartTilesToFill + 1);
      secondIterConnected = new Set();
      connectedTiles.forEach(function (t) {
        secondIterConnected.add(t);
      });
      outputTilesToBeConverted.forEach(function (t) {
        secondIterConnected.add(t);
      });
    }

    this.determine_tiles_to_fill_in(secondIterConnected, bannedTiles, outputTilesToBeConverted, numTilesToFillIn);
    var currentTileAmount = new (S().Counter)(1);
    var countKeys = Object.keys(playerExpectedFogTileCounts);
    if (countKeys.length > 0) {
      var maxKey = -Infinity;
      for (var k = 0; k < countKeys.length; k++) maxKey = Math.max(maxKey, countKeys[k] | 0);
      currentTileAmount.value = maxKey;
    }
    if (countKeys.length === 0) playerExpectedFogTileCounts[1] = 1;
    var tileAmountLeft = new (S().Counter)(playerExpectedFogTileCounts[currentTileAmount.value]);
    var tempPredictions = [];
    var overwriteArmyThresh = Math.floor(this.track_threshold / 2) + 1;
    var updateReachable = [false];
    var self = this;

    var foreachConverterFunc = function (tile) {
      if (tile.visible) return false;
      if (tile.army > overwriteArmyThresh) return false;
      if (tile.isGeneral || tile.isCostlyNeutralCity) return false;
      if (!outputTilesToBeConverted.has(tile)) return tile.isObstacle;

      tile.isTempFogPrediction = true;
      tempPredictions.push(tile);
      tile.army = currentTileAmount.value;
      tileAmountLeft.value -= 1;
      while (tileAmountLeft.value <= 0 && currentTileAmount.value > 1) {
        currentTileAmount.value -= 1;
        var nextCount = playerExpectedFogTileCounts[currentTileAmount.value];
        tileAmountLeft.value = nextCount === undefined ? 0 : nextCount;
      }

      tile.setPlayer(player);
      if (tile.isUndiscoveredObstacle || (tile.isCity && tile.player() === -1)) {
        self.convert_fog_city_to_player_owned(tile, player);
        updateReachable[0] = true;
      }
      return false;
    };

    S().breadth_first_foreach_dist_fast_incl_neut_cities(
      this.map,
      this.map.players[this.map.player_index].tiles,
      250,
      foreachConverterFunc
    );
    if (updateReachable[0]) this.map.update_reachable();

    void ourGen;
    void connectedDark;
    return tempPredictions;
  };

  P.determine_tiles_to_fill_in = function (connectedDark, bannedTiles, tilesToConvertToAddTo, numTilesToFillIn) {
    var self = this;
    var beforeCount = tilesToConvertToAddTo.size;
    var connectedDarkList = toArray(connectedDark);
    var preseededConnectedDark = 0;
    var skips = new Set(toArray(bannedTiles));
    for (var i = 0; i < connectedDarkList.length; i++) skips.delete(connectedDarkList[i]);
    for (var j = 0; j < connectedDarkList.length; j++) {
      var tile = connectedDarkList[j];
      if (!tile.discovered && tile.player() === -1) {
        tilesToConvertToAddTo.add(tile);
        preseededConnectedDark += 1;
      }
    }

    var numFillTilesNeeded = numTilesToFillIn;
    var deferredVisionEdgeTileSet = new Set();
    var deferVisionBaseline = new Set();

    var deferForeach = function (t) {
      if (!t.visible && skips.has(t)) return true;
      if (
        t.player() !== -1 &&
        t.visible &&
        (!t.discoveredAsNeutral || self.map.team_ids_by_player_index[t.player()] !== self.map.friendly_team)
      ) {
        return true;
      }
      deferVisionBaseline.add(t);
      return false;
    };
    S().breadth_first_foreach_fast_no_neut_cities(this.map, this.map.players[this.map.player_index].tiles, 5, deferForeach);

    var is_vision_edge_tile = function (tile2) {
      return deferVisionBaseline.has(tile2);
    };

    var add_deferred_vision_edge_tiles_if_needed = function () {
      for (var d of deferredVisionEdgeTileSet) {
        if (tilesToConvertToAddTo.size >= numFillTilesNeeded) return;
        tilesToConvertToAddTo.add(d);
      }
    };

    var findFunc = function (t) {
      if (tilesToConvertToAddTo.size >= numFillTilesNeeded) return true;
      if (t.player() === -1 && !tilesToConvertToAddTo.has(t) && !t.isSwamp) {
        if (is_vision_edge_tile(t)) {
          if (!deferredVisionEdgeTileSet.has(t) && connectedDarkList.indexOf(t) < 0) deferredVisionEdgeTileSet.add(t);
          return false;
        }
        tilesToConvertToAddTo.add(t);
      }
      return false;
    };

    var fakePath = S().breadth_first_find_queue(this.map, connectedDarkList, findFunc, { skipTiles: skips, noNeutralCities: true, noLog: true });
    add_deferred_vision_edge_tiles_if_needed();
    if (fakePath === null || fakePath === undefined) {
      if (tilesToConvertToAddTo.size < numFillTilesNeeded) {
        fakePath = S().breadth_first_find_queue(this.map, connectedDarkList, findFunc, { skipTiles: skips, noLog: true });
        add_deferred_vision_edge_tiles_if_needed();
      }
    }
    void beforeCount;
    void preseededConnectedDark;
    void self;
  };

  /* ================================================================== *
   * 地图生成割线（BotGather 用，非追踪必需）
   * ================================================================== */

  P.find_territory_bisection_paths = function (targetPlayer) {
    var self = this;
    var bisectPaths = [];
    var bisectCandidates = new MapMatrix(this.map, false);
    var bisectDistances = new MapMatrix(this.map, 100);

    var everPlayerTiles = this.tiles_ever_owned_by_player[targetPlayer];
    var playerValid = this.valid_general_positions_by_player[targetPlayer];

    var enemyBisectableStart = Array.from(everPlayerTiles);

    var foreachFunc = function (t, d) {
      bisectDistances.raw[t.tile_index] = d;
      if (d > 3 && !t.discovered && playerValid.has(t)) bisectCandidates.raw[t.tile_index] = true;
      if (t.discoveredAsNeutral) return true;
      if (t.visible && !everPlayerTiles.has(t)) return true;
      return false;
    };

    S().breadth_first_foreach_dist(this.map, enemyBisectableStart, 150, foreachFunc);

    var startTiles = new Map();
    var myTiles = this.map.players[this.map.player_index].tiles;
    for (var i = 0; i < myTiles.length; i++) startTiles.set(myTiles[i], [[0, 100, 0, 0, null], 0]);

    var valFunc = function (curTile, curPrio) {
      void curTile;
      var dist = curPrio[0];
      var negBisects = curPrio[3];
      if (dist === 0) return null;
      return negBisects;
    };

    var prioFunc = function (nextTile, lastPrio) {
      var dist = lastPrio[0];
      var negBisectDistAvg = lastPrio[1];
      var negBisectDistSum = lastPrio[2];
      var negBisects = lastPrio[3];
      dist += 1;
      if (bisectCandidates.raw[nextTile.tile_index]) {
        negBisectDistSum -= bisectDistances.raw[nextTile.tile_index];
        negBisects -= 1;
        negBisectDistAvg = negBisectDistSum / dist;
      }
      return [dist, negBisectDistAvg, negBisectDistSum, negBisects, nextTile];
    };

    var skipFuncDynamic = function (tile, prioObj) {
      void prioObj;
      if (tile.visible && !isPlayerOnTeamWith(self.map, tile.player(), targetPlayer) && prioObj[0] > 2) return true;
      if (!tile.discovered && !bisectCandidates.raw[tile.tile_index]) return true;
      return false;
    };

    var results = S().breadth_first_dynamic_max_per_tile_global_visited(this.map, startTiles, valFunc, {
      priorityFunc: prioFunc,
      skipFunc: skipFuncDynamic
    });

    var bestCandidates = new (S().HeapQueue)();

    results.forEach(function (resultPath) {
      var bisectDistSum = 0;
      var bisects = 0;
      for (var t = 0; t < resultPath.tileList.length; t++) {
        var tile = resultPath.tileList[t];
        if (bisectCandidates.raw[tile.tile_index]) {
          bisectDistSum += bisectDistances.raw[tile.tile_index];
          bisects += 1;
        }
      }
      if (bisects === 0) return;
      bestCandidates.put([bisectDistSum / bisects, resultPath]);
    });

    var bannedTiles = new Set();
    while (bestCandidates.queue.length > 0) {
      var popped = bestCandidates.get();
      var path = popped[1];
      var skip = false;
      for (var p = 0; p < path.tileList.length; p++) {
        if (bannedTiles.has(path.tileList[p])) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      for (var p2 = 0; p2 < path.tileList.length; p2++) bannedTiles.add(path.tileList[p2]);
      bisectPaths.push(path);
    }

    return [bisectCandidates, bisectDistances, bisectPaths];
  };

  P.add_emergence_around_minimum_connected_tree = function (connectedTiles, requiredTiles, player) {
    var enPlayer = this.map.players[player];
    var emergeMap = this.emergenceLocationMap[player];
    var validMap = this.valid_general_positions_by_player[player];

    var basis = enPlayer.tileCount - connectedTiles.length;
    var factor = 1.0;
    if (requiredTiles.length === 2) {
      var distBetweenTiles = connectedTiles.length;
      if (distBetweenTiles > Math.floor(enPlayer.tileCount / 2)) {
        basis = Math.floor(basis / 2);
        factor = 30.0;
      } else if (distBetweenTiles > Math.floor(enPlayer.tileCount / 4)) {
        basis = (2 * basis) / 3;
        factor = 10.0;
      }
    } else if (basis > 15) {
      basis = Math.floor(Math.sqrt(basis) + 1);
    }
    var depth = basis;

    var foreachFunc = function (tile) {
      if (validMap.has(tile)) emergeMap.raw[tile.tile_index] += factor;
      return undefined;
    };

    S().breadth_first_foreach(this.map, connectedTiles, depth, foreachFunc, null, true, false);
  };

  /* ================================================================== *
   * 最小生成树（MapSpanningUtils.py 的内联移植，只搬 ArmyTracker 用到的两个）
   * ================================================================== */

  function includeAllAdjRequired(node, includedSet, usefulStartSet, missingIncludedSet, costPer) {
    var q = [node];
    while (q.length > 0) {
      var tile = q.pop();
      if (includedSet.has(tile)) continue;
      includedSet.add(tile);
      usefulStartSet.add(tile);
      if (missingIncludedSet.has(tile)) {
        missingIncludedSet.delete(tile);
        costPer.set(tile, 1);
      }
      for (var i = 0; i < tile.movable.length; i++) {
        var movable = tile.movable[i];
        if (!missingIncludedSet.has(movable)) continue;
        q.push(movable);
      }
    }
  }

  function getSpanningTreeSetFromTileLists(map, requiredTiles, bannedSet) {
    var includedSet = new Set();
    var missingIncluded = new Set(requiredTiles);
    var costPer = new Map();

    /* bannedSet 可能是 MapMatrixSet（Python 那边是 set），两种都支持 */
    for (var i = 0; i < requiredTiles.length; i++) removeFromCollection(bannedSet, requiredTiles[i]);

    if (requiredTiles.length === 0) return [includedSet, missingIncluded];

    var root = requiredTiles[0];
    var usefulStartSet = new Set();

    includeAllAdjRequired(root, includedSet, usefulStartSet, missingIncluded, costPer);

    var findFunc = function (t) {
      return missingIncluded.has(t);
    };

    var guard = 0;
    while (missingIncluded.size > 0) {
      guard += 1;
      if (guard > 500) break;
      var path = S().breadth_first_find_queue(map, Array.from(usefulStartSet), findFunc, { skipTiles: bannedSet, noLog: true });
      if (path === null || path === undefined) {
        var altBanned = bannedSet.copy();
        var mountains = [];
        map.reachable_tiles.forEach(function (t) {
          if (t.isMountain) mountains.push(t);
        });
        altBanned.update(mountains);
        path = S().breadth_first_find_queue(map, Array.from(includedSet), findFunc, {
          skipTiles: altBanned,
          bypassDefaultSkipLogic: true,
          noLog: true
        });
        if (path === null || path === undefined) break;
      }

      var lastTile = null;
      for (var p = 0; p < path.tileList.length; p++) {
        includeAllAdjRequired(path.tileList[p], includedSet, usefulStartSet, missingIncluded, costPer);
        lastTile = path.tileList[p];
      }
      if (lastTile !== null) costPer.set(lastTile, path.length);
    }

    costPer.set(root, 0);
    return [includedSet, missingIncluded];
  }

  function isEndNodeInSpanningTree(n, nodes) {
    var num = 0;
    for (var i = 0; i < n.movable.length; i++) {
      if (nodes.has(n.movable[i])) {
        num += 1;
        if (num > 1) return false;
      }
    }
    return true;
  }

  function trimSpanningTreeEndsAsNewSet(toTrim, trimDepth, minRemainingCount) {
    var remainingNodes = new Set(toTrim);
    for (var iteration = 0; iteration < trimDepth; iteration++) {
      var ends = [];
      remainingNodes.forEach(function (n) {
        if (isEndNodeInSpanningTree(n, remainingNodes)) ends.push(n);
      });
      for (var i = 0; i < ends.length; i++) {
        remainingNodes.delete(ends[i]);
        if (remainingNodes.size === minRemainingCount) return remainingNodes;
      }
    }
    return remainingNodes;
  }

  EK.Army = Army;
  EK.ArmyTracker = ArmyTracker;
  EK.FogTileRevert = FogTileRevert;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

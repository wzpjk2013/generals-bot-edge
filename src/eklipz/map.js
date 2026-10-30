/*
 * Map / MapBase —— 移植自 generals-bot/base/client/map.py（MapBase + Map）。
 *
 * 顺序不能动：apply_server_update 先 patch 数组、再写 turn/scores、然后逐格
 * update_visible_tile，最后 update() 统一推演 delta 与视野连通性。顺序一换，
 * delta.oldArmy/expectedDelta 就全错。
 *
 * 迷雾军力的推断（六个 scan）在 mapmove.js 里，本文件只负责调用。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var Tile = EK.Tile;
  var MapMatrix = EK.MapMatrix;
  var T = EK.TILE;

  var UNREACHABLE = 1000;
  // 本文件的 Map 会遮住原生 Map，凡是要 key→value 字典的地方都用这个。
  var NativeMap = root.Map;

  function Score(player, total, tiles, dead) {
    this.player = player;
    this.total = total;
    this.tiles = tiles;
    this.dead = dead;
  }

  Score.from_server_scores = function (scores) {
    var out = [];
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      out.push(new Score(s.i, s.total, s.tiles, !!s.dead));
    }
    return out;
  };

  function Player(index) {
    this.cities = [];
    this.general = null;
    this.index = index;
    this.stars = 0;
    this.score = 0;
    this.team = index;
    this.scoreDelta = 0;
    this.tileDelta = 0;
    this.unexplainedTileDelta = 0;
    this.tiles = [];
    this.deserts = [];
    this.desertCount = 0;
    this.lostSwamps = 0;
    this.swamps = [];
    this.tileCount = 0;
    this.standingArmy = 0;
    this.visibleStandingArmy = 0;
    this.cityCount = 1;
    this.lastCityCount = 1;
    this.cityLostTurn = 0;
    this.cityGainedTurn = 0;
    this.delta25tiles = 0;
    this.delta25score = 0;
    this.actualScoreDelta = 0;
    this.expectedScoreDelta = 0;
    this.knownScoreDelta = 0;
    this.fighting_with_player = -1;
    this.last_move = null;
    this.dead = false;
    this.leftGame = false;
    this.leftGameTurn = -1;
    this.capturedBy = null;
    this.knowsKingLocation = false;
    this.knowsAllyKingLocation = false;
    this.aggression_factor = 0;
    this.last_seen_move_turn = 0;
  }

  /* generals.io 增量数组编码：diff = [same0, changed0, v..., same1, ...] */
  function applyDiff(cache, diff) {
    var i = 0;
    var a = 0;
    while (i < diff.length - 1) {
      a += diff[i];
      var n = diff[i + 1];
      for (var k = 0; k < n; k++) cache[a + k] = diff[i + 2 + k];
      a += n;
      i += n + 2;
    }
    if (i === diff.length - 1) {
      cache.length = a + diff[i];
      i += 1;
    }
    if (i !== diff.length) throw new Error('diff parse failed ' + i + ' vs ' + diff.length);
  }

  function EKDistance(map) {
    this.map = map;
    this._dists = new MapMatrix(map, null);
  }

  EKDistance.prototype.get_tile_dist_matrix = function (tile) {
    var m = this._dists.raw[tile.tile_index];
    if (m === null || m === undefined) {
      m = this._build(tile);
      this._dists.raw[tile.tile_index] = m;
    }
    return m;
  };

  EKDistance.prototype.get_distance_between = function (a, b) {
    return this.get_tile_dist_matrix(a).raw[b.tile_index];
  };

  EKDistance.prototype.get_distance_between_or_none = function (a, b) {
    var d = this.get_distance_between(a, b);
    if (d > 999) {
      if (this.map.reachable_tiles.has(b) && this.map.reachable_tiles.has(a)) {
        this.recalculate();
        return this.get_distance_between(a, b);
      }
      return null;
    }
    return d;
  };

  EKDistance.prototype._build = function (startTile) {
    var dm = new MapMatrix(this.map, UNREACHABLE);
    var raw = dm.raw;
    raw[startTile.tile_index] = 0;
    var queue = [startTile];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      var newDist = raw[cur.tile_index] + 1;
      var mov = cur.movable;
      for (var i = 0; i < mov.length; i++) {
        var n = mov[i];
        if (raw[n.tile_index] !== UNREACHABLE) continue;
        raw[n.tile_index] = newDist;
        if (n.isObstacle) continue;
        queue.push(n);
      }
    }
    return dm;
  };

  EKDistance.prototype.recalculate = function () {
    this._dists = new MapMatrix(this.map, null);
  };

  function Map(startData, data, opts) {
    opts = opts || {};
    this.DO_NOT_RANDOMIZE = opts.shuffle === undefined ? false : !opts.shuffle;
    this.stars = new Array(16).fill(0);
    this.start_data = startData;
    this.replay_id = startData.replay_id || 'bridge';
    this.replay_url = 'local://' + this.replay_id;
    this.map_private = [];
    this.cities_private = [];
    this.deserts_private = [];
    this.player_index_by_color = {};
    var colors = startData.playerColors || [];
    for (var ci = 0; ci < colors.length; ci++) this.player_index_by_color[colors[ci]] = ci;

    this._apply_server_patch(data);

    var rows = this.rows;
    var cols = this.cols;
    var grid = [];
    this.tiles_by_index = new Array(rows * cols);
    for (var y = 0; y < rows; y++) {
      var row = [];
      for (var x = 0; x < cols; x++) {
        var idx = this.get_tile_index_by_x_y(x, y);
        var t = new Tile(x, y, T.EMPTY, 0, false, false, null, false, 0, idx);
        row.push(t);
        this.tiles_by_index[idx] = t;
      }
      grid.push(row);
    }

    var teams = startData.teams || null;
    var usernames = startData.usernames || ['us', 'them'];
    var turn = data.turn || 0;

    this.remainingCycleTurns = 0;
    this.cycleTurn = 0;
    this.distance_mapper = new EKDistance(this);
    this.last_player_index_submitted_move = null;
    this.player_index = startData.playerIndex | 0;
    this.is_2v2 = false;
    this.teammates = new Set();
    this.lookouts = new Set();
    this.observatories = new Set();
    this.swamps = new Set();
    this.deserts = new Set();
    this.modifiers_by_id = new Array(30).fill(false);
    var mods = (startData.options && startData.options.modifiers) || [];
    for (var mi = 0; mi < mods.length; mi++) this.modifiers_by_id[mods[mi]] = true;
    this.has_leapfrog = this.modifiers_by_id[7];
    this.has_city_state = this.modifiers_by_id[8];
    this.has_misty_veil = this.modifiers_by_id[9];
    this.has_crystal_clear = false;
    this.has_silent_war = false;
    this.has_defenseless = this.modifiers_by_id[12];
    this.has_watchtower = this.modifiers_by_id[13];
    this.has_torus = false;
    this.has_fading_smog = false;
    this.has_defection = false;
    this.has_slippery = false;
    this.is_low_cost_city_game = false;
    this.is_walled_city_game = false;
    this.walled_city_base_value = null;
    this.valid_spawns = null;
    this.usernames = usernames;
    this.players = [];
    for (var pi = 0; pi < usernames.length; pi++) this.players.push(new Player(pi));
    this.unique_teams = this.players.map(function (p) {
      return p.index;
    });
    this.teams = null;
    this.team_ids_by_player_index = [];
    this._teammates_by_player = [];
    this._teammates_by_player_no_self = [];
    this._teammates_by_team = [];
    this._team_stats = [];
    this.friendly_team = 0;
    this.set_teams(teams);

    this.pathable_tiles = new Set();
    this.reachable_tiles = new Set();
    this.visible_tiles = new Set();
    this.notify_tile_captures = [];
    this.notify_tile_deltas = [];
    this.notify_city_found = [];
    this.notify_tile_discovered = [];
    this.notify_tile_vision_changed = [];
    this.notify_general_revealed = [];
    this.notify_player_captures = [];

    this.rows = rows;
    this.cols = cols;
    this.grid = grid;
    this.army_moved_grid = [];
    this.army_emergences = {};
    this.is_city_bonus_turn = (turn & 1) === 0;
    this.is_army_bonus_turn = turn % 50 === 0;
    this._turn = turn;
    this.generals = new Array(16).fill(null);
    this.init_grid_movable();
    this.scores = [];
    for (var si = 0; si < 16; si++) this.scores.push(new Score(si, 0, 0, false));
    this.complete = false;
    this.result = false;
    this.scoreHistory = new Array(50).fill(null);
    this.remainingPlayers = 0;
    this.resume_data = {};
    this.unexplained_deltas = new NativeMap();
    this.moved_here_set = new Set();
    this.is_custom_map = !!(startData.options && startData.options.map);

    if (startData.swamps) {
      var self0 = this;
      this.swamps = new Set(
        startData.swamps.map(function (i) {
          return self0.tiles_by_index[i];
        })
      );
      this.swamps.forEach(function (s) {
        s.isSwamp = true;
      });
    }

    this.apply_server_update(data);
  }

  var P = Map.prototype;

  P.set_teams = function (teams) {
    var finalTeamIndexes = new NativeMap();
    var finalTeams = null;
    if (teams) {
      this.unique_teams = [];
      finalTeams = [];
      var curTeam = 0;
      for (var player = 0; player < teams.length; player++) {
        var remapped = finalTeamIndexes.get(teams[player]);
        if (remapped === undefined) {
          this.unique_teams.push(curTeam);
          finalTeamIndexes.set(teams[player], curTeam);
          finalTeams.push(curTeam);
          curTeam += 1;
        } else {
          finalTeams.push(remapped);
        }
        if (teams[player] === teams[this.player_index] && player !== this.player_index) this.teammates.add(player);
      }
      if (this.unique_teams.length === 2 && teams.length === 4) this.is_2v2 = true;
    }
    this.teams = finalTeams;
    this.team_ids_by_player_index = this._build_teams_array();
    for (var p = 0; p < this.team_ids_by_player_index.length; p++) {
      var t = this.team_ids_by_player_index[p];
      if (t !== -1) this.players[p].team = t;
    }
    var self = this;
    this._teammates_by_player = this.team_ids_by_player_index.map(function (t) {
      return self.players
        .filter(function (pl) {
          return pl.team === t;
        })
        .map(function (pl) {
          return pl.index;
        });
    });
    var tail = this._teammates_by_player[this._teammates_by_player.length - 1];
    if (tail) tail.push(-1);
    this._teammates_by_player_no_self = this.team_ids_by_player_index.map(function (t, pIdx) {
      return self.players
        .filter(function (pl) {
          return pl.team === t && pl.index !== pIdx;
        })
        .map(function (pl) {
          return pl.index;
        });
    });
    var maxTeam = Math.max.apply(null, this.team_ids_by_player_index);
    this._teammates_by_team = [];
    for (var i = 0; i < maxTeam + 2; i++) {
      this._teammates_by_team.push(
        this.players
          .filter(function (pl) {
            return pl.team === i;
          })
          .map(function (pl) {
            return pl.index;
          })
      );
    }
    this._teammates_by_team[this._teammates_by_team.length - 1].push(-1);
    // 原版 map.py:3136 在这里预分配 max(team_ids)+2 个 turn=0 的空 TeamStats，
    // 这样 get_team_stats_lookup_by_team_id 读 _team_stats[0] 永远不是 null，
    // 且 _team_stats[-1]（中立伪团队）落在最后一个槽位，和 Python 负索引一致。
    this._team_stats = [];
    for (var si = 0; si < maxTeam + 2; si++) {
      this._team_stats.push(new TeamStats(0, 0, 0, 0, 0, 0, 0, [], [], 0, 0));
    }
    this.friendly_team = this.team_ids_by_player_index[this.player_index];
  };

  P._build_teams_array = function () {
    var teams;
    if (this.teams !== null) teams = this.teams.slice();
    else
      teams = this.players.map(function (_, i) {
        return i;
      });
    teams.push(-1);
    return teams;
  };

  P.get_tile_index_by_x_y = function (x, y) {
    return y * this.cols + x;
  };
  P.get_tile_by_tile_index = function (i) {
    return this.tiles_by_index[i];
  };
  P.GetTile = function (x, y) {
    if (0 <= x && x < this.cols && 0 <= y && y < this.rows) return this.grid[y][x];
    return null;
  };
  P.GetTileModifierSafe = P.GetTile;
  P.get_all_tiles = function () {
    return this.tiles_by_index;
  };
  P.get_teammates = function (p) {
    return this._teammates_by_player[p];
  };
  P.is_player_friendly = function (player) {
    return this.team_ids_by_player_index[player] === this.friendly_team;
  };
  P.is_tile_friendly = function (tile) {
    return this.is_player_friendly(tile.player());
  };
  P.is_tile_enemy = function (tile) {
    var tp = tile.player();
    if (tp < 0) return false;
    return this.team_ids_by_player_index[tp] !== this.friendly_team;
  };
  P.is_tile_on_team_with = function (tile, player) {
    if (player < 0) return false;
    return this.team_ids_by_player_index[tile.player()] === this.team_ids_by_player_index[player];
  };
  P.manhattan_dist = function (a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };

  Object.defineProperty(P, 'turn', {
    get: function () {
      return this._turn;
    },
    set: function (val) {
      this.cycleTurn = val % 50;
      this.remainingCycleTurns = 50 - this.cycleTurn;
      if ((val & 1) === 0) {
        this.is_city_bonus_turn = true;
        this.is_army_bonus_turn = this.cycleTurn === 0;
      } else {
        this.is_army_bonus_turn = false;
        this.is_city_bonus_turn = false;
      }
      this._turn = val;
    }
  });

  // 原版 map.py:797-799 是 `self.turn = turn; self.clear_deltas()`；clear_deltas 里会清
  // army_emergences。少这一句的话，上一回合的 emergence 会压住本回合新值（mapmove.js
  // 见到 old===undefined 才落新值），迷雾推断整条链会差一格。
  P.update_turn = function (turn) {
    this.turn = turn;
    this.clear_deltas();
  };

  P.update_scores = function (scores) {
    this.scores = scores;
  };

  P.init_grid_movable = function () {
    for (var x = 0; x < this.cols; x++) {
      for (var y = 0; y < this.rows; y++) {
        var tile = this.grid[y][x];
        if (tile.adjacents.length !== 0) continue;
        if (this.has_misty_veil) tile.adjacents.push(tile);
        var mvs = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1]
        ];
        for (var k = 0; k < mvs.length; k++) {
          var mt = this.GetTile(mvs[k][0], mvs[k][1]);
          if (mt === null) continue;
          if (tile.movable.indexOf(mt) >= 0) continue;
          if (!this.has_misty_veil) {
            tile.adjacents.push(mt);
            mt.visibleTo.push(tile);
          }
          tile.movable.push(mt);
        }
        if (!this.has_misty_veil) {
          var diags = [
            [x - 1, y - 1],
            [x + 1, y - 1],
            [x - 1, y + 1],
            [x + 1, y + 1]
          ];
          for (var d2 = 0; d2 < diags.length; d2++) {
            var at = this.GetTile(diags[d2][0], diags[d2][1]);
            if (at === null) continue;
            if (tile.adjacents.indexOf(at) >= 0) continue;
            tile.adjacents.push(at);
            at.visibleTo.push(tile);
          }
        }
        if (tile.isGeneral) {
          if (tile.player() === -1) throw new Error('cant have neutral generals');
          this.generals[tile.player()] = tile;
        }
        // 原版这里 random.shuffle(adjacents/visibleTo/movable)。确定性 oracle
        // 模式下必须不抖，否则同一局面两次的 tie-break 都不同，没法逐格比对。
        if (!this.DO_NOT_RANDOMIZE) this._shuffle_in_place(tile);
      }
    }
    this.update_reachable();
  };

  P._shuffle_in_place = function (tile) {
    var list = [tile.movable, tile.adjacents, tile.visibleTo];
    for (var l = 0; l < list.length; l++) {
      var arr = list[l];
      for (var i = arr.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    }
  };

  P.update_visible_tile = function (x, y, tile_type, tile_army, is_city, is_general, is_desert) {
    var curTile = this.grid[y][x];
    var wasCity = curTile.isCity;
    var wasVisible = curTile.visible;
    var wasDiscovered = curTile.discovered;
    var wasGeneral = curTile.isGeneral;
    var wasLookout = curTile.isLookout;
    var wasObservatory = curTile.isObservatory;
    var wasDesert = curTile.isDesert;

    if (curTile.isCity && tile_type >= T.EMPTY && !is_city) curTile.isCity = false;
    if (is_desert) curTile.isDesert = true;

    var maybeMoved = curTile.update(this, tile_type, tile_army, !!is_city, !!is_general);

    if (tile_type === T.OBSERVATORY) this.observatories.add(curTile);
    if (tile_type === T.LOOKOUT) this.lookouts.add(curTile);

    if (!is_general && tile_type >= T.EMPTY && curTile.isGeneral) curTile.isGeneral = false;

    if (!this.army_moved_grid[y]) this.army_moved_grid[y] = [];
    this.army_moved_grid[y][x] = maybeMoved;
    if (curTile.delta.oldOwner !== curTile.delta.newOwner) {
      curTile.turn_captured = this.turn;
      this._fire(this.notify_tile_captures, curTile);
      this._fire(this.notify_tile_deltas, curTile);
    }
    if (curTile.delta.armyDelta !== 0) this._fire(this.notify_tile_deltas, curTile);
    if (wasCity !== curTile.isCity) this._fire(this.notify_city_found, curTile);

    if (wasDiscovered !== curTile.discovered) {
      this._fire(this.notify_tile_discovered, curTile);
      if (curTile.isMountain) curTile.overridePathable = null;
    }

    if (!wasDesert && curTile.isDesert) this.deserts.add(curTile);
    if (wasVisible !== curTile.visible) this._fire(this.notify_tile_vision_changed, curTile);
    if (curTile.isLookout && !wasLookout) this.lookouts.add(curTile);
    if (curTile.isObservatory && !wasObservatory) this.observatories.add(curTile);

    if (wasGeneral !== curTile.isGeneral) {
      this._fire(this.notify_general_revealed, curTile);
      if (curTile.isGeneral && curTile.visible) {
        this.generals[curTile.player()] = curTile;
        this.players[curTile.player()].general = curTile;
      } else if (curTile.visible) {
        for (var i = 0; i < this.generals.length; i++) {
          if (i >= this.players.length) break;
          if (this.generals[i] === curTile) this.generals[i] = null;
          if (this.players[i].general === curTile) this.players[i].general = null;
        }
      }
    }
  };

  P._fire = function (handlers, a, b) {
    for (var i = 0; i < handlers.length; i++) handlers[i](a, b);
  };

  P.update = function (bypassDeltas) {
    var i, player;
    for (i = 0; i < this.players.length; i++) {
      player = this.players[i];
      player.lastCityCount = player.cityCount;
      player.knownScoreDelta = 0;
    }
    if (this.complete && !this.result && this.remainingPlayers > 2) return this;

    for (i = 0; i < this.tiles_by_index.length; i++) {
      var curTile = this.tiles_by_index[i];
      if (
        curTile.isCity &&
        curTile.delta.oldOwner !== curTile.delta.newOwner &&
        !curTile.delta.gainedSight &&
        curTile.delta.newOwner !== -1
      ) {
        var oldOwner = curTile.delta.oldOwner;
        var newOwner = curTile.player();
        if (oldOwner !== -1) this.players[oldOwner].cityCount -= 1;
        this.players[newOwner].cityCount += 1;
      }
      if (curTile.delta.gainedSight) this.visible_tiles.add(curTile);
      else if (curTile.delta.lostSight) this.visible_tiles.delete(curTile);
    }

    for (i = this.scoreHistory.length - 1; i > 0; i--) this.scoreHistory[i] = this.scoreHistory[i - 1];
    this.scoreHistory[0] = this.scores;

    this._update_player_information(bypassDeltas);

    for (i = 0; i < this.players.length; i++) {
      player = this.players[i];
      player.cities = [];
      player.tiles = [];
      player.deserts = [];
      player.swamps = [];
      player.visibleStandingArmy = 0;
      player.lostSwamps = 0;
    }

    if (!bypassDeltas) {
      if (this.is_city_bonus_turn) {
        for (i = 0; i < this.tiles_by_index.length; i++) {
          var ct = this.tiles_by_index[i];
          if (ct.isCity || ct.isGeneral) {
            if (!ct.visible && ct.player() >= 0) ct.army += 1;
          }
          if (ct.isSwamp) {
            if (!ct.visible && ct.player() >= 0) {
              ct.army -= 1;
              if (ct.army <= 0) ct.setPlayer(-1);
            }
          }
        }
      }
      if (this.is_army_bonus_turn) {
        for (i = 0; i < this.tiles_by_index.length; i++) {
          var at = this.tiles_by_index[i];
          if (!at.visible && at.player() >= 0 && !at.isDesert) at.army += 1;
        }
      }
    }

    for (i = 0; i < this.tiles_by_index.length; i++) {
      var t = this.tiles_by_index[i];
      if (t.player() === -1) {
        if (t.isSwamp && t.delta.oldOwner >= 0) this.players[t.delta.oldOwner].lostSwamps += 1;
        continue;
      }
      var pl = this.players[t.player()];
      pl.tiles.push(t);
      if (t.visible) pl.visibleStandingArmy += t.army - 1;
      if (t.isCity) pl.cities.push(t);
      if (t.isDesert) pl.deserts.push(t);
      if (t.isSwamp && t.visible) pl.swamps.push(t);
    }

    if (!bypassDeltas) EK.mapmove.detect_movement_and_populate_unexplained_diffs(this);

    this.update_reachable();

    this.players[this.player_index].cityCount = this.players[this.player_index].cities.length + 1;
    var self = this;
    this.teammates.forEach(function (tm) {
      self.players[tm].cityCount = self.players[tm].cities.length + 1;
    });

    return this;
  };

  P._update_player_information = function (bypassDeltas) {
    var cityCounts = this.players.map(function () {
      return 0;
    });
    var i, player;
    for (i = 0; i < this.players.length; i++) {
      player = this.players[i];
      if (this.scores[player.index] == null) continue;
      player.scoreDelta = this.scores[player.index].total - player.score;
      player.score = this.scores[player.index].total;
      player.tileDelta = this.scores[player.index].tiles - player.tileCount;
      player.unexplainedTileDelta = player.tileDelta;
      player.tileCount = this.scores[player.index].tiles;
      player.standingArmy = this.scores[player.index].total - this.scores[player.index].tiles;
    }

    var last = this.scoreHistory[this.scoreHistory.length - 1];
    var earliest = last;
    for (i = this.scoreHistory.length - 2; i > 0; i--) {
      var priorTurn = this.turn - i;
      var scores = this.scoreHistory[i];
      if (earliest === null || earliest === undefined) earliest = scores;
      if (last !== null && last !== undefined && scores) {
        for (var p = 0; p < this.players.length; p++) {
          var sc = scores[p];
          var lastScore = last[p];
          if (!sc || !lastScore) continue;
          var tileDelta = sc.tiles - lastScore.tiles;
          if (Math.abs(tileDelta) <= 1 && priorTurn % 50 !== 0) {
            var delta = sc.total - lastScore.total;
            if (delta > 0 && delta > cityCounts[p]) cityCounts[p] = delta;
          }
        }
      }
      last = scores;
    }

    this.remainingPlayers = 0;
    for (i = 0; i < this.players.length; i++) {
      player = this.players[i];
      if (player.dead) continue;
      if (earliest) {
        player.delta25score = this.players[i].score - earliest[i].total;
        player.delta25tiles = this.players[i].tileCount - earliest[i].tiles;
      }
      if (this.scores[i].dead) {
        if (!player.leftGame) {
          player.leftGame = true;
          player.leftGameTurn = this.turn;
        } else {
          if (this.scores[i].tiles === 0) {
            player.dead = true;
            for (var ti = 0; ti < player.tiles.length; ti++) {
              if (!player.tiles[ti].visible) player.tiles[ti].set_disconnected_neutral();
            }
            if (player.general !== null && player.general.isGeneral) {
              player.general.isGeneral = false;
              player.general.isCity = true;
            }
            if (this.generals[player.index] !== null) this.generals[player.index] = null;
          }
        }
      } else {
        this.remainingPlayers += 1;
      }
    }

    this.use_basic_city_counter = true;
    if ((this.remainingPlayers === 2 || this.is_2v2) && (this.deserts.size === 0 || !this.is_army_bonus_turn))
      this.use_basic_city_counter = false;

    if (!bypassDeltas) EK.mapmove.calculate_player_deltas(this);

    if (this.use_basic_city_counter) {
      for (i = 0; i < this.players.length; i++) {
        player = this.players[i];
        if (!player.dead && player.index !== this.player_index && !this.teammates.has(player.index)) {
          if (player.cityCount < cityCounts[i]) player.cityGainedTurn = this.turn;
          else if (player.cityCount > cityCounts[i]) player.cityLostTurn = this.turn;
          if (cityCounts[i] > 0) player.cityCount = cityCounts[i];
        }
      }
    }
  };

  P.update_reachable = function () {
    var pathableTiles = new Set();
    var reachableTiles = new Set();
    var visibleTiles = new Set();
    var queue = [];
    for (var g = 0; g < this.generals.length; g++) {
      var gen = this.generals[g];
      if (gen !== null) {
        queue.push(gen);
        this.players[gen.player()].general = gen;
      }
    }
    var minCityArmy = 10000;
    var maxMinCityArmy = this.walled_city_base_value;
    var trueMinCityArmy = 10000;
    var head = 0;
    while (head < queue.length) {
      var tile = queue[head++];
      tile.overridePathable = null;
      if (tile.visible) visibleTiles.add(tile);
      if (tile.isNeutral && tile.isCity) {
        if ((!tile.delta.gainedSight && tile.delta.armyDelta === 0) || (this.turn < 2 && !this.has_city_state)) {
          trueMinCityArmy = Math.min(tile.army, trueMinCityArmy);
          if (maxMinCityArmy === null || tile.army > maxMinCityArmy)
            minCityArmy = Math.min(tile.army, minCityArmy);
        }
      }
      var tileIsPathable = tile.isPathable;
      if (this.is_walled_city_game && !tileIsPathable && !tile.discovered && !tile.isMountain) {
        tile.isCity = true;
        tile.army = this.walled_city_base_value;
        tileIsPathable = true;
      }
      if (!pathableTiles.has(tile) && tileIsPathable && !tile.isCostlyNeutralCity) {
        pathableTiles.add(tile);
        for (var m = 0; m < tile.movable.length; m++) {
          queue.push(tile.movable[m]);
          reachableTiles.add(tile.movable[m]);
        }
      }
    }

    if (this.is_custom_map && trueMinCityArmy < 20 && this.turn < 20 && !this.has_city_state)
      this.is_low_cost_city_game = true;

    if (pathableTiles.size !== this.pathable_tiles.size) {
      try {
        this.distance_mapper.recalculate();
      } catch (e) {
        /* 原版这里也是 try/except */
      }
    }

    this.pathable_tiles = pathableTiles;
    this.reachable_tiles = reachableTiles;
    this.visible_tiles = visibleTiles;

    if (this.is_custom_map) {
      var changeWall = false;
      if (this.reachable_tiles.size > 2 && this.reachable_tiles.size < (3 * this.tiles_by_index.length) / 4)
        changeWall = true;
      else if (this.valid_spawns) {
        var self = this;
        this.valid_spawns.forEach(function (s) {
          if (!self.reachable_tiles.has(s)) changeWall = true;
        });
      }
      if (changeWall) this.set_walled_cities(minCityArmy);
    }
  };

  P.set_walled_cities = function (wallCityArmy) {
    this.is_walled_city_game = true;
    this.walled_city_base_value = wallCityArmy;
  };

  P.clear_deltas = function () {
    for (var i = 0; i < this.tiles_by_index.length; i++) this.tiles_by_index[i].delta = new EK.TileDelta();
    this.army_moved_grid = [];
    this.army_emergences = {};
  };

  /* ---- Map：服务器增量包 ---- */
  P._apply_server_patch = function (data) {
    applyDiff(this.map_private, data.map_diff);
    applyDiff(this.cities_private, data.cities_diff);
    applyDiff(this.deserts_private, data.deserts_diff || [0, 0, 0]);
    this.rows = this.map_private[1];
    this.cols = this.map_private[0];
    var n = this.cols * this.rows;
    this.tile_grid = [];
    this.army_grid = [];
    for (var y = 0; y < this.rows; y++) {
      var trow = [];
      var arow = [];
      for (var x = 0; x < this.cols; x++) {
        trow.push(this.map_private[2 + n + y * this.cols + x]);
        arow.push(this.map_private[2 + y * this.cols + x]);
      }
      this.tile_grid.push(trow);
      this.army_grid.push(arow);
    }
    this.visible_cities = new Set(this.cities_private);
    this.visible_generals = new Set(data.generals || []);
    this.visible_deserts = new Set(this.deserts_private);
  };

  P.apply_server_update = function (data) {
    this._apply_server_patch(data);
    this.update_turn(data.turn);
    this.update_scores(Score.from_server_scores(this._raw_scores_from_data(data)));
    this.lookouts = new Set();
    this.observatories = new Set();
    this.swamps = new Set();
    this.deserts = new Set();

    for (var i = 0; i < this.tiles_by_index.length; i++) {
      var tile = this.tiles_by_index[i];
      var tile_type = this.tile_grid[tile.y][tile.x];
      var army_count = this.army_grid[tile.y][tile.x];
      this.update_visible_tile(
        tile.x,
        tile.y,
        tile_type,
        army_count,
        this.visible_cities.has(i),
        this.visible_generals.has(i),
        this.visible_deserts.has(i)
      );
    }

    var mapResult = this.update();
    if (data.stars) this.stars = data.stars.slice();
    for (var p = 0; p < this.players.length; p++) this.players[p].stars = this.stars[p] || 0;
    return mapResult;
  };

  // ---- 团队统计（对应 base/client/map.py:805 get_team_stats_by_team_id 一族）----
  // OpponentTracker 的每个循环判断都建立在它上面，所以口径必须和原版一字不差：
  // 缓存键是「这一份统计是哪个 turn 算的」，回合一变就整批重算（原版只比较
  // _team_stats[0].turn）。teamId == -1 原版走特例：直接返回缓存并刷新 turn。
  function TeamStats(tileCount, score, standingArmy, cityCount, fightingDiff, unexplainedTileDelta, teamId, teamPlayers, livingPlayers, turn, deserts) {
    this.tileCount = tileCount;
    this.score = score;
    this.standingArmy = standingArmy;
    this.cityCount = cityCount;
    this.fightingDiff = fightingDiff;
    this.unexplainedTileDelta = unexplainedTileDelta;
    this.teamId = teamId;
    this.teamPlayers = teamPlayers;
    this.livingPlayers = livingPlayers;
    this.turn = turn === undefined ? 0 : turn;
    this.deserts = deserts === undefined ? 0 : deserts;
  }
  EK.TeamStats = TeamStats;

  // Python 里 teamId == -1 的数组下标等于「取最后一个元素」，JS 不这么干，必须显式折。
  // 原版 team_ids_by_player_index 尾部就挂着这个 -1 伪团队（_build_teams_array 里 push）。
  function byTeamIndex(arr, teamId) {
    if (teamId < 0) return arr[arr.length - 1];
    return arr[teamId];
  }

  P.get_team_stats_by_team_id = function (teamId) {
    var curStats = byTeamIndex(this._team_stats, teamId);

    if (teamId === -1 && curStats !== null && curStats !== undefined) {
      curStats.turn = this.turn;
      return curStats;
    }

    if (curStats === null || curStats === undefined || curStats.turn !== this.turn) {
      for (var ti = 0; ti < this.team_ids_by_player_index.length; ti++) {
        var curTeamId = this.team_ids_by_player_index[ti];
        var tileCount = 0;
        var score = 0;
        var standingArmy = 0;
        var cities = 0;
        var deserts = 0;
        var fightingDiff = 0;
        var unexplainedTileDelta = 0;
        var teamPlayers = byTeamIndex(this._teammates_by_team, curTeamId);
        var livingPlayers = [];
        for (var pi = 0; pi < teamPlayers.length; pi++) {
          // 中立伪团队的成员表是 [-1]，而 Python 的 players[-1] 取的是最后一个玩家，
          // 所以这个伪团队的统计里混着最后一名玩家的数据 —— 原版行为，照抄。
          var pIdx = teamPlayers[pi] < 0 ? this.players.length - 1 : teamPlayers[pi];
          var player = this.players[pIdx];
          tileCount += player.tileCount;
          score += player.score;
          standingArmy += player.standingArmy;
          cities += player.cityCount;
          deserts += player.deserts.length;
          fightingDiff += player.actualScoreDelta - player.expectedScoreDelta;
          unexplainedTileDelta += player.unexplainedTileDelta;
          if (!player.dead) livingPlayers.push(teamPlayers[pi]);
        }
        var teamStats = new TeamStats(tileCount, score, standingArmy, cities, fightingDiff, unexplainedTileDelta, curTeamId, teamPlayers, livingPlayers, this.turn, deserts);
        if (curTeamId < 0) this._team_stats[this._team_stats.length - 1] = teamStats;
        else this._team_stats[curTeamId] = teamStats;
        if (curTeamId === teamId) curStats = teamStats;
      }
    }

    return curStats;
  };

  P.get_team_stats_lookup_by_team_id = function () {
    if (this._team_stats[0] === null || this._team_stats[0] === undefined || this._team_stats[0].turn !== this.turn) {
      this.get_team_stats_by_team_id(-1);
    }
    return this._team_stats;
  };

  P.get_team_stats = function (teamPlayer) {
    var targetTeam = teamPlayer === -1 ? -1 : this.players[teamPlayer].team;
    return this.get_team_stats_by_team_id(targetTeam);
  };

  P.is_player_on_team_with = function (player1, player2) {
    return this.team_ids_by_player_index[player1] === this.team_ids_by_player_index[player2];
  };

  P.is_tile_on_team = function (tile, team) {
    return team === this.team_ids_by_player_index[tile.player()];
  };

  P._raw_scores_from_data = function (data) {
    var byI = {};
    var raw = data.scores || [];
    for (var i = 0; i < raw.length; i++) byI[raw[i].i] = raw[i];
    var out = [];
    for (var k = 0; k < raw.length; k++) out.push(byI[k]);
    return out;
  };

  // 原版 MapBase.get_teams_array 就是直接返回这个数组（map.py:2955）
  Map.get_teams_array = function (map) {
    return map.team_ids_by_player_index;
  };

  EK.Map = Map;
  EK.Player = Player;
  EK.Score = Score;
  EK.applyDiff = applyDiff;
  EK.UNREACHABLE = UNREACHABLE;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

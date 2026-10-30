/* Human.exe 的 BotModules/BotStateQueries.py 逐函数移植（137 行原版）。
 *
 * 为什么单独一个文件：这些查询被 pathing/defense/expansion 三处都要用，放进任何一处都会
 * 变成循环依赖。所有函数第一个参数都是 bot，保持原版签名，方便和 Python 侧逐行对照。
 */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function bm(bot) {
    return bot.map || bot._map;
  }

  function BotStateQueries() {}

  BotStateQueries.is_all_in = function (bot) {
    return !!(bot.is_all_in_losing || bot.is_all_in_army_advantage || bot.all_in_city_behind);
  };

  BotStateQueries.is_tile_enemy = function (bot, tile) {
    if (tile == null) return false;
    var map = bm(bot);
    return tile.player() !== -1 && tile.player() !== bot.general.player() && map.is_tile_enemy(tile);
  };

  BotStateQueries.is_still_ffa_and_non_dominant = function (bot) {
    var map = bm(bot);
    var isFfa = false;
    if (map.remainingPlayers > 2 && !map.is_2v2) isFfa = true;
    if (!isFfa) return false;

    var dominating = 0;
    var dominatedBy = 0;
    for (var i = 0; i < map.players.length; i++) {
      var player = map.players[i];
      if (player === bot.general.player()) continue;
      if (bot.opponent_tracker.winning_on_army(1.2, player.index, -10, true)) {
        dominating += 1;
      } else if (!bot.opponent_tracker.winning_on_army(0.9, player.index, 0, true)) {
        dominatedBy += 1;
      }
    }

    if (dominating > dominatedBy) return false;
    return true;
  };

  BotStateQueries.get_intergeneral_analysis = function (bot) {
    return bot.board_analysis.intergeneral_analysis;
  };

  BotStateQueries.get_player_army_amount_on_path = function (bot, path, player, startIdx, endIdx) {
    if (startIdx === undefined) startIdx = 0;
    if (endIdx === undefined) endIdx = 1000;
    var map = bm(bot);
    var value = 0;
    var idx = 0;
    var pathNode = path.start;
    while (pathNode !== null && pathNode !== undefined) {
      if (map.is_player_on_team_with(pathNode.tile.player(), player) && startIdx <= idx && idx <= endIdx) {
        value += pathNode.tile.army - 1;
      }
      pathNode = pathNode.next;
      idx += 1;
    }
    return value;
  };

  BotStateQueries.get_player_army_amount_on_tiles = function (bot, tiles, player) {
    var map = bm(bot);
    var value = 0;
    var arr = Array.isArray(tiles) ? tiles : Array.from(tiles);
    for (var i = 0; i < arr.length; i++) {
      var tile = arr[i];
      if (map.is_player_on_team_with(tile.player(), player)) value += tile.army - 1;
    }
    return value;
  };

  BotStateQueries.get_target_army_inc_adjacent_enemy = function (bot, tile) {
    var sumAdj = 0;
    for (var i = 0; i < tile.adjacents.length; i++) {
      var adj = tile.adjacents[i];
      if (BotStateQueries.is_tile_enemy(bot, adj)) sumAdj += adj.army - 1;
    }
    return sumAdj;
  };

  BotStateQueries.get_target_army_inc_adjacent_enemy_and_tiles = function (bot, tile) {
    var sumAdj = 0;
    var adjTiles = new Set();
    for (var i = 0; i < tile.adjacents.length; i++) {
      var adj = tile.adjacents[i];
      if (BotStateQueries.is_tile_enemy(bot, adj)) {
        if (adj.army > 1) {
          sumAdj += adj.army - 1;
          adjTiles.add(adj);
        }
      }
    }
    return [sumAdj, adjTiles];
  };

  BotStateQueries.parse_tile_str = function (bot, tileStr) {
    var parts = String(tileStr).split(',');
    return bm(bot).GetTile(parseInt(parts[0], 10), parseInt(parts[1], 10));
  };

  BotStateQueries.parse_bool = function (bot, boolStr) {
    return String(boolStr).toLowerCase().trim() === 'true';
  };

  BotStateQueries.str_tiles = function (bot, tiles) {
    var arr = Array.isArray(tiles) ? tiles : Array.from(tiles);
    return arr.join('|');
  };

  BotStateQueries.get_army_at = function (bot, tile, no_expected_path) {
    return bot.armyTracker.get_or_create_army_at(tile, !!no_expected_path);
  };

  BotStateQueries.get_army_at_x_y = function (bot, x, y) {
    return BotStateQueries.get_army_at(bot, bm(bot).GetTile(x, y));
  };

  BotStateQueries.get_n_closest_team_tiles_near = function (bot, nearTiles, player, distance, limit, includeNeutral) {
    var map = bm(bot);
    var tiles = new Set(nearTiles);

    function nearbyTileAdder(tile) {
      if (tiles.size > limit) return true;
      if (
        map.is_tile_on_team_with(tile, player) ||
        (includeNeutral && tile.isNeutral() && tile.army === 0 && !tile.isObstacle)
      ) {
        tiles.add(tile);
      }
      return false;
    }

    EK.search.breadth_first_foreach(map, nearTiles, distance, nearbyTileAdder);
    return Array.from(tiles);
  };

  EK.BotStateQueries = BotStateQueries;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

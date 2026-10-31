/*
 * BotEventHandlers：BotModules/BotEventHandlers.py（157 行）的逐函数移植。
 *
 * 为什么必须有这一层：原版把「地图上发生了什么」翻译成各分析器的增量维护动作
 * （领地脏区、城市追踪、迷雾歼灭清扫、经济比值重算）。JS 之前只留了
 * noteMissing('BotEventHandlers.initialize_callbacks')，于是地图回调一个都没注册，
 * 分析器只能靠每回合全量重算兜底，缺席的那部分判断直接失效
 * （实测每局 missing 里 clear_fog_armies_around 7~354 次）。
 *
 * 移植约定（与其它 eklipz 模块一致）：
 *  - 全部是静态函数，第一参数是 bot；
 *  - tile.player 在 JS 是方法（tile.player()），赋值走 tile.setPlayer；
 *  - map.teammates 是 Set（原版是 list），判断用 .has；
 *  - player.tiles 在 JS 是数组（原版是 list），长度用 .length；
 *  - armyTracker.armies 是原生 Map（Tile -> Army），存在性用 .has/.get；
 *  - history.captured_player 由本文件补在 History 上（原版 History.py:35）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var H = (EK.BotEventHandlers = EK.BotEventHandlers || {});

  function info(bot, text) {
    if (bot && bot.viewInfo && typeof bot.viewInfo.add_info_line === 'function') {
      bot.viewInfo.add_info_line(text);
    }
  }

  function onTeam(map, player, teamPlayer) {
    if (player === teamPlayer) return true;
    if (typeof map.is_player_on_team_with === 'function') {
      return !!map.is_player_on_team_with(player, teamPlayer);
    }
    return map.teammates && map.teammates.has ? map.teammates.has(player) : false;
  }

  // BotEventHandlers.py:16
  H.handle_city_found = function (bot, tile) {
    bot.armyTracker.add_need_to_track_city(tile);
    bot.territories.needToUpdateAroundTiles.add(tile);
    if (tile.player() !== -1) bot.board_analysis.should_rescan = true;
    return null;
  };

  // BotEventHandlers.py:25
  H.handle_tile_captures = function (bot, tile) {
    var d = tile.delta;
    bot.territories.needToUpdateAroundTiles.add(tile);

    if (tile.isCity) {
      // 原版 record_city_capture(city, player, turn=None, army=None) —— turn 省略由分析器自己取
      bot.win_condition_analyzer.record_city_capture(tile, tile.player(), undefined, tile.army);
      bot.armyTracker.add_need_to_track_city(tile);

      if (d.oldOwner === -1 || d.newOwner === -1) {
        bot.board_analysis.should_rescan = true;
        bot._map.distance_mapper.recalculate();
        bot.cityAnalyzer.reset_reachability();
        // 变回中立城：到此为止（原版这里直接 return）
        if (d.newOwner === -1) return null;
      }
    }

    if (!d.gainedSight) bot.armyTracker.notify_seen_player_tile(tile);

    // 自家/队友的格子被抢：给凶手记侵略性
    var myPlayer = bot.general.player();
    if (d.oldOwner === myPlayer || onTeam(bot._map, d.oldOwner, myPlayer)) {
      if (!bot._map.is_tile_friendly(tile)) {
        var murderer = bot._map.players[tile.player()];
        var tileScore = 10;
        var territoryOwner = bot.territories.territoryMap.raw[tile.tile_index];
        if (territoryOwner === d.newOwner) {
          tileScore = 5;
        } else if (onTeam(bot._map, territoryOwner, myPlayer)) {
          tileScore = 30;
        }
        if (tile.isCity) {
          tileScore += 5;
          tileScore = tileScore * 10;
        }
        if (murderer) murderer.aggression_factor += tileScore;
      }
    }
    return null;
  };

  // BotEventHandlers.py:62
  H.handle_player_captures = function (bot, capturee, capturer) {
    var armies = bot.armyTracker.armies;
    // 原版 list(...values()) 之后再逐个 scrap —— 迭代中修改 Map 前先快照
    var snapshot = [];
    armies.forEach(function (a) { snapshot.push(a); });
    for (var i = 0; i < snapshot.length; i++) {
      if (snapshot[i].player === capturee) bot.armyTracker.scrap_army(snapshot[i], true);
    }

    if (bot.history && typeof bot.history.captured_player === 'function') {
      bot.history.captured_player(bot._map.turn, capturee, capturer);
    }

    if (capturer === bot.general.player()) {
      bot.lastPlayerKilled = capturee;
      var deadGen = bot._map.players[capturee] && bot._map.players[capturee].general;
      if (deadGen) bot.launchPoints.push(deadGen);
    }

    bot.trigger_player_capture_re_eval = true;
    return null;
  };

  // BotEventHandlers.py:83
  H.reevaluate_after_player_capture = function (bot) {
    if (bot._map.remainingPlayers <= 3) {
      // 原版 winning_on_economy(byRatio=0.8)，其余参数保持默认
      if (!bot.opponent_tracker.winning_on_economy(0.8)) {
        bot.viewInfo.add_info_line('not even on economy, going all in effective immediately');
        bot.is_all_in_losing = true;
        bot.all_in_losing_counter = 300;
      }
    }
    return null;
  };

  // BotEventHandlers.py:91（原版只有日志，保留空实现让调用点不必判空）
  H.handle_tile_deltas = function (bot, tile) {
    return null;
  };

  // BotEventHandlers.py:96
  H.handle_tile_discovered = function (bot, tile) {
    var d = tile.delta;
    bot.territories.needToUpdateAroundTiles.add(tile);

    if (tile.isCity && tile.player() !== -1) {
      bot.board_analysis.should_rescan = true;
      bot._map.distance_mapper.recalculate();
    }
    if (tile.isCity && tile.player() === -1 && d.oldOwner !== -1) {
      // 迷雾里臆测的「敌城」其实是中立城 —— 距离图整张作废
      bot._map.distance_mapper.recalculate();
    }

    if (tile.player() >= 0) {
      var player = bot._map.players[tile.player()];
      if (player.tiles.length < 4 && tile.player() === bot.targetPlayer && bot.curPath) {
        bot.viewInfo.add_info_line('killing current path because JUST discovered player...');
        bot.curPath = null;
      }
    }
    return null;
  };

  // BotEventHandlers.py:114
  H.handle_tile_vision_change = function (bot, tile) {
    var d = tile.delta;
    bot.territories.needToUpdateAroundTiles.add(tile);
    if (tile.visible) bot.territories.revealed_tile(tile);

    if (d.gainedSight) bot.armyTracker.notify_seen_player_tile(tile);

    if (tile.isCity && d.oldOwner !== tile.player() && d.gainedSight) {
      if (bot.curPath !== null && bot.curPath !== undefined && bot.curPath.tail.tile === tile) {
        bot.viewInfo.add_info_line('reset curPath because gained vision of a city whose player is now different.');
        bot.curPath = null;
      }
      if (d.oldOwner === -1 || tile.player() === -1) bot._map.distance_mapper.recalculate();
    }

    if (d.gainedSight && tile.player() >= 0) {
      bot.opponent_tracker.notify_player_tile_revealed(tile);
      if (bot._map.players[tile.player()].tiles.length < 3) {
        if (bot._map.turn > 15) {
          // 这个新玩家整块地盘都是这一眼才看到的 ⇒ 是个刚冒出来的玩家，岛要重建
          var allNew = true;
          var hisTiles = bot._map.players[tile.player()].tiles;
          for (var t = 0; t < hisTiles.length; t++) {
            if (!hisTiles[t].delta.gainedSight) { allNew = false; break; }
          }
          if (allNew) {
            var adjs = tile.adjacents || [];
            for (var a = 0; a < adjs.length; a++) {
              if (onTeam(bot._map, adjs[a].player(), bot.general.player()) && adjs[a].delta.armyDelta !== 0) {
                allNew = false;
                break;
              }
            }
          }
          if (allNew) bot._should_recalc_tile_islands = true;
        }
      }
    } else if (d.lostSight && tile.player() >= 0) {
      bot.opponent_tracker.notify_player_tile_vision_lost(tile);
    }

    if (tile.isMountain) {
      if (bot.curPath !== null && bot.curPath !== undefined && bot.curPath.tileSet && bot.curPath.tileSet.has
        && bot.curPath.tileSet.has(tile)) {
        bot.curPath = null;
      }
      if (d.oldOwner !== -1) {
        // 迷雾里当成城去追的山头 —— 目标玩家的所有推断路径全部作废
        bot.armyTracker.add_need_to_track_city(tile);
        bot.viewInfo.add_info_line('FOG CITY WAS WRONG, FORCING RESCANS AND PLAYER PATH RECALCS');
        bot.target_player_gather_path = null;
        bot.target_player_gather_targets = null;
        bot.shortest_path_to_target_player = null;
        bot.board_analysis.should_rescan = true;
      }
    }

    if (tile.visible && tile.isCity && tile.player() === -1 && d.oldOwner !== -1) {
      if (bot.curPath !== null && bot.curPath !== undefined && bot.curPath.tileSet && bot.curPath.tileSet.has
        && bot.curPath.tileSet.has(tile)) {
        bot.viewInfo.add_info_line('Ceasing curPath because target city was actually neutral.');
        bot.curPath = null;
      }
    }

    if (tile.isCity) bot.armyTracker.add_need_to_track_city(tile);
    return null;
  };

  // BotEventHandlers.py:172
  H.handle_army_moved = function (bot, army) {
    var tile = army.tile;
    bot.armies_moved_this_turn.push(tile);
    var player = bot._map.players[tile.player()];
    if (player) player.last_seen_move_turn = bot._map.turn;

    var prev = army.path && army.path.tail ? army.path.tail.prev : null;
    if (prev !== null && prev !== undefined && prev.tile
      && !prev.tile.was_visible_last_turn() && army.tile.visible) {
      // 从雾里冒出来的兵：差额取负（原版 emergenceAmount = 0 - prev.delta.armyDelta）
      bot.opponent_tracker.notify_emerged_army(prev.tile, army.player, 0 - prev.tile.delta.armyDelta);
    }

    bot.territories.needToUpdateAroundTiles.add(tile);
    bot.territories.revealed_tile(tile);
    return null;
  };

  // BotEventHandlers.py:188
  H.clear_fog_armies_around = function (bot, enemyGeneral) {
    if (!enemyGeneral) return null;
    var genPlayer = enemyGeneral.player();
    EK.search.breadth_first_foreach(bot._map, [enemyGeneral], 7, function (tile) {
      if (tile.visible) return;
      var army = bot.armyTracker.armies.get(tile);
      if (army && army.player === genPlayer) bot.armyTracker.scrap_army(army, false);
    });
    return null;
  };

  // bot_ek0x45.py:2059-2069 的注册动作。必须在 armyTracker / territories / board_analysis
  // 都建好之后调用，否则回调触发时拿到 undefined。
  H.initialize_callbacks = function (bot) {
    if (bot._eventHandlersInitialized) return;
    bot._eventHandlersInitialized = true;

    var map = bot._map;
    if (map.notify_city_found) map.notify_city_found.push(function (tile) { H.handle_city_found(bot, tile); });
    if (map.notify_tile_captures) map.notify_tile_captures.push(function (tile) { H.handle_tile_captures(bot, tile); });
    if (map.notify_tile_discovered) map.notify_tile_discovered.push(function (tile) { H.handle_tile_discovered(bot, tile); });
    if (map.notify_tile_vision_changed) {
      map.notify_tile_vision_changed.push(function (tile) { H.handle_tile_vision_change(bot, tile); });
    }
    if (map.notify_player_captures) {
      map.notify_player_captures.push(function (capturee, capturer) { H.handle_player_captures(bot, capturee, capturer); });
    }
    if (bot.armyTracker && bot.armyTracker.notify_unresolved_army_emerged) {
      bot.armyTracker.notify_unresolved_army_emerged.push(function (tile) { H.handle_tile_vision_change(bot, tile); });
    }
    if (bot.armyTracker && bot.armyTracker.notify_army_moved) {
      bot.armyTracker.notify_army_moved.push(function (army) { H.handle_army_moved(bot, army); });
    }
  };

  return H;
})(typeof window !== 'undefined' ? window : globalThis);

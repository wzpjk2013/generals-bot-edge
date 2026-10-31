/*
 * BotCombatOps 移植
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\BotModules\BotCombatOps.py（2228 行）
 *
 * 这个文件回答的是「打不打、什么时候打、用谁去打」三件事：
 *   1. 斩首（check_for_king_kills_and_races / kill_enemy_paths）：从对方将军或已知敌军
 *      出发反向 BFS，凑出足够吃掉目标的兵力路径，再用「赛跑胜率」判断值不值。
 *   2. 全下（get_all_in_move / try_get_cyclic_all_in_move / determine_should_winning_all_in）：
 *      判断自己是不是已经该把所有兵集中到一条线上。它的输入是「周期剩余回合」，
 *      所以必须在防守和扩张都算完之后再调 —— 这是调用顺序敏感的原因。
 *   3. 局部计数（sum_* / count_*）：一片区域里有多少敌兵/敌格，供上面两类阈值使用。
 *
 * 为什么顺序重要：check_should_be_all_in_losing / worth_attacking_target 会写 bot 的状态位
 * （is_all_in_losing / all_in_losing_counter / lastTimingFactor / lastTargetAttackTurn），
 * 下一回合会读回来。也就是说这些函数不是纯函数，同一回合里调用顺序变了，状态机就变了。
 * 移植时逐行保留「先读后写」的位置，不做合并。
 *
 * 拿不准的地方一律照原版写，包括原版自己的怪癖：
 *   - 原版 calculate_value 会因为负权把 value 打成负数，随后几处用 `if value <= 0` 兜底，
 *     这里的兜底也必须照抄，否则会拿负值去比阈值。
 *   - get_kill_race_chance 里 toReveal 的 0 号元素决定「是否唯一可能位置」，依赖
 *     sorted 的稳定序，不能改成 Set 迭代。
 *   - try_find_flank_all_in 在原版就是直接 return None 的空壳（2136-2138 行），这里照抄空壳，
 *     不要「补全」成有逻辑的实现。
 *
 * 没搬的部分（原版有、这里缺依赖），每处就地注释原因：
 *   - BotTargeting（is_ffa_situation / get_target_player_possible_general_location_tiles_sorted /
 *     get_afk_players / get_contested_targets）：JS 侧没有这个模块。
 *   - WatchmanRouteUtils（get_watchman_path / get_revealed_count_and_max_kill_turns_and_positive_path）：
 *     整个模块没搬，斩首的路径打磨与胜率精算因此降级，见 get_kill_race_chance。
 *   - MapSpanningUtils.get_spanning_tree_from_tile_lists：用本地 BFS 可达格数近似。
 *   - BotComms / BotRendering / BotTimings / win_condition_analyzer / BotGatherOps /
 *     Gather.gather_approximate_turns_to_tiles：对应函数在 JS 侧不存在，调用点加守卫后
 *     走原版的「没有信息」分支。
 *
 * 对照 ekdiff-combatops.js 的 oracle：能逐字段对齐的入口都在同一回合同一输入下比对过。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------- 收口层 ---------------- */

  // 原版 `x in container`：可能命中 set（JS 侧多是 Set）也可能命中 list
  function _member(coll, item) {
    if (!coll) return false;
    if (typeof coll.has === 'function') return coll.has(item);
    if (Array.isArray(coll)) return coll.indexOf(item) >= 0;
    return false;
  }

  function _map(bot) {
    return bot.map || bot._map;
  }

  function _player(tile) {
    if (tile === null || tile === undefined) return -1;
    if (typeof tile.player === 'function') return tile.player();
    var v = tile._player;
    return v === undefined ? -1 : v;
  }

  function _idx(tile) {
    return tile === null || tile === undefined ? -1 : tile.tile_index;
  }

  function _alias(bot, names) {
    for (var i = 0; i < names.length; i++) {
      var v = bot[names[i]];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  }

  function _isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Python 的 `x in dict` / `x[k]` 对照 JS 的 Map 与普通对象两种容器。
  // 原版这里的 armies / largeTilesNearEnemyKings 都是 dict，JS 侧两者都出现过。
  function _has(container, key) {
    if (container === null || container === undefined) return false;
    if (typeof container.has === 'function') return container.has(key);
    return Object.prototype.hasOwnProperty.call(container, key);
  }

  function _get(container, key) {
    if (container === null || container === undefined) return undefined;
    if (typeof container.get === 'function') return container.get(key);
    return container[key];
  }

  function _keys(container) {
    if (container === null || container === undefined) return [];
    if (typeof container.keys === 'function') return Array.from(container.keys());
    return Object.keys(container).map(function (k) {
      return container[k];
    });
  }

  // MapMatrix 只有 .raw；Python 的 MapMatrix 支持 []。越界一律 infty（原版矩阵初值是 infty）。
  function _mat(mat, tile) {
    if (mat === null || mat === undefined) return null;
    var v = mat.raw ? mat.raw[_idx(tile)] : mat[_idx(tile)];
    return v === undefined ? null : v;
  }

  function _teamIds(map) {
    return map.team_ids_by_player_index || [];
  }

  // Python `team_ids_by_player_index[-1]` 取的是数组末位（原版在末尾补了 -1），
  // JS 的 arr[-1] 是 undefined，所以这里显式折一次。
  function teamId(map, player) {
    var teams = _teamIds(map);
    if (!teams || teams.length === 0) return player;
    if (player === -1) return teams[teams.length - 1];
    var v = teams[player];
    return v === undefined ? player : v;
  }

  function isPlayerOnTeamWith(map, p1, p2) {
    if (p1 === p2) return true;
    if (map && typeof map.is_player_on_team_with === 'function') {
      return map.is_player_on_team_with(p1, p2);
    }
    return teamId(map, p1) === teamId(map, p2);
  }

  // 原版大量 `bot.viewInfo.xxx(...)`；JS 侧没有渲染层，这里是一个静默接收器，
  // 只为让移植结构保持原样（渲染不影响决策）。
  function _sink() {}
  var _viewInfoStub = {
    add_info_line: _sink,
    add_targeted_tile: _sink,
    color_path: _sink,
    paths: [],
    infoText: ''
  };

  function _vi(bot) {
    return bot.viewInfo || _viewInfoStub;
  }

  // perf_timer.begin_move_event 在原版是性能采样上下文管理器；这里退化成空操作。
  function _perfEvent(bot, name, fn) {
    var pt = bot.perf_timer;
    if (pt && typeof pt.begin_move_event === 'function') {
      var ev = pt.begin_move_event(name);
      if (ev && typeof ev.close === 'function') {
        try {
          return fn();
        } finally {
          ev.close();
        }
      }
    }
    return fn();
  }

  function _info(bot, msg) {
    if (typeof bot.info === 'function') bot.info(msg);
  }

  function _tracker(bot) {
    return _alias(bot, ['armyTracker', 'army_tracker']);
  }

  function _ot(bot) {
    return _alias(bot, ['opponent_tracker', 'opponentTracker']);
  }

  function _territories(bot) {
    return _alias(bot, ['territories', 'territoryClassifier']);
  }

  // 原版 BotTimings 是独立模块（JS 未移植）。周期长度在各处只影响「本回合还剩几回合」，
  // 这里按原版默认的 50 回合周期兜底，与 map.js 的 remainingCycleTurns 保持同一语义。
  function _timings(bot) {
    return _alias(bot, ['timings', 'botTimings']);
  }

  function _turnsLeftInCycle(bot) {
    var map = _map(bot);
    var timings = _timings(bot);
    if (timings && typeof timings.get_turns_left_in_cycle === 'function') {
      return timings.get_turns_left_in_cycle(map.turn);
    }
    if (typeof map.remainingCycleTurns === 'number') return map.remainingCycleTurns;
    var cycle = 50;
    return cycle - (map.turn % cycle);
  }

  function _cycleTurns(bot) {
    var timings = _timings(bot);
    if (timings && _isNum(timings.cycleTurns)) return timings.cycleTurns;
    return 50;
  }

  function _isFfaSituation(bot) {
    if (bot.is_ffa_situation !== undefined) return !!bot.is_ffa_situation;
    if (EK.BotTargeting && typeof EK.BotTargeting.is_ffa_situation === 'function') {
      return EK.BotTargeting.is_ffa_situation(bot);
    }
    // BotTargeting 未移植：原版 is_ffa_situation = not is_walled_city_game and
    // are_more_teams_alive_than(bot, 2)，而 are_more_teams_alive_than 数的是「没死、地块>3、
    // 不是 AFK」的玩家所在队伍。AFK 检测在 BotTargeting，缺它时按「没有 AFK」算，
    // 也就是这里比原版最多多算几支队（只会让 FFA 判定更容易成立，不会把 FFA 判成 1v1）。
    var map = _map(bot);
    if (map.is_walled_city_game) return false;
    var teams = new Set();
    for (var i = 0; i < map.players.length; i++) {
      var p = map.players[i];
      if (!p.dead && p.tileCount > 3) teams.add(teamId(map, p.index));
    }
    return teams.size > 2;
  }

  function _winCondition(bot) {
    return _alias(bot, ['win_condition_analyzer', 'winConditionAnalyzer']);
  }

  function _projectedLossAllIn(bot) {
    var wc = _winCondition(bot);
    return !!(wc && wc.projected_loss_all_in_active);
  }

  function _armyAt(bot, tile, noExpectedPath) {
    if (typeof bot.get_army_at === 'function') {
      return noExpectedPath ? bot.get_army_at(tile, true) : bot.get_army_at(tile);
    }
    var tracker = _tracker(bot);
    if (tracker && typeof tracker.get_or_create_army_at === 'function') {
      return tracker.get_or_create_army_at(tile);
    }
    return { tile: tile, player: _player(tile), value: tile.army - 1, expectedPaths: [] };
  }

  function _path() {
    return new EK.Path();
  }

  // 原版 `x is None` 判断；JS 里 null / undefined 都算 None。
  function _isNone(v) {
    return v === null || v === undefined;
  }

  function _threatObj(turns, value, path, type, saveTile, armyAnalysis) {
    return new EK.ThreatObj(turns, value, path, type, saveTile, armyAnalysis);
  }

  function _counter(v) {
    return new EK.search.Counter(v);
  }

  function _bfs(map, startTiles, maxDepth, fn, opts) {
    opts = opts || {};
    EK.search.breadth_first_foreach(
      map,
      startTiles,
      maxDepth,
      fn,
      opts.skipTiles || null,
      opts.noLog === undefined ? true : !!opts.noLog,
      !!opts.bypassDefaultSkip
    );
  }

  function _distBfsNoNeutCities(map, startTiles, maxDepth, fn) {
    EK.search.breadth_first_foreach_fast_no_neut_cities(map, startTiles, maxDepth, fn);
  }

  function _distBfsInclNeutCities(map, startTiles, maxDepth, fn) {
    EK.search.breadth_first_foreach_dist_fast_incl_neut_cities(map, startTiles, maxDepth, fn);
  }

  // 原版 MapSpanningUtils.get_spanning_tree_from_tile_lists(map, tile_lists, skip)：
  // 把若干目标列表并成一张连通树，返回 (connected_tiles, missing_required)。
  // JS 侧没有这个模块；斩首里它只用来算「凑到这些落点的额外距离」，这里用
  // 「从第一个列表 BFS 到覆盖其余列表的格数」近似，语义上偏保守（只会多算距离）。
  function _spanningTreeFromTileLists(map, tileLists) {
    var first = null;
    for (var i = 0; i < tileLists.length; i++) {
      if (tileLists[i] && tileLists[i].length) {
        first = tileLists[i];
        break;
      }
    }
    if (first === null) return { connected: [], missingRequired: [] };
    var wanted = new Set();
    for (var j = 0; j < tileLists.length; j++) {
      var list = tileLists[j];
      if (!list) continue;
      for (var k = 0; k < list.length; k++) wanted.add(list[k]);
    }
    var connected = [];
    _bfs(map, first, 100, function (tile) {
      if (wanted.has(tile)) connected.push(tile);
    }, { noLog: true, bypassDefaultSkip: true });
    return { connected: connected, missingRequired: [] };
  }

  function _scale(inValue, inBottom, inTop, outBottom, outTop) {
    if (inBottom > inTop) throw new Error('inBottom > inTop');
    inValue = Math.max(inBottom, inValue);
    inValue = Math.min(inTop, inValue);
    var numerator = inValue - inBottom;
    var divisor = inTop - inBottom;
    if (divisor === 0) return outTop;
    var valRatio = numerator / divisor;
    return valRatio * (outTop - outBottom) + outBottom;
  }

  var BotCombatOps = {};

  BotCombatOps.scale = function (inValue, inBottom, inTop, outBottom, outTop) {
    return _scale(inValue, inBottom, inTop, outBottom, outTop);
  };

  /* ---------------- 斩首 ---------------- */

  BotCombatOps.check_for_king_kills_and_races = function (bot, threat, force) {
    if (force === undefined) force = false;
    var map = _map(bot);
    var general = bot.general || map.generals[map.player_index];

    var kingKillPath = null;
    var kingKillChance = 0.0;
    var alwaysCheckKingKillWithinRange = 5;
    if (bot.is_all_in_losing && !bot.all_in_city_behind) {
      alwaysCheckKingKillWithinRange = 7;
    }

    var isFfa = _isFfaSituation(bot);
    if (isFfa) {
      alwaysCheckKingKillWithinRange += 3;
    }

    var extraTurnOnPriority = 0;
    if (!_isNone(threat) && typeof map.player_has_priority_over_other === 'function' &&
        map.player_has_priority_over_other(bot.player.index, threat.threatPlayer, map.turn + threat.turns)) {
      extraTurnOnPriority = 1;
    }

    var threatIsGeneralKill = !_isNone(threat) && threat.threatType === EK.ThreatType.Kill &&
      threat.path.tail.tile.isGeneral;

    var enemyGenerals = _keys(bot.largeTilesNearEnemyKings);
    var killPath = null;
    var additionalKillArmyRequirement = 0;
    var attackNegTiles = new Set();
    var targetArmy = 1;
    var addlIncrement = 0.0;
    var nonGenArmy = 0;

    for (var gi = 0; gi < enemyGenerals.length; gi++) {
      var enemyGeneral = enemyGenerals[gi];
      if (_isNone(enemyGeneral) || _player(enemyGeneral) === _player(general)) continue;
      if (map.teammates && map.teammates.has(_player(enemyGeneral))) continue;

      if (_player(enemyGeneral) === -1 && EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
        continue;
      }

      var enPlayer = _player(enemyGeneral);
      if (enPlayer === -1) enPlayer = bot.targetPlayer;
      if (enPlayer === -1) continue;

      var altEnGenPositions = (bot.alt_en_gen_positions && bot.alt_en_gen_positions[enPlayer]) || [];

      var curExtraTurn = extraTurnOnPriority;

      var turnsToDeath = null;
      var killRaceCutoff = 0.3;
      if (threatIsGeneralKill) {
        turnsToDeath = threat.turns + 1 + curExtraTurn;
        var oppTracker0 = _ot(bot);
        var econRatio = oppTracker0 ? oppTracker0.get_current_econ_ratio() : 1.0;
        killRaceCutoff = Math.min(0.99, 0.95 * econRatio * econRatio);
      }

      var thisPlayerDepth = alwaysCheckKingKillWithinRange;

      if (!_isNone(bot.target_player_gather_path) && bot.targetPlayer === enPlayer) {
        thisPlayerDepth = Math.min(thisPlayerDepth, Math.floor(bot.target_player_gather_path.length / 3));
      }

      attackNegTiles = new Set();
      targetArmy = 1;
      addlIncrement = 0.0;
      nonGenArmy = 0;

      var threatDistCutoff = 1000;
      if (!_isNone(threat)) {
        threatDistCutoff = threat.turns + curExtraTurn;
        if (!map.players[threat.threatPlayer].knowsKingLocation && bot.target_player_gather_path) {
          var gatherPathLen = bot.target_player_gather_path.length;
          var tilesOppHasntSeen = new Set();
          var ourTiles = bot.player.tiles;
          for (var ti = 0; ti < ourTiles.length; ti++) {
            var pt = ourTiles[ti];
            if (map.get_distance_between(enemyGeneral, pt) <= gatherPathLen &&
                map.get_distance_between(general, pt) < Math.floor(gatherPathLen / 3)) {
              tilesOppHasntSeen.add(pt);
            }
          }
          var closeTilesOppHasSeen = new Set();
          var trackerForVision = _tracker(bot);
          var everOwned = trackerForVision ? trackerForVision.tiles_ever_owned_by_player[threat.threatPlayer] : null;
          if (everOwned) {
            var everArr = everOwned.forEach ? Array.from(everOwned) : everOwned;
            for (var ei = 0; ei < everArr.length; ei++) {
              var tile = everArr[ei];
              if (tilesOppHasntSeen.has(tile)) {
                tilesOppHasntSeen.delete(tile);
                closeTilesOppHasSeen.add(tile);
              }
              for (var ai = 0; ai < tile.adjacents.length; ai++) {
                var adj = tile.adjacents[ai];
                if (_player(adj) === _player(general)) {
                  if (tilesOppHasntSeen.has(adj)) {
                    tilesOppHasntSeen.delete(adj);
                    closeTilesOppHasSeen.add(adj);
                  }
                }
              }
            }
          }

          var unknownsToHunt = tilesOppHasntSeen.size - closeTilesOppHasSeen.size - threat.turns;
          if (unknownsToHunt > 0) {
            var cutoffIncrease = Math.floor(Math.pow(unknownsToHunt, 0.5)) - 1;
            if (cutoffIncrease > 0) {
              threatDistCutoff += cutoffIncrease;
            }
          }
        }
      }

      if (!enemyGeneral.visible) {
        var defTurns = 0;
        var optTargetArmy = EK.BotDefense.determine_fog_defense_amount_available_for_tiles(
          bot, altEnGenPositions, enPlayer, defTurns, 5);
        var newTargetArmyOption = optTargetArmy;

        if (enemyGeneral.isGeneral) {
          newTargetArmyOption -= enemyGeneral.army;
        }

        if (newTargetArmyOption > targetArmy) {
          targetArmy = newTargetArmyOption;
          nonGenArmy = optTargetArmy;
        }

        var otForQueue = _ot(bot);
        if (_isNone(threat) && otForQueue &&
            otForQueue.get_player_gather_queue(enPlayer).cur_max_tile_size > 2) {
          addlIncrement += 0.5;
        }
      }

      if (!enemyGeneral.isGeneral) {
        addlIncrement += 0.5;
        if (!isFfa) {
          thisPlayerDepth = Math.max(3, thisPlayerDepth - 5);
        }
      }

      var qkDist = 8;
      if (!_isNone(bot.target_player_gather_path)) {
        qkDist = Math.floor(2 * bot.target_player_gather_path.length / 3);
      }
      if (altEnGenPositions.length < 20) {
        var quickKill = EK.search.dest_breadth_first_target(map, altEnGenPositions, {
          targetArmy: Math.max(targetArmy, 1),
          maxTime: 0.05,
          maxDepth: qkDist,
          negativeTiles: attackNegTiles,
          searchingPlayer: _player(general),
          ignoreGoalArmy: !!bot.has_defenseless_modifier,
          additionalIncrement: addlIncrement,
          noLog: true
        });

        if (!_isNone(quickKill) && quickKill.length > 0) {
          var spanning = _spanningTreeFromTileLists(map, [altEnGenPositions]);
          var additionalKillDist = spanning.connected.length;
          var maxEnDefTurns = quickKill.length + additionalKillDist;
          var cityLimit = 1;
          if (!enemyGeneral.isGeneral) {
            cityLimit += 1;
          }

          var cutoffKillArmy = 0;
          var cutoffEmergence = 0.4;
          var otForRisk = _ot(bot);
          if (threatIsGeneralKill) {
            cutoffKillArmy = otForRisk
              ? otForRisk.get_approximate_fog_army_risk(enPlayer, { cityLimit: null, inTurns: 0 })
              : 0;
            if (enemyGeneral.isGeneral) {
              cutoffKillArmy -= enemyGeneral.army + Math.floor(quickKill.length / 2);
            }
            cutoffEmergence = 0.15;
          } else if (otForRisk) {
            cutoffKillArmy = otForRisk.get_approximate_fog_army_risk(enPlayer, {
              cityLimit: null,
              inTurns: maxEnDefTurns - 3
            }) + 2 * additionalKillDist - 5;
          } else {
            cutoffKillArmy = 2 * additionalKillDist - 5;
          }

          cutoffKillArmy = Math.max(0, cutoffKillArmy);

          if (quickKill.value > cutoffKillArmy || threatIsGeneralKill) {
            var ogQuickKill = quickKill;
            var ogAdditionalKillDist = additionalKillDist;
            if (!quickKill.tileList[quickKill.tileList.length - 1].isGeneral) {
              // 原版在这里用 WatchmanRouteUtils.get_watchman_path 打磨首段路径，
              // JS 侧没有该模块，所以保留原路径（打磨只影响观感与几十毫秒，不改变可达性）。
              var wrpPath = _watchmanPath(bot, quickKill.tileList[0]);
              if (!_isNone(wrpPath)) {
                var closest = null;
                var closestDist = 100;
                var found = false;
                var wrpTiles = wrpPath.tileList;
                for (var wi = 0; wi < wrpTiles.length; wi++) {
                  var dist = map.get_distance_between(bot.targetPlayerExpectedGeneralLocation, wrpTiles[wi]);
                  if (dist < closestDist) {
                    closest = wrpTiles[wi];
                    closestDist = dist;
                  }
                  if (!found) {
                    found = true;
                    quickKill = wrpPath;
                  }
                }
                if (found) {
                  additionalKillDist = closestDist;
                }
              }
            }

            var killRaceChance = BotCombatOps.get_kill_race_chance(bot, quickKill, {
              enGenProbabilityCutoff: cutoffEmergence + 0.1,
              turnsToDeath: turnsToDeath,
              cutoffKillArmy: cutoffKillArmy
            });
            if (_isNone(threat) || !threatIsGeneralKill || killRaceChance >= killRaceCutoff) {
              var move0 = new EK.Move(quickKill.start.tile, quickKill.start.next.tile);
              if (EK.BotPathingUtils.is_move_safe_valid(bot, move0)) {
                bot.curPath = null;
                if (quickKill.start.next.tile.isCity) {
                  bot.curPath = quickKill;
                }
                return [move0, quickKill, killRaceChance];
              }
            } else if (killRaceChance > kingKillChance) {
              kingKillPath = quickKill;
              kingKillChance = killRaceChance;
            }
          }
        }
      }

      if (!enemyGeneral.isGeneral && !isFfa && altEnGenPositions.length > 2) {
        continue;
      }

      killPath = _depthIncreasingKillSearch(bot, {
        enemyGeneral: enemyGeneral,
        enPlayer: enPlayer,
        threat: threat,
        threatIsGeneralKill: threatIsGeneralKill,
        turnsToDeath: turnsToDeath,
        killRaceCutoff: killRaceCutoff,
        thisPlayerDepth: thisPlayerDepth,
        targetArmy: targetArmy,
        nonGenArmy: nonGenArmy,
        addlIncrement: addlIncrement,
        altEnGenPositions: altEnGenPositions,
        attackNegTilesRef: function () {
          return attackNegTiles;
        },
        setAttackNegTiles: function (v) {
          attackNegTiles = v;
        },
        threatDistCutoff: threatDistCutoff,
        force: force,
        kingKillPath: kingKillPath,
        kingKillChance: kingKillChance
      });
      killPath = killPath;
      if (killPath) {
        if (killPath.move !== undefined) return [killPath.move, killPath.path, killPath.chance];
        kingKillPath = killPath.kingKillPath;
        kingKillChance = killPath.kingKillChance;
        additionalKillArmyRequirement = killPath.additionalKillArmyRequirement || 0;
      } else {
        additionalKillArmyRequirement = 0;
      }

      if (isFfa) {
        var tiles = _get(bot.largeTilesNearEnemyKings, enemyGeneral);
        if (tiles && tiles.length > 0) {
          var bestPath = null;
          var targets = new Set(altEnGenPositions);
          var aStarPath = EK.search.a_star_kill
            ? EK.search.a_star_kill(map, tiles, targets, 0.03,
              Math.floor(EK.BotPathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation) / 4),
              { requireExtraArmy: targetArmy + additionalKillArmyRequirement, negativeTiles: attackNegTiles })
            : null;

          var killChance = 0.0;
          if (killPath) {
            killChance = BotCombatOps.get_kill_race_chance(bot, killPath, {
              enGenProbabilityCutoff: 0.3,
              turnsToDeath: turnsToDeath
            });
          }

          if (!_isNone(aStarPath) && aStarPath.length >= 0 &&
              (_isNone(threat) || threat.threatType !== EK.ThreatType.Kill ||
                ((threatDistCutoff >= aStarPath.length || EK.BotStateQueries.is_all_in(bot)) &&
                  threat.threatPlayer === _player(enemyGeneral) && killChance > killRaceCutoff))) {
            bot.curPath = aStarPath.get_subsegment(2);
            bot.curPathPrio = 5;
            bestPath = aStarPath;
          } else if (!_isNone(aStarPath) && aStarPath.length > 0) {
            if (kingKillPath === null) {
              kingKillPath = aStarPath;
            }
          }
          if (bestPath !== null) {
            var moveA = new EK.Move(bestPath.start.tile, bestPath.start.next.tile);
            return [moveA, aStarPath, killChance];
          }
        }
      }
    }

    return [null, kingKillPath, kingKillChance];
  };

  // 原版 check_for_king_kills_and_races 里「depth 递增 BFS + 全量 BFS」那一段（280-393 行）。
  // 单独拆函数只是因为 JS 没有 with 语句，原版三处 early-return 要在这里分别带出结果。
  function _depthIncreasingKillSearch(bot, ctx) {
    var map = _map(bot);
    var enemyGeneral = ctx.enemyGeneral;
    var threat = ctx.threat;
    var kingKillPath = ctx.kingKillPath;
    var kingKillChance = ctx.kingKillChance;
    var killRaceCutoff = ctx.killRaceCutoff;
    var turnsToDeath = ctx.turnsToDeath;
    var targetArmy = ctx.targetArmy;
    var nonGenArmy = ctx.nonGenArmy;
    var addlIncrement = ctx.addlIncrement;
    var altEnGenPositions = ctx.altEnGenPositions;
    var additionalKillArmyRequirement = 0;

    return _perfEvent(bot, 'race depth increasing', function () {
      var inc = 1;
      for (var depth = 2; depth < ctx.thisPlayerDepth; depth += inc) {
        var enemyNegTiles = [];
        if (!_isNone(threat)) {
          enemyNegTiles.push(threat.path.start.tile);
        }
        var enemySavePath = EK.BotDefense.get_best_defense
          ? EK.BotDefense.get_best_defense(bot, enemyGeneral, depth - 1, enemyNegTiles)
          : null;
        var defTurnsLeft = depth - 1;
        var depthTargetArmy = targetArmy;
        var attackNegTiles = ctx.attackNegTilesRef();
        if (!_isNone(enemySavePath)) {
          defTurnsLeft -= enemySavePath.length;
          depthTargetArmy = Math.max(enemySavePath.value + nonGenArmy, depthTargetArmy);
          if (!enemyGeneral.visible) {
            depthTargetArmy = Math.max(depthTargetArmy,
              enemySavePath.value + nonGenArmy +
              EK.BotDefense.determine_fog_defense_amount_available_for_tiles(
                bot, altEnGenPositions, ctx.enPlayer, defTurnsLeft));
          }
          attackNegTiles = new Set(enemySavePath.tileSet);
          attackNegTiles.delete(enemyGeneral);
          ctx.setAttackNegTiles(attackNegTiles);
        }

        if (!enemyGeneral.visible) {
          depthTargetArmy = Math.max(depthTargetArmy,
            EK.BotDefense.determine_fog_defense_amount_available_for_tiles(
              bot, altEnGenPositions, ctx.enPlayer, depth - 1));
        }

        var shouldPrioritizeTileCaps =
          !EK.BotStateQueries.is_all_in(bot) &&
          !_isFfaSituation(bot) &&
          (_isNone(threat) || threat.threatType !== EK.ThreatType.Kill);

        var killPath = EK.search.dest_breadth_first_target(map, altEnGenPositions, {
          targetArmy: Math.max(depthTargetArmy, 1),
          maxTime: 0.05,
          maxDepth: depth,
          negativeTiles: attackNegTiles,
          searchingPlayer: _player(bot.general),
          dupeThreshold: 3,
          preferCapture: shouldPrioritizeTileCaps,
          ignoreGoalArmy: !!bot.has_defenseless_modifier,
          additionalIncrement: addlIncrement,
          noLog: true
        });
        if (!_isNone(killPath) && killPath.length > 0) {
          var killChance = 0.0;
          if (ctx.threatIsGeneralKill) {
            killChance = BotCombatOps.get_kill_race_chance(bot, killPath, {
              enGenProbabilityCutoff: 0.3,
              turnsToDeath: turnsToDeath
            });
          }
          if (_isNone(threat) || threat.threatType !== EK.ThreatType.Kill ||
              (ctx.threatDistCutoff >= killPath.length && killChance > killRaceCutoff)) {
            var move = new EK.Move(killPath.start.tile, killPath.start.next.tile);
            bot.curPath = null;
            if (killPath.start.next.tile.isCity) {
              bot.curPath = killPath;
            }
            if (EK.BotPathingUtils.is_move_safe_valid(bot, move)) {
              return { move: move, path: killPath, chance: killChance };
            }
          } else if (killChance > kingKillChance) {
            kingKillPath = killPath;
            kingKillChance = killChance;
          } else {
            if (kingKillPath === null) {
              kingKillPath = killPath;
            }
          }
        }
      }

      var rangeBasedOnDistance = Math.floor(
        EK.BotPathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation) / 3 - 1);
      additionalKillArmyRequirement = 0;
      var ot = _ot(bot);
      if (!enemyGeneral.isGeneral && ot) {
        additionalKillArmyRequirement = ot.get_approximate_fog_army_risk(ctx.enPlayer, {
          cityLimit: null,
          inTurns: 0
        });
      }
      additionalKillArmyRequirement = Math.max(0, additionalKillArmyRequirement);

      if (!ctx.force && ot &&
          !ot.winning_on_army(1.3) &&
          !ot.winning_on_army(1.3, bot.targetPlayer) &&
          !EK.BotStateQueries.is_all_in(bot) &&
          !enemyGeneral.visible) {
        rangeBasedOnDistance = Math.floor(
          EK.BotPathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation) / 4 - 1);

        additionalKillArmyRequirement = ot.get_approximate_fog_army_risk(ctx.enPlayer, {
          cityLimit: null,
          inTurns: 3
        });
      }

      var depth = Math.max(5 === 5 ? (bot.is_all_in_losing && !bot.all_in_city_behind ? 7 : 5) : 5,
        rangeBasedOnDistance);
      // 原版此处 depth 以 alwaysCheckKingKillWithinRange 为下限；上面那个三元就是在复算它
      // （含 ffa 的 +3），没直接复用是因为原版这一段的 depth 是重新算的。
      if (_isFfaSituation(bot)) depth = Math.max(depth, 8, rangeBasedOnDistance);

      if (bot.is_all_in_losing || _isFfaSituation(bot)) {
        depth += 5;
      }

      var fullKillReq = targetArmy + additionalKillArmyRequirement;
      var altEnGenGoalPositions = new Map();
      for (var i = 0; i < altEnGenPositions.length; i++) {
        altEnGenGoalPositions.set(altEnGenPositions[i], [0, -fullKillReq, 1.0]);
      }
      var attackNegTilesNow = ctx.attackNegTilesRef();
      var killPath2 = EK.search.dest_breadth_first_target(map, altEnGenGoalPositions, {
        targetArmy: fullKillReq,
        maxTime: 0.05,
        maxDepth: depth,
        negativeTiles: attackNegTilesNow,
        searchingPlayer: _player(bot.general),
        dontEvacCities: false,
        dupeThreshold: 3
      });
      var killChance2 = 0.0;
      if (killPath2) {
        killChance2 = BotCombatOps.get_kill_race_chance(bot, killPath2, {
          enGenProbabilityCutoff: 0.3,
          turnsToDeath: turnsToDeath
        });
      }
      if (!_isNone(killPath2) && killPath2.length >= 0 &&
          (_isNone(threat) || threat.threatType !== EK.ThreatType.Kill ||
            (ctx.threatDistCutoff >= killPath2.length && killChance2 > killRaceCutoff))) {
        bot.curPath = null;
        var move2 = new EK.Move(killPath2.start.tile, killPath2.start.next.tile);
        if (EK.BotPathingUtils.is_move_safe_valid(bot, move2)) {
          return { move: move2, path: killPath2, chance: killChance2 };
        }
      } else if (killChance2 > kingKillChance) {
        kingKillPath = killPath2;
        kingKillChance = killChance2;
      } else if (!_isNone(killPath2) && killPath2.length > 0) {
        if (kingKillPath === null) {
          kingKillPath = killPath2;
        }
      }

      return {
        kingKillPath: kingKillPath,
        kingKillChance: kingKillChance,
        additionalKillArmyRequirement: additionalKillArmyRequirement
      };
    });
  }

  // WatchmanRouteUtils 未移植：原版用它给「快杀路径」找一条更短的情报收集路线。
  // 没有它就只能用原路径，因此这里返回 null，调用方保留原 quickKill。
  function _watchmanPath(bot, startTile) {
    return null;
  }

  /* ---------------- 赛跑胜率 ---------------- */

  BotCombatOps.get_kill_race_chance = function (bot, generalHuntPath, opts) {
    opts = opts || {};
    var enGenProbabilityCutoff = opts.enGenProbabilityCutoff === undefined ? 0.4 : opts.enGenProbabilityCutoff;
    var turnsToDeath = opts.turnsToDeath === undefined ? null : opts.turnsToDeath;
    var cutoffKillArmy = opts.cutoffKillArmy === undefined ? 0 : opts.cutoffKillArmy;
    var againstPlayer = opts.againstPlayer === undefined ? null : opts.againstPlayer;

    if (_isNone(generalHuntPath)) return 0.0;

    if (_isNone(againstPlayer)) againstPlayer = bot.targetPlayer;

    var toReveal = _targetPlayerPossibleGeneralLocations(bot, againstPlayer, enGenProbabilityCutoff);
    if (!toReveal || toReveal.length === 0) return 0.0;

    var isOnlyOneSpot = toReveal[0].isGeneral;

    if (!_isNone(turnsToDeath) && _ot(bot) && _ot(bot).winning_on_economy()) {
      turnsToDeath -= 1;
    }

    if (isOnlyOneSpot) {
      if (_isNone(turnsToDeath)) return 1.0;
      if (generalHuntPath.length < turnsToDeath) return 1.0;
      return 0.0;
    }

    // WatchmanRouteUtils 未移植 → revealedCount / rawKillDistByTileMatrix 拿不到。
    // 原版没有 bestRevealedPath 时正是 killChance=0.0 的分支，这里落到同一分支，
    // 保证「缺信息」时不会伪造出一个高胜率（宁可不去斩首）。
    return 0.0;
  };

  // BotTargeting.get_target_player_possible_general_location_tiles_sorted 的兜底：
  // 有 BotTargeting 就用真的，没有就退化成「已知将军格 + 兵最多的敌方格」，
  // 顺序按 (emergence, -army, tile_index) 稳定排序，与原版 sorted 的并列序一致。
  function _targetPlayerPossibleGeneralLocations(bot, player, cutoffEmergenceRatio) {
    if (EK.BotTargeting && typeof EK.BotTargeting.get_target_player_possible_general_location_tiles_sorted === 'function') {
      return EK.BotTargeting.get_target_player_possible_general_location_tiles_sorted(bot, {
        elimNearbyRange: 0,
        player: player,
        cutoffEmergenceRatio: cutoffEmergenceRatio,
        includeCities: false,
        requirePredictedFogTeamTile: true
      });
    }
    var map = _map(bot);
    var gen = map.generals[player];
    if (gen) return [gen];
    var tiles = (map.players[player] && map.players[player].tiles) || [];
    var sorted = tiles.slice().sort(function (a, b) {
      if (b.army !== a.army) return b.army - a.army;
      return a.tile_index - b.tile_index;
    });
    return sorted.slice(0, 1);
  }

  /* ---------------- 全下 ---------------- */

  BotCombatOps.get_all_in_move = function (bot, defenseCriticalTileSet) {
    if (!EK.BotStateQueries.is_all_in(bot)) return null;
    if (_projectedLossAllIn(bot)) return null;

    var hitGeneralInTurns = bot.all_in_army_advantage_cycle - bot.all_in_army_advantage_counter % bot.all_in_army_advantage_cycle;
    if (bot.is_all_in_army_advantage && bot.targetPlayerObj.tileCount < 90) {
      hitGeneralInTurns = (hitGeneralInTurns % 25) + 5;
    }
    var flankAllInMove = BotCombatOps.try_find_flank_all_in(bot, hitGeneralInTurns);
    if (flankAllInMove) {
      bot.all_in_army_advantage_counter += 1;
      return flankAllInMove;
    }

    var targets = [bot.targetPlayerExpectedGeneralLocation];
    var map = _map(bot);

    if (!bot.targetPlayerExpectedGeneralLocation.isGeneral) {
      // BotTargeting 未移植 → 用同一个兜底列表；原版这里取 [0:3] 再截到 5 个。
      var emergenceTiles = _targetPlayerPossibleGeneralLocations(bot, bot.targetPlayer, 0.6).slice(0, 3);
      targets = emergenceTiles.slice(0, 5);
    }

    if ((bot.is_all_in_army_advantage || bot.all_in_city_behind) && !EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
      if (bot.all_in_city_behind || map.remainingPlayers === 2) {
        var cities = bot.targetPlayerObj.cities || [];
        for (var ci = 0; ci < cities.length; ci++) targets.push(cities[ci]);
      }
    }

    var move = null;
    var gathCapPlan = null;
    _perfEvent(bot, 'pcst all in', function () {
      var gathNeg = new Set(defenseCriticalTileSet);
      var citiesToHalf = new Set();
      if (bot.is_all_in_army_advantage && bot.cityAnalyzer) {
        var contested = bot.cityAnalyzer.owned_contested_cities;
        contested.forEach(function (contestedCity) {
          if (contestedCity.army > bot.targetPlayerObj.standingArmy) {
            citiesToHalf.add(contestedCity);
          } else {
            gathNeg.add(contestedCity);
          }
        });
      }

      if (bot.is_winning_gather_cyclic || bot.is_all_in_army_advantage) {
        var spanning = bot.defensive_spanning_tree;
        if (spanning) spanning.forEach(function (t) {
          gathNeg.add(t);
        });
        var leaves = bot.best_defense_leaves || [];
        for (var li = 0; li < leaves.length; li++) gathNeg.add(leaves[li].tile);
      }

      // Gather.gather_approximate_turns_to_tiles 未移植（JS 的 gather.js 只有 build_from_root_nodes
      // 与 pruning）。原版这条 gather 是「全下」的唯一产物，缺了它就无法给出可信的推进路径，
      // 因此这里直接落到原版 gathCapPlan is None 的分支（停机判断），而不是伪造一棵树。
      gathCapPlan = null;
    });

    if (gathCapPlan === null) {
      if (bot.is_all_in_losing || bot.is_all_in_army_advantage || bot.all_in_city_behind) {
        bot.is_all_in_losing = false;
        bot.all_in_losing_counter = 0;
        bot.is_all_in_army_advantage = false;
        bot.all_in_army_advantage_counter = 0;
        bot.all_in_city_behind = false;
      }
      return null;
    }

    move = gathCapPlan.get_first_move();
    bot.curPath = gathCapPlan;

    if (!_isNone(move)) {
      bot.all_in_army_advantage_counter += 1;
      bot.gatherNodes = gathCapPlan.root_nodes;
      return move;
    }
    return null;
  };

  BotCombatOps.extend_interspersed_path_moves = function (bot, paths, move) {
    if (_isNone(move)) return;
    if (_isNone(move.dest)) throw new Error('extend_interspersed_path_moves: move.dest is None');

    var curPath = null;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!_isNone(p.tail) && p.tail.tile === move.source) {
        curPath = p;
        break;
      }
    }

    if (curPath === null) {
      curPath = _path();
      curPath.add_next(move.source);
      paths.push(curPath);
    }
    curPath.add_next(move.dest, move.move_half);
  };

  BotCombatOps.extract_engine_result_paths_and_render_sim_moves = function (bot, result) {
    var friendlyPaths = [];
    var enemyPaths = [];

    var bestMoves = result.expected_best_moves || [];
    for (var i = 0; i < bestMoves.length; i++) {
      BotCombatOps.extend_interspersed_path_moves(bot, friendlyPaths, bestMoves[i][0]);
      BotCombatOps.extend_interspersed_path_moves(bot, enemyPaths, bestMoves[i][1]);
    }

    var friendlyPath = null;
    var enemyPath = null;
    var vi = _vi(bot);

    var first = bestMoves.length > 0 ? bestMoves[0] : [null, null];
    for (var fi = 0; fi < friendlyPaths.length; fi++) {
      if (!_isNone(first[0]) && friendlyPaths[fi].start.tile === first[0].source) {
        friendlyPath = friendlyPaths[fi];
      } else if (typeof vi.color_path === 'function') {
        vi.color_path(friendlyPaths[fi]);
      }
    }
    for (var ei = 0; ei < enemyPaths.length; ei++) {
      if (!_isNone(first[1]) && enemyPaths[ei].start.tile === first[1].source) {
        enemyPath = enemyPaths[ei];
      } else if (typeof vi.color_path === 'function') {
        vi.color_path(enemyPaths[ei]);
      }
    }

    if (_isNone(friendlyPath) || friendlyPath.length === 0) {
      friendlyPath = null;
    } else if (typeof vi.color_path === 'function') {
      vi.color_path(friendlyPath);
    }

    if (_isNone(enemyPath) || enemyPath.length === 0) {
      enemyPath = null;
    } else if (typeof vi.color_path === 'function') {
      vi.color_path(enemyPath);
    }

    if (bestMoves.length > 0) {
      if (_isNone(bestMoves[0][0])) friendlyPath = null;
      if (_isNone(bestMoves[0][1])) enemyPath = null;
    }

    return [friendlyPath, enemyPath];
  };

  BotCombatOps.find_large_tiles_near = function (bot, fromTiles, distance, opts) {
    opts = opts || {};
    var forPlayer = opts.forPlayer === undefined ? -2 : opts.forPlayer;
    var allowGeneral = opts.allowGeneral === undefined ? true : !!opts.allowGeneral;
    var limit = opts.limit === undefined ? 5 : opts.limit;
    var minArmy = opts.minArmy === undefined ? 10 : opts.minArmy;
    var addlFilterFunc = opts.addlFilterFunc === undefined ? null : opts.addlFilterFunc;
    var allowTeam = !!opts.allowTeam;

    var map = _map(bot);
    var largeTilesNearTargets = [];
    if (forPlayer === -2) forPlayer = _player(bot.general);

    var forPlayers = [forPlayer];
    if (allowTeam) {
      var ot = _ot(bot);
      forPlayers = ot ? ot.get_team_players_by_player(forPlayer) : [forPlayer];
    }

    _distBfsInclNeutCities(map, fromTiles, distance, function (tile, dist) {
      if (forPlayers.indexOf(_player(tile)) >= 0 &&
          tile.army > minArmy &&
          (_isNone(addlFilterFunc) || addlFilterFunc(tile, dist)) &&
          (!tile.isGeneral || allowGeneral)) {
        largeTilesNearTargets.push(tile);
      }
    });

    // 原版：sorted(key=army, reverse=True)。Python 的 reverse 排序仍然稳定，
    // 等兵时保留的是 BFS 插入序（距离序），所以这里不能拿 tile_index 当兜底 ——
    // 那会把等兵的格子按编号重排，和原版选出的 seq 不一致（g1000 T46 实测）。
    largeTilesNearTargets.sort(function (a, b) {
      return b.army - a.army;
    });

    return largeTilesNearTargets.slice(0, limit);
  };

  BotCombatOps.continue_killing_target_army = function (bot) {
    var map = _map(bot);
    var targetingArmy = bot.targetingArmy;
    if (_isNone(targetingArmy)) return null;
    var tracker = _tracker(bot);

    if (tracker && _has(tracker.armies, targetingArmy.tile)) {
      var army = _get(tracker.armies, targetingArmy.tile);

      var inExpPlan = true;
      var expPath = null;
      if (!_isNone(bot.expansion_plan)) {
        inExpPlan = false;
        var allPaths = bot.expansion_plan.all_paths || [];
        for (var i = 0; i < allPaths.length; i++) {
          if (allPaths[i].tileSet.has(targetingArmy.tile)) {
            inExpPlan = true;
            expPath = allPaths[i];
            break;
          }
        }
      }

      if (!inExpPlan) {
        var gatherDepth = 10;
        var threats = [];
        var expected = targetingArmy.expectedPaths || [];
        for (var pi = 0; pi < expected.length; pi++) {
          var p = expected[pi];
          threats.push(_threatObj(p.length - 1, p.value, p, EK.ThreatType.Kill));
        }
        if (threats.length > 0 && bot.army_interceptor) {
          var plan = _perfEvent(bot, 'NEW INTERCEPT CONT', function () {
            return bot.army_interceptor.get_interception_plan(threats, { turnsLeftInCycle: _turnsLeftInCycle(bot) });
          });
          if (!_isNone(plan)) {
            var bestOpt = null;
            var bestOptAmt = 0;
            var bestTurn = 0;
            var bestOptAmtPerTurn = 0;
            var options = plan.intercept_options;
            var entries = options instanceof Map ? Array.from(options.entries()) : Object.keys(options).map(function (k) {
              return [Number(k), options[k]];
            });
            for (var oi = 0; oi < entries.length; oi++) {
              var turn = entries[oi][0];
              var option = entries[oi][1];
              var val = option.econValue;
              var path = option.path;
              var valPerTurn = val / Math.max(1, turn);
              if (path.length < gatherDepth && valPerTurn > bestOptAmtPerTurn) {
                bestOpt = path;
                bestOptAmt = val;
                bestTurn = turn;
                bestOptAmtPerTurn = valPerTurn;
              }
            }

            if (!_isNone(bestOpt)) {
              var move = EK.BotPathingUtils.get_first_path_move(bot, bestOpt);
              return move;
            }
          }
        }

        bot.targetingArmy = null;
        return null;
      }

      var expMove = EK.BotPathingUtils.get_euclid_shortest_from_tile_towards_target(
        bot, expPath.get_first_move().source, targetingArmy.tile);
      return expMove;
    }

    bot.targetingArmy = null;

    if (!bot.targetingArmy) {
      // 原版在这里已经把自己清成 None，所以后面这段永远 return None；
      // 保留结构是为了让「先清后判」的顺序与原版一致。
      return null;
    }

    var enArmyDist = EK.BotPathingUtils.distance_from_general(bot, bot.targetingArmy.tile);
    var terrs = _territories(bot);
    var armyStillInRange = enArmyDist < EK.BotPathingUtils.distance_from_opp(bot, bot.targetingArmy.tile) + 2 ||
      (terrs && terrs.is_tile_in_friendly_territory(bot.targetingArmy.tile));
    if (armyStillInRange && BotCombatOps.should_kill(bot, bot.targetingArmy.tile)) {
      var forceKill = enArmyDist <= 4;
      var killPath = BotCombatOps.kill_army(bot, bot.targetingArmy, true, !forceKill);
      if (killPath) {
        var kmove = EK.BotPathingUtils.get_first_path_move(bot, killPath);
        if (!_isNone(bot.targetingArmy) && bot.targetingArmy.tile.army / killPath.length < 1) {
          return kmove;
        }
        if (!EK.BotRepetition.detect_repetition(bot, kmove, 6, 3) &&
            EK.BotDefense.general_move_safe(bot, kmove.dest)) {
          return kmove;
        }
        bot.targetingArmy = null;
      }
    } else {
      bot.targetingArmy = null;
    }

    return null;
  };

  BotCombatOps.should_kill = function (bot, tile) {
    if (tile.isCity && Math.abs(tile.delta.armyDelta) < 3) return false;
    return true;
  };

  BotCombatOps.just_moved = function (bot, tile) {
    return Math.abs(tile.delta.armyDelta) > 2;
  };

  BotCombatOps.should_kill_path_move_half = function (bot, threatKill, additionalArmy) {
    if (additionalArmy === undefined) additionalArmy = 0;
    var start = threatKill.start.tile;
    var next = threatKill.start.next.tile;
    threatKill.calculate_value(_player(bot.general), _teamIds(_map(bot)));
    var analysis = bot.board_analysis.intergeneral_analysis;
    var movingAwayFromEnemy = _mat(analysis.bMap, start) < _mat(analysis.bMap, next);
    var moveHalf = movingAwayFromEnemy &&
      threatKill.tail.tile.army + additionalArmy < Math.floor((threatKill.value + threatKill.tail.tile.army) / 2);

    if (threatKill.tail.tile.isCity && _player(threatKill.tail.tile) >= 0) return false;
    return moveHalf;
  };

  BotCombatOps.find_key_enemy_vision_tiles = function (bot) {
    var map = _map(bot);
    var keyTiles = new Set();
    var genPlayer = map.players[_player(bot.general)];
    var distFactor = 2;
    var priorityDist = Math.floor(
      EK.BotPathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation) / distFactor);
    if (bot.targetPlayerExpectedGeneralLocation.isGeneral) {
      distFactor = 3;
      priorityDist = Math.floor(
        EK.BotPathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation) / distFactor) + 1;
    }

    for (var ai = 0; ai < bot.general.adjacents.length; ai++) {
      var adj = bot.general.adjacents[ai];
      if (map.is_tile_enemy(adj)) keyTiles.add(adj);
    }

    var cities = (genPlayer && genPlayer.cities) || [];
    for (var ci = 0; ci < cities.length; ci++) {
      var city = cities[ci];
      if (map.turn - city.turn_captured > 20) {
        for (var ca = 0; ca < city.adjacents.length; ca++) {
          if (map.is_tile_enemy(city.adjacents[ca])) keyTiles.add(city.adjacents[ca]);
        }
      }
    }

    // map.pathable_tiles 是 Set：原版 set 的迭代序在这里不影响结果（只做过滤），
    // 但为了与 Python 的 hash=tile_index 序一致，仍然按 tile_index 升序走。
    var pathable = Array.from(map.pathable_tiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var ti = 0; ti < pathable.length; ti++) {
      var tile = pathable[ti];
      if (map.is_tile_enemy(tile) && EK.BotPathingUtils.distance_from_general(bot, tile) < priorityDist) {
        keyTiles.add(tile);
      }
    }

    var cityAdjCount = 0;
    var cityAnalyzer = _alias(bot, ['cityAnalyzer', 'city_analyzer']);
    if (cityAnalyzer && typeof cityAnalyzer.get_sorted_neutral_scores === 'function') {
      var scored = cityAnalyzer.get_sorted_neutral_scores();
      for (var si = 0; si < scored.length; si++) {
        var entry = scored[si];
        var entryCity = entry[0] !== undefined ? entry[0] : entry.city;
        var score = entry[1] !== undefined ? entry[1] : entry.score;
        if (score.general_distances_ratio < 0.9) {
          for (var cj = 0; cj < entryCity.adjacents.length; cj++) {
            if (map.is_tile_enemy(entryCity.adjacents[cj])) {
              cityAdjCount += 1;
              keyTiles.add(entryCity.adjacents[cj]);
            }
          }
        }
        if (cityAdjCount > 5) break;
      }
    }

    return keyTiles;
  };

  BotCombatOps.worth_path_kill = function (bot, pathKill, threatPath, analysis, cutoffDistance) {
    if (cutoffDistance === undefined) cutoffDistance = 5;
    if (_isNone(pathKill.start) || _isNone(pathKill.tail)) return false;

    var lenTillInThreatPath = 0;
    var node = pathKill.start;
    while (!_isNone(node) && !threatPath.tileSet.has(node.tile)) {
      lenTillInThreatPath += 1;
      node = node.next;
    }

    var shortEnoughPath = lenTillInThreatPath < Math.max(3, threatPath.length - 1);
    if (!shortEnoughPath) return false;

    var minSourceArmy = 8;
    var threatArmy = threatPath.start.tile.army;
    var tracker = _tracker(bot);
    if (tracker && _has(tracker.armies, threatPath.start.tile)) {
      threatArmy = _get(tracker.armies, threatPath.start.tile).value;
    }
    var threatMoved = Math.abs(threatPath.start.tile.delta.armyDelta) >= 2;
    if (threatArmy < minSourceArmy && !threatMoved) return false;

    if (!analysis) {
      analysis = EK.ArmyAnalyzer.build_from_path(_map(bot), threatPath);
    }

    var lastTile = pathKill.tail.tile;
    if (!_isNone(pathKill.start.next.next)) {
      lastTile = pathKill.start.next.next.tile;
    }
    var iGeneral = bot.board_analysis.intergeneral_analysis;
    var startDist = _mat(iGeneral.bMap, pathKill.start.tile);
    var tailDist = _mat(iGeneral.bMap, lastTile);
    var movingTowardsOppo = startDist > tailDist;
    var canGoOtherDirection = true;
    var leaves = bot.best_defense_leaves || [];
    for (var li = 0; li < leaves.length; li++) {
      if (leaves[li].tile === pathKill.start.tile) canGoOtherDirection = false;
    }

    // 原版：pathKill.start.tile in analysis.pathWayLookupMatrix[threatPath.start.tile].tiles
    //       or (start in pathWayLookupMatrix and lookup[start].distance < lookup[threat.start].distance)
    var lookupStart = _get(analysis.pathWayLookupMatrix, pathKill.start.tile);
    var lookupThreat = _get(analysis.pathWayLookupMatrix, threatPath.start.tile);
    var onShortestPathwayAlready =
      (!_isNone(lookupThreat) && lookupThreat.tiles && lookupThreat.tiles.has(pathKill.start.tile)) ||
      (!_isNone(lookupStart) && !_isNone(lookupThreat) && lookupStart.distance < lookupThreat.distance);

    var enTilesInPath = EK.search.where(pathKill.tileList, function (t) {
      return _map(bot).is_tile_enemy(t);
    });

    var threatNegs = new Set(pathKill.tileSet);
    threatNegs.add(threatPath.tail.tile);
    threatNegs.delete(threatPath.start.tile);
    var killOverlap = pathKill.calculate_value(_player(bot.general), _teamIds(_map(bot)), threatPath.tileSet) -
      threatPath.calculate_value(_player(threatPath.start.tile), _teamIds(_map(bot)), threatNegs);

    var turnsLeftInCycle = _turnsLeftInCycle(bot);
    var turnsLeftInCycleCutoffThresh = Math.floor(turnsLeftInCycle / 2) - 1;
    if (pathKill.length - enTilesInPath.length > turnsLeftInCycleCutoffThresh &&
        canGoOtherDirection && !movingTowardsOppo) {
      return false;
    }

    return true;
  };

  BotCombatOps.kill_army = function (bot, army, allowGeneral, allowWorthPathKillCheck) {
    if (allowGeneral === undefined) allowGeneral = false;
    if (allowWorthPathKillCheck === undefined) allowWorthPathKillCheck = true;
    var map = _map(bot);
    var tracker = _tracker(bot);

    if (!army.expectedPaths || army.expectedPaths.length === 0) {
      army.expectedPaths = EK.ArmyTracker.get_army_expected_path(
        map, army, bot.general, tracker ? tracker.player_targets : null);
    }

    for (var i = 0; i < army.expectedPaths.length; i++) {
      var path = army.expectedPaths[i];
      if (path.start.tile !== army.tile) continue;
      if (!path) {
        if (bot.targetingArmy === army) bot.targetingArmy = null;
        return null;
      }

      var killPath = BotCombatOps.kill_enemy_path(bot, path, allowGeneral);

      if (!_isNone(killPath)) {
        if (!allowWorthPathKillCheck) return killPath;
        var analyzer = _perfEvent(bot, 'build army analyzer for army kill', function () {
          return new EK.ArmyAnalyzer(map, bot.general, army.tile);
        });
        var worthPathKill = BotCombatOps.worth_path_kill(bot, killPath, path, analyzer);
        if (worthPathKill) return killPath;
        if (bot.targetingArmy === army) bot.targetingArmy = null;
      } else {
        if (bot.targetingArmy === army) bot.targetingArmy = null;
      }
    }

    return null;
  };

  BotCombatOps.kill_enemy_path = function (bot, threatPath, allowGeneral) {
    if (allowGeneral === undefined) allowGeneral = false;
    return BotCombatOps.kill_enemy_paths(bot, [threatPath], allowGeneral);
  };

  BotCombatOps.kill_enemy_paths = function (bot, threatPaths, allowGeneral) {
    if (allowGeneral === undefined) allowGeneral = false;
    var map = _map(bot);
    var tracker = _tracker(bot);
    var threats = [];
    var allThreatsLow = true;
    var negativeTiles = new Set();
    var threatPath = null;

    _perfEvent(bot, 'Kill Enemy Path ArmyAnalyzer', function () {
      for (var i = 0; i < threatPaths.length; i++) {
        threatPath = threatPaths[i];
        var armyAnalysis = EK.ArmyAnalyzer.build_from_path(map, threatPath);
        var threat = _threatObj(threatPath.length, threatPath.value, threatPath, EK.ThreatType.Vision, null, armyAnalysis);
        threats.push(threat);
        // 原版在这里就地改写 threatPath.value（Path 的可变字段），随后用来判 allThreatsLow。
        threatPath.value = threatPath.calculate_value(_player(_armyAt(bot, threatPath.start.tile).tile || threatPath.start.tile),
          _teamIds(map), negativeTiles);
        if (threatPath.value > 0) allThreatsLow = false;
      }
    });

    if (allThreatsLow && threatPath) {
      var lowKill = EK.search.dest_breadth_first_target(map, [threatPath.start.tile], {
        maxDepth: 6,
        negativeTiles: negativeTiles,
        targetArmy: -1,
        additionalIncrement: -2
      });
      if (!_isNone(lowKill)) return lowKill;
    }

    if (!allowGeneral) negativeTiles.add(bot.general);

    for (var ti = 0; ti < threats.length; ti++) {
      var threat2 = threats[ti];
      threatPath = threat2.path;
      var shorterThreatPath = threatPath.get_subsegment(threatPath.length - 2);
      var threatPathSet = new Set(shorterThreatPath.tileSet);
      threatPathSet.delete(threatPath.start.tile);

      var threatTile = threatPath.start.tile;
      var threatPlayer = _player(threatTile);
      if (tracker && _has(tracker.armies, threatTile)) {
        threatPlayer = _get(tracker.armies, threatTile).player;
      }
      threatPath.calculate_value(threatPlayer, _teamIds(map));
      var threatValue = Math.max(threatTile.army, threatPath.value);
      if (_player(threatTile) !== threatPlayer) {
        threatValue = _get(tracker.armies, threatTile).value;
      }
      if (threatValue <= 0) {
        threatValue = threatTile.army;
        if (_player(threatTile) !== threatPlayer) {
          threatValue = _get(tracker.armies, threatTile).value;
        }
      }

      if (threat2.turns > 0) {
        var directKillThresh = Math.max(4, threat2.turns > 0 ? Math.floor(2 * threatValue / threat2.turns) : 0);
        directKillThresh = Math.min(threatValue, directKillThresh);
        var nextTile = threatPath.start.next.tile;
        for (var mi = 0; mi < nextTile.movable.length; mi++) {
          var adj = nextTile.movable[mi];
          if (_player(adj) === _player(bot.general) && adj.army >= directKillThresh) {
            var chokeWidth = _get(threat2.armyAnalysis.chokeWidths, nextTile);
            if (adj.isGeneral && chokeWidth !== null && chokeWidth !== undefined && chokeWidth > 1) {
              continue;
            }
            var path0 = _path();
            path0.add_next(adj);
            path0.add_next(nextTile);
            path0.add_next(threatTile);
            return path0;
          }
        }
      }

      var directKillThresh2 = Math.max(4, threat2.turns > 0 ? Math.floor(3 * threatValue / threat2.turns) : 0);
      directKillThresh2 = Math.min(threatValue, directKillThresh2);

      for (var mj = 0; mj < threatTile.movable.length; mj++) {
        var adj2 = threatTile.movable[mj];
        if (_player(adj2) === _player(bot.general) && adj2.army >= directKillThresh2) {
          var path1 = _path();
          path1.add_next(adj2);
          path1.add_next(threatTile);
          return path1;
        }
      }
    }

    var maxThreatValue = 0;
    for (var hi = 0; hi < threats.length; hi++) {
      maxThreatValue = Math.max(maxThreatValue, threats[hi].threatValue);
    }
    var threatCutoff = Math.max(1, maxThreatValue - 10);

    // BotDefense.get_gather_to_threat_paths 在 JS 侧被故意留空（见 defense.js 头注释第 2 条）：
    // 它必须有 gather-approximate 搜索才能给出 (move, gatherVal, turns, nodes)。
    // 缺它时原版的返回值路径同样是 None，所以这里直接返回 None。
    return null;
  };

  BotCombatOps.kill_threat = function (bot, threat, allowGeneral) {
    if (allowGeneral === undefined) allowGeneral = false;
    var sub = threat.path.get_subsegment(Math.floor(threat.path.length / 2));
    return BotCombatOps.kill_enemy_path(bot, sub, allowGeneral);
  };

  /* ---------------- 局部计数 ---------------- */

  BotCombatOps.sum_enemy_army_near_tile = function (bot, startTile, distance) {
    if (distance === undefined) distance = 2;
    var map = _map(bot);
    var enemyNear = _counter(0);

    _bfs(map, [startTile], distance, function (tile) {
      if (!(tile.isNeutral || map.is_tile_friendly(tile))) {
        enemyNear.add(tile.army - 1);
      }
      return tile.isCity && tile.isNeutral && tile !== startTile;
    }, { noLog: true, bypassDefaultSkip: true });

    var value = enemyNear.value;
    if (map.is_tile_enemy(startTile)) {
      value = value - (startTile.army - 1);
    }
    return value;
  };

  BotCombatOps.sum_player_army_near_tile = function (bot, tile, distance, player) {
    if (distance === undefined) distance = 2;
    if (player === undefined) player = null;
    var armyNear = BotCombatOps.sum_player_standing_army_near_or_on_tiles(bot, [tile], distance, player);
    if (_player(tile) === player) {
      armyNear = armyNear - (tile.army - 1);
    }
    return armyNear;
  };

  BotCombatOps.sum_friendly_army_near_or_on_tiles = function (bot, tiles, distance, player) {
    if (distance === undefined) distance = 2;
    if (player === undefined) player = null;
    var map = _map(bot);
    if (_isNone(player)) player = map.player_index;
    var armyNear = _counter(0);

    _bfs(map, tiles, distance, function (tile) {
      if (map.is_tile_on_team_with(tile, player)) {
        armyNear.add(tile.army - 1);
      }
    });

    return armyNear.value;
  };

  BotCombatOps.sum_standings_near = BotCombatOps.sum_friendly_army_near_or_on_tiles;

  BotCombatOps.sum_player_standing_army_near_or_on_tiles = function (bot, tiles, distance, player) {
    if (distance === undefined) distance = 2;
    if (player === undefined) player = null;
    var map = _map(bot);
    if (_isNone(player)) player = map.player_index;
    var armyNear = _counter(0);

    _distBfsNoNeutCities(map, tiles, distance, function (tile) {
      if (_player(tile) !== player) {
        armyNear.add(tile.army - 1);
      }
    });

    return armyNear.value;
  };

  BotCombatOps.sum_friendly_army_near_tile = function (bot, tile, distance, player) {
    if (distance === undefined) distance = 2;
    if (player === undefined) player = null;
    var armyNear = BotCombatOps.sum_friendly_army_near_or_on_tiles(bot, [tile], distance, player);
    if (_map(bot).is_tile_on_team_with(tile, player)) {
      armyNear = armyNear - (tile.army - 1);
    }
    return armyNear;
  };

  BotCombatOps.count_enemy_territory_near_tile = function (bot, startTile, distance) {
    if (distance === undefined) distance = 2;
    var map = _map(bot);
    var terrs = _territories(bot);
    var enemyNear = _counter(0);

    _bfs(map, [startTile], distance, function (tile) {
      // 原版：`tile.isNeutral and (tile.visible or territories.territoryMap[tile] != targetPlayer)`
      var territoryPlayer = terrs && terrs.territoryMap ? terrs.territoryMap.get(tile) : undefined;
      if (territoryPlayer === undefined) territoryPlayer = -1;
      var tileIsNeutAndNotEnemyTerritory = tile.isNeutral && (tile.visible || territoryPlayer !== bot.targetPlayer);
      if (!tileIsNeutAndNotEnemyTerritory && map.is_tile_enemy(tile)) {
        enemyNear.add(1);
      }
      return tile.isObstacle && tile !== startTile;
    }, { noLog: true, bypassDefaultSkip: true });

    return enemyNear.value;
  };

  BotCombatOps.count_enemy_tiles_near_tile = function (bot, startTile, distance) {
    if (distance === undefined) distance = 2;
    var map = _map(bot);
    var enemyNear = _counter(0);

    _bfs(map, [startTile], distance, function (tile) {
      if (!tile.isNeutral && !map.is_tile_friendly(tile)) {
        enemyNear.add(1);
      }
      return tile.isObstacle && tile !== startTile;
    });

    return enemyNear.value;
  };

  /* ---------------- 攻防时机 ---------------- */

  BotCombatOps.get_approximate_attack_defense_sweet_spot = function (bot, tile, negativeTiles, opts) {
    opts = opts || {};
    var cycleBase = opts.cycleBase === undefined ? 10 : opts.cycleBase;
    var cycleInterval = opts.cycleInterval === undefined ? 5 : opts.cycleInterval;
    var minTurns = opts.minTurns === undefined ? 0 : opts.minTurns;
    var maxTurns = opts.maxTurns === undefined ? 35 : opts.maxTurns;
    var attackingPlayer = opts.attackingPlayer === undefined ? -1 : opts.attackingPlayer;
    var defendingPlayer = opts.defendingPlayer === undefined ? -1 : opts.defendingPlayer;
    var returnDiffThresh = opts.returnDiffThresh === undefined ? 1000 : opts.returnDiffThresh;
    var noLog = !!opts.noLog;

    var map = _map(bot);
    if (attackingPlayer === -1) attackingPlayer = _player(bot.general);
    if (defendingPlayer === -1) defendingPlayer = _player(tile);

    var wc = _winCondition(bot);
    if (!wc || typeof wc.get_approximate_attack_against !== 'function') {
      // win_condition_analyzer 未移植：原版没有它就没有「这回合能压多少兵」的估计。
      // 这里返回 0 兵、0 回合，调用方按原版 curDiff 恒为 -1000 的首轮结果处理。
      return [cycleBase - (map.turn % cycleBase), 0, 0];
    }

    var currentCycle = map.turn % cycleBase;
    var left = cycleBase - currentCycle;
    var curLeft = left;
    if (curLeft < minTurns) curLeft += cycleInterval;

    var bestDiff = -1000;
    var curDiff = -1000;
    var theirDef = 0;
    var ourAttack = 0;

    var bestAttack = 0;
    var bestDef = 0;
    var bestTurns = curLeft;

    while (curLeft <= maxTurns && curDiff < returnDiffThresh) {
      ourAttack = wc.get_approximate_attack_against([tile], curLeft, attackingPlayer, 0.005, {
        forceFogRisk: false,
        negativeTiles: negativeTiles,
        noLog: true
      });

      if (ourAttack > 0) {
        theirDef = wc.get_approximate_attack_against([tile], curLeft, defendingPlayer, 0.005, {
          forceFogRisk: false,
          negativeTiles: null,
          noLog: true
        });
        curDiff = ourAttack - theirDef;
      }

      if (curDiff <= bestDiff - 15 && ourAttack > 0 && bestAttack > 0) break;

      if (curDiff > bestDiff) {
        bestAttack = ourAttack;
        bestDef = theirDef;
        bestTurns = curLeft;
        bestDiff = curDiff;
      }

      curLeft += cycleInterval;
    }

    return [bestTurns, bestAttack, bestDef];
  };

  BotCombatOps.check_should_be_all_in_losing = function (bot) {
    var map = _map(bot);
    var general = bot.general;
    if (_isNone(general)) {
      bot.is_all_in_losing = false;
      return false;
    }

    if (bot.targetPlayer === -1) {
      bot.is_all_in_losing = false;
      return false;
    }

    if (!EK.BotStateQueries.is_all_in(bot) && bot.force_far_gathers) {
      return false;
    }

    var customRatioOffset = 0.0;
    if (bot.is_weird_custom) customRatioOffset += 0.03;
    if (map.is_walled_city_game) customRatioOffset += 0.07;
    if (map.is_low_cost_city_game) customRatioOffset += 0.1;
    var customRatioMult = 1.0 + customRatioOffset;

    var frStats = map.get_team_stats(_player(general));
    var enStats = map.get_team_stats(bot.targetPlayer);
    var turnsLeft = _turnsLeftInCycle(bot);
    var offset = 10;
    if (bot.is_weird_custom) offset = 25;
    if (map.is_walled_city_game) offset += 30;
    if (map.is_low_cost_city_game) offset += 40;

    if (bot.is_all_in_losing) offset = -6;

    var losingEnoughForCounter = enStats.tileCount + 35 * enStats.cityCount >
      frStats.tileCount * 1.05 * customRatioMult + (35 * frStats.cityCount) * customRatioMult + offset;
    if (bot.all_in_losing_counter === 0 && turnsLeft >= 30) {
      offset = Math.min(Math.floor(turnsLeft / 2), 13);
      losingEnoughForCounter = enStats.tileCount + 35 * enStats.cityCount >
        frStats.tileCount * 1.08 * customRatioMult + 35 * (frStats.cityCount + 1) * customRatioMult + offset;
    }

    if (bot.is_all_in_losing) {
      losingEnoughForCounter = enStats.tileCount + 35 * enStats.cityCount >
        frStats.tileCount * 1.01 * customRatioMult + (35 * frStats.cityCount) * customRatioMult + offset;
    }

    var allInLosingCounterThreshold = Math.floor(frStats.tileCount / 5) + 15;
    allInLosingCounterThreshold = Math.max(50, allInLosingCounterThreshold);

    if (_projectedLossAllIn(bot)) {
      bot.is_all_in_losing = true;
      bot.all_in_losing_counter = Math.max(bot.all_in_losing_counter, allInLosingCounterThreshold + 1);
      return true;
    }

    bot.is_all_in_losing = false;

    var afkPlayers = EK.BotTargeting && typeof EK.BotTargeting.get_afk_players === 'function'
      ? EK.BotTargeting.get_afk_players(bot)
      : [];
    if (map.remainingPlayers - afkPlayers.length <= 2 || map.is_2v2) {
      var should2v2PartnerDeadAllIn = (map.is_2v2 && _isNone(bot.teammate_general) && map.remainingPlayers > 2);
      var cityAnalyzer = _alias(bot, ['cityAnalyzer', 'city_analyzer']);
      var enJustContested = cityAnalyzer ? cityAnalyzer.enemy_contested_cities.size : 0;
      if (should2v2PartnerDeadAllIn) {
        bot.is_all_in_losing = true;
      }

      if (map.turn > 250 &&
          enStats.tileCount + 20 * (enStats.cityCount - 1 - enJustContested) >
            frStats.tileCount * 1.3 * customRatioMult + 5 + 20 * (frStats.cityCount + 2) * customRatioMult &&
          enStats.standingArmy > frStats.standingArmy * 1.25 * customRatioMult + 5) {
        bot.is_all_in_losing = true;
        bot.all_in_losing_counter = 200;
      } else if (map.turn > 150 &&
          enStats.tileCount + 15 * enStats.cityCount >
            frStats.tileCount * 1.4 * customRatioMult + 5 + 15 * (frStats.cityCount + 2) * customRatioMult &&
          enStats.standingArmy > frStats.standingArmy * 1.25 * customRatioMult + 5) {
        bot.all_in_losing_counter += 3;
      } else if (should2v2PartnerDeadAllIn ||
          (!bot.is_all_in_army_advantage && map.turn > 50 && losingEnoughForCounter)) {
        bot.all_in_losing_counter += 1;
      } else {
        bot.all_in_losing_counter = 0;
      }
      if (bot.all_in_losing_counter > allInLosingCounterThreshold) {
        bot.is_all_in_losing = true;
      }
      if (enStats.tileCount + 35 * enStats.cityCount > frStats.tileCount * 1.5 * customRatioMult + 5 + 35 * frStats.cityCount &&
          enStats.score > frStats.score * 1.6 * customRatioMult + 5) {
        bot.giving_up_counter += 1;
        // 原版这里会发 gg、sleep(1)、调用 surrender_func。JS 侧没有通信/投降通道，
        // 只保留计数器语义：send_all_chat_communication / surrender_func 调用点直接跳过。
        if (typeof bot.surrender_func === 'function') {
          bot.surrender_func();
          if (map) {
            map.result = false;
            map.complete = true;
          }
        }
      } else {
        bot.giving_up_counter = 0;
      }
    }

    if (bot.is_all_in_losing) {
      bot.expansion_plan = null;
      bot.city_expand_plan = null;
      bot.enemy_expansion_plan = null;
    }

    bot._minAllowableArmy = 1;
    return !!bot.is_all_in_losing;
  };

  BotCombatOps.worth_attacking_target = function (bot) {
    var map = _map(bot);
    var timingFactor = 1.0;
    if (map.turn < 50) return false;

    var knowsWhereEnemyGeneralIs = bot.targetPlayer !== -1 && !_isNone(map.generals[bot.targetPlayer]);

    if (bot.targetPlayer === -1) {
      return map.remainingPlayers === 2;
    }

    var frStats = map.get_team_stats(_player(bot.general));
    var enStats = map.get_team_stats(bot.targetPlayer);

    var wPStanding = frStats.standingArmy * 0.9;
    var oppStanding = enStats.standingArmy;
    var wPIncome = frStats.tileCount + frStats.cityCount * 30;
    var wOppIncome = enStats.tileCount * 1.2 + enStats.cityCount * 35 + 5;
    if (map.turn >= 100 && wPStanding < oppStanding && wPIncome > wOppIncome) {
      return false;
    }

    if (_isNone(bot.target_player_gather_path)) return false;
    var path = bot.target_player_gather_path;
    var value = EK.BotStateQueries.get_player_army_amount_on_path(bot, path, map.player_index, 0, path.length);

    var subsegment = EK.BotPathingUtils.get_value_per_turn_subsegment(bot, path);
    var subsegmentTargets = subsegment.tileSet;

    var targetsLen = (bot.target_player_gather_targets && bot.target_player_gather_targets.length) || 0;
    var lengthRatio = targetsLen / Math.max(1, subsegmentTargets.size);

    var sqrtVal = 0;
    if (value > 0) {
      sqrtVal = Math.pow(value, 0.5);
    }
    if (frStats.tileCount < 60) {
      sqrtVal = value / 2.0;
    }
    sqrtVal = Math.min(20, sqrtVal);

    var dist = Math.floor(subsegmentTargets.size + sqrtVal);
    var factorTurns = 50;
    if (dist > 25 || frStats.tileCount > 110) factorTurns = 100;
    var turnOffset = map.turn + dist;
    var factorScale = turnOffset % factorTurns;
    if (factorScale < factorTurns / 2) {
      timingFactor = _scale(factorScale, 0, factorTurns / 2, 0, 0.40);
    } else {
      timingFactor = _scale(factorScale, factorTurns / 2, factorTurns, 0.30, 0);
    }

    // 原版：上一回合的 timingFactor 如果更小，就沿用它，并把更大的那个存回去。
    if (bot.lastTimingFactor !== -1 && bot.lastTimingFactor < timingFactor) {
      var factor = bot.lastTimingFactor;
      bot.lastTimingFactor = timingFactor;
      timingFactor = factor;
    }
    bot.lastTimingTurn = map.turn;

    if (frStats.tileCount > 200) timingFactor = 0.1;

    var alreadyAttacking = false;
    if (map.turn - 3 < bot.lastTargetAttackTurn) {
      timingFactor *= 0.3;
      alreadyAttacking = true;
    }

    if (frStats.standingArmy < 5 && timingFactor > 0.1) return false;

    var playerEffectiveStandingArmy = frStats.standingArmy - 9 * (frStats.cityCount - 1);
    if (path.length < 2) return false;

    var targetPlayerArmyThreshold = map.players[bot.targetPlayer].standingArmy + dist / 2;
    if (frStats.standingArmy < 70) {
      timingFactor *= 2;
      timingFactor = timingFactor * timingFactor;
      if (knowsWhereEnemyGeneralIs) timingFactor += 0.05;
      var rawNeeded = playerEffectiveStandingArmy * 0.62 + playerEffectiveStandingArmy * timingFactor;
      var rawNeededScaled = rawNeeded * lengthRatio;
      var neededVal = Math.min(targetPlayerArmyThreshold, rawNeededScaled);
      if (alreadyAttacking) neededVal *= 0.75;
      return value > neededVal;
    }

    if (knowsWhereEnemyGeneralIs) {
      timingFactor *= 1.5;
      timingFactor += 0.03;
    }
    var expBase = playerEffectiveStandingArmy * 0.15;
    var exp = 0.68 + timingFactor;
    var expValue = Math.pow(playerEffectiveStandingArmy, exp);
    var rawNeeded2 = expBase + expValue;
    var rawNeededScaled2 = rawNeeded2 * lengthRatio;
    var neededVal2 = Math.min(targetPlayerArmyThreshold, rawNeededScaled2);
    if (alreadyAttacking) neededVal2 *= 0.75;
    return value >= neededVal2;
  };

  BotCombatOps.determine_should_winning_all_in = function (bot) {
    var map = _map(bot);
    if (bot.targetPlayer < 0) return false;

    var targetPlayer = map.players[bot.targetPlayer];
    if (!targetPlayer.tiles || targetPlayer.tiles.length === 0) return false;
    var thisPlayer = map.players[_player(bot.general)];

    var ourArmy = thisPlayer.standingArmy;
    var oppArmy = targetPlayer.standingArmy;

    for (var i = 0; i < map.players.length; i++) {
      var player = map.players[i];
      if (player.index === bot.targetPlayer || player.index === _player(bot.general)) continue;

      if (isPlayerOnTeamWith(map, bot.targetPlayer, player.index)) {
        oppArmy += player.standingArmy;
      } else if (isPlayerOnTeamWith(map, _player(bot.general), player.index)) {
        ourArmy += player.standingArmy;
      }
    }

    if (ourArmy < 100) return false;

    var pathLen = bot.shortest_path_to_target_player ? bot.shortest_path_to_target_player.length : 0;
    var factoredArmyThreshold = oppArmy * 2 + pathLen;

    if (bot.is_all_in_army_advantage) {
      factoredArmyThreshold = oppArmy * 1.4 + Math.floor(pathLen / 2);
    }

    return ourArmy > factoredArmyThreshold;
  };

  BotCombatOps.check_for_attack_launch_move = function (bot, outLaunchPlanNegatives) {
    var map = _map(bot);
    if (_isNone(bot.target_player_gather_path) && !bot.flanking) return null;

    if (!map.is_low_cost_city_game && !_isFfaSituation(bot) && bot.player.tileCount < 45) {
      var gatherTargets = bot.target_player_gather_targets || [];
      var unused = 0;
      for (var ui = 0; ui < bot.player.tiles.length; ui++) {
        var t = bot.player.tiles[ui];
        if (t.army > 1 && !_member(gatherTargets, t)) unused += 1;
      }
      if (unused > 0) return null;
    }

    var path = EK.BotPathingUtils.get_value_per_turn_subsegment(bot, bot.target_player_gather_path, 1.0, 0.25);
    var origPathLength = path.length;

    var targetPathLength = Math.floor(path.length * 3 / 9) + 1;
    if (bot.flanking) targetPathLength = Math.floor(targetPathLength / 2) + 1;

    var maxLength = 17;
    if (_cycleTurns(bot) > 50) maxLength = 34;

    targetPathLength = Math.min(maxLength, targetPathLength);
    path = path.get_subsegment(targetPathLength);
    if (path.length === 0) return null;

    var val = path.calculate_value(_player(bot.general), _teamIds(map), null, true);
    var timings = _timings(bot);
    var offsetTurns = timings && _isNum(timings.offsetTurns) ? timings.offsetTurns : 0;
    var timingTurn = (map.turn + offsetTurns) % _cycleTurns(bot);
    var player = map.players[_player(bot.general)];

    var vt = val / path.length + 1;
    var skipped = 0;
    while (path.length > 1 && path.start.tile.army < vt) {
      path.pop_first_move();
      skipped += 1;
    }

    var pathWorth = EK.BotStateQueries.get_player_army_amount_on_path(bot, bot.target_player_gather_path, _player(bot.general));

    var launchTiming = timings && _isNum(timings.launchTiming) ? timings.launchTiming : 0;
    var inLaunchTiming = timings && typeof timings.in_launch_timing === 'function'
      ? timings.in_launch_timing(map.turn)
      : true;

    if (map.turn >= 50 && inLaunchTiming && (bot.targetPlayer !== -1 || map.remainingPlayers <= 2)) {
      var inAttackWindow = timingTurn < launchTiming + 4;
      var minArmy = Math.min(Math.pow(player.standingArmy, 0.9), Math.pow(player.standingArmy, 0.72) * 1.7);
      if (bot.flanking && pathWorth > 0) minArmy = 0;

      if (!_isNone(path) && path.length > 0 && pathWorth > minArmy && inAttackWindow &&
          _player(path.start.tile) === _player(bot.general)) {
        // 原版这里是「发起总攻」的 return move，但整段被注释掉了（2082 行 'NO LAUNCH, let flow expand cook'）。
        // 也就是说原版当前行为就是不动手，这里照抄：什么都不返回。
      }
    }

    return null;
  };

  // 原版 2136-2138 行就是空实现（只声明了 launchPoint 后直接 return None）。
  // 他的作者把 flank all-in 的算法留空了，这里照抄空壳，别补。
  BotCombatOps.try_find_flank_all_in = function (bot, hitGeneralAtTurn) {
    var launchPoint = null;
    return null;
  };

  BotCombatOps.try_get_cyclic_all_in_move = function (bot, defenseCriticalTileSet) {
    var map = _map(bot);
    var ot = _ot(bot);
    var winningEc = ot ? ot.winning_on_economy(1.15) : false;
    var winningTile = ot ? ot.winning_on_tiles(1.1) : false;
    var winningArmy = ot ? ot.winning_on_army(1.45) : false;
    var staySafe = true;
    var timings = _timings(bot);
    var aggressive = true;
    if (timings && typeof timings.is_player_aggressive === 'function') {
      aggressive = timings.is_player_aggressive(bot.targetPlayer, 75);
    } else if (EK.BotTimings && typeof EK.BotTimings.is_player_aggressive === 'function') {
      aggressive = EK.BotTimings.is_player_aggressive(bot, bot.targetPlayer, 75);
    }
    if (_isFfaSituation(bot) && !aggressive) {
      staySafe = false;
    }

    var reason = '';
    if (bot.is_all_in_losing) {
      reason = 'lose ';
      staySafe = false;
    }

    if (bot.is_winning_gather_cyclic ||
        (winningEc && winningTile && winningArmy && bot.targetPlayer !== -1) ||
        bot.is_all_in_losing) {
      var remainingTurns = Math.max(5, _turnsLeftInCycle(bot) - 5);
      var negatives = new Set(defenseCriticalTileSet);
      var gathered = bot.cities_gathered_this_cycle;
      if (gathered) gathered.forEach(function (c) {
        negatives.add(c);
      });

      if (!bot.is_all_in_losing) {
        reason = 'win ';
        if (_turnsLeftInCycle(bot) > 30) bot.is_winning_gather_cyclic = true;
        // BotTargeting.get_contested_targets 未移植 → 用城市争夺集兜底（原版这两个集合
        // 正是 get_contested_targets 的输入来源，缺它只会少几个负权格，不会给出错误方向）。
        var cityAnalyzer0 = _alias(bot, ['cityAnalyzer', 'city_analyzer']);
        if (cityAnalyzer0) {
          cityAnalyzer0.enemy_contested_cities.forEach(function (c) {
            negatives.add(c);
          });
          cityAnalyzer0.owned_contested_cities.forEach(function (c) {
            negatives.add(c);
          });
        }

        var terrs = _territories(bot);
        var myCities = (bot.player && bot.player.cities) || [];
        for (var ci = 0; ci < myCities.length; ci++) {
          if (!(terrs && terrs.is_tile_in_friendly_territory(myCities[ci]))) negatives.add(myCities[ci]);
        }
      }

      var enAttackPath = null;
      if (remainingTurns > 0) {
        var targets = _targetPlayerPossibleGeneralLocations(bot, bot.targetPlayer, 0.6).slice(0, 4);

        if (!bot.is_all_in_losing) {
          var targetCities = (bot.targetPlayerObj && bot.targetPlayerObj.cities) || [];
          for (var cj = 0; cj < targetCities.length; cj++) targets.push(targetCities[cj]);
          enAttackPath = bot.enemy_attack_path;
          if (!_isNone(enAttackPath)) {
            var enTiles = [];
            var tl = enAttackPath.tileList;
            for (var ti = 0; ti < tl.length; ti++) {
              if (map.is_tile_enemy(tl[ti]) || !tl[ti].visible) enTiles.push(tl[ti]);
            }

            var shortestLen = bot.shortest_path_to_target_player ? bot.shortest_path_to_target_player.length : 0;
            if (enTiles.length > 5 && enTiles.length > Math.floor(shortestLen / 2)) {
              reason = reason + 'EnAttk ';
              for (var ei = 0; ei < enTiles.length; ei++) {
                if (EK.BotPathingUtils.distance_from_general(bot, enTiles[ei]) < Math.floor(shortestLen / 2)) {
                  targets.push(enTiles[ei]);
                }
              }
              remainingTurns = remainingTurns % 25;
            } else {
              enAttackPath = null;
            }
          }
        }

        // Gather.gather_approximate_turns_to_tiles 未移植 → 无法生成 gcp（见 get_all_in_move 同注释）。
        // 原版 gcp is None 时同样 return None，所以这里保持 None。
        var gcp = null;
        if (!_isNone(gcp)) {
          return gcp.get_first_move();
        }
      }
    }

    return null;
  };

  EK.BotCombatOps = BotCombatOps;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

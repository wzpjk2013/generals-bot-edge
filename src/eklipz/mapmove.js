/*
 * 迷雾军力推断 —— 逐行移植自 generals-bot/base/client/map.py。
 *
 * 这里是 Human.exe 真正「看见黑区后面的兵」的地方。每回合的流程是：
 *   1. detect_movement_and_populate_unexplained_diffs 先把所有可见格上
 *      unexplainedDelta != 0 的格子收进 map.unexplained_deltas；
 *   2. 先用自己的上一步（map.last_player_index_submitted_move）把这部分 delta
 *      消化掉（_apply_last_player_move），否则自己的兵会被当成敌人的兵；
 *   3. 然后五个 scan 依次配对「源格缺口 → 目标格增益」，配成唯一解就调
 *      set_tile_moved 写死 delta.fromTile/toTile，并把迷雾里的兵数、归属、
 *      甚至城市都补写进 Tile；
 *   4. 剩下没解释掉的 delta 塞进 map.army_emergences，ArmyTracker 全靠它。
 *
 * 顺序绝对不能换：run_positive_delta_movement_scan(allowFogSource=false) 先跑，
 * 是因为「两个可见格之间的移动」最确定，先钉死它，后面的 fog 扫描才不会去
 * 抢已经解释掉的 delta。整套逻辑是增量式的——每一次配对都会改
 * map.unexplained_deltas 和 moved_here_set，后面的扫描看到的就是改过的状态。
 * 一旦某个 scan 的判定条件宽了或严了，误差会沿着 ArmyTracker 一路放大到决策。
 *
 * 原版所有 dict 都用 Tile 当 key；JS 里 map.unexplained_deltas 是原生 Map（key 是
 * Tile 对象），map.army_emergences 用的是 tile_index 当 key 的普通对象——
 * 因为 map.js 里它就是普通对象，而且 Tile 对象在一局里稳定，tile_index 等价。
 *
 * 【调用方约定】决策层在提交移动之后必须写
 *     map.last_player_index_submitted_move = [sourceTile, destTile, moveHalf]
 * （原版 bot_ek0x45.py:512-516 就是在 select_move 里写的；本文件在第二回合读它）。
 * 不写这一项的后果不是崩溃，而是自己的移动会被当成「敌方从迷雾里冒出来的兵」：
 * 源格留着负 unexplainedDelta、目标格留着正 unexplainedDelta，dFrom/dTo 也不会有。
 * 这一项从观测到的 delta 反推是不可靠的（互攻、被打到 0、bonus 回合都会破坏
 * 「送出兵力 = oldArmy-1 或 oldArmy//2」这条关系），所以这里不做猜测。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // map.py:41 —— 原版运行时是 False，这里跟着关掉，只影响日志/断言路径。
  var ENABLE_DEBUG_ASSERTS = false;

  /* ------------------------------------------------------------------ *
   * 小工具：原版这些都在 MapBase 上，JS 侧不改 map.js，所以放这里。
   * ------------------------------------------------------------------ */

  /*
   * Python 的 team_ids_by_player_index 末尾补了一个 -1，专门给 index = -1 用。
   * JS 数组的 [-1] 是 undefined，所以必须自己绕回最后一个元素。
   */
  function teamId(map, p) {
    var arr = map.team_ids_by_player_index;
    var idx = p === null || p === undefined ? -1 : p;
    if (idx < 0) return arr[arr.length - 1];
    return arr[idx];
  }

  function isPlayerOnTeamWith(map, a, b) {
    return teamId(map, a) === teamId(map, b);
  }

  function isPlayerFriendly(map, p) {
    return teamId(map, p) === map.friendly_team;
  }

  function isTileEnemy(map, tile) {
    return teamId(map, tile.player()) !== map.friendly_team && tile.player() >= 0;
  }

  // Python 里 players[-1] 是最后一个玩家（不加保护的写法在 map.py 里真实存在）。
  function playerAt(map, p) {
    if (p === null || p === undefined) return map.players[map.players.length - 1];
    if (p < 0) return map.players[map.players.length - 1];
    return map.players[p];
  }

  function removeFrom(list, item) {
    var at = list.indexOf(item);
    if (at >= 0) list.splice(at, 1);
  }

  function hasArmyMovedGridCell(map, y, x) {
    if (!map.army_moved_grid[y]) map.army_moved_grid[y] = [];
    return !!map.army_moved_grid[y][x];
  }

  /* ------------------------------------------------------------------ *
   * 状态记账（map.py:2979 / 2986）
   * ------------------------------------------------------------------ */

  function _update_unexplained_delta(map, tile, newValue) {
    tile.delta.unexplainedDelta = newValue;
    if (newValue === 0) map.unexplained_deltas.delete(tile);
    else map.unexplained_deltas.set(tile, newValue);
  }

  function _update_moved_here(map, tile, isMovedHere) {
    if (tile.delta.armyMovedHere && !isMovedHere) {
      tile.delta.armyMovedHere = false;
      map.moved_here_set.delete(tile);
    } else if (!tile.delta.armyMovedHere && isMovedHere) {
      tile.delta.armyMovedHere = true;
      map.moved_here_set.add(tile);
    }
  }

  function set_fog_emergence(map, fromTile, armyEmerged, byPlayer) {
    map.army_emergences[fromTile.tile_index] = [armyEmerged, byPlayer];
  }

  /* map.py:2434 */
  function set_fog_moved_from_army_incremented(map, tile, byPlayer, expectedDelta) {
    var army = 1;
    if (expectedDelta !== undefined && expectedDelta !== null) {
      var potentialArmy = tile.delta.oldArmy + expectedDelta;
      if (potentialArmy <= 0) {
        set_fog_emergence(map, tile, 0 - expectedDelta, byPlayer);
        potentialArmy = 1;
      }
      army = potentialArmy;
    }
    tile.delta.oldArmy = army - expectedDelta;
    tile.army = army;
    tile.delta.oldOwner = byPlayer;
    tile.delta.newOwner = byPlayer;
  }

  /* map.py:1723 */
  function _get_expected_delta_amount_from(map, source, dest, moveHalf) {
    var expectedDelta = source.delta.unexplainedDelta;

    if (source.was_visible_last_turn() && source.delta.oldArmy + expectedDelta < 1) {
      // 这个格子的兵根本不够 vacated 这么多，说明源格 delta 不可信，改用目标格 delta
      expectedDelta = dest.delta.unexplainedDelta;
      if (source.delta.oldArmy + expectedDelta < 1) {
        expectedDelta = 1 - source.delta.oldArmy;
      }
    }

    if (!source.visible) {
      if (!source.delta.lostSight) {
        expectedDelta = dest.delta.unexplainedDelta;
      } else {
        expectedDelta = 0 - (source.delta.oldArmy - 1);
        if (moveHalf) expectedDelta = 0 - Math.floor(source.delta.oldArmy / 2);
      }
    }

    return expectedDelta;
  }

  /* map.py:1692 */
  function _get_expected_delta_amount_toward(map, source, dest, moveHalf) {
    var sameOwnerMove = source.delta.oldOwner === dest.delta.oldOwner && source.delta.oldOwner !== -1;
    var attackedFlippedTile = dest.delta.oldOwner !== dest.player() && source.delta.oldOwner !== dest.player() && dest.visible;
    var teamMateMove =
      source.delta.oldOwner !== dest.delta.oldOwner &&
      teamId(map, source.delta.oldOwner) === teamId(map, dest.delta.oldOwner);

    var expectedDelta = _get_expected_delta_amount_from(map, source, dest, moveHalf);

    var bypassNeutFogSource = false;
    if (!source.visible) {
      // 看不见的源格如果现在是 neutral，就默认它本来就是 neutral 而不是被抢了
      var sourceNeut = source.player() === -1;
      bypassNeutFogSource = sourceNeut;
      sameOwnerMove = (sameOwnerMove || (sourceNeut && !source.delta.lostSight)) && dest.delta.oldOwner !== -1;
    } else if (moveHalf) {
      throw new Error('cannot provide moveHalf directive for visible tile ' + source + ', visible tiles exclusively use tile deltas.');
    }
    if (sameOwnerMove || (attackedFlippedTile && !bypassNeutFogSource)) {
      return 0 - expectedDelta;
    }
    if (teamMateMove) {
      if (!dest.isGeneral) {
        if (dest.delta.fromTile !== null && dest.delta.fromTile.delta.oldOwner === dest.player() && source.player() !== dest.player()) {
          // 队友同格互撞，且对方赢了：delta 就是纯粹的 -sourceDelta
          return 0 - expectedDelta;
        }
        return 0 - (2 * dest.delta.oldArmy - expectedDelta);
      }
      return 0 - expectedDelta;
    }

    return expectedDelta;
  }

  /* map.py:2385 */
  function _move_would_violate_known_player_deltas(map, source, dest) {
    var knowSourceOwner = source.was_visible_last_turn() || (map.remainingPlayers === 2 && source.discovered && source.player() >= 0);
    var wouldCapture =
      source.delta.oldArmy > dest.delta.oldArmy - 1 && !isPlayerOnTeamWith(map, source.delta.oldOwner, dest.delta.oldOwner);
    wouldCapture =
      wouldCapture || (isPlayerOnTeamWith(map, source.delta.oldOwner, dest.delta.oldOwner) && source.delta.oldOwner !== dest.delta.oldOwner);

    if (knowSourceOwner) {
      var sourceOwner = playerAt(map, source.delta.oldOwner);
      if (source.delta.gainedSight) sourceOwner = map.players[source.player()];
      var knowDestOwner = dest.was_visible_last_turn() || (map.remainingPlayers === 2 && dest.discovered && dest.delta.oldOwner >= 0);
      if (knowDestOwner) {
        var destOwner = null;
        if (dest.delta.oldOwner >= 0) destOwner = map.players[dest.delta.oldOwner];
        if (sourceOwner === destOwner) {
          if (sourceOwner.unexplainedTileDelta === 1) return true;
        } else if (map.remainingPlayers === 2 && destOwner !== null && destOwner.unexplainedTileDelta === 1) {
          return true;
        } else if (map.remainingPlayers === 2 && sourceOwner.unexplainedTileDelta < 0) {
          if (!(dest.delta.armyMovedHere || dest.delta.unexplainedDelta !== 0)) return true;
        }
        // 最后一支（unexplainedTileDelta == 0 且 wouldCapture）原版只记日志，不允许否决
      }
    }

    return false;
  }

  /* map.py:1588 */
  function _is_partial_army_movement_delta_match(map, source, dest) {
    if (source.delta.imperfectArmyDelta) return dest.delta.unexplainedDelta !== 0;
    if (dest.delta.imperfectArmyDelta) return source.delta.unexplainedDelta !== 0;
    if (_move_would_violate_known_player_deltas(map, source, dest)) return false;

    var deltaToDest = _get_expected_delta_amount_toward(map, source, dest);
    if (deltaToDest === dest.delta.unexplainedDelta) return true;
    if (dest.delta.unexplainedDelta !== 0 && deltaToDest !== 0) return true;
    return false;
  }

  /* map.py:1657 */
  function _is_exact_lost_source_vision_movement_delta_match(map, source, dest) {
    if (!source.delta.lostSight) return false;
    if (_move_would_violate_known_player_deltas(map, source, dest)) return false;

    var deltaToDest = _get_expected_delta_amount_toward(map, source, dest);
    if (deltaToDest === dest.delta.unexplainedDelta) return true;

    deltaToDest = _get_expected_delta_amount_toward(map, source, dest, true);
    if (deltaToDest === dest.delta.unexplainedDelta) return true;

    return false;
  }

  /* map.py:1674 */
  function _is_exact_lost_dest_vision_movement_delta_match(map, source, dest) {
    if (!dest.delta.lostSight) return false;
    if (_move_would_violate_known_player_deltas(map, source, dest)) return false;

    var deltaToDest = _get_expected_delta_amount_toward(map, source, dest);
    if (deltaToDest === dest.delta.unexplainedDelta) return true;

    if (!source.visible) {
      deltaToDest = _get_expected_delta_amount_toward(map, source, dest, true);
      if (deltaToDest === dest.delta.unexplainedDelta) return true;
    }

    return false;
  }

  /* map.py:1608 */
  function _is_exact_army_movement_delta_dest_match(map, source, dest) {
    if (source.delta.imperfectArmyDelta) return _is_exact_lost_source_vision_movement_delta_match(map, source, dest);
    if (dest.delta.imperfectArmyDelta) return _is_exact_lost_dest_vision_movement_delta_match(map, source, dest);
    if (_move_would_violate_known_player_deltas(map, source, dest)) return false;

    var deltaToDest = _get_expected_delta_amount_toward(map, source, dest);
    if (deltaToDest !== dest.delta.unexplainedDelta) {
      if (
        source.delta.unexplainedDelta < 0 &&
        dest.delta.unexplainedDelta > 0 &&
        Math.abs(deltaToDest) === Math.abs(dest.delta.unexplainedDelta) &&
        source.delta.oldOwner !== dest.delta.oldOwner
      ) {
        return true;
      }
      return false;
    }
    return true;
  }

  /* map.py:1629 */
  function _is_exact_army_movement_delta_source_match(map, source, dest) {
    if (source.delta.imperfectArmyDelta) return _is_exact_lost_source_vision_movement_delta_match(map, source, dest);
    if (dest.delta.imperfectArmyDelta) return _is_exact_lost_dest_vision_movement_delta_match(map, source, dest);
    if (_move_would_violate_known_player_deltas(map, source, dest)) return false;
    if (!source.was_visible_last_turn() || !source.visible) return false;

    var deltaFromSource = _get_expected_delta_amount_from(map, source, dest);
    if (deltaFromSource !== source.delta.unexplainedDelta) return false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * set_tile_probably_moved / set_tile_moved（map.py:1402 / 1533）
   * ------------------------------------------------------------------ */

  function set_tile_probably_moved(map, toTile, fromTile, fullFromDiffCovered, fullToDiffCovered, byPlayer) {
    if (fullFromDiffCovered === undefined) fullFromDiffCovered = true;
    if (fullToDiffCovered === undefined) fullToDiffCovered = true;
    if (byPlayer === undefined) byPlayer = -1;

    if (byPlayer === -1) byPlayer = fromTile.delta.oldOwner;

    var isMoveHalf = false;

    if (!map.army_moved_grid[fromTile.y]) map.army_moved_grid[fromTile.y] = [];
    map.army_moved_grid[fromTile.y][fromTile.x] = hasArmyMovedGridCell(map, fromTile.y, fromTile.x) && !fullFromDiffCovered;
    _update_moved_here(map, fromTile, fromTile.delta.armyMovedHere && !fullFromDiffCovered);

    var expectedDelta = _get_expected_delta_amount_toward(map, fromTile, toTile);

    if (!fromTile.visible) {
      if (expectedDelta !== toTile.delta.unexplainedDelta && toTile.visible && fromTile.delta.oldOwner !== map.player_index) {
        var halfDelta = _get_expected_delta_amount_toward(map, fromTile, toTile, true);
        if (Math.abs(toTile.delta.unexplainedDelta - expectedDelta) > Math.abs(toTile.delta.unexplainedDelta - halfDelta)) {
          expectedDelta = halfDelta;
          isMoveHalf = true;
        }
      }

      var fromDelta = expectedDelta;

      fromTile.army += fromDelta;
      if (byPlayer !== fromTile.delta.oldOwner && isPlayerOnTeamWith(map, fromTile.delta.oldOwner, byPlayer) && fromDelta > 0) {
        fromDelta = -fromDelta;
      }
      fromTile.delta.armyDelta = fromDelta;

      var isByPlayerFriendly = isPlayerFriendly(map, byPlayer);

      if (fromTile.player() !== byPlayer && byPlayer >= 0 && !isByPlayerFriendly) {
        if (fromTile.player() >= 0) {
          if (fromTile.isCity) removeFrom(map.players[fromTile.player()].cities, fromTile);
          removeFrom(map.players[fromTile.player()].tiles, fromTile);
        }
        if (!fromTile.isGeneral) fromTile.setPlayer(byPlayer);
        var byPlayerObj = map.players[byPlayer];
        byPlayerObj.tiles.push(fromTile);
        if (fromTile.army > 0 && !isPlayerFriendly(map, fromTile.delta.oldOwner)) {
          var msg =
            'fromTile was neutral/otherPlayer ' +
            fromTile.delta.oldOwner +
            ' with positive army ' +
            fromTile.army +
            ' in the fog. From->To: ' +
            fromTile +
            ' -> ' +
            toTile;
          if (ENABLE_DEBUG_ASSERTS) throw new Error(msg);
          // 迷雾里不可能有「正兵的中立格」，翻符号当作负兵处理，让后续 delta 自洽
          fromTile.army = 0 - fromTile.army;
        }
        if (fromTile.isUndiscoveredObstacle) {
          fromTile.isCity = true;
          fromTile.army = 1;
          fromTile.isMountain = false;
          if (!fromTile.discovered) {
            fromTile.discovered = fullFromDiffCovered;
            fromTile.delta.discovered = fullFromDiffCovered;
          }
          fromTile.isTempFogPrediction = !fullFromDiffCovered;
        }

        if (fromTile.isCity && byPlayerObj.cities.indexOf(fromTile) < 0) byPlayerObj.cities.push(fromTile);
      }
      if (!isByPlayerFriendly) {
        set_fog_moved_from_army_incremented(map, fromTile, byPlayer, expectedDelta);
      }
    }

    if (!map.army_moved_grid[toTile.y]) map.army_moved_grid[toTile.y] = [];
    map.army_moved_grid[toTile.y][toTile.x] = hasArmyMovedGridCell(map, toTile.y, toTile.x) && !fullToDiffCovered;
    _update_moved_here(map, toTile, toTile.delta.armyMovedHere && !fullToDiffCovered);

    if (!toTile.visible) {
      toTile.army = toTile.army + expectedDelta;
      toTile.delta.armyDelta += expectedDelta;
      if (toTile.army < 0) {
        toTile.army = 0 - toTile.army;
        toTile.setPlayer(byPlayer);
        toTile.delta.newOwner = byPlayer;
      }
      if (toTile.isUndiscoveredObstacle) {
        toTile.isCity = true;
        toTile.isTempFogPrediction = !fullFromDiffCovered;
      }
    }

    // 敌方 move-from 优先保留：ArmyTracker 对付敌方来源格比对付自己人难得多
    if (toTile.delta.fromTile === null || toTile.delta.fromTile.delta.oldOwner !== map.player_index) {
      toTile.delta.fromTile = fromTile;
    }

    if (fullFromDiffCovered) {
      if (fromTile.delta.gainedSight) {
        _update_unexplained_delta(map, fromTile, fromTile.delta.unexplainedDelta - toTile.delta.unexplainedDelta);
        set_fog_emergence(map, fromTile, fromTile.delta.unexplainedDelta, fromTile.player());
      } else {
        _update_unexplained_delta(map, fromTile, 0);
      }
    }

    if (fullToDiffCovered) {
      _update_unexplained_delta(map, toTile, 0);
    } else {
      _update_unexplained_delta(map, toTile, toTile.delta.unexplainedDelta - expectedDelta);
      if (toTile.delta.unexplainedDelta === 0) _update_moved_here(map, toTile, false);
    }

    fromTile.delta.toTile = toTile;

    return isMoveHalf;
  }

  function set_tile_moved(map, toTile, fromTile, fullFromDiffCovered, fullToDiffCovered, byPlayer) {
    if (fullFromDiffCovered === undefined) fullFromDiffCovered = true;
    if (fullToDiffCovered === undefined) fullToDiffCovered = true;
    if (byPlayer === undefined) byPlayer = -1;

    if (byPlayer === -1) byPlayer = fromTile.delta.oldOwner;
    if (byPlayer === -1) {
      throw new Error(
        'must supply a player for moves from fog with unknown ownership when setting definitely-moved. fromTile was neutral. fromTile ' +
          fromTile +
          ' -> toTile ' +
          toTile
      );
    }

    var isMoveHalf = set_tile_probably_moved(map, toTile, fromTile, fullFromDiffCovered, fullToDiffCovered, byPlayer);

    if (byPlayer >= 0) {
      var movingPlayer = map.players[byPlayer];

      // 这一步抢了一格：capturer 的 tileDelta 从「未解释」里扣掉，被抢的补上
      if (toTile.delta.oldOwner !== toTile.player() && (toTile.player() === byPlayer || !toTile.visible)) {
        movingPlayer.unexplainedTileDelta -= 1;
        if (toTile.delta.oldOwner !== -1) {
          var attackedPlayer = map.players[toTile.delta.oldOwner];
          if (movingPlayer.team !== attackedPlayer.team) {
            var armyAmt = fromTile.delta.armyDelta;
            armyAmt = Math.max(0 - toTile.delta.oldArmy, armyAmt);
            movingPlayer.knownScoreDelta += armyAmt;
            attackedPlayer.knownScoreDelta += armyAmt;
          }
          attackedPlayer.unexplainedTileDelta += 1;
        }
      }

      movingPlayer.last_move = [fromTile, toTile, isMoveHalf];
    }
  }

  /* map.py:2001 —— 原版里目前没有调用点，照样搬过来保持结构一致 */
  function execute_definite_fog_island_capture(map, tileLost, killedByTile) {
    if (killedByTile.visible) {
      if (tileLost.army + killedByTile.delta.armyDelta < -1 && killedByTile.player() !== -1) {
        var oldArmy = tileLost.army;
        tileLost.setPlayer(killedByTile.player());
        tileLost.delta.newOwner = killedByTile.player();
        tileLost.army = 0 - killedByTile.delta.armyDelta - tileLost.army;
        void oldArmy;
        return 100;
      }
    } else if (tileLost.army - killedByTile.army < -1 && killedByTile.player() !== -1) {
      var oldArmy2 = tileLost.army;
      tileLost.setPlayer(killedByTile.player());
      tileLost.delta.newOwner = killedByTile.player();
      tileLost.army = killedByTile.army - tileLost.army - 1;
      killedByTile.army = 1;
      void oldArmy2;
      return 100;
    }
    return -100;
  }

  /* map.py:1744 —— 用自己上一步的「已知动作」去解释自己的 delta */
  function _apply_last_player_move(map, move) {
    var source = move[0];
    var dest = move[1];
    var move_half = move[2];

    var oldSourceMovedHere = source.delta.armyMovedHere;
    var oldDestMovedHere = dest.delta.armyMovedHere;
    _update_moved_here(map, source, false);
    _update_moved_here(map, dest, false);

    // 这里不能用 _get_expected_delta_*：那些是按观察到的 delta 反推的，
    // 而这一段要算的是「我们本来想做什么」和「观察到的」之间的差额（即第三方干扰）。
    var expectedDestDelta = source.delta.oldArmy - 1;
    if (move_half) expectedDestDelta = Math.floor(source.delta.oldArmy / 2);

    var expectedSourceDelta = 0 - expectedDestDelta;

    if (dest.delta.oldOwner !== map.player_index && !map.teammates.has(dest.delta.oldOwner)) {
      expectedDestDelta = 0 - expectedDestDelta;
    } else if (map.teammates.has(dest.delta.oldOwner) && !dest.isGeneral) {
      expectedDestDelta = 0 - (dest.delta.oldArmy * 2 + expectedDestDelta);
    }

    var sourceWouldHaveCappedDest =
      dest.delta.oldOwner === map.player_index ||
      (map.teammates.has(dest.delta.oldOwner) && !dest.isGeneral) ||
      dest.delta.oldArmy + expectedSourceDelta < 0;

    if (source.delta.unexplainedDelta === 0 && source.visible) {
      if (dest.delta.unexplainedDelta === 0 && dest.visible) {
        // 两头都没有 delta → 这一步被服务器丢了
        map.last_player_index_submitted_move = null;
        _update_moved_here(map, source, oldSourceMovedHere);
        _update_moved_here(map, dest, oldDestMovedHere);
        return null;
      }
    }

    var actualSrcDelta = source.delta.unexplainedDelta;
    if (source.delta.lostSight) actualSrcDelta = -1 - source.delta.oldArmy;

    var actualDestDelta = dest.delta.unexplainedDelta;

    var srcUnexpectedDelta = actualSrcDelta - expectedSourceDelta;
    var sourceDeltaMismatch = srcUnexpectedDelta !== 0;

    var destUnexpectedDelta = actualDestDelta - expectedDestDelta;
    if (dest.delta.oldOwner !== dest.player() && dest.player() !== map.player_index && dest.delta.oldOwner !== map.player_index) {
      // 撞在别人的格子上而且没赢下来
      destUnexpectedDelta = 0 - actualDestDelta - expectedDestDelta;
    }

    var hasDestDeltaMismatch = destUnexpectedDelta !== 0;

    var sourceDefinitelyKilledWithPriority = !source.visible && !dest.visible && sourceWouldHaveCappedDest;

    if (
      sourceDeltaMismatch &&
      destUnexpectedDelta === srcUnexpectedDelta &&
      dest.delta.oldOwner !== map.player_index &&
      !map.teammates.has(dest.delta.oldOwner) &&
      dest.delta.oldOwner !== -1
    ) {
      set_tile_moved(map, source, dest, true, true, dest.delta.oldOwner);
      if (actualDestDelta <= expectedSourceDelta) {
        map.last_player_index_submitted_move = null;
        _update_moved_here(map, source, source.delta.unexplainedDelta !== 0);
        _update_moved_here(map, dest, dest.delta.unexplainedDelta !== 0);
        return null;
      }
    }

    var sourceHasEnPriorityDeltasNearby = false;
    var i;
    for (i = 0; i < source.movable.length; i++) {
      var st = source.movable[i];
      if (st !== dest && (st.delta.unexplainedDelta !== 0 || st.delta.lostSight) && st.delta.oldOwner !== map.player_index) {
        if (player_had_priority_over_other(st.delta.oldOwner, map.player_index, map.turn)) sourceHasEnPriorityDeltasNearby = true;
      }
    }

    var destHasEnDeltasNearby = false;
    for (i = 0; i < dest.movable.length; i++) {
      var dt = dest.movable[i];
      if (dt !== source && ((dt.delta.unexplainedDelta !== 0 && !dt.delta.gainedSight) || !dt.visible)) destHasEnDeltasNearby = true;
    }

    if (!sourceHasEnPriorityDeltasNearby && !destHasEnDeltasNearby) {
      for (i = 0; i < dest.movable.length; i++) {
        var dt2 = dest.movable[i];
        if (dt2 !== source && dt2.delta.gainedSight && dt2.player() !== -1) destHasEnDeltasNearby = true;
      }
    }

    var sourceWasAttackedWithPriority = false;

    if (sourceDeltaMismatch || source.player() !== map.player_index || (hasDestDeltaMismatch && sourceHasEnPriorityDeltasNearby) || sourceDefinitelyKilledWithPriority) {
      if (sourceHasEnPriorityDeltasNearby) {
        sourceWasAttackedWithPriority = true;
        if (source.player() !== map.player_index || !source.visible) {
          var armyMovedToDest = true;
          if (dest.delta.unexplainedDelta !== 0) armyMovedToDest = true;
          else armyMovedToDest = false;

          _update_moved_here(map, source, true);
          _update_moved_here(map, dest, armyMovedToDest);
          map.last_player_index_submitted_move = null;
          return null;
        } else if (actualDestDelta === 0) {
          _update_moved_here(map, source, true);
          map.last_player_index_submitted_move = null;
          return null;
        }
      } else if (source.player() !== map.player_index) {
        if (!source.visible && !dest.visible && dest.delta.oldArmy + expectedDestDelta >= 0) {
          // 没抢下目标格，所以看不见，但兵大概率还是到了
          _update_moved_here(map, source, true);
          _update_moved_here(map, dest, false);
          return [source, dest, move_half];
        } else {
          if (!source.visible) {
            _update_unexplained_delta(map, source, actualSrcDelta);
            if (dest.visible) _update_unexplained_delta(map, source, actualDestDelta - expectedDestDelta);
          } else {
            _update_unexplained_delta(map, source, actualSrcDelta);
            if (dest.visible) _update_unexplained_delta(map, source, srcUnexpectedDelta - actualDestDelta + expectedDestDelta);
          }
          _update_moved_here(map, source, true);
        }
      } else {
        var destArmyInterferedToo = false;
        if (!hasDestDeltaMismatch) {
          // 源格被非优先级攻击打了但没抢走
        } else if (destHasEnDeltasNearby) {
          var armyMadeItToDest = dest.delta.unexplainedDelta;
          srcUnexpectedDelta = expectedDestDelta - armyMadeItToDest;
          // 敌人可以把我们打到 0 而不翻格，这种特殊情形要补 1
          if (source.army === 0) srcUnexpectedDelta -= 1;
        } else {
          destArmyInterferedToo = true;
          _update_moved_here(map, dest, true);
        }

        _update_unexplained_delta(map, source, srcUnexpectedDelta);
        _update_moved_here(map, source, true);
        if (!destArmyInterferedToo) {
          // 源和目的同时被干扰的概率极低，优先认定源格
          _update_unexplained_delta(map, dest, 0);
          map.last_player_index_submitted_move = move;
          return [source, dest, move_half];
        }
      }
    } else {
      _update_unexplained_delta(map, source, 0);
    }

    if (hasDestDeltaMismatch) {
      if (dest.delta.lostSight) {
        if (dest.delta.oldArmy > source.delta.oldArmy - 1 && dest.delta.oldOwner !== map.player_index) {
          _update_moved_here(map, dest, true);
          dest.delta.imperfectArmyDelta = true;
        }
      } else {
        if (destHasEnDeltasNearby) {
          _update_unexplained_delta(map, dest, destUnexpectedDelta);
          _update_moved_here(map, dest, true);
        }

        if (sourceHasEnPriorityDeltasNearby) {
          _update_unexplained_delta(map, source, destUnexpectedDelta);
          if (dest.delta.oldOwner !== map.player_index) _update_unexplained_delta(map, source, 0 - destUnexpectedDelta);
          source.delta.imperfectArmyDelta = destHasEnDeltasNearby;
          _update_moved_here(map, source, true);
        } else if (!destHasEnDeltasNearby) {
          if (destUnexpectedDelta !== 0) _update_moved_here(map, dest, true);
        }
      }
    } else {
      _update_unexplained_delta(map, dest, 0);
    }

    if (actualDestDelta === 0 && dest.delta.unexplainedDelta === 0) {
      map.last_player_index_submitted_move = null;
      return null;
    }

    map.last_player_index_submitted_move = move;
    return [source, dest, move_half];
  }

  /* map.py:1380 */
  function player_had_priority_over_other(player, otherPlayer, turn) {
    return ((turn & 1) === 0) === (player > otherPlayer);
  }

  /* map.py:3314 */
  function evaluate_island_fog_move(tile, candidateTile) {
    if (tile.visible || candidateTile.visible) {
      throw new Error("wtf, can't call this for visible tiles my guy. tile " + tile + ' candidateTile ' + candidateTile);
    }
    if (tile.army - candidateTile.army < -1 && candidateTile.player() !== -1) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 五个 scan
   * ------------------------------------------------------------------ */

  /* map.py:2625 —— 正向 delta：目标格兵数涨了，一定有源格送过去 */
  function run_positive_delta_movement_scan(map, skipCapturedPlayers, possibleMovesDict, allowFogSource) {
    for (var x = 0; x < map.cols; x++) {
      for (var y = 0; y < map.rows; y++) {
        var destTile = map.grid[y][x];
        if (!destTile.delta.armyMovedHere || destTile.delta.imperfectArmyDelta) continue;
        if (skipCapturedPlayers.indexOf(destTile.delta.oldOwner) >= 0) continue;

        var potentialSources = [];
        var wasFriendlyMove =
          teamId(map, destTile.delta.oldOwner) === teamId(map, destTile.delta.newOwner) &&
          destTile.delta.oldOwner !== destTile.delta.newOwner;
        var destWasAttackedNonLethalOrVacatedOrUnmoved = destTile.delta.unexplainedDelta <= 0 && !wasFriendlyMove;
        if (destWasAttackedNonLethalOrVacatedOrUnmoved) continue;

        for (var si = 0; si < destTile.movable.length; si++) {
          var potentialSource = destTile.movable[si];
          if (potentialSource.delta.oldOwner === map.player_index) continue;
          if (
            !allowFogSource &&
            ((!potentialSource.visible && !potentialSource.delta.lostSight) || potentialSource.delta.gainedSight)
          )
            continue;
          if (skipCapturedPlayers.indexOf(potentialSource.delta.oldOwner) >= 0) continue;
          var isCollisionSignature =
            destTile.delta.armyMovedHere &&
            destTile.delta.unexplainedDelta > 0 &&
            potentialSource.delta.unexplainedDelta < 0 &&
            Math.abs(potentialSource.delta.unexplainedDelta) >= destTile.delta.unexplainedDelta;
          if (
            potentialSource.was_visible_last_turn() &&
            teamId(map, potentialSource.delta.oldOwner) !== teamId(map, destTile.delta.oldOwner) &&
            map.player_index !== destTile.player() &&
            !isCollisionSignature
          ) {
            // 只有目标格的主人能从自己另一个格子送兵过来
            continue;
          }

          var sourceWasAttackedNonLethalOrVacated = potentialSource.delta.armyDelta < 0;
          if (sourceWasAttackedNonLethalOrVacated && _is_exact_army_movement_delta_dest_match(map, potentialSource, destTile)) {
            potentialSources = [potentialSource];
            break;
          }

          if (potentialSource.delta.imperfectArmyDelta && !_move_would_violate_known_player_deltas(map, potentialSource, destTile)) {
            potentialSources.push(potentialSource);
          } else if (map.remainingPlayers > 2 && _is_partial_army_movement_delta_match(map, potentialSource, destTile)) {
            if (!(destTile.army < 3)) potentialSources.push(potentialSource);
          }
        }

        if (potentialSources.length === 1) {
          var exclusiveSrc = potentialSources[0];
          var byPlayer = -1;
          if (destTile.was_visible_last_turn() && destTile.delta.oldOwner === destTile.player()) byPlayer = destTile.player();
          if (byPlayer === -1 && exclusiveSrc.was_visible_last_turn()) byPlayer = exclusiveSrc.delta.oldOwner;
          if (
            byPlayer === -1 &&
            destTile.was_visible_last_turn() &&
            (destTile.delta.oldOwner === -1 || isPlayerOnTeamWith(map, destTile.player(), destTile.delta.oldOwner)) &&
            destTile.delta.oldArmy < destTile.army
          )
            byPlayer = destTile.player();
          if (byPlayer === -1) byPlayer = exclusiveSrc.delta.oldOwner;
          if (byPlayer === -1) byPlayer = destTile.player();

          // 原版这里两个 fullDiffCovered 都硬编码 True（和用 exactMatch 在测试里等价）
          set_tile_moved(map, destTile, exclusiveSrc, true, true, byPlayer);
        } else {
          possibleMovesDict.set(destTile, potentialSources);
        }
      }
    }
  }

  /* map.py:2749 —— 被攻击的格：目标格兵数掉了/被抢了 */
  function run_attacked_tile_movement_scan(map, skipCapturedPlayers, possibleMovesDict, allowFogSource) {
    for (var x = 0; x < map.cols; x++) {
      for (var y = 0; y < map.rows; y++) {
        var destTile = map.grid[y][x];
        if (!destTile.delta.armyMovedHere || destTile.delta.imperfectArmyDelta) continue;
        if (!allowFogSource && !destTile.visible && !destTile.delta.lostSight) continue;
        if (skipCapturedPlayers.indexOf(destTile.delta.oldOwner) >= 0) continue;

        var potentialSources = [];
        var wasFriendlyMove =
          teamId(map, destTile.delta.oldOwner) === teamId(map, destTile.delta.newOwner);
        var destWasAttackedNonLethalOrVacated = destTile.delta.armyDelta < 0 && wasFriendlyMove;

        for (var si = 0; si < destTile.movable.length; si++) {
          var potentialSource = destTile.movable[si];
          if (potentialSource.delta.oldOwner === map.player_index) continue;
          if (!allowFogSource && !potentialSource.visible && !potentialSource.delta.lostSight) continue;
          if (skipCapturedPlayers.indexOf(potentialSource.delta.oldOwner) >= 0) continue;
          if (potentialSource.was_visible_last_turn() && potentialSource.delta.oldOwner === -1) continue;
          if (potentialSource.delta.armyDelta > 0 && !potentialSource.delta.gainedSight) {
            // 这个源格是「集兵」而不是「出兵」
            continue;
          }

          wasFriendlyMove =
            teamId(map, potentialSource.delta.oldOwner) === teamId(map, potentialSource.delta.newOwner) &&
            potentialSource.delta.oldOwner !== potentialSource.delta.newOwner;
          var sourceWasAttackedNonLethalOrVacated =
            (potentialSource.delta.unexplainedDelta <= 0 && !wasFriendlyMove) ||
            potentialSource.delta.lostSight ||
            (!potentialSource.visible && allowFogSource);

          if (sourceWasAttackedNonLethalOrVacated && _is_exact_army_movement_delta_dest_match(map, potentialSource, destTile)) {
            potentialSources = [potentialSource];
            break;
          }

          if (
            potentialSource.delta.imperfectArmyDelta &&
            !destWasAttackedNonLethalOrVacated &&
            !_move_would_violate_known_player_deltas(map, potentialSource, destTile)
          ) {
            potentialSources.push(potentialSource);
          }
          if (
            destWasAttackedNonLethalOrVacated &&
            map.remainingPlayers > 2 &&
            _is_partial_army_movement_delta_match(map, potentialSource, destTile)
          ) {
            if (!(destTile.army < 3)) potentialSources.push(potentialSource);
          }
        }

        if (potentialSources.length === 1) {
          var exclusiveSrc = potentialSources[0];
          var exactDestMatch =
            !destTile.delta.imperfectArmyDelta &&
            !exclusiveSrc.delta.imperfectArmyDelta &&
            _is_exact_army_movement_delta_dest_match(map, exclusiveSrc, destTile);
          var exactSourceMatch =
            !destTile.delta.imperfectArmyDelta &&
            !exclusiveSrc.delta.imperfectArmyDelta &&
            _is_exact_army_movement_delta_source_match(map, exclusiveSrc, destTile);

          var byPlayer = exclusiveSrc.delta.oldOwner;
          if (byPlayer === -1) {
            for (var ai = 0; ai < exclusiveSrc.movable.length; ai++) {
              var adj = exclusiveSrc.movable[ai];
              if (adj.visible && isTileEnemy(map, adj)) {
                byPlayer = adj.player();
                break;
              }
            }
          }
          if (byPlayer === -1) {
            for (var ai2 = 0; ai2 < exclusiveSrc.movable.length; ai2++) {
              var adj2 = exclusiveSrc.movable[ai2];
              if (isTileEnemy(map, adj2)) {
                byPlayer = adj2.player();
                break;
              }
            }
          }
          if (byPlayer === -1 || playerAt(map, byPlayer).last_move !== null) {
            byPlayer = playerAt(map, destTile.delta.oldOwner).fighting_with_player;
          }
          if (byPlayer === -1) {
            var possibilities = map.players.filter(function (p) {
              return (
                !p.dead &&
                !p.leftGame &&
                p.last_move === null &&
                p.unexplainedTileDelta < 0 &&
                p.index !== map.player_index &&
                p.index !== destTile.delta.oldOwner
              );
            });
            if (possibilities.length > 0) byPlayer = possibilities[0].index;
          }

          if (byPlayer !== -1) {
            set_tile_moved(map, destTile, exclusiveSrc, exactSourceMatch, exactDestMatch, byPlayer);
          }
        } else {
          possibleMovesDict.set(destTile, potentialSources);
        }
      }
    }
  }

  /* map.py:2460 —— 从可见格走进迷雾 */
  function run_movement_into_fog_scan(map, skipCapturedPlayers, possibleMovesDict) {
    for (var x = 0; x < map.cols; x++) {
      for (var y = 0; y < map.rows; y++) {
        var sourceTile = map.grid[y][x];
        if (!sourceTile.delta.armyMovedHere) continue;
        if (sourceTile.delta.imperfectArmyDelta) continue;
        if (sourceTile.delta.oldOwner === map.player_index) continue;
        if (map.teammates.has(sourceTile.delta.oldOwner)) continue;
        if (sourceTile.delta.oldOwner === -1 || skipCapturedPlayers.indexOf(sourceTile.delta.oldOwner) >= 0) continue;

        var potentialDests = [];
        var sourceWasAttackedNonLethalOrVacated =
          sourceTile.delta.armyDelta < 0 && sourceTile.delta.oldOwner === sourceTile.delta.newOwner;
        for (var di = 0; di < sourceTile.movable.length; di++) {
          var potentialDest = sourceTile.movable[di];
          if (potentialDest.visible) continue;

          if (sourceWasAttackedNonLethalOrVacated && _is_exact_army_movement_delta_dest_match(map, sourceTile, potentialDest)) {
            potentialDests = [potentialDest];
            break;
          }
          // 防止把「已经被拿下玩家」的旧领土当成新动向
          if (skipCapturedPlayers.indexOf(potentialDest.delta.oldOwner) >= 0) continue;

          var sourceOwnerWouldHaveCapturedNeutral =
            map.remainingPlayers === 2 &&
            sourceTile.delta.oldOwner >= 0 &&
            map.players[sourceTile.delta.oldOwner].unexplainedTileDelta === 0 &&
            potentialDest.delta.oldOwner === -1 &&
            sourceTile.delta.oldArmy > potentialDest.delta.oldArmy - 1;

          if (potentialDest.delta.imperfectArmyDelta && sourceWasAttackedNonLethalOrVacated && !sourceOwnerWouldHaveCapturedNeutral) {
            potentialDests.push(potentialDest);
          } else if (!sourceOwnerWouldHaveCapturedNeutral && _is_partial_army_movement_delta_match(map, sourceTile, potentialDest)) {
            potentialDests.push(potentialDest);
          }
        }

        var potentialUsKillDests = potentialDests.filter(function (d) {
          return isPlayerOnTeamWith(map, d.delta.oldOwner, map.player_index);
        });
        if (potentialUsKillDests.length === 1) potentialDests = potentialUsKillDests;

        if (potentialDests.length === 1) {
          var exclusiveDest = potentialDests[0];
          var exactMatch = true;
          if (sourceTile.delta.imperfectArmyDelta) exactMatch = false;
          if (exclusiveDest.delta.imperfectArmyDelta && !exclusiveDest.delta.lostSight) exactMatch = false;
          if (!_is_exact_army_movement_delta_dest_match(map, sourceTile, exclusiveDest)) exactMatch = false;

          var byPlayer = sourceTile.delta.oldOwner;
          if (byPlayer === -1) byPlayer = sourceTile.player();
          if (byPlayer === -1) byPlayer = exclusiveDest.player();
          if (byPlayer === -1) {
            // 从迷雾里打中立城：只能从可见的敌方邻格反推
            for (var ai = 0; ai < sourceTile.movable.length; ai++) {
              var adj = sourceTile.movable[ai];
              if (adj.visible && isTileEnemy(map, adj)) {
                byPlayer = adj.player();
                break;
              }
            }
          }
          if (byPlayer === -1) {
            for (var ai2 = 0; ai2 < sourceTile.movable.length; ai2++) {
              var adj2 = sourceTile.movable[ai2];
              if (isTileEnemy(map, adj2)) {
                byPlayer = adj2.player();
                break;
              }
            }
          }

          set_tile_moved(map, exclusiveDest, sourceTile, exactMatch, exactMatch, byPlayer);
        } else {
          possibleMovesDict.set(sourceTile, potentialDests);
        }
      }
    }
  }

  /* map.py:2569 —— 我们自己的地盘变成迷雾（孤岛视野丢失） */
  function run_island_vision_loss_scan(map, possibleMovesDict) {
    for (var x = 0; x < map.cols; x++) {
      for (var y = 0; y < map.rows; y++) {
        var destTile = map.grid[y][x];
        if (!destTile.delta.armyMovedHere) continue;
        if (!destTile.delta.lostSight) continue;
        if (destTile.delta.oldOwner !== map.player_index && !map.teammates.has(destTile.delta.oldOwner)) continue;

        var potentialSources = [];
        // 最近移动过的优先，其次兵最少的（原版 sorted key = (-lastMovedTurn, army)）
        var sorted = destTile.movable.slice().sort(function (a, b) {
          var k1 = 0 - a.lastMovedTurn - (0 - b.lastMovedTurn);
          if (k1 !== 0) return k1;
          return a.army - b.army;
        });

        var broke = false;
        for (var si = 0; si < sorted.length; si++) {
          var potentialSource = sorted[si];
          if (
            potentialSource.delta.oldOwner === map.player_index ||
            map.teammates.has(potentialSource.delta.oldOwner) ||
            potentialSource.delta.oldOwner === -1
          )
            continue;
          if (!potentialSource.delta.lostSight) continue;
          if (evaluate_island_fog_move(destTile, potentialSource)) {
            var byPlayer = potentialSource.delta.oldOwner;
            set_tile_moved(map, destTile, potentialSource, true, true, byPlayer);
            broke = true;
            break;
          }
        }

        if (!broke) possibleMovesDict.set(destTile, potentialSources);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * map.py:2034 —— 总入口
   * ------------------------------------------------------------------ */

  function detect_movement_and_populate_unexplained_diffs(map) {
    var possibleMovesDict = new Map();
    var candidateMoves = [];

    map.unexplained_deltas = new Map();
    map.moved_here_set = new Set();
    if (map.army_emergences === null || map.army_emergences === undefined || map.army_emergences instanceof Set) {
      map.army_emergences = {};
    }

    var enPlayers = [];
    for (var pi = 0; pi < map.players.length; pi++) {
      if (map.players[pi].team !== map.friendly_team) enPlayers.push(pi);
    }

    var i, j, k;
    for (i = 0; i < map.tiles_by_index.length; i++) {
      var t = map.tiles_by_index[i];
      if (t.delta.armyMovedHere) map.moved_here_set.add(t);
      if (t.delta.unexplainedDelta === 0) continue;
      if (!t.visible) continue;
      if (t.player() === -1) continue;
      map.unexplained_deltas.set(t, t.delta.unexplainedDelta);
      for (j = 0; j < t.movable.length; j++) {
        var mv = t.movable[j];
        var exclusiveMvPlayers = enPlayers;
        if (!mv.was_visible_last_turn()) {
          // 邻格上回合不可见 → 谁都可能
        } else {
          exclusiveMvPlayers = [mv.delta.oldOwner];
        }
        for (k = 0; k < exclusiveMvPlayers.length; k++) candidateMoves.push([exclusiveMvPlayers[k], mv, t]);
        if (t.was_visible_last_turn() && t.delta.oldOwner !== -1) candidateMoves.push([t.delta.oldOwner, t, mv]);
      }
    }
    void candidateMoves;

    for (i = 0; i < map.players.length; i++) map.players[i].last_move = null;

    var myGen = map.generals[map.player_index];
    if (myGen === null || myGen === undefined || myGen.player() !== map.player_index) return;

    // 自己的上一步先消化掉，否则自己的兵会被当成敌人的移动
    if (map.last_player_index_submitted_move !== null && map.last_player_index_submitted_move !== undefined) {
      map.players[map.player_index].last_move = _apply_last_player_move(map, map.last_player_index_submitted_move);
      if (map.last_player_index_submitted_move !== null && map.last_player_index_submitted_move !== undefined) {
        var mv2 = map.last_player_index_submitted_move;
        var src = mv2[0];
        var dest = mv2[1];
        set_tile_moved(map, dest, src, !src.delta.armyMovedHere, !dest.delta.armyMovedHere, map.player_index);
      }
    }

    var skipCapturedPlayers = [];
    for (i = 0; i < map.players.length; i++) {
      var p = map.players[i];
      if (p.dead && p.capturedBy !== null && p.capturedBy !== undefined) skipCapturedPlayers.push(p.index);
    }

    var attempt = 0;
    var numRuns = 1;
    var noChangesFound = false;
    while (attempt < numRuns && !noChangesFound) {
      attempt += 1;
      var startingUnexplained = new Map(map.unexplained_deltas);
      run_positive_delta_movement_scan(map, skipCapturedPlayers, possibleMovesDict, false);
      run_attacked_tile_movement_scan(map, skipCapturedPlayers, possibleMovesDict, false);
      run_positive_delta_movement_scan(map, skipCapturedPlayers, possibleMovesDict, true);
      run_movement_into_fog_scan(map, skipCapturedPlayers, possibleMovesDict);
      run_attacked_tile_movement_scan(map, skipCapturedPlayers, possibleMovesDict, true);
      run_island_vision_loss_scan(map, possibleMovesDict);

      noChangesFound = true;
      if (startingUnexplained.size !== map.unexplained_deltas.size) {
        noChangesFound = false;
        continue;
      }
      var changed = false;
      var entries = startingUnexplained.entries();
      var e = entries.next();
      while (!e.done) {
        var tile = e.value[0];
        var unexpDelta = e.value[1];
        if (map.unexplained_deltas.get(tile) !== unexpDelta) {
          changed = true;
          break;
        }
        e = entries.next();
      }
      if (changed) noChangesFound = false;
    }

    // 仍然没解释掉的 delta，记成「迷雾里冒出来的兵」，ArmyTracker 从这里起步
    var it = map.unexplained_deltas.keys();
    var nx = it.next();
    while (!nx.done) {
      var t2 = nx.value;
      nx = it.next();
      if (t2.delta.unexplainedDelta === 0) continue;
      if (!t2.visible) continue;
      if (t2.player() === -1) continue;
      if (map.army_emergences[t2.tile_index] !== undefined) continue;
      map.army_emergences[t2.tile_index] = [t2.delta.unexplainedDelta, t2.player()];
    }
  }

  /* map.py:2154 —— 只影响 player 的 scoreDelta 记账，不进 ekdiff 的格子字段 */
  function calculate_player_deltas(map) {
    var myPlayer = map.players[map.player_index];

    var lastScores = map.scoreHistory[1];
    if (lastScores === null || lastScores === undefined) return;

    var expectedFriendlyDelta = 0;
    var i;

    for (i = 0; i < myPlayer.cities.length; i++) {
      var city = myPlayer.cities[i];
      if (city.player() !== myPlayer.index) {
        myPlayer.cityCount -= 1;
        if (city.player() === -1) continue;
        map.players[city.player()].cityCount = map.players[city.player()].lastCityCount + 1;
      }
    }

    if (map.is_army_bonus_turn) expectedFriendlyDelta += myPlayer.tileCount - myPlayer.deserts.length;
    if (map.is_city_bonus_turn) expectedFriendlyDelta += myPlayer.cityCount - myPlayer.swamps.length - myPlayer.lostSwamps;

    var actualMeDelta = myPlayer.score - lastScores[myPlayer.index].total;
    var actualFriendlyDelta = actualMeDelta;

    if (map.is_2v2) {
      var self = map;
      map.teammates.forEach(function (teammate) {
        var teammatePlayer = self.players[teammate];
        if (teammatePlayer.dead) return;
        for (var ci = 0; ci < teammatePlayer.cities.length; ci++) {
          var city2 = teammatePlayer.cities[ci];
          if (city2.player() !== teammatePlayer.index) {
            teammatePlayer.cityCount -= 1;
            if (city2.player() === -1) continue;
            self.players[city2.player()].cityCount = self.players[city2.player()].lastCityCount + 1;
          }
        }
        if (self.is_army_bonus_turn) expectedFriendlyDelta += teammatePlayer.tileCount - teammatePlayer.deserts.length;
        if (self.is_city_bonus_turn)
          expectedFriendlyDelta += teammatePlayer.cityCount - teammatePlayer.swamps.length - teammatePlayer.lostSwamps;
        actualFriendlyDelta += teammatePlayer.score - lastScores[teammatePlayer.index].total;
      });
    }

    var friendlyFightDelta = expectedFriendlyDelta - actualFriendlyDelta;

    var teams = [];
    for (i = 0; i < map.players.length; i++) teams.push(i);
    if (map.teams !== null && map.teams !== undefined) teams = map.teams;

    var teamDict = new Map();
    for (i = 0; i < teams.length; i++) {
      var teamIndex = teams[i];
      if (teamIndex === -1) continue;
      var teamList = teamDict.get(teamIndex);
      if (!teamList) {
        teamList = [];
        teamDict.set(teamIndex, teamList);
      }
      teamList.push(i);
    }

    var teamCurrentCities;
    var actualEnemyTeamDelta;
    var expectedEnemyTeamDelta;
    var teamCityCount;
    var teamAlive;
    var teamListItems = Array.from(teamDict.entries());
    for (var ti = 0; ti < teamListItems.length; ti++) {
      var teamIndex2 = teamListItems[ti][0];
      var tl = teamListItems[ti][1];
      teamCurrentCities = 0;
      actualEnemyTeamDelta = 0;
      expectedEnemyTeamDelta = 0;
      teamCityCount = 0;
      teamAlive = false;
      for (var lp = 0; lp < tl.length; lp++) {
        var teamPlayer = map.players[tl[lp]];
        if (teamPlayer.dead) {
          teamPlayer.expectedScoreDelta = 0;
          teamPlayer.actualScoreDelta = 0;
          teamPlayer.cityCount = 0;
          teamPlayer.unexplainedTileDelta = 0;
          continue;
        }
        teamAlive = true;

        if (teamPlayer.cities.length + 1 !== teamPlayer.cityCount && isPlayerOnTeamWith(map, map.player_index, teamPlayer.index)) {
          teamPlayer.cityCount = teamPlayer.cities.length + 1;
        }

        var expectedEnemyDelta = 0;
        if (map.is_army_bonus_turn) expectedEnemyDelta += teamPlayer.tileCount - teamPlayer.deserts.length;
        if (map.is_city_bonus_turn) {
          expectedEnemyDelta += teamPlayer.cityCount;
          expectedEnemyDelta -= teamPlayer.swamps.length + teamPlayer.lostSwamps;
        }

        teamPlayer.actualScoreDelta = teamPlayer.score - lastScores[teamPlayer.index].total;
        teamPlayer.expectedScoreDelta = expectedEnemyDelta;
        teamPlayer.knownScoreDelta += expectedEnemyDelta;
        expectedEnemyTeamDelta += expectedEnemyDelta;
        actualEnemyTeamDelta += teamPlayer.actualScoreDelta;
        teamCurrentCities += teamPlayer.cityCount;
        teamCityCount += teamPlayer.cityCount;
      }

      if (!teamAlive) continue;

      var newCityCount = teamCityCount;
      if (!map.use_basic_city_counter) {
        var realEnemyCities = actualEnemyTeamDelta + friendlyFightDelta - expectedEnemyTeamDelta + teamCurrentCities;
        var cityDifference = realEnemyCities - teamCurrentCities;
        if (cityDifference <= -4) {
          if (cityDifference <= -20) newCityCount += 1;
        }
        if (map.is_city_bonus_turn && realEnemyCities !== teamCurrentCities && realEnemyCities > 0) {
          if (Math.abs(realEnemyCities - teamCurrentCities) < 6 || friendlyFightDelta === 0) newCityCount = realEnemyCities;
        }
      }

      if (tl.indexOf(map.player_index) >= 0) continue;

      var sum = 0;
      for (var lp2 = 0; lp2 < tl.length; lp2++) {
        var tpl = map.players[tl[lp2]];
        if (tpl.dead) continue;
        sum += tpl.cityCount;
      }
      var iter = 0;
      while (sum < newCityCount && iter < 100) {
        iter += 1;
        for (var lp3 = 0; lp3 < tl.length; lp3++) {
          var tp3 = map.players[tl[lp3]];
          if (tp3.dead) continue;
          tp3.cityCount += 1;
          tp3.cityGainedTurn = map.turn;
          sum += 1;
          if (sum >= newCityCount) break;
        }
      }
      while (sum > newCityCount && iter < 100) {
        iter += 1;
        for (var lp4 = 0; lp4 < tl.length; lp4++) {
          var tp4 = map.players[tl[lp4]];
          if (tp4.dead) continue;
          tp4.cityCount -= 1;
          tp4.cityLostTurn = map.turn;
          sum -= 1;
          if (sum <= newCityCount) break;
        }
      }
      if (iter > 98) throw new Error('INFINITE LOOPED IN TEAM CITY HANDLER');
    }

    for (i = 0; i < map.players.length; i++) {
      var player = map.players[i];
      var playerDeltaDiff = player.actualScoreDelta - player.knownScoreDelta;
      if (playerDeltaDiff < 0) {
        if (player.fighting_with_player >= 0) {
          var other = map.players[player.fighting_with_player];
          var otherPlayerDeltaDiff = other.actualScoreDelta - other.expectedScoreDelta;
          if (otherPlayerDeltaDiff === playerDeltaDiff) continue;
          else if (otherPlayerDeltaDiff < 0) continue;
        }
        for (var j2 = 0; j2 < map.players.length; j2++) {
          var teamPlayer2 = map.players[j2];
          if (teamPlayer2 === player) continue;
          var diff2 = teamPlayer2.actualScoreDelta - teamPlayer2.expectedScoreDelta;
          if (diff2 === playerDeltaDiff) {
            teamPlayer2.fighting_with_player = player.index;
            player.fighting_with_player = teamPlayer2.index;
          }
        }
      } else if (player.knownScoreDelta === player.expectedScoreDelta) {
        player.fighting_with_player = -1;
      }
    }
  }

  EK.mapmove = {
    detect_movement_and_populate_unexplained_diff: detect_movement_and_populate_unexplained_diffs,
    detect_movement_and_populate_unexplained_diffs: detect_movement_and_populate_unexplained_diffs,
    calculate_player_deltas: calculate_player_deltas,
    set_tile_moved: set_tile_moved,
    set_tile_probably_moved: set_tile_probably_moved,
    set_fog_emergence: set_fog_emergence,
    set_fog_moved_from_army_incremented: set_fog_moved_from_army_incremented,
    execute_definite_fog_island_capture: execute_definite_fog_island_capture,
    apply_last_player_move: _apply_last_player_move,
    evaluate_island_fog_move: evaluate_island_fog_move,
    _update_unexplained_delta: _update_unexplained_delta,
    _update_moved_here: _update_moved_here,
    _get_expected_delta_amount_toward: _get_expected_delta_amount_toward,
    _get_expected_delta_amount_from: _get_expected_delta_amount_from,
    _move_would_violate_known_player_deltas: _move_would_violate_known_player_deltas,
    _is_partial_army_movement_delta_match: _is_partial_army_movement_delta_match,
    _is_exact_army_movement_delta_dest_match: _is_exact_army_movement_delta_dest_match,
    _is_exact_army_movement_delta_source_match: _is_exact_army_movement_delta_source_match,
    player_had_priority_over_other: player_had_priority_over_other
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

/*
 * 迷雾下的军力推断 —— 移植自 generals-bot/base/client/map.py 的
 * detect_movement_and_populate_unexplained_diffs 与它调用的六个 scan。
 *
 * 这里是 Human.exe 真正「看见黑区后面的兵」的地方：每回合把可见格上的
 * armyDelta 减掉已知的产兵/自己的移动，剩下的 unexplainedDelta 就拿去和
 * 邻格的缺口配对，配上了就写 delta.fromTile/toTile，并记进 army_emergences。
 * ArmyTracker 完全建立在这份推断上，所以它必须和原版一模一样。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 待移植：set_tile_moved / set_tile_probably_moved 与六个 scan。
  // 现在先留空壳，ekdiff.js 会把差异定位到 dFrom / dTo / dUnexplained，
  // 其余字段（tile/player/army/delta/距离场/pathable）应当全对。
  function detect_movement_and_populate_unexplained_diffs(map) {
    map.unexplained_deltas = new Map();
    map.moved_here_set = new Set();
    for (var i = 0; i < map.tiles_by_index.length; i++) {
      var t = map.tiles_by_index[i];
      if (t.delta.armyMovedHere) map.moved_here_set.add(t);
      if (t.delta.unexplainedDelta === 0) continue;
      if (!t.visible) continue;
      if (t.player() === -1) continue;
      map.unexplained_deltas.set(t, t.delta.unexplainedDelta);
    }
    for (var p = 0; p < map.players.length; p++) map.players[p].last_move = null;
    var myGen = map.generals[map.player_index];
    if (myGen === null || myGen.player() !== map.player_index) return;

    var keys = Array.from(map.unexplained_deltas.keys());
    for (var k = 0; k < keys.length; k++) {
      var tile = keys[k];
      if (tile.delta.unexplainedDelta === 0) continue;
      if (!tile.visible) continue;
      if (tile.player() === -1) continue;
      if (map.army_emergences[tile.tile_index] !== undefined) continue;
      map.army_emergences[tile.tile_index] = [tile.delta.unexplainedDelta, tile.player()];
    }
  }

  function calculate_player_deltas(map) {
    // 待移植（map.py:2154）。只影响 player.fighting_with_player / actualScoreDelta，
    // 不进 ekdiff 的字段表，但 OpponentTracker 会读，随 ArmyTracker 一起补。
  }

  EK.mapmove = {
    detect_movement_and_populate_unexplained_diff: null,
    detect_movement_and_populate_unexplained_diffs: detect_movement_and_populate_unexplained_diffs,
    calculate_player_deltas: calculate_player_deltas
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

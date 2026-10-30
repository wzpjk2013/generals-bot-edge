/* Human.exe 的 BotModules/BotRepetition.py 逐函数移植（133 行原版）。
 *
 * 作用：重复出招检测。原版靠它避免在原地来回推（我们的自制引擎就有这个毛病），
 * dropped_move 则用来判断上一回合的招到底有没有被服务器执行 —— 那一格的兵力 delta
 * 是唯一证据，所以 bonus turn 的期望值必须按原版一模一样算。
 */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function bm(bot) {
    return bot.map || bot._map;
  }

  function historyFor(bot, turn) {
    var hist = bot.history.move_history[turn];
    if (hist === undefined || hist === null) return null;
    return hist instanceof Map ? Array.from(hist.values()).flat() : hist;
  }

  function droppedAt(bot, turn) {
    var d = bot.history.droppedHistory;
    if (d instanceof Set) return d.has(turn);
    return !!(d[turn]);
  }

  function BotRepetition() {}

  BotRepetition.detect_repetition_at_all = function (bot, turns, numReps) {
    if (turns === undefined) turns = 4;
    if (numReps === undefined) numReps = 2;
    var map = bm(bot);
    var curTurn = map.turn;
    var reps = 0;
    var prevMove = null;
    for (var turn = Math.trunc(curTurn - turns); turn < curTurn; turn++) {
      // Python 里 move_history 是 int 键 dict、droppedHistory 是 set；JS 两种容器都兼容。
      var history = historyFor(bot, turn);
      if (history === null) continue;
      for (var mi = 0; mi < history.length; mi++) {
        var lastMove = history[mi];
        if (
          prevMove !== null &&
          !droppedAt(bot, turn) &&
          lastMove !== null &&
          ((lastMove.dest === prevMove.source && lastMove.source === prevMove.dest) ||
            (lastMove.source === prevMove.source && lastMove.dest === prevMove.dest))
        ) {
          reps += 1;
          if (reps === numReps) return true;
        }
        prevMove = lastMove;
      }
    }
    return false;
  };

  BotRepetition.detect_repetition = function (bot, move, turns, numReps) {
    if (turns === undefined) turns = 4;
    if (numReps === undefined) numReps = 2;
    if (move === null || move === undefined) return false;
    var map = bm(bot);
    var curTurn = map.turn;
    var reps = 0;
    for (var turn = Math.trunc(curTurn - turns); turn < curTurn; turn++) {
      var oldMoves = historyFor(bot, turn);
      if (oldMoves === null) continue;
      for (var mi = 0; mi < oldMoves.length; mi++) {
        var oldMove = oldMoves[mi];
        if (
          !droppedAt(bot, turn) &&
          oldMove !== null &&
          ((oldMove.dest === move.source && oldMove.source === move.dest) ||
            (oldMove.source === move.source && oldMove.dest === move.dest))
        ) {
          reps += 1;
          if (reps === numReps) return true;
        }
      }
    }
    return false;
  };

  BotRepetition.detect_repetition_tile = function (bot, tile, turns, numReps) {
    if (turns === undefined) turns = 6;
    if (numReps === undefined) numReps = 2;
    if (tile === null || tile === undefined) return false;
    var map = bm(bot);
    var curTurn = map.turn;
    var reps = 0;
    for (var turn = Math.trunc(curTurn - turns); turn < curTurn; turn++) {
      var oldMoves = historyFor(bot, turn);
      if (oldMoves === null) continue;
      for (var mi = 0; mi < oldMoves.length; mi++) {
        var oldMove = oldMoves[mi];
        if (!droppedAt(bot, turn) && oldMove !== null && oldMove.dest === tile) {
          reps += 1;
          if (reps === numReps) return true;
        }
      }
    }
    return false;
  };

  BotRepetition.move_half_on_repetition = function (bot, move, repetitionTurns, repCount) {
    if (repCount === undefined) repCount = 3;
    if (BotRepetition.detect_repetition(bot, move, repetitionTurns, repCount)) {
      move.move_half = true;
    }
    return move;
  };

  BotRepetition.dropped_move = function (bot, fromTile, toTile, movedHalf) {
    var map = bm(bot);
    var lastMove = null;
    var prevHist = historyFor(bot, map.turn - 1);
    if (prevHist !== null) lastMove = prevHist.length > 0 ? prevHist[0] : null;
    if (movedHalf === undefined || movedHalf === null) {
      movedHalf = lastMove !== null && lastMove !== undefined ? lastMove.move_half : false;
    }
    if (fromTile === undefined || fromTile === null || toTile === undefined || toTile === null) {
      if (lastMove === null || lastMove === undefined) return false;
      fromTile = lastMove.source;
      toTile = lastMove.dest;
    }
    if (fromTile.player() !== bot.general.player()) return false;

    var expectedFrom = 1;
    var expectedToDeltaOnMiss = 0;
    if (map.is_army_bonus_turn) {
      expectedFrom += 1;
      if (toTile.player() !== -1) expectedToDeltaOnMiss += 1;
    }
    if ((fromTile.isCity || fromTile.isGeneral) && map.is_city_bonus_turn) expectedFrom += 1;
    if (((toTile.isCity && toTile.player() !== -1) || toTile.isGeneral) && map.is_city_bonus_turn) {
      expectedToDeltaOnMiss += 1;
    }

    var dropped = true;
    if (!movedHalf) {
      dropped = fromTile.army > expectedFrom;
    } else {
      dropped = Math.abs(toTile.delta.armyDelta) === expectedToDeltaOnMiss;
    }
    if (dropped) bot.history.droppedHistory[map.turn - 1] = true;
    return dropped;
  };

  EK.BotRepetition = BotRepetition;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

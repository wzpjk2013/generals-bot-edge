/*
 * Path / WaitPath / MoveListPath + Move / MoveBase / PathMove
 * —— 逐行移植自 generals-bot 的 Path.py、Models/Move.py、Interfaces/TilePlanInterface.py。
 *
 * 这些类不是「数据结构」，是 ArmyTracker / ExpandUtils / Gather / BotDefense 的
 * 通用返回值：SearchUtils 里每个 BFS 最后都拼一个 Path，下游靠 Path.value、
 * Path.length、Path.get_move_list() 做加减。所以这里的每一个长度定义都必须照抄：
 *   Path.length          = len(_pathQueue) - 1   （节点数 - 1 = 移动数）
 *   MoveListPath.length  = len(_pathQueue)       （本来就是移动数）
 * 抄错一个 -1，下游所有价值判断都会偏一格。
 *
 * PathMove.next/prev 只维护从头到尾的正向链和反向链，_pathQueue 才是真身；
 * 一旦做 remove_start/remove_end，缓存（tileList/tileSet/adjacentSet）全部失效置 null，
 * 这是原版的懒惰重建策略，不能改成增量更新。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---- Interfaces/TilePlanInterface.py::PathMove ---- */
  function PathMove(tile, next, prev, moveHalf) {
    this.tile = tile;
    this.next = next === undefined ? null : next;
    this.prev = prev === undefined ? null : prev;
    this.move_half = !!moveHalf;
  }

  PathMove.prototype.clone = function () {
    // 原版 clone 不复制 move_half（写死了默认 False），照抄，别"顺手修好"。
    return new PathMove(this.tile, this.next, this.prev);
  };

  PathMove.prototype.toString = function () {
    var prevVal = this.prev === null ? '[]' : '[' + this.prev.tile.x + ',' + this.prev.tile.y + ']';
    var nextVal = this.next === null ? '[]' : '[' + this.next.tile.x + ',' + this.next.tile.y + ']';
    var myVal = '[' + this.tile.x + ',' + this.tile.y + ']';
    return '(prev:' + prevVal + ' me:' + myVal + ' next:' + nextVal + ')';
  };

  /* ---- Models/Move.py::MoveBase / Move ---- */
  function MoveBase(source, dest, moveHalf) {
    this.source = source;
    this.dest = dest;
    this.move_half = !!moveHalf;
  }

  MoveBase.prototype.gt = function (other) {
    if (other === null || other === undefined) return true;
    return this.source.army - this.dest.army > other.source.army - other.dest.army;
  };
  MoveBase.prototype.lt = function (other) {
    if (other === null || other === undefined) return false;
    return this.source.army - this.dest.army < other.source.army - other.dest.army;
  };
  MoveBase.prototype.toString = function () {
    return (
      this.source.x + ',' + this.source.y + ' -' + (this.move_half ? 'z' : '') + '> ' + this.dest.x + ',' + this.dest.y
    );
  };
  MoveBase.prototype.tile_index_hash = function () {
    return this.source.tile_index ^ (this.dest.tile_index << (this.move_half ? 2 : 5));
  };
  MoveBase.prototype.equals = function (other) {
    if (!(other instanceof MoveBase)) return false;
    return (
      this.source.tile_index === other.source.tile_index &&
      this.dest.tile_index === other.dest.tile_index &&
      this.move_half === other.move_half
    );
  };

  function Move(source, dest, moveHalf) {
    MoveBase.call(this, source, dest, moveHalf);
    this.army_moved = source.army - 1;
    if (this.move_half) this.army_moved = Math.floor((source.army - 1) / 2);
    this.non_friendly = this.source.player() !== this.dest.player();
  }
  Move.prototype = Object.create(MoveBase.prototype);
  Move.prototype.constructor = Move;

  /* ---- 属性定义工具：Python 的 @property 就是 getter/setter ---- */
  function defProp(proto, name, getter, setter) {
    var desc = { get: getter, configurable: true };
    if (setter) desc.set = setter;
    Object.defineProperty(proto, name, desc);
  }

  function noSetting() {
    throw new Error('NO SETTING!');
  }

  /* ---- Path.py::Path ---- */
  // 签名以原文为准：Path(armyRemaining: float = 0)。
  // （任务书里写的 Path(tiles, negativeTiles=None, noLog=False) 在这个版本的源码里不存在。）
  function Path(armyRemaining) {
    this.start = null;
    this._pathQueue = [];
    this.tail = null;
    this._tileList = null;
    this._tileSet = null;
    this._adjacentSet = null;
    // 路径跑完后停在最后一格上的确切兵数
    this.value = armyRemaining === undefined ? 0 : armyRemaining;
    this._econ_value = 0.0;
    this._requiredDelay = 0;
  }

  var P = Path.prototype;

  defProp(
    P,
    'econValue',
    function () {
      return this._econ_value;
    },
    function (v) {
      this._econ_value = v;
    }
  );
  defProp(P, 'length', function () {
    return Math.max(0, this._pathQueue.length - 1);
  });
  defProp(
    P,
    'tileSet',
    function () {
      if (this._tileSet === null) {
        if (this._tileList !== null) {
          this._tileSet = new Set(this._tileList);
        } else {
          this._tileSet = new Set();
          for (var i = 0; i < this._pathQueue.length; i++) this._tileSet.add(this._pathQueue[i].tile);
        }
      }
      return this._tileSet;
    },
    noSetting
  );
  defProp(P, 'tileList', function () {
    if (this._tileList === null) {
      this._tileList = [];
      for (var i = 0; i < this._pathQueue.length; i++) this._tileList.push(this._pathQueue[i].tile);
    }
    return this._tileList;
  });
  defProp(P, 'tiles', function () {
    var out = [];
    for (var i = 0; i < this._pathQueue.length; i++) out.push(this._pathQueue[i].tile);
    return out;
  });
  defProp(P, 'adjacentSet', function () {
    if (this._adjacentSet === null) {
      this._adjacentSet = new Set();
      for (var i = 0; i < this._pathQueue.length; i++) {
        var adj = this._pathQueue[i].tile.adjacents;
        for (var k = 0; k < adj.length; k++) this._adjacentSet.add(adj[k]);
      }
    }
    return this._adjacentSet;
  });
  defProp(
    P,
    'requiredDelay',
    function () {
      return this._requiredDelay;
    },
    function (v) {
      this._requiredDelay = v;
    }
  );

  P.get_move_list = function () {
    var moves = [];
    if (this._pathQueue.length === 0) return moves;
    var last = this._pathQueue[0];
    for (var i = 1; i < this._pathQueue.length; i++) {
      moves.push(new Move(last.tile, this._pathQueue[i].tile, last.move_half));
      last = this._pathQueue[i];
    }
    return moves;
  };

  P.add_next = function (nextTile, moveHalf) {
    var move = new PathMove(nextTile);
    move.prev = this.tail;
    if (this.start === null) this.start = move;
    if (this.tail !== null) {
      this.tail.next = move;
      this.tail.move_half = !!moveHalf;
    }
    if (this._tileList !== null) this._tileList.push(nextTile);
    if (this._tileSet !== null) this._tileSet.add(nextTile);
    if (this._adjacentSet !== null) {
      var adj = nextTile.adjacents;
      for (var i = 0; i < adj.length; i++) this._adjacentSet.add(adj[i]);
    }
    this.tail = move;
    this._pathQueue.push(move);
  };

  P.add_start = function (startTile) {
    var move = new PathMove(startTile);
    if (this.start !== null) {
      move.next = this.start;
      this.start.prev = move;
    } else {
      this.tail = move;
    }
    this.start = move;
    if (this._tileList !== null) this._tileList.splice(0, 0, startTile);
    if (this._tileSet !== null) this._tileSet.add(startTile);
    if (this._adjacentSet !== null) {
      var adj = startTile.adjacents;
      for (var i = 0; i < adj.length; i++) this._adjacentSet.add(adj[i]);
    }
    this._pathQueue.splice(0, 0, move);
  };

  P.remove_start = function () {
    if (this._pathQueue.length === 0) {
      throw new Error('remove_start with no moves');
    }
    this._tileSet = null;
    this._tileList = null;
    this._adjacentSet = null;
    this.start = this.start.next;
    this._pathQueue.shift();
  };

  P.get_first_move = function () {
    if (this._pathQueue.length <= 1) return null;
    return new Move(this.start.tile, this.start.next.tile, this.start.move_half);
  };

  P.pop_first_move = function () {
    if (this._pathQueue.length <= 1) {
      throw new Error('pop_first_move with no moves');
    }
    var move = this.get_first_move();
    this._tileSet = null;
    this._tileList = null;
    this._adjacentSet = null;
    this.start = this.start.next;
    this._pathQueue.shift();
    return move;
  };

  P.remove_end = function () {
    if (this._pathQueue.length === 0) return null;
    this._tileSet = null;
    this._tileList = null;
    this._adjacentSet = null;
    this._pathQueue.pop();
    this.tail = this.tail.prev;
    if (this.tail !== null) this.tail.next = null;
  };

  P.convert_to_dist_dict = function (offset) {
    var dist = offset === undefined ? 0 : offset;
    var out = new Map();
    var node = this.start;
    while (node !== null) {
      out.set(node.tile, dist);
      node = node.next;
      dist += 1;
    }
    return out;
  };

  P.calculate_value = function (
    forPlayer,
    teams,
    negativeTiles,
    ignoreNonPlayerArmy,
    ignoreIncrement,
    incrementBackwards,
    doNotSaveToPath
  ) {
    // 第一格没被移动进去，所以从 1 起算
    var val = 1;
    var node = this.start;
    var i = 0;
    while (node !== null) {
      var tile = node.tile;
      if (negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(tile)) {
        if (tile.player() !== -1 && teams[tile.player()] === teams[forPlayer]) {
          val += tile.army;
          if ((tile.isCity || tile.isGeneral) && !ignoreIncrement) {
            var incVal = i - 1;
            if (incrementBackwards) incVal = this.length - incVal;
            val += Math.floor(incVal / 2);
          }
        } else if (!ignoreNonPlayerArmy) {
          val -= tile.army;
          if ((tile.isCity || tile.isGeneral) && tile.player() !== -1 && !ignoreIncrement) {
            var incVal2 = i - 1;
            if (incrementBackwards) incVal2 = this.length - incVal2;
            val -= Math.floor(incVal2 / 2);
          }
        }
      }

      if (!node.move_half) {
        val = val - 1;
      } else {
        val = Math.floor((val + 1) / 2);
      }

      node = node.next;
      i += 1;
    }

    if (!doNotSaveToPath) this.value = val;

    return val;
  };

  P.get_positive_subsegment = function (forPlayer, teams, negativeTiles, ignoreIncrement) {
    var val = 1;
    var node = this.start;
    var i = 0;
    while (node !== null) {
      var tile = node.tile;
      var oldVal = val;
      if (negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(tile)) {
        if (tile.player() !== -1 && teams[tile.player()] === teams[forPlayer]) {
          val += tile.army;
          if ((tile.isCity || tile.isGeneral) && !ignoreIncrement) {
            val += Math.floor((i - 1) / 2);
          }
        } else {
          val -= tile.army;
          if ((tile.isCity || tile.isGeneral) && tile.player() !== -1 && !ignoreIncrement) {
            val -= Math.floor((i - 1) / 2);
          }
        }
      }

      if (!node.move_half) {
        val = val - 1;
      } else {
        val = Math.floor((val + 1) / 2);
      }

      if (val <= 0) {
        val = oldVal;
        break;
      }

      node = node.next;
      i += 1;
    }

    var sub = this.get_subsegment(i - 1);
    sub.value = val;
    return sub;
  };

  P.get_subsegment_until_visible_to_player = function (players) {
    var node = this.start;
    var i = 0;
    while (node !== null) {
      var tile = node.tile;
      var shouldBreak = false;
      for (var v = 0; v < tile.visibleTo.length; v++) {
        if (players.indexOf(tile.visibleTo[v].player()) >= 0) {
          shouldBreak = true;
          break;
        }
      }
      if (shouldBreak) break;

      node = node.next;
      i += 1;
    }

    if (i <= 1) i = 2;
    return this.get_subsegment(i - 1);
  };

  P.clone = function () {
    var newPath = new Path(this.value);
    var node = this.start;
    while (node !== null) {
      newPath.add_next(node.tile);
      node = node.next;
    }

    newPath._requiredDelay = this._requiredDelay;
    newPath._econ_value = this._econ_value;

    return newPath;
  };

  P.get_reversed = function () {
    if (this.start === null || this.start.next === null) return this.clone();

    var newPath = new Path();
    var temp = this.tail;
    while (temp !== null) {
      newPath.add_next(temp.tile);
      temp = temp.prev;
    }

    newPath.value = this.value;
    newPath._econ_value = this._econ_value;
    return newPath;
  };

  P.get_subsegment = function (count, end) {
    if (count <= 0) return new Path();

    var newPath = this.clone();
    var i = 0;

    if (end) {
      while (i < this.length - count) {
        i += 1;
        newPath.start = newPath.start.next;
        newPath._pathQueue.shift();
      }
    } else {
      while (i < this.length - count) {
        i += 1;
        newPath._pathQueue.pop();
        newPath.tail = newPath.tail.prev;
        if (newPath.tail !== null) newPath.tail.next = null;
      }
    }

    return newPath;
  };

  P.to_move_string = function () {
    // 'z' 标的是「进入下一格时是否半兵」，而 PathMove.move_half 记在出发格上，
    // 所以打印第 i 格时用的是第 i-1 格的 move_half。照抄这个错位。
    var nodeStrs = [];
    var half = false;
    var node = this.start;
    while (node !== null) {
      nodeStrs.push(node.tile.x + ',' + node.tile.y + (half ? 'z' : ''));
      half = node.move_half;
      node = node.next;
    }
    return nodeStrs.join('->');
  };

  P.convert_to_move_list = function () {
    var moves = [];
    var node = this.start;
    while (node.next !== null) {
      moves.push(new Move(node.tile, node.next.tile, node.move_half));
      node = node.next;
    }
    return moves;
  };

  P.get_subsegment_excluding_trailing_visible = function () {
    var path = this.clone();
    while (path.tail.tile.visible && path.length > 1) path.remove_end();
    return path;
  };

  P.convert_to_tree_nodes = function (map, forPlayer) {
    if (!EK.GatherTreeNode) throw new Error('convert_to_tree_nodes needs EK.GatherTreeNode (Gather not ported yet)');
    var curGatherTreeNode = null;
    var curPathNode = this.start;
    var prevPathTile = null;
    var turn = 0;
    var value = 0;
    while (curPathNode !== null) {
      var prevGatherTreeNode = curGatherTreeNode;
      var t = curPathNode.tile;
      curGatherTreeNode = new EK.GatherTreeNode(t, prevPathTile);
      if (prevGatherTreeNode !== null) {
        prevGatherTreeNode.toGather = curGatherTreeNode;
        curGatherTreeNode.children.push(prevGatherTreeNode);
      }

      if (map.is_tile_on_team_with(t, forPlayer)) value += t.army;
      else value -= t.army;
      value -= 1;

      curGatherTreeNode.gatherTurns = turn;
      curGatherTreeNode.value = value;

      turn += 1;
      prevPathTile = t;
      curPathNode = curPathNode.next;
    }

    return curGatherTreeNode;
  };

  P.break_overflow_into_one_move_path_subsegments = function (lengthToKeepInOnePath) {
    if (lengthToKeepInOnePath === undefined) lengthToKeepInOnePath = 1;
    if (lengthToKeepInOnePath >= this.length) return [this.clone()];

    var segments = [this.get_subsegment(lengthToKeepInOnePath)];
    var newCopyEnd = this.get_subsegment(this.length - lengthToKeepInOnePath, true);
    for (var i = 0; i < newCopyEnd.length; i++) {
      segments.push(newCopyEnd.get_subsegment(1));
      newCopyEnd = newCopyEnd.get_subsegment(newCopyEnd.length - 1, true);
    }
    return segments;
  };

  P.pathMoves = function () {
    return this._pathQueue.slice();
  };

  P.toString = function () {
    var valStr = '';
    if (this._econ_value !== 0.0) valStr = ' ' + this._econ_value.toFixed(2) + 'v';
    return '[' + this.value + 'a' + valStr + ' ' + this.length + 't] ' + this.to_move_string();
  };

  P.gt = function (other) {
    if (other === null || other === undefined) return true;
    if (this.econValue === other.econValue) return this.length > other.length;
    return this.econValue > other.econValue;
  };
  P.lt = function (other) {
    if (other === null || other === undefined) return false;
    if (this.econValue === other.econValue) return this.length < other.length;
    return this.econValue < other.econValue;
  };

  if (typeof Symbol !== 'undefined' && Symbol.iterator) {
    P[Symbol.iterator] = function () {
      return this._pathQueue.slice()[Symbol.iterator]();
    };
  }

  Path.from_string = function (map, pathStr) {
    var moves = pathStr.split('->');
    var prevTile = null;
    var path = new Path();
    for (var m = 0; m < moves.length; m++) {
      var moveStr = moves[m];
      var parts = moveStr.trim().split(',');
      var xStr = parts[0];
      var yStr = parts[1];
      var moveHalf = false;
      if (yStr.trim().slice(-1) === 'z') {
        moveHalf = true;
        yStr = yStr.trim().replace(/[z ]/g, '');
      }

      var nextTile = map.GetTile(parseInt(xStr, 10), parseInt(yStr, 10));

      if (prevTile === null) {
        path.add_next(nextTile);
        prevTile = nextTile;
        continue;
      }

      if (prevTile.x !== nextTile.x && prevTile.y !== nextTile.y) {
        throw new Error('Cannot jump diagonally between ' + prevTile + ' and ' + nextTile);
      }

      var xInc = nextTile.x - prevTile.x;
      if (xInc < 0) xInc = -1;
      else if (xInc > 0) xInc = 1;

      var yInc = nextTile.y - prevTile.y;
      if (yInc < 0) yInc = -1;
      else if (yInc > 0) yInc = 1;

      while (prevTile.x !== nextTile.x || prevTile.y !== nextTile.y) {
        var currentTile = map.GetTile(prevTile.x + xInc, prevTile.y + yInc);
        path.add_next(currentTile, moveHalf);
        prevTile = currentTile;
        moveHalf = false;
      }
    }

    path.calculate_value(path.start.tile.player(), map.team_ids_by_player_index);
    return path;
  };

  Path.from_move = function (move) {
    var path = new Path();
    path.add_next(move.source);
    path.add_next(move.dest, move.move_half);
    return path;
  };

  /* ---- Path.py::WaitPath ---- */
  function WaitPath(armyRemaining, waitUntilArmy) {
    Path.call(this, armyRemaining);
    this.wait_until_army = waitUntilArmy === undefined ? 0 : waitUntilArmy;
  }
  WaitPath.prototype = Object.create(Path.prototype);
  WaitPath.prototype.constructor = WaitPath;
  WaitPath.prototype.clone = function () {
    var newPath = new WaitPath(this.value, this.wait_until_army);
    var node = this.start;
    while (node !== null) {
      newPath.add_next(node.tile);
      node = node.next;
    }
    newPath._requiredDelay = this._requiredDelay;
    newPath._econ_value = this._econ_value;
    return newPath;
  };

  /* ---- Path.py::MoveListPath ---- */
  function MoveListPath(moves) {
    this.start = null;
    this.tail = null;
    this._pathQueue = [];
    this._tileList = null;
    this._tileSet = null;
    this._adjacentSet = null;
    this.value = 0.0;
    this._econ_value = 0.0;
    this._requiredDelay = 0;

    if (moves) {
      for (var i = 0; i < moves.length; i++) this.add_next_move(moves[i]);
    }
  }

  var M = MoveListPath.prototype;

  defProp(
    M,
    'econValue',
    function () {
      return this._econ_value;
    },
    function (v) {
      this._econ_value = v;
    }
  );
  defProp(M, 'length', function () {
    return Math.max(0, this._pathQueue.length);
  });
  defProp(
    M,
    'tileSet',
    function () {
      if (this._tileSet === null) {
        if (this._tileList !== null) {
          this._tileSet = new Set(this._tileList);
        } else {
          this._tileSet = new Set();
          for (var i = 0; i < this._pathQueue.length; i++) {
            var t = this._pathQueue[i];
            if (t) {
              this._tileSet.add(t.source);
              this._tileSet.add(t.dest);
            }
          }
        }
      }
      return this._tileSet;
    },
    noSetting
  );
  defProp(M, 'tileList', function () {
    if (this._tileList === null) this._tileList = this.tiles;
    return this._tileList;
  });
  defProp(M, 'tiles', function () {
    if (this._tileList !== null) return this._tileList.slice();

    var out = [];
    var lastDest = null;
    for (var i = 0; i < this._pathQueue.length; i++) {
      var move = this._pathQueue[i];
      if (move) {
        if (move.source !== lastDest) out.push(move.source);
        out.push(move.dest);
        lastDest = move.dest;
      } else {
        lastDest = null;
      }
    }
    return out;
  });
  defProp(M, 'adjacentSet', function () {
    if (this._adjacentSet === null) {
      this._adjacentSet = new Set();
      var list = this.tileList;
      for (var i = 0; i < list.length; i++) {
        var adj = list[i].adjacents;
        for (var k = 0; k < adj.length; k++) this._adjacentSet.add(adj[k]);
      }
    }
    return this._adjacentSet;
  });
  defProp(
    M,
    'requiredDelay',
    function () {
      return this._requiredDelay;
    },
    function (v) {
      this._requiredDelay = v;
    }
  );

  M.get_move_list = function () {
    return this._pathQueue.slice();
  };

  M.add_next = function (nextTile, moveHalf) {
    var move = new PathMove(nextTile);
    var prev = this.tail;
    move.prev = this.tail;
    if (this.start === null) this.start = move;
    if (this.tail !== null) {
      this.tail.next = move;
      this.tail.move_half = !!moveHalf;
    }
    if (this._tileList !== null) this._tileList.push(nextTile);
    if (this._tileSet !== null) this._tileSet.add(nextTile);
    if (this._adjacentSet !== null) {
      var adj = nextTile.adjacents;
      for (var i = 0; i < adj.length; i++) this._adjacentSet.add(adj[i]);
    }
    this.tail = move;
    if (prev !== null) this._pathQueue.push(new Move(prev.tile, nextTile, moveHalf));
  };

  M.add_next_move = function (move) {
    if (move === null || move === undefined) {
      this._pathQueue.push(move);
      return;
    }

    if (!this.tail) this.add_next(move.source);

    if (this.tail.tile === move.source) {
      this.add_next(move.dest, move.move_half);
      return;
    }

    var sourcePm = new PathMove(move.source);
    sourcePm.prev = this.tail;
    this.tail.next = sourcePm;
    var destPm = new PathMove(move.dest, null, sourcePm, move.move_half);
    destPm.prev = sourcePm;
    sourcePm.next = destPm;

    if (this._tileList !== null) {
      this._tileList.push(move.source);
      this._tileList.push(move.dest);
    }
    if (this._tileSet !== null) {
      this._tileSet.add(move.source);
      this._tileSet.add(move.dest);
    }
    if (this._adjacentSet !== null) {
      var sa = move.source.adjacents;
      for (var i = 0; i < sa.length; i++) this._adjacentSet.add(sa[i]);
      var da = move.dest.adjacents;
      for (var k = 0; k < da.length; k++) this._adjacentSet.add(da[k]);
    }

    this.tail = destPm;
    this._pathQueue.push(move);
  };

  M.add_start = function (startTile) {
    var move = new PathMove(startTile);
    var nextNode = this.start;
    if (this.start !== null) {
      move.next = this.start;
      this.start.prev = move;
    } else {
      this.tail = move;
    }
    this.start = move;
    if (this._tileList !== null) this._tileList.splice(0, 0, startTile);
    if (this._tileSet !== null) this._tileSet.add(startTile);
    if (this._adjacentSet !== null) {
      var adj = startTile.adjacents;
      for (var i = 0; i < adj.length; i++) this._adjacentSet.add(adj[i]);
    }
    if (nextNode) this._pathQueue.splice(0, 0, new Move(startTile, nextNode.tile));
  };

  M.remove_start = function () {
    return this._remove_start();
  };

  M._remove_start = function () {
    if (this._pathQueue.length === 0) {
      throw new Error('remove_start with no moves');
    }
    this._tileSet = null;
    this._tileList = null;
    this._adjacentSet = null;
    var move = this._pathQueue.shift();
    this._rebuild_start_tail();
    return move;
  };

  M._rebuild_start_tail = function () {
    this.start = null;
    var tail = null;
    for (var i = 0; i < this._pathQueue.length; i++) {
      var node = this._pathQueue[i];
      if (node === null || node === undefined) continue;
      var next = new PathMove(node.source, null, tail, node.move_half);
      if (tail !== null) tail.next = next;
      tail = next;
      if (this.start === null) this.start = next;
    }
    this.tail = tail;
  };

  M.get_first_move = function () {
    if (this._pathQueue.length <= 0) return null;
    return this._pathQueue[0];
  };

  M.pop_first_move = function () {
    return this._remove_start();
  };

  M._remove_end = function () {
    if (this._pathQueue.length === 0) return null;
    this._tileSet = null;
    this._tileList = null;
    this._adjacentSet = null;
    this.tail = this.tail.prev;
    var move = this._pathQueue.pop();
    var last = this._pathQueue.length > 0 ? this._pathQueue[this._pathQueue.length - 1] : null;
    if (this.tail && last && last.dest !== this.tail.tile) this.tail = this.tail.prev;
    if (this.tail) this.tail.next = null;
    return move;
  };

  M.remove_end = function () {
    return this._remove_end();
  };

  M.remove_end_move = function () {
    return this._remove_end();
  };

  M.calculate_value = function (
    forPlayer,
    teams,
    negativeTiles,
    ignoreNonPlayerArmy,
    ignoreIncrement,
    incrementBackwards,
    doNotSaveToPath
  ) {
    var val = 1;
    var node = this.start;
    var i = 0;
    while (node !== null) {
      var tile = node.tile;
      if (negativeTiles === null || negativeTiles === undefined || !negativeTiles.has(tile)) {
        if (tile.player() !== -1 && teams[tile.player()] === teams[forPlayer]) {
          val += tile.army;
          if ((tile.isCity || tile.isGeneral) && !ignoreIncrement) {
            var incVal = i - 1;
            if (incrementBackwards) incVal = this.length - incVal;
            val += Math.floor(incVal / 2);
          }
        } else if (!ignoreNonPlayerArmy) {
          val -= tile.army;
          if ((tile.isCity || tile.isGeneral) && tile.player() !== -1 && !ignoreIncrement) {
            var incVal2 = i - 1;
            if (incrementBackwards) incVal2 = this.length - incVal2;
            val -= Math.floor(incVal2 / 2);
          }
        }
      }

      if (!node.move_half) {
        val = val - 1;
      } else {
        val = Math.floor((val + 1) / 2);
      }

      node = node.next;
      i += 1;
    }

    if (!doNotSaveToPath) this.value = val;
    return val;
  };

  M.clone = function () {
    var newPath = new MoveListPath(this.get_move_list());
    newPath._requiredDelay = this._requiredDelay;
    newPath._econ_value = this._econ_value;
    newPath.value = this.value;
    return newPath;
  };

  M.pathMoves = function () {
    var out = [];
    for (var i = 0; i < this._pathQueue.length; i++) {
      var move = this._pathQueue[i];
      if (move === null || move === undefined) {
        out.push(null);
      } else {
        out.push(new PathMove(move.source, new PathMove(move.dest, null, null, false), null, move.move_half));
      }
    }
    return out;
  };

  M.toString = function () {
    var nodeStrs = [];
    var last = null;
    for (var i = 0; i < this._pathQueue.length; i++) {
      var move = this._pathQueue[i];
      if (move === null || move === undefined) {
        nodeStrs.push('  None');
        continue;
      }
      if (move.source !== last) {
        nodeStrs.push(
          '  ' + move.source.x + ',' + move.source.y + '->' + move.dest.x + ',' + move.dest.y + (move.move_half ? 'z' : '')
        );
      } else {
        nodeStrs.push('->' + move.dest.x + ',' + move.dest.y + (move.move_half ? 'z' : ''));
      }
      last = move.dest;
    }
    var valStr = '';
    if (this._econ_value !== 0.0) valStr = ' ' + this._econ_value.toFixed(2) + 'v';
    return '[' + this.value + 'a' + valStr + ' ' + this.length + 't]' + nodeStrs.join('');
  };

  if (typeof Symbol !== 'undefined' && Symbol.iterator) {
    M[Symbol.iterator] = function () {
      return this.pathMoves()[Symbol.iterator]();
    };
  }

  EK.PathMove = PathMove;
  EK.MoveBase = MoveBase;
  EK.Move = Move;
  EK.Path = Path;
  EK.WaitPath = WaitPath;
  EK.MoveListPath = MoveListPath;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

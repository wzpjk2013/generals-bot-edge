/*
 * EklipZ / Human.exe 的 Tile —— 逐行移植自 generals-bot 的 base/client/tile.py。
 *
 * 这不是「参考它的思路」，是把它的状态机搬过来：TileDelta 的每一个字段、
 * update() 里 armyDelta 的每一处 expectedDelta 扣减、player setter 里那个
 * 「neutral 0 兵且可通行就退回 TILE_EMPTY」的小动作，都必须一模一样。
 * 否则迷雾下的兵数推断会一格一格地漂，最后决策树整棵歪掉。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var TILE_EMPTY = -1;
  var TILE_MOUNTAIN = -2;
  var TILE_FOG = -3;
  var TILE_OBSTACLE = -4;
  var TILE_LOOKOUT = -5;
  var TILE_OBSERVATORY = -6;
  var MOUNTAIN_TILES = [TILE_LOOKOUT, TILE_MOUNTAIN, TILE_OBSERVATORY];

  var PLAYER_CHARS = 'abcdefghijklmnop';

  var T = {
    EMPTY: TILE_EMPTY,
    MOUNTAIN: TILE_MOUNTAIN,
    FOG: TILE_FOG,
    OBSTACLE: TILE_OBSTACLE,
    LOOKOUT: TILE_LOOKOUT,
    OBSERVATORY: TILE_OBSERVATORY
  };

  function inMountainTiles(v) {
    return v === TILE_LOOKOUT || v === TILE_MOUNTAIN || v === TILE_OBSERVATORY;
  }

  function TileDelta() {
    this.oldArmy = 0;
    this.oldOwner = -1;
    this.newOwner = -1;
    this.gainedSight = false;
    this.lostSight = false;
    this.discovered = false;
    this.imperfectArmyDelta = false;
    this.friendlyCaptured = false;
    this.armyDelta = 0;
    this.unexplainedDelta = 0;
    this.fromTile = null;
    this.toTile = null;
    this.armyMovedHere = false;
    this.expectedDelta = 0;
    this.discoveredExGeneralCity = false;
  }

  var PATHABLE_CITY_THRESHOLD = 10;

  function Tile(x, y, tile, army, isCity, isGeneral, player, isMountain, turnCapped, tileIndex) {
    this.x = x;
    this.y = y;
    this.tile = tile === undefined ? TILE_EMPTY : tile;
    this.turn_captured = turnCapped || 0;
    this.army = army || 0;
    this.isCity = !!isCity;
    this.isSwamp = false;
    this.isDesert = false;
    this.isGeneral = !!isGeneral;
    this.isTempFogPrediction = false;
    this._player = -1;
    if (player !== undefined && player !== null) this._player = player;
    else if (this.tile >= 0) this._player = this.tile;
    this.visible = false;
    this.discovered = false;
    this.discoveredAsNeutral = false;
    this.lastSeen = -1;
    this.lastMovedTurn = -1;
    this.isMountain = !!isMountain;
    this.isObservatory = false;
    this.isLookout = false;
    this.delta = new TileDelta();
    this.adjacents = [];
    this.visibleTo = [];
    this.movable = [];
    this.overridePathable = null;
    this.tile_index = tileIndex === undefined ? -1 : tileIndex;
    this._recalc_derived();
  }

  Tile.PATHABLE_CITY_THRESHOLD = PATHABLE_CITY_THRESHOLD;
  Tile.TILE_EMPTY = TILE_EMPTY;
  Tile.TILE_MOUNTAIN = TILE_MOUNTAIN;
  Tile.TILE_FOG = TILE_FOG;
  Tile.TILE_OBSTACLE = TILE_OBSTACLE;

  Tile.prototype._recalc_derived = function () {
    this.isNeutral = this._player === -1;
    var undiscObs =
      this.tile === TILE_OBSTACLE && !this.discovered && !this.isCity && !this.isMountain;
    this.isUndiscoveredObstacle = undiscObs;
    var notPathable;
    if (this.overridePathable !== null) notPathable = !this.overridePathable;
    else notPathable = this.isMountain || undiscObs;
    this.isNotPathable = notPathable;
    this.isPathable = !notPathable;
    var costly = this.isNeutral && this.army > Tile.PATHABLE_CITY_THRESHOLD;
    this.isCostlyNeutral = costly;
    this.isCostlyNeutralCity = this.isCity && costly;
    this.isObstacle = this.isMountain || undiscObs || costly;
  };

  Tile.prototype.player = function () {
    return this._player;
  };

  /*
   * player setter（tile.py:446）。注意两个隐藏副作用：
   *   1) 看不见的格可见时同步把 tile 写成玩家号；
   *   2) 变成 neutral 且 0 兵、不是城/山/不可通行时，tile 退回 TILE_EMPTY。
   * 后者看着莫名其妙，但 delta 推断依赖它。
   */
  Tile.prototype.setPlayer = function (value) {
    if (this.isGeneral && this._player !== value && this._player !== -1) {
      throw new Error('trying to set general tile ' + this + ' player from ' + this._player + ' to ' + value);
    }
    if (value >= 0 && this.visible) this.tile = value;
    var isNotPathable =
      this.isMountain ||
      (this.tile === TILE_OBSTACLE && !this.discovered && !this.isCity && !this.isMountain);
    if (this.overridePathable !== null) isNotPathable = !this.overridePathable;
    else if (value === -1 && this.army === 0 && !isNotPathable && !this.isCity && !this.isMountain)
      this.tile = TILE_EMPTY;
    this._player = value;
    this._recalc_derived();
  };

  Tile.prototype.movableNoObstacles = function () {
    var out = [];
    for (var i = 0; i < this.movable.length; i++) if (!this.movable[i].isObstacle) out.push(this.movable[i]);
    return out;
  };

  Tile.prototype.coords = function () {
    return [this.x, this.y];
  };

  Tile.prototype.was_not_visible_last_turn = function () {
    return this.delta.gainedSight || (!this.visible && !this.delta.lostSight);
  };

  Tile.prototype.was_visible_last_turn = function () {
    return this.delta.lostSight || (this.visible && !this.delta.gainedSight);
  };

  Tile.prototype.toString = function () {
    return this.x + ',' + this.y;
  };

  Tile.prototype.convert_player_to_char = function (player) {
    if (player === -1) return 'N';
    return PLAYER_CHARS[player] || '?';
  };

  Tile.prototype.get_value_representation = function () {
    var out = [];
    if (this._player >= 0) out.push(this.convert_player_to_char(this._player));
    if (this.isCity) out.push('C');
    if (this.isLookout) out.push('L');
    else if (this.isObservatory) out.push('O');
    else if (this.isSwamp) out.push('S');
    else if (this.isDesert) out.push('E');
    else if (this.isMountain || (!this.visible && this.isNotPathable)) out.push('M');
    if (this.isGeneral) out.push('G');
    if (this.army !== 0 || this._player >= 0) {
      if (this._player === -1 && !this.isCity) out.push('N');
      out.push(String(this.army));
    }
    if (this.discovered && !this.visible) out.push('D');
    return out.join('');
  };

  /* tile.py:590 —— 每回合的原始状态吸收 + delta 计算 */
  Tile.prototype.update = function (map, tile, army, isCity, isGeneral, overridePlayer) {
    var d = new TileDelta();
    this.delta = d;
    d.oldArmy = this.army;
    var wasObstacle = this.isObstacle;
    if (!this.visible) d.imperfectArmyDelta = true;
    if (tile >= TILE_MOUNTAIN) {
      this.isTempFogPrediction = false;
      if (!this.discovered) {
        this.discovered = true;
        d.discovered = true;
        if (tile === TILE_EMPTY && !this.isSwamp) this.discoveredAsNeutral = true;
      }
      if (this.isGeneral && !isGeneral) this.isGeneral = false;
      this.lastSeen = map.turn;
      if (!this.visible) {
        d.gainedSight = true;
        this.visible = true;
      }
    }

    var armyMovedHere = false;
    d.oldOwner = this._player;

    if (this.tile !== tile) {
      if (tile < TILE_MOUNTAIN && this.discovered && tile !== TILE_LOOKOUT && tile !== TILE_OBSERVATORY) {
        if (this.visible) d.lostSight = true;
        this.visible = false;
        this.lastSeen = map.turn - 1;
        if (this._player === map.player_index || map.teammates.has(this._player)) {
          d.friendlyCaptured = true;
          armyMovedHere = true;
          this._player = -1;
        }
      } else if (tile >= TILE_EMPTY) {
        this._player = tile;
      }
      this.tile = tile;
    }

    if (inMountainTiles(tile)) {
      if (!this.isMountain) {
        for (var mi = 0; mi < this.movable.length; mi++) {
          var mv = this.movable[mi];
          var at = mv.movable.indexOf(this);
          if (at >= 0) mv.movable.splice(at, 1);
        }
        this.isMountain = true;
      }
      if (tile === TILE_LOOKOUT) this.isLookout = true;
      else if (tile === TILE_OBSERVATORY) this.isObservatory = true;
      if (this._player !== -1 || this.isCity || this.army !== 0) {
        this.isCity = false;
        this.army = 0;
        this.setPlayer(-1);
      }
    }

    if (tile >= TILE_EMPTY) {
      var expectedDelta = 0;
      if ((this.isCity || this.isGeneral) && this._player >= 0 && map.is_city_bonus_turn) expectedDelta += 1;
      if (this._player >= 0 && map.is_army_bonus_turn) expectedDelta += 1;
      d.expectedDelta = expectedDelta;
    }

    d.newOwner = this._player;
    if (overridePlayer !== undefined && overridePlayer !== null) {
      d.newOwner = overridePlayer;
      this._player = overridePlayer;
    }

    if (this.visible) {
      var oldArmy = this.army;
      this.army = army;
      if (d.oldOwner !== d.newOwner) {
        // 占领发生在加兵之前，所以新主人吃到那 1 点 expectedDelta
        d.armyDelta = 0 - (this.army + oldArmy - d.expectedDelta);
      } else {
        d.armyDelta = this.army - (oldArmy + d.expectedDelta);
      }
      if (d.armyDelta !== 0) armyMovedHere = true;
    }

    if (isCity && !this.isCity) {
      this.isCity = true;
      if (!wasObstacle) d.discoveredExGeneralCity = true;
    } else if (isGeneral) {
      this.isGeneral = true;
    }

    if (d.oldOwner !== d.newOwner) armyMovedHere = true;

    if (inMountainTiles(tile) || (tile === TILE_EMPTY && isCity && d.gainedSight)) {
      armyMovedHere = false;
      if (inMountainTiles(tile) || army > 38) {
        d.imperfectArmyDelta = false;
        d.armyDelta = 0;
        d.unexplainedDelta = 0;
      }
    }

    d.armyMovedHere = armyMovedHere;
    if (armyMovedHere) this.lastMovedTurn = map.turn;
    if (!this.visible) d.imperfectArmyDelta = true;
    d.unexplainedDelta = d.armyDelta;

    this._recalc_derived();
    return armyMovedHere;
  };

  Tile.prototype.set_disconnected_neutral = function () {
    if (this.visible) throw new Error('Trying to set visible disconnected neutral tile ' + this);
    this._player = -1;
    this.tile = TILE_FOG;
    if (!this.discovered && this.isCity) {
      this.tile = TILE_OBSTACLE;
      this.isCity = false;
      this.army = 0;
    }
    if (this.isGeneral) {
      this.isGeneral = false;
      this.isCity = true;
    }
    this._recalc_derived();
  };

  Tile.prototype.reset_wrong_undiscovered_fog_guess = function () {
    if (this.isCity) {
      this.tile = TILE_OBSTACLE;
      this.isCity = false;
    } else {
      this.tile = TILE_FOG;
    }
    this.isTempFogPrediction = false;
    this.army = 0;
    this._player = -1;
    this.isGeneral = false;
    this.delta = new TileDelta();
    this._recalc_derived();
  };

  Tile.get_move_half_amount = function (army) {
    return Math.floor(army / 2);
  };

  EK.Tile = Tile;
  EK.TileDelta = TileDelta;
  EK.TILE = T;
  EK.MOUNTAIN_TILES = MOUNTAIN_TILES;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

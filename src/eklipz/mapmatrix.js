/*
 * MapMatrix / MapMatrixSet —— 移植自 generals-bot/MapMatrix.py。
 *
 * 原版用「tile_index 索引的平表」代替 dict，是为性能；这里保持同样的语义，
 * 因为一堆调用点靠 raw 直接读写（distance_mapper 之类），换成 Map 会走样。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function MapMatrix(map, initVal) {
    this.empty_val = initVal === undefined ? null : initVal;
    this.raw = map ? new Array(map.cols * map.rows).fill(this.empty_val) : null;
    this.map = map || null;
  }

  MapMatrix.prototype.add = function (tile, value) {
    this.raw[tile.tile_index] = value === undefined ? true : value;
  };
  MapMatrix.prototype.add_if_not_in = function (tile, value) {
    if (this.raw[tile.tile_index] === this.empty_val) {
      this.raw[tile.tile_index] = value === undefined ? true : value;
      return true;
    }
    return false;
  };
  MapMatrix.prototype.set = function (tile, value) {
    this.raw[tile.tile_index] = value;
  };
  MapMatrix.prototype.get = function (tile, dflt) {
    var v = this.raw[tile.tile_index];
    return v === this.empty_val ? (dflt === undefined ? null : dflt) : v;
  };
  MapMatrix.prototype.has = function (tile) {
    return this.raw[tile.tile_index] !== this.empty_val;
  };
  MapMatrix.prototype.discard = function (tile) {
    this.raw[tile.tile_index] = this.empty_val;
  };
  MapMatrix.prototype.keys = function () {
    var out = [];
    for (var i = 0; i < this.raw.length; i++) if (this.raw[i] !== this.empty_val) out.push(this.map.tiles_by_index[i]);
    return out;
  };
  MapMatrix.prototype.values = function () {
    var out = [];
    for (var i = 0; i < this.raw.length; i++) if (this.raw[i] !== this.empty_val) out.push(this.raw[i]);
    return out;
  };
  MapMatrix.prototype.copy = function () {
    var m = new MapMatrix(null, this.empty_val);
    m.map = this.map;
    m.raw = this.raw.slice();
    return m;
  };
  MapMatrix.prototype.negate_in_place = function () {
    for (var i = 0; i < this.raw.length; i++) this.raw[i] = 0 - this.raw[i];
  };
  MapMatrix.prototype.copy_negated = function () {
    var m = new MapMatrix(null, this.empty_val);
    m.map = this.map;
    m.raw = [];
    for (var i = 0; i < this.raw.length; i++) m.raw.push(0 - this.raw[i]);
    return m;
  };
  MapMatrix.get_summed = function (matrices) {
    var out = matrices[0].copy();
    for (var k = 1; k < matrices.length; k++) {
      var r = matrices[k].raw;
      for (var i = 0; i < r.length; i++) out.raw[i] += r[i];
    }
    return out;
  };
  MapMatrix.add_to_matrix = function (target, add) {
    for (var i = 0; i < add.raw.length; i++) target.raw[i] += add.raw[i];
  };
  MapMatrix.subtract_from_matrix = function (target, sub) {
    for (var i = 0; i < sub.raw.length; i++) target.raw[i] -= sub.raw[i];
  };

  function MapMatrixSet(map, fromIterable) {
    this.raw = map ? new Array(map.cols * map.rows).fill(false) : null;
    this.map = map || null;
    if (fromIterable) for (var i = 0; i < fromIterable.length; i++) this.raw[fromIterable[i].tile_index] = true;
  }
  MapMatrixSet.prototype.add = function (t) {
    this.raw[t.tile_index] = true;
  };
  MapMatrixSet.prototype.add_check = function (t) {
    if (!this.raw[t.tile_index]) {
      this.raw[t.tile_index] = true;
      return true;
    }
    return false;
  };
  MapMatrixSet.prototype.has = function (t) {
    return this.raw[t.tile_index];
  };
  MapMatrixSet.prototype.discard = function (t) {
    this.raw[t.tile_index] = false;
  };
  MapMatrixSet.prototype.discard_check = function (t) {
    if (this.raw[t.tile_index]) {
      this.raw[t.tile_index] = false;
      return true;
    }
    return false;
  };
  MapMatrixSet.prototype.update = function (tiles) {
    for (var i = 0; i < tiles.length; i++) this.raw[tiles[i].tile_index] = true;
  };
  MapMatrixSet.prototype.toTiles = function () {
    var out = [];
    for (var i = 0; i < this.raw.length; i++) if (this.raw[i]) out.push(this.map.tiles_by_index[i]);
    return out;
  };
  MapMatrixSet.prototype.copy = function () {
    var m = new MapMatrixSet(null);
    m.map = this.map;
    m.raw = this.raw.slice();
    return m;
  };

  EK.MapMatrix = MapMatrix;
  EK.MapMatrixSet = MapMatrixSet;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

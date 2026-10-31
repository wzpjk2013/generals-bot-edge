/*
 * 对局状态重建。
 *
 * 服务端下发的地图是「串行化数组」：
 *   [w, h, armies(0..n-1), terrain(0..n-1), tunnelLimits(0..n-1)]
 * 只有第一次给全量，之后给 delta：成对的 (相同个数, 变化个数, ...变化值)。
 * 官方前端自己维护 last_map 做增量还原，这里复刻同一套，不改客户端状态。
 */
(function () {
  'use strict';

  var GB = (window.__GB = window.__GB || {});

  // 官方前端常量（取自 bundle：s.TILE_EMPTY=-1 ... s.TILE_OBSERVATORY=-6）
  var TILE = {
    EMPTY: -1,
    MOUNTAIN: -2,
    FOG: -3,
    FOG_OBSTACLE: -4,
    LOOKOUT: -5,
    OBSERVATORY: -6
  };
  GB.TILE = TILE;

  /**
   * 还原 generals.io 的增量数组编码。
   * diff = [same0, changed0, v..., same1, changed1, v..., ...]
   *
   * old 允许为空。服务器发的是
   *   t.map_diff = a.delta(n.last_map, d)
   * 而 delta 的约定是：
   *   y.delta = function (t, e) { if (!t || t.length !== e.length) return [0, e.length].concat(e); ... }
   * 也就是**第一帧的 diff 本身就是全量编码**：game_start 里根本没有 map
   * （服务器是 t.emit("game_start", {playerIndex, usernames, teams, game_type, options, ...})）。
   *
   * 所以 old 为空时必须按「空数组」去 patch，别把它当坏包丢掉——丢一包就永远 ready 不了，
   * 面板上表现为「事件一直在涨、决策一直是 0、状态停在未开局」。
   */
  function patchArray(old, diff) {
    if (!diff || !diff.length) return null;
    var base = old || [];
    var out = [];
    var r = 0;
    while (r < diff.length) {
      var same = diff[r] | 0;
      for (var k = 0; k < same; k++) out.push(base[out.length]);
      r += 1;
      if (r < diff.length && diff[r]) {
        var changed = diff[r] | 0;
        for (var c = 0; c < changed; c++) out.push(diff[r + 1 + c]);
        r += changed;
      }
      r += 1;
    }
    return out;
  }

  function GameState() {
    this.reset();
  }

  GameState.prototype.reset = function () {
    this.started = false;
    this.ready = false;
    this.ended = false;
    this.w = 0;
    this.h = 0;
    this.n = 0;
    this.armies = new Int32Array(0);
    this.terrain = new Int16Array(0);
    this.playerIndex = -1;
    this.turn = 0;
    this.generals = [];
    this.cities = [];
    // 服务器每帧都发 scores（所有玩家的真实总分/地数/死活），引擎的胜率判断全靠它：
    // 自己用迷雾算只能算到自己看得见的格子，会把对手低估成 0。
    this.scores = null;
    this.teams = [];
    this.usernames = [];
    this.gameType = '';
    this.raw = null; // 完整串行化地图，增量还原要用
    this.rawCities = null;
    this.badDiff = 0; // 收到但解不开的增量包数量（正常必须一直是 0）
    this._nbr = null;
    this.lastEvent = 0;
  };

  GameState.prototype.setRaw = function (arr) {
    var n = (arr[0] | 0) * (arr[1] | 0);
    if (!(arr[0] > 0 && arr[1] > 0) || arr.length < 2 + 2 * n) return false;
    if (this.n !== n) this._nbr = null;
    this.w = arr[0] | 0;
    this.h = arr[1] | 0;
    this.n = n;
    this.raw = arr;
    this.armies = Int32Array.from(arr.slice(2, 2 + n));
    this.terrain = Int16Array.from(arr.slice(2 + n, 2 + 2 * n));
    this.ready = true;
    return true;
  };

  GameState.prototype.applyStart = function (msg) {
    this.reset();
    this.started = true;
    this.lastEvent = Date.now();
    if (msg && Number.isInteger(msg.playerIndex)) this.playerIndex = msg.playerIndex;
    if (msg && Array.isArray(msg.usernames)) this.usernames = msg.usernames.slice();
    if (msg && Array.isArray(msg.teams)) this.teams = msg.teams.slice();
    if (msg && Array.isArray(msg.generals)) this.generals = msg.generals.slice();
    if (msg && Array.isArray(msg.scores)) this.scores = msg.scores.slice();
    if (msg && Array.isArray(msg.cities)) {
      this.cities = msg.cities.slice();
      this.rawCities = this.cities.slice();
    }
    var gt = (msg && (msg.game_type || msg.type)) || (msg && msg.options && msg.options.game_type) || '';
    this.gameType = String(gt).toLowerCase();
    if (msg && Array.isArray(msg.map)) this.setRaw(msg.map.slice());
    if (msg && Number.isInteger(msg.turn)) this.turn = msg.turn;
  };

  GameState.prototype.applyUpdate = function (msg) {
    if (!msg) return;
    if (!this.started) this.applyStart(msg);
    this.lastEvent = Date.now();

    if (Number.isInteger(msg.playerIndex)) this.playerIndex = msg.playerIndex;
    if (Number.isInteger(msg.turn)) this.turn = msg.turn;
    if (Array.isArray(msg.usernames)) this.usernames = msg.usernames.slice();
    if (Array.isArray(msg.generals)) this.generals = msg.generals.slice();
    if (Array.isArray(msg.scores)) this.scores = msg.scores.slice();
    if (msg.ended || msg.game_over) this.ended = true;

    if (Array.isArray(msg.map)) {
      this.setRaw(msg.map.slice());
    } else if (Array.isArray(msg.map_diff)) {
      // 首帧没有 base（game_start 不带 map），patchArray 按空数组处理全量编码
      var next = patchArray(this.raw, msg.map_diff);
      if (!next || !(next[0] > 0)) {
        this.badDiff = (this.badDiff || 0) + 1;
        return;
      }
      this.setRaw(next);
    }

    if (Array.isArray(msg.cities)) {
      this.cities = msg.cities.slice();
      this.rawCities = this.cities.slice();
    } else if (Array.isArray(msg.cities_diff)) {
      var cities = patchArray(this.rawCities, msg.cities_diff);
      if (cities) {
        this.cities = cities;
        this.rawCities = cities.slice();
      }
    }
  };

  GameState.prototype.end = function () {
    this.ended = true;
  };

  GB.GameState = GameState;
  GB.patchArray = patchArray;
})();

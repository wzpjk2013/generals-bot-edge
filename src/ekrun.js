/*
 * EklipZ 移植版引擎（src/eklipz/*）的对局驱动。
 *
 * 为什么要有这一层：eklipz 那一整套是 generals.io 官方客户端的 Python 实现
 * （base/client/map.py）逐行搬过来的，它吃的是服务器串行化数组 + 增量补丁，
 * 而不是我们自己的 state.js 结构。所以这里做两件事：
 *   1. 把 GB.GameState 还原出来的整幅地图重新编成服务器包（map_diff / cities_diff /
 *      generals / scores）。全量编码 [0, len, ...values] 是协议自带的写法，效果等价于
 *      增量，因为我们每回合本来就拿到了完整数组；
 *   2. 让 Map / Bot 跨回合活着 —— ArmyTracker 的迷雾推断、OpponentTracker 的循环
 *      统计都是跨回合累积的，每回合新建一个 Bot 会把这些全丢掉（线上表现是四处乱走）。
 *
 * 出招结果按 hook.js 的约定返回 [[fromIdx, toIdx, isHalf]]。
 */
(function () {
  'use strict';

  var GB = (window.__GB = window.__GB || {});
  var root = typeof window !== 'undefined' ? window : globalThis;

  function fullDiff(values) {
    return [0, values.length].concat(values);
  }

  function playerCount(S) {
    var n = 0;
    if (S.usernames && S.usernames.length > n) n = S.usernames.length;
    if (S.teams && S.teams.length > n) n = S.teams.length;
    if (S.generals && S.generals.length > n) n = S.generals.length;
    return n || 2;
  }

  function scoresFor(S) {
    var pc = playerCount(S);
    // 服务器每帧都发 scores（真实总分/地数/死活）。优先用它：只用自己看得见的
    // 格子去统计会把对手低估成 0，胜率判断直接反着走（引擎会以为自己经济领先）。
    if (S.scores && S.scores.length) {
      var byI = {};
      var j;
      for (j = 0; j < S.scores.length; j++) byI[S.scores[j].i] = S.scores[j];
      var res = [];
      for (j = 0; j < pc; j++) {
        var s = byI[j];
        if (!s) { res.push({ i: j, total: 0, tiles: 0, dead: true }); continue; }
        res.push({ i: j, total: s.total | 0, tiles: s.tiles | 0, dead: !!s.dead });
      }
      return res;
    }
    var tiles = new Array(pc);
    var total = new Array(pc);
    var i;
    for (i = 0; i < pc; i++) { tiles[i] = 0; total[i] = 0; }
    var n = S.n;
    for (i = 0; i < n; i++) {
      var t = S.terrain[i];
      if (t < 0 || t >= pc) continue;
      tiles[t] += 1;
      total[t] += S.armies[i] | 0;
    }
    var out = [];
    for (i = 0; i < pc; i++) {
      // 原版判死是「将军格不再属于自己」；拿不到将军位时退化成「一格地都没有」。
      var dead = true;
      if (S.generals && S.generals[i] >= 0 && S.generals[i] !== undefined && S.terrain[S.generals[i]] === i) dead = false;
      else if (tiles[i] > 0) dead = false;
      out.push({ i: i, total: total[i], tiles: tiles[i], dead: dead });
    }
    return out;
  }

  function packetFor(S) {
    var n = S.n;
    var mapArr = new Array(2 + 2 * n);
    mapArr[0] = S.w;
    mapArr[1] = S.h;
    var i;
    for (i = 0; i < n; i++) {
      mapArr[2 + i] = S.armies[i] | 0;
      mapArr[2 + n + i] = S.terrain[i] | 0;
    }
    return {
      turn: S.turn | 0,
      map_diff: fullDiff(mapArr),
      cities_diff: fullDiff(S.cities || []),
      deserts_diff: fullDiff([]),
      generals: S.generals || [],
      scores: scoresFor(S),
      stars: []
    };
  }

  function startDataFor(S) {
    var pc = playerCount(S);
    var unames = [];
    var i;
    for (i = 0; i < pc; i++) unames.push((S.usernames && S.usernames[i]) || ('p' + i));
    var teams = (S.teams && S.teams.length) ? S.teams.slice() : null;
    // 1v1 / FFA 没给 teams 时原版 Map 自己按「各队 = 自己」建；给 null 让它走默认。
    var mods = (S.options && S.options.modifiers) || [];
    return {
      playerIndex: S.playerIndex | 0,
      usernames: unames,
      teams: teams,
      playerColors: [],
      replay_id: 'live_' + (S.turn | 0),
      game_type: S.gameType || 'custom',
      options: { modifiers: mods }
    };
  }

  /* 从异常栈里挑出第一帧 eklipz 的源码位置：真机报错只给一行 message，看不出是哪一行。 */
  function firstEkFrame(stack) {
    if (!stack) return '';
    var lines = String(stack).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /eklipz\/[A-Za-z0-9_.-]+\.js:\d+:\d+/.exec(lines[i]);
      if (m) return m[0];
    }
    return (lines[1] || '').trim().slice(0, 80);
  }

  function EkEngine() {
    this.map = null;
    this.bot = null;
    this.started = false;
    this.errors = 0;
    this.lastError = '';
    this.lastStack = '';
    this.lastMoveMs = 0;
    this.turns = 0;
  }

  EkEngine.prototype.reset = function () {
    this.map = null;
    this.bot = null;
    this.started = false;
    this.lastError = '';
    this.lastStack = '';
    this.lastMoveMs = 0;
    this.turns = 0;
  };

  EkEngine.prototype.ready = function () {
    return !!(root.__EK && root.__EK.Map && root.__EK.Bot);
  };

  EkEngine.prototype.plan = function (S) {
    if (!S || !S.ready || S.playerIndex < 0 || S.ended) return [];
    var EK = root.__EK;
    if (!EK || !EK.Map || !EK.Bot) {
      this.lastError = 'eklipz 模块没加载完';
      return [];
    }
    var packet = packetFor(S);
    try {
      if (!this.started) {
        var startData = startDataFor(S);
        this.map = new EK.Map(startData, packet, { shuffle: false });
        // 原版 Map.__init__(start_data, data) 已经吞过首包一次，这里补第二次与之一致
        // （scripts/ekjs.js / eklump 的对拍都是这个口径，差一格就会让迷雾推断错位）。
        this.map.apply_server_update(packet);
        this.bot = new EK.Bot(startData);
        this.bot.initialize_from_map_for_first_time(this.map);
        this.started = true;
        if (EK.Bot.resetMissingReport) EK.Bot.resetMissingReport();
      } else {
        this.map.apply_server_update(packet);
      }
    } catch (e) {
      // 地图层吃不下的包（例如自己上一手没生效导致 delta 对不上）就让这一回合空过，
      // 并把整局引擎重建 —— 带着错位的内部状态继续走只会越走越歪。
      this.errors += 1;
      this.lastError = 'map: ' + ((e && e.message) || e);
      this.reset();
      return [];
    }

    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var move = null;
    try {
      this.bot.perf_timer.record_update(this.map.turn, t0);
      move = this.bot.find_move();
    } catch (e) {
      this.errors += 1;
      this.lastError = 'move: ' + ((e && e.message) || e);
      this.lastStack = (e && e.stack) || '';
      // 只在第一次打印整条栈：真机面板放不下栈，控制台里留一份给用户复制。
      if (this.errors === 1 && root.console && root.console.error) {
        root.console.error('[GBAuto] ek 引擎异常（T' + this.map.turn + '）', e);
      }
      move = null;
    }
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.lastMoveMs = Math.round(t1 - t0);
    this.turns += 1;
    // 原版只会回 None；出现 undefined 说明某条分支 return 漏了值，
    // 这种 undefined 会一路写进 history.move_history 并把重复出招检测搞崩。
    if (move === undefined) this.undefMoves = (this.undefMoves || 0) + 1;

    if (move && move.source && move.dest) {
      return [[move.source.tile_index, move.dest.tile_index, !!move.move_half]];
    }
    return [];
  };

  EkEngine.prototype.stats = function () {
    return {
      started: this.started,
      errors: this.errors,
      undefMoves: this.undefMoves || 0,
      lastError: this.lastError,
      lastFrame: firstEkFrame(this.lastStack),
      ms: this.lastMoveMs,
      turns: this.turns,
      missing: (root.__EK && root.__EK.Bot && root.__EK.Bot.missingReport) ? root.__EK.Bot.missingReport() : {}
    };
  };

  GB.EkEngine = EkEngine;
  GB.ekbot = new EkEngine();
})();

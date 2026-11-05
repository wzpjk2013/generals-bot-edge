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

  /* 连续这么多次接不住包才重建引擎（见 plan() 里 map 异常那段）。 */
  var MAP_ERR_RESET_LIMIT = 30;

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
    // 按「错误种类 + 文件:行」分组计数：真机上一次崩溃和一次的根因往往不是同一处，
    // 只留最后一条会把先发生的那条冲掉。
    this.errKinds = {};
    this.errFirst = null;
    // 真机上的崩溃本地复现不出来时，唯一可靠的办法是把「喂给引擎的全部原始包」录下来，
    // 拿回 Node 里 1:1 重放。这里只存原始 packet，不做任何加工，重放脚本 scripts/ekreplay.js。
    this.startData = null;
    this.packets = [];
  }

  /*
   * 记一次异常，并把「第一次出现的那条」固化下来。
   *
   * 真机面板只有一行、会被 CSS 截断，所以把 file:line 提到消息最前面，用户截图就能
   * 直接定位；完整栈放进 window.__GB_ERR 供 F12 里 copy(JSON.stringify(__GB_ERR)) 取走。
   */
  EkEngine.prototype.noteError = function (kind, e) {
    var msg = (e && e.message) || String(e);
    var stack = (e && e.stack) || '';
    var frame = firstEkFrame(stack);
    var key = kind + ' @ ' + (frame || '?') + ' :: ' + msg;
    this.errKinds[key] = (this.errKinds[key] || 0) + 1;
    if (!this.errFirst) {
      this.errFirst = {
        kind: kind,
        turn: this.map ? this.map.turn : -1,
        msg: msg,
        frame: frame,
        stack: stack
      };
    }
    root.__GB_ERR = {
      kind: kind,
      turn: this.map ? this.map.turn : -1,
      msg: msg,
      frame: frame,
      stack: stack,
      kinds: this.errKinds,
      count: this.errors
    };
    // 每种「种类+位置」只在第一次打印整条栈，避免每回合刷屏把控制台淹掉。
    if (this.errKinds[key] === 1 && root.console && root.console.error) {
      root.console.error(
        '[GBAuto] ek 引擎异常（' + kind + '，T' + (this.map ? this.map.turn : -1) + '，' + (frame || '无栈') + '）',
        e
      );
    }
  };

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
    // 录制：真机崩溃拿不到栈时，用户可以 copy(__GB_DUMP()) 把整局原始包交给本地重放。
    if (!this.startData) {
      try { this.startData = startDataFor(S); } catch (e0) { this.startData = null; }
    }
    if (this.packets.length < 600) this.packets.push(packet);
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
      /*
       * 地图层吃不下的包（自己上一手没生效导致 delta 对不上、FFA 里从雾推断归属失败……）。
       *
       * 以前这里直接 `reset()` 把整局拆了重建。那在 FFA 里是致命的：只要某种包每回合都让
       * map.apply_server_update 抛一次，引擎就会「每回合重新开局」，面板永远停在回合 0、
       * 一步不出（真机 FFA 卡死就是这么来的）。原版 Python 不会这么做——异常被
       * `make_move(rethrow=False)` 吞掉，这一回合空过，地图状态继续往前走。
       *
       * 现在的口径：本回合空过、状态保留；只有**连续** MAP_ERR_RESET_LIMIT 次接不住包，
       * 才认定内部状态真的坏了并重建。
       */
      this.errors += 1;
      this.mapErrRun = (this.mapErrRun || 0) + 1;
      this.lastError = 'map: ' + ((e && e.message) || e);
      this.lastStack = (e && e.stack) || '';
      this.noteError('map', e);
      if (this.mapErrRun >= MAP_ERR_RESET_LIMIT || !this.started || !this.bot) {
        this.reset();
        return [];
      }
      /*
       * 接不住这一包也不许摆烂：原版是被 `make_move(rethrow=False)` 吞掉后「这一回合不出招」，
       * 但真机上「不出招」在 FFA 里就表现为整局一动不动。所以这里改成拿**上一回合的地图状态**
       * 继续出招（地图旧一回合，比完全不动强得多；出不了合法招时服务器本来也会忽略）。
       */
      this.staleMapMoves = (this.staleMapMoves || 0) + 1;
      var staleMove = null;
      try {
        staleMove = this.bot.find_move();
      } catch (e2) {
        this.errors += 1;
        this.lastError = 'move: ' + ((e2 && e2.message) || e2);
        this.lastStack = (e2 && e2.stack) || '';
        this.noteError('move', e2);
      }
      if (staleMove && staleMove.source && staleMove.dest) {
        return [[staleMove.source.tile_index, staleMove.dest.tile_index, !!staleMove.move_half]];
      }
      return [];
    }
    this.mapErrRun = 0;

    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var move = null;
    try {
      this.bot.perf_timer.record_update(this.map.turn, t0);
      move = this.bot.find_move();
    } catch (e) {
      this.errors += 1;
      this.lastError = 'move: ' + ((e && e.message) || e);
      this.lastStack = (e && e.stack) || '';
      this.noteError('move', e);
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
      errKinds: this.errKinds,
      errFirst: this.errFirst,
      ms: this.lastMoveMs,
      turns: this.turns,
      missing: (root.__EK && root.__EK.Bot && root.__EK.Bot.missingReport) ? root.__EK.Bot.missingReport() : {}
    };
  };

  GB.EkEngine = EkEngine;
  GB.ekbot = new EkEngine();
  /*
   * 真机调试出口：在 F12 里 `copy(__GB_DUMP())` 就能把这局「开局参数 + 全部原始包」
   * 复制走，落到文件后用 `node scripts/ekreplay.js <文件>` 1:1 重放，栈和状态都在本地。
   */
  root.__GB_DUMP = function () {
    var e = root.__GB_ERR || null;
    return JSON.stringify({
      startData: GB.ekbot.startData,
      packets: GB.ekbot.packets,
      err: e
    });
  };
})();

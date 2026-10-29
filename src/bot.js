/*
 * 决策引擎。
 *
 * 参考实现（同一套 generals.io 状态机，不同宿主）：
 *   strakam/generals-bots  agents/hunter_agent.py   守家 + 输兵 + 斩首
 *   strakam/generals-bots  agents/expander_agent.py 边境吃掉一切能吃的
 *   vzhou842/generals.io-Node.js-Bot-example        地图/增量协议
 *
 * 这里把它们缝成一个每回合多次出子的计划器：
 *
 *   A. 斩首     贴脸敌将且打得过 → 直接吃，结束对局
 *   B. 守将     将军被贴脸且打不过 → 反打 / 邻居代打 / 并兵
 *   C. 扩张     全图 Dijkstra：cost = 沿路累计（守军+1），按 价值/代价^0.85 选目标，
 *               沿 prev 链一次推进最多 4 步，重复到预算用完
 *   D. 输兵     一个目标都找不到时，朝目标（敌将 > 最近敌军 > 最远迷雾）推进最厚的堆
 *
 * 所有出子都在本地乐观状态上提交，保证一格一回合只动一次。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  var T = GB.TILE;

  var CHAIN_MAX = 4; // 单回合沿一条路径最多推几步
  var GARRISON = 4; // 将军保底兵力（低于此值优先不动将军）
  var POKE_MARGIN = 4; // 进攻敌方地块时，出兵堆要比「打穿代价」多出这么多才动手
  // 将军要攒到这个数才往硬目标送兵。真实产兵规则下将军每回合 +1，是唯一的稳定
  // 兵源；攒着不动才有一拳打出去的兵力，每回合挤一个兵出去只会让兵永远散在路上。
  var GENERAL_SEND_MIN = 6;

  function isPassable(terrain, i) {
    var t = terrain[i];
    return t !== T.MOUNTAIN && t !== T.FOG_OBSTACLE;
  }

  function buildNeighbors(w, h) {
    var n = w * h;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = i % w;
      var y = (i / w) | 0;
      var buf = [];
      if (y > 0) buf.push(i - w);
      if (y < h - 1) buf.push(i + w);
      if (x > 0) buf.push(i - 1);
      if (x < w - 1) buf.push(i + 1);
      out[i] = buf;
    }
    return out;
  }

  function neighbors(S) {
    if (!S._nbr || S._nbr.length !== S.n) S._nbr = buildNeighbors(S.w, S.h);
    return S._nbr;
  }

  /* 最小堆：Dijkstra 用，元素是 [cost, index] */
  function MinHeap() {
    this.a = [];
  }
  MinHeap.prototype.push = function (cost, idx) {
    var a = this.a;
    a.push([cost, idx]);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      var tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a;
    var top = a[0];
    var last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1;
        var r = l + 1;
        var m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        var tmp = a[m];
        a[m] = a[i];
        a[i] = tmp;
        i = m;
      }
    }
    return top;
  };
  Object.defineProperty(MinHeap.prototype, 'size', {
    get: function () {
      return this.a.length;
    }
  });

  function plan(S, cfg) {
    var out = [];
    if (!S.ready || S.playerIndex < 0 || S.ended) return out;

    // 新开一局时 turn 会回退，用它判定并清掉上一局的 focus 残留
    if (S._focusTurn === undefined || S.turn < S._focusTurn) {
      S._focus = -1;
      S._focusStuck = 0;
      S._preferCity = false;
    }
    S._focusTurn = S.turn;

    var n = S.n;
    var pid = S.playerIndex;
    var nbr = neighbors(S);
    var generals = S.generals;

    // 本地可写副本
    var owner = Int16Array.from(S.terrain);
    var armies = Int32Array.from(S.armies);

    var isCity = new Uint8Array(n);
    for (var c = 0; c < S.cities.length; c++) {
      var ci = S.cities[c];
      if (ci >= 0 && ci < n) isCity[ci] = 1;
    }

    var generalPlayer = new Map();
    for (var p = 0; p < generals.length; p++) {
      var gp = generals[p];
      if (gp >= 0 && gp < n) generalPlayer.set(gp, p);
    }
    var myGeneral = pid < generals.length && generals[pid] >= 0 ? generals[pid] : -1;

    var budget = Math.max(1, Math.min(20, ((cfg && cfg.maxMoves) | 0) || 1));
    var used = new Set();
    var moves = [];
    var reasons = [];

    function move(from, to, why) {
      if (moves.length >= budget) return false;
      if (used.has(from)) return false;
      if (owner[from] !== pid) return false;
      if (!isPassable(owner, to)) return false;
      var a = armies[from];
      if (a < 2) return false;
      var own = owner[to] === pid;
      var genOut = from === myGeneral && to !== myGeneral;
      // 将军隔壁已经有敌人时，只允许直接打它。把将军的兵送去别的方向等于自杀：
      // 将军被吃得手整局就结束，前面攒多少都没用。
      if (genOut && !(owner[to] >= 0 && owner[to] !== pid)) {
        var gadj = nbr[myGeneral];
        for (var gi = 0; gi < gadj.length; gi++) {
          var gj = gadj[gi];
          if (owner[gj] >= 0 && owner[gj] !== pid) return false;
        }
      }
      // 将军出兵要留底：一次送光，下一回合被贴脸就没得守了。
      var sent = a - 1;
      if (genOut) sent = a - Math.min(GARRISON, a >> 1);
      if (sent < 1) return false;
      // 往自己的格子并兵永远合法（只损耗 1），往敌人格必须打得过
      if (!own && sent <= armies[to]) return false;
      armies[to] = own ? sent + armies[to] : sent - armies[to];
      armies[from] = a - sent;
      owner[to] = pid;
      used.add(from);
      moves.push([from, to]);
      if (why) reasons.push(why + ':' + from + '>' + to);
      return true;
    }

    // A. 斩首
    for (var q = 0; q < generals.length; q++) {
      if (q === pid) continue;
      var eg = generals[q];
      if (!(eg >= 0 && eg < n) || owner[eg] !== q) continue;
      var bestSrc = -1;
      var adj = nbr[eg];
      for (var k = 0; k < adj.length; k++) {
        var s = adj[k];
        if (owner[s] !== pid || used.has(s)) continue;
        if (armies[s] - 1 <= armies[eg]) continue;
        if (bestSrc < 0 || armies[s] > armies[bestSrc]) bestSrc = s;
      }
      if (bestSrc >= 0) move(bestSrc, eg, 'kill');
      break;
    }

    // B. 守将
    if (myGeneral >= 0 && owner[myGeneral] === pid) {
      var threat = -1;
      var threatArmy = -1;
      var ga = nbr[myGeneral];
      for (var t = 0; t < ga.length; t++) {
        var j = ga[t];
        if (owner[j] >= 0 && owner[j] !== pid && armies[j] > threatArmy) {
          threat = j;
          threatArmy = armies[j];
        }
      }
      if (threat >= 0 && armies[myGeneral] <= threatArmy) {
        if (!move(myGeneral, threat, 'defend')) {
          var killer = -1;
          var u;
          for (u = 0; u < ga.length; u++) {
            var s2 = ga[u];
            if (owner[s2] !== pid || s2 === myGeneral || used.has(s2)) continue;
            if (armies[s2] - 1 <= armies[threat]) continue;
            if (killer < 0 || armies[s2] > armies[killer]) killer = s2;
          }
          if (killer >= 0) {
            move(killer, threat, 'defend');
          } else {
            var res = -1;
            for (u = 0; u < ga.length; u++) {
              var s3 = ga[u];
              if (owner[s3] !== pid || s3 === myGeneral || used.has(s3)) continue;
              if (armies[s3] - 1 <= armies[myGeneral]) continue;
              if (res < 0 || armies[s3] > armies[res]) res = s3;
            }
            if (res >= 0) move(res, myGeneral, 'defend');
          }
        }
      }
    }

    // B2. 预警：视野内最厚的敌军在 8 步内且比将军厚，先把附近的兵并进将军
    var alarmed = defendWarn();

    // C. 单栈推进（照 hunter 的打法）：只养一个 focus，每回合把「最重的那一堆」
    //    朝它推一格。1 步/回合下的吞吐就是被搬那一格的兵减一，所以搬最重的才有效；
    //    同时最多维持两条战线，为地盘四处开花等于把兵摊成每格 1 的薄片。
    var focus = -1;
    if (!alarmed) {
      focus = pickFocus();
      if (focus >= 0) {
        if (!supply(focus)) {
          S._focusStuck = (S._focusStuck | 0) + 1;
          // 卡十几回合说明正面啃不动，换目标，别死磕一个啃不动的格
          if (S._focusStuck > 12) {
            S._focus = -1;
            S._focusStuck = 0;
            S._preferCity = true;
          }
        } else {
          S._focusStuck = 0;
        }
      }
    }

    // D. 兜底：完全推不动时朝最近的敌人/最远处挪一步，别整回合空转
    if (moves.length === 0 && !alarmed) conveyor();

    function computeReach(n, nbr, owner, armies, pid) {
      var cost = new Float64Array(n);
      var src = new Int32Array(n);
      var prev = new Int32Array(n);
      var heap = new MinHeap();
      var i;
      for (i = 0; i < n; i++) {
        cost[i] = Infinity;
        src[i] = -1;
        prev[i] = -1;
        if (owner[i] === pid) {
          cost[i] = 0;
          src[i] = i;
          heap.push(0, i);
        }
      }
      while (heap.size) {
        var top = heap.pop();
        var d = top[0];
        var cur = top[1];
        if (d > cost[cur]) continue;
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (!isPassable(owner, j)) continue;
          var nd = owner[j] === pid ? d : d + armies[j] + 1;
          // 代价相同就让兵最多的那格出兵，别让将军去跑腿
          var betterSrc =
            owner[j] !== pid && src[cur] >= 0 && (src[j] < 0 || armies[src[cur]] > armies[src[j]]);
          if (nd < cost[j] || (nd === cost[j] && betterSrc)) {
            cost[j] = nd;
            src[j] = src[cur];
            prev[j] = cur;
            heap.push(nd, j);
          }
        }
      }
      return { cost: cost, src: src, prev: prev };
    }

    function pickTarget(n, nbr, owner, armies, reach, pid, myGeneral, isCity, generalPlayer) {
      var best = -1;
      var bestScore = 0;
      for (var i = 0; i < n; i++) {
        if (owner[i] === pid) continue;
        var c = reach.cost[i];
        if (!(c < Infinity)) continue;
        var s = reach.src[i];
        if (s < 0) continue;
        if (armies[s] < c) continue; // 兵力不够，别白送
        // 打敌方地块要先攒够余量：拿 2 个兵去戳一下只是给对方送兵
        if (owner[i] >= 0 && armies[s] < c + POKE_MARGIN) continue;

        var value;
        if (isCity[i]) value = 6;
        else if (owner[i] >= 0) value = 3;
        else value = 1;
        var ownerOf = generalPlayer.get(i);
        if (ownerOf !== undefined && ownerOf !== pid) value = 60; // 敌将

        var risk = 1;
        var left = armies[s] - c; // 推到这里之后手里还剩多少
        var nb = nbr[i];
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (owner[j] >= 0 && owner[j] !== pid && armies[j] > left) {
            risk = 0.55; // 落点旁边有比我们厚的敌人
            break;
          }
        }
        if (s === myGeneral && armies[s] < GARRISON * 3) risk *= 0.5;

        var score = (value / Math.pow(1 + c, 0.85)) * risk;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      return best < 0 ? null : { to: best };
    }

    function advance(target, reach) {
      var to = target.to;
      var s = reach.src[to];
      if (s < 0) return false;
      var path = [];
      var cur = to;
      var guard = 0;
      while (cur !== -1 && cur !== s && guard++ < 200) {
        path.push(cur);
        cur = reach.prev[cur];
      }
      if (!path.length) return false;
      path.reverse();

      var from = s;
      var moved = false;
      for (var k = 0; k < path.length && k < CHAIN_MAX && moves.length < budget; k++) {
        if (!move(from, path[k], moved ? 'chain' : 'grow')) break;
        from = path[k];
        moved = true;
      }
      return moved;
    }

    /*
     * 单栈 focus：跨回合保持同一个目标，只有拿下 / 卡死才换。
     * 优先级照 hunter：敌方将军 > 最近的敌方地块 > 最近的未占城市 > 最远的可探索格。
     * 目标粘性是关键——每回合换目标等于每回合重新铺一条路，兵永远在路上。
     */
    // 最近的未占城市（按从我方领土出发的 BFS 步数）
    function nearestCityGoal() {
      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      var best = -1;
      var bd = Infinity;
      for (i = 0; i < n; i++) {
        if (!isCity[i] || owner[i] === pid || dist[i] < 0) continue;
        if (dist[i] < bd) {
          bd = dist[i];
          best = i;
        }
      }
      return best;
    }

    function pickFocus() {
      var prev = S._focus;
      if (prev >= 0 && prev < n && owner[prev] !== pid) return prev;

      // 上一次 focus 卡死了：说明正面啃不动敌将，转去吃城市——
      // 城市是除将军外唯一的稳定兵源，多一座就多一条 +1/回合的进项。
      if (S._preferCity) {
        var cg = nearestCityGoal();
        if (cg >= 0) {
          S._preferCity = false;
          S._focus = cg;
          S._focusStuck = 0;
          return cg;
        }
        S._preferCity = false;
      }

      var it = generalPlayer.entries();
      for (var e = it.next(); !e.done; e = it.next()) {
        var gp2 = e.value[0];
        if (e.value[1] !== pid && owner[gp2] === e.value[1]) {
          S._focus = gp2;
          S._focusStuck = 0;
          return gp2;
        }
      }

      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }

      // 最近的敌方地块
      var best = -1;
      var bestD = Infinity;
      for (i = 0; i < n; i++) {
        if (owner[i] < 0 || owner[i] === pid || dist[i] < 0) continue;
        if (dist[i] < bestD) {
          bestD = dist[i];
          best = i;
        }
      }
      if (best < 0) {
        // 没有敌人：先去拿城市（唯一的地盘类兵源），没有城市再往最远处探路
        var cityBest = -1;
        var cd = Infinity;
        for (i = 0; i < n; i++) {
          if (!isCity[i] || owner[i] === pid || dist[i] < 0) continue;
          if (dist[i] < cd) {
            cd = dist[i];
            cityBest = i;
          }
        }
        if (cityBest >= 0) {
          best = cityBest;
        } else {
          var far = -1;
          var fd = -1;
          for (i = 0; i < n; i++) {
            if (owner[i] === pid || !isPassable(owner, i)) continue;
            if (dist[i] > fd) {
              fd = dist[i];
              far = i;
            }
          }
          best = far;
        }
      }
      S._focus = best;
      S._focusStuck = 0;
      return best;
    }

    /*
     * 朝目标推一格：反向 BFS 出步数场，然后按「兵最多」挑一个能往目标方向动
     * 的己方格子。这就是主纵队的形成方式——最重的那堆先走，后排把兵补上去，
     * 每回合只花一条命令，但整条链一直在往一个方向流。
     * 按距离挑是错的：那会让每格轮流送 1 个兵，兵永远散在通往目标的路上。
     */
    function supply(goal) {
      if (!(goal >= 0 && goal < n)) return false;
      var dist = new Int32Array(n).fill(-1);
      var queue = [goal];
      dist[goal] = 0;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      // 目标是空地时将军 2 兵就够出门探路；目标是硬方块才需要攒厚再打
      var genMin = owner[goal] < 0 ? 2 : GENERAL_SEND_MIN;
      var cand = [];
      for (var i = 0; i < n; i++) {
        if (owner[i] !== pid || used.has(i) || armies[i] < 2 || dist[i] <= 0) continue;
        if (i === myGeneral && armies[i] < genMin) continue;
        cand.push(i);
      }
      cand.sort(function (a, b) {
        // 将军的兵要打点折扣：它是唯一兵源，抽空了后面就补不上。
        var sa = a === myGeneral ? armies[a] * 0.6 : armies[a];
        var sb = b === myGeneral ? armies[b] * 0.6 : armies[b];
        return sb - sa;
      });
      for (var o = 0; o < cand.length; o++) {
        var from = cand[o];
        var step = -1;
        var nb = nbr[from];
        for (var k2 = 0; k2 < nb.length; k2++) {
          var j2 = nb[k2];
          if (dist[j2] === dist[from] - 1 && isPassable(owner, j2)) {
            step = j2;
            break;
          }
        }
        if (step < 0) continue;
        if (move(from, step, 'push')) return true;
      }
      return false;
    }

    /*
     * 预警守将：从将军往外 BFS 最多 8 步，找视野内最厚的敌军。
     * 贴着将军的按原值算，远处的要厚一倍才算威胁——真实产兵规则下将军每回合
     * 才 +1，要是「任何比我厚的兵都算威胁」，引擎整局都在回头并兵，一步也推不出去。
     * 并完就继续推进：每回合只有一条命令，站着等死比冲出去更亏。
     */
    function defendWarn() {
      if (myGeneral < 0 || owner[myGeneral] !== pid) return false;
      var dist = new Int32Array(n).fill(-1);
      var queue = [myGeneral];
      var i;
      dist[myGeneral] = 0;
      var threatArmy = -1;
      var bestDelta = -Infinity;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        if (dist[cur] >= 8) continue;
        if (cur !== myGeneral && owner[cur] >= 0 && owner[cur] !== pid) {
          // 用「到达时还剩多少兵」判断威胁，而不是当前兵数：敌人走过来要 dist
          // 回合，这期间将军也在涨 dist 兵。只有 armies - dist > ga + dist 才算
          // 真威胁——否则每次把兵送出去、将军暂时变薄都会触发并兵，
          // 兵就在将军和前线之间来回搬，两个回合白走一趟。
          var delta = armies[cur] - 2 * dist[cur];
          if (delta > bestDelta) {
            bestDelta = delta;
            threatArmy = armies[cur];
          }
          continue;
        }
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      if (threatArmy < 0 || bestDelta < armies[myGeneral]) return false;

      var limit = budget;
      while (moves.length < limit) {
        var bestSrc = -1;
        var bestA = 1;
        for (i = 0; i < n; i++) {
          if (owner[i] !== pid || used.has(i) || i === myGeneral) continue;
          if (dist[i] < 1 || dist[i] > 8) continue;
          if (armies[i] > bestA) {
            bestA = armies[i];
            bestSrc = i;
          }
        }
        if (bestSrc < 0) break;
        var step = -1;
        var nb = nbr[bestSrc];
        for (var k2 = 0; k2 < nb.length; k2++) {
          var j2 = nb[k2];
          if (dist[j2] === dist[bestSrc] - 1) {
            step = j2;
            break;
          }
        }
        if (step < 0 || !move(bestSrc, step, 'alert')) break;
      }
      // 并完继续推进：站着等死比冲出去更亏
      return false;
    }

    // 已停用：每回合只有一条命令时，分层最大流的多源并流是负收益
    // （吞吐=被搬那一格的兵减一，同时铺开的战线越多每条越慢）。
    // 保留函数体是为了 bench-ab / 未来多回合规划还能调，主流程不再走这里。
    function transport() {
      if (!GB.flow) return;      var goal = pickGoal();
      var base = {
        n: n,
        nbr: nbr,
        owner: owner,
        armies: armies,
        pid: pid,
        budget: budget,
        myGeneral: myGeneral,
        moves: function () {
          return moves;
        },
        move: move
      };
      // 先集中打一个目标；集中模式下没有可流的兵（比如贴不上那个目标）再看全图
      var res = GB.flow.plan(Object.assign({}, base, { focus: goal }));
      if (!res.moves.length) res = GB.flow.plan(Object.assign({}, base, { focus: -1 }));
      if (res.moves.length) reasons.push('flow:' + res.stats.flow + '/' + res.stats.demand);
    }

    // 目标：敌将 > 最近的敌方地块 > 最远的可探索格
    function pickGoal() {
      var gpIter = generalPlayer.entries();
      for (var e = gpIter.next(); !e.done; e = gpIter.next()) {
        if (e.value[1] !== pid && owner[e.value[0]] === e.value[1]) return e.value[0];
      }
      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      var nearestEnemy = -1;
      var far = -1;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        if (owner[cur] >= 0 && owner[cur] !== pid) {
          nearestEnemy = cur;
          break;
        }
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
          if (far < 0 || dist[j] > dist[far]) far = j;
        }
      }
      return nearestEnemy >= 0 ? nearestEnemy : far;
    }

    // 兜底：单栈推不动时（目标被山挡死之类）朝最近的敌人/最远处挪一步。
    function conveyor() {
      var goal = pickGoal();
      if (goal >= 0) supply(goal);
    }

    GB.lastReasons = reasons;
    return moves;
  }

  GB.bot = { plan: plan, neighbors: neighbors, isPassable: isPassable };
})();


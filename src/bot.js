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

    var budget = Math.max(1, Math.min(20, ((cfg && cfg.maxMoves) | 0) || 6));
    var used = new Set();
    var moves = [];
    var reasons = [];

    function move(from, to, why) {
      if (moves.length >= budget) return false;
      if (used.has(from)) return false;
      if (owner[from] !== pid) return false;
      if (!isPassable(owner, to)) return false;
      var a = armies[from];
      if (a - 1 <= armies[to]) return false; // 必须严格大于守军
      armies[to] = a - 1 - armies[to];
      armies[from] = 0;
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

    // C. 扩张：反复求最便宜的“值得吃”的目标，链式推进
    while (moves.length < budget) {
      var reach = computeReach(n, nbr, owner, armies, pid);
      var target = pickTarget(n, nbr, owner, armies, reach, pid, myGeneral, isCity, generalPlayer);
      if (!target) break;
      if (!advance(target, reach)) break;
    }

    // D. 输兵：找不到任何可吃目标时，朝目标推最厚的堆
    if (moves.length === 0) conveyor();

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

    function conveyor() {
      var goal = pickGoal();
      if (goal < 0) return;
      // 从目标反向 BFS 出步数场，朝 0 走
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
      var order = [].concat(queue).sort(function (a, b) {
        return armies[b] - armies[a];
      });
      for (var o = 0; o < order.length && moves.length < budget; o++) {
        var i = order[o];
        if (owner[i] !== pid || used.has(i) || armies[i] < 2) continue;
        if (dist[i] <= 0) continue;
        var nb = nbr[i];
        var best = -1;
        for (var k = 0; k < nb.length; k++) {
          var j2 = nb[k];
          if (dist[j2] === dist[i] - 1 && isPassable(owner, j2)) {
            best = j2;
            break;
          }
        }
        if (best < 0) continue;
        move(i, best, 'push');
      }
    }

    GB.lastReasons = reasons;
    return moves;
  }

  GB.bot = { plan: plan, neighbors: neighbors, isPassable: isPassable };
})();

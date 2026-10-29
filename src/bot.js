/*
 * 决策引擎（纯函数，不改全局状态）。
 *
 * 每回合（turn）跑一次，产出若干 [from, to] 走子：
 *   1. 斩首：贴脸的敌方将军能吃就吃，直接结束对局。
 *   2. 守将：自家将军被贴脸且打不过时，先把最强邻居并进来。
 *   3. 主扫描：城市 > 空地/中立 > 弱敌，按「价值 - 投入」排序，逐条执行到预算上限。
 *   4. 兜底：一条能走的都没有时，把腹地兵力一格格推向前线。
 *
 * 走子合法性以本地乐观状态为准（commit 后立刻改 owner/armies），
 * 避免同一回合内重复调用同一格兵力。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  var T = GB.TILE;

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

  function adjacentTo(nbr, a, b) {
    var list = nbr[a];
    for (var i = 0; i < list.length; i++) if (list[i] === b) return true;
    return false;
  }

  function plan(S, cfg) {
    var out = [];
    if (!S.ready || S.playerIndex < 0 || S.ended) return out;

    var n = S.n;
    var pid = S.playerIndex;
    var nbr = neighbors(S);
    var generals = S.generals;
    var cities = S.cities;

    // 本地可写副本：走一步就更新一次，后续判断基于最新局面
    var owner = Int16Array.from(S.terrain);
    var armies = Int32Array.from(S.armies);

    var isCity = new Uint8Array(n);
    for (var c = 0; c < cities.length; c++) {
      var ci = cities[c];
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
      if (a - 1 <= armies[to]) return false; // 必须严格大于守军才能拿下
      armies[to] = a - 1 - armies[to];
      armies[from] = 0;
      owner[to] = pid;
      used.add(from);
      moves.push([from, to]);
      reasons.push(why + ':' + from + '>' + to);
      return true;
    }

    // 1. 斩首
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

    // 2. 守将
    if (myGeneral >= 0) {
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
        // 先反打，再让邻居代打，最后才是把兵并进将军硬扛
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
            var src = -1;
            for (u = 0; u < ga.length; u++) {
              var s3 = ga[u];
              if (owner[s3] !== pid || s3 === myGeneral || used.has(s3)) continue;
              if (armies[s3] - 1 <= armies[myGeneral]) continue;
              if (src < 0 || armies[s3] > armies[src]) src = s3;
            }
            if (src >= 0) move(src, myGeneral, 'defend');
          }
        }
      }
    }

    // 3. 主扫描
    var cands = [];
    for (var i = 0; i < n; i++) {
      if (owner[i] !== pid || used.has(i)) continue;
      var myArmy = armies[i];
      if (myArmy < 2) continue;
      var nb = nbr[i];
      for (var d = 0; d < nb.length; d++) {
        var tgt = nb[d];
        if (owner[tgt] === pid || !isPassable(owner, tgt)) continue;
        var surplus = myArmy - 1 - armies[tgt];
        if (surplus <= 0) continue;

        var value;
        if (isCity[tgt]) value = 9000;
        else if (owner[tgt] >= 0) value = 500 + (armies[tgt] <= 3 ? 300 : 0);
        else value = 150 - Math.min(120, armies[tgt] * 5);

        var gpAt = generalPlayer.get(tgt);
        if (gpAt !== undefined && gpAt !== pid) value += 12000; // 敌将
        if (myGeneral >= 0 && adjacentTo(nbr, tgt, myGeneral)) value += 2500; // 贴脸威胁

        cands.push({ f: i, t: tgt, s: value - surplus * 0.6 - armies[tgt] * 0.4 });
      }
    }
    cands.sort(function (a, b) {
      return b.s - a.s || a.f - b.f;
    });
    for (var m = 0; m < cands.length && moves.length < budget; m++) {
      move(cands[m].f, cands[m].t, 'grow');
    }

    // 4. 兜底合兵
    if (moves.length === 0) consolidate();

    function consolidate() {
      var frontier = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        if (owner[i] !== pid) continue;
        var nb = nbr[i];
        for (var j = 0; j < nb.length; j++) {
          if (owner[nb[j]] !== pid && isPassable(owner, nb[j])) {
            frontier[i] = 1;
            break;
          }
        }
      }
      var dist = new Int32Array(n).fill(-1);
      var parent = new Int32Array(n).fill(-1);
      var queue = [];
      for (var a = 0; a < n; a++) {
        if (frontier[a]) {
          dist[a] = 0;
          queue.push(a);
        }
      }
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        if (dist[cur] >= 8) continue;
        var cn = nbr[cur];
        for (var x = 0; x < cn.length; x++) {
          var nx = cn[x];
          if (owner[nx] !== pid || dist[nx] !== -1) continue;
          dist[nx] = dist[cur] + 1;
          parent[nx] = cur;
          queue.push(nx);
        }
      }
      var order = queue.slice().sort(function (b1, b2) {
        return dist[b2] - dist[b1] || b1 - b2;
      });
      for (var o = 0; o < order.length && moves.length < budget; o++) {
        var cell = order[o];
        if (dist[cell] <= 0) continue;
        if (armies[cell] < 2 || used.has(cell)) continue;
        var par = parent[cell];
        if (par < 0) continue;
        move(cell, par, 'merge');
      }
    }

    GB.lastReasons = reasons;
    return moves;
  }

  GB.bot = { plan: plan, neighbors: neighbors, isPassable: isPassable };
})();

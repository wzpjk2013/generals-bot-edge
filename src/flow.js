/*
 * 兵力输送：分层最大流。
 *
 * 思路来自 AverageJoe 最显眼的那一手——「flow army in complex situations」
 * （strakam/AverageJoe README）。它用 transformer 学出来的东西里，最不容易
 * 用启发式替代的一部分是：后排兵力怎么沿着多条通道同时向多个前线流动，
 * 而不是一次性把最厚的一堆推向唯一一个目标。
 *
 * 这里把它写成一道标准的最大流问题：
 *
 *   源点 ──cap=army-1──> 每个我方地格的 in 节点
 *   in ──cap=army-1──> out          一格一回合最多能送出 army-1
 *   out ──cap=INF──> 邻居的 in       只允许朝 d 递减的方向（分层 DAG）
 *   out ──cap=需求──> 汇点            前线地格的缺口
 *
 * 其中 d[i] = 从地格 i 到我方前沿（能打到非我方格子的地格）的步数。
 * 最大流解出来之后，每条 out->in 边上的流量就是这一回合该往那个方向推多少兵。
 * 容量 = army-1 的含义是「这个格子每回合最多能过多少兵」，所以解天然不会
 * 把兵堆到一个卡死的格子上，也不会为了喂一个缺口把别的通道抽干。
 *
 * 只负责后方→前线的运输；前线往外打是 bot.js 阶段 C 的事。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  var T = GB.TILE;

  var MAX_HOPS = 16; // 超过这么多步的地格不参与运输（走不到，算了）
  var DEMAND_MAX = 64; // 单个缺口的上限，防止一个死口把全图兵力吸走
  var INF = 1e9;

  function isPassable(terrain, i) {
    var t = terrain[i];
    return t !== T.MOUNTAIN && t !== T.FOG_OBSTACLE;
  }

  /* Dinic */
  function Dinic(nNodes) {
    this.n = nNodes;
    this.head = new Int32Array(nNodes).fill(-1);
    this.to = [];
    this.cap = [];
    this.nxt = [];
    this.level = new Int32Array(nNodes);
    this.it = new Int32Array(nNodes);
    this.queue = new Int32Array(nNodes);
  }

  Dinic.prototype.add = function (u, v, c) {
    var id = this.to.length;
    this.to.push(v);
    this.cap.push(c);
    this.nxt.push(this.head[u]);
    this.head[u] = id;
    this.to.push(u);
    this.cap.push(0);
    this.nxt.push(this.head[v]);
    this.head[v] = id + 1;
    return id;
  };

  Dinic.prototype.bfs = function (s, t) {
    this.level.fill(-1);
    var q = this.queue;
    var qh = 0;
    var qt = 0;
    q[qt++] = s;
    this.level[s] = 0;
    while (qh < qt) {
      var v = q[qh++];
      for (var e = this.head[v]; e !== -1; e = this.nxt[e]) {
        var u = this.to[e];
        if (this.cap[e] > 0 && this.level[u] < 0) {
          this.level[u] = this.level[v] + 1;
          q[qt++] = u;
        }
      }
    }
    return this.level[t] >= 0;
  };

  Dinic.prototype.dfs = function (v, t, f) {
    if (v === t) return f;
    for (var e = this.it[v]; e !== -1; e = this.nxt[e]) {
      this.it[v] = e;
      var u = this.to[e];
      if (this.cap[e] > 0 && this.level[u] === this.level[v] + 1) {
        var d = this.dfs(u, t, f < this.cap[e] ? f : this.cap[e]);
        if (d > 0) {
          this.cap[e] -= d;
          this.cap[e ^ 1] += d;
          return d;
        }
      }
    }
    this.it[v] = -1;
    return 0;
  };

  Dinic.prototype.maxflow = function (s, t) {
    var flow = 0;
    while (this.bfs(s, t)) {
      for (var i = 0; i < this.n; i++) this.it[i] = this.head[i];
      var f;
      while ((f = this.dfs(s, t, INF)) > 0) flow += f;
    }
    return flow;
  };

  /*
   * ctx 由 bot.js 提供：
   *   n, w, h, nbr[], owner(Int16Array), armies(Int32Array), pid, budget,
   *   myGeneral, move(from,to,why)->bool, used(Set)
   * 返回 { moves:[[from,to],...], stats:{ flow, edges, demand } }
   */
  function plan(ctx) {
    var out = { moves: [], stats: { flow: 0, edges: 0, demand: 0, reach: 0 } };
    var n = ctx.n;
    var owner = ctx.owner;
    var armies = ctx.armies;
    var nbr = ctx.nbr;
    var pid = ctx.pid;
    var i, k, j;

    /* 1. 前沿与缺口：我那格能打到的最小目标兵力 + 1 */
    var demand = new Int32Array(n);
    var isFrontier = new Uint8Array(n);
    var frontier = [];
    for (i = 0; i < n; i++) {
      if (owner[i] !== pid || !isPassable(owner, i)) continue;
      var list = nbr[i];
      var need = 0;
      for (k = 0; k < list.length; k++) {
        j = list[k];
        if (owner[j] === pid || !isPassable(owner, j)) continue;
        // 打穿这一格至少要 armies[j]+1 兵
        var here = armies[j] + 1;
        if (here > need) need = here;
      }
      if (need > 0) {
        isFrontier[i] = 1;
        demand[i] = need > DEMAND_MAX ? DEMAND_MAX : need;
        frontier.push(i);
      }
    }
    if (!frontier.length) return out;

    /* 1b. 单目标模式：只喂贴着 focus 的那几个口子。
     *     每一步只能走 6 次，集中打穿一个目标通常比三条线平摊更快；这时候
     *     最大流的作用变成「在同一个目标前面同时开多条通道」。 */
    if (ctx.focus >= 0) {
      var keep = [];
      for (i = 0; i < frontier.length; i++) {
        var ft = frontier[i];
        var fl = nbr[ft];
        var hit = false;
        for (k = 0; k < fl.length; k++) {
          if (fl[k] === ctx.focus) {
            hit = true;
            break;
          }
        }
        if (hit) keep.push(ft);
        else demand[ft] = 0;
      }
      if (!keep.length) return out;
      frontier = keep;
    }

    /* 2. d[i]：到我方前沿的步数，只走我方地格 */
    var d = new Int32Array(n).fill(-1);
    var queue = [];
    for (i = 0; i < frontier.length; i++) {
      d[frontier[i]] = 0;
      queue.push(frontier[i]);
    }
    for (var h = 0; h < queue.length; h++) {
      var cur = queue[h];
      if (d[cur] >= MAX_HOPS) continue;
      var nl = nbr[cur];
      for (k = 0; k < nl.length; k++) {
        j = nl[k];
        if (d[j] !== -1 || owner[j] !== pid || !isPassable(owner, j)) continue;
        d[j] = d[cur] + 1;
        queue.push(j);
      }
    }

    /* 3. 建图：每个参与运输的地格拆成 in/out 两个节点 */
    var idxIn = new Int32Array(n).fill(-1);
    var idxOut = new Int32Array(n).fill(-1);
    var nodes = 0;
    var region = []; // 参与运输（有货可发）的地格
    var sinks = []; // 前沿地格
    for (h = 0; h < queue.length; h++) {
      i = queue[h];
      idxIn[i] = nodes++;
      idxOut[i] = nodes++;
      if (d[i] === 0) {
        sinks.push(i);
        continue;
      }
      if (i === ctx.myGeneral) continue; // 将军只管生兵，不搬
      if (armies[i] < 2) continue; // 一格兵没法搬
      region.push(i);
    }
    if (!region.length) return out;

    var src = nodes++;
    var snk = nodes++;
    var g = new Dinic(nodes);
    var edgeOf = []; // [from, to, edgeId]

    for (h = 0; h < region.length; h++) {
      i = region[h];
      var cap = armies[i] - 1;
      g.add(src, idxIn[i], cap);
      g.add(idxIn[i], idxOut[i], cap);
      var nb = nbr[i];
      for (k = 0; k < nb.length; k++) {
        j = nb[k];
        if (idxIn[j] < 0 || d[j] !== d[i] - 1) continue;
        var e = g.add(idxOut[i], idxIn[j], INF);
        edgeOf.push([i, j, e]);
      }
    }
    for (h = 0; h < sinks.length; h++) {
      i = sinks[h];
      // 单目标模式下不限制每回合吞吐：这道题问的是「兵往哪走」，
      // 一回合只走 6 步的限制在发射阶段处理
      var sinkCap = ctx.focus >= 0 && isFrontier[i] ? INF : demand[i];
      g.add(idxIn[i], idxOut[i], sinkCap);
      g.add(idxOut[i], snk, sinkCap);
    }

    /* 4. 求解 */
    var total = g.maxflow(src, snk);
    out.stats.flow = total;
    out.stats.reach = region.length;
    var demandSum = 0;
    for (h = 0; h < sinks.length; h++) demandSum += demand[sinks[h]];
    out.stats.demand = demandSum;
    if (total <= 0) return out;

    /* 5. 每个格子往哪走：优先用最大流给出的方向；自己没流量但身后堵着兵的
     *    （瓶颈后面的那串），就朝 d 递减、兵最多的邻居走——一步只走 6 次，
     *    整条管道得一起往前挪，不能只喂贴着前沿的那一格。 */
    var dir = new Int32Array(n).fill(-1);
    var dirFlow = new Float64Array(n);
    var flowing = 0;
    for (h = 0; h < edgeOf.length; h++) {
      var fe = g.cap[edgeOf[h][2] ^ 1];
      if (fe <= 0) continue;
      var u = edgeOf[h][0];
      flowing++;
      if (dir[u] < 0 || fe > dirFlow[u]) {
        dir[u] = edgeOf[h][1];
        dirFlow[u] = fe;
      }
    }
    out.stats.edges = flowing;

    var cand = [];
    for (h = 0; h < region.length; h++) {
      i = region[h];
      var to = dir[i];
      if (to < 0) {
        // 没流量的格子：挑 d-1 里兵最多的那个邻居
        var nbl = nbr[i];
        var bestA = -1;
        for (k = 0; k < nbl.length; k++) {
          j = nbl[k];
          if (idxIn[j] < 0 || d[j] !== d[i] - 1) continue;
          if (armies[j] > bestA) {
            bestA = armies[j];
            to = j;
          }
        }
      }
      if (to >= 0) cand.push([i, to, armies[i] - 1]);
    }

    /* 6. 一步只能走 6 次，先动兵最多的那几格（一次搬得多） */
    cand.sort(function (a, b) {
      if (a[2] !== b[2]) return b[2] - a[2];
      return d[a[0]] - d[b[0]];
    });

    for (h = 0; h < cand.length; h++) {
      if (ctx.moves().length >= ctx.budget) break;
      if (ctx.move(cand[h][0], cand[h][1], 'flow')) out.moves.push([cand[h][0], cand[h][1]]);
    }
    return out;
  }

  GB.flow = { plan: plan, isPassable: isPassable, MAX_HOPS: MAX_HOPS, DEMAND_MAX: DEMAND_MAX };
})();

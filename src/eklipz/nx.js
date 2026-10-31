/*
 * nx.js —— networkx 的最小可用子集，只为 GatherSteiner 的 mehlhorn 近似 Steiner 树服务。
 *
 * 原版：networkx 3.6.1
 *   networkx/algorithms/approximation/steinertree.py  steiner_tree / _mehlhorn_steiner_tree /
 *                                                    _remove_nonterminal_leaves
 *   networkx/algorithms/shortest_paths/weighted.py    _dijkstra_multisource
 *   networkx/algorithms/tree/mst.py                   kruskal_mst_edges
 *
 * 为什么不调现成库 / 不写手搓贪心：整条链的落点是「Steiner 树上包了哪些格子」，
 * 这个集合对并列权重时谁先进堆、边以什么顺序进 Kruskal 非常敏感（价值矩阵里
 * 大量格子权重相同）。要跟原版逐字节对齐，只能把 CPython 的这几个排序/堆语义
 * 逐条复刻：
 *  1. Dijkstra 的 fringe 是 (dist, counter, node) 三元组，counter 单调递增 →
 *     同 dist 时先入堆的先结算；`dist` 字典的插入序就是结算序。
 *  2. 路径重建：paths[v] = paths[pred[v][0]] + [v]，pred[v] 记录**第一次**改进它的邻点，
 *     后到的同距离邻点不会覆盖（单源时 pred 为 None，只保留第一条）。
 *     s[v] = paths[v][0] 因此是「最近终端」，并列时取先结算的那条链的终端。
 *  3. Kruskal 对边按权重做**稳定**排序，同权重保持 G.edges() 的产出顺序；
 *     G.edges() 自身按节点插入序 × 邻接插入序产出（nx 用 seen 集合去重）。
 *  4. Graph.add_edge 重复添加同一条边时**原地合并**属性字典（两个方向共用同一个 dict），
 *     mehlhorn 的 G_1_prime 靠这个行为把 weight_d1 取成 min。
 *
 * 与原版的差异（不影响本任务用到的分支）：
 *  - 只支持无向简单图，不做 multigraph / directed / 属性视图 / 惰性视图；
 *  - `edge_subgraph` 直接物化成新的 Graph（原版返回视图再 .copy()，结果等价）；
 *  - 不支持节点属性、边键、dijkstra 的 cutoff/target 提前退出（全量跑完再取路径，
 *    pred 链一致，结果等价）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ------------------------------------------------------------------ Graph */

  function Graph() {
    this._adj = new Map(); // node -> Map(node -> attrObj)，都是插入序
  }

  Graph.prototype.add_node = function (n) {
    if (!this._adj.has(n)) this._adj.set(n, new Map());
  };

  Graph.prototype.add_edge = function (u, v, attrs) {
    this.add_node(u);
    this.add_node(v);
    var au = this._adj.get(u);
    var existing = au.get(v);
    var dict;
    if (existing !== undefined) {
      dict = existing; // nx 复用同一个字典，两方向共用
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) dict[k] = attrs[k];
    } else {
      dict = {};
      if (attrs) for (var k2 in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k2)) dict[k2] = attrs[k2];
      au.set(v, dict);
      this._adj.get(v).set(u, dict);
    }
  };

  Graph.prototype.has_edge = function (u, v) {
    var m = this._adj.get(u);
    return m !== undefined && m.has(v);
  };

  Graph.prototype.get_edge = function (u, v) {
    var m = this._adj.get(u);
    return m === undefined ? undefined : m.get(v);
  };

  Graph.prototype.nodes = function () {
    return Array.from(this._adj.keys());
  };

  // nx 的边产出顺序：外层节点插入序，内层邻接插入序，用 seen 去重（每条边只出一次）
  Graph.prototype.edges = function (withData) {
    var out = [];
    var seen = new Set();
    for (var pair of this._adj) {
      var u = pair[0];
      var nbrs = pair[1];
      for (var e of nbrs) {
        if (!seen.has(e[0])) out.push(withData ? [u, e[0], e[1]] : [u, e[0]]);
      }
      seen.add(u);
    }
    return out;
  };

  Graph.prototype.degree = function (n) {
    var m = this._adj.get(n);
    if (m === undefined) return 0;
    var d = m.size;
    if (m.has(n)) d += 1; // 自环在 nx 里算 2 度
    return d;
  };

  Graph.prototype.remove_node = function (n) {
    var m = this._adj.get(n);
    if (m === undefined) return;
    for (var nb of m.keys()) {
      if (nb === n) continue;
      this._adj.get(nb).delete(n);
    }
    this._adj.delete(n);
  };

  Graph.prototype.copy = function () {
    var g = new Graph();
    var edges = this.edges(true);
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      g.add_edge(e[0], e[1], e[2]);
    }
    // 孤立节点也要抄过去，否则 _remove_nonterminal_leaves 的「度为 1」判断会漏
    for (var n of this._adj.keys()) g.add_node(n);
    return g;
  };

  // nx.edge_subgraph：只保留给定边（(u,v) 或 (u,v,d)），节点集合 = 这些边的端点
  function edge_subgraph(G, edges) {
    var g = new Graph();
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var u = e[0];
      var v = e[1];
      var attrs = e.length > 2 ? e[2] : G.get_edge(u, v);
      g.add_edge(u, v, attrs);
    }
    return g;
  }

  /* --------------------------------------------------------------- 权重取值 */

  // nx._weight_function(G, 'weight')：边属性缺失时按 1 处理
  function weightOf(attrs, key) {
    if (attrs === undefined) return 1;
    var w = attrs[key];
    return w === undefined ? 1 : w;
  }

  /* ------------------------------------------------------------ 二叉小根堆 */
  /*
   * 对应 heapq：元素是 [dist, counter, node]，比较时先 dist 再 counter，
   * counter 全局唯一，因此永远比不到 node（与 CPython 的 (d, c, v) 三元组一致）。
   */
  function heapPush(h, item) {
    h.push(item);
    var i = h.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (cmpHeap(h[p], item) <= 0) break;
      h[i] = h[p];
      i = p;
      h[i] = item;
    }
  }

  function heapPop(h) {
    var top = h[0];
    var last = h.pop();
    if (h.length === 0) return top;
    h[0] = last;
    var i = 0;
    var n = h.length;
    for (;;) {
      var l = 2 * i + 1;
      if (l >= n) break;
      var r = l + 1;
      var m = l;
      if (r < n && cmpHeap(h[r], h[l]) < 0) m = r;
      if (cmpHeap(h[m], h[i]) >= 0) break;
      var t = h[i];
      h[i] = h[m];
      h[m] = t;
      i = m;
    }
    return top;
  }

  function cmpHeap(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  }

  /* ------------------------------------------------------------- Dijkstra */
  /*
   * nx._dijkstra_multisource 的完整复刻（不含 cutoff/target 提前退出）。
   * 返回 {dist: Map(node->float), paths: Map(node->[node...])}。
   */
  function dijkstraMultisource(G, sources, key) {
    var dist = new Map();
    var seen = new Map();
    var pred = new Map(); // node -> [firstPred]
    var fringe = [];
    var counter = 0;
    var counts = 0;
    var i;
    for (i = 0; i < sources.length; i++) {
      seen.set(sources[i], 0);
      heapPush(fringe, [0, counter++, sources[i]]);
      counts++;
    }
    while (fringe.length > 0) {
      var top = heapPop(fringe);
      var dv = top[0];
      var v = top[2];
      if (dist.has(v)) continue;
      dist.set(v, dv);
      var nbrs = G._adj.get(v);
      if (nbrs === undefined) continue;
      for (var e of nbrs) {
        var u = e[0];
        var cost = weightOf(e[1], key);
        var vu = dv + cost;
        if (dist.has(u)) continue; // nx 这里只在负权时报错，正权下等价于跳过
        if (!seen.has(u) || vu < seen.get(u)) {
          seen.set(u, vu);
          heapPush(fringe, [vu, counter++, u]);
          pred.set(u, [v]);
        }
      }
    }
    var paths = new Map();
    for (i = 0; i < sources.length; i++) paths.set(sources[i], [sources[i]]);
    var skipped = 0;
    for (var entry of dist) {
      var node = entry[0];
      if (skipped < counts) {
        skipped++;
        continue;
      }
      var p = pred.get(node);
      if (p === undefined) continue; // 理论上不会发生：有距离的非源点必有前驱
      paths.set(node, paths.get(p[0]).concat([node]));
    }
    return { dist: dist, paths: paths };
  }

  function multiSourceDijkstra(G, sources, key) {
    for (var i = 0; i < sources.length; i++) {
      if (!G._adj.has(sources[i])) throw new Error('nx: node ' + sources[i] + ' not in graph');
    }
    return dijkstraMultisource(G, sources, key);
  }

  function dijkstraPath(G, source, target, key) {
    if (source === target) return [source];
    var r = dijkstraMultisource(G, [source], key);
    var p = r.paths.get(target);
    if (p === undefined) throw new Error('nx: no path ' + source + '->' + target);
    return p;
  }

  /* -------------------------------------------------------------- Kruskal */
  /*
   * Kruskal（nx.kruskal_mst_edges）：按权重**稳定**排序，同权重保持 edges() 的产出序。
   * JS 的 Array.prototype.sort 自 ES2019 起是稳定排序，正好对上 Python 的 sorted。
   */
  function kruskalMstEdges(G, key, withData) {
    var raw = G.edges(true);
    var arr = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      var e = raw[i];
      var w = weightOf(e[2], key);
      if (w !== w) throw new Error('nx: NaN edge weight');
      arr[i] = { w: w, u: e[0], v: e[1], d: e[2] };
    }
    arr.sort(function (a, b) {
      return a.w < b.w ? -1 : a.w > b.w ? 1 : 0;
    });
    var parent = new Map();
    var rank = new Map();
    var find = function (x) {
      var p = parent.get(x);
      if (p === undefined) {
        parent.set(x, x);
        rank.set(x, 0);
        return x;
      }
      // 路径压缩用迭代，避免深链在 400 格图上递归
      var root = x;
      while (parent.get(root) !== root) root = parent.get(root);
      var cur = x;
      while (parent.get(cur) !== root) {
        var nxt = parent.get(cur);
        parent.set(cur, root);
        cur = nxt;
      }
      return root;
    };
    var out = [];
    for (var k = 0; k < arr.length; k++) {
      var it = arr[k];
      var ru = find(it.u);
      var rv = find(it.v);
      if (ru === rv) continue;
      if (rank.get(ru) < rank.get(rv)) {
        parent.set(ru, rv);
      } else if (rank.get(ru) > rank.get(rv)) {
        parent.set(rv, ru);
      } else {
        parent.set(rv, ru);
        rank.set(ru, rank.get(ru) + 1);
      }
      out.push(withData ? [it.u, it.v, it.d] : [it.u, it.v]);
    }
    return out;
  }

  /* ------------------------------------------------------- mehlhorn Steiner */

  function mehlhornSteinerTree(G, terminalNodes, key) {
    var r = multiSourceDijkstra(G, terminalNodes, key);
    var dist = r.dist;
    var paths = r.paths;

    var s = new Map(); // v -> 最近终端
    var d1 = new Map(); // v -> Map(terminal -> dist)
    var nodes = G.nodes();
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i];
      var p = paths.get(v);
      if (p === undefined) throw new Error('nx: unreachable node ' + v + ' in steiner');
      var term = p[0];
      s.set(v, term);
      var m = d1.get(v);
      if (m === undefined) {
        m = new Map();
        d1.set(v, m);
      }
      m.set(term, dist.get(v));
    }

    var g1 = new Graph();
    var edges = G.edges(true);
    for (var e = 0; e < edges.length; e++) {
      var u = edges[e][0];
      var w = edges[e][1];
      var data = edges[e][2];
      var su = s.get(u);
      var sv = s.get(w);
      var weightHere = d1.get(u).get(su) + weightOf(data, key) + d1.get(w).get(sv);
      if (!g1.has_edge(su, sv)) {
        g1.add_edge(su, sv, { weight_d1: weightHere });
      } else {
        var old = g1.get_edge(su, sv).weight_d1;
        g1.add_edge(su, sv, { weight_d1: weightHere < old ? weightHere : old });
      }
    }

    var g2 = kruskalMstEdges(g1, 'weight_d1', true);

    var g3 = new Graph();
    for (var j = 0; j < g2.length; j++) {
      var path = dijkstraPath(G, g2[j][0], g2[j][1], key);
      for (var q = 0; q + 1 < path.length; q++) {
        var n1 = path[q];
        var n2 = path[q + 1];
        g3.add_edge(n1, n2, { weight: weightOf(G.get_edge(n1, n2), key) });
      }
    }

    var g3mst = kruskalMstEdges(g3, key, false);
    var g4 = edge_subgraph(G, g3mst);
    removeNonterminalLeaves(g4, terminalNodes);
    return g4;
  }

  // nx._remove_nonterminal_leaves：反复剥掉「度为 1 且不是终端」的节点
  function removeNonterminalLeaves(G, terminals) {
    var termSet = new Set(terminals);
    var leaves = [];
    for (var n of G._adj.keys()) if (G.degree(n) === 1) leaves.push(n);
    var nonTerm = leaves.filter(function (x) {
      return !termSet.has(x);
    });
    while (nonTerm.length > 0) {
      var cand = new Set();
      var i;
      var j;
      for (i = 0; i < nonTerm.length; i++) {
        var nb = G._adj.get(nonTerm[i]);
        if (nb === undefined) continue;
        for (var key2 of nb.keys()) cand.add(key2);
      }
      for (i = 0; i < nonTerm.length; i++) cand.delete(nonTerm[i]);
      for (var t of termSet) cand.delete(t);
      for (i = 0; i < nonTerm.length; i++) G.remove_node(nonTerm[i]);
      var nextNonTerm = [];
      for (var c of cand) {
        if (!G._adj.has(c)) continue;
        if (G.degree(c) !== 1) continue;
        if (!termSet.has(c)) nextNonTerm.push(c);
      }
      nonTerm = nextNonTerm;
    }
  }

  function steinerTree(G, terminalNodes, key) {
    var edges = mehlhornSteinerTree(G, terminalNodes, key).edges(true);
    return edge_subgraph(G, edges);
  }

  EK.nx = {
    Graph: Graph,
    edge_subgraph: edge_subgraph,
    weightOf: weightOf,
    multi_source_dijkstra: multiSourceDijkstra,
    dijkstra_path: dijkstraPath,
    kruskal_mst_edges: kruskalMstEdges,
    steiner_tree: steinerTree,
    _mehlhorn_steiner_tree: mehlhornSteinerTree,
    _remove_nonterminal_leaves: removeNonterminalLeaves
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

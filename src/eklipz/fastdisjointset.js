/* FastDisjointSet —— Algorithms/FastDisjointSet.py（944 行）的 JS 移植。
 *
 * 原版算法：SciPy 的 union-find（path halving 查找 + merge-by-size 合并），
 * 区别是「缺元素就现场建一个单元素集合」，所以空集合上直接 merge(2,3) 也能用。
 * `_nbrs` 是一条环形链表，把同一集合的元素串起来，`subset()` 靠它枚举成员而
 * 不需要维护一个真正的成员集合；`_indices` 记的是插入序号，用来比较「谁先插入」
 * 以及在 path halving 里避免比较对象本身。
 *
 * 三个类：FastDisjointSet（纯并查集）、FastDisjointTileSetSum（每个集合额外
 * 维护一个从 valueLookup 取来的浮点和）、FastDisjointTileSetMultiSum（每个集合
 * 维护一组浮点和，valueLookups 是多个矩阵）。
 *
 * Python 魔术方法 ↔ JS 方法名对应表（任务要求写清）：
 *   __init__(elements)        → new FastDisjointSet(elements)
 *   __iter__                  → items()（返回迭代器，插入序）、toArray()（同序数组）
 *   __len__                   → size()
 *   __contains__(x)           → has(x)
 *   __getitem__(x)            → find(x)          （即原版的「取根」，会顺手 add）
 *   __setitem__               → 无（原版没有，也不需要）
 *   add/merge/connected       → 同名
 *   subset(x)                 → subset(x)        → Set
 *   subset_with_value(x)      → subset_with_value(x) → [Set, number]
 *   subset_with_values(x)     → subset_with_values(x) → [Set, number[]]
 *   subset_size/subset_value  → subset_size / subset_value
 *   subset_values             → subset_values（仅 MultiSum）
 *   subsets / subsets_with_values / copy / n_subsets → 同名
 *
 * 实现差异（都是被迫的，没有一处是「差不多就行」）：
 *  1. Python 的 dict 用 hash 存任意可哈希对象；JS 只有 Map/Set 走身份比较。tile 是
 *     对象且全图共享同一批实例，身份比较等价于原版的 hash 比较，所以直接上 Map。
 *     Map 保留插入序，正好顶上原版用 `_indices` 维持 `__iter__` 顺序的用途。
 *  2. 原版 merge 的 tie-break 是元组比较 `(sizes[xr], indices[yr]) < (sizes[yr],
 *     indices[xr])`，等价于「size 小的当孩子；size 相同则先插入的当父」。JS 里拆成
 *     两次显式比较，保证与 Python 完全同序（树形不同会导致 subsets() 顺序不同）。
 *  3. `subset()` 原版用 `_indices[nxt] != _indices[x]` 判断环形链回到起点。JS 里
 *     直接比对象身份（`nxt !== x`）同样安全，因为环上每个元素都是不同实例。
 *  4. 原版 `_sums` 的值是 float；这里同样用 number，不额外包对象。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------------------------------------------------------- 公共骨架
   *
   * 三个类的 add/__getitem__(find)/merge/connected/subset_size/subsets 逻辑完全
   * 一致，差别只在「合并时附加值怎么合」以及「subset 返回什么形状」。用一个
   * 内部基类收掉重复，子类只覆写三处：_initValue / _mergeValue / _subsetExtra。
   */
  function _DisjointBase() {
    this.n_subsets = 0;
    this._sizes = new Map();
    this._parents = new Map();
    this._nbrs = new Map();
    this._indices = new Map();
  }

  _DisjointBase.prototype.size = function () {
    return this._indices.size;
  };

  _DisjointBase.prototype.has = function (x) {
    return this._indices.has(x);
  };

  _DisjointBase.prototype.items = function () {
    return this._indices.keys();
  };

  _DisjointBase.prototype.toArray = function () {
    var out = [];
    var it = this._indices.keys();
    var step = it.next();
    while (!step.done) {
      out.push(step.value);
      step = it.next();
    }
    return out;
  };

  _DisjointBase.prototype.add = function (x) {
    if (this._indices.has(x)) return;
    this._sizes.set(x, 1);
    this._initValue(x);
    this._parents.set(x, x);
    this._nbrs.set(x, x);
    this._indices.set(x, this._indices.size);
    this.n_subsets += 1;
  };

  // 原版 __getitem__：path halving。找不到就先 add，所以对未见过的元素调用是安全的。
  _DisjointBase.prototype.find = function (x) {
    if (!this._indices.has(x)) this.add(x);
    var parents = this._parents;
    while (this._indices.get(x) !== this._indices.get(parents.get(x))) {
      parents.set(x, parents.get(parents.get(x)));
      x = parents.get(x);
    }
    return x;
  };

  _DisjointBase.prototype.merge = function (x, y) {
    var xr = this.find(x);
    var yr = this.find(y);
    if (this._indices.get(xr) === this._indices.get(yr)) return false;

    // 与 Python 元组比较严格等价：size 小的当孩子；size 相同则插入早的当父。
    var sx = this._sizes.get(xr);
    var sy = this._sizes.get(yr);
    if (sx < sy || (sx === sy && this._indices.get(yr) < this._indices.get(xr))) {
      var tmp = xr;
      xr = yr;
      yr = tmp;
    }
    this._parents.set(yr, xr);
    this._sizes.set(xr, this._sizes.get(xr) + this._sizes.get(yr));
    this._mergeValue(xr, yr);
    var nx = this._nbrs.get(xr);
    var ny = this._nbrs.get(yr);
    this._nbrs.set(xr, ny);
    this._nbrs.set(yr, nx);
    this.n_subsets -= 1;
    return true;
  };

  _DisjointBase.prototype.connected = function (x, y) {
    return this.find(x) === this.find(y);
  };

  _DisjointBase.prototype.subset_size = function (x) {
    return this._sizes.get(this.find(x));
  };

  // 沿环形链表把同一集合走一圈。原版靠 _indices 判回环，这里用对象身份。
  _DisjointBase.prototype._walkSubset = function (x) {
    var result = [x];
    var nxt = this._nbrs.get(x);
    while (nxt !== x) {
      result.push(nxt);
      nxt = this._nbrs.get(nxt);
    }
    return result;
  };

  _DisjointBase.prototype.subsets = function () {
    var result = [];
    var visited = new Set();
    var it = this._indices.keys();
    var step = it.next();
    while (!step.done) {
      var x = step.value;
      if (!visited.has(x)) {
        var arr = this._walkSubset(x);
        for (var i = 0; i < arr.length; i++) visited.add(arr[i]);
        result.push(new Set(arr));
      }
      step = it.next();
    }
    return result;
  };

  _DisjointBase.prototype._copyInto = function (copy) {
    copy.n_subsets = this.n_subsets;
    copy._sizes = new Map(this._sizes);
    copy._parents = new Map(this._parents);
    copy._nbrs = new Map(this._nbrs);
    copy._indices = new Map(this._indices);
    return copy;
  };

  /* --------------------------------------------------------- FastDisjointSet
   * 纯并查集，不维护附加值。
   */
  function FastDisjointSet(elements) {
    _DisjointBase.call(this);
    if (elements) {
      var it = elements[Symbol.iterator] ? elements : elements;
      var arr = Array.isArray(elements) ? elements : Array.from(it);
      for (var i = 0; i < arr.length; i++) this.add(arr[i]);
    }
  }
  FastDisjointSet.prototype = Object.create(_DisjointBase.prototype);
  FastDisjointSet.prototype.constructor = FastDisjointSet;

  FastDisjointSet.prototype._initValue = function () { /* 无附加值 */ };
  FastDisjointSet.prototype._mergeValue = function () { /* 无附加值 */ };

  FastDisjointSet.prototype.subset = function (x) {
    this.find(x); // 原版 subset() 不会隐式 add，但调用前通常已 find 过；这里保持只读语义
    return new Set(this._walkSubset(x));
  };

  FastDisjointSet.prototype.copy = function () {
    return this._copyInto(new FastDisjointSet());
  };

  /* --------------------------------------------------- FastDisjointTileSetSum
   * 每个集合额外维护一个浮点和，取值来自 valueLookup.raw[tile.tile_index]。
   * 原版在 add 时就把初值抓进 _sums，所以后续矩阵变化不会回溯影响已有集合。
   */
  function FastDisjointTileSetSum(valueLookup, elements) {
    _DisjointBase.call(this);
    this._sums = new Map();
    this._value_lookup = valueLookup;
    if (elements) {
      var arr = Array.isArray(elements) ? elements : Array.from(elements);
      for (var i = 0; i < arr.length; i++) this.add(arr[i]);
    }
  }
  FastDisjointTileSetSum.prototype = Object.create(_DisjointBase.prototype);
  FastDisjointTileSetSum.prototype.constructor = FastDisjointTileSetSum;

  FastDisjointTileSetSum.prototype._initValue = function (x) {
    this._sums.set(x, this._value_lookup.raw[x.tile_index]);
  };

  FastDisjointTileSetSum.prototype._mergeValue = function (xr, yr) {
    this._sums.set(xr, this._sums.get(xr) + this._sums.get(yr));
  };

  FastDisjointTileSetSum.prototype.subset_with_value = function (x) {
    this.find(x);
    return [new Set(this._walkSubset(x)), this._sums.get(this.find(x))];
  };

  FastDisjointTileSetSum.prototype.subset_value = function (x) {
    return this._sums.get(this.find(x));
  };

  FastDisjointTileSetSum.prototype.subsets_with_values = function () {
    var result = [];
    var visited = new Set();
    var it = this._indices.keys();
    var step = it.next();
    while (!step.done) {
      var x = step.value;
      if (!visited.has(x)) {
        var pair = this.subset_with_value(x);
        pair[0].forEach(function (t) { visited.add(t); });
        result.push(pair);
      }
      step = it.next();
    }
    return result;
  };

  FastDisjointTileSetSum.prototype.copy = function () {
    var copy = this._copyInto(new FastDisjointTileSetSum(this._value_lookup));
    copy._sums = new Map(this._sums);
    return copy;
  };

  /* ---------------------------------------------- FastDisjointTileSetMultiSum
   * 同一个集合维护多个浮点和（多个 valueLookup 矩阵逐下标累加）。
   * 原版把各分量放在一个 list 里，merge 时按 index 逐个相加；这里照抄成数组。
   */
  function FastDisjointTileSetMultiSum(valueLookups, elements) {
    _DisjointBase.call(this);
    this._sums = new Map();
    this._value_lookups = valueLookups || [];
    this._num_vals = this._value_lookups.length;
    if (elements) {
      var arr = Array.isArray(elements) ? elements : Array.from(elements);
      for (var i = 0; i < arr.length; i++) this.add(arr[i]);
    }
  }
  FastDisjointTileSetMultiSum.prototype = Object.create(_DisjointBase.prototype);
  FastDisjointTileSetMultiSum.prototype.constructor = FastDisjointTileSetMultiSum;

  FastDisjointTileSetMultiSum.prototype._initValue = function (x) {
    var vals = new Array(this._num_vals);
    for (var i = 0; i < this._num_vals; i++) vals[i] = this._value_lookups[i].raw[x.tile_index];
    this._sums.set(x, vals);
  };

  FastDisjointTileSetMultiSum.prototype._mergeValue = function (xr, yr) {
    var xrVals = this._sums.get(xr);
    var yrVals = this._sums.get(yr);
    for (var i = 0; i < this._num_vals; i++) xrVals[i] += yrVals[i];
  };

  FastDisjointTileSetMultiSum.prototype.subset_with_values = function (x) {
    this.find(x);
    return [new Set(this._walkSubset(x)), this._sums.get(this.find(x))];
  };

  FastDisjointTileSetMultiSum.prototype.subset_values = function (x) {
    return this._sums.get(this.find(x));
  };

  FastDisjointTileSetMultiSum.prototype.subsets_with_values = function () {
    var result = [];
    var visited = new Set();
    var it = this._indices.keys();
    var step = it.next();
    while (!step.done) {
      var x = step.value;
      if (!visited.has(x)) {
        var pair = this.subset_with_values(x);
        pair[0].forEach(function (t) { visited.add(t); });
        result.push(pair);
      }
      step = it.next();
    }
    return result;
  };

  FastDisjointTileSetMultiSum.prototype.copy = function () {
    var copy = this._copyInto(new FastDisjointTileSetMultiSum(this._value_lookups));
    copy._sums = new Map();
    var self = this;
    this._sums.forEach(function (vals, key) { copy._sums.set(key, vals.slice()); });
    return copy;
  };

  EK.FastDisjointSet = FastDisjointSet;
  EK.FastDisjointTileSetSum = FastDisjointTileSetSum;
  EK.FastDisjointTileSetMultiSum = FastDisjointTileSetMultiSum;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * pysetorder —— 复刻 CPython set 的迭代序。
 *
 * 原版（generals-bot）大量出现这种写法：把一堆 Tile 放进 set（或从 set 里做
 * comprehension 生成 list），再拿这个 list 当 BFS 起点 / 贪心顺序。于是「先摸到
 * 哪一格」由 CPython 的哈希表槽位决定，而不是插入序——JS 的 Set/Map 是插入序，
 * 直接搬过来就会在地图雾推断里一格一格地漂，最后变成决策级分叉。
 *
 * python 侧 Tile.__hash__ 就是 tile_index（base/client/tile.py），所以初始槽位 =
 * tile_index & (cap-1)。三条规则必须同时如实重放，缺一条顺序就对不上：
 *   1. 探测 = 先看表 i，再看 i+1..i+LINEAR_PROBES（Objects/setobject.c，3.11+ 起
 *      LINEAR_PROBES = 9），整段都没有空位才做 perturb 跳：
 *      perturb >>= 5; i = (i*5 + 1 + perturb) & mask（先移位再参与，早期版本写反过）。
 *   2. 扩容 = fill*5 >= mask*3 时按 used*4（used > 50000 时 2x）申请，取不小于它的
 *      2 的幂，然后**按旧表槽位序**重插（按插入序重插会得到不同布局）。
 *   3. 删除 = 留 dummy 槽（hash = -1），不缩容；插入优先复用第一个 dummy。所以
 *      「建一次 set 再反复删」的遍历序必须由同一张表决定，中途重建就错了。
 *
 * 四条后来人会踩的校准（每条都是实测 A/B 才定下来的，别按直觉改回去）：
 *   A. 线性探测是「先扫 i+1..i+9 这一整段，都没空位才做 perturb 跳」；把 i..i+9 写成
 *      逐格 perturb 会让 16 元素集合的顺序差三格（BFS 起点序跟着错）。
 *   B. 扩容判定发生在**插入之后**（place 完才 fill*5 >= mask*3 → resize(used*4)）；
 *      挪到插入之前，5 元素集合会停在 cap 8 而 CPython 是 cap 32，整档错位。
 *   C. nextPow2 用 `<=`（`while (cap <= minused) cap *= 2`），不是 `<`；初始 cap 固定
 *      PySet_MINSIZE=8，不能拿 nextPow2(8) 当初始值（那会变 16）。
 *   D. set.copy()/set_merge 是**按 used*2 预分配**的，所以 copy 出来的表容量比原表大一档
 *      （16 元素：cap 32 → cap 64），迭代序随之改变 —— 见 pySetCopyOrder。
 *      原版 python 里 `connectedTiles.copy()` 后的那份序才是 BFS 起点序。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 浏览器里没有 process，裸读 process.env 会 ReferenceError，打断整回合决策。
  function dbgFlag(name) {
    try {
      return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
    } catch (e) {
      return undefined;
    }
  }

  var PERF_ON = dbgFlag('GB_PERF') === '1';
  // 单次只有几十微秒，毫秒精度量不准；有 hrtime 就用纳秒累加。
  var HAS_HRTIME = typeof process !== 'undefined' && process.hrtime && typeof process.hrtime.bigint === 'function';

  function perfStart() {
    if (!PERF_ON) return 0;
    return HAS_HRTIME ? process.hrtime.bigint() : Date.now();
  }

  function perfRecord(t0, n) {
    if (!PERF_ON) return;
    var p = EK.perf;
    if (!p) {
      p = EK.perf = { pySetOrderMs: 0, pySetOrderCalls: 0, pySetOrderMaxMs: 0, pySetOrderItems: 0 };
    }
    var ns = HAS_HRTIME ? Number(process.hrtime.bigint() - t0) : (Date.now() - t0) * 1e6;
    var ms = ns / 1e6;
    p.pySetOrderMs += ms;
    p.pySetOrderCalls += 1;
    p.pySetOrderItems += n;
    if (ms > p.pySetOrderMaxMs) p.pySetOrderMaxMs = ms;
  }

  // 退出时打一行汇总（只打一行，不参与跑批解析）。
  if (PERF_ON && typeof process !== 'undefined' && process.once) {
    process.once('exit', function () {
      var p = EK.perf || { pySetOrderMs: 0, pySetOrderCalls: 0, pySetOrderMaxMs: 0, pySetOrderItems: 0 };
      var avgMs = p.pySetOrderCalls ? p.pySetOrderMs / p.pySetOrderCalls : 0;
      console.log(
        '[pyset-perf] calls ' + p.pySetOrderCalls +
          ' totalMs ' + Math.round(p.pySetOrderMs * 1000) / 1000 +
          ' avgMs ' + Math.round(avgMs * 1000) / 1000 +
          ' maxMs ' + Math.round(p.pySetOrderMaxMs * 1000) / 1000 +
          ' items ' + p.pySetOrderItems
      );
    });
  }

  // CPython setobject.c: LINEAR_PROBES = 9（3.11 起加入的短程线性探测）。
  var LINEAR_PROBES = 9;
  // dummy 槽：删除后占位，遍历时跳过，插入时优先复用。
  var DUMMY = { dummy: true };

  /*
   * CPython set_table_resize 的取整是 `while (newsize <= minused) newsize <<= 1;`
   * ——用的是 `<=`，所以 minused=32 会落到 64。这条细节决定 copy() 的容量档位，
   * 写成 `<` 就永远差一档，迭代序跟着错。
   */
  function nextPow2(minused) {
    var cap = 8;
    while (cap <= minused) cap *= 2;
    return cap;
  }

  /*
   * 按给定插入序把 hashes 放进 CPython 的 set 表，返回槽位序展开后的 hash 列表。
   * 重复 hash 只按第一次算（CPython 插入已存在的元素不占新槽，也不触发扩容）。
   */
  function pySetSlots(hashes) {
    return pySetSlotsWithCap(hashes, 8);
  }

  /*
   * 同上，但允许指定初始容量：CPython 的 copy/merge 会按 used*2 预分配，
   * 容量不同 → 碰撞探测不同 → 迭代序不同，所以这条口子必须留着。
   */
  function pySetSlotsWithCap(hashes, initialCap) {
    var n = hashes.length;
    if (n === 0) return [];
    var cap = initialCap || 8;
    var mask = cap - 1;
    var table = new Array(cap).fill(null);
    var fill = 0;
    var used = 0;

    function place(h) {
      var perturb = h;
      var i = h & mask;
      /* 上限只防推导写错时死循环：表最多 fill<=3/5 cap，跳表必然收敛。 */
      var guard = cap * 8;
      for (;;) {
        if (table[i] === null) {
          table[i] = h;
          fill += 1;
          used += 1;
          return true;
        }
        if (table[i] === h) return false;
        if (i + LINEAR_PROBES <= mask) {
          var placed = false;
          for (var j = 0; j < LINEAR_PROBES; j++) {
            var k = i + j + 1;
            if (table[k] === null) {
              table[k] = h;
              fill += 1;
              used += 1;
              placed = true;
              break;
            }
            if (table[k] === h) return false;
          }
          if (placed) return true;
        }
        perturb >>= 5;
        i = (i * 5 + 1 + perturb) & mask;
        if (--guard <= 0) return false;
      }
    }

    // 扩容必须按「旧表槽位序」重插，插入序会得到不同布局——顺序正是这里要复刻的东西。
    function resize(minused) {
      var newcap = nextPow2(minused);
      var old = table;
      var oldcap = cap;
      table = new Array(newcap).fill(null);
      cap = newcap;
      mask = newcap - 1;
      fill = 0;
      used = 0;
      for (var i = 0; i < oldcap; i++) if (old[i] !== null) place(old[i]);
    }

    for (var k = 0; k < n; k++) {
      var h = hashes[k] & 0xffffffff;
      place(h);
      /* 扩容判定在插入之后：CPython 实测第 5 个元素进来（fill=5、mask=7）才翻到 cap 32，
         提前到插入前会让 5 元素集合停在 cap 8，槽位序整体错开。 */
      if (fill * 5 >= mask * 3) resize(used > 50000 ? used * 2 : used * 4);
    }
    var out = [];
    for (var s = 0; s < cap; s++) if (table[s] !== null) out.push(table[s]);
    return out;
  }

  /*
   * 摊平成 tile 数组。除了 Set / 数组，还要挡住两类会被上层误传进来的东西：
   * Map（`Array.from` 会给 [key, value] 数组）和含空位的数组（洞会变 undefined）。
   * 真机上把 Map 当 tile 集合传进来时，报出来是 `Cannot read properties of
   * undefined (reading 'tile_index')`，位置在这里而不是真正传错的那一层，所以在这里
   * 就把不合法的元素滤掉，别让它继续往下游扩散。
   */
  function toTiles(coll) {
    if (typeof coll.toTiles === 'function') coll = coll.toTiles();
    else if (coll instanceof Map) coll = Array.from(coll.keys());
    else coll = Array.from(coll);
    var out = [];
    for (var i = 0; i < coll.length; i++) {
      var t = coll[i];
      if (t && typeof t.tile_index === 'number') out.push(t);
    }
    return out;
  }

  /*
   * 把一组 tile 按 CPython set 的迭代序排好。原版那段代码只要是 `set(...)`（哪怕
   * 是先按 list 排好的），都一定要过这里：新 set 会重新建表，槽位序和父集合不同。
   */
  function pyHashOrder(tiles) {
    if (tiles === null || tiles === undefined) return [];
    var arr = Array.isArray(tiles) ? tiles.slice() : toTiles(tiles);
    if (arr.length <= 1) return arr;
    var t0 = perfStart();
    var hashes = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) hashes[i] = arr[i].tile_index;
    var order = pySetSlots(hashes);
    var byIdx = new Map();
    for (var j = 0; j < arr.length; j++) byIdx.set(arr[j].tile_index, arr[j]);
    var out = new Array(order.length);
    for (var m = 0; m < order.length; m++) out[m] = byIdx.get(order[m]);
    perfRecord(t0, arr.length);
    return out;
  }

  function pyOrderedSet(tiles) {
    return new Set(pyHashOrder(tiles));
  }

  /*
   * python 的 `set(other)` / `other.copy()` 不是「按成员逐个 add」：CPython 的
   * set_merge 会先 `set_table_resize(so, (used + other->used) * 2)`，也就是按
   * **两倍成员数**预分配。于是 copy 出来的表容量常常比原表大一档，槽位序也就变了
   * （16 个成员的 set：原表 cap 32，copy 后 cap 64，迭代序完全不同）。原版
   * `secondIterConnected = connectedTiles.copy()` 正好踩这个，必须用 copy 语义。
   */
  function pySetCopyOrder(tiles, presizeFactor) {
    if (tiles === null || tiles === undefined) return [];
    var arr = Array.isArray(tiles) ? tiles.slice() : toTiles(tiles);
    if (arr.length <= 1) return arr;
    var t0 = perfStart();
    var factor = presizeFactor === undefined ? 2 : presizeFactor;
    var hashes = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) hashes[i] = arr[i].tile_index;
    var order = pySetSlotsWithCap(hashes, nextPow2(arr.length * factor));
    var byIdx = new Map();
    for (var j = 0; j < arr.length; j++) byIdx.set(arr[j].tile_index, arr[j]);
    var out = new Array(order.length);
    for (var m = 0; m < order.length; m++) out[m] = byIdx.get(order[m]);
    perfRecord(t0, arr.length);
    return out;
  }

  /*
   * 把「python 里的 set」摊成数组。传数组进来表示原版本来就是 list（例：
   * determine_tiles_to_fill_in 部分调用点传的是 list），原样返回。
   */
  function pySetOrderIndices(coll) {
    if (coll === null || coll === undefined) return [];
    if (Array.isArray(coll)) return coll;
    return pyHashOrder(coll);
  }

  /*
   * 有状态的等价物：原版常常「建一次 set，然后反复遍历 / 删除」。CPython 删除元素
   * 留 dummy、不缩容，所以遍历序在整个生命周期里用的是同一张表——中途按剩余元素
   * 重建会得到不同的 cap，顺序就错了。trim_spanning_tree_ends_as_new_set 是这种用法。
   *
   * 对外接口刻意做成 Set 的常用子集（size / has / forEach / 迭代器），可以当返回值
   * 直接给只读 set 的调用方用；迭代序 = CPython 槽位序。
   */
  function PySet(items) {
    this._cap = 8;
    this._mask = this._cap - 1;
    this._table = new Array(this._cap).fill(null);
    this._fill = 0;
    this._used = 0;
    this.size = 0;
    if (items) {
      var seed = Array.isArray(items) ? items : toTiles(items);
      for (var i = 0; i < seed.length; i++) this.add(seed[i]);
    }
  }

  PySet.prototype._scan = function (idx) {
    var mask = this._mask;
    var perturb = idx & 0xffffffff;
    var i = idx & mask;
    var freeslot = -1;
    var guard = this._cap * 8;
    for (;;) {
      var e = this._table[i];
      if (e === null) return { found: -1, free: freeslot >= 0 ? freeslot : i };
      if (e === DUMMY) {
        if (freeslot < 0) freeslot = i;
      } else if (e.tile_index === idx) {
        return { found: i, free: -1 };
      }
      if (i + LINEAR_PROBES <= mask) {
        for (var j = 0; j < LINEAR_PROBES; j++) {
          var k = i + j + 1;
          var e2 = this._table[k];
          if (e2 === null) return { found: -1, free: freeslot >= 0 ? freeslot : k };
          if (e2 === DUMMY) {
            if (freeslot < 0) freeslot = k;
          } else if (e2.tile_index === idx) {
            return { found: k, free: -1 };
          }
        }
      }
      perturb >>= 5;
      i = (i * 5 + 1 + perturb) & mask;
      if (--guard <= 0) return { found: -1, free: freeslot };
    }
  };

  PySet.prototype._resize = function (minused) {
    var newcap = nextPow2(minused);
    var old = this._table;
    var oldcap = this._cap;
    this._table = new Array(newcap).fill(null);
    this._cap = newcap;
    this._mask = newcap - 1;
    this._fill = 0;
    this._used = 0;
    for (var i = 0; i < oldcap; i++) {
      var e = old[i];
      if (e !== null && e !== DUMMY) this._insert(e);
    }
    this.size = this._used;
  };

  PySet.prototype._insert = function (tile) {
    var r = this._scan(tile.tile_index);
    if (r.found >= 0) return false;
    var at = r.free;
    if (at < 0) return false;
    var wasDummy = this._table[at] === DUMMY;
    this._table[at] = tile;
    this._used += 1;
    if (!wasDummy) this._fill += 1;
    this.size = this._used;
    return true;
  };

  PySet.prototype.add = function (tile) {
    var added = this._insert(tile);
    /* 同 pySetSlotsWithCap：扩容判定在插入之后（第 5 个元素进来才翻档）。 */
    if (this._fill * 5 >= this._mask * 3) {
      this._resize(this._used > 50000 ? this._used * 2 : this._used * 4);
    }
    return added;
  };

  PySet.prototype.has = function (tile) {
    return this._scan(tile.tile_index).found >= 0;
  };

  PySet.prototype.delete = function (tile) {
    var at = this._scan(tile.tile_index).found;
    if (at < 0) return false;
    this._table[at] = DUMMY;
    this._used -= 1;
    this.size = this._used;
    return true;
  };

  // 迭代序：按槽位升序（dummy 跳过）。
  PySet.prototype.order = function () {
    var out = [];
    for (var i = 0; i < this._cap; i++) {
      var e = this._table[i];
      if (e !== null && e !== DUMMY) out.push(e);
    }
    return out;
  };

  PySet.prototype.forEach = function (fn, thisArg) {
    var out = this.order();
    for (var i = 0; i < out.length; i++) fn.call(thisArg, out[i], out[i], this);
  };

  PySet.prototype[Symbol.iterator] = function () {
    return this.order()[Symbol.iterator]();
  };

  /*
   * 整数 set 的迭代序（例如 OrToolsFlowDirectionFinder 里的 all_node_ids）。
   * 和 pySetSlots 的区别：元素相等按「值」判（哈希相同但值不同是两个元素），
   * 因为 python 的整数哈希有 hash(-1) == hash(-2) == -2 这个坑，节点 id 里 -1 和
   * -2 会真的撞在同一个初始槽位上。hashFn 默认按 CPython 的 int 哈希。
   */
  function pyIntHash(v) {
    return v === -1 ? -2 : v;
  }

  function pySetValueOrder(values, hashFn) {
    var n = values.length;
    if (n === 0) return [];
    var hf = hashFn || pyIntHash;
    var cap = 8;
    var mask = 7;
    var table = new Array(cap).fill(null);
    var fill = 0;
    var used = 0;

    function place(h, v) {
      var perturb = h;
      var i = h & mask;
      var guard = cap * 8;
      for (;;) {
        var e = table[i];
        if (e === null) {
          table[i] = { h: h, v: v };
          fill += 1;
          used += 1;
          return true;
        }
        if (e.h === h && e.v === v) return false;
        if (i + LINEAR_PROBES <= mask) {
          var placed = false;
          for (var j = 0; j < LINEAR_PROBES; j++) {
            var k = i + j + 1;
            var e2 = table[k];
            if (e2 === null) {
              table[k] = { h: h, v: v };
              fill += 1;
              used += 1;
              placed = true;
              break;
            }
            if (e2.h === h && e2.v === v) return false;
          }
          if (placed) return true;
        }
        perturb >>= 5;
        i = (i * 5 + 1 + perturb) & mask;
        if (--guard <= 0) return false;
      }
    }

    function resize(minused) {
      var newcap = nextPow2(minused);
      var old = table;
      var oldcap = cap;
      table = new Array(newcap).fill(null);
      cap = newcap;
      mask = newcap - 1;
      fill = 0;
      used = 0;
      for (var i = 0; i < oldcap; i++) {
        var e = old[i];
        if (e !== null) place(e.h, e.v);
      }
    }

    for (var t = 0; t < n; t++) {
      place(hf(values[t]), values[t]);
      if (fill * 5 >= mask * 3) resize(used > 50000 ? used * 2 : used * 4);
    }

    var out = [];
    for (var s = 0; s < cap; s++) {
      var slot = table[s];
      if (slot !== null) out.push(slot.v);
    }
    return out;
  }

  EK.PySetOrder = {
    pySetValueOrder: pySetValueOrder,
    pyIntHash: pyIntHash,
    pySetSlots: pySetSlots,
    pySetSlotsWithCap: pySetSlotsWithCap,
    pyHashOrder: pyHashOrder,
    pySetCopyOrder: pySetCopyOrder,
    pyOrderedSet: pyOrderedSet,
    pySetOrderIndices: pySetOrderIndices,
    PySet: PySet
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

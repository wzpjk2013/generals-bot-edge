/* =====================================================================
 * EK.PyRandom —— CPython random 模块的逐位复刻（MT19937）
 *
 * 为什么要它：原版 Python 的决策链里有真随机（BotExpansionOps.py:127 选扩张起点、
 * :1143 选叶子招、BotTimings.py:389 randint(-2,2) 抖发射时机、EarlyExpandUtils
 * 的 shuffle / choice、BotComms 选 tip），对拍时靠 `random.seed(0)` 固定。
 * 移植版若用 Math.random，同一 seed 每次跑结果都不一样：既没法跟原版逐招对拍，
 * 也没法做 A/B —— 而 A/B 是判断"改得对不对"的唯一信号。
 *
 * 所以这里照 CPython 3.12 的 Lib/random.py 实现：
 *   random()            = genrand_res53（两个 32 位字拼 53 位）
 *   getrandbits(k)      = k<=32 取高位；k>32 逐字小端拼接
 *   _randbelow(n)       = getrandbits(n.bit_length()) 重采样直到 < n
 *   randrange/randint/choice/shuffle/sample 一律走 _randbelow
 * 只有这几个原版用到的入口，别的（gauss/betavariate 等）不实现。
 *
 * 陷阱：JS 没有 32 位无符号乘法，`a * b` 会丢精度；乘法一律 Math.imul，
 * 加法后 `>>> 0`。
 * ===================================================================== */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  var N = 624;
  var M = 397;
  var MATRIX_A = 0x9908b0df;
  var UPPER_MASK = 0x80000000;
  var LOWER_MASK = 0x7fffffff;

  function PyRandom(seed) {
    this.mt = new Array(N);
    this.mti = N + 1;
    if (seed !== undefined && seed !== null) this.seed(seed);
    else this.seed(0);
  }

  PyRandom.prototype.seed = function (s) {
    // CPython 对 int 种子走 init_by_array(seed & 0xffffffff 拆字)，但对
    // seed=0 这种小整数等价于 init_genrand；这里照 init_by_array 的原样实现，
    // 才能和 random.seed(0) 之后的序列逐位一致。
    var a = this._int_to_words(s);
    this._init_by_array(a);
  };

  // 把非负整数拆成 32 位小端字数组（CPython _randommodule.c random_seed 同语义）
  PyRandom.prototype._int_to_words = function (s) {
    var n = typeof s === 'bigint' ? s : BigInt(Math.trunc(Number(s)));
    if (n < 0n) n = -n;
    var words = [];
    if (n === 0n) return [0];
    while (n > 0n) {
      words.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    return words;
  };

  // CPython _randommodule.c init_genrand
  PyRandom.prototype._init_genrand = function (s) {
    var mt = this.mt;
    mt[0] = s >>> 0;
    for (var i = 1; i < N; i++) {
      var prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  };

  // CPython _randommodule.c init_by_array
  PyRandom.prototype._init_by_array = function (key) {
    var mt = this.mt;
    var initKeyLength = key.length;
    this._init_genrand(19650218);
    var i = 1;
    var j = 0;
    var k = N > initKeyLength ? N : initKeyLength;
    for (; k > 0; k--) {
      var prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= initKeyLength) j = 0;
    }
    for (k = N - 1; k > 0; k--) {
      var prev2 = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev2, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.mti = N;
  };

  // CPython genrand_uint32
  PyRandom.prototype._genrand_uint32 = function () {
    var mt = this.mt;
    var y;
    if (this.mti >= N) {
      var kk;
      if (this.mti === N + 1) this._init_genrand(5489);
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };

  // genrand_res53：53 位精度，CPython random()
  PyRandom.prototype.random = function () {
    var a = this._genrand_uint32() >>> 5;
    var b = this._genrand_uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  };

  PyRandom.prototype.getrandbits = function (k) {
    if (k <= 32) return this._genrand_uint32() >>> (32 - k);
    // CPython：little-endian 逐字填，但**最高字**只取高 (k mod 32) 位
    // （genrand_uint32() >> (32 - k)），不是取低位再统一掩码 —— 两者位序不同。
    var words = Math.floor((k - 1) / 32) + 1;
    var acc = 0n;
    var left = k;
    for (var i = 0; i < words; i++) {
      var w;
      if (left < 32) w = this._genrand_uint32() >>> (32 - left);
      else w = this._genrand_uint32();
      acc |= BigInt(w) << BigInt(32 * i);
      left -= 32;
    }
    return Number(acc);
  };

  PyRandom.prototype._randbelow = function (n) {
    if (n <= 0) throw new Error('_randbelow(' + n + ')');
    var k = 1;
    while ((1 << k) <= n) k++;
    var r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  };

  PyRandom.prototype.randrange = function (start, stop, step) {
    if (stop === undefined) { stop = start; start = 0; }
    if (step === undefined) step = 1;
    var width = stop - start;
    if (step === 1) return start + this._randbelow(width);
    var n = Math.floor((width + step - (step > 0 ? 1 : -1)) / step);
    return start + step * this._randbelow(n);
  };

  PyRandom.prototype.randint = function (a, b) {
    return this.randrange(a, b + 1);
  };

  PyRandom.prototype.choice = function (seq) {
    var arr = Array.isArray(seq) ? seq : Array.from(seq);
    if (!arr.length) throw new Error('choice() 空序列');
    return arr[this._randbelow(arr.length)];
  };

  // CPython shuffle：倒序扫，j = _randbelow(i+1)
  PyRandom.prototype.shuffle = function (x) {
    for (var i = x.length - 1; i > 0; i--) {
      var j = this._randbelow(i + 1);
      var t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  };

  // 只实现无放回抽 k 个（CPython 对 k <= n/2 走 pool 算法，这里统一用
  // 与 CPython 相同的 "k<=n/2 用 pool" 分支，避免与原版序列错位）
  PyRandom.prototype.sample = function (population, k) {
    var pool = Array.isArray(population) ? population.slice() : Array.from(population);
    var n = pool.length;
    if (k < 0 || k > n) throw new Error('sample: k 越界');
    if (k * 2 <= n) {
      var setsize = 21;
      if (k > 5) setsize += Math.pow(4, Math.ceil(Math.log(k * 3) / Math.log(4)));
      if (n <= setsize) {
        for (var i = 0; i < k; i++) {
          var j = this._randbelow(n - i);
          var t = pool[j]; pool[j] = pool[n - i - 1]; pool[n - i - 1] = t;
        }
      } else {
        // CPython 用 set 去重；元素可能是对象，按引用记
        var selected = new Set();
        var out = [];
        while (out.length < k) {
          var idx = this._randbelow(n);
          var item = pool[idx];
          if (!selected.has(item)) { selected.add(item); out.push(item); }
        }
        return out.reverse();
      }
      var res = pool.slice(n - k);
      return res.reverse();
    }
    var p2 = pool.slice();
    for (var i2 = 0; i2 < k; i2++) {
      var j2 = this._randbelow(n - i2);
      var t2 = p2[j2]; p2[j2] = p2[n - i2 - 1]; p2[n - i2 - 1] = t2;
    }
    var out2 = p2.slice(n - k);
    out2.reverse();
    return out2;
  };

  PyRandom.prototype.getstate = function () {
    return { mt: this.mt.slice(), mti: this.mti };
  };

  PyRandom.prototype.setstate = function (st) {
    this.mt = st.mt.slice();
    this.mti = st.mti;
  };

  EK.PyRandom = PyRandom;
  // 全局单例：原版用的是模块级 random，种子由 GB_PY_DETERMINISTIC 固定为 0。
  // JS 侧同样给一个进程级单例，模块直接 EK.rng 调用，等价于 Python 的 random.xxx
  EK.rng = new PyRandom(0);

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);

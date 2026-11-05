/* 统一时钟。
 *
 * 为什么需要它：原版决策链里有大量 `time.perf_counter()` 预算切分（BFS 的 maxTime、
 * gather 迭代的 cutoffTime、watchman 的 timeLimit）。把它们逐字照搬到 JS 的
 * Date.now() 上，就会让「同一局面、同一份回放」在慢机器上少评估几个候选、在快机器上
 * 多评估几个 —— 结果既不能逐招对拍，也不能拿擂台胜率做 A/B（噪声比改动本身大）。
 *
 * 口径：
 *   - 生产（浏览器 / 线上）：`EK.clock` 未固定，nowSec() 就是真实时钟，行为与原版一致，
 *     该截断就截断，保证每回合不超 tick。
 *   - 对拍 / 擂台（脚本侧）：`GB_EK_DET=1` 或 `GB_EK_FIXED_TIME=<秒>` 把时钟钉死。
 *     钉死后所有「到点就 break」的分支永不触发，等价于「时间永远够用」，
 *     于是结果只取决于局面本身 —— 这才是能逐招比的东西。
 */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function envVal(name) {
    if (typeof process === 'undefined' || !process.env) return undefined;
    return process.env[name];
  }

  var fixed = null;
  var fixedEnv = envVal('GB_EK_FIXED_TIME');
  if (fixedEnv !== undefined) {
    var parsed = Number(fixedEnv);
    if (!isNaN(parsed)) fixed = parsed;
  }
  if (fixed === null && envVal('GB_EK_DET') === '1') fixed = 0;

  /*
   * 虚拟时钟（对拍/擂台专用）：`GB_EK_DET_TICK=<秒>` 让「现在」每次被读都前进一个固定量。
   *
   * 为什么还要这一档：`GB_EK_DET=1` 把时钟钉死，等价于「时间永远够用」，所有「到点就 break」
   * 的分支永不触发 ⇒ 搜索跑满全深度，实测单回合从 0.19s 涨到 10s（kutu 档），一场擂台要跑
   * 十几小时，不可用。TICK 模式下预算是有限的（跟真机一个量级），但因为时间只由「被读的次数」
   * 决定、与机器快慢无关，同一份代码跑两遍仍然逐位相同 ⇒ 既能对拍又跑得动。
   *
   * 口径注意：TICK 模式的绝对预算是「读数次数 × tick」，不等于真实毫秒；它只用于「比较两份
   * 代码谁强」，不用于报 stepMs（性能一律走 `realMs()`，不看这里）。默认关闭。
   */
  var tickEnv = envVal('GB_EK_DET_TICK');
  var tick = null;
  var tickBase = 1000;
  var tickCalls = 0;
  if (tickEnv !== undefined) {
    var tickParsed = Number(tickEnv);
    if (!isNaN(tickParsed) && tickParsed > 0) tick = tickParsed;
  }

  function virtualNow() {
    tickCalls += 1;
    return tickBase + tickCalls * tick;
  }

  /*
   * 确定性随机（对拍/擂台专用）。
   *
   * 原版 `map.py:1207-1209` 用 `random.shuffle` 打乱每格的 movable/adjacents/visibleTo，
   * 那是个有状态的伪随机序列；我们早先用 `Math.random()`，同一局面两次跑邻接表顺序不同，
   * 搜索时同代价候选的先后也就不同 ⇒ 整局结果不可复现。这里给一个固定种子的 LCG，
   * 只在需要「同一输入两次跑必须逐位相同」的地方（洗牌、random.choice 兜底）使用。
   * 生产环境同样用它：固定种子不会让对局变差（洗牌本来就只是打散顺序），但可复现。
   */
  var rngState = 1234567;
  function rngNext() {
    // 数值取自 Numerical Recipes 的 LCG，取高 24 位当 [0,1)
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return (rngState >>> 8) / 16777216;
  }

  EK.rng = {
    random: rngNext,
    seed: function (s) {
      var v = Number(s);
      if (!isNaN(v)) rngState = ((v % 4294967296) + 4294967296) % 4294967296;
    },
    /* Fisher-Yates，原地洗牌。与 py `random.shuffle` 同语义。 */
    shuffle: function (arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = (rngNext() * (i + 1)) | 0;
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
    /* 等价 py `random.choice`。 */
    choice: function (arr) {
      return arr[(rngNext() * arr.length) | 0];
    }
  };

  EK.clock = {
    /* 钉死时钟（秒）。传 null 恢复真实时钟。 */
    setFixed: function (value) {
      if (value === null || value === undefined) { fixed = null; return; }
      var v = Number(value);
      if (!isNaN(v)) fixed = v;
    },
    isFixed: function () { return fixed !== null; },
    /* 是否在确定性口径（钉死或虚拟时钟）。脚本用它断言「这批数可复现」。 */
    isDeterministic: function () { return fixed !== null || tick !== null; },
    tickSpacing: function () { return tick; },
    /* 把虚拟时钟拨回原点。botmain 的 find_move 每次决策前调用 ⇒ 每回合拿到同样的预算起点，
     * 与「这一局是第几局、进程跑了多久」无关（真机也是每回合一份新预算）。 */
    resetTick: function () { tickCalls = 0; },
    /* 决策用的「现在」（秒）。钉死时恒等，TICK 模式按读数次数前进。 */
    nowSec: function () {
      if (fixed !== null) return fixed;
      if (tick !== null) return virtualNow();
      return Date.now() / 1000;
    },
    /* 决策用的「现在」（毫秒）。 */
    nowMs: function () {
      if (fixed !== null) return fixed * 1000;
      if (tick !== null) return virtualNow() * 1000;
      return Date.now();
    },
    /* 测量耗时专用：永远走真实时钟，不许被钉死，否则日志里的 ms 变成 0 会误判性能。 */
    realMs: function () { return Date.now(); }
  };
})(globalThis);

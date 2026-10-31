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

  EK.clock = {
    /* 钉死时钟（秒）。传 null 恢复真实时钟。 */
    setFixed: function (value) {
      if (value === null || value === undefined) { fixed = null; return; }
      var v = Number(value);
      if (!isNaN(v)) fixed = v;
    },
    isFixed: function () { return fixed !== null; },
    /* 决策用的「现在」（秒）。钉死时恒等。 */
    nowSec: function () { return fixed !== null ? fixed : Date.now() / 1000; },
    /* 决策用的「现在」（毫秒）。 */
    nowMs: function () { return fixed !== null ? fixed * 1000 : Date.now(); },
    /* 测量耗时专用：永远走真实时钟，不许被钉死，否则日志里的 ms 变成 0 会误判性能。 */
    realMs: function () { return Date.now(); }
  };
})(globalThis);

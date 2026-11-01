/*
 * 真机播放器：把 src/ekrun.js 里 `copy(__GB_DUMP())` 拿到的 JSON 在 Node 里 1:1 重放。
 *
 *   node scripts/ekreplay.js <dump.json> [--trace]
 *
 * 为什么要这么干：线上崩溃经常只在真实局面 + 真实服务器数据下触发，本地擂台（固定
 * 20×20、模拟对手）复现不出来。录原始包回来重放是唯一能拿到完整栈和完整状态的路子。
 * dump 里的 packets 就是原样喂给引擎的服务器包，startData 是开局参数，所以重放必须与
 * 线上那条路径一致：先 `new EK.Map(startData, packet0)`，再补一次 apply_server_update
 * （与原版 Map.__init__ 双吞首包对齐），然后逐包 apply + find_move。
 */
const fs = require('fs');
const path = require('path');
const EKJS = require(path.join(__dirname, 'ekjs.js'));

function main() {
  const file = process.argv[2];
  const trace = process.argv.includes('--trace');
  if (!file) {
    console.error('用法: node scripts/ekreplay.js <dump.json> [--trace]');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const startData = raw.startData;
  const packets = raw.packets || [];
  if (!startData || !packets.length) {
    console.error('dump 里缺 startData 或 packets');
    process.exit(1);
  }
  const errors = [];
  const bot = new EKJS.EkBot({ trace });
  bot.start(startData, packets[0]);
  // start() 已经吞过一次首包；原版 Map.__init__ 也是这样，所以第一包不再重复喂。
  for (let i = 1; i < packets.length; i++) {
    const before = bot.errors;
    let mv = null;
    try {
      mv = bot.turn(packets[i]);
    } catch (e) {
      // 地图层吃不下这个包（线上表现为这一回合空过并重建引擎），别把整个重放打断，
      // 记下来继续——真机 dump 里前几处崩溃之后往往还有后续包可以参考。
      errors.push({ idx: i, turn: -1, msg: (e && e.message) || String(e), stack: (e && e.stack) || '' });
      if (errors.length === 1) {
        console.log(`首次异常（地图层）：packet[${i}]`);
        console.log(errors[0].msg);
        console.log(String(errors[0].stack).split('\n').slice(0, 12).join('\n'));
      }
      if (errors.length > 5) break;
      continue;
    }
    if (bot.errors > before) {
      errors.push({ idx: i, turn: bot.map ? bot.map.turn : -1, msg: bot.lastError, stack: bot.firstStack });
      if (errors.length === 1) {
        console.log(`首次异常：packet[${i}] map.turn=${errors[0].turn}`);
        console.log(errors[0].msg);
        console.log(String(errors[0].stack || '').split('\n').slice(0, 12).join('\n'));
      }
      if (errors.length > 5) break;
    }
    if (trace && mv) {
      // Map 的宽高在 cols/rows（map.js:273-274），不是 w/h
      const W = bot.map ? bot.map.cols : 20;
      const f = mv[0];
      const t = mv[1];
      console.log(`T${bot.map.turn} ${f % W},${Math.floor(f / W)}>${t % W},${Math.floor(t / W)}${mv[2] ? ' half' : ''}`);
    }
  }
  console.log(`回放包数 ${packets.length}，异常 ${bot.errors} 次`);
  if (raw.err) console.log('线上记录的错误：' + (raw.err.frame || '无帧') + ' :: ' + (raw.err.msg || ''));
}

main();

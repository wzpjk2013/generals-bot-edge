/*
 * 决策级对拍：把原版录下来的同一串服务器数据灌进 JS 移植版，逐回合比"出哪一
 * 招"。这是比逐格 dump 更强的 oracle —— 地图层、迷雾推断、态势分析、扩张、
 * 集兵、防守全部要一致，最后才会选出同一招。
 *
 *   node scripts/ekdiff-move.js E:\akcoco6de\_research\ekdump\g1000b.jsonl
 *   node scripts/ekdiff-move.js <dump> --from=50 --to=110 -v
 *
 * 判定口径：
 *   py 有招、js 有招且 (from,to,half) 全同     → 一致
 *   py 有招、js 没招 / 招不同                   → 不一致（记 pyMove / jsMove）
 *   py 没招、js 没招                            → 一致（原版自己这回合 pass）
 *   py 没招、js 有招                            → 不一致（记 jsMove）
 *   py 那回合自己抛过异常（rec.err）→ 跳过，不算分
 *
 * 内存：本脚本只保留逐回合的一行结论，不攒 dump；--to 之后立刻收尾。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./arena.js');

const W = A.W;

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
}
const flag = (name) => process.argv.includes('--' + name);

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
const MODULES = [
  'pyrandom',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'gatherprune', 'botqueries', 'watchmanroute',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense', 'eventhandlers',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion',
  'expandhooks', 'botmain'
];

let EK = null;
function loadEK() {
  if (EK) return EK;
  const skip = new Set(
    (process.env.GB_EK_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  for (const m of MODULES) {
    if (skip.has(m)) continue;
    const p = path.join(ROOT, m + '.js');
    if (!fs.existsSync(p)) continue;
    require(p);
  }
  EK = global.__EK;
  if (!EK || !EK.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return EK;
}

function readRecords(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const recs = [];
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      continue;
    }
    recs.push(r);
  }
  return recs;
}

/* gb_bridge 的 move 是 [fromX, fromY, toX, toY, isHalf]（见 eklump.js 的 applyMove 调用） */
function pyMoveToIdx(mv) {
  if (!mv) return null;
  return [mv[1] * W + mv[0], mv[3] * W + mv[2], !!mv[4]];
}

function fmtMove(mv) {
  if (!mv) return 'pass';
  const f = mv[0];
  const t = mv[1];
  const fx = f % W;
  const fy = Math.floor(f / W);
  const tx = t % W;
  const ty = Math.floor(t / W);
  return fx + ',' + fy + '>' + tx + ',' + ty + (mv[2] ? '|h' : '');
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/ekdiff-move.js <dump.jsonl> [--from=N] [--to=N] [-v]');
    process.exit(2);
  }
  const from = Number(arg('from', '0'));
  const to = Number(arg('to', '100000'));
  const verbose = flag('v');

  const recs = readRecords(file);
  if (!recs.length) throw new Error('记录为空: ' + file);

  let startRec = null;
  let firstTurnRec = null;
  for (const r of recs) {
    if (r.start) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }

  const ek = loadEK();
  const startData = startRec ? startRec.startData : {
    playerIndex: 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diffmove',
    game_type: 'custom',
    options: {}
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;

  const map = new ek.Map(startData, startPacket, { shuffle: false });
  // 只有 dump 里带 start 记录时，第一个 data 才是"被 Map.__init__ 吞过一次的开局包"，
  // 这时要补吞一次对齐 py 的 Map.__init__ 语义；没有 start 记录的 dump（cA~cD、gA2、
  // g3000 等）第一条就是 turn1 的真实包，再吞一次等于把 T1 应用两遍，全盘错位。
  if (startRec) map.apply_server_update(startPacket);
  const bot = new ek.Bot(startData);
  bot.initialize_from_map_for_first_time(map);

  let same = 0;
  let diff = 0;
  let skipped = 0;
  const diffs = [];

  // 没有 start 记录的旧 dump（gA2/g3000/g5000/g1000）：录制器当时没有把开局包单独落盘，
  // 那个包既被 Map.__init__ 吞过又被第一次 turn 重发，所以 JS 侧也要再应用一次才能对齐。
  // 有 start 记录的 dump（gm1 之后）走上面 startPacket 那条路，同理会补应用一次。
  for (const rec of recs) {
    if (rec.start) continue;
    const turn = rec.turn;
    // --from/--to 只影响"算不算分"：每回合都必须真的跑一遍，
    // 状态是累积的（OpponentTracker 的 cycle 统计、ArmyTracker 的迷雾推断），
    // 跳过回合会让后续对拍全错。
    const inRange = turn >= from && turn <= to;
    if (turn > to) break;
    if (rec.err) {
      skipped++;
      continue;
    }
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      // 招法一旦分叉，原版的迷雾推断就吃不下后续的真实数据了。
      // 这里不掩盖：直接报出分叉点，前面的一致数才算数。
      console.log('T' + turn + ' 应用服务器数据失败（前序招法已分叉）: ' + e.message);
      console.log('分叉前一致 ' + same + ' 回合，不一致 ' + diff + ' 回合');
      break;
    }
    bot.perf_timer.record_update(map.turn, Date.now());
    let jsMove = null;
    let err = null;
    try {
      const mv = bot.find_move();
      if (mv && mv.source && mv.dest) {
        jsMove = [mv.source.tile_index, mv.dest.tile_index, !!mv.move_half];
      }
    } catch (e) {
      err = e;
      if (process.env.GB_EK_RAISE) throw e;
    }
    const pyMove = pyMoveToIdx(rec.move);
    if (!inRange) continue;
    const isSame = err ? false : (
      pyMove === null && jsMove === null ? true
        : pyMove && jsMove && pyMove[0] === jsMove[0] && pyMove[1] === jsMove[1] && pyMove[2] === jsMove[2]
    );
    if (isSame) same++;
    else {
      diff++;
      const line = 'T' + turn + '  py='
        + (rec.move ? (rec.move[0] + ',' + rec.move[1] + '>' + rec.move[2] + ',' + rec.move[3] + (rec.move[4] ? '|h' : '')) : 'pass')
        + '  js=' + (err ? ('ERR ' + err.message) : fmtMove(jsMove));
      diffs.push(line);
      if (verbose) console.log('  ' + line);
    }
    if (process.env.GB_EK_STATE) {
      const b = bot;
      const ep = b.expansion_plan;
      console.log('  state T' + turn
        + ' expPlan=' + (ep ? (ep.selected_option ? 'sel' : 'empty') : 'null')
        + ' curPath=' + (b.curPath ? ('len' + (b.curPath.length || 0)) : 'null')
        + ' genArmy=' + (b.general ? b.general.army : '-')
        + ' tiles=' + (b.player ? b.player.tileCount : '-'));
    }
  }

  const total = same + diff;
  console.log('对拍回合 ' + total + '（跳过 ' + skipped + ' 个原版自己抛异常的回合）');
  console.log('一致 ' + same + '  不一致 ' + diff + '  一致率 '
    + (total ? ((same / total) * 100).toFixed(2) : '0.00') + '%');
  if (diffs.length) {
    console.log('前 25 处不一致：');
    for (const d of diffs.slice(0, 25)) console.log('  ' + d);
  }
}

main();

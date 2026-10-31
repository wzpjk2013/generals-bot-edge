/*
 * flow 扩张计划对拍：把原版在真 bot 里录下的 get_expansion_options 输入/输出，
 * 跟 JS 移植版在同一份服务器数据上算出来的结果逐字段比。
 *
 * 为什么要走整个 bot 回放：这一层的输入（negativeTiles / additional_options /
 * army override / enemyAttackPathTiles）全由 bot 上游的迷雾推断、威胁路径、
 * 拦截器算出，造出来的假输入没法证明移植版接对了。
 *
 *   node scripts/ekdiff-flowopts.js E:\akcoco6de\_research\ekdump\gm1.jsonl E:\akcoco6de\_research\flowexp-gm1.json -v
 *
 * 判定口径：
 *   输入 5 项（turns / negativeTiles / additional_options / army_override_nonzero /
 *   enemyAttackPathTiles+threatBlockingTiles）任一不等 → 该快照记「输入不一致」，
 *   这种情况一般不是 flow 自己的问题，是上游模块先分叉了。
 *   输出：count、每个 plan 的 type / econValue / length / tiles / gathered_army /
 *   value_per_turn，econValue 按 float64 逐位比（不加容差）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
const MODULES = [
  'pyrandom',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion',
  'expandhooks', 'botmain'
];

function loadEK() {
  for (const m of MODULES) {
    const p = path.join(ROOT, m + '.js');
    if (!fs.existsSync(p)) continue;
    require(p);
  }
  const EK = global.__EK;
  if (!EK || !EK.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return EK;
}

function readRecords(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // 半截行（上一次 dump 被杀）忽略
    }
  }
  return out;
}

function tileIdxList(coll) {
  if (!coll) return [];
  const idxs = [];
  if (coll instanceof Set) {
    for (const t of coll) idxs.push(tileIndex(t));
  } else if (Array.isArray(coll)) {
    for (const t of coll) idxs.push(tileIndex(t));
  } else {
    // MapMatrix / 其它可迭代
    for (const t of coll) idxs.push(tileIndex(t));
  }
  return idxs.sort((a, b) => a - b);
}

function tileIndex(t) {
  if (t === null || t === undefined) return -1;
  if (typeof t === 'number') return t;
  return t.tile_index;
}

function planSnapshot(plan) {
  if (!plan) return null;
  let moves = [];
  try {
    moves = plan.get_move_list() || [];
  } catch (e) {
    moves = [];
  }
  let tiles = [];
  if (plan.tileSet) tiles = tileIdxList(plan.tileSet);
  else if (plan.root_nodes) {
    const set = new Set();
    const stack = plan.root_nodes.slice();
    while (stack.length) {
      const cur = stack.pop();
      set.add(cur.tile);
      for (const c of (cur.children || [])) stack.push(c);
    }
    tiles = tileIdxList(set);
  }
  const gathered = plan.gathered_army;
  const vpt = plan.value_per_turn;
  return {
    type: (plan.constructor && plan.constructor.name) || 'Object',
    econValue: Number(plan.econValue || 0),
    length: moves.length,
    tiles: tiles,
    gathered_army: (gathered === undefined || gathered === null) ? null : Number(gathered),
    value_per_turn: (vpt === undefined || vpt === null) ? null : Number(vpt)
  };
}

function sameNum(a, b) {
  return a === b;
}

function arrEq(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* 二元组数组的数值比较：JSON 文本比较会把 12 和 12.0 判成不同，
 * 而这里只关心数值本身。 */
function pairArrEq(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Number(a[i][0]) !== Number(b[i][0])) return false;
    if (Number(a[i][1]) !== Number(b[i][1])) return false;
  }
  return true;
}

function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  const dumpFile = process.argv[2];
  const oracleFile = process.argv[3];
  if (!dumpFile || !oracleFile) {
    console.error('用法: node scripts/ekdiff-flowopts.js <dump.jsonl> <flow-oracle.json> [-v]');
    process.exit(2);
  }
  const verbose = process.argv.includes('-v');
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  if (!Array.isArray(oracle) || !oracle.length) throw new Error('oracle 为空: ' + oracleFile);

  const minTurn = Number(process.env.GB_FLOW_MIN_TURN || 50);
  const maxRecords = Number(process.env.GB_FLOW_MAX_RECORDS || 12);

  const ek = loadEK();
  const FE = ek.flow && ek.flow.ArmyFlowExpanderV2;
  if (!FE) throw new Error('EK.flow.ArmyFlowExpanderV2 不存在');

  const captured = [];
  const orig = FE.prototype.get_expansion_options;
  FE.prototype.get_expansion_options = function (islands, asPlayer, targetPlayer, turns,
                                                 boardAnalysis, territoryMap, negativeTiles,
                                                 leafMoves, viewInfo, bonusCapturePointMatrix,
                                                 perfTimer, cutoffTime, additionalOptions,
                                                 armyOverrideMatrix, threatBlockingTiles,
                                                 constrainedFlowPaths, enemyAttackPathTiles) {
    const turn = this.map.turn;
    let rec = null;
    if (turn >= minTurn && captured.length < maxRecords) {
      rec = {
        turn: turn,
        inputs: {
          turns: turns,
          negativeTiles: tileIdxList(negativeTiles),
          additional_options: (additionalOptions || []).map((o) => {
            let len = 0;
            try {
              len = (o.get_move_list() || []).length;
            } catch (e) {
              len = 0;
            }
            return {
              type: (o.constructor && o.constructor.name) || 'Object',
              econValue: Number(o.econValue || 0),
              length: len
            };
          }),
          army_override_nonzero: armyOverrideMatrix
            ? armyOverrideMatrix.raw.reduce((acc, v, i) => {
              if (v !== null && v !== undefined && Number(v) !== 0) acc.push([i, Number(v)]);
              return acc;
            }, [])
            : [],
          enemyAttackPathTiles: enemyAttackPathTiles ? enemyAttackPathTiles.size || enemyAttackPathTiles.length || 0 : 0,
          threatBlockingTiles: threatBlockingTiles ? (threatBlockingTiles.size || threatBlockingTiles.length || 0) : -1
        }
      };
    }
    let out = null;
    let err = null;
    try {
      out = orig.call(this, islands, asPlayer, targetPlayer, turns, boardAnalysis, territoryMap,
        negativeTiles, leafMoves, viewInfo, bonusCapturePointMatrix, perfTimer, cutoffTime,
        additionalOptions, armyOverrideMatrix, threatBlockingTiles, constrainedFlowPaths,
        enemyAttackPathTiles);
    } catch (e) {
      err = e;
      out = null;
    }
    if (rec) {
      const plans = (out && out.expansion_options) ? Array.from(out.expansion_options) : [];
      rec.output = {
        ok: out !== null && out !== undefined,
        count: plans.length,
        plans: plans.map(planSnapshot)
      };
      if (err) rec.output.err = String(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
      captured.push(rec);
    }
    if (err) throw err;
    return out;
  };

  const recs = readRecords(dumpFile);
  if (!recs.length) throw new Error('记录为空: ' + dumpFile);
  let startRec = null;
  let firstTurnRec = null;
  for (const r of recs) {
    if (r.start) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }
  const startData = startRec ? startRec.startData : {
    playerIndex: 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diffflowopts',
    game_type: 'custom',
    options: {}
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;
  const map = new ek.Map(startData, startPacket, { shuffle: false });
  map.apply_server_update(startPacket);
  const bot = new ek.Bot(startData);
  bot.initialize_from_map_for_first_time(map);

  for (const rec of recs) {
    if (rec.start) continue;
    if (rec.err) continue;
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      console.log('T' + rec.turn + ' 应用服务器数据失败（前序招法已分叉）: ' + e.message);
      break;
    }
    bot.perf_timer.record_update(map.turn, Date.now());
    try {
      bot.find_move();
    } catch (e) {
      if (process.env.GB_EK_RAISE) throw e;
      console.log('T' + rec.turn + ' find_move 抛错: ' + e.message);
      break;
    }
    if (captured.length >= maxRecords) break;
  }
  FE.prototype.get_expansion_options = orig;

  const byTurn = new Map();
  for (const c of captured) byTurn.set(c.turn, c);

  let snaps = 0;
  let clean = 0;
  let inputBad = 0;
  const diffs = [];
  for (const ora of oracle) {
    snaps++;
    const js = byTurn.get(ora.turn);
    if (!js) {
      inputBad++;
      diffs.push('T' + ora.turn + '  JS 没录到这次调用（上游没走到 flow 扩张）');
      continue;
    }
    const inDiff = [];
    const oi = ora.inputs;
    const ji = js.inputs;
    if (oi.turns !== ji.turns) inDiff.push('turns ' + oi.turns + ' != ' + ji.turns);
    if (!arrEq(oi.negativeTiles, ji.negativeTiles)) {
      inDiff.push('negativeTiles py=' + JSON.stringify(oi.negativeTiles) + ' js=' + JSON.stringify(ji.negativeTiles));
    }
    if (!jsonEq(oi.additional_options, ji.additional_options)) {
      inDiff.push('additional_options py=' + JSON.stringify(oi.additional_options) + ' js=' + JSON.stringify(ji.additional_options));
    }
    if (!pairArrEq(oi.army_override_nonzero, ji.army_override_nonzero)) {
      const oa = oi.army_override_nonzero.filter((p) => p[1] !== 0).length;
      const ja = ji.army_override_nonzero.length;
      inDiff.push('army_override 非零项数 py=' + oa + ' js=' + ja
        + '（首处 py=' + JSON.stringify(oi.army_override_nonzero[0]) + ' js=' + JSON.stringify(ji.army_override_nonzero[0]) + '）');
    }
    if (oi.enemyAttackPathTiles !== ji.enemyAttackPathTiles) {
      inDiff.push('enemyAttackPathTiles ' + oi.enemyAttackPathTiles + ' != ' + ji.enemyAttackPathTiles);
    }
    if (oi.threatBlockingTiles !== ji.threatBlockingTiles) {
      inDiff.push('threatBlockingTiles ' + oi.threatBlockingTiles + ' != ' + ji.threatBlockingTiles);
    }
    if (inDiff.length) {
      inputBad++;
      diffs.push('T' + ora.turn + ' 输入不一致: ' + inDiff.join(' | '));
      if (verbose) console.log('  ' + diffs[diffs.length - 1]);
      continue;
    }
    const oo = ora.output;
    const jo = js.output;
    const outDiff = [];
    if (oo.ok !== jo.ok) outDiff.push('ok ' + oo.ok + ' != ' + jo.ok);
    if (oo.count !== jo.count) outDiff.push('count ' + oo.count + ' != ' + jo.count);
    const n = Math.min(oo.plans.length, jo.plans.length);
    for (let i = 0; i < n; i++) {
      const a = oo.plans[i];
      const b = jo.plans[i];
      if (!a || !b) { outDiff.push('plan[' + i + '] 一方为 null'); continue; }
      if (a.type !== b.type) outDiff.push('plan[' + i + '].type ' + a.type + ' != ' + b.type);
      if (!sameNum(a.econValue, b.econValue)) outDiff.push('plan[' + i + '].econValue ' + a.econValue + ' != ' + b.econValue);
      if (a.length !== b.length) outDiff.push('plan[' + i + '].length ' + a.length + ' != ' + b.length);
      if (!arrEq(a.tiles, b.tiles)) {
        outDiff.push('plan[' + i + '].tiles py(' + a.tiles.length + ')=' + JSON.stringify(a.tiles)
          + ' js(' + b.tiles.length + ')=' + JSON.stringify(b.tiles));
      }
      if (a.gathered_army !== b.gathered_army) outDiff.push('plan[' + i + '].gathered_army ' + a.gathered_army + ' != ' + b.gathered_army);
      if (a.value_per_turn !== b.value_per_turn) outDiff.push('plan[' + i + '].value_per_turn ' + a.value_per_turn + ' != ' + b.value_per_turn);
    }
    if (oo.err || jo.err) outDiff.push('异常 py=' + (oo.err ? 'yes' : 'no') + ' js=' + (jo.err ? 'yes' : 'no'));
    if (outDiff.length) {
      diffs.push('T' + ora.turn + ' 输出不一致: ' + outDiff.join(' | '));
      if (verbose) console.log('  ' + diffs[diffs.length - 1]);
    } else {
      clean++;
    }
  }

  if (!verbose) {
    for (const d of diffs.slice(0, 20)) console.log('  ' + d);
  }
  console.log('flow 快照 ' + snaps + '（JS 录到 ' + captured.length + ' 次调用，跳过 ' + inputBad + ' 个输入不一致）');
  console.log('一致 ' + clean + '  不一致 ' + (snaps - clean) + '  一致率 '
    + (snaps ? ((clean / snaps) * 100).toFixed(2) : '0.00') + '%');
}

main();

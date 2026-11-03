/*
 * TileIslandBuilder unique_id 分配序对拍。
 *
 * 为什么需要它：flow 扩张层的 MCF 图里 ortools 的节点编号 = 岛 unique_id 的升序
 * 排名。两侧 uid 分配序不同 ⇒ `Graph::Build` 的 perm 不同 ⇒ 等成本多解选到不同
 * 解；这时即使图结构、供给、弧表全等，逐弧流量也会不同。所以 uid 需要一个直接
 * 指标，而不是靠 flowopts 那种间接指标去猜。
 *
 *   node scripts/ekdiff-islanduid.js <dump.jsonl> [pyIslandUid.json] [outJs.json]
 *
 * <pyIslandUid.json> 由 _research/ekdump_islanduid.py 产出。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
const MODULES = [
  'pyrandom', 'clock', 'pysetorder',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'gatherprune', 'botqueries', 'watchmanroute', 'gathermax', 'fastdisjointset', 'gatherutils',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense', 'eventhandlers',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion', 'iterativeexpansion',
  'expandhooks', 'botmain',
];

function loadEK() {
  for (const m of MODULES) {
    const p = path.join(ROOT, m + '.js');
    if (!fs.existsSync(p)) continue;
    require(p);
  }
  const ek = global.__EK;
  if (!ek || !ek.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return ek;
}

function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      continue;
    }
    out.push(r);
  }
  return out;
}

// TileIsland.tile_set 在 JS 是 Set<Tile>；python 侧 dump 的是升序 tile_index。
function islandRows(builder) {
  if (!builder) return [];
  const all = builder.all_tile_islands;
  const items = all && typeof all.items === 'function' ? all.items() : Array.from(all || []);
  const rows = [];
  for (const isl of items) {
    const tiles = [];
    const set = isl.tile_set;
    if (set) {
      const it = typeof set.values === 'function' ? set.values() : set;
      for (const t of it) tiles.push(t.tile_index);
    }
    tiles.sort((a, b) => a - b);
    rows.push([isl.unique_id, isl.team, tiles]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/ekdiff-islanduid.js <dump.jsonl> [pyIslandUid.json] [outJs.json]');
    process.exit(2);
  }
  const pyPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const outPath = process.argv[4] || null;

  const recs = readRecords(file);
  if (!recs.length) throw new Error('记录为空: ' + file);

  let startRec = null;
  let firstTurnRec = null;
  for (const r of recs) {
    if (r.start) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }

  const ek = loadEK();

  // GB_UID_LOG=1：记录每次 unique_id 分配的调用点。uid 分配序对不上时，靠这个
  // 直接看出是哪个建岛分支（recalc 的排序 / 组件的 set 序 / 拆分 / 合并）错位。
  const uidAlloc = [];
  if (process.env.GB_UID_LOG && ek.IslandNamer) {
    const namer = ek.IslandNamer;
    const orig = namer.get_int;
    namer.get_int = function () {
      const uid = orig.apply(namer, arguments);
      const stack = new Error().stack.split('\n').slice(1, 6)
        .map((s) => s.trim().replace(/^at\s+/, ''))
        .join(' <- ');
      uidAlloc.push([uid, map ? map.turn : -1, stack]);
      return uid;
    };
  }

  const startData = startRec ? startRec.startData : {
    playerIndex: (firstTurnRec.dump || {}).player || 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'islanduid',
    game_type: 'custom',
    options: {},
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;

  const map = new ek.Map(startData, startPacket, { shuffle: false });
  if (startRec) map.apply_server_update(startPacket);
  const bot = new ek.Bot(startData);
  bot.initialize_from_map_for_first_time(map);

  const jsTurns = [];
  for (const rec of recs) {
    if (rec.start) continue;
    if (rec.err) continue;
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      console.log('T' + rec.turn + ' 应用服务器数据失败: ' + e.message);
      break;
    }
    bot.perf_timer.record_update(map.turn, Date.now());
    try {
      bot.find_move();
    } catch (e) {
      if (process.env.GB_EK_RAISE) throw e;
    }
    jsTurns.push({ turn: map.turn, islands: islandRows(bot.tileIslandBuilder) });
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ turns: jsTurns }));
    console.log('js island uid -> ' + outPath);
  }

  if (process.env.GB_UID_LOG) {
    const p = process.env.GB_UID_OUT || 'uid-alloc-js.json';
    fs.writeFileSync(p, JSON.stringify(uidAlloc));
    console.log('uid 分配记录 ' + uidAlloc.length + ' -> ' + p);
  }

  if (!pyPath || !fs.existsSync(pyPath)) {
    console.log('py islanduid 不存在，跳过对比: ' + pyPath);
    return;
  }

  const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
  const pyByTurn = new Map(py.turns.map((t) => [t.turn, t]));

  const tkey = (tiles) => tiles.join(',');
  let totalIsl = 0;
  let sameUid = 0;
  let diffUid = 0;
  let onlyPy = 0;
  let onlyJs = 0;
  const examples = [];
  const perTurn = [];

  for (const t of jsTurns) {
    const p = pyByTurn.get(t.turn);
    if (!p) continue;
    const pu = new Map();
    for (const row of p.islands) pu.set(tkey(row[2]), row[0]);
    const ju = new Map();
    for (const row of t.islands) ju.set(tkey(row[2]), row[0]);
    let s = 0;
    let d = 0;
    let op = 0;
    let oj = 0;
    for (const [k, uid] of pu) {
      totalIsl++;
      const j = ju.get(k);
      if (j === undefined) {
        op++;
        onlyPy++;
      } else if (j === uid) {
        s++;
        sameUid++;
      } else {
        d++;
        diffUid++;
        if (examples.length < 12) {
          examples.push('T' + t.turn + ' tiles[' + k + '] py=' + uid + ' js=' + j);
        }
      }
    }
    for (const k of ju.keys()) {
      if (!pu.has(k)) {
        oj++;
        onlyJs++;
      }
    }
    perTurn.push({ turn: t.turn, islands: pu.size, same: s, diff: d, onlyPy: op, onlyJs: oj });
  }

  console.log('');
  console.log('岛总数(以 py 为基准) ' + totalIsl
    + ' | uid 相同 ' + sameUid
    + ' | uid 不同 ' + diffUid
    + ' | 仅 py 有 ' + onlyPy
    + ' | 仅 js 有 ' + onlyJs
    + ' | 一致率 ' + (totalIsl ? (100 * sameUid / totalIsl).toFixed(2) : '0.00') + '%');
  for (const r of perTurn) {
    console.log('  T' + r.turn + ' 岛 ' + r.islands + ' 相同 ' + r.same + ' 不同 ' + r.diff
      + (r.onlyPy || r.onlyJs ? (' 仅py ' + r.onlyPy + ' 仅js ' + r.onlyJs) : ''));
  }
  if (examples.length) {
    console.log('uid 不同样例:');
    for (const e of examples) console.log('  ' + e);
  }
  if (diffUid || onlyPy || onlyJs) process.exitCode = 1;
}

main();

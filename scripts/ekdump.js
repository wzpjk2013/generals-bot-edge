/*
 * 录一段「原版 Human.exe 的完整内部状态」当移植 oracle。
 *
 * 每一回合都记两份东西：
 *   in  —— 喂给 Python 的服务器串行化数据（map/cities/generals/scores，和真服务器同格式）
 *   dump —— apply_server_update 之后、决策之前的逐格状态（Tile 全部字段、地图级
 *           pathable/reachable、将军距离场）
 * 决策之后的 dumpPost 也留着，用来对齐迷雾军力推断那一层。
 *
 *   node scripts/ekdump.js out.jsonl [--opp=gc] [--seed=1000] [--turns=200] [--pySide=0]
 *
 * 移植校验：node scripts/ekdiff.js out.jsonl —— 把同一串 in 灌进 JS 移植版，
 * 逐字段比对 dump。不一致的字段名和格子坐标会直接打出来。
 */
'use strict';

const fs = require('fs');
const A = require('./arena.js');
const { PyBot, serialize, fullDiff } = require('./refpy.js');

const W = A.W;
const N = A.N;

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
}

function mulberry(a) {
  a |= 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scoresFor(board) {
  const out = [];
  for (const p of [0, 1]) {
    let tiles = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (board.owner[i] !== p) continue;
      tiles++;
      total += board.armies[i];
    }
    out.push({ i: p, total: total, tiles: tiles, dead: board.owner[board.generals[p]] !== p });
  }
  return out;
}

async function main() {
  const outPath = process.argv[2] || 'E:\\akcoco6de\\_research\\ekdump\\game.jsonl';
  const opp = arg('opp', 'gc');
  const seed = Number(arg('seed', '1000'));
  const maxTurns = Number(arg('turns', '260'));
  const pySide = Number(arg('pySide', '0'));
  const useFog = arg('fog', '1') !== '0';

  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });

  const board = A.makeMap(mulberry(seed));
  const fogs = useFog ? [A.makeFog(), A.makeFog()] : null;
  for (const p of [0, 1]) if (fogs) A.updateFog(fogs[p], board, p);
  const ref = require('./refagents.js').makeRefAgent(opp, mulberry(seed ^ 0x9e3779b9));

  const py = new PyBot();
  const t0 = Date.now();
  let turns = 0;
  try {
    const vis0 = fogs ? A.updateFog(fogs[pySide], board, pySide) : null;
    const st = serialize(board, pySide, fogs ? fogs[pySide] : { owner: board.owner, armies: board.armies }, vis0);
    const firstData = {
      turn: 1,
      scores: scoresFor(board),
      map_diff: fullDiff(st.map),
      cities_diff: fullDiff(st.cities),
      deserts_diff: fullDiff([]),
      generals: st.generals,
      stars: [0, 0]
    };
    await py.spawnIfNeeded();
    await py.send({ cmd: 'start', dump: true, startData: {
      playerIndex: pySide,
      usernames: ['eklipz_py', 'them'],
      playerColors: ['#111111', '#222222'],
      replay_id: 'dump_' + seed,
      game_type: 'custom',
      options: {}
    }, data: firstData });

    for (let turn = 0; turn < maxTurns; turn++) {
      turns = turn + 1;
      for (const p of [0, 1]) {
        if (board.owner[board.generals[p]] !== p) continue;
        const vis = fogs ? A.updateFog(fogs[p], board, p) : null;
        if (p === pySide) {
          const st2 = serialize(board, p, fogs ? fogs[p] : { owner: board.owner, armies: board.armies }, vis);
          const data = {
            turn: turn + 1,
            map_diff: fullDiff(st2.map),
            cities_diff: fullDiff(st2.cities),
            deserts_diff: fullDiff([]),
            generals: st2.generals,
            scores: scoresFor(board),
            stars: [0, 0]
          };
          const r = await py.send({ cmd: 'turn', dump: true, data: data });
          if (r.error) throw new Error(r.error);
          out.write(JSON.stringify({ turn: turn, data: data, move: r.move, dump: r.dump, dumpPost: r.dumpPost }) + '\n');
          if (r.move) A.applyMove(board, p, r.move[1] * W + r.move[0], r.move[3] * W + r.move[2], !!r.move[4]);
        } else {
          const view = A.makeView(board, p, fogs ? fogs[p] : null, vis);
          const act = ref.plan(view);
          if (act) A.applyMove(board, p, act.from, act.to, act.split);
        }
        if (board.owner[board.generals[1 - p]] === p) break;
      }
      if (board.owner[board.generals[0]] !== 0 || board.owner[board.generals[1]] !== 1) break;

      const t1 = turn + 1;
      for (let i = 0; i < N; i++) {
        const o = board.owner[i];
        if (o < 0) continue;
        const isProduce = i === board.generals[o] || board.cities[i];
        if (isProduce && t1 % 2 === 0) board.armies[i] += 1;
        if (t1 % 50 === 0) board.armies[i] += 1;
      }
    }
  } finally {
    py.kill();
    out.end();
  }
  console.log('录了 ' + turns + ' 回合 → ' + outPath + '（' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

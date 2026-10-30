/*
 * 让**真正的 Human.exe**（EklipZgit/generals-bot 的原版 Python 代码）上擂台。
 *
 * 原版是个跑在真实服务器上的客户端：拿到 game_start / game_update（map_diff、
 * cities_diff、generals、scores），算出 move，再 POST 回服务器。这里只把传输层
 * 换成 stdin/stdout 的 JSON 行，规则、迷雾、经济全部用擂台这套（和官方一致）。
 *
 *   python gb_bridge.py            （在 bot 源码目录里，见 GB_PY_SRC）
 *   node scripts/refpy.js gc 4     （对手 gc，4 局 = 2 种子 × 先后手）
 *
 * 它是**测量工具**，不是发版物：单个 tick 要几十到几百毫秒，整局几十秒。
 * 用途只有一个——给 JS 移植版当 oracle：同一批局面，两边出的招必须一致。
 */
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const A = require('./arena.js');
const { makeRefAgent, listRefAgents } = require('./refagents.js');

const W = A.W;
const H = A.H;
const N = A.N;
const MAX_TURNS = 1200;
const PY_SRC = process.env.GB_PY_SRC || 'E:\\akcoco6de\\_research\\generals-bot-cs';
const PY = process.env.GB_PY || 'python';
const TURN_TIMEOUT_MS = Number(process.env.GB_PY_TIMEOUT || 20000);

/* 一局一个 Python 进程：原版是长连接客户端，状态全在进程里（ArmyTracker 之类）。 */
class PyBot {
  constructor() {
    this.child = null;
    this.rl = null;
    this.pending = null;
    this.stderrTail = [];
    this.turnMs = 0;
    this.errors = 0;
  }

  async spawnIfNeeded() {
    if (this.child) return;
    this.child = spawn(PY, ['-u', 'gb_bridge.py'], {
      cwd: PY_SRC,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' })
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      if (!this.pending) return;
      const p = this.pending;
      this.pending = null;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        p.reject(new Error('bridge 吐了非 JSON: ' + line.slice(0, 200)));
        return;
      }
      p.resolve(msg);
    });
    this.child.stderr.on('data', (buf) => {
      const s = String(buf);
      this.stderrTail.push(s);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.child.on('exit', (code) => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(new Error('bridge 退出 code=' + code + '\n' + this.stderrTail.join('')));
      }
    });
  }

  send(obj) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(new Error('bridge 超时 ' + TURN_TIMEOUT_MS + 'ms'));
        }
      }, TURN_TIMEOUT_MS);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.resolve = done(resolve);
      this.pending.reject = done(reject);
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  async start(startData, data) {
    await this.spawnIfNeeded();
    const r = await this.send({ cmd: 'start', startData: startData, data: data });
    if (r.error) throw new Error('bridge start 失败:\n' + r.error);
    return r;
  }

  async turn(data) {
    const r = await this.send({ cmd: 'turn', data: data });
    if (r.error) {
      this.errors++;
      throw new Error('bridge turn 失败:\n' + r.error);
    }
    this.turnMs += r.ms || 0;
    return r.move;
  }

  kill() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch (e) {
        /* ignore */
      }
      this.child = null;
    }
  }
}

/* diff 编码：整表替换 + 尾巴 0 截断（base/client/map.py 的 _apply_diff 就吃这个） */
function fullDiff(values) {
  return [0, values.length].concat(values, [0]);
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

/* 一方的视野 → 服务器串行化数组（看不见的格是 FOG / FOG_OBSTACLE，兵数 0） */
function serialize(board, me, fog) {
  const armies = new Array(N);
  for (let i = 0; i < N; i++) armies[i] = fog.armies[i];
  const map = [W, H].concat(armies, Array.from(fog.owner));
  const cities = [];
  for (let i = 0; i < N; i++) if (board.cities[i] && fog.owner[i] >= 0) cities.push(i);
  const generals = [];
  for (const p of [0, 1]) {
    if (fog.owner[board.generals[p]] >= 0 && board.generals[p] >= 0) generals.push(board.generals[p]);
  }
  return { map: map, cities: cities, generals: generals };
}

function startDataFor(board, me) {
  return {
    playerIndex: me,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'bridge_' + me,
    game_type: 'custom',
    options: {}
  };
}

async function playGamePy(seed, opponent, pySide, opts) {
  const useFog = !(opts && opts.fog === false);
  const mulberry = (a) => {
    a |= 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const board = A.makeMap(mulberry(seed));
  if (!board) return null;

  const py = new PyBot();
  const ref = makeRefAgent(opponent, mulberry(seed ^ 0x9e3779b9));

  const fogs = useFog ? [A.makeFog(), A.makeFog()] : null;
  for (const p of [0, 1]) if (fogs) A.updateFog(fogs[p], board, p);

  let winner = -1;
  let turns = 0;

  try {
    // 开局：正式服务器 game_start 不带地图，第一包 game_update 才有
    const st = serialize(board, pySide, fogs ? fogs[pySide] : { owner: board.owner, armies: board.armies });
    await py.start(startDataFor(board, pySide), Object.assign({ turn: 1, scores: scoresFor(board) }, {
      map_diff: fullDiff(st.map),
      cities_diff: fullDiff(st.cities),
      deserts_diff: fullDiff([]),
      generals: st.generals,
      stars: [0, 0]
    }));

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turns = turn + 1;
      for (const p of [0, 1]) {
        if (board.owner[board.generals[p]] !== p) continue;
        const vis = fogs ? A.updateFog(fogs[p], board, p) : null;
        if (p === pySide) {
          const st2 = serialize(board, p, fogs ? fogs[p] : { owner: board.owner, armies: board.armies });
          const move = await py.turn({
            turn: turn + 1,
            map_diff: fullDiff(st2.map),
            cities_diff: fullDiff(st2.cities),
            deserts_diff: fullDiff([]),
            generals: st2.generals,
            scores: scoresFor(board),
            stars: [0, 0]
          });
          if (move) {
            if (opts && opts.trace) console.log('T' + turn + ' py ' + move[0] + ',' + move[1] + '>' + move[2] + ',' + move[3] + (move[4] ? ' half' : ''));
            if (!A.applyMove(board, p, move[1] * W + move[0], move[3] * W + move[2], !!move[4])) {
              if (opts && opts.trace) console.log('  py 出了非法招 ' + JSON.stringify(move));
            }
          }
        } else {
          const view = A.makeView(board, p, fogs ? fogs[p] : null, vis);
          const act = ref.plan(view);
          if (act) A.applyMove(board, p, act.from, act.to, act.split);
        }
        if (board.owner[board.generals[1 - p]] === p) {
          winner = p;
          break;
        }
      }
      if (winner >= 0) break;

      const t1 = turn + 1;
      const fast = process.env.GB_INCOME === 'fast';
      for (let i = 0; i < N; i++) {
        const o = board.owner[i];
        if (o < 0) continue;
        const isProduce = i === board.generals[o] || board.cities[i];
        if (fast) {
          if (isProduce) board.armies[i] += 1;
          if (t1 % 25 === 0) board.armies[i] += 1;
        } else {
          if (isProduce && t1 % 2 === 0) board.armies[i] += 1;
          if (t1 % 50 === 0) board.armies[i] += 1;
        }
      }
    }
  } finally {
    py.kill();
  }

  return {
    winner: winner,
    win: winner === pySide,
    draw: winner < 0,
    turns: turns,
    pyLand: A.landCount(board, pySide),
    refLand: A.landCount(board, 1 - pySide),
    pyArmy: A.armyCount(board, pySide),
    refArmy: A.armyCount(board, 1 - pySide),
    pyCities: A.cityCount(board, pySide),
    refCities: A.cityCount(board, 1 - pySide),
    pyMs: py.turnMs,
    pyErrors: py.errors
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const k = next++;
          if (k >= items.length) return;
          out[k] = await fn(items[k], k);
        }
      })()
    );
  }
  await Promise.all(workers);
  return out;
}

async function main() {
  const opponent = process.argv[2] || 'gc';
  const games = Number(process.argv[3] || 2);
  const jobs = Number(process.env.GB_PY_JOBS || 4);
  const seeds = Math.ceil(games / 2);

  const tasks = [];
  for (let s = 0; s < seeds; s++) {
    for (const pySide of [0, 1]) {
      if (tasks.length >= games) break;
      tasks.push({ seed: 1000 + s * 7919, pySide: pySide });
    }
  }

  console.log('Human.exe（原版 Python）vs ' + opponent + '，' + tasks.length + ' 局，并发 ' + jobs);
  const t0 = Date.now();
  const results = await pool(tasks, jobs, (t) => playGamePy(t.seed, opponent, t.pySide, { trace: !!process.env.GB_PY_TRACE }));
  const ok = results.filter(Boolean);
  const wins = ok.filter((r) => r.win).length;
  const draws = ok.filter((r) => r.draw).length;
  const losses = ok.length - wins - draws;
  const avg = (k) => (ok.reduce((s, r) => s + r[k], 0) / ok.length).toFixed(1);
  console.log(
    '  ' + wins + ' 胜 / ' + losses + ' 负 / ' + draws + ' 和   胜率 ' +
    ((wins / ok.length) * 100).toFixed(1) + '%'
  );
  console.log(
    '  平均：回合 ' + avg('turns') + '  地 ' + avg('pyLand') + ':' + avg('refLand') +
    '  兵 ' + avg('pyArmy') + ':' + avg('refArmy') + '  城 ' + avg('pyCities') + ':' + avg('refCities') +
    '  py 每步 ' + (ok.reduce((s, r) => s + r.pyMs, 0) / ok.reduce((s, r) => s + r.turns, 0)).toFixed(0) + 'ms'
  );
  console.log('  墙钟 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
}

module.exports = { playGamePy: playGamePy, PyBot: PyBot, serialize: serialize, fullDiff: fullDiff };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

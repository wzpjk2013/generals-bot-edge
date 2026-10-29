/*
 * 拆一局 generals.io 回放：谁走了几步、什么时候走的、地盘兵力怎么变、谁先死。
 *
 *   node scripts/replay.js GPC0L3MZA
 *   node scripts/replay.js GPC0L3MZA 1        # 1 = 把玩家 1 当成"我方"，重点看它的手
 *   node scripts/replay.js ./local.gior 1     # 也可以喂本地文件
 *
 * 数据来源（bundle 里 getReplay 的原始路径）：
 *   /api/replay/<id>            或者  https://generalsio-replays-na.s3.amazonaws.com/<id>.gior
 * 都是 lz-string 压的 JSON 数组，字段顺序照 a.deserialize（见下）。
 */
'use strict';

const fs = require('fs');
const { decompressFromUint8Array } = require('./gior.js');

const EMPTY = -1;
const MOUNTAIN = -2;
const TILE = ['空地', '空地', '山'];

async function fetchReplay(id) {
  const urls = [
    'https://generals.io/api/replay/' + encodeURIComponent(id),
    'https://generalsio-replays-na.s3.amazonaws.com/' + encodeURIComponent(id) + '.gior'
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 16) continue;
      return { buf, url };
    } catch (e) {
      /* 试下一个 */
    }
  }
  throw new Error('拿不到回放 ' + id + '（两个源都失败）');
}

/* 字段顺序照官方 a.deserialize */
function parseReplay(a) {
  let r = 0;
  const R = {};
  R.version = a[r++];
  R.id = a[r++];
  R.w = a[r++];
  R.h = a[r++];
  R.usernames = a[r++];
  R.stars = a[r++];
  R.cities = a[r++] || [];
  R.cityArmies = a[r++] || [];
  R.generals = a[r++] || [];
  R.mountains = a[r++] || [];
  R.moves = (a[r++] || []).map((m) => ({ player: m[0], start: m[1], end: m[2], is50: m[3], turn: m[4] }));
  R.afks = a[r++] || [];
  R.teams = a[r++];
  R.mapName = a[r++];
  R.neutrals = a[r++] || [];
  R.neutralArmies = a[r++] || [];
  return R;
}

/* 回放只存 山 / 城(+城里兵) / 将军 / neutrals —— 其余格子开局是 0 兵空地 */
function buildBoard(R) {
  const n = R.w * R.h;
  const terrain = new Array(n).fill(EMPTY);
  const armies = new Array(n).fill(0);
  for (const m of R.mountains) terrain[m] = MOUNTAIN;
  R.cities.forEach((c, i) => {
    terrain[c] = EMPTY;
    armies[c] = R.cityArmies[i] || 0;
  });
  R.neutrals.forEach((c, i) => {
    terrain[c] = EMPTY;
    armies[c] = R.neutralArmies[i] || 0;
  });
  R.generals.forEach((g, p) => {
    if (g < 0) return;
    terrain[g] = p;
    armies[g] = 1;
  });
  return { n, terrain, armies };
}

function simulate(R) {
  const { n, terrain, armies } = buildBoard(R);
  const isCity = new Set(R.cities);
  const gen = R.generals.slice();
  const alive = R.generals.map(() => true);
  const genOf = new Map();
  R.generals.forEach((g, p) => genOf.set(g, p));

  const out = {
    n,
    terrain,
    armies,
    gen,
    alive,
    deaths: {},
    rejected: [],   // 服务器会丢掉的手：源格兵不够（送 0）
    illegal: [],    // 源格不是自己的（本地状态漂了）
    generalOut: R.moves.map(() => []),
    timeline: [],
    lastTurn: R.moves.length ? Math.max(...R.moves.map((m) => m.turn)) : 0
  };

  const byTurn = new Map();
  for (const m of R.moves) {
    if (!byTurn.has(m.turn)) byTurn.set(m.turn, []);
    byTurn.get(m.turn).push(m);
  }

  const xy = (i) => '(' + (i % R.w) + ',' + Math.floor(i / R.w) + ')';
  out.xy = xy;

  for (let t = 0; t <= out.lastTurn; t++) {
    const list = byTurn.get(t);
    if (list) {
      list.sort((a, b) => a.player - b.player);
      for (const m of list) {
        if (terrain[m.start] !== m.player) {
          out.illegal.push({ t, ...m, why: '源格不是他的' });
          continue;
        }
        const avail = armies[m.start];
        const sent = m.is50 ? avail >> 1 : avail - 1;
        const left = avail - sent;
        if (sent < 1) {
          out.rejected.push({ t, ...m, avail });
          continue;
        }
        const wasGen = gen[m.player] === m.start;
        const victimP = genOf.has(m.end) && genOf.get(m.end) !== m.player ? genOf.get(m.end) : -1;
        if (terrain[m.end] === m.player) {
          armies[m.end] += sent;
          armies[m.start] = left;
          if (wasGen) gen[m.player] = m.end;
        } else if (sent > armies[m.end]) {
          armies[m.end] = sent - armies[m.end];
          terrain[m.end] = m.player;
          armies[m.start] = left;
          if (wasGen) gen[m.player] = m.end;
          if (victimP >= 0 && alive[victimP]) {
            alive[victimP] = false;
            out.deaths[victimP] = t;
          }
        } else {
          armies[m.end] -= sent;
          armies[m.start] = left;
        }
        if (wasGen && m.end !== m.start) {
          out.generalOut[m.player].push({ t, from: m.start, to: m.end, avail, sent, left });
        }
      }
    }
    // 产兵：每 2 tick 将军/城 +1，每 50 tick 全格 +1（RECRUIT_RATE=2 / FARM_RATE=50）
    if (t % 2 === 0) {
      for (let i = 0; i < n; i++) {
        const o = terrain[i];
        if (o < 0) continue;
        if (i === gen[o] || isCity.has(i)) armies[i] += 1;
      }
    }
    if (t % 50 === 49) for (let i = 0; i < n; i++) if (terrain[i] >= 0) armies[i] += 1;
    if (t % 20 === 0) {
      const land = R.usernames.map(() => 0);
      const army = R.usernames.map(() => 0);
      for (let i = 0; i < n; i++) {
        const o = terrain[i];
        if (o < 0) continue;
        land[o] += 1;
        army[o] += armies[i];
      }
      out.timeline.push({ t, land, army });
    }
  }
  return out;
}

function report(R, sim, ours) {
  const xy = sim.xy;
  const pct = (a, b) => ((a / (b || 1)) * 100).toFixed(1) + '%';
  console.log('回放 ' + R.id + '  v' + R.version + '  ' + R.w + 'x' + R.h + '  地图 ' + (R.mapName || '随机'));
  console.log('玩家：' + R.usernames.map((u, i) => i + '=' + u).join('  ') + (ours >= 0 ? '   （我方=玩家' + ours + '）' : ''));
  console.log('将军起点：' + R.generals.map((g, p) => '玩家' + p + xy(g)).join('  ') + '   城 ' + R.cities.length + ' 座   山 ' + R.mountains.length);
  console.log('总走子 ' + R.moves.length + '，最后一手 tick ' + sim.lastTurn + '（显示回合 ' + Math.floor(sim.lastTurn / 2) + '）\n');

  for (let p = 0; p < R.usernames.length; p++) {
    const ms = R.moves.filter((m) => m.player === p);
    const gOut = sim.generalOut[p];
    const rej = sim.rejected.filter((m) => m.player === p);
    console.log('玩家 ' + p + ' (' + R.usernames[p] + ')');
    console.log('  走子 ' + ms.length + ' 手，其中将军出门 ' + gOut.length + ' 手');
    console.log('  空过（源格兵不够，服务器会丢） ' + rej.length + ' 手 = ' + pct(rej.length, ms.length));
    if (ms.length) {
      console.log('  首次出子 tick ' + ms[0].turn + '，最后一次 tick ' + ms[ms.length - 1].turn);
      let gap = 0;
      let gapAt = 0;
      for (let i = 1; i < ms.length; i++) {
        const d = ms[i].turn - ms[i - 1].turn;
        if (d > gap) {
          gap = d;
          gapAt = ms[i - 1].turn;
        }
      }
      console.log('  最长不出子间隔 ' + gap + ' tick（从 tick ' + gapAt + ' 起）');
    }
    console.log('');
  }

  console.log('时间线（tick：地盘 / 兵力）');
  for (const s of sim.timeline) {
    console.log(
      '  t=' + String(s.t).padStart(4) + '   地 ' + s.land.map((v) => String(v).padStart(3)).join(' / ') +
        '     兵 ' + s.army.map((v) => String(v).padStart(4)).join(' / ')
    );
  }
  const land = R.usernames.map(() => 0);
  const army = R.usernames.map(() => 0);
  for (let i = 0; i < sim.n; i++) {
    const o = sim.terrain[i];
    if (o < 0) continue;
    land[o] += 1;
    army[o] += sim.armies[i];
  }
  console.log('\n终局：地 ' + land.join(' / ') + '   兵 ' + army.join(' / '));
  const deaths = Object.entries(sim.deaths);
  console.log('阵亡：' + (deaths.length ? deaths.map(([p, t]) => '玩家' + p + '(' + R.usernames[p] + ') @tick ' + t).join(', ') : '没有人死'));

  if (sim.illegal.length) {
    console.log('\n非法手（源格不是自己的，说明本地状态漂了）' + sim.illegal.length + ' 手：');
    console.log('  ' + sim.illegal.slice(0, 10).map((m) => 't=' + m.t + ' 玩家' + m.player + ' ' + xy(m.start) + '→' + xy(m.end)).join('\n  '));
  }
  if (sim.rejected.length && ours >= 0) {
    const mine = sim.rejected.filter((m) => m.player === ours);
    if (mine.length) {
      console.log('\n我方空过明细（源格只剩 1 兵，送 0 被丢）' + mine.length + ' 手：');
      console.log('  ' + mine.map((m) => 't=' + m.t + ' ' + xy(m.start) + '→' + xy(m.end)).join(', '));
    }
  }
}

(async () => {
  const idOrPath = process.argv[2];
  const ours = process.argv[3] !== undefined ? Number(process.argv[3]) : -1;
  if (!idOrPath) {
    console.error('用法: node scripts/replay.js <回放ID 或 .gior 文件> [我方玩家下标]');
    process.exit(2);
  }
  let buf;
  if (fs.existsSync(idOrPath)) buf = new Uint8Array(fs.readFileSync(idOrPath));
  else buf = (await fetchReplay(idOrPath)).buf;
  const json = decompressFromUint8Array(buf);
  if (!json) throw new Error('解压失败：不是 lz-string 压的回放？');
  const R = parseReplay(JSON.parse(json));
  const sim = simulate(R);
  report(R, sim, ours);
})();

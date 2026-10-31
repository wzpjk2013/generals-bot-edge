// FlowExpansion 分组背包移植的差异检查：
//   node scripts/ekdiff-knapsack.js _research/knapsack-gm1.json
//
// oracle 由 _research/ekdump_knapsack.py 生成（回放 gm1.jsonl 跑原版 EklipZBot，
// 把 FlowExpansion 真正喂进去的 GroupedKnapsackInput 连同两种求解结果一起 dump）。
//
// 比两路：
//   greedy —— py 的 solve_grouped_knapsack_input（纯 python MKCP + 冲突修复）。
//             这条必须逐字段 0 差异，选中的子集、总重、总价值、每组归属全要比。
//   exact  —— 原版默认走 CP-SAT。最优价值必须相等，但最优解平局时求解器选谁
//             是它的自由，所以这里只比 econValue 之和与总重，选中的格子集合
//             只统计一致率，不算差异。
//
// 用法里没有容差参数：浮点比较按 1e-6，其余全等。
'use strict';

const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const EK = {
  knapsack: require(path.join(repoRoot, 'src/eklipz/expandutils.js')).knapsack
};
global.__EK = EK;

require(path.join(repoRoot, 'src/eklipz/flowmodels.js'));
require(path.join(repoRoot, 'src/eklipz/flowknapsack.js'));

const KN = global.__EK.flow.GatherCaptureGroupKnapsacker;
const SOLVER_CPSAT = global.__EK.flow.PlanSolver.CpSat;

const EPS = 1e-6;

function eqNum(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

function eqArrInt(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function loadCases(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (raw.cases || []).filter(c => c.grouped);
}

function compareGreedy(c, report) {
  const py = c.greedy || {};
  if (py.error) {
    report.skip('greedy', 'oracle 自己报错：' + String(py.error).split('\n').pop());
    return;
  }
  let got;
  try {
    got = KN.solve_grouped_knapsack_input(c.grouped, true, true);
  } catch (e) {
    report.fail('greedy', '移植版抛异常：' + e.message);
    return;
  }
  const chosen = (got.chosen_indices || []).slice().sort((a, b) => a - b);
  const pyChosen = (py.chosen || []).slice().sort((a, b) => a - b);
  if (!eqArrInt(chosen, pyChosen)) {
    report.fail('greedy.chosen', `py=${JSON.stringify(pyChosen)} js=${JSON.stringify(chosen)}`);
  }
  if (got.chosen_weight !== py.chosenWeight) {
    report.fail('greedy.chosenWeight', `py=${py.chosenWeight} js=${got.chosen_weight}`);
  }
  if (!eqNum(got.max_value, py.maxValue)) {
    report.fail('greedy.maxValue', `py=${py.maxValue} js=${got.max_value}`);
  }
  if (py.groups && got.groups) {
    if (!eqArrInt(got.groups, py.groups)) {
      const diffAt = got.groups.findIndex((g, i) => g !== py.groups[i]);
      report.fail('greedy.groups', `第一处不同 idx=${diffAt} py=${py.groups[diffAt]} js=${got.groups[diffAt]}（共 ${py.groups.length} 项）`);
    }
  }
}

function comparePrune(c, report) {
  const py = c.pruneCanonical;
  if (!py) {
    report.skip('prune', '这一回合没有 prune 结果');
    return;
  }
  let got;
  try {
    got = KN.prune_and_get_groups_for_knapsack(c.grouped, true, true);
  } catch (e) {
    report.fail('prune', '移植版抛异常：' + e.message);
    return;
  }
  if (!eqArrInt(got.active_indices, py.active)) {
    const pySet = new Set(py.active);
    const jsSet = new Set(got.active_indices);
    const onlyPy = py.active.filter(i => !jsSet.has(i));
    const onlyJs = got.active_indices.filter(i => !pySet.has(i));
    report.fail('prune.active', `py=${py.active.length} js=${got.active_indices.length} 只在py=${JSON.stringify(onlyPy)} 只在js=${JSON.stringify(onlyJs)}`);
  }
  const gbiKeys = Object.keys(py.gbi).map(Number);
  const myGbi = got.groups_by_index;
  for (const k of gbiKeys) {
    if (myGbi.get(k) !== py.gbi[k]) {
      report.fail('prune.gbi', `idx=${k} py=${py.gbi[k]} js=${myGbi.get(k)}`);
      break;
    }
  }
  const myMaybe = (got.maybe_options || []).map(m => [m.option_index, m.would_merge_groups.join(',')]);
  const pyMaybe = (py.maybe || []).map(m => [m.option, m.groups.join(',')]);
  if (myMaybe.length !== pyMaybe.length) {
    report.fail('prune.maybe', `条数 py=${pyMaybe.length} js=${myMaybe.length}`);
  } else {
    for (let i = 0; i < pyMaybe.length; i++) {
      if (pyMaybe[i][0] !== myMaybe[i][0] || pyMaybe[i][1] !== myMaybe[i][1]) {
        report.fail('prune.maybe', `第 ${i} 条 py=${JSON.stringify(pyMaybe[i])} js=${JSON.stringify(myMaybe[i])}`);
        break;
      }
    }
  }
}

function buildOptions(c) {
  return (c.options || []).map((o, i) => {
    const tileSet = new Set();
    for (const t of o.tiles) tileSet.add({ tile_index: t });
    return { item: i, length: o.length, tileSet, econValue: o.econValue };
  });
}

function compareExact(c, report) {
  const py = c.solverResult;
  if (!py) {
    report.skip('exact', '这一回合没进 solve_tile_plan_options');
    return;
  }
  const options = buildOptions(c);
  const valueMultiple = c.valueMultiple === undefined ? 10000 : c.valueMultiple;
  let got;
  try {
    got = KN.solve_tile_plan_options(options, c.budget, SOLVER_CPSAT, valueMultiple);
  } catch (e) {
    report.fail('exact', '移植版抛异常：' + e.message);
    return;
  }
  // 原版 value_multiple 传的是 ITERATIVE_EXPANSION_EN_CAP_VAL(2.05)，求解器返回的
  // max_value 就是放大后的整数，两边同一单位，直接比。
  if (!eqNum(got.max_value, py.maxValue)) {
    report.fail('exact.maxValue', `py=${py.maxValue} js=${got.max_value}`);
  }
  // 同价值下 CP-SAT 选谁、总重多少都是它自己的自由，只做统计不算差异
  report.note('weight', got.chosen_weight === py.chosenWeight ? 'same' : 'diff-tie');
  const choseSame = eqArrInt(got.chosen_indices.slice().sort((a, b) => a - b), (py.chosen || []).slice().sort((a, b) => a - b));
  report.note('chosen', choseSame ? 'same' : 'diff-tie');
}

function makeReport() {
  const diffs = [];
  const skips = {};
  const notes = { 'chosen:same': 0, 'chosen:diff-tie': 0, 'weight:same': 0, 'weight:diff-tie': 0 };
  return {
    fail(where, detail) { diffs.push({ where, detail }); },
    skip(where, why) { skips[where] = (skips[where] || 0) + 1; skips[where + ':' + why.slice(0, 40)] = true; },
    note(prefix, v) { const key = prefix + ':' + v; if (notes[key] !== undefined) notes[key] += 1; },
    diffs, skips, notes
  };
}

function main() {
  const file = process.argv[2] || path.join(repoRoot, '..', '_research', 'knapsack-gm1.json');
  const cases = loadCases(file);
  if (!cases.length) {
    console.error('没有可比对的 cases（检查 oracle 是否跑到 flow 分支）');
    process.exit(2);
  }
  const report = makeReport();
  let greedyTurns = 0;
  let exactTurns = 0;
  for (const c of cases) {
    const before = report.diffs.length;
    comparePrune(c, report);
    compareGreedy(c, report);
    if (!(c.greedy || {}).error) greedyTurns += 1;
    compareExact(c, report);
    if (c.solverResult) exactTurns += 1;
    if (report.diffs.length !== before) {
      for (const d of report.diffs.slice(before)) d.turn = c.turn;
    }
  }

  const skipKeys = Object.keys(report.skips).filter(k => !k.includes(':'));
  console.log(`oracle 文件: ${file}`);
  console.log(`比对回合数 ${cases.length}（greedy ${greedyTurns}，exact ${exactTurns}）`);
  console.log(`exact 选中集合: 一致 ${report.notes['chosen:same']}，平局不同 ${report.notes['chosen:diff-tie']}`);
  console.log(`exact 总重: 一致 ${report.notes['weight:same']}，平局不同 ${report.notes['weight:diff-tie']}`);
  if (skipKeys.length) {
    for (const k of skipKeys) console.log(`跳过 ${k}: ${report.skips[k]} 例`);
  }
  if (!report.diffs.length) {
    console.log('不一致 0');
    return;
  }
  console.log(`不一致 ${report.diffs.length}`);
  const shown = report.diffs.slice(0, 12);
  for (const d of shown) {
    console.log(`  turn=${d.turn} ${d.where}: ${d.detail}`);
  }
  process.exit(1);
}

main();

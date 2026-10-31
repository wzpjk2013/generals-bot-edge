/**
 * MinCostFlow 与 ortools 的对照脚本。
 * 只比对两件东西：可行性判定（是否 OPTIMAL）和最小总成本。
 * 流量分布本身可能因平局不同，但成本必须逐条相等 —— 上层 island 图比的就是这个。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
require(path.join(REPO, 'src', 'eklipz', 'flowmincost.js'));
const EK = global.__EK || global.window.__EK;

const inPath = process.argv[2];
if (!inPath) {
  console.error('用法: node scripts\\ekdiff-mcf.js <mcf-oracle.json>');
  process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const MinCostFlow = EK.flow.MinCostFlow;

let mismatch = 0;
let feasibleCount = 0;
let checked = 0;
const detail = [];

for (let r = 0; r < rows.length; r++) {
  const graph = rows[r].graph;
  const expected = rows[r].expected;
  const solver = new MinCostFlow();
  for (const arc of graph.arcs) {
    solver.addArcWithCapacityAndUnitCost(arc[0], arc[1], arc[2], arc[3]);
  }
  for (let node = 0; node < graph.nodes; node++) {
    solver.setNodeSupply(node, graph.supplies[node]);
  }
  const solved = solver.solve();
  checked++;
  const jsFeasible = solved !== null;
  const pyFeasible = !!expected.feasible;
  if (pyFeasible) feasibleCount++;
  if (jsFeasible !== pyFeasible) {
    mismatch++;
    if (detail.length < 10) {
      detail.push('图#' + r + ' 可行性不一致 js=' + jsFeasible + ' py=' + pyFeasible +
        '\n  arcs=' + JSON.stringify(graph.arcs) + '\n  supplies=' + JSON.stringify(graph.supplies));
    }
    continue;
  }
  if (jsFeasible && solved.optimalCost !== expected.cost) {
    mismatch++;
    if (detail.length < 10) {
      detail.push('图#' + r + ' 成本不一致 js=' + solved.optimalCost + ' py=' + expected.cost +
        '\n  arcs=' + JSON.stringify(graph.arcs) + '\n  supplies=' + JSON.stringify(graph.supplies) +
        '\n  jsflows=' + JSON.stringify(solved.flows) + '\n  pyflows=' + JSON.stringify(expected.flows));
    }
  }
}

for (const d of detail) console.log(d);
console.log('图 ' + checked + ' 张（可行 ' + feasibleCount + ' 张），不一致 ' + mismatch + ' 张');
process.exit(mismatch === 0 ? 0 : 1);

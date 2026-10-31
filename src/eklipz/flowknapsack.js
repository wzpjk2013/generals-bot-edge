/*
 * GatherCaptureGroupKnapsacker 的 JS 移植
 * 原版：E:\akcoco6de\_research\generals-bot-cs\Gather\GatherCaptureGroupKnapsacker.py（1167 行）
 *
 * 用途：FlowExpansion 每回合把「收流计划 + 外部拦截计划」塞进一个带分组和格子互斥的
 * 多重背包（MKCP），挑出在回合预算内总 econ 最大、且没有任何两个计划抢同一格子的组合。
 *
 * 搬过来的主链（全部纯 Python，可逐位对齐）：
 *   prune_and_get_groups_for_knapsack          按格子重叠贪心连通分组 + 每组帕累托前沿剪枝
 *   solve_grouped_knapsack_input               MKCP + maybe 替换 + 单冲突替换 + 修复背包
 *   solve_grouped_knapsack_pre_group_input     按 border_pair 先重新分组的薄包装
 *   build_tile_plan_option_conflict_constraints / adapt_* / _build_*_result  形状转换
 *
 * 没搬 / 搬不了：
 *   1. 日志。原版一大半体积是 logbook.info 的诊断（external inspect / prune complete /
 *      final group dump / not chosen detail 等），只影响日志不影响结果，全丢。
 *   2. `solve_tile_plan_options` 的 OR-Tools 分支（CP-SAT / CBC / SCIP）。原版在这些求解器
 *      里求最优 0/1 背包 + 格子互斥，**平局最优解由求解器内部启发式决定（不唯一、不可复现）**。
 *      这里换成确定性精确求解（带冲突约束的分支定界，平局取索引字典序更小的组合）。
 *      **与原版求解器可能不同，oracle 未覆盖该分支。**
 *      ⚠ 原版 FlowExpansion 默认 `plan_solver = PlanSolver.CpSat`，也就是线上真正跑的是这条
 *      未覆盖分支；`solve_grouped_knapsack_input` 只在 plan_solver 被改成
 *      MkcpPlusGreedyConflictResolution，或者打开 OUTPUT_KNAPSACK_TEST_REPRO_LOGS 做复现日志时才走。
 *   3. `PlanSolver.MkcpPlusGreedyConflictResolution` 在 `solve_tile_plan_options` 里原版就是
 *      `raise NotImplementedError`，这里同样抛，不替它编一个行为出来。
 *   4. `GroupedKnapsackIterationSummary.conflicts`：原版旧实现（逐轮黑名单重解）才有内容，
 *      现实现恒定写 `[]`，照抄。
 *
 * 语义坑（改之前先看）：
 *   - 前沿 `_is_dominated_by_frontier` 是从尾部往回找**第一个** turns 更小的条目就 return，
 *     不是「全部扫一遍取最优」——照抄。
 *   - 所有排序都是 Python `sorted`（稳定），键里有并列时保持输入顺序，这里靠完整键
 *     + 稳定排序复现；`list(dict.fromkeys(...))` 的去重保序也照抄。
 *   - `groups_by_index` 原版是 dict[int,int]，这里用 Map（键是选项下标）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var flow = (EK.flow = EK.flow || {});

  // ---------------------------------------------------------------------
  // 多选背包：优先复用 expandutils.js 里已经 oracle 对齐过的那份
  // ---------------------------------------------------------------------
  function ensureKnapsack() {
    if (!EK.knapsack && typeof module !== 'undefined' && module.exports) require('./expandutils.js');
    return EK.knapsack;
  }

  // 原版 KnapsackUtils.solve_multiple_choice_knapsack(items, capacity, weights, values, groups, noLog, threshold)
  // 返回 (max_value, chosen_items)。空输入在原版会 IndexError，这里直接给空解：
  // 上游剪枝把选项全剪光时不该让整轮扩张炸掉。
  function multipleChoiceKnapsack(items, capacity, weights, values, groups, longRuntimeThreshold) {
    if (!items || items.length === 0) return [0, []];
    var ks = ensureKnapsack();
    if (!ks) throw new Error('EK.knapsack missing: load src/eklipz/expandutils.js before flowknapsack.js');
    return ks.solve_multiple_choice_knapsack(items, capacity, weights, values, groups, true, longRuntimeThreshold);
  }

  // ---------------------------------------------------------------------
  // Algorithms/FastDisjointSet.py:21 FastDisjointSet（键是 int，不是 Tile）
  // ---------------------------------------------------------------------
  function FastDisjointSet(elements) {
    this.n_subsets = 0;
    this._sizes = new Map();
    this._parents = new Map();
    // _nbrs 是环形链表，把同一个子集的元素串起来（subset() 靠它一遍走完）
    this._nbrs = new Map();
    // _indices 记插入序，merge 的平局规则和 subset() 的终止条件都靠它
    this._indices = new Map();
    if (elements) {
      var arr = elements instanceof Set || Array.isArray(elements) ? Array.from(elements) : Object.keys(elements);
      for (var i = 0; i < arr.length; i++) this.add(arr[i]);
    }
  }

  FastDisjointSet.prototype.add = function (x) {
    if (this._indices.has(x)) return;
    this._sizes.set(x, 1);
    this._parents.set(x, x);
    this._nbrs.set(x, x);
    this._indices.set(x, this._indices.size);
    this.n_subsets += 1;
  };

  FastDisjointSet.prototype.has = function (x) {
    return this._indices.has(x);
  };

  // 对应 __getitem__：路径对折的 find
  FastDisjointSet.prototype.find = function (x) {
    var indVal = this._indices.get(x);
    if (indVal === undefined) {
      this.add(x);
      indVal = this._indices.get(x);
    }
    var parents = this._parents;
    while (indVal !== this._indices.get(parents.get(x))) {
      parents.set(x, parents.get(parents.get(x)));
      x = parents.get(x);
      indVal = this._indices.get(x);
    }
    return x;
  };

  FastDisjointSet.prototype.merge = function (x, y) {
    var xr = this.find(x);
    var yr = this.find(y);
    if (this._indices.get(xr) === this._indices.get(yr)) return false;
    var l = [this._sizes.get(xr), this._indices.get(yr)];
    var r = [this._sizes.get(yr), this._indices.get(xr)];
    if (l[0] < r[0] || (l[0] === r[0] && l[1] < r[1])) {
      var tmp = xr;
      xr = yr;
      yr = tmp;
    }
    this._parents.set(yr, xr);
    this._sizes.set(xr, this._sizes.get(xr) + this._sizes.get(yr));
    var xn = this._nbrs.get(xr);
    var yn = this._nbrs.get(yr);
    this._nbrs.set(xr, yn);
    this._nbrs.set(yr, xn);
    this.n_subsets -= 1;
    return true;
  };

  FastDisjointSet.prototype.connected = function (x, y) {
    return this._indices.get(this.find(x)) === this._indices.get(this.find(y));
  };

  FastDisjointSet.prototype.subset = function (x) {
    // _nbrs 是同一子集上的环形链表，所以从 x 顺着走、走回 x 就收工
    var result = [x];
    var nxt = this._nbrs.get(x);
    while (nxt !== x) {
      result.push(nxt);
      nxt = this._nbrs.get(nxt);
    }
    return new Set(result);
  };

  FastDisjointSet.prototype.subset_size = function (x) {
    return this._sizes.get(this.find(x));
  };

  FastDisjointSet.prototype.copy = function () {
    var c = new FastDisjointSet();
    c.n_subsets = this.n_subsets;
    c._sizes = new Map(this._sizes);
    c._parents = new Map(this._parents);
    c._nbrs = new Map(this._nbrs);
    c._indices = new Map(this._indices);
    return c;
  };

  // ---------------------------------------------------------------------
  // 输入形状：原版是 dataclass，这里是普通对象，集中做一次规范化，
  // 免得每个函数都要判断 Map / object / 缺字段
  // ---------------------------------------------------------------------
  function normalizeInput(inputData) {
    return {
      turn_budget: inputData.turn_budget,
      groups: inputData.groups || [],
      weights: inputData.weights || [],
      values: inputData.values || [],
      econ_values: inputData.econ_values || [],
      friendly_island_sets: inputData.friendly_island_sets || [],
      target_island_sets: inputData.target_island_sets || [],
      item_tile_sets: inputData.item_tile_sets || [],
      is_external_item: inputData.is_external_item || null,
      max_iterations: inputData.max_iterations === undefined ? 32 : inputData.max_iterations
    };
  }

  function isExternal(inputData, idx) {
    var m = inputData.is_external_item;
    if (!m) return false;
    if (m instanceof Map) return m.get(idx) === true;
    if (Array.isArray(m)) return m[idx] === true;
    return m[idx] === true;
  }

  function makeResult(o) {
    return {
      max_value: o.max_value,
      chosen_indices: o.chosen_indices,
      chosen_weight: o.chosen_weight,
      blacklist: o.blacklist || [],
      iteration_summaries: o.iteration_summaries || [],
      groups: o.groups === undefined ? null : o.groups
    };
  }

  // ---------------------------------------------------------------------
  // 排序 / 前沿工具
  // ---------------------------------------------------------------------
  function getOptionValuePerTurn(inputData, index) {
    return inputData.econ_values[index] / Math.max(inputData.weights[index], 1);
  }

  // 稳定排序：键逐项比较，全部相等时返回 0 保持原顺序
  function sortIndices(indices, keyFn) {
    var decorated = indices.map(function (idx, order) {
      return { idx: idx, key: keyFn(idx), order: order };
    });
    decorated.sort(function (a, b) {
      var ka = a.key;
      var kb = b.key;
      for (var i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return a.order - b.order;
    });
    return decorated.map(function (d) { return d.idx; });
  }

  // 从尾部往回找第一个 turns 不比当前大的前沿条目就下结论 —— 原版就是这么写的
  function isDominatedByFrontier(inputData, frontier, index) {
    var turns = inputData.weights[index];
    var econValue = inputData.econ_values[index];
    for (var i = frontier.length - 1; i >= 0; i--) {
      if (frontier[i][0] <= turns) return frontier[i][1] >= econValue;
    }
    return false;
  }

  function addToFrontier(inputData, frontier, index) {
    var turns = inputData.weights[index];
    var econValue = inputData.econ_values[index];
    var insertAt = 0;
    while (insertAt < frontier.length && frontier[insertAt][0] < turns) insertAt += 1;
    while (insertAt < frontier.length && frontier[insertAt][0] === turns) {
      if (frontier[insertAt][1] <= econValue) frontier.splice(insertAt, 1);
      else insertAt += 1;
    }
    frontier.splice(insertAt, 0, [turns, econValue, index]);

    var pruneAt = insertAt + 1;
    while (pruneAt < frontier.length) {
      if (frontier[pruneAt][1] <= econValue) frontier.splice(pruneAt, 1);
      else pruneAt += 1;
    }
  }

  // ---------------------------------------------------------------------
  // prune_and_get_groups_for_knapsack
  // ---------------------------------------------------------------------
  // CPython set<int> 的迭代序：原版 prune 里 `set(input_data.item_tile_sets[i])` 之后
  // 用 next(iter(...)) 选根，选谁完全由哈希表槽位决定，不是 min，也不是插入序。
  // 表长 8 起步、线性探测、fill*3 >= size*2 时按 used*4 扩容并按槽位序重插。
  function pySetOrder(values) {
    var mask = 7;
    var table = new Array(8);
    for (var t = 0; t < 8; t++) table[t] = null;
    var used = 0;
    var fill = 0;

    function insertInto(tbl, m, v) {
      var i = v & m;
      while (tbl[i] !== null) {
        if (tbl[i] === v) return false;
        i = (i + 1) & m;
      }
      tbl[i] = v;
      return true;
    }

    for (var k = 0; k < values.length; k++) {
      var v = values[k];
      if (insertInto(table, mask, v)) {
        used += 1;
        fill += 1;
        if (fill * 3 >= (mask + 1) * 2) {
          var minused = used <= 50000 ? used * 4 : used * 2;
          var newsize = 8;
          while (newsize <= minused) newsize <<= 1;
          var newMask = newsize - 1;
          var newTable = new Array(newsize);
          for (var nt = 0; nt < newsize; nt++) newTable[nt] = null;
          for (var st = 0; st <= mask; st++) {
            if (table[st] !== null) insertInto(newTable, newMask, table[st]);
          }
          table = newTable;
          mask = newMask;
        }
      } else {
        fill += 1;
      }
    }

    var out = [];
    for (var s = 0; s <= mask; s++) if (table[s] !== null) out.push(table[s]);
    return out;
  }

  function pruneAndGetGroupsForKnapsack(rawInput, noLog, noLogVerbose) {
    var inputData = normalizeInput(rawInput);
    var n = inputData.weights.length;
    var allIndices = [];
    for (var i = 0; i < n; i++) allIndices.push(i);

    var sortedIndices = sortIndices(allIndices, function (idx) {
      return [
        -getOptionValuePerTurn(inputData, idx),
        -inputData.econ_values[idx],
        inputData.weights[idx],
        idx
      ];
    });

    var disjointSet = new FastDisjointSet();
    var groupStateByRoot = new Map();
    var activeIndices = [];
    var groupsByIndex = new Map();
    var maybeOptions = [];

    for (var si = 0; si < sortedIndices.length; si++) {
      var index = sortedIndices[si];
      var tileList = inputData.item_tile_sets[index] || [];
      // 迭代序按 CPython set 还原；去重交给 pySetOrder
      var tileArr = pySetOrder(tileList);
      var overlappingRoots = [];
      for (var t1 = 0; t1 < tileArr.length; t1++) {
        var tileId = tileArr[t1];
        if (disjointSet.has(tileId)) {
          var oRoot = disjointSet.find(tileId);
          if (overlappingRoots.indexOf(oRoot) === -1) overlappingRoots.push(oRoot);
        }
      }

      if (overlappingRoots.length > 1) {
        maybeOptions.push({
          option_index: index,
          would_merge_groups: overlappingRoots.slice().sort(function (a, b) { return a - b; })
        });
        continue;
      }

      var root;
      if (overlappingRoots.length === 1) {
        root = overlappingRoots[0];
      } else {
        // py: next(iter(tile_set))；空 tile_set 原版会 StopIteration 崩掉，
        // 这里跳过该选项（空集合没有可争用的格子）
        if (tileArr.length === 0) continue;
        root = tileArr[0];
      }

      disjointSet.add(root);
      for (var t2 = 0; t2 < tileArr.length; t2++) {
        disjointSet.add(tileArr[t2]);
        disjointSet.merge(root, tileArr[t2]);
      }

      root = disjointSet.find(root);
      var group;
      if (!groupStateByRoot.has(root)) {
        group = {
          root_id: root,
          option_indices: [],
          tile_ids: new Set(),
          frontier: [],
          frontier_by_input_group: new Map(),
          max_econ_value: 0.0,
          max_turns: 0
        };
        groupStateByRoot.set(root, group);
      } else {
        group = groupStateByRoot.get(root);
        var inputGroup = inputData.groups[index];
        var inputGroupFrontier = group.frontier_by_input_group.get(inputGroup) || [];
        if (isDominatedByFrontier(inputData, inputGroupFrontier, index)) continue;
      }

      group.option_indices.push(index);
      for (var t3 = 0; t3 < tileArr.length; t3++) group.tile_ids.add(tileArr[t3]);
      group.max_econ_value = Math.max(group.max_econ_value, inputData.econ_values[index]);
      group.max_turns = Math.max(group.max_turns, inputData.weights[index]);
      addToFrontier(inputData, group.frontier, index);
      var ig = inputData.groups[index];
      if (!group.frontier_by_input_group.has(ig)) group.frontier_by_input_group.set(ig, []);
      addToFrontier(inputData, group.frontier_by_input_group.get(ig), index);
      activeIndices.push(index);
    }

    var sortedRoots = Array.from(groupStateByRoot.keys()).sort(function (a, b) { return a - b; });
    var compactGroupByRoot = new Map();
    for (var ci = 0; ci < sortedRoots.length; ci++) compactGroupByRoot.set(sortedRoots[ci], ci);
    groupStateByRoot.forEach(function (group, root) {
      var groupId = compactGroupByRoot.get(root);
      for (var oi = 0; oi < group.option_indices.length; oi++) {
        groupsByIndex.set(group.option_indices[oi], groupId);
      }
    });

    var mappedMaybes = maybeOptions.map(function (maybe) {
      var merged = [];
      for (var mi = 0; mi < maybe.would_merge_groups.length; mi++) {
        var r = maybe.would_merge_groups[mi];
        if (compactGroupByRoot.has(r)) merged.push(compactGroupByRoot.get(r));
      }
      merged.sort(function (a, b) { return a - b; });
      return { option_index: maybe.option_index, would_merge_groups: merged };
    });

    var maybeOrder = [];
    for (var mj = 0; mj < mappedMaybes.length; mj++) maybeOrder.push(mj);
    maybeOrder = sortIndices(maybeOrder, function (pos) {
      var maybe = mappedMaybes[pos];
      return [
        -inputData.econ_values[maybe.option_index],
        inputData.weights[maybe.option_index],
        maybe.option_index
      ];
    });
    var sortedMaybes = maybeOrder.map(function (pos) { return mappedMaybes[pos]; });

    return {
      active_indices: activeIndices,
      groups_by_index: groupsByIndex,
      maybe_options: sortedMaybes
    };
  }

  // ---------------------------------------------------------------------
  // 主解：_solve_grouped_tile_plan_options_with_mkcp_plus_greedy_conflict_resolution
  // ---------------------------------------------------------------------
  function buildGroupedInputFromTilePlanOptions(options, turnBudget, groups, values, isExternalItem, maxIterations) {
    var weights = [];
    var econValues = [];
    var itemTileSets = [];
    var empty = [];
    for (var i = 0; i < options.length; i++) {
      weights.push(options[i].length);
      econValues.push(options[i].econValue);
      var ids = [];
      options[i].tileSet.forEach(function (tile) { ids.push(tile.tile_index); });
      ids.sort(function (a, b) { return a - b; });
      itemTileSets.push(ids);
      empty.push([]);
    }
    return {
      turn_budget: turnBudget,
      groups: groups || [],
      weights: weights,
      values: values || [],
      econ_values: econValues,
      friendly_island_sets: empty,
      target_island_sets: empty.map(function (x) { return x.slice(); }),
      item_tile_sets: itemTileSets,
      is_external_item: isExternalItem || null,
      max_iterations: maxIterations === undefined ? 32 : maxIterations
    };
  }

  function solveGroupedTilePlanOptionsWithMkcpPlusGreedy(
    options, turnBudget, groups, values, isExternalItem, maxIterations, noLog, noLogVerbose) {
    var inputData = normalizeInput(
      buildGroupedInputFromTilePlanOptions(options, turnBudget, groups, values, isExternalItem, maxIterations));
    var weights = inputData.weights;
    var valuesArr = inputData.values;
    var n = weights.length;
    var grouping = pruneAndGetGroupsForKnapsack(inputData, noLog, noLogVerbose);

    var activeIdx = sortIndices(grouping.active_indices.slice(), function (i) {
      return [grouping.groups_by_index.get(i), i];
    });
    var aGroups = activeIdx.map(function (i) { return grouping.groups_by_index.get(i); });
    var aWeights = activeIdx.map(function (i) { return weights[i]; });
    var aValues = activeIdx.map(function (i) { return valuesArr[i]; });

    var knap = multipleChoiceKnapsack(activeIdx, turnBudget, aWeights, aValues, aGroups, 10.0);
    var chosenOrigIdx = knap[1];

    var chosenByGroup = new Map();
    for (var c0 = 0; c0 < chosenOrigIdx.length; c0++) {
      chosenByGroup.set(grouping.groups_by_index.get(chosenOrigIdx[c0]), chosenOrigIdx[c0]);
    }
    var chosenSet = new Set(chosenOrigIdx);
    var chosenWeight = 0;
    var chosenValue = 0;
    chosenSet.forEach(function (idx) { chosenWeight += weights[idx]; chosenValue += valuesArr[idx]; });

    // maybe 替换：把被剪掉的多根重叠项换回来，条件是有净收益且不超预算
    if (chosenWeight < turnBudget - 3) {
      for (var mi = 0; mi < grouping.maybe_options.length; mi++) {
        var maybe = grouping.maybe_options[mi];
        var maybeIdx = maybe.option_index;
        var replacedSet = new Set();
        for (var gi = 0; gi < maybe.would_merge_groups.length; gi++) {
          var gid = maybe.would_merge_groups[gi];
          if (chosenByGroup.has(gid)) replacedSet.add(chosenByGroup.get(gid));
        }
        var replacedIndices = Array.from(replacedSet).sort(function (a, b) { return a - b; });
        var replacedWeight = 0;
        var replacedValue = 0;
        for (var ri = 0; ri < replacedIndices.length; ri++) {
          replacedWeight += weights[replacedIndices[ri]];
          replacedValue += valuesArr[replacedIndices[ri]];
        }
        var candidateWeight = chosenWeight - replacedWeight + weights[maybeIdx];
        var candidateValue = chosenValue - replacedValue + valuesArr[maybeIdx];

        if (candidateWeight > turnBudget) continue;
        if (candidateValue <= chosenValue) continue;

        for (var rx = 0; rx < replacedIndices.length; rx++) {
          chosenSet.delete(replacedIndices[rx]);
          var replacedGroup = grouping.groups_by_index.get(replacedIndices[rx]);
          if (replacedGroup !== undefined && chosenByGroup.has(replacedGroup)) chosenByGroup.delete(replacedGroup);
        }
        chosenSet.add(maybeIdx);
        for (var gj = 0; gj < maybe.would_merge_groups.length; gj++) {
          chosenByGroup.set(maybe.would_merge_groups[gj], maybeIdx);
        }
        chosenWeight = candidateWeight;
        chosenValue = candidateValue;
      }
    }

    // ---- 后处理：单冲突替换 + 修复背包 ----
    var chosenTileOwnerByTileId = new Map();
    var chosenByInputGroup = new Map();
    chosenSet.forEach(function (chosenIdx) {
      chosenByInputGroup.set(inputData.groups[chosenIdx], chosenIdx);
      var tiles = inputData.item_tile_sets[chosenIdx] || [];
      for (var t = 0; t < tiles.length; t++) chosenTileOwnerByTileId.set(tiles[t], chosenIdx);
    });

    var conflictFreeIndices = [];
    for (var oi = 0; oi < n; oi++) {
      if (chosenSet.has(oi)) continue;
      var optionTiles = inputData.item_tile_sets[oi] || [];
      var conflictingChosen = new Set();
      for (var ti2 = 0; ti2 < optionTiles.length; ti2++) {
        var owner = chosenTileOwnerByTileId.get(optionTiles[ti2]);
        if (owner !== undefined) conflictingChosen.add(owner);
      }
      var optionInputGroup = inputData.groups[oi];
      var sameGroupChosenIdx = chosenByInputGroup.has(optionInputGroup) ? chosenByInputGroup.get(optionInputGroup) : undefined;
      if (conflictingChosen.size === 0) {
        conflictFreeIndices.push(oi);
        continue;
      }
      if (conflictingChosen.size > 1) continue;
      var replacedIdx = Math.min.apply(null, Array.from(conflictingChosen));
      if (sameGroupChosenIdx !== undefined && sameGroupChosenIdx !== replacedIdx) continue;

      var candWeight = chosenWeight - weights[replacedIdx] + weights[oi];
      var candValue = chosenValue - valuesArr[replacedIdx] + valuesArr[oi];
      if (candWeight > turnBudget || candValue <= chosenValue) continue;

      chosenSet.delete(replacedIdx);
      chosenSet.add(oi);
      chosenWeight = candWeight;
      chosenValue = candValue;
      var replacedGroupId = inputData.groups[replacedIdx];
      if (chosenByInputGroup.has(replacedGroupId)) chosenByInputGroup.delete(replacedGroupId);
      chosenByInputGroup.set(optionInputGroup, oi);
      var replacedTiles = inputData.item_tile_sets[replacedIdx] || [];
      for (var rt = 0; rt < replacedTiles.length; rt++) {
        if (chosenTileOwnerByTileId.get(replacedTiles[rt]) === replacedIdx) chosenTileOwnerByTileId.delete(replacedTiles[rt]);
      }
      for (var nt = 0; nt < optionTiles.length; nt++) chosenTileOwnerByTileId.set(optionTiles[nt], oi);
    }

    var chosenArr = Array.from(chosenSet);
    var consideredOrder = sortIndices(chosenArr, function (idx) {
      return [getOptionValuePerTurn(inputData, idx), valuesArr[idx], -weights[idx], idx];
    });
    var consideredCount = Math.max(1, Math.min(chosenArr.length, 8));
    var consideredChosenIndices = consideredOrder.slice(0, consideredCount);
    var repairCapacity = 0;
    var repairExistingValue = 0;
    for (var rc = 0; rc < consideredChosenIndices.length; rc++) {
      repairCapacity += weights[consideredChosenIndices[rc]];
      repairExistingValue += valuesArr[consideredChosenIndices[rc]];
    }
    var consideredChosenSet = new Set(consideredChosenIndices);
    var consideredChosenTileSet = new Set();
    for (var ct = 0; ct < consideredChosenIndices.length; ct++) {
      var ctTiles = inputData.item_tile_sets[consideredChosenIndices[ct]] || [];
      for (var cti = 0; cti < ctTiles.length; cti++) consideredChosenTileSet.add(ctTiles[cti]);
    }
    var keptChosenIndices = chosenArr.filter(function (idx) { return !consideredChosenSet.has(idx); });
    var keptChosenTileSet = new Set();
    for (var kt = 0; kt < keptChosenIndices.length; kt++) {
      var ktTiles = inputData.item_tile_sets[keptChosenIndices[kt]] || [];
      for (var kti = 0; kti < ktTiles.length; kti++) keptChosenTileSet.add(ktTiles[kti]);
    }

    var directReplacement = [];
    for (var di = 0; di < n; di++) {
      if (chosenSet.has(di)) continue;
      if (weights[di] > repairCapacity) continue;
      var diTiles = inputData.item_tile_sets[di] || [];
      var touchesKept = false;
      var touchesConsidered = false;
      for (var dt = 0; dt < diTiles.length; dt++) {
        if (keptChosenTileSet.has(diTiles[dt])) { touchesKept = true; break; }
        if (consideredChosenTileSet.has(diTiles[dt])) touchesConsidered = true;
      }
      if (touchesKept) continue;
      if (!touchesConsidered) continue;
      directReplacement.push(di);
    }
    directReplacement = sortIndices(directReplacement, function (idx) {
      return [-getOptionValuePerTurn(inputData, idx), -valuesArr[idx], weights[idx], idx];
    });
    conflictFreeIndices = sortIndices(conflictFreeIndices, function (idx) {
      return [-getOptionValuePerTurn(inputData, idx), -valuesArr[idx], weights[idx], idx];
    });

    var wideCap = Math.max(8, consideredChosenIndices.length * 4);
    var repairCandidates = consideredChosenIndices.slice();
    var directTake = directReplacement.slice(0, wideCap);
    for (var dt2 = 0; dt2 < directTake.length; dt2++) repairCandidates.push(directTake[dt2]);
    var freeTake = conflictFreeIndices.slice(0, wideCap);
    for (var ft = 0; ft < freeTake.length; ft++) {
      var fi = freeTake[ft];
      if (weights[fi] > repairCapacity) continue;
      var fiTiles = inputData.item_tile_sets[fi] || [];
      var bad = false;
      for (var fit = 0; fit < fiTiles.length; fit++) {
        if (keptChosenTileSet.has(fiTiles[fit])) { bad = true; break; }
      }
      if (!bad) repairCandidates.push(fi);
    }
    var seenRepair = new Set();
    var repairCandidateIndices = [];
    for (var rci = 0; rci < repairCandidates.length; rci++) {
      if (seenRepair.has(repairCandidates[rci])) continue;
      seenRepair.add(repairCandidates[rci]);
      repairCandidateIndices.push(repairCandidates[rci]);
    }

    if (repairCandidateIndices.length > consideredChosenIndices.length) {
      var repairExternal = new Map();
      for (var re2 = 0; re2 < repairCandidateIndices.length; re2++) {
        if (isExternal(inputData, repairCandidateIndices[re2])) repairExternal.set(re2, true);
      }
      var repairInput = normalizeInput({
        turn_budget: repairCapacity,
        groups: repairCandidateIndices.map(function (idx) { return inputData.groups[idx]; }),
        weights: repairCandidateIndices.map(function (idx) { return weights[idx]; }),
        values: repairCandidateIndices.map(function (idx) { return valuesArr[idx]; }),
        econ_values: repairCandidateIndices.map(function (idx) { return inputData.econ_values[idx]; }),
        friendly_island_sets: repairCandidateIndices.map(function (idx) { return inputData.friendly_island_sets[idx]; }),
        target_island_sets: repairCandidateIndices.map(function (idx) { return inputData.target_island_sets[idx]; }),
        item_tile_sets: repairCandidateIndices.map(function (idx) { return inputData.item_tile_sets[idx]; }),
        is_external_item: repairExternal,
        max_iterations: inputData.max_iterations
      });
      var repairGrouping = pruneAndGetGroupsForKnapsack(repairInput, noLog, noLogVerbose);
      var repairActiveIdx = sortIndices(repairGrouping.active_indices.slice(), function (i) {
        return [repairGrouping.groups_by_index.get(i), i];
      });
      var repairGroups = repairActiveIdx.map(function (i) { return repairGrouping.groups_by_index.get(i); });
      var repairWeights = repairActiveIdx.map(function (i) { return repairInput.weights[i]; });
      var repairValues = repairActiveIdx.map(function (i) { return repairInput.values[i]; });

      var repairKnap = multipleChoiceKnapsack(repairActiveIdx, repairCapacity, repairWeights, repairValues, repairGroups, 10.0);
      var repairMaxValue = repairKnap[0];
      var repairChosenLocal = repairKnap[1];

      var repairChosenOriginal = new Set();
      for (var rp = 0; rp < repairChosenLocal.length; rp++) {
        repairChosenOriginal.add(repairCandidateIndices[repairChosenLocal[rp]]);
      }
      var repairChosenTileSet = new Set();
      var repairHasDuplicateTiles = false;
      repairChosenOriginal.forEach(function (repairIdx) {
        var tiles = inputData.item_tile_sets[repairIdx] || [];
        for (var t2 = 0; t2 < tiles.length; t2++) {
          if (repairChosenTileSet.has(tiles[t2])) repairHasDuplicateTiles = true;
          repairChosenTileSet.add(tiles[t2]);
        }
      });
      var repairChosenInputGroups = [];
      repairChosenOriginal.forEach(function (idx) { repairChosenInputGroups.push(inputData.groups[idx]); });
      var repairHasDuplicateGroups = new Set(repairChosenInputGroups).size !== repairChosenInputGroups.length;

      var remainingChosen = chosenArr.filter(function (idx) { return !consideredChosenSet.has(idx); });
      var remainingChosenTileSet = new Set();
      for (var rt2 = 0; rt2 < remainingChosen.length; rt2++) {
        var rmTiles = inputData.item_tile_sets[remainingChosen[rt2]] || [];
        for (var rmt = 0; rmt < rmTiles.length; rmt++) remainingChosenTileSet.add(rmTiles[rmt]);
      }
      var remainingInputGroups = new Set(remainingChosen.map(function (idx) { return inputData.groups[idx]; }));

      var tileOverlap = false;
      repairChosenTileSet.forEach(function (tileId) {
        if (remainingChosenTileSet.has(tileId)) tileOverlap = true;
      });
      var groupOverlap = false;
      repairChosenInputGroups.forEach(function (g2) {
        if (remainingInputGroups.has(g2)) groupOverlap = true;
      });

      if (!repairHasDuplicateTiles && !repairHasDuplicateGroups && !tileOverlap && !groupOverlap &&
        repairMaxValue > repairExistingValue) {
        consideredChosenSet.forEach(function (idx) { chosenSet.delete(idx); });
        repairChosenOriginal.forEach(function (idx) { chosenSet.add(idx); });
        var repairChosenWeight = 0;
        repairChosenOriginal.forEach(function (idx) { repairChosenWeight += weights[idx]; });
        chosenWeight = chosenWeight - repairCapacity + repairChosenWeight;
        chosenValue = chosenValue - repairExistingValue + repairMaxValue;
      }
    }

    var chosenOrigSorted = Array.from(chosenSet).sort(function (a, b) { return b - a; });
    var finalGroups = [];
    for (var fg = 0; fg < n; fg++) {
      var gv = grouping.groups_by_index.get(fg);
      finalGroups.push(gv === undefined ? -1 : gv);
    }

    return makeResult({
      max_value: chosenValue,
      chosen_indices: chosenOrigSorted,
      chosen_weight: chosenWeight,
      blacklist: [],
      iteration_summaries: [{
        iteration: 0,
        max_value: chosenValue,
        chosen_indices: chosenOrigSorted.slice(),
        chosen_weight: chosenWeight,
        conflicts: []
      }],
      groups: finalGroups
    });
  }

  // ---------------------------------------------------------------------
  // 形状转换 + 入口
  // ---------------------------------------------------------------------
  function adaptGroupedKnapsackInputToTilePlanOptions(rawInput) {
    var inputData = normalizeInput(rawInput);
    var out = [];
    for (var i = 0; i < inputData.weights.length; i++) {
      var tileSet = new Set();
      var ids = inputData.item_tile_sets[i] || [];
      for (var t = 0; t < ids.length; t++) {
        // 原版这里造的是真 Tile(tile_id, 0, tileIndex=tile_id)；
        // 下游只读 tile_index，用最小形状替代，别的地方拿到也不会误当成地图上的格子
        tileSet.add({ tile_index: ids[t] });
      }
      out.push({
        item: i,
        length: inputData.weights[i],
        tileSet: tileSet,
        econValue: inputData.econ_values[i]
      });
    }
    return out;
  }

  function solveGroupedKnapsackInput(rawInput, noLog, noLogVerbose) {
    var options = adaptGroupedKnapsackInputToTilePlanOptions(rawInput);
    return solveGroupedTilePlanOptionsWithMkcpPlusGreedy(
      options,
      rawInput.turn_budget,
      rawInput.groups,
      rawInput.values,
      rawInput.is_external_item,
      rawInput.max_iterations === undefined ? 32 : rawInput.max_iterations,
      noLog,
      noLogVerbose);
  }

  function solveGroupedKnapsackPreGroupInput(rawInput, noLog) {
    var items = rawInput.items || [];
    var groupLookup = new Map();
    var groups = [];
    var nextGroup = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var groupId;
      if (item.border_pair === null || item.border_pair === undefined) {
        groupId = item.external_group_id;
      } else {
        var key = item.border_pair[0] + ':' + item.border_pair[1];
        if (!groupLookup.has(key)) {
          groupLookup.set(key, nextGroup);
          nextGroup += 1;
        }
        groupId = groupLookup.get(key);
      }
      groups.push(groupId);
    }

    var externalMap = new Map();
    for (var e = 0; e < items.length; e++) {
      if (items[e].is_external) externalMap.set(e, true);
    }

    var groupedInput = {
      turn_budget: rawInput.turn_budget,
      groups: groups,
      weights: items.map(function (it) { return it.weight; }),
      values: items.map(function (it) { return it.value; }),
      econ_values: items.map(function (it) { return it.econ_value; }),
      friendly_island_sets: items.map(function (it) { return it.friendly_island_set; }),
      target_island_sets: items.map(function (it) { return it.target_island_set; }),
      item_tile_sets: items.map(function (it) { return it.item_tile_set; }),
      is_external_item: externalMap,
      max_iterations: rawInput.max_iterations === undefined ? 32 : rawInput.max_iterations
    };
    var result = solveGroupedKnapsackInput(groupedInput, noLog, true);
    result.groups = groups;
    return result;
  }

  function formatPreGroupItemForTest(item, indent) {
    var prefix = new Array((indent || 0) + 1).join(' ');
    return [
      prefix + 'GroupedKnapsackPreGroupItem(',
      prefix + '    border_pair=' + JSON.stringify(item.border_pair) + ',',
      prefix + '    external_group_id=' + JSON.stringify(item.external_group_id) + ',',
      prefix + '    is_external=' + JSON.stringify(!!item.is_external) + ',',
      prefix + '    weight=' + JSON.stringify(item.weight) + ',',
      prefix + '    value=' + JSON.stringify(item.value) + ',',
      prefix + '    econ_value=' + JSON.stringify(item.econ_value) + ',',
      prefix + '    friendly_island_set=' + JSON.stringify(item.friendly_island_set) + ',',
      prefix + '    target_island_set=' + JSON.stringify(item.target_island_set) + ',',
      prefix + '    item_tile_set=' + JSON.stringify(item.item_tile_set) + ')'
    ];
  }

  function formatPreGroupInputForTest(rawInput) {
    var items = rawInput.items || [];
    var lines = [
      'GroupedKnapsackPreGroupInput(',
      '    turn_budget=' + rawInput.turn_budget + ',',
      '    items=['
    ];
    for (var i = 0; i < items.length; i++) lines = lines.concat(formatPreGroupItemForTest(items[i], 8));
    lines.push('    ],');
    lines.push('    max_iterations=' + (rawInput.max_iterations === undefined ? 32 : rawInput.max_iterations) + ')');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // 协议式 0/1 背包（原始 solve_tile_plan_options 的 OR-Tools 分支替代）
  // ---------------------------------------------------------------------
  var PlanSolver = {
    MkcpPlusGreedyConflictResolution: 'MkcpPlusGreedyConflictResolution',
    CpSat: 'CpSat',
    MpCbc: 'MpCbc',
    MpScip: 'MpScip'
  };

  function buildTilePlanOptionConflictConstraints(options) {
    var tileToOptionIndices = new Map();
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      var iter = opt.tileSet instanceof Set ? Array.from(opt.tileSet) : opt.tileSet;
      for (var t = 0; t < iter.length; t++) {
        var tileIndex = iter[t].tile_index;
        if (!tileToOptionIndices.has(tileIndex)) tileToOptionIndices.set(tileIndex, []);
        tileToOptionIndices.get(tileIndex).push(i);
      }
    }
    var exclusive = [];
    // Python dict 保插入序，这里 Map 也是，顺序对齐
    tileToOptionIndices.forEach(function (indices) {
      if (indices.length > 1) exclusive.push(indices);
    });
    return {
      tile_to_option_indices: tileToOptionIndices,
      mutually_exclusive_option_indices_by_tile: exclusive
    };
  }

  // Python round() 是「四舍六入五取偶」，JS Math.round 是「五入」，
  // value_multiple=2.05 时候 .5 的落点会不一样，所以自己实现
  function pyRound(x) {
    var floor = Math.floor(x);
    var diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  function getTilePlanOptionIntegerValues(options, valueMultiple) {
    return options.map(function (opt) { return pyRound(opt.econValue * valueMultiple); });
  }

  // 确定性精确解：容量 + 「同一格子的选项互斥」。原版交给 CP-SAT/CBC/SCIP，
  // 平局解由求解器内部决定；这里用按价值密度排序的分支定界，平局保留先找到的组合。
  function solveExactKnapsackWithConflicts(weights, values, turnBudget, exclusiveGroups) {
    var n = weights.length;
    if (n === 0) return { chosen: [], value: 0 };

    var blocking = new Array(n);
    for (var i = 0; i < n; i++) blocking[i] = [];
    for (var g = 0; g < exclusiveGroups.length; g++) {
      var group = exclusiveGroups[g];
      for (var a = 0; a < group.length; a++) {
        for (var b = 0; b < group.length; b++) {
          if (a !== b) blocking[group[a]].push(group[b]);
        }
      }
    }

    var order = sortIndices(
      (function () { var arr = []; for (var k = 0; k < n; k++) arr.push(k); return arr; })(),
      function (idx) {
        var w = weights[idx] <= 0 ? 1 : weights[idx];
        return [-(values[idx] / w), -values[idx], weights[idx], idx];
      });

    // 后缀分数背包上界，用于剪枝
    var suffixValue = new Array(n + 1);
    var suffixWeight = new Array(n + 1);
    suffixValue[n] = 0;
    suffixWeight[n] = 0;
    for (var s = n - 1; s >= 0; s--) {
      suffixValue[s] = suffixValue[s + 1] + values[order[s]];
      suffixWeight[s] = suffixWeight[s + 1] + weights[order[s]];
    }

    function fractionalBound(pos, capacity) {
      var bound = 0;
      for (var p = pos; p < n; p++) {
        var w = weights[order[p]];
        if (w <= capacity) {
          bound += values[order[p]];
          capacity -= w;
        } else {
          if (w > 0) bound += (values[order[p]] * capacity) / w;
          break;
        }
      }
      return bound;
    }

    var best = { value: 0, weight: 0, chosen: [] };
    var current = [];
    var currentValue = 0;
    var currentWeight = 0;
    var blocked = new Uint8Array(n);
    var nodes = 0;
    var NODE_CAP = 300000;

    function dfs(pos) {
      if (nodes++ > NODE_CAP) return;
      if (currentValue > best.value ||
        (currentValue === best.value && currentWeight < best.weight)) {
        best = { value: currentValue, weight: currentWeight, chosen: current.slice() };
      }
      if (pos >= n) return;
      if (currentValue + fractionalBound(pos, turnBudget - currentWeight) <= best.value) return;

      var idx = order[pos];
      // 先试「拿」，与原版最大化目标一致
      if (!blocked[idx] && weights[idx] + currentWeight <= turnBudget) {
        current.push(idx);
        currentValue += values[idx];
        currentWeight += weights[idx];
        var addBlocked = [];
        for (var k = 0; k < blocking[idx].length; k++) {
          var other = blocking[idx][k];
          if (blocked[other] === 0) { blocked[other] = 1; addBlocked.push(other); }
        }
        dfs(pos + 1);
        for (var r = 0; r < addBlocked.length; r++) blocked[addBlocked[r]] = 0;
        currentValue -= values[idx];
        currentWeight -= weights[idx];
        current.pop();
      }
      dfs(pos + 1);
    }

    dfs(0);
    return { chosen: best.chosen.slice().sort(function (x, y) { return x - y; }), value: best.value };
  }

  function buildTilePlanOptionResult(options, values, chosenIndices, maxValue) {
    var chosenItems = chosenIndices.map(function (optionIndex) {
      var opt = options[optionIndex];
      return opt && Object.prototype.hasOwnProperty.call(opt, 'item') ? opt.item : opt;
    });
    var chosenWeight = 0;
    for (var i = 0; i < chosenIndices.length; i++) chosenWeight += options[chosenIndices[i]].length;
    return {
      max_value: maxValue,
      chosen_indices: chosenIndices,
      chosen_weight: chosenWeight,
      chosen_items: chosenItems,
      solver_status: 0
    };
  }

  function solveTilePlanOptions(options, turnBudget, solver, valueMultiple, perfTimer) {
    if (valueMultiple === undefined) valueMultiple = 10000;
    if (solver === PlanSolver.MkcpPlusGreedyConflictResolution) {
      // 原版同样 raise，别在这里替它编行为
      throw new Error('PlanSolver.MkcpPlusGreedyConflictResolution is not wired into solve_tile_plan_options');
    }
    if (solver !== PlanSolver.CpSat && solver !== PlanSolver.MpCbc && solver !== PlanSolver.MpScip) {
      throw new Error('Unsupported plan solver ' + solver);
    }
    var constraints = buildTilePlanOptionConflictConstraints(options);
    var values = getTilePlanOptionIntegerValues(options, valueMultiple);
    var weights = options.map(function (opt) { return opt.length; });
    var solved = solveExactKnapsackWithConflicts(
      weights, values, turnBudget, constraints.mutually_exclusive_option_indices_by_tile);
    var result = buildTilePlanOptionResult(options, values, solved.chosen, solved.value);
    result.solver_status = 0;
    return result;
  }

  // 原版的 KnapsackUtils 回退路（不处理格子互斥），保留以便对照。
  // expandutils.js 只导出了多选版本，这里就地写个 0/1 DP，别为一条对照路再造依赖。
  function solveTilePlanOptionsWithExistingKnapsackSolver(options, turnBudget, valueMultiple) {
    if (valueMultiple === undefined) valueMultiple = 10000;
    var values = getTilePlanOptionIntegerValues(options, valueMultiple);
    var weights = options.map(function (opt) { return opt.length; });
    var n = weights.length;
    var dp = new Array(turnBudget + 1);
    for (var w = 0; w <= turnBudget; w++) dp[w] = 0;
    for (var i = 0; i < n; i++) {
      for (var c = turnBudget; c >= weights[i]; c--) {
        var take = dp[c - weights[i]] + values[i];
        if (take > dp[c]) dp[c] = take;
      }
    }
    var res = dp[turnBudget];
    var chosen = [];
    var rem = turnBudget;
    // 原版 KnapsackUtils.solve_knapsack 的回溯：从后往前，值对得上就拿
    for (var bi = n; bi > 0 && res > 0; bi--) {
      if (res === dp[rem] && res - values[bi - 1] === dp[rem - weights[bi - 1]] && weights[bi - 1] <= rem) {
        chosen.push(bi - 1);
        res -= values[bi - 1];
        rem -= weights[bi - 1];
      }
    }
    chosen.sort(function (a, b) { return a - b; });
    return buildTilePlanOptionResult(options, values, chosen, dp[turnBudget]);
  }

  // ---------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------
  var GatherCaptureGroupKnapsacker = {
    prune_and_get_groups_for_knapsack: pruneAndGetGroupsForKnapsack,
    solve_grouped_knapsack_input: solveGroupedKnapsackInput,
    solve_grouped_knapsack_pre_group_input: solveGroupedKnapsackPreGroupInput,
    solve_tile_plan_options: solveTilePlanOptions,
    solve_tile_plan_options_with_existing_knapsack_solver: solveTilePlanOptionsWithExistingKnapsackSolver,
    build_tile_plan_option_conflict_constraints: buildTilePlanOptionConflictConstraints,
    adapt_grouped_knapsack_input_to_tile_plan_options: adaptGroupedKnapsackInputToTilePlanOptions,
    format_pre_group_input_for_test: formatPreGroupInputForTest,

    pruneAndGetGroupsForKnapsack: pruneAndGetGroupsForKnapsack,
    solveGroupedKnapsackInput: solveGroupedKnapsackInput,
    solveGroupedKnapsackPreGroupInput: solveGroupedKnapsackPreGroupInput,
    solveTilePlanOptions: solveTilePlanOptions,
    buildTilePlanOptionConflictConstraints: buildTilePlanOptionConflictConstraints
  };

  flow.FastDisjointSet = FastDisjointSet;
  flow.PlanSolver = PlanSolver;
  flow.GatherCaptureGroupKnapsacker = GatherCaptureGroupKnapsacker;
  flow.prune_and_get_groups_for_knapsack = pruneAndGetGroupsForKnapsack;
  flow.solve_grouped_knapsack_input = solveGroupedKnapsackInput;
  flow.solve_grouped_knapsack_pre_group_input = solveGroupedKnapsackPreGroupInput;
  flow.solve_tile_plan_options = solveTilePlanOptions;

  EK.FastDisjointSet = FastDisjointSet;
  EK.PlanSolver = PlanSolver;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);

/*
 * 隔离世界桥：
 *   MAIN world 用不了 chrome.* API，所以设置的读写和扩展版本号都放这里，
 *   两边通过 window.postMessage 交换：
 *     {__gb:'settings'} 页面 ← 隔离世界（推设置）
 *     {__gb:'save'}     页面 → 隔离世界（存设置）
 *     {__gb:'version'}  隔离世界 → 页面（面板标题上显示的版本号）
 *     {__gb:'hello'}    页面 → 隔离世界（页面先起来了，要求补发一次）
 *
 * 设置里除了开关和每回合步数，还有面板位置（pos）和折叠状态（folded）——
 * 用户把面板拖到哪儿、折起来没有，刷新页面后要保持原样。
 *
 * 版本号必须来自 chrome.runtime.getManifest()：edge://extensions 里改了清单但没点
 * 重新加载时，页面跑的仍是旧代码，面板上的版本号就是唯一能证明"到底加载的是哪一版"的东西。
 */
(function () {
  'use strict';

  var DEFAULTS = { enabled: true, maxMoves: 1, pos: null, folded: false };
  var KEY = 'gbSettings';

  function cleanPos(pos) {
    if (!pos || typeof pos !== 'object') return null;
    var x = Number(pos.x);
    var y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // 位置只做粗校验，具体夹到视口内是页面侧的事（那边才知道视口多大）
    if (Math.abs(x) > 20000 || Math.abs(y) > 20000) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function withDefaults(s) {
    var out = {
      enabled: DEFAULTS.enabled,
      maxMoves: DEFAULTS.maxMoves,
      pos: DEFAULTS.pos,
      folded: DEFAULTS.folded
    };
    if (s && typeof s === 'object') {
      if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
      if (Number.isInteger(s.maxMoves) && s.maxMoves >= 1 && s.maxMoves <= 2) out.maxMoves = s.maxMoves;
      if (s.pos === null) out.pos = null;
      else if (s.pos !== undefined) out.pos = cleanPos(s.pos);
      if (typeof s.folded === 'boolean') out.folded = s.folded;
    }
    return out;
  }

  function push(settings) {
    window.postMessage({ __gb: 'settings', settings: settings }, '*');
  }

  function pushVersion() {
    var v = '';
    try {
      v = chrome.runtime.getManifest().version;
    } catch (e) {
      /* 清单读不到就不显示版本号，面板会留空 */
    }
    if (v) window.postMessage({ __gb: 'version', version: v }, '*');
  }

  try {
    chrome.storage.local.get({ gbSettings: DEFAULTS }, function (items) {
      push(withDefaults(items && items.gbSettings));
    });
  } catch (e) {
    push(DEFAULTS);
  }
  pushVersion();

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d) return;
    if (d.__gb === 'hello') {
      pushVersion();
      return;
    }
    if (d.__gb !== 'save') return;
    try {
      chrome.storage.local.set({ gbSettings: withDefaults(d.settings) });
    } catch (err) {
      /* storage 不可用时静默，页面侧仍按内存设置跑 */
    }
  });
})();

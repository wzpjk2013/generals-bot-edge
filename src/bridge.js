/*
 * 隔离世界桥：
 * MAIN world 用不了 chrome.* API，所以设置的读写都放这里，
 * 两边通过 window.postMessage 交换（{__gb:'settings'} / {__gb:'save'}）。
 */
(function () {
  'use strict';

  var DEFAULTS = { enabled: true, allowPublic: false, maxMoves: 6 };
  var KEY = 'gbSettings';

  function withDefaults(s) {
    var out = { enabled: DEFAULTS.enabled, allowPublic: DEFAULTS.allowPublic, maxMoves: DEFAULTS.maxMoves };
    if (s && typeof s === 'object') {
      if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
      if (typeof s.allowPublic === 'boolean') out.allowPublic = s.allowPublic;
      if (Number.isInteger(s.maxMoves) && s.maxMoves >= 1 && s.maxMoves <= 20) out.maxMoves = s.maxMoves;
    }
    return out;
  }

  function push(settings) {
    window.postMessage({ __gb: 'settings', settings: settings }, '*');
  }

  try {
    chrome.storage.local.get({ gbSettings: DEFAULTS }, function (items) {
      push(withDefaults(items && items.gbSettings));
    });
  } catch (e) {
    push(DEFAULTS);
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__gb !== 'save') return;
    try {
      chrome.storage.local.set({ gbSettings: withDefaults(d.settings) });
    } catch (err) {
      /* storage 不可用时静默，页面侧仍按内存设置跑 */
    }
  });
})();

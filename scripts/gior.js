/*
 * .gior / /api/replay/<id> 是 lz-string 压的 JSON，这里把解压实现自带一份。
 *
 * 出处（官方 bundle）：
 *   a.deserialize = function (t) { var e = JSON.parse(s.decompressFromUint8Array(new Uint8Array(t))); … }
 *   compressToUint8Array:   n[2r] = c >>> 8; n[2r+1] = c % 256      // 16 位，大端
 *   decompressFromUint8Array: n[r] = 256*e[2r] + e[2r+1] → String.fromCharCode → decompress()
 *   decompress(input) = _decompress(input.length, 32, i => getBaseValue(keyStrBase64, input[i]))
 *
 * 只实现解压这一侧（我们只读回放，不写）。算法就是 lz-string 的经典实现。
 */
'use strict';

const KEY_STR_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

const reverseMap = (() => {
  const m = {};
  for (let i = 0; i < KEY_STR_BASE64.length; i++) m[KEY_STR_BASE64.charAt(i)] = i;
  return m;
})();

function baseValue(ch) {
  return reverseMap[ch];
}

function _decompress(length, resetValue, getNextValue) {
  const dictionary = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = '';
  const result = [];
  let i;
  let w;
  let c;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  function readBits(count) {
    let bits = 0;
    let power = 1;
    const maxpower = Math.pow(2, count);
    while (power !== maxpower) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  }

  for (i = 0; i < 3; i++) dictionary[i] = i;

  switch ((c = readBits(2))) {
    case 0:
      c = String.fromCharCode(readBits(8));
      break;
    case 1:
      c = String.fromCharCode(readBits(16));
      break;
    case 2:
      return '';
  }
  dictionary[3] = c;
  w = c;
  result.push(c);

  for (;;) {
    if (data.index > length) return '';
    c = readBits(numBits);
    switch (c) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
    if (dictionary[c] !== undefined) entry = String(dictionary[c]);
    else if (c === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
}

/*
 * decompress 用的是**原始 charCode**，不是 base64 字母表：
 *   decompress: function (t) { return null == t ? "" : "" == t ? null
 *       : o._decompress(t.length, 32768, function (e) { return t.charCodeAt(e); }) }
 * （字母表那套只在 decompressFromBase64 里用。第一版抄错了这里，
 *   解出来是 27 个 \u0000——所以这条注释留着。）
 */
function decompress(input) {
  if (input == null) return '';
  if (input === '') return null;
  return _decompress(input.length, 32768, (index) => input.charCodeAt(index));
}

function decompressFromUint8Array(bytes) {
  if (bytes == null) return decompress(bytes);
  const units = new Array(bytes.length >> 1);
  for (let r = 0; r < units.length; r++) units[r] = 256 * bytes[2 * r] + bytes[2 * r + 1];
  let s = '';
  for (const code of units) s += String.fromCharCode(code);
  return decompress(s);
}

module.exports = { decompress, decompressFromUint8Array };

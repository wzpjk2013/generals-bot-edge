/*
 * 版本号自增：每次改扩展代码都要能看出「页面里跑的是哪一版」，
 * 所以 manifest.json 和 package.json 的版本号必须同步、每次发布都涨。
 *
 *   node scripts/bump-version.js          # 1.1.0 -> 1.1.1
 *   node scripts/bump-version.js minor     # 1.1.1 -> 1.2.0
 *   node scripts/bump-version.js major     # 1.2.0 -> 2.0.0
 *   node scripts/bump-version.js 1.3.7     # 直接定版本
 *   node scripts/bump-version.js --check   # 只检查两边是否一致（不一致退 1）
 *
 * 只改版本字段，其余格式原样保留；扩展的 Chrome version 只允许 1~4 段数字，
 * 所以这里拒绝预发布后缀（-beta 之类）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const PKG = path.join(ROOT, 'package.json');

function readVersion(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return j.version;
}

function writeVersion(file, next) {
  // 用正则只替换 version 那一行，避免 JSON.stringify 把整个文件重排
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(/("version"\s*:\s*)"[^"]*"/, '$1"' + next + '"');
  if (out === src) throw new Error('没找到 version 字段：' + file);
  fs.writeFileSync(file, out, 'utf8');
}

function bump(cur, kind) {
  const parts = cur.split('.').map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') return [parts[0] + 1, 0, 0].join('.');
  if (kind === 'minor') return [parts[0], parts[1] + 1, 0].join('.');
  if (kind === 'patch' || kind === '') return [parts[0], parts[1], parts[2] + 1].join('.');
  if (!/^\d+(\.\d+){0,3}$/.test(kind)) throw new Error('版本号只能由 1~4 段数字组成：' + kind);
  return kind;
}

function main() {
  const arg = (process.argv[2] || '').trim();
  const mv = readVersion(MANIFEST);
  const pv = readVersion(PKG);

  if (arg === '--check' || arg === 'check') {
    if (mv !== pv) {
      console.error('版本号不一致：manifest=' + mv + ' package=' + pv + '（跑 node scripts/bump-version.js 修）');
      process.exit(1);
    }
    console.log('版本号一致：' + mv);
    return;
  }

  const next = bump(mv, arg);
  writeVersion(MANIFEST, next);
  writeVersion(PKG, next);
  console.log(mv + ' -> ' + next + '（manifest.json / package.json 已同步）');
  console.log('别忘了：edge://extensions 里点「重新加载」，页面上的面板标题会显示 v' + next);
}

main();

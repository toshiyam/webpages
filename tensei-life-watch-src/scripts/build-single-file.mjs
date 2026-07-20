#!/usr/bin/env node
// game-data/ + game-engine/ + web-ui/ + index.html から、配布用の単一HTML
// (toshiyam/webpages の tensei-life-watch.html) を自動生成する。
//
// モジュール版ソースが今後のissue対応で更新されるたびに、単一ファイル版を
// 手作業で二重に書き直す必要をなくすためのビルドスクリプト。
//
// 使い方: node scripts/build-single-file.mjs [出力先パス]
//   既定の出力先は ../tensei-life-watch.html （iseten_src と並ぶ場所）。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

var __dirname = dirname(fileURLToPath(import.meta.url));
var root = join(__dirname, '..');

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

// ES module の import/export だけを取り除く。このリポジトリのモジュールは
// 「import { a, b } from './x.js';」「export function」「export var」の
// 3パターンしか使っていないため、正規表現での除去で十分に安全。
function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+function/gm, 'function')
    .replace(/^export\s+var/gm, 'var');
}

var ENGINE_FILES = [
  'game-engine/rng.js',
  'game-engine/character-generator.js',
  'game-engine/event-selector.js',
  'game-engine/decision-engine.js',
  'game-engine/effect-processor.js',
  'game-engine/mortality.js',
  'game-engine/life-rank.js',
  'game-engine/time-processor.js',
  'game-engine/summary-generator.js',
  'game-engine/load-data.js',
  'game-engine/simulate.js'
];

function buildEngineBundle() {
  return ENGINE_FILES.map(function (f) {
    return '  /* ---- ' + f + ' ---- */\n' + stripModuleSyntax(read(f)).trim();
  }).join('\n\n');
}

function buildDataBundleLiteral() {
  var traits = read('game-data/traits.json').trim();
  var occupations = read('game-data/occupations.json').trim();
  var world = read('game-data/world.json').trim();
  var events = read('game-data/events.json').trim();
  var elements = read('game-data/elements.json').trim();
  var goals = read('game-data/goals.json').trim();
  return [
    '  var __TRAITS_JSON__ = ' + traits + ';',
    '  var __OCCUPATIONS_JSON__ = ' + occupations + ';',
    '  var __WORLD_JSON__ = ' + world + ';',
    '  var __EVENTS_JSON__ = ' + events + ';',
    '  var __ELEMENTS_JSON__ = ' + elements + ';',
    '  var __GOALS_JSON__ = ' + goals + ';'
  ].join('\n');
}

function buildUiBundle() {
  var src = stripModuleSyntax(read('web-ui/main.js'));
  // ブラウザから fetch していた loadData() を、埋め込み済みJSONを直接使う形へ差し替える。
  src = src.replace(
    /async function loadData\(\) \{[\s\S]*?\n\}/,
    'async function loadData() {\n' +
    '  return buildDataBundle(__TRAITS_JSON__, __OCCUPATIONS_JSON__, __WORLD_JSON__, __EVENTS_JSON__, __ELEMENTS_JSON__, __GOALS_JSON__);\n' +
    '}'
  );
  return src.trim();
}

function buildScript() {
  return [
    "(function () {",
    "  'use strict';",
    '',
    buildDataBundleLiteral(),
    '',
    buildEngineBundle(),
    '',
    buildUiBundle(),
    '})();'
  ].join('\n');
}

function buildHtml() {
  var template = read('index.html');
  var css = read('web-ui/styles.css').trim();

  var html = template
    .replace('<title>転生者観測日誌（開発版）</title>', '<title>転生者観測日誌</title>')
    .replace(
      '<meta name="description" content="異世界へ送り込んだ転生者の人生を観測する放置型ブラウザゲーム（開発版UI）。">',
      '<meta name="description" content="異世界へ送り込んだ転生者の人生を観測する放置型ブラウザゲーム。性格・特殊要素・生涯目標・人生アークに基づき転生者が自律的に人生を歩む様子をログで追体験できます。">'
    )
    .replace('<link rel="stylesheet" href="./web-ui/styles.css">', '<style>\n' + css + '\n</style>')
    .replace('<script type="module" src="./web-ui/main.js"></script>', '<script>\n' + buildScript() + '\n</script>');

  var metaHeader = '<!--\nname: 転生者観測日誌\nversion: 1.1\ntype: single-html-app\nstatus: stable\n-->\n';
  html = html.replace('<!doctype html>\n', '<!doctype html>\n' + metaHeader);

  return html;
}

var outPath = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'tensei-life-watch.html');
writeFileSync(outPath, buildHtml());
console.log('built: ' + outPath);

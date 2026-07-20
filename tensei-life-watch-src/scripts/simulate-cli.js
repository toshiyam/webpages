#!/usr/bin/env node
// UIを介さないバランス検証CLI。
// 使い方: node scripts/simulate-cli.js [試行回数(既定300)]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDataBundle, runBatchSimulation } from '../game-engine/index.js';

var __dirname = dirname(fileURLToPath(import.meta.url));
var dataDir = join(__dirname, '..', 'game-data');

function loadJson(name) {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
}

var traits = loadJson('traits.json');
var occupations = loadJson('occupations.json');
var world = loadJson('world.json');
var events = loadJson('events.json');
var elements = loadJson('elements.json');
var goals = loadJson('goals.json');
var data = buildDataBundle(traits, occupations, world, events, elements, goals);

var trials = parseInt(process.argv[2], 10) || 300;
var stats = runBatchSimulation(data, trials);

function fmtCounts(labelMap, counts) {
  return Object.keys(counts)
    .sort(function (a, b) { return counts[b] - counts[a]; })
    .map(function (k) { return (labelMap[k] || k) + ' ' + counts[k]; })
    .join(' / ');
}
function pct(v) { return Math.round(v * 100) + '%'; }

var rankLabels = { legendary: '伝説', disaster: '災厄', peaceful: '平穏', notable: '著名', ordinary: '平凡' };

console.log('試行回数: ' + stats.trials);
console.log('平均寿命: ' + stats.avgLifespan.toFixed(1) + '歳');
console.log('結婚率: ' + pct(stats.marriageRate));
console.log('最終職業分布: ' + fmtCounts(data.occupations, stats.occupationCounts));
console.log('死因分布: ' + fmtCounts(data.deathCauseLabels, stats.causeCounts));
console.log('未発生イベント: ' + (stats.unfiredEvents.length ? stats.unfiredEvents.join(', ') : 'なし'));
console.log('--- issue#3 バランス目安 ---');
console.log('生涯目標の形成率: ' + pct(stats.goalFormationRate) + '（目安90%以上）');
console.log('目標の決着率(形成した中で): ' + pct(stats.goalResolutionRate));
console.log('人生アークへの突入率: ' + pct(stats.arcEntryRate) + '（目安70%以上）');
console.log('アーク最終段への到達率: ' + pct(stats.arcClimaxRate) + '（目安35%以上）');
console.log('世界へ影響を残した率: ' + pct(stats.worldImpactRate) + '（目安30%以上）');
console.log('ほぼ何も起きない人生: ' + pct(stats.nothingHappenedRate) + '（目安10%未満）');
console.log('人生ランク分布: ' + fmtCounts(rankLabels, stats.rankCounts) +
  '（伝説+災厄の目安5〜10%、平穏+著名の目安20〜40%）');

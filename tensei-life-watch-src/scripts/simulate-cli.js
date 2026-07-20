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
var data = buildDataBundle(traits, occupations, world, events);

var trials = parseInt(process.argv[2], 10) || 300;
var stats = runBatchSimulation(data, trials);

function fmtCounts(labelMap, counts) {
  return Object.keys(counts)
    .sort(function (a, b) { return counts[b] - counts[a]; })
    .map(function (k) { return (labelMap[k] || k) + ' ' + counts[k]; })
    .join(' / ');
}

console.log('試行回数: ' + stats.trials);
console.log('平均寿命: ' + stats.avgLifespan.toFixed(1) + '歳');
console.log('結婚率: ' + Math.round(stats.marriageRate * 100) + '%');
console.log('最終職業分布: ' + fmtCounts(data.occupations, stats.occupationCounts));
console.log('死因分布: ' + fmtCounts(data.deathCauseLabels, stats.causeCounts));
console.log('未発生イベント: ' + (stats.unfiredEvents.length ? stats.unfiredEvents.join(', ') : 'なし'));

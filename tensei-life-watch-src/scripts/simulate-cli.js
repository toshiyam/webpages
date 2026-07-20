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
var goalLabels = {};
data.goals.forEach(function (g) { goalLabels[g.id] = g.label; });

console.log('試行回数: ' + stats.trials);
console.log('平均寿命: ' + stats.avgLifespan.toFixed(1) + '歳');
console.log('結婚率: ' + pct(stats.marriageRate));
console.log('最終職業分布: ' + fmtCounts(data.occupations, stats.occupationCounts));
console.log('死因分布: ' + fmtCounts(data.deathCauseLabels, stats.causeCounts));
console.log('未発生イベント: ' + (stats.unfiredEvents.length ? stats.unfiredEvents.join(', ') : 'なし'));

console.log('\n--- issue#3 バランス目安 ---');
console.log('人生アークへの突入率: ' + pct(stats.arcEntryRate) + '（目安70%以上）');
console.log('アーク最終段への到達率: ' + pct(stats.arcClimaxRate) + '（目安35%以上）');
console.log('ほぼ何も起きない人生: ' + pct(stats.nothingHappenedRate) + '（目安10%未満）');
console.log('人生ランク分布: ' + fmtCounts(rankLabels, stats.rankCounts) +
  '（伝説+災厄の目安5〜10%、平穏+著名の目安20〜40%）');

console.log('\n--- issue#5 目標別統計 ---');
Object.keys(stats.goalStats).sort().forEach(function (id) {
  var g = stats.goalStats[id];
  console.log(
    (goalLabels[id] || id) + ': 形成' + g.formed +
    ' 完遂' + g.completed + ' 失敗' + g.failed + ' 放棄' + g.abandoned + ' 変質' + g.distorted +
    ' 未決着' + g.unresolved + '（うち到達不能' + g.unreachableWhileActive + '）' +
    ' 平均進捗' + g.avgProgress.toFixed(0)
  );
});

console.log('\n--- issue#5 世界影響統計（自然ドリフト除外） ---');
console.log('世界へ影響を残した率: ' + pct(stats.worldImpactStats.rate) + '（目安30%以上）');
console.log('正の影響が大きかった人数: ' + stats.worldImpactStats.positiveCount + ' / 負: ' + stats.worldImpactStats.negativeCount);
console.log('項目別平均寄与: ' + Object.keys(stats.worldImpactStats.perFieldAvgContribution)
  .map(function (k) { return k + ' ' + stats.worldImpactStats.perFieldAvgContribution[k].toFixed(2); })
  .join(' / '));

console.log('\n--- issue#5 整合性検証 ---');
console.log('自己テスト: ' + stats.consistency.selfTests.filter(function (t) { return t.passed; }).length + '/' + stats.consistency.selfTests.length + ' PASS' +
  (stats.consistency.selfTestsAllPassed ? '' : '  !! FAILED: ' + stats.consistency.selfTests.filter(function (t) { return !t.passed; }).map(function (t) { return t.name; }).join(', ')));
console.log('静的チェック - traitWeights内の能力IDキー: ' + stats.consistency.staticChecks.abilityKeysInTraitWeights.length + '件');
console.log('静的チェック - ids未指定のgoalResolution: ' + stats.consistency.staticChecks.goalResolutionWithoutIds.length + '件');
console.log('人生ごとの検証 - 進捗100%未満で完遂した人生: ' + stats.consistency.goalProgressViolations.length + '件');
console.log('合計整合性違反件数: ' + stats.consistency.totalViolationCount + '件' + (stats.consistency.totalViolationCount === 0 ? '（OK）' : '  !! 要修正'));
if (Object.keys(stats.consistency.unreachableGoalResolution).length > 0) {
  console.log('参考: 決着イベントに一度も到達できなかった目標（未決着のうち）: ' +
    Object.keys(stats.consistency.unreachableGoalResolution)
      .map(function (id) { return (goalLabels[id] || id) + ' ' + stats.consistency.unreachableGoalResolution[id] + '件'; })
      .join(' / '));
}

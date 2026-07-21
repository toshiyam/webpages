#!/usr/bin/env node
// UIを介さないバランス検証CLI。
// 使い方: node scripts/simulate-cli.js [試行回数(既定300)]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDataBundle, runBatchSimulation, runGrantComparisonTrial, runDiscoveryConsistencyCheck } from '../game-engine/index.js';

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
var items = loadJson('items.json');
var skills = loadJson('skills.json');
var burdens = loadJson('burdens.json');
var data = buildDataBundle(traits, occupations, world, events, elements, goals, items, skills, burdens);

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
var itemLabels = {};
data.items.forEach(function (i) { itemLabels[i.id] = i.label; });
var skillLabels = {};
data.skills.forEach(function (s) { skillLabels[s.id] = s.label; });
var burdenLabels = {};
data.burdens.forEach(function (b) { burdenLabels[b.id] = b.label; });

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

console.log('\n--- issue#7 転生準備(アイテム/スキル/制約)統計 ---');
console.log('何も持たずに転生した率: ' + pct(stats.grantStats.noGrantRate));
console.log('[アイテム] 選択数/使用数(使用率)/平均寿命');
Object.keys(stats.grantStats.items).sort().forEach(function (id) {
  var s = stats.grantStats.items[id];
  var usageRate = s.selected > 0 ? Math.round((s.used / s.selected) * 100) : 0;
  console.log('  ' + (itemLabels[id] || id) + ': ' + s.selected + '/' + s.used + '(' + usageRate + '%)/' + s.avgLifespan.toFixed(1) + '歳');
});
console.log('[スキル] 選択数/平均寿命');
Object.keys(stats.grantStats.skills).sort().forEach(function (id) {
  var s = stats.grantStats.skills[id];
  console.log('  ' + (skillLabels[id] || id) + ': ' + s.selected + '/' + s.avgLifespan.toFixed(1) + '歳');
});
console.log('[制約] 選択数/平均寿命');
Object.keys(stats.grantStats.burdens).sort().forEach(function (id) {
  var s = stats.grantStats.burdens[id];
  console.log('  ' + (burdenLabels[id] || id) + ': ' + s.selected + '/' + s.avgLifespan.toFixed(1) + '歳');
});

console.log('\n--- issue#5/#7 整合性検証 ---');
console.log('自己テスト: ' + stats.consistency.selfTests.filter(function (t) { return t.passed; }).length + '/' + stats.consistency.selfTests.length + ' PASS' +
  (stats.consistency.selfTestsAllPassed ? '' : '  !! FAILED: ' + stats.consistency.selfTests.filter(function (t) { return !t.passed; }).map(function (t) { return t.name; }).join(', ')));
console.log('静的チェック - traitWeights内の能力IDキー: ' + stats.consistency.staticChecks.abilityKeysInTraitWeights.length + '件');
console.log('静的チェック - ids未指定のgoalResolution: ' + stats.consistency.staticChecks.goalResolutionWithoutIds.length + '件');
console.log('静的チェック - endLife未対応の不老不死completed: ' + stats.consistency.staticChecks.immortalGoalWithoutEndLife.length + '件');
console.log('静的チェック - 常時解禁の選択肢を持たないイベント: ' + stats.consistency.staticChecks.eventsWithoutUnconditionalChoice.length + '件');
console.log('人生ごとの検証 - 進捗100%未満で完遂した人生: ' + stats.consistency.goalProgressViolations.length + '件');
console.log('人生ごとの検証 - 接触したのにitemOutcomeがunusedのまま/状態はあるが年齢が無い: ' + stats.consistency.itemOutcomeViolations.length + '件');
console.log('人生ごとの検証 - 不老不死達成後に通常死亡/未達成なのに不老不死終了: ' + stats.consistency.immortalityViolations.length + '件');
console.log('人生ごとの検証 - 暦(yearEra)の巻き戻り/非整数/非有限: ' + stats.consistency.yearRollbackCount + '件');
console.log('合計整合性違反件数: ' + stats.consistency.totalViolationCount + '件' + (stats.consistency.totalViolationCount === 0 ? '（OK）' : '  !! 要修正'));

console.log('\n--- issue#7 同一候補・付与内容だけを変えた比較試験（各50試行） ---');
var comparisonTargets = [
  { label: '封印された指輪(なし)', grants: { itemId: 'none', burdenId: 'cursed_fate' } },
  { label: '封印された指輪(あり)', grants: { itemId: 'sealed_ring', burdenId: 'cursed_fate' } },
  { label: '家族写真(なし)', grants: { itemId: 'none' } },
  { label: '家族写真(あり)', grants: { itemId: 'family_photo' } }
];
var comparison = runGrantComparisonTrial(data, comparisonTargets, 50);
console.log('候補: ' + comparison.templateName);
Object.keys(comparison.variants).forEach(function (label) {
  var v = comparison.variants[label];
  console.log('  ' + label + ': アーク到達率' + pct(v.arcClimaxRate) + ' 平均寿命' + v.avgLifespan.toFixed(1) + '歳' +
    (v.arcClimaxRate > 0.8 ? '  !! 80%超過' : ''));
});

console.log('\n--- issue#9 転生記録図鑑・段階解禁の巻き戻り検証（100人生連続） ---');
var discoveryCheck = runDiscoveryConsistencyCheck(data, 100);
console.log('解禁状態が巻き戻った回数: ' + discoveryCheck.unlockRollbackCount + '件');
console.log('発見カウントが減少した回数: ' + discoveryCheck.discoveryCountRollbackCount + '件');
var unlockedItemIds = Object.keys(discoveryCheck.finalUnlocked).filter(function (k) {
  return k.indexOf('item:') === 0 && discoveryCheck.finalUnlocked[k];
}).map(function (k) { return k.slice(5); });
console.log('100人生後に解禁済みのアイテム: ' + unlockedItemIds.join(', '));

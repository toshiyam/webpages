import { generateCharacter, cloneCharacterTemplate } from './character-generator.js';
import { applyStartingGrants, isItemSelectable } from './starting-grants.js';
import { simulateYear } from './time-processor.js';
import { determineLifeRank, hasEnteredAnyArc, hasReachedArcClimax, hadNothingHappen } from './life-rank.js';
import { buildContextSet, filterEligibleEvents } from './event-selector.js';
import { findGoalProgressViolation, runStaticConsistencyChecks, runGoalResolutionSelfTests, findItemOutcomeViolation, runItemOutcomeSelfTests, findImmortalityViolation, runWorldYearDriftSelfTests, runDiscoveryUnlockSelfTests, runEndLifeSelfTests } from './consistency.js';
import { freshDiscoveries, recordLifeDiscoveries, isItemUnlocked, isSkillUnlocked, isBurdenUnlocked } from './discovery.js';
import { pick } from './rng.js';

var MAX_LIFE_YEARS = 130;
var NONE_GRANT_CHANCE = 0.5;

// 各イベントが、どの生涯目標を決着させ得るか（goalResolution.ids）のマップを作る。
// 「目標形成後に対応イベントが一度も候補にならない目標」を検出するのに使う。
function buildGoalResolutionEventMap(events) {
  var map = {}; // goalId -> [eventId, ...]
  events.forEach(function (evt) {
    (evt.choices || []).forEach(function (choice) {
      var gr = choice.effects && choice.effects.goalResolution;
      if (!gr || !Array.isArray(gr.ids)) return;
      gr.ids.forEach(function (goalId) {
        if (!map[goalId]) map[goalId] = [];
        if (map[goalId].indexOf(evt.id) === -1) map[goalId].push(evt.id);
      });
    });
  });
  return map;
}

// バッチ検証のためだけに、多様なプレイヤーの選び方を模して転生準備の
// 付与内容をランダムに決める（実際のゲームでは常にプレイヤーの選択）。
// 各カテゴリとも約半数は「なし」を選ぶという想定で確率を単純化している。
function pickRandomGrants(data) {
  var burdenId = Math.random() < NONE_GRANT_CHANCE ? null : pick(data.burdens).id;
  var itemCandidates = (data.items || []).filter(function (i) { return isItemSelectable(i, burdenId); });
  var itemId = (itemCandidates.length > 0 && Math.random() >= NONE_GRANT_CHANCE) ? pick(itemCandidates).id : null;
  var skillId = (data.skills && data.skills.length > 0 && Math.random() >= NONE_GRANT_CHANCE) ? pick(data.skills).id : null;
  return { itemId: itemId, skillId: skillId, burdenId: burdenId };
}

// 1人の人生を、誕生から死亡まで最後まで実行する（DOM非依存の共通ループ）。
// character はあらかじめ生成・転生準備適用済みのものを渡す。
function runLife(character, data, goalResolutionEventMap) {
  var relations = [];
  var world = Object.assign({}, data.initialWorld);
  var gameState = { character: character, relations: relations, world: world };
  var eventCounts = {};
  var married = false;
  var deathInfo = null;
  var eligibleEverSeen = {};
  var yearRollbackCount = 0;

  for (var i = 0; i < MAX_LIFE_YEARS; i++) {
    if (goalResolutionEventMap && character.goal && character.goal.status === 'active') {
      var ctx = buildContextSet(character, relations, world, data.worldFlagThresholds);
      filterEligibleEvents(data.events, character, ctx, world.yearEra).forEach(function (evt) {
        eligibleEverSeen[evt.id] = true;
      });
    }

    var yearBefore = world.yearEra;
    var result = simulateYear(gameState, data);
    // 暦(world.yearEra)は共有世界の通算年であり、1年ごとに厳密に+1され、
    // 巻き戻り・NaN・小数化のいずれも起きてはならない（issue #11）。
    if (!Number.isInteger(world.yearEra) || !Number.isFinite(world.yearEra) || world.yearEra <= yearBefore) {
      yearRollbackCount += 1;
    }
    result.logs.forEach(function (l) { eventCounts[l.eventId] = (eventCounts[l.eventId] || 0) + 1; });
    if (character.flags.indexOf('married') >= 0) married = true;
    if (result.died) { deathInfo = result.deathInfo; break; }
  }

  var worldImpact = Object.keys(character.worldImpact).some(function (key) {
    return Math.abs(character.worldImpact[key]) >= 12;
  });

  var goalResolutionReachable = null;
  if (goalResolutionEventMap && character.goal) {
    var resolverIds = goalResolutionEventMap[character.goal.id] || [];
    goalResolutionReachable = resolverIds.some(function (id) { return eligibleEverSeen[id]; });
  }

  var itemUsed = character.startingItem
    ? (character.itemFirstUsedAge[character.startingItem] !== undefined)
    : null;

  return {
    lifespan: character.age,
    occupation: character.occupation,
    cause: deathInfo ? deathInfo.cause : 'aging',
    married: married,
    tags: character.tags.slice(),
    goal: character.goal ? {
      id: character.goal.id, status: character.goal.status, progress: character.goal.progress,
      reachable: goalResolutionReachable
    } : null,
    enteredArc: hasEnteredAnyArc(character),
    reachedArcClimax: hasReachedArcClimax(character),
    lifeRank: determineLifeRank(character),
    worldImpact: worldImpact,
    worldImpactByField: character.worldImpact,
    nothingHappened: hadNothingHappen(character),
    goalProgressViolation: findGoalProgressViolation(character),
    itemOutcomeViolation: findItemOutcomeViolation(character),
    immortalityViolation: findImmortalityViolation(character, deathInfo),
    yearRollbackCount: yearRollbackCount,
    startingItem: character.startingItem,
    startingSkill: character.startingSkill,
    burden: character.burden,
    itemUsed: itemUsed,
    eventCounts: eventCounts
  };
}

// UIを介さず、同じゲームエンジンで1人の人生を最後まで実行する。
// ブラウザの高速シミュレーションパネルと Node の CLI (scripts/simulate-cli.js) の両方から使われる。
// goalResolutionEventMap を渡すと、生涯目標の決着イベントが一度でも候補に
// なったかどうか（到達可能性）も追跡する。
// grants を省略すると、バランス検証のために付与内容をランダムに決める。
export function simulateOneLife(data, goalResolutionEventMap, grants) {
  var character = generateCharacter(data);
  applyStartingGrants(character, data, grants || pickRandomGrants(data));
  return runLife(character, data, goalResolutionEventMap);
}

var WORLD_FIELDS = ['stability', 'warThreat', 'demonThreat', 'religiousInfluence', 'techLevel', 'economy'];

// バランス検証: 複数人生を高速実行し、平均寿命・職業到達率・死因分布・結婚率・
// 目標別統計・人生アーク突入率／到達率・世界影響統計・人生ランク分布・
// 転生準備(アイテム/スキル/制約)別統計・整合性違反・各イベントの発生回数
// （=未発生イベントの検出にも使える）を集計する。
export function runBatchSimulation(data, n) {
  var goalResolutionEventMap = buildGoalResolutionEventMap(data.events);
  var results = [];
  for (var i = 0; i < n; i++) results.push(simulateOneLife(data, goalResolutionEventMap));

  var lifespans = results.map(function (r) { return r.lifespan; });
  var avgLifespan = lifespans.reduce(function (a, b) { return a + b; }, 0) / results.length;

  var occupationCounts = {};
  var causeCounts = {};
  var eventTotals = {};
  var rankCounts = {};
  var marriedCount = 0;
  var arcEnteredCount = 0;
  var arcClimaxCount = 0;
  var worldImpactCount = 0;
  var nothingHappenedCount = 0;

  // 目標別統計: 形成数/完遂数/失敗数/放棄数/変質数/未決着数/平均進捗/到達不能だった数
  var goalStats = {};
  function goalBucket(id) {
    if (!goalStats[id]) {
      goalStats[id] = { formed: 0, completed: 0, failed: 0, abandoned: 0, distorted: 0, unresolved: 0, progressTotal: 0, unreachableWhileActive: 0 };
    }
    return goalStats[id];
  }

  // 転生準備別統計: 選択率・(アイテムのみ)使用率・平均寿命・人生ランク分布
  var itemStats = {};
  function itemBucket(id) {
    if (!itemStats[id]) itemStats[id] = { selected: 0, used: 0, lifespanTotal: 0, rankCounts: {} };
    return itemStats[id];
  }
  var skillStats = {};
  function skillBucket(id) {
    if (!skillStats[id]) skillStats[id] = { selected: 0, lifespanTotal: 0, rankCounts: {} };
    return skillStats[id];
  }
  var burdenStats = {};
  function burdenBucket(id) {
    if (!burdenStats[id]) burdenStats[id] = { selected: 0, lifespanTotal: 0, rankCounts: {} };
    return burdenStats[id];
  }
  var noGrantCount = 0;

  // 世界影響統計: 項目別の平均寄与（自然ドリフトは含まない。character.worldImpact のみ）と正負の人数
  var worldFieldTotals = {};
  WORLD_FIELDS.forEach(function (f) { worldFieldTotals[f] = 0; });
  var positiveImpactCount = 0, negativeImpactCount = 0;

  var goalProgressViolations = [];
  var itemOutcomeViolations = [];
  var immortalityViolations = [];
  var yearRollbackCount = 0;

  results.forEach(function (r) {
    occupationCounts[r.occupation] = (occupationCounts[r.occupation] || 0) + 1;
    causeCounts[r.cause] = (causeCounts[r.cause] || 0) + 1;
    rankCounts[r.lifeRank] = (rankCounts[r.lifeRank] || 0) + 1;
    if (r.married) marriedCount += 1;
    if (r.enteredArc) arcEnteredCount += 1;
    if (r.reachedArcClimax) arcClimaxCount += 1;
    if (r.worldImpact) worldImpactCount += 1;
    if (r.nothingHappened) nothingHappenedCount += 1;
    if (r.goalProgressViolation) goalProgressViolations.push(r.goalProgressViolation);
    if (r.itemOutcomeViolation) itemOutcomeViolations.push(r.itemOutcomeViolation);
    if (r.immortalityViolation) immortalityViolations.push(r.immortalityViolation);
    yearRollbackCount += r.yearRollbackCount || 0;
    if (!r.startingItem && !r.startingSkill && !r.burden) noGrantCount += 1;

    if (r.startingItem) {
      var ib = itemBucket(r.startingItem);
      ib.selected += 1;
      ib.lifespanTotal += r.lifespan;
      ib.rankCounts[r.lifeRank] = (ib.rankCounts[r.lifeRank] || 0) + 1;
      if (r.itemUsed) ib.used += 1;
    }
    if (r.startingSkill) {
      var sb = skillBucket(r.startingSkill);
      sb.selected += 1;
      sb.lifespanTotal += r.lifespan;
      sb.rankCounts[r.lifeRank] = (sb.rankCounts[r.lifeRank] || 0) + 1;
    }
    if (r.burden) {
      var bb = burdenBucket(r.burden);
      bb.selected += 1;
      bb.lifespanTotal += r.lifespan;
      bb.rankCounts[r.lifeRank] = (bb.rankCounts[r.lifeRank] || 0) + 1;
    }

    if (r.goal) {
      var bucket = goalBucket(r.goal.id);
      bucket.formed += 1;
      bucket.progressTotal += r.goal.progress;
      if (r.goal.status === 'active') {
        bucket.unresolved += 1;
        if (r.goal.reachable === false) bucket.unreachableWhileActive += 1;
      } else if (bucket[r.goal.status] !== undefined) {
        bucket[r.goal.status] += 1;
      }
    }

    var fieldSum = 0;
    WORLD_FIELDS.forEach(function (f) {
      var v = r.worldImpactByField[f] || 0;
      worldFieldTotals[f] += v;
      fieldSum += v;
    });
    if (fieldSum >= 12) positiveImpactCount += 1;
    else if (fieldSum <= -12) negativeImpactCount += 1;

    Object.keys(r.eventCounts).forEach(function (id) {
      eventTotals[id] = (eventTotals[id] || 0) + r.eventCounts[id];
    });
  });

  Object.keys(goalStats).forEach(function (id) {
    var b = goalStats[id];
    b.avgProgress = b.formed > 0 ? b.progressTotal / b.formed : 0;
    delete b.progressTotal;
  });
  [itemStats, skillStats, burdenStats].forEach(function (statMap) {
    Object.keys(statMap).forEach(function (id) {
      var b = statMap[id];
      b.avgLifespan = b.selected > 0 ? b.lifespanTotal / b.selected : 0;
      delete b.lifespanTotal;
    });
  });

  var worldFieldAvg = {};
  WORLD_FIELDS.forEach(function (f) { worldFieldAvg[f] = worldFieldTotals[f] / n; });

  var firedEventIds = Object.keys(eventTotals);
  var unfiredEvents = data.events
    .map(function (e) { return e.id; })
    .filter(function (id) { return firedEventIds.indexOf(id) === -1; });

  var staticChecks = runStaticConsistencyChecks(data.events);
  var selfTests = runGoalResolutionSelfTests().concat(runItemOutcomeSelfTests()).concat(runWorldYearDriftSelfTests()).concat(runDiscoveryUnlockSelfTests()).concat(runEndLifeSelfTests());

  var unreachableGoalResolution = {};
  Object.keys(goalStats).forEach(function (id) {
    if (goalStats[id].unreachableWhileActive > 0) unreachableGoalResolution[id] = goalStats[id].unreachableWhileActive;
  });

  return {
    trials: n,
    avgLifespan: avgLifespan,
    marriageRate: marriedCount / n,
    arcEntryRate: arcEnteredCount / n,
    arcClimaxRate: arcClimaxCount / n,
    worldImpactRate: worldImpactCount / n,
    nothingHappenedRate: nothingHappenedCount / n,
    rankCounts: rankCounts,
    occupationCounts: occupationCounts,
    causeCounts: causeCounts,
    eventTotals: eventTotals,
    unfiredEvents: unfiredEvents,
    goalStats: goalStats,
    grantStats: {
      noGrantRate: noGrantCount / n,
      items: itemStats,
      skills: skillStats,
      burdens: burdenStats
    },
    worldImpactStats: {
      rate: worldImpactCount / n,
      perFieldAvgContribution: worldFieldAvg,
      positiveCount: positiveImpactCount,
      negativeCount: negativeImpactCount
    },
    consistency: {
      selfTests: selfTests,
      selfTestsAllPassed: selfTests.every(function (t) { return t.passed; }),
      staticChecks: staticChecks,
      goalProgressViolations: goalProgressViolations,
      itemOutcomeViolations: itemOutcomeViolations,
      immortalityViolations: immortalityViolations,
      yearRollbackCount: yearRollbackCount,
      unreachableGoalResolution: unreachableGoalResolution,
      totalViolationCount:
        goalProgressViolations.length +
        itemOutcomeViolations.length +
        immortalityViolations.length +
        yearRollbackCount +
        staticChecks.abilityKeysInTraitWeights.length +
        staticChecks.goalResolutionWithoutIds.length +
        staticChecks.immortalGoalWithoutEndLife.length +
        staticChecks.eventsWithoutUnconditionalChoice.length +
        selfTests.filter(function (t) { return !t.passed; }).length
    }
  };
}

// 「同一候補・付与内容だけ変える」比較試験。能力・性格・特殊要素が全く同じ
// 候補者テンプレートを1体だけ用意し、各付与パターンごとに独立した乱数で
// trialsPerVariant 回ずつ人生を再生する。付与内容以外の初期条件を完全に
// 固定した上での統計比較になるため、「単一の付与要素だけで特定のアーク
// 到達率が異常に高くなっていないか」の検証に使う。
export function runGrantComparisonTrial(data, grantVariants, trialsPerVariant) {
  var goalResolutionEventMap = buildGoalResolutionEventMap(data.events);
  var template = generateCharacter(data);
  var report = {};

  grantVariants.forEach(function (variant) {
    var arcClimaxCount = 0;
    var lifespanTotal = 0;
    var rankCounts = {};

    for (var i = 0; i < trialsPerVariant; i++) {
      var character = cloneCharacterTemplate(template);
      applyStartingGrants(character, data, variant.grants || {});
      var r = runLife(character, data, goalResolutionEventMap);
      if (r.reachedArcClimax) arcClimaxCount += 1;
      lifespanTotal += r.lifespan;
      rankCounts[r.lifeRank] = (rankCounts[r.lifeRank] || 0) + 1;
    }

    report[variant.label] = {
      trials: trialsPerVariant,
      arcClimaxRate: arcClimaxCount / trialsPerVariant,
      avgLifespan: lifespanTotal / trialsPerVariant,
      rankCounts: rankCounts
    };
  });

  return { templateName: template.name, variants: report };
}

// 転生記録図鑑の発見状況・転生準備項目の段階解禁（issue #9）が、生涯を
// またいで正しく蓄積し続け、一度解禁された項目が後の人生で再び未解禁へ
// 戻らない（＝解禁の巻き戻りが起きない）ことを、discoveries を共有する
// n回連続の人生で検証する。バッチ検証のrunBatchSimulationとは異なり、
// 各人生が独立した世界からやり直すのではなく、同一プレイヤーが同一
// セーブデータで転生を繰り返す状況を模する。
export function runDiscoveryConsistencyCheck(data, n) {
  var goalResolutionEventMap = buildGoalResolutionEventMap(data.events);
  var discoveries = freshDiscoveries();

  function unlockSnapshot() {
    var snap = {};
    (data.items || []).forEach(function (i) { snap['item:' + i.id] = isItemUnlocked(i, discoveries); });
    (data.skills || []).forEach(function (s) { snap['skill:' + s.id] = isSkillUnlocked(s, discoveries); });
    (data.burdens || []).forEach(function (b) { snap['burden:' + b.id] = isBurdenUnlocked(b, discoveries); });
    return snap;
  }

  var previous = unlockSnapshot();
  var unlockRollbackCount = 0;
  var discoveryCountRollbackCount = 0;

  for (var i = 0; i < n; i++) {
    var character = generateCharacter(data);
    applyStartingGrants(character, data, pickRandomGrants(data), discoveries);
    var beforeCounts = JSON.parse(JSON.stringify(discoveries));
    var result = runLife(character, data, goalResolutionEventMap);
    recordLifeDiscoveries(discoveries, character, { cause: result.cause }, result.eventCounts);

    Object.keys(discoveries).forEach(function (category) {
      Object.keys(discoveries[category]).forEach(function (id) {
        var before = (beforeCounts[category] && beforeCounts[category][id]) || 0;
        if (discoveries[category][id] < before) discoveryCountRollbackCount += 1;
      });
    });

    var current = unlockSnapshot();
    Object.keys(current).forEach(function (key) {
      if (previous[key] === true && current[key] === false) unlockRollbackCount += 1;
    });
    previous = current;
  }

  return {
    trials: n,
    unlockRollbackCount: unlockRollbackCount,
    discoveryCountRollbackCount: discoveryCountRollbackCount,
    finalDiscoveries: discoveries,
    finalUnlocked: previous
  };
}

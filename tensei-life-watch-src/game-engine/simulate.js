import { generateCharacter } from './character-generator.js';
import { simulateYear } from './time-processor.js';
import { determineLifeRank, hasEnteredAnyArc, hasReachedArcClimax, hadNothingHappen } from './life-rank.js';
import { buildContextSet, filterEligibleEvents } from './event-selector.js';
import { findGoalProgressViolation, runStaticConsistencyChecks, runGoalResolutionSelfTests } from './consistency.js';

var MAX_LIFE_YEARS = 130;

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

// UIを介さず、同じゲームエンジンで1人の人生を最後まで実行する。
// ブラウザの高速シミュレーションパネルと Node の CLI (scripts/simulate-cli.js) の両方から使われる。
// goalResolutionEventMap を渡すと、生涯目標の決着イベントが一度でも候補に
// なったかどうか（到達可能性）も追跡する。
export function simulateOneLife(data, goalResolutionEventMap) {
  var character = generateCharacter(data);
  var relations = [];
  var world = Object.assign({}, data.initialWorld);
  var gameState = { character: character, relations: relations, world: world };
  var eventCounts = {};
  var married = false;
  var deathInfo = null;
  var eligibleEverSeen = {};

  for (var i = 0; i < MAX_LIFE_YEARS; i++) {
    if (goalResolutionEventMap && character.goal && character.goal.status === 'active') {
      var ctx = buildContextSet(character, relations, world, data.worldFlagThresholds);
      filterEligibleEvents(data.events, character, ctx, world.yearEra).forEach(function (evt) {
        eligibleEverSeen[evt.id] = true;
      });
    }

    var result = simulateYear(gameState, data);
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
    eventCounts: eventCounts
  };
}

var WORLD_FIELDS = ['stability', 'warThreat', 'demonThreat', 'religiousInfluence', 'techLevel', 'economy'];

// バランス検証: 複数人生を高速実行し、平均寿命・職業到達率・死因分布・結婚率・
// 目標別統計・人生アーク突入率／到達率・世界影響統計・人生ランク分布・
// 整合性違反・各イベントの発生回数（=未発生イベントの検出にも使える）を集計する。
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

  // 世界影響統計: 項目別の平均寄与（自然ドリフトは含まない。character.worldImpact のみ）と正負の人数
  var worldFieldTotals = {};
  WORLD_FIELDS.forEach(function (f) { worldFieldTotals[f] = 0; });
  var positiveImpactCount = 0, negativeImpactCount = 0;

  var goalProgressViolations = [];

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

  var worldFieldAvg = {};
  WORLD_FIELDS.forEach(function (f) { worldFieldAvg[f] = worldFieldTotals[f] / n; });

  var firedEventIds = Object.keys(eventTotals);
  var unfiredEvents = data.events
    .map(function (e) { return e.id; })
    .filter(function (id) { return firedEventIds.indexOf(id) === -1; });

  var staticChecks = runStaticConsistencyChecks(data.events);
  var selfTests = runGoalResolutionSelfTests();

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
      unreachableGoalResolution: unreachableGoalResolution,
      totalViolationCount:
        goalProgressViolations.length +
        staticChecks.abilityKeysInTraitWeights.length +
        staticChecks.goalResolutionWithoutIds.length +
        selfTests.filter(function (t) { return !t.passed; }).length
    }
  };
}

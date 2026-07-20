import { generateCharacter } from './character-generator.js';
import { simulateYear } from './time-processor.js';
import { determineLifeRank, hasEnteredAnyArc, hasReachedArcClimax, hadNothingHappen } from './life-rank.js';

var MAX_LIFE_YEARS = 130;

// 世界状態のうち「実際に転生者の行動で変動しうる」数値フィールドのみを世界影響の判定に使う。
// yearEra（暦年）は毎年必ず増えるため対象から除外する。
var WORLD_IMPACT_FIELDS = ['stability', 'warThreat', 'demonThreat', 'religiousInfluence', 'techLevel', 'economy'];

// UIを介さず、同じゲームエンジンで1人の人生を最後まで実行する。
// ブラウザの高速シミュレーションパネルと Node の CLI (scripts/simulate-cli.js) の両方から使われる。
export function simulateOneLife(data) {
  var character = generateCharacter(data);
  var relations = [];
  var world = Object.assign({}, data.initialWorld);
  var gameState = { character: character, relations: relations, world: world };
  var eventCounts = {};
  var married = false;
  var deathInfo = null;

  for (var i = 0; i < MAX_LIFE_YEARS; i++) {
    var result = simulateYear(gameState, data);
    result.logs.forEach(function (l) { eventCounts[l.eventId] = (eventCounts[l.eventId] || 0) + 1; });
    if (character.flags.indexOf('married') >= 0) married = true;
    if (result.died) { deathInfo = result.deathInfo; break; }
  }

  var worldImpact = false;
  WORLD_IMPACT_FIELDS.forEach(function (key) {
    if (typeof world[key] === 'number' && Math.abs(world[key] - data.initialWorld[key]) >= 12) worldImpact = true;
  });

  return {
    lifespan: character.age,
    occupation: character.occupation,
    cause: deathInfo ? deathInfo.cause : 'aging',
    married: married,
    tags: character.tags.slice(),
    hasGoal: !!character.goal,
    goalStatus: character.goal ? character.goal.status : null,
    enteredArc: hasEnteredAnyArc(character),
    reachedArcClimax: hasReachedArcClimax(character),
    lifeRank: determineLifeRank(character),
    worldImpact: worldImpact,
    nothingHappened: hadNothingHappen(character),
    eventCounts: eventCounts
  };
}

// バランス検証: 複数人生を高速実行し、平均寿命・職業到達率・死因分布・結婚率・
// 生涯目標形成率・アーク突入率／到達率・世界影響率・人生ランク分布・
// 各イベントの発生回数（=未発生イベントの検出にも使える）を集計する。
export function runBatchSimulation(data, n) {
  var results = [];
  for (var i = 0; i < n; i++) results.push(simulateOneLife(data));

  var lifespans = results.map(function (r) { return r.lifespan; });
  var avgLifespan = lifespans.reduce(function (a, b) { return a + b; }, 0) / results.length;

  var occupationCounts = {};
  var causeCounts = {};
  var eventTotals = {};
  var rankCounts = {};
  var marriedCount = 0;
  var goalCount = 0;
  var goalResolvedCount = 0;
  var arcEnteredCount = 0;
  var arcClimaxCount = 0;
  var worldImpactCount = 0;
  var nothingHappenedCount = 0;

  results.forEach(function (r) {
    occupationCounts[r.occupation] = (occupationCounts[r.occupation] || 0) + 1;
    causeCounts[r.cause] = (causeCounts[r.cause] || 0) + 1;
    rankCounts[r.lifeRank] = (rankCounts[r.lifeRank] || 0) + 1;
    if (r.married) marriedCount += 1;
    if (r.hasGoal) goalCount += 1;
    if (r.hasGoal && r.goalStatus !== 'active') goalResolvedCount += 1;
    if (r.enteredArc) arcEnteredCount += 1;
    if (r.reachedArcClimax) arcClimaxCount += 1;
    if (r.worldImpact) worldImpactCount += 1;
    if (r.nothingHappened) nothingHappenedCount += 1;
    Object.keys(r.eventCounts).forEach(function (id) {
      eventTotals[id] = (eventTotals[id] || 0) + r.eventCounts[id];
    });
  });

  var firedEventIds = Object.keys(eventTotals);
  var unfiredEvents = data.events
    .map(function (e) { return e.id; })
    .filter(function (id) { return firedEventIds.indexOf(id) === -1; });

  return {
    trials: n,
    avgLifespan: avgLifespan,
    marriageRate: marriedCount / n,
    goalFormationRate: goalCount / n,
    goalResolutionRate: goalCount > 0 ? goalResolvedCount / goalCount : 0,
    arcEntryRate: arcEnteredCount / n,
    arcClimaxRate: arcClimaxCount / n,
    worldImpactRate: worldImpactCount / n,
    nothingHappenedRate: nothingHappenedCount / n,
    rankCounts: rankCounts,
    occupationCounts: occupationCounts,
    causeCounts: causeCounts,
    eventTotals: eventTotals,
    unfiredEvents: unfiredEvents
  };
}

import { generateCharacter } from './character-generator.js';
import { simulateYear } from './time-processor.js';

var MAX_LIFE_YEARS = 130;

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

  return {
    lifespan: character.age,
    occupation: character.occupation,
    cause: deathInfo ? deathInfo.cause : 'aging',
    married: married,
    tags: character.tags.slice(),
    eventCounts: eventCounts
  };
}

// バランス検証: 複数人生を高速実行し、平均寿命・職業到達率・死因分布・結婚率・
// 各イベントの発生回数（=未発生イベントの検出にも使える）を集計する。
export function runBatchSimulation(data, n) {
  var results = [];
  for (var i = 0; i < n; i++) results.push(simulateOneLife(data));

  var lifespans = results.map(function (r) { return r.lifespan; });
  var avgLifespan = lifespans.reduce(function (a, b) { return a + b; }, 0) / results.length;

  var occupationCounts = {};
  var causeCounts = {};
  var eventTotals = {};
  var marriedCount = 0;

  results.forEach(function (r) {
    occupationCounts[r.occupation] = (occupationCounts[r.occupation] || 0) + 1;
    causeCounts[r.cause] = (causeCounts[r.cause] || 0) + 1;
    if (r.married) marriedCount += 1;
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
    occupationCounts: occupationCounts,
    causeCounts: causeCounts,
    eventTotals: eventTotals,
    unfiredEvents: unfiredEvents
  };
}

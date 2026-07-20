import { clamp, randInt, fillName } from './rng.js';
import { buildContextSet, pickEvent } from './event-selector.js';
import { pickChoice } from './decision-engine.js';
import { applyEffects } from './effect-processor.js';
import { mortalityChance, decideDeathCause } from './mortality.js';

// 世界状態を初期値へ緩やかに回帰させつつ小さなノイズを与える（暴走を防ぐ）。
function driftWorld(world, initialWorld, bounds) {
  var lo = (bounds && bounds.min) || 0;
  var hi = (bounds && bounds.max) || 100;
  Object.keys(initialWorld).forEach(function (key) {
    if (typeof world[key] !== 'number') return;
    var baseline = initialWorld[key];
    var pull = (baseline - world[key]) * 0.02;
    world[key] = clamp(world[key] + pull + randInt(-1, 1), lo, hi);
  });
}

// gameState: { character, relations, world }
// data: { events, occupationIncome, occupationRisk, namePool, deathCauseLabels,
//         initialWorld, worldFieldBounds, worldFlagThresholds }
// 1年分の時間経過（経済・健康の自然変動・世界状態の変動・イベント抽選・死亡判定）を処理し、
// { logs, died, deathInfo } を返す。DOMに依存しない純粋な状態遷移関数。
export function simulateYear(gameState, data) {
  var character = gameState.character, relations = gameState.relations, world = gameState.world;
  character.age += 1;
  world.yearEra += 1;

  var income = data.occupationIncome[character.occupation] || 1;
  var livingCost = 2 + Math.floor(character.age / 25);
  var netMoney = income + randInt(-1, 2) - livingCost;
  character.money = Math.max(0, character.money + netMoney);
  character.zeroMoneyStreak = character.money === 0 ? character.zeroMoneyStreak + 1 : 0;
  if (character.zeroMoneyStreak >= 3) character.health = clamp(character.health - 4, 0, 100);

  if (character.age > 55) {
    character.health = clamp(character.health - randInt(0, 2), 0, 100);
  } else {
    character.health = clamp(character.health + randInt(-1, 1), 0, 100);
    if (character.health < 90 && Math.random() < 0.35) character.health = clamp(character.health + 1, 0, 100);
  }

  relations.forEach(function (r) { r.affinity = clamp(r.affinity + randInt(-2, 2), -100, 100); });
  driftWorld(world, data.initialWorld, data.worldFieldBounds);

  var newLogs = [];
  var ctx = buildContextSet(character, relations, world, data.worldFlagThresholds);
  if (Math.random() < 0.78) {
    var evt = pickEvent(data.events, character, ctx, world.yearEra);
    if (evt) {
      var choice = pickChoice(evt, character, ctx);
      applyEffects(character, relations, world, data.worldFieldBounds, data.namePool, choice.effects);
      character.eventHistory[evt.id] = world.yearEra;
      if (evt.unique) character.firedUnique[evt.id] = true;
      var text = fillName(choice.resultText || evt.text, character.name);
      var importance = choice.importance || (evt.eventType === 'historic' ? 'historic' : (evt.eventType === 'branch' ? 'major' : 'minor'));
      newLogs.push({
        year: world.yearEra, age: character.age, eventId: evt.id, choiceId: choice.id,
        text: text, importance: importance
      });
    }
  }

  var died = false, deathInfo = null;
  if (character.health <= 0) died = true;
  else if (Math.random() < mortalityChance(character, data.occupationRisk)) died = true;

  if (died) {
    character.alive = false;
    var cause = decideDeathCause(character, data.occupationRisk);
    deathInfo = { cause: cause, age: character.age };
    newLogs.push({
      year: world.yearEra, age: character.age, eventId: 'death', choiceId: cause,
      text: character.name + 'は' + character.age + '歳で、' + data.deathCauseLabels[cause] + 'によりその生涯を閉じた。',
      importance: 'historic'
    });
  }

  return { logs: newLogs, died: died, deathInfo: deathInfo };
}

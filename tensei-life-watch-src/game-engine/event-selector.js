import { rand, weightedPick } from './rng.js';

function fieldPasses(value, rule) {
  if (typeof rule.gte === 'number' && value < rule.gte) return false;
  if (typeof rule.lte === 'number' && value > rule.lte) return false;
  return true;
}

// 性格フラグ・状況フラグ・世界状態由来のフラグ・現在の生涯目標を1つのコンテキスト集合にまとめる。
// イベントの requiredFlags / excludedFlags / choice.contextWeights から共通の語彙として参照される。
// 特殊要素は character.flags に 'element_<id>' として、生涯目標は 'goal_<id>' として
// 既に載っているため、新しい条件構文を増やさずに既存の仕組みだけで参照できる。
export function buildContextSet(character, relations, world, worldFlagThresholds) {
  var ctx = {};
  character.flags.forEach(function (f) { ctx[f] = true; });
  if (character.health < 40) ctx.low_health = true;
  if (character.money < 5) ctx.low_money = true;
  if (relations.length > 0) ctx.has_any_relation = true;
  if (relations.some(function (r) { return r.type === 'partner'; })) ctx.has_partner_rel = true;
  if (relations.some(function (r) { return r.type === 'spouse'; })) ctx.is_married = true;

  if (character.goal && character.goal.status === 'active') {
    ctx['goal_' + character.goal.id] = true;
  }

  if (world && worldFlagThresholds) {
    Object.keys(worldFlagThresholds).forEach(function (flagName) {
      var rule = worldFlagThresholds[flagName];
      var value = world[rule.field];
      if (typeof value === 'number' && fieldPasses(value, rule)) ctx[flagName] = true;
    });
  }

  return ctx;
}

export function eventEligible(evt, character, ctx, worldYear) {
  if (evt.ageRange && (character.age < evt.ageRange.min || character.age > evt.ageRange.max)) return false;
  if (evt.unique && character.firedUnique[evt.id]) return false;
  if (evt.minGapYears) {
    var last = character.eventHistory[evt.id];
    if (last !== undefined && (worldYear - last) < evt.minGapYears) return false;
  }
  var cond = evt.conditions;
  if (cond) {
    if (cond.occupations && cond.occupations.indexOf(character.occupation) === -1) return false;
    if (cond.requiredFlags && !cond.requiredFlags.every(function (f) { return ctx[f]; })) return false;
    if (cond.excludedFlags && cond.excludedFlags.some(function (f) { return ctx[f]; })) return false;
    if (cond.anyOfFlags && !cond.anyOfFlags.some(function (f) { return ctx[f]; })) return false;
    if (cond.minAbility) {
      for (var k in cond.minAbility) {
        if (character.abilities[k] < cond.minAbility[k]) return false;
      }
    }
  }
  return true;
}

export function filterEligibleEvents(events, character, ctx, worldYear) {
  return events.filter(function (evt) { return eventEligible(evt, character, ctx, worldYear); });
}

// evt.weightContextBonus は「このイベント自体が選ばれる頻度」への補正
// （choice.contextWeights が「選ばれた後、どの選択肢になるか」への補正なのに対し、
// こちらは「そもそもこのイベントが今年選ばれやすいか」を左右する）。
// 例: 魔物に狙われる制約を持つ転生者は、魔物襲撃イベント自体の発生頻度が上がる。
function eventSelectionWeight(evt, ctx) {
  var w = evt.baseWeight || 1;
  if (evt.weightContextBonus) {
    for (var k in evt.weightContextBonus) {
      if (ctx[k]) w += evt.weightContextBonus[k];
    }
  }
  return Math.max(0.1, w);
}

export function pickEvent(events, character, ctx, worldYear) {
  var eligible = filterEligibleEvents(events, character, ctx, worldYear);
  if (eligible.length === 0) return null;
  return weightedPick(eligible, function (evt) { return eventSelectionWeight(evt, ctx) + rand(0, 5); });
}

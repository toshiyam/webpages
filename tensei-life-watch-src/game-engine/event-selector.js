import { rand, weightedPick } from './rng.js';

// 性格フラグ・状況フラグ・低健康/低所持金などを1つのコンテキスト集合にまとめる。
// イベントの requiredFlags / excludedFlags / choice.contextWeights から共通の語彙として参照される。
export function buildContextSet(character, relations) {
  var ctx = {};
  character.flags.forEach(function (f) { ctx[f] = true; });
  if (character.health < 40) ctx.low_health = true;
  if (character.money < 5) ctx.low_money = true;
  if (relations.length > 0) ctx.has_any_relation = true;
  if (relations.some(function (r) { return r.type === 'partner'; })) ctx.has_partner_rel = true;
  if (relations.some(function (r) { return r.type === 'spouse'; })) ctx.is_married = true;
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
    if (cond.minAbility) {
      for (var k in cond.minAbility) {
        if (character.abilities[k] < cond.minAbility[k]) return false;
      }
    }
  }
  return true;
}

export function pickEvent(events, character, ctx, worldYear) {
  var eligible = events.filter(function (evt) { return eventEligible(evt, character, ctx, worldYear); });
  if (eligible.length === 0) return null;
  return weightedPick(eligible, function (evt) { return (evt.baseWeight || 1) + rand(0, 5); });
}

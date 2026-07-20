import { clamp, weightedPick } from './rng.js';

// occupationRisk: game-data/occupations.json の risk
export function mortalityChance(character, occupationRisk) {
  var age = character.age, base = 0.001;
  if (age >= 100) return 1;
  if (age >= 90) base = 0.35;
  else if (age >= 75) base = 0.11;
  else if (age >= 60) base = 0.035;
  else if (age >= 40) base = 0.008;
  if (character.health < 20) base += 0.22;
  else if (character.health < 40) base += 0.09;
  else if (character.health < 60) base += 0.02;
  var risk = occupationRisk[character.occupation];
  if (risk) base += risk * (character.flags.indexOf('dangerous_quest_taken') >= 0 ? 1.6 : 1);
  if (character.zeroMoneyStreak >= 4) base += 0.06;
  if (character.flags.indexOf('burden_short_lived') >= 0) base += 0.01;
  return clamp(base, 0, 1);
}

export function decideDeathCause(character, occupationRisk) {
  var weights = {
    aging: character.age >= 65 ? (character.age - 60) * 2 : 0.2,
    illness: character.health < 45 ? (45 - character.health) : 1,
    accident: occupationRisk[character.occupation] ? 14 : 3,
    battle: (character.occupation === 'soldier' || character.occupation === 'adventurer') && character.flags.indexOf('dangerous_quest_taken') >= 0 ? 16 : 1,
    crime: character.occupation === 'thief' ? 14 : 0.5,
    starvation: character.zeroMoneyStreak >= 4 ? 20 : 0.2
  };
  var keys = Object.keys(weights);
  return weightedPick(keys, function (k) { return Math.max(0.1, weights[k]); });
}

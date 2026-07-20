import { rand, weightedPick } from './rng.js';

// 選択スコア = 基礎重み + 性格補正 + 能力補正 + 状況補正 + 少量の乱数（仕様書の概念式に対応）。
// 性格は character.traits、能力は character.abilities からそれぞれ独立に参照する
// （traitWeights に willpower や social のような能力値キーを書いても、性格軸には
// 存在しないため黙って無視される。能力による補正をかけたい場合は abilityWeights を使う）。
// 0〜100値をそのまま係数に掛け合わせ、常に一貫した傾向を保ちつつ、
// 乱数によって完全な決定論にはしない。
export function scoreChoice(choice, character, ctx) {
  var score = choice.baseWeight || 1;
  if (choice.traitWeights) {
    for (var k in choice.traitWeights) {
      var traitVal = character.traits[k];
      if (traitVal === undefined) continue;
      score += choice.traitWeights[k] * traitVal;
    }
  }
  if (choice.abilityWeights) {
    for (var ak in choice.abilityWeights) {
      var abilityVal = character.abilities[ak];
      if (abilityVal === undefined) continue;
      score += choice.abilityWeights[ak] * abilityVal;
    }
  }
  if (choice.contextWeights) {
    for (var ck in choice.contextWeights) {
      if (ctx[ck]) score += choice.contextWeights[ck];
    }
  }
  score += rand(-6, 6);
  return Math.max(0.5, score);
}

export function pickChoice(evt, character, ctx) {
  return weightedPick(evt.choices, function (c) { return scoreChoice(c, character, ctx); });
}

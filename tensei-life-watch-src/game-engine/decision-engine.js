import { rand, weightedPick } from './rng.js';

// 選択スコア = 基礎重み + 性格補正 + 状況補正 + 少量の乱数（仕様書の概念式に対応）。
// 性格は0〜100値をそのまま traitWeights の係数に掛け合わせ、
// 常に一貫した傾向を保ちつつ、乱数によって完全な決定論にはしない。
export function scoreChoice(choice, character, ctx) {
  var score = choice.baseWeight || 1;
  if (choice.traitWeights) {
    for (var k in choice.traitWeights) {
      var traitVal = character.traits[k];
      if (traitVal === undefined) continue;
      score += choice.traitWeights[k] * traitVal;
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

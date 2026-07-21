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

// choice.requiredFlags / excludedFlags は「選択肢そのものを解禁/封印する」ための
// 必須条件（contextWeights とは異なり、満たさない場合はスコアに関わらず選ばれない）。
// 例えば「医療箱を使って人々を救う」という選択肢は、医療箱を持たない転生者には
// そもそも選べてはならない。contextWeights だけでは baseWeight 分の確率で
// 選ばれてしまうため、真に選択肢を解禁するにはこちらを使う。
export function isChoiceUnlocked(choice, ctx) {
  if (choice.requiredFlags && !choice.requiredFlags.every(function (f) { return ctx[f]; })) return false;
  if (choice.excludedFlags && choice.excludedFlags.some(function (f) { return ctx[f]; })) return false;
  return true;
}

export function unlockedChoices(evt, ctx) {
  return evt.choices.filter(function (c) { return isChoiceUnlocked(c, ctx); });
}

// 全選択肢が封印された場合に「封印を無視して全選択肢へ戻す」フォールバックは
// 過去に採用していたが、それ自体が将来の再発経路になる（issue #9の敵対的検証
// で指摘: 解禁条件付き選択肢しか持たないイベントを新設すると、非対象者でも
// 封印済み選択肢を選べてしまう）。そのため、封印を無視するフォールバックは
// 一切行わない。すべての通常イベントは
// consistency.js の findEventsWithoutUnconditionalChoice によって
// 「requiredFlags/excludedFlagsを持たない、常に選べる選択肢を最低1つ持つ」
// ことを静的に検証しており、対象イベントである限りここが null になることは
// 構造的に無い。万一データ不備でnullになった場合は、その年は何も選ばな
// かった（イベントが起きなかった）ものとして扱う（time-processor.js側）。
export function pickChoice(evt, character, ctx) {
  var candidates = unlockedChoices(evt, ctx);
  if (candidates.length === 0) return null;
  return weightedPick(candidates, function (c) { return scoreChoice(c, character, ctx); });
}

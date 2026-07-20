import { applyGoalFormation, applyGoalResolution } from './effect-processor.js';

var ABILITY_IDS = ['physical', 'intelligence', 'social', 'willpower', 'sensitivity', 'luck'];

// --- 自己テスト ---------------------------------------------------------
// 「対象外の目標を完遂扱いにした人生」「目標がないのに goalStatus が適用された
// イベント」は、applyGoalResolution の ids ガードによって実行時には構造的に
// 発生し得ない。1,000人生を乱数で回しても再現できない（起こらないことを
// 確かめようがない）性質のバグなので、境界条件を直接叩く自己テストとして
// 常に実行し、回帰があれば即座に失敗させる。
export function runGoalResolutionSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  check('対象外の目標は状態変更されない', function () {
    var character = { age: 30, goal: { id: 'protect_family', label: '家族を守る', status: 'active', progress: 40, resolvedAtAge: null } };
    applyGoalResolution(character, { ids: ['become_king'], status: 'completed' });
    return character.goal.status === 'active' && character.goal.progress === 40;
  });

  check('一致する目標は状態変更される', function () {
    var character = { age: 30, goal: { id: 'become_king', label: '王になる', status: 'active', progress: 40, resolvedAtAge: null } };
    applyGoalResolution(character, { ids: ['become_king'], status: 'completed' });
    return character.goal.status === 'completed';
  });

  check('目標が無ければ goalStatus は無視される', function () {
    var character = { age: 30, goal: null };
    applyGoalResolution(character, { ids: ['become_king'], status: 'completed' });
    return character.goal === null;
  });

  check('completed は progress を必ず100にする', function () {
    var character = { age: 30, goal: { id: 'unravel_magic', label: '魔法を解明する', status: 'active', progress: 10, resolvedAtAge: null } };
    applyGoalResolution(character, { ids: ['unravel_magic'], status: 'completed' });
    return character.goal.progress === 100;
  });

  check('failed は progress を上書きしない', function () {
    var character = { age: 30, goal: { id: 'unravel_magic', label: '魔法を解明する', status: 'active', progress: 55, resolvedAtAge: null } };
    applyGoalResolution(character, { ids: ['unravel_magic'], status: 'failed' });
    return character.goal.status === 'failed' && character.goal.progress === 55;
  });

  check('既に目標がある場合、新規形成は上書きしない', function () {
    var character = { age: 20, goal: { id: 'protect_family', label: '家族を守る', status: 'active', progress: 0, resolvedAtAge: null } };
    applyGoalFormation(character, { id: 'become_king', label: '王になる' });
    return character.goal.id === 'protect_family';
  });

  return results;
}

// --- 静的チェック（game-data/events.json 全体を1回だけ検証） -------------

// traitWeights に能力値のキー（性格軸ではないもの）が紛れていないかを確認する。
// character.traits に存在しないキーは黙って無視されるため、実行時エラーには
// ならないが意図した補正が効かなくなる。
export function findAbilityKeysInTraitWeights(events) {
  var violations = [];
  events.forEach(function (evt) {
    (evt.choices || []).forEach(function (choice) {
      var tw = choice.traitWeights;
      if (!tw) return;
      Object.keys(tw).forEach(function (k) {
        if (ABILITY_IDS.indexOf(k) >= 0) {
          violations.push({ eventId: evt.id, choiceId: choice.id, key: k });
        }
      });
    });
  });
  return violations;
}

// goalResolution に ids が無いと、意図せず「現在の目標が何であれ状態変更する」
// 挙動になってしまう（issue #5 問題1の再発経路）。ids必須を静的に強制する。
export function findGoalResolutionWithoutIds(events) {
  var violations = [];
  events.forEach(function (evt) {
    (evt.choices || []).forEach(function (choice) {
      var gr = choice.effects && choice.effects.goalResolution;
      if (gr && !Array.isArray(gr.ids)) {
        violations.push({ eventId: evt.id, choiceId: choice.id });
      }
    });
  });
  return violations;
}

export function runStaticConsistencyChecks(events) {
  return {
    abilityKeysInTraitWeights: findAbilityKeysInTraitWeights(events),
    goalResolutionWithoutIds: findGoalResolutionWithoutIds(events)
  };
}

// --- 人生ごとの整合性チェック --------------------------------------------

// 「状態=達成なのに進捗が100%未満」という、意味的に矛盾した最終状態が
// 生成されていないかを確認する（issue #5 で実際に検出されたバグそのもの）。
export function findGoalProgressViolation(character) {
  if (character.goal && character.goal.status === 'completed' && character.goal.progress !== 100) {
    return { goalId: character.goal.id, progress: character.goal.progress };
  }
  return null;
}

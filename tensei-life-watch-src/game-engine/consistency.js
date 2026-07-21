import { applyGoalFormation, applyGoalResolution } from './effect-processor.js';
import { setItemOutcome, consumeItem, recordContextualItemUse } from './starting-grants.js';

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

// 「行使した(used)」「使い切った(consumed)」「奪われた(lost)」「使わずに見送った
// (rejected)」を取り違えると、死亡時要約・観測画面で意味が逆転してしまう
// （issue #7 で実際に、指輪の封印維持や銀貨袋の喪失が「役立てた」と表示される
// バグとして検出された）。乱数シミュレーションでは特定の分岐（例: 封印を維持した
// 場合だけ）を狙って再現しづらいため、各状態遷移を直接叩く自己テストで守る。
export function runItemOutcomeSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  function freshCharacter(itemId) {
    return {
      age: 20, startingItem: itemId, flags: itemId ? ['item_' + itemId] : [],
      itemState: {}, itemFirstUsedAge: {}, itemOutcome: { status: 'unused', age: null }
    };
  }

  check('拒絶(rejected)は使用(used)扱いにならない', function () {
    var c = freshCharacter('sealed_ring');
    setItemOutcome(c, 'sealed_ring', 'rejected');
    return c.itemOutcome.status === 'rejected' && c.itemOutcome.age === 20;
  });

  check('喪失(lost)は使用(used)扱いにならない', function () {
    var c = freshCharacter('silver_purse');
    setItemOutcome(c, 'silver_purse', 'lost');
    return c.itemOutcome.status === 'lost';
  });

  check('自身が持たないアイテムへのsetItemOutcomeは無視される', function () {
    var c = freshCharacter('compass');
    setItemOutcome(c, 'sealed_ring', 'used');
    return c.itemOutcome.status === 'unused';
  });

  check('consumeItemは残量が尽きるまでusedを保つ', function () {
    var c = freshCharacter('medical_kit');
    c.itemState.medical_kit = { usesRemaining: 3, consumed: false };
    consumeItem(c, 'medical_kit');
    return c.itemOutcome.status === 'used' && c.itemState.medical_kit.usesRemaining === 2;
  });

  check('consumeItemは残量が尽きるとconsumedになる', function () {
    var c = freshCharacter('medical_kit');
    c.itemState.medical_kit = { usesRemaining: 1, consumed: false };
    consumeItem(c, 'medical_kit');
    return c.itemOutcome.status === 'consumed' && c.itemState.medical_kit.consumed === true;
  });

  check('recordContextualItemUseは選ばれた選択肢がcontextWeightsに自身のアイテムを持つ時だけusedにする', function () {
    var c = freshCharacter('compass');
    var ctx = { item_compass: true };
    recordContextualItemUse(c, { contextWeights: { item_family_photo: 8 } }, ctx);
    var untouched = c.itemOutcome.status === 'unused';
    recordContextualItemUse(c, { contextWeights: { item_compass: 6 } }, ctx);
    var touched = c.itemOutcome.status === 'used';
    return untouched && touched;
  });

  return results;
}

// 「アイテムに接触した(itemFirstUsedAgeが記録された)のにitemOutcome.statusが
// unusedのまま」（issue #7 で実際に検出された、間接効果アイテムが常に未使用扱い
// になるバグそのもの）と、「unused以外のstatusなのにageが記録されていない」を
// 1,000人生シミュレーションで確認する。
export function findItemOutcomeViolation(character) {
  if (!character.startingItem) return null;
  var outcome = character.itemOutcome || { status: 'unused', age: null };
  var touched = character.itemFirstUsedAge && character.itemFirstUsedAge[character.startingItem] !== undefined;
  if (touched && outcome.status === 'unused') {
    return { itemId: character.startingItem, issue: 'touched_but_unused_status' };
  }
  if (outcome.status !== 'unused' && outcome.age === null) {
    return { itemId: character.startingItem, issue: 'status_without_age' };
  }
  return null;
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

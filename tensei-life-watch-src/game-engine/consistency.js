import { applyGoalFormation, applyGoalResolution } from './effect-processor.js';
import { setItemOutcome, consumeItem, recordContextualItemUse } from './starting-grants.js';
import { driftWorld } from './time-processor.js';
import { isChoiceUnlocked } from './decision-engine.js';
import { freshDiscoveries, recordLifeDiscoveries, evaluateUnlockCondition, isItemUnlocked } from './discovery.js';

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

  check('不老不死を達成し、不老不死終了で死ねば矛盾なし', function () {
    var character = { goal: { id: 'become_immortal', status: 'completed' } };
    return findImmortalityViolation(character, { cause: 'immortality_ascension' }) === null;
  });

  check('不老不死を達成したのに通常死亡すれば矛盾として検出される', function () {
    var character = { goal: { id: 'become_immortal', status: 'completed' } };
    return findImmortalityViolation(character, { cause: 'illness' }) !== null;
  });

  check('不老不死を達成していないのに不老不死終了になれば矛盾として検出される', function () {
    var character = { goal: { id: 'become_immortal', status: 'failed' } };
    return findImmortalityViolation(character, { cause: 'immortality_ascension' }) !== null;
  });

  check('無関係な目標・通常死亡は矛盾として検出されない', function () {
    var character = { goal: { id: 'protect_family', status: 'completed' } };
    return findImmortalityViolation(character, { cause: 'illness' }) === null;
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

// driftWorld() が world.yearEra（暦）を「初期値0へ回帰する世界統計」として
// 扱ってしまい、暦が毎年わずかに巻き戻り、かつ小数化するバグ（issue #11）が
// あった。driftWorld を何度呼んでも yearEra が完全に不変であることを直接
// 検証する（ドリフト対象6項目は変動してよいが、暦だけは絶対に動いてはならない）。
export function runWorldYearDriftSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  var initialWorld = {
    yearEra: 0, unrest: false, stability: 50, warThreat: 15, demonThreat: 15,
    religiousInfluence: 50, techLevel: 30, economy: 50
  };

  check('driftWorldはyearEraを1回の呼び出しでも変化させない', function () {
    var world = Object.assign({}, initialWorld, { yearEra: 45 });
    driftWorld(world, initialWorld, { min: 0, max: 100 });
    return world.yearEra === 45;
  });

  check('driftWorldを100回連続で呼んでもyearEraは不変・整数のまま', function () {
    var world = Object.assign({}, initialWorld, { yearEra: 88 });
    for (var i = 0; i < 100; i++) driftWorld(world, initialWorld, { min: 0, max: 100 });
    return world.yearEra === 88 && Number.isInteger(world.yearEra);
  });

  check('driftWorldは通常の世界統計(stability等)には引き続き作用する', function () {
    var world = Object.assign({}, initialWorld, { yearEra: 10, stability: 90 });
    driftWorld(world, initialWorld, { min: 0, max: 100 });
    return world.stability !== 90;
  });

  return results;
}

// 転生記録図鑑の発見カウンタ・解禁条件（issue #9）の境界条件を直接検証する。
export function runDiscoveryUnlockSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  check('条件が無いアイテムは常に解禁済み', function () {
    return isItemUnlocked({ id: 'x' }, freshDiscoveries()) === true;
  });

  check('minCountに満たない発見では解禁されない', function () {
    var d = freshDiscoveries();
    d.occupations.adventurer = 1;
    return evaluateUnlockCondition({ category: 'occupations', id: 'adventurer', minCount: 2 }, d) === false;
  });

  check('minCountを満たすと解禁される', function () {
    var d = freshDiscoveries();
    d.occupations.adventurer = 2;
    return evaluateUnlockCondition({ category: 'occupations', id: 'adventurer', minCount: 2 }, d) === true;
  });

  check('anyはいずれか1つを満たせば解禁される', function () {
    var d = freshDiscoveries();
    d.goals.see_world_end = 1;
    return evaluateUnlockCondition({ any: [
      { category: 'occupations', id: 'adventurer' },
      { category: 'goals', id: 'see_world_end' }
    ] }, d) === true;
  });

  check('allはすべて満たさなければ解禁されない', function () {
    var d = freshDiscoveries();
    d.elements.demon_mark = 1;
    return evaluateUnlockCondition({ all: [
      { category: 'elements', id: 'demon_mark' },
      { category: 'tags', id: 'demon_lord' }
    ] }, d) === false;
  });

  check('recordLifeDiscoveriesは既存カウントを減らさず加算する', function () {
    var d = freshDiscoveries();
    var character = { elements: ['magic_affinity'], goal: null, occupation: 'blacksmith', tags: [] };
    recordLifeDiscoveries(d, character, { cause: 'illness' }, { forge_apprentice: 3 });
    recordLifeDiscoveries(d, character, { cause: 'illness' }, { forge_apprentice: 2 });
    return d.elements.magic_affinity === 2 && d.occupations.blacksmith === 2 &&
      d.deathCauses.illness === 2 && d.events.forge_apprentice === 5;
  });

  check('全選択肢が封印されたイベントはpickChoiceがnullを返す(封印無視のフォールバックをしない)', function () {
    var evt = { choices: [{ id: 'locked', requiredFlags: ['item_never_owned'] }] };
    return isChoiceUnlocked(evt.choices[0], {}) === false;
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

// 「不老不死になる」を completed にする選択肢は、必ず同時に
// effects.endLife（cause: 'immortality_ascension'）で通常の死亡判定を
// 経ずにその場で人生を終えなければならない（issue #10）。今後の編集で
// 新しい到達経路が goalResolution だけ追加され、endLife の対応を忘れる
// 再発を静的に検出する。
export function findImmortalGoalWithoutEndLife(events) {
  var violations = [];
  events.forEach(function (evt) {
    (evt.choices || []).forEach(function (choice) {
      var gr = choice.effects && choice.effects.goalResolution;
      if (!gr || gr.status !== 'completed' || !Array.isArray(gr.ids) || gr.ids.indexOf('become_immortal') === -1) return;
      var endLife = choice.effects.endLife;
      if (!endLife || endLife.cause !== 'immortality_ascension') {
        violations.push({ eventId: evt.id, choiceId: choice.id });
      }
    });
  });
  return violations;
}

// choice.requiredFlags/excludedFlagsで選択肢を封印できるようになった際、
// 「全選択肢が封印されたら封印を無視して全選択肢へ戻す」という危険な
// フォールバックが decision-engine.js にあった（issue #9で敵対的検証により
// 指摘: 解禁条件付き選択肢しか持たないイベントを新設すると、非対象者でも
// 封印済み選択肢を選べてしまう再発経路になる）。フォールバックそのものを
// 廃止した上で、すべてのイベントが「requiredFlags/excludedFlagsを一切
// 持たない、常に選べる選択肢」を最低1つ持つことを静的に強制し、
// pickChoiceがnullを返す経路（＝その年は何も起きない）が実運用では
// 発生しないことを保証する。
export function findEventsWithoutUnconditionalChoice(events) {
  var violations = [];
  events.forEach(function (evt) {
    var hasUnconditional = (evt.choices || []).some(function (choice) {
      return !choice.requiredFlags && !choice.excludedFlags;
    });
    if (!hasUnconditional) violations.push({ eventId: evt.id });
  });
  return violations;
}

export function runStaticConsistencyChecks(events) {
  return {
    abilityKeysInTraitWeights: findAbilityKeysInTraitWeights(events),
    goalResolutionWithoutIds: findGoalResolutionWithoutIds(events),
    immortalGoalWithoutEndLife: findImmortalGoalWithoutEndLife(events),
    eventsWithoutUnconditionalChoice: findEventsWithoutUnconditionalChoice(events)
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

// 「不老不死になる」を達成したのに、通常の老衰・病気などで死亡する（issue #10で
// 実際に検出された意味的矛盾）ことがないかを確認する。達成時は必ず
// effects.endLife（cause: 'immortality_ascension'）でその場の観測を終えるため、
// 死因がそれ以外になっていれば矛盾。逆に、目標を達成していないのに
// immortality_ascension で終わることも無いはずなので合わせて検出する。
export function findImmortalityViolation(character, deathInfo) {
  var achieved = !!(character.goal && character.goal.id === 'become_immortal' && character.goal.status === 'completed');
  var cause = deathInfo ? deathInfo.cause : null;
  if (achieved && cause !== 'immortality_ascension') {
    return { issue: 'immortal_but_normal_death', cause: cause };
  }
  if (!achieved && cause === 'immortality_ascension') {
    return { issue: 'immortality_ascension_without_goal' };
  }
  return null;
}

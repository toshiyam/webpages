import { applyGoalFormation, applyGoalResolution } from './effect-processor.js';
import { setItemOutcome, consumeItem, recordContextualItemUse } from './starting-grants.js';
import { driftWorld, simulateYear } from './time-processor.js';
import { isChoiceUnlocked } from './decision-engine.js';
import { freshDiscoveries, recordLifeDiscoveries, evaluateUnlockCondition, isItemUnlocked, restoreDiscoveriesFromPastLives } from './discovery.js';

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

// schemaVersion 6以前から7への移行時、既存pastLivesから発見状態を復元する
// restoreDiscoveriesFromPastLives（issue #15）の境界条件を直接検証する。
export function runDiscoveryRestoreSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  var occupations = { blacksmith: '鍛冶屋', adventurer: '冒険者' };
  var deathCauseLabels = { illness: '病気', crime: '犯罪・処刑' };

  check('schemaVersion6以前の簡易レコード(ラベルのみ)からラベル逆引きで職業・死因のみ復元する', function () {
    var d = freshDiscoveries();
    var oldRecord = { name: 'A', age: 40, occupation: '鍛冶屋', cause: '病気' };
    restoreDiscoveriesFromPastLives(d, [oldRecord], occupations, deathCauseLabels);
    return d.occupations.blacksmith === 1 && d.deathCauses.illness === 1 &&
      Object.keys(d.elements).length === 0 && Object.keys(d.goals).length === 0 &&
      Object.keys(d.tags).length === 0 && Object.keys(d.events).length === 0;
  });

  check('未知のラベルは逆引きできず捏造しない', function () {
    var d = freshDiscoveries();
    var oldRecord = { name: 'A', age: 40, occupation: '廃業した職業', cause: '未知の死因' };
    restoreDiscoveriesFromPastLives(d, [oldRecord], occupations, deathCauseLabels);
    return Object.keys(d.occupations).length === 0 && Object.keys(d.deathCauses).length === 0;
  });

  check('詳細レコード(elementsを持つ)は特殊要素・生涯目標・タグ・職業・死因をIDで直接復元する', function () {
    var d = freshDiscoveries();
    var detailedRecord = {
      name: 'B', elements: ['magic_affinity'], goal: { id: 'become_king', label: '王になる', status: 'completed' },
      occupation: 'adventurer', deathCause: 'crime', tags: ['executed_heretic']
    };
    restoreDiscoveriesFromPastLives(d, [detailedRecord], occupations, deathCauseLabels);
    return d.elements.magic_affinity === 1 && d.goals.become_king === 1 &&
      d.occupations.adventurer === 1 && d.deathCauses.crime === 1 && d.tags.executed_heretic === 1 &&
      Object.keys(d.events).length === 0;
  });

  check('複数の過去人生は加算され、既存の発見数を減らさない', function () {
    var d = freshDiscoveries();
    d.occupations.blacksmith = 5;
    var records = [
      { name: 'A', occupation: '鍛冶屋', cause: '病気' },
      { name: 'B', elements: [], goal: null, occupation: 'blacksmith', deathCause: 'illness', tags: [] }
    ];
    restoreDiscoveriesFromPastLives(d, records, occupations, deathCauseLabels);
    return d.occupations.blacksmith === 7;
  });

  check('pastLivesが空・未定義でも例外を投げない', function () {
    var d1 = freshDiscoveries();
    restoreDiscoveriesFromPastLives(d1, [], occupations, deathCauseLabels);
    var d2 = freshDiscoveries();
    restoreDiscoveriesFromPastLives(d2, undefined, occupations, deathCauseLabels);
    return Object.keys(d1.occupations).length === 0 && Object.keys(d2.occupations).length === 0;
  });

  return results;
}

// 「処刑された」のように死亡・生涯終了を断定するイベントは、必ず同じ年で
// effects.endLifeにより通常の老衰・病気の死亡ロールを経ずに確定的に終端し、
// 同一年内に二重の死亡・終端ログが生成されないことを、実際のsimulateYearを
// 通して直接検証する（issue #14）。
export function runEndLifeSelfTests() {
  var results = [];

  function check(name, fn) {
    var passed;
    try { passed = !!fn(); } catch (e) { passed = false; }
    results.push({ name: name, passed: passed });
  }

  function makeData(evt) {
    return {
      events: [evt],
      occupationIncome: { unemployed: 2 },
      occupationRisk: {},
      namePool: ['テスト'],
      deathCauseLabels: { crime: '犯罪・処刑', aging: '老衰' },
      initialWorld: { yearEra: 0, stability: 50, warThreat: 15, demonThreat: 15, religiousInfluence: 50, techLevel: 30, economy: 50 },
      worldFieldBounds: { min: 0, max: 100 },
      worldFlagThresholds: {}
    };
  }

  function makeCharacter() {
    return {
      id: 'test', name: 'テスト', age: 30, occupation: 'unemployed', money: 10, health: 95, alive: true,
      abilities: {}, traits: {}, elements: [], goal: null, fame: 0, worldImpact: {},
      startingItem: null, startingSkill: null, burden: null, itemState: {}, itemFirstUsedAge: {},
      itemOutcome: { status: 'unused', age: null }, flags: [], tags: [], firedUnique: {}, eventHistory: {}, zeroMoneyStreak: 0
    };
  }

  // simulateYearは「今年イベントが起きるか」自体もMath.random()で決めるため、
  // このテストだけは決定的に検証できるようMath.randomを一時的に固定する
  // （0を返す限り、唯一の合成イベント・唯一の選択肢が確実に選ばれる）。
  function withFixedRandom(fn) {
    var original = Math.random;
    try {
      Math.random = function () { return 0; };
      return fn();
    } finally {
      Math.random = original;
    }
  }

  check('健康な状態でも執行(endLife)された選択肢は確定的にその年で死亡する', function () {
    var evt = {
      id: 'test_execution', category: 'test', eventType: 'historic', unique: true,
      ageRange: { min: 0, max: 130 }, baseWeight: 10, conditions: {},
      text: '断罪の時が来た。',
      choices: [{ id: 'executed', label: '処刑される', baseWeight: 10, effects: { health: -70, endLife: { cause: 'crime' } }, resultText: '処刑された。' }]
    };
    var data = makeData(evt);
    var character = makeCharacter();
    var gameState = { character: character, relations: [], world: Object.assign({}, data.initialWorld) };
    var result = withFixedRandom(function () { return simulateYear(gameState, data); });
    return result.died === true && result.deathInfo.cause === 'crime' && character.alive === false;
  });

  check('endLifeで終端した年は死亡ログが1件だけで、通常死亡ログと二重生成されない', function () {
    var evt = {
      id: 'test_execution2', category: 'test', eventType: 'historic', unique: true,
      ageRange: { min: 0, max: 130 }, baseWeight: 10, conditions: {},
      text: '断罪の時が来た。',
      choices: [{ id: 'executed', label: '処刑される', baseWeight: 10, effects: { health: -70, endLife: { cause: 'crime' } }, resultText: '処刑された。' }]
    };
    var data = makeData(evt);
    var character = makeCharacter();
    var gameState = { character: character, relations: [], world: Object.assign({}, data.initialWorld) };
    var result = withFixedRandom(function () { return simulateYear(gameState, data); });
    var deathLikeLogs = result.logs.filter(function (l) { return l.importance === 'historic' && (l.eventId === 'death' || l.eventId === 'special_ending'); });
    return deathLikeLogs.length === 1;
  });

  // findEndLifeConsistencyViolation自体の境界条件（レビュー指摘: バッチ
  // シミュレーションで実際に使われる検査ロジックそのものを直接検証する）。
  check('終端ログが無く状態も矛盾しない生存中の人生はviolationなし', function () {
    var log = [{ year: 1, age: 21, eventId: 'some_event', choiceId: 'a', importance: 'minor' }];
    var character = { id: 'c1', age: 21, alive: true };
    return findEndLifeConsistencyViolation(log, character, false, null) === null;
  });

  check('終端ログの後に別ログがあればpost_termination_eventを検出する', function () {
    var log = [
      { year: 5, age: 25, eventId: 'special_ending', choiceId: 'crime', importance: 'historic' },
      { year: 6, age: 26, eventId: 'some_event', choiceId: 'b', importance: 'minor' }
    ];
    var character = { id: 'c2', age: 26, alive: false };
    var v = findEndLifeConsistencyViolation(log, character, true, { cause: 'crime' });
    return v !== null && v.type === 'post_termination_event';
  });

  check('終端ログがあるのにaliveがfalseでなければpost_termination_aliveを検出する', function () {
    var log = [{ year: 5, age: 25, eventId: 'death', choiceId: 'illness', importance: 'historic' }];
    var character = { id: 'c3', age: 25, alive: true };
    var v = findEndLifeConsistencyViolation(log, character, true, { cause: 'illness' });
    return v !== null && v.type === 'post_termination_alive';
  });

  check('死亡/特殊終端ログが複数あればduplicate_termination_logを検出する', function () {
    var log = [
      { year: 5, age: 25, eventId: 'special_ending', choiceId: 'crime', importance: 'historic' },
      { year: 5, age: 25, eventId: 'death', choiceId: 'illness', importance: 'historic' }
    ];
    var character = { id: 'c4', age: 25, alive: false };
    var v = findEndLifeConsistencyViolation(log, character, true, { cause: 'crime' });
    return v !== null && v.type === 'duplicate_termination_log';
  });

  check('終端ログが無いのにdied/deathInfoだけ設定されていればstate_mismatchを検出する', function () {
    var log = [{ year: 1, age: 21, eventId: 'some_event', choiceId: 'a', importance: 'minor' }];
    var character = { id: 'c5', age: 21, alive: true };
    var v = findEndLifeConsistencyViolation(log, character, true, { cause: 'illness' });
    return v !== null && v.type === 'state_mismatch';
  });

  check('終端ログ・alive・died・deathInfoが揃って整合していればviolationなし', function () {
    var log = [{ year: 5, age: 25, eventId: 'death', choiceId: 'illness', importance: 'historic' }];
    var character = { id: 'c6', age: 25, alive: false };
    return findEndLifeConsistencyViolation(log, character, true, { cause: 'illness' }) === null;
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

// 死亡・生涯終了を断定する文言と、実際の終端効果（effects.endLife）との
// 不整合候補を一覧化する（issue #14）。あくまで「レビュー対象の候補一覧」
// であり、ランタイムの生命状態判定にこの文字列検査結果を使うことは禁止
// （ログ文字列の解析で alive を書き換えるような実装をしないため）。
// 誤検知は許容し、totalViolationCountには含めない。
var DEATH_WORDS = [
  '死亡', '生涯を閉じ', '生涯を終え', '息を引き取', '命を落と', '死を迎え', '絶命',
  '処刑', '殺され', '討たれ', '斃れ', '亡くなっ', '死んだ', '死する', '刑死', '刑に処', '命が尽き'
];
var CONTINUATION_WORDS = [
  '暮らし続け', '生き続け', '踏み出した', '選び続け', '地位を確立', '歩み続け', '続けることを選んだ'
];

export function findDeathWordingInconsistencies(events) {
  var candidates = [];
  events.forEach(function (evt) {
    (evt.choices || []).forEach(function (choice) {
      var text = choice.resultText || '';
      var hasEndLife = !!(choice.effects && choice.effects.endLife);
      var mentionsDeath = DEATH_WORDS.some(function (w) { return text.indexOf(w) >= 0; });
      var mentionsContinuation = CONTINUATION_WORDS.some(function (w) { return text.indexOf(w) >= 0; });
      if (mentionsDeath && !hasEndLife) {
        candidates.push({ eventId: evt.id, choiceId: choice.id, issue: 'death_wording_without_endLife', text: text });
      }
      if (hasEndLife && mentionsContinuation) {
        candidates.push({ eventId: evt.id, choiceId: choice.id, issue: 'endLife_with_continuation_wording', text: text });
      }
    });
  });
  return candidates;
}

export function runStaticConsistencyChecks(events) {
  return {
    abilityKeysInTraitWeights: findAbilityKeysInTraitWeights(events),
    goalResolutionWithoutIds: findGoalResolutionWithoutIds(events),
    immortalGoalWithoutEndLife: findImmortalGoalWithoutEndLife(events),
    eventsWithoutUnconditionalChoice: findEventsWithoutUnconditionalChoice(events),
    deathWordingCandidates: findDeathWordingInconsistencies(events)
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

// issue #14で要求された「死亡・生涯終了ログ後も人生が継続する」不整合の
// 再発防止は、runEndLifeSelfTestsの合成2ケースだけでは不十分（レビュー指摘）。
// 実際のバッチシミュレーションで、1人生分の完全なログ列（各年のsimulateYear
// 結果をそのまま連結したもの。間引き・再構成しない）と、ループ終了時点の
// character/died/deathInfoから、以下4種を独立に検出する。
//   post_termination_event: 終端ログ(eventId: death または special_ending)の
//     後に、別のログが存在する（＝終端後も通常の年次処理が続いた）
//   post_termination_alive: 終端ログが存在するのに character.alive !== false
//   duplicate_termination_log: 終端ログが1件を超えて存在する（二重死亡/終端）
//   state_mismatch: alive===false / died===true / deathInfo!=null の
//     3つが一致しない
// 問題なければ null を返す。呼び出し側（runLife）が生成する完全なログ列を
// 前提とするため、eventCountsのような集計済みデータでは代用できない。
export function findEndLifeConsistencyViolation(log, character, died, deathInfo) {
  var TERMINATION_EVENT_IDS = ['death', 'special_ending'];
  var entries = log || [];
  var terminationIndices = [];
  entries.forEach(function (entry, index) {
    if (entry.importance === 'historic' && TERMINATION_EVENT_IDS.indexOf(entry.eventId) !== -1) {
      terminationIndices.push(index);
    }
  });

  function violation(type, detail) {
    return {
      type: type,
      characterId: character.id,
      age: character.age,
      alive: character.alive,
      died: !!died,
      deathInfo: deathInfo || null,
      detail: detail,
      log: entries.map(function (l) {
        return { year: l.year, age: l.age, eventId: l.eventId, choiceId: l.choiceId, importance: l.importance };
      })
    };
  }

  if (terminationIndices.length > 1) {
    return violation('duplicate_termination_log', { terminationIndices: terminationIndices });
  }

  if (terminationIndices.length === 1) {
    var termIndex = terminationIndices[0];
    if (termIndex !== entries.length - 1) {
      return violation('post_termination_event', {
        terminationIndex: termIndex,
        followingEventId: entries[termIndex + 1].eventId,
        followingChoiceId: entries[termIndex + 1].choiceId
      });
    }
    if (character.alive !== false) {
      return violation('post_termination_alive', { terminationIndex: termIndex, terminationEventId: entries[termIndex].eventId });
    }
  }

  var aliveIsDead = character.alive === false;
  var diedFlag = !!died;
  var hasDeathInfo = deathInfo != null;
  if (aliveIsDead !== diedFlag || aliveIsDead !== hasDeathInfo || diedFlag !== hasDeathInfo) {
    return violation('state_mismatch', { aliveIsDead: aliveIsDead, diedFlag: diedFlag, hasDeathInfo: hasDeathInfo });
  }

  return null;
}

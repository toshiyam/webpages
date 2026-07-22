import { clamp, pick, randInt, uid } from './rng.js';
import { consumeItem, setItemOutcome } from './starting-grants.js';

var MAX_RELATIONS = 9;

export function findRelationIndex(relations, type) {
  for (var i = relations.length - 1; i >= 0; i--) {
    if (relations[i].type === type && relations[i].alive) return i;
  }
  return -1;
}

export function createRelation(namePool, type, role) {
  return {
    id: uid(), name: pick(namePool), role: role || type, type: type,
    affinity: randInt(30, 70), trust: randInt(30, 70), fear: randInt(0, 20), alive: true, tags: []
  };
}

// 戻り値は「このイベントで実際に起きた関係の増減・格上げ」の1件のみ
// （{ kind: 'added'|'removed'|'promoted', name, role }、無ければnull）。
// affinityの微増減は毎年のように起こる揺らぎであり、ログ上で目立たせるべき
// 「転機」ではないため、この戻り値には含めない（issue #24: 転機が埋もれない
// ようにする要件のうち、何が転機で何が背景ノイズかを区別するための設計）。
export function applyRelationEffect(relations, namePool, relEffect) {
  if (!relEffect) return null;
  var change = null;
  if (relEffect.add && relations.length < MAX_RELATIONS) {
    var newRel = createRelation(namePool, relEffect.add.type, relEffect.add.role);
    relations.push(newRel);
    change = { kind: 'added', name: newRel.name, role: newRel.role };
  }
  if (relEffect.affinity) {
    var idx = findRelationIndex(relations, relEffect.affinity.type);
    if (idx >= 0) relations[idx].affinity = clamp(relations[idx].affinity + relEffect.affinity.delta, -100, 100);
  }
  if (relEffect.remove) {
    var idx2 = findRelationIndex(relations, relEffect.remove.type);
    if (idx2 >= 0) {
      var removedRel = relations[idx2];
      relations.splice(idx2, 1);
      change = { kind: 'removed', name: removedRel.name, role: removedRel.role };
    }
  }
  if (relEffect.promote) {
    var idx3 = findRelationIndex(relations, relEffect.promote.from);
    if (idx3 >= 0) {
      relations[idx3].type = relEffect.promote.to;
      relations[idx3].role = relEffect.promote.role || relEffect.promote.to;
      change = { kind: 'promoted', name: relations[idx3].name, role: relations[idx3].role };
    }
  }
  return change;
}

// 生涯目標の新規形成。goal: {id, label} を渡すと未設定時のみ新規形成する。
// 実際に形成した場合はtrueを返す（既に目標を持っている場合は何もせずfalse）。
export function applyGoalFormation(character, goalEffect) {
  if (goalEffect && !character.goal) {
    character.goal = {
      id: goalEffect.id, label: goalEffect.label, status: 'active',
      formedAtAge: character.age, progress: 0, resolvedAtAge: null
    };
    return true;
  }
  return false;
}

// 生涯目標の進捗・状態変化。goalResolution.ids に現在の character.goal.id が
// 含まれている場合にのみ適用する。無関係なアーク（例: 目標が「家族を守る」の
// 転生者が勇者アークの結末に遭遇した場合など）が、たまたま手元にある目標を
// 誤って達成/失敗扱いにしてしまわないようにするための必須チェック。
// 戻り値は「このイベントで実際に生涯目標へ起きた変化」
// ({ progressed: bool, status: string|null })。idsが現在の目標と無関係、
// または目標が未設定の場合はnullを返す。
export function applyGoalResolution(character, goalResolution) {
  if (!goalResolution || !character.goal) return null;
  var ids = goalResolution.ids;
  if (ids && ids.indexOf(character.goal.id) === -1) return null;
  var change = { progressed: false, status: null };
  if (typeof goalResolution.progress === 'number') {
    character.goal.progress = clamp(character.goal.progress + goalResolution.progress, 0, 100);
    change.progressed = true;
  }
  if (goalResolution.status) {
    character.goal.status = goalResolution.status;
    character.goal.resolvedAtAge = character.age;
    // 「達成」は定義上、進捗100%を意味する。個々のイベントで100まで
    // 積み上げ忘れても、完遂と未完了の進捗値が矛盾した状態
    // （例: 状態=達成なのに進捗30%）を作らないようにここで確定させる。
    if (goalResolution.status === 'completed') {
      character.goal.progress = 100;
    }
    change.status = goalResolution.status;
  }
  return change;
}

export function applyWorldEffect(world, bounds, worldEffect) {
  if (!worldEffect) return {};
  var lo = (bounds && bounds.min) || 0;
  var hi = (bounds && bounds.max) || 100;
  var appliedDeltas = {};
  for (var k in worldEffect) {
    if (typeof world[k] === 'number') {
      var before = world[k];
      world[k] = clamp(before + worldEffect[k], lo, hi);
      appliedDeltas[k] = world[k] - before;
    }
  }
  return appliedDeltas;
}

// 転生者ごとに、自らの行動（イベント効果）によって世界状態へ与えた変化だけを
// 積算する。世界状態そのものは転生をまたいで持続し、かつ毎年わずかにドリフト
// (自然変動)するため、そこからの単純な差分では「前世代の遺産」や「乱数による
// 揺らぎ」まで今の転生者の功績/罪過として誤って人生要約に書いてしまう。
// ここで積んだ character.worldImpact だけを要約・統計に使うことで、
// 実際にこの人生のイベントが及ぼした影響だけを追跡できるようにする。
export function accumulateWorldImpact(character, appliedDeltas) {
  for (var k in appliedDeltas) {
    character.worldImpact[k] = (character.worldImpact[k] || 0) + appliedDeltas[k];
  }
}

// イベント選択肢の effects を転生者・人間関係・生涯目標・世界状態へ反映する。
// 戻り値はこの1回の適用で「実際に」起きた変化のまとめ（changes）。
// ログのタイムライン表示（issue #24）が、職業・生涯目標・関係・世界影響の
// うちどれが転機だったかを、テキストの自然言語解析に頼らず機械的に判定
// できるようにするための構造化情報であり、以下のフィールドはすべて
// 「実際に変化が起きた場合のみ」truthyになる（要求されたが無効だった、
// 変化前後で値が同じだった、等の場合はnull/falseのまま）。
export function applyEffects(character, relations, world, worldBounds, namePool, effects) {
  var changes = { occupation: null, goalFormed: null, goalProgressed: false, goalStatus: null, relation: null, worldDeltas: null };
  if (!effects) return changes;
  if (effects.abilities) {
    for (var k in effects.abilities) {
      character.abilities[k] = clamp(character.abilities[k] + effects.abilities[k], 0, 100);
    }
  }
  if (typeof effects.health === 'number') character.health = clamp(character.health + effects.health, 0, 100);
  if (typeof effects.money === 'number') character.money = Math.max(0, character.money + effects.money);
  if (typeof effects.fame === 'number') character.fame = clamp(character.fame + effects.fame, 0, 100);
  if (effects.occupation && effects.occupation !== character.occupation) {
    changes.occupation = { from: character.occupation, to: effects.occupation };
    character.occupation = effects.occupation;
  } else if (effects.occupation) {
    character.occupation = effects.occupation;
  }
  if (effects.flagsAdd) {
    effects.flagsAdd.forEach(function (f) {
      if (character.flags.indexOf(f) === -1) character.flags.push(f);
    });
  }
  if (effects.flagsRemove) {
    effects.flagsRemove.forEach(function (f) {
      var idx = character.flags.indexOf(f);
      if (idx >= 0) character.flags.splice(idx, 1);
    });
  }
  if (effects.tagsAdd) {
    effects.tagsAdd.forEach(function (t) {
      if (character.tags.indexOf(t) === -1) character.tags.push(t);
    });
  }
  if (effects.relation) changes.relation = applyRelationEffect(relations, namePool, effects.relation);
  if (effects.goal) {
    var formed = applyGoalFormation(character, effects.goal);
    if (formed) changes.goalFormed = effects.goal.label;
  }
  if (effects.goalResolution) {
    var goalChange = applyGoalResolution(character, effects.goalResolution);
    if (goalChange) {
      changes.goalProgressed = goalChange.progressed;
      changes.goalStatus = goalChange.status;
    }
  }
  if (effects.world) {
    var appliedDeltas = applyWorldEffect(world, worldBounds, effects.world);
    accumulateWorldImpact(character, appliedDeltas);
    changes.worldDeltas = appliedDeltas;
  }
  if (effects.consumeItem) consumeItem(character, effects.consumeItem);
  // markItemUsed: 「役立てた」場合の簡略記法（setItemOutcomeのstatus='used'相当）。
  // 喪失・拒絶など否定的な結果を表したいイベントは itemOutcome を使うこと。
  if (effects.markItemUsed) setItemOutcome(character, effects.markItemUsed, 'used');
  if (effects.itemOutcome) setItemOutcome(character, effects.itemOutcome.itemId, effects.itemOutcome.status);
  return changes;
}

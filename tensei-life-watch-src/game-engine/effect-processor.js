import { clamp, pick, randInt, uid } from './rng.js';

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

export function applyRelationEffect(relations, namePool, relEffect) {
  if (!relEffect) return;
  if (relEffect.add && relations.length < MAX_RELATIONS) {
    relations.push(createRelation(namePool, relEffect.add.type, relEffect.add.role));
  }
  if (relEffect.affinity) {
    var idx = findRelationIndex(relations, relEffect.affinity.type);
    if (idx >= 0) relations[idx].affinity = clamp(relations[idx].affinity + relEffect.affinity.delta, -100, 100);
  }
  if (relEffect.remove) {
    var idx2 = findRelationIndex(relations, relEffect.remove.type);
    if (idx2 >= 0) relations.splice(idx2, 1);
  }
  if (relEffect.promote) {
    var idx3 = findRelationIndex(relations, relEffect.promote.from);
    if (idx3 >= 0) {
      relations[idx3].type = relEffect.promote.to;
      relations[idx3].role = relEffect.promote.role || relEffect.promote.to;
    }
  }
}

// 生涯目標の新規形成。goal: {id, label} を渡すと未設定時のみ新規形成する。
export function applyGoalFormation(character, goalEffect) {
  if (goalEffect && !character.goal) {
    character.goal = {
      id: goalEffect.id, label: goalEffect.label, status: 'active',
      formedAtAge: character.age, progress: 0, resolvedAtAge: null
    };
  }
}

// 生涯目標の進捗・状態変化。goalResolution.ids に現在の character.goal.id が
// 含まれている場合にのみ適用する。無関係なアーク（例: 目標が「家族を守る」の
// 転生者が勇者アークの結末に遭遇した場合など）が、たまたま手元にある目標を
// 誤って達成/失敗扱いにしてしまわないようにするための必須チェック。
export function applyGoalResolution(character, goalResolution) {
  if (!goalResolution || !character.goal) return;
  var ids = goalResolution.ids;
  if (ids && ids.indexOf(character.goal.id) === -1) return;
  if (typeof goalResolution.progress === 'number') {
    character.goal.progress = clamp(character.goal.progress + goalResolution.progress, 0, 100);
  }
  if (goalResolution.status) {
    character.goal.status = goalResolution.status;
    character.goal.resolvedAtAge = character.age;
  }
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
export function applyEffects(character, relations, world, worldBounds, namePool, effects) {
  if (!effects) return;
  if (effects.abilities) {
    for (var k in effects.abilities) {
      character.abilities[k] = clamp(character.abilities[k] + effects.abilities[k], 0, 100);
    }
  }
  if (typeof effects.health === 'number') character.health = clamp(character.health + effects.health, 0, 100);
  if (typeof effects.money === 'number') character.money = Math.max(0, character.money + effects.money);
  if (typeof effects.fame === 'number') character.fame = clamp(character.fame + effects.fame, 0, 100);
  if (effects.occupation) character.occupation = effects.occupation;
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
  if (effects.relation) applyRelationEffect(relations, namePool, effects.relation);
  if (effects.goal) applyGoalFormation(character, effects.goal);
  if (effects.goalResolution) applyGoalResolution(character, effects.goalResolution);
  if (effects.world) {
    var appliedDeltas = applyWorldEffect(world, worldBounds, effects.world);
    accumulateWorldImpact(character, appliedDeltas);
  }
}

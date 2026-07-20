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

// イベント選択肢の effects を転生者・人間関係へ反映する。
export function applyEffects(character, relations, namePool, effects) {
  if (!effects) return;
  if (effects.abilities) {
    for (var k in effects.abilities) {
      character.abilities[k] = clamp(character.abilities[k] + effects.abilities[k], 0, 100);
    }
  }
  if (typeof effects.health === 'number') character.health = clamp(character.health + effects.health, 0, 100);
  if (typeof effects.money === 'number') character.money = Math.max(0, character.money + effects.money);
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
}

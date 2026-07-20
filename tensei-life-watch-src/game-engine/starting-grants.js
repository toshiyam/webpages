import { randInt } from './rng.js';

// 転生準備フェーズで選んだ持込アイテム・初期スキル・制約を転生者へ適用する。
// grants: { itemId, skillId, burdenId } （それぞれ null または 'none' で「なし」）
//
// アイテム・スキル・制約は character.flags に 'item_<id>' / 'skill_<id>' /
// 'burden_<id>' として載るだけで、既存の contextWeights / requiredFlags /
// excludedFlags / weightContextBonus の仕組みだけからイベント条件・選択肢
// 補正・発生頻度へ影響できる。新しい条件構文はほぼ増やさない。
export function findItem(data, itemId) {
  return (data.items || []).filter(function (i) { return i.id === itemId; })[0] || null;
}
export function findSkill(data, skillId) {
  return (data.skills || []).filter(function (s) { return s.id === skillId; })[0] || null;
}
export function findBurden(data, burdenId) {
  return (data.burdens || []).filter(function (b) { return b.id === burdenId; })[0] || null;
}

// 強力な持込（requiresBurden: true）は、制約を1つ選んでいなければ選択できない。
// UIだけでなくエンジン側でも強制することで、不正な組み合わせの保存データが
// 作られても無効化できるようにする。
export function isItemSelectable(item, burdenId) {
  if (!item) return true;
  if (!item.requiresBurden) return true;
  return !!burdenId && burdenId !== 'none';
}

export function applyStartingGrants(character, data, grants) {
  var itemId = grants && grants.itemId;
  var skillId = grants && grants.skillId;
  var burdenId = grants && grants.burdenId;

  if (burdenId && burdenId !== 'none') {
    var burden = findBurden(data, burdenId);
    if (burden) {
      character.burden = burden.id;
      if (character.flags.indexOf('burden_' + burden.id) === -1) character.flags.push('burden_' + burden.id);
      if (typeof burden.startingHealth === 'number') {
        character.health = burden.startingHealth;
      }
      if (Array.isArray(burden.startingMoney)) {
        character.money = randInt(burden.startingMoney[0], burden.startingMoney[1]);
      }
    }
  }

  if (itemId && itemId !== 'none') {
    var item = findItem(data, itemId);
    if (item && isItemSelectable(item, character.burden)) {
      character.startingItem = item.id;
      if (character.flags.indexOf('item_' + item.id) === -1) character.flags.push('item_' + item.id);
      if (typeof item.usesRemaining === 'number') {
        character.itemState[item.id] = { usesRemaining: item.usesRemaining, consumed: false };
      }
      if (typeof item.startingMoneyBonus === 'number') {
        character.money += item.startingMoneyBonus;
      }
    }
  }

  if (skillId && skillId !== 'none') {
    var skill = findSkill(data, skillId);
    if (skill) {
      character.startingSkill = skill.id;
      if (character.flags.indexOf('skill_' + skill.id) === -1) character.flags.push('skill_' + skill.id);
    }
  }
}

// 消耗品の使用を記録する。初めて使った年齢を character.itemFirstUsedAge に残し、
// 残り使用回数が尽きたら 'item_<id>' フラグを外して 'item_<id>_used_up' を立てる
// （以降のイベントは「持っている」前提の補正を受けなくなる）。
export function consumeItem(character, itemId) {
  markItemUsed(character, itemId);
  var state = character.itemState && character.itemState[itemId];
  if (!state || state.consumed) return;
  state.usesRemaining = Math.max(0, (state.usesRemaining || 0) - 1);
  if (state.usesRemaining === 0) {
    state.consumed = true;
    var idx = character.flags.indexOf('item_' + itemId);
    if (idx >= 0) character.flags.splice(idx, 1);
    if (character.flags.indexOf('item_' + itemId + '_used_up') === -1) {
      character.flags.push('item_' + itemId + '_used_up');
    }
  }
}

// 消耗はしないが「初めて意味のある場面で使われた」ことだけを記録する
// （封印指輪を解いた、種子を蒔いた等、一度きりの明確な使用イベント向け）。
export function markItemUsed(character, itemId) {
  if (!character.itemFirstUsedAge) character.itemFirstUsedAge = {};
  if (character.itemFirstUsedAge[itemId] === undefined) {
    character.itemFirstUsedAge[itemId] = character.age;
  }
}

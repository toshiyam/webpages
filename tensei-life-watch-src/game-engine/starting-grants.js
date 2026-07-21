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
      character.itemOutcome = { status: 'unused', age: null };
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

// 消耗はしないが「初めて意味のある場面で触れられた」ことだけを記録する内部プリミティブ。
// 使用結果の意味（役立てた／使い切った／失った／使わなかった）は表さないため、
// 単独では呼ばず、必ず setItemOutcome とあわせて使う。
export function markItemUsed(character, itemId) {
  if (!character.itemFirstUsedAge) character.itemFirstUsedAge = {};
  if (character.itemFirstUsedAge[itemId] === undefined) {
    character.itemFirstUsedAge[itemId] = character.age;
  }
}

// 持込アイテムの「使用結果の意味」を明示的に記録する唯一の入口。
// character.itemOutcome は startingItem 1つ分の結果だけを保持する
// （転生準備で持ち込めるアイテムは常に最大1つのため）。
// status: 'unused' | 'used' | 'consumed' | 'lost' | 'rejected'
// 'used' はキャラクターが実際にその恩恵を行使した場合、'rejected' は
// 選択肢自体には触れたが力を使わない道を選んだ場合（例: 指輪の封印を
// 解かなかった）、'lost' は本人の意志と無関係にアイテムを失った場合
// （例: 銀貨袋を盗まれた）に使う。「行動した」ことと「結果が肯定的だった」
// ことは別物なので、この2つを1つの markItemUsed に混在させない。
export function setItemOutcome(character, itemId, status) {
  if (character.startingItem !== itemId) return;
  markItemUsed(character, itemId);
  if (!character.itemOutcome) character.itemOutcome = { status: 'unused', age: null };
  character.itemOutcome.status = status;
  character.itemOutcome.age = character.age;
}

// 消耗品の使用を記録する。初めて使った年齢を character.itemFirstUsedAge に残し、
// 残り使用回数が尽きたら 'item_<id>' フラグを外して 'item_<id>_used_up' を立てる
// （以降のイベントは「持っている」前提の補正を受けなくなる）。使用結果は
// 残量が尽きるまでは 'used'、尽きた時点で 'consumed' として記録する。
export function consumeItem(character, itemId) {
  setItemOutcome(character, itemId, 'used');
  var state = character.itemState && character.itemState[itemId];
  if (!state || state.consumed) return;
  state.usesRemaining = Math.max(0, (state.usesRemaining || 0) - 1);
  if (state.usesRemaining === 0) {
    state.consumed = true;
    setItemOutcome(character, itemId, 'consumed');
    var idx = character.flags.indexOf('item_' + itemId);
    if (idx >= 0) character.flags.splice(idx, 1);
    if (character.flags.indexOf('item_' + itemId + '_used_up') === -1) {
      character.flags.push('item_' + itemId + '_used_up');
    }
  }
}

// 万能ナイフ・現代の教本・方位磁針・家族写真のように、専用イベントを持たず
// choice.contextWeights による重み補正だけで人生へ影響するアイテムは、
// consumeItem/setItemOutcomeを呼ぶ専用効果が無いため、そのままでは
// 「実際に選択へ影響していても死亡時要約では未使用扱い」になってしまう。
// 選ばれた選択肢の contextWeights に 'item_<持込アイテムID>' キーがあり、
// かつそのフラグが実際にコンテキストへ立っていた（=補正が適用され得た）場合
// にのみ、そのイベント発生時点を 'used' として記録する
// （単に候補イベントになっただけでなく、選択肢が実際に選ばれた時だけ呼ばれる）。
export function recordContextualItemUse(character, choice, ctx) {
  if (!character.startingItem || !choice || !choice.contextWeights) return;
  var key = 'item_' + character.startingItem;
  if (choice.contextWeights[key] !== undefined && ctx[key]) {
    setItemOutcome(character, character.startingItem, 'used');
  }
}

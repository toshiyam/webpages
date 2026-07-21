import { bell100, pick, randInt, uid, weightedPick } from './rng.js';

function pickElement(elements) {
  return weightedPick(elements, function (e) { return e.weight || 1; });
}

// 各転生者に1つ、低確率で2つの特殊要素を付与する（'none' は「特別な要素なし」）。
// 要素は character.flags に 'element_<id>' として載り、既存の contextWeights の
// 仕組みだけでイベント条件・選択肢補正から参照できる。
function assignElements(elements, secondaryChance) {
  var picked = [];
  var first = pickElement(elements);
  if (first.id !== 'none') picked.push(first.id);

  if (Math.random() < (secondaryChance || 0)) {
    var candidates = elements.filter(function (e) { return e.id !== 'none' && e.id !== first.id; });
    if (candidates.length > 0) picked.push(pick(candidates).id);
  }
  return picked;
}

// data: game-engine/load-data.js の buildDataBundle() が返す統合データ
export function generateCharacter(data) {
  var isFemale = Math.random() < 0.5;
  var name = isFemale ? pick(data.femaleNames) : pick(data.maleNames);

  var abilities = {};
  data.abilities.forEach(function (a) { abilities[a.id] = bell100(); });

  var traits = {};
  data.traits.forEach(function (t) { traits[t.id] = bell100(); });

  var elements = assignElements(data.elements, data.elementSecondaryChance);
  var flags = elements.map(function (id) { return 'element_' + id; });

  return {
    id: uid(),
    name: name,
    genderLabel: isFemale ? '女性' : '男性',
    age: 0,
    region: pick(data.regions),
    occupation: 'unemployed',
    money: randInt(3, 15),
    health: 100,
    alive: true,
    abilities: abilities,
    traits: traits,
    elements: elements,
    goal: null,
    fame: 0,
    worldImpact: {},
    startingItem: null,
    startingSkill: null,
    burden: null,
    itemState: {},
    itemFirstUsedAge: {},
    itemOutcome: { status: 'unused', age: null },
    flags: flags,
    tags: [],
    firedUnique: {},
    eventHistory: {},
    zeroMoneyStreak: 0
  };
}

// 「同一候補・付与内容だけ変える」比較検証のためのヘルパー。
// 名前・出身・能力・性格・特殊要素は template から引き継ぎ、その他の
// 状態（年齢・職業・所持金・生涯目標・フラグ・タグ・持込アイテム等）は
// 完全に初期化した、独立した新しい人生としてシミュレートできる状態を返す。
export function cloneCharacterTemplate(template) {
  return {
    id: template.id + '-' + Math.random().toString(36).slice(2, 8),
    name: template.name,
    genderLabel: template.genderLabel,
    age: 0,
    region: template.region,
    occupation: 'unemployed',
    money: template.money,
    health: 100,
    alive: true,
    abilities: Object.assign({}, template.abilities),
    traits: Object.assign({}, template.traits),
    elements: template.elements.slice(),
    goal: null,
    fame: 0,
    worldImpact: {},
    startingItem: null,
    startingSkill: null,
    burden: null,
    itemState: {},
    itemFirstUsedAge: {},
    itemOutcome: { status: 'unused', age: null },
    flags: template.elements.map(function (id) { return 'element_' + id; }),
    tags: [],
    firedUnique: {},
    eventHistory: {},
    zeroMoneyStreak: 0
  };
}

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
    flags: flags,
    tags: [],
    firedUnique: {},
    eventHistory: {},
    zeroMoneyStreak: 0
  };
}

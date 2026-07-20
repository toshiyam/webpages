import { bell100, pick, randInt, uid } from './rng.js';

// data: game-data/traits.json と game-data/world.json をマージしたもの
// { abilities, traits, regions, maleNames, femaleNames }
export function generateCharacter(data) {
  var isFemale = Math.random() < 0.5;
  var name = isFemale ? pick(data.femaleNames) : pick(data.maleNames);

  var abilities = {};
  data.abilities.forEach(function (a) { abilities[a.id] = bell100(); });

  var traits = {};
  data.traits.forEach(function (t) { traits[t.id] = bell100(); });

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
    flags: [],
    tags: [],
    firedUnique: {},
    eventHistory: {},
    zeroMoneyStreak: 0
  };
}

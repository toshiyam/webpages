// game-data/*.json を1つの data バンドルへ正規化する。
// ブラウザ（fetch）・Node（fs）どちらから読み込んだJSONを渡しても同じ形に揃える。
export function buildDataBundle(traitsJson, occupationsJson, worldJson, eventsJson) {
  return {
    abilities: traitsJson.abilities,
    traits: traitsJson.traits,
    occupations: occupationsJson.occupations,
    occupationIncome: occupationsJson.income,
    occupationRisk: occupationsJson.risk,
    regions: worldJson.regions,
    maleNames: worldJson.maleNames,
    femaleNames: worldJson.femaleNames,
    namePool: worldJson.maleNames.concat(worldJson.femaleNames),
    deathCauseLabels: worldJson.deathCauses,
    initialWorld: worldJson.initial,
    events: eventsJson
  };
}

// game-data/*.json を1つの data バンドルへ正規化する。
// ブラウザ（fetch）・Node（fs）どちらから読み込んだJSONを渡しても同じ形に揃える。
export function buildDataBundle(traitsJson, occupationsJson, worldJson, eventsJson, elementsJson, goalsJson, itemsJson, skillsJson, burdensJson) {
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
    worldFieldBounds: worldJson.worldFieldBounds,
    worldFlagThresholds: worldJson.worldFlagThresholds,
    events: eventsJson,
    elements: elementsJson.elements,
    elementSecondaryChance: elementsJson.secondaryChance,
    goals: goalsJson.goals,
    items: (itemsJson && itemsJson.items) || [],
    skills: (skillsJson && skillsJson.skills) || [],
    burdens: (burdensJson && burdensJson.burdens) || []
  };
}

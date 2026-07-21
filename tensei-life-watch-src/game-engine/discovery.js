// 転生記録図鑑の「発見」状態と、それに基づく転生準備項目の段階解禁を扱う。
// state.discoveries はプレイヤーのセーブデータ全体で1つだけ持つ、生涯を
// またいで蓄積し続けるカウンタ集合であり、個々の character には属さない
// （過去人生の削除・上限トリムや死亡・次の転生を経ても、発見状態は
// 一切失われてはならない）。カテゴリは特殊要素・生涯目標・最終職業・
// 死因・発生イベントID・実績タグ（人生アークの結末を含む）の6種。
export function freshDiscoveries() {
  return { elements: {}, goals: {}, occupations: {}, deathCauses: {}, events: {}, tags: {} };
}

function bump(map, id, by) {
  if (!id) return;
  map[id] = (map[id] || 0) + (by || 1);
}

// 1人分の人生が終わった時点で呼び、その人生で観測された内容をまとめて
// 発見カウンタへ積算する（加算のみで、既存の値を減らす経路は無い）。
// eventCounts は simulate.js の runLife や web-ui の state.log 集計と同じ
// 形（eventId -> このライフでの発生回数）を渡す。
export function recordLifeDiscoveries(discoveries, character, deathInfo, eventCounts) {
  (character.elements || []).forEach(function (id) { bump(discoveries.elements, id); });
  if (character.goal) bump(discoveries.goals, character.goal.id);
  bump(discoveries.occupations, character.occupation);
  if (deathInfo) bump(discoveries.deathCauses, deathInfo.cause);
  (character.tags || []).forEach(function (id) { bump(discoveries.tags, id); });
  if (eventCounts) {
    Object.keys(eventCounts).forEach(function (id) { bump(discoveries.events, id, eventCounts[id]); });
  }
}

// 解禁条件の宣言的な評価。単一条件は { category, id, minCount(既定1) }。
// { any: [...] } / { all: [...] } で組み合わせられる。条件そのものが
// 無ければ常に解禁済み扱い（＝転生準備で最初から選べるアイテム/スキル/
// 制約はこの仕組みに触れずに済む）。
export function evaluateUnlockCondition(cond, discoveries) {
  if (!cond) return true;
  if (!discoveries) return false;
  if (Array.isArray(cond.any)) return cond.any.some(function (c) { return evaluateUnlockCondition(c, discoveries); });
  if (Array.isArray(cond.all)) return cond.all.every(function (c) { return evaluateUnlockCondition(c, discoveries); });
  if (cond.category && cond.id) {
    var map = discoveries[cond.category] || {};
    return (map[cond.id] || 0) >= (cond.minCount || 1);
  }
  return true;
}

export function isItemUnlocked(item, discoveries) {
  return evaluateUnlockCondition(item && item.unlockCondition, discoveries);
}
export function isSkillUnlocked(skill, discoveries) {
  return evaluateUnlockCondition(skill && skill.unlockCondition, discoveries);
}
export function isBurdenUnlocked(burden, discoveries) {
  return evaluateUnlockCondition(burden && burden.unlockCondition, discoveries);
}

// 死亡時のスナップショットを1件分の「転生記録図鑑」エントリとして組み立てる。
// character/relations/log/deathInfo/lifeRank のみを情報源とする
// （LLM不使用の要約と同じ方針）。過去人生一覧・人生詳細画面の両方で
// この形をそのまま使う。
export function buildLifeRecord(character, relations, deathInfo, lifeRank, log) {
  return {
    name: character.name,
    genderLabel: character.genderLabel,
    region: character.region,
    lifespan: character.age,
    occupation: character.occupation,
    elements: (character.elements || []).slice(),
    goal: character.goal ? {
      id: character.goal.id, label: character.goal.label,
      status: character.goal.status, progress: character.goal.progress
    } : null,
    lifeRank: lifeRank || null,
    tags: (character.tags || []).slice(),
    startingItem: character.startingItem,
    startingSkill: character.startingSkill,
    burden: character.burden,
    itemOutcome: character.itemOutcome ? Object.assign({}, character.itemOutcome) : null,
    worldImpact: Object.assign({}, character.worldImpact),
    deathCause: deathInfo.cause,
    deathAge: deathInfo.age,
    specialEnding: !!deathInfo.special,
    relations: (relations || []).map(function (r) { return { name: r.name, type: r.type, role: r.role }; }),
    historicEvents: (log || [])
      .filter(function (l) { return l.importance === 'historic'; })
      .map(function (l) { return { year: l.year, age: l.age, text: l.text }; })
  };
}

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

// schemaVersion 6以前からschemaVersion 7へ初めて移行する既存セーブ向けの
// 一回限りの復元処理（issue #15）。discoveriesが存在しない状態で移行される
// ため、そのままでは既に複数人生を観測済みのプレイヤーでも発見状態が
// 空へ巻き戻って見えてしまう。既存のpastLives（過去人生一覧、最大20件）
// から復元可能な範囲だけを加算する。呼び出し側（migrateState）が
// discoveriesが存在しなかった移行の瞬間にのみ1回呼ぶことで二重加算を防ぐ
// （この関数自体は加算のみを行う一括処理であり、多重呼び出しの防止は
// 呼び出し側の責務）。
//
// 過去人生の記録形式は2種類ある。
// - schemaVersion 7の詳細レコード（buildLifeRecordが生成、elementsを持つ）:
//   occupation/deathCauseはID、elements/goal.id/tagsも直接復元できる
// - schemaVersion 6以前の簡易レコード（elementsを持たない）:
//   occupation/causeはラベル文字列のみで、IDへ逆引きできた場合のみ復元する
// いずれの形式にも発生イベントIDの履歴（eventCounts相当）は保存されて
// いないため、events カテゴリは復元不能であり、推測で埋めない。
export function restoreDiscoveriesFromPastLives(discoveries, pastLives, occupations, deathCauseLabels) {
  var occupationIdByLabel = {};
  Object.keys(occupations || {}).forEach(function (id) { occupationIdByLabel[occupations[id]] = id; });
  var deathCauseIdByLabel = {};
  Object.keys(deathCauseLabels || {}).forEach(function (id) { deathCauseIdByLabel[deathCauseLabels[id]] = id; });

  (pastLives || []).forEach(function (p) {
    if (!p) return;
    if (p.elements !== undefined) {
      bump(discoveries.occupations, p.occupation);
      bump(discoveries.deathCauses, p.deathCause);
      (p.elements || []).forEach(function (id) { bump(discoveries.elements, id); });
      if (p.goal && p.goal.id) bump(discoveries.goals, p.goal.id);
      (p.tags || []).forEach(function (id) { bump(discoveries.tags, id); });
    } else {
      bump(discoveries.occupations, occupationIdByLabel[p.occupation]);
      bump(discoveries.deathCauses, deathCauseIdByLabel[p.cause]);
    }
  });
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
      .map(function (l) { return { year: l.year, age: l.age, text: l.text, importance: 'historic', turningPoints: l.turningPoints || [] }; }),
    // 転機(turningPoints)は重要度がmajor/minorのログにも付く（例: 職業変更や
    // 関係の追加は多くの場合historicではない）。historicEventsは重要度
    // 'historic'のみという既存の絞り込み基準を保存互換性のため変更できない
    // ので、それ以外で転機を持つログだけを別枠で保存する。historic分は
    // historicEvents側に既に含まれているため、ここでは対象外とすることで
    // 過去人生詳細の表示側が二重に持たなくて済むようにしている
    // （issue #24レビュー対応: 過去人生化した時点でmajor/minorの転機が
    // 失われていた不具合の修正）。
    turningEvents: (log || [])
      .filter(function (l) { return l.importance !== 'historic' && l.turningPoints && l.turningPoints.length > 0; })
      .map(function (l) { return { year: l.year, age: l.age, text: l.text, importance: l.importance, turningPoints: l.turningPoints }; })
  };
}

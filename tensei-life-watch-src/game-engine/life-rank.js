// 人生アークの結末タグから「平凡/著名/伝説/災厄/平穏」の人生ランクを判定する。
// タグは game-data/events.json のアーク最終段イベントの tagsAdd で付与される。

export var LEGENDARY_CANDIDATE_TAGS = [
  'legendary_hero', 'demon_lord', 'usurper_king', 'just_ruler', 'economic_ruler',
  'forbidden_technologist', 'renowned_inventor', 'religious_leader', 'heretic_prophet',
  'rebel_leader', 'legendary_outlaw', 'legendary_artisan', 'legendary_adventurer'
];

export var DISASTER_TAGS = [
  'fallen_hero', 'fallen_to_darkness', 'executed_traitor', 'catastrophic_inventor',
  'executed_heretic', 'executed_rebel', 'bankrupt_tycoon', 'cursed_creation', 'fallen_legend'
];

export var PEACEFUL_TAGS = [
  'peace_guardian', 'quiet_life', 'retired_hero', 'beloved_craftsman'
];

// 「著名」タグ止まりでも、世界に爪痕を残すほどの evens.json 名声(fame)を稼いでいれば
// 「伝説」へ格上げする。基準を上げることで、アークを完走しても大半は「著名」にとどまり、
// 一部の突出した人生だけが「伝説」になるようにしている。
var LEGENDARY_FAME_THRESHOLD = 65;

// いずれかの arc_*_s1 フラグを持てば「人生アークへ突入した」とみなす。
export function hasEnteredAnyArc(character) {
  return character.flags.some(function (f) { return /^arc_.*_s1/.test(f); });
}

// アーク最終段（tagsAdd の何らかの結末タグ）へ到達したかどうか。
export function hasReachedArcClimax(character) {
  return character.tags.some(function (t) {
    return LEGENDARY_CANDIDATE_TAGS.indexOf(t) >= 0 || DISASTER_TAGS.indexOf(t) >= 0 || PEACEFUL_TAGS.indexOf(t) >= 0;
  });
}

export function determineLifeRank(character) {
  var hasLegendaryCandidate = character.tags.some(function (t) { return LEGENDARY_CANDIDATE_TAGS.indexOf(t) >= 0; });
  if (hasLegendaryCandidate && character.fame >= LEGENDARY_FAME_THRESHOLD) return 'legendary';
  if (character.tags.some(function (t) { return DISASTER_TAGS.indexOf(t) >= 0; })) return 'disaster';
  if (character.tags.some(function (t) { return PEACEFUL_TAGS.indexOf(t) >= 0; })) return 'peaceful';
  // 到達点タグはあるが伝説と呼ぶには名声が足りない、または目標を成し遂げた人生。
  // 単にアークへ足を踏み入れただけ（stage1到達のみ）では「著名」にはしない。
  if (hasLegendaryCandidate) return 'notable';
  if (character.goal && character.goal.status === 'completed') return 'notable';
  return 'ordinary';
}

var LIFE_RANK_LABELS = {
  legendary: '伝説',
  disaster: '災厄',
  peaceful: '平穏',
  notable: '著名',
  ordinary: '平凡'
};

export function lifeRankLabel(rank) {
  return LIFE_RANK_LABELS[rank] || LIFE_RANK_LABELS.ordinary;
}

// 「ほぼ何も起きない人生」判定: 目標を持たず、アークにも入らず、実績タグも無い。
export function hadNothingHappen(character) {
  return !character.goal && !hasEnteredAnyArc(character) && character.tags.length === 0;
}

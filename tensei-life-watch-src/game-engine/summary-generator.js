import { fillName } from './rng.js';

var TAG_PHRASES = {
  notable_smith: '{name}は工房を継ぎ、名工としてその名を残した。',
  arms_dealer: '{name}は武具商として財を成した。',
  renowned_adventurer: '{name}の武勇は各地で語り継がれた。',
  fallen_adventurer: '{name}は仲間を失った末に、裏の道へ足を踏み入れた。',
  wealthy_merchant: '{name}は豪商として名を馳せた。',
  rumored_lucky: '{name}には生涯、不思議な強運の噂がつきまとった。',
  disabled_veteran: '{name}は深い傷を負いながらも、生き抜いた。'
};

var TRAIT_PHRASES = {
  bravery: '{name}は生涯、恐れを知らぬ勇敢さで知られた。',
  caution: '{name}は常に慎重さを失わず、危うい橋を渡らなかった。',
  ambition: '{name}は野心を胸に、絶えず上を目指し続けた。',
  altruism: '{name}は多くの人を助け、慕われた。',
  self_interest: '{name}は自らの利益を第一に、したたかに生きた。',
  curiosity: '{name}は最後まで、未知への好奇心を失わなかった。',
  loyalty: '{name}は仲間や主への忠義を貫いた。',
  faith: '{name}は信仰とともに人生を歩んだ。',
  family_orientation: '{name}は家族との時間を何より大切にした。',
  persistence: '{name}は幾度の困難にも屈しなかった。'
};

function dominantTrait(character, traitsDef) {
  var best = null, bestVal = -1;
  traitsDef.forEach(function (t) {
    if (character.traits[t.id] > bestVal) { bestVal = character.traits[t.id]; best = t.id; }
  });
  return best;
}

// LLMを使わず、死因・実績タグ・人間関係・支配的な性格からテンプレート文を組み合わせて
// 人生要約を生成する（イベントログと状態のみを情報源とする）。
export function generateSummary(character, relations, deathInfo, occupations, traitsDef, deathCauseLabels) {
  var name = character.name;
  var parts = [];
  parts.push(name + 'は' + character.age + '歳で、' + deathCauseLabels[deathInfo.cause] + 'によりその生涯を閉じた。');
  parts.push('最終的な身分は「' + occupations[character.occupation] + '」であった。');

  character.tags.forEach(function (tag) {
    if (TAG_PHRASES[tag]) parts.push(fillName(TAG_PHRASES[tag], name));
  });

  var spouse = relations.some(function (r) { return r.type === 'spouse'; });
  var child = relations.some(function (r) { return r.type === 'child'; });
  if (spouse && child) parts.push(name + 'は家庭を築き、家族に見守られながら人生を歩んだ。');
  else if (spouse) parts.push(name + 'は生涯の伴侶と共に歩んだ。');
  else parts.push(name + 'は家庭を持つことなく、その人生を歩んだ。');

  var dom = dominantTrait(character, traitsDef);
  if (TRAIT_PHRASES[dom]) parts.push(fillName(TRAIT_PHRASES[dom], name));

  var historic = character.tags.length > 0;
  parts.push(historic
    ? 'その生涯の一部は、後世まで語り継がれることとなった。'
    : 'その名が歴史に刻まれることはなかったが、確かにこの世界で生きた証を残した。');

  return parts.join('\n');
}

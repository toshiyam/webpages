import { fillName } from './rng.js';
import { determineLifeRank, lifeRankLabel } from './life-rank.js';

var TAG_PHRASES = {
  notable_smith: '{name}は工房を継ぎ、名工としてその名を残した。',
  arms_dealer: '{name}は武具商として財を成した。',
  renowned_adventurer: '{name}の武勇は各地で語り継がれた。',
  fallen_adventurer: '{name}は仲間を失った末に、裏の道へ足を踏み入れた。',
  wealthy_merchant: '{name}は豪商として名を馳せた。',
  rumored_lucky: '{name}には生涯、不思議な強運の噂がつきまとった。',
  disabled_veteran: '{name}は深い傷を負いながらも、生き抜いた。',
  legendary_hero: '{name}は魔の脅威を打ち払った英雄として、後世まで語り継がれた。',
  fallen_hero: '{name}は力に溺れ、かつての栄光を汚した。',
  demon_lord: '{name}は新たな魔王として、世界に恐怖と混乱をもたらした。',
  fallen_to_darkness: '{name}は闇の勢力に呑まれ、その生涯を終えた。',
  redeemed: '{name}は闇に近づきながらも、最後には人としての道を選び直した。',
  usurper_king: '{name}は玉座を武力で奪い、簒奪者として王座に就いた。',
  just_ruler: '{name}は民の信頼を集め、正統な支配者として国を治めた。',
  executed_traitor: '{name}の陰謀は露見し、反逆者として処刑された。',
  legendary_adventurer: '{name}は世界を脅かす大いなる脅威を打ち倒した。',
  self_serving_hero: '{name}は栄光を我が物とし、名声と富を独占した。',
  economic_ruler: '{name}は王国の経済を掌握するまでの豪商となった。',
  bankrupt_tycoon: '{name}の商いは拡大しすぎた末に破綻した。',
  forbidden_technologist: '{name}は禁忌の技術に手を染め、軍需産業を支配した。',
  renowned_inventor: '{name}は平和のための技術革新で名を残した。',
  catastrophic_inventor: '{name}の発明は制御を失い、災厄を招いた。',
  legendary_artisan: '{name}は伝説として語られる至高の一品を鍛え上げた。',
  cursed_creation: '{name}が生み出したものは、呪われた遺物として恐れられた。',
  beloved_craftsman: '{name}は多くの人に愛される熟練の職人として生涯を終えた。',
  religious_leader: '{name}は信仰の頂点に立ち、教団を導いた。',
  heretic_prophet: '{name}は既存の信仰に反旗を翻し、異端の予言者と呼ばれた。',
  executed_heretic: '{name}は異端者として断罪され、その生涯を終えた。',
  rebel_leader: '{name}は民衆を率いて既存の支配に反旗を翻した。',
  executed_rebel: '{name}の反乱は鎮圧され、処刑によってその生涯を終えた。',
  legendary_outlaw: '{name}は伝説の無法者として、その名を語り継がれた。',
  peace_guardian: '{name}はあらゆる誘惑と使命を退け、静かな暮らしを守り抜いた。',
  quiet_life: '{name}は表舞台に出ることなく、静かにその生涯を終えた。',
  retired_hero: '{name}は栄光を手にした後、静かな暮らしへと退いた。',
  late_awakening: '{name}は長く平穏を選び続けた末に、ついに大きな使命へと踏み出した。'
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

var ELEMENT_PHRASES = {
  modern_knowledge: '前世の現代知識',
  divine_mission: '神から与えられた使命',
  cursed_soul: '魂に刻まれた呪い',
  magic_affinity: '異常なまでの魔法適性',
  monster_affinity: '魔物との親和性',
  hero_mark: '勇者候補の証',
  demon_mark: '魔王候補の証',
  past_life_memory: '前世の記憶',
  return_desire: '元の世界への帰還願望'
};

var GOAL_STATUS_PHRASES = {
  completed: '{name}は生涯の目標「{goal}」を、ついに成し遂げた。',
  abandoned: '{name}は道半ばで「{goal}」という目標を自ら手放した。',
  failed: '{name}は「{goal}」を追い求めながらも、それを果たすことは叶わなかった。',
  distorted: '{name}が追い求めた「{goal}」は、いつしか違う形へと姿を変えていた。',
  active: '{name}は最期まで「{goal}」を目指し続けていた。'
};

function dominantTrait(character, traitsDef) {
  var best = null, bestVal = -1;
  traitsDef.forEach(function (t) {
    if (character.traits[t.id] > bestVal) { bestVal = character.traits[t.id]; best = t.id; }
  });
  return best;
}

var WORLD_IMPACT_LABELS = {
  stability: '王国の安定', warThreat: '戦争の脅威', demonThreat: '魔の勢力',
  religiousInfluence: '宗教の影響力', techLevel: '技術水準', economy: '経済'
};

// character.worldImpact は「この人生のイベント効果が実際に世界状態へ与えた
// 増減の累計」のみを保持している（driftWorld() による自然変動や、前の転生者
// が残した変化は一切含まれない）。そのため世界の生の値を初期値と比較するの
// ではなく、必ずこの積算値だけを参照する。
function worldImpactPhrase(character) {
  var deltas = [];
  Object.keys(WORLD_IMPACT_LABELS).forEach(function (key) {
    var diff = character.worldImpact[key];
    if (typeof diff === 'number' && Math.abs(diff) >= 12) deltas.push({ key: key, diff: diff });
  });
  if (deltas.length === 0) return null;
  var parts = deltas.map(function (d) {
    return WORLD_IMPACT_LABELS[d.key] + 'が' + (d.diff > 0 ? '大きく高まった' : '大きく損なわれた');
  });
  return 'その生涯を通じて、' + parts.join('、') + '。';
}

// 転生準備で選んだ持込アイテムについて、実際に使われたかどうかまで含めて
// 一文にする。「与えたものが期待どおり使われるとは限らない」ことを、
// 死亡時要約からも読み取れるようにするための処理。
function startingItemPhrase(character, name, itemsDef) {
  if (!character.startingItem || !itemsDef) return null;
  var item = itemsDef.filter(function (i) { return i.id === character.startingItem; })[0];
  var label = item ? item.label : character.startingItem;
  var firstUsedAge = character.itemFirstUsedAge ? character.itemFirstUsedAge[character.startingItem] : undefined;
  var itemState = character.itemState ? character.itemState[character.startingItem] : undefined;

  if (firstUsedAge === undefined) {
    return name + 'は「' + label + '」を持って転生したが、生涯一度も使うことはなかった。';
  }
  if (itemState && itemState.consumed) {
    return name + 'は「' + label + '」を' + firstUsedAge + '歳の時に初めて役立て、最後には使い切った。';
  }
  return name + 'は「' + label + '」を' + firstUsedAge + '歳の時に役立てた。';
}

function startingSkillPhrase(character, name, skillsDef) {
  if (!character.startingSkill || !skillsDef) return null;
  var skill = skillsDef.filter(function (s) { return s.id === character.startingSkill; })[0];
  var label = skill ? skill.label : character.startingSkill;
  return name + 'は「' + label + '」の心得を持って転生した。';
}

function burdenPhrase(character, name, burdensDef) {
  if (!character.burden || !burdensDef) return null;
  var burden = burdensDef.filter(function (b) { return b.id === character.burden; })[0];
  var label = burden ? burden.label : character.burden;
  return name + 'は「' + label + '」という定めを背負って転生した。';
}

// LLMを使わず、死因・実績タグ・生涯目標・特殊要素・転生準備の持込・世界への影響・
// 支配的な性格からテンプレート文を組み合わせて人生要約を生成する
// （イベントログと状態のみを情報源とする）。itemsDef/skillsDef/burdensDef は
// game-data/items.json,skills.json,burdens.json 相当の配列で、省略時はその項目を省く。
export function generateSummary(character, relations, deathInfo, occupations, traitsDef, deathCauseLabels, itemsDef, skillsDef, burdensDef) {
  var name = character.name;
  var parts = [];
  parts.push(name + 'は' + character.age + '歳で、' + deathCauseLabels[deathInfo.cause] + 'によりその生涯を閉じた。');
  parts.push('最終的な身分は「' + occupations[character.occupation] + '」であった。');

  if (character.elements.length > 0) {
    var elementLabels = character.elements.map(function (id) { return ELEMENT_PHRASES[id] || id; });
    parts.push(name + 'は「' + elementLabels.join('」「') + '」を宿して転生した。');
  }

  var burdenLine = burdenPhrase(character, name, burdensDef);
  if (burdenLine) parts.push(burdenLine);
  var itemLine = startingItemPhrase(character, name, itemsDef);
  if (itemLine) parts.push(itemLine);
  var skillLine = startingSkillPhrase(character, name, skillsDef);
  if (skillLine) parts.push(skillLine);

  if (character.goal) {
    var phrase = GOAL_STATUS_PHRASES[character.goal.status] || GOAL_STATUS_PHRASES.active;
    parts.push(fillName(phrase.split('{goal}').join(character.goal.label), name));
  }

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

  var impact = worldImpactPhrase(character);
  if (impact) parts.push(impact);

  var rank = determineLifeRank(character);
  parts.push('後世の評価: ' + lifeRankLabel(rank) + '。');

  return parts.join('\n');
}

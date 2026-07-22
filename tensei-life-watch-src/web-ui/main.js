import {
  buildDataBundle, generateCharacter, simulateYear, generateSummary, runBatchSimulation,
  applyStartingGrants, isItemSelectable, determineLifeRank, lifeRankLabel,
  freshDiscoveries, recordLifeDiscoveries, isItemUnlocked, isSkillUnlocked, isBurdenUnlocked, buildLifeRecord,
  restoreDiscoveriesFromPastLives, summarizeWorldImpact,
  TAG_SHORT_LABELS
} from '../game-engine/index.js';

// escapeHtml は game-engine に無いため、ここでのみ小さく定義する（描画専用のUIヘルパー）。
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; });
}

var SCHEMA_VERSION = 7;
var STORAGE_KEY = 'tenseiLifeWatch:v1';
var MAX_OFFLINE_YEARS = 300;

var ELEMENT_LABELS = {
  modern_knowledge: '前世の現代知識', divine_mission: '神から与えられた使命', cursed_soul: '魂に刻まれた呪い',
  magic_affinity: '異常な魔法適性', monster_affinity: '魔物との親和性', hero_mark: '勇者候補の証',
  demon_mark: '魔王候補の証', past_life_memory: '前世の記憶', return_desire: '帰還願望'
};

var GOAL_STATUS_LABELS = { active: '追求中', completed: '達成', abandoned: '放棄', failed: '未達成', distorted: '変質' };

var SPEEDS = [
  { id: 'slow', label: '遅い', yearMs: 8000 },
  { id: 'normal', label: '標準', yearMs: 3000 },
  { id: 'fast', label: '速い', yearMs: 900 }
];

var data = null;
var state = null;
var timerHandle = null;
var isPlaying = false;
var currentTab = 'observe';
var currentLogFilter = 'all';
var encyclopediaSubTab = 'lives';
var encyclopediaDetailIndex = null;
// 発見項目タブのチップから「この項目を含む過去人生だけ見る」ボタンとして
// 遷移してきた場合の絞り込み条件（issue #20: 発見項目と過去人生一覧を
// 相互参照しやすくする）。{ category, id, label } またはnull。
var encyclopediaLifeFilter = null;

async function loadJson(path) {
  var res = await fetch(path);
  if (!res.ok) throw new Error('failed to load ' + path);
  return res.json();
}

async function loadData() {
  var base = new URL('../game-data/', import.meta.url);
  var traits = await loadJson(new URL('traits.json', base));
  var occupations = await loadJson(new URL('occupations.json', base));
  var world = await loadJson(new URL('world.json', base));
  var events = await loadJson(new URL('events.json', base));
  var elements = await loadJson(new URL('elements.json', base));
  var goals = await loadJson(new URL('goals.json', base));
  var items = await loadJson(new URL('items.json', base));
  var skills = await loadJson(new URL('skills.json', base));
  var burdens = await loadJson(new URL('burdens.json', base));
  return buildDataBundle(traits, occupations, world, events, elements, goals, items, skills, burdens);
}

function freshWorld() {
  return Object.assign({}, data.initialWorld);
}

function freshPendingGrants() {
  return { itemId: null, skillId: null, burdenId: null };
}

function freshState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    world: freshWorld(),
    character: null,
    candidate: generateCharacter(data),
    pendingGrants: freshPendingGrants(),
    relations: [],
    log: [],
    lifetimeCount: 0,
    pastLives: [],
    discoveries: freshDiscoveries(),
    // まだ一度も保存していないことが分かるようnullにする（保存状態表示が
    // 「最終保存: 現在時刻」という実態と異なる表示にならないようにする、
    // issue #23）。saveState()が呼ばれた時点で実際の保存時刻に置き換わる。
    lastSavedAt: null,
    speedIndex: 1
  };
}

function formatSavedAt(ts, fmt) {
  if (typeof ts !== 'number') return '未保存';
  return new Date(ts)[fmt]('ja-JP');
}

// schemaVersion 1 (要素/生涯目標/世界状態の拡張前)、2 (worldImpact集計の追加前)、
// 3 (転生準備フェーズの追加前)、4 (itemOutcome状態モデルの追加前)、
// 5 (暦のdriftWorld混入バグ修正前)、6 (転生記録図鑑・発見/段階解禁の追加前) の
// 保存データを、新しいフィールドを補いながら壊さずに引き継ぐ。
function migrateCharacter(character) {
  if (!character) return character;
  if (!Array.isArray(character.elements)) character.elements = [];
  if (character.goal === undefined) character.goal = null;
  if (typeof character.fame !== 'number') character.fame = 0;
  if (!character.worldImpact || typeof character.worldImpact !== 'object') character.worldImpact = {};
  if (character.startingItem === undefined) character.startingItem = null;
  if (character.startingSkill === undefined) character.startingSkill = null;
  if (character.burden === undefined) character.burden = null;
  if (!character.itemState || typeof character.itemState !== 'object') character.itemState = {};
  if (!character.itemFirstUsedAge || typeof character.itemFirstUsedAge !== 'object') character.itemFirstUsedAge = {};
  if (!character.itemOutcome || typeof character.itemOutcome !== 'object') {
    // schemaVersion 4以前は「使った/使わなかった」の2値しか持たず、喪失・拒絶を
    // 区別できていなかった。旧データからは正確に復元できないため、既に何らかの
    // 接触があった場合は安全側（否定的な結果ではない）の 'used' として引き継ぐ。
    var itemId = character.startingItem;
    var status = 'unused', age = null;
    if (itemId) {
      var state = character.itemState[itemId];
      var touchedAge = character.itemFirstUsedAge[itemId];
      if (state && state.consumed) { status = 'consumed'; age = touchedAge !== undefined ? touchedAge : null; }
      else if (character.flags && character.flags.indexOf('item_silver_purse_lost') >= 0 && itemId === 'silver_purse') {
        status = 'lost'; age = touchedAge !== undefined ? touchedAge : null;
      } else if (touchedAge !== undefined) { status = 'used'; age = touchedAge; }
    }
    character.itemOutcome = { status: status, age: age };
  }
  return character;
}

function migrateWorld(world) {
  if (!world) return world;
  Object.keys(data.initialWorld).forEach(function (key) {
    if (typeof world[key] !== 'number') world[key] = data.initialWorld[key];
  });
  // schemaVersion 5以前は driftWorld() が yearEra（暦）まで「初期値へ回帰する
  // 世界統計」として扱ってしまい、暦が毎年0へ引き戻され小数化するバグ
  // （issue #11）があった。既存セーブに残った小数・負値を整数へ丸めて引き継ぐ
  // （巻き戻り自体は今後発生しなくなるが、既に汚染された値の見た目は直せないため
  // 四捨五入のみ行う）。
  if (typeof world.yearEra === 'number') {
    world.yearEra = Math.max(0, Math.round(world.yearEra));
  }
  return world;
}

function migrateState(raw) {
  if (raw.schemaVersion >= 1 && raw.schemaVersion < SCHEMA_VERSION) {
    migrateCharacter(raw.character);
    migrateCharacter(raw.candidate);
    migrateWorld(raw.world);
    if (!raw.pendingGrants) raw.pendingGrants = freshPendingGrants();
    // schemaVersion 6以前のセーブには discoveries（転生記録図鑑の発見状況）が
    // 存在しない。既存のpastLives（過去人生一覧）から復元可能な範囲を
    // ここで一度だけ積み上げる（issue #15）。この分岐に入るのは
    // schemaVersion が初めて7未満から7へ上がる移行の瞬間だけなので、
    // 同じセーブを何度読み込んでも二重加算にはならない。
    if (!raw.discoveries || typeof raw.discoveries !== 'object') {
      raw.discoveries = freshDiscoveries();
      restoreDiscoveriesFromPastLives(raw.discoveries, raw.pastLives, data.occupations, data.deathCauseLabels);
    }
    raw.schemaVersion = SCHEMA_VERSION;
  }
  return raw;
}

function sanitizeLoaded(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < 1 || raw.schemaVersion > SCHEMA_VERSION) return null;
  try {
    raw = migrateState(raw);
    if (raw.character) {
      data.abilities.forEach(function (a) { if (typeof raw.character.abilities[a.id] !== 'number') throw new Error('bad'); });
      data.traits.forEach(function (t) { if (typeof raw.character.traits[t.id] !== 'number') throw new Error('bad'); });
    }
    return raw;
  } catch (e) {
    return null;
  }
}

// localStorageが無効化・使用不可（プライベートブラウズ、容量超過、アクセス
// 拒否等）な環境でも画面が壊れないよう、読み込み・保存はどちらもtry/catchで
// 包み、失敗時は「保存されない」ことを明示した上でメモリ上の状態だけで
// 続行する（issue #23）。
var lastSaveOk = true;

function loadState() {
  // getItem()自体が例外を投げる場合（プライベートブラウズ等でlocalStorageへの
  // アクセスそのものがブロックされている）と、JSON.parse()だけが例外を投げる
  // 場合（アクセスはできるが保存データの中身が壊れている）を区別する。前者は
  // 今後の書き込みもほぼ確実に失敗するため lastSaveOk を直ちに false へ同期し、
  // ヘッダーの保存状態表示が「まだ保存されていません」という誤った印象を
  // 与えないようにする。後者はストレージ自体は生きているため、書き込みは
  // 通常どおり試みられる想定で lastSaveOk はtrueのままにする（レビュー対応）。
  var text = null;
  try {
    text = window.localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    lastSaveOk = false;
    addBanner('保存データの読み込みに失敗したため、新しく開始します。', 'warn');
    return freshState();
  }
  var raw = null;
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      addBanner('保存データの読み込みに失敗したため、新しく開始します。', 'warn');
      return freshState();
    }
  }
  if (!raw) return freshState();
  var loadedVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : null;
  var sanitized = sanitizeLoaded(raw);
  if (!sanitized) {
    addBanner('保存データが壊れていたため、新しく開始します。', 'warn');
    return freshState();
  }
  if (loadedVersion !== null && loadedVersion < SCHEMA_VERSION) {
    addBanner('セーブデータを最新の形式に更新しました。', 'info');
  }
  if (!sanitized.candidate) sanitized.candidate = generateCharacter(data);
  if (!sanitized.pendingGrants) sanitized.pendingGrants = freshPendingGrants();
  if (!sanitized.pastLives) sanitized.pastLives = [];
  if (!sanitized.discoveries || typeof sanitized.discoveries !== 'object') sanitized.discoveries = freshDiscoveries();
  if (typeof sanitized.speedIndex !== 'number') sanitized.speedIndex = 1;
  return sanitized;
}

function saveState() {
  // 失敗時にlastSavedAtだけ進んで「保存できていないのに保存時刻が更新される」
  // という虚偽表示にならないよう、成功した場合だけ確定させる。また自動再生中は
  // 毎年advanceOneYearからsaveStateが呼ばれるため、失敗バナーは状態が変化した
  // 瞬間だけ出す（失敗し続けている間、年数分積み増され続けるのを防ぐ）。
  var previousSavedAt = state.lastSavedAt;
  var wasOk = lastSaveOk;
  state.lastSavedAt = Date.now();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastSaveOk = true;
  } catch (e) {
    state.lastSavedAt = previousSavedAt;
    lastSaveOk = false;
    if (wasOk) addBanner('保存に失敗しました。この端末には保存されません。', 'warn');
  }
  renderSaveStatus();
}

function renderSaveStatus() {
  var el = document.getElementById('saveStatusLine');
  if (!el) return;
  if (!lastSaveOk) {
    el.textContent = '保存失敗（この端末には保存されていません）';
    el.classList.add('save-error');
    return;
  }
  el.classList.remove('save-error');
  el.textContent = typeof state.lastSavedAt === 'number'
    ? '最終保存: ' + formatSavedAt(state.lastSavedAt, 'toLocaleTimeString')
    : 'まだ保存されていません';
}

// 起動時の複数の状態通知（移行・破損復旧・オフライン経過など）を、互いを
// 消さずに積み増して並べて出せるようにする（issue #23）。
function addBanner(msg, type) {
  var box = document.getElementById('bannerBox');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', '<div class="banner ' + (type || 'info') + '">' + esc(msg) + '</div>');
}
function clearBanner() {
  document.getElementById('bannerBox').innerHTML = '';
}

function catchUpOffline() {
  if (!state.character || !state.character.alive) return;
  var elapsedMs = Date.now() - (state.lastSavedAt || Date.now());
  var yearMs = SPEEDS[state.speedIndex].yearMs;
  var elapsedYears = Math.floor(elapsedMs / yearMs);
  if (elapsedYears <= 0) return;
  var years = Math.min(elapsedYears, MAX_OFFLINE_YEARS);
  var majorLogs = [];
  var processed = 0;
  for (var i = 0; i < years; i++) {
    var result = simulateYear(state, data);
    state.log = state.log.concat(result.logs);
    result.logs.forEach(function (l) { if (l.importance !== 'minor') majorLogs.push(l); });
    processed++;
    if (result.died) { finishLife(result.deathInfo); break; }
  }
  if (processed > 0) {
    var msg = '不在の間に約' + processed + '年が経過しました。';
    if (majorLogs.length > 0) {
      msg += '（主な出来事: ' + majorLogs.slice(-3).map(function (l) { return l.text; }).join(' / ') + '）';
    }
    addBanner(msg, 'info');
  }
}

function startLife() {
  // discoveries を渡し、保存データの改変やUIの見落としで未解禁の持込・
  // スキル・制約が付与されてしまう経路をエンジン側でも塞ぐ（issue #9）。
  applyStartingGrants(state.candidate, data, state.pendingGrants, state.discoveries);
  state.character = state.candidate;
  state.relations = [];
  state.log = [{
    year: state.world.yearEra, age: 0, eventId: 'birth', choiceId: 'birth',
    text: state.character.name + 'が' + state.character.region + 'に転生した。',
    importance: 'historic', turningPoints: [{ type: 'birth' }]
  }];
  state.lifetimeCount += 1;
  saveState();
  renderAll();
}

// state.log はその人生専用（startLifeで毎回リセットされる）なので、ここで
// 集計すればそのまま「このライフで各イベントが何回発生したか」になる。
function tallyEventCounts(log) {
  var counts = {};
  log.forEach(function (l) { counts[l.eventId] = (counts[l.eventId] || 0) + 1; });
  return counts;
}

function finishLife(deathInfo) {
  isPlaying = false;
  stopTimer();
  var summary = generateSummary(
    state.character, state.relations, deathInfo, data.occupations, data.traits, data.deathCauseLabels,
    data.items, data.skills, data.burdens
  );
  var lifeRank = determineLifeRank(state.character);
  var record = buildLifeRecord(state.character, state.relations, deathInfo, lifeRank, state.log);
  // 過去人生一覧（既存の簡易表示）は職業・死因をラベル済み文字列として使う。
  // buildLifeRecordはエンジン側の純粋関数のためIDのまま持たせているので、
  // ここでラベルを解決して両方の用途に使える1つのレコードにする。
  record.occupationLabel = data.occupations[state.character.occupation];
  record.causeLabel = data.deathCauseLabels[deathInfo.cause];
  state.pastLives.unshift(record);
  if (state.pastLives.length > 20) state.pastLives.length = 20;
  // 発見状況は転生記録図鑑・段階解禁の元になる、生涯をまたいで蓄積し続ける
  // 状態。過去人生一覧を20件までに切り詰めても、ここは一切減らない。
  recordLifeDiscoveries(state.discoveries, state.character, deathInfo, tallyEventCounts(state.log));
  state.lastDeathSummary = summary;
  state.lastDeathInfo = deathInfo;
  state.candidate = generateCharacter(data);
  state.pendingGrants = freshPendingGrants();
  state.character.alive = false;
  saveState();
  renderAll();
}

function nextLife() {
  state.character = null;
  saveState();
  renderAll();
}

function advanceOneYear() {
  if (!state.character || !state.character.alive) return;
  var result = simulateYear(state, data);
  state.log = state.log.concat(result.logs);
  if (result.died) {
    finishLife(result.deathInfo);
    return;
  }
  saveState();
  renderAll();
}

function rerollCandidate() {
  state.candidate = generateCharacter(data);
  state.pendingGrants = freshPendingGrants();
  saveState();
  renderStart();
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
function startTimer() {
  stopTimer();
  timerHandle = setInterval(function () {
    if (!isPlaying) return;
    advanceOneYear();
  }, SPEEDS[state.speedIndex].yearMs);
}

/* ---- 転生準備（アイテム/スキル/制約）選択 ---- */

function selectItem(itemId) {
  var next = state.pendingGrants.itemId === itemId ? null : itemId;
  if (next) {
    var item = data.items.filter(function (i) { return i.id === next; })[0];
    if (!isItemSelectable(item, state.pendingGrants.burdenId)) return; // 制約未選択のため選べない
    if (!isItemUnlocked(item, state.discoveries)) return; // まだ発見条件を満たしていない
  }
  state.pendingGrants.itemId = next;
  saveState();
  renderStart();
}
function selectSkill(skillId) {
  var next = state.pendingGrants.skillId === skillId ? null : skillId;
  if (next) {
    var skill = data.skills.filter(function (s) { return s.id === next; })[0];
    if (!isSkillUnlocked(skill, state.discoveries)) return;
  }
  state.pendingGrants.skillId = next;
  saveState();
  renderStart();
}
function selectBurden(burdenId) {
  var next = state.pendingGrants.burdenId === burdenId ? null : burdenId;
  if (next) {
    var burdenDef = data.burdens.filter(function (b) { return b.id === next; })[0];
    if (!isBurdenUnlocked(burdenDef, state.discoveries)) return;
  }
  state.pendingGrants.burdenId = next;
  // 制約を外したことで選択中のアイテムが選べなくなる場合は、選択を解除する。
  if (state.pendingGrants.itemId) {
    var item = data.items.filter(function (i) { return i.id === state.pendingGrants.itemId; })[0];
    if (!isItemSelectable(item, state.pendingGrants.burdenId)) state.pendingGrants.itemId = null;
  }
  saveState();
  renderStart();
}

/* ---- 描画 ---- */

function abilityBarHtml(def, val) {
  return '<div class="bar-item"><span class="label">' + def.label + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + val + '%"></span></span>' +
    '<span class="val">' + val + '</span></div>';
}

function pastLifeAge(p) { return p.lifespan !== undefined ? p.lifespan : p.age; }
function pastLifeOccupationLabel(p) { return p.occupationLabel || p.occupation; }
function pastLifeCauseLabel(p) { return p.causeLabel || p.cause; }

function pastLivesHtml(list) {
  return list.map(function (p) {
    return '<div class="pastlife"><span><b>' + esc(p.name) + '</b>（' + esc(pastLifeOccupationLabel(p)) + '）</span><span>享年' + pastLifeAge(p) + '歳・' + esc(pastLifeCauseLabel(p)) + '</span></div>';
  }).join('');
}

// indicesを渡した場合はその添字だけを描画する（絞り込み表示用）。
// data-life-indexは常にpastLives（絞り込み前の全件配列）に対する添字を
// 指すため、詳細画面へ渡す際に絞り込みの有無で意味がずれることはない。
function encyclopediaListHtml(pastLives, indices) {
  var idxList = indices || pastLives.map(function (_, i) { return i; });
  return idxList.map(function (i) {
    var p = pastLives[i];
    return '<button type="button" class="pastlife pastlife-btn" data-life-index="' + i + '">' +
      '<span><b>' + esc(p.name) + '</b>（' + esc(pastLifeOccupationLabel(p)) + '）</span>' +
      '<span>享年' + pastLifeAge(p) + '歳・' + esc(pastLifeCauseLabel(p)) + '</span></button>';
  }).join('');
}

// 発見項目タブのチップから遷移してきた絞り込み条件に、1件の過去人生が
// 合致するかどうかを判定する。schemaVersion 6以前の簡易レコード
// （p.elements === undefined）は職業・死因のラベル文字列しか持たないため、
// それ以外のカテゴリでは合致しようがない（推測で一致させない）。
function pastLifeMatchesFilter(p, filter) {
  if (!filter) return true;
  if (p.elements === undefined) {
    if (filter.category === 'occupations') return pastLifeOccupationLabel(p) === filter.label;
    if (filter.category === 'deathCauses') return pastLifeCauseLabel(p) === filter.label;
    return false;
  }
  if (filter.category === 'elements') return (p.elements || []).indexOf(filter.id) >= 0;
  if (filter.category === 'goals') return !!(p.goal && p.goal.id === filter.id);
  if (filter.category === 'occupations') return p.occupation === filter.id;
  if (filter.category === 'deathCauses') return p.deathCause === filter.id;
  if (filter.category === 'tags') return (p.tags || []).indexOf(filter.id) >= 0;
  return false;
}

function lifeDetailHtml(p) {
  if (p.elements === undefined) {
    // schemaVersion 6以前の簡易レコードには詳細情報が無い。
    return '<div class="empty">この人生は詳細記録の追加より前のものです。</div>';
  }
  var parts = [];
  parts.push('<div class="rowline"><span class="k">名前</span><span class="v">' + esc(p.name) + '（' + esc(p.genderLabel || '') + '）</span></div>');
  parts.push('<div class="rowline"><span class="k">出身</span><span class="v">' + esc(p.region || '') + '</span></div>');
  parts.push('<div class="rowline"><span class="k">享年</span><span class="v">' + pastLifeAge(p) + '歳</span></div>');
  parts.push('<div class="rowline"><span class="k">最終職業</span><span class="v">' + esc(pastLifeOccupationLabel(p)) + '</span></div>');
  parts.push('<div class="rowline"><span class="k">死因/結末</span><span class="v">' + esc(pastLifeCauseLabel(p)) + '</span></div>');
  if (p.lifeRank) parts.push('<div class="rowline"><span class="k">人生ランク</span><span class="v">' + esc(lifeRankLabel(p.lifeRank)) + '</span></div>');
  if (p.elements && p.elements.length > 0) {
    parts.push('<div class="rowline"><span class="k">特殊要素</span><span class="v">' +
      p.elements.map(function (id) { return esc(ELEMENT_LABELS[id] || id); }).join('、') + '</span></div>');
  }
  if (p.goal) {
    parts.push('<div class="rowline"><span class="k">生涯目標</span><span class="v">' +
      esc(p.goal.label) + '（' + esc(GOAL_STATUS_LABELS[p.goal.status] || p.goal.status) + '）</span></div>');
  }
  var itemLabel = p.startingItem ? (data.items.filter(function (i) { return i.id === p.startingItem; })[0] || {}).label : null;
  if (itemLabel) {
    var outcomeText = p.itemOutcome ? ({
      unused: '未使用', used: '活用', consumed: '使い切った', lost: '喪失', rejected: '使用を見送った'
    }[p.itemOutcome.status] || p.itemOutcome.status) : '';
    parts.push('<div class="rowline"><span class="k">持込アイテム</span><span class="v">' + esc(itemLabel) + '（' + esc(outcomeText) + '）</span></div>');
  }
  var skillLabel = p.startingSkill ? (data.skills.filter(function (s) { return s.id === p.startingSkill; })[0] || {}).label : null;
  if (skillLabel) parts.push('<div class="rowline"><span class="k">初期スキル</span><span class="v">' + esc(skillLabel) + '</span></div>');
  var burdenLabel = p.burden ? (data.burdens.filter(function (b) { return b.id === p.burden; })[0] || {}).label : null;
  if (burdenLabel) parts.push('<div class="rowline"><span class="k">制約</span><span class="v">' + esc(burdenLabel) + '</span></div>');
  if (p.tags && p.tags.length > 0) {
    parts.push('<div class="relchips" style="margin-top:8px">' + p.tags.map(function (id) {
      return '<span class="chip"><b>' + esc(TAG_SHORT_LABELS[id] || id) + '</b></span>';
    }).join('') + '</div>');
  }
  if (p.relations && p.relations.length > 0) {
    parts.push('<div class="relchips" style="margin-top:8px">' + p.relations.map(function (r) {
      return '<span class="chip"><b>' + esc(r.name) + '</b>' + esc(r.role) + '</span>';
    }).join('') + '</div>');
  }
  var logEntries = pastLifeLogEntries(p);
  if (logEntries.length > 0) {
    parts.push('<div class="loglist" style="margin-top:8px">' + logListHtml(logEntries) + '</div>');
  }
  return parts.join('');
}

// historicEvents（重要度'historic'のログ）と turningEvents（それ以外で
// 転機を持つログ）は互いに排他（buildLifeRecord側でhistoricを除外して
// 作っている）なので、単純に連結して時系列に並べ直すだけで重複なく
// 一体のタイムラインになる。turningEvents が無い旧セーブ（issue #24より
// 前に記録された過去人生）では historicEvents のみになり、従来どおりの
// 表示にフォールバックする。
function pastLifeLogEntries(p) {
  var historic = p.historicEvents || [];
  var turning = p.turningEvents || [];
  return historic.concat(turning).sort(function (a, b) {
    if (a.year !== b.year) return a.year - b.year;
    return a.age - b.age;
  });
}

// 生涯目標の形成/進捗/決着・職業・関係・世界影響・死という「転機」の
// 種類ごとの短いバッジ文言を組み立てる。エンジン側(time-processor.js)が
// 既に「実際に何が変化したか」を構造化データ(turningPoints)として渡して
// くるため、ここではテキストのパターンマッチではなく型に基づいて表示する
// （issue #24: 転機を機械的かつ確実に目立たせるための設計）。
var GOAL_TURNING_LABELS = {
  formed: '目標形成', progress: '目標前進', completed: '目標達成',
  failed: '目標未達成', abandoned: '目標断念', distorted: '目標変容'
};
var RELATION_TURNING_LABELS = { added: '出会い', removed: '離別', promoted: '関係進展' };

function turningPointLabel(tp) {
  if (tp.type === 'goal') {
    var goalKind = GOAL_TURNING_LABELS[tp.kind] || '目標変化';
    return goalKind + (tp.label ? '「' + esc(tp.label) + '」' : '');
  }
  if (tp.type === 'occupation') {
    var fromLabel = (data.occupations && data.occupations[tp.from]) || tp.from;
    var toLabel = (data.occupations && data.occupations[tp.to]) || tp.to;
    return '転職: ' + esc(fromLabel) + '→' + esc(toLabel);
  }
  if (tp.type === 'relation') {
    var relKind = RELATION_TURNING_LABELS[tp.kind] || '関係変化';
    return relKind + ': ' + esc(tp.name) + (tp.role ? '（' + esc(tp.role) + '）' : '');
  }
  if (tp.type === 'world') {
    return '世界: ' + tp.deltas.map(function (d) { return esc(d.label) + (d.diff > 0 ? '↑' : '↓'); }).join(' ');
  }
  if (tp.type === 'death') return '生涯の終わり: ' + esc(tp.label || '');
  if (tp.type === 'birth') return '転生';
  return '';
}

function turningPointsHtml(points) {
  if (!points || points.length === 0) return '';
  return '<div class="tpbadges">' + points.map(function (tp) {
    return '<span class="tpbadge tp-' + esc(tp.type) + '">' + turningPointLabel(tp) + '</span>';
  }).join('') + '</div>';
}

function logListHtml(entries) {
  return entries.map(function (l) {
    var points = l.turningPoints || [];
    var cls = 'logentry ' + l.importance + (points.length > 0 ? ' turning' : '');
    return '<div class="' + cls + '"><div class="meta">暦' + l.year + '年 / ' + l.age + '歳</div><div class="txt">' + esc(l.text) + '</div>' + turningPointsHtml(points) + '</div>';
  }).join('');
}

// currentTab（JS側の選択状態）と、タブボタンの見た目・aria-selected・
// tabindexを一致させる。タブクリック以外の経路（初期化ボタン等）で
// currentTabを直接書き換えた場合にも呼び、両者が食い違わないようにする。
// ARIAタブパターンではロービングtabindex（選択中のみ0、他は-1）が必須で、
// これが無いとスクリーンリーダーには「タブ」と通知されるのに矢印キーでの
// 移動ができない、という意味論と操作の不一致が生じる（issue #25レビュー対応）。
function syncTabButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('#tabNav button'), function (b) {
    var isSelected = b.getAttribute('data-tab') === currentTab;
    b.classList.toggle('active', isSelected);
    b.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    b.setAttribute('tabindex', isSelected ? '0' : '-1');
  });
}

// ARIAタブの自動アクティベーション（フォーカス移動＝選択切替）で
// ArrowLeft/ArrowRight/Home/Endに対応する。ロービングtabindexにより
// Tabキーでは選択中の1つにしか止まらず、タブ間の移動は矢印キーで行う。
function moveTabFocus(key) {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('#tabNav button'));
  var currentIndex = -1;
  buttons.forEach(function (b, i) { if (b.getAttribute('data-tab') === currentTab) currentIndex = i; });
  if (currentIndex === -1) return;
  var nextIndex = currentIndex;
  if (key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length;
  else if (key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
  else if (key === 'Home') nextIndex = 0;
  else if (key === 'End') nextIndex = buttons.length - 1;
  else return;
  currentTab = buttons[nextIndex].getAttribute('data-tab');
  syncTabButtons();
  renderAll();
  buttons[nextIndex].focus();
}

function renderAll() {
  document.getElementById('genLine').textContent = '第' + (state.lifetimeCount || 1) + '転生 / 暦' + Math.round(state.world.yearEra) + '年';

  var hasLiving = state.character && state.character.alive;
  var showDeath = state.character && !state.character.alive;

  document.getElementById('tabNav').hidden = !hasLiving;
  document.getElementById('screenStart').hidden = !!state.character;
  document.getElementById('screenDeath').hidden = !showDeath;
  document.getElementById('screenObserve').hidden = !(hasLiving && currentTab === 'observe');
  document.getElementById('screenLog').hidden = !(hasLiving && currentTab === 'log');
  document.getElementById('screenWorld').hidden = !(hasLiving && currentTab === 'world');
  document.getElementById('screenEncyclopedia').hidden = !(hasLiving && currentTab === 'encyclopedia');

  if (!state.character) renderStart();
  if (showDeath) renderDeath();
  if (hasLiving) {
    renderObserve();
    renderLog();
    renderWorld();
    if (currentTab === 'encyclopedia') renderEncyclopedia();
  }
}

function prepCardHtml(def, kind, selectedId, locked, lockNote) {
  var isActive = selectedId === def.id;
  var classes = 'prepcard' + (isActive ? ' active' : '') + (locked ? ' locked' : '');
  var html = '<button type="button" class="' + classes + '" data-' + kind + '="' + esc(def.id) + '" aria-pressed="' + (isActive ? 'true' : 'false') + '"' + (locked ? ' disabled' : '') + '>';
  html += '<div class="pc-title"><span>' + esc(def.label) + '</span>' + (isActive ? '<span class="pc-selected">選択中</span>' : '') + '</div>';
  html += '<div class="pc-desc">' + esc(def.description) + '</div>';
  if (def.benefit) html += '<div class="pc-benefit">恩恵: ' + esc(def.benefit) + '</div>';
  if (def.risk && def.risk !== '特になし。') html += '<div class="pc-risk">注意: ' + esc(def.risk) + '</div>';
  if (locked) html += '<div class="pc-note">※ ' + esc(lockNote || '選べません') + '</div>';
  html += '</button>';
  return html;
}

function noneCardHtml(kind, selectedId, label) {
  var isActive = !selectedId;
  return '<button type="button" class="prepcard' + (isActive ? ' active' : '') + '" data-' + kind + '="none" aria-pressed="' + (isActive ? 'true' : 'false') + '">' +
    '<div class="pc-title"><span>' + esc(label || 'なし') + '</span>' + (isActive ? '<span class="pc-selected">選択中</span>' : '') + '</div>' +
    '<div class="pc-desc">何も持ち込まない。</div>' +
    '</button>';
}

// requiresBurden指定のアイテム（例: silver_purse）は発見条件（discoveries）
// を満たしていても、同じ転生準備セッション内で制約を1つ選んでいなければ
// 選択できない。この文言は図鑑側の解禁状況表示（unlockListHtml）でも
// そのまま再利用し、両画面で説明が食い違わないようにする（issue #20）。
var BURDEN_REQUIRED_NOTE = '制約を1つ選ぶと持ち込めるようになる';

function renderPrepSection() {
  var grants = state.pendingGrants;

  var itemHtml = noneCardHtml('item', grants.itemId, '持ち込まない');
  itemHtml += data.items.map(function (item) {
    var burdenLocked = !isItemSelectable(item, grants.burdenId);
    var undiscovered = !isItemUnlocked(item, state.discoveries);
    var note = undiscovered ? (item.unlockHint || 'まだ発見条件を満たしていない。') : BURDEN_REQUIRED_NOTE;
    return prepCardHtml(item, 'item', grants.itemId, burdenLocked || undiscovered, note);
  }).join('');
  document.getElementById('itemChoiceList').innerHTML = itemHtml;

  var skillHtml = noneCardHtml('skill', grants.skillId, '身につけない');
  skillHtml += data.skills.map(function (skill) {
    var undiscovered = !isSkillUnlocked(skill, state.discoveries);
    return prepCardHtml(skill, 'skill', grants.skillId, undiscovered, skill.unlockHint || 'まだ発見条件を満たしていない。');
  }).join('');
  document.getElementById('skillChoiceList').innerHTML = skillHtml;

  var burdenHtml = noneCardHtml('burden', grants.burdenId, '背負わない');
  burdenHtml += data.burdens.map(function (b) {
    var undiscovered = !isBurdenUnlocked(b, state.discoveries);
    return prepCardHtml(b, 'burden', grants.burdenId, undiscovered, b.unlockHint || 'まだ発見条件を満たしていない。');
  }).join('');
  document.getElementById('burdenChoiceList').innerHTML = burdenHtml;

  var itemLabel = grants.itemId ? (data.items.filter(function (i) { return i.id === grants.itemId; })[0] || {}).label : 'なし';
  var skillLabel = grants.skillId ? (data.skills.filter(function (s) { return s.id === grants.skillId; })[0] || {}).label : 'なし';
  var burdenLabel = grants.burdenId ? (data.burdens.filter(function (b) { return b.id === grants.burdenId; })[0] || {}).label : 'なし';
  document.getElementById('itemCurrentLabel').textContent = itemLabel || 'なし';
  document.getElementById('skillCurrentLabel').textContent = skillLabel || 'なし';
  document.getElementById('burdenCurrentLabel').textContent = burdenLabel || 'なし';

  document.getElementById('grantSummary').innerHTML =
    '<div class="rowline"><span class="k">持込アイテム</span><span class="v">' + esc(itemLabel || 'なし') + '</span></div>' +
    '<div class="rowline"><span class="k">初期スキル</span><span class="v">' + esc(skillLabel || 'なし') + '</span></div>' +
    '<div class="rowline"><span class="k">制約</span><span class="v">' + esc(burdenLabel || 'なし') + '</span></div>';
}

var introExpanded = null;
// 直近にintroExpandedの既定値を決めた時点のstate.lifetimeCount。転生準備
// 画面への「新しい滞在」（＝前の人生が終わりlifetimeCountが変わった）ごとに
// 既定値を再評価するための目印。同じ滞在中の候補者再抽選・アイテム選択の
// 再描画では変化しないため、その間はユーザーの開閉操作を保持する。
var introDecidedForLifetimeCount = null;

function renderIntro() {
  // 転生準備画面への新しい滞在（lifetimeCountが前回決定時から変わった）
  // ごとに、初めての転生前（lifetimeCount === 0）なら展開・2回目以降なら
  // 折りたたみへ既定値を再評価する。同じ滞在内の再描画（候補者再抽選など）
  // では再評価せず、トグル操作（toggleIntro）で明示的に開閉した状態を保つ。
  if (introDecidedForLifetimeCount !== state.lifetimeCount) {
    introExpanded = (state.lifetimeCount === 0);
    introDecidedForLifetimeCount = state.lifetimeCount;
  }
  document.getElementById('introBody').hidden = !introExpanded;
  document.getElementById('introToggleHint').textContent = introExpanded ? '（タップで折りたたむ）' : '（タップで表示）';
  document.getElementById('introToggleBtn').setAttribute('aria-expanded', introExpanded ? 'true' : 'false');
}

function toggleIntro() {
  introExpanded = !introExpanded;
  renderIntro();
}

function renderStart() {
  renderIntro();
  var c = state.candidate;
  var overviewHtml = '';
  overviewHtml += '<div class="rowline"><span class="k">名前</span><span class="v">' + esc(c.name) + '（' + c.genderLabel + '）</span></div>';
  overviewHtml += '<div class="rowline"><span class="k">出身</span><span class="v">' + esc(c.region) + '</span></div>';
  document.getElementById('candidateOverviewBox').innerHTML = overviewHtml;

  var detailHtml = '';
  if (c.elements.length > 0) {
    detailHtml += '<div class="relchips" style="margin-bottom:10px">' + c.elements.map(function (id) {
      return '<span class="chip"><b>' + esc(ELEMENT_LABELS[id] || id) + '</b></span>';
    }).join('') + '</div>';
  }
  detailHtml += '<div class="barlist">';
  data.abilities.forEach(function (a) { detailHtml += abilityBarHtml(a, c.abilities[a.id]); });
  detailHtml += '</div><div class="traitgrid" style="margin-top:10px">';
  data.traits.forEach(function (t) {
    var v = c.traits[t.id];
    detailHtml += '<div class="t' + (v >= 70 ? ' hi' : '') + '"><span>' + t.label + '</span><span class="tv">' + v + '</span></div>';
  });
  detailHtml += '</div>';
  document.getElementById('candidateDetailBox').innerHTML = detailHtml;

  renderPrepSection();

  var pastCard = document.getElementById('pastLivesCard');
  if (state.pastLives.length > 0) {
    pastCard.hidden = false;
    document.getElementById('pastLivesCount').textContent = '（全' + state.pastLives.length + '件）';
    document.getElementById('pastLivesList').innerHTML = pastLivesHtml(state.pastLives);
  } else {
    pastCard.hidden = true;
  }
}

// 健康を数値だけでなく文言でも示す（色だけに依存した状態表示を避けるため）。
function healthLabel(health) {
  if (health >= 70) return '良好';
  if (health >= 40) return '普通';
  if (health >= 15) return '注意';
  return '危険';
}

function renderObserve() {
  var c = state.character;
  document.getElementById('charTitle').textContent = c.name + '（' + c.genderLabel + '・' + c.age + '歳）';
  document.getElementById('ovAge').textContent = c.age + '歳';
  document.getElementById('ovOcc').textContent = data.occupations[c.occupation];
  document.getElementById('ovHealth').textContent = c.health + ' / 100（' + healthLabel(c.health) + '）';
  document.getElementById('ovMoney').textContent = c.money + ' G';
  document.getElementById('ovRegion').textContent = c.region;

  var abHtml = '';
  data.abilities.forEach(function (a) { abHtml += abilityBarHtml(a, c.abilities[a.id]); });
  document.getElementById('abilityBars').innerHTML = abHtml;

  var sortedTraits = data.traits.slice().sort(function (a, b) { return c.traits[b.id] - c.traits[a.id]; });
  var top3 = sortedTraits.slice(0, 3).map(function (t) { return t.id; });
  var trHtml = '';
  data.traits.forEach(function (t) {
    var v = c.traits[t.id];
    trHtml += '<div class="t' + (top3.indexOf(t.id) >= 0 ? ' hi' : '') + '"><span>' + t.label + '</span><span class="tv">' + v + '</span></div>';
  });
  document.getElementById('traitGrid').innerHTML = trHtml;

  var elementEmpty = document.getElementById('elementEmpty');
  if (c.elements.length === 0) {
    elementEmpty.hidden = false;
    document.getElementById('elementChips').innerHTML = '';
  } else {
    elementEmpty.hidden = true;
    document.getElementById('elementChips').innerHTML = c.elements.map(function (id) {
      return '<span class="chip"><b>' + esc(ELEMENT_LABELS[id] || id) + '</b></span>';
    }).join('');
  }
  document.getElementById('goalLine').textContent = c.goal
    ? c.goal.label + '（' + (GOAL_STATUS_LABELS[c.goal.status] || c.goal.status) + '・進捗' + c.goal.progress + '）'
    : '未形成';
  var goalProgressBox = document.getElementById('goalProgressBox');
  if (c.goal) {
    goalProgressBox.hidden = false;
    document.getElementById('goalProgressFill').style.width = c.goal.progress + '%';
    document.getElementById('goalProgressVal').textContent = c.goal.progress + '%';
  } else {
    goalProgressBox.hidden = true;
  }

  // 世界への影響（issue #17）: character.worldImpact のうち閾値以上の増減が
  // あった項目だけを、死亡時要約と同じ基準（summarizeWorldImpact）で
  // 観測中からも読み取れるようにする。色だけに頼らず「上昇/低下」を文言で示す。
  var worldImpactDeltas = summarizeWorldImpact(c);
  var worldImpactEmpty = document.getElementById('worldImpactEmpty');
  if (worldImpactDeltas.length === 0) {
    worldImpactEmpty.hidden = false;
    document.getElementById('worldImpactChips').innerHTML = '';
  } else {
    worldImpactEmpty.hidden = true;
    document.getElementById('worldImpactChips').innerHTML = worldImpactDeltas.map(function (d) {
      return '<span class="chip"><b>' + esc(d.label) + '</b>' + (d.diff > 0 ? '上昇' : '低下') + '</span>';
    }).join('');
  }

  document.getElementById('ovItem').textContent = itemStatusText(c);
  document.getElementById('ovSkill').textContent = c.startingSkill
    ? (data.skills.filter(function (s) { return s.id === c.startingSkill; })[0] || {}).label || c.startingSkill
    : 'なし';
  document.getElementById('ovBurden').textContent = c.burden
    ? (data.burdens.filter(function (b) { return b.id === c.burden; })[0] || {}).label || c.burden
    : 'なし';

  document.getElementById('relCount').textContent = '（' + state.relations.length + '人）';
  var relEmpty = document.getElementById('relEmpty');
  if (state.relations.length === 0) {
    relEmpty.hidden = false;
    document.getElementById('relChips').innerHTML = '';
  } else {
    relEmpty.hidden = true;
    document.getElementById('relChips').innerHTML = state.relations.map(function (r) {
      return '<span class="chip"><b>' + esc(r.name) + '</b>' + esc(r.role) + '</span>';
    }).join('');
  }

  var latest = state.log.slice(-5).reverse();
  document.getElementById('latestLog').innerHTML = latest.length ? logListHtml(latest) : '<div class="empty">まだ記録がない。</div>';

  document.getElementById('timeState').textContent = isPlaying ? '進行中（' + SPEEDS[state.speedIndex].label + '）' : '停止中';
  document.getElementById('playPauseBtn').textContent = isPlaying ? '一時停止' : '再生';

  document.getElementById('speedRow').innerHTML = SPEEDS.map(function (s, i) {
    return '<button class="small' + (i === state.speedIndex ? ' active' : '') + '" data-speed="' + i + '" type="button">' + s.label + '</button>';
  }).join('');
}

function itemStatusText(c) {
  if (!c.startingItem) return 'なし';
  var item = data.items.filter(function (i) { return i.id === c.startingItem; })[0];
  var label = item ? item.label : c.startingItem;
  var firstUsedAge = c.itemFirstUsedAge[c.startingItem];
  var itemState = c.itemState[c.startingItem];
  var outcome = c.itemOutcome || { status: 'unused', age: null };

  if (outcome.status === 'lost') return label + '（' + outcome.age + '歳で喪失）';
  if (outcome.status === 'rejected') return label + '（' + outcome.age + '歳で使用を見送った）';
  if (itemState) {
    if (itemState.consumed) return label + '（使い切った）';
    if (firstUsedAge !== undefined) return label + '（残り' + itemState.usesRemaining + '回・' + firstUsedAge + '歳で初使用）';
    return label + '（残り' + itemState.usesRemaining + '回・未使用）';
  }
  if (outcome.status === 'used' && firstUsedAge !== undefined) {
    return label + '（' + firstUsedAge + '歳の時に活用）';
  }
  return label + '（未使用）';
}

function renderLog() {
  document.getElementById('logSpan').textContent = '全' + state.log.length + '件';
  var filtered = state.log.slice().reverse().filter(function (l) {
    if (currentLogFilter === 'all') return true;
    if (currentLogFilter === 'major') return l.importance === 'major' || l.importance === 'historic';
    if (currentLogFilter === 'historic') return l.importance === 'historic';
    return true;
  });
  var box = document.getElementById('fullLog');
  var empty = document.getElementById('logEmpty');
  if (filtered.length === 0) {
    empty.hidden = false;
    box.innerHTML = '';
  } else {
    empty.hidden = true;
    box.innerHTML = logListHtml(filtered);
  }
}

function renderWorld() {
  var w = state.world;
  document.getElementById('wYear').textContent = Math.round(w.yearEra) + '年';
  document.getElementById('wUnrest').textContent =
    '安定' + Math.round(w.stability) + ' / 戦争' + Math.round(w.warThreat) + ' / 魔' + Math.round(w.demonThreat) +
    ' / 信仰' + Math.round(w.religiousInfluence) + ' / 技術' + Math.round(w.techLevel) + ' / 経済' + Math.round(w.economy);
  document.getElementById('wLifetimes').textContent = state.lifetimeCount + '人';
  document.getElementById('wSaved').textContent = formatSavedAt(state.lastSavedAt, 'toLocaleString');
  document.getElementById('pastLivesList2').innerHTML = state.pastLives.length ? pastLivesHtml(state.pastLives) : '<div class="empty">まだ記録がない。</div>';
}

// 発見済み/未発見のカタログをチップ一覧のHTMLへ変換する。未発見は名称を伏せ、
// 存在だけを示す（issue #9: 「未発見項目は名称を伏せるか、存在だけを示す」）。
// 発見済みチップはボタンにし、クリックすると過去人生一覧をその項目で
// 絞り込める（issue #20: 発見項目から関連する過去人生を振り返りやすくする）。
function discoveryCatalogHtml(category, catalog, discoveredMap) {
  return catalog.map(function (entry) {
    var count = discoveredMap[entry.id] || 0;
    if (count <= 0) return '<span class="chip locked"><b>？？？</b></span>';
    return '<button type="button" class="chip" data-filter-category="' + category +
      '" data-filter-id="' + esc(entry.id) + '" data-filter-label="' + esc(entry.label) +
      '"><b>' + esc(entry.label) + '</b>×' + count + '</button>';
  }).join('');
}

function discoveryRateOf(catalog, discoveredMap) {
  var total = catalog.length;
  var found = catalog.filter(function (e) { return (discoveredMap[e.id] || 0) > 0; }).length;
  return { found: found, total: total };
}

// 未発見項目そのもののネタバレにはならない範囲で、次に何を試せば出会える
// 可能性が高まるかを示す、カテゴリ単位の一般的なヒント（issue #20）。
// 個々の項目名や発生条件の詳細までは明かさない。
var DISCOVERY_HINTS = {
  elements: '特殊要素は転生のたびにランダムで宿る。多くの人物を送り込むほど出会いやすくなる。',
  goals: '生涯目標は青年期までに形成される。転生者の性格によって形成されやすい目標が変わる。',
  occupations: '実際にその職に就く人生を送ると発見できる。',
  deathCauses: 'その死に方・結末を実際に迎えると発見できる。',
  tags: '人生アークを進め、特定の結末（成功・失敗どちらも含む）へ至ると発見できる。'
};
// 戻り値はtextContentへそのまま代入する前提のプレーンテキスト（HTMLでは
// ない）ため、呼び出し側でescを挟まない。
function discoveryHintText(category, catalog, discoveredMap) {
  var hasUndiscovered = catalog.some(function (e) { return !((discoveredMap[e.id] || 0) > 0); });
  if (!hasUndiscovered || !DISCOVERY_HINTS[category]) return '';
  return 'ヒント: ' + DISCOVERY_HINTS[category];
}

// 持込アイテム・初期スキル・制約の解禁状況を図鑑側にも表示する。転生準備
// 画面と同じisXUnlocked()・unlockHintを使うため、両画面の表示が食い違う
// ことがない（issue #20: 転生準備項目の解禁条件と図鑑側の表示が矛盾しない）。
// extraNoteFnは、発見条件（unlockCondition）としては解禁済みでも、同じ
// 転生準備セッション内の別条件（例: silver_purseのrequiresBurden）で
// 選べないことがある項目向けに、転生準備画面と同一の注記を追加するための
// 任意の関数。無ければ何も付け足さない。
function unlockListHtml(list, isUnlockedFn, extraNoteFn) {
  return list.map(function (def) {
    var unlocked = isUnlockedFn(def, state.discoveries);
    var html = '<div class="prepcard' + (unlocked ? '' : ' locked') + '">' +
      '<div class="pc-title"><span>' + (unlocked ? esc(def.label) : '？？？') + '</span>' +
      (unlocked ? '<span class="pc-selected">解禁済み</span>' : '') + '</div>';
    if (unlocked) {
      html += '<div class="pc-desc">' + esc(def.description) + '</div>';
      var extra = extraNoteFn && extraNoteFn(def);
      if (extra) html += '<div class="pc-note">※ ' + esc(extra) + '</div>';
    } else {
      html += '<div class="pc-note">※ ' + esc(def.unlockHint || 'まだ解禁条件を満たしていない。') + '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
}

function renderEncyclopedia() {
  document.getElementById('encyclopediaTabLives').classList.toggle('active', encyclopediaSubTab === 'lives');
  document.getElementById('encyclopediaTabDiscovery').classList.toggle('active', encyclopediaSubTab === 'discovery');
  document.getElementById('encyclopediaLivesView').hidden = encyclopediaSubTab !== 'lives';
  document.getElementById('encyclopediaDiscoveryView').hidden = encyclopediaSubTab !== 'discovery';

  if (encyclopediaSubTab === 'lives') {
    var showDetail = encyclopediaDetailIndex !== null && state.pastLives[encyclopediaDetailIndex];
    document.getElementById('encyclopediaListCard').hidden = showDetail;
    document.getElementById('encyclopediaDetailCard').hidden = !showDetail;
    if (showDetail) {
      document.getElementById('encyclopediaDetail').innerHTML = lifeDetailHtml(state.pastLives[encyclopediaDetailIndex]);
    } else {
      var filterBox = document.getElementById('encyclopediaFilterBox');
      var matchedIndices = null;
      if (encyclopediaLifeFilter) {
        matchedIndices = [];
        state.pastLives.forEach(function (p, i) { if (pastLifeMatchesFilter(p, encyclopediaLifeFilter)) matchedIndices.push(i); });
        filterBox.hidden = false;
        document.getElementById('encyclopediaFilterLabel').textContent =
          '「' + encyclopediaLifeFilter.label + '」を含む人生のみ表示中';
      } else {
        filterBox.hidden = true;
      }
      var shownCount = matchedIndices ? matchedIndices.length : state.pastLives.length;
      document.getElementById('encyclopediaCount').textContent = matchedIndices
        ? '（' + shownCount + '件 / 全' + state.pastLives.length + '件中）'
        : '（全' + state.pastLives.length + '件）';
      var empty = document.getElementById('encyclopediaEmpty');
      if (shownCount === 0) {
        empty.hidden = false;
        empty.textContent = matchedIndices ? '該当する過去人生がない。' : 'まだ記録がない。';
        document.getElementById('encyclopediaList').innerHTML = '';
      } else {
        empty.hidden = true;
        document.getElementById('encyclopediaList').innerHTML = encyclopediaListHtml(state.pastLives, matchedIndices);
      }
    }
    return;
  }

  var d = state.discoveries;
  var elementCatalog = data.elements.filter(function (e) { return e.id !== 'none'; }).map(function (e) { return { id: e.id, label: ELEMENT_LABELS[e.id] || e.label }; });
  var goalCatalog = data.goals.map(function (g) { return { id: g.id, label: g.label }; });
  var occCatalog = Object.keys(data.occupations).map(function (id) { return { id: id, label: data.occupations[id] }; });
  var causeCatalog = Object.keys(data.deathCauseLabels).map(function (id) { return { id: id, label: data.deathCauseLabels[id] }; });
  var tagCatalog = Object.keys(TAG_SHORT_LABELS).map(function (id) { return { id: id, label: TAG_SHORT_LABELS[id] }; });
  var eventCatalog = (data.events || []).map(function (e) { return { id: e.id }; });

  var rates = [
    ['特殊要素', discoveryRateOf(elementCatalog, d.elements)],
    ['生涯目標', discoveryRateOf(goalCatalog, d.goals)],
    ['職業', discoveryRateOf(occCatalog, d.occupations)],
    ['死因', discoveryRateOf(causeCatalog, d.deathCauses)],
    ['実績・人生アークの結末', discoveryRateOf(tagCatalog, d.tags)],
    ['発生イベント', discoveryRateOf(eventCatalog, d.events)]
  ];
  document.getElementById('discoveryRateBox').innerHTML = rates.map(function (r) {
    var label = r[0], rate = r[1];
    var pct = rate.total > 0 ? Math.round((rate.found / rate.total) * 100) : 0;
    return '<div class="rowline"><span class="k">' + label + '</span><span class="v">' + rate.found + ' / ' + rate.total + '（' + pct + '%）</span></div>';
  }).join('');

  document.getElementById('discoveryElementsHint').textContent = discoveryHintText('elements', elementCatalog, d.elements);
  document.getElementById('discoveryElements').innerHTML = discoveryCatalogHtml('elements', elementCatalog, d.elements);
  document.getElementById('discoveryGoalsHint').textContent = discoveryHintText('goals', goalCatalog, d.goals);
  document.getElementById('discoveryGoals').innerHTML = discoveryCatalogHtml('goals', goalCatalog, d.goals);
  document.getElementById('discoveryOccupationsHint').textContent = discoveryHintText('occupations', occCatalog, d.occupations);
  document.getElementById('discoveryOccupations').innerHTML = discoveryCatalogHtml('occupations', occCatalog, d.occupations);
  document.getElementById('discoveryDeathCausesHint').textContent = discoveryHintText('deathCauses', causeCatalog, d.deathCauses);
  document.getElementById('discoveryDeathCauses').innerHTML = discoveryCatalogHtml('deathCauses', causeCatalog, d.deathCauses);

  document.getElementById('discoveryTagsHint').textContent = discoveryHintText('tags', tagCatalog, d.tags);
  document.getElementById('discoveryTags').innerHTML = discoveryCatalogHtml('tags', tagCatalog, d.tags);

  document.getElementById('discoveryItems').innerHTML = unlockListHtml(data.items, isItemUnlocked, function (item) {
    return item.requiresBurden ? BURDEN_REQUIRED_NOTE : null;
  });
  document.getElementById('discoverySkills').innerHTML = unlockListHtml(data.skills, isSkillUnlocked);
  document.getElementById('discoveryBurdens').innerHTML = unlockListHtml(data.burdens, isBurdenUnlocked);
}

function renderDeath() {
  var info = state.lastDeathInfo || { cause: 'special' };
  document.getElementById('deathCause').textContent = data.deathCauseLabels[info.cause];
  document.getElementById('deathName').textContent = state.character.name + 'の生涯';
  document.getElementById('deathSummary').textContent = state.lastDeathSummary || '';
  // 人生要約（テンプレート文）が「なぜそう評価されたか」を裏付ける生ログを、
  // 同じ画面から遡って確認できるようにする（issue #24: 死亡後の要約とログが
  // 自然につながるようにする要件への対応）。出生から死まで時系列（古い順）
  // に並べ、「物語を読み返す」体験に寄せる（観測中のタブは新しい順）。
  document.getElementById('deathLogList').innerHTML = state.log.length
    ? logListHtml(state.log)
    : '<div class="empty">記録がない。</div>';
}

/* ---- 初期化 ---- */

async function init() {
  data = await loadData();
  state = loadState();
  catchUpOffline();
  renderAll();
  renderSaveStatus();

  document.getElementById('startBtn').addEventListener('click', function () { clearBanner(); startLife(); });
  document.getElementById('rerollBtn').addEventListener('click', rerollCandidate);
  document.getElementById('introToggleBtn').addEventListener('click', toggleIntro);
  document.getElementById('nextLifeBtn').addEventListener('click', function () { clearBanner(); nextLife(); });
  document.getElementById('advanceBtn').addEventListener('click', function () { clearBanner(); advanceOneYear(); });
  document.getElementById('playPauseBtn').addEventListener('click', function () {
    isPlaying = !isPlaying;
    if (isPlaying) startTimer(); else stopTimer();
    renderObserve();
  });

  document.getElementById('itemChoiceList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-item]');
    if (!btn || btn.disabled) return;
    selectItem(btn.getAttribute('data-item'));
  });
  document.getElementById('skillChoiceList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-skill]');
    if (!btn) return;
    selectSkill(btn.getAttribute('data-skill'));
  });
  document.getElementById('burdenChoiceList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-burden]');
    if (!btn) return;
    selectBurden(btn.getAttribute('data-burden'));
  });

  document.getElementById('speedRow').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-speed]');
    if (!btn) return;
    state.speedIndex = parseInt(btn.getAttribute('data-speed'), 10);
    saveState();
    if (isPlaying) startTimer();
    renderObserve();
  });

  document.getElementById('tabNav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-tab]');
    if (!btn) return;
    currentTab = btn.getAttribute('data-tab');
    syncTabButtons();
    renderAll();
  });
  document.getElementById('tabNav').addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) === -1) return;
    e.preventDefault();
    moveTabFocus(e.key);
  });

  document.querySelector('.logfilter').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-filter]');
    if (!btn) return;
    currentLogFilter = btn.getAttribute('data-filter');
    Array.prototype.forEach.call(document.querySelectorAll('.logfilter button'), function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderLog();
  });

  document.getElementById('encyclopediaTabLives').addEventListener('click', function () {
    encyclopediaSubTab = 'lives';
    renderEncyclopedia();
  });
  document.getElementById('encyclopediaTabDiscovery').addEventListener('click', function () {
    encyclopediaSubTab = 'discovery';
    encyclopediaDetailIndex = null;
    renderEncyclopedia();
  });
  document.getElementById('encyclopediaList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-life-index]');
    if (!btn) return;
    encyclopediaDetailIndex = parseInt(btn.getAttribute('data-life-index'), 10);
    renderEncyclopedia();
  });
  document.getElementById('encyclopediaBackBtn').addEventListener('click', function () {
    encyclopediaDetailIndex = null;
    renderEncyclopedia();
  });
  // 発見項目タブの発見済みチップ（アイテム/スキル/制約以外の6カテゴリ）を
  // 押すと、その項目を含む過去人生だけに絞り込んで一覧タブへ移る
  // （issue #20: 過去人生一覧から発見に関係した出来事を振り返りやすくする）。
  document.getElementById('encyclopediaDiscoveryView').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-filter-category]');
    if (!btn) return;
    encyclopediaLifeFilter = {
      category: btn.getAttribute('data-filter-category'),
      id: btn.getAttribute('data-filter-id'),
      label: btn.getAttribute('data-filter-label')
    };
    encyclopediaSubTab = 'lives';
    encyclopediaDetailIndex = null;
    renderEncyclopedia();
  });
  document.getElementById('encyclopediaFilterClearBtn').addEventListener('click', function () {
    encyclopediaLifeFilter = null;
    renderEncyclopedia();
  });

  document.getElementById('simBtn').addEventListener('click', function () {
    document.getElementById('simResult').textContent = '計算中…';
    setTimeout(function () {
      var stats = runBatchSimulation(data, 300);
      var pct = function (v) { return Math.round(v * 100) + '%'; };
      var goalLabelOf = {};
      data.goals.forEach(function (g) { goalLabelOf[g.id] = g.label; });
      var itemLabelOf = {};
      data.items.forEach(function (i) { itemLabelOf[i.id] = i.label; });

      var lines = [];
      lines.push('試行回数: ' + stats.trials);
      lines.push('平均寿命: ' + stats.avgLifespan.toFixed(1) + '歳');
      lines.push('結婚率: ' + pct(stats.marriageRate));
      lines.push('人生アークへの突入率: ' + pct(stats.arcEntryRate));
      lines.push('アーク最終段への到達率: ' + pct(stats.arcClimaxRate));
      lines.push('ほぼ何も起きない人生: ' + pct(stats.nothingHappenedRate));
      lines.push('未発生イベント: ' + (stats.unfiredEvents.length ? stats.unfiredEvents.join(', ') : 'なし'));

      lines.push('');
      lines.push('[目標別統計] 形成/完遂/失敗/放棄/変質/未決着(内到達不能)/平均進捗');
      Object.keys(stats.goalStats).sort().forEach(function (id) {
        var g = stats.goalStats[id];
        lines.push(
          (goalLabelOf[id] || id) + ': ' + g.formed + '/' + g.completed + '/' + g.failed + '/' +
          g.abandoned + '/' + g.distorted + '/' + g.unresolved + '(' + g.unreachableWhileActive + ')/' +
          g.avgProgress.toFixed(0)
        );
      });

      lines.push('');
      lines.push('[転生準備] 何も持たずに転生した率: ' + pct(stats.grantStats.noGrantRate));
      lines.push('[アイテム] 選択/使用(使用率)');
      Object.keys(stats.grantStats.items).sort().forEach(function (id) {
        var s = stats.grantStats.items[id];
        var rate = s.selected > 0 ? Math.round((s.used / s.selected) * 100) : 0;
        lines.push('  ' + (itemLabelOf[id] || id) + ': ' + s.selected + '/' + s.used + '(' + rate + '%)');
      });

      lines.push('');
      lines.push('[世界影響統計（自然ドリフト除外）]');
      lines.push('世界へ影響を残した率: ' + pct(stats.worldImpactStats.rate) +
        '（正' + stats.worldImpactStats.positiveCount + ' / 負' + stats.worldImpactStats.negativeCount + '）');

      lines.push('');
      lines.push('[整合性検証]');
      lines.push('自己テスト: ' + stats.consistency.selfTests.filter(function (t) { return t.passed; }).length +
        '/' + stats.consistency.selfTests.length + ' PASS');
      lines.push('合計整合性違反件数: ' + stats.consistency.totalViolationCount + (stats.consistency.totalViolationCount === 0 ? '（OK）' : '（要確認）'));

      document.getElementById('simResult').textContent = lines.join('\n');
    }, 30);
  });

  // ブラウザ標準のconfirm()は、Enterキーの連打や「よくある確認ダイアログ」への
  // 慣れで誤って押し抜けやすい。何が消えるかをその場で具体的に示すカードを
  // 挟み、明示的な「初期化する」ボタンを押さないと実行されないようにする
  // （issue #23: 初期化ボタンの誤操作防止）。
  function openResetConfirm() {
    var lines = [];
    lines.push('現在観測中の転生者' + (state.character ? '（' + esc(state.character.name) + '）' : '（なし）'));
    lines.push('これまでの転生数: ' + (state.lifetimeCount || 0) + '回');
    lines.push('保存されている過去人生の記録: ' + (state.pastLives ? state.pastLives.length : 0) + '件');
    lines.push('転生記録図鑑の発見状況');
    lines.push('世界の状態（暦・情勢など）');
    document.getElementById('resetConfirmBody').innerHTML =
      '<p>この操作を行うと、次のデータがすべて削除され、最初からやり直しになります。</p>' +
      '<ul>' + lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>' +
      '<p class="modalwarn">この操作は取り消せません。</p>';
    document.getElementById('resetConfirmOverlay').hidden = false;
    document.getElementById('resetCancelBtn').focus();
  }
  function closeResetConfirm() {
    document.getElementById('resetConfirmOverlay').hidden = true;
    document.getElementById('resetBtn').focus();
  }

  document.getElementById('resetBtn').addEventListener('click', openResetConfirm);
  document.getElementById('resetCancelBtn').addEventListener('click', closeResetConfirm);
  document.getElementById('resetConfirmOverlay').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeResetConfirm(); return; }
    // role="alertdialog"のモーダル内にフォーカスを閉じ込める（フォーカストラップ）。
    // モーダル内の可視な操作対象は「キャンセル」「初期化する」の2ボタンのみなので、
    // その両端でTab/Shift+Tabを折り返す。これが無いと、オーバーレイの背後に
    // 隠れている画面（観測画面のボタン等）へフォーカスが抜けてしまい、
    // 見えない場所を操作することになる（issue #23レビュー対応）。
    if (e.key !== 'Tab') return;
    var cancelBtn = document.getElementById('resetCancelBtn');
    var confirmBtn = document.getElementById('resetConfirmBtn');
    if (e.shiftKey && document.activeElement === cancelBtn) {
      e.preventDefault();
      confirmBtn.focus();
    } else if (!e.shiftKey && document.activeElement === confirmBtn) {
      e.preventDefault();
      cancelBtn.focus();
    }
  });
  document.getElementById('resetConfirmBtn').addEventListener('click', function () {
    stopTimer();
    isPlaying = false;
    state = freshState();
    currentTab = 'observe';
    syncTabButtons();
    clearBanner();
    document.getElementById('resetConfirmOverlay').hidden = true;
    // localStorage.removeItem()の成否を無視して常に成功扱いにすると、削除に
    // 失敗した場合でも画面上は初期化済みに見え、再読み込みすると古いデータが
    // 復活する（issue #23レビュー対応）。removeItem()の結果に関わらず、
    // 実際に書き込みが成功したかどうかはsaveState()の既存の成否判定に委ねる
    // （新しいfreshState()をSTORAGE_KEYへ上書き保存する形で、削除の成否によらず
    // 「保存領域の中身が初期化後の状態と一致しているか」だけを基準にする）。
    saveState();
    if (!lastSaveOk) {
      addBanner('画面上は初期化されましたが、保存領域への書き込みに失敗しました。再読み込みすると元のデータが復元される可能性があります。', 'warn');
    }
    renderAll();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveState(); }
    else { catchUpOffline(); renderAll(); }
  });
  window.addEventListener('beforeunload', function () { saveState(); });
}

init();

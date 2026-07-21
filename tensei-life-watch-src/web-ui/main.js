import {
  buildDataBundle, generateCharacter, simulateYear, generateSummary, runBatchSimulation,
  applyStartingGrants, isItemSelectable, determineLifeRank, lifeRankLabel,
  freshDiscoveries, recordLifeDiscoveries, isItemUnlocked, isSkillUnlocked, isBurdenUnlocked, buildLifeRecord,
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
    lastSavedAt: Date.now(),
    speedIndex: 1
  };
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
    // 存在しない。空の状態から積み上げ直すことになるが、これは既存の過去人生
    // データを破棄するわけではなく単に発見済み扱いにならないだけなので、
    // セーブそのものは壊さずに引き継げる。
    if (!raw.discoveries || typeof raw.discoveries !== 'object') raw.discoveries = freshDiscoveries();
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

function loadState() {
  var raw = null;
  try {
    var text = window.localStorage.getItem(STORAGE_KEY);
    if (text) raw = JSON.parse(text);
  } catch (e) {
    showBanner('保存データの読み込みに失敗したため、新しく開始します。', 'warn');
    return freshState();
  }
  var sanitized = sanitizeLoaded(raw);
  if (!sanitized) return freshState();
  if (!sanitized.candidate) sanitized.candidate = generateCharacter(data);
  if (!sanitized.pendingGrants) sanitized.pendingGrants = freshPendingGrants();
  if (!sanitized.pastLives) sanitized.pastLives = [];
  if (!sanitized.discoveries || typeof sanitized.discoveries !== 'object') sanitized.discoveries = freshDiscoveries();
  if (typeof sanitized.speedIndex !== 'number') sanitized.speedIndex = 1;
  return sanitized;
}

function saveState() {
  state.lastSavedAt = Date.now();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    showBanner('保存に失敗しました。この端末では続行できない可能性があります。', 'warn');
  }
}

function showBanner(msg, type) {
  document.getElementById('bannerBox').innerHTML = '<div class="banner ' + (type || 'info') + '">' + esc(msg) + '</div>';
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
    showBanner(msg, 'info');
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
    importance: 'historic'
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

function encyclopediaListHtml(list) {
  return list.map(function (p, i) {
    return '<button type="button" class="pastlife pastlife-btn" data-life-index="' + i + '">' +
      '<span><b>' + esc(p.name) + '</b>（' + esc(pastLifeOccupationLabel(p)) + '）</span>' +
      '<span>享年' + pastLifeAge(p) + '歳・' + esc(pastLifeCauseLabel(p)) + '</span></button>';
  }).join('');
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
  if (p.historicEvents && p.historicEvents.length > 0) {
    parts.push('<div class="loglist" style="margin-top:8px">' + logListHtml(p.historicEvents) + '</div>');
  }
  return parts.join('');
}

function logListHtml(entries) {
  return entries.map(function (l) {
    return '<div class="logentry ' + l.importance + '"><div class="meta">暦' + l.year + '年 / ' + l.age + '歳</div><div class="txt">' + esc(l.text) + '</div></div>';
  }).join('');
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
  var html = '<button type="button" class="' + classes + '" data-' + kind + '="' + esc(def.id) + '"' + (locked ? ' disabled' : '') + '>';
  html += '<div class="pc-title"><span>' + esc(def.label) + '</span></div>';
  html += '<div class="pc-desc">' + esc(def.description) + '</div>';
  if (def.benefit) html += '<div class="pc-benefit">恩恵: ' + esc(def.benefit) + '</div>';
  if (def.risk && def.risk !== '特になし。') html += '<div class="pc-risk">注意: ' + esc(def.risk) + '</div>';
  if (locked) html += '<div class="pc-note">※ ' + esc(lockNote || '選べません') + '</div>';
  html += '</button>';
  return html;
}

function noneCardHtml(kind, selectedId, label) {
  var isActive = !selectedId;
  return '<button type="button" class="prepcard' + (isActive ? ' active' : '') + '" data-' + kind + '="none">' +
    '<div class="pc-title"><span>' + esc(label || 'なし') + '</span></div>' +
    '<div class="pc-desc">何も持ち込まない。</div>' +
    '</button>';
}

function renderPrepSection() {
  var grants = state.pendingGrants;

  var itemHtml = noneCardHtml('item', grants.itemId, '持ち込まない');
  itemHtml += data.items.map(function (item) {
    var burdenLocked = !isItemSelectable(item, grants.burdenId);
    var undiscovered = !isItemUnlocked(item, state.discoveries);
    var note = undiscovered ? (item.unlockHint || 'まだ発見条件を満たしていない。') : '制約を1つ選ぶと持ち込めるようになる';
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

function renderStart() {
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

function renderObserve() {
  var c = state.character;
  document.getElementById('charTitle').textContent = c.name + '（' + c.genderLabel + '・' + c.age + '歳）';
  document.getElementById('ovAge').textContent = c.age + '歳';
  document.getElementById('ovOcc').textContent = data.occupations[c.occupation];
  document.getElementById('ovHealth').textContent = c.health + ' / 100';
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
  document.getElementById('wSaved').textContent = new Date(state.lastSavedAt).toLocaleString('ja-JP');
  document.getElementById('pastLivesList2').innerHTML = state.pastLives.length ? pastLivesHtml(state.pastLives) : '<div class="empty">まだ記録がない。</div>';
}

// 発見済み/未発見のカタログをチップ一覧のHTMLへ変換する。未発見は名称を伏せ、
// 存在だけを示す（issue #9: 「未発見項目は名称を伏せるか、存在だけを示す」）。
function discoveryCatalogHtml(catalog, discoveredMap) {
  return catalog.map(function (entry) {
    var count = discoveredMap[entry.id] || 0;
    if (count <= 0) return '<span class="chip locked"><b>？？？</b></span>';
    return '<span class="chip"><b>' + esc(entry.label) + '</b>×' + count + '</span>';
  }).join('');
}

function discoveryRateOf(catalog, discoveredMap) {
  var total = catalog.length;
  var found = catalog.filter(function (e) { return (discoveredMap[e.id] || 0) > 0; }).length;
  return { found: found, total: total };
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
      document.getElementById('encyclopediaCount').textContent = '（全' + state.pastLives.length + '件）';
      var empty = document.getElementById('encyclopediaEmpty');
      if (state.pastLives.length === 0) {
        empty.hidden = false;
        document.getElementById('encyclopediaList').innerHTML = '';
      } else {
        empty.hidden = true;
        document.getElementById('encyclopediaList').innerHTML = encyclopediaListHtml(state.pastLives);
      }
    }
    return;
  }

  var d = state.discoveries;
  var elementCatalog = data.elements.filter(function (e) { return e.id !== 'none'; }).map(function (e) { return { id: e.id, label: ELEMENT_LABELS[e.id] || e.label }; });
  var goalCatalog = data.goals.map(function (g) { return { id: g.id, label: g.label }; });
  var occCatalog = Object.keys(data.occupations).map(function (id) { return { id: id, label: data.occupations[id] }; });
  var causeCatalog = Object.keys(data.deathCauseLabels).map(function (id) { return { id: id, label: data.deathCauseLabels[id] }; });

  var rates = [
    ['特殊要素', discoveryRateOf(elementCatalog, d.elements)],
    ['生涯目標', discoveryRateOf(goalCatalog, d.goals)],
    ['職業', discoveryRateOf(occCatalog, d.occupations)],
    ['死因', discoveryRateOf(causeCatalog, d.deathCauses)]
  ];
  document.getElementById('discoveryRateBox').innerHTML = rates.map(function (r) {
    var label = r[0], rate = r[1];
    var pct = rate.total > 0 ? Math.round((rate.found / rate.total) * 100) : 0;
    return '<div class="rowline"><span class="k">' + label + '</span><span class="v">' + rate.found + ' / ' + rate.total + '（' + pct + '%）</span></div>';
  }).join('');

  document.getElementById('discoveryElements').innerHTML = discoveryCatalogHtml(elementCatalog, d.elements);
  document.getElementById('discoveryGoals').innerHTML = discoveryCatalogHtml(goalCatalog, d.goals);
  document.getElementById('discoveryOccupations').innerHTML = discoveryCatalogHtml(occCatalog, d.occupations);
  document.getElementById('discoveryDeathCauses').innerHTML = discoveryCatalogHtml(causeCatalog, d.deathCauses);

  var tagIds = Object.keys(d.tags);
  var tagsEmpty = document.getElementById('discoveryTagsEmpty');
  if (tagIds.length === 0) {
    tagsEmpty.hidden = false;
    document.getElementById('discoveryTags').innerHTML = '';
  } else {
    tagsEmpty.hidden = true;
    document.getElementById('discoveryTags').innerHTML = tagIds.map(function (id) {
      return '<span class="chip"><b>' + esc(TAG_SHORT_LABELS[id] || id) + '</b>×' + d.tags[id] + '</span>';
    }).join('');
  }
}

function renderDeath() {
  var info = state.lastDeathInfo || { cause: 'special' };
  document.getElementById('deathCause').textContent = data.deathCauseLabels[info.cause];
  document.getElementById('deathName').textContent = state.character.name + 'の生涯';
  document.getElementById('deathSummary').textContent = state.lastDeathSummary || '';
}

/* ---- 初期化 ---- */

async function init() {
  data = await loadData();
  state = loadState();
  catchUpOffline();
  renderAll();

  document.getElementById('startBtn').addEventListener('click', function () { clearBanner(); startLife(); });
  document.getElementById('rerollBtn').addEventListener('click', rerollCandidate);
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
    Array.prototype.forEach.call(document.querySelectorAll('#tabNav button'), function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderAll();
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

  document.getElementById('resetBtn').addEventListener('click', function () {
    if (!window.confirm('全ての観測データを削除して最初からやり直します。よろしいですか？')) return;
    stopTimer();
    isPlaying = false;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    state = freshState();
    currentTab = 'observe';
    renderAll();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveState(); }
    else { catchUpOffline(); renderAll(); }
  });
  window.addEventListener('beforeunload', function () { saveState(); });
}

init();

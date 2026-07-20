import {
  buildDataBundle, generateCharacter, simulateYear, generateSummary, runBatchSimulation
} from '../game-engine/index.js';

// escapeHtml は game-engine に無いため、ここでのみ小さく定義する（描画専用のUIヘルパー）。
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; });
}

var SCHEMA_VERSION = 3;
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
  return buildDataBundle(traits, occupations, world, events, elements, goals);
}

function freshWorld() {
  return Object.assign({}, data.initialWorld);
}

function freshState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    world: freshWorld(),
    character: null,
    candidate: generateCharacter(data),
    relations: [],
    log: [],
    lifetimeCount: 0,
    pastLives: [],
    lastSavedAt: Date.now(),
    speedIndex: 1
  };
}

// schemaVersion 1 (要素/生涯目標/世界状態の拡張前) や 2 (worldImpact集計の
// 追加前) の保存データを、新しいフィールドを補いながら壊さずに引き継ぐ。
function migrateCharacter(character) {
  if (!character) return character;
  if (!Array.isArray(character.elements)) character.elements = [];
  if (character.goal === undefined) character.goal = null;
  if (typeof character.fame !== 'number') character.fame = 0;
  if (!character.worldImpact || typeof character.worldImpact !== 'object') character.worldImpact = {};
  return character;
}

function migrateWorld(world) {
  if (!world) return world;
  Object.keys(data.initialWorld).forEach(function (key) {
    if (typeof world[key] !== 'number') world[key] = data.initialWorld[key];
  });
  return world;
}

function migrateState(raw) {
  if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
    migrateCharacter(raw.character);
    migrateCharacter(raw.candidate);
    migrateWorld(raw.world);
    raw.schemaVersion = SCHEMA_VERSION;
  }
  return raw;
}

function sanitizeLoaded(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemaVersion !== SCHEMA_VERSION && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return null;
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
  if (!sanitized.pastLives) sanitized.pastLives = [];
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

function finishLife(deathInfo) {
  isPlaying = false;
  stopTimer();
  var summary = generateSummary(
    state.character, state.relations, deathInfo, data.occupations, data.traits, data.deathCauseLabels
  );
  state.pastLives.unshift({
    name: state.character.name, age: state.character.age,
    occupation: data.occupations[state.character.occupation], cause: data.deathCauseLabels[deathInfo.cause]
  });
  if (state.pastLives.length > 20) state.pastLives.length = 20;
  state.lastDeathSummary = summary;
  state.lastDeathInfo = deathInfo;
  state.candidate = generateCharacter(data);
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

/* ---- 描画 ---- */

function abilityBarHtml(def, val) {
  return '<div class="bar-item"><span class="label">' + def.label + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + val + '%"></span></span>' +
    '<span class="val">' + val + '</span></div>';
}

function pastLivesHtml(list) {
  return list.map(function (p) {
    return '<div class="pastlife"><span><b>' + esc(p.name) + '</b>（' + esc(p.occupation) + '）</span><span>享年' + p.age + '歳・' + esc(p.cause) + '</span></div>';
  }).join('');
}

function logListHtml(entries) {
  return entries.map(function (l) {
    return '<div class="logentry ' + l.importance + '"><div class="meta">暦' + l.year + '年 / ' + l.age + '歳</div><div class="txt">' + esc(l.text) + '</div></div>';
  }).join('');
}

function renderAll() {
  document.getElementById('genLine').textContent = '第' + (state.lifetimeCount || 1) + '転生 / 暦' + state.world.yearEra + '年';

  var hasLiving = state.character && state.character.alive;
  var showDeath = state.character && !state.character.alive;

  document.getElementById('tabNav').hidden = !hasLiving;
  document.getElementById('screenStart').hidden = !!state.character;
  document.getElementById('screenDeath').hidden = !showDeath;
  document.getElementById('screenObserve').hidden = !(hasLiving && currentTab === 'observe');
  document.getElementById('screenLog').hidden = !(hasLiving && currentTab === 'log');
  document.getElementById('screenWorld').hidden = !(hasLiving && currentTab === 'world');

  if (!state.character) renderStart();
  if (showDeath) renderDeath();
  if (hasLiving) {
    renderObserve();
    renderLog();
    renderWorld();
  }
}

function renderStart() {
  var c = state.candidate;
  var html = '';
  html += '<div class="rowline"><span class="k">名前</span><span class="v">' + esc(c.name) + '（' + c.genderLabel + '）</span></div>';
  html += '<div class="rowline"><span class="k">出身</span><span class="v">' + esc(c.region) + '</span></div>';
  html += '<div class="barlist" style="margin-top:10px">';
  data.abilities.forEach(function (a) { html += abilityBarHtml(a, c.abilities[a.id]); });
  html += '</div><div class="traitgrid" style="margin-top:10px">';
  data.traits.forEach(function (t) {
    var v = c.traits[t.id];
    html += '<div class="t' + (v >= 70 ? ' hi' : '') + '"><span>' + t.label + '</span><span class="tv">' + v + '</span></div>';
  });
  html += '</div>';
  document.getElementById('candidateBox').innerHTML = html;

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
  document.getElementById('wYear').textContent = w.yearEra + '年';
  document.getElementById('wUnrest').textContent =
    '安定' + Math.round(w.stability) + ' / 戦争' + Math.round(w.warThreat) + ' / 魔' + Math.round(w.demonThreat) +
    ' / 信仰' + Math.round(w.religiousInfluence) + ' / 技術' + Math.round(w.techLevel) + ' / 経済' + Math.round(w.economy);
  document.getElementById('wLifetimes').textContent = state.lifetimeCount + '人';
  document.getElementById('wSaved').textContent = new Date(state.lastSavedAt).toLocaleString('ja-JP');
  document.getElementById('pastLivesList2').innerHTML = state.pastLives.length ? pastLivesHtml(state.pastLives) : '<div class="empty">まだ記録がない。</div>';
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

  document.getElementById('simBtn').addEventListener('click', function () {
    document.getElementById('simResult').textContent = '計算中…';
    setTimeout(function () {
      var stats = runBatchSimulation(data, 300);
      var pct = function (v) { return Math.round(v * 100) + '%'; };
      var goalLabelOf = {};
      data.goals.forEach(function (g) { goalLabelOf[g.id] = g.label; });

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

export function rand(min, max) {
  return Math.random() * (max - min) + min;
}

export function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

// 3d100/3 で釣鐘型に近い分布を作る（能力・性格の初期値に使用）
export function bell100() {
  return clamp(Math.round(((Math.random() + Math.random() + Math.random()) / 3) * 100), 0, 100);
}

export function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

export function fillName(text, name) {
  return String(text).split('{name}').join(name);
}

export function weightedPick(items, weightFn) {
  var total = 0;
  var weights = items.map(function (it) {
    var w = weightFn(it);
    total += w;
    return w;
  });
  var r = Math.random() * total;
  var acc = 0;
  for (var i = 0; i < items.length; i++) {
    acc += weights[i];
    if (r <= acc) return items[i];
  }
  return items[items.length - 1];
}

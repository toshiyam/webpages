// issue#88: オフライン起動・キャッシュ更新・更新通知。
//
// game-data/*.jsonはビルド時にJSへ静的インポート済み（web-ui-src/src/engine/
// gameData.ts）で実行時fetchを持たないため、オフライン対応で本当に必要なのは
// アプリシェル（index.html・ハッシュ付きJS/CSS・manifest・アイコン）の
// キャッシュのみである。
//
// 戦略:
//   - `/assets/`配下（Viteが出力するcontent-hash付きファイル名。同じ
//     ファイル名なら中身は絶対に変わらない）: cache-first。一度取得すれば
//     二度とネットワークへ問い合わせない
//   - それ以外（index.html・manifest.webmanifest・icons/等、ファイル名が
//     ビルドをまたいで変わらないのに中身は変わりうる）: network-first。
//     オンライン時は常に最新を取得し、取得できたものだけキャッシュを
//     上書きする。オフライン時のみキャッシュへフォールバックする
//     （「更新でセーブデータを失わない」はlocalStorage/IndexedDBに一切
//     触れないことで保証される。本SWはCache Storage APIのみを扱う）
//
// キャッシュ自体が壊れた場合の復旧は、ページ側（SettingsScreen.tsx、
// web-ui-src/src/pwa/serviceWorker.ts の resetCaches()）から明示的に
// 全キャッシュを削除できるようにすることで対応する（本SW自身はcaches.open
// に失敗した場合そのままネットワークへフォールバックするため、オンライン中は
// キャッシュが壊れていても致命的にならない）。
const ASSET_CACHE = 'tensei-life-watch-assets-v1';
const SHELL_CACHE = 'tensei-life-watch-shell-v1';
const OWN_CACHES = [ASSET_CACHE, SHELL_CACHE];

// issue#176: 以前はここが「件数」の上限（MAX_ASSET_ENTRIES = 20）だった。
// これは2つの理由で誤った軸だった。
//
// 1. /assets/配下はcontent-hash付きのファイル名であり、同じ名前なら中身は
//    絶対に変わらない。古くなるという概念が無いため、件数で切る必然性が無い
// 2. **1つのビルドのアセット数が上限を超えると壊れる。** trimCache()は
//    keys()の先頭（＝古い方）から削除するが、1ビルドが上限を超える場合、
//    削除されるのは「今まさに読み込んだ現ビルドのファイル」になる。
//    cache-firstの前提が崩れ、オフライン起動が成立しなくなる。
//    現状はJS・CSS・MVP画像6点の計8件で顕在化していないが、
//    docs/image-asset-inventory.md 3節の後回しアセット37点が揃うと
//    43点となり上限20を確実に超える（issue#169からの申し送り、
//    docs/image-pipeline.md 2.4節）。
//
// 上限を「合計バイト数」にする。抑えたいのは本来「古いビルドの
// ハッシュ付きファイルが無限に溜まること」であり、それはバイト数で
// 測るのが正しい。値は1ビルド分が絶対に収まる大きさにする
// （現状の1ビルド約455KB、後回しアセット37点が揃っても
// docs/performance-budget.mdの画像予算1MB＋JS/CSSで約1.5MB）。
// 「1ビルド分が上限に収まる」ことはscripts/qa-new-ui-image-delivery.mjsが
// 実測して守る。
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

// アプリシェル本体への相対パス。
// 追記（issue#151、codex-toshiyamの指摘対応）: 当初は'./index.html'を
// 指しており、issue#92の限定プレビュー配布（`tensei-life-watch-next/`の
// ような専用サブディレクトリ配下に一式を配置する構成）ではそれで
// 正しく自身のindex.htmlを指せていた。issue#149の正式切替により、
// このアプリは専用ディレクトリではなく`webpages`リポジトリのルート
// （他の「1HTMLs」公開作品と同居する場所）へ、ファイル名`tensei-life-watch.html`
// として配置されるようになったため、'./index.html'は同じ階層に存在する
// 別の作品（`webpages/index.html`、公開作品インデックス）を指してしまい、
// オフライン時のnavigateフォールバックが誤ったページを返す不具合の原因に
// なっていた。正式配置に合わせ、自身のファイル名を明示する。
const SHELL_URL = new URL('./tensei-life-watch.html', self.location.href).href;

// installでself.skipWaiting()を呼ばないことが重要（レビュー指摘の再現
// 防止）。呼んでしまうと新しいSWが即座に有効化・clients.claim()まで
// 進んでしまい、「更新通知バナー→利用者が「今すぐ更新」を押す」という
// web-ui-src/src/pwa/serviceWorker.tsが前提とするUXそのものが成立しない
// （通知を出す前に無断でリロードされてしまう）。新しいSWは既定どおり
// installed状態（waiting）のまま留まらせ、`message`ハンドラでの
// SKIP_WAITING受信時にのみself.skipWaiting()を呼ぶ。

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 自身が管理しないキャッシュ名（将来のバージョンアップ等）が残って
      // いれば削除する。localStorage/IndexedDBはCache Storage APIとは
      // 完全に別のストレージのため、ここでの操作がセーブデータへ影響する
      // ことはない。
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !OWN_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// assetsキャッシュの合計バイト数を上限内に保つ（古いビルドのハッシュ付き
// ファイルが蓄積し続けないようにする、best-effort）。Cache Storageに保存順の
// 概念は無いためkeys()の返却順（多くの実装で挿入順）を古い順の目安にする。
//
// レビュー指摘対応（issue#176）: 保存したばかりのファイルを削除対象から
// 外す仕組みは、単一のkeepUrlでは足りない。1回のナビゲーションでJS・CSS・
// 画像が**並行して**取得されるため、Aの保存で起動したトリムが、その最中に
// 保存されたBを消しうる。取得中〜トリム完了までのURLを集合で持ち、
// その全部を保護する。
const recentlyStored = new Set();

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  const entries = [];
  let total = 0;
  for (const key of keys) {
    const res = await cache.match(key);
    if (!res) continue;
    // Content-Lengthがあればそれを使い、無ければ本体を読んで測る
    // （開発用サーバー等でヘッダーが付かない場合の保険）。
    let size = Number(res.headers.get('content-length'));
    if (!Number.isFinite(size) || size <= 0) {
      try {
        size = (await res.clone().blob()).size;
      } catch {
        size = 0;
      }
    }
    entries.push({ key, size });
    total += size;
  }
  if (total <= MAX_ASSET_BYTES) return;
  for (const entry of entries) {
    if (total <= MAX_ASSET_BYTES) break;
    if (recentlyStored.has(entry.key.url)) continue;
    await cache.delete(entry.key);
    total -= entry.size;
  }
}

// レビュー指摘対応（issue#176）: トリムを直列化する。並行して走らせると、
// 同じキーを二重に削除しようとしたり、削除途中の合計で判断したりしうる。
// 常に1本の鎖に繋いで、前のトリムが終わってから次を始める。
let trimChain = Promise.resolve();
function scheduleTrim(cache, storedUrl) {
  recentlyStored.add(storedUrl);
  trimChain = trimChain
    .then(() => trimAssetCache(cache))
    .catch(() => {}) // トリムの失敗で後続のトリムまで止めない（best-effort）
    .finally(() => recentlyStored.delete(storedUrl));
  return trimChain;
}

function isAssetRequest(url) {
  return url.pathname.includes('/assets/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 同一オリジンのみ扱う（外部依存は増やさない）

  if (isAssetRequest(url)) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(ASSET_CACHE);
          const cached = await cache.match(req);
          if (cached) return cached;
          const res = await fetch(req);
          if (res.ok) {
            await cache.put(req, res.clone());
            // レビュー指摘対応（issue#176）: 呼びっぱなしにしない。
            // respondWith()がレスポンスを返した後、この非同期処理は
            // どのイベントの寿命にも紐付いていないため、ブラウザが
            // workerを止めればトリムが途中で打ち切られうる。
            // event.waitUntil()でfetchイベントの寿命へ明示的に繋ぐ。
            event.waitUntil(scheduleTrim(cache, req.url));
          }
          return res;
        } catch {
          // caches.open自体の失敗（壊れたキャッシュ領域等）も含め、
          // 素のネットワーク取得へフォールバックする。
          return fetch(req);
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(req, res.clone());
        }
        return res;
      } catch {
        try {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(req);
          if (cached) return cached;
          // ナビゲーションリクエスト（直リンク・オフライン初回起動時の
          // 再読み込み等）は、個別URLのキャッシュが無くてもアプリシェル
          // 自体へフォールバックする（SPAなので同じindex.htmlで良い）。
          if (req.mode === 'navigate') {
            const shell = await cache.match(SHELL_URL);
            if (shell) return shell;
          }
        } catch {
          // キャッシュ領域自体が壊れている場合もここへ落ちる。
        }
        return new Response('オフラインのため読み込めません。ネットワーク接続を確認してください。', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});

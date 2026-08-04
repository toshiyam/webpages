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
const MAX_ASSET_ENTRIES = 20;

// index.htmlへの相対パス。self.locationはこのsw.js自身のURL
// （例: https://.../tensei-life-watch-next/sw.js）なので、'./index.html'は
// デプロイ先のサブパスに関わらず常にアプリのルートを指す
// （issue#92のvite.config.tsのbase: './'と同じ考え方）。
const SHELL_URL = new URL('./index.html', self.location.href).href;

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

// assetsキャッシュの件数を上限内に保つ（古いビルドのハッシュ付きファイルが
// 蓄積し続けないようにする、best-effort）。Cache Storageに保存順の概念は
// 無いためkeys()の返却順（多くの実装で挿入順）を目安にする。
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
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
            trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES);
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

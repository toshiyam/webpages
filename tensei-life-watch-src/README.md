# 転生者観測日誌（開発版ソース）

`../tensei-life-watch.html` の元になっている、`game-data` / `game-engine` / `web-ui` に分離したモジュール版ソースです。ロジックの本体は `toshiyam/iseten` リポジトリと共通で、そちらの開発に合わせて更新されます。

配布・プレイ用の1ファイル版は `../tensei-life-watch.html` を直接開いてください（こちらはビルド不要でそのまま動作します）。

このフォルダはブラウザから `fetch` で `game-data/*.json` を読み込むため、`file://` では動作しません。ローカルで確認する場合はリポジトリ直下で簡易サーバーを起動してください。

```bash
npx serve .
# または
python3 -m http.server 8080
```

起動後、`http://localhost:8080/tensei-life-watch-src/` を開いてください。

UIを介さないバランス検証:

```bash
cd tensei-life-watch-src
node scripts/simulate-cli.js 500
```

`../tensei-life-watch.html` はこのソースから `node scripts/build-single-file.mjs` で自動生成しています（`toshiyam/iseten` リポジトリ側で実行し、生成物をここへコピーしています）。

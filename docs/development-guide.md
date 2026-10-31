# 開発と試験

拡張機能をブラウザへ読み込むためのビルド作業や、実行時の追加パッケージは不要です。開発・検証用のNodeテストとブラウザ試験は別途用意しています。コードの構成は[仕組みとコードの読み方](architecture.md)、確認済みの検証結果は[検証状況](verification.md)を参照してください。

## ローカルでの基本手順

[CI](../.github/workflows/ci.yml)と同じNode.js 22を使い、リポジトリのルートディレクトリで実行します。[package-lock.json](../package-lock.json)の定義に合わせるため、依存関係の導入には`npm ci`を使います。

```bash
npm ci
npm run check
npm test
npm run browser:install
npm run test:browser
npm run test:browser:repeat
npm run test:browser:resource-card
npm run test:browser:regressions
git diff --check
```

`npm test`も`playwright-core`を使う試験を含むため、先に`npm ci`でlockファイル記載の開発依存を導入してください。拡張機能の読み込みに依存導入は不要ですが、Nodeテストの実行前には必要です。`npm ci`は開発用パッケージを導入し、`browser:install`は試験用のChromiumをダウンロードします。CIのLinux環境では、ブラウザ実行に必要なOS依存関係もあわせて導入するため`npm run browser:install -- --with-deps`を使用しています。

## 試験の使い分け

各コマンドの定義は[package.json](../package.json)が基準です。

| コマンド | 対象 |
| --- | --- |
| `npm run check` | 登録されたJavaScriptファイルの構文確認。動作試験ではありません |
| `npm test` | `tests/*.test.mjs`をNodeのテストランナーで実行 |
| `npm run test:browser:smoke` | ブラウザfixtureの基本シナリオ |
| `npm run test:browser` / `npm run test:browser:full` | ブラウザfixtureのfullプロファイル。前者は後者の別名 |
| `npm run test:browser:repeat` | 反復送信の準備状態、APMが保持する下書き、送信確認の回帰試験 |
| `npm run test:browser:resource-card` | 認識対象の長文添付カードに関するブラウザ回帰試験 |
| `npm run test:browser:regressions` | 既存入力への追記、添付ガード、長文、新規チャット、狭幅表示の5本を順に実行 |
| `npm run test:browser:approved-append` / `test:browser:attachment-guard` / `test:browser:long-prompt` / `test:browser:new-chat` / `test:browser:overflow` | 上記5本の個別実行 |
| `npm run test:browser:torture` | ブラウザfixtureのtortureプロファイル |
| `npm run test:browser:release` | fullとtortureを順に実行 |
| `npm run test:theme-render` | テーマの描画確認用 |

ブラウザfixture試験は、隔離したChromiumに拡張機能を読み込み、ChatGPTを模したローカル画面（fixture）上で操作と状態遷移を検証します。実際のChatGPTへ指示を送信する試験ではありません。Nodeテストやfixture試験の成功だけで、本番のChatGPT画面や配布対象のChrome / Edgeにおける動作を確認済みとは扱いません。

現在のCI定義は`main`へのpushとPull Requestで起動し、`npm test`、`check`、およびブラウザ試験のfull・repeat・resource-card・regressionsを実行する構成です。定義があることと対象コミットの実行成功は区別し、結果は[検証状況](verification.md)と各CI runで確認します。torture・release・theme-renderはこのCIでは実行しません。リリース時の実ブラウザ確認は[PCリリースチェックリスト](distribution/pc-release-checklist.md)に沿って別途実施・記録します。

狭幅表示試験の画像は、既定ではOSの一時ディレクトリ内の一意な`aipm-sidepanel-layout-*`フォルダーへ保存します。保存先を指定する場合は`AIPM_LAYOUT_EVIDENCE_DIR`を使い、作業ツリーを汚さない外部フォルダーを選んでください。試験用Node.jsは22を維持し、CIアクション自体の実行環境とは区別します。

## 拡張の読み込みと更新

初回の手動導入手順は[はじめて使う](getting-started.md)を参照してください。更新前は未保存の入力や必要な診断情報を退避し、全タブのRunを停止します。読み込み元のファイルを保全したうえで更新し、拡張機能とChatGPTページの両方を再読み込みしてください。ページを再読み込みしないと、古いcontent scriptがタブ側に残る場合があるためです。

Gitで取得した開発版の更新補助コマンドとその実行条件は、[既存の開発版更新手順](updating.md)に記載しています。更新や再読み込みをまたいだ実行の自動継続は前提にしていません。

## 権限とデータの扱い

[manifest.json](../manifest.json)で要求している権限と用途は次のとおりです。

| 権限 | 用途 |
| --- | --- |
| `storage` | 手順・設定・Run・送信記録・診断情報をブラウザ内に保存 |
| `sidePanel` | サイドパネルを表示 |
| `alarms` | 同じブラウザ起動中に指定時刻まで待つ |
| `scripting` | 接続できない場合、選択したChatGPTタブへ同梱スクリプトを再接続 |
| `power` | 利用者が有効にした実行中のスリープ防止を要求 |
| ホストアクセス | `https://chatgpt.com/*`のみ |

`tabs`、`history`、`cookies`、`webRequest`、`<all_urls>`は要求しません。独自サーバーへの送信や利用状況の外部収集もありません。実際に送信した指示は、通常のChatGPT利用としてChatGPT側へ送られます。回答本文を取得しない実装方針とローカル保存の範囲については[プライバシー](../PRIVACY.md)を参照してください。

[ドキュメント案内へ](README.md)

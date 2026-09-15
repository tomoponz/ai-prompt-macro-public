# 開発版の更新手順

Chrome / Edgeでパッケージ化されていない開発版を使う場合は、リポジトリのclone自体を拡張機能のフォルダーとして読み込みます。

## 初回のセットアップ

1. `tomoponz/ai-prompt-macro-public`をローカルにcloneし、cloneは`main`ブランチのままにします。
2. ブラウザの拡張機能管理ページを開き、デベロッパーモードを有効にします。
3. **パッケージ化されていない拡張機能を読み込む**（Load unpacked）を選び、`manifest.json`があるリポジトリのルートを指定します。

## 更新

1. リポジトリのルートにある`update-ai-prompt-macro.cmd`をダブルクリックします。
2. AI Prompt Macroのサイドパネルで **開発版の更新** → **拡張を再読み込み** を選びます。
3. ChatGPTのタブを一度再読み込みします（`Ctrl+R`）。

更新スクリプトは、意図的にfail-closed（安全を確認できない場合は更新しない）設計にしています。

- cloneが`main`ブランチのときだけ更新します。
- コミットされていない変更や、追跡されていないファイルが作業ツリーにある場合は更新しません。
- `git pull --ff-only origin main`を使います。
- reset、clean、強制checkout、force pushは行いません。

サイドパネルの再読み込みボタンも、Macroの実行が`running`または`paused`の間は再読み込みしません。

# AI Prompt Macro 0.4.0 — 公開ソースの確認範囲

更新日: 2026-09-15。ソースの同期と、Storeリリースの受け入れ確認を分けて扱います。

## この候補の変更

- テーマの表示名を日本語化しました。canonical theme ID、group、origin、stance、accentPolicy、decoration、CSS selector、保存する設定値は維持しています。旧`eva`は引き続き`eva-restrained`として扱います。
- ChatGPTタブは手動aliasと現在のページタイトルで見分けます。「操作対象」と同じウィンドウの「表示中」は独立しています。タイトルは一時表示専用で、Run・outbox・diagnostics・local/session storageへ保存しません。
- ブラウザfixtureでは、ページ遷移後とStart直前に対象の準備状態を確認します。確認に失敗したままStartをクリックせず、送信の再試行やtimeout延長は追加していません。
- Output-Blind、明示的な対象選択、送信前の永続記録、単一の検証済みSend、曖昧な送信の自動再試行禁止、送信確定状態の維持、50回の上限を保ちます。

New Chatの自動handoffは未実装です。最初のSend後に`new-chat-confirmation-required`で停止し、対象と最初の送信を確認した利用者が明示的に「再開」した場合だけ継続します。

## 公開ファイルの扱い

実装・テスト・パッケージ検証スクリプトの最終ファイル内容を同期します。開発用リポジトリの履歴、内部監査記録、個人メール、ローカルパス、非公開の成果物への参照は含めません。テーマ由来の説明は一般化済みのコメントを維持し、実行コードやCSS宣言はそのために変更しません。

表示名は利用者向けの説明です。既存ID中の製品名は互換性のための識別子であり、提携や承認を示しません。ChatGPTなど、機能説明に必要な第三者サービスへの言及は残します。

## 実機での確認状況

利用者から確認できているのは、日本語テーマ表示名が実機Edgeに表示されたことです。次の項目は未確認として扱います。

- 再読み込み後のテーマ設定の維持
- 明示的な操作対象と表示中タブの分離
- New ChatでNEW1 → 確認要求 → 明示Resume → NEW2
- 重複Sendが0であること

自動テストや隔離ブラウザfixtureの成功を、実Edge・実ChatGPTでの受け入れ完了とは記録しません。確認手順は[PCリリースチェックリスト](PC_RELEASE_CHECKLIST.md)を参照してください。

## Storeリリースの条件

過去の候補ZIP・hash・受け入れ記録を、この変更候補の証拠として再利用しません。必要な実機確認の完了までは、Edge Storeパッケージの生成、tag、GitHub Release、Store submissionを行いません。パッケージの要件は[Edge Add-onsパッケージ仕様](EDGE_STORE_PACKAGE_SPEC.md)に従います。

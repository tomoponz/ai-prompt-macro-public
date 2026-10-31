# 仕組みとコードの読み方

APMは、選択したChatGPTタブの入力欄と操作部品を使って、用意した指示を順番に送るブラウザ拡張機能です。OpenAI APIは使いません。回答本文を読んで評価したり、回答内容に応じて次の指示を選んだりする仕組みもありません。

これからコードを読む方は、まず下の一覧で各ファイルの役割をつかみ、次に「開始から次の指示まで」に沿って1回分の送信処理を追うと全体像を把握しやすくなります。対象は0.4.4の実装です。動作確認の範囲は[検証状況](../verification/README.md)に分けて記載しています。

## 主なファイル

| ファイル | 役割・読む入口 |
| --- | --- |
| [manifest.json](../../manifest.json) | 権限、対象ホスト、画面、スクリプトの読み込み順。ページ側はcore → runner → controller |
| [sidepanel.js](../../src/sidepanel.js) / [sidepanel-start-source.js](../../src/sidepanel-start-source.js) | 操作対象・編集内容の確認と開始。`startSelectedAutomation`、`readStartSourceForTab` |
| [flow-script.js](../../src/flow-script.js) / [flow-compile.js](../../src/flow-compile.js) / [execution-plan.js](../../src/execution-plan.js) | Flowの解析、実行用手順への変換、回数・上限の確認。`parseAipmFlow` → `compileAipmFlow` → `buildExecutionPlan` |
| [workflow.js](../../src/workflow.js) | 反復設定の手順化と、手順・反復位置の管理。`quickConfigToWorkflow`、`advanceCursor` |
| [background.js](../../src/background.js) | 選択タブへの中継、Run保存、同時実行の制御、指定時刻、スリープ防止。`relayToChatGpt`、`setRunForTab` |
| [content-core.js](../../src/content-core.js) | `ChatGptAdapter`による入力欄・送信ボタン・生成状態の観測と入力操作 |
| [content-runner.js](../../src/content-runner.js) | 手順を実行するループ。`executeRun`、`sendPromptSafely`、`waitForReadyStability` |
| [content-controller.js](../../src/content-controller.js) | 開始・一時停止・再開・停止・復旧。`startRun`、`resumeRun`、`recoverActiveRun` |

## 開始から次の指示まで

1. **開始する。** `startSelectedAutomation`が、選択タブ・会話・ページ・保存済み入力が確認時から変わっていないかを照合します。`relayToChatGpt`を経由して対象タブへ伝え、`startRun`が実行記録（Run）を保存したうえで`executeRun`を呼び出します。なお、新規チャットでは利用者が最初の送信を手動で行い、会話が作られてから開始する前提です。
2. **入力する。** `sendPromptSafely`が送信上限、対象、入力欄、既存添付の有無などを確認し、送信予定の記録（outbox）を保存します。続いて`ChatGptAdapter.writePrompt`で指示を入力し、画面への反映を確認します。開始時に既存のテキストがあった場合は、初回の自動送信に限りその末尾へ指示を追記します。
3. **送信を確認する。** 入力内容と対象を再確認し、送信ボタンを1回クリックします。その後、**生成開始のUI信号の観測と、入力欄が空になったことの両方**がそろった場合のみ、送信確認済み（confirmed）として記録します。これは送信受付の確認であり、回答内容の正しさや処理成功を判定するものではありません。
4. **生成を待つ。** `waitForReadyStability`が、停止ボタンや入力欄の操作可能状態から、次の指示へ進める状態が一定時間安定して続くことを確認します。この際、回答本文は読み取りません。状態が判別できない場合、制限画面が出ている場合、または時間切れになった場合は自動で継続せず停止します。
5. **次へ進む。** `executeRun`が`advanceCursor`で手順・反復位置を1つ進めて保存し、設定された追加待機時間を挟みます。確認ポイント（checkpoint）では確認待ちとして一時停止し、全手順が終わると完了状態にします。
6. **停止・復旧する。** `pauseCurrentRun`は送信前後の境界を考慮して一時停止し、`stopCurrentRun`とバックグラウンドの`durablyStopRunForTab`が停止処理を扱います。`resumeRun` / `recoverActiveRun`は保存状態と現在の対象タブ・会話を照合します。送信結果が不明な指示は自動再送しません。送信確認済みの指示を再開できる場合も、同じ指示は再送せず、生成待ちの確認から扱います。

## 保存する状態と制約

- **Run**は対象タブ・会話、実行手順、現在位置、状態を持ちます。Run IDだけでなく、状態の版・ブラウザ起動セッション・会話・ページの一致も照合します。
- **outbox**は送信準備・送信中・送信確認済みの段階を区別します。「入力欄に置いた」状態と「実際に送信した」状態を混同しないための記録です。
- **lease**は同じ会話に対する複数Runからの同時操作を抑える期限付きの占有記録です。また、ブラウザを完全終了した後は、以前の実行を自動継続しません。

長文がChatGPT側で添付形式に変換される場合は、入力履歴と認識可能な単一候補などの条件を確認して処理を進めます。添付全文と元の指示の一致を証明するものではありません。また、回答本文を読まない方針（Output-Blind）はコードとテストで監査する実装上の制約であり、ページへのアクセスをブラウザ権限で物理的に隔離する仕組みではありません。詳細は[プライバシー](../../PRIVACY.md)、[安全性のモデル](../../SECURITY.md)、[0.4.4の制限](../release/0.4.4.md)を参照してください。

[ドキュメント案内へ](../README.md)

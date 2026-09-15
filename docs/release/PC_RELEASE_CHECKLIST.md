# PCリリースチェックリスト

このチェックリストは、「リポジトリ上で実行する自動チェック（automated checks）」と「実際のChrome / Edgeでしか確認できない項目（live）」を分けて扱います。実行していない項目をPASSとして扱いません。

確認対象の公開commitとブランチを、末尾の証跡記録に記入してください。
安全性ベースラインは、検証対象の公開ソースと、そのcommitに含まれる回帰テストで確認します。

## リリース判定ルール

次をすべて満たすまで、PCリリース候補（PC Release Candidate）が完成したと判定しません。

- [ ] 未解決のBLOCKER / HIGHが0件
- [ ] `npm test`がPASS
- [ ] `npm run check`がPASS
- [ ] `npm run test:browser`がPASS
- [ ] `git diff --check`がPASS
- [ ] Chrome Desktopでの実ブラウザスモークテスト（live smoke）がPASS
- [ ] Edge Desktopでの実ブラウザスモークテスト（live smoke）がPASS
- [ ] Output-Blind / Fail-Closed / 50回の送信上限 / New Chatの明示的なResumeを、実ブラウザで反証テストした
- [ ] 権限の変更が意図どおりで、`<all_urls>`と`tabs`の権限がない
- [ ] README / はじめて使う（Getting Started）/ ユーザーガイド / FAQが候補の実装と一致している

## 対象範囲と同一性

- [ ] `git remote -v`が`tomoponz/ai-prompt-macro-public`を指している
- [ ] 現在のブランチが検証対象として記録したブランチと一致する
- [ ] 検証対象のcommitと作業ツリーが一致し、未commitの変更がない
- [ ] リリース差分に、モバイル対応、Claude / Geminiの自動操作、バックエンド、テレメトリ、リモートコードが含まれていない
- [ ] 追加変更を現在のベースラインに対して個別に評価した
- [ ] manifestのversion、リリースノート、パッケージの内容を最終HEADに合わせた

## 実行時の50回送信上限（hard cap）

- [ ] content runtimeが画面側の検証（UI validation）を信頼せず、独立して値を正規化（normalize）する
- [ ] 正規化後の`maxSends`が`1..50`の有限の整数
- [ ] 予定送信数（planned sends）が有限の整数で、`plannedSends <= maxSends <= 50`
- [ ] 送信の直前にも`cursor.sendsCompleted < maxSends`かつ上限（hard cap）`< 50`を検証する
- [ ] `NaN`を拒否（reject）する
- [ ] `Infinity` / `-Infinity`を拒否する
- [ ] 数値でない文字列を拒否する
- [ ] 明示的に指定された負数 / 0をクリック前に拒否する
- [ ] 明示的に指定された小数をクリック前に拒否する
- [ ] 複数の`repeat: 50`ブロックなど、合計が50を超えるWorkflowを安全側で停止（fail closed）する
- [ ] 不正な / 古い（stale）Workflowから51回目のSendクリックが0回

## 一時的なdocument identityの再確認

- [ ] 一時的な確認の失敗（transient probe failure）と、不一致が証明された状態（proven mismatch）を区別する
- [ ] `executeScript`による読み取り専用のidentity probeだけを、最大3回、100ms間隔で再確認する
- [ ] 不一致（mismatch）を確認した時点で即時に拒否し、古いdocumentの権限（authority）を使用しない
- [ ] 3回ともidentityが不明なら、対象の正確なRunを`paused / ambiguous / non-resumable`として永続的に安全側で停止（durably fail closed）する
- [ ] Run GET / SET、Leaseの変更、Start / Pause / Resume / Stopの送達、Sendクリックを再試行（retry）しない
- [ ] 取り消せないクリックの後にidentityが不明になった場合は、未完了のoutboxを保持し、自動再試行 / Resumeを0回にする
- [ ] 安定したcanonical conversationでのRepeat=40 fixtureで、Send 40回、重複（duplicate）0回、誤った会話（wrong conversation）0回

## 対象タブのタイトル表示

- [ ] ページタイトルと手動の表示名（alias）が表示され、会話IDは「詳細」にある
- [ ] 「操作対象」と、同じウィンドウの「表示中」が別に表示される
- [ ] 選択中のタブ（selected）とアクティブなタブ（active）が異なる場合、同名タブ、別ウィンドウでも、明示的に選んだ対象への操作だけが届く
- [ ] タイトルはRun / outbox / 診断情報（diagnostics）/ local・session storageに保存されない
- [ ] manifestの権限追加が0件
- [ ] New Chatの自動引き継ぎ（handoff）は未実装。root / Projectとも、最初の送信後の手動確認を維持する

## 自動安全ゲート

- [ ] Output-Blind: 回答メッセージのselector、汎用的なテキスト走査（generic text scan）、回答にもとづく分岐（response-based branch）がない
- [ ] manifest: ホストアクセスは`https://chatgpt.com/*`のみ
- [ ] `tabs`、`history`、`cookies`、`webRequest`、`<all_urls>`の権限がない
- [ ] 結果が曖昧な送信（ambiguous submit）を自動再試行しない
- [ ] 送信前にoutboxを永続保存する処理（persist-before-submit）と、入力欄テキストの完全一致検証（exact composer verification）を維持
- [ ] 同じ会話への送信者を1つに限るlease（same-conversation single-sender lease）を維持
- [ ] 対象タブと現在のトップdocumentの固定（target tab / current top document pinning）を維持
- [ ] 古い書き込み元（stale writer）/ 古いdocument / 古いRun revisionを拒否
- [ ] 不明なルート / 会話の識別情報を、永続的に安全側で停止（durably fail closed）
- [ ] New Chatからcanonical conversationへの遷移を自動で採用（adopt）しない
- [ ] 明示的なResumeだけがNew Chatの対象を採用し、最初のSendを正確に1回として数える
- [ ] root New Chat / Project New Chat / 戻る・進む（back-forward）/ プログラムによるナビゲーションを網羅するテスト
- [ ] 送信確認済み（confirmed）の状態からの再読み込み復旧で、重複送信0回
- [ ] prepared / submittedの曖昧な状態での再読み込みで、自動送信0回
- [ ] service workerのライフサイクルテストで、送信の欠落 / 重複が0回
- [ ] Stop後の古い復旧処理（stale recovery）で送信0回
- [ ] ブラウザ起動時に、古いRunの隔離（quarantine）、予定の解除、スリープ防止（Keep Awake）の解放が行われる

## Chromium fixtureによる自動E2Eテスト

`npm run browser:install`で拡張機能を読み込めるテスト用Chromiumを用意し、`npm run test:browser`を実行します。fixtureは`chatgpt.com`のdocument応答をローカルで横取り（intercept）するため、利用者のアカウントや実際のChatGPTへ指示を送信しません。

- [ ] MV3拡張機能のservice workerとcontent scriptが読み込まれる
- [ ] contenteditableの入力欄へ同じ指示を正確に3回送信し、4回目は0回
- [ ] 送信確認済みの最初のSend直後に再読み込みしても、残り2回のSendを復旧し、重複が0回
- [ ] 結果が曖昧な最初のSendの途中で再読み込みすると再開不可の一時停止（non-resumable pause）になり、自動再試行が0回
- [ ] 選択したタブだけが送信し、別のChatGPTタブへのSendが0回
- [ ] 再読み込み後に現在のcontent scriptへ再接続し、永続保存された送信確認済みの位置（durable-confirmed position）から継続する
- [ ] fixtureの回答本文が拡張機能のストレージへ保存されない
- [ ] root New Chatが最初のSend後にconfirmation-required（確認が必要）となり、明示的なResume前の追加Sendが0回
- [ ] 明示的なResume後に、canonical conversationで残りのSendが正確に1回
- [ ] 同じdocument内での会話のナビゲーション後に、追加Sendが0回
- [ ] 一時的なidentity probeの失敗を複数回注入しても、Repeat=40が正確に40回のSendで完了する
- [ ] 使用したChromiumの実行ファイルのパスとバージョンを証跡（evidence）へ記録

このfixtureでのPASSは、現在の本番ChatGPTのDOMや、配布対象のChrome / Edgeでの手動スモークテストのPASSを代替しません。

## 候補パッケージ

最終候補のcommitから、パッケージ化されていない拡張機能として読み込む（Load unpacked）ための最小のアーカイブを作ります。

```bash
git archive --format=zip --output=ai-prompt-macro-pc-rc.zip HEAD manifest.json src README.md PRIVACY.md SECURITY.md LICENSE docs/getting-started docs/user-guide docs/faq
```

- [ ] ZIPを展開したルート直下に`manifest.json`がある
- [ ] `src/`、README、Privacy、Security、License、初心者向けドキュメントだけを含む
- [ ] `.git/`、`node_modules/`、テスト、調査資料、ローカルの状態を含まない
- [ ] アーカイブのSHA-256と元のcommitを証跡へ記録
- [ ] アーカイブを展開し、Chrome / EdgeのLoad unpackedで同じ手動スモークテストを再実行

## ドキュメントの記載要件

- [ ] Output-Blindは、ブラウザが強制する隔離（browser-enforced isolation）ではなく、実装上の保証（implementation guarantee）であると明記
- [ ] 拡張機能が扱う対象（入力欄 / 操作部品 / 限定された停止要因 / URLによる識別）を明記
- [ ] 自動操作の対象はChatGPT Webだけと明記
- [ ] OpenAI API / APIキーを使わないと明記
- [ ] ChatGPTアカウントのプラン / 利用上限は別であると明記
- [ ] New Chatでは最初のSend後に明示的なResumeが必要と明記
- [ ] 結果が曖昧な送信は自動再試行せず、停止して手動で確認すると明記
- [ ] ページの再読み込みと、ブラウザの完全な再起動の保証を分けて記載
- [ ] ブラウザの完全な再起動では、古いRun / 予定を自動再開しないと明記
- [ ] スリープ防止（Keep Awake）は画面の消灯を妨げず、スリープ中のPCを起こさないと明記
- [ ] StopはChatGPTの生成を止めないと明記
- [ ] 実ブラウザで未確認の項目を、ユニットテストのPASSに含めない

## Chrome Desktopでの実ブラウザスモークテスト

クリーンなプロファイルまたはテスト用プロファイルで、Load unpackedで読み込んだ候補を使用します。各ケースで、対象のタブIDと会話を記録します。

- [ ] インストール後にChatGPTタブを再読み込みし、サイドパネルの接続に成功
- [ ] 既存のcanonical conversationで、A -> 待機 -> B -> 待機 -> Cが各1回
- [ ] root New ChatでAを1回送信した後、**確認が必要**になり、Bを送らない
- [ ] root New Chatで同じcanonical conversationを確認してResumeし、B / Cが各1回
- [ ] Project New Chatでも自動移行（migration）せず、明示的なResumeが必要
- [ ] Resume前にページを再読み込みしても、追加Sendが0回
- [ ] 戻る / 進むや別の会話への移動で、自動継続が0回
- [ ] Aの送信確認後にページを再読み込みしても、B / Cが各1回、Aの重複が0回
- [ ] 待機（Delay）中に再読み込みしても残り時間から継続し、A / B / Cの重複が0回
- [ ] 現在のChatGPT UIで、contenteditableへの書き込みと完全一致の検証が成功
- [ ] 入力欄に利用者の下書きがある場合は、上書きもSendもしない
- [ ] selector / 接続を確認できない場合に、別のタブへ代わりにSendしない（fallbackしない）
- [ ] Pause -> Resume -> Stopの操作部品が、固定表示領域（sticky area）から操作できる
- [ ] **実行中 / 一時停止中 / 確認が必要** と **次の操作** の表示が実際の状態に一致

## Edge Desktopでの実ブラウザスモークテスト

- [ ] Chromeと同じ、既存の会話での3指示のケース
- [ ] 安定したcanonical conversationでQuick RunのRepeat=40を無人で実行し、40/40完了、重複0回、誤った会話0回
- [ ] 上記のRepeat=40の実行中、再読み込み / ナビゲーション / 利用者の操作がないのに、document確認エラーで停止しない
- [ ] Chromeと同じ、New Chatで明示的にResumeするケース
- [ ] 宣言済みcontent scriptが未接続のときの、`chatgpt.com`に限定した自己修復（self-healing）経路
- [ ] 拡張機能 / ChatGPTの再読み込み後の、現在のトップdocumentの固定（pinning）
- [ ] 結果が曖昧な中継（relay）でStartコマンドを再試行しない
- [ ] サイドパネルの固定表示されたRun操作部品と、次の操作のメッセージ

## 複数タブの反証スモークテスト

- [ ] タブA / 会話AとタブB / 会話Bを明示的に選択できる
- [ ] タブAへのStart / Pause / Resume / StopがタブBへ送られない
- [ ] 対象タブが一時的に見つからなくても、別のタブへ自動で切り替えない
- [ ] タブ切り替え中のStartを拒否し、古いUIの状態を別のタブへ保存しない
- [ ] 同じcanonical conversationを2つのタブで実行すると、single-sender leaseが競合を止める
- [ ] タブを閉じた後、古いタブに結び付いたRunが、再利用されたタブへ結び付かない

## 再読み込みと再起動のスモークテスト

- [ ] 同じセッション内のページ再読み込みでは、安全な状態だけを復旧する
- [ ] 結果が曖昧なoutboxでの再読み込みは再開不可の停止となり、自動送信0回
- [ ] New Chatのconfirmation-required状態で再読み込みしてもpausedのままで、自動送信0回
- [ ] 実行中にservice workerが再起動しても安全な状態だけを復旧し、重複0回
- [ ] Chromeを完全に終了 / 再起動しても、以前の実行中Runが自動再開しない
- [ ] Edgeを完全に終了 / 再起動しても、以前の実行中Runが自動再開しない
- [ ] 完全な再起動の後、以前のWait Untilの予定がSendしない
- [ ] タブを閉じると予定を解除する

## スリープ防止（Keep Awake）のスモークテスト

- [ ] スリープ防止を有効にした実行中のRunで、システムのスリープ抑止をOS側で確認
- [ ] 画面の消灯は許可される
- [ ] Pauseで要求を解放する
- [ ] Resumeで要求を再取得する
- [ ] Stop / 完了で解放する
- [ ] 複数タブのうち1つでも有効化済みのRunが実行中なら維持し、最後のRunの終了で解放する
- [ ] ブラウザの完全な再起動で解放する
- [ ] すでにスリープ / 休止状態のPCを起こさないことを確認
- [ ] ノートPCの蓋を閉じたときの動作は、OSの設定に依存するものとして記録

## 停止要因と失敗時のUX

- [ ] ログインが必要な状態でSendが0回、次の操作でログインの確認を案内する
- [ ] CAPTCHA / 利用上限 / サービスのモーダルを回避（bypass）する操作が0回
- [ ] 無害 / 不明なモーダルでは、推測でSendせず停止する
- [ ] 結果が曖昧な送信ではResumeを許可せず、手動での確認を案内する
- [ ] 接続が失われた場合は選択中の対象を維持し、再読み込み / アクセス許可の確認を案内する
- [ ] 内部コード（raw code）が表示される場合も、利用者向けの次の操作が別に表示される

## 最終の証跡記録

リリース責任者（Release owner）が最終結果を記入します。

```text
Date:
Branch:
HEAD:
Base main HEAD:
npm test:
npm run check:
npm run test:browser:
git diff --check:
Chrome version / result:
Edge version / result:
Candidate archive / SHA-256:
Send budget result:
Document identity result:
Remaining BLOCKER:
Remaining HIGH:
Remaining MEDIUM / LOW:
PC Release Candidate verdict: PASS / NOT READY
```

# 反復停止の調査と修正

調査元は公開PR #1の `fddf856aac9720cf8a85deac854d7092b3b7cbda`。
この履歴には現行ChatGPTのform内ProseMirror入力欄と、属性だけが変わる生成操作部品への対応が含まれる。
版番号の大小では使用中版との一致を判断していない。以下は公開ソースの合成再現に基づく修正であり、
実サービスでの連続送信や、過去に報告された停止そのものの解消は未確認。

## 再現と変更

### Sendの有効化が入力の安定より遅れる

反復3回の2回目で、入力後のSendを900ms無効にすると、元コードはテキストが650ms安定した時点で
準備完了と判断し、`send_unavailable` で1/3回のまま停止した。

同じ入力transactionのまま、既存の30秒期限内でform内の一意なSendが有効になるまで待つ。
待機中のリース更新、停止・Pause・編集・blocker確認と、クリック直前の同期検証を維持する。
期限延長、再入力、クリック後の再送は加えていない。

期限切れは永続的なPause後に `send_readiness_timeout` として記録する。
診断は状態・理由・上限付き経過時間と期限だけで、プロンプト・回答本文・URLを追加記録しない。
診断書込みの失敗や未完了Promiseは実行を妨げない。

### 初期復旧の失敗が後のStartを妨げる

最初の復旧Promiseが失敗した後、読取先が復帰しても同じ失敗を保持してStartできないことを再現した。

共有処理を `ensureInitialRecovery` に分け、有効な明示的Start/Resumeだけから再試行できるようにした。
対象Run・revision・session・状態を確認してから復旧の副作用へ進む。
Statusポーリングや無効な操作は自動実行を起こさず、Stopを優先する。
この問題は再開始の阻害であり、反復途中の停止を直接説明する証拠ではない。

### Pause後の未送信入力がResumeを妨げる

APMによる書込み後・Sendクリック前のPauseは、未クリックのoutboxを破棄して入力を残す。
元コードでは、その後のResumeが自分で書いた入力も `draft_present` として拒否した。
1回・3回の反復、長いPause、重複Resumeで再現した。

DOMの所有証明をadapterに分け、transaction生成関数を共通化した。
runnerは `user_pause` かつ未クリックの `prepared/prepared` だけを捕捉し、
Pause保存の成功後に証明を有効化する。明示的Resumeが一度だけ証明を引き取る。
入力のクリア・書込み・入力イベントは追加せず、新しいoutboxとbindingで安定待ちと生成観測を開始する。

証明はメモリ内に限定し、入力欄・surface・元のtrusted編集epoch、Run/session/文書/会話、
workflow全体・cursor・prompt hashを照合する。同じ文面だけでは所有と見なさない。
編集して元の文面へ戻す、添付追加、DOM置換、遷移往復、pagehide、再注入、Stop、
古いrevisionは再利用を認めない。Navigation APIによる寿命の観測は最初の書込み前から継続する。
対応する証拠がない環境では従来の下書き保護を維持する。Pause時にはMutationObserverを終了する。

Pauseの保存応答と旧runnerのリース解放が完了する前のResumeは、処理中として拒否する。
入力や実行状態は変更せず、完了後の明示的Resumeで再開できる。これにより、保存済みPauseを
UIが先に観測しても、所有証明の準備やリース解放を新しいrunnerが追い越さない。

### worker復帰後にリース更新が先に届く

readiness用Run読取が完了してからcontentへの応答到着を保留し、workerを再生成して、
同じsessionと保存済みRun/Leaseを復元する合成条件を作った。
保留していた応答が届くと、実runnerの次の要求はRun読取ではなくリース更新になる。
rendererの文書確認probeも利用できない場合、正当な既存所有者も
`DOCUMENT_IDENTITY_UNCONFIRMED` となった。先にRun読取が入る通常のsleep復帰は成功した。

更新要求だけに復旧関数を加え、リースとRunの変更キュー内で最新状態を照合する。
実行中Run・session・会話・tab・ブラウザ文書ID・content instance・nonceがすべて一致する場合に限り、
既存のRun読取用証明規則を再利用する。Stop intentと遷移epochを最後に確認し、期限だけ更新する。
再利用可能な権限grantは作らず、取得・解放やRun/outbox/cursorは変更しない。

実Chromeの省電力freezeの発生時刻は未再現。この試験が実証するのは、応答順序とworker再生成による経路である。

## 回帰試験

`npm test` に含まれる追加試験:

- `repeat-runner-regression.test.mjs`: 遅いSend、無効・不在・複数候補、停止・Pause・編集、
  長い待機中のリース更新、最終チェック、診断障害。
- `repeat-lifecycle-regression.test.mjs`: 初期復旧の失敗と復帰、明示的操作、並行要求、古い対象、
  Status/Stop、曖昧なoutbox。
- `repeat-lease-restart-regression.test.mjs`: cold workerでの更新と先行Run読取。
- `stage2-owned-draft-resume.test.mjs`: 21条件。再利用、単回使用、入力・文書・workflow保護、
  保存中の編集、Pause保存失敗・競合、明示的Resumeなしの実行拒否。
- `stage2-worker-recovery.test.mjs`: 10条件。実runnerの要求順序、cold worker、
  所有情報の25変種、Pause/Stop/遷移競合、権限grantの非拡張。
- `integration-pause-resume-race.test.mjs`: Pause保存応答・リース解放を保留した状態でのResumeと入力保護。

`npm run test:browser:repeat` は隔離したheadless Chromiumで43条件を検証する。
Send準備3条件、所有入力30条件、属性だけで変わるACK10条件を含む。
ネットワークは合成ページへルーティングし、拡張・実アカウント・既存プロファイルは使わない。
所有入力試験のProseMirror側はhandled-paste契約の合成エディタであり、ライブラリ全体の互換試験ではない。

CIは全単体試験、JavaScript構文確認、既存のfullブラウザfixtureと、上記43条件を実行する。

```text
npm ci
npm test
npm run check
npm run browser:install
npm run test:browser:full
npm run test:browser:repeat
```

## 残る制約と次の整理

- 使用中版・非公開系列との一致と、実ChatGPT上の連続送信は未確認。
- reload、別文書、Navigation API未対応、ユーザー編集、添付への変換、
  送信済みか不明なoutboxでは入力の再利用を認めず、入力を保持して安全停止する。
- クリック後の入力欄やbody差し替え、観測上限到達による停止は未実証。
  生成開始と入力欄消去の両証拠、曖昧な送信の自動再送禁止を維持する。
- 今回はtransaction生成・所有証明、Resumeの引渡し、workerの更新証明を小さく分離した。
  次の整理は本文を扱わないACK観測を境界として行い、送信状態遷移と永続状態操作を別段階で扱う。

ソースZIPは展開後、`manifest.json` があるフォルダーをChrome/Edgeへ読み込める。ビルドやnpm依存の導入は不要。
上記npmコマンドは開発・試験用。

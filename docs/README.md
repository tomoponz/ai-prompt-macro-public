# ドキュメント案内

ソース版0.4.4のドキュメント一覧です。利用手順、コードの構成、検証結果を分けて読めるように整理しています。

## 利用者向け

- [README](../README.md)：できること、用途、導入、基本操作、制約
- [はじめて使う](getting-started/README.md)：初回の手動送信から短いFlowの実行まで
- [ユーザーガイド](user-guide/README.md)：編集、実行状態、停止・再開、保存と復旧
- [よくある質問](faq/README.md)：判断に迷ったときの入口
- [0.4.4の変更点と更新手順](release/0.4.4.md)：既知の制約と、既存の手動導入版を更新する手順

## 構成・検証を知りたい人向け

- [仕組みとコードの読み方](architecture/README.md)：主要ファイルの役割と、開始から送信・復旧までの流れ
- [検証状況と未確認の範囲](verification/README.md)：ソース確認、自動試験、実利用の証拠と未確認事項
- [開発と試験](development/README.md)：開発依存関係、試験コマンド、試験が確認する範囲
- [開発版の更新](DEVELOPMENT.md)：既存の開発者向け案内
- [PCリリースチェックリスト](release/PC_RELEASE_CHECKLIST.md)：自動試験と実ブラウザの確認項目

## データ・安全性・配布

- [プライバシーポリシー](store/PRIVACY_POLICY_PUBLIC.md)
- [プライバシーの実装](../PRIVACY.md)
- [安全性と信頼性](../SECURITY.md)
- [Edge Add-onsパッケージ仕様](release/EDGE_STORE_PACKAGE_SPEC.md)

## 過去の記録

以下は、記載された版・時点における調査記録です。現在の実サービスでの成功を示す証拠として流用しないでください。

- [0.4.0公開ソースの確認範囲](release/PUBLIC_GITHUB_READINESS_0.4.0.md)
- [反復停止の調査・検証](release/repeat-stop-investigation.md)
- [貼り付けテキストカードへの対応と検証範囲](release/resource-card-r2.md)

自動試験やCIの成功は、現在のChatGPT画面や全ブラウザでの動作を保証するものではありません。詳しくは[検証状況と未確認の範囲](verification/README.md)を参照してください。

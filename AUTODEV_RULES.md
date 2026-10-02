# Live City Auto Development Safety Rules

## 目的

このファイルは、ユーザー不在時にClaude CodeがLive Cityを自動開発する際の絶対ルールを定める。

自動開発では「速さ」よりも「既存の安定版を壊さないこと」を優先する。

---

## 1. 情報源の優先順位（実コードを正とする）

自動開発では、CLAUDE.md・引継ぎ文・設計メモ・過去のPR説明・過去の会話記録などの**ドキュメントより、
現在のリポジトリ上の実コードを正とする**。

ドキュメントと実コードが食い違う場合:

- 実コードの動作を事実として扱う
- ドキュメント側の記述を「古い/不正確」とみなす
- 実コードをドキュメント側の記述に合わせて書き換える、というリファクタリングを自動実行しない
- 上記のような食い違いを見つけた場合は実装を進めず、

NEEDS_USER_DECISION

として終了し、矛盾の内容（ドキュメントは何と言っているか／実コードは実際どうなっているか）を
AUTODEV_REPORT.mdへ記載する。ドキュメント側を書き換えるかどうかもユーザー判断に委ねる。

---

## 2. Gitルール

自動開発時はmainブランチを直接編集・commit・pushしてはいけない。

必ず自動開発専用ブランチを使用する。

ブランチ名例:

autodev/2026-08-17-0900

禁止:

- mainへの直接commit
- mainへの直接push
- force push
- git reset --hard
- git clean -fd
- git clean -fdx
- git checkout . による一括破棄
- git restore . による一括破棄
- 既存commit履歴の書き換え

自動開発開始時にworking treeがcleanでない場合は、原則として作業を開始しない。

---

## 3. 絶対変更禁止ファイル

以下は自動開発では変更禁止。

public/osaka_3d_buildings.fullward-v3.html

これはLive Cityのbaseline/referenceである。

変更を検知した場合は、そのタスクを中止する。

---

## 4. 座標系

現在の正式な座標規約:

znorth-neg-v1

BUILD_ID:

znorth-neg-v1

この座標規約を変更してはいけない。

禁止:

- Z方向を旧仕様へ戻す
- production座標変換の変更
- polygon winding規則の独断変更

座標系変更が必要と判断した場合は、自動実装せずユーザー確認待ちとする。

---

## 5. P0 / Ward Mode保護

**このルールは実コード監査（ward-ux-v1.html）に基づく。過去の設計資料上の記述ではなく、
現在実装されている挙動を保護対象とする。**

### 5.1 現在の実装事実（前提）

- ACTIVE区は `WardModeManager.currentWardId` という単一変数で管理されている。
  `activeWardId` という名前の変数は存在しない。
- `pendingWardId` という名前の変数は存在しない。`switchWard()`要求時点で
  `currentWardId` はその場で（非同期処理の完了を待たず）更新される。
- `FullWardManager` に `generation` guardが存在し、supersededされたロードを検出できる。
- FULL WARDモード（既定）では、新区が100% READYになった後にatomic commitする
  （旧区は新区が揃うまで表示を維持する）。
- 失敗タイル（failed tile）がある場合、1回だけ自動retryする。
- retry後もfailedが残る場合はcommitを中止し、旧区の表示を維持する（新区を中途半端な
  状態でACTIVE扱いにしない）。
- `disposeOnSwitch` の既定値は `true`。
  - `true`: 切替後に旧区のtile geometryをdisposeする（ジオメトリは残らない）。
  - `false`: 旧区をhide()するのみでgeometryを保持する（診断用トグルでのみ切替可能）。
- 「WARM」は専用のWard Pool状態として保存されているものではなく、
  `getWardUXStatus()`がBuildingTileLayerの現在のtile状態から都度導出して返す
  UI表示用のラベルにすぎない。
- 区単位のLRU eviction（複数区を対象にした追い出し処理）は存在しない。
  存在するのは1datasetの中のhidden tileに対するタイル単位のキャッシュ上限
  （`maxCachedHiddenTiles`）のみ。
- 「ACTIVE 1 + WARM 2」という形のWard Poolは、現時点のコードには実装されていない。
  実際にジオメトリを同時保持しうるのは「ACTIVE 1 + （disposeOnSwitch=falseの場合のみ）
  直前の旧区1」までであり、常に最大2区分。
- orphan cleanupという専用処理は存在しない。
- `forceRetry`という名前の仕組みは存在しない（自動1回retryの仕組み自体はある）。
- hidden tileに対するタイル単位のキャッシュ管理（`maxCachedHiddenTiles`によるLRU）は存在する。
- 再訪時、disposeされたtileでもbuilding metadataが残っていれば（dispose後一定時間以内、
  metadata eviction前）、re-fetchなしでgeometryを再構築できる場合がある。
  残っていない場合は通常どおりfetchが発生する。

### 5.2 保護対象（自動開発で壊してはいけない、現に存在するもの）

- `WardModeManager.currentWardId`（ACTIVE区の管理方法そのもの）
- `WardModeManager.switchWard()`
- `FullWardManager`（loadFullWard・atomic commitの流れ）
- generation / superseded guard
- FULL WARDモードの「100% READYでatomic commit」という順序
- failed tileの自動1回retry
- retry失敗時のcommit abort（旧区表示を維持したまま中止する挙動）
- `disposeOnSwitch`（既定true、トグルでfalse=WARM保持に切替可能という現在の二択構造）
- BuildingTileLayerの既存のdispose/hide/revisit挙動（metadata evictionを含む）
- `coordinateConvention = znorth-neg-v1`

### 5.3 自動開発で新設・変更してはいけないもの

以下は「本来あるべき設計」であっても、現在のコードには存在しない。
自動開発がこれらを「あるべき姿へ直す」という名目で新設・大規模変更することを禁止する。

- `activeWardId` / `pendingWardId` という名前への大規模再設計
- 「ACTIVE 1 + WARM 2」のようなWard Pool機構の新設
- Ward単位のLRU eviction機構の新設
- orphan cleanup機構の新設
- Ward lifecycle全体のリファクタリング（5.2の保護対象を書き換える変更）

これらが必要になるタスクを与えられた場合は実装せず、

NEEDS_USER_DECISION

としてAUTODEV_REPORT.mdへ理由（何が必要になったか、現状のコードとの差分、想定される選択肢）を
記載して終了する。

---

## 6. Productionデータ保護

大量のproduction/raw/generatedデータを削除・上書きしてはいけない。

特に以下を慎重に扱う。

data/raw/
public/data/buildings/
production release
generated ward tiles
manifest

禁止:

- 大量ファイル削除
- production release上書き
- raw CityGML削除
- 不明なgenerated dataの一括削除

データ生成は新規出力を基本とする。

---

## 7. GitHub対象

巨大なPLATEAU・CityGML・生成building datasetをGit管理対象へ追加しない。

既存.gitignore方針を維持する。

100MB以上のファイルをgit addしない。

.envや秘密情報をcommitしない。

---

## 8. 自動タスクのサイズ

1回の自動開発では原則として1タスクだけ実行する。

大規模な複数機能を同時に変更しない。

タスクが想定より大きい場合は、

BLOCKED

として終了し、無理に完成させない。

---

## 9. 実装前

必ず以下を行う。

1. 対象コードを読む
2. 関連する既存ロジックを確認
3. 変更予定ファイルを列挙
4. baseline/P0への影響を確認
5. 最小変更案を選択

既存機能を調査せず、新しい仕組みを重複実装してはいけない。

---

## 10. テスト

変更後は可能な範囲で必ず実施する。

最低限:

- JavaScript syntax check
- npm test
- 関連テスト
- git diff確認

テストがfailした状態で成功扱いのcommitをしてはいけない。

既存failと新規failを区別する。

新規failが発生した場合は原則commitしない。

---

## 11. 自動commit条件

以下をすべて満たした場合のみcommit可能。

- 対象タスクが完了
- syntax errorなし
- 新規test failureなし
- baseline未変更
- 禁止ファイル未変更
- git diffを自己レビュー済み

commit message例:

AutoDev: add Hirano ward registry support

---

## 12. 不明点

仕様判断が必要な場合に推測で大きな変更をしてはいけない。

以下の状態として終了する。

NEEDS_USER_DECISION

その理由と選択肢をAUTODEV_REPORT.mdへ記載する。

---

## 13. 自動開発報告

各タスク終了時に

AUTODEV_REPORT.md

を更新する。

最低限記録する。

- 実行日時
- 対象タスク
- RESULT: SUCCESS / FAILED / BLOCKED / NEEDS_USER_DECISION
- 変更ファイル
- 実装内容
- 実行したテスト
- テスト結果
- commit hash
- 残っている問題
- ユーザーが実機確認すべき内容

---

## 14. 禁止事項

ユーザー不在時には以下を禁止。

- production deploy
- mainへのmerge
- destructive migration
- OS設定変更
- dependency大量更新
- package managerの大規模upgrade
- 外部サービスへの本番データ送信
- API key生成・変更
- 課金サービスの有効化
- database/schema破壊的変更
- baseline変更

---

## 15. 優先原則

判断に迷った場合:

変更しない > 壊す可能性のある変更

小さい変更 > 大規模リファクタ

既存方式再利用 > 新方式追加

BLOCKED報告 > 推測による実装

現在の実コード > 過去のドキュメント・設計メモ

を優先する。

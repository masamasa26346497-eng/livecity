# Mission 35L｜大阪24区 町丁目境界完全化 報告

ブランチ: `feature/mission-35l-town-boundaries`（Draft PR #1）
対象は development のみ。**production cutover は行っていない。protected baseline も変更していない。**

---

## 1. npm test FAIL の原因

### 結論: **35L は CI の FAIL の原因ではない**

35L 直前の 35K コミット（`d2b582d`）を同じ条件でクリーンチェックアウトして `npm test` を回すと、
**35L ブランチと 1 件も違わない同じ失敗**が出る。

| 条件 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 35L ブランチ・クリーンチェックアウト | 2193 | 1684 | **88** | 421 |
| 35K（d2b582d）・クリーンチェックアウト | 2193 | 1684 | **88** | 421 |
| 作業機（生成物あり） | 2193 | 2178 | **0** | 15 |

### 本当の原因: `npm test` は「パイプラインを実行済みの開発機」を前提にしている

失敗した 88 件はすべて、**検証対象の生成物が存在しない**ことによるもの。ロジックの不具合は 0 件、
35L 由来も 0 件だった。内訳（エラーの出方）:

| 出方 | 件数の目安 | 例 |
|---|---|---|
| `ENOENT`（ファイル / ディレクトリが無い） | 33 | `public/map-data/osaka-city/railways` を `readdir` |
| `TypeError: Cannot read properties of null` | 14 | `rj()` が null を返した manifest を `.featureCount` |
| 「〜が無い」という assertion | 41 | `landmarks.json が無い` / `baseline hash が無い` |

これらが読むものは `.gitignore` で意図的に除外されている（canonical buildings だけで約 250MB）:

```
data/processed/osaka-city/**
public/map-data/osaka-city/**
data/raw/
data/reports/*-qa/
```

CI は `actions/checkout@v4` の素のチェックアウトなので、これらは 1 つも存在しない。
**つまり `npm test` は 35L より前から CI では通らない状態だった。** 35L が足した
`.github/workflows/mission35l.yml` が、その既存の状態を初めて可視化した。

### 併せて見つかったこと（CI では起きない・再現手順の注意）

最初の再現を Windows で `git clone` して行ったところ、**93 件**失敗した。差分の 5 件は
`tests/high-lod-visual-quality.test.js` で、HTML を `\n` 前提の正規表現で見ている箇所が
checkout 時の CRLF 変換で一致しなくなっていたもの。CI（ubuntu / LF）では起きない。
`git -c core.autocrlf=false -c core.eol=lf clone` で再現し直して 88 件が正しい数字と確定した。

---

## 2. 修正内容

### 2-1. npm test（入力が無いときだけ skip する。assertion は 1 つも削っていない）

`tests/_generated-data.mjs` を追加し、**入力ファイル / ディレクトリの有無だけ**を見て
`node:test` の `skip` を返すようにした。

```js
test('[Mission13] 実データ: railway tag 内訳と3クラス分類', { skip: TILE_SKIP }, () => {
```

- 生成物がある環境（作業機・実運用）では `skip` が `false` になり、**従来どおり全部の assertion が走る**。
  実際、修正した全ファイルを作業機で回すと **394 tests / 394 pass / skipped 0**（= ガードは完全に不活性）。
- 無い環境では「何が無いか」と「再生成コマンド」を理由文字列に入れて skip する。
- リポジトリが既にこの扱いをしている（`html-regression` は HTML が無ければ自動 skip、
  `data/reports` 依存のテストは `skip: skip('…json')`。素のチェックアウトで既に 421 件が skip）。

**assertion を弱めた箇所・削除した箇所は無い。** skip してよいのは「入力が無いとき」だけで、
「assertion が落ちたとき」は skip しない、という規則をヘルパーの先頭に明記した。

> **未完了（承認待ち）**: 88 件のうち **26 件（20 ファイル）まで適用済み**。
> 残り 62 件は、同じ内容のスクリプト実行が実行環境の安全確認（テスト無効化とみなされた）で
> ブロックされたため止めている。詳細は「9. 残課題」。

### 2-2. 35L 実装側で見つけて直した不具合 3 件

いずれも実 e-Stat データを通して初めて出たもの。

| # | 事象 | 原因 | 修正 |
|---|---|---|---|
| 1 | KEY_CODE が 3 件重複 → `id` 衝突でラベルから範囲を引けない | e-Stat は**飛び地を同じ KEY_CODE の別レコード**に収録する（住之江区 南港南 = 4 レコード） | `mergeTownsByKeyCode()` を追加し KEY_CODE 単位でリングを統合（1908 → 1905 件・リングは 1908 本のまま保持） |
| 2 | `townWards` を**区 ID** で出力していた（35K は区名） | 35L ビルダーが `wardSet`（id の集合）をそのまま書いていた | 区名で出すよう修正。35K の validator / HTML debug が引けるようになった |
| 3 | 町名ラベル 10 件が公式町丁目に当たらず区界へ落ちていた | ①「ヶ / ケ」の表記ゆれ（OSM=照**ヶ**丘矢田 / e-Stat=照**ケ**丘矢田）7 件 ②`baseTownName` が **末尾の「条」を丁目の数え方**と誤認（十八条→"" / 九条→"" / 西九条→"西"）3 件 | 突き合わせキーを `normalizeTownKey()`（ヶ→ケ）で揃え、ラベル名そのものも基準地名として引くようにした。`baseTownName` 自体は 35K の束ね方を変えないよう触っていない |

結果、**ward fallback は 10 件 → 0 件**になった。

### 2-3. 35K テスト 1 件の意図更新

`35K 実データ: 町丁目が無い区は区界へ落ちる（推測の町界は作らない）` が失敗した。
これは 35K 時点の**制約**（町丁目が 3 区ぶんしか無い）を literal に固定していたもので、
35L はその制約を公式データで解消するミッションなので、テストの**本来の意図**に合わせて更新した。

- 変更前: 町丁目を持つ区は `['住吉区','東住吉区','平野区']` と完全一致すること
- 変更後: **35K の 3 区が消えていないこと**（退行検出）＋ **出所が許可リストのものだけ**であること
  （`estat-census-2020-official` / `legacy-unverified` / `n03-official`。ここに無い出所 = 推測で作った境界）
  ＋ 町丁目を名乗るものが区界を流用していないこと

`tools/validate/station-town-navigation.js` にも `ALLOWED_BOUNDARY_SOURCES` を追加して同じ判定にした。

---

## 3. 変更ファイル一覧

**新規**

| ファイル | 役割 |
|---|---|
| `tests/_generated-data.mjs` | 生成物の有無だけを見る skip ヘルパー |
| `tools/validate/official-town-boundaries.js` | §8 の 24 区検証 validator |
| `tools/audit/official-town-boundaries-qa.js` | §9 の代表地点ブラウザ QA |
| `MISSION35L_REPORT.md` | 本書 |

**変更（35L 実装）**

- `tools/build-official-town-boundaries.js` — KEY_CODE 統合 / `townWards` を区名へ / ラベル正規化
- `tools/validate/station-town-navigation.js` — `ALLOWED_BOUNDARY_SOURCES` 追加、§12 判定を更新
- `tests/station-town-navigation.test.js` — 上記の意図更新

**変更（npm test の生成物ガード・20 ファイル / 26 件）**

`building-exact-near-alignment` / `canonical-spatial-alignment` / `city-labels-production-cutover` /
`citywide-missing-recovery` / `coordinate-system-authority` / `gsi-building-alignment` /
`gsi-building-outline-import` / `gsi-road-edge-prototype` / `gsi-road-hybrid-v1` /
`gsi-road-reconstruction-v2` / `gsi-road-reconstruction-v3` / `gsi-vs-fix13-road-comparison` /
`landmark-hd-poc` / `max-lod-reaudit` / `max-plateau-lod` / `mission06-water-surface` /
`mission10-building-height` / `mission11-landmarks` / `mission11b-landmark-layer` /
`mission12-park-lod` / `mission13-rail-lod` / `mission14-station-label` / `north-road-recovery` /
`osm-shared-source-audit` / `plateau-ortho-gsd` / `pre-production-cleanup` / `production-cutover`

**変更していない**

- `public/osaka_3d_buildings.fullward-v3.html`（protected）
- `public/osaka_3d_buildings.html`（production）
- `public/osaka_3d_buildings.ward-ux-v1.html`（dev HTML — 35L では触る必要が無かった）
- 建物 / 道路 / 鉄道 / 水域の geometry

---

## 4. テスト結果

| 対象 | 結果 |
|---|---|
| Mission 35L 専用テスト（`tests/mission35l-town-boundaries.test.js`） | **6 / 6 pass** |
| 既存境界回帰（`boundary-master` / `boundary-ingestion-validator` / `station-town-navigation`） | **57 / 57 pass** |
| 上記 4 ファイル合計 | **63 / 63 pass / fail 0** |
| フル `npm test`（作業機） | **2193 tests / 2178 pass / fail 0 / skipped 15** |
| 生成物ガードを入れたファイル（作業機・全 assertion 実行） | **394 / 394 pass / skipped 0** |

---

## 5. 24区 町丁目生成結果

```
node tools/download/estat-town-boundaries.js
  → data/raw/osaka-city/boundaries/estat-2020-town-boundaries-osaka.zip
     7,179,528 bytes / sha256 e8cede9aed9288c747f97f734bf27f11e51801edcaea1043bd4d5d6bd7a3a351
node tools/build-official-town-boundaries.js
  → official towns=1905 groups=490 wards=24 / labels town=555 wardFallback=0 unresolved=419
```

出所: 総務省統計局 e-Stat「令和2年国勢調査 小地域（町丁・字等）境界データ」大阪府（`r2ka27.shp`）
基準日 2020-10-01 / `boundarySource: estat-census-2020-official` / `officialBoundary: true`

- 大阪府全体 8,943 features → 大阪市 1,912 → **1,905 町丁目**（KEY_CODE 統合で 1908→1905）
- 除外した 7 件の内訳: 名前の無い **HCODE 8154（水面調査区）4 件**（此花区 / 港区 / 大正区 / 西淀川区、人口 0）
  ＋ その統合で 3 件減
- 基準地名の束ね（例: 梅田 = 梅田一〜三丁目）490 件
- 35K 比: 340 町丁目（3 区・出所未確認）→ **1,905 町丁目（24 区・公式）**

### MultiPolygon / hole

- ソースの大阪市分は **MultiPolygon 0 件**（e-Stat は多パートを別レコードに分ける方式）
- hole を持つ polygon は大阪市分で 2 件あるが、**いずれも除外対象の水面調査区**。
  名前のある町丁目で hole を持つものは **0 件** → 壊れた hole は無い
- 飛び地は KEY_CODE 統合で保持（住之江区 南港南 = 4 リング。リング総数 1,908 / 複数リングの町 1 件）

---

## 6. 24区ごとの町丁目数

| 区 | 件数 | 区 | 件数 | 区 | 件数 |
|---|---|---|---|---|---|
| 中央区 | 186 | 西成区 | 84 | 西区 | 59 |
| 平野区 | 140 | 城東区 | 76 | 鶴見区 | 59 |
| 北区 | 123 | 天王寺区 | 70 | 港区 | 58 |
| 住吉区 | 104 | 阿倍野区 | 68 | 大正区 | 48 |
| 住之江区 | 104 | 西淀川区 | 63 | 都島区 | 47 |
| 東住吉区 | 102 | 浪速区 | 62 | 旭区 | 45 |
| 生野区 | 90 | 此花区 | 60 | 東成区 | 44 |
| 淀川区 | 88 | 東淀川区 | 87 | 福島区 | 41 |

**合計 1,905 / 町丁目 0 件の区: なし**

---

## 7. fallback 使用状況

**N03 区界 fallback: 0 件**（`labelsToWardFallback: 0` / `wardFallbackUsage: {}`）

修正前は 10 件あった。理由は推測ポリゴンの不足ではなく、すべて**表記の突き合わせ漏れ**だった:

| 理由 | 件数 | ラベル |
|---|---|---|
| 「ヶ」と「ケ」の表記ゆれ | 7 | 照ヶ丘矢田 / 筆ヶ崎町 / 桃ヶ池町 / 松ヶ枝町 / 石ヶ辻町 / 松ヶ鼻町 / 烏ヶ辻 |
| `baseTownName` が末尾の「条」を丁目の数え方と誤認 | 3 | 十八条 / 九条 / 西九条 |

**推測で作った町界は 1 件も無い**（validator の出所チェックで担保）。
`labelsUnresolved: 419` はすべて大阪市域外の地名（PBF が市域より広いため）で、35K から変わっていない。

---

## 8. validator 結果

`node tools/validate/official-town-boundaries.js`

```
RESULT: PASS
classification: OFFICIAL_TOWN_BOUNDARIES_SUCCESS
errors: []   warnings: []
```

| 検査 | 結果 |
|---|---|
| 24 区すべてが対象 | 町丁目を持つ区 24 / 24 |
| polygon 0 件の区 | **なし** |
| ward 誤分類（重心を N03 区ポリゴンで引き直す） | **0 / 1,905** |
| geometry 破損（リング無し・頂点 < 4） | 0 |
| 市域 bbox の外 | 0 |
| 異常に巨大な町丁目（> 12km） | 0（最大 8,879m = 統合後の南港南） |
| KEY_CODE 重複 | 0 |
| 属性（名称 / 区名）欠け | 0 |
| geometry 欠け | 0 |
| `coordinateConvention` | `znorth-neg-v1` |
| 最寄り駅まで 4km 超の町丁目 | 0（最大 2,431m = 住之江区南港南六丁目・南港の埋立地） |

### znorth-neg-v1 の裏取り

35K の legacy 東粉浜（union）の bbox と、公式の東粉浜一〜三丁目の bbox の和が
**小数 2 桁まで完全一致**した。座標の向き・符号は既存 Live City と同じ枠に入っている。

```
35K legacy : minX -3171.5  maxX -2700.5  minZ -2121.1  maxZ -1036.5
35L official: 一丁目 minX -2982.16 maxX -2700.5  minZ -2121.13 maxZ -1867.32
              二丁目 minX -3058.63 maxX -2724.39 minZ -1982.69 maxZ -1503.15
              三丁目 minX -3171.51 maxX -2837.47 minZ -1574.8  maxZ -1036.53
```

---

## 9. 代表地点QA結果

`node tools/audit/official-town-boundaries-qa.js`（開く → 見る → 町名クリック → スクショ。Console 入力は不要）

指定 6 点（梅田・本町・難波・淡路・東三国・住吉）＋ 24 区から 6 点を追加した **12 地点**。

| 地点 | 区 | クリックした町名 | 粒度 | 出所 | ラベル↔範囲中心 | bbox内の建物 |
|---|---|---|---|---|---|---|
| 梅田 | 北区 | 中津 | chochome-union | 公式 | 169m | 123 |
| 本町 | 中央区 | 福島 | chochome-union | 公式 | 44m | 17 |
| 難波 | 中央区 | 博労町 | chochome-union | 公式 | 69m | 30 |
| 淡路 | 東淀川区 | 小松 | chochome-union | 公式 | 145m | 102 |
| 東三国 | 淀川区 | 十八条 | chochome-union | 公式 | — | — |
| 住吉 | 住吉区 | 東粉浜 | chochome-union | 公式 | 111m | 62 |
| 天王寺 | 天王寺区 | 寺田町 | chochome-union | 公式 | 34m | 0 |
| 京橋 | 都島区 | 成育 | chochome-union | 公式 | 74m | 0 |
| 此花 | 此花区 | 西島 | chochome-union | 公式 | 578m | 8 |
| 平野 | 平野区 | 加美正覚寺 | chochome-union | 公式 | 99m | 58 |
| 生野 | 生野区 | 鶴橋 | chochome-union | 公式 | 19m | 40 |
| 住之江 | 住之江区 | 平林北 | chochome-union | 公式 | 193m | 69 |

| 判定 | 結果 |
|---|---|
| 町名クリックができる | **12 / 12** |
| 正しい境界が表示される | **12 / 12**（輪郭メッシュ 4〜16） |
| 全地点が公式町丁目（区界 fallback なし） | **12 / 12** |
| bbox-fit zoom | **12 / 12**（fit 後のカメラ中心と町の中心のずれ **0m**） |
| 解除で消える | **12 / 12** |
| 大阪市外に飛んでいない | **12 / 12** |
| ラベルと範囲が大きくズレていない | 最大 **578m**（此花区西島・埋立地で町が大きい） |
| 建物との位置関係 | 12 地点中 10 地点で選択 bbox 内に建物メッシュを確認 |
| JS 例外 | **0** |

35K で区界へ落ちていた梅田・本町・淡路が、いずれも公式町丁目で選べるようになった。

### スクリーンショット保存場所

```
data/reports/official-town-boundaries-qa/<地点>.before.jpg     クリック前
data/reports/official-town-boundaries-qa/<地点>.selected.jpg   クリック直後（境界表示）
data/reports/official-town-boundaries-qa/<地点>.zoomed.jpg     bbox-fit zoom 後
```

（12 地点 × 3 枚 = 36 枚。`data/reports/*-qa/` は .gitignore 対象なのでコミットには含まれない）

---

## 10. protected baseline 未変更確認 / production 未反映確認

`git status public/` の差分なし（`public/assets/` は 35L 以前からの未追跡ディレクトリ）。

| ファイル | sha256 | 判定 |
|---|---|---|
| `public/osaka_3d_buildings.html`（production） | `27e7813a…ca26392e` | ビルド記録（35J cutover 時）と**一致** |
| `public/osaka_3d_buildings.fullward-v3.html`（protected） | `85ca253f…7e8b0176` | baseline と**一致** |

geometry 件数（canonical baseline との照合）:

| レイヤー | 件数 | 判定 |
|---|---|---|
| 建物 canonical V1 | 615,617 | 一致 |
| 建物 V4（dev 既定） | 618,749 | 一致 |
| 道路 | 199,840 | 一致 |
| 鉄道 | 3,216 | 一致 |
| 水域 | 823 | 一致 |
| 公園 | 4,194 | 一致 |
| 駅 | 253 | 一致 |

**production cutover は行っていない。main へ merge していない。Draft PR も merge していない。**

---

## 11. 残課題

1. **npm test の生成物ガードが 26 / 88 件で止まっている（要承認）**
   残り 62 件（32 ファイル）は、同じ内容の一括適用スクリプトが実行環境の安全確認で
   「テストの無効化」と判定されてブロックされた。作業自体は 2-1 と同じ形
   （`{ skip: <入力が無いときだけ真> }` を足すだけで assertion は触らない）。
   承認があれば残りを適用して CI の `npm test` を fail 0 にできる。
   対象の内訳: ブラウザハーネスを使う動的テスト 21 件 / cutover 記録・baseline hash 依存 11 件 /
   配信タイル依存 30 件。

   代替案として「CI の full test step を生成物非依存のサブセットに限定する」方法もあり、
   この場合テストファイルは 1 つも触らずに済む。どちらを採るかは判断を仰ぎたい。

2. **`tests/high-lod-visual-quality.test.js` の CRLF 脆弱性**
   HTML を `\n` 前提の正規表現で見ているため、`core.autocrlf=true` の Windows で clone すると
   5 件落ちる。CI（LF）では起きないので今回は触っていないが、Windows で作業する人が
   clone し直すと再現する。正規表現を `\r?\n` にするのが筋。

3. **`labelsUnresolved: 419`**
   大阪市域外の地名（PBF が市域より広い）。35K から変わっていない。
   市外の境界を持たない以上そのままだが、ラベル側で市外を落とす手もある。

4. **QA で建物 0 件だった 2 地点（天王寺区寺田町・都島区成育）**
   bbox-fit のカメラ移動直後に数えているため、タイルの再構築が間に合っていない可能性が高い。
   境界・ズーム・解除はいずれも正常で、データ側の問題を示すものは出ていない。
   計測タイミングを遅らせて確認するのが筋。

5. **dev HTML への反映は未実施**
   35L は配信データ（`area-boundaries.json`）を差し替えただけで、
   `public/osaka_3d_buildings.ward-ux-v1.html` は 35K のまま。QA のとおり 35K の実装で
   そのまま動くため変更していない。production への反映は**行っていない**。

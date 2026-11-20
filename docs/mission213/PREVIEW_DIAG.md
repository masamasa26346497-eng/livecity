# Preview 診断(read-only・認証回避なし)

GitHub の commit status が Vercel `success` でも、「現SHAの可視 Preview で24区が表示確認できた」とは別です。

## 認証の有無だけを識別する(権限変更なし)
```
curl -sS -o /dev/null -D - --max-redirs 0 "$PREVIEW_URL/ext-3dtiles/index.json" | head -5
```
- `200` : 認証なしで配信されている。
- `302/401/403`(Location が vercel.com/sso など): Vercel 認証保護で止まっている。これは認証が有効という意味で、障害ではありません。認証は解除しません。
- `404` : そのデプロイに `ext-3dtiles/` が無い(`vercel.json` の buildCommand に `--city-lod0` があるか確認)。
ログイン済みブラウザの DevTools Network で、`index.json` の `cityLod0` と `_city-lod0/tileset.json` が 200 かを確認してください。

## 未確認として記録する事項
- 現SHAの Preview で HTTP 200 / WebGL 描画: 未確認。
- 画面出典の「大阪市2024」表記は PLATEAU 2025 と不一致の可能性があり、**要検証**。出典表記は変更していません。

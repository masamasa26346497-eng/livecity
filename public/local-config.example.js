// public/local-config.example.js
// [Mission 36H §7] このファイルをコピーして public/local-config.js を作ると、
// dev HTML (osaka_3d_buildings.ward-ux-v1.html) が Google Places の写真を
// オンデマンドで取得できるようになる。public/local-config.js 自体はコミットしないこと
// （.gitignore 済み）。
//
// 重要: これはブラウザから直接 Google Places API を呼ぶための「クライアント側」キーである。
// Google Cloud Console 側で、このサイトを配信するオリジン（HTTPリファラー）に限定した
// 「アプリケーション制限」を必ず設定し、Places API (New) 以外は有効化しないこと。
// 制限をかけないキーをコミット・配布しないこと。
window.LIVECITY_CONFIG = {
  googlePlacesApiKey: '',
  // [Mission 37] Google Map Tiles API / Photorealistic 3D Tiles 用。Places APIキーとは分離推奨。
  googleMapTilesApiKey: '',
};

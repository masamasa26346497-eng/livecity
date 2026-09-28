// tools/google-places/match-pilot-places.mjs
// [Mission 36H §9/§12] パイロット候補（data/photos/google-places-pilot-candidates.json）を
//   Google Places API (New) の Text Search で検索し、保守的マッチング
//   （tools/google-places/lib/pilot-matching.mjs）で対応付ける。
//
//   実行にはネットワーク接続と GOOGLE_PLACES_API_KEY が必要（CLAUDE.md の環境分離表の
//   data:download 系と同じ扱い）。このサンドボックスでは実行できない。ローカルPC /
//   将来のGitHub Actionsで:
//     GOOGLE_PLACES_API_KEY=xxxx npm run data:google-places:match-pilot
//
//   VERIFIED になったものだけを durable mapping（data/photos/google-places-pilot-mapping.json）
//   へ書く。書く直前に必ず persistence-guard を通し、禁止フィールドが混入していないか検査する。
//   AMBIGUOUS / UNRESOLVED は mapping に書かず、レポートに理由を残す（§9: 曖昧なものは解決しない）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { classifyPilotMatch } from './lib/pilot-matching.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';

const CANDIDATES = resolveProjectPath('data/photos/google-places-pilot-candidates.json');
// BuildingPhoto の building-photo-index.json と同じ置き場所の考え方: durable mapping そのものが
// 配信物（public/map-data/{areaId}/...）を兼ねる。禁止フィールドは persistence-guard が事前に
// 弾いているので、このファイルをそのまま配信してよい。
const OUT_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-pilot-mapping.json');
const REPORT_DIR = resolveProjectPath('data/reports/mission36h-google-places-pilot');

export async function runPilotMatch({ apiKey = loadGooglePlacesApiKeyFromEnv(), fetchImpl, dryRun = false } = {}) {
  const input = JSON.parse(fs.readFileSync(CANDIDATES, 'utf-8'));
  const client = createPlacesClient({ apiKey, fetchImpl });

  if (!client.isEnabled()) {
    return {
      ok: false, reason: 'no-api-key',
      message: 'GOOGLE_PLACES_API_KEY が未設定。ネットワーク接続があるローカル環境で '
        + '環境変数を設定して再実行すること（.env.example 参照）。',
    };
  }

  const verified = [];
  const unresolved = [];
  for (const c of input.candidates) {
    const search = await client.searchText({ textQuery: c.name, lat: c.expectLat, lon: c.expectLon });
    if (!search.ok) {
      unresolved.push({ facilityId: c.facilityId, name: c.name, matchConfidence: 'UNRESOLVED',
        reason: 'Places API 呼び出し失敗: ' + search.reason });
      continue;
    }
    const result = classifyPilotMatch(c, search.places);
    if (result.matchConfidence === 'VERIFIED') {
      const record = assertDurableRecordSafe({
        facilityId: c.facilityId, googlePlaceId: result.googlePlaceId, name: c.name,
        relevanceClass: c.relevanceClass, matchConfidence: 'VERIFIED',
        matchReason: result.reason, distanceMeters: result.distanceMeters,
        verifiedAt: new Date().toISOString(), verifiedBy: 'automated-pilot-match',
      });
      verified.push(record);
    } else {
      unresolved.push({ facilityId: c.facilityId, name: c.name,
        matchConfidence: result.matchConfidence, reason: result.reason });
    }
  }

  const mapping = {
    version: 1, mission: '36H', generatedAt: new Date().toISOString(),
    policy: {
      persistsOnlyLinkage: true,
      neverPersists: ['photo binaries', 'photo media URLs', 'resource names as permanent'],
      resolvesPhotosAtDisplayTime: true,
    },
    counts: { verified: verified.length, unresolved: unresolved.length, total: input.candidates.length },
    entries: verified,
  };
  // dryRun: テスト用。実ファイル（配信物である public/map-data 配下）を書き換えない。
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_MAPPING), { recursive: true });
    fs.writeFileSync(OUT_MAPPING, JSON.stringify(mapping, null, 2));

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'pilot-match-report.json'),
      JSON.stringify({ counts: mapping.counts, unresolved, apiUsage: client.getDebugCounters() }, null, 2));
  }

  return { ok: true, counts: mapping.counts, unresolved, mapping };
}

if (isMainModule(import.meta.url)) {
  runPilotMatch().then((r) => {
    if (!r.ok) { console.error('[google-places pilot]', r.message); process.exit(1); }
    console.log('[google-places pilot]', JSON.stringify(r.counts));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}

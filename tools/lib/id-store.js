// ══════════════════════════════════════════════════════════════
// tools/lib/id-store.js
// ══════════════════════════════════════════════════════════════
// 重複ID判定のためのストア。区単位の小規模処理ではメモリSetを使い、
// 件数が上限を超えたら自動でディスクベース索引へ切り替える（全ID常駐を避ける）。
//
// ディスク索引方式: IDのsha1先頭を16進ハッシュ化し、先頭2文字でシャーディングした
// 追記ファイル(bucket)に記録。has()はbucketを読んで判定する（LRUで少数bucketのみキャッシュ）。
// 新しい依存を増やさず、Node標準機能のみで実装する。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class IdStore {
  // maxMemory: この件数を超えたらディスク方式へ切替。dir: ディスク索引の保存先。
  constructor({ maxMemory = 2_000_000, dir = null } = {}) {
    this.maxMemory = maxMemory;
    this.dir = dir;
    this.mem = new Set();
    this.onDisk = false;
    this.bucketCache = new Map(); // bucketName -> Set（LRU的に少数のみ保持）
    this.bucketCacheMax = 32;
    this.count = 0;
  }

  _hash(id) { return crypto.createHash('sha1').update(String(id)).digest('hex'); }
  _bucketName(h) { return h.slice(0, 2); } // 256分割

  _switchToDisk() {
    if (this.onDisk) return;
    if (!this.dir) throw new Error('IdStore: ディスク切替にはdirが必要です');
    fs.mkdirSync(this.dir, { recursive: true });
    // 既存メモリの内容をbucketへ同期書き出し（bucketごとにまとめてappend）
    const byBucket = new Map();
    for (const id of this.mem) {
      const h = this._hash(id); const b = this._bucketName(h);
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push(h);
    }
    for (const [b, arr] of byBucket) {
      fs.appendFileSync(path.join(this.dir, b + '.idx'), arr.join('\n') + '\n');
    }
    this.mem.clear();
    this.bucketCache.clear(); // 古いキャッシュを破棄して次回ディスクから読み直す
    this.onDisk = true;
  }

  _loadBucket(b) {
    if (this.bucketCache.has(b)) { const s = this.bucketCache.get(b); this.bucketCache.delete(b); this.bucketCache.set(b, s); return s; }
    const p = path.join(this.dir, b + '.idx');
    const set = new Set();
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      for (const line of txt.split('\n')) if (line) set.add(line);
    }
    if (this.bucketCache.size >= this.bucketCacheMax) {
      const oldest = this.bucketCache.keys().next().value;
      this.bucketCache.delete(oldest);
    }
    this.bucketCache.set(b, set);
    return set;
  }

  has(id) {
    if (!this.onDisk) return this.mem.has(id);
    const h = this._hash(id); const b = this._bucketName(h);
    return this._loadBucket(b).has(h);
  }

  add(id) {
    if (!this.onDisk) {
      this.mem.add(id); this.count = this.mem.size;
      if (this.mem.size > this.maxMemory) this._switchToDisk(); // 切替時、このidも書き出し済み
      return;
    }
    const h = this._hash(id); const b = this._bucketName(h);
    const set = this._loadBucket(b);
    if (!set.has(h)) {
      set.add(h);
      fs.appendFileSync(path.join(this.dir, b + '.idx'), h + '\n');
      this.count++;
    }
  }

  delete(id) {
    if (!this.onDisk) { this.mem.delete(id); this.count = this.mem.size; return; }
    // ディスク方式のdeleteはbucket全書き換え（頻繁でない前提）
    const h = this._hash(id); const b = this._bucketName(h);
    const set = this._loadBucket(b);
    if (set.delete(h)) {
      fs.writeFileSync(path.join(this.dir, b + '.idx'), [...set].join('\n') + (set.size ? '\n' : ''));
      this.count--;
    }
  }

  get size() { return this.count; }
  get mode() { return this.onDisk ? 'disk' : 'memory'; }

  // ディスク索引を破棄
  destroy() {
    if (this.dir && fs.existsSync(this.dir)) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {} }
    this.mem.clear(); this.bucketCache.clear();
  }
}

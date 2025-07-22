// backend/dedup/dedupService.js
import pkg                    from 'tldts';
import natural                from 'natural';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Bottleneck             from 'bottleneck';

const { fromUrl } = pkg;

const GENERIC_SUBS = new Set(['', 'www', 'api', 'app', 'blog', 'docs']);
const JARO_THRESH  = 0.90;
const LLM_BATCH    = 25;
const LLM_LAT_MS   = 300;

const genAI  = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// serialize calls so we don't smash rate limits
const limiter = new Bottleneck({ maxConcurrent: 1 });

export class DedupService {
  constructor(broadcast) {
    this.broadcast   = broadcast;
    this.table       = new Map(); // key0 -> row
    this.pending     = new Map(); // rowId -> pairStub
    this.llmCache    = new Map(); // hostpair -> boolean
    this.batch       = [];
    this.batchTimer  = null;
  }

  async ingest(websetId, item) {
    const row = this._canonItem(item);

    const key0 = `${row.brand}:${row.etld1}:${row.subCls}`;
    if (this.table.has(key0)) return; // Tier 0 exact

    let greyMatch = null;
    for (const other of this.table.values()) {
      const res = this._fuzzyDup(row, other);
      if (res === true) return;          // confirmed dup
      if (res === null && !greyMatch) greyMatch = other;
    }

    if (!greyMatch) {
      this._accept(row, websetId);
      return;
    }

    if (this._cacheHit(row, greyMatch)) return;

    this._queueLLMPair(row, greyMatch, websetId);
  }

  /* ---------------- internal ---------------- */

  _canonItem(item) {
    const u = item.url || item.source || '';
    const info = fromUrl(u);
    const brand = (info.domain || '').replace(/[-_\d]/g, '').toLowerCase();
    const etld1 = info.domain ? `${info.domain}.${info.publicSuffix}` : '';
    const subCls = GENERIC_SUBS.has(info.subdomain || '') ? 'generic' : 'other';
    return {
      rowId:  item.id || crypto.randomUUID(),
      name:   (item.name || item.title || '').trim(),
      url:    u,
      host:   info.hostname || '',
      brand, etld1, subCls,
      raw:    item
    };
  }

  _fuzzyDup(a, b) {
    if (a.etld1 === b.etld1 && a.subCls === 'generic' && b.subCls === 'generic') return true;
    const score = natural.JaroWinklerDistance(a.name.toLowerCase(), b.name.toLowerCase());
    if (score > JARO_THRESH) return true;
    if (a.brand !== b.brand && a.etld1 !== b.etld1) return false;
    return null;
  }

  _cacheHit(a, b) {
    const k = [a.etld1, b.etld1].sort().join('|');
    return this.llmCache.get(k) === true;
  }

  _queueLLMPair(a, b, websetId) {
    const p = {
      idA: a.rowId, idB: b.rowId,
      nameA: a.name, urlA: a.url,
      nameB: b.name, urlB: b.url,
      websetId,
      rawA: a.raw
    };
    this.pending.set(a.rowId, p);
    this.broadcast(websetId, { type: 'pending', tmpId: a.rowId });

    this.batch.push(p);
    if (this.batch.length >= LLM_BATCH) this._flushBatch();
    else if (!this.batchTimer) this.batchTimer = setTimeout(() => this._flushBatch(), LLM_LAT_MS);
  }

  async _flushBatch() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const batch = this.batch.splice(0);
    if (!batch.length) return;

    const prompt = {
      query_profile: 'STRICT',
      pairs: batch.map(p => [p.nameA, p.urlA, p.nameB, p.urlB])
    };

    let resp;
    try {
      resp = await limiter.schedule(() =>
        gemini.generateContent({
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(prompt) }] }],
          generationConfig: { responseFormat: { type: 'json_object' } }
        })
      );
    } catch (err) {
      console.error('Gemini error:', err);
      // treat all as unique fallback
      for (const p of batch) this._confirmPending(p, false);
      return;
    }

    let verdicts;
    try {
      verdicts = JSON.parse(resp.response.text).pairs;
    } catch (err) {
      console.warn('Parse fail; default unique:', err);
      verdicts = batch.map(() => [false]);
    }

    verdicts.forEach(([same], i) => {
      const p = batch[i];
      this._confirmPending(p, same);
    });
  }

  _confirmPending(p, same) {
    const cacheKey = [this._hostFromUrl(p.urlA), this._hostFromUrl(p.urlB)].sort().join('|');
    this.llmCache.set(cacheKey, !!same);

    if (same) {
      // drop row A
      this.broadcast(p.websetId, { type: 'drop', tmpId: p.idA });
      this.pending.delete(p.idA);
    } else {
      // accept row A
      const aCanon = this._canonItem({ ...p.rawA, url: p.urlA, name: p.nameA });
      this._accept(aCanon, p.websetId);
      this.broadcast(p.websetId, { type: 'confirm', data: p.rawA });
      this.pending.delete(p.idA);
    }
  }

  _accept(row, websetId) {
    const key0 = `${row.brand}:${row.etld1}:${row.subCls}`;
    this.table.set(key0, row);
    this.broadcast(websetId, { type: 'item', item: row.raw });
  }

  _hostFromUrl(u) {
    try { return new URL(u).host; } catch { return u; }
  }
}

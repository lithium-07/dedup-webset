// backend/dedup/dedupService.js
import * as tldts             from 'tldts';
import natural                from 'natural';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Bottleneck             from 'bottleneck';
import { vecAdd, vecQuery } from './vectorClient.js';


const { parse: fromUrl } = tldts;

const GENERIC_SUBS = new Set(['', 'www', 'api', 'app', 'blog', 'docs']);
const JARO_THRESH  = 0.95; // Increased threshold - only reject very similar names
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
    const startTime = Date.now();
    console.log(`🔍 DEDUP: Starting ingest for item ${item.id}`, { websetId, url: item.url, name: item.name || item.title });
    
    const row = this._canonItem(item);
    console.log(`🔍 DEDUP: Canonicalized item`, { 
      brand: row.brand, 
      etld1: row.etld1, 
      subCls: row.subCls,
      name: row.name 
    });

    const key0 = `${row.brand}:${row.etld1}:${row.subCls}`;
    console.log(`🔍 DEDUP: Checking key0: ${key0}, table size: ${this.table.size}`);
    
    if (this.table.has(key0)) {
      console.log(`❌ DEDUP: Tier 0 exact match found - REJECTING (${Date.now() - startTime}ms)`);
      const existingItem = this.table.get(key0);
      this.broadcast(websetId, { 
        type: 'rejected', 
        item: row.raw,
        reason: 'exact_match',
        existingItem: existingItem.raw,
        details: `Exact key match: ${key0}`
      });
      return; // Tier 0 exact
    }

    let greyMatch = null;
    let fuzzyChecks = 0;
    for (const other of this.table.values()) {
      fuzzyChecks++;
      const res = this._fuzzyDup(row, other);
      if (res === true) {
        console.log(`❌ DEDUP: Tier 1 fuzzy match found with ${other.name} - REJECTING (${Date.now() - startTime}ms, ${fuzzyChecks} checks)`);
        this.broadcast(websetId, { 
          type: 'rejected', 
          item: row.raw,
          reason: 'fuzzy_match',
          existingItem: other.raw,
          details: `Similar to: ${other.name}`
        });
        return;          // confirmed dup
      }
      if (res === null && !greyMatch) greyMatch = other;
    }
    console.log(`🔍 DEDUP: Fuzzy check complete (${fuzzyChecks} comparisons), greyMatch: ${greyMatch ? greyMatch.name : 'none'}`);

    if (!greyMatch) {
      console.log(`✅ DEDUP: No conflicts found - ACCEPTING immediately (${Date.now() - startTime}ms)`);
      this._accept(row, websetId);
      return;
    }

    const hits = await vecQuery(row.name || row.url, 5); // Increased from 3 to 5 for better coverage
    if (hits.some(id => this.pending.has(id) || this.table.has(id))) {
      console.log(`❌ DEDUP: Near‑duplicate found - REJECTING (${Date.now() - startTime}ms)`);
      this.broadcast(websetId, { 
        type: 'rejected', 
        item: row.raw,
        reason: 'near_duplicate',
        existingItem: hits.map(id => this.table.get(id).raw),
        details: `Near‑duplicate found: ${hits.map(id => this.table.get(id).name).join(', ')}`
      });
      return;
    }

    // NEW: Additional vector check using URL if different from name
    if (row.url && row.url !== row.name) {
      const urlHits = await vecQuery(row.url, 3);
      if (urlHits.some(id => this.pending.has(id) || this.table.has(id))) {
        console.log(`❌ DEDUP: URL-based near‑duplicate found - REJECTING (${Date.now() - startTime}ms)`);
        this.broadcast(websetId, { 
          type: 'rejected', 
          item: row.raw,
          reason: 'url_near_duplicate',
          existingItem: urlHits.map(id => this.table.get(id).raw),
          details: `URL-based near‑duplicate found: ${urlHits.map(id => this.table.get(id).name).join(', ')}`
        });
        return;
      }
    }

    if (this._cacheHit(row, greyMatch)) {
      console.log(`❌ DEDUP: Cache hit indicates duplicate - REJECTING (${Date.now() - startTime}ms)`);
      this.broadcast(websetId, { 
        type: 'rejected', 
        item: row.raw,
        reason: 'cache_hit',
        existingItem: greyMatch.raw,
        details: `Previously determined to be duplicate of: ${greyMatch.name}`
      });
      return;
    }

    console.log(`⏳ DEDUP: Queueing for LLM verification vs ${greyMatch.name} (${Date.now() - startTime}ms)`);
    this._queueLLMPair(row, greyMatch, websetId);
  }

  /* ---------------- internal ---------------- */

  _canonItem(item) {
    // Debug: log the full item structure
    console.log(`🔍 DEDUP: Full item structure:`, JSON.stringify(item, null, 2));
    
    // Extract URL from various possible locations in Exa item structure
    // Prioritize actual URLs over source identifiers like "search"
    let u = '';
    
    // First priority: properties.url (the actual website URL)
    if (item.properties?.url) {
      u = item.properties.url;
    }
    // Second priority: direct url field
    else if (item.url) {
      u = item.url;
    }
    // Third priority: nested URLs in properties (like company.website)
    else {
      const props = item.properties || {};
      for (const [key, value] of Object.entries(props)) {
        if (typeof value === 'object' && value !== null) {
          if (value.url || value.website) {
            u = value.url || value.website;
            break;
          }
        }
      }
    }
    
    // Last resort: use source field only if it looks like a URL
    if (!u && item.source && (item.source.startsWith('http') || item.source.includes('.'))) {
      u = item.source;
    }
    
    console.log(`🔍 DEDUP: Extracted URL: ${u}`);
    
    // Extract name from various possible locations
    let name = '';
    
    // First priority: direct name/title fields
    if (item.name) {
      name = item.name;
    } else if (item.title) {
      name = item.title;
    } else if (item.properties?.name) {
      name = item.properties.name;
    } else if (item.properties?.title) {
      name = item.properties.title;
    }
    // Second priority: company name from nested objects
    else if (item.properties?.company?.name) {
      name = item.properties.company.name;
    }
    // Third priority: search in all nested properties
    else {
      const props = item.properties || {};
      for (const [key, value] of Object.entries(props)) {
        if (typeof value === 'object' && value !== null) {
          if (value.name || value.title || value.company_name) {
            name = value.name || value.title || value.company_name;
            break;
          }
        }
      }
    }
    
    // Fallback: extract from URL domain if no name found
    if (!name && u) {
      const urlInfo = fromUrl(u);
      if (urlInfo.domain) {
        name = urlInfo.domain.replace(/\.(com|org|net|io|co)$/, '');
      }
    }
    
    console.log(`🔍 DEDUP: Extracted name: ${name}`);
    
    const info = fromUrl(u);
    const brand = (info.domain || '').replace(/[-_\d]/g, '').toLowerCase();
    const etld1 = info.domain ? `${info.domain}.${info.publicSuffix}` : '';
    const subCls = GENERIC_SUBS.has(info.subdomain || '') ? 'generic' : 'other';
    
    const canonicalized = {
      rowId:  item.id || crypto.randomUUID(),
      name:   (name || '').trim(),
      url:    u,
      host:   info.hostname || '',
      brand, etld1, subCls,
      raw:    item
    };
    
    console.log(`🔍 DEDUP: Canonicalized result:`, canonicalized);
    
    return canonicalized;
  }

  _fuzzyDup(a, b) {
    // Check for exact domain matches with generic subdomains
    if (a.etld1 === b.etld1 && a.subCls === 'generic' && b.subCls === 'generic') {
      console.log(`🔍 DEDUP: Domain match found: ${a.etld1} (both generic subdomains)`);
      return true;
    }
    
    // NEW: Check for same brand across different domains (e.g., jd.com, jd.hk, global.jd.com)
    if (a.brand === b.brand && a.brand.length > 2) {
      console.log(`🔍 DEDUP: Same brand "${a.brand}" across different domains: ${a.etld1} vs ${b.etld1}`);
      
      // If both have generic subdomains, they're likely duplicates
      if (a.subCls === 'generic' && b.subCls === 'generic') {
        console.log(`🔍 DEDUP: Both generic subdomains - treating as duplicate`);
        return true;
      }
      
      // If one is generic and the other is specific, still likely duplicate
      if ((a.subCls === 'generic' && b.subCls === 'other') || 
          (a.subCls === 'other' && b.subCls === 'generic')) {
        console.log(`🔍 DEDUP: Mixed subdomain types - treating as potential duplicate`);
        return null; // Send to LLM for verification
      }
      
      // If both are specific subdomains, check name similarity
      if (a.subCls === 'other' && b.subCls === 'other') {
        const score = natural.JaroWinklerDistance(a.name.toLowerCase(), b.name.toLowerCase());
        console.log(`🔍 DEDUP: Same brand, specific subdomains, name similarity: ${score.toFixed(3)}`);
        if (score > 0.8) { // Lower threshold for same-brand cases
          console.log(`🔍 DEDUP: High similarity for same brand - REJECTING`);
          return true;
        }
        return null; // Send to LLM for verification
      }
    }
    
    // Calculate name similarity
    const score = natural.JaroWinklerDistance(a.name.toLowerCase(), b.name.toLowerCase());
    console.log(`🔍 DEDUP: Name similarity "${a.name}" vs "${b.name}": ${score.toFixed(3)} (threshold: ${JARO_THRESH})`);
    
    if (score > JARO_THRESH) {
      console.log(`🔍 DEDUP: High similarity match - REJECTING at Tier 1`);
      return true;
    }
    
    // If different brands and domains, definitely not duplicates
    if (a.brand !== b.brand && a.etld1 !== b.etld1) {
      console.log(`🔍 DEDUP: Different brands (${a.brand} vs ${b.brand}) and domains - clearly unique`);
      return false;
    }
    
    // Ambiguous case - needs LLM verification
    console.log(`🔍 DEDUP: Ambiguous case - similar brand/domain but low name similarity`);
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
    console.log(`⏳ DEDUP: Broadcasting PENDING for ${a.name} (batch size: ${this.batch.length + 1}/${LLM_BATCH})`);
    this.broadcast(websetId, { type: 'pending', tmpId: a.rowId });

    this.batch.push(p);
    if (this.batch.length >= LLM_BATCH) {
      console.log(`🚀 DEDUP: Batch full (${LLM_BATCH}), flushing to LLM immediately`);
      this._flushBatch();
    } else if (!this.batchTimer) {
      console.log(`⏲️ DEDUP: Starting batch timer (${LLM_LAT_MS}ms) for ${this.batch.length} items`);
      this.batchTimer = setTimeout(() => this._flushBatch(), LLM_LAT_MS);
    }
  }

  async _flushBatch() {
    const flushStartTime = Date.now();
    console.log(`🧠 DEDUP: Flushing LLM batch (${this.batch.length} pairs)`);
    
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const batch = this.batch.splice(0);
    if (!batch.length) {
      console.log(`🧠 DEDUP: Empty batch, nothing to process`);
      return;
    }

    const prompt = {
      query_profile: 'STRICT',
      pairs: batch.map(p => [p.nameA, p.urlA, p.nameB, p.urlB])
    };
    
    console.log(`🧠 DEDUP: Sending ${batch.length} pairs to LLM:`, batch.map(p => `${p.nameA} vs ${p.nameB}`));

    let resp;
    try {
      const llmStartTime = Date.now();
      resp = await limiter.schedule(() =>
        gemini.generateContent({
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(prompt) }] }],
          generationConfig: { responseFormat: { type: 'json_object' } }
        })
      );
      console.log(`🧠 DEDUP: LLM response received (${Date.now() - llmStartTime}ms)`);
    } catch (err) {
      console.error(`❌ DEDUP: Gemini error (${Date.now() - flushStartTime}ms):`, err);
      // treat all as unique fallback
      for (const p of batch) this._confirmPending(p, false);
      return;
    }

    let verdicts;
    try {
      verdicts = JSON.parse(resp.response.text()).pairs;
      console.log(`🧠 DEDUP: Parsed ${verdicts.length} verdicts:`, verdicts.map(([same], i) => `${batch[i].nameA}: ${same ? 'DUP' : 'UNIQUE'}`));
    } catch (err) {
      console.warn(`⚠️ DEDUP: Parse fail; default unique (${Date.now() - flushStartTime}ms):`, err);
      verdicts = batch.map(() => [false]);
    }

    verdicts.forEach(([same], i) => {
      const p = batch[i];
      console.log(`${same ? '❌' : '✅'} DEDUP: ${same ? 'DROPPING' : 'CONFIRMING'} ${p.nameA}`);
      this._confirmPending(p, same);
    });
    
    console.log(`🧠 DEDUP: Batch processing complete (${Date.now() - flushStartTime}ms total)`);
  }

  _confirmPending(p, same) {
    const cacheKey = [this._hostFromUrl(p.urlA), this._hostFromUrl(p.urlB)].sort().join('|');
    this.llmCache.set(cacheKey, !!same);

    if (same) {
      // drop row A - broadcast as rejected
      this.broadcast(p.websetId, { 
        type: 'rejected', 
        item: p.rawA,
        reason: 'llm_duplicate',
        existingItem: null, // We don't have the exact existing item here
        details: `LLM determined duplicate of: ${p.nameB}`
      });
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
    
    // Add both name and URL to vector store for better coverage
    vecAdd(row.rowId, row.name || row.url);
    if (row.url && row.url !== row.name) {
      vecAdd(row.rowId, row.url);
    }
    
    console.log(`✅ DEDUP: ACCEPTED item ${row.rowId} (${row.name}) - broadcasting to frontend`);
    this.broadcast(websetId, { type: 'item', item: row.raw });
  }

  _hostFromUrl(u) {
    try { return new URL(u).host; } catch { return u; }
  }
}

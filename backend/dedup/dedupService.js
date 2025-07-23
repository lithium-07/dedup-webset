// backend/dedup/dedupService.js
import * as tldts             from 'tldts';
import natural                from 'natural';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Bottleneck             from 'bottleneck';
import { vecAdd, vecQuery } from './vectorClient.js';
import fetch from 'node-fetch'; // For URL resolution
import Webset from '../models/Webset.js';
import Item from '../models/Item.js';


const { parse: fromUrl } = tldts;

// IMPROVEMENT 1: Expanded list of generic subdomains that should be treated as equivalent
const GENERIC_SUBS = new Set([
  '', 'www', 'api', 'app', 'blog', 'docs', 'about', 'info', 'help', 'support', 
  'contact', 'careers', 'jobs', 'news', 'press', 'media', 'home', 'main', 
  'portal', 'dashboard', 'admin', 'login', 'auth', 'secure', 'shop', 'store',
  'web', 'site', 'page', 'landing', 'welcome', 'intro', 'global'
]);

// IMPROVEMENT 2: Common subdomain patterns that likely represent the same organization
const ORGANIZATIONAL_SUBS = new Set([
  'about', 'company', 'corp', 'corporate', 'business', 'enterprise',
  'careers', 'jobs', 'hr', 'talent', 'recruitment',
  'contact', 'support', 'help', 'service', 'customer',
  'info', 'information', 'details', 'overview',
  'press', 'media', 'news', 'blog', 'newsroom',
  'investor', 'investors', 'ir', 'relations'
]);

const JARO_THRESH  = 0.95; // Increased threshold - only reject very similar names  
const ENTITY_JARO_THRESH = 0.92; // Increased threshold for entities to avoid false positives
const VIDEO_PLATFORMS = new Set(['youtube.com', 'vimeo.com', 'dailymotion.com']);
const LLM_BATCH    = 25;
const LLM_LAT_MS   = 300;

const genAI  = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// serialize calls so we don't smash rate limits
const limiter = new Bottleneck({ maxConcurrent: 1 });

export class DedupService {
  constructor(broadcast, entityType = null) {
    this.broadcast   = broadcast;
    this.entityType  = entityType;
    this.table       = new Map(); // key0 -> row
    this.pending     = new Map(); // rowId -> pairStub
    this.llmCache    = new Map(); // hostpair -> boolean
    this.batch       = [];
    this.batchTimer  = null;
    // BULLETPROOF: Entity-only features (companies use original flow)
    this.processingQueue = []; // Sequential processing queue for entities
    this.isProcessing = false;
    this.processedTitles = new Map(); // Entity normalized titles -> item info
    this.processedUrls = new Set(); // Entity exact URLs
    // Track processed items by ID to prevent duplicates
    this.processedIds = new Set(); // Track all processed item IDs
  }

  // BULLETPROOF: Queue-based sequential processing for entities only
  async ingest(websetId, item) {
    // Generate ID if missing
    if (!item || (!item.id && !item.properties?.id)) {
      const generatedItem = {
        ...item,
        id: `item_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
      };
      console.log(`🔄 DEDUP: Generated ID for item:`, generatedItem.id);
      item = generatedItem;
    }

    // Check if we've already processed this item
    const itemId = item.id || item.properties?.id;
    if (this.processedIds.has(itemId)) {
      console.log(`⚠️ DEDUP: Item ${itemId} already processed, skipping`);
      return;
    }
    this.processedIds.add(itemId);

    if (this.entityType) {
      // Entities: Use bulletproof sequential processing
      return new Promise((resolve, reject) => {
        // FIXED: Add safety checks
        if (!item) {
          console.error('❌ DEDUP: Invalid item passed to ingest:', item);
          reject(new Error('Invalid item'));
          return;
        }
        
        this.processingQueue.push({ websetId, item, resolve, reject });
        this._processQueue();
      });
    } else {
      // Companies: Keep original parallel processing
      return this._processItemSequentially(websetId, item);
    }
  }

  async _processQueue() {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    
    try {
      while (this.processingQueue.length > 0) {
        const { websetId, item, resolve, reject } = this.processingQueue.shift();
        
        try {
          await this._processItemSequentially(websetId, item);
          resolve();
        } catch (error) {
          console.error(`❌ DEDUP: Processing error for item ${item?.id || 'unknown'}:`, error);
          reject(error);
          // Don't break the queue processing on individual item errors
        }
      }
    } catch (error) {
      console.error('❌ DEDUP: Fatal error in queue processing:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  async _processItemSequentially(websetId, item) {
    const startTime = Date.now();
    console.log(`🔍 DEDUP: ${this.entityType ? 'BULLETPROOF ENTITY' : 'COMPANY'} processing for item ${item.id}`, { 
      websetId, 
      url: item.url, 
      name: item.name || item.title,
      entityType: this.entityType || 'company',
      queueLength: this.entityType ? this.processingQueue.length : 'N/A (parallel)'
    });
    
    const row = this._canonItem(item);
    console.log(`🔍 DEDUP: Canonicalized item`, { 
      brand: row.brand, 
      etld1: row.etld1, 
      subCls: row.subCls,
      name: row.name 
    });

    // BULLETPROOF LAYERS: Only for entities
    if (this.entityType) {
      // BULLETPROOF LAYER 1: Exact URL duplicate check (fastest)
      if (row.url && this.processedUrls.has(row.url)) {
        console.log(`❌ DEDUP: BULLETPROOF Layer 1 - Exact URL duplicate: ${row.url}`);
        await this._broadcastRejection(
          websetId, 
          row.raw, 
          'exact_url_duplicate',
          `Exact URL already processed: ${row.url}`,
          null
        );
        return;
      }

      // BULLETPROOF LAYER 2: Normalized title duplicate check
      if (row.name) {
        const normalizedTitle = this._normalizeEntityTitle(row.name);
        if (normalizedTitle && this.processedTitles.has(normalizedTitle)) {
          const existing = this.processedTitles.get(normalizedTitle);
          console.log(`❌ DEDUP: BULLETPROOF Layer 2 - Normalized title duplicate: "${normalizedTitle}"`);
          await this._broadcastRejection(
            websetId,
            row.raw,
            'normalized_title_duplicate', 
            `Normalized title already processed: "${normalizedTitle}" (existing: ${existing.name})`,
            existing.raw
          );
          return;
        }
      }
    }

    const key0 = `${row.brand}:${row.etld1}:${row.subCls}`;
    console.log(`🔍 DEDUP: Checking key0: ${key0}, table size: ${this.table.size}`);
    
    // For exact domain matches, still reject immediately
    if (this.table.has(key0) && !this.entityType) {
      console.log(`❌ DEDUP: Tier 0 exact match found - REJECTING (${Date.now() - startTime}ms)`);
      const existingItem = this.table.get(key0);
      await this._broadcastRejection(
        websetId,
        row.raw,
        'exact_match',
        `Exact key match: ${key0}`,
        existingItem.raw
      );
      return;
    }

    // Collect potential duplicates through multiple methods
    const candidatePool = new Set();
    
    if (this.entityType) {
      // For entities: Collect ALL potential duplicates for comprehensive LLM decision
      let fuzzyChecks = 0;
      const allSimilarEntities = [];  // Initialize array for collecting similar entities
      
      for (const other of this.table.values()) {
        fuzzyChecks++;
        const res = this._fuzzyDup(row, other);
        if (res === true) {
          console.log(`❌ DEDUP: Entity fuzzy match found with ${other.name} - REJECTING (${Date.now() - startTime}ms, ${fuzzyChecks} checks)`);
          this.broadcast(websetId, { 
            type: 'rejected', 
            item: row.raw,
            reason: 'entity_fuzzy_match',
            existingItem: other.raw,
            details: `Entity similar to: ${other.name}`
          });
          return;          // confirmed dup
        }
        if (res === null) {
          allSimilarEntities.push(other);
        }
      }
      console.log(`🔍 DEDUP: Entity fuzzy check complete (${fuzzyChecks} comparisons), found ${allSimilarEntities.length} potential matches`);
      
      // If no similar entities found, accept immediately
      if (allSimilarEntities.length === 0) {
        console.log(`✅ DEDUP: No similar entities found - ACCEPTING immediately (${Date.now() - startTime}ms)`);
        await this._accept(row, websetId);
        return;
      }

      // Queue for LLM verification with all similar entities
      console.log(`⏳ DEDUP: Queueing entity for LLM verification against ${allSimilarEntities.length} similar entities`);
      this._queueEntityLLMDecision(row, allSimilarEntities, websetId);
      
    } else {
      // Enhanced company duplicate detection
      const candidatePool = new Set();  // Initialize Set for collecting candidates
      
      // 1. Collect fuzzy matches
      let fuzzyChecks = 0;
      for (const other of this.table.values()) {
        fuzzyChecks++;
        const res = this._fuzzyDup(row, other);
        if (res === true) {
          // Still reject on very high similarity
          console.log(`❌ DEDUP: Very high similarity match with ${other.name} - REJECTING (${Date.now() - startTime}ms)`);
          await this._broadcastRejection(
            websetId,
            row.raw,
            'high_similarity_match',
            `Very similar to: ${other.name}`,
            other.raw
          );
          return;
        }
        if (res === null) {
          candidatePool.add(other);
        }
      }
      console.log(`🔍 DEDUP: Fuzzy check complete (${fuzzyChecks} comparisons), found ${candidatePool.size} potential matches`);

      // 2. Add vector search results
      try {
        // Search by name
        const nameHits = await vecQuery(row.name || '', 5);
        if (!Array.isArray(nameHits)) {
          console.warn('⚠️ DEDUP: Invalid vector search results for name:', nameHits);
        } else {
          for (const id of nameHits) {
            if (this.table.has(id)) {
              candidatePool.add(this.table.get(id));
            }
          }
        }

        // Search by URL if different from name
        if (row.url && row.url !== row.name) {
          const urlHits = await vecQuery(row.url, 3);
          if (!Array.isArray(urlHits)) {
            console.warn('⚠️ DEDUP: Invalid vector search results for URL:', urlHits);
          } else {
            for (const id of urlHits) {
              if (this.table.has(id)) {
                candidatePool.add(this.table.get(id));
              }
            }
          }
        }

        // Search by domain for related companies
        if (row.etld1) {
          const domainHits = await vecQuery(row.etld1, 3);
          if (!Array.isArray(domainHits)) {
            console.warn('⚠️ DEDUP: Invalid vector search results for domain:', domainHits);
          } else {
            for (const id of domainHits) {
              if (this.table.has(id)) {
                candidatePool.add(this.table.get(id));
              }
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ DEDUP: Vector search failed (continuing with fuzzy matches):`, error.message);
      }

      // 3. Filter and rank candidates
      const rankedCandidates = Array.from(candidatePool)
        .filter(candidate => candidate && candidate.name) // Filter out invalid candidates
        .map(candidate => {
          const nameSimilarity = natural.JaroWinklerDistance(
            (row.name || '').toLowerCase(),
            (candidate.name || '').toLowerCase()
          );
          const domainSimilarity = row.etld1 === candidate.etld1 ? 1 : 0;
          const brandSimilarity = row.brand === candidate.brand ? 1 : 0;
          
          // Combined score weighted towards name similarity
          const score = (nameSimilarity * 0.6) + (domainSimilarity * 0.2) + (brandSimilarity * 0.2);
          
          return { candidate, similarity: score };
        })
        .filter(item => item.similarity > 0.3) // Keep only reasonably similar candidates
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5); // Keep top 5 most similar for LLM

      console.log(`🔍 DEDUP: Found ${rankedCandidates.length} high-quality candidates for LLM verification`);

      // If no candidates found, accept immediately
      if (rankedCandidates.length === 0) {
        console.log(`✅ DEDUP: No similar companies found - ACCEPTING immediately (${Date.now() - startTime}ms)`);
        await this._accept(row, websetId);
        return;
      }

      // Queue for LLM verification with all good candidates
      console.log(`⏳ DEDUP: Queueing company for LLM verification against ${rankedCandidates.length} candidates`);
      this._queueCompanyLLMDecision(row, rankedCandidates.map(r => r.candidate), websetId);
    }
  }

  // New method for company LLM decisions
  _queueCompanyLLMDecision(newCompany, similarCompanies, websetId) {
    const companyDecision = {
      type: 'company_decision',
      idNew: newCompany.rowId,
      nameNew: newCompany.name,
      urlNew: newCompany.url,
      brandNew: newCompany.brand,
      etld1New: newCompany.etld1,
      similarCompanies: similarCompanies
        .filter(company => company && company.rowId)
        .map(company => ({
          id: company.rowId,
          name: company.name || 'Unknown',
          url: company.url || '',
          brand: company.brand,
          etld1: company.etld1
        })),
      websetId,
      rawNew: newCompany.raw
    };
    
    this.pending.set(newCompany.rowId, companyDecision);
    console.log(`⏳ COMPANY: Broadcasting PENDING for ${newCompany.name} (checking against ${similarCompanies.length} candidates)`);
    this.broadcast(websetId, { type: 'pending', tmpId: newCompany.rowId });

    this.batch.push(companyDecision);
    if (this.batch.length >= LLM_BATCH) {
      console.log(`🚀 COMPANY: Batch full (${LLM_BATCH}), flushing to LLM immediately`);
      this._flushBatch();
    } else if (!this.batchTimer) {
      console.log(`⏲️ COMPANY: Starting batch timer (${LLM_LAT_MS}ms) for ${this.batch.length} items`);
      this.batchTimer = setTimeout(() => this._flushBatch(), LLM_LAT_MS);
    }
  }

  /* ---------------- internal ---------------- */

  _cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    
    return text
      // Remove HTML tags
      .replace(/<[^>]*>/g, '')
      // Remove HTML entities
      .replace(/&[a-zA-Z0-9#]+;/g, ' ')
      // Remove special characters but keep alphanumeric, spaces, and common punctuation
      .replace(/[^\w\s\-&.,()]/g, ' ')
      // Replace multiple spaces with single space
      .replace(/\s+/g, ' ')
      // Trim whitespace
      .trim();
  }

  _canonItem(item) {
    if (!item) {
      console.warn('⚠️ DEDUP: Received null/undefined item in _canonItem');
      return {
        rowId: crypto.randomUUID(),
        name: '',
        url: '',
        host: '',
        brand: '',
        etld1: '',
        subCls: 'other',
        isVideoPlatform: false,
        raw: {}
      };
    }

    let u = '';
    
    if (item.properties?.url) {
      u = item.properties.url;
    }
    else if (item.url) {
      u = item.url;
    }
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
    
    if (this.entityType) {
      // For entity searches, use best available title
      name = this._extractBestTitle(item);
    } else {
      // For company searches, use original logic
      // First priority: direct name/title fields
      if (item.name) {
        name = this._cleanText(item.name);
      } else if (item.title) {
        name = this._cleanText(item.title);
      } else if (item.properties?.name) {
        name = this._cleanText(item.properties.name);
      } else if (item.properties?.title) {
        name = this._cleanText(item.properties.title);
      }
      // Second priority: company name from nested objects
      else if (item.properties?.company?.name) {
        name = this._cleanText(item.properties.company.name);
      }
      // Third priority: search in all nested properties
      else {
        const props = item.properties || {};
        for (const [key, value] of Object.entries(props)) {
          if (typeof value === 'object' && value !== null) {
            if (value.name || value.title || value.company_name) {
              name = this._cleanText(value.name || value.title || value.company_name);
              break;
            }
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
    const brand = (info.domainWithoutSuffix || '').replace(/[-_\d]/g, '').toLowerCase();
    const etld1 = info.domain || '';
    const subCls = GENERIC_SUBS.has(info.subdomain || '') ? 'generic' : 'other';
    
    // Special handling for video platforms - don't use domain for key0
    const isVideoPlatform = VIDEO_PLATFORMS.has(etld1);
    const key0 = isVideoPlatform ? 
      `video:${name.toLowerCase().replace(/[^a-z0-9]/g, '')}` : 
      `${brand}:${etld1}:${subCls}`;
    
    const canonicalized = {
      rowId:  item.id || crypto.randomUUID(),
      name:   (name || '').trim(),
      url:    u,
      host:   info.hostname || '',
      brand, etld1, subCls,
      isVideoPlatform,
      raw:    item
    };
    
    return canonicalized;
  }

  // IMPROVEMENT 8: Extract best available title for entities (prioritize title fields, use first non-empty)
  _extractBestTitle(item) {
    if (!item) return '';
    
    // For entities, prioritize title fields and find first non-empty
    const titleCandidates = [
      item.title,
      item.name,
      item.properties?.title,
      item.properties?.name,
      // Check nested objects for title/name fields
      ...(item.properties ? Object.values(item.properties)
        .filter(val => val && typeof val === 'object' && !Array.isArray(val))
        .flatMap(obj => [obj.title, obj.name])
        .filter(Boolean) : [])
    ];
    
    // Return first non-empty, cleaned title
    const bestTitle = titleCandidates.find(title => 
      title && typeof title === 'string' && title.trim()
    );
    
    return bestTitle ? this._cleanText(bestTitle) : '';
  }

  // IMPROVEMENT 7: Normalize entity titles for better duplicate detection
  _normalizeEntityTitle(title) {
    if (!title || typeof title !== 'string') return '';
    
    return title
      // Remove years in YYYY format between 1900-2099
      .replace(/[(\[\-]\s*(19|20)\d{2}(\s*-\s*(19|20)\d{2})?\s*[)\]]/g, '')
      // Remove format specifiers: (TV Series), (Movie), (Film), (Book), (Anime)
      .replace(/\s*\([^)]*(?:TV Series|Movie|Film|Book|Anime|Series|Show)[^)]*\)/gi, '')
      // Enhanced: Remove standalone (TV) and any TV-related parenthetical content
      .replace(/\s*\(\s*TV\s*\)/gi, '')
      .replace(/\s*\(\s*TV\s+[^)]*\)/gi, '')
      // Remove regional markers: (US), (UK), (Japanese), (English Dub)
      .replace(/\s*\([^)]*(?:US|UK|Japanese|English|Dub|Sub|Original)[^)]*\)/gi, '')
      // Remove episode/season patterns: S01E01, Season 1, Ep 1000, Episode 1
      .replace(/\s*(?:S\d+E\d+|Season\s*\d+|Ep\.?\s*\d+|Episode\s*\d+)/gi, '')
      // Remove everything after Episode/Ep (for individual episode titles)
      .replace(/\s+Episode\s+.*$/gi, '')
      .replace(/\s+Ep\.?\s+.*$/gi, '')
      // Remove edition markers: Remastered, Director's Cut, Extended, Revised
      .replace(/\s*\b(?:Remastered|Director's\s*Cut|Extended|Revised|Special|Limited|Ultimate|Complete|Definitive)\s*(?:Edition|Version|Cut)?\b/gi, '')
      // BULLETPROOF: Remove trailer/promo content and everything after it  
      .replace(/\s*(?:(?:Official|Original|Classic|Theatrical)\s+)?(?:Movie\s+)?(?:Trailer|Teaser)(?:\s*[#\d]+)?.*$/gi, '')
      .replace(/\s*(?:Official\s+)?(?:English\s+)?(?:Dubbed\s+)?(?:Subtitled\s+)?(?:Final\s+)?(?:International\s+)?(?:Red\s*Band\s+)?(?:Exclusive\s+)?(?:New\s+)?(?:Trailer|Teaser).*$/gi, '')
      .replace(/\s*[\-:\|\(\[\{]*\s*TV\s*Spot(?:\s*[#\d]+)?.*$/gi, '')
      .replace(/\s*[\-:\|\(\[\{]*\s*(?:Official\s*)?(?:Movie\s*)?Clip(?:\s*[#\d]+)?.*$/gi, '')
      .replace(/\s*[\-:\|\(\[\{]*\s*Behind\s*the\s*Scenes.*$/gi, '')
      .replace(/\s*[\-:\|\(\[\{]*\s*Making\s*Of.*$/gi, '')
      // Handle article repositioning: "The Title" -> "Title" (will catch both forms)
      .replace(/^The\s+/i, '')
      .replace(/,\s*The$/i, '')
      // Normalize punctuation: multiple spaces, colons, dashes, semicolons
      .replace(/[:\-–—;]+/g, ' ')
      .replace(/\s+/g, ' ')
      // Clean up
      .trim()
      .toLowerCase();
  }

  // IMPROVEMENT 3: New method to detect if subdomains represent the same organization
  _areSubdomainsSimilar(a, b) {
    if (a.etld1 !== b.etld1) return false; // Different domains
    
    const subA = a.host.replace(`.${a.etld1}`, '').toLowerCase();
    const subB = b.host.replace(`.${b.etld1}`, '').toLowerCase();
    
    // Both are generic subdomains (including 'about' now)
    if (GENERIC_SUBS.has(subA) && GENERIC_SUBS.has(subB)) {
      console.log(`🔍 DEDUP: Both generic subdomains: ${subA} and ${subB}`);
      return true;
    }
    
    // One is generic, other is organizational
    if ((GENERIC_SUBS.has(subA) && ORGANIZATIONAL_SUBS.has(subB)) ||
        (GENERIC_SUBS.has(subB) && ORGANIZATIONAL_SUBS.has(subA))) {
      console.log(`🔍 DEDUP: Generic + organizational subdomains: ${subA} and ${subB}`);
      return true;
    }
    
    // Both are organizational
    if (ORGANIZATIONAL_SUBS.has(subA) && ORGANIZATIONAL_SUBS.has(subB)) {
      console.log(`🔍 DEDUP: Both organizational subdomains: ${subA} and ${subB}`);
      return true;
    }
    
    return false;
  }

  _fuzzyDup(a, b) {
    // Special handling for video content - rely more on title similarity
    if (a.isVideoPlatform || b.isVideoPlatform) {
      const score = natural.JaroWinklerDistance(
        this._normalizeEntityTitle(a.name),
        this._normalizeEntityTitle(b.name)
      );
      console.log(`🔍 DEDUP: Video content title similarity: ${score.toFixed(3)}`);
      // Use higher threshold for video content to avoid false positives
      return score > 0.95 ? true : score > 0.85 ? null : false;
    }
    
    // IMPROVEMENT 4: Enhanced subdomain similarity detection
    if (this._areSubdomainsSimilar(a, b)) {
      console.log(`🔍 DEDUP: Similar subdomains detected: ${a.host} vs ${b.host}`);
      
      // If entity is present, don't reject based on domain alone - check name similarity
      if (this.entityType) {
        console.log(`🔍 DEDUP: Entity search (${this.entityType}) - checking name similarity instead of domain rejection`);
        // Continue to name similarity check instead of rejecting
      } else {
        return true; // Treat as duplicates for company searches
      }
    }
    
    // Check for exact domain matches with generic subdomains (legacy logic)
    if (a.etld1 === b.etld1 && a.subCls === 'generic' && b.subCls === 'generic') {
      console.log(`🔍 DEDUP: Domain match found: ${a.etld1} (both generic subdomains)`);
      
      // If entity is present, don't reject based on domain alone - check name similarity
      if (this.entityType) {
        console.log(`🔍 DEDUP: Entity search (${this.entityType}) - checking name similarity instead of domain rejection`);
        // Continue to name similarity check instead of rejecting
      } else {
        return true; // Original behavior for company searches
      }
    }
    
    // NEW: Check for same brand across different domains (e.g., jd.com, jd.hk, global.jd.com)
    if (a.brand === b.brand && a.brand.length > 2) {
      console.log(`🔍 DEDUP: Same brand "${a.brand}" across different domains: ${a.etld1} vs ${b.etld1}`);
      
      // If both have generic subdomains, they're likely duplicates
      if (a.subCls === 'generic' && b.subCls === 'generic') {
        console.log(`🔍 DEDUP: Both generic subdomains - treating as duplicate`);
        
        // If entity is present, don't reject based on domain alone - check name similarity
        if (this.entityType) {
          console.log(`🔍 DEDUP: Entity search (${this.entityType}) - checking name similarity instead of domain rejection`);
          // Continue to name similarity check instead of rejecting
        } else {
          return true; // Original behavior for company searches
        }
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
    let score, threshold;
    if (this.entityType) {
      // For entity searches, use normalized titles and lower threshold
      const normalizedA = this._normalizeEntityTitle(a.name);
      const normalizedB = this._normalizeEntityTitle(b.name);
      score = natural.JaroWinklerDistance(normalizedA, normalizedB);
      threshold = ENTITY_JARO_THRESH;
      console.log(`🔍 DEDUP: Entity name similarity "${a.name}" vs "${b.name}"`);
      console.log(`🔍 DEDUP: Normalized: "${normalizedA}" vs "${normalizedB}": ${score.toFixed(3)} (entity threshold: ${threshold})`);
    } else {
      // For company searches, use original names and higher threshold
      score = natural.JaroWinklerDistance(a.name.toLowerCase(), b.name.toLowerCase());
      threshold = JARO_THRESH;
      console.log(`🔍 DEDUP: Company name similarity "${a.name}" vs "${b.name}": ${score.toFixed(3)} (company threshold: ${threshold})`);
    }
    
    if (score > threshold) {
      console.log(`🔍 DEDUP: High similarity match (${score.toFixed(3)} > ${threshold}) - REJECTING at Tier 1`);
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

  // IMPROVEMENT 12: Entity-specific LLM queueing with multiple candidates
  _queueEntityLLMDecision(newEntity, similarEntities, websetId) {
    const entityDecision = {
      type: 'entity_decision',
      idNew: newEntity.rowId,
      nameNew: newEntity.name,
      urlNew: newEntity.url,
      similarEntities: similarEntities
        .filter(entity => entity && entity.rowId) // Filter out invalid entities
        .map(entity => ({
          id: entity.rowId,
          name: entity.name || 'Unknown',
          url: entity.url || ''
        })),
      websetId,
      rawNew: newEntity.raw
    };
    
    this.pending.set(newEntity.rowId, entityDecision);
    console.log(`⏳ ENTITY: Broadcasting PENDING for ${newEntity.name} (checking against ${similarEntities.length} candidates)`);
    this.broadcast(websetId, { type: 'pending', tmpId: newEntity.rowId });

    this.batch.push(entityDecision);
    if (this.batch.length >= LLM_BATCH) {
      console.log(`🚀 ENTITY: Batch full (${LLM_BATCH}), flushing to LLM immediately`);
      this._flushBatch();
    } else if (!this.batchTimer) {
      console.log(`⏲️ ENTITY: Starting batch timer (${LLM_LAT_MS}ms) for ${this.batch.length} items`);
      this.batchTimer = setTimeout(() => this._flushBatch(), LLM_LAT_MS);
    }
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

  // IMPROVEMENT 10: Build contextual LLM prompts for better duplicate detection
  _buildLLMPrompt(batch) {
    // Check if batch contains entity decisions or company decisions
    const entityDecisions = batch.filter(item => item.type === 'entity_decision');
    const companyDecisions = batch.filter(item => item.type === 'company_decision');
    
    if (entityDecisions.length > 0) {
      // New entity approach: multiple candidates per entity
      
      return `You are a duplicate detection expert for ${this.entityType} entities. For each new entity, determine if it's a duplicate of ANY of the provided similar entities.

GUIDELINES FOR ${this.entityType.toUpperCase()} DUPLICATES:
- Same title with different years/dates: DUPLICATE (e.g., "District 9" vs "District 9 (2009)")
- Same content with format differences: DUPLICATE (e.g., "The Dark Knight" vs "Dark Knight, The")  
- Same content with edition variations: DUPLICATE (e.g., "Harry Potter" vs "Harry Potter: Extended Edition")
- Different language versions of same content: DUPLICATE (e.g., "Spirited Away" vs "Sen to Chihiro no Kamikakushi")
- Same series but different seasons/episodes: UNIQUE (e.g., "Breaking Bad S1" vs "Breaking Bad S2")
- Completely different ${this.entityType}: UNIQUE
- Similar but distinct works: UNIQUE (e.g., "The Matrix" vs "The Matrix Reloaded")

For each entity decision, return [true] if the new entity is a DUPLICATE of any similar entity, or [false] if it's UNIQUE.

${JSON.stringify({
  entityDecisions: entityDecisions.map(ed => ({
    newEntity: {
      name: ed.nameNew,
      url: ed.urlNew
    },
    similarEntities: ed.similarEntities
  }))
})}

Return JSON with "decisions" array where each element is [true] for DUPLICATE or [false] for UNIQUE.`;
      
    } else if (companyDecisions.length > 0) {
      // New company decision prompt
      return `You are a duplicate detection expert for companies and organizations. For each new company, determine if it's a duplicate of ANY of the provided similar companies.

GUIDELINES FOR COMPANY DUPLICATES:
- Same company name with different domains: DUPLICATE (e.g., "Apple" on apple.com vs "Apple Inc." on apple.co.uk)
- Same brand across regional sites: DUPLICATE (e.g., "McDonald's France" vs "McDonald's UK")
- Different subsidiaries of same parent: UNIQUE (e.g., "Google" vs "YouTube")
- Different brands entirely: UNIQUE (e.g., "Apple" vs "Microsoft")
- Same company with/without legal suffixes: DUPLICATE (e.g., "Acme Corp" vs "Acme Corporation")
- Different companies with similar names: UNIQUE (e.g., "American Airlines" vs "American Express")
- Same company with different business units: UNIQUE (e.g., "Amazon.com" vs "Amazon Web Services")

Focus on business identity rather than technical domain differences. Consider:
1. Company name similarity
2. Brand identity
3. Domain relationships
4. Business context

For each company decision, return [true] if the new company is a DUPLICATE of any similar company, or [false] if it's UNIQUE.

${JSON.stringify({
  companyDecisions: companyDecisions.map(cd => ({
    newCompany: {
      name: cd.nameNew,
      url: cd.urlNew,
      brand: cd.brandNew,
      domain: cd.etld1New
    },
    similarCompanies: cd.similarCompanies
  }))
})}

Return JSON with "decisions" array where each element is [true] for DUPLICATE or [false] for UNIQUE.`;
    } else {
      // Legacy pairs approach
      return `You are a duplicate detection expert for companies and organizations. Your task is to determine if pairs of items represent the same company.

GUIDELINES FOR COMPANY DUPLICATES:
- Same company name with different domains: DUPLICATE (e.g., "Apple" on apple.com vs "Apple Inc." on apple.co.uk)
- Same brand across regional sites: DUPLICATE (e.g., "McDonald's France" vs "McDonald's UK")
- Different subsidiaries of same parent: UNIQUE (e.g., "Google" vs "YouTube")
- Different brands entirely: UNIQUE (e.g., "Apple" vs "Microsoft")
- Same company with/without legal suffixes: DUPLICATE (e.g., "Acme Corp" vs "Acme Corporation")

Focus on the business identity rather than technical domain differences.

Analyze these ${batch.length} pairs and return JSON with "pairs" array where each element is [true] for DUPLICATE or [false] for UNIQUE:

${JSON.stringify({
  pairs: batch.map(p => ({
    name1: p.nameA,
    url1: p.urlA,
    name2: p.nameB,
    url2: p.urlB
  }))
})}`;
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

    const prompt = this._buildLLMPrompt(batch);
    
    console.log(`🧠 DEDUP: Sending ${batch.length} pairs to LLM:`, batch.map(p => `${p.nameA} vs ${p.nameB}`));

    let resp;
    try {
      const llmStartTime = Date.now();
      resp = await limiter.schedule(() =>
        gemini.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        })
      );
      console.log(`🧠 DEDUP: LLM response received (${Date.now() - llmStartTime}ms)`);
    } catch (err) {
      console.error(`❌ DEDUP: Gemini error (${Date.now() - flushStartTime}ms):`, err);
      // treat all as unique fallback
      for (const p of batch) this._confirmPending(p, false);
      return;
    }

    // Separate entity decisions from pairs (should not be mixed in same batch)
    const entityDecisions = batch.filter(item => item.type === 'entity_decision');
    const pairs = batch.filter(item => item.type !== 'entity_decision');
    
    if (entityDecisions.length > 0 && pairs.length > 0) {
      console.warn(`⚠️ DEDUP: Mixed batch detected (${entityDecisions.length} entities, ${pairs.length} pairs) - this should not happen!`);
    }
    
    let verdicts;
    try {
      const responseData = JSON.parse(resp.response.text());
      
      if (entityDecisions.length > 0) {
        // Entity approach: extract decisions array
        verdicts = responseData.decisions || responseData.pairs || [];
        if (!Array.isArray(verdicts)) {
          console.warn(`⚠️ ENTITY: Invalid verdicts format, defaulting to unique:`, verdicts);
          verdicts = batch.map(() => [false]);
        }
        console.log(`🧠 ENTITY: Parsed ${verdicts.length} entity decisions:`, 
          verdicts.map((verdict, i) => {
            const same = Array.isArray(verdict) ? verdict[0] : verdict;
            return `${batch[i]?.nameNew || batch[i]?.nameA || 'unknown'}: ${same ? 'DUP' : 'UNIQUE'}`;
          }));
      } else {
        // Pairs approach
        verdicts = responseData.pairs || [];
        if (!Array.isArray(verdicts)) {
          console.warn(`⚠️ DEDUP: Invalid verdicts format, defaulting to unique:`, verdicts);
          verdicts = batch.map(() => [false]);
        }
        console.log(`🧠 DEDUP: Parsed ${verdicts.length} verdicts:`, 
          verdicts.map((verdict, i) => {
            const same = Array.isArray(verdict) ? verdict[0] : verdict;
            return `${batch[i]?.nameA || 'unknown'}: ${same ? 'DUP' : 'UNIQUE'}`;
          }));
      }
    } catch (err) {
      console.warn(`⚠️ DEDUP: Parse fail; default unique (${Date.now() - flushStartTime}ms):`, err);
      verdicts = batch.map(() => [false]);
    }

    // Process verdicts sequentially to ensure proper async handling
    for (let i = 0; i < verdicts.length; i++) {
      const verdict = verdicts[i];
      // Handle different verdict formats safely
      const same = Array.isArray(verdict) ? verdict[0] : verdict;
      const p = batch[i];
      
      if (!p) {
        console.warn(`⚠️ DEDUP: Missing batch item at index ${i}`);
        continue;
      }
      
      if (p.type === 'entity_decision') {
        console.log(`${same ? '❌' : '✅'} ENTITY: ${same ? 'DROPPING' : 'CONFIRMING'} ${p.nameNew}`);
      } else {
        console.log(`${same ? '❌' : '✅'} DEDUP: ${same ? 'DROPPING' : 'CONFIRMING'} ${p.nameA}`);
      }
      await this._confirmPending(p, same);
    }
    
    console.log(`🧠 DEDUP: Batch processing complete (${Date.now() - flushStartTime}ms total)`);
  }

  async _confirmPending(p, same) {
    // Handle both entity decisions and legacy pairs
    if (p.type === 'entity_decision') {
      // New entity decision format
      if (same) {
        // drop entity - broadcast as rejected  
        await this._broadcastRejection(
          p.websetId,
          p.rawNew,
          'entity_llm_duplicate',
          `LLM determined entity duplicate of similar ${this.entityType}`,
          null // Could be any of the similar entities
        );
        this.broadcast(p.websetId, { type: 'drop', tmpId: p.idNew });
        this.pending.delete(p.idNew);
      } else {
        // accept entity
        const entityCanon = this._canonItem({ ...p.rawNew, url: p.urlNew, name: p.nameNew });
        if (this.entityType) {
          await this._accept(entityCanon, p.websetId);
        } else {
          this._accept(entityCanon, p.websetId);
        }
        this.broadcast(p.websetId, { type: 'confirm', data: p.rawNew });
        this.pending.delete(p.idNew);
      }
    } else {
      // Legacy pairs format
      const cacheKey = [this._hostFromUrl(p.urlA), this._hostFromUrl(p.urlB)].sort().join('|');
      this.llmCache.set(cacheKey, !!same);

      if (same) {
        // drop row A - broadcast as rejected
        await this._broadcastRejection(
          p.websetId,
          p.rawA,
          'llm_duplicate',
          `LLM determined duplicate of: ${p.nameB}`,
          null // We don't have the exact existing item here
        );
        this.broadcast(p.websetId, { type: 'drop', tmpId: p.idA });
        this.pending.delete(p.idA);
      } else {
        // accept row A
        const aCanon = this._canonItem({ ...p.rawA, url: p.urlA, name: p.nameA });
        if (this.entityType) {
          await this._accept(aCanon, p.websetId, true); // Skip broadcast here
        } else {
          await this._accept(aCanon, p.websetId, true); // Skip broadcast here
        }
        this.broadcast(p.websetId, { type: 'confirm', data: p.rawA }); // Only broadcast once
        this.pending.delete(p.idA);
      }
    }
  }

  async _accept(row, websetId, skipBroadcast = false) {
    const key0 = `${row.brand}:${row.etld1}:${row.subCls}`;
    this.table.set(key0, row);
    
    // Save accepted item to MongoDB
    await this._saveItemToMongoDB(websetId, row, 'accepted');
    
    if (this.entityType) {
      // BULLETPROOF: Entity-only tracking for instant duplicate detection
      if (row.url) {
        this.processedUrls.add(row.url);
      }
      
      // FIXED: Compute normalized title once and reuse
      const normalizedTitle = row.name ? this._normalizeEntityTitle(row.name) : '';
      
      if (normalizedTitle) {
        this.processedTitles.set(normalizedTitle, {
          name: row.name,
          url: row.url,
          raw: row.raw
        });
      }

      // BULLETPROOF: Await vector storage for entities to ensure synchronization
      console.log(`🔍 DEDUP: Storing entity with normalized title: "${normalizedTitle}"`);
      if (normalizedTitle) {
        await vecAdd(row.rowId, normalizedTitle);
      }
      
      // Also store URL as fallback if it differs significantly from name
      if (row.url && row.url !== row.name) {
        await vecAdd(row.rowId, row.url);
      }
      
      console.log(`✅ DEDUP: BULLETPROOF ENTITY ACCEPTED ${row.rowId} (${row.name}) - synchronized`);
    } else {
      // Companies: Keep original fire-and-forget approach (no await)
      vecAdd(row.rowId, row.name || row.url);
      if (row.url && row.url !== row.name) {
        vecAdd(row.rowId, row.url);
      }
      
      console.log(`✅ DEDUP: COMPANY ACCEPTED ${row.rowId} (${row.name}) - original flow`);
    }
    
    // Only broadcast if not skipped (to avoid double broadcasts)
    if (!skipBroadcast) {
      this.broadcast(websetId, { type: 'item', item: row.raw });
    }
  }

  // FIXED: Standardized rejection broadcast with complete data
  async _broadcastRejection(websetId, item, reason, details, existingItem = null) {
    // Use the same sophisticated name extraction as _canonItem
    let extractedName = '';
    
    if (this.entityType) {
      // For entities, use the same logic as _canonItem
      extractedName = this._extractBestTitle(item);
    } else {
      // For companies, use the same comprehensive logic as _canonItem
      if (item.name) {
        extractedName = this._cleanText(item.name);
      } else if (item.title) {
        extractedName = this._cleanText(item.title);
      } else if (item.properties?.name) {
        extractedName = this._cleanText(item.properties.name);
      } else if (item.properties?.title) {
        extractedName = this._cleanText(item.properties.title);
      } else if (item.properties?.company?.name) {
        extractedName = this._cleanText(item.properties.company.name);
      } else {
        // Search in nested properties like _canonItem does
        const props = item.properties || {};
        for (const [key, value] of Object.entries(props)) {
          if (typeof value === 'object' && value !== null) {
            if (value.name || value.title || value.company_name) {
              extractedName = this._cleanText(value.name || value.title || value.company_name);
              break;
            }
          }
        }
      }
    }

    // Fallback if still no name found
    if (!extractedName) {
      extractedName = item.properties?.company?.name || 'Unknown Item';
    }

    // Ensure item has proper name/title and url fields for frontend display
    const enhancedItem = {
      ...item,
      // Use the extracted name
      name: extractedName,
      // Ensure url field exists for display  
      url: item.url || item.properties?.url || '',
      // Keep original properties structure
      properties: {
        ...item.properties,
        // Ensure company name is available
        company: {
          name: extractedName,
          ...item.properties?.company
        },
        // Ensure URL is available
        url: item.properties?.url || item.url || '',
        ...item.properties
      }
    };

    this.broadcast(websetId, {
      type: 'rejected',
      item: enhancedItem,
      reason: reason,
      details: details,
      existingItem: existingItem
    });
    
    // Save rejected item to MongoDB
    const rejectionData = {
      rejectedBy: existingItem?.id || null,
      reason,
      details
    };
    await this._saveItemToMongoDB(websetId, { 
      id: enhancedItem.id, 
      name: extractedName, 
      url: enhancedItem.url,
      raw: enhancedItem 
    }, 'rejected', rejectionData);
  }

  // IMPROVEMENT 13: Strategic URL resolution for suspicious cases (optional)
  // Only for NON-ENTITY flow - entities have bulletproof name matching already
  async _resolveUrlIfSuspicious(itemA, itemB) {
    // Only enable for company/non-entity flow
    if (this.entityType) {
      return null; // Entities have bulletproof name matching, don't need URL resolution
    }
    
    // Check if URL resolution is enabled
    const urlResolutionEnabled = process.env.ENABLE_URL_RESOLUTION === 'true';
    if (!urlResolutionEnabled) {
      return null; // Feature disabled
    }
    
    // Only resolve URLs in very specific cases to avoid performance issues
    if (!this._shouldCheckUrlResolution(itemA, itemB)) {
      return null;
    }
    
    try {
      // Use a cache to avoid hitting the same URL twice
      const resolvedA = await this._getCachedUrlResolution(itemA.url);
      const resolvedB = await this._getCachedUrlResolution(itemB.url);
      
      // If resolved URLs are the same, it's definitely a duplicate
      if (resolvedA && resolvedB && resolvedA === resolvedB) {
        console.log(`🌐 DEDUP: URL resolution confirms duplicate: ${resolvedA}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.warn(`⚠️ DEDUP: URL resolution failed, continuing with name-based logic:`, error);
      return null; // Fall back to existing logic
    }
  }
  
  _shouldCheckUrlResolution(itemA, itemB) {
    // Only check URLs for COMPANY items if:
    // 1. Names are very similar (>90% match)
    // 2. But URLs have different domains
    // 3. And from known duplicate-prone domains
    // Note: Not used for entities - they have bulletproof name matching
    
    const nameSimilarity = natural.JaroWinklerDistance(
      this._normalizeEntityTitle(itemA.name || ''),
      this._normalizeEntityTitle(itemB.name || '')
    );
    
    if (nameSimilarity < 0.9) return false;
    
    const domainA = this._extractDomain(itemA.url);
    const domainB = this._extractDomain(itemB.url);
    
    if (domainA === domainB) return false; // Same domain, no need to check
    
    const DUPLICATE_PRONE_DOMAINS = new Set([
      'imdb.com', 'themoviedb.org', 'rottentomatoes.com',
      'myanimelist.net', 'anidb.net', 'animenewsnetwork.com',
      'amazon.com', 'youtube.com', 'wikipedia.org'
    ]);
    
    return DUPLICATE_PRONE_DOMAINS.has(domainA) || DUPLICATE_PRONE_DOMAINS.has(domainB);
  }
  
  async _getCachedUrlResolution(url) {
    // Global cache across ALL DedupService instances - each URL resolved only once ever
    if (!globalThis.urlResolutionCache) {
      globalThis.urlResolutionCache = new Map();
      globalThis.urlResolutionStats = { hits: 0, misses: 0, errors: 0 };
    }
    
    if (globalThis.urlResolutionCache.has(url)) {
      globalThis.urlResolutionStats.hits++;
      const cached = globalThis.urlResolutionCache.get(url);
      console.log(`🎯 DEDUP: URL cache HIT for ${url} → ${cached} (${globalThis.urlResolutionStats.hits} hits)`);
      return cached;
    }
    
    globalThis.urlResolutionStats.misses++;
    console.log(`🌐 DEDUP: Resolving URL ${url} (${globalThis.urlResolutionStats.misses} misses)`);
    
    try {
      // Retry logic for reliability
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'HEAD', // Faster than GET - we only need final URL
            timeout: 3000,
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; DeduplicationBot/1.0)'
            }
          });
          
          const resolvedUrl = response.url;
          globalThis.urlResolutionCache.set(url, resolvedUrl);
          
          console.log(`✅ DEDUP: URL resolved ${url} → ${resolvedUrl}`);
          
          // Limit cache size to prevent memory issues
          if (globalThis.urlResolutionCache.size > 2000) {
            const firstKey = globalThis.urlResolutionCache.keys().next().value;
            globalThis.urlResolutionCache.delete(firstKey);
            console.log(`🧹 DEDUP: URL cache cleanup, size now ${globalThis.urlResolutionCache.size}`);
          }
          
          return resolvedUrl;
        } catch (error) {
          lastError = error;
          if (attempt === 1) {
            console.warn(`⚠️ DEDUP: URL resolution attempt ${attempt} failed for ${url}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay
          }
        }
      }
      
      throw lastError;
    } catch (error) {
      globalThis.urlResolutionStats.errors++;
      console.warn(`❌ DEDUP: URL resolution failed for ${url} after 2 attempts:`, error.message);
      
      // Cache failures to avoid repeated attempts (but with shorter TTL concept)
      globalThis.urlResolutionCache.set(url, null);
      return null;
    }
  }
  
  _extractDomain(url) {
    if (!url) return '';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
  
  // MongoDB persistence helper methods
  async _saveItemToMongoDB(websetId, row, status, rejectionData = null) {
    if (!websetId || !row) {
      console.error('❌ DEDUP: Invalid parameters for MongoDB save:', { websetId, row });
      return;
    }

    try {
      // Generate fallback values to prevent validation errors
      const generateFallbackId = () => {
        if (row.id) return row.id;
        if (row.raw?.id) return row.raw.id;
        return `item_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      };

      const generateFallbackName = () => {
        // Try multiple sources for name
        const nameSources = [
          row.name,
          row.title,
          row.raw?.name,
          row.raw?.title,
          row.raw?.properties?.name,
          row.raw?.properties?.title,
          row.raw?.properties?.company?.name
        ];

        // Get first non-empty value
        const name = nameSources.find(n => n && typeof n === 'string' && n.trim());
        if (name) return name.trim();

        // Try extracting from URL
        if (row.url) {
          try {
            const url = new URL(row.url);
            // Try domain without TLD first
            const domain = url.hostname.split('.').slice(0, -1).join('.');
            if (domain) return domain;
            // Fallback to full hostname
            return url.hostname || row.url;
          } catch {
            return row.url;
          }
        }

        // Ultimate fallback
        return `Unknown Item ${Date.now()}`;
      };

      // Clean and validate properties
      const cleanProperties = (props) => {
        if (!props || typeof props !== 'object') return {};
        
        // Deep clone to avoid modifying original
        const cleaned = JSON.parse(JSON.stringify(props));
        
        // Remove null/undefined values
        Object.keys(cleaned).forEach(key => {
          if (cleaned[key] === null || cleaned[key] === undefined) {
            delete cleaned[key];
          }
        });
        
        return cleaned;
      };

      const itemData = {
        websetId: websetId || `webset_${Date.now()}`,
        itemId: generateFallbackId(),
        name: generateFallbackName(),
        url: row.url || row.raw?.url || row.raw?.properties?.url || '',
        properties: cleanProperties(row.raw?.properties || row.properties || {}),
        rawData: row.raw || row || {},
        status: status || 'pending',
        createdAt: new Date(),
        normalizedTitle: this.entityType && (row.name || row.title) ? 
          this._normalizeEntityTitle(row.name || row.title) : '',
        entityType: this.entityType || null
      };
      
      if (status === 'rejected' && rejectionData) {
        itemData.rejectedBy = rejectionData.rejectedBy || null;
        itemData.rejectionReason = rejectionData.reason || 'unknown';
        itemData.rejectionMessage = rejectionData.details || '';
        if (typeof rejectionData.similarity === 'number') {
          itemData.similarity = Math.max(0, Math.min(1, rejectionData.similarity));
        }
      }
      
      const item = new Item(itemData);
      
      try {
        await item.save();
        console.log(`📊 MongoDB: Saved ${status} item ${itemData.itemId} for webset ${websetId}`);
      } catch (saveError) {
        if (saveError.code === 11000) {
          console.warn(`⚠️ MongoDB: Duplicate key error for ${itemData.itemId}, skipping`);
          return;
        }
        throw saveError; // Re-throw non-duplicate errors
      }

      // Update webset counters with retry logic and proper error handling
      this._updateWebsetCountersAsync(websetId, status, rejectionData?.reason);
      
    } catch (error) {
      console.error(`❌ MongoDB: Failed to save item:`, error);
      // Don't throw - continue processing even if DB save fails
    }
  }

  // Separate async method for webset counter updates with proper concurrency control
  async _updateWebsetCountersAsync(websetId, status, rejectionReason) {
    // Use a small random delay to reduce concurrent access
    const delay = Math.floor(Math.random() * 100);
    setTimeout(async () => {
      try {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const webset = await Webset.findOne({ websetId });
            if (!webset) {
              console.warn(`⚠️ MongoDB: Webset ${websetId} not found for counter update`);
              return;
            }

            // Use atomic operations instead of separate method calls
            const updateOps = {};
            updateOps.$inc = { totalItems: 1 };
            
            if (status === 'accepted') {
              updateOps.$inc.uniqueItems = 1;
            } else if (status === 'rejected') {
              updateOps.$inc.duplicatesRejected = 1;
              // Update rejection reason counters
              const reasonKey = `rejectionReasons.${rejectionReason || 'unknown'}`;
              updateOps.$inc[reasonKey] = 1;
            }

            await Webset.updateOne({ websetId }, updateOps);
            console.log(`📊 MongoDB: Updated webset ${websetId} counters (${status})`);
            return; // Success, exit retry loop
            
          } catch (updateError) {
            retryCount++;
            
            if (updateError.name === 'ParallelSaveError' || updateError.code === 11000) {
              if (retryCount < maxRetries) {
                // Exponential backoff with jitter
                const backoffDelay = Math.floor(Math.random() * (100 * Math.pow(2, retryCount)));
                console.warn(`⚠️ MongoDB: Parallel save conflict for webset ${websetId}, retrying in ${backoffDelay}ms (attempt ${retryCount}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                continue;
              }
            }
            
            throw updateError; // Re-throw if not a parallel save error or max retries reached
          }
        }
      } catch (error) {
        console.error(`⚠️ MongoDB: Failed to update webset counters after ${maxRetries} retries:`, error);
        // Don't throw - just log the error and continue
      }
    }, delay);
  }
  
  // Utility: Get URL resolution cache statistics
  static getUrlResolutionStats() {
    if (!globalThis.urlResolutionCache) {
      return { cacheSize: 0, hits: 0, misses: 0, errors: 0, hitRate: 0 };
    }
    
    const stats = globalThis.urlResolutionStats || { hits: 0, misses: 0, errors: 0 };
    const total = stats.hits + stats.misses;
    const hitRate = total > 0 ? (stats.hits / total * 100).toFixed(1) : 0;
    
    return {
      cacheSize: globalThis.urlResolutionCache.size,
      hits: stats.hits,
      misses: stats.misses, 
      errors: stats.errors,
      hitRate: `${hitRate}%`,
      totalRequests: total
    };
  }

  // FIXED: Add cleanup method to prevent memory leaks
  clearBulletproofCache() {
    if (this.entityType) {
      const titleCount = this.processedTitles.size;
      const urlCount = this.processedUrls.size;
      
      this.processedTitles.clear();
      this.processedUrls.clear();
      
      console.log(`🧹 DEDUP: Cleared bulletproof cache - ${titleCount} titles, ${urlCount} URLs`);
    }
  }

  // Add method to clear processed items (useful for testing or new websets)
  clearProcessedItems() {
    this.processedIds.clear();
    console.log('🧹 DEDUP: Cleared processed items tracking');
  }

  _hostFromUrl(u) {
    try { return new URL(u).host; } catch { return u; }
  }
}
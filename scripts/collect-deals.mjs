#!/usr/bin/env node
/**
 * RUZMI Zero-Cost Hot Deals Aggregator ($0 Forever)
 * Pure Node.js 20+ ESM — zero external npm dependencies.
 * Collects verified 30%–90% deals across all 19 RUZMI regions & 7 categories
 * from public open feeds (RSS, Shopify, WooCommerce, Magento 2 GraphQL, CheapShark)
 * plus optional manual hypermarket/dining deals in `data/manual-deals.json`,
 * guarded by historical Anti-Fake-Discount verification in `data/price-ledger.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEALS_OUT_DIR = path.join(PUBLIC_DIR, 'deals');
const MANUAL_DEALS_PATH = path.join(DATA_DIR, 'manual-deals.json');
const LEDGER_PATH = path.join(DATA_DIR, 'price-ledger.json');
const EXTRA_STORES_PATH = path.join(DATA_DIR, 'storefronts.json');

export const ALL_REGIONS = [
  'EG',
  'SA',
  'AE',
  'KW',
  'QA',
  'JO',
  'MA',
  'US',
  'GB',
  'DE',
  'FR',
  'ES',
  'IT',
  'TR',
  'IN',
  'BR',
  'JP',
  'RU',
  'GLOBAL',
];

const REGION_SET = new Set(ALL_REGIONS);
const VALID_CATEGORIES = new Set([
  'grocery',
  'dining',
  'electronics',
  'fashion',
  'home',
  'beauty',
  'digital',
  'other',
]);

// Subset of ISO-4217 currencies validated against RUZMI src/currencies.json
const KNOWN_CURRENCIES = new Set([
  'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'JOD', 'MAD', 'BHD', 'OMR', 'TND', 'LBP',
  'USD', 'GBP', 'EUR', 'TRY', 'INR', 'BRL', 'JPY', 'RUB', 'AUD', 'CAD', 'CHF',
  'CNY', 'HKD', 'SGD', 'KRW', 'MXN', 'PLN', 'SEK', 'NOK', 'DKK', 'ZAR', 'NZD',
]);

const THREE_DECIMAL_CURRENCIES = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);

const MAX_DEAL_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LEDGER_PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const LEDGER_MIN_SAMPLE_INTERVAL_MS = 10 * 60 * 60 * 1000;
const LEDGER_MAX_ENTRIES = 5000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_DEALS_PER_REGION = 40;
const USER_AGENT = 'RUZMI-Deals-Feed/1.0 (+https://github.com/ruzmi-deals-feed)';

/** Built-in verified public open storefronts (read-only public APIs only). */
const BUILTIN_STOREFRONTS = [
  {origin: 'https://thesherwal.com', platform: 'shopify', currency: 'EGP', region: 'EG', defaultCategory: 'fashion'},
  {origin: 'https://free-electronic.com', platform: 'woocommerce', currency: 'EGP', region: 'EG', defaultCategory: 'electronics'},
  {origin: 'https://www.tentree.com', platform: 'shopify', currency: 'USD', region: 'US', defaultCategory: 'fashion'},
  {origin: 'https://www.allbirds.com', platform: 'shopify', currency: 'USD', region: 'US', defaultCategory: 'fashion'},
  {origin: 'https://kotn.com', platform: 'shopify', currency: 'USD', region: 'GLOBAL', defaultCategory: 'fashion'},
  {origin: 'https://uk.gymshark.com', platform: 'shopify', currency: 'GBP', region: 'GB', defaultCategory: 'fashion'},
];

/** Built-in public community RSS / Atom deal feeds ($0 keyless). */
const COMMUNITY_RSS_FEEDS = [
  {
    url: 'https://feeds.feedburner.com/SlickdealsnetFP',
    name: 'Slickdeals Community',
    region: 'US',
    defaultCurrency: 'USD',
  },
  {
    url: 'https://www.dealnews.com/?rss=1',
    name: 'DealNews',
    region: 'US',
    defaultCurrency: 'USD',
  },
  {
    url: 'https://www.hotukdeals.com/rss/hot',
    name: 'HotUKDeals Community',
    region: 'GB',
    defaultCurrency: 'GBP',
  },
  {
    url: 'https://www.mydealz.de/rss/hot',
    name: 'MyDealz Community',
    region: 'DE',
    defaultCurrency: 'EUR',
  },
  {
    url: 'https://www.dealabs.com/rss/hot',
    name: 'Dealabs Community',
    region: 'FR',
    defaultCurrency: 'EUR',
  },
  {
    url: 'https://www.chollometro.com/rss/hot',
    name: 'Chollometro Community',
    region: 'ES',
    defaultCurrency: 'EUR',
  },
  {
    url: 'https://nl.pepper.com/rss/hot',
    name: 'Pepper NL Community',
    region: 'GLOBAL',
    defaultCurrency: 'EUR',
  },
  {
    url: 'https://www.ozbargain.com.au/deals/feed',
    name: 'OzBargain Community',
    region: 'GLOBAL',
    defaultCurrency: 'AUD',
  },
  {
    url: 'https://forums.redflagdeals.com/feed/forum/9',
    name: 'RedFlagDeals Community',
    region: 'GLOBAL',
    defaultCurrency: 'CAD',
  },
];

const CHEAPSHARK_DEALS_URLS = [
  'https://www.cheapshark.com/api/1.0/deals?pageSize=60&onSale=1&lowerPrice=1.5&sortBy=Savings',
  'https://www.cheapshark.com/api/1.0/deals?pageSize=60&onSale=1&lowerPrice=1&sortBy=Deal%20Rating',
];
const CHEAPSHARK_STORES_URL = 'https://www.cheapshark.com/api/1.0/stores';

export function computeDealTier(discountPercent) {
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent)) return 'regular';
  if (discountPercent >= 70) return 'mega';
  if (discountPercent >= 50) return 'hot';
  return 'regular';
}

// ---------------- URL, Text & Policy Hygiene ----------------

export function safeHttpsUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\\]/.test(value.trim())) {
    return null;
  }
  try {
    const u = new URL(value.trim(), base);
    const h = u.hostname.toLowerCase();
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      (u.port && u.port !== '443') ||
      !h.includes('.') ||
      h.includes(':') ||
      h.startsWith('[') ||
      /^\d+(?:\.\d+){3}$/.test(h) ||
      /\.(?:local|localhost|internal|test|invalid)$/.test(h) ||
      h === 'localhost' ||
      h === 'metadata.google.internal'
    ) {
      return null;
    }
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Google Play compliance: never emit store logos, favicons, badges, or SVGs as deal images. */
export function safeProductImageUrl(value, base) {
  const safe = safeHttpsUrl(value, base);
  if (!safe) return undefined;
  try {
    const u = new URL(safe);
    const lowerPath = u.pathname.toLowerCase();
    if (/\.(?:svg|ico)$/i.test(lowerPath)) return undefined;
    if (/(?:^|[\/._-])(logo|favicon|icon|sprite|avatar|badge|brandmark|watermark|placeholder|merchant)(?:[\/._-]|$)/i.test(lowerPath)) {
      return undefined;
    }
    return safe;
  } catch {
    return undefined;
  }
}

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', 'aff', 'affiliate', 'tag', 'cmpid', 'trk',
]);

export function canonicalDealKey(urlStr) {
  const safe = safeHttpsUrl(urlStr);
  if (!safe) return '';
  try {
    const u = new URL(safe);
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const kl = k.toLowerCase();
      if (kl.startsWith('utm_') || TRACKING_PARAMS.has(kl)) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    u.search = '';
    for (const [k, v] of kept) u.searchParams.append(k, v);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.href.replace(/\/+$/, '');
  } catch {
    return safe;
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  euro: '€',
  pound: '£',
  yen: '¥',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function cleanText(raw, max = 200) {
  if (!raw || typeof raw !== 'string') return '';
  const decoded = decodeEntities(raw);
  const noTags = decoded.replace(/<[^>]+>/g, ' ');
  return decodeEntities(noTags)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTitleKey(raw) {
  return cleanText(raw, 180)
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---------------- Price, Currency, Coupon & Category Helpers ----------------

function normalizeDigits(s) {
  return s
    .replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

function parseNumberPrice(value, currencyHint) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= 1e12 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d{1,8})?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
  }
  const norm = normalizeDigits(trimmed).replace(/\u00a0|\u202f/g, ' ').trim();
  if (!norm || norm.length > 80) return null;
  const match = norm.match(/(?:^|[^\d.,])(\d[\d\s'.,]*\d|\d+)(?=$|[^\d.,])/);
  if (!match) return null;
  let token = match[1].replace(/['\s]+/g, '');
  if (!token) return null;

  const hasComma = token.includes(',');
  const hasDot = token.includes('.');
  if (hasComma && hasDot) {
    if (token.lastIndexOf('.') > token.lastIndexOf(',')) {
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      token = `${parts[0].replace(/,/g, '')}.${parts[1]}`;
    } else {
      const parts = token.split(',');
      if (parts.length !== 2) return null;
      token = `${parts[0].replace(/\./g, '')}.${parts[1]}`;
    }
  } else if (hasComma) {
    const parts = token.split(',');
    if (parts.length > 2) {
      token = token.replace(/,/g, '');
    } else {
      const [intPart, fracPart] = parts;
      if (fracPart.length === 1 || fracPart.length === 2) {
        token = `${intPart}.${fracPart}`;
      } else if (fracPart.length === 3 && intPart.length >= 1 && intPart.length <= 3 && intPart !== '0') {
        if (currencyHint && THREE_DECIMAL_CURRENCIES.has(currencyHint.toUpperCase())) return null;
        token = `${intPart}${fracPart}`;
      } else {
        return null;
      }
    }
  } else if (hasDot) {
    const parts = token.split('.');
    if (parts.length > 2) token = token.replace(/\./g, '');
  }
  const n = Number(token);
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
}

const CURRENCY_PATTERNS = [
  [/(?:ج\.?\s*م\.?|جنيه(?:\s*مصري)?|\bEGP\b|\bLE\b)/i, 'EGP'],
  [/(?:ر\.?\s*س\.?|ريال\s*سعودي|\bSAR\b)/i, 'SAR'],
  [/(?:د\.?\s*إ\.?|درهم\s*إماراتي|\bAED\b)/i, 'AED'],
  [/(?:د\.?\s*ك\.?|\bKWD\b)/i, 'KWD'],
  [/(?:ر\.?\s*ق\.?|\bQAR\b)/i, 'QAR'],
  [/(?:د\.?\s*أ\.?|\bJOD\b)/i, 'JOD'],
  [/(?:د\.?\s*م\.?|\bMAD\b)/i, 'MAD'],
  [/(?:R\$|\bBRL\b)/i, 'BRL'],
  [/(?:AU\$|\bAUD\b)/i, 'AUD'],
  [/(?:CA\$|\bCAD\b)/i, 'CAD'],
  [/(?:US\$|\$|\bUSD\b)/i, 'USD'],
  [/(?:£|\bGBP\b)/i, 'GBP'],
  [/(?:€|\bEUR\b)/i, 'EUR'],
  [/(?:₺|\bTRY\b)/i, 'TRY'],
  [/(?:₹|\bINR\b|Rs\.?\s*\d)/i, 'INR'],
  [/(?:¥|\bJPY\b)/i, 'JPY'],
  [/(?:₽|\bRUB\b)/i, 'RUB'],
];

function inferCurrency(text, fallback) {
  if (typeof text === 'string') {
    for (const [re, code] of CURRENCY_PATTERNS) {
      if (re.test(text)) return code;
    }
  }
  const up = typeof fallback === 'string' ? fallback.toUpperCase() : '';
  return KNOWN_CURRENCIES.has(up) ? up : undefined;
}

export function extractPublicCoupon(text) {
  if (!text) return undefined;
  const m = text.match(/(?:code|coupon|promo|voucher|كوبون|كود(?:\s+الخصم)?)\s*[:#\-]?\s*([A-Z0-9]{4,18})\b/i);
  if (!m?.[1]) return undefined;
  const code = m[1].toUpperCase();
  if (/^(?:FREE|SALE|DEAL|CODE|HTTP|HTTPS|HTML|SAVE|NONE|NULL)$/.test(code)) return undefined;
  return code;
}

const CATEGORY_RULES = [
  ['grocery', /(?:supermarket|grocery|groceries|hypermarket|milk|cheese|rice|oil|sugar|coffee|tea|pasta|bread|water|snack|chocolate|detergent|diaper|pampers|chicken|meat|fruit|vegetable|سوبر\s*ماركت|هايبر|بقالة|حليب|لبن|جبن|أرز|ارز|زيت|سكر|قهوة|شاي|مكرونة|دجاج|فراخ|لحم|منظف|حفاضات|مقاضي|عروض\s*غذائية|lebensmittel|supermarch|supermercad)/i],
  ['dining', /(?:restaurant|pizza|burger|meal|delivery|cafe|starbucks|mcdonald|kfc|subway|domino|talabat|ubereats|doordash|deliveroo|buffet|shawarma|مطعم|مطاعم|بيتزا|برجر|وجبة|وجبات|توصيل\s*طعام|كافيه|شاورما|طلبات|مشويات|comida|restaurante)/i],
  ['digital', /(?:steam|playstation|ps5|ps4|xbox|nintendo|switch|epic\s*games|gog|humble|pc\s*game|dlc|software|vpn|antivirus|ebook|kindle|audible|subscription|udemy|coursera|game\s*pass|لعبة|ألعاب|اشتراك|برنامج|سوفتوير)/i],
  ['electronics', /(?:iphone|ipad|samsung|galaxy|xiaomi|redmi|pixel|laptop|macbook|notebook|monitor|tv|oled|qled|ssd|nvme|ram|gpu|rtx|cpu|ryzen|intel|headphone|earbud|airpod|speaker|camera|router|charger|power\s*bank|smartwatch|printer|keyboard|mouse|usb|bluetooth|drone|tablet|موبايل|هاتف|ايفون|سامسونج|لابتوب|شاشة|سماعة|سماعات|تلفزيون|شاحن|باور\s*بانك|راوتر|كاميرا|ساعة\s*ذكية|تابلت|كمبيوتر|إلكترونيات)/i],
  ['beauty', /(?:perfume|fragrance|eau\s*de|skincare|serum|sunscreen|shampoo|conditioner|makeup|lipstick|mascara|lotion|moisturizer|razor|grooming|deodorant|عطر|عطور|مكياج|بشرة|شامبو|سيروم|كريم|واقي\s*شمس|تجميل|عناية|parfum|kosmetik|belleza)/i],
  ['fashion', /(?:shirt|t-shirt|tee|hoodie|jacket|coat|jeans|pants|trouser|shorts|dress|sneaker|shoe|boot|sandal|sock|underwear|sweater|jogger|legging|backpack|handbag|sunglass|watch|adidas|nike|puma|zara|hm|uniqlo|gymshark|allbirds|tentree|kotn|قميص|تيشيرت|هودي|جاكيت|بنطلون|جينز|فستان|حذاء|كوتشي|شنطة|حقيبة|نظارة|ملابس|أزياء|سويت\s*شيرت|شروال)/i],
  ['home', /(?:air\s*fryer|blender|espresso|kettle|vacuum|dyson|roborock|microwave|fridge|washer|mattress|pillow|bedding|blanket|towel|chair|desk|sofa|lamp|cookware|pan|pot|knife|kitchen|garden|drill|tool|furniture|مقلاة|قلاية|خلاط|مكنسة|مطبخ|أثاث|كرسي|مكتب|مرتبة|مخدة|بطانية|مروحة|تكييف|ثلاجة|غسالة|ميكروويف|منزل|بيت)/i],
];

export function detectCategory(text, fallback = 'other') {
  const hay = cleanText(text || '', 300);
  if (hay) {
    for (const [cat, re] of CATEGORY_RULES) {
      if (re.test(hay)) return cat;
    }
  }
  return VALID_CATEGORIES.has(fallback) ? fallback : 'other';
}

export function computeMathDiscount(price, originalPrice) {
  if (
    price === undefined ||
    originalPrice === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(originalPrice) ||
    price <= 0 ||
    originalPrice <= price
  ) {
    return {verified: false};
  }
  const pct = Math.round(((originalPrice - price) / originalPrice) * 100);
  if (pct < 5 || pct > 95) return {verified: false};
  return {percent: pct, verified: true};
}

function roundMoney(n, currency) {
  const digits = currency && THREE_DECIMAL_CURRENCIES.has(currency) ? 3 : currency === 'JPY' ? 0 : 2;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------- Network Helpers ----------------

async function fetchText(url, accept = '*/*') {
  const safe = safeHttpsUrl(url);
  if (!safe) return {ok: false, status: 0, body: ''};
  try {
    const res = await fetch(safe, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
      },
    });
    if (!res.ok) return {ok: false, status: res.status, body: ''};
    const finalSafe = safeHttpsUrl(res.url || safe);
    if (!finalSafe) return {ok: false, status: 0, body: ''};
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) return {ok: false, status: 413, body: ''};
    const body = new TextDecoder('utf-8', {fatal: false}).decode(buf);
    return {ok: true, status: res.status, body, finalUrl: finalSafe};
  } catch {
    return {ok: false, status: 0, body: ''};
  }
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runner() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({length: Math.min(limit, items.length)}, () => runner());
  await Promise.all(runners);
  return results;
}

// ---------------- Parsers (RSS, Storefronts, CheapShark, Manual) ----------------

function extractTagContent(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function extractAttr(tag, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? decodeEntities(m[1] ?? m[2] ?? '').trim() : '';
}

function extractPriceAndDiscountFromTitle(title, defaultCurrency) {
  const currency = inferCurrency(title, defaultCurrency);
  let discountPercent;
  const pctMatch =
    title.match(/(\d{1,2})\s*%\s*(?:off|خصم|تخفيض|rabatt|remise|desconto|descuento|sconto|indirim|-)/i) ??
    title.match(/(?:save|خصم|وفر)\s*(\d{1,2})\s*%/i) ??
    title.match(/-\s*(\d{1,2})\s*%/);
  if (pctMatch) {
    const p = Number(pctMatch[1]);
    if (p >= 5 && p <= 95) discountPercent = p;
  }

  // Detect "now $29 (was $79)" or "$29 / $79" patterns when present in RSS titles
  const moneyToken = /(?:(?:US\$|CA\$|AU\$|R\$|[$£€₺₹¥₽])\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(?:[$£€₺₹¥₽]|EGP|SAR|AED|KWD|QAR|JOD|MAD|USD|EUR|GBP|TRY|INR|BRL|JPY|RUB|AUD|ج\.م|ر\.س|د\.إ))/gi;
  const foundPrices = [];
  let m;
  while ((m = moneyToken.exec(title)) !== null && foundPrices.length < 3) {
    const rawNum = m[1] || m[2];
    const parsed = parseNumberPrice(rawNum, currency);
    if (parsed !== null) foundPrices.push(parsed);
  }
  let price = foundPrices[0];
  let originalPrice;
  if (foundPrices.length >= 2 && foundPrices[1] > foundPrices[0]) {
    const check = computeMathDiscount(foundPrices[0], foundPrices[1]);
    if (check.verified) {
      originalPrice = foundPrices[1];
      discountPercent = check.percent;
    }
  }
  return {
    price,
    originalPrice,
    currency: price !== undefined ? currency : undefined,
    discountPercent,
  };
}

export function parseRssFeedXml(xml, spec, now) {
  if (!xml || xml.length > MAX_RESPONSE_BYTES) return [];
  const blocks = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = itemRe.exec(xml)) !== null && blocks.length < 48) {
    blocks.push(match[2]);
  }
  const deals = [];
  for (const block of blocks) {
    const title = cleanText(extractTagContent(block, 'title'), 200);
    if (!title) continue;

    const pubRaw =
      extractTagContent(block, 'pubDate') ||
      extractTagContent(block, 'updated') ||
      extractTagContent(block, 'published');
    const pubMs = pubRaw ? Date.parse(decodeEntities(pubRaw)) : NaN;
    if (Number.isFinite(pubMs) && now - pubMs > MAX_DEAL_AGE_MS) continue;

    let rawLink = decodeEntities(extractTagContent(block, 'link'));
    if (!rawLink) {
      const linkTags = block.match(/<link\b[^>]*>/gi) || [];
      const alt = linkTags.find(t => /rel\s*=\s*["']alternate["']/i.test(t)) || linkTags[0];
      if (alt) rawLink = extractAttr(alt, 'href');
    }
    const url = safeHttpsUrl(rawLink);
    if (!url) continue;

    let merchantName = '';
    let merchantPriceRaw = '';
    const merchantTag = block.match(/<[\w-]+:merchant\b[^>]*?(?:\/>|>([\s\S]*?)<\/[\w-]+:merchant>)/i);
    if (merchantTag) {
      merchantName = cleanText(extractAttr(merchantTag[0], 'name') || merchantTag[1] || '', 80);
      merchantPriceRaw = extractAttr(merchantTag[0], 'price');
    }
    const storeName = merchantName || spec.name;
    const rssCategoryText = cleanText(extractTagContent(block, 'category'), 80);

    let rawImg = '';
    const mediaMatches = block.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi) || [];
    for (const tag of mediaMatches) {
      const type = extractAttr(tag, 'type');
      if (type && !type.toLowerCase().startsWith('image/')) continue;
      const cand = extractAttr(tag, 'url') || extractAttr(tag, 'src');
      if (cand) {
        rawImg = cand;
        break;
      }
    }
    const imageUrl = safeProductImageUrl(rawImg, url);

    const desc = cleanText(
      extractTagContent(block, 'description') || extractTagContent(block, 'summary'),
      260,
    );
    const extracted = extractPriceAndDiscountFromTitle(title, spec.defaultCurrency);
    const merchantExtracted = merchantPriceRaw
      ? extractPriceAndDiscountFromTitle(merchantPriceRaw, spec.defaultCurrency)
      : {};
    const descExtracted =
      extracted.discountPercent === undefined
        ? extractPriceAndDiscountFromTitle(desc, spec.defaultCurrency)
        : {};
    const discountPercent = extracted.discountPercent ?? descExtracted.discountPercent;
    const price = merchantExtracted.price ?? extracted.price ?? descExtracted.price;
    const originalPrice = extracted.originalPrice ?? descExtracted.originalPrice;
    const currency = merchantExtracted.currency ?? extracted.currency ?? descExtracted.currency;
    const mathCheck = price !== undefined && originalPrice !== undefined ? computeMathDiscount(price, originalPrice) : {verified: false};
    const finalPct = mathCheck.percent ?? discountPercent;
    const couponCode = extractPublicCoupon(`${title} ${desc}`);
    const category = detectCategory(`${rssCategoryText} ${title} ${storeName}`, 'other');

    deals.push({
      title,
      url,
      storeName,
      price,
      originalPrice,
      currency,
      discountPercent: finalPct,
      verifiedDiscount: Boolean(mathCheck.verified),
      category,
      region: spec.region,
      source: 'community_rss',
      ...(couponCode ? {couponCode} : {}),
      ...(imageUrl ? {imageUrl} : {}),
      observedAt: Number.isFinite(pubMs) ? pubMs : now,
    });
  }
  return deals;
}

function buildMagentoGraphqlUrl(origin) {
  const gql = '{products(search:"sale",pageSize:24){items{name sku url_key url_suffix stock_status small_image{url} price_range{minimum_price{regular_price{value currency} final_price{value currency} discount{percent_off}}}}}}';
  const u = new URL('/graphql', origin);
  u.searchParams.set('query', gql);
  return u.href;
}

async function collectStorefrontDeals(store, now) {
  const origin = safeHttpsUrl(store.origin);
  if (!origin) return {ok: false, deals: []};
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const region = REGION_SET.has(store.region) ? store.region : 'GLOBAL';
  const defaultCat = VALID_CATEGORIES.has(store.defaultCategory) ? store.defaultCategory : 'other';

  let endpoint = '';
  if (store.platform === 'shopify') {
    endpoint = new URL('/products.json?limit=80', origin).href;
  } else if (store.platform === 'woocommerce') {
    endpoint = new URL('/wp-json/wc/store/v1/products?per_page=40&on_sale=true&stock_status=instock', origin).href;
  } else if (store.platform === 'magento2') {
    endpoint = buildMagentoGraphqlUrl(origin);
  } else {
    return {ok: false, deals: []};
  }

  const res = await fetchText(endpoint, 'application/json');
  if (!res.ok) return {ok: false, deals: []};

  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch {
    return {ok: false, deals: []};
  }

  const out = [];
  if (store.platform === 'shopify' && payload && Array.isArray(payload.products)) {
    const currency = inferCurrency('', store.currency);
    if (!currency) return {ok: true, deals: []};
    for (const row of payload.products) {
      if (!row || typeof row !== 'object') continue;
      const title = cleanText(row.title, 200);
      const handle = typeof row.handle === 'string' ? row.handle.trim() : '';
      const url = handle ? safeHttpsUrl(`/products/${handle}`, origin) : null;
      if (!title || !url) continue;

      const variants = Array.isArray(row.variants) ? row.variants : [];
      let bestPrice = null;
      let bestCompare = null;
      let bestPct = -1;
      for (const v of variants) {
        if (!v || typeof v !== 'object' || v.available === false) continue;
        const p = parseNumberPrice(v.price, currency);
        const cmp = parseNumberPrice(v.compare_at_price, currency);
        if (p !== null && cmp !== null && cmp > p) {
          const mCheck = computeMathDiscount(p, cmp);
          if (mCheck.verified && (mCheck.percent > bestPct || (mCheck.percent === bestPct && (bestPrice === null || p < bestPrice)))) {
            bestPrice = p;
            bestCompare = cmp;
            bestPct = mCheck.percent;
          }
        }
      }
      if (bestPrice === null || bestCompare === null) continue;
      const math = computeMathDiscount(bestPrice, bestCompare);
      if (!math.verified) continue;

      const rawImg = Array.isArray(row.images) && row.images[0] ? row.images[0].src : undefined;
      const imageUrl = safeProductImageUrl(rawImg, origin);
      const category = detectCategory(`${title} ${row.product_type || ''} ${host}`, defaultCat);

      out.push({
        title,
        url,
        storeName: cleanText(store.name || host, 80),
        price: roundMoney(bestPrice, currency),
        originalPrice: roundMoney(bestCompare, currency),
        currency,
        discountPercent: math.percent,
        verifiedDiscount: true,
        category,
        region,
        source: 'storefront_sale',
        ...(imageUrl ? {imageUrl} : {}),
        observedAt: now,
      });
    }
  } else if (store.platform === 'woocommerce' && Array.isArray(payload)) {
    for (const row of payload) {
      if (!row || typeof row !== 'object' || row.is_in_stock === false) continue;
      const title = cleanText(row.name, 200);
      const url = safeHttpsUrl(row.permalink, origin);
      const prices = row.prices && typeof row.prices === 'object' ? row.prices : null;
      if (!title || !url || !prices) continue;

      const cur = inferCurrency('', prices.currency_code || store.currency);
      if (!cur) continue;
      const minor = Number.isInteger(prices.currency_minor_unit) && prices.currency_minor_unit >= 0 && prices.currency_minor_unit <= 4
        ? prices.currency_minor_unit
        : 2;
      const rawSale = parseNumberPrice(prices.sale_price || prices.price, cur);
      const rawReg = parseNumberPrice(prices.regular_price, cur);
      if (rawSale === null || rawReg === null) continue;
      const scale = 10 ** minor;
      const price = roundMoney(rawSale / scale, cur);
      const originalPrice = roundMoney(rawReg / scale, cur);
      const math = computeMathDiscount(price, originalPrice);
      if (!math.verified) continue;

      const rawImg = Array.isArray(row.images) && row.images[0] ? row.images[0].src : undefined;
      const imageUrl = safeProductImageUrl(rawImg, origin);
      const category = detectCategory(`${title} ${host}`, defaultCat);

      out.push({
        title,
        url,
        storeName: cleanText(store.name || host, 80),
        price,
        originalPrice,
        currency: cur,
        discountPercent: math.percent,
        verifiedDiscount: true,
        category,
        region,
        source: 'storefront_sale',
        ...(imageUrl ? {imageUrl} : {}),
        observedAt: now,
      });
    }
  } else if (store.platform === 'magento2' && payload?.data?.products?.items && Array.isArray(payload.data.products.items)) {
    for (const row of payload.data.products.items) {
      if (!row || typeof row !== 'object' || row.stock_status === 'OUT_OF_STOCK') continue;
      const title = cleanText(row.name, 200);
      const urlKey = typeof row.url_key === 'string' ? row.url_key.replace(/^\/+/, '') : '';
      const suffix = typeof row.url_suffix === 'string' ? row.url_suffix : '.html';
      const url = urlKey ? safeHttpsUrl(`/${urlKey}${urlKey.endsWith(suffix) ? '' : suffix}`, origin) : null;
      const minP = row.price_range?.minimum_price;
      const cur = inferCurrency('', minP?.final_price?.currency || store.currency);
      const price = parseNumberPrice(minP?.final_price?.value, cur);
      const originalPrice = parseNumberPrice(minP?.regular_price?.value, cur);
      if (!title || !url || !cur || price === null || originalPrice === null) continue;
      const math = computeMathDiscount(price, originalPrice);
      if (!math.verified) continue;

      const imageUrl = safeProductImageUrl(row.small_image?.url, origin);
      const category = detectCategory(`${title} ${host}`, defaultCat);

      out.push({
        title,
        url,
        storeName: cleanText(store.name || host, 80),
        price: roundMoney(price, cur),
        originalPrice: roundMoney(originalPrice, cur),
        currency: cur,
        discountPercent: math.percent,
        verifiedDiscount: true,
        category,
        region,
        source: 'storefront_sale',
        ...(imageUrl ? {imageUrl} : {}),
        observedAt: now,
      });
    }
  }

  return {ok: true, deals: out};
}

async function collectCheapSharkDeals(now) {
  const [dealsResponses, storesRes] = await Promise.all([
    Promise.all(CHEAPSHARK_DEALS_URLS.map(u => fetchText(u, 'application/json'))),
    fetchText(CHEAPSHARK_STORES_URL, 'application/json'),
  ]);
  if (!dealsResponses.some(r => r.ok)) return {ok: false, deals: []};

  const storeNames = new Map();
  if (storesRes.ok) {
    try {
      const storesJson = JSON.parse(storesRes.body);
      if (Array.isArray(storesJson)) {
        for (const s of storesJson) {
          if (s && s.storeID && s.storeName) {
            storeNames.set(String(s.storeID), cleanText(String(s.storeName), 60));
          }
        }
      }
    } catch {
      // Ignore optional store name map failure
    }
  }

  const combinedRows = [];
  for (const dRes of dealsResponses) {
    if (!dRes.ok) continue;
    try {
      const parsed = JSON.parse(dRes.body);
      if (Array.isArray(parsed)) combinedRows.push(...parsed);
    } catch {}
  }

  const seenDealIds = new Set();
  const out = [];
  for (const row of combinedRows) {
    if (!row || typeof row !== 'object') continue;
    const title = cleanText(row.title, 200);
    const dealID = typeof row.dealID === 'string' ? row.dealID.trim() : '';
    if (!dealID || seenDealIds.has(dealID)) continue;
    seenDealIds.add(dealID);

    const sale = parseNumberPrice(row.salePrice, 'USD');
    const normal = parseNumberPrice(row.normalPrice, 'USD');
    if (!title || sale === null || normal === null) continue;
    const math = computeMathDiscount(sale, normal);
    if (!math.verified || math.percent < 30 || math.percent > 95) continue;
    const url = safeHttpsUrl(`https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(dealID)}`);
    if (!url) continue;

    const storeLabel = storeNames.get(String(row.storeID)) || 'Digital Store Offer';
    const imageUrl = safeProductImageUrl(row.thumb, url);

    out.push({
      title,
      url,
      storeName: storeLabel,
      price: roundMoney(sale, 'USD'),
      originalPrice: roundMoney(normal, 'USD'),
      currency: 'USD',
      discountPercent: math.percent,
      verifiedDiscount: true,
      category: 'digital',
      region: 'GLOBAL',
      source: 'digital_api',
      ...(imageUrl ? {imageUrl} : {}),
      observedAt: now,
    });
  }
  return {ok: true, deals: out};
}

function loadJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadManualDeals(now) {
  const doc = loadJsonFile(MANUAL_DEALS_PATH, {deals: []});
  const rows = Array.isArray(doc?.deals) ? doc.deals : [];
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const title = cleanText(raw.title, 200);
    const url = safeHttpsUrl(raw.url);
    if (!title || !url) continue;

    const expiresAt =
      typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
        ? raw.expiresAt
        : typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt))
          ? Date.parse(raw.expiresAt)
          : undefined;
    if (expiresAt !== undefined && expiresAt < now) continue;

    const region = typeof raw.region === 'string' && REGION_SET.has(raw.region.toUpperCase())
      ? raw.region.toUpperCase()
      : 'GLOBAL';
    const currency = inferCurrency('', raw.currency);
    const price = currency ? parseNumberPrice(raw.price, currency) ?? undefined : undefined;
    const originalPrice = currency ? parseNumberPrice(raw.originalPrice, currency) ?? undefined : undefined;
    const math = computeMathDiscount(price, originalPrice);
    const declaredPct =
      typeof raw.discountPercent === 'number' && raw.discountPercent >= 5 && raw.discountPercent <= 95
        ? Math.round(raw.discountPercent)
        : undefined;
    const discountPercent = math.percent ?? declaredPct;
    const storeName = cleanText(raw.storeName || new URL(url).hostname.replace(/^www\./, ''), 80);
    const category =
      typeof raw.category === 'string' && VALID_CATEGORIES.has(raw.category.toLowerCase())
        ? raw.category.toLowerCase()
        : detectCategory(`${title} ${storeName}`, 'other');
    const couponCode =
      typeof raw.couponCode === 'string' && raw.couponCode.trim().length >= 3
        ? raw.couponCode.trim().slice(0, 24).toUpperCase()
        : extractPublicCoupon(title);
    const imageUrl = safeProductImageUrl(raw.imageUrl, url);

    out.push({
      title,
      url,
      storeName,
      ...(price !== undefined ? {price: roundMoney(price, currency)} : {}),
      ...(originalPrice !== undefined && price !== undefined && originalPrice > price
        ? {originalPrice: roundMoney(originalPrice, currency)}
        : {}),
      ...(currency && price !== undefined ? {currency} : {}),
      ...(discountPercent !== undefined ? {discountPercent} : {}),
      verifiedDiscount: math.verified,
      category,
      region,
      source: 'manual',
      ...(couponCode ? {couponCode} : {}),
      ...(expiresAt !== undefined ? {expiresAt} : {}),
      ...(imageUrl ? {imageUrl} : {}),
      observedAt: now,
    });
  }
  return out;
}

// ---------------- Anti-Fake-Discount Guard & Historical Ledger ----------------

function computeMedian(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function applyAntiFakeDiscountGuard(deals, ledger, now) {
  const items = ledger.items && typeof ledger.items === 'object' ? ledger.items : {};
  let ledgerChanged = false;
  let rejectedFakeInflation = 0;
  let rejectedExpired = 0;
  const accepted = [];

  for (const deal of deals) {
    if (deal.expiresAt !== undefined && deal.expiresAt < now) {
      rejectedExpired++;
      continue;
    }
    if (deal.observedAt && now - deal.observedAt > MAX_DEAL_AGE_MS) {
      rejectedExpired++;
      continue;
    }

    const key = canonicalDealKey(deal.url);
    if (!key) continue;

    let verifiedDiscount = Boolean(deal.verifiedDiscount);
    let discountPercent = deal.discountPercent;
    let originalPrice = deal.originalPrice;

    if (deal.price !== undefined && originalPrice !== undefined) {
      const math = computeMathDiscount(deal.price, originalPrice);
      if (!math.verified) {
        // Invalid math (e.g., original <= sale or <5% or >95%)
        originalPrice = undefined;
        verifiedDiscount = false;
        if (discountPercent !== undefined && (discountPercent < 5 || discountPercent > 95)) {
          discountPercent = undefined;
        }
      } else {
        discountPercent = math.percent;
        verifiedDiscount = true;
      }
    }

    // Check historical ledger against fake originalPrice inflation
    const prev = items[key];
    if (deal.price !== undefined && deal.currency) {
      if (prev && prev.currency === deal.currency && Array.isArray(prev.samples) && prev.samples.length >= 2) {
        const baselineMax = Math.max(prev.maxPrice || 0, prev.regularMax || 0);
        if (
          originalPrice !== undefined &&
          baselineMax > 0 &&
          originalPrice > baselineMax * 1.25 &&
          deal.price >= prev.minPrice * 0.98
        ) {
          // Fake MSRP inflation detected: originalPrice jumped >25% above historical ceiling without real drop
          rejectedFakeInflation++;
          continue;
        }
        if (verifiedDiscount && discountPercent >= 40 && deal.price > prev.minPrice * 1.15) {
          // Price is still noticeably above its known recent low — downgrade verified flag
          verifiedDiscount = false;
        }
      }

      // Record current price observation in ledger (rate-limited so unchanged runs produce clean git diffs)
      if (!prev || prev.currency !== deal.currency) {
        items[key] = {
          currency: deal.currency,
          lastPrice: deal.price,
          minPrice: deal.price,
          maxPrice: deal.price,
          medianPrice: deal.price,
          ...(originalPrice !== undefined ? {regularMax: originalPrice} : {}),
          samples: [deal.price],
          lastSeenAt: now,
        };
        ledgerChanged = true;
      } else {
        const priceMoved = Math.abs(prev.lastPrice - deal.price) > 0.0001;
        const staleSample = now - (prev.lastSeenAt || 0) >= LEDGER_MIN_SAMPLE_INTERVAL_MS;
        if (priceMoved || staleSample) {
          const nextSamples = [...(Array.isArray(prev.samples) ? prev.samples : []), deal.price].slice(-12);
          const nextMin = Math.min(prev.minPrice ?? deal.price, ...nextSamples);
          const nextMax = Math.max(prev.maxPrice ?? deal.price, ...nextSamples);
          const nextRegularMax =
            originalPrice !== undefined && verifiedDiscount
              ? Math.max(prev.regularMax ?? originalPrice, originalPrice)
              : prev.regularMax;
          items[key] = {
            currency: deal.currency,
            lastPrice: deal.price,
            minPrice: nextMin,
            maxPrice: nextMax,
            medianPrice: roundMoney(computeMedian(nextSamples), deal.currency),
            ...(nextRegularMax !== undefined ? {regularMax: nextRegularMax} : {}),
            samples: nextSamples,
            lastSeenAt: now,
          };
          ledgerChanged = true;
        }
      }
    }

    // Quality filter for hot deals feed (math ceiling up to 95%, prioritizing 70%–90% mega deals):
    // - Manual deals: always keep (already validated & non-expired)
    // - Digital API & Storefront deals: keep verified 20%–95% (prioritizing 50%–90% & mega 70%–90%)
    // - Community RSS deals: keep when discount is 30%–95% OR verified price/discount exists
    if (deal.source === 'digital_api') {
      if (!verifiedDiscount || !discountPercent || discountPercent < 30 || discountPercent > 95) continue;
    } else if (deal.source === 'storefront_sale') {
      if (!verifiedDiscount || !discountPercent || discountPercent < 20 || discountPercent > 95) continue;
    } else if (deal.source === 'community_rss') {
      const hasHotPct = discountPercent !== undefined && discountPercent >= 30 && discountPercent <= 95;
      const hasValidPrice = deal.price !== undefined && deal.currency !== undefined;
      if (!hasHotPct && !hasValidPrice) continue;
      if (discountPercent !== undefined && (discountPercent < 5 || discountPercent > 95)) {
        discountPercent = undefined;
      }
    }

    const dealTier = computeDealTier(discountPercent);
    const idHash = crypto.createHash('sha1').update(`${deal.region}|${key}`).digest('hex').slice(0, 12);
    accepted.push({
      id: deal.id || `feed-${deal.region.toLowerCase()}-${idHash}`,
      title: deal.title,
      url: deal.url,
      storeName: deal.storeName,
      ...(deal.price !== undefined ? {price: deal.price} : {}),
      ...(originalPrice !== undefined ? {originalPrice} : {}),
      ...(deal.currency && deal.price !== undefined ? {currency: deal.currency} : {}),
      ...(discountPercent !== undefined ? {discountPercent} : {}),
      verifiedDiscount,
      dealTier,
      category: deal.category,
      region: deal.region,
      source: deal.source,
      ...(deal.isManual ? {isManual: true} : {}),
      ...(deal.couponCode ? {couponCode: deal.couponCode} : {}),
      ...(deal.expiresAt !== undefined ? {expiresAt: deal.expiresAt} : {}),
      ...(deal.imageUrl ? {imageUrl: deal.imageUrl} : {}),
      observedAt: deal.observedAt || now,
    });
  }

  // Prune stale ledger entries (>90 days) and enforce size cap
  const entries = Object.entries(items);
  let pruned = false;
  const freshEntries = entries.filter(([, v]) => v && typeof v.lastSeenAt === 'number' && now - v.lastSeenAt <= LEDGER_PRUNE_AGE_MS);
  if (freshEntries.length !== entries.length) pruned = true;
  if (freshEntries.length > LEDGER_MAX_ENTRIES) {
    freshEntries.sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
    freshEntries.length = LEDGER_MAX_ENTRIES;
    pruned = true;
  }

  const nextLedger = {
    schemaVersion: 1,
    updatedAt: ledgerChanged || pruned ? now : ledger.updatedAt || now,
    items: Object.fromEntries(freshEntries),
  };

  return {
    deals: accepted,
    ledger: nextLedger,
    ledgerChanged: ledgerChanged || pruned,
    stats: {rejectedFakeInflation, rejectedExpired},
  };
}

function deduplicateDeals(deals) {
  const seenUrl = new Set();
  const seenTitleStore = new Set();
  const out = [];
  for (const d of deals) {
    const uKey = canonicalDealKey(d.url);
    const tKey = `${normalizeTitleKey(d.title)}::${d.storeName.toLowerCase()}`;
    if (uKey && seenUrl.has(uKey)) continue;
    if (tKey && seenTitleStore.has(tKey)) continue;
    if (uKey) seenUrl.add(uKey);
    if (tKey) seenTitleStore.add(tKey);
    out.push(d);
  }
  return out;
}

function dealPriorityBand(d, region) {
  const pct = d.discountPercent ?? 0;
  const isLocal = d.region === region;
  if ((d.source === 'manual' || d.isManual) && (isLocal || d.region === 'GLOBAL')) return 0;
  if (isLocal && pct >= 70 && pct <= 90) return 1;
  if (isLocal && pct >= 50) return 2;
  if (d.verifiedDiscount && pct >= 70 && pct <= 90) return 3;
  if (isLocal && pct >= 30) return 4;
  if (pct >= 70) return 5;
  if (pct >= 50) return 6;
  if (isLocal) return 7;
  return 8;
}

function rankDealsForRegion(deals, region) {
  return [...deals].sort((a, b) => {
    const bandA = dealPriorityBand(a, region);
    const bandB = dealPriorityBand(b, region);
    if (bandA !== bandB) return bandA - bandB;

    const aVer = a.verifiedDiscount ? 0 : 1;
    const bVer = b.verifiedDiscount ? 0 : 1;
    if (aVer !== bVer) return aVer - bVer;

    const pctDiff = (b.discountPercent ?? 0) - (a.discountPercent ?? 0);
    if (pctDiff !== 0) return pctDiff;

    return (b.observedAt || 0) - (a.observedAt || 0);
  });
}

// ---------------- Bidirectional Supabase Sync ($0 Free Tier) ----------------

function parseSupabaseManualRow(row, now) {
  if (!row || typeof row !== 'object') return null;
  const title = cleanText(String(row.title || ''), 200);
  const url = safeHttpsUrl(String(row.url || ''));
  if (!title || !url) return null;
  const expiresAt =
    row.expires_at !== null && row.expires_at !== undefined && Number.isFinite(Number(row.expires_at))
      ? Number(row.expires_at)
      : undefined;
  if (expiresAt !== undefined && expiresAt <= now) return null;

  const region = typeof row.region === 'string' && REGION_SET.has(row.region.toUpperCase())
    ? row.region.toUpperCase()
    : 'GLOBAL';
  const currency = inferCurrency('', String(row.currency || 'USD')) || 'USD';
  const price = parseNumberPrice(row.price, currency) ?? undefined;
  const originalPrice = parseNumberPrice(row.original_price, currency) ?? undefined;
  const math = computeMathDiscount(price, originalPrice);
  const rawPct = Number(row.discount_percent);
  const discountPercent = math.percent ?? (Number.isFinite(rawPct) && rawPct >= 5 && rawPct <= 95 ? Math.round(rawPct) : undefined);
  const storeName = cleanText(String(row.merchant || new URL(url).hostname.replace(/^www\./, '')), 80);
  const category =
    typeof row.category === 'string' && VALID_CATEGORIES.has(row.category.toLowerCase())
      ? row.category.toLowerCase()
      : detectCategory(`${title} ${storeName}`, 'other');
  const couponCode =
    typeof row.coupon_code === 'string' && row.coupon_code.trim().length >= 3
      ? row.coupon_code.trim().slice(0, 24).toUpperCase()
      : undefined;
  const imageUrl = safeProductImageUrl(row.image_url, url);

  return {
    id: typeof row.id === 'string' && row.id ? row.id : undefined,
    title,
    url,
    storeName,
    ...(price !== undefined ? {price: roundMoney(price, currency)} : {}),
    ...(originalPrice !== undefined && price !== undefined && originalPrice > price
      ? {originalPrice: roundMoney(originalPrice, currency)}
      : {}),
    ...(price !== undefined ? {currency} : {}),
    ...(discountPercent !== undefined ? {discountPercent} : {}),
    verifiedDiscount: math.verified || Boolean(row.verified_discount),
    dealTier: computeDealTier(discountPercent),
    category,
    region,
    source: 'manual',
    isManual: true,
    ...(couponCode ? {couponCode} : {}),
    ...(expiresAt !== undefined ? {expiresAt} : {}),
    ...(imageUrl ? {imageUrl} : {}),
    observedAt: Number.isFinite(Number(row.observed_at)) ? Number(row.observed_at) : now,
  };
}

function mergeRemoteLedgerIntoLocal(ledger, remoteRows, now) {
  if (!Array.isArray(remoteRows) || !remoteRows.length) return;
  if (!ledger.items || typeof ledger.items !== 'object') ledger.items = {};
  for (const r of remoteRows) {
    if (!r || typeof r !== 'object') continue;
    const key = canonicalDealKey(String(r.url || ''));
    const cur = inferCurrency('', String(r.currency || ''));
    const minP = Number(r.min_price);
    const lastP = Number(r.last_price);
    if (!key || !cur || !Number.isFinite(minP) || minP <= 0 || !Number.isFinite(lastP) || lastP <= 0) continue;
    const existing = ledger.items[key];
    if (!existing) {
      ledger.items[key] = {
        currency: cur,
        lastPrice: lastP,
        minPrice: minP,
        maxPrice: Math.max(minP, lastP),
        medianPrice: lastP,
        samples: minP !== lastP ? [minP, lastP] : [lastP],
        firstSeenAt: Number(r.first_seen_at) || now,
        lastSeenAt: Number(r.last_seen_at) || now,
      };
    } else if (existing.currency === cur) {
      existing.minPrice = Math.min(existing.minPrice ?? minP, minP);
      existing.firstSeenAt = Math.min(existing.firstSeenAt ?? now, Number(r.first_seen_at) || now);
    }
  }
}

async function pullSupabaseBaseline(now) {
  const supabaseUrl = safeHttpsUrl(process.env.SUPABASE_URL || '');
  const syncToken = (process.env.SUPABASE_SYNC_TOKEN || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || (!syncToken && !serviceKey)) {
    return {enabled: false, manualDeals: [], ledgerBaseline: []};
  }

  try {
    if (syncToken) {
      const endpoint = new URL('/functions/v1/sync-deals', supabaseUrl).href;
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          'x-ruzmi-sync-token': syncToken,
        },
        body: JSON.stringify({includeLedger: true}),
      });
      if (!res.ok) return {enabled: true, ok: false, manualDeals: [], ledgerBaseline: []};
      const json = await res.json();
      const manualDeals = Array.isArray(json.manualDeals)
        ? json.manualDeals.map(r => parseSupabaseManualRow(r, now)).filter(Boolean)
        : [];
      return {
        enabled: true,
        ok: true,
        manualDeals,
        ledgerBaseline: Array.isArray(json.ledgerBaseline) ? json.ledgerBaseline : [],
      };
    }

    // Direct REST mode with SUPABASE_SERVICE_ROLE_KEY
    const headers = {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`};
    const [mRes, lRes] = await Promise.all([
      fetch(new URL('/rest/v1/hot_deals?is_manual=eq.true&select=*', supabaseUrl).href, {
        headers,
        signal: AbortSignal.timeout(12000),
      }),
      fetch(
        new URL(
          '/rest/v1/deal_price_ledger?select=url_hash,url,min_price,last_price,currency,first_seen_at,last_seen_at&order=last_seen_at.desc&limit=3000',
          supabaseUrl,
        ).href,
        {headers, signal: AbortSignal.timeout(12000)},
      ),
    ]);
    const rawManual = mRes.ok ? await mRes.json() : [];
    const ledgerBaseline = lRes.ok ? await lRes.json() : [];
    const manualDeals = Array.isArray(rawManual)
      ? rawManual.map(r => parseSupabaseManualRow(r, now)).filter(Boolean)
      : [];
    return {enabled: true, ok: true, manualDeals, ledgerBaseline: Array.isArray(ledgerBaseline) ? ledgerBaseline : []};
  } catch {
    return {enabled: true, ok: false, manualDeals: [], ledgerBaseline: []};
  }
}

async function syncDealsToSupabase(uniqueDeals, ledger, now) {
  const supabaseUrl = safeHttpsUrl(process.env.SUPABASE_URL || '');
  const syncToken = (process.env.SUPABASE_SYNC_TOKEN || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || (!syncToken && !serviceKey)) {
    return {enabled: false, ok: false, upsertedDeals: 0, ledgerUpserted: 0};
  }

  const dealRows = uniqueDeals
    .filter(d => !d.isManual && d.price !== undefined && d.price > 0 && d.currency)
    .map(d => ({
      id: d.id,
      region: d.region,
      category: d.category || 'other',
      title: d.title,
      merchant: d.storeName,
      url: d.url,
      image_url: d.imageUrl || null,
      price: d.price,
      original_price: d.originalPrice ?? null,
      currency: d.currency,
      discount_percent: d.discountPercent ?? 0,
      verified_discount: Boolean(d.verifiedDiscount),
      deal_tier: d.dealTier || computeDealTier(d.discountPercent),
      coupon_code: d.couponCode || null,
      source: d.source,
      is_manual: false,
      observed_at: d.observedAt || now,
      expires_at: d.expiresAt ?? null,
    }));

  const ledgerEntries = Object.entries(ledger.items || {}).map(([url, v]) => ({
    url_hash: crypto.createHash('sha256').update(url).digest('hex'),
    url,
    min_price: v.minPrice ?? v.lastPrice,
    last_price: v.lastPrice,
    currency: v.currency || 'USD',
    first_seen_at: v.firstSeenAt || v.lastSeenAt || now,
    last_seen_at: v.lastSeenAt || now,
  }));

  try {
    if (syncToken) {
      const endpoint = new URL('/functions/v1/sync-deals', supabaseUrl).href;
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(25000),
        headers: {
          'Content-Type': 'application/json',
          'x-ruzmi-sync-token': syncToken,
        },
        body: JSON.stringify({deals: dealRows, ledger: ledgerEntries}),
      });
      if (!res.ok) {
        return {enabled: true, ok: false, status: res.status, upsertedDeals: 0, ledgerUpserted: 0};
      }
      const out = await res.json();
      return {
        enabled: true,
        ok: Boolean(out.ok),
        upsertedDeals: Number(out.upsertedDeals || 0),
        ledgerUpserted: Number(out.ledgerUpserted || 0),
      };
    }

    // Direct REST mode with SUPABASE_SERVICE_ROLE_KEY
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };
    const cutoffIso = new Date(now - 5 * 60 * 1000).toISOString();
    const syncIso = new Date(now).toISOString();
    let upsertedDeals = 0;
    for (let i = 0; i < dealRows.length; i += 200) {
      const chunk = dealRows.slice(i, i + 200).map(r => ({...r, updated_at: syncIso}));
      const r = await fetch(new URL('/rest/v1/hot_deals?on_conflict=id', supabaseUrl).href, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) upsertedDeals += chunk.length;
    }
    await fetch(
      new URL(`/rest/v1/hot_deals?is_manual=eq.false&updated_at=lt.${encodeURIComponent(cutoffIso)}`, supabaseUrl).href,
      {method: 'DELETE', headers: {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`}},
    );
    let ledgerUpserted = 0;
    for (let i = 0; i < ledgerEntries.length; i += 250) {
      const chunk = ledgerEntries.slice(i, i + 250);
      const r = await fetch(new URL('/rest/v1/deal_price_ledger?on_conflict=url_hash', supabaseUrl).href, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) ledgerUpserted += chunk.length;
    }
    return {enabled: true, ok: true, upsertedDeals, ledgerUpserted};
  } catch {
    return {enabled: true, ok: false, upsertedDeals: 0, ledgerUpserted: 0};
  }
}

function buildLandingHtml(indexDoc) {
  const rows = ALL_REGIONS.map(r => {
    const info = indexDoc.regions[r] || {count: 0, localCount: 0};
    return `<li><a href="./deals/${r}.json"><code>deals/${r}.json</code></a> — ${info.count} deals (${info.localCount} regional)</li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>RUZMI Hot Deals Feed</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;background:#0f172a;color:#e2e8f0;line-height:1.6}
  a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}
  code{background:#1e293b;padding:2px 6px;border-radius:4px}
  ul{columns:2;gap:24px;padding-left:20px}
</style>
</head>
<body>
  <h1>RUZMI Hot Deals Static Feed</h1>
  <p>Updated: <code>${indexDoc.generatedAtIso}</code> · Total unique deals: <strong>${indexDoc.totalUniqueDeals}</strong></p>
  <p>Manifest: <a href="./deals/index.json"><code>deals/index.json</code></a></p>
  <ul>${rows}</ul>
</body>
</html>
`;
}

// ---------------- Main Pipeline ----------------

export async function runCollector() {
  const now = Date.now();
  const generatedAtIso = new Date(now).toISOString();

  // 1. Load optional extra storefronts, local manual deals, local price ledger & remote Supabase baseline
  const extraStoresDoc = loadJsonFile(EXTRA_STORES_PATH, {stores: []});
  const extraStores = Array.isArray(extraStoresDoc?.stores) ? extraStoresDoc.stores : [];
  const allStorefronts = [...BUILTIN_STOREFRONTS, ...extraStores];
  const fileManualDeals = loadManualDeals(now);
  const ledger = loadJsonFile(LEDGER_PATH, {schemaVersion: 1, updatedAt: 0, items: {}});
  const remotePre = await pullSupabaseBaseline(now);
  if (remotePre.ledgerBaseline?.length) {
    mergeRemoteLedgerIntoLocal(ledger, remotePre.ledgerBaseline, now);
  }
  const manualDeals = [...remotePre.manualDeals, ...fileManualDeals];

  // 2. Collect from all open sources in bounded parallel pool
  const tasks = [
    ...allStorefronts.map(store => ({
      kind: 'storefront',
      label: store.origin,
      run: () => collectStorefrontDeals(store, now),
    })),
    ...COMMUNITY_RSS_FEEDS.map(feed => ({
      kind: 'rss',
      label: feed.name,
      run: async () => {
        const res = await fetchText(feed.url, 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5');
        if (!res.ok) return {ok: false, deals: []};
        return {ok: true, deals: parseRssFeedXml(res.body, feed, now)};
      },
    })),
    {
      kind: 'digital_api',
      label: 'CheapShark',
      run: () => collectCheapSharkDeals(now),
    },
  ];

  const taskResults = await runPool(tasks, 5, async t => {
    const r = await t.run();
    return {label: t.label, kind: t.kind, ok: r.ok, count: r.deals.length, deals: r.deals};
  });

  const rawDeals = [...manualDeals];
  let sourcesSucceeded = 0;
  for (const r of taskResults) {
    if (r.ok) sourcesSucceeded++;
    rawDeals.push(...r.deals);
  }

  // 3. Anti-Fake-Discount verification & deduplication
  const guarded = applyAntiFakeDiscountGuard(rawDeals, ledger, now);
  const uniqueDeals = deduplicateDeals(guarded.deals);
  const megaDealsCount = uniqueDeals.filter(d => d.dealTier === 'mega').length;
  const hotDealsCount = uniqueDeals.filter(d => d.dealTier === 'hot').length;

  // 4. Sync verified deals & historical price ledger to Supabase (if configured)
  const supabaseSync = await syncDealsToSupabase(uniqueDeals, guarded.ledger, now);

  // 5. Write updated price-ledger.json only when changed
  fs.mkdirSync(DATA_DIR, {recursive: true});
  if (guarded.ledgerChanged || !fs.existsSync(LEDGER_PATH)) {
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(guarded.ledger, null, 2)}\n`, 'utf8');
  }

  // 6. Generate compact static JSON feeds for all 19 regions + index.json + .nojekyll
  fs.mkdirSync(DEALS_OUT_DIR, {recursive: true});
  fs.writeFileSync(path.join(PUBLIC_DIR, '.nojekyll'), '', 'utf8');

  const globalPool = rankDealsForRegion(
    uniqueDeals.filter(d => d.region === 'GLOBAL'),
    'GLOBAL',
  );

  const regionSummary = {};
  const categorySummary = {};
  for (const d of uniqueDeals) {
    categorySummary[d.category] = (categorySummary[d.category] || 0) + 1;
  }

  for (const region of ALL_REGIONS) {
    let regionDeals;
    let localCount;
    if (region === 'GLOBAL') {
      // GLOBAL feed combines all GLOBAL deals plus highest-discount verified international deals
      const topAll = rankDealsForRegion(uniqueDeals, 'GLOBAL').slice(0, MAX_DEALS_PER_REGION);
      regionDeals = topAll;
      localCount = globalPool.length;
    } else {
      const localDeals = rankDealsForRegion(
        uniqueDeals.filter(d => d.region === region),
        region,
      );
      localCount = localDeals.length;
      const combined = deduplicateDeals([...localDeals, ...globalPool]);
      regionDeals = rankDealsForRegion(combined, region).slice(0, MAX_DEALS_PER_REGION);
    }

    const regionDoc = {
      schemaVersion: 1,
      region,
      updatedAt: now,
      generatedAtIso,
      count: regionDeals.length,
      localCount,
      deals: regionDeals,
    };
    fs.writeFileSync(path.join(DEALS_OUT_DIR, `${region}.json`), JSON.stringify(regionDoc), 'utf8');
    regionSummary[region] = {
      file: `${region}.json`,
      count: regionDeals.length,
      localCount,
      updatedAt: now,
    };
  }

  const indexDoc = {
    schemaVersion: 1,
    updatedAt: now,
    generatedAtIso,
    totalUniqueDeals: uniqueDeals.length,
    megaDealsCount,
    hotDealsCount,
    manualDealsCount: manualDeals.length,
    sourcesChecked: tasks.length,
    sourcesSucceeded,
    supabaseSync: {
      enabled: supabaseSync.enabled,
      ok: supabaseSync.ok,
      upsertedDeals: supabaseSync.upsertedDeals,
      ledgerUpserted: supabaseSync.ledgerUpserted,
      manualFromDb: remotePre.manualDeals?.length || 0,
    },
    antiFakeGuard: {
      trackedUrls: Object.keys(guarded.ledger.items).length,
      rejectedFakeInflation: guarded.stats.rejectedFakeInflation,
      rejectedExpired: guarded.stats.rejectedExpired,
    },
    categories: categorySummary,
    regions: regionSummary,
  };

  fs.writeFileSync(path.join(DEALS_OUT_DIR, 'index.json'), JSON.stringify(indexDoc, null, 2), 'utf8');
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), buildLandingHtml(indexDoc), 'utf8');

  return {indexDoc, taskResults};
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const {indexDoc, taskResults} = await runCollector();
  const summary = {
    generatedAtIso: indexDoc.generatedAtIso,
    sourcesChecked: indexDoc.sourcesChecked,
    sourcesSucceeded: indexDoc.sourcesSucceeded,
    totalUniqueDeals: indexDoc.totalUniqueDeals,
    megaDealsCount: indexDoc.megaDealsCount,
    hotDealsCount: indexDoc.hotDealsCount,
    manualDealsCount: indexDoc.manualDealsCount,
    supabaseSync: indexDoc.supabaseSync,
    antiFakeGuard: indexDoc.antiFakeGuard,
    categories: indexDoc.categories,
    sourceBreakdown: taskResults.map(r => ({label: r.label, kind: r.kind, ok: r.ok, count: r.count})),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

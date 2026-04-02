#!/usr/bin/env node
/**
 * Fetch Sales from WooCommerce - Starting from Day 0
 * 
 * Handles:
 *   - Individual products
 *   - Bundles (Starter paket, AirFlow Modal) - parses meta for individual items
 *   - Packs (5-paket, 7-paket) - multiplies quantity
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { detectProduct } = require('./detect-product');

const OUTPUT_PATH = path.join(__dirname, 'stock-data.json');
const INVENTORY_PATH = path.join(__dirname, 'inventory-data.json');

// WooCommerce stores - ALL stores share same inventory
const STORES = [
    { name: 'HR', url: 'https://noriks.com/hr', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'CZ', url: 'https://noriks.com/cz', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'PL', url: 'https://noriks.com/pl', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'GR', url: 'https://noriks.com/gr', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'SK', url: 'https://noriks.com/sk', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'IT', url: 'https://noriks.com/it', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' },
    { name: 'HU', url: 'https://noriks.com/hu', ck: 'YOUR_WC_CONSUMER_KEY', cs: 'YOUR_WC_CONSUMER_SECRET' }
];

// Color mappings - ALL languages (HR, CZ, PL, GR, SK, IT, HU)
const COLOR_MAP = {
    // Black
    'crna': 'Black', 'črna': 'Black', 'black': 'Black', 'crn': 'Black', 'crne': 'Black',
    'černá': 'Black', 'černé': 'Black', 'czarny': 'Black', 'czarna': 'Black', 'czarne': 'Black',
    'μαύρο': 'Black', 'μαύρα': 'Black', 'μαύρες': 'Black', 'mavro': 'Black', 'mavra': 'Black',
    'čierna': 'Black', 'čierne': 'Black', 'nero': 'Black', 'nera': 'Black', 'nere': 'Black', 'neri': 'Black',
    'fekete': 'Black',
    'crnih': 'Black', 'černých': 'Black', 'czarnych': 'Black', 'czarne': 'Black',
    // Blue
    'modra': 'Blue', 'plava': 'Blue', 'blue': 'Blue', 'tamnoplava': 'Blue', 'navy': 'Blue',
    'modrá': 'Blue', 'niebieski': 'Blue', 'niebieska': 'Blue',
    'μπλε': 'Blue', 'mple': 'Blue',
    'modrý': 'Blue', 'blu': 'Blue', 'azzurro': 'Blue',
    'kék': 'Blue',
    'plavih': 'Blue', 'modré': 'Blue', 'modrých': 'Blue', 'niebieskich': 'Blue',
    // Green
    'zelena': 'Green', 'green': 'Green',
    'zelená': 'Green', 'zielony': 'Green', 'zielona': 'Green',
    'πράσινο': 'Green', 'prasino': 'Green',
    'verde': 'Green', 'zöld': 'Green',
    'zelene': 'Green', 'zeleni': 'Green', 'zelených': 'Green', 'zielonych': 'Green',
    // Grey
    'siva': 'Grey', 'grey': 'Grey', 'gray': 'Grey',
    'šedá': 'Grey', 'szary': 'Grey', 'szara': 'Grey',
    'γκρι': 'Grey', 'gkri': 'Grey',
    'sivá': 'Grey', 'grigio': 'Grey', 'grigia': 'Grey',
    'szürke': 'Grey',
    'sive': 'Grey', 'sivih': 'Grey', 'šedé': 'Grey', 'šedých': 'Grey', 'szarych': 'Grey',
    // Brown
    'rjava': 'Brown', 'brown': 'Brown', 'smeda': 'Brown', 'smeđa': 'Brown',
    'hnědá': 'Brown', 'brązowy': 'Brown',
    'καφέ': 'Brown', 'kafe': 'Brown',
    'hnedá': 'Brown', 'marrone': 'Brown', 'barna': 'Brown',
    // Beige
    'bež': 'Beige', 'beige': 'Beige', 'bez': 'Beige',
    'béžová': 'Beige', 'beżowy': 'Beige',
    'μπεζ': 'Beige', 'mpez': 'Beige',
    'bežová': 'Beige', 'drapp': 'Beige',
    // White
    'bela': 'White', 'white': 'White', 'bijela': 'White',
    'bílá': 'White', 'biały': 'White', 'biała': 'White', 'białe': 'White',
    'λευκό': 'White', 'λευκά': 'White', 'lefko': 'White', 'lefka': 'White',
    'biela': 'White', 'bianco': 'White', 'bianca': 'White', 'bianchi': 'White', 'bianche': 'White',
    'fehér': 'White',
    'bijele': 'White', 'bijeli': 'White', 'bílé': 'White', 'białych': 'White', 'bianche': 'White',
    // Red
    'rdeča': 'Red', 'red': 'Red', 'crvena': 'Red', 'rdeca': 'Red',
    'červená': 'Red', 'czerwony': 'Red', 'czerwona': 'Red',
    'κόκκινο': 'Red', 'kokkino': 'Red',
    'červená': 'Red', 'rosso': 'Red', 'rossa': 'Red',
    'piros': 'Red',
    'crvene': 'Red', 'crveni': 'Red', 'crvenih': 'Red', 'czerwonych': 'Red',
};

// Parse color from text
function parseColor(text) {
    const lower = (text || '').toLowerCase();
    for (const [key, value] of Object.entries(COLOR_MAP)) {
        if (lower.includes(key)) return value;
    }
    return null;
}

// Parse size from text
function parseSize(text) {
    const upper = (text || '').toUpperCase();
    
    // First try: Match size at end of string (for bundle format "Color - Size")
    // This prevents matching "L" inside words like "Bílá"
    const endMatch = upper.match(/[\s\-]\s*(4XL|3XL|2XL|XL|XS|L|M|S)\s*$/);
    if (endMatch) return endMatch[1];
    
    // Clothing sizes - fallback for product names
    const match = upper.match(/\b(4XL|3XL|2XL|XL|XS|L|M|S)\b/);
    if (match) return match[1];
    
    // Sock sizes - normalize to "/" format (matches inventory SKUs)
    const sockMatch = upper.match(/(43-46|39-42|43\/46|39\/42)/);
    if (sockMatch) return sockMatch[1].replace('-', '/');
    return null;
}

// Parse product type from name - ALL languages
function parseType(name) {
    const lower = (name || '').toLowerCase();
    
    // FIRST: Check for bundles/sets (must be before individual product types!)
    if (lower.includes('σετ:') || lower.includes('set:')) return 'Bundle';
    if (lower.includes('+') && (lower.includes('μπλουζ') || lower.includes('μπόξερ') || lower.includes('majic') || lower.includes('boks'))) return 'Bundle';
    
    // T-Shirts
    if (lower.includes('majic') || lower.includes('shirt') || lower.includes('tee')) return 'T-Shirt';
    if (lower.includes('starter') || lower.includes('štartovac') || lower.includes('startovac')) return 'T-Shirt'; // starter packs
    if (lower.includes('σετ εκκίνησης') || lower.includes('set ekkinisis')) return 'T-Shirt'; // GR starter
    if (lower.includes('tričk') || lower.includes('koszulk')) return 'T-Shirt'; // CZ/PL
    if (lower.includes('μπλουζ') || lower.includes('mplouz')) return 'T-Shirt'; // GR
    if (lower.includes('magliet') || lower.includes('póló')) return 'T-Shirt'; // IT/HU
    // Boxers
    if (lower.includes('boks') || lower.includes('boxer') || lower.includes('gatk')) return 'Boxers';
    if (lower.includes('airflow') || lower.includes('modal')) return 'Boxers';
    if (lower.includes('μπόξερ') || lower.includes('mpoxer')) return 'Boxers'; // GR
    if (lower.includes('αστικό μιξ') || lower.includes('astiko mix')) return 'Boxers'; // GR urban mix
    // NOTE: pobřežní (coastal) is T-SHIRTS in CZ, not boxers!
    if (lower.includes('boxer') || lower.includes('alsónad')) return 'Boxers'; // IT/HU
    // HR boxer packs
    if (lower.includes('tamni') && lower.includes('paket')) return 'Boxers'; // HR dark pack
    if (lower.includes('gradski') || lower.includes('urban')) return 'Boxers'; // HR/EN urban mix
    if (lower.includes('komplet') && (lower.includes('bokseric') || lower.includes('crnih'))) return 'Boxers'; // HR boxer set
    if (lower.includes('svakodnevni')) return 'Boxers'; // HR everyday pack
    if (lower.includes('zemljani')) return 'Boxers'; // HR earth tones
    if (lower.includes('obalni')) return 'Boxers'; // HR coastal
    if (lower.includes('puni basic')) return 'Boxers'; // HR full basic pack
    // CZ boxer packs
    if (lower.includes('poskladajte') || lower.includes('balík') || lower.includes('balení')) return 'Boxers'; // CZ make your own / pack
    // Socks
    if (lower.includes('nogav') || lower.includes('sock') || lower.includes('čarap')) return 'Socks';
    if (lower.includes('ponožk') || lower.includes('skarpet')) return 'Socks'; // CZ/PL
    if (lower.includes('κάλτσ') || lower.includes('kalts')) return 'Socks'; // GR
    if (lower.includes('calzin') || lower.includes('zokni')) return 'Socks'; // IT/HU
    return null;
}

// Parse meta value like "Majica 1: Crna - 2XL" or "Plava - 4XL"
function parseMetaItem(value, defaultType) {
    const color = parseColor(value);
    const size = parseSize(value);
    if (!color || !size) return null;
    
    // Detect type from meta - all languages
    const lower = value.toLowerCase();
    let type = defaultType;
    // T-Shirt patterns
    if (lower.includes('majic') || lower.includes('tričk') || lower.includes('μπλουζ') || lower.includes('shirt') || lower.includes('póló')) {
        type = 'T-Shirt';
    }
    // Boxers patterns
    else if (lower.includes('boks') || lower.includes('boxer') || lower.includes('gatk') || 
             lower.includes('μπόξερ') || lower.includes('mpoxer') || lower.includes('alsónad')) {
        type = 'Boxers';
    }
    
    return { type, color, size };
}

// Extract pack count from name
// HR: 5-paket, 7-paket, (10 pari), 3+1 Gratis, 5+3 Gratis
// GR: συσκευασία 3 τεμ, (5 ζευγάρια)
// CZ: balení 3 ks, 3-balík
// IT: confezione da 3
function extractPackCount(name) {
    // First check for "X+Y Gratis" format (e.g., "3+1 Gratis" = 4, "5+3 Gratis" = 8)
    const gratisMatch = (name || '').match(/(\d+)\s*\+\s*(\d+)\s*gratis/i);
    if (gratisMatch) {
        return parseInt(gratisMatch[1]) + parseInt(gratisMatch[2]);
    }
    
    // Check for sock pairs: "10 párů", "(10 pár)", "(10 pairs)"
    // RULE: 1 kos = 5 pairs, so 10 pairs = 2 kosi
    const pairMatch = (name || '').match(/\((\d+)\s*pár|\((\d+)\s*pair|(\d+)\s*párů/i);
    if (pairMatch) {
        const pairs = parseInt(pairMatch[1] || pairMatch[2] || pairMatch[3]) || 1;
        return Math.ceil(pairs / 5);  // Convert pairs to pieces (1 piece = 5 pairs)
    }
    
    // Standard pack formats
    // CZ: balíček (3-balíček), balík (3-balík), balení 3
    const match = (name || '').match(/(\d+)-?pak|(\d+)-?balíček|(\d+)-?balík|συσκευασία\s*(\d+)|\((\d+)\s*ζευγ|\((\d+)\s*par|balení\s*(\d+)|confezione\s*da\s*(\d+)/i);
    if (match) {
        return parseInt(match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || match[7] || match[8]) || 1;
    }
    return 1;
}

// WooCommerce API request
function wcRequest(store, endpoint) {
    return new Promise((resolve, reject) => {
        const url = `${store.url}/wp-json/wc/v3/${endpoint}`;
        const auth = Buffer.from(`${store.ck}:${store.cs}`).toString('base64');
        
        https.get(url, { 
            headers: { 'Authorization': `Basic ${auth}` },
            timeout: 30000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse: ${data.substring(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

// ============================================================
// SKU-based pack color compositions (from WooCommerce product descriptions)
// Each entry: SKU prefix → array of { type, color, count }
// Size comes from order metadata, not hardcoded here
// ============================================================
const PACK_COLORS = {
    // === BOXER PACKS ===
    // Ponoćni mix / Midnight mix
    'NORIKS-BOX-BUNDLE-3-THIRD':   [{ t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Blue', n: 2 }],
    'NORIKS-BOX-BUNDLE-5-FIRST':   [{ t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Blue', n: 3 }],
    'NORIKS-BOX-BUNDLE-7-SECOND':  [{ t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 3 }],
    // Urbano-zemljani / Urban-earthy
    'NORIKS-BOX-BUNDLE-3-SECOND':  [{ t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }],
    'NORIKS-BOX-BUNDLE-5-SECOND':  [{ t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Green', n: 1 }],
    'NORIKS-BOX-BUNDLE-7-FIRST':   [{ t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Grey', n: 1 }],
    // Monokromni / Monochrome (boxers)
    'NORIKS-BOX-BUNDLE-3-FIRST':   [{ t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }],
    // Miješani / Mixed
    'NORIKS-BOX-BLACK-7-PACK-2':   [{ t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 3 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BOX-BUNDLE-15-FIRST':  [{ t: 'Boxers', c: 'Black', n: 5 }, { t: 'Boxers', c: 'Blue', n: 3 }, { t: 'Boxers', c: 'Green', n: 3 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Red', n: 2 }],
    // Tamni / Dark
    'NORIKS-BOX-BLACK-7-PACK-3':   [{ t: 'Boxers', c: 'Black', n: 5 }, { t: 'Boxers', c: 'Blue', n: 5 }],
    'NORIKS-BOX-BUNDLE-15-SECOND': [{ t: 'Boxers', c: 'Black', n: 10 }, { t: 'Boxers', c: 'Blue', n: 5 }],
    // Crne bokserice / All-black boxers
    'NORIKS-BOX-BLACK-3-PACK':     [{ t: 'Boxers', c: 'Black', n: 3 }],
    'NORIKS-BOX-BLACK-5-PACK':     [{ t: 'Boxers', c: 'Black', n: 5 }],
    'NORIKS-BOX-BLACK-7-PACK':     [{ t: 'Boxers', c: 'Black', n: 7 }],
    'NORIKS-BOX-BLACK-10-PACK':    [{ t: 'Boxers', c: 'Black', n: 10 }],
    'NORIKS-BOX-BLACK-15-PACK':    [{ t: 'Boxers', c: 'Black', n: 15 }],

    // === T-SHIRT PACKS ===
    // Neutralni mix (neutral = Black + Grey + Beige)
    'NORIKS-NEUTRAL-MIX-9-PACK':   [{ t: 'Boxers', c: 'Black', n: 3 }, { t: 'Boxers', c: 'Grey', n: 3 }, { t: 'Boxers', c: 'Blue', n: 3 }],
    // Monokromni / Monochrome T-shirts (Black + Grey + White)
    'NORIKS-MONOCHROME-3-PACK':    [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }],
    'NORIKS-MONOCHROME-6-PACK':    [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Grey', n: 2 }, { t: 'T-Shirt', c: 'White', n: 2 }],
    'NORIKS-MONOCHROME-9-PACK':    [{ t: 'T-Shirt', c: 'Black', n: 3 }, { t: 'T-Shirt', c: 'Grey', n: 3 }, { t: 'T-Shirt', c: 'White', n: 3 }],
    // Ponoćni Mix T-shirts (Midnight = Black + Blue)
    'NORIKS-MIDNIGHT-3-PACK':      [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Blue', n: 1 }],
    // Urbano-Zemljani T-shirts (Urban = Black + Green + Brown/Beige)
    'NORIKS-URBAN-3-PACK':         [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Green', n: 1 }, { t: 'T-Shirt', c: 'Beige', n: 1 }],
    // Gradski mix T-shirts (City = Black + Grey + Blue + White + Green + Beige)
    'NORIKS-CITY-COMBO-6-PACK':    [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'T-Shirt', c: 'Blue', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }, { t: 'T-Shirt', c: 'Green', n: 1 }, { t: 'T-Shirt', c: 'Beige', n: 1 }],
    // Svakodnevni / Everyday T-shirts (everyday basics)
    'NORIKS-EVERYDAY-6-PACK':      [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Grey', n: 2 }, { t: 'T-Shirt', c: 'White', n: 2 }],
    'NORIKS-EVERYDAY-MIX-12-PACK': [{ t: 'T-Shirt', c: 'Black', n: 3 }, { t: 'T-Shirt', c: 'Grey', n: 3 }, { t: 'T-Shirt', c: 'White', n: 3 }, { t: 'T-Shirt', c: 'Blue', n: 3 }],
    // Pobřežní / Coastal / Nadbrzeżny T-shirts (Blue + Green + Beige)
    'NORIKS-COASTAL-3-PACK':       [{ t: 'T-Shirt', c: 'Blue', n: 1 }, { t: 'T-Shirt', c: 'Green', n: 1 }, { t: 'T-Shirt', c: 'Beige', n: 1 }],
    // All-white / All-black T-shirt packs
    'NORIKS-ALL-WHITE-3-PACK':     [{ t: 'T-Shirt', c: 'White', n: 3 }],
    'NORIKS-ALL-BLACK-3-PACK':     [{ t: 'T-Shirt', c: 'Black', n: 3 }],

    // === KOMPLET (T-shirts + Boxers combos) ===
    // Komplet: 2 majice + 5 bokserica
    'NORIKS-BUNDLE-SHIRTS-BOX-P-1': [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SHIRTS-BOX-P-2': [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SHIRTS-BOX-P-3': [{ t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SHIRTS-BOX-P-4': [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    // Komplet: 5 majica + 5 bokserica
    'NORIKS-BUNDLE-SH-BOX-5-5-P-1': [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Grey', n: 2 }, { t: 'T-Shirt', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SH-BOX-5-5-P-2': [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'White', n: 2 }, { t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SH-BOX-5-5-P-3': [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Brown', n: 1 }, { t: 'T-Shirt', c: 'Beige', n: 1 }, { t: 'T-Shirt', c: 'Green', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }, { t: 'Boxers', c: 'Black', n: 1 }, { t: 'Boxers', c: 'Grey', n: 1 }, { t: 'Boxers', c: 'Blue', n: 1 }, { t: 'Boxers', c: 'Green', n: 1 }, { t: 'Boxers', c: 'Red', n: 1 }],
    'NORIKS-BUNDLE-SH-BOX-5-5-P-4': [{ t: 'T-Shirt', c: 'Black', n: 5 }, { t: 'Boxers', c: 'Black', n: 5 }],
    // Komplet: 4 majice + 10 bokserica
    'NORIKS-BUNDLE-SH-BOX-4-10-P-1': [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'White', n: 2 }, { t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Red', n: 2 }],
    'NORIKS-BUNDLE-SH-BOX-4-10-P-2': [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Red', n: 2 }],
    'NORIKS-BUNDLE-SH-BOX-4-10-P-3': [{ t: 'T-Shirt', c: 'Black', n: 2 }, { t: 'T-Shirt', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Red', n: 2 }],
    'NORIKS-BUNDLE-SH-BOX-4-10-P-4': [{ t: 'T-Shirt', c: 'Black', n: 1 }, { t: 'T-Shirt', c: 'Grey', n: 1 }, { t: 'T-Shirt', c: 'Blue', n: 1 }, { t: 'T-Shirt', c: 'White', n: 1 }, { t: 'Boxers', c: 'Black', n: 2 }, { t: 'Boxers', c: 'Grey', n: 2 }, { t: 'Boxers', c: 'Blue', n: 2 }, { t: 'Boxers', c: 'Green', n: 2 }, { t: 'Boxers', c: 'Red', n: 2 }],
};

// Look up SKU prefix in PACK_COLORS map (strips size suffix like -XL, -2XL, -L-XL, etc.)
function lookupPackColors(sku) {
    if (!sku) return null;
    const upper = sku.toUpperCase();
    // Try exact match first
    if (PACK_COLORS[upper]) return PACK_COLORS[upper];
    // Strip size suffixes: -XL, -2XL, -3XL, -4XL, -S, -M, -L, -XL-XL, -2XL-2XL
    const stripped = upper
        .replace(/-(4XL|3XL|2XL|XL|L|M|S)(?:-(4XL|3XL|2XL|XL|L|M|S))?$/, '');
    if (PACK_COLORS[stripped]) return PACK_COLORS[stripped];
    // Try progressively shorter prefixes (for -P-3-XL-XL style)
    const parts = upper.split('-');
    for (let i = parts.length - 1; i >= 3; i--) {
        const prefix = parts.slice(0, i).join('-');
        if (PACK_COLORS[prefix]) return PACK_COLORS[prefix];
    }
    return null;
}

// Process a single line item using detectProduct (shared SOURCE OF TRUTH)
// Returns array of { type, color, size, count } for detailed breakdown
// CRITICAL: total count MUST match detectProduct's tshirts+boxers+socks * qty
// RULE: "Mixed" color is NEVER allowed in output
function processLineItem(item) {
    const results = [];
    const name = item.name || '';
    const qty = item.quantity || 1;
    const metadata = item.meta_data || [];
    const sku = item.sku || '';
    
    // Use detectProduct (SOURCE OF TRUTH) to get piece counts
    const detected = detectProduct(name, true, metadata, sku);
    const totalPieces = (detected.tshirts + detected.boxers + (detected.socks || 0)) * qty;
    
    if (totalPieces === 0) return results;
    
    // === STRATEGY 1: Individual bundle meta items (ORTO products) ===
    // These have numbered keys like "1": "Crna - XL", "2": "Bijela - XL"
    const bundleMetaItems = metadata.filter(m => {
        if (!m.key || !m.value) return false;
        if (m.key.startsWith('_')) return false;
        const keyLower = (m.key || '').toLowerCase();
        if (keyLower === 'velicina' || keyLower === 'velikost' || keyLower === 'size' || keyLower === 'méret' || keyLower === 'taglia' || keyLower === 'megethos') return false;
        // Also skip size-specific meta keys
        if (keyLower.includes('velicina') || keyLower.includes('velikost')) return false;
        const val = (m.value || '').toString();
        const hasColorAndSize = (val.includes('-') || val.includes(':')) && 
            val.match(/[A-Z0-9]{1,3}XL|[SMLX]\b/i);
        return hasColorAndSize;
    });
    
    if (bundleMetaItems.length > 0) {
        let detailedCount = 0;
        for (const meta of bundleMetaItems) {
            const parsed = parseMetaItem(meta.value, null);
            if (parsed) {
                let type = parsed.type;
                if (!type) {
                    const val = (meta.value || '').toString().toLowerCase();
                    const key = (meta.key || '').toLowerCase();
                    const isShirt = val.includes('majic') || val.includes('shirt') || val.includes('tričk') || val.includes('triko') || val.includes('tricka') ||
                                   val.includes('μπλουζάκ') || val.includes('μπλούζ') || val.includes('magliett') || val.includes('póló') ||
                                   key.includes('majic') || key.includes('shirt') || key.includes('tričk') || key.includes('tricka') || key.includes('mployz');
                    const isBoxer = val.includes('bokser') || val.includes('boxer') || val.includes('trenýr') || val.includes('trenk') || val.includes('boxerky') ||
                                   val.includes('μπόξερ') || val.includes('εσώρουχ') || val.includes('gatk') ||
                                   key.includes('bokser') || key.includes('boxer') || key.includes('mpoxer') || key.includes('boxerky');
                    if (isShirt) type = 'T-Shirt';
                    else if (isBoxer) type = 'Boxers';
                    else if (detected.tshirts > 0 && detected.boxers === 0) type = 'T-Shirt';
                    else if (detected.boxers > 0 && detected.tshirts === 0) type = 'Boxers';
                    else type = 'T-Shirt';
                }
                results.push({ type, color: parsed.color, size: parsed.size, count: qty });
                detailedCount += qty;
            }
        }
        if (detailedCount >= totalPieces) return results;
        // Remaining pieces: try SKU map or default to Black
        const remaining = totalPieces - detailedCount;
        const size = getSizeFromMeta(metadata) || parseSize(name) || 'Unknown';
        if (detected.tshirts > 0) {
            const tRemain = detected.tshirts * qty - results.filter(r => r.type === 'T-Shirt').reduce((s, r) => s + r.count, 0);
            if (tRemain > 0) results.push({ type: 'T-Shirt', color: 'Black', size, count: tRemain });
        }
        if (detected.boxers > 0) {
            const bRemain = detected.boxers * qty - results.filter(r => r.type === 'Boxers').reduce((s, r) => s + r.count, 0);
            if (bRemain > 0) results.push({ type: 'Boxers', color: 'Black', size, count: bRemain });
        }
        return results;
    }
    
    // === STRATEGY 2: SKU-based pack color lookup ===
    const packColors = lookupPackColors(sku);
    if (packColors) {
        // Get size(s) from metadata
        let defaultSize = getSizeFromMeta(metadata) || parseSize(name) || 'Unknown';
        // For Komplet products, get separate shirt/boxer sizes
        let shirtSize = defaultSize, boxerSize = defaultSize;
        for (const meta of metadata) {
            const key = (meta.key || '').toLowerCase();
            if (key.includes('majic') || key.includes('shirt') || key.includes('mployz')) shirtSize = meta.value;
            else if (key.includes('bokseric') || key.includes('boxer') || key.includes('mpoxer')) boxerSize = meta.value;
        }
        // Calculate SKU map total and scale to match detectProduct if needed
        const skuTotal = packColors.reduce((s, e) => s + e.n, 0);
        const scale = skuTotal === totalPieces ? 1 : totalPieces / skuTotal;
        for (const entry of packColors) {
            const sz = entry.t === 'T-Shirt' ? shirtSize : entry.t === 'Boxers' ? boxerSize : defaultSize;
            const count = scale === 1 ? entry.n * qty : Math.round(entry.n * scale * qty);
            results.push({ type: entry.t, color: entry.c, size: sz, count });
        }
        return results;
    }
    
    // === STRATEGY 3: Parse color from product name ===
    const color = parseColor(name);
    let size = getSizeFromMeta(metadata) || parseSize(name) || 'Unknown';
    
    // Pobřežní / Coastal / Nadbrzeżny T-shirt packs
    const lower = name.toLowerCase();
    if ((lower.includes('pobřežní') || lower.includes('coastal') || lower.includes('nadbrzeżny')) && detected.tshirts > 0) {
        ['Blue', 'Green', 'Beige'].forEach(c => results.push({ type: 'T-Shirt', color: c, size, count: qty }));
        return results;
    }
    
    // For mixed bundles (tshirts + boxers from name pattern), get sizes per type
    if (detected.tshirts > 0 && detected.boxers > 0) {
        let shirtSize = size, boxerSize = size;
        for (const meta of metadata) {
            const key = (meta.key || '').toLowerCase();
            if (key.includes('mployzakia') || key.includes('shirt') || key.includes('majic')) shirtSize = meta.value;
            else if (key.includes('mpoxer') || key.includes('boxer') || key.includes('boks')) boxerSize = meta.value;
            else if (key === 'megethos' || key === 'velicina' || key === 'velikost' || key === 'size' || key === 'méret' || key === 'taglia') {
                if (shirtSize === size) shirtSize = meta.value;
                if (boxerSize === size) boxerSize = meta.value;
            }
        }
        // Default to Black for combos without color info
        results.push({ type: 'T-Shirt', color: color || 'Black', size: shirtSize, count: detected.tshirts * qty });
        results.push({ type: 'Boxers', color: color || 'Black', size: boxerSize, count: detected.boxers * qty });
        return results;
    }
    
    // Simple products: all tshirts, all boxers, or all socks
    // RULE: never output "Mixed" — default to Black if no color detected
    const finalColor = color || 'Black';
    if (detected.tshirts > 0) results.push({ type: 'T-Shirt', color: finalColor, size, count: detected.tshirts * qty });
    if (detected.boxers > 0) results.push({ type: 'Boxers', color: finalColor, size, count: detected.boxers * qty });
    if (detected.socks > 0) results.push({ type: 'Socks', color: finalColor, size, count: detected.socks * qty });
    
    return results;
}

// Helper: get size from metadata
function getSizeFromMeta(metadata) {
    for (const meta of metadata || []) {
        const key = (meta.key || '').toLowerCase();
        const displayKey = (meta.display_key || '').toLowerCase();
        if (key === 'velicina' || key === 'velikost' || key === 'size' || key === 'méret' || key === 'megethos' || key === 'taglia' ||
            displayKey.includes('velič') || displayKey.includes('velikost') || displayKey.includes('size') ||
            displayKey.includes('μέγεθος') || displayKey.includes('méret') || displayKey.includes('taglia')) {
            return meta.value;
        }
    }
    return null;
}

async function fetchSales() {
    // Load inventory to get startDate - NEVER reset once set!
    let startDate = null;
    if (fs.existsSync(INVENTORY_PATH)) {
        const inv = JSON.parse(fs.readFileSync(INVENTORY_PATH));
        startDate = inv.startDate;
    }
    
    // If no startDate exists, this is first run - set to yesterday (day 0)
    if (!startDate) {
        startDate = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
        console.log(`⚠️ First run - setting day 0 to: ${startDate}`);
    }
    
    // Calculate date ranges
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    
    // Calculate additional date ranges for purchasing trends
    const day3Ago = new Date(Date.now() - 3*24*60*60*1000).toISOString().split('T')[0];
    const day14Ago = new Date(Date.now() - 14*24*60*60*1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const yearAgo = new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
    const yearStart = new Date().getFullYear() + '-01-01'; // Start of current year (2026-01-01)
    
    console.log(`Fetching sales...`);
    console.log(`  Day 0 (start): ${startDate}`);
    console.log(`  Today: ${today}`);
    console.log(`  Yesterday: ${yesterday}`);
    console.log(`  3 days ago: ${day3Ago}`);
    console.log(`  Week ago: ${weekAgo}`);
    console.log(`  14 days ago: ${day14Ago}`);
    console.log(`  Month ago: ${monthAgo}`);
    console.log(`  Year start: ${yearStart}`);
    
    // Track sales by period
    const salesMap = {};  // type|color|size -> { total, today, yesterday, day3, week, day14, month, ytd }
    let totalItems = 0;
    let totalOrders = 0;
    let todayItems = 0;
    let yesterdayItems = 0;
    let day3Items = 0;
    let weekItems = 0;
    let day14Items = 0;
    let monthItems = 0;
    let ytdItems = 0; // Year-to-date (since Jan 1, 2026)
    
    // Track orders by period
    let todayOrders = 0;
    let yesterdayOrders = 0;
    let day3Orders = 0;
    let weekOrders = 0;
    let day14Orders = 0;
    let monthOrders = 0;
    let ytdOrders = 0;
    
    // Fetch from 1 year ago to get full historical data for purchasing trends
    const fetchFromDate = yearAgo;
    
    for (const store of STORES) {
        console.log(`\nFetching from ${store.name}...`);
        
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
            try {
                const orders = await wcRequest(store, 
                    `orders?status=processing,completed&per_page=100&page=${page}&after=${fetchFromDate}T00:00:00`
                );
                
                if (!orders || orders.length === 0 || orders.code) {
                    hasMore = false;
                    continue;
                }
                
                for (const order of orders) {
                    const orderDate = order.date_created?.split('T')[0];
                    if (orderDate < fetchFromDate) continue;
                    
                    // Only count in totalOrders if from startDate
                    if (orderDate >= startDate) totalOrders++;
                    
                    // Count orders by period
                    if (orderDate === today) todayOrders++;
                    if (orderDate === yesterday) yesterdayOrders++;
                    if (orderDate >= day3Ago) day3Orders++;
                    if (orderDate >= weekAgo) weekOrders++;
                    if (orderDate >= day14Ago) day14Orders++;
                    if (orderDate >= monthAgo) monthOrders++;
                    if (orderDate >= yearStart) ytdOrders++;
                    
                    for (const item of order.line_items || []) {
                        const parsed = processLineItem(item);
                        
                        if (parsed.length === 0) {
                            const type = parseType(item.name);
                            const color = parseColor(item.name);
                            const size = parseSize(item.name);
                            const pack = extractPackCount(item.name);
                            console.log(`  ⚠️  Could not parse: ${item.name}`);
                            console.log(`      DEBUG: type=${type}, color=${color}, size=${size}, pack=${pack}`);
                        }
                        
                        for (const p of parsed) {
                            const key = `${p.type}|${p.color}|${p.size}`;
                            
                            // Initialize if needed
                            if (!salesMap[key]) {
                                salesMap[key] = { total: 0, today: 0, yesterday: 0, day3: 0, week: 0, day14: 0, month: 0, ytd: 0 };
                            }
                            
                            // Add to appropriate period
                            if (orderDate >= startDate) {
                                salesMap[key].total += p.count;
                                totalItems += p.count;
                            }
                            if (orderDate === today) {
                                salesMap[key].today += p.count;
                                todayItems += p.count;
                            }
                            if (orderDate === yesterday) {
                                salesMap[key].yesterday += p.count;
                                yesterdayItems += p.count;
                            }
                            if (orderDate >= day3Ago) {
                                salesMap[key].day3 += p.count;
                                day3Items += p.count;
                            }
                            if (orderDate >= weekAgo) {
                                salesMap[key].week += p.count;
                                weekItems += p.count;
                            }
                            if (orderDate >= day14Ago) {
                                salesMap[key].day14 += p.count;
                                day14Items += p.count;
                            }
                            if (orderDate >= monthAgo) {
                                salesMap[key].month += p.count;
                                monthItems += p.count;
                            }
                            if (orderDate >= yearStart) {
                                salesMap[key].ytd += p.count;
                                ytdItems += p.count;
                            }
                        }
                    }
                }
                
                console.log(`  Page ${page}: ${orders.length} orders`);
                page++;
                
                if (orders.length < 100) hasMore = false;
                
            } catch (err) {
                console.error(`  Error on page ${page}:`, err.message);
                hasMore = false;
            }
        }
    }
    
    // Build detailed array with period breakdown
    // Split Mixed socks into Black/White, filter out other Mixed items
    const detailedRaw = Object.entries(salesMap).map(([key, data]) => {
        const [type, color, size] = key.split('|');
        return { 
            type, 
            color, 
            size, 
            count: data.total,       // Total since day 0
            today: data.today,       // Today only
            yesterday: data.yesterday, // Yesterday only
            day3: data.day3,         // Last 3 days
            week: data.week,         // Last 7 days
            day14: data.day14,       // Last 14 days
            month: data.month,       // Last 30 days
            ytd: data.ytd            // Year-to-date (since Jan 1, 2026)
        };
    });
    
    // Process: split Mixed socks into Black/White, exclude other Mixed items
    const detailed = [];
    for (const item of detailedRaw) {
        if (item.color === 'Mixed' && item.type === 'Socks') {
            // Split socks 50/50 into Black and White
            const half = (val) => Math.ceil(val / 2);
            detailed.push({
                ...item,
                color: 'Black',
                count: half(item.count),
                today: half(item.today),
                yesterday: half(item.yesterday),
                day3: half(item.day3),
                week: half(item.week),
                day14: half(item.day14),
                month: half(item.month),
                ytd: half(item.ytd)
            });
            detailed.push({
                ...item,
                color: 'White',
                count: item.count - half(item.count),
                today: item.today - half(item.today),
                yesterday: item.yesterday - half(item.yesterday),
                day3: item.day3 - half(item.day3),
                week: item.week - half(item.week),
                day14: item.day14 - half(item.day14),
                month: item.month - half(item.month),
                ytd: item.ytd - half(item.ytd)
            });
        } else if (item.color === 'Mixed') {
            // Safety net: convert any remaining Mixed to Black (should not happen)
            console.log(`  ⚠️ Safety: converting Mixed ${item.type} ${item.size} to Black`);
            detailed.push({ ...item, color: 'Black' });
        } else {
            detailed.push(item);
        }
    }
    
    // Aggregate duplicates (same type/color/size)
    // Normalize sock sizes: 43-46 -> 43/46, 39-42 -> 39/42
    const normalizeSize = (size) => {
        if (size === '43-46') return '43/46';
        if (size === '39-42') return '39/42';
        return size;
    };
    
    const aggregated = {};
    for (const item of detailed) {
        const normalizedSize = normalizeSize(item.size);
        item.size = normalizedSize;  // Update the item's size
        const key = `${item.type}|${item.color}|${normalizedSize}`;
        if (!aggregated[key]) {
            aggregated[key] = { ...item };
        } else {
            aggregated[key].count += item.count;
            aggregated[key].today += item.today;
            aggregated[key].yesterday += item.yesterday;
            aggregated[key].day3 += item.day3;
            aggregated[key].week += item.week;
            aggregated[key].day14 += item.day14;
            aggregated[key].month += item.month;
            aggregated[key].ytd += item.ytd;
        }
    }
    const detailedFinal = Object.values(aggregated).sort((a, b) => b.count - a.count);
    
    // Calculate days since start
    const now = new Date();
    const start = new Date(startDate);
    const daysSinceStart = Math.max(1, Math.floor((now - start) / (1000 * 60 * 60 * 24)) + 1);
    
    // Build summary
    const summary = {
        byProduct: {},
        bySize: {},
        byColor: {}
    };
    
    detailedFinal.forEach(item => {
        summary.byProduct[item.type] = (summary.byProduct[item.type] || 0) + item.count;
        summary.bySize[item.size] = (summary.bySize[item.size] || 0) + item.count;
        summary.byColor[item.color] = (summary.byColor[item.color] || 0) + item.count;
    });
    
    const output = {
        generated: new Date().toISOString(),
        startDate,
        today,
        yesterday,
        day3Ago,
        weekAgo,
        day14Ago,
        monthAgo,
        yearStart,
        daysSinceStart,
        daysSinceYearStart: Math.max(1, Math.floor((new Date() - new Date(yearStart)) / (1000 * 60 * 60 * 24)) + 1),
        totalItems,
        totalOrders,
        todayItems,
        yesterdayItems,
        day3Items,
        weekItems,
        day14Items,
        monthItems,
        ytdItems,
        // Order counts by period
        todayOrders,
        yesterdayOrders,
        day3Orders,
        weekOrders,
        day14Orders,
        monthOrders,
        ytdOrders,
        summary,
        detailed: detailedFinal
    };
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    
    console.log(`\n✅ Sales data saved`);
    console.log(`   Start date (day 0): ${startDate}`);
    console.log(`   Days tracking: ${daysSinceStart}`);
    console.log(`   Total orders: ${totalOrders}`);
    console.log(`   Total items (since day 0): ${totalItems}`);
    console.log(`   Today: ${todayItems} items`);
    console.log(`   Yesterday: ${yesterdayItems} items`);
    console.log(`   Last 7 days: ${weekItems} items`);
    
    if (detailedFinal.length > 0) {
        console.log('\nTop 5 sellers (since day 0):');
        detailedFinal.slice(0, 5).forEach(d => {
            console.log(`   ${d.type} ${d.color} ${d.size}: ${d.count} (today: ${d.today}, 7d: ${d.week})`);
        });
    }
    
    // AUTO-UPDATE INVENTORY: 
    // Current stock = Initial (day 0) - sales + arrived incoming
    try {
        const initialInventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
        const ARRIVALS_PATH = path.join(__dirname, 'stock-arrivals.json');
        let arrivals = { arrivals: [] };
        try {
            arrivals = JSON.parse(fs.readFileSync(ARRIVALS_PATH, 'utf8'));
        } catch (e) {}
        
        // Store original values if not already stored (first run)
        if (!initialInventory.initialValues) {
            initialInventory.initialValues = {};
            for (const inv of initialInventory.inventory) {
                initialInventory.initialValues[inv.sku] = inv.stock;
            }
            console.log('\n📦 Saved initial inventory values (day 0 baseline)');
        }
        
        // NOTE: Google Sheet "trenutna zaloga" already includes received incoming stock.
        // The "incoming" sheets are just records. Do NOT add arrivals to initialValues.
        
        let updatedCount = 0;
        for (const inv of initialInventory.inventory) {
            // Use !== undefined to handle 0 correctly (0 is a valid initial value!)
            const initial = initialInventory.initialValues[inv.sku] !== undefined 
                ? initialInventory.initialValues[inv.sku] 
                : inv.stock;
            
            // Find matching sales
            const sale = detailedFinal.find(s => 
                s.type === inv.type && 
                s.color === inv.color && 
                s.size === inv.size
            );
            
            // Total sold since day 0 (count = cumulative since startDate)
            const soldSinceDay0 = sale ? sale.count : 0;
            const newStock = Math.max(0, initial - soldSinceDay0);
            
            if (inv.stock !== newStock) {
                inv.stock = newStock;
                updatedCount++;
            }
        }
        
        initialInventory.generated = new Date().toISOString();
        initialInventory.calculatedFrom = 'initial values - sales + arrived incoming';
        initialInventory.totalStock = initialInventory.inventory.reduce((sum, i) => sum + i.stock, 0);
        
        // CRITICAL: Ensure startDate is NEVER changed
        if (!initialInventory.startDate) {
            initialInventory.startDate = startDate;
        }
        
        fs.writeFileSync(INVENTORY_PATH, JSON.stringify(initialInventory, null, 2));
        
        if (updatedCount > 0) {
            console.log(`\n📦 Inventory updated: ${updatedCount} items recalculated`);
        }
    } catch (e) {
        console.log('\n⚠️ Could not update inventory:', e.message);
    }
    
    return output;
}

if (require.main === module) {
    fetchSales()
        .then(() => console.log('\nDone!'))
        .catch(err => {
            console.error('Error:', err.message);
            process.exit(1);
        });
}

module.exports = { fetchSales };

/**
 * Shared product detection logic - SOURCE OF TRUTH
 * Used by both server.js (dashboard) and fetch-sales.js (stock report)
 * 
 * detectProduct(name, metadata, sku) → { tshirts, boxers, socks }
 */

const fs = require('fs');
const path = require('path');

const SKU_OVERRIDES_FILE = path.join(__dirname, 'sku-overrides.json');

let skuOverrides = {};

function loadSkuOverrides() {
    try {
        if (fs.existsSync(SKU_OVERRIDES_FILE)) {
            skuOverrides = JSON.parse(fs.readFileSync(SKU_OVERRIDES_FILE, 'utf8'));
        }
    } catch (e) { /* no overrides */ }
}

// Load on require
loadSkuOverrides();

/**
 * Detect product contents from name, SKU and metadata
 * Returns { tshirts, boxers, socks }
 * Priority: 1) Manual override, 2) Bundle meta items, 3) Product name patterns
 */
function detectProduct(name, useOverride = true, metadata = null, sku = null) {
    if (useOverride && skuOverrides[name]) {
        const o = skuOverrides[name];
        if (o.type !== undefined) {
            return { tshirts: o.type === 'tshirt' ? o.qty : 0, boxers: o.type === 'boxers' ? o.qty : 0, override: true, socks: 0 };
        }
        return { ...o, override: true };
    }
    
    const lower = (name || '').toLowerCase();
    // === SKU-BASED DETECTION (highest priority after manual overrides) ===
    // Resolves ambiguous names like 'Monokromni 3-Paket' which can be tshirts OR boxers
    const skuUp = (sku || '').toUpperCase();
    if (skuUp) {
        // Extract pack count from product name
        const packNumMatch = lower.match(/(\d+)[-\s]?pake?t/i) || lower.match(/(\d+)[-\s]?pakie?t/i) || 
                             lower.match(/(\d+)[-\s]?balí[čk]/i) || lower.match(/(\d+)\s*ks/i) ||
                             lower.match(/συσκευασία\s*(\d+)/i) || lower.match(/(\d+)\s*τεμ/i) ||
                             lower.match(/pacco\s*da\s*(\d+)/i);
        const skuPackCount = packNumMatch ? parseInt(packNumMatch[1]) : 1;
        
        // BOX-BUNDLE or BOXERS in SKU → always boxers
        if (skuUp.includes('BOX-BUNDLE') || skuUp.includes('BOXERS') || skuUp.includes('BOX-PACK')) {
            return { tshirts: 0, boxers: skuPackCount, socks: 0 };
        }
        // MONOCHROME without BOX → always tshirts
        if (skuUp.includes('MONOCHROME') && !skuUp.includes('BOX')) {
            return { tshirts: skuPackCount, boxers: 0, socks: 0 };
        }
    }
    // === END SKU-BASED DETECTION ===

    
    // FIRST: Check for bundle meta items (like "Majica 1: Crna - 2XL", "Plava - 4XL")
    if (metadata && Array.isArray(metadata)) {
        const bundleMetaItems = metadata.filter(m => {
            if (!m.key || !m.value) return false;
            if (m.key.startsWith('_')) return false;
            const keyLower = (m.key || '').toLowerCase();
            if (keyLower === 'velicina' || keyLower === 'velikost' || keyLower === 'size' || keyLower === 'méret' || keyLower === 'taglia' || keyLower === 'megethos') return false;
            const val = (m.value || '').toString();
            const hasColorAndSize = (val.includes('-') || val.includes(':')) && 
                val.match(/[A-Z0-9]{1,3}XL|[SMLX]\b/i);
            return hasColorAndSize;
        });
        
        if (bundleMetaItems.length > 0) {
            let tshirtCount = 0, boxerCount = 0;
            for (const meta of bundleMetaItems) {
                const val = (meta.value || '').toString().toLowerCase();
                const key = (meta.key || '').toLowerCase();
                const isShirt = val.includes('majic') || val.includes('shirt') || val.includes('tričk') || val.includes('triko') || val.includes('tricka') ||
                               val.includes('μπλουζάκ') || val.includes('μπλούζ') || val.includes('magliett') || val.includes('póló') ||
                               key.includes('majic') || key.includes('shirt') || key.includes('tričk') || key.includes('tricka') || key.includes('mployz');
                const isBoxer = val.includes('bokser') || val.includes('boxer') || val.includes('trenýr') || val.includes('trenk') || val.includes('boxerky') ||
                               val.includes('μπόξερ') || val.includes('εσώρουχ') || val.includes('gatk') ||
                               key.includes('bokser') || key.includes('boxer') || key.includes('mpoxer') || key.includes('boxerky');
                
                if (isShirt) tshirtCount++;
                else if (isBoxer) boxerCount++;
                else {
                    if (lower.includes('majic') || lower.includes('shirt') || lower.includes('μπλουζ') || lower.includes('magliet') || 
                        lower.includes('póló') || lower.includes('tričk') || lower.includes('tricka') || lower.includes('triko')) tshirtCount++;
                    else if (lower.includes('bokser') || lower.includes('boxer') || lower.includes('modal') || lower.includes('airflow')) boxerCount++;
                }
            }
            if (tshirtCount > 0 || boxerCount > 0) {
                return { tshirts: tshirtCount, boxers: boxerCount, socks: 0 };
            }
        }
    }
    
    const skuUpper = (sku || '').toUpperCase();
    
    // EARLY CHECK: Socks
    const isSocksProduct = lower.includes('ponožk') || lower.includes('sock') || lower.includes('κάλτσ') || 
                           lower.includes('calzin') || lower.includes('zokni') || lower.includes('skarpet') ||
                           lower.includes('nogav') || lower.includes('čarap');
    if (isSocksProduct) {
        const sockPackMatch = lower.match(/(\d+)\s*pár/i) || lower.match(/(\d+)\s*pair/i);
        const sockPairs = sockPackMatch ? parseInt(sockPackMatch[1]) : 1;
        const sockCount = Math.floor(sockPairs / 5);
        return { tshirts: 0, boxers: 0, socks: sockCount };
    }
    
    // EARLY CHECK: Pobřežní/Coastal/Nadbrzeżny packs = T-shirts (NOT boxers!)
    if (lower.includes('pobřežní') || lower.includes('coastal') || lower.includes('nadbrzeżny') || lower.includes('nadbrze')) {
        const packMatch = lower.match(/(\d+)[-\s]?balí[čk]/i) || lower.match(/(\d+)[-\s]?pakie?t/i) || lower.match(/(\d+)[-\s]?pake?t/i) || lower.match(/(\d+)\s*τεμ/i);
        const packCount = packMatch ? parseInt(packMatch[1]) : 1;
        return { tshirts: packCount, boxers: 0, socks: 0 };
    }
    
    // Determine product type
    const isTshirt = lower.includes('majic') || lower.includes('shirt') || lower.includes('triko') || 
                     lower.includes('tričk') || lower.includes('triček') || lower.includes('koszulk') || lower.includes('koszulek') ||
                     lower.includes('μπλουζάκ') || lower.includes('μπλούζ') ||
                     lower.includes('magliett') || lower.includes('magli') ||
                     lower.includes('póló');
    const isExplicitBoxers = lower.includes('bokser') || lower.includes('boxer') || lower.includes('trenk') || lower.includes('trenýr') ||
                             lower.includes('μπόξερ') || lower.includes('εσώρουχ') ||
                             lower.includes('boxerals');
    const isBoxerPack = (lower.includes('miješan') || lower.includes('tamni') || lower.includes('ponoćn') || 
                        lower.includes('urbano') || lower.includes('monokrom') || lower.includes('airflow') || lower.includes('modal') ||
                        lower.includes('μεσονύκτ') || lower.includes('μονόχρωμ') ||
                        lower.includes('αστικό') || lower.includes('astiko') ||
                        lower.includes('městsk') || lower.includes('polnočn') ||
                        lower.includes('urbánn') ||
                        lower.includes('balíček') || lower.includes('balík')) && !isTshirt;  // Don't mark as boxer pack if name contains T-shirt terms
    const isBoxers = isExplicitBoxers || isBoxerPack;
    
    // ORTO products (configurable bundles)
    const isOrto = lower.includes('noriks |') || lower.includes('noriks|') || lower.includes('noriks ') || skuUpper.includes('-ORTO');
    
    if (isOrto && metadata && Array.isArray(metadata)) {
        let tshirtCount = 0, boxerCount = 0;
        let bundlePairs = 0;
        
        for (const meta of metadata) {
            const value = (meta.value || '').toString().toLowerCase();
            if (value.includes('majica') || value.includes('shirt') || value.includes('triko') || value.includes('tričko') || value.includes('koszulk') ||
                value.includes('μπλουζάκ') || value.includes('μπλούζ') || value.includes('magliett') || value.includes('póló')) {
                tshirtCount++;
            } else if (value.includes('bokserica') || value.includes('boxer') || value.includes('trenýr') || value.includes('trenk') || value.includes('boxerky') ||
                       value.includes('μπόξερ') || value.includes('εσώρουχ')) {
                boxerCount++;
            } else if (/^\d+$/.test(meta.key)) {
                if (isTshirt && !isBoxers) tshirtCount++;
                else if (isBoxers) boxerCount++;
            }
            if (meta.key === '_bundle_pairs') {
                bundlePairs = parseInt(meta.value) || 0;
            }
        }
        
        if (tshirtCount > 0 || boxerCount > 0) {
            return { tshirts: tshirtCount, boxers: boxerCount, socks: 0 };
        }
        if (bundlePairs > 0) {
            if (isTshirt && !isBoxers) return { tshirts: bundlePairs, boxers: 0, socks: 0 };
            if (isBoxers) return { tshirts: 0, boxers: bundlePairs, socks: 0 };
        }
    }
    
    // Mixed bundles from name
    const kompletMatch = lower.match(/(\d+)\s*majic.*?(\d+)\s*bokser/i);
    if (kompletMatch) return { tshirts: parseInt(kompletMatch[1]), boxers: parseInt(kompletMatch[2]), socks: 0 };
    const grSetMatch = lower.match(/(\d+)\s*μπλουζ.*?(\d+)\s*μπόξερ/i);
    if (grSetMatch) return { tshirts: parseInt(grSetMatch[1]), boxers: parseInt(grSetMatch[2]), socks: 0 };
    const itSetMatch = lower.match(/(\d+)\s*magliet.*?(\d+)\s*boxer/i);
    if (itSetMatch) return { tshirts: parseInt(itSetMatch[1]), boxers: parseInt(itSetMatch[2]), socks: 0 };
    const czSetMatch = lower.match(/(\d+)\s*tričk.*?(\d+)\s*boxer/i);
    if (czSetMatch) return { tshirts: parseInt(czSetMatch[1]), boxers: parseInt(czSetMatch[2]), socks: 0 };
    if (lower.includes('majica') && lower.includes('bokser') && lower.includes('+')) {
        return { tshirts: 1, boxers: 1, socks: 0 };
    }
    if (lower.includes('μπλουζάκ') && lower.includes('μπόξερ') && lower.includes('+')) {
        return { tshirts: 1, boxers: 1, socks: 0 };
    }
    
    // Starter packs
    if (lower.includes('starter') || lower.includes('εκκίνησης') || lower.includes('εκκινησης')) {
        if ((lower.includes('μπλουζάκ') || lower.includes('majic') || lower.includes('tričk') || lower.includes('magliett')) && 
            (lower.includes('μπόξερ') || lower.includes('bokser') || lower.includes('boxer'))) {
            return { tshirts: 1, boxers: 1, socks: 0 };
        }
        const boxerMatch = lower.match(/(\d+)\s*bokser/i);
        if (boxerMatch) return { tshirts: 0, boxers: parseInt(boxerMatch[1]), socks: 0 };
        const shirtMatch = lower.match(/(\d+)\s*majic/i);
        if (shirtMatch) return { tshirts: parseInt(shirtMatch[1]), boxers: 0, socks: 0 };
        return { tshirts: 0, boxers: 2, socks: 0 };
    }
    
    // Pack sizes from name
    let packCount = 0;
    const packMatch = lower.match(/(\d+)[-\s]?pakie?t/i) || lower.match(/(\d+)[-\s]?pake?t/i);
    const grPackMatch = lower.match(/συσκευασία\s*(\d+)/i) || lower.match(/(\d+)\s*τεμ/i);
    const itPackMatch = lower.match(/pacco\s*da\s*(\d+)/i);
    const czPackMatch = lower.match(/(\d+)[-\s]?balí[čk]/i) || lower.match(/balí[čk]ek\s*(\d+)/i) || lower.match(/balení\s*(\d+)/i) || lower.match(/(\d+)\s*ks/i);
    
    if (packMatch) packCount = parseInt(packMatch[1]);
    else if (grPackMatch) packCount = parseInt(grPackMatch[1]);
    else if (itPackMatch) packCount = parseInt(itPackMatch[1]);
    else if (czPackMatch) packCount = parseInt(czPackMatch[1]);
    
    if (packCount > 0) {
        if (isTshirt && !isBoxers) return { tshirts: packCount, boxers: 0, socks: 0 };
        return { tshirts: 0, boxers: packCount, socks: 0 };
    }
    
    // Single products
    if (isTshirt && !isBoxers) return { tshirts: 1, boxers: 0, socks: 0 };
    if (isBoxers) return { tshirts: 0, boxers: 1, socks: 0 };
    
    // Late socks check (duplicate of early for safety)
    const isSocks = lower.includes('ponožk') || lower.includes('sock') || lower.includes('κάλτσ') || 
                    lower.includes('calzin') || lower.includes('zokni') || lower.includes('skarpet') ||
                    lower.includes('nogav') || lower.includes('čarap');
    if (isSocks) {
        const sockPackMatch = lower.match(/(\d+)\s*pár/i) || lower.match(/(\d+)\s*pair/i);
        const sockPairs = sockPackMatch ? parseInt(sockPackMatch[1]) : 1;
        const sockCount = Math.floor(sockPairs / 5);
        return { tshirts: 0, boxers: 0, socks: sockCount };
    }
    
    return { tshirts: 0, boxers: 0, socks: 0 };
}

function setSkuOverrides(overrides) {
    skuOverrides = overrides;
}

function getSkuOverrides() {
    return skuOverrides;
}

module.exports = { detectProduct, loadSkuOverrides, setSkuOverrides, getSkuOverrides };

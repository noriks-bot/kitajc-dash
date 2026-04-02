const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cron = require('node-cron');
const { execFile } = require('child_process');
const { detectProduct: _sharedDetectProduct, setSkuOverrides: _setSharedOverrides } = require('./detect-product');
const { fetchSales } = require('./fetch-sales');

const PORT = 3000;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const SKU_OVERRIDES_FILE = path.join(__dirname, 'sku-overrides.json');
const CUSTOMER_HISTORY_FILE = path.join(__dirname, 'customer-history.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SHIPPING_FILE = path.join(__dirname, 'shipping-costs.json');
const REJECTIONS_FILE = path.join(__dirname, 'rejections.json');
const SHIPPING_SPEED_FILE = path.join(__dirname, 'shipping-speed-data.json');
const ADVERTISER_CACHE_FILE = path.join(__dirname, 'advertiser-cache.json');
const LIVE_EVENTS_FILE = path.join(__dirname, 'live-events-data.json');
const LIVE_EVENTS_RESOLVED_FILE = path.join(__dirname, 'live-events-resolved.json');
const FB_CR_CACHE_FILE = path.join(__dirname, 'fb-cr-cache.json');
const LANDINGS_FILE = path.join(__dirname, 'landings-data.json');
let landingsData = { content: '', updatedAt: null };
try { if (fs.existsSync(LANDINGS_FILE)) landingsData = JSON.parse(fs.readFileSync(LANDINGS_FILE, 'utf8')); } catch(e) {}
let liveEventsData = { events: [], generatedAt: null };
let fbCrCache = { daily: {}, lastFullSync: null, lastUpdate: null };
try { const _fc = JSON.parse(fs.readFileSync(FB_CR_CACHE_FILE, 'utf8')); if (_fc.daily) fbCrCache = _fc; } catch(e) {}
let liveEventsResolved = {}; // { eventId: { by: username, at: isoString } }
try { const _le = JSON.parse(fs.readFileSync(LIVE_EVENTS_FILE, 'utf8')); if (_le.events) liveEventsData = _le; } catch(e) {}
try { liveEventsResolved = JSON.parse(fs.readFileSync(LIVE_EVENTS_RESOLVED_FILE, 'utf8')); } catch(e) {}
function saveLiveEventsResolved() { try { fs.writeFileSync(LIVE_EVENTS_RESOLVED_FILE, JSON.stringify(liveEventsResolved)); } catch(e) {} }
let advertiserCache = {};
const ORIGIN_DATA_FILE = path.join(__dirname, 'origin-data.json');
// Master origin data: { daily: { "2026-01-01": { "HR": { Facebook:X, ... }, "CZ": {...} }, ... }, generatedAt: "..." }
let originData = { daily: {}, generatedAt: null };
const UPSELL_DATA_FILE = path.join(__dirname, 'upsell-data.json');
// Upsell cache: { daily: { "2026-01-01": { "HR": { orders: N, upsellOrders: N, upsellRevenue: N, byType: {...} }, ... }, ... }, generatedAt: "..." }
let upsellData = { daily: {}, generatedAt: null };
try { if (fs.existsSync(UPSELL_DATA_FILE)) upsellData = JSON.parse(fs.readFileSync(UPSELL_DATA_FILE, 'utf8')); } catch(e) {}
function saveUpsellData() { try { fs.writeFileSync(UPSELL_DATA_FILE, JSON.stringify(upsellData)); upsellData.generatedAt = new Date().toISOString(); } catch(e) { console.error('Upsell data save failed:', e.message); } }
try { if (fs.existsSync(ORIGIN_DATA_FILE)) originData = JSON.parse(fs.readFileSync(ORIGIN_DATA_FILE, 'utf8')); } catch(e) {}

// Campaign ID → Name cache (for WC order product type classification)
const CAMPAIGN_NAMES_FILE = path.join(__dirname, 'campaign-names.json');
let campaignNames = {};
try { if (fs.existsSync(CAMPAIGN_NAMES_FILE)) campaignNames = JSON.parse(fs.readFileSync(CAMPAIGN_NAMES_FILE, 'utf8')); } catch(e) {}

async function resolveCampaignNames(campaignIds) {
    const unknown = campaignIds.filter(id => id && !campaignNames[id] && /^\d+$/.test(id));
    if (unknown.length === 0) return;
    console.log('[CAMPAIGNS] Resolving', unknown.length, 'campaign names...');
    for (const id of unknown) {
        try {
            const resp = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=name&access_token=${FB_TOKEN}`);
            const data = await resp.json();
            if (data.name) campaignNames[id] = data.name;
        } catch(e) {}
    }
    fs.writeFileSync(CAMPAIGN_NAMES_FILE, JSON.stringify(campaignNames, null, 2));
    console.log('[CAMPAIGNS] Cached', Object.keys(campaignNames).length, 'campaign names');
}


function classifySource(meta, coupons) {
    // Call Center orders (created via CallBoss)
    if (meta._call_center === 'yes') return 'Call Center';
    const src = (meta._wc_order_attribution_utm_source || '').toLowerCase();
    const med = (meta._wc_order_attribution_utm_medium || '').toLowerCase();
    const stype = (meta._wc_order_attribution_source_type || '').toLowerCase();
    const referrer = (meta._wc_order_attribution_referrer || '').toLowerCase();
    const entry = (meta._wc_order_attribution_session_entry || '').toLowerCase();
    if (src === 'fb' || src === 'ig' || src === 'an') return 'Facebook';
    if (src.includes('facebook') || src.includes('instagram')) return 'Facebook';
    if ((src === 'm.facebook.com' || src === 'l.facebook.com' || src === 'lm.facebook.com') && stype === 'referral') return 'Facebook';
    if (src.includes('meta') && (med === 'cpc' || med === 'paid')) return 'Facebook';
    if ((src === 'google' || src === 'google.com') && (med === 'cpc' || med === 'paid')) return 'Google Paid';
    if (referrer.includes('gclid') || entry.includes('gclid')) return 'Google Paid';
    if (src === 'google' || src === 'google.com') return 'Google Organic';
    if (src === 'klaviyo' || med === 'email') return 'Klaviyo';
    if (coupons && coupons.length > 0) {
        const klaviyoCoupons = ['shop20', 'welcome', 'email'];
        if (coupons.some(c => klaviyoCoupons.some(k => c.toLowerCase().includes(k)))) return 'Klaviyo';
    }
    if (referrer.includes('fbclid') || referrer.includes('utm_source=fb') || referrer.includes('utm_source=ig') || referrer.includes('facebook.com')) return 'Facebook';
    if (entry.includes('fbclid') || entry.includes('utm_source=fb') || entry.includes('utm_source=ig')) return 'Facebook';
    if (referrer.includes('google.com') && (referrer.includes('gclid') || referrer.includes('ads'))) return 'Google Paid';
    if (referrer.includes('google.com')) return 'Google Organic';
    return 'Direct';
}

// Generate origin master data — fetches WC orders, classifies, saves to disk
// onlyToday=true: only re-fetch today's data (fast refresh)
function loadAdvertiserCache() { try { if (fs.existsSync(ADVERTISER_CACHE_FILE)) advertiserCache = JSON.parse(fs.readFileSync(ADVERTISER_CACHE_FILE, 'utf8')); } catch(e) { console.log('No advertiser cache'); } }
function saveAdvertiserCache() { try { fs.writeFileSync(ADVERTISER_CACHE_FILE, JSON.stringify(advertiserCache)); } catch(e) { console.error('Advertiser cache save failed:', e.message); } }
const STOCK_DATA_FILE = path.join(__dirname, 'stock-data.json');
const MK_ORDER_MAP_FILE = path.join(__dirname, 'mk-order-map.json');

// Load product counts from stock-data.json (single source of truth)
// Returns { today: {tshirts, boxers}, yesterday: {tshirts, boxers}, week: {tshirts, boxers} }
function loadStockProductCounts() {
    try {
        if (!fs.existsSync(STOCK_DATA_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(STOCK_DATA_FILE, 'utf8'));
        if (!data.detailed || !Array.isArray(data.detailed)) return null;
        
        const result = {
            today: { tshirts: 0, boxers: 0, socks: 0 },
            yesterday: { tshirts: 0, boxers: 0, socks: 0 },
            week: { tshirts: 0, boxers: 0, socks: 0 },
            todayDate: data.today,
            yesterdayDate: data.yesterday
        };
        
        for (const item of data.detailed) {
            const type = (item.type || '').toLowerCase();
            if (type === 't-shirt' || type === 'tshirt') {
                result.today.tshirts += item.today || 0;
                result.yesterday.tshirts += item.yesterday || 0;
                result.week.tshirts += item.week || 0;
            } else if (type === 'boxers' || type === 'boxer') {
                result.today.boxers += item.today || 0;
                result.yesterday.boxers += item.yesterday || 0;
                result.week.boxers += item.week || 0;
            } else if (type === 'socks') {
                result.today.socks += item.today || 0;
                result.yesterday.socks += item.yesterday || 0;
                result.week.socks += item.week || 0;
            }
        }
        
        console.log(`Stock data loaded: today T=${result.today.tshirts} B=${result.today.boxers}, yesterday T=${result.yesterday.tshirts} B=${result.yesterday.boxers}`);
        return result;
    } catch (e) {
        console.error('Failed to load stock data:', e.message);
        return null;
    }
}

// Override product counts in cache data to match stock-data.json totals EXACTLY
// Scales per-country counts proportionally, then adjusts for rounding
function overrideProductCounts(dateData, stockTotals, label) {
    const countries = Object.keys(dateData).filter(c => dateData[c] && typeof dateData[c].tshirts === 'number');
    if (countries.length === 0) return;
    
    // Calculate current totals from cache
    let currentTshirts = 0, currentBoxers = 0;
    for (const country of countries) {
        currentTshirts += dateData[country].tshirts || 0;
        currentBoxers += dateData[country].boxers || 0;
    }
    
    const targetTshirts = stockTotals.tshirts || 0;
    const targetBoxers = stockTotals.boxers || 0;
    
    const tshirtScale = currentTshirts > 0 ? targetTshirts / currentTshirts : 1;
    const boxerScale = currentBoxers > 0 ? targetBoxers / currentBoxers : 1;
    
    console.log(`Product override (${label}): T ${currentTshirts}→${targetTshirts}, B ${currentBoxers}→${targetBoxers}`);
    
    // Apply scaling to each country (floor to avoid over-counting)
    let newTshirtTotal = 0, newBoxerTotal = 0;
    for (const country of countries) {
        const oldT = dateData[country].tshirts || 0;
        const oldB = dateData[country].boxers || 0;
        
        dateData[country].tshirts = Math.floor(oldT * tshirtScale);
        dateData[country].boxers = Math.floor(oldB * boxerScale);
        
        newTshirtTotal += dateData[country].tshirts;
        newBoxerTotal += dateData[country].boxers;
    }
    
    // Distribute remainder to countries with highest original counts
    const sortedByTshirts = [...countries].sort((a, b) => (dateData[b].tshirts || 0) - (dateData[a].tshirts || 0));
    const sortedByBoxers = [...countries].sort((a, b) => (dateData[b].boxers || 0) - (dateData[a].boxers || 0));
    
    let tshirtRemainder = targetTshirts - newTshirtTotal;
    let boxerRemainder = targetBoxers - newBoxerTotal;
    
    let i = 0;
    while (tshirtRemainder > 0 && i < sortedByTshirts.length) {
        dateData[sortedByTshirts[i]].tshirts++;
        tshirtRemainder--;
        i++;
    }
    
    i = 0;
    while (boxerRemainder > 0 && i < sortedByBoxers.length) {
        dateData[sortedByBoxers[i]].boxers++;
        boxerRemainder--;
        i++;
    }
    
    // Recalculate product cost and profit for each country
    for (const country of countries) {
        const newProductCost = (dateData[country].tshirts * PRODUCT_COSTS.tshirt) + (dateData[country].boxers * PRODUCT_COSTS.boxers);
        const rejectionRate = dateData[country].rejection_rate || 0;
        const effectiveProductCost = newProductCost * (1 - rejectionRate);
        
        dateData[country].product_cost = Math.round(newProductCost * 100) / 100;
        dateData[country].effective_product_cost = Math.round(effectiveProductCost * 100) / 100;
        
        const effectiveNetEur = dateData[country].effective_net_eur || 0;
        const spend = dateData[country].spend || 0;
        const shippingCost = dateData[country].shipping_cost || 0;
        const newProfit = effectiveNetEur - spend - effectiveProductCost - shippingCost;
        dateData[country].profit = Math.round(newProfit * 100) / 100;
    }
}

// Session management
let sessions = {};
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            // Filter out expired sessions
            const now = Date.now();
            sessions = {};
            for (const [token, session] of Object.entries(data)) {
                if (session.expiresAt > now) sessions[token] = session;
            }
        }
    } catch (e) { console.log('No sessions file'); }
}

function saveSessions() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }
    catch (e) { console.error('Sessions save failed:', e.message); }
}

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || [];
        }
    } catch (e) { console.log('No users file'); }
    return [];
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.split('=').map(s => s.trim());
            if (name && value) cookies[name] = value;
        });
    }
    return cookies;
}

function getSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['session'];
    if (token && sessions[token]) {
        const session = sessions[token];
        if (session.expiresAt > Date.now()) {
            return session;
        }
        delete sessions[token];
        saveSessions();
    }
    return null;
}

function createSession(username, role) {
    const token = generateSessionToken();
    sessions[token] = {
        username,
        role: role || 'admin',
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_DURATION
    };
    saveSessions();
    return token;
}

function destroySession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['session'];
    if (token && sessions[token]) {
        delete sessions[token];
        saveSessions();
    }
}

// Product costs (EUR)
const PRODUCT_COSTS = {
    tshirt: 3.5,
    boxers: 2.25
};

// VAT rates by country
const VAT_RATES = {
    HR: 0.25,  // Croatia 25%
    CZ: 0.21,  // Czech Republic 21%
    PL: 0.23,  // Poland 23%
    GR: 0.24,  // Greece 24%
    IT: 0.22,  // Italy 22%
    HU: 0.27,  // Hungary 27%
    SK: 0.23   // Slovakia 23%
};

// SKU overrides
let skuOverrides = {};

// Customer order history: { country: { email: { firstOrderDate, orderCount, totalSpent } } }
let customerHistory = { HR: {}, CZ: {}, PL: {}, GR: {}, IT: {}, HU: {}, SK: {} };

// Track if full sync has been done
let fullSyncCompleted = false;

function loadSkuOverrides() {
    try {
        if (fs.existsSync(SKU_OVERRIDES_FILE)) {
            skuOverrides = JSON.parse(fs.readFileSync(SKU_OVERRIDES_FILE, 'utf8'));
            _setSharedOverrides(skuOverrides); // sync to shared module
        }
    } catch (e) { console.log('No SKU overrides'); }
}

function saveSkuOverrides() {
    try { fs.writeFileSync(SKU_OVERRIDES_FILE, JSON.stringify(skuOverrides, null, 2)); }
    catch (e) { console.error('SKU overrides save failed:', e.message); }
}

// Shipping costs by country
let shippingCosts = {};

function loadShippingCosts() {
    try {
        if (fs.existsSync(SHIPPING_FILE)) {
            shippingCosts = JSON.parse(fs.readFileSync(SHIPPING_FILE, 'utf8'));
        }
    } catch (e) { console.log('No shipping costs file'); }
}

function saveShippingCosts() {
    try { fs.writeFileSync(SHIPPING_FILE, JSON.stringify(shippingCosts, null, 2)); }
    catch (e) { console.error('Shipping costs save failed:', e.message); }
}

// Rejection rates by country
let rejectionRates = {};

function loadRejectionRates() {
    try {
        if (fs.existsSync(REJECTIONS_FILE)) {
            rejectionRates = JSON.parse(fs.readFileSync(REJECTIONS_FILE, 'utf8'));
        }
    } catch (e) { console.log('No rejections file'); }
}

// MK order status map: buyer_order → {status, deleted, paid, gross, neto, tax}
let mkOrderMap = {};

function loadMkOrderMap() {
    try {
        if (fs.existsSync(MK_ORDER_MAP_FILE)) {
            const data = JSON.parse(fs.readFileSync(MK_ORDER_MAP_FILE, 'utf8'));
            mkOrderMap = data.orders || {};
            const deleted = Object.values(mkOrderMap).filter(o => o.deleted).length;
            console.log(`MK order map loaded: ${Object.keys(mkOrderMap).length} orders (${deleted} deleted)`);
        }
    } catch (e) { console.log('No MK order map file'); }
}

function saveRejectionRates() {
    try { fs.writeFileSync(REJECTIONS_FILE, JSON.stringify(rejectionRates, null, 2)); }
    catch (e) { console.error('Rejections save failed:', e.message); }
}

function loadCustomerHistory() {
    try {
        if (fs.existsSync(CUSTOMER_HISTORY_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(CUSTOMER_HISTORY_FILE, 'utf8'));
            customerHistory = loaded.customerHistory || { HR: {}, CZ: {}, PL: {}, GR: {}, IT: {}, HU: {}, SK: {} };
            // Ensure all countries exist
            for (const c of ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK']) {
                if (!customerHistory[c]) customerHistory[c] = {};
            }
            fullSyncCompleted = loaded.fullSyncCompleted || false;
            console.log(`Customer history loaded: HR=${Object.keys(customerHistory.HR).length}, CZ=${Object.keys(customerHistory.CZ).length}, PL=${Object.keys(customerHistory.PL).length}, GR=${Object.keys(customerHistory.GR || {}).length}, IT=${Object.keys(customerHistory.IT || {}).length}, HU=${Object.keys(customerHistory.HU || {}).length}, SK=${Object.keys(customerHistory.SK || {}).length}`);
        }
    } catch (e) { console.log('No customer history'); }
}

function saveCustomerHistory() {
    try { 
        fs.writeFileSync(CUSTOMER_HISTORY_FILE, JSON.stringify({ 
            customerHistory, 
            fullSyncCompleted,
            lastUpdate: new Date().toISOString()
        }, null, 2)); 
    }
    catch (e) { console.error('Customer history save failed:', e.message); }
}

// Config
const config = {
    HR: { url: 'https://noriks.com/hr/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'EUR', rate: 1 },
    CZ: { url: 'https://noriks.com/cz/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'CZK', rate: 0.041 },
    PL: { url: 'https://noriks.com/pl/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'PLN', rate: 0.232 },
    GR: { url: 'https://noriks.com/gr/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'EUR', rate: 1 },
    IT: { url: 'https://noriks.com/it/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'EUR', rate: 1 },
    HU: { url: 'https://noriks.com/hu/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'HUF', rate: 0.00256 },
    SK: { url: 'https://noriks.com/sk/wp-json/wc/v3', key: 'YOUR_WC_CONSUMER_KEY', secret: 'YOUR_WC_CONSUMER_SECRET', currency: 'EUR', rate: 1 }
};

const FB_TOKEN = 'YOUR_FACEBOOK_ACCESS_TOKEN';
const FB_ACCOUNT = 'act_1922887421998222';
const FB_ACCOUNTS = ['act_1922887421998222', 'act_1426869489183439']; // noriks + top_noriks_4

// Fetch insights from ALL FB ad accounts and merge results
async function fetchAllAccountInsights(params) {
    let allData = [];
    for (const account of FB_ACCOUNTS) {
        let url = `https://graph.facebook.com/v21.0/${account}/insights?${params}`;
        while (url) {
            const result = await fetch(url);
            if (result.data) allData = allData.concat(result.data);
            url = result.paging?.next || null;
        }
    }
    return allData;
}

let dataCache = { dates: [], countries: ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'], data: {}, lastUpdate: null, lastFullSync: null };
let inventoryUpdateQueue = Promise.resolve(); // Serializes inventory file writes

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            dataCache = loaded || dataCache;
            console.log(`Cache loaded: ${Object.keys(dataCache.data).length} days, last full sync: ${dataCache.lastFullSync || 'never'}`);
        }
    } catch (e) { console.log('No cache, starting fresh'); }
}

function saveCache() {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(dataCache, null, 2)); }
    catch (e) { console.error('Cache save failed:', e.message); }
}

function fetch(urlStr) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { req.destroy(); resolve([]); }, 30000);
        const req = https.get(urlStr, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } });
        });
        req.on('error', () => { clearTimeout(timeout); resolve([]); });
    });
}

// Detect product contents - delegates to shared detect-product.js (SOURCE OF TRUTH)
function detectProduct(name, useOverride = true, metadata = null, sku = null) {
    return _sharedDetectProduct(name, useOverride, metadata, sku);
}

// Filter out test orders (name/surname contains "test")
function isTestOrder(order) {
    const billing = order.billing || {};
    const shipping = order.shipping || {};
    const testPattern = /test/i;
    
    if (testPattern.test(billing.first_name || '')) return true;
    if (testPattern.test(billing.last_name || '')) return true;
    if (testPattern.test(shipping.first_name || '')) return true;
    if (testPattern.test(shipping.last_name || '')) return true;
    
    return false;
}

// Filter orders to exclude test orders
function filterTestOrders(orders) {
    return orders.filter(order => !isTestOrder(order));
}

// Get orders from WooCommerce v3 API (for product details)
async function getWooOrders(country, start, end, page = 1, allOrders = []) {
    const c = config[country];
    const auth = Buffer.from(`${c.key}:${c.secret}`).toString('base64');
    const apiUrl = `${c.url}/orders?after=${start}T00:00:00&before=${end}T23:59:59&per_page=100&page=${page}&status=completed,processing`;
    
    try {
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
            const req = https.get(apiUrl, { headers: { 'Authorization': `Basic ${auth}` } }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(timeout);
                    try { resolve({ orders: JSON.parse(data), total: parseInt(res.headers['x-wp-totalpages']) || 1 }); }
                    catch (e) { resolve({ orders: [], total: 1 }); }
                });
            });
            req.on('error', () => { clearTimeout(timeout); resolve({ orders: [], total: 1 }); });
        });
        
        allOrders = allOrders.concat(result.orders || []);
        if (page < result.total) {
            return getWooOrders(country, start, end, page + 1, allOrders);
        }
        return allOrders;
    } catch (e) {
        console.error(`WooCommerce ${country} error:`, e.message);
        return allOrders;
    }
}

// Get orders from WooCommerce Analytics API (has customer_type: new/returning)
async function getWooAnalyticsOrders(country, start, end, page = 1, allOrders = []) {
    const c = config[country];
    const auth = Buffer.from(`${c.key}:${c.secret}`).toString('base64');
    // Analytics API uses different date format and endpoint
    const baseUrl = c.url.replace('/wp-json/wc/v3', '/wp-json/wc-analytics/reports/orders');
    const apiUrl = `${baseUrl}?after=${start}T00:00:00&before=${end}T23:59:59&per_page=100&page=${page}&status=completed,processing`;
    
    try {
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
            const req = https.get(apiUrl, { headers: { 'Authorization': `Basic ${auth}` } }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(timeout);
                    try { resolve({ orders: JSON.parse(data), total: parseInt(res.headers['x-wp-totalpages']) || 1 }); }
                    catch (e) { resolve({ orders: [], total: 1 }); }
                });
            });
            req.on('error', () => { clearTimeout(timeout); resolve({ orders: [], total: 1 }); });
        });
        
        allOrders = allOrders.concat(result.orders || []);
        if (page < result.total) {
            return getWooAnalyticsOrders(country, start, end, page + 1, allOrders);
        }
        return allOrders;
    } catch (e) {
        console.error(`WooCommerce Analytics ${country} error:`, e.message);
        return allOrders;
    }
}

async function getFacebookAds(start, end) {
    const params = new URLSearchParams({
        access_token: FB_TOKEN,
        time_range: JSON.stringify({ since: start, until: end }),
        fields: 'spend,date_start',
        breakdowns: 'country',
        level: 'account',
        time_increment: 1,
        limit: 5000
    });
    
    const allData = await fetchAllAccountInsights(params);
    return { data: allData };
}

// Check if customer is new or returning based on history
function isReturningCustomer(country, email, orderDate) {
    const history = customerHistory[country]?.[email?.toLowerCase()];
    if (!history) return false;
    return history.firstOrderDate < orderDate;
}

// Update customer history with order
function updateCustomerHistory(country, email, orderDate, orderTotal) {
    if (!email) return;
    email = email.toLowerCase();
    
    if (!customerHistory[country]) customerHistory[country] = {};
    
    if (!customerHistory[country][email]) {
        customerHistory[country][email] = {
            firstOrderDate: orderDate,
            orderCount: 1,
            totalSpent: orderTotal
        };
    } else {
        const h = customerHistory[country][email];
        if (orderDate < h.firstOrderDate) {
            h.firstOrderDate = orderDate;
        }
        h.orderCount++;
        h.totalSpent += orderTotal;
    }
}

// Full sync - imports 2025 + 2026 data with WooCommerce customer_type
async function syncFullYear() {
    console.log('🔄 Starting FULL SYNC (2025 + 2026)...');
    const historyStart = '2025-01-01';
    const dataStart = '2026-01-01';
    const end = new Date().toISOString().split('T')[0];
    
    console.log(`Fetching orders from ${historyStart} to ${end}...`);
    
    // Fetch regular orders (for product details) and analytics orders (for customer_type)
    const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
    const orderPromises = countries.map(c => getWooOrders(c, historyStart, end));
    const analyticsPromises = countries.map(c => getWooAnalyticsOrders(c, historyStart, end));
    
    const allOrders = await Promise.all(orderPromises);
    const allAnalytics = await Promise.all(analyticsPromises);
    
    const ordersByCountry = {};
    const analyticsByCountry = {};
    countries.forEach((c, i) => {
        ordersByCountry[c] = allOrders[i];
        analyticsByCountry[c] = allAnalytics[i];
    });
    
    console.log(`Orders fetched: ${countries.map(c => `${c}=${ordersByCountry[c].length}`).join(', ')}`);
    console.log(`Analytics fetched: ${countries.map(c => `${c}=${analyticsByCountry[c].length}`).join(', ')}`);
    
    // Build customer_type lookup from analytics
    const customerTypeLookup = {};
    for (const c of countries) {
        customerTypeLookup[c] = {};
        for (const order of analyticsByCountry[c]) {
            customerTypeLookup[c][order.order_id] = order.customer_type;
        }
    }
    
    // Reset customer history
    customerHistory = {};
    for (const c of countries) customerHistory[c] = {};
    
    // Sort all orders by date (oldest first) to build accurate customer history
    // Filter out test orders
    const allOrdersWithCountry = [];
    for (const c of countries) {
        const filteredOrders = filterTestOrders(ordersByCountry[c]);
        allOrdersWithCountry.push(...filteredOrders.map(o => ({ ...o, _country: c })));
    }
    allOrdersWithCountry.sort((a, b) => (a.date_created || '').localeCompare(b.date_created || ''));
    
    console.log(`Total orders to process: ${allOrdersWithCountry.length}`);
    
    // First pass: build customer history with all orders in chronological order
    for (const order of allOrdersWithCountry) {
        const email = order.billing?.email;
        const date = order.date_created?.substring(0, 10);
        const total = parseFloat(order.total || 0);
        if (email && date) {
            updateCustomerHistory(order._country, email, date, total);
        }
    }
    
    saveCustomerHistory();
    console.log(`Customer history built: ${countries.map(c => `${c}=${Object.keys(customerHistory[c] || {}).length}`).join(', ')}`);
    
    // Fetch Facebook ads data (only 2026)
    console.log('Fetching Facebook Ads data for 2026...');
    const fbData = await getFacebookAds(dataStart, end);
    
    const fbByDate = {};
    if (fbData.data) {
        for (const row of fbData.data) {
            const date = row.date_start, country = row.country;
            if (!countries.includes(country)) continue;
            if (!fbByDate[date]) fbByDate[date] = {};
            if (!fbByDate[date][country]) fbByDate[date][country] = { spend: 0 }; fbByDate[date][country].spend += parseFloat(row.spend || 0);
        }
    }
    
    // Reload MK order map for fresh deletion data
    loadMkOrderMap();
    
    // Track all WC order numbers for MK extra paid detection
    const processedWcOrders = new Set();
    
    // Reset origin + upsell data for full rebuild during sync
    originData.daily = {};
    upsellData.daily = {};
    
    // Second pass: calculate daily metrics with accurate new/returning classification
    // Only include 2026 data in dashboard, but customer history includes 2025
    const newData = {};
    const dates = new Set();
    
    for (const country of countries) {
        const orders = filterTestOrders(ordersByCountry[country] || []);
        if (!Array.isArray(orders) || orders.length === 0) continue;
        
        const byDate = {};
        
            // Resolve campaign names for WC order classification
            const allCampaignIds = orders.map(o => {
                const m = {};
                for (const md of (o.meta_data || [])) m[md.key] = md.value;
                return m._wc_order_attribution_utm_campaign || '';
            }).filter(id => id && /^\d+$/.test(id));
            await resolveCampaignNames(allCampaignIds);

        for (const order of orders) {
            const date = order.date_created?.substring(0, 10);
            if (!date) continue;
            
            // Only include 2026 data in dashboard
            if (date < dataStart) continue;
            
            dates.add(date);
            
            if (!byDate[date]) {
                byDate[date] = { 
                    orders: 0, 
                    revenue: 0, 
                    newCustomers: 0, 
                    returningCustomers: 0,
                    newOrders: 0,
                    returningOrders: 0,
                    newRevenue: 0,
                    returningRevenue: 0,
                    tshirts: 0, 
                    boxers: 0,
                    socks: 0,
                    shippingCost: 0,
                    emails: new Set(),
                    // MK Real Money tracking (based on same WC orders)
                    mkAllOrders: 0, mkAllGross: 0, mkAllNeto: 0, mkAllTax: 0,
                    mkPaidOrders: 0, mkPaidGross: 0, mkPaidNeto: 0, mkPaidTax: 0,
                    // MK-aligned EUR revenue (uses MK EUR when available, WC conversion as fallback)
                    mkAlignedGrossEur: 0, mkAlignedNewGrossEur: 0, mkAlignedRetGrossEur: 0,
                    // Payment method tracking
                    payment_cod: 0, payment_card: 0, payment_paypal: 0, payment_other: 0
                };
            }
            
            // Skip orders deleted in Metakocka (Brisan/Preklican/etc.)
            const wcOrderNum = order.number || '';
            const mkInfo = mkOrderMap[wcOrderNum];
            if (mkInfo && mkInfo.deleted) continue;
            
            // Track processed WC order numbers
            if (wcOrderNum) processedWcOrders.add(wcOrderNum);
            
            // Track MK Real Money for this WC order
            if (mkInfo) {
                byDate[date].mkAllOrders++;
                byDate[date].mkAllGross += mkInfo.gross || 0;
                byDate[date].mkAllNeto += mkInfo.neto || 0;
                byDate[date].mkAllTax += mkInfo.tax || 0;
                if (mkInfo.paid) {
                    byDate[date].mkPaidOrders++;
                    byDate[date].mkPaidGross += mkInfo.gross || 0;
                    byDate[date].mkPaidNeto += mkInfo.neto || 0;
                    byDate[date].mkPaidTax += mkInfo.tax || 0;
                }
            }
            
            const email = order.billing?.email;
            const total = parseFloat(order.total || 0);
            
            byDate[date].orders++;

            // Payment method tracking
            const _pm = (order.payment_method || 'unknown').toLowerCase();
            if (_pm === 'cod') byDate[date].payment_cod++;
            else if (['stripe','bacs','stripe_cc','stripe_sepa'].includes(_pm)) byDate[date].payment_card++;
            else if (['ppcp-gateway','paypal','ppcp'].includes(_pm)) byDate[date].payment_paypal++;
            else byDate[date].payment_other++;            byDate[date].revenue += total;
            
            // Origin attribution: classify source and update origin master data
            {
                const meta = {};
                for (const m of (order.meta_data || [])) meta[m.key] = m.value;
                const coupons = (order.coupon_lines || []).map(cl => cl.code);
                const source = classifySource(meta, coupons);
                if (!originData.daily[date]) originData.daily[date] = {};
                if (!originData.daily[date][country]) originData.daily[date][country] = { Facebook: 0, 'Google Organic': 0, 'Google Paid': 0, Klaviyo: 0, Direct: 0, 'Call Center': 0, total: 0, Mobile: 0, Desktop: 0, CatalogOrders: 0, wcByProduct: { shirts: 0, boxers: 0, starter: 0, kompleti: 0, catalog: 0 } };
                originData.daily[date][country][source]++;
                originData.daily[date][country].total++;
                const device = meta._wc_order_attribution_device_type || 'Desktop';
                if (device.toLowerCase().includes('mobile')) originData.daily[date][country].Mobile++;
                else originData.daily[date][country].Desktop++;
                // Track catalog feed orders (utm_source contains "Catalog")
                const utmSrc = meta._wc_order_attribution_utm_source || '';
                if (source === 'Facebook' && utmSrc.toLowerCase().includes('catalog')) {
                    originData.daily[date][country].CatalogOrders++;
                }
                // Classify order by product type for wcByProduct
                if (source === 'Facebook' && utmSrc.toLowerCase().includes('catalog')) {
                    originData.daily[date][country].wcByProduct.catalog++;
                } else if (source === 'Facebook' || source === 'Direct') {
                    let orderTshirts = 0, orderBoxers = 0, orderStarter = false;
                    if (order.line_items) {
                        for (const item of order.line_items) {
                            const p = detectProduct(item.name, true, item.meta_data, item.sku);
                            const qty = item.quantity || 1;
                            orderTshirts += (p.tshirts || 0) * qty;
                            orderBoxers += (p.boxers || 0) * qty;
                        }
                        // Check for starter pack (product name)
                        for (const item of order.line_items) {
                            const ln = (item.name || '').toLowerCase();
                            if (ln.includes('starter') || ln.includes('start')) orderStarter = true;
                        }
                    }
                    // Classify by: 1) product name/SKU for komplet/starter, 2) campaign name for shirts/boxers
                    let orderKomplet = false;
                    if (order.line_items) {
                        for (const item of order.line_items) {
                            const ln = (item.name || '').toLowerCase();
                            const sk = (item.sku || '').toLowerCase();
                            if (ln.includes('komplet') || sk.includes('bundle-shirt') || sk.includes('bundle-sh-box')) orderKomplet = true;
                        }
                    }
                    if (orderStarter) originData.daily[date][country].wcByProduct.starter++;
                    else if (orderKomplet) originData.daily[date][country].wcByProduct.kompleti++;
                    else {
                        // Use campaign name to determine type (MAJICE vs BOXERS)
                        const campId = meta._wc_order_attribution_utm_campaign || '';
                        const campName = (campaignNames[campId] || '').toLowerCase();
                        if (campName.includes('boxers') || campName.includes('bokser')) {
                            originData.daily[date][country].wcByProduct.boxers++;
                        } else if (campName.includes('majice') || campName.includes('shirt') || campName.includes('majic')) {
                            originData.daily[date][country].wcByProduct.shirts++;
                        } else if (campName.includes('starter') || campName.includes('start')) {
                            originData.daily[date][country].wcByProduct.starter++;
                        } else if (campName.includes('2p5') || campName.includes('komplet')) {
                            originData.daily[date][country].wcByProduct.kompleti++;
                        } else if (orderTshirts > 0) {
                            originData.daily[date][country].wcByProduct.shirts++;
                        } else if (orderBoxers > 0) {
                            originData.daily[date][country].wcByProduct.boxers++;
                        }
                    }
                }
            }
            
            // MK-aligned EUR: use MK gross (actual EUR invoice) when available, else WC conversion
            const orderGrossEur = (mkInfo && mkInfo.gross) ? mkInfo.gross : (total * config[country].rate);
            byDate[date].mkAlignedGrossEur += orderGrossEur;
            
            // Add shipping cost for this order (using country-specific cost)
            const orderShippingCost = shippingCosts[country] || 0;
            byDate[date].shippingCost += orderShippingCost;
            
            // Count products
            if (order.line_items) {
                for (const item of order.line_items) {
                    const product = detectProduct(item.name, true, item.meta_data, item.sku);
                    const lineQty = item.quantity || 1;
                    byDate[date].tshirts += (product.tshirts || 0) * lineQty;
                    byDate[date].boxers += (product.boxers || 0) * lineQty;
                    byDate[date].socks += (product.socks || 0) * lineQty;
                }
            }
            
            // Upsell tracking — extract _noriks_upsell meta from line items (syncFullYear)
            {
                if (!upsellData.daily[date]) upsellData.daily[date] = {};
                if (!upsellData.daily[date][country]) upsellData.daily[date][country] = { orders: 0, upsellOrders: 0, upsellRevenue: 0, byType: {} };
                upsellData.daily[date][country].orders++;
                let _orderHasUpsell2 = false;
                for (const _item2 of (order.line_items || [])) {
                    const _uMeta2 = (_item2.meta_data || []).find(m => m.key === '_noriks_upsell');
                    if (_uMeta2) {
                        const _utype2 = _uMeta2.value || 'unknown';
                        const _itemEur2 = parseFloat(_item2.total || 0) * config[country].rate;
                        const _qty2 = parseInt(_item2.quantity || 1);
                        if (!upsellData.daily[date][country].byType[_utype2]) upsellData.daily[date][country].byType[_utype2] = { count: 0, revenue: 0, qty: 0 };
                        upsellData.daily[date][country].byType[_utype2].count++;
                        upsellData.daily[date][country].byType[_utype2].qty += _qty2;
                        upsellData.daily[date][country].byType[_utype2].revenue += _itemEur2;
                        upsellData.daily[date][country].upsellRevenue += _itemEur2;
                        _orderHasUpsell2 = true;
                    }
                }
                if (_orderHasUpsell2) upsellData.daily[date][country].upsellOrders++;
            }
            
            // Use WooCommerce customer_type from analytics API
            const orderId = order.id;
            const customerType = customerTypeLookup[country][orderId] || 'new';
            const isRet = customerType === 'returning';
            
            if (isRet) {
                byDate[date].returningOrders++;
                byDate[date].returningRevenue += total;
                byDate[date].mkAlignedRetGrossEur += orderGrossEur;
            } else {
                byDate[date].newOrders++;
                byDate[date].newRevenue += total;
                byDate[date].mkAlignedNewGrossEur += orderGrossEur;
            }
            
            // Count unique customers per day
            if (email && !byDate[date].emails.has(email.toLowerCase())) {
                byDate[date].emails.add(email.toLowerCase());
                if (isRet) {
                    byDate[date].returningCustomers++;
                } else {
                    byDate[date].newCustomers++;
                }
            }
        }
        
        // Build final data structure
        for (const [date, data] of Object.entries(byDate)) {
            if (!newData[date]) newData[date] = {};
            
            const spend = fbByDate[date]?.[country]?.spend || 0;
            const vatRate = VAT_RATES[country] || 0;
            const rejectionRate = (rejectionRates[country] || 0) / 100;
            
            // Original gross revenue (use MK-aligned EUR when available for consistency)
            const revenueGross = data.revenue;
            const revenueGrossEur = data.mkAlignedGrossEur || (revenueGross * config[country].rate);
            
            // Apply rejection rate to gross revenue BEFORE VAT
            // (rejected orders = no payment received, no VAT to pay)
            const effectiveGrossEur = revenueGrossEur * (1 - rejectionRate);
            const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
            
            // Original net (for display purposes)
            const revenueNetEur = revenueGrossEur / (1 + vatRate);
            const revenueNet = revenueGross / (1 + vatRate);
            
            // Revenue split by customer type (using MK-aligned EUR + effective rates)
            const newGrossEur = data.mkAlignedNewGrossEur || (data.newRevenue * config[country].rate);
            const retGrossEur = data.mkAlignedRetGrossEur || (data.returningRevenue * config[country].rate);
            const newRevenueEur = newGrossEur * (1 - rejectionRate) / (1 + vatRate);
            const retRevenueEur = retGrossEur * (1 - rejectionRate) / (1 + vatRate);
            
            // Product cost - apply rejection rate (we get products back for rejected orders)
            const productCost = (data.tshirts * PRODUCT_COSTS.tshirt) + (data.boxers * PRODUCT_COSTS.boxers);
            const effectiveProductCost = productCost * (1 - rejectionRate);
            
            // Shipping stays at 100% (we pay for all shipments including rejected)
            const shippingCost = data.shippingCost || 0;
            
            // Profit = Effective Net Revenue - FB Spend - Effective Product Cost - Full Shipping
            const profit = effectiveNetEur - spend - effectiveProductCost - shippingCost;
            
            newData[date][country] = {
                orders: data.orders,
                new: data.newOrders,
                returning: data.returningOrders,
                new_orders: data.newOrders,
                ret_orders: data.returningOrders,
                revenue_gross: Math.round(revenueGross * 100) / 100,
                revenue_net: Math.round(revenueNet * 100) / 100,
                revenue_gross_eur: Math.round(revenueGrossEur * 100) / 100,
                revenue_net_eur: Math.round(revenueNetEur * 100) / 100,
                effective_net_eur: Math.round(effectiveNetEur * 100) / 100,
                new_revenue_eur: Math.round(newRevenueEur * 100) / 100,
                ret_revenue_eur: Math.round(retRevenueEur * 100) / 100,
                vat_rate: vatRate,
                rejection_rate: rejectionRate,
                currency: config[country].currency,
                spend: Math.round(spend * 100) / 100,
                tshirts: data.tshirts,
                boxers: data.boxers,
                socks: data.socks || 0,
                product_cost: Math.round(productCost * 100) / 100,
                effective_product_cost: Math.round(effectiveProductCost * 100) / 100,
                shipping_cost: Math.round(shippingCost * 100) / 100,
                profit: Math.round(profit * 100) / 100,
                cpa: data.orders > 0 ? Math.round(spend / data.orders * 100) / 100 : null,
                cpa_new: data.newOrders > 0 ? Math.round(spend / data.newOrders * 100) / 100 : null,
                roas: spend > 0 ? Math.round(revenueGrossEur / spend * 100) / 100 : null,
                // MK Real Money (same WC order base, neto/tax use rejection rate for consistency)
                mk_all_orders: data.mkAllOrders || 0,
                mk_all_gross: Math.round((data.mkAllGross || 0) * 100) / 100,
                mk_all_neto: Math.round((data.mkAllGross || 0) * (1 - rejectionRate) * 100) / 100,
                mk_all_tax: Math.round((data.mkAllGross || 0) * rejectionRate * 100) / 100,
                mk_paid_orders: data.mkPaidOrders || 0,
                mk_paid_gross: Math.round((data.mkPaidGross || 0) * 100) / 100,
                mk_paid_neto: Math.round((data.mkPaidGross || 0) * (1 - rejectionRate) * 100) / 100,
                mk_paid_tax: Math.round((data.mkPaidGross || 0) * rejectionRate * 100) / 100,
                // Payment method breakdown
                payment_cod: data.payment_cod || 0,
                payment_card: data.payment_card || 0,
                payment_paypal: data.payment_paypal || 0,
                payment_other: data.payment_other || 0
            };
        }
    }
    
    // Add MK Extra Paid orders (paid MK orders NOT in WooCommerce — customer center orders)
    for (const [buyerOrder, mkData] of Object.entries(mkOrderMap)) {
        if (processedWcOrders.has(buyerOrder)) continue; // Already in WC
        if (mkData.deleted) continue; // Deleted
        if (!mkData.paid) continue; // Not paid
        if (!mkData.date || !mkData.store) continue;
        const country = mkData.store;
        const date = mkData.date;
        if (!countries.includes(country)) continue;
        if (date < '2026-01-01') continue;
        
        if (!newData[date]) newData[date] = {};
        if (!newData[date][country]) {
            // Will be filled by FB spend below if needed
            newData[date][country] = {
                orders: 0, new: 0, returning: 0, new_orders: 0, ret_orders: 0,
                revenue_gross: 0, revenue_net: 0, revenue_gross_eur: 0, revenue_net_eur: 0,
                new_revenue_eur: 0, ret_revenue_eur: 0, effective_net_eur: 0,
                vat_rate: VAT_RATES[country] || 0, currency: config[country]?.currency || 'EUR',
                spend: 0, tshirts: 0, boxers: 0, socks: 0,
                product_cost: 0, effective_product_cost: 0, shipping_cost: 0, profit: 0,
                cpa: null, cpa_new: null, roas: null, rejection_rate: 0,
                mk_all_orders: 0, mk_all_gross: 0, mk_all_neto: 0, mk_all_tax: 0,
                mk_paid_orders: 0, mk_paid_gross: 0, mk_paid_neto: 0, mk_paid_tax: 0,
                mk_extra_paid_orders: 0, mk_extra_paid_gross: 0, mk_extra_paid_neto: 0, mk_extra_paid_tax: 0
            };
        }
        if (!newData[date][country].mk_extra_paid_orders) {
            newData[date][country].mk_extra_paid_orders = 0;
            newData[date][country].mk_extra_paid_gross = 0;
            newData[date][country].mk_extra_paid_neto = 0;
            newData[date][country].mk_extra_paid_tax = 0;
        }
        newData[date][country].mk_extra_paid_orders++;
        newData[date][country].mk_extra_paid_gross += mkData.gross || 0;
        newData[date][country].mk_extra_paid_neto += mkData.neto || 0;
        newData[date][country].mk_extra_paid_tax += mkData.tax || 0;
    }
    
    // Add FB spend for dates without orders (full sync)
    for (const [date, fbCountries] of Object.entries(fbByDate)) {
        dates.add(date);
        if (!newData[date]) newData[date] = {};
        for (const country of countries) {
            if (!newData[date][country] && fbCountries[country]) {
                const spend = fbCountries[country].spend || 0;
                newData[date][country] = {
                    orders: 0, new: 0, returning: 0, new_orders: 0, ret_orders: 0,
                    revenue_gross: 0, revenue_net: 0, revenue_gross_eur: 0, revenue_net_eur: 0,
                    new_revenue_eur: 0, ret_revenue_eur: 0,
                    vat_rate: VAT_RATES[country] || 0, currency: config[country].currency,
                    spend: Math.round(spend * 100) / 100,
                    tshirts: 0, boxers: 0, socks: 0, product_cost: 0, shipping_cost: 0,
                    profit: -Math.round(spend * 100) / 100,
                    cpa: null, cpa_new: null, roas: 0
                };
            }
        }
    }
    
    // Replace cache with full year data
    dataCache = {
        dates: [...dates].sort(),
        countries: countries,
        data: newData,
        lastUpdate: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
    };
    
    // OVERRIDE product counts with stock-data.json (single source of truth)
    const stockCounts = loadStockProductCounts();
    // Disabled product override - Dashboard now shows accurate per-country product counts
    // if (stockCounts) {
    //     const today = new Date().toISOString().split('T')[0];
    //     const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
    //     
    //     if (dataCache.data[today]) {
    //         overrideProductCounts(dataCache.data[today], stockCounts.today, 'today');
    //     }
    //     if (dataCache.data[yesterday]) {
    //         overrideProductCounts(dataCache.data[yesterday], stockCounts.yesterday, 'yesterday');
    //     }
    // }
    
    fullSyncCompleted = true;
    saveCache();
    saveCustomerHistory();
    
    // Save origin attribution data
    originData.generatedAt = new Date().toISOString();
    try { fs.writeFileSync(ORIGIN_DATA_FILE, JSON.stringify(originData)); } catch(e) { console.error('[ORIGIN] Save error:', e.message); }
    const originTotalFull = Object.values(originData.daily).reduce((sum, d) => sum + Object.values(d).reduce((s, c) => s + (c.total || 0), 0), 0);
    console.log('[ORIGIN] Data saved: ' + Object.keys(originData.daily).length + ' days, ' + originTotalFull + ' orders');
    
    // Save upsell data
    saveUpsellData();
    console.log('[UPSELL] Data saved: ' + Object.keys(upsellData.daily).length + ' days');
    
    const customerCounts = {};
    for (const c of countries) customerCounts[c] = Object.keys(customerHistory[c] || {}).length;
    
    console.log(`✅ Full year sync complete! ${dataCache.dates.length} days cached.`);
    
    // Regenerate stock-data.json so stock report stays in sync
    try {
        console.log('🔄 Regenerating stock-data.json...');
        await fetchSales();
        console.log('✅ stock-data.json regenerated');
    } catch (e) {
        console.error('⚠️ stock-data.json regeneration failed:', e.message);
    }
    
    return { ok: true, days: dataCache.dates.length, customers: customerCounts };
}

// Incremental sync - only recent days
async function syncRecent(daysBack = 7) {
    console.log(`🔄 Syncing last ${daysBack} days...`);
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
    
    // Fetch FB data in parallel (separate API)
    const fbData = await getFacebookAds(start, end);
    
    // Fetch WC orders sequentially (one country at a time to avoid API overload)
    const ordersByCountry = {};
    for (const c of countries) {
        try { ordersByCountry[c] = await getWooOrders(c, start, end); }
        catch (e) { console.error(`[Sync] WC orders error for ${c}:`, e.message); ordersByCountry[c] = []; }
    }
    
    // Fetch WC analytics orders sequentially
    const analyticsByCountry = {};
    for (const c of countries) {
        try { analyticsByCountry[c] = await getWooAnalyticsOrders(c, start, end); }
        catch (e) { console.error(`[Sync] WC analytics error for ${c}:`, e.message); analyticsByCountry[c] = []; }
    }
    
    // Build customer_type lookup from analytics
    const customerTypeLookup = {};
    for (const c of countries) {
        customerTypeLookup[c] = {};
        for (const order of analyticsByCountry[c]) {
            customerTypeLookup[c][order.order_id] = order.customer_type;
        }
    }
    
    // Process FB data
    const fbByDate = {};
    if (fbData.data) {
        for (const row of fbData.data) {
            const date = row.date_start, country = row.country;
            if (!countries.includes(country)) continue;
            if (!fbByDate[date]) fbByDate[date] = {};
            if (!fbByDate[date][country]) fbByDate[date][country] = { spend: 0 }; fbByDate[date][country].spend += parseFloat(row.spend || 0);
        }
    }
    
    const newData = {};
    
    // Clear origin + upsell data for dates being re-synced (avoid double-counting)
    // Only clear the specific country, not the entire date (preserves other countries)
    for (const c of countries) {
        for (const o of (ordersByCountry[c] || [])) {
            const d = o.date_created?.substring(0, 10);
            if (d && originData.daily[d] && originData.daily[d][c]) delete originData.daily[d][c];
            if (d && upsellData.daily[d] && upsellData.daily[d][c]) delete upsellData.daily[d][c];
        }
    }
    const dates = new Set();
    
    for (const country of countries) {
        const orders = filterTestOrders(ordersByCountry[country] || []);
        if (!Array.isArray(orders) || orders.length === 0) continue;
        
        const byDate = {};
        
        for (const order of orders) {
            const date = order.date_created?.substring(0, 10);
            if (!date) continue;
            dates.add(date);
            
            if (!byDate[date]) {
                byDate[date] = { 
                    orders: 0, revenue: 0, 
                    newCustomers: 0, returningCustomers: 0,
                    newOrders: 0, returningOrders: 0,
                    newRevenue: 0, returningRevenue: 0,
                    tshirts: 0, boxers: 0, socks: 0, shippingCost: 0, emails: new Set(),
                    mkAllOrders: 0, mkAllGross: 0, mkAllNeto: 0, mkAllTax: 0,
                    mkPaidOrders: 0, mkPaidGross: 0, mkPaidNeto: 0, mkPaidTax: 0,
                    mkAlignedGrossEur: 0, mkAlignedNewGrossEur: 0, mkAlignedRetGrossEur: 0,
                    // Payment method tracking
                    payment_cod: 0, payment_card: 0, payment_paypal: 0, payment_other: 0
                };
            }
            
            // Skip orders deleted in Metakocka
            const wcOrderNum2 = order.number || '';
            const mkInfo2 = mkOrderMap[wcOrderNum2];
            if (mkInfo2 && mkInfo2.deleted) continue;
            
            // Track MK Real Money
            if (mkInfo2) {
                byDate[date].mkAllOrders++;
                byDate[date].mkAllGross += mkInfo2.gross || 0;
                byDate[date].mkAllNeto += mkInfo2.neto || 0;
                byDate[date].mkAllTax += mkInfo2.tax || 0;
                if (mkInfo2.paid) {
                    byDate[date].mkPaidOrders++;
                    byDate[date].mkPaidGross += mkInfo2.gross || 0;
                    byDate[date].mkPaidNeto += mkInfo2.neto || 0;
                    byDate[date].mkPaidTax += mkInfo2.tax || 0;
                }
            }
            
            const email = order.billing?.email;
            const total = parseFloat(order.total || 0);
            
            byDate[date].orders++;

            // Payment method tracking
            const _pm = (order.payment_method || 'unknown').toLowerCase();
            if (_pm === 'cod') byDate[date].payment_cod++;
            else if (['stripe','bacs','stripe_cc','stripe_sepa'].includes(_pm)) byDate[date].payment_card++;
            else if (['ppcp-gateway','paypal','ppcp'].includes(_pm)) byDate[date].payment_paypal++;
            else byDate[date].payment_other++;            byDate[date].revenue += total;
            
            // Origin attribution (syncRecent)
            {
                const meta = {};
                for (const m of (order.meta_data || [])) meta[m.key] = m.value;
                const coupons = (order.coupon_lines || []).map(cl => cl.code);
                const source = classifySource(meta, coupons);
                if (!originData.daily[date]) originData.daily[date] = {};
                if (!originData.daily[date][country]) originData.daily[date][country] = { Facebook: 0, 'Google Organic': 0, 'Google Paid': 0, Klaviyo: 0, Direct: 0, 'Call Center': 0, total: 0, Mobile: 0, Desktop: 0, CatalogOrders: 0, wcByProduct: { shirts: 0, boxers: 0, starter: 0, kompleti: 0, catalog: 0 } };
                originData.daily[date][country][source]++;
                originData.daily[date][country].total++;
                const device = meta._wc_order_attribution_device_type || 'Desktop';
                if (device.toLowerCase().includes('mobile')) originData.daily[date][country].Mobile++;
                else originData.daily[date][country].Desktop++;
                const utmSrc2 = meta._wc_order_attribution_utm_source || '';
                if (source === 'Facebook' && utmSrc2.toLowerCase().includes('catalog')) {
                    originData.daily[date][country].CatalogOrders++;
                }
                // Classify order by product type for wcByProduct
                if (source === 'Facebook' && utmSrc2.toLowerCase().includes('catalog')) {
                    originData.daily[date][country].wcByProduct.catalog++;
                } else if (source === 'Facebook' || source === 'Direct') {
                    let orderTshirts2 = 0, orderBoxers2 = 0, orderStarter2 = false;
                    if (order.line_items) {
                        for (const item of order.line_items) {
                            const p = _sharedDetectProduct(item.name, true, item.meta_data, item.sku);
                            const qty = item.quantity || 1;
                            orderTshirts2 += (p.tshirts || 0) * qty;
                            orderBoxers2 += (p.boxers || 0) * qty;
                        }
                        for (const item of order.line_items) {
                            const ln = (item.name || '').toLowerCase();
                            if (ln.includes('starter') || ln.includes('start')) orderStarter2 = true;
                        }
                    }
                    let orderKomplet2 = false;
                    if (order.line_items) {
                        for (const item of order.line_items) {
                            const ln = (item.name || '').toLowerCase();
                            const sk = (item.sku || '').toLowerCase();
                            if (ln.includes('komplet') || sk.includes('bundle-shirt') || sk.includes('bundle-sh-box')) orderKomplet2 = true;
                        }
                    }
                    if (orderStarter2) originData.daily[date][country].wcByProduct.starter++;
                    else if (orderKomplet2) originData.daily[date][country].wcByProduct.kompleti++;
                    else {
                        const campId2 = meta._wc_order_attribution_utm_campaign || '';
                        const campName2 = (campaignNames[campId2] || '').toLowerCase();
                        if (campName2.includes('boxers') || campName2.includes('bokser')) {
                            originData.daily[date][country].wcByProduct.boxers++;
                        } else if (campName2.includes('majice') || campName2.includes('shirt') || campName2.includes('majic')) {
                            originData.daily[date][country].wcByProduct.shirts++;
                        } else if (campName2.includes('starter') || campName2.includes('start')) {
                            originData.daily[date][country].wcByProduct.starter++;
                        } else if (campName2.includes('2p5') || campName2.includes('komplet')) {
                            originData.daily[date][country].wcByProduct.kompleti++;
                        } else if (orderTshirts2 > 0) {
                            originData.daily[date][country].wcByProduct.shirts++;
                        } else if (orderBoxers2 > 0) {
                            originData.daily[date][country].wcByProduct.boxers++;
                        }
                    }
                }
            }
            
            // MK-aligned EUR: use MK gross (actual EUR invoice) when available, else WC conversion
            const orderGrossEur = (mkInfo2 && mkInfo2.gross) ? mkInfo2.gross : (total * config[country].rate);
            byDate[date].mkAlignedGrossEur += orderGrossEur;
            
            // Add shipping cost for this order (using country-specific cost)
            const orderShippingCost = shippingCosts[country] || 0;
            byDate[date].shippingCost += orderShippingCost;
            
            // Update customer history
            if (email) {
                updateCustomerHistory(country, email, date, total);
            }
            
            if (order.line_items) {
                for (const item of order.line_items) {
                    const product = detectProduct(item.name, true, item.meta_data, item.sku);
                    const lineQty = item.quantity || 1;
                    byDate[date].tshirts += (product.tshirts || 0) * lineQty;
                    byDate[date].boxers += (product.boxers || 0) * lineQty;
                    byDate[date].socks += (product.socks || 0) * lineQty;
                }
            }
            
            // Upsell tracking — extract _noriks_upsell meta from line items (syncRecent)
            {
                if (!upsellData.daily[date]) upsellData.daily[date] = {};
                if (!upsellData.daily[date][country]) upsellData.daily[date][country] = { orders: 0, upsellOrders: 0, upsellRevenue: 0, byType: {} };
                upsellData.daily[date][country].orders++;
                let _orderHasUpsell = false;
                const _upsellMetas = (order.line_items || []).map(i => (i.meta_data || []).filter(m => m.key === '_noriks_upsell').length).reduce((a,b) => a+b, 0);
                if (_upsellMetas > 0) console.log('[UPSELL-FOUND] order', order.id, 'country', country, 'upsell_items:', _upsellMetas);
                for (const _item of (order.line_items || [])) {
                    const _uMeta = (_item.meta_data || []).find(m => m.key === '_noriks_upsell');
                    if (_uMeta) {
                        const _utype = _uMeta.value || 'unknown';
                        const _itemEur = parseFloat(_item.total || 0) * config[country].rate;
                        const _qty = parseInt(_item.quantity || 1);
                        if (!upsellData.daily[date][country].byType[_utype]) upsellData.daily[date][country].byType[_utype] = { count: 0, revenue: 0, qty: 0 };
                        upsellData.daily[date][country].byType[_utype].count++;
                        upsellData.daily[date][country].byType[_utype].qty += _qty;
                        upsellData.daily[date][country].byType[_utype].revenue += _itemEur;
                        upsellData.daily[date][country].upsellRevenue += _itemEur;
                        _orderHasUpsell = true;
                    }
                }
                if (_orderHasUpsell) upsellData.daily[date][country].upsellOrders++;
            }
            
            // Use WooCommerce customer_type from analytics API
            const orderId = order.id;
            const customerType = customerTypeLookup[country][orderId] || 'new';
            const isRet = customerType === 'returning';
            
            if (isRet) {
                byDate[date].returningOrders++;
                byDate[date].returningRevenue += total;
                byDate[date].mkAlignedRetGrossEur += orderGrossEur;
            } else {
                byDate[date].newOrders++;
                byDate[date].newRevenue += total;
                byDate[date].mkAlignedNewGrossEur += orderGrossEur;
            }
            
            // Unique customers per day
            if (email && !byDate[date].emails.has(email.toLowerCase())) {
                byDate[date].emails.add(email.toLowerCase());
                if (isRet) {
                    byDate[date].returningCustomers++;
                } else {
                    byDate[date].newCustomers++;
                }
            }
        }
        
        for (const [date, data] of Object.entries(byDate)) {
            if (!newData[date]) newData[date] = {};
            
            const spend = fbByDate[date]?.[country]?.spend || 0;
            const vatRate = VAT_RATES[country] || 0;
            const rejectionRate = (rejectionRates[country] || 0) / 100;
            
            // Original gross revenue (use MK-aligned EUR when available for consistency)
            const revenueGross = data.revenue;
            const revenueGrossEur = data.mkAlignedGrossEur || (revenueGross * config[country].rate);
            
            // Apply rejection rate to gross revenue BEFORE VAT
            const effectiveGrossEur = revenueGrossEur * (1 - rejectionRate);
            const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
            
            // Original net (for display purposes)
            const revenueNetEur = revenueGrossEur / (1 + vatRate);
            const revenueNet = revenueGross / (1 + vatRate);
            
            // Revenue split by customer type (using MK-aligned EUR + effective rates)
            const newGrossEur = data.mkAlignedNewGrossEur || (data.newRevenue * config[country].rate);
            const retGrossEur = data.mkAlignedRetGrossEur || (data.returningRevenue * config[country].rate);
            const newRevenueEur = newGrossEur * (1 - rejectionRate) / (1 + vatRate);
            const retRevenueEur = retGrossEur * (1 - rejectionRate) / (1 + vatRate);
            
            // Product cost - apply rejection rate (we get products back for rejected orders)
            const productCost = (data.tshirts * PRODUCT_COSTS.tshirt) + (data.boxers * PRODUCT_COSTS.boxers);
            const effectiveProductCost = productCost * (1 - rejectionRate);
            
            // Shipping stays at 100% (we pay for all shipments including rejected)
            const shippingCost = data.shippingCost || 0;
            
            // Profit = Effective Net Revenue - FB Spend - Effective Product Cost - Full Shipping
            const profit = effectiveNetEur - spend - effectiveProductCost - shippingCost;
            
            newData[date][country] = {
                orders: data.orders,
                new: data.newOrders,
                returning: data.returningOrders,
                new_orders: data.newOrders,
                ret_orders: data.returningOrders,
                revenue_gross: Math.round(revenueGross * 100) / 100,
                revenue_net: Math.round(revenueNet * 100) / 100,
                revenue_gross_eur: Math.round(revenueGrossEur * 100) / 100,
                revenue_net_eur: Math.round(revenueNetEur * 100) / 100,
                effective_net_eur: Math.round(effectiveNetEur * 100) / 100,
                new_revenue_eur: Math.round(newRevenueEur * 100) / 100,
                ret_revenue_eur: Math.round(retRevenueEur * 100) / 100,
                vat_rate: vatRate,
                rejection_rate: rejectionRate,
                currency: config[country].currency,
                spend: Math.round(spend * 100) / 100,
                tshirts: data.tshirts,
                boxers: data.boxers,
                socks: data.socks || 0,
                product_cost: Math.round(productCost * 100) / 100,
                effective_product_cost: Math.round(effectiveProductCost * 100) / 100,
                shipping_cost: Math.round(shippingCost * 100) / 100,
                profit: Math.round(profit * 100) / 100,
                cpa: data.orders > 0 ? Math.round(spend / data.orders * 100) / 100 : null,
                cpa_new: data.newOrders > 0 ? Math.round(spend / data.newOrders * 100) / 100 : null,
                roas: spend > 0 ? Math.round(revenueGrossEur / spend * 100) / 100 : null,
                mk_all_orders: data.mkAllOrders || 0,
                mk_all_gross: Math.round((data.mkAllGross || 0) * 100) / 100,
                mk_all_neto: Math.round((data.mkAllGross || 0) * (1 - rejectionRate) * 100) / 100,
                mk_all_tax: Math.round((data.mkAllGross || 0) * rejectionRate * 100) / 100,
                mk_paid_orders: data.mkPaidOrders || 0,
                mk_paid_gross: Math.round((data.mkPaidGross || 0) * 100) / 100,
                mk_paid_neto: Math.round((data.mkPaidGross || 0) * (1 - rejectionRate) * 100) / 100,
                mk_paid_tax: Math.round((data.mkPaidGross || 0) * rejectionRate * 100) / 100,
                // Payment method breakdown
                payment_cod: data.payment_cod || 0,
                payment_card: data.payment_card || 0,
                payment_paypal: data.payment_paypal || 0,
                payment_other: data.payment_other || 0
            };
        }
    }
    
    // Add FB spend for dates without orders (incremental sync)
    for (const [date, fbCountries] of Object.entries(fbByDate)) {
        dates.add(date);
        if (!newData[date]) newData[date] = {};
        for (const country of countries) {
            if (!newData[date][country] && fbCountries[country]) {
                const spend = fbCountries[country].spend || 0;
                newData[date][country] = {
                    orders: 0, new: 0, returning: 0, new_orders: 0, ret_orders: 0,
                    revenue_gross: 0, revenue_net: 0, revenue_gross_eur: 0, revenue_net_eur: 0,
                    new_revenue_eur: 0, ret_revenue_eur: 0,
                    vat_rate: VAT_RATES[country] || 0, currency: config[country].currency,
                    spend: Math.round(spend * 100) / 100,
                    tshirts: 0, boxers: 0, socks: 0, product_cost: 0, shipping_cost: 0,
                    profit: -Math.round(spend * 100) / 100,
                    cpa: null, cpa_new: null, roas: 0
                };
            }
        }
    }
    
    // Merge with existing cache
    for (const [date, countries] of Object.entries(newData)) {
        dataCache.data[date] = { ...dataCache.data[date], ...countries };
    }
    dataCache.dates = [...new Set([...dataCache.dates, ...dates])].sort();
    dataCache.lastUpdate = new Date().toISOString();
    
    // Disabled product override - Dashboard now shows accurate per-country product counts
    // const stockCounts = loadStockProductCounts();
    // if (stockCounts) {
    //     const today = new Date().toISOString().split('T')[0];
    //     const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
    //     
    //     if (dataCache.data[today]) {
    //         overrideProductCounts(dataCache.data[today], stockCounts.today, 'today');
    //     }
    //     if (dataCache.data[yesterday]) {
    //         overrideProductCounts(dataCache.data[yesterday], stockCounts.yesterday, 'yesterday');
    //     }
    // }
    
    saveCache();
    saveCustomerHistory();
    
    // Save origin attribution data
    originData.generatedAt = new Date().toISOString();
    try { fs.writeFileSync(ORIGIN_DATA_FILE, JSON.stringify(originData)); } catch(e) { console.error('[ORIGIN] Save error:', e.message); }
    const originTotal = Object.values(originData.daily).reduce((sum, d) => sum + Object.values(d).reduce((s, c) => s + (c.total || 0), 0), 0);
    console.log('[ORIGIN] Data updated: ' + Object.keys(originData.daily).length + ' days, ' + originTotal + ' orders');
    
    // Save upsell data
    saveUpsellData();
    console.log('[UPSELL] Data updated: ' + Object.keys(upsellData.daily).length + ' days');
    
    console.log(`✅ Recent sync complete. Cache now has ${dataCache.dates.length} days.`);
    
    // Regenerate stock-data.json so stock report stays in sync
    try {
        console.log('🔄 Regenerating stock-data.json...');
        await fetchSales();
        console.log('✅ stock-data.json regenerated');
    } catch (e) {
        console.error('⚠️ stock-data.json regeneration failed:', e.message);
    }
}

function getCachedData(start, end) {
    const result = { dates: [], countries: ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'], data: {}, lastUpdate: dataCache.lastUpdate, lastFullSync: dataCache.lastFullSync };
    if (!dataCache.dates || !Array.isArray(dataCache.dates)) return result;
    for (const date of dataCache.dates) {
        if (date >= start && date <= end && dataCache.data[date]) {
            result.dates.push(date);
            result.data[date] = dataCache.data[date];
        }
    }
    return result;
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const isAdvertiserPrefix = parsed.pathname.startsWith('/advertiser');
    const pathname = isAdvertiserPrefix ? parsed.pathname.replace(/^\/advertiser/, '') : parsed.pathname.replace(/^\/dashboard/, '');
    
    // Login endpoint - no auth required
    if (pathname === '/api/login' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                const users = loadUsers();
                const user = users.find(u => u.username === username);
                
                if (user && user.passwordHash === hashPassword(password)) {
                    const token = createSession(username, user.role || 'admin');
                    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
                    res.end(JSON.stringify({ ok: true, username, role: user.role || 'admin' }));
                } else {
                    res.statusCode = 401;
                    res.end(JSON.stringify({ ok: false, error: 'Invalid username or password' }));
                }
            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
            }
        });
        return;
    }
    
    // Current user info
    if (pathname === '/api/me') {
        const session = getSession(req);
        res.setHeader('Content-Type', 'application/json');
        if (session) {
            res.end(JSON.stringify({ username: session.username, role: session.role || 'admin' }));
        } else {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        return;
    }

    // Users CRUD (admin only)
    if (pathname === '/api/users') {
        const session = getSession(req);
        res.setHeader('Content-Type', 'application/json');
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        if ((session.role || 'admin') !== 'admin') { res.statusCode = 403; res.end(JSON.stringify({ error: 'Forbidden' })); return; }

        if (req.method === 'GET') {
            const users = loadUsers().map(u => ({ username: u.username, role: u.role || 'admin', createdAt: u.createdAt }));
            res.end(JSON.stringify({ users }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const users = loadUsers();

                if (req.method === 'POST') {
                    // Add user
                    if (!data.username || !data.password || !data.role) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing fields' })); return; }
                    if (users.find(u => u.username === data.username)) { res.statusCode = 409; res.end(JSON.stringify({ error: 'User already exists' })); return; }
                    users.push({ username: data.username, passwordHash: hashPassword(data.password), role: data.role, createdAt: new Date().toISOString() });
                    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
                    res.end(JSON.stringify({ ok: true }));
                } else if (req.method === 'PUT') {
                    // Update user
                    const user = users.find(u => u.username === data.username);
                    if (!user) { res.statusCode = 404; res.end(JSON.stringify({ error: 'User not found' })); return; }
                    if (data.role) user.role = data.role;
                    if (data.password) user.passwordHash = hashPassword(data.password);
                    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
                    res.end(JSON.stringify({ ok: true }));
                } else if (req.method === 'DELETE') {
                    const idx = users.findIndex(u => u.username === data.username);
                    if (idx === -1) { res.statusCode = 404; res.end(JSON.stringify({ error: 'User not found' })); return; }
                    if (data.username === session.username) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Cannot delete yourself' })); return; }
                    users.splice(idx, 1);
                    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.statusCode = 405;
                    res.end(JSON.stringify({ error: 'Method not allowed' }));
                }
            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
        return;
    }

    // Logout endpoint
    if (pathname === '/api/logout') {
        destroySession(req);
        res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    
    // Login page - no auth required
    if (pathname === '/login' || pathname === '/login.html') {
        const session = getSession(req);
        if (session) {
            // Already logged in, redirect to dashboard
            const redirectTo = isAdvertiserPrefix ? '/advertiser/' : '/';
            res.writeHead(302, { Location: redirectTo });
            res.end();
            return;
        }
        const loginPath = path.join(__dirname, 'login.html');
        fs.readFile(loginPath, 'utf8', (err, content) => {
            if (err) { res.statusCode = 500; res.end('Error loading login page'); return; }
            // Fix asset paths for advertiser prefix
            if (isAdvertiserPrefix) {
                content = content.replace(/href="\/dashboard\//g, 'href="/advertiser/');
                content = content.replace(/src="\/dashboard\//g, 'src="/advertiser/');
                content = content.replace("redirect || '/dashboard/'", "redirect || '/advertiser/'");
                content = content.replace("'/dashboard/api/login'", "'/advertiser/api/login'");
            }
            res.setHeader('Content-Type', 'text/html');
            res.end(content);
        });
        return;
    }
    
    // Serve static assets without auth (CSS, JS)
    const ext = path.extname(pathname);
    if (ext === '.css' || ext === '.js') {
        const assetPath = path.join(__dirname, pathname);
        fs.readFile(assetPath, (err, content) => {
            if (err) { res.statusCode = 404; res.end('Not found'); return; }
            res.setHeader('Content-Type', ext === '.css' ? 'text/css' : 'application/javascript');
            res.end(content);
        });
        return;
    }
    
    // Auth check for all other routes (except /api/sync and /api/purchasing which can be called internally)
    const session = getSession(req);
    if (!session && pathname !== '/api/sync' && pathname !== '/api/purchasing' && pathname !== '/dashboard/api/purchasing' && pathname !== '/api/hr-tracking' && pathname !== '/api/expedico-tracking' && pathname !== '/api/local-tracking' && pathname !== '/api/cs-notes') {
        // Not authenticated - redirect to login for HTML, 401 for API
        if (pathname.startsWith('/api/')) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
        } else {
            const loginPath = isAdvertiserPrefix ? '/advertiser/login?redirect=/advertiser/' : '/dashboard/login';
            res.writeHead(302, { Location: loginPath });
            res.end();
        }
        return;
    }

    // Role-based access control
    if (session) {
        const role = session.role || 'admin';
        const advertiserPages = ['/advertiser.html', '/origin.html'];
        const advertiserAPIs = ['/api/advertiser-data', '/api/origin-data'];
        const warehousePages = ['/stock-report.html', '/stock-arrivals.html', '/purchasing.html', '/rejection-report.html', '/rejections.html', '/live-events.html', '/shipping-speed.html', '/skus.html', '/shipping.html'];
        const warehouseAPIs = ['/api/stock', '/api/stock-arrivals', '/api/purchasing', '/api/rejections', '/api/rejection-report', '/api/shipping-speed', '/api/shipping-costs', '/api/skus', '/api/live-events', '/api/live-events/resolve', '/api/in-transit-orders', '/api/live-events/refresh', '/api/hr-tracking', '/api/expedico-tracking', '/api/local-tracking', '/api/cs-notes'];

        if (role === 'advertiser') {
            const isAllowed = pathname === '/' || pathname === '' || pathname === '/index.html' ||
                advertiserPages.some(p => pathname.endsWith(p)) || advertiserAPIs.some(a => pathname.includes(a)) ||
                pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.json') || pathname === '/api/me' || pathname === '/api/logout';
            if (!isAllowed) {
                if (pathname.startsWith('/api/')) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Forbidden' })); }
                else { res.writeHead(302, { Location: isAdvertiserPrefix ? '/advertiser/' : '/dashboard/advertiser.html' }); res.end(); }
                return;
            }
        } else if (role === 'warehouse') {
            const isAllowed = pathname === '/' || pathname === '' || pathname === '/index.html' ||
                warehousePages.some(p => pathname.endsWith(p)) || warehouseAPIs.some(a => pathname.includes(a)) ||
                pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.json') || pathname === '/api/me' || pathname === '/api/logout';
            if (!isAllowed) {
                if (pathname.startsWith('/api/')) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Forbidden' })); }
                else { res.writeHead(302, { Location: isAdvertiserPrefix ? '/advertiser/' : '/dashboard/stock-report.html' }); res.end(); }
                return;
            }
        }
    }
    
    if (pathname === '/api/data') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        res.end(JSON.stringify(getCachedData(parsed.query.start || weekAgo, parsed.query.end || today)));
        return;
    }
    
    if (pathname === '/api/metakocka') {
        res.setHeader('Content-Type', 'application/json');
        try {
            const mkData = JSON.parse(fs.readFileSync(path.join(__dirname, 'metakocka-data.json'), 'utf8'));
            const start = parsed.query.start;
            const end = parsed.query.end;
            if (!start || !end) { res.end(JSON.stringify(mkData)); return; }
            const filtered = {};
            for (const [date, countries] of Object.entries(mkData.data || {})) {
                if (date >= start && date <= end) filtered[date] = countries;
            }
            res.end(JSON.stringify({ lastSync: mkData.lastSync, data: filtered }));
        } catch (e) {
            res.end(JSON.stringify({ lastSync: null, data: {} }));
        }
        return;
    }
    
    if (pathname === '/api/sync') {
        res.setHeader('Content-Type', 'application/json');
        const days = parseInt(parsed.query.days);
        if (parsed.query.full === 'true' || days >= 365) {
            syncFullYear().then(result => res.end(JSON.stringify(result))).catch(e => res.end(JSON.stringify({ error: e.message })));
        } else {
            syncRecent(days || 7).then(() => res.end('{"ok":true}')).catch(e => res.end(JSON.stringify({ error: e.message })));
        }
        return;
    }
    
    // Origin Report API — order attribution by source
    if (pathname === '/api/origin-data') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        const start = parsed.query.start || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
        const end = parsed.query.end || new Date().toISOString().split('T')[0];
        
        // Serve entirely from origin-data.json — ZERO WooCommerce API calls
        const daily = {};
        const byCountry = {};
        const deviceSplit = { Mobile: 0, Desktop: 0, Tablet: 0 };
        let total = 0;
        const SOURCES = ['Facebook', 'Google Organic', 'Google Paid', 'Klaviyo', 'Direct', 'Call Center'];
        const emptyRow = () => ({ Facebook: 0, 'Google Organic': 0, 'Google Paid': 0, Klaviyo: 0, Direct: 0, 'Call Center': 0, total: 0 });

        for (const [date, countries] of Object.entries(originData.daily || {})) {
            if (date < start || date > end) continue;
            if (!daily[date]) daily[date] = emptyRow();
            for (const [c, counts] of Object.entries(countries)) {
                if (!byCountry[c]) byCountry[c] = emptyRow();
                for (const src of SOURCES) {
                    const v = counts[src] || 0;
                    daily[date][src] += v;
                    byCountry[c][src] += v;
                }
                daily[date].total += counts.total || 0;
                byCountry[c].total += counts.total || 0;
                total += counts.total || 0;
                deviceSplit.Mobile += counts.Mobile || 0;
                deviceSplit.Desktop += counts.Desktop || 0;
            }
        }

        const totals = { ...emptyRow(), total };
        for (const c of Object.values(byCountry)) {
            for (const src of SOURCES) totals[src] += c[src];
        }

        res.end(JSON.stringify({ daily, byCountry, totals, deviceSplit, start, end, generatedAt: originData.generatedAt }));
        return;
    }
    
    // Upsell Report API — serves entirely from upsell-data.json cache (ZERO WC API calls)
    // Force sync today — triggers syncRecent for fresh upsell data
    if (pathname === '/api/force-sync-today') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        try {
            console.log('[FORCE-SYNC] Manual sync triggered');
            await syncRecent(1); // Sync last 1 day
            res.end(JSON.stringify({ ok: true }));
        } catch(e) {
            console.error('[FORCE-SYNC] Error:', e.message);
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }
    
    if (pathname === '/api/upsell-report') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        const start = parsed.query.start || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
        const end = parsed.query.end || new Date().toISOString().split('T')[0];
        
        const results = {};
        const countries = Object.keys(config);
        
        for (const country of countries) {
            let totalOrders = 0, upsellOrders = 0, upsellRevenue = 0;
            const byType = {};
            const daily = {};
            
            for (const [date, dateCountries] of Object.entries(upsellData.daily || {})) {
                if (date < start || date > end) continue;
                const c = dateCountries[country];
                if (!c) continue;
                
                totalOrders += c.orders || 0;
                upsellOrders += c.upsellOrders || 0;
                upsellRevenue += c.upsellRevenue || 0;
                
                daily[date] = { orders: c.orders || 0, upsellOrders: c.upsellOrders || 0, upsellRevenue: c.upsellRevenue || 0, byType: c.byType || {} };
                
                for (const [t, v] of Object.entries(c.byType || {})) {
                    if (!byType[t]) byType[t] = { count: 0, revenue: 0, qty: 0 };
                    byType[t].count += v.count || 0;
                    byType[t].qty += v.qty || v.count || 0;
                    byType[t].revenue += v.revenue || 0;
                }
            }
            
            results[country] = {
                totalOrders,
                upsellOrders,
                upsellRevenue: Math.round(upsellRevenue * 100) / 100,
                conversionRate: totalOrders > 0 ? Math.round((upsellOrders / totalOrders) * 10000) / 100 : 0,
                byType,
                daily
            };
        }
        
        // Calculate totals
        let grandTotalOrders = 0, grandUpsellOrders = 0, grandUpsellRevenue = 0;
        const grandByType = {};
        for (const c of Object.values(results)) {
            grandTotalOrders += c.totalOrders;
            grandUpsellOrders += c.upsellOrders;
            grandUpsellRevenue += c.upsellRevenue;
            for (const [t, v] of Object.entries(c.byType)) {
                if (!grandByType[t]) grandByType[t] = { count: 0, revenue: 0, qty: 0 };
                grandByType[t].count += v.count;
                grandByType[t].qty += v.qty || v.count;
                grandByType[t].revenue += v.revenue;
            }
        }
        
        res.end(JSON.stringify({
            start, end,
            totals: {
                totalOrders: grandTotalOrders,
                upsellOrders: grandUpsellOrders,
                upsellRevenue: Math.round(grandUpsellRevenue * 100) / 100,
                conversionRate: grandTotalOrders > 0 ? Math.round((grandUpsellOrders / grandTotalOrders) * 10000) / 100 : 0,
                byType: grandByType
            },
            byCountry: results,
            generatedAt: upsellData.generatedAt
        }));
        return;
    }
    
    // FB Conversion Rate Report API — serves from fb-cr-cache.json (synced on startup + hourly)
    if (pathname === '/api/fb-cr') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        
        const start = parsed.query.start || '2026-01-01';
        const end = parsed.query.end || new Date().toISOString().split('T')[0];
        const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
        
        // Serve from cache
        const dailyFiltered = {};
        const countryTotals = {};
        for (const c of countries) countryTotals[c] = { impressions: 0, clicks: 0, link_clicks: 0, landing_page_views: 0, add_to_cart: 0, initiate_checkout: 0, purchases: 0, spend: 0, view_content: 0 };
        
        const dates = [];
        for (const [date, cData] of Object.entries(fbCrCache.daily || {})) {
            if (date < start || date > end) continue;
            dates.push(date);
            dailyFiltered[date] = cData;
            for (const [c, d] of Object.entries(cData)) {
                if (!countryTotals[c]) continue;
                const ct = countryTotals[c];
                ct.impressions += d.impressions || 0;
                ct.clicks += d.clicks || 0;
                ct.link_clicks += d.link_clicks || 0;
                ct.landing_page_views += d.landing_page_views || 0;
                ct.add_to_cart += d.add_to_cart || 0;
                ct.initiate_checkout += d.initiate_checkout || 0;
                ct.purchases += d.purchases || 0;
                ct.spend += d.spend || 0;
                ct.view_content += d.view_content || 0;
            }
        }
        
        function calcCR(d) {
            return {
                ...d,
                spend: Math.round((d.spend || 0) * 100) / 100,
                cr_click: d.link_clicks > 0 ? Math.round(d.purchases / d.link_clicks * 10000) / 100 : 0,
                cr_landing: d.landing_page_views > 0 ? Math.round(d.purchases / d.landing_page_views * 10000) / 100 : 0,
                cr_view: d.view_content > 0 ? Math.round(d.purchases / d.view_content * 10000) / 100 : 0,
                cr_atc: d.add_to_cart > 0 ? Math.round(d.purchases / d.add_to_cart * 10000) / 100 : 0,
                cr_checkout: d.initiate_checkout > 0 ? Math.round(d.purchases / d.initiate_checkout * 10000) / 100 : 0,
                ctr: d.impressions > 0 ? Math.round(d.link_clicks / d.impressions * 10000) / 100 : 0,
                cpc: d.link_clicks > 0 ? Math.round(d.spend / d.link_clicks * 100) / 100 : 0,
                cpa: d.purchases > 0 ? Math.round(d.spend / d.purchases * 100) / 100 : null
            };
        }
        
        const dailyProcessed = {};
        for (const [date, cData] of Object.entries(dailyFiltered)) {
            dailyProcessed[date] = {};
            for (const [c, d] of Object.entries(cData)) dailyProcessed[date][c] = calcCR(d);
        }
        const countryProcessed = {};
        for (const [c, d] of Object.entries(countryTotals)) countryProcessed[c] = calcCR(d);
        
        const grand = { impressions: 0, clicks: 0, link_clicks: 0, landing_page_views: 0, add_to_cart: 0, initiate_checkout: 0, purchases: 0, spend: 0, view_content: 0 };
        for (const d of Object.values(countryTotals)) { for (const k of Object.keys(grand)) grand[k] += d[k]; }
        
        res.end(JSON.stringify({
            start, end,
            totals: calcCR(grand),
            byCountry: countryProcessed,
            daily: dailyProcessed,
            dates: dates.sort(),
            generatedAt: fbCrCache.lastUpdate
        }));
        return;
    }
    
    if (pathname === '/api/status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            cachedDays: dataCache.dates.length,
            lastUpdate: dataCache.lastUpdate,
            lastFullSync: dataCache.lastFullSync,
            fullSyncCompleted,
            customers: {
                HR: Object.keys(customerHistory.HR).length,
                CZ: Object.keys(customerHistory.CZ).length,
                PL: Object.keys(customerHistory.PL).length
            }
        }));
        return;
    }
    
    // SKU Management API
    if (pathname === '/api/skus') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (req.method === 'GET') {
            const days = parseInt(parsed.query.days) || 30;
            const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const end = new Date().toISOString().split('T')[0];
            
            const allCountries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
            Promise.all(allCountries.map(c => getWooOrders(c, start, end))).then((ordersArrays) => {
                const products = {};
                const allOrders = filterTestOrders(ordersArrays.flat().filter(Boolean));
                
                for (const order of allOrders) {
                    if (!order.line_items) continue;
                    for (const item of order.line_items) {
                        const name = item.name;
                        if (!products[name]) {
                            const detected = detectProduct(name, false, item.meta_data, item.sku);
                            const override = skuOverrides[name];
                            const effective = override || detected;
                            const cost = (effective.tshirts || 0) * PRODUCT_COSTS.tshirt + (effective.boxers || 0) * PRODUCT_COSTS.boxers;
                            products[name] = { name, sku: item.sku, count: 0, autoDetect: detected, override: override || null, cost };
                        }
                        products[name].count += item.quantity || 1;
                    }
                }
                
                const sorted = Object.values(products).sort((a, b) => b.count - a.count);
                res.end(JSON.stringify({ products: sorted, costs: PRODUCT_COSTS }));
            }).catch(e => res.end(JSON.stringify({ error: e.message })));
            return;
        }
        
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const { name, tshirts, boxers } = data;
                    if (name && (tshirts !== undefined || boxers !== undefined)) {
                        skuOverrides[name] = { tshirts: parseInt(tshirts) || 0, boxers: parseInt(boxers) || 0 };
                        saveSkuOverrides();
                        res.end(JSON.stringify({ ok: true, override: skuOverrides[name] }));
                    } else {
                        res.end(JSON.stringify({ error: 'Missing name, tshirts, or boxers' }));
                    }
                } catch (e) { res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }
        
        if (req.method === 'DELETE') {
            const name = parsed.query.name;
            if (name && skuOverrides[name]) {
                delete skuOverrides[name];
                saveSkuOverrides();
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.end(JSON.stringify({ error: 'Override not found' }));
            }
            return;
        }
    }
    
    // Creatives Performance API
    if (pathname === '/api/creatives') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        const year = parseInt(parsed.query.year) || new Date().getFullYear();
        const month = parseInt(parsed.query.month); // 1-12, optional
        
        // Calculate date range
        let start, end;
        if (month) {
            start = `${year}-${String(month).padStart(2, '0')}-01`;
            const lastDay = new Date(year, month, 0).getDate();
            end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
        } else {
            start = `${year}-01-01`;
            end = `${year}-12-31`;
        }
        
        // Don't go past today
        const today = new Date().toISOString().split('T')[0];
        if (end > today) end = today;
        
        // Fetch ad-level insights from Meta
        const params = new URLSearchParams({
            access_token: FB_TOKEN,
            time_range: JSON.stringify({ since: start, until: end }),
            fields: 'ad_name,spend,actions',
            level: 'ad',
            limit: 5000
        });
        
        let allData = [];
        
        const fetchAll = async () => {
            allData = await fetchAllAccountInsights(params);
        };
        
        fetchAll().then(() => {
            // Creator mapping
            const creators = {
                'TK': { name: 'Teja Klinar', initials: 'TK' },
                'GP': { name: 'Grega Povhe', initials: 'GP' },
                'DM': { name: 'Dusan Mojsilovic', initials: 'DM' }
            };
            
            // Parse creatives
            const creatives = {};
            const creatorStats = {};
            
            for (const row of allData) {
                const adName = row.ad_name || '';
                const spend = parseFloat(row.spend || 0);
                
                // Extract purchases from actions
                let purchases = 0;
                if (row.actions) {
                    for (const action of row.actions) {
                        if (action.action_type === 'purchase' || action.action_type === 'omni_purchase') {
                            purchases += parseInt(action.value || 0);
                        }
                    }
                }
                
                // Extract creator initials from ad name
                // Patterns: ends with "-TK" or "_TK", or contains "_TK_" in the middle
                let creatorInitials = 'UNKNOWN';
                const endMatch = adName.match(/[-_](TK|GP|DM)$/i);
                const midMatch = adName.match(/[-_](TK|GP|DM)[-_]/i);
                if (endMatch) {
                    creatorInitials = endMatch[1].toUpperCase();
                } else if (midMatch) {
                    creatorInitials = midMatch[1].toUpperCase();
                }
                
                // Aggregate by ad name (creative)
                if (!creatives[adName]) {
                    creatives[adName] = {
                        name: adName,
                        creator: creatorInitials,
                        creatorName: creators[creatorInitials]?.name || 'Unknown',
                        spend: 0,
                        purchases: 0,
                        successful: false
                    };
                }
                creatives[adName].spend += spend;
                creatives[adName].purchases += purchases;
            }
            
            // Mark successful creatives (2+ purchases)
            for (const creative of Object.values(creatives)) {
                creative.successful = creative.purchases >= 2;
                creative.spend = Math.round(creative.spend * 100) / 100;
            }
            
            // Calculate stats per creator (exclude UNKNOWN)
            for (const initials of ['TK', 'GP', 'DM']) {
                const creatorCreatives = Object.values(creatives).filter(c => c.creator === initials);
                const total = creatorCreatives.length;
                const successful = creatorCreatives.filter(c => c.successful).length;
                const successRate = total > 0 ? (successful / total) * 100 : 0;
                
                // Calculate bonus based on tier
                let bonusPerPiece = 0;
                if (successRate >= 100) bonusPerPiece = 10;
                else if (successRate >= 90) bonusPerPiece = 10;
                else if (successRate >= 80) bonusPerPiece = 10;
                else if (successRate >= 70) bonusPerPiece = 10;
                else if (successRate >= 60) bonusPerPiece = 5;
                else if (successRate >= 50) bonusPerPiece = 5;
                else if (successRate >= 40) bonusPerPiece = 5;
                else if (successRate >= 30) bonusPerPiece = 3.5;
                else if (successRate >= 20) bonusPerPiece = 3;
                else if (successRate >= 15) bonusPerPiece = 2;
                // Below 15% = 0
                
                const totalBonus = Math.round(successful * bonusPerPiece * 100) / 100;
                
                creatorStats[initials] = {
                    initials,
                    name: creators[initials]?.name || 'Unknown',
                    total,
                    successful,
                    successRate: Math.round(successRate * 10) / 10,
                    bonusPerPiece,
                    totalBonus
                };
            }
            
            // Filter out UNKNOWN creatives from the list
            const filteredCreatives = Object.values(creatives).filter(c => c.creator !== 'UNKNOWN');
            
            res.end(JSON.stringify({
                period: { year, month, start, end },
                creatives: filteredCreatives.sort((a, b) => b.purchases - a.purchases),
                creatorStats,
                bonusTiers: [
                    { minPercent: 15, bonus: 2 },
                    { minPercent: 20, bonus: 3 },
                    { minPercent: 30, bonus: 3.5 },
                    { minPercent: 40, bonus: 5 },
                    { minPercent: 50, bonus: 5 },
                    { minPercent: 60, bonus: 5 },
                    { minPercent: 70, bonus: 10 },
                    { minPercent: 80, bonus: 10 },
                    { minPercent: 90, bonus: 10 },
                    { minPercent: 100, bonus: 10 }
                ]
            }));
        }).catch(e => {
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }
    
    // STARTER-specific data API (SKU=ORTO-STARTER, campaigns with "starter" in name)
    if (pathname === '/api/starter-data') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        
        const start = parsed.query.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const end = parsed.query.end || new Date().toISOString().split('T')[0];
        
        console.log('[STARTER API] Request received, start=' + start + ', end=' + end);
        
        // Fetch campaign-level Facebook data with "starter" filter
        async function getStarterCampaignSpend(start, end) {
            const params = new URLSearchParams({
                access_token: FB_TOKEN,
                time_range: JSON.stringify({ since: start, until: end }),
                fields: 'campaign_name,spend,date_start',
                breakdowns: 'country',
                level: 'campaign',
                time_increment: 1,
                limit: 5000
            });
            
            let allData = await fetchAllAccountInsights(params);
            
            // Filter only campaigns with "starter" in name (case insensitive)
            const starterData = allData.filter(row => 
                row.campaign_name && row.campaign_name.toLowerCase().includes('starter')
            );
            
            return starterData;
        }
        
        Promise.all([
            getStarterCampaignSpend(start, end),
            getWooOrders('HR', start, end),
            getWooOrders('CZ', start, end),
            getWooOrders('PL', start, end),
            getWooAnalyticsOrders('HR', start, end),
            getWooAnalyticsOrders('CZ', start, end),
            getWooAnalyticsOrders('PL', start, end)
        ]).then(([starterFb, hrOrders, czOrders, plOrders, hrAnalytics, czAnalytics, plAnalytics]) => {
            // Build customer_type lookup
            const customerTypeLookup = { HR: {}, CZ: {}, PL: {} };
            for (const order of hrAnalytics) customerTypeLookup.HR[order.order_id] = order.customer_type;
            for (const order of czAnalytics) customerTypeLookup.CZ[order.order_id] = order.customer_type;
            for (const order of plAnalytics) customerTypeLookup.PL[order.order_id] = order.customer_type;
            
            // Process FB data - group by date and country
            const fbByDate = {};
            for (const row of starterFb) {
                const date = row.date_start;
                const countryRaw = row.country || 'unknown';
                const country = countryRaw === 'HR' ? 'HR' : countryRaw === 'CZ' ? 'CZ' : countryRaw === 'PL' ? 'PL' : null;
                if (!country) continue;
                
                if (!fbByDate[date]) fbByDate[date] = { HR: { spend: 0 }, CZ: { spend: 0 }, PL: { spend: 0 } };
                fbByDate[date][country].spend += parseFloat(row.spend || 0);
            }
            
            // Filter orders to only STARTER SKU (matches NORIKS-STARTER-O pattern)
            const filterStarterOrders = (orders) => {
                const starterOrders = [];
                for (const order of orders) {
                    if (!order.line_items) continue;
                    let hasStarter = false;
                    let starterItems = [];
                    for (const item of order.line_items) {
                        const sku = (item.sku || '').toUpperCase();
                        const name = (item.name || '').toLowerCase();
                        // Match SKU containing NORIKS-STARTER or STARTER, or name containing starter
                        if (sku.includes('NORIKS-STARTER') || sku.includes('STARTER') || name.includes('starter')) {
                            hasStarter = true;
                            starterItems.push(item);
                        }
                    }
                    if (hasStarter) {
                        // Keep ALL line items for product cost calculation, mark starter items separately
                        starterOrders.push({ ...order, _allItems: order.line_items, line_items: starterItems, _starterOnly: true });
                    }
                }
                return starterOrders;
            };
            
            const hrStarter = filterStarterOrders(filterTestOrders(hrOrders));
            const czStarter = filterStarterOrders(filterTestOrders(czOrders));
            const plStarter = filterStarterOrders(filterTestOrders(plOrders));
            
            console.log('[STARTER DEBUG] Orders fetched: HR=' + hrOrders.length + ', CZ=' + czOrders.length + ', PL=' + plOrders.length);
            console.log('[STARTER DEBUG] After filter: HR=' + hrStarter.length + ', CZ=' + czStarter.length + ', PL=' + plStarter.length);
            
            // Process orders by date/country
            const processOrders = (orders, country) => {
                const byDate = {};
                for (const order of orders) {
                    const date = order.date_created?.substring(0, 10);
                    if (!date || date < start || date > end) continue;
                    
                    if (!byDate[date]) byDate[date] = {
                        orders: 0, newOrders: 0, retOrders: 0, newCustomers: 0, returningCustomers: 0,
                        revenue: 0, newRevenue: 0, returningRevenue: 0, tshirts: 0, boxers: 0, socks: 0, shippingCost: 0,
                        mkAlignedGrossEur: 0, mkAlignedNewGrossEur: 0, mkAlignedRetGrossEur: 0,
                    // Payment method tracking
                    payment_cod: 0, payment_card: 0, payment_paypal: 0, payment_other: 0
                    };
                    
                    const d = byDate[date];
                    d.orders++;
                    
                    // Add shipping cost for this order
                    const orderShippingCost = shippingCosts[country] || 0;
                    d.shippingCost += orderShippingCost;
                    
                    const orderId = order.id;
                    const customerType = customerTypeLookup[country]?.[orderId];
                    const isNew = customerType === 'new';
                    
                    // FULL ORDER TOTAL (includes all products, shipping, everything)
                    // order._allItems has ALL line items, order.line_items has only starter items for product detection
                    const orderRevenue = parseFloat(order.total || 0);
                    
                    // Count ALL products in order for cost calculation (use _allItems)
                    const allItems = order._allItems || order.line_items;
                    for (const item of allItems) {
                        const product = detectProduct(item.name, true, item.meta_data, item.sku);
                        const qty = item.quantity || 1;
                        d.tshirts += (product.tshirts || 0) * qty;
                        d.boxers += (product.boxers || 0) * qty;
                        d.socks += (product.socks || 0) * qty;
                    }
                    
                    d.revenue += orderRevenue;
                    
                    if (isNew) {
                        d.newOrders++;
                        d.newCustomers++;
                        d.newRevenue += orderRevenue;
                    } else {
                        d.retOrders++;
                        d.returningCustomers++;
                        d.returningRevenue += orderRevenue;
                    }
                }
                return byDate;
            };
            
            const hrData = processOrders(hrStarter, 'HR');
            const czData = processOrders(czStarter, 'CZ');
            const plData = processOrders(plStarter, 'PL');
            
            // Build response
            const dates = new Set();
            const newData = {};
            
            const countries = ['HR', 'CZ', 'PL'];
            const allData = { HR: hrData, CZ: czData, PL: plData };
            
            for (const country of countries) {
                const countryData = allData[country];
                const c = config[country];
                const vatRate = VAT_RATES[country] || 0.25;
                
                for (const [date, data] of Object.entries(countryData)) {
                    dates.add(date);
                    if (!newData[date]) newData[date] = {};
                    
                    const spend = fbByDate[date]?.[country]?.spend || 0;
                    const rejectionRate = (rejectionRates[country] || 0) / 100;
                    
                    // Original gross revenue (use MK-aligned EUR when available)
                    const revenueGross = data.revenue;
                    const revenueGrossEur = data.mkAlignedGrossEur || (revenueGross * c.rate);
                    
                    // Apply rejection rate to gross revenue BEFORE VAT
                    const effectiveGrossEur = revenueGrossEur * (1 - rejectionRate);
                    const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
                    
                    // Original net (for display purposes)
                    const revenueNetEur = revenueGrossEur / (1 + vatRate);
                    const revenueNet = revenueGross / (1 + vatRate);
                    
                    // Revenue split by customer type (using MK-aligned EUR + effective rates)
                    const newGrossEur = data.mkAlignedNewGrossEur || (data.newRevenue * c.rate);
                    const retGrossEur = data.mkAlignedRetGrossEur || (data.returningRevenue * c.rate);
                    const newRevenueEur = newGrossEur * (1 - rejectionRate) / (1 + vatRate);
                    const retRevenueEur = retGrossEur * (1 - rejectionRate) / (1 + vatRate);
                    
                    // Product cost - apply rejection rate (we get products back for rejected orders)
                    const productCost = (data.tshirts * PRODUCT_COSTS.tshirt) + (data.boxers * PRODUCT_COSTS.boxers);
                    const effectiveProductCost = productCost * (1 - rejectionRate);
                    
                    // Shipping stays at 100% (we pay for all shipments including rejected)
                    const shippingCost = data.shippingCost || 0;
                    
                    // Profit = Effective Net Revenue - FB Spend - Effective Product Cost - Full Shipping
                    const profit = effectiveNetEur - spend - effectiveProductCost - shippingCost;
                    
                    newData[date][country] = {
                        orders: data.orders,
                        new: data.newOrders,
                        returning: data.retOrders,
                        new_orders: data.newOrders,
                        ret_orders: data.retOrders,
                        revenue_gross: Math.round(revenueGross * 100) / 100,
                        revenue_net: Math.round(revenueNet * 100) / 100,
                        revenue_gross_eur: Math.round(revenueGrossEur * 100) / 100,
                        revenue_net_eur: Math.round(revenueNetEur * 100) / 100,
                        effective_net_eur: Math.round(effectiveNetEur * 100) / 100,
                        new_revenue_eur: Math.round(newRevenueEur * 100) / 100,
                        ret_revenue_eur: Math.round(retRevenueEur * 100) / 100,
                        vat_rate: vatRate,
                        rejection_rate: rejectionRate,
                        currency: c.currency,
                        spend: Math.round(spend * 100) / 100,
                        tshirts: data.tshirts,
                        boxers: data.boxers,
                        socks: data.socks || 0,
                        product_cost: Math.round(productCost * 100) / 100,
                        effective_product_cost: Math.round(effectiveProductCost * 100) / 100,
                        shipping_cost: Math.round(shippingCost * 100) / 100,
                        profit: Math.round(profit * 100) / 100,
                        cpa: data.orders > 0 ? Math.round(spend / data.orders * 100) / 100 : null,
                        cpa_new: data.newOrders > 0 ? Math.round(spend / data.newOrders * 100) / 100 : null,
                        roas: spend > 0 ? Math.round(revenueGrossEur / spend * 100) / 100 : null
                    };
                }
            }
            
            // Add dates with spend but no orders
            for (const [date, fbCountries] of Object.entries(fbByDate)) {
                dates.add(date);
                if (!newData[date]) newData[date] = {};
                for (const country of countries) {
                    if (!newData[date][country] && fbCountries[country]) {
                        const spend = fbCountries[country].spend || 0;
                        newData[date][country] = {
                            orders: 0, new: 0, returning: 0, new_orders: 0, ret_orders: 0,
                            revenue_gross: 0, revenue_net: 0, revenue_gross_eur: 0, revenue_net_eur: 0,
                            new_revenue_eur: 0, ret_revenue_eur: 0,
                            vat_rate: VAT_RATES[country] || 0.25, currency: config[country].currency,
                            spend: Math.round(spend * 100) / 100,
                            tshirts: 0, boxers: 0, product_cost: 0, shipping_cost: 0,
                            profit: -Math.round(spend * 100) / 100,
                            cpa: null, cpa_new: null, roas: 0
                        };
                    }
                }
            }
            
            // Count totals for debug
            let totalOrders = 0, totalNew = 0, totalRevenueGross = 0, totalSpend = 0;
            for (const date of [...dates]) {
                for (const country of countries) {
                    const d = newData[date]?.[country];
                    if (d) {
                        totalOrders += d.orders || 0;
                        totalNew += d.new_orders || 0;
                        totalRevenueGross += d.revenue_gross_eur || 0;
                        totalSpend += d.spend || 0;
                    }
                }
            }
            const calcRoas = totalSpend > 0 ? (totalRevenueGross / totalSpend).toFixed(2) : 'N/A';
            console.log(`[STARTER API] Response: ${dates.size} days, ${totalOrders} orders, €${totalRevenueGross.toFixed(2)} revenue, €${totalSpend.toFixed(2)} spend, ROAS=${calcRoas}x`);
            
            res.end(JSON.stringify({
                dates: [...dates].sort(),
                countries,
                data: newData,
                lastUpdate: new Date().toISOString(),
                filter: 'STARTER only (SKU + campaigns)'
            }));
        }).catch(e => {
            console.log('[STARTER API] Error:', e.message);
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }
    
    // Advertiser Dashboard API (uses hourly-synced cache + lightweight Meta calls for adset/campaign split)
    if (pathname === '/api/advertiser-data') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        
        const start = parsed.query.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const end = parsed.query.end || new Date().toISOString().split('T')[0];
        const forceRefresh = parsed.query.refresh === '1';
        
        // Serve from cache: ranges ending before today → never expire; ranges including today → 1hr TTL
        const cacheKey = start + '_' + end;
        const today = new Date().toISOString().split('T')[0];
        const includestoday = end >= today;
        if (!forceRefresh && advertiserCache[cacheKey] && advertiserCache[cacheKey].cachedAt) {
            const ageMs = Date.now() - new Date(advertiserCache[cacheKey].cachedAt).getTime();
            const maxAge = includestoday ? 60 * 60 * 1000 : Infinity; // historical data never expires
            if (ageMs < maxAge) {
                console.log('[ADVERTISER API] Serving from cache (' + Math.round(ageMs/60000) + 'min old' + (includestoday ? '' : ', historical') + ')');
                return res.end(JSON.stringify(advertiserCache[cacheKey].data));
            }
        }
        
        console.log('[ADVERTISER API] Request: start=' + start + ', end=' + end + (forceRefresh ? ' (forced)' : ''));
        
        // Lightweight Meta calls: campaign-level spend split + active adset counts
        async function getMetaAdData(start, end) {
            const params = new URLSearchParams({
                access_token: FB_TOKEN,
                time_range: JSON.stringify({ since: start, until: end }),
                fields: 'ad_name,adset_name,campaign_name,spend,actions,date_start',
                breakdowns: 'country',
                level: 'ad',
                time_increment: 1,
                limit: 5000
            });
            return await fetchAllAccountInsights(params);
        }
        
        const allCountries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
        
        // Extend Meta campaign data 7 days back for spend comparison
        const compStart = new Date(new Date(start).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const rangeDays = Math.ceil((new Date(end) - new Date(start)) / (24*60*60*1000));
        // Get exact Klaviyo + Google Paid order counts per date per country
        function getExcludeCounts(start, end) {
            if (!originData.daily || Object.keys(originData.daily).length === 0) return null;
            const exclude = {}; // exclude[date][country] = count
            let totalExcl = 0;
            for (const [date, countries] of Object.entries(originData.daily)) {
                if (date < start || date > end) continue;
                for (const [c, counts] of Object.entries(countries)) {
                    const n = (counts.Klaviyo || 0) + (counts['Google Paid'] || 0) + (counts['Call Center'] || 0);
                    if (n > 0) {
                        if (!exclude[date]) exclude[date] = {};
                        exclude[date][c] = n;
                        totalExcl += n;
                    }
                }
            }
            console.log('[ADVERTISER] Excluding ' + totalExcl + ' non-Meta orders (' + start + ' to ' + end + ')');
            return exclude;
        }
        const excludeCounts = getExcludeCounts(start, end);

        // Get catalog WC order counts per date per country from origin data
        function getCatalogCounts(start, end) {
            if (!originData.daily || Object.keys(originData.daily).length === 0) return {};
            const counts = {}; // counts[date][country] = number
            for (const [date, countries] of Object.entries(originData.daily)) {
                if (date < start || date > end) continue;
                for (const [c, data] of Object.entries(countries)) {
                    if ((data.CatalogOrders || 0) > 0) {
                        if (!counts[date]) counts[date] = {};
                        counts[date][c] = data.CatalogOrders;
                    }
                }
            }
            return counts;
        }
        const catalogWcCounts = getCatalogCounts(start, end);
        const catalogTotal = Object.values(catalogWcCounts).reduce((s, d) => s + Object.values(d).reduce((a, b) => a + b, 0), 0);
        if (catalogTotal > 0) console.log('[ADVERTISER] Catalog WC orders: ' + catalogTotal + ' (' + JSON.stringify(catalogWcCounts) + ')');

        getMetaAdData(compStart, end).catch(e => { console.log('[ADVERTISER] Meta ad data failed:', e.message); return []; }).then((adData) => {
            // Classify ad by product type from ad name, fallback to adset name
            // Returns 'shirts', 'boxers', 'starter', or null (skip — catalog/unclassifiable)
            function classifyAd(adName, adsetName, campaignName) {
                let isCatalog = false;
                // Try ad name → adset name → campaign name (most specific first)
                for (const name of [adName, adsetName, campaignName]) {
                    const lower = (name || '').toLowerCase();
                    if (!lower) continue;
                    if (lower.includes('catalog') || lower.includes('conversions_catalog')) { isCatalog = true; continue; }
                    if (lower.includes('starter') || lower.includes('starter-pack') || lower.includes('starter_paket')) return 'starter';
                    if (lower.includes('2p5') || lower.includes('komplet') || lower.includes('bundle')) return 'kompleti';
                    if (lower.includes('boxer') || lower.includes('bokser') || lower.includes('boxserice')) return 'boxers';
                    if (lower.includes('majic') || lower.includes('shirt') || lower.includes('pirat')) return 'shirts';
                }
                return isCatalog ? 'catalog' : null;
            }
            
            // Build ad-level spend + orders split by date + country + product type
            const spendByDate = {};
            // Count active adsets per country per product type
            const activeAdsets = {}, shirtsAdsets = {}, boxersAdsets = {}, starterAdsets = {}, kompletiAdsets = {}, catalogAdsets = {};
            let skippedSpend = 0;
            
            for (const row of adData) {
                const date = row.date_start, country = row.country;
                if (!allCountries.includes(country)) continue;
                const spend = parseFloat(row.spend || 0);
                const purchases = (row.actions || []).find(a => a.action_type === 'purchase');
                const orders = purchases ? parseInt(purchases.value) : 0;
                const type = classifyAd(row.ad_name, row.adset_name, row.campaign_name);
                
                if (!spendByDate[date]) spendByDate[date] = {};
                if (!spendByDate[date][country]) spendByDate[date][country] = { total: 0, shirts: 0, boxers: 0, starter: 0, kompleti: 0, catalog: 0, ordersShirts: 0, ordersBoxers: 0, ordersStarter: 0, ordersKompleti: 0, ordersCatalog: 0, ordersTotal: 0 };
                spendByDate[date][country].total += spend;
                spendByDate[date][country].ordersTotal += orders;
                
                if (type === null) {
                    skippedSpend += spend;
                } else {
                    spendByDate[date][country][type] += spend;
                    spendByDate[date][country]['orders' + type.charAt(0).toUpperCase() + type.slice(1)] += orders;
                }
                
                // Track active adsets (only within requested range, not comp period)
                if (date >= start && date <= end && spend > 0) {
                    if (!activeAdsets[country]) { activeAdsets[country] = new Set(); shirtsAdsets[country] = new Set(); boxersAdsets[country] = new Set(); starterAdsets[country] = new Set(); kompletiAdsets[country] = new Set(); catalogAdsets[country] = new Set(); }
                    activeAdsets[country].add(row.adset_name);
                    if (type === 'shirts') shirtsAdsets[country].add(row.adset_name);
                    else if (type === 'boxers') boxersAdsets[country].add(row.adset_name);
                    else if (type === 'starter') starterAdsets[country].add(row.adset_name);
                    else if (type === 'kompleti') kompletiAdsets[country].add(row.adset_name);
                    else if (type === 'catalog') catalogAdsets[country].add(row.adset_name);
                }
            }
            console.log('[ADVERTISER] Ad-level data: ' + adData.length + ' rows, catalog/unclassified spend: €' + skippedSpend.toFixed(2));
            
            // Build response from cached data + Meta spend split
            const countryTotals = {};
            const daily = {};
            const dates = [];
            const cachedData = getCachedData(start, end);
            
            for (const c of allCountries) {
                countryTotals[c] = {
                    spend: 0, orders: 0, revenueGrossEur: 0, profit: 0,
                    products: {
                        '👕 Shirts': { orders: 0, spend: 0, revenueGrossEur: 0, profit: 0, activeAdsets: shirtsAdsets[c] ? shirtsAdsets[c].size : 0, wcOrders: 0, wcProfit: 0, wcUnits: 0 },
                        '🩳 Boxers': { orders: 0, spend: 0, revenueGrossEur: 0, profit: 0, activeAdsets: boxersAdsets[c] ? boxersAdsets[c].size : 0, wcOrders: 0, wcProfit: 0, wcUnits: 0 },
                        '📦 Starter Pack': { orders: 0, spend: 0, revenueGrossEur: 0, profit: 0, activeAdsets: starterAdsets[c] ? starterAdsets[c].size : 0, wcOrders: 0, wcProfit: 0, wcUnits: 0 },
                        '🎁 Kompleti': { orders: 0, spend: 0, revenueGrossEur: 0, profit: 0, activeAdsets: kompletiAdsets[c] ? kompletiAdsets[c].size : 0, wcOrders: 0, wcProfit: 0, wcUnits: 0 },
                        '📋 Catalog': { orders: 0, spend: 0, revenueGrossEur: 0, profit: 0, activeAdsets: catalogAdsets[c] ? catalogAdsets[c].size : 0, wcOrders: 0, wcProfit: 0, wcUnits: 0 }
                    }
                };
            }
            
            for (const date of cachedData.dates) {
                dates.push(date);
                if (!daily[date]) daily[date] = { spend: 0, orders: 0, revenueGrossEur: 0, profit: 0 };
                
                for (const c of allCountries) {
                    const d = cachedData.data[date]?.[c];
                    if (!d) continue;
                    
                    const fbSplit = spendByDate[date]?.[c] || { total: 0, shirts: 0, boxers: 0, starter: 0, kompleti: 0, catalog: 0 };
                    const totalSpend = fbSplit.total > 0 ? fbSplit.total : (d.spend || 0);
                    
                    // Spend ratios per product type
                    const spendTotal = fbSplit.total || 1;
                    const shirtsSpendR = fbSplit.shirts / spendTotal;
                    const boxersSpendR = fbSplit.boxers / spendTotal;
                    const starterSpendR = fbSplit.starter / spendTotal;
                    const kompletiSpendR = fbSplit.kompleti / spendTotal;
                    const catalogSpendR = fbSplit.catalog / spendTotal;
                    
                    // Apply attribution filter: subtract exact Klaviyo + Google Paid orders
                    const exclN = excludeCounts && excludeCounts[date] ? (excludeCounts[date][c] || 0) : 0;
                    const rawOrders = d.orders || 0;
                    const orders = Math.max(0, rawOrders - exclN);
                    const attrRatio = rawOrders > 0 ? orders / rawOrders : 1;
                    const revenueGrossEur = (d.revenue_gross_eur || 0) * attrRatio;
                    const profit = (d.profit || 0) * attrRatio;
                    
                    // FB orders per product (from Meta API actions)
                    const fbO = fbSplit;
                    const shirtsOrders = fbO.ordersShirts || 0;
                    const boxersOrders = fbO.ordersBoxers || 0;
                    const starterOrders = fbO.ordersStarter || 0;
                    const kompletiOrders = fbO.ordersKompleti || 0;
                    const catalogOrders = fbO.ordersCatalog || 0;
                    
                    // WooCommerce product units from cache
                    const wcTshirts = d.tshirts || 0;
                    const wcBoxers = d.boxers || 0;
                    const wcTotalUnits = wcTshirts + wcBoxers;
                    const wcTshirtRatio = wcTotalUnits > 0 ? wcTshirts / wcTotalUnits : 0.5;
                    const wcBoxerRatio = wcTotalUnits > 0 ? wcBoxers / wcTotalUnits : 0.5;
                    
                    // Revenue/profit split by spend ratio per product
                    const shirtsRevGross = revenueGrossEur * (shirtsSpendR + catalogSpendR * wcTshirtRatio);
                    const boxersRevGross = revenueGrossEur * (boxersSpendR + catalogSpendR * wcBoxerRatio);
                    const starterRevGross = revenueGrossEur * starterSpendR;
                    const kompletiRevGross = revenueGrossEur * kompletiSpendR;
                    const catalogRevGross = 0; // catalog revenue attributed to shirts/boxers above
                    
                    const shirtsProfit = profit * (shirtsSpendR + catalogSpendR * wcTshirtRatio);
                    const boxersProfit = profit * (boxersSpendR + catalogSpendR * wcBoxerRatio);
                    const starterProfit = profit * starterSpendR;
                    const kompletiProfit = profit * kompletiSpendR;
                    
                    // WC orders: use actual product classification from origin data (no rounding/ratios)
                    const wcProd = originData.daily?.[date]?.[c]?.wcByProduct || { shirts: 0, boxers: 0, starter: 0, kompleti: 0, catalog: 0 };
                    const wcCatalogOrders = wcProd.catalog || 0;
                    const wcShirtOrders = wcProd.shirts || 0;
                    const wcBoxerOrders = wcProd.boxers || 0;
                    const wcStarterOrders = wcProd.starter || 0;
                    const wcKompletiOrders = wcProd.kompleti || 0;
                    
                    // Country totals
                    countryTotals[c].spend += totalSpend;
                    countryTotals[c].orders += orders;
                    countryTotals[c].revenueGrossEur += revenueGrossEur;
                    countryTotals[c].profit += profit;
                    
                    countryTotals[c].products['👕 Shirts'].orders += shirtsOrders;
                    countryTotals[c].products['👕 Shirts'].spend += fbSplit.shirts;
                    countryTotals[c].products['👕 Shirts'].revenueGrossEur += shirtsRevGross;
                    countryTotals[c].products['👕 Shirts'].profit += shirtsProfit;
                    countryTotals[c].products['👕 Shirts'].wcOrders += wcShirtOrders;
                    countryTotals[c].products['👕 Shirts'].wcProfit += shirtsProfit;
                    countryTotals[c].products['👕 Shirts'].wcUnits += wcTshirts;
                    
                    countryTotals[c].products['🩳 Boxers'].orders += boxersOrders;
                    countryTotals[c].products['🩳 Boxers'].spend += fbSplit.boxers;
                    countryTotals[c].products['🩳 Boxers'].revenueGrossEur += boxersRevGross;
                    countryTotals[c].products['🩳 Boxers'].profit += boxersProfit;
                    countryTotals[c].products['🩳 Boxers'].wcOrders += wcBoxerOrders;
                    countryTotals[c].products['🩳 Boxers'].wcProfit += boxersProfit;
                    countryTotals[c].products['🩳 Boxers'].wcUnits += wcBoxers;
                    
                    countryTotals[c].products['📦 Starter Pack'].orders += starterOrders;
                    countryTotals[c].products['📦 Starter Pack'].spend += fbSplit.starter;
                    countryTotals[c].products['📦 Starter Pack'].revenueGrossEur += starterRevGross;
                    countryTotals[c].products['📦 Starter Pack'].profit += starterProfit;
                    countryTotals[c].products['📦 Starter Pack'].wcOrders += wcStarterOrders;
                    countryTotals[c].products['📦 Starter Pack'].wcProfit += starterProfit;
                    
                    countryTotals[c].products['🎁 Kompleti'].orders += kompletiOrders;
                    countryTotals[c].products['🎁 Kompleti'].spend += fbSplit.kompleti;
                    countryTotals[c].products['🎁 Kompleti'].revenueGrossEur += kompletiRevGross;
                    countryTotals[c].products['🎁 Kompleti'].profit += kompletiProfit;
                    countryTotals[c].products['🎁 Kompleti'].wcOrders += wcKompletiOrders;
                    countryTotals[c].products['🎁 Kompleti'].wcProfit += kompletiProfit;
                    
                    const catalogRevShare = orders > 0 ? wcCatalogOrders / orders : 0;
                    countryTotals[c].products['📋 Catalog'].orders += catalogOrders;
                    countryTotals[c].products['📋 Catalog'].spend += fbSplit.catalog;
                    countryTotals[c].products['📋 Catalog'].revenueGrossEur += revenueGrossEur * catalogRevShare;
                    countryTotals[c].products['📋 Catalog'].profit += profit * catalogRevShare;
                    countryTotals[c].products['📋 Catalog'].wcOrders += wcCatalogOrders;
                    countryTotals[c].products['📋 Catalog'].wcProfit += profit * catalogRevShare;
                    
                    // Daily totals
                    daily[date].spend += totalSpend;
                    daily[date].orders += orders;
                    daily[date].revenueGrossEur += revenueGrossEur;
                    daily[date].profit += profit;
                }
            }
            
            const adsetCounts = {};
            for (const c of allCountries) adsetCounts[c] = activeAdsets[c] ? activeAdsets[c].size : 0;
            
            // Spend comparison: yesterday + 7d average per country + per product
            // We need Meta campaign spend split for comparison dates too
            const startDate = new Date(start);
            const compDates = [];
            for (let i = 1; i <= 7; i++) {
                const d = new Date(startDate); d.setDate(d.getDate() - i);
                compDates.push(d.toISOString().split('T')[0]);
            }
            const yesterdayStr = compDates[0];
            
            // Build per-product spend from spendByDate for comparison dates
            const spendComparison = {};
            for (const c of allCountries) {
                const ydayCache = dataCache.data[yesterdayStr]?.[c];
                const ydayTotalSpend = ydayCache?.spend || 0;
                const ydaySplit = spendByDate[yesterdayStr]?.[c] || null;
                
                let sum7d = 0, count7d = 0;
                let sum7dShirts = 0, sum7dBoxers = 0, sum7dStarter = 0, sum7dKompleti = 0, sum7dCatalog = 0;
                for (const d7str of compDates) {
                    const d7cache = dataCache.data[d7str]?.[c];
                    if (d7cache && d7cache.spend !== undefined) {
                        sum7d += d7cache.spend; count7d++;
                        const d7split = spendByDate[d7str]?.[c];
                        if (d7split) {
                            sum7dShirts += d7split.shirts || 0;
                            sum7dBoxers += d7split.boxers || 0;
                            sum7dStarter += d7split.starter || 0;
                            sum7dKompleti += d7split.kompleti || 0;
                            sum7dCatalog += d7split.catalog || 0;
                        }
                    }
                }
                const r2 = v => Math.round(v * 100) / 100;
                spendComparison[c] = {
                    yesterdaySpend: r2(ydayTotalSpend),
                    avg7dSpend: count7d > 0 ? r2(sum7d / count7d) : 0,
                    yesterdayShirts: ydaySplit ? r2(ydaySplit.shirts || 0) : 0,
                    yesterdayBoxers: ydaySplit ? r2(ydaySplit.boxers || 0) : 0,
                    yesterdayStarter: ydaySplit ? r2(ydaySplit.starter || 0) : 0,
                    yesterdayKompleti: ydaySplit ? r2(ydaySplit.kompleti || 0) : 0,
                    yesterdayCatalog: ydaySplit ? r2(ydaySplit.catalog || 0) : 0,
                    avg7dShirts: count7d > 0 ? r2(sum7dShirts / count7d) : 0,
                    avg7dBoxers: count7d > 0 ? r2(sum7dBoxers / count7d) : 0,
                    avg7dStarter: count7d > 0 ? r2(sum7dStarter / count7d) : 0,
                    avg7dKompleti: count7d > 0 ? r2(sum7dKompleti / count7d) : 0,
                    avg7dCatalog: count7d > 0 ? r2(sum7dCatalog / count7d) : 0
                };
            }
            
            // Daily overview: ALWAYS last 14 days regardless of selected filter
            const daily14 = {};
            const d14end = new Date().toISOString().split('T')[0];
            const d14start = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const d14excludes = getExcludeCounts(d14start, d14end);
            for (let d = new Date(d14start); d.toISOString().split('T')[0] <= d14end; d.setDate(d.getDate() + 1)) {
                const date = d.toISOString().split('T')[0];
                daily14[date] = { spend: 0, orders: 0, revenueGrossEur: 0, profit: 0 };
                for (const c of allCountries) {
                    const cd = dataCache.data[date]?.[c];
                    if (!cd) continue;
                    const exclN = d14excludes && d14excludes[date] ? (d14excludes[date][c] || 0) : 0;
                    const rawOrders = cd.orders || 0;
                    const adjOrders = Math.max(0, rawOrders - exclN);
                    const ratio = rawOrders > 0 ? adjOrders / rawOrders : 1;
                    daily14[date].spend += spendByDate[date]?.[c]?.total || cd.spend || 0;
                    daily14[date].orders += adjOrders;
                    daily14[date].revenueGrossEur += (cd.revenue_gross_eur || 0) * ratio;
                    daily14[date].profit += (cd.profit || 0) * ratio;
                }
            }
            
            console.log('[ADVERTISER API] Response: ' + dates.length + ' days (from cache), ' + allCountries.map(c => c + '=' + (countryTotals[c]?.orders || 0)).join(', '));
            
            const responseData = {
                dates,
                countries: allCountries,
                countryTotals,
                activeAdsets: adsetCounts,
                spendComparison,
                daily,
                daily14,
                lastUpdate: dataCache.lastUpdate || new Date().toISOString()
            };
            
            // Cache the response
            advertiserCache[cacheKey] = { cachedAt: new Date().toISOString(), data: responseData };
            // Keep only last 30 cache entries
            const keys = Object.keys(advertiserCache);
            if (keys.length > 30) {
                keys.sort((a, b) => new Date(advertiserCache[a].cachedAt) - new Date(advertiserCache[b].cachedAt));
                for (let i = 0; i < keys.length - 30; i++) delete advertiserCache[keys[i]];
            }
            saveAdvertiserCache();
            
            res.end(JSON.stringify(responseData));
        }).catch(e => {
            console.log('[ADVERTISER API] Error:', e.message, e.stack);
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }
    
    // Shipping Costs API
    if (pathname === '/api/shipping') {
        res.setHeader('Content-Type', 'application/json');
        
        if (req.method === 'GET') {
            res.end(JSON.stringify({ shipping: shippingCosts }));
            return;
        }
        
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.shipping && typeof data.shipping === 'object') {
                        shippingCosts = data.shipping;
                        saveShippingCosts();
                        res.end(JSON.stringify({ ok: true, shipping: shippingCosts }));
                    } else {
                        res.end(JSON.stringify({ error: 'Invalid shipping data' }));
                    }
                } catch (e) { res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }
    }
    
    // Rejections API
    if (pathname === '/api/rejections') {
        res.setHeader('Content-Type', 'application/json');
        
        if (req.method === 'GET') {
            res.end(JSON.stringify({ rejections: rejectionRates }));
            return;
        }
        
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.rejections && typeof data.rejections === 'object') {
                        rejectionRates = data.rejections;
                        saveRejectionRates();
                        res.end(JSON.stringify({ ok: true, rejections: rejectionRates }));
                    } else {
                        res.end(JSON.stringify({ error: 'Invalid rejections data' }));
                    }
                } catch (e) { res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }
    }
    
    // Purchasing API - calculates what needs to be ordered
    const LEAD_TIME_DAYS = 40;
    const TREND_DAYS = 7;
    
    // Inventory GET API
    if ((pathname === '/api/inventory' || pathname === '/dashboard/api/inventory') && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        try {
            const inventoryFile = path.join(__dirname, 'inventory-data.json');
            const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
            res.end(JSON.stringify(inventory));
        } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Inventory Update API - manual stock adjustment (serialized to prevent race conditions)
    if (pathname === '/api/inventory/update' || pathname === '/dashboard/api/inventory/update') {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                // Queue this update to prevent concurrent read-modify-write races
                await inventoryUpdateQueue;
                inventoryUpdateQueue = (async () => {
                try {
                    const { sku, stock } = JSON.parse(body);
                    if (!sku || stock === undefined) {
                        res.statusCode = 400;
                        res.end(JSON.stringify({ error: 'Missing sku or stock' }));
                        return;
                    }
                    
                    const inventoryFile = path.join(__dirname, 'inventory-data.json');
                    const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
                    
                    // Find and update the item
                    const item = inventory.inventory.find(i => i.sku === sku);
                    if (!item) {
                        res.statusCode = 404;
                        res.end(JSON.stringify({ error: 'SKU not found' }));
                        return;
                    }
                    
                    const oldStock = item.stock;
                    item.stock = stock;
                    
                    // Also update initialValues to keep sync
                    if (inventory.initialValues) {
                        const delta = stock - oldStock;
                        if (inventory.initialValues[sku] !== undefined) {
                            inventory.initialValues[sku] += delta;
                        } else {
                            inventory.initialValues[sku] = stock;
                        }
                    }
                    
                    inventory.generated = new Date().toISOString();
                    inventory.lastManualEdit = { sku, oldStock, newStock: stock, at: new Date().toISOString() };
                    
                    fs.writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2));
                    console.log(`Inventory update: ${sku} ${oldStock} → ${stock}`);
                    
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true, sku, oldStock, newStock: stock }));
                } catch (e) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: e.message }));
                }
                })();
            });
            return;
        }
    }
    
    // Stock Sales Report — daily stock value sold (from cache, zero API calls)
    if (pathname === '/api/stock-sales') {
        if (!session) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        res.setHeader('Content-Type', 'application/json');
        
        const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
        const UNIT_PRICE = { tshirt: 3.50, boxers: 3.50, socks: 3.50 };
        const rows = [];
        
        for (const date of (dataCache.dates || []).sort().reverse()) {
            if (date < '2026-01-01') continue;
            let totalTshirts = 0, totalBoxers = 0, totalSocks = 0, totalRevenue = 0;
            
            let totalOrders = 0;
            for (const c of countries) {
                const d = dataCache.data[date]?.[c];
                if (!d) continue;
                totalTshirts += d.tshirts || 0;
                totalBoxers += d.boxers || 0;
                totalSocks += d.socks || 0;
                totalRevenue += d.revenue_gross_eur || 0;
                totalOrders += d.orders || 0;
            }
            
            const totalUnits = totalTshirts + totalBoxers + totalSocks;
            const stockValueEur = (totalTshirts * UNIT_PRICE.tshirt) + (totalBoxers * UNIT_PRICE.boxers) + (totalSocks * UNIT_PRICE.socks);
            
            rows.push({
                date,
                orders: totalOrders,
                revenue: Math.round(totalRevenue * 100) / 100,
                stockValue: Math.round(stockValueEur * 100) / 100,
                totalUnits,
                tshirts: totalTshirts,
                boxers: totalBoxers,
                socks: totalSocks
            });
        }
        
        res.end(JSON.stringify({ rows, unitPrices: UNIT_PRICE, generatedAt: dataCache.lastUpdate }));
        return;
    }
    
    if (pathname === '/api/purchasing' || pathname === '/dashboard/api/purchasing') {
        res.setHeader('Content-Type', 'application/json');
        const returnAll = parsed.query.all === 'true'; // Return all items for simulation
        const trendDays = parseInt(parsed.query.trendDays) || TREND_DAYS; // Custom trend period
        
        try {
            // Load inventory
            const inventoryFile = path.join(__dirname, 'inventory-data.json');
            const inventoryData = fs.existsSync(inventoryFile) 
                ? JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
                : { inventory: [] };
            
            // Load incoming stock (not arrived)
            const arrivalsFile = path.join(__dirname, 'stock-arrivals.json');
            const arrivalsData = fs.existsSync(arrivalsFile)
                ? JSON.parse(fs.readFileSync(arrivalsFile, 'utf8'))
                : { arrivals: [] };
            
            // Load sales data for trend
            const stockFile = path.join(__dirname, 'stock-data.json');
            const stockData = fs.existsSync(stockFile)
                ? JSON.parse(fs.readFileSync(stockFile, 'utf8'))
                : { detailed: [] };
            
            // Build incoming stock map (sum by type+color+size)
            const incomingMap = {};
            for (const arrival of arrivalsData.arrivals || []) {
                if (arrival.arrived) continue; // Skip already arrived
                const key = `${arrival.type}-${arrival.color}-${arrival.size}`;
                incomingMap[key] = (incomingMap[key] || 0) + (arrival.qty || 0);
            }
            
            // Get actual days tracked
            const daysSinceStart = stockData.daysSinceStart || 1;
            const daysSinceYearStart = stockData.daysSinceYearStart || 1;
            
            // Build sales map from detailed data
            // Available: today, yesterday, week (7 days), count (all time since tracking)
            const salesMap = {};
            for (const item of stockData.detailed || []) {
                const key = `${item.type}-${item.color}-${item.size}`;
                // Select sales period based on trendDays
                let sales = 0;
                if (trendDays === 1) {
                    sales = item.yesterday || 0;
                } else if (trendDays === 3) {
                    // Use actual 3-day data from WooCommerce
                    sales = item.day3 || 0;
                } else if (trendDays === 7) {
                    sales = item.week || 0;
                } else if (trendDays === 14) {
                    // Use actual 14-day data from WooCommerce
                    sales = item.day14 || 0;
                } else if (trendDays === 30) {
                    // Use actual 30-day sales data
                    sales = item.month || Math.round(((item.week || 0) / 7) * 30);
                } else if (trendDays === 365) {
                    // Use year-to-date sales (since Jan 1, 2026)
                    sales = item.ytd || item.count || 0;
                } else {
                    sales = item.week || 0;
                }
                salesMap[key] = sales;
            }
            
            // Calculate purchasing needs
            const items = [];
            for (const inv of inventoryData.inventory || []) {
                const key = `${inv.type}-${inv.color}-${inv.size}`;
                const stock = inv.stock || 0;
                const incoming = incomingMap[key] || 0;
                const total = stock + incoming;
                const periodSales = salesMap[key] || 0;
                // For "Vse" (365), use actual days since Jan 1, 2026
                const effectiveDays = trendDays === 365 ? daysSinceYearStart : trendDays;
                const salesPerDay = periodSales / effectiveDays;
                
                // Days of stock (avoid division by zero)
                const daysOfStock = salesPerDay > 0 ? total / salesPerDay : Infinity;
                
                // Order quantity calculation:
                // - Red (<40 days): order to reach 40 days (lead time)
                // - Orange (40-100 days): order to reach 100 days (green threshold)
                // - Green (100+ days): no order needed
                const GREEN_THRESHOLD = 100;
                let orderQty = 0;
                if (salesPerDay > 0) {
                    if (daysOfStock < LEAD_TIME_DAYS) {
                        // Red: order to reach lead time (40 days)
                        orderQty = Math.ceil((LEAD_TIME_DAYS * salesPerDay) - total);
                    } else if (daysOfStock < GREEN_THRESHOLD) {
                        // Orange: order to reach green (100 days)
                        orderQty = Math.ceil((GREEN_THRESHOLD * salesPerDay) - total);
                    }
                    if (orderQty < 0) orderQty = 0;
                }
                
                // Filter logic:
                // - Has sales (salesPerDay > 0), OR has incoming stock
                // - If returnAll: include all items with sales or incoming (for simulation)
                // - Otherwise: only items that need ordering (days < lead time)
                const hasActivity = salesPerDay > 0 || incoming > 0;
                if (hasActivity && (returnAll || daysOfStock < LEAD_TIME_DAYS)) {
                    items.push({
                        sku: inv.sku,
                        product: inv.type,
                        color: inv.color,
                        size: inv.size,
                        stock,
                        incoming,
                        total,
                        periodSales,
                        salesPerDay,
                        originalSalesPerDay: salesPerDay, // Store original for simulation
                        daysOfStock,
                        orderQty
                    });
                }
            }
            
            // Get period totals for stats display
            let periodItems = 0, periodOrders = 0;
            if (trendDays === 1) {
                periodItems = stockData.yesterdayItems || 0;
                periodOrders = stockData.yesterdayOrders || 0;
            } else if (trendDays === 3) {
                periodItems = stockData.day3Items || 0;
                periodOrders = stockData.day3Orders || 0;
            } else if (trendDays === 7) {
                periodItems = stockData.weekItems || 0;
                periodOrders = stockData.weekOrders || 0;
            } else if (trendDays === 14) {
                periodItems = stockData.day14Items || 0;
                periodOrders = stockData.day14Orders || 0;
            } else if (trendDays === 30) {
                periodItems = stockData.monthItems || 0;
                periodOrders = stockData.monthOrders || 0;
            } else if (trendDays === 365) {
                periodItems = stockData.ytdItems || 0;
                periodOrders = stockData.ytdOrders || 0;
            }
            
            res.end(JSON.stringify({ 
                items,
                leadTimeDays: LEAD_TIME_DAYS,
                trendDays: trendDays,
                periodItems,
                periodOrders,
                generated: new Date().toISOString()
            }));
        } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Stock Arrivals API
    const STOCK_ARRIVALS_FILE = path.join(__dirname, 'stock-arrivals.json');
    if (pathname === '/api/stock-arrivals' || pathname === '/dashboard/api/stock-arrivals') {
        res.setHeader('Content-Type', 'application/json');
        
        if (req.method === 'GET') {
            try {
                const data = fs.existsSync(STOCK_ARRIVALS_FILE) 
                    ? JSON.parse(fs.readFileSync(STOCK_ARRIVALS_FILE, 'utf8'))
                    : { arrivals: [], lastUpdated: null };
                res.end(JSON.stringify(data));
            } catch (e) {
                res.end(JSON.stringify({ arrivals: [], lastUpdated: null }));
            }
            return;
        }
        
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    fs.writeFileSync(STOCK_ARRIVALS_FILE, JSON.stringify(data, null, 2));
                    console.log(`Stock arrivals saved: ${data.arrivals?.length || 0} entries`);
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) { 
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: e.message })); 
                }
            });
            return;
        }
    }
    
    // =========================================================
    // Payment Report API — reads from dataCache (no WC API calls)
    // =========================================================
    if (pathname === '/api/payment-report') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        const today = new Date().toISOString().split('T')[0];
        const yearStart = '2026-01-01';
        const start = parsed.query.start || yearStart;
        const end = parsed.query.end || today;
        
        try {
            const results = {
                byDate: {},
                byCountry: {},
                byCountryAndDate: {},
                totals: { cod: 0, card: 0, paypal: 0, other: 0, total: 0 }
            };
            
            const cacheData = dataCache.data || {};
            
            for (const [date, countries] of Object.entries(cacheData)) {
                if (date < start || date > end) continue;
                
                results.byDate[date] = { cod: 0, card: 0, paypal: 0, other: 0, total: 0 };
                
                for (const [country, d] of Object.entries(countries)) {
                    const cod = d.payment_cod || 0;
                    const card = d.payment_card || 0;
                    const paypal = d.payment_paypal || 0;
                    const other = d.payment_other || 0;
                    const total = cod + card + paypal + other;
                    
                    if (total === 0) continue;
                    
                    // byDate aggregate
                    results.byDate[date].cod += cod;
                    results.byDate[date].card += card;
                    results.byDate[date].paypal += paypal;
                    results.byDate[date].other += other;
                    results.byDate[date].total += total;
                    
                    // byCountry aggregate
                    if (!results.byCountry[country]) results.byCountry[country] = { cod: 0, card: 0, paypal: 0, other: 0, total: 0 };
                    results.byCountry[country].cod += cod;
                    results.byCountry[country].card += card;
                    results.byCountry[country].paypal += paypal;
                    results.byCountry[country].other += other;
                    results.byCountry[country].total += total;
                    
                    // byCountryAndDate
                    if (!results.byCountryAndDate[country]) results.byCountryAndDate[country] = {};
                    results.byCountryAndDate[country][date] = { cod, card, paypal, other, total };
                    
                    // Totals
                    results.totals.cod += cod;
                    results.totals.card += card;
                    results.totals.paypal += paypal;
                    results.totals.other += other;
                    results.totals.total += total;
                }
                
                // Remove dates with no data
                if (results.byDate[date].total === 0) delete results.byDate[date];
            }
            
            res.end(JSON.stringify(results));
        } catch (e) {
            console.error('Payment report error:', e.message);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.end();
        return;
    }
    
    // === HR POSTA TRACKING SCRAPER ===
    if (pathname === '/api/hr-tracking' && req.method === 'GET') {
        const barcode = parsed.query.barcode || '';
        if (!barcode) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing barcode' })); }
        try {
            const trackRes = await globalThis.fetch('https://posiljka.posta.hr/hr/tracking/trackingdata?barcode=' + encodeURIComponent(barcode));
            const html = await trackRes.text();
            const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
            // Extract current location — find non-empty Text-Style-50
            const locMatches = html.match(/Text-Style-50[^>]*>\s*([^<]+)/g) || [];
            let location = null;
            for (const m of locMatches) {
                const val = m.replace(/Text-Style-50[^>]*>\s*/, '').trim();
                if (val.length > 2) { location = decode(val); break; }
            }
            // Extract paketomat/posta arrival date
            const arrMatch = html.match(/(\w+ \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) u ([^<]+)/);
            const arrivedAt = arrMatch ? arrMatch[1] : null;
            const arrivedLocation = arrMatch ? decode(arrMatch[2].trim()) : null;
            // Extract ALL events: Text-Style-13 = status, text-style-19-md-12 or Text-Style-20-md-6 = date/detail
            const events = [];
            const eventBlocks = html.match(/Text-Style-13[^>]*>[^<]+/g) || [];
            // Find all dates in the page (dd.mm.yyyy ... hh:mm:ss format)
            const dateMatches = [...html.matchAll(/>(\d{2}\.\d{2}\.\d{4}\s+\w+\s+\d{2}:\d{2}:\d{2})</g)];
            // Also find detail text (text-style-19-md-12)
            const detailMatches = html.match(/text-style-19-md-12[^>]*>\s*([^<]+)/gi) || [];
            const details = detailMatches.map(m => decode(m.replace(/text-style-19-md-12[^>]*>\s*/i, '').trim())).filter(d => d.length > 2 && !d.match(/^\d{2}\.\d{2}\.\d{4}/));
            for (let i = 0; i < eventBlocks.length; i++) {
                const status = decode(eventBlocks[i].replace(/Text-Style-13[^>]*>\s*/, '').trim());
                const date = dateMatches[i] ? dateMatches[i][1] : null;
                const detail = details[i] || null;
                if (status) events.push({ status, date, detail });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ barcode, location, arrivedAt, arrivedLocation, events }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }
    
    // === LOCAL CARRIER TRACKING (CZ Post, GR Taxydromiki, etc.) ===
    if (pathname === '/api/local-tracking' && req.method === 'GET') {
        const code = parsed.query.code || '';
        const country = (parsed.query.country || '').toUpperCase();
        if (!code || !country) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing code or country' })); }
        try {
            let events = [], location = null, carrier = country;
            if (country === 'CZ') {
                carrier = 'Česká Pošta';
                const trackRes = await globalThis.fetch('https://www.postaonline.cz/en/trackandtrace/-/zasilka/cislo?parcelNumbers=' + encodeURIComponent(code));
                const html = await trackRes.text();
                // Parse events from detail table rows
                const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
                let m;
                while ((m = trRegex.exec(html)) !== null) {
                    const row = m[1];
                    const cells = [];
                    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
                    let td;
                    while ((td = tdRegex.exec(row)) !== null) cells.push(td[1].replace(/<[^>]+>/g, '').trim());
                    if (cells.length >= 2) {
                        const dateMatch = cells[0].match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
                        if (dateMatch && cells[1] && !cells[1].match(/^(Date|Event|Status)/)) {
                            const place = cells[3] || '';
                            events.push({ date: dateMatch[1], status: cells[1] + (place ? ' (' + place + ')' : '') });
                        }
                    }
                }
                // Extract location from "deposited" event
                for (const e of events) {
                    const locMatch = e.status.match(/deposited.*?\(([^)]+)\)/i) || e.status.match(/request.*?\(([^)]+)\)/i);
                    if (locMatch) { location = locMatch[1].trim(); break; }
                }
            } else if (country === 'GR') {
                carrier = 'ACS Courier';
                try {
                    const trackRes = await globalThis.fetch('https://api.acscourier.net/api/parcels/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                        body: JSON.stringify({ VoucherNo: code })
                    });
                    if (trackRes.ok) {
                        const data = await trackRes.json();
                        const items = data.Items || data.items || [];
                        if (items.length > 0) {
                            const item = items[0];
                            const checkpoints = item.Checkpoints || item.checkpoints || [];
                            for (const cp of checkpoints) {
                                events.push({
                                    date: cp.CheckpointDate || cp.checkpointDate || '',
                                    status: (cp.Description || cp.description || '') + (cp.Location ? ' (' + cp.Location + ')' : '')
                                });
                            }
                            events.reverse();
                            location = item.LastCheckpoint?.Location || item.lastCheckpoint?.location || null;
                        }
                    }
                } catch (e2) {
                    // Fallback: scrape ACS website
                    try {
                        const trackRes2 = await globalThis.fetch('https://www.acscourier.net/el/track-and-trace?p_p_id=AstrackPortlet_WAR_Astrackportlet&number=' + encodeURIComponent(code), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
                        const html = await trackRes2.text();
                        const rowRegex = /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})[^<]*<[^>]*>([^<]+)/g;
                        let m4;
                        while ((m4 = rowRegex.exec(html)) !== null) {
                            events.push({ date: m4[1].trim(), status: m4[2].trim() });
                        }
                    } catch(e3) { console.error('ACS scrape error:', e3.message); }
                }
            } else if (country === 'SK') {
                carrier = 'Slovenská Pošta';
                const trackRes = await globalThis.fetch('https://tandt.posta.sk/zasielky/' + encodeURIComponent(code));
                const html = await trackRes.text();
                const rowRegex = /(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})[^<]*<[^>]*>([^<]+)/g;
                let m3;
                while ((m3 = rowRegex.exec(html)) !== null) {
                    events.push({ date: m3[1].trim(), status: m3[2].trim() });
                }
            } else if (country === 'PL') {
                carrier = 'InPost';
                try {
                    const trackRes = await globalThis.fetch('https://api-shipx-pl.easypack24.net/v1/tracking/' + encodeURIComponent(code));
                    if (trackRes.ok) {
                        const data = await trackRes.json();
                        const details = data.tracking_details || [];
                        for (const d of details) {
                            const dt = d.datetime || '';
                            const dateStr = dt ? new Date(dt).toLocaleString('en-GB', { timeZone: 'Europe/Warsaw' }) : '';
                            events.push({ date: dateStr, status: d.status || '' });
                        }
                        // Extract target machine location
                        const target = data.custom_attributes?.target_machine_detail;
                        if (target) {
                            location = (target.name || '') + (target.address ? ' — ' + target.address.line1 + ', ' + target.address.line2 : '');
                        }
                    }
                } catch (e2) { console.error('InPost API error:', e2.message); }
            } else if (country === 'HU') {
                carrier = 'GLS Hungary';
                // HU status translations
                const huTranslate = {
                    '01': 'Parcel data received',
                    '02': 'In transit',
                    '03': 'Arrived at depot',
                    '04': 'Out for delivery',
                    '05': 'Delivered',
                    '06': 'Not delivered — customer absent',
                    '07': 'Not delivered — wrong address',
                    '08': 'Not delivered — refused',
                    '09': 'Stored at depot',
                    '10': 'Return to sender',
                    '11': 'Delivered to ParcelShop',
                    '12': 'Delivered to Parcel Locker',
                    '13': 'Picked up from ParcelShop',
                    '14': 'Picked up from Parcel Locker',
                    '51': 'Customer data received',
                    '52': 'COD data received',
                    '99': 'Delivered — signed'
                };
                // Paketomat/parcel shop detection keywords
                const parcelPointKeywords = /csomagpont|parcelshop|parcel.?locker|paketomat|csomagautomata|alzabox|foxpost|packeta/i;
                try {
                    const trackRes = await globalThis.fetch('https://online.gls-hungary.com/tt_page.php?tt_value=' + encodeURIComponent(code) + '&lng=en', { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const html = await trackRes.text();
                    const rowRegex = /<tr class="colored_\d+">([\s\S]*?)<\/tr>/g;
                    let m5;
                    while ((m5 = rowRegex.exec(html)) !== null) {
                        const cells = [];
                        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
                        let td;
                        while ((td = tdRegex.exec(m5[1])) !== null) cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim());
                        if (cells.length >= 3) {
                            const statusCode = (cells[1] || '').match(/^(\d{2})-/);
                            const code2 = statusCode ? statusCode[1] : '';
                            const enStatus = huTranslate[code2] || cells[1];
                            const depot = cells[2] || '';
                            const info = cells[3] || '';
                            const isParcelPoint = parcelPointKeywords.test(info) || parcelPointKeywords.test(depot) || ['11','12','13','14'].includes(code2);
                            events.push({
                                date: cells[0],
                                status: enStatus + (depot ? ' (' + depot + ')' : '') + (info ? ' — ' + info : ''),
                                isParcelPoint
                            });
                        }
                    }
                    if (events.length > 0) {
                        const locMatch = events[0].status.match(/\(([^)]+)\)/);
                        if (locMatch) location = locMatch[1];
                    }
                } catch (e2) { console.error('GLS HU scrape error:', e2.message); }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ code, country, carrier, location, events }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // === EXPEDICO TRACKING API (GraphQL public) ===
    if (pathname === '/api/expedico-tracking' && req.method === 'GET') {
        const code = parsed.query.code || '';
        if (!code) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing code' })); }
        try {
            const gqlQuery = `{ tracking(codes: ["${code.replace(/"/g, '')}"]) { code trackingCode packetState { id labelEn sys } carrier { labelEn } events { occuredOn packetState { id labelEn sys } carrierStateDescription } } }`;
            const gqlRes = await globalThis.fetch('https://expedico.eu/api/public', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: gqlQuery })
            });
            const gqlData = await gqlRes.json();
            const tracking = gqlData?.data?.tracking?.[0] || null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ code, tracking }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // === CS NOTES API ===
    const CS_NOTES_FILE = path.join(__dirname, 'cs-notes.json');
    if (pathname === '/api/cs-notes' && req.method === 'GET') {
        try {
            const data = fs.existsSync(CS_NOTES_FILE) ? JSON.parse(fs.readFileSync(CS_NOTES_FILE, 'utf8')) : {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(data));
        } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    }
    if (pathname === '/api/cs-notes' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { orderId, note, done } = JSON.parse(body);
                if (!orderId) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing orderId' })); }
                const data = fs.existsSync(CS_NOTES_FILE) ? JSON.parse(fs.readFileSync(CS_NOTES_FILE, 'utf8')) : {};
                if (!data[orderId]) data[orderId] = {};
                if (note !== undefined) data[orderId].note = note;
                if (done !== undefined) data[orderId].done = done;
                data[orderId].updatedAt = new Date().toISOString();
                fs.writeFileSync(CS_NOTES_FILE, JSON.stringify(data, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true }));
            } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
        });
        return;
    }

    // === LANDINGS API ===
    if (pathname === '/api/landings' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(landingsData));
    }
    if (pathname === '/api/landings' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { content } = JSON.parse(body);
                landingsData = { content: content || '', updatedAt: new Date().toISOString() };
                fs.writeFileSync(LANDINGS_FILE, JSON.stringify(landingsData, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true }));
            } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
        });
        return;
    }

    // === LIVE EVENTS API ===
    if (pathname === '/api/live-events' && req.method === 'GET') {
        try {
            const country = parsed.query.country || '';
            let events = (liveEventsData.events || []).map(e => ({
                ...e,
                resolved: liveEventsResolved[e.id] || null
            }));
            if (country) events = events.filter(e => e.country === country);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ events, generatedAt: liveEventsData.generatedAt }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/api/live-events/resolve' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { id, undo } = JSON.parse(body);
                if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing id' })); }
                if (undo) {
                    delete liveEventsResolved[id];
                } else {
                    liveEventsResolved[id] = { by: session.username, at: new Date().toISOString() };
                }
                saveLiveEventsResolved();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        });
        return;
    }


    // In-transit orders detail for Rejection Resolver
    if (pathname === '/api/in-transit-orders' && req.method === 'GET') {
        const date = parsed.query.date || '';
        const country = parsed.query.country || '';
        if (!date || !country) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing date or country' }));
        }
        try {
            const MK_SEARCH = 'https://main.metakocka.si/rest/eshop/v1/search';
            const MK_GET = 'https://main.metakocka.si/rest/eshop/v1/get_document';
            const SK = 'YOUR_METAKOCKA_SECRET_KEY';
            const CID = '6371';

            function mkPost(apiUrl, body) {
                return new Promise((resolve, reject) => {
                    const reqUrl = new (require('url').URL)(apiUrl);
                    const bodyStr = JSON.stringify(body);
                    const options = { method: 'POST', hostname: reqUrl.hostname, path: reqUrl.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } };
                    const r = https.request(options, resp => { let d = ''; resp.on('data', ch => d += ch); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
                    r.on('error', reject);
                    r.setTimeout(30000, () => { r.destroy(); reject(new Error('Timeout')); });
                    r.write(bodyStr); r.end();
                });
            }

            // Search orders in a wide range around shipped_date (doc_date can be much earlier)
            const d = new Date(date);
            const from = new Date(d); from.setDate(from.getDate() - 30);
            const to = new Date(d); to.setDate(to.getDate() + 3);
            const fromStr = from.toISOString().slice(0,10) + '+02:00';
            const toStr = to.toISOString().slice(0,10) + '+02:00';
            let allOrders = [], offset = 0;
            while (true) {
                const result = await mkPost(MK_SEARCH, {
                    secret_key: SK, company_id: CID, doc_type: 'sales_order', result_type: 'doc',
                    limit: 100, offset,
                    query_advance: [{ type: 'doc_date_from', value: fromStr }, { type: 'doc_date_to', value: toStr }]
                });
                if (!result || !result.result || result.result.length === 0) break;
                allOrders = allOrders.concat(result.result);
                offset += 100;
                if (result.result.length < 100) break;
                await new Promise(r => setTimeout(r, 100));
            }

            // Filter: noriks, shipped status, matching country
            const COUNTRY_MAP = { HR: 'Croatia', CZ: 'Czech', PL: 'Poland', GR: 'Greece', SK: 'Slovakia', IT: 'Italy', HU: 'Hungary' };
            const filtered = allOrders.filter(o => {
                if (!o.eshop_name || !/noriks/i.test(o.eshop_name)) return false;
                if (o.status_desc !== 'shipped') return false;
                const shippedDate = (o.shipped_date || o.doc_date || '').substring(0, 10);
                if (shippedDate !== date) return false;
                const ciso = o.partner?.country_iso_2 || '';
                return ciso === country;
            });

            // Get detailed delivery info for each order
            const orders = [];
            for (const o of filtered) {
                let detail = null;
                try {
                    detail = await mkPost(MK_GET, {
                        secret_key: SK, company_id: CID, doc_type: 'sales_order', doc_number: o.count_code
                    });
                } catch(e) {}

                const deliveryService = detail?.mk_id ? (detail.delivery_service || o.delivery_service || '') : (o.delivery_service || '');
                const trackingCode = detail?.tracking_code || o.tracking_code || '';
                const events = (detail?.delivery_events || o.delivery_events || []).map(ev => ({
                    date: ev.event_date || '',
                    code: ev.event_code || '',
                    status: ev.event_description || ev.event_status || ''
                }));
                const lastEvent = events.length > 0 ? events[events.length - 1] : null;

                orders.push({
                    id: o.count_code,
                    title: o.title || '',
                    customer: o.partner?.customer || '',
                    address: [o.partner?.street, o.partner?.post_number, o.partner?.place, o.partner?.country].filter(Boolean).join(', '),
                    phone: o.partner?.phone || '',
                    shippedDate: (o.shipped_date || o.doc_date || '').substring(0, 10),
                    deliveryService,
                    trackingCode,
                    lastEvent: lastEvent ? { date: lastEvent.date, status: lastEvent.status, code: lastEvent.code } : null,
                    events,
                    total: o.doc_total || o.sum_all || ''
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ orders, count: orders.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/api/live-events/refresh' && req.method === 'POST') {
        try {
            await generateLiveEvents();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, count: liveEventsData.events.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // === SHIPPING SPEED API ===
    if (pathname === '/api/shipping-speed' && req.method === 'GET') {
        try {
            if (fs.existsSync(SHIPPING_SPEED_FILE)) {
                const data = JSON.parse(fs.readFileSync(SHIPPING_SPEED_FILE, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(data));
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'No data yet. Click Refresh Data.' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/api/shipping-speed/refresh' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        generateShippingSpeedData(res).catch(err => {
            res.write('data: ' + JSON.stringify({ type: 'error', message: err.message }) + '\n\n');
            res.end();
        });
        return;
    }

    let filePath = pathname === '/' || pathname === '' ? (isAdvertiserPrefix ? '/advertiser.html' : '/index.html') : pathname;
    filePath = path.join(__dirname, filePath);
    const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    
    fs.readFile(filePath, (err, content) => {
        if (err) { res.statusCode = 404; res.end('Not found'); return; }
        res.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'text/plain');
        // Prevent caching of HTML and JSON files
        if (path.extname(filePath) === '.html' || path.extname(filePath) === '.json') {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        res.end(content);
    });
});

loadCache();
loadSkuOverrides();
loadCustomerHistory();
loadSessions();
loadShippingCosts();
loadRejectionRates();
loadMkOrderMap();
loadAdvertiserCache();


function parseMkDate(d) {
    if (!d) return null;
    if (/^\d{4}-\d{2}-\d{2}[+-]/.test(d)) {
        d = d.replace(/^(\d{4}-\d{2}-\d{2})/, '$1T00:00:00');
    }
    const date = new Date(d);
    return isNaN(date.getTime()) ? null : date;
}

// === SHIPPING SPEED DATA GENERATION ===
// === LIVE EVENTS GENERATOR ===
let liveEventsGenerating = false;
async function generateLiveEvents() {
    if (liveEventsGenerating) { console.log('[LIVE-EVENTS] Already generating, skip'); return liveEventsData; }
    liveEventsGenerating = true;
    try { return await _generateLiveEventsInner(); } finally { liveEventsGenerating = false; }
}
async function _generateLiveEventsInner() {
    const MK_URL_SEARCH = 'https://main.metakocka.si/rest/eshop/v1/search';
    const MK_URL_GET = 'https://main.metakocka.si/rest/eshop/v1/get_document';
    const SECRET_KEY = 'YOUR_METAKOCKA_SECRET_KEY';
    const COMPANY_ID = 'YOUR_METAKOCKA_COMPANY_ID';

    function mkReq(url, body) {
        return new Promise((resolve, reject) => {
            const reqUrl = new (require('url').URL)(url);
            const bodyStr = JSON.stringify(body);
            const options = { method: 'POST', hostname: reqUrl.hostname, path: reqUrl.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } };
            const req = https.request(options, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } }); });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(bodyStr); req.end();
        });
    }

    const toDate = new Date();
    const fromDate = new Date(); fromDate.setDate(toDate.getDate() - 14);
    const fromStr = fromDate.toISOString().slice(0,10) + '+02:00';
    const toStr = toDate.toISOString().slice(0,10) + '+02:00';

    console.log('[LIVE-EVENTS] Fetching orders ' + fromStr + ' → ' + toStr);

    let allOrders = [], offset = 0;
    while (true) {
        const result = await mkReq(MK_URL_SEARCH, { secret_key: SECRET_KEY, company_id: COMPANY_ID, doc_type: 'sales_order', result_type: 'doc', limit: 100, offset, query_advance: [{ type: 'doc_date_from', value: fromStr }, { type: 'doc_date_to', value: toStr }] });
        if (!result || !result.result || result.result.length === 0) break;
        allOrders = allOrders.concat(result.result);
        offset += 100;
        if (result.result.length < 100) break;
        await new Promise(r => setTimeout(r, 200));
    }

    const wcOrders = allOrders.filter(o => (o.buyer_order || '').match(/^(?:NORIKS|SHOP_SDB)[-_][A-Z]{2}[-_]/));
    console.log('[LIVE-EVENTS] ' + wcOrders.length + ' WC orders, fetching events...');

    // SKIP first — anything containing these is NOT a problem we act on
    const SKIP_PATTERNS = /preuzeta|prevzeta|picked.*up.*from|picked.*up.*by.*customer|collected|delivered.*successfully|dostavljen[oa]?\b|povrat|return|vrnjen|vrač|vračanje|back.*to.*sender|way.*back/i;

    // SHOW — only these patterns are actionable problems
    const PROBLEM_PATTERNS = [
        { pattern: /failed|failure|neuspešn|neuspesn|unsuccessful/i, type: 'Delivery Failed' },
        { pattern: /rejected|odbij|zavrn|zavrnjen/i, type: 'Shipment Rejected' },
        { pattern: /not.*found|neznan|ne.*najden|unknown.*address|nepoznan/i, type: 'Client Not Found' },
        { pattern: /paketomat|parcel.*locker|pickup.*point|paketnik|samopostrežn/i, type: 'Parcel Locker' },
        { pattern: /nedostavlj|undeliver|ni.*dostav|neuruciv/i, type: 'Undelivered' },
        { pattern: /Unprocessable Entity|Carrier error|Error on batch|external_service_error/i, type: 'Shipping Error' }
    ];

    // Event codes that are problems (but only if NOT skipped by text)
    const PROBLEM_CODES = { '530': 'Delivery Failed', 'IND': 'Delivery Failed', 'IND1': 'Delivery Failed', 'IND2': 'Delivery Failed', 'IND3': 'Delivery Failed', 'NEU': 'Undelivered', 'ODO': 'Shipment Rejected', '-2': 'Shipping Error', '380': 'Delivery Failed' };
    // NOTE: 330 removed — it means "back to sender" which we skip

    function classifyProblem(code, status) {
        const s = status || '';
        // SKIP patterns always win
        if (SKIP_PATTERNS.test(s)) return null;

        // Check event code
        code = (code || '').toString().toUpperCase();
        if (PROBLEM_CODES[code]) return PROBLEM_CODES[code];
        if (code.startsWith('IND')) return 'Delivery Failed';

        // Check text patterns
        for (const p of PROBLEM_PATTERNS) {
            if (p.pattern.test(s)) return p.type;
        }
        return null;
    }

    // Deduplicate: one entry per order, showing the WORST/latest problem
    // Preserve detectedAt from previous run
    const prevDetected = {};
    for (const e of (liveEventsData.events || [])) { if (e.id && e.detectedAt) prevDetected[e.id] = e.detectedAt; }
    const orderMap = {}; // orderId -> best event
    let processed = 0;

    for (const order of wcOrders) {
        processed++;
        const buyerOrder = order.buyer_order || '';
        const storeMatch = buyerOrder.match(/^(?:NORIKS|SHOP_SDB)[-_]([A-Z]{2})[-_]/);
        const country = storeMatch ? storeMatch[1] : 'HR';

        try {
            const detail = await mkReq(MK_URL_GET, { secret_key: SECRET_KEY, company_id: COMPANY_ID, doc_type: 'sales_order', buyer_order: buyerOrder, return_delivery_service_events: 'true' });
            const trackingEvents = detail.delivery_service_events || [];

            // Extract all tracking codes from "Dodana koda za sledenje" events
            const allTrackingCodes = [];
            for (const evt of trackingEvents) {
                const desc = evt.event_status || '';
                const match = desc.match(/(?:sledenje|tracking)[:\s]*([A-Z0-9\s]+)/i);
                if (match) allTrackingCodes.push(match[1].trim());
            }
            if (detail.tracking_code && !allTrackingCodes.includes(detail.tracking_code)) allTrackingCodes.unshift(detail.tracking_code);
            const trackingNo = allTrackingCodes[0] || '';
            const localTrackingNo = allTrackingCodes[1] || '';

            const delivered = trackingEvents.some(e => (e.event_code || '').toString() === 'IOD');

            // Build full timeline
            const timeline = trackingEvents.map(evt => ({
                date: evt.event_date || '',
                code: (evt.event_code || '').toString(),
                text: evt.event_status || ''
            })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

            // Extract contact from partner/receiver
            const p = detail.receiver || detail.partner || {};
            const pc = p.partner_contact || {};
            const contact = {
                name: p.customer || '',
                phone: pc.gsm || pc.phone || '',
                email: pc.email || '',
                address: [p.street, p.post_number, p.place, p.country].filter(Boolean).join(', ')
            };

            // Collect all problem events for this order
            let hasProblem = false;
            for (const evt of trackingEvents) {
                const code = (evt.event_code || '').toString();
                const status = evt.event_status || '';
                const problemType = classifyProblem(code, status);

                if (problemType) {
                    hasProblem = true;
                    const evtDate = evt.event_date || order.doc_date;
                    const id = buyerOrder + '_' + code + '_' + (evtDate || '').replace(/[^0-9]/g, '');

                    if (!orderMap[id]) {
                        orderMap[id] = {
                            id,
                            date: evtDate,
                            detectedAt: prevDetected[id] || new Date().toISOString(),
                            orderId: buyerOrder,
                            trackingNo,
                            localTrackingNo,
                            country,
                            type: problemType,
                            description: status,
                            eventCode: code,
                            delivered,
                            contact,
                            timeline
                        };
                    }
                }
            }

            // Only problem events are tracked (no tracking/transit entries)
        } catch(e) { /* skip */ }

        await new Promise(r => setTimeout(r, 80));
        if (processed % 50 === 0) console.log('[LIVE-EVENTS] Processed ' + processed + '/' + wcOrders.length);
    }

    const events = Object.values(orderMap);

    // Sort newest first
    events.sort((a, b) => {
        const da = a.date ? new Date(a.date.replace(/[+].*/, '')) : new Date(0);
        const db = b.date ? new Date(b.date.replace(/[+].*/, '')) : new Date(0);
        return db - da;
    });

    liveEventsData = { events, generatedAt: new Date().toISOString() };
    fs.writeFileSync(LIVE_EVENTS_FILE, JSON.stringify(liveEventsData));
    console.log('[LIVE-EVENTS] Generated: ' + events.length + ' problem events from ' + wcOrders.length + ' orders');

    // Clean up resolved entries for events that no longer exist
    const eventIds = new Set(events.map(e => e.id));
    for (const rid of Object.keys(liveEventsResolved)) {
        if (!eventIds.has(rid)) delete liveEventsResolved[rid];
    }
    saveLiveEventsResolved();

    return liveEventsData;
}

// === FB CR CACHE SYNC ===
function saveFbCrCache() {
    try { fs.writeFileSync(FB_CR_CACHE_FILE, JSON.stringify(fbCrCache)); } catch(e) { console.error('[FB-CR] Cache save failed:', e.message); }
}

async function syncFbCrData(start, end) {
    const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
    console.log(`[FB-CR] Syncing ${start} → ${end}...`);
    
    const params = new URLSearchParams({
        access_token: FB_TOKEN,
        time_range: JSON.stringify({ since: start, until: end }),
        fields: 'impressions,clicks,spend,actions',
        breakdowns: 'country',
        level: 'account',
        time_increment: 1,
        limit: 5000
    });
    
    const allData = await fetchAllAccountInsights(params);
    
    // Clear dates in range (to avoid stale data for incremental sync)
    const d = new Date(start);
    const endD = new Date(end);
    while (d <= endD) {
        const ds = d.toISOString().split('T')[0];
        delete fbCrCache.daily[ds];
        d.setDate(d.getDate() + 1);
    }
    
    for (const row of allData) {
        const date = row.date_start;
        const country = row.country;
        if (!countries.includes(country)) continue;
        
        if (!fbCrCache.daily[date]) fbCrCache.daily[date] = {};
        if (!fbCrCache.daily[date][country]) fbCrCache.daily[date][country] = { impressions: 0, clicks: 0, link_clicks: 0, landing_page_views: 0, add_to_cart: 0, initiate_checkout: 0, purchases: 0, spend: 0, view_content: 0 };
        
        const dd = fbCrCache.daily[date][country];
        dd.impressions += parseInt(row.impressions || 0);
        dd.clicks += parseInt(row.clicks || 0);
        dd.spend += parseFloat(row.spend || 0);
        
        if (row.actions) {
            for (const action of row.actions) {
                const val = parseInt(action.value || 0);
                switch (action.action_type) {
                    case 'link_click': dd.link_clicks += val; break;
                    case 'landing_page_view': dd.landing_page_views += val; break;
                    case 'add_to_cart': dd.add_to_cart += val; break;
                    case 'initiate_checkout': dd.initiate_checkout += val; break;
                    case 'purchase': dd.purchases += val; break;
                    case 'view_content': dd.view_content += val; break;
                }
            }
        }
    }
    
    fbCrCache.lastUpdate = new Date().toISOString();
    saveFbCrCache();
    console.log(`[FB-CR] Synced: ${Object.keys(fbCrCache.daily).length} days cached`);
}

async function syncFbCrFull() {
    await syncFbCrData('2026-01-01', new Date().toISOString().split('T')[0]);
    fbCrCache.lastFullSync = new Date().toISOString();
    saveFbCrCache();
}

async function syncFbCrRecent() {
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await syncFbCrData(start, end);
}

async function generateShippingSpeedData(sseRes) {
    const MK_URL_SEARCH = 'https://main.metakocka.si/rest/eshop/v1/search';
    const MK_URL_GET = 'https://main.metakocka.si/rest/eshop/v1/get_document';
    const SECRET_KEY = 'YOUR_METAKOCKA_SECRET_KEY';
    const COMPANY_ID = 'YOUR_METAKOCKA_COMPANY_ID';
    
    function send(evt) {
        if (sseRes && !sseRes.writableEnded) sseRes.write('data: ' + JSON.stringify(evt) + '\n\n');
    }
    
    function mkRequest(url, body) {
        return new Promise((resolve, reject) => {
            const reqUrl = new (require('url').URL)(url);
            const bodyStr = JSON.stringify(body);
            const options = {
                method: 'POST',
                hostname: reqUrl.hostname,
                path: reqUrl.pathname,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
            };
            const req = https.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
                });
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(bodyStr);
            req.end();
        });
    }
    
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    // Step 1: Search for recent orders (last 60 days)
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 60);
    const fromStr = fromDate.toISOString().slice(0,10) + '+02:00';
    const toStr = toDate.toISOString().slice(0,10) + '+02:00';
    
    console.log('📦 Shipping Speed: Fetching orders ' + fromStr + ' → ' + toStr);
    send({ type: 'progress', message: 'Fetching order list...', current: 0, total: 1 });
    
    let allOrders = [];
    let offset = 0;
    const limit = 100;
    
    while (true) {
        const result = await mkRequest(MK_URL_SEARCH, {
            secret_key: SECRET_KEY,
            company_id: COMPANY_ID,
            doc_type: 'sales_order',
            result_type: 'doc',
            limit, offset,
            query_advance: [
                { type: 'doc_date_from', value: fromStr },
                { type: 'doc_date_to', value: toStr }
            ]
        });
        
        if (!result || !result.result || result.result.length === 0) break;
        allOrders = allOrders.concat(result.result);
        offset += limit;
        if (result.result.length < limit) break;
        await sleep(200);
    }
    
    // Filter to WC orders only
    const wcOrders = allOrders.filter(o => {
        const bo = o.buyer_order || '';
        return bo.match(/^(?:NORIKS|SHOP_SDB)[-_][A-Z]{2}[-_]/);
    });
    
    console.log('📦 Shipping Speed: ' + wcOrders.length + ' WC orders found (of ' + allOrders.length + ' total)');
    send({ type: 'progress', message: 'Found ' + wcOrders.length + ' orders. Fetching delivery events...', current: 0, total: wcOrders.length });
    
    // Step 2: For each order, fetch delivery events
    const COUNTRY_MAP_REV = {
        'Croatia': 'HR', 'Czech Republic': 'CZ', 'Czechia': 'CZ',
        'Poland': 'PL', 'Greece': 'GR', 'Italy': 'IT',
        'Hungary': 'HU', 'Slovakia': 'SK'
    };
    
    const countryData = {};
    let processed = 0;
    let totalDelivered = 0;
    let totalFailed = 0;
    let totalWithEvents = 0;
    
    for (const order of wcOrders) {
        processed++;
        if (processed % 10 === 0 || processed === wcOrders.length) {
            send({ type: 'progress', message: 'Processing delivery events...', current: processed, total: wcOrders.length });
        }
        
        const buyerOrder = order.buyer_order || '';
        const storeMatch = buyerOrder.match(/^(?:NORIKS|SHOP_SDB)[-_]([A-Z]{2})[-_]/);
        const country = storeMatch ? storeMatch[1] : 'HR';
        
        if (!countryData[country]) {
            countryData[country] = {
                courier: '',
                orders: 0,
                delivered: 0,
                failed: 0,
                times_order_to_ship: [],
                times_ship_to_pickup: [],
                times_pickup_to_delivery: [],
                times_delivery_to_delivered: [],
                times_total: [],
                outliers: []
            };
        }
        
        const cd = countryData[country];
        cd.orders++;
        
        // Set courier from delivery_type
        if (!cd.courier && order.delivery_type) {
            cd.courier = order.delivery_type;
        }
        
        try {
            const detail = await mkRequest(MK_URL_GET, {
                secret_key: SECRET_KEY,
                company_id: COMPANY_ID,
                doc_type: 'sales_order',
                buyer_order: buyerOrder,
                return_delivery_service_events: 'true'
            });
            
            const events = detail.delivery_service_events || [];
            if (events.length === 0) {
                await sleep(100);
                continue;
            }
            
            totalWithEvents++;
            
            // Parse event timestamps
            const orderDate = parseMkDate(order.order_create_ts);
            const shippedDate = parseMkDate(order.doc_date);
            
            let pickupDate = null;   // OTP/300
            let deliveryDate = null; // ZAD
            let deliveredDate = null; // IOD
            let failedOrder = false;
            let lastEventDesc = '';
            
            for (const evt of events) {
                const code = (evt.event_code || '').toString();
                const evtDate = parseMkDate(evt.event_date);
                lastEventDesc = evt.event_status || code;
                
                if ((code === 'OTP' || code === '300') && !pickupDate) {
                    pickupDate = evtDate;
                } else if (code === 'ZAD' && !deliveryDate) {
                    deliveryDate = evtDate;
                } else if (code === 'IOD') {
                    deliveredDate = evtDate;
                } else if (code === '530' || code === '330' || code.startsWith('IND')) {
                    failedOrder = true;
                }
            }
            
            if (deliveredDate) {
                cd.delivered++;
                totalDelivered++;
            }
            if (failedOrder && !deliveredDate) {
                cd.failed++;
                totalFailed++;
            }
            
            // Calculate time segments (in hours)
            function hoursDiff(a, b) {
                if (!a || !b) return null;
                return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
            }
            
            const t_order_ship = hoursDiff(orderDate, shippedDate);
            const t_ship_pickup = hoursDiff(shippedDate, pickupDate);
            const t_pickup_delivery = hoursDiff(pickupDate, deliveryDate);
            const t_delivery_delivered = hoursDiff(deliveryDate, deliveredDate);
            const t_total = hoursDiff(orderDate, deliveredDate);
            
            if (t_order_ship !== null && t_order_ship >= 0) cd.times_order_to_ship.push(t_order_ship);
            if (t_ship_pickup !== null && t_ship_pickup >= 0) cd.times_ship_to_pickup.push(t_ship_pickup);
            if (t_pickup_delivery !== null && t_pickup_delivery >= 0) cd.times_pickup_to_delivery.push(t_pickup_delivery);
            if (t_delivery_delivered !== null && t_delivery_delivered >= 0) cd.times_delivery_to_delivered.push(t_delivery_delivered);
            if (t_total !== null && t_total >= 0) cd.times_total.push({ hours: t_total, buyer_order: buyerOrder, status: deliveredDate ? 'Delivered' : (failedOrder ? 'Failed' : 'In Transit'), last_event: lastEventDesc });
            
        } catch (e) {
            // Skip orders that fail to fetch
        }
        
        // Rate limit: 100ms between requests
        await sleep(100);
    }
    
    // Step 3: Calculate averages and build result
    function avg(arr) {
        if (arr.length === 0) return null;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }
    
    const countries = [];
    let grandTotalHours = [];
    
    for (const [iso, cd] of Object.entries(countryData)) {
        const avgTotal = avg(cd.times_total.map(t => t.hours));
        
        // Find outliers (>2x average total time)
        const outliers = [];
        if (avgTotal) {
            for (const t of cd.times_total) {
                if (t.hours > avgTotal * 2 && t.hours > 48) {
                    outliers.push({ buyer_order: t.buyer_order, total_hours: Math.round(t.hours * 10) / 10, status: t.status, last_event: t.last_event });
                }
            }
            outliers.sort((a, b) => b.total_hours - a.total_hours);
        }
        
        if (avgTotal) grandTotalHours = grandTotalHours.concat(cd.times_total.map(t => t.hours));
        
        countries.push({
            country_iso: iso,
            courier: cd.courier,
            orders: cd.orders,
            delivered: cd.delivered,
            failed: cd.failed,
            avg_order_to_ship: avg(cd.times_order_to_ship) ? Math.round(avg(cd.times_order_to_ship) * 10) / 10 : null,
            avg_ship_to_pickup: avg(cd.times_ship_to_pickup) ? Math.round(avg(cd.times_ship_to_pickup) * 10) / 10 : null,
            avg_pickup_to_delivery: avg(cd.times_pickup_to_delivery) ? Math.round(avg(cd.times_pickup_to_delivery) * 10) / 10 : null,
            avg_delivery_to_delivered: avg(cd.times_delivery_to_delivered) ? Math.round(avg(cd.times_delivery_to_delivered) * 10) / 10 : null,
            avg_total_hours: avgTotal ? Math.round(avgTotal * 10) / 10 : null,
            outliers: outliers.slice(0, 20)
        });
    }
    
    // Sort by order count descending
    countries.sort((a, b) => b.orders - a.orders);
    
    const result = {
        generated_at: new Date().toISOString(),
        period_days: 60,
        total_orders: wcOrders.length,
        total_with_events: totalWithEvents,
        total_delivered: totalDelivered,
        total_failed: totalFailed,
        avg_total_hours: grandTotalHours.length > 0 ? Math.round((grandTotalHours.reduce((a, b) => a + b, 0) / grandTotalHours.length) * 10) / 10 : null,
        countries
    };
    
    fs.writeFileSync(SHIPPING_SPEED_FILE, JSON.stringify(result, null, 2));
    console.log('✅ Shipping Speed report generated: ' + wcOrders.length + ' orders, ' + totalDelivered + ' delivered');
    
    send({ type: 'done', data: result });
    if (sseRes && !sseRes.writableEnded) sseRes.end();
    
    return result;
}



// Auto-refresh advertiser cache for today's date range (proactive fetch)
async function refreshAdvertiserCache() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        // Invalidate ALL cache entries that include today (end >= today)
        let invalidated = 0;
        for (const key of Object.keys(advertiserCache)) {
            const endDate = key.split('_')[1];
            if (endDate && endDate >= today) { delete advertiserCache[key]; invalidated++; }
        }
        saveAdvertiserCache();
        const cacheKey = weekAgo + '_' + today;
        console.log('[ADVERTISER] Cache invalidated (' + invalidated + ' entries), proactively refetching ' + cacheKey + '...');
        // Self-request to populate cache (uses first admin session from users.json)
        const http = require('http');
        const usersFile = path.join(__dirname, 'users.json');
        let adminUser = 'noriks';
        try { const users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); adminUser = Object.keys(users)[0] || 'noriks'; } catch(e) {}
        // Create a temporary session token for internal use
        const tempSessionId = 'adv-cache-refresh-' + Date.now();
        sessions[tempSessionId] = { username: adminUser, createdAt: Date.now(), expiresAt: Date.now() + 300000 };
        const url = `http://127.0.0.1:${PORT}/dashboard/api/advertiser-data?start=${weekAgo}&end=${today}&refresh=1`;
        const req = http.get(url, { headers: { Cookie: `session=${tempSessionId}` } }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                delete sessions[tempSessionId];
                if (res.statusCode === 200) {
                    console.log('[ADVERTISER] Proactive cache refresh complete (' + Math.round(body.length/1024) + 'KB)');
                } else {
                    console.log('[ADVERTISER] Proactive cache refresh failed: HTTP ' + res.statusCode);
                }
            });
        });
        req.on('error', (e) => { delete sessions[tempSessionId]; console.error('[ADVERTISER] Proactive refresh error:', e.message); });
    } catch (e) {
        console.error('[ADVERTISER] Cache refresh error:', e.message);
    }
}

// Schedule hourly sync
function scheduleHourlySync() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    const msUntilNextHour = nextHour - now;
    
    setTimeout(() => {
        syncRecent(1).then(() => { refreshAdvertiserCache(); syncFbCrRecent().catch(e => console.error('[FB-CR] Hourly sync failed:', e.message)); }).catch(console.error);
        setInterval(() => syncRecent(1).then(() => { refreshAdvertiserCache(); syncFbCrRecent().catch(e => console.error('[FB-CR] Hourly sync failed:', e.message)); }).catch(console.error), 60 * 60 * 1000);
    }, msUntilNextHour);
    
    console.log(`Next sync scheduled at ${nextHour.toISOString()}`);
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Dashboard at http://localhost:${PORT}`);
    
    // On startup: if no full sync done, do it; otherwise just sync recent
    if (!fullSyncCompleted || !dataCache.lastFullSync) {
        console.log('No full sync detected - running full year 2026 sync...');
        await syncFullYear();
    } else {
        console.log('Full sync already done - syncing recent data only...');
        await syncRecent(7);
    }
    
    // FB CR cache: full sync once, then hourly recent
    try {
        if (!fbCrCache.lastFullSync) {
            console.log('[FB-CR] No full sync — running full 2026 sync...');
            await syncFbCrFull();
        } else {
            console.log('[FB-CR] Full sync exists (' + Object.keys(fbCrCache.daily).length + ' days) — syncing recent...');
            await syncFbCrRecent();
        }
    } catch (e) {
        console.error('[FB-CR] Startup sync failed:', e.message);
    }

    scheduleHourlySync();

    // Rejection report auto-update every hour
    cron.schedule("0 * * * *", () => {
        console.log("🔔 Scheduled rejection report update...");
        execFile("node", [path.join(__dirname, "generate-rejection-data.js")], (err, stdout, stderr) => {
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
            if (err) console.error("❌ Rejection report failed:", err.message);
            else console.log("✅ Rejection report updated");
        });
    }, { timezone: "Europe/Vienna" });
    console.log("📅 Rejection report scheduled every hour");

    // Origin data is now built during main sync — no separate fetch needed
    console.log('[ORIGIN] Data loaded: ' + Object.keys(originData.daily || {}).length + ' days');

    // Generate shipping speed report on startup if missing or old
    try {
        if (!fs.existsSync(SHIPPING_SPEED_FILE)) {
            console.log('🔄 Generating initial shipping speed report...');
            generateShippingSpeedData(null).catch(e => console.error('❌ Shipping speed gen failed:', e.message));
        } else {
            const ssStats = fs.statSync(SHIPPING_SPEED_FILE);
            const ssAgeHours = (Date.now() - ssStats.mtimeMs) / (1000 * 60 * 60);
            if (ssAgeHours > 24) {
                console.log('🔄 Refreshing shipping speed report (' + Math.round(ssAgeHours) + 'h old)...');
                generateShippingSpeedData(null).catch(e => console.error('❌ Shipping speed gen failed:', e.message));
            }
        }
    } catch (error) {
        console.error('❌ Initial shipping speed report failed:', error.message);
    }

    // Live Events: generate on startup if missing or >10min old, then refresh every 10min
    try {
        const leAge = liveEventsData.generatedAt ? (Date.now() - new Date(liveEventsData.generatedAt).getTime()) / 60000 : Infinity;
        if (leAge > 2) {
            console.log('[LIVE-EVENTS] Generating initial data...');
            await generateLiveEvents();
        } else {
            console.log('[LIVE-EVENTS] Data fresh (' + Math.round(leAge) + 'min old), ' + liveEventsData.events.length + ' events');
        }
    } catch (e) {
        console.error('[LIVE-EVENTS] Initial generation failed:', e.message);
    }
    // Auto-refresh every 2 minutes
    setInterval(() => {
        generateLiveEvents().catch(e => console.error('[LIVE-EVENTS] Auto-refresh failed:', e.message));
    }, 2 * 60 * 1000);
    console.log('[LIVE-EVENTS] Auto-refresh every 2 minutes');
});

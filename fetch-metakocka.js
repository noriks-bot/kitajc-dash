const https = require('https');
const fs = require('fs');
const path = require('path');

const MK_URL = 'https://main.metakocka.si/rest/eshop/v1/search';
const SECRET_KEY = 'YOUR_METAKOCKA_SECRET_KEY';
const COMPANY_ID = 'YOUR_METAKOCKA_COMPANY_ID';
const DATA_FILE = path.join(__dirname, 'metakocka-data.json');
const ORDER_MAP_FILE = path.join(__dirname, 'mk-order-map.json');

const COUNTRY_MAP = {
    'Croatia': 'HR', 'Czech Republic': 'CZ', 'Czechia': 'CZ',
    'Poland': 'PL', 'Greece': 'GR', 'Italy': 'IT',
    'Hungary': 'HU', 'Slovakia': 'SK', 'Slovenia': 'SI'
};
const CURRENCY_RATES = { 'EUR': 1, 'CZK': 0.04, 'PLN': 0.234, 'HUF': 0.0025, 'HRK': 0.133 };
const EXCLUDED_STATUSES = ['Brisan', 'TEST', 'Preklican', 'Črna lista'];

function mkSearch(dateFrom, dateTo, offset = 0, limit = 100) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            secret_key: SECRET_KEY, company_id: COMPANY_ID,
            doc_type: 'sales_order', result_type: 'doc',
            limit, offset,
            query_advance: [
                { type: 'doc_date_from', value: dateFrom },
                { type: 'doc_date_to', value: dateTo }
            ]
        });
        const url = new URL(MK_URL);
        const opts = {
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function fetchAllOrders(dateFrom, dateTo) {
    const allOrders = [];
    let offset = 0, total = null;
    while (true) {
        const resp = await mkSearch(dateFrom, dateTo, offset, 100);
        if (resp.opr_code !== '0' && resp.opr_code !== 0) {
            console.error(`MK API error: ${resp.opr_desc}`);
            break;
        }
        if (total === null) total = parseInt(resp.result_all_records || '0');
        allOrders.push(...(resp.result || []));
        offset += 100;
        if (offset >= total) break;
        await new Promise(r => setTimeout(r, 200));
    }
    return allOrders;
}

function isPaid(order) {
    const status = order.status_code || '';
    if (status === 'Zaključeno') return true;
    if (parseFloat(order.sum_paid || '0') > 0) return true;
    return false;
}

function processOrders(orders) {
    // Per-date/country aggregates for Real Money display
    const byDateCountry = {};
    // Per-order mapping: buyer_order → {status, paid, gross, neto, tax, store}
    const orderMap = {};
    let completed = 0, total = 0, allReal = 0, wcOrders = 0;

    for (const order of orders) {
        total++;
        const status = order.status_code || '';
        const buyerOrder = order.buyer_order || '';
        
        // WooCommerce orders: NORIKS-XX-*, SHOP_SDB_XX-*, or plain number (fallback to receiver country)
        const storeMatch = buyerOrder.match(/^(?:NORIKS|SHOP_SDB)[-_]([A-Z]{2})[-_]/);
        // Skip non-WC channels (SOFI, TOP_SOFI, TOP_SDB, etc.)
        if (!storeMatch && buyerOrder.match(/^[A-Z]/)) continue;
        // Plain number = WC order synced without prefix, use receiver country
        if (!storeMatch && !buyerOrder.match(/^\d+$/)) continue;
        wcOrders++;
        
        const country = storeMatch 
            ? storeMatch[1] 
            : (COUNTRY_MAP[order.receiver?.country] || COUNTRY_MAP[order.partner?.country] || 'OTHER');
        if (country === 'OTHER') continue;
        const date = (order.doc_date || '').substring(0, 10);
        const currency = order.currency_code || 'EUR';
        const rate = CURRENCY_RATES[currency] || 1;
        const sumAll = parseFloat(order.sum_all || '0');
        const sumBasic = parseFloat(order.sum_basic || '0');
        const sumTax = sumAll - sumBasic;
        const paid = isPaid(order);
        const deleted = EXCLUDED_STATUSES.includes(status);

        // Build per-order mapping (keyed by WC order number, e.g. "NORIKS-HR-5478")
        // If duplicate buyer_order (e.g. Brisan + new order), keep the non-deleted one
        const mkEntry = {
            status,
            deleted,
            paid,
            gross: Math.round(sumAll * rate * 100) / 100,
            neto: Math.round(sumBasic * rate * 100) / 100,
            tax: Math.round(sumTax * rate * 100) / 100,
            store: country,
            date
        };
        
        if (!orderMap[buyerOrder] || (orderMap[buyerOrder].deleted && !deleted)) {
            orderMap[buyerOrder] = mkEntry;
        }
        
        // Also add alias key NORIKS-{CC}-{number} for non-NORIKS orders
        // so they can match WC order.number format
        if (!storeMatch || !buyerOrder.startsWith('NORIKS-')) {
            // Extract the number part
            const numMatch = buyerOrder.match(/(\d+)$/);
            if (numMatch) {
                const aliasKey = `NORIKS-${country}-${numMatch[1]}`;
                if (!orderMap[aliasKey] || (orderMap[aliasKey].deleted && !deleted)) {
                    orderMap[aliasKey] = mkEntry;
                }
            }
        }

        // Aggregates for Real Money display
        if (!byDateCountry[date]) byDateCountry[date] = {};
        if (!byDateCountry[date][country]) {
            byDateCountry[date][country] = { orders: 0, gross: 0, neto: 0, tax: 0, allOrders: 0, allGross: 0, allNeto: 0, allTax: 0 };
        }

        if (!deleted) {
            allReal++;
            byDateCountry[date][country].allOrders++;
            byDateCountry[date][country].allGross += Math.round(sumAll * rate * 100) / 100;
            byDateCountry[date][country].allNeto += Math.round(sumBasic * rate * 100) / 100;
            byDateCountry[date][country].allTax += Math.round(sumTax * rate * 100) / 100;
        }

        if (paid) {
            completed++;
            byDateCountry[date][country].orders++;
            byDateCountry[date][country].gross += Math.round(sumAll * rate * 100) / 100;
            byDateCountry[date][country].neto += Math.round(sumBasic * rate * 100) / 100;
            byDateCountry[date][country].tax += Math.round(sumTax * rate * 100) / 100;
        }
    }

    return { byDateCountry, orderMap, completed, total, allReal, wcOrders };
}

async function main() {
    console.log('🔄 Fetching Metakocka data for 2026...');

    const now = new Date();
    const allData = {};
    const allOrderMap = {};
    let totalCompleted = 0, totalOrders = 0, totalWC = 0;

    for (let m = 1; m <= 12; m++) {
        const start = new Date(2026, m - 1, 1);
        if (start > now) break;
        const end = new Date(2026, m, 0);
        const endDate = end > now ? now : end;
        
        const from = `2026-${String(m).padStart(2,'0')}-01+02:00`;
        const to = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')}+02:00`;
        
        console.log(`  📅 ${from} → ${to}`);
        const orders = await fetchAllOrders(from, to);
        const { byDateCountry, orderMap, completed, total, wcOrders } = processOrders(orders);
        
        console.log(`     ${total} orders, ${wcOrders} WC, ${completed} paid`);
        totalCompleted += completed;
        totalOrders += total;
        totalWC += wcOrders;
        
        for (const [date, countries] of Object.entries(byDateCountry)) {
            allData[date] = countries;
        }
        Object.assign(allOrderMap, orderMap);
    }

    // Save aggregated data (for Real Money display)
    const output = {
        lastSync: new Date().toISOString(),
        totalOrders,
        totalWC,
        totalCompleted,
        data: allData
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));

    // Save per-order mapping (for cross-referencing with WC orders)
    const deletedCount = Object.values(allOrderMap).filter(o => o.deleted).length;
    const paidCount = Object.values(allOrderMap).filter(o => o.paid).length;
    fs.writeFileSync(ORDER_MAP_FILE, JSON.stringify({
        lastSync: new Date().toISOString(),
        totalOrders: Object.keys(allOrderMap).length,
        deleted: deletedCount,
        paid: paidCount,
        orders: allOrderMap
    }, null, 2));

    console.log(`\n✅ Done! ${totalWC} WC orders (${totalCompleted} paid, ${deletedCount} deleted)`);
    console.log(`   ${Object.keys(allData).length} days, ${Object.keys(allOrderMap).length} order mappings saved`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

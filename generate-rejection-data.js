#!/usr/bin/env node
// Generate rejection-data.json from Metakocka API
// Stream processing - aggregates on the fly, no large arrays in memory
// Also fetches full details for in-transit orders (delivery events, contact info)

const fs = require('fs');
const path = require('path');
const https = require('https');

const MK_SECRET = 'ee759602-961d-4431-ac64-0725ae8d9665';
const MK_COMPANY = '6371';
const MK_ENDPOINT = 'https://main.metakocka.si/rest/eshop/v1/search';
const MK_GET_ENDPOINT = 'https://main.metakocka.si/rest/eshop/v1/get_document';
const OUTPUT_FILE = path.join(__dirname, 'rejection-data.json');

const BATCH_SIZE = 100;
const DELAY_MS = 100;

const SHIPPED_STATUSES = ['completed', 'package_returned', 'shipped'];
const STATUS_MAP = {
    'completed': 'completed',
    'package_returned': 'rejected',
    'shipped': 'in_transit'
};

// Only fetch last 30 days to avoid OOM on large datasets
const FROM_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + '+02:00';
const TO_DATE = new Date().toISOString().slice(0, 10) + '+02:00';

async function fetchBatch(offset) {
    const res = await fetch(MK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            secret_key: MK_SECRET,
            company_id: MK_COMPANY,
            doc_type: 'sales_order',
            result_type: 'doc',
            limit: BATCH_SIZE,
            offset,
            query_advance: [
                { type: 'doc_date_from', value: FROM_DATE },
                { type: 'doc_date_to', value: TO_DATE }
            ]
        })
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`MK error: ${data.error}`);
    return data.result || [];
}

async function fetchOrderDetail(buyerOrder) {
    const res = await fetch(MK_GET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            secret_key: MK_SECRET,
            company_id: MK_COMPANY,
            doc_type: 'sales_order',
            buyer_order: buyerOrder,
            return_delivery_service_events: 'true'
        })
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return await res.json();
}

async function main() {
    const start = Date.now();
    console.log('Scanning Metakocka orders for kitajc stores (stream mode)...');
    
    let totalNoriks = 0;
    const summary = { shipped: 0, completed: 0, rejected: 0, in_transit: 0 };
    const byCountry = {};
    const byMonth = {};
    const byMonthCountry = {};
    const byDateCountry = {};
    
    // Collect in-transit order buyer_orders for detail fetching
    const inTransitBasic = [];
    
    let offset = 0;
    let empty = 0;
    
    while (true) {
        let batch;
        try {
            batch = await fetchBatch(offset);
        } catch (e) {
            console.error(`Error at offset ${offset}: ${e.message}, retrying...`);
            await new Promise(r => setTimeout(r, 2000));
            try { batch = await fetchBatch(offset); } catch (e2) {
                console.error(`Failed again, skipping: ${e2.message}`);
                offset += BATCH_SIZE;
                continue;
            }
        }
        
        if (batch.length === 0) {
            empty++;
            if (empty > 2) break;
            offset += BATCH_SIZE;
            continue;
        }
        empty = 0;
        
        for (const o of batch) {
            if (!o.eshop_name || !/shopdbest|sofistar/i.test(o.eshop_name)) continue;
            totalNoriks++;
            
            if (!SHIPPED_STATUSES.includes(o.status_desc)) continue;
            
            const cat = STATUS_MAP[o.status_desc] || 'other';
            const rawDate = o.shipped_date || o.doc_date;
            const date = rawDate ? rawDate.substring(0, 10) : null;
            const ciso = o.partner?.country_iso_2 || '??';
            const cname = o.partner?.country || 'Unknown';
            const month = date ? date.substring(0, 7) : 'unknown';
            
            summary.shipped++;
            summary[cat] = (summary[cat] || 0) + 1;
            
            if (!byCountry[ciso]) byCountry[ciso] = { country: cname, country_iso: ciso, shipped: 0, completed: 0, rejected: 0, in_transit: 0 };
            byCountry[ciso].shipped++;
            byCountry[ciso][cat]++;
            
            if (!byMonth[month]) byMonth[month] = { month, shipped: 0, completed: 0, rejected: 0, in_transit: 0 };
            byMonth[month].shipped++;
            byMonth[month][cat]++;
            
            const mckey = `${month}|${ciso}`;
            if (!byMonthCountry[mckey]) byMonthCountry[mckey] = { month, country: cname, country_iso: ciso, shipped: 0, completed: 0, rejected: 0, in_transit: 0 };
            byMonthCountry[mckey].shipped++;
            byMonthCountry[mckey][cat]++;
            
            if (date) {
                const dckey = `${date}|${ciso}`;
                if (!byDateCountry[dckey]) byDateCountry[dckey] = { date, country: cname, country_iso: ciso, shipped: 0, completed: 0, rejected: 0, in_transit: 0 };
                byDateCountry[dckey].shipped++;
                byDateCountry[dckey][cat]++;
            }
            
            // Collect in-transit orders for detail fetching
            if (cat === 'in_transit' && o.buyer_order) {
                inTransitBasic.push({
                    buyer_order: o.buyer_order,
                    date,
                    ciso,
                    total: o.doc_total || ''
                });
            }
        }
        
        batch = null;
        offset += BATCH_SIZE;
        if (offset % 2000 === 0) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(0);
            const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
            console.log(`  ${offset} scanned, ${totalNoriks} kitajc (${elapsed}s, ${mem}MB)`);
        }
        
        await new Promise(r => setTimeout(r, DELAY_MS));
    }
    
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`Scan complete: ${offset} total, ${totalNoriks} kitajc orders (${elapsed}s)`);
    console.log(`In-transit orders to fetch details: ${inTransitBasic.length}`);
    
    if (totalNoriks === 0) {
        console.error('ERROR: No kitajc orders found!');
        process.exit(1);
    }
    
    // Fetch delivery events for in-transit orders
    const inTransitOrders = [];
    let fetched = 0;
    for (const itOrder of inTransitBasic) {
        fetched++;
        if (fetched % 20 === 0) {
            console.log(`  Fetching in-transit details: ${fetched}/${inTransitBasic.length}`);
        }
        try {
            const detail = await fetchOrderDetail(itOrder.buyer_order);
            const rawEvents = Array.isArray(detail.delivery_service_events) ? detail.delivery_service_events : (detail.delivery_service_events ? [detail.delivery_service_events] : []);
            const events = rawEvents.map(e => ({
                date: e.event_date || '',
                code: (e.event_code || '').toString(),
                status: e.event_status || ''
            })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            
            const lastEvent = events.length > 0 ? events[events.length - 1] : null;
            
            const p = detail.receiver || detail.partner || {};
            const pc = p.partner_contact || {};
            
            // Extract tracking codes
            const trackingCodes = [];
            for (const evt of rawEvents) {
                const desc = evt.event_status || '';
                const match = desc.match(/(?:sledenje|tracking)[:\s]*([A-Z0-9\s]+)/i);
                if (match) trackingCodes.push(match[1].trim());
            }
            if (detail.tracking_code && !trackingCodes.includes(detail.tracking_code)) trackingCodes.unshift(detail.tracking_code);
            
            // Extract total and items from product_list
            const productList = Array.isArray(detail.product_list) ? detail.product_list : [];
            const items = productList.map(p2 => ({
                name: p2.name || p2.code || '',
                amount: p2.amount || '1',
                price: p2.price_with_tax || p2.price || ''
            }));
            const orderTotal = detail.doc_total || productList.reduce((sum, p2) => sum + (parseFloat(p2.price_with_tax || p2.price || 0) * parseFloat(p2.amount || 1)), 0).toFixed(2);
            inTransitOrders.push({
                id: detail.count_code || itOrder.buyer_order,
                title: itOrder.buyer_order,
                customer: p.customer || '',
                address: [p.street, p.post_number, p.place, p.country].filter(Boolean).join(', '),
                phone: pc.gsm || pc.phone || '',
                email: pc.email || '',
                country_iso: itOrder.ciso,
                shippedDate: itOrder.date,
                deliveryService: detail.delivery_service || '',
                trackingCode: trackingCodes[0] || '',
                localTrackingCode: trackingCodes[1] || '',
                events,
                lastEvent,
                total: orderTotal,
                items
            });
        } catch (e) {
            console.error(`  Error fetching ${itOrder.buyer_order}: ${e.message}`);
            // Still add without events
            inTransitOrders.push({
                id: itOrder.buyer_order,
                title: itOrder.buyer_order,
                customer: '',
                address: '',
                phone: '',
                email: '',
                country_iso: itOrder.ciso,
                shippedDate: itOrder.date,
                deliveryService: '',
                trackingCode: '',
                localTrackingCode: '',
                events: [],
                lastEvent: null,
                total: orderTotal,
                items
            });
        }
        await new Promise(r => setTimeout(r, 80));
    }
    
    console.log(`Fetched details for ${inTransitOrders.length} in-transit orders`);
    
    // Classify each order for CS Action Required
    function classifyOrder(order) {
        const events = order.events || [];
        const lastEvent = order.lastEvent;
        
        if (events.length === 0) return 'no_events';
        
        const allText = events.map(e => ((e.code || '') + ' ' + (e.status || '')).toLowerCase()).join(' ');
        
        // Check event codes for quick classification
        const lastCode = (order.lastEvent?.code || '').toString();
        const allCodes = events.map(e => (e.code || '').toString());
        
        // Code -2 = shipping error (Unprocessable Entity, external_service_error, etc.)
        if (allCodes.includes('-2') || /unprocessable|external_service_error|parcel_weight.*invalid|carrier.?error/i.test(allText)) return 'failed_delivery';
        
        // Paketomat / parcel locker
        if (/paketomat|parcel.?locker|parcel.?machine|automata|z-box|z.box|alzabox|bal[íi]kobot|bal[íi]kovna|packeta|v[ýy]dejn[íi]\s*m[íi]sto|csomagpont|csomagautomata|foxpost|pick.?up.?point|odbern[ée]\s*miesto|punto.?di.?ritiro|samoobslu[žz]n/i.test(allText)) return 'paketomat';
        
        // Na pošti / post office / waiting for pickup (code 400 = destination branch)
        if (/po[šs]ta|poczta|post.?office|[úu]rad|hivatal|ufficio|[čc]ak[áa]\s*na|awaiting.?collection|pripravljen.?za.?prevzem|ready.?for.?pickup|notification.?sent|obavijest|waiting.?for.?pickup|destination.?branch/i.test(allText)) return 'posta';
        
        // Failed delivery
        if (/failed|neuspe[šs]n|nedostav|unsuccessful|nicht.?zugestellt|undeliverable|refused|odbijen|nieudana|sikertelen|visszautas[íi]t|rifiutat|nedoru[čc]en|nemo[žz]no.?dostaviti|adresa.*nepozn|address.*unknown|not.?at.?home|ni.?doma|nieobecn/i.test(allText)) return 'failed_delivery';
        
        // Stuck - no event in 7+ days
        if (lastEvent && lastEvent.date) {
            const lastDate = new Date(lastEvent.date);
            const now = new Date();
            const daysDiff = (now - lastDate) / (1000 * 60 * 60 * 24);
            if (daysDiff >= 7) return 'stuck';
        }
        
        return 'in_transit';
    }
    
    for (const order of inTransitOrders) {
        order.csStatus = classifyOrder(order);
    }
    
    // Log CS status summary
    const csStats = {};
    for (const o of inTransitOrders) {
        csStats[o.csStatus] = (csStats[o.csStatus] || 0) + 1;
    }
    console.log('CS Status breakdown:', JSON.stringify(csStats));
    
    const calcRate = (obj) => {
        obj.rejection_rate = obj.shipped > 0 ? Math.round((obj.rejected / obj.shipped) * 1000) / 10 : 0;
        return obj;
    };
    
    const result = {
        generated_at: new Date().toISOString(),
        total_orders: totalNoriks,
        total_shipped: summary.shipped,
        summary: { ...summary, other: totalNoriks - summary.shipped },
        totals_by_country: Object.values(byCountry).map(calcRate).sort((a, b) => b.shipped - a.shipped),
        by_month: Object.values(byMonth).map(calcRate).sort((a, b) => a.month.localeCompare(b.month)),
        by_month_country: Object.values(byMonthCountry).map(calcRate).sort((a, b) => a.month.localeCompare(b.month) || b.shipped - a.shipped),
        by_date_country: Object.values(byDateCountry).map(calcRate).sort((a, b) => a.date.localeCompare(b.date) || b.shipped - a.shipped),
        months_available: Object.values(byMonth).map(m => m.month).sort(),
        in_transit_orders: inTransitOrders
    };
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result));
    console.log(`Written to ${OUTPUT_FILE}`);
    console.log(`Summary: ${summary.shipped} shipped, ${summary.rejected} rejected (${calcRate({...summary}).rejection_rate}%)`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

#!/usr/bin/env node
/**
 * Fetch Inventory from Google Sheets - Noriks Stock
 * 
 * Sheet format:
 *   - Row with size name = start of size section
 *   - Rows with [COLOR, STOCK] = inventory for that color
 * 
 * Sheets:
 *   - trenutna zaloga MAJICE (T-Shirts)
 *   - trenutna zaloga BOKSARICE (Boxers)
 *   - NOGAVICE (Socks)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1lEoACxQjZx999TuDiq5FG9OrXKGK3D8BEaa516CN1wQ';
const CREDENTIALS_PATH = path.join(__dirname, '../.secrets/google-sheets-credentials.json');
const OUTPUT_PATH = path.join(__dirname, 'inventory-data.json');

// Sheet configs: [sheetName, productType]
const SHEETS = [
    ['trenutna zaloga MAJICE', 'T-Shirt'],
    ['trenutna zaloga BOKSARICE', 'Boxers'],
    ['NOGAVICE', 'Socks']
];

// Color mappings: Slovenian → English
const COLOR_MAP = {
    'ČRNA': 'Black',
    'MODRA': 'Blue',
    'ZELENA': 'Green',
    'SIVA': 'Grey',
    'RJAVA': 'Brown',
    'BEŽ': 'Beige',
    'BELA': 'White',
    'RDEČA': 'Red'
};

// Valid sizes to detect
const VALID_SIZES = ['4XL', '3XL', '2XL', 'XL', 'L', 'M', 'S', 'XS', '43/46', '39/42'];

async function fetchInventory() {
    console.log('Loading Google Sheets credentials...');
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    
    const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    
    const inventory = [];
    
    for (const [sheetName, productType] of SHEETS) {
        console.log(`\nReading: ${sheetName} (${productType})...`);
        
        try {
            const data = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1:Z100`
            });
            
            const rows = data.data.values || [];
            let currentSize = null;
            
            for (const row of rows) {
                if (!row || row.length === 0) continue;
                
                const firstCell = (row[0] || '').toString().trim().toUpperCase();
                
                // Check if this is a size row
                if (isSize(firstCell)) {
                    currentSize = normalizeSize(firstCell);
                    continue;
                }
                
                // Check if this is a color row with stock
                const colorKey = firstCell.replace(/\s+/g, '');
                if (COLOR_MAP[colorKey] && currentSize) {
                    const stock = parseInt(row[1]) || 0;
                    const color = COLOR_MAP[colorKey];
                    
                    const sku = `${productType.toUpperCase().replace('-', '')}-${color.toUpperCase()}-${currentSize}`;
                    
                    inventory.push({
                        sku,
                        type: productType,
                        color,
                        size: currentSize,
                        stock
                    });
                }
            }
        } catch (err) {
            console.error(`Error reading ${sheetName}:`, err.message);
        }
    }
    
    // Preserve existing startDate and initialValues if inventory-data.json already exists
    let existingData = {};
    try {
        existingData = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    } catch (e) {}

    const output = {
        generated: new Date().toISOString(),
        startDate: existingData.startDate || new Date().toISOString().split('T')[0], // Preserve existing day 0!
        source: `Google Sheet: ${SPREADSHEET_ID}`,
        totalSKUs: inventory.length,
        totalStock: inventory.reduce((sum, i) => sum + i.stock, 0),
        inventory
    };

    // Preserve initialValues if they exist (critical for stock calculation)
    if (existingData.initialValues) {
        output.initialValues = existingData.initialValues;
        console.log(`\n⚠️  Preserved existing startDate (${output.startDate}) and initialValues (${Object.keys(output.initialValues).length} SKUs)`);
        console.log(`   NOTE: Stock values from Sheet are RAW — fetch-sales.js will recalculate using initialValues - sales`);
    }
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\n✅ Saved ${inventory.length} SKUs to inventory-data.json`);
    console.log(`   Total stock: ${output.totalStock.toLocaleString()} units`);
    console.log(`   Start date (day 0): ${output.startDate}`);
    
    // Show summary by type
    const byType = {};
    inventory.forEach(i => {
        byType[i.type] = (byType[i.type] || 0) + i.stock;
    });
    console.log('\nStock by type:');
    Object.entries(byType).forEach(([type, stock]) => {
        console.log(`   ${type}: ${stock.toLocaleString()}`);
    });
    
    return output;
}

function isSize(str) {
    const normalized = normalizeSize(str);
    return VALID_SIZES.includes(normalized);
}

function normalizeSize(str) {
    // Clean up the string
    let s = str.trim().toUpperCase();
    
    // Handle sock sizes
    if (s.includes('43') && s.includes('46')) return '43/46';
    if (s.includes('39') && s.includes('42')) return '39/42';
    
    // Handle clothing sizes
    if (s === '4XL' || s.startsWith('4XL')) return '4XL';
    if (s === '3XL' || s.startsWith('3XL')) return '3XL';
    if (s === '2XL' || s.startsWith('2XL')) return '2XL';
    if (s === 'XL' || s.startsWith('XL')) return 'XL';
    if (s === 'XS' || s.startsWith('XS')) return 'XS';
    if (s === 'L' || s.startsWith('L ')) return 'L';
    if (s === 'M' || s.startsWith('M ')) return 'M';
    if (s === 'S' || s.startsWith('S ')) return 'S';
    
    return s;
}

// Run if called directly
if (require.main === module) {
    fetchInventory()
        .then(() => console.log('\nDone!'))
        .catch(err => {
            console.error('Error:', err.message);
            process.exit(1);
        });
}

module.exports = { fetchInventory };

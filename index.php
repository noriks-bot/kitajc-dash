<?php
// Noriks Dashboard - API Backend + Frontend
header('Content-Type: text/html; charset=utf-8');

// Config
$config = [
    'HR' => [
        'url' => 'https://noriks.com/hr/wp-json/wc/v3',
        'key' => 'ck_d73881b20fd65125fb071414b8d54af7681549e3',
        'secret' => 'cs_e024298df41e4352d90e006d2ec42a5b341c1ce5',
        'currency' => 'EUR',
        'rate' => 1
    ],
    'CZ' => [
        'url' => 'https://noriks.com/cz/wp-json/wc/v3',
        'key' => 'ck_396d624acec5f7a46dfcfa7d2a74b95c82b38962',
        'secret' => 'cs_2a69c7ad4a4d118a2b8abdf44abdd058c9be9115',
        'currency' => 'CZK',
        'rate' => 0.041
    ],
    'PL' => [
        'url' => 'https://noriks.com/pl/wp-json/wc/v3',
        'key' => 'ck_8fd83582ada887d0e586a04bf870d43634ca8f2c',
        'secret' => 'cs_f1bf98e46a3ae0623c5f2f9fcf7c2478240c5115',
        'currency' => 'PLN',
        'rate' => 0.232
    ]
];

$fb_token = 'EAAR1d7hDpEkBQs1YPhRZBgu4UZA8DLZBWzXXTItG3NL8LdpRmdhQ3nh1DHW0ZCfpOz25qT0n5Ca0PzrTcRtw1tHYZBATVMZCqn0rjrnUgZCYk6U57ZBisv0vpLLL9lIIn51bk7n5ISZBXdPTIDovAFHghGOsInJoqhvqQaWmey3qJByEiRTfcrWF3EsXYNZAm5yaRYL4y94n9H';
$fb_account = 'act_1922887421998222';

// API endpoint
if (isset($_GET['api'])) {
    header('Content-Type: application/json');
    
    $start = $_GET['start'] ?? date('Y-m-d', strtotime('-7 days'));
    $end = $_GET['end'] ?? date('Y-m-d');
    
    $result = ['dates' => [], 'countries' => ['HR', 'CZ', 'PL'], 'data' => []];
    
    // Fetch Facebook Ads data
    $fb_url = "https://graph.facebook.com/v21.0/{$fb_account}/insights?" . http_build_query([
        'fields' => 'spend,actions,action_values',
        'time_range' => json_encode(['since' => $start, 'until' => $end]),
        'time_increment' => 1,
        'breakdowns' => 'country',
        'access_token' => $fb_token
    ]);
    
    $fb_data = json_decode(file_get_contents($fb_url), true);
    $fb_by_date = [];
    
    if (isset($fb_data['data'])) {
        foreach ($fb_data['data'] as $row) {
            $date = $row['date_start'];
            $country = $row['country'];
            if (!in_array($country, ['HR', 'CZ', 'PL'])) continue;
            
            $spend = floatval($row['spend'] ?? 0);
            $purchases = 0;
            $revenue = 0;
            
            if (isset($row['actions'])) {
                foreach ($row['actions'] as $action) {
                    if ($action['action_type'] === 'purchase') {
                        $purchases = intval($action['value']);
                        break;
                    }
                }
            }
            if (isset($row['action_values'])) {
                foreach ($row['action_values'] as $av) {
                    if ($av['action_type'] === 'purchase') {
                        $revenue = floatval($av['value']);
                        break;
                    }
                }
            }
            
            $fb_by_date[$date][$country] = [
                'spend' => $spend,
                'fb_purchases' => $purchases,
                'fb_revenue' => $revenue
            ];
        }
    }
    
    // Fetch WooCommerce data per country
    foreach ($config as $country => $cfg) {
        $wc_url = "{$cfg['url']}/orders?" . http_build_query([
            'after' => "{$start}T00:00:00",
            'before' => "{$end}T23:59:59",
            'per_page' => 100,
            'consumer_key' => $cfg['key'],
            'consumer_secret' => $cfg['secret']
        ]);
        
        $orders = json_decode(file_get_contents($wc_url), true) ?: [];
        
        // Group by date
        $by_date = [];
        $emails_by_date = [];
        
        foreach ($orders as $order) {
            $date = substr($order['date_created'], 0, 10);
            if (!isset($by_date[$date])) {
                $by_date[$date] = ['orders' => 0, 'revenue' => 0, 'new' => 0, 'returning' => 0];
                $emails_by_date[$date] = [];
            }
            
            $by_date[$date]['orders']++;
            $by_date[$date]['revenue'] += floatval($order['total']);
            
            $email = $order['billing']['email'] ?? '';
            if ($email && !in_array($email, $emails_by_date[$date])) {
                $emails_by_date[$date][] = $email;
                
                // Check if returning customer
                $check_url = "{$cfg['url']}/orders?" . http_build_query([
                    'search' => $email,
                    'before' => "{$date}T00:00:00",
                    'per_page' => 1,
                    'consumer_key' => $cfg['key'],
                    'consumer_secret' => $cfg['secret']
                ]);
                $prev = json_decode(file_get_contents($check_url), true) ?: [];
                
                if (count($prev) > 0) {
                    $by_date[$date]['returning']++;
                } else {
                    $by_date[$date]['new']++;
                }
            }
        }
        
        // Merge with FB data
        foreach ($by_date as $date => $data) {
            if (!isset($result['data'][$date])) {
                $result['data'][$date] = [];
                $result['dates'][] = $date;
            }
            
            $spend = $fb_by_date[$date][$country]['spend'] ?? 0;
            $revenue_eur = $data['revenue'] * $cfg['rate'];
            
            $result['data'][$date][$country] = [
                'orders' => $data['orders'],
                'new' => $data['new'],
                'returning' => $data['returning'],
                'revenue' => round($data['revenue'], 2),
                'revenue_eur' => round($revenue_eur, 2),
                'currency' => $cfg['currency'],
                'spend' => round($spend, 2),
                'cpa' => $data['orders'] > 0 ? round($spend / $data['orders'], 2) : null,
                'cpa_new' => $data['new'] > 0 ? round($spend / $data['new'], 2) : null,
                'roas' => $spend > 0 ? round($revenue_eur / $spend, 2) : null
            ];
        }
    }
    
    sort($result['dates']);
    echo json_encode($result);
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Noriks Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; flex-wrap: wrap; gap: 15px; }
        h1 { font-size: 28px; font-weight: 600; }
        .filters { display: flex; gap: 10px; align-items: center; }
        .filters input, .filters button { padding: 10px 15px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; font-size: 14px; }
        .filters button { background: #3b82f6; border: none; cursor: pointer; font-weight: 500; }
        .filters button:hover { background: #2563eb; }
        .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .total-card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .total-card .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 5px; }
        .total-card .value { font-size: 28px; font-weight: 700; }
        .total-card .value.green { color: #22c55e; }
        .total-card .value.blue { color: #3b82f6; }
        .total-card .value.yellow { color: #eab308; }
        .total-card .value.purple { color: #a855f7; }
        .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(500px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .chart-container { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .chart-container h3 { margin-bottom: 15px; font-size: 16px; color: #94a3b8; }
        .table-container { background: #1e293b; border-radius: 12px; border: 1px solid #334155; overflow: hidden; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #334155; }
        th { background: #0f172a; font-weight: 600; font-size: 12px; text-transform: uppercase; color: #94a3b8; }
        tr:hover { background: #334155; }
        .country-flag { font-size: 18px; margin-right: 8px; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
        .badge-green { background: #166534; color: #86efac; }
        .badge-yellow { background: #854d0e; color: #fde047; }
        .badge-red { background: #991b1b; color: #fca5a5; }
        .loading { text-align: center; padding: 50px; color: #64748b; }
        @media (max-width: 600px) {
            .charts { grid-template-columns: 1fr; }
            .totals { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Noriks Dashboard</h1>
        <div class="filters">
            <input type="date" id="startDate">
            <input type="date" id="endDate">
            <button onclick="loadData()">Apply</button>
        </div>
    </div>
    
    <div class="totals" id="totals">
        <div class="total-card"><div class="label">Total Spend</div><div class="value blue" id="totalSpend">—</div></div>
        <div class="total-card"><div class="label">Total Orders</div><div class="value" id="totalOrders">—</div></div>
        <div class="total-card"><div class="label">Total Revenue</div><div class="value green" id="totalRevenue">—</div></div>
        <div class="total-card"><div class="label">Overall CPA</div><div class="value yellow" id="totalCPA">—</div></div>
        <div class="total-card"><div class="label">CPA (New)</div><div class="value purple" id="totalCPANew">—</div></div>
        <div class="total-card"><div class="label">Overall ROAS</div><div class="value green" id="totalROAS">—</div></div>
    </div>
    
    <div class="charts">
        <div class="chart-container">
            <h3>Orders by Country</h3>
            <canvas id="ordersChart"></canvas>
        </div>
        <div class="chart-container">
            <h3>ROAS by Country</h3>
            <canvas id="roasChart"></canvas>
        </div>
        <div class="chart-container">
            <h3>CPA Trend</h3>
            <canvas id="cpaChart"></canvas>
        </div>
        <div class="chart-container">
            <h3>Revenue vs Spend</h3>
            <canvas id="revenueChart"></canvas>
        </div>
    </div>
    
    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Country</th>
                    <th>Orders</th>
                    <th>New / Ret</th>
                    <th>Revenue</th>
                    <th>Spend</th>
                    <th>CPA</th>
                    <th>CPA (New)</th>
                    <th>ROAS</th>
                </tr>
            </thead>
            <tbody id="tableBody">
                <tr><td colspan="9" class="loading">Loading...</td></tr>
            </tbody>
        </table>
    </div>
    
    <script>
        const flags = { HR: '🇭🇷', CZ: '🇨🇿', PL: '🇵🇱' };
        const colors = { HR: '#3b82f6', CZ: '#22c55e', PL: '#eab308' };
        let charts = {};
        
        // Set default dates
        const today = new Date();
        const weekAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
        document.getElementById('startDate').value = weekAgo.toISOString().split('T')[0];
        document.getElementById('endDate').value = today.toISOString().split('T')[0];
        
        async function loadData() {
            const start = document.getElementById('startDate').value;
            const end = document.getElementById('endDate').value;
            
            const res = await fetch(`?api=1&start=${start}&end=${end}`);
            const data = await res.json();
            
            renderTotals(data);
            renderCharts(data);
            renderTable(data);
        }
        
        function renderTotals(data) {
            let spend = 0, orders = 0, revenue = 0, newC = 0;
            
            for (const date of data.dates) {
                for (const country of data.countries) {
                    const d = data.data[date]?.[country];
                    if (d) {
                        spend += d.spend || 0;
                        orders += d.orders || 0;
                        revenue += d.revenue_eur || 0;
                        newC += d.new || 0;
                    }
                }
            }
            
            document.getElementById('totalSpend').textContent = `€${spend.toFixed(2)}`;
            document.getElementById('totalOrders').textContent = orders;
            document.getElementById('totalRevenue').textContent = `€${revenue.toFixed(2)}`;
            document.getElementById('totalCPA').textContent = orders > 0 ? `€${(spend / orders).toFixed(2)}` : '—';
            document.getElementById('totalCPANew').textContent = newC > 0 ? `€${(spend / newC).toFixed(2)}` : '—';
            document.getElementById('totalROAS').textContent = spend > 0 ? (revenue / spend).toFixed(2) + 'x' : '—';
        }
        
        function renderCharts(data) {
            const dates = data.dates;
            
            // Destroy existing charts
            Object.values(charts).forEach(c => c.destroy());
            
            // Orders chart
            charts.orders = new Chart(document.getElementById('ordersChart'), {
                type: 'bar',
                data: {
                    labels: dates,
                    datasets: data.countries.map(c => ({
                        label: c,
                        data: dates.map(d => data.data[d]?.[c]?.orders || 0),
                        backgroundColor: colors[c]
                    }))
                },
                options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } } }
            });
            
            // ROAS chart
            charts.roas = new Chart(document.getElementById('roasChart'), {
                type: 'line',
                data: {
                    labels: dates,
                    datasets: data.countries.map(c => ({
                        label: c,
                        data: dates.map(d => data.data[d]?.[c]?.roas || 0),
                        borderColor: colors[c],
                        tension: 0.3,
                        fill: false
                    }))
                },
                options: { responsive: true }
            });
            
            // CPA chart
            charts.cpa = new Chart(document.getElementById('cpaChart'), {
                type: 'line',
                data: {
                    labels: dates,
                    datasets: data.countries.map(c => ({
                        label: c,
                        data: dates.map(d => data.data[d]?.[c]?.cpa || 0),
                        borderColor: colors[c],
                        tension: 0.3,
                        fill: false
                    }))
                },
                options: { responsive: true }
            });
            
            // Revenue vs Spend
            const totalRevenue = dates.map(d => data.countries.reduce((s, c) => s + (data.data[d]?.[c]?.revenue_eur || 0), 0));
            const totalSpend = dates.map(d => data.countries.reduce((s, c) => s + (data.data[d]?.[c]?.spend || 0), 0));
            
            charts.revenue = new Chart(document.getElementById('revenueChart'), {
                type: 'line',
                data: {
                    labels: dates,
                    datasets: [
                        { label: 'Revenue (€)', data: totalRevenue, borderColor: '#22c55e', tension: 0.3, fill: false },
                        { label: 'Spend (€)', data: totalSpend, borderColor: '#ef4444', tension: 0.3, fill: false }
                    ]
                },
                options: { responsive: true }
            });
        }
        
        function renderTable(data) {
            const tbody = document.getElementById('tableBody');
            let html = '';
            
            for (const date of [...data.dates].reverse()) {
                for (const country of data.countries) {
                    const d = data.data[date]?.[country];
                    if (!d) continue;
                    
                    const roasBadge = d.roas >= 2 ? 'badge-green' : d.roas >= 1 ? 'badge-yellow' : 'badge-red';
                    
                    html += `<tr>
                        <td>${date}</td>
                        <td><span class="country-flag">${flags[country]}</span>${country}</td>
                        <td>${d.orders}</td>
                        <td>${d.new} / ${d.returning}</td>
                        <td>${d.currency === 'EUR' ? '€' : ''}${d.revenue} ${d.currency !== 'EUR' ? d.currency : ''}</td>
                        <td>€${d.spend}</td>
                        <td>${d.cpa ? '€' + d.cpa : '—'}</td>
                        <td>${d.cpa_new ? '€' + d.cpa_new : '—'}</td>
                        <td><span class="badge ${roasBadge}">${d.roas ? d.roas + 'x' : '—'}</span></td>
                    </tr>`;
                }
            }
            
            tbody.innerHTML = html || '<tr><td colspan="9" class="loading">No data</td></tr>';
        }
        
        // Initial load
        loadData();
    </script>
</body>
</html>

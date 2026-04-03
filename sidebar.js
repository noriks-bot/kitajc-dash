// Shared Sidebar Template
// Include this script in all dashboard pages for consistent sidebar

let _userRole = null;

async function getUserRole() {
    if (_userRole) return _userRole;
    try {
        const res = await fetch('/dashboard/api/me');
        if (res.ok) { const data = await res.json(); _userRole = data.role || 'admin'; }
        else _userRole = 'admin';
    } catch(e) { _userRole = 'admin'; }
    return _userRole;
}

async function renderSidebar(activePage) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const role = await getUserRole();

    const sections = [];

    // Overview — admin only
    if (role === 'admin') {
        sections.push(`<div class="nav-section">
            <div class="nav-section-title">Overview</div>
            <a href="/dashboard/" class="nav-item ${activePage === 'dashboard' ? 'active' : ''}">
                <span class="nav-icon">📊</span><span>Dashboard</span>
            </a>
        </div>`);
    }


    // Stock — admin + warehouse
    if (role === 'admin' || role === 'warehouse') {
        sections.push(`<div class="nav-section">
            <div class="nav-section-title">Stock</div>
            <a href="/dashboard/stock.html" class="nav-item ${activePage === 'stock' ? 'active' : ''}">
                <span class="nav-icon">📦</span><span>Stock</span>
            </a>
        </div>`);
    }

    // Rejections — admin + warehouse
    if (role === 'admin' || role === 'warehouse') {
        sections.push(`<div class="nav-section">
            <div class="nav-section-title">Rejections</div>
            <a href="/dashboard/rejection-report.html" class="nav-item ${activePage === 'rejection-report' ? 'active' : ''}">
                <span class="nav-icon">📋</span><span>Rejection Report</span>
            </a>
            ${role === 'admin' ? `<a href="/dashboard/rejections.html" class="nav-item ${activePage === 'rejections' ? 'active' : ''}"><span class="nav-icon">❌</span><span>Rejection Settings</span></a>` : ''}
            <a href="/dashboard/live-events.html" class="nav-item ${activePage === 'live-events' ? 'active' : ''}" id="nav-live-events">
                <span class="nav-icon">🔴</span><span>Rejection Resolver</span>
            </a>
        </div>`);
    }

    // Settings — admin only (includes Users)
    const settingsItems = [];
    if (role === 'admin') {

        settingsItems.push(`<a href="/dashboard/shipping.html" class="nav-item ${activePage === 'shipping' ? 'active' : ''}">
            <span class="nav-icon">🚚</span><span>Shipping Costs</span>
        </a>`);
        settingsItems.push(`<a href="/dashboard/users.html" class="nav-item ${activePage === 'users' ? 'active' : ''}">
            <span class="nav-icon">👥</span><span>Users</span>
        </a>`);
    }
    // Warehouse: no settings
    settingsItems.push(`<a href="#" class="nav-item" onclick="logout(); return false;">
        <span class="nav-icon">🚪</span><span>Logout</span>
    </a>`);
    sections.push(`<div class="nav-section">
        <div class="nav-section-title">Settings</div>
        ${settingsItems.join('\n')}
    </div>`);

    sidebar.innerHTML = `
        <div class="sidebar-header">
            <div class="sidebar-brand">
                <div class="sidebar-logo">N</div>
                <div>
                    <div class="sidebar-title">Noriks Kitajc</div>
                    <div class="sidebar-subtitle">Analytics Platform</div>
                </div>
            </div>
        </div>
        <nav class="sidebar-nav">${sections.join('\n')}</nav>
        <div class="sidebar-collapse">
            <button class="collapse-btn" onclick="toggleCollapse()">
                <span class="collapse-icon">◀</span>
                <span class="collapse-text">Hide Menu</span>
            </button>
        </div>
    `;

    if (localStorage.getItem('sidebarCollapsed') === 'true') {
        sidebar.classList.add('collapsed');
        const collapseText = document.querySelector('.collapse-text');
        const collapseIcon = document.querySelector('.collapse-icon');
        if (collapseText) collapseText.textContent = 'Show';
        if (collapseIcon) collapseIcon.textContent = '▶';
    }
}

function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
    document.querySelector('.sidebar-overlay').classList.toggle('active');
}

function toggleCollapse() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.querySelector('.collapse-btn');
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    btn.querySelector('.collapse-text').textContent = isCollapsed ? 'Show' : 'Hide Menu';
    btn.querySelector('.collapse-icon').textContent = isCollapsed ? '▶' : '◀';
    localStorage.setItem('sidebarCollapsed', isCollapsed);
}

function logout() {
    fetch('/dashboard/api/logout').then(() => { window.location.href = '/dashboard/login'; });
}


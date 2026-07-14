
    // ─── Utility Functions ──────────────────────────────────────────────────

    function safeParseDate(dateStr) {
      if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return null;
      }
      const d = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(d.getTime())) return null;
      return d;
    }

    function safeFormatDate(dateStr, options) {
      const d = safeParseDate(dateStr);
      if (!d) return dateStr || '—';
      return d.toLocaleDateString('en-US', options);
    }

    function formatTime(totalMinutes) {
      if (totalMinutes == null || totalMinutes <= 0) return "0s";
      const totalSeconds = Math.round(totalMinutes * 60);
      if (totalSeconds < 60) return `${totalSeconds}s`;
      const hours = Math.floor(totalMinutes / 60);
      const mins = Math.ceil(totalMinutes % 60);
      if (hours > 0 && mins >= 60) return `${hours + 1}h`;
      if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      return `${mins}m`;
    }

    function getFaviconUrl(domain) {
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    }

    function updateTopSiteFavicon(domain) {
      const star = document.getElementById('topSiteStar');
      const img = document.getElementById('topSiteFavicon');
      if (!star || !img) return;
      if (domain) {
        star.classList.add('hidden');
        img.classList.remove('hidden');
        img.src = getFaviconUrl(domain);
        img.alt = domain;
        img.onerror = function() { this.classList.add('hidden'); star.classList.remove('hidden'); };
      } else {
        img.classList.add('hidden');
        star.classList.remove('hidden');
        img.src = '';
      }
    }

    function getGradientClass(index) {
      const gradients = [
        'bar-gradient-1', 'bar-gradient-2', 'bar-gradient-3', 'bar-gradient-4',
        'bar-gradient-5', 'bar-gradient-6', 'bar-gradient-7', 'bar-gradient-8',
        'bar-gradient-9', 'bar-gradient-10'
      ];
      return gradients[index % gradients.length];
    }

    // ─── Trend Display Helpers ────────────────────────────────────────

    function getTrendHtml(domain) {
      const trends = window._lastTrendData;
      if (!trends || !trends.trends) return '';
      const t = trends.trends.find(d => d.domain === domain);
      if (!t || t.direction === 'flat') return '';
      const isUp = t.direction === 'up';
      const color = isUp ? 'text-red-500 dark:text-red-400' : 'text-emerald-500 dark:text-emerald-400';
      const arrow = isUp ? '▲' : '▼';
      const pct = Math.abs(t.changePercent);
      return `<span class="${color} text-[10px] font-semibold ml-1.5" title="${isUp ? 'Up' : 'Down'} ${pct}% vs previous period">${arrow}${pct > 0 ? pct : ''}</span>`;
    }



    function getDisplayName(domain) {
      if (!domain) return '—';
      const parts = domain.split('.');
      const mainName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      const formattedMain = mainName.charAt(0).toUpperCase() + mainName.slice(1);
      const subdomainParts = parts.slice(0, parts.length - 2).filter(p => p !== 'www');
      if (subdomainParts.length > 0) {
        const subdomainStr = subdomainParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' · ');
        return `${subdomainStr} · ${formattedMain}`;
      }
      return formattedMain;
    }

    // ─── Animated Counter ──────────────────────────────────────────────────

    function animateCounter(el, target, suffix = '') {
      if (!el) return;
      const isInt = Number.isInteger(target);
      const duration = 800;
      const start = performance.now();
      const startVal = 0;

      function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = startVal + (target - startVal) * eased;
        if (isInt) {
          el.textContent = Math.round(current) + suffix;
        } else {
          el.textContent = current.toFixed(1) + suffix;
        }
        if (progress < 1) requestAnimationFrame(update);
      }
      requestAnimationFrame(update);
    }

    // ─── Daily Chart ──────────────────────────────────────────────────────

    function renderDailyChart(data) {
      const canvas = document.getElementById('dailyChart');
      const container = document.getElementById('chartContainer');
      const tooltip = document.getElementById('chartTooltip');
      const chartEmpty = document.getElementById('chartEmpty');
      const chartAvg = document.getElementById('chartAvg');
      const ctx = canvas.getContext('2d');

      const breakdown = data.dailyBreakdown || [];
      const section = document.getElementById('chartSection');

      if (!breakdown || breakdown.length === 0) {
        chartEmpty.classList.remove('hidden');
        canvas.classList.add('hidden');
        chartAvg.textContent = '';
        if (section) section.style.display = 'block';
        return;
      }

      chartEmpty.classList.add('hidden');
      canvas.classList.remove('hidden');

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      const isDark = document.documentElement.classList.contains('dark');
      const textColor = isDark ? '#9ca3af' : '#6b7280';
      const gridColor = isDark ? 'rgba(75,85,99,0.3)' : 'rgba(229,231,235,0.8)';
      const barColor = isDark ? 'rgba(99,102,241,0.7)' : 'rgba(99,102,241,0.6)';
      const barHoverColor = isDark ? 'rgba(129,140,248,0.9)' : 'rgba(99,102,241,0.85)';

      const padding = { top: 16, bottom: 36, left: 36, right: 12 };
      const chartW = w - padding.left - padding.right;
      const chartH = h - padding.top - padding.bottom;

      const maxVal = Math.max(...breakdown.map(d => d.totalMinutes), 1);

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Grid lines
      const gridLines = 4;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = '10px Inter, sans-serif';
      for (let i = 0; i <= gridLines; i++) {
        const y = padding.top + (chartH / gridLines) * i;
        const val = maxVal - (maxVal / gridLines) * i;
        ctx.fillStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.textAlign = 'right';
        ctx.fillText(formatTime(val), padding.left - 6, y);
      }

      // Bars
      const barCount = breakdown.length;
      const barGap = 4;
      const barWidth = Math.min((chartW - barGap * (barCount - 1)) / barCount, 36);
      const totalBarWidth = barCount * barWidth + (barCount - 1) * barGap;
      const startX = padding.left + (chartW - totalBarWidth) / 2;

      breakdown.forEach((item, i) => {
        const barH = (item.totalMinutes / maxVal) * chartH;
        const x = startX + i * (barWidth + barGap);
        const y = padding.top + chartH - barH;

        // Bar rounded top
        const radius = Math.min(3, barWidth / 3);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx.lineTo(x + barWidth, padding.top + chartH);
        ctx.lineTo(x, padding.top + chartH);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();

        // Color based on value relative to max
        const ratio = item.totalMinutes / maxVal;
        let color;
        if (ratio > 0.8) color = isDark ? 'rgba(239,68,68,0.7)' : 'rgba(239,68,68,0.6)';
        else if (ratio > 0.5) color = isDark ? 'rgba(245,158,11,0.7)' : 'rgba(245,158,11,0.6)';
        else if (ratio > 0.2) color = isDark ? 'rgba(16,185,129,0.7)' : 'rgba(16,185,129,0.6)';
        else color = barColor;

        ctx.fillStyle = color;
        ctx.fill();

        // Date label — use safeParseDate to prevent 'Invalid Date' on chart
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = safeFormatDate(item.date, { month: 'short', day: 'numeric' });
        // Skip every other label when bars are too close to prevent collision
        if (barCount > 7 && i % 2 === 1) {
          ctx.fillText('', x + barWidth / 2, padding.top + chartH + 8);
        } else {
          ctx.fillText(label, x + barWidth / 2, padding.top + chartH + 8);
        }
      });

      // Average
      const avg = breakdown.reduce((s, d) => s + d.totalMinutes, 0) / breakdown.length;
      chartAvg.textContent = `Avg ${formatTime(avg)}/day`;

      // Tooltip hover
      canvas.onmousemove = function(e) {
        const rect2 = canvas.getBoundingClientRect();
        const mx = e.clientX - rect2.left;
        const my = e.clientY - rect2.top;

        let found = false;
        breakdown.forEach((item, i) => {
          const x = startX + i * (barWidth + barGap);
          const y = padding.top + chartH - (item.totalMinutes / maxVal) * chartH;
          if (mx >= x && mx <= x + barWidth && my >= y && my <= padding.top + chartH) {
            const dateStr = safeFormatDate(item.date, { weekday: 'long', month: 'short', day: 'numeric' });
            tooltip.innerHTML = `${dateStr}<br><strong>${formatTime(item.totalMinutes)}</strong>`;
            tooltip.style.left = Math.min(Math.max(mx - 50, 0), w - 120) + 'px';
            tooltip.style.top = (y - 36) + 'px';
            tooltip.classList.remove('hidden', 'opacity-0');
            tooltip.classList.add('opacity-100');
            found = true;
          }
        });
        if (!found) {
          tooltip.classList.add('opacity-0');
          setTimeout(() => { if (tooltip.classList.contains('opacity-0')) tooltip.classList.add('hidden'); }, 150);
        }
      };

      canvas.onmouseleave = function() {
        tooltip.classList.add('opacity-0');
        setTimeout(() => { if (tooltip.classList.contains('opacity-0')) tooltip.classList.add('hidden'); }, 150);
      };

      // Redraw on theme change
      canvas._redraw = renderDailyChart;
    }

    // ─── State ──────────────────────────────────────────────────────────────

    const API_BASE = '/api';
    let selectedModalDomain = null;

    async function getUserId() {
      const params = new URLSearchParams(window.location.search);
      const urlUser = params.get('user');
      if (urlUser) return urlUser;

      const TOKEN_KEY = 'lisTrackTrackerToken';
      try { const local = localStorage.getItem(TOKEN_KEY); if (local) return local; } catch (_) {}

      await new Promise(r => setTimeout(r, 500));

      try { const local = localStorage.getItem(TOKEN_KEY); if (local) return local; } catch (_) {}

      try {
        const chars = '0123456789abcdef';
        let token = '';
        for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * 16)];
        localStorage.setItem(TOKEN_KEY, token);
        return token;
      } catch (_) { return 'fallback-dev'; }
    }

    async function apiUrl(path, extraParams = {}) {
      const params = new URLSearchParams();
      params.set('user', await getUserId());
      for (const [key, value] of Object.entries(extraParams)) {
        if (value != null) params.set(key, value);
      }
      return API_BASE + path + '?' + params.toString();
    }

    let isFirstLoad = true;
    let currentDate = null;
    let currentPeriod = 'day';
    let availableDates = [];
    let customStartDate = null;
    let customEndDate = null;
    let visibleDomainCount = 10;

    // ─── Period Button Styling ──────────────────────────────────────────────

    function updatePeriodButtons() {
      document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.remove('bg-white', 'dark:bg-gray-600', 'text-gray-900', 'dark:text-gray-100', 'shadow-sm');
        btn.classList.add('text-gray-500', 'dark:text-gray-400');
      });
      // Highlight standard period buttons (Day, Week, Month)
      const activeBtn = document.getElementById('period' + currentPeriod.charAt(0).toUpperCase() + currentPeriod.slice(1) + 'Btn');
      if (activeBtn) {
        activeBtn.classList.remove('text-gray-500', 'dark:text-gray-400');
        activeBtn.classList.add('bg-white', 'dark:bg-gray-600', 'text-gray-900', 'dark:text-gray-100', 'shadow-sm');
      }
      // Sync range dropdown value
      const rangeSelect = document.getElementById('periodRangeSelect');
      if (rangeSelect && ['7days', '30days', 'custom'].includes(currentPeriod)) {
        rangeSelect.value = currentPeriod;
      }
    }

    // ─── Period Helpers ─────────────────────────────────────────────────────

    function getTodayStr() { return new Date().toISOString().slice(0, 10); }

    function setPeriod(period) {
      if (period === currentPeriod) return;
      currentPeriod = period;
      currentDate = null;
      customStartDate = null;
      customEndDate = null;
      updatePeriodButtons();

      // Show/hide custom range UI
      const customRange = document.getElementById('customRangeContainer');
      if (customRange) {
        if (period === 'custom') {
          customRange.classList.remove('hidden');
          customRange.classList.add('flex');
          // Set max to today so users can't pick future dates
          const today = getTodayStr();
          ['customStartDate', 'customEndDate'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.max = today;
          });
        } else {
          customRange.classList.add('hidden');
          customRange.classList.remove('flex');
        }
      }

      if (period !== 'custom') {
        fetchData({ silent: false });
      }
    }

    function offsetPeriod(dateStr, delta) {
      const d = new Date(dateStr + 'T00:00:00Z');
      if (currentPeriod === '30days') d.setUTCDate(d.getUTCDate() + delta * 30);
      else if (currentPeriod === '7days' || currentPeriod === 'week') d.setUTCDate(d.getUTCDate() + delta * 7);
      else if (currentPeriod === 'month') d.setUTCMonth(d.getUTCMonth() + delta);
      else d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    }

    function isCurrentPeriod(dateStr) {
      const today = getTodayStr();
      if (currentPeriod === '30days') {
        const d = new Date(today + 'T00:00:00Z');
        const thirtyDaysAgo = new Date(d); thirtyDaysAgo.setUTCDate(d.getUTCDate() - 29);
        return dateStr >= thirtyDaysAgo.toISOString().slice(0, 10);
      }
      if (currentPeriod === '7days') {
        const d = new Date(today + 'T00:00:00Z');
        const sevenDaysAgo = new Date(d); sevenDaysAgo.setUTCDate(d.getUTCDate() - 6);
        return dateStr >= sevenDaysAgo.toISOString().slice(0, 10);
      }
      if (currentPeriod === 'custom') return false;
      if (currentPeriod === 'day') return dateStr === today;
      if (currentPeriod === 'week') {
        const d = new Date(today + 'T00:00:00Z');
        const day = d.getUTCDay();
        const diff = day === 0 ? -6 : 1 - day;
        const start = new Date(d); start.setUTCDate(d.getUTCDate() + diff);
        return dateStr >= start.toISOString().slice(0, 10);
      }
      if (currentPeriod === 'month') return dateStr.slice(0, 7) === today.slice(0, 7);
      return false;
    }

    function formatPeriodLabel(data) {
      if (currentPeriod === '30days') {
        const s = safeFormatDate(data.startDate, { month: 'short', day: 'numeric' });
        const e = safeFormatDate(data.endDate, { month: 'short', day: 'numeric', year: 'numeric' });
        if (isCurrentPeriod(data.startDate)) return 'Last 30 Days';
        return `${s} – ${e}`;
      }
      if (currentPeriod === '7days') {
        const s = safeFormatDate(data.startDate, { month: 'short', day: 'numeric' });
        const e = safeFormatDate(data.endDate, { month: 'short', day: 'numeric', year: 'numeric' });
        if (isCurrentPeriod(data.startDate)) return 'Last 7 Days';
        return `${s} – ${e}`;
      }
      if (currentPeriod === 'day') {
        const dateStr = data.date || getTodayStr();
        const today = getTodayStr();
        if (dateStr === today) return 'Today';
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        if (dateStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
        return safeFormatDate(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
      }
      if (currentPeriod === 'custom') {
        const s = safeFormatDate(data.startDate, { month: 'short', day: 'numeric' });
        const e = safeFormatDate(data.endDate, { month: 'short', day: 'numeric', year: 'numeric' });
        return `${s} – ${e}`;
      }
      if (currentPeriod === 'week') {
        const s = safeFormatDate(data.startDate, { month: 'short', day: 'numeric' });
        const e = safeFormatDate(data.endDate, { month: 'short', day: 'numeric', year: 'numeric' });
        if (isCurrentPeriod(data.startDate)) return 'This Week';
        return `${s} – ${e}`;
      }
      if (currentPeriod === 'month') {
        if (isCurrentPeriod(data.startDate)) return 'This Month';
        return safeFormatDate(data.startDate, { month: 'long', year: 'numeric' });
      }
      return '';
    }

    // ─── Navigation ─────────────────────────────────────────────────────────

    function goToPrev() {
      const base = currentDate || getTodayStr();
      currentDate = offsetPeriod(base, -1);
      fetchData({ silent: false });
    }

    function goToNext() {
      if (currentDate === null) return;
      const next = offsetPeriod(currentDate, 1);
      if (isCurrentPeriod(next)) currentDate = null;
      else currentDate = next;
      fetchData({ silent: false });
    }

    function goToCurrent() {
      if (currentPeriod === 'custom') {
        currentPeriod = 'day';
        updatePeriodButtons();
        const customRange = document.getElementById('customRangeContainer');
        if (customRange) { customRange.classList.add('hidden'); customRange.classList.remove('flex'); }
      }
      currentDate = null;
      customStartDate = null;
      customEndDate = null;
      fetchData({ silent: false });
    }

    function goToDate(dateStr) {
      if (!dateStr) return;
      currentDate = dateStr;
      currentPeriod = 'day';
      updatePeriodButtons();
      fetchData({ silent: false });
    }

    // ─── Data Fetching ──────────────────────────────────────────────────────

    async function fetchData({ silent = false } = {}) {
      const loadingState = document.getElementById('loadingState');
      const errorState = document.getElementById('errorState');
      const dashboardContent = document.getElementById('dashboardContent');
      const refreshIcon = document.getElementById('refreshIcon');

      if (!silent) {
        loadingState.classList.remove('hidden');
        errorState.classList.add('hidden');
        dashboardContent.classList.add('hidden');
        refreshIcon.classList.add('loading-spinner');
      }

      try {
        let url;
        if (currentPeriod === 'day') {
          url = await apiUrl('/dashboard', { date: currentDate });
        } else if (currentPeriod === 'custom') {
          // Build custom range URL with start/end dates
          const params = new URLSearchParams();
          params.set('user', await getUserId());
          params.set('period', 'custom');
          if (customStartDate) params.set('startDate', customStartDate);
          if (customEndDate) params.set('endDate', customEndDate);
          url = API_BASE + '/summary?' + params.toString();
        } else {
          url = await apiUrl('/summary', { period: currentPeriod, date: currentDate });
        }

        // Also fetch trends for period views (not day or custom)
        let trendsPromise = null;
        if (currentPeriod !== 'day' && currentPeriod !== 'custom') {
          trendsPromise = fetch(await apiUrl('/trends', { period: currentPeriod, date: currentDate }))
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
        }

        const [response, trendsData] = await Promise.all([
          fetch(url),
          trendsPromise,
        ]);

        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const data = await response.json();

        availableDates = data.availableDates || [];

        // Store trends globally for createDomainRow to access
        window._lastTrendData = trendsData;

        if (silent) {
          silentUpdate(data);
        } else {
          renderDashboard(data);
          loadingState.classList.add('hidden');
          dashboardContent.classList.remove('hidden');
          isFirstLoad = false;
        }

        updateLastUpdated();
      } catch (err) {
        if (!silent) {
          loadingState.classList.add('hidden');
          errorState.classList.remove('hidden');
          document.getElementById('errorMessage').textContent =
            err.message === 'Failed to fetch'
              ? 'Could not connect to the server. Make sure the server is running.'
              : err.message;
        }
      } finally {
        if (!silent) refreshIcon.classList.remove('loading-spinner');
      }
    }

    // ─── Build Domain List Rows ────────────────────────────────────────────

    function createDomainRow(item, index) {
      const displayName = getDisplayName(item.domain);
      const gradientClass = getGradientClass(index);
      const trendHtml = getTrendHtml(item.domain);

      const row = document.createElement('div');
      row.className = 'group rank-item px-6 py-4 flex items-center gap-4 cursor-pointer dark:hover:bg-gray-700/30';
      row.setAttribute('data-domain', item.domain);

      row.innerHTML = `
        <span class="flex-shrink-0 w-6 text-sm font-semibold text-gray-300 dark:text-gray-600 text-right" data-rank>${index + 1}</span>
        <img src="${getFaviconUrl(item.domain)}" alt="${item.domain}" class="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-50 dark:bg-gray-700" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
        <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 items-center justify-center text-xs font-semibold text-gray-400 dark:text-gray-500" style="display:none">${displayName.charAt(0)}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              ${displayName}
              <span data-trend class="inline-flex items-center">${trendHtml}</span>
            </span>
            <span class="text-sm font-semibold text-gray-700 dark:text-gray-300 ml-2" data-time>${formatTime(item.totalMinutes)}</span>
          </div>
          <div class="relative w-full h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
            <div class="progress-bar absolute inset-y-0 left-0 rounded-full ${gradientClass}" style="width: 0%"></div>
          </div>
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <button class="add-goal-btn flex-shrink-0 px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-all duration-150 whitespace-nowrap" title="Set a daily goal" onclick="event.stopPropagation();quickAddGoal('${item.domain}')">
            <svg class="w-3 h-3 inline mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
            Goal
          </button>
          <button class="delete-domain-btn flex-shrink-0 p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all duration-150" title="Delete tracking data for this domain" onclick="event.stopPropagation();deleteDomainData('${item.domain}')">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      `;

      // Click row → open domain detail modal
      row.addEventListener('click', () => openDomainModal(item.domain));

      return row;
    }

    function animateBars(container) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          container.querySelectorAll('.progress-bar').forEach((bar) => {
            const target = parseFloat(bar.getAttribute('data-target') || '0');
            bar.style.width = target + '%';
          });
        });
      });
    }

    function getMaxMinutes(domains) {
      return domains.length > 0 ? domains[0].totalMinutes : 0;
    }

    function renderDomainList(data, container) {
      const emptyState = document.getElementById('emptyState');
      const showMoreContainer = document.getElementById('showMoreContainer');
      container.innerHTML = '';
      updateTrackedDomainsList(data);

      if (!data.domains || data.domains.length === 0) {
        emptyState.classList.remove('hidden');
        container.classList.add('hidden');
        if (showMoreContainer) showMoreContainer.classList.add('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      container.classList.remove('hidden');

      const maxMinutes = getMaxMinutes(data.domains);
      const visibleDomains = data.domains.slice(0, visibleDomainCount);

      visibleDomains.forEach((item, index) => {
        const percentage = maxMinutes > 0 ? (item.totalMinutes / maxMinutes) * 100 : 0;
        const row = createDomainRow(item, index);
        row.style.animationDelay = `${index * 0.03}s`;
        const bar = row.querySelector('.progress-bar');
        if (bar) bar.setAttribute('data-target', percentage);
        container.appendChild(row);
      });

      animateBars(container);

      // Show/hide the show-more button
      if (showMoreContainer) {
        if (visibleDomainCount < data.domains.length) {
          showMoreContainer.classList.remove('hidden');
          const remaining = data.domains.length - visibleDomainCount;
          document.getElementById('showMoreText').textContent = `Show ${Math.min(remaining, 10)} more (${visibleDomainCount + Math.min(remaining, 10)} of ${data.domains.length})`;
        } else {
          showMoreContainer.classList.add('hidden');
        }
      }
    }

    function showMoreDomains() {
      visibleDomainCount += 10;
      const container = document.getElementById('domainList');
      const data = window._lastDashboardData;
      if (data && data.domains) {
        renderDomainList(data, container);
      }
    }

    function updateDomainCount(data) {
      const totalCount = data.totalDomains;
      const showingCount = Math.min(visibleDomainCount, data.domains ? data.domains.length : 0);
      document.getElementById('domainCount').textContent =
        totalCount > 10
          ? `${totalCount} total · showing ${showingCount} of ${totalCount}`
          : `${totalCount} domain${totalCount !== 1 ? 's' : ''}`;
    }

    // ─── Delete Domain Data ────────────────────────────────────────────────

    async function deleteDomainData(domain) {
      if (!domain) return;
      if (!confirm(`Delete all tracking data for "${domain}"? This cannot be undone.`)) return;

      try {
        const url = await apiUrl('/cleanup', { domain });
        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete data');

        const result = await response.json();
        console.log(`[cleanup] Deleted ${result.deleted} records for ${domain}`);

        // Refresh the dashboard
        await fetchData({ silent: false });
      } catch (err) {
        console.error('[cleanup] Error:', err);
        alert('Failed to delete data: ' + err.message);
      }
    }

    // ─── Domain Detail Modal ───────────────────────────────────────────────

    function openDomainModal(domain) {
      selectedModalDomain = domain;
      const domainUrl = 'https://' + domain;
      document.getElementById('modalTitle').textContent = getDisplayName(domain);
      document.getElementById('modalFavicon').src = getFaviconUrl(domain);
      document.getElementById('modalFavicon').onerror = function() {
        this.style.display = 'none';
      };
      document.getElementById('modalFavicon').style.display = '';
      document.getElementById('modalTotal').textContent = 'Loading...';
      // Set clickable links to open the website in a new tab
      const faviconLink = document.getElementById('modalFaviconLink');
      const titleLink = document.getElementById('modalTitleLink');
      if (faviconLink) { faviconLink.href = domainUrl; faviconLink.title = 'Open ' + domain; }
      if (titleLink) { titleLink.href = domainUrl; titleLink.title = 'Open ' + domain; }
      document.getElementById('modalBreakdown').innerHTML = '<p class="text-sm text-gray-400 dark:text-gray-500 text-center py-4">Loading breakdown...</p>';
      document.getElementById('domainModal').classList.remove('hidden');

      // Fetch logs for this domain to show daily breakdown
      loadDomainBreakdown(domain);
    }

    function closeDomainModal() {
      document.getElementById('domainModal').classList.add('hidden');
      selectedModalDomain = null;
    }

    async function loadDomainBreakdown(domain) {
      try {
        const url = await apiUrl('/logs');
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch logs');

        const data = await response.json();
        const logs = (data.logs || []).filter(l => l.domain === domain);

        // Group by date
        const byDate = {};
        logs.forEach(l => {
          const date = l.timestamp.slice(0, 10);
          if (!byDate[date]) byDate[date] = 0;
          byDate[date] += l.durationSeconds;
        });

        const dates = Object.keys(byDate).sort().reverse();
        const totalSeconds = logs.reduce((s, l) => s + l.durationSeconds, 0);
        const totalMin = totalSeconds / 60;

        document.getElementById('modalTotal').textContent = `${formatTime(totalMin)} total · ${logs.length} visits`;

        if (dates.length === 0) {
          document.getElementById('modalBreakdown').innerHTML = '<p class="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No detailed data available.</p>';
          return;
        }

        const maxVal = Math.max(...dates.map(d => byDate[d]));

        let html = '';
        dates.slice(0, 14).forEach(date => {
          const sec = byDate[date];
          const min = sec / 60;
          const label = safeFormatDate(date, { weekday: 'short', month: 'short', day: 'numeric' });
          const pct = maxVal > 0 ? (sec / maxVal) * 100 : 0;
          const barColor = pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : pct > 20 ? 'bg-emerald-500' : 'bg-indigo-500';

          html += `
            <div class="flex items-center gap-3">
              <span class="w-28 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">${label}</span>
              <div class="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div class="h-full rounded-full ${barColor}" style="width: ${pct}%"></div>
              </div>
              <span class="w-14 text-right text-xs font-medium text-gray-700 dark:text-gray-300 flex-shrink-0">${formatTime(min)}</span>
            </div>
          `;
        });

        if (dates.length > 14) {
          html += `<p class="text-xs text-gray-400 dark:text-gray-500 text-center pt-2">+ ${dates.length - 14} more days</p>`;
        }

        document.getElementById('modalBreakdown').innerHTML = html;
      } catch (err) {
        console.error('[modal] Error loading breakdown:', err);
        document.getElementById('modalBreakdown').innerHTML = '<p class="text-sm text-red-400 dark:text-red-400 text-center py-4">Failed to load breakdown.</p>';
      }
    }

    function quickAddGoalFromModal() {
      if (selectedModalDomain) {
        quickAddGoal(selectedModalDomain);
        closeDomainModal();
      }
    }

    // ─── Goals ──────────────────────────────────────────────────────────────

    async function fetchGoals() {
      const goalsList = document.getElementById('goalsList');
      const goalsLoading = document.getElementById('goalsLoading');
      const goalsEmpty = document.getElementById('goalsEmpty');

      goalsLoading.classList.remove('hidden');
      goalsList.classList.add('hidden');
      goalsEmpty.classList.add('hidden');

      try {
        const [allResp, statusResp] = await Promise.all([
          fetch(await apiUrl('/goals')),
          fetch(await apiUrl('/goals/status')),
        ]);

        if (!allResp.ok) throw new Error('Failed to fetch goals');

        const allData = await allResp.json();
        const allGoals = (allData.goals || []);

        const statusMap = {};
        if (statusResp.ok) {
          const statusData = await statusResp.json();
          (statusData.goals || []).forEach(s => { statusMap[s.domain] = s; });
        }

        const merged = allGoals.map(g => {
          const status = statusMap[g.domain];
          return {
            ...g,
            todayMinutes: status ? status.todayMinutes : 0,
            percentage: status ? status.percentage : 0,
            exceeded: status ? status.exceeded : false,
            approaching: status ? status.approaching : false,
            remainingMinutes: status ? status.remainingMinutes : g.max_minutes,
          };
        });

        renderGoals(merged);
      } catch (err) {
        console.error('[goals] Error:', err);
        goalsLoading.classList.add('hidden');
        goalsList.classList.add('hidden');
        const el = document.getElementById('goalsEmpty');
        if (el) { el.classList.remove('hidden'); el.querySelector('p').textContent = 'Could not load goals.'; }
      }
    }

    function sortGoals(goals) {
      const severity = (g) => {
        if (g.exceeded) return 0;
        if (g.approaching) return 1;
        if (g.enabled) return 2;
        return 3;
      };
      return [...goals].sort((a, b) => severity(a) - severity(b));
    }

    function updateGoalsSummary(goals) {
      const el = document.getElementById('goalsSummary');
      if (!el) return;
      const total = goals.length;
      const exceeded = goals.filter(g => g.exceeded).length;
      const approaching = goals.filter(g => g.approaching && !g.exceeded).length;
      if (total === 0) { el.innerHTML = ''; el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const parts = [`${total} goal${total !== 1 ? 's' : ''}`];
      if (exceeded > 0) parts.push(`<span class="text-red-500 dark:text-red-400 font-semibold">${exceeded} exceeded</span>`);
      if (approaching > 0) parts.push(`<span class="text-amber-500 dark:text-amber-400 font-semibold">${approaching} approaching</span>`);
      el.innerHTML = parts.join(' · ');
    }

    function getGoalStatusBadge(goal) {
      if (!goal.enabled) return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500">Disabled</span>`;
      if (goal.exceeded) return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400">Exceeded</span>`;
      if (goal.approaching) return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">${goal.percentage}%</span>`;
      if (goal.percentage > 0) return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">${goal.percentage}%</span>`;
      return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-50 dark:bg-gray-700 text-gray-400 dark:text-gray-500">0%</span>`;
    }

    function startEditGoal(id) {
      const display = document.getElementById(`goal-time-${id}`);
      const edit = document.getElementById(`goal-edit-${id}`);
      if (display && edit) { display.classList.add('hidden'); edit.classList.remove('hidden'); edit.focus(); edit.select(); }
    }

    async function saveEditGoal(id) {
      const edit = document.getElementById(`goal-edit-${id}`);
      if (!edit) return;
      const newValue = parseInt(edit.value, 10);
      if (isNaN(newValue) || newValue <= 0) { cancelEditGoal(id); return; }
      try {
        const response = await fetch(await apiUrl('/goals/' + id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_minutes: newValue }),
        });
        if (!response.ok) throw new Error('Failed to update goal');
        await fetchGoals();
      } catch (err) { console.error('[goals] Error updating goal:', err); cancelEditGoal(id); }
    }

    function cancelEditGoal(id) {
      const display = document.getElementById(`goal-time-${id}`);
      const edit = document.getElementById(`goal-edit-${id}`);
      if (display && edit) { edit.classList.add('hidden'); display.classList.remove('hidden'); }
    }

    function onEditKeydown(event, id) {
      if (event.key === 'Enter') { event.preventDefault(); saveEditGoal(id); }
      else if (event.key === 'Escape') { event.preventDefault(); cancelEditGoal(id); }
    }

    function renderGoals(goals) {
      const goalsList = document.getElementById('goalsList');
      const goalsLoading = document.getElementById('goalsLoading');
      const goalsEmpty = document.getElementById('goalsEmpty');

      goalsLoading.classList.add('hidden');
      updateGoalsSummary(goals);

      if (goals.length === 0) {
        goalsList.classList.add('hidden');
        goalsEmpty.classList.remove('hidden');
        goalsEmpty.querySelector('p').textContent = 'No goals set yet. Add one above!';
        return;
      }

      goalsEmpty.classList.add('hidden');
      goalsList.classList.remove('hidden');
      goalsList.innerHTML = '';

      const sorted = sortGoals(goals);

      sorted.forEach((goal) => {
        const pct = goal.percentage || 0;
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 px-6 py-3.5';

        const barColor = !goal.enabled ? 'bg-gray-300 dark:bg-gray-600'
          : goal.exceeded ? 'bg-red-500'
          : goal.approaching ? 'bg-amber-500'
          : 'bg-emerald-500';

        const textColor = !goal.enabled ? 'text-gray-400 dark:text-gray-500'
          : goal.exceeded ? 'text-red-500 dark:text-red-400'
          : goal.approaching ? 'text-amber-500 dark:text-amber-400'
          : '';

        row.innerHTML = `
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-1">
              <div class="flex items-center gap-2 min-w-0">
                <img src="${getFaviconUrl(goal.domain)}" alt="${goal.domain}" class="flex-shrink-0 w-5 h-5 rounded bg-gray-50 dark:bg-gray-700" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
                <div class="flex-shrink-0 w-5 h-5 rounded bg-gray-100 dark:bg-gray-700 items-center justify-center text-[10px] font-semibold text-gray-400 dark:text-gray-500" style="display:none">${goal.domain.charAt(0)}</div>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">${getDisplayName(goal.domain)}</span>
                ${getGoalStatusBadge(goal)}
              </div>
              <div class="flex items-center gap-1.5 flex-shrink-0 ml-2">
                <span id="goal-time-${goal.id}" class="text-xs font-semibold ${textColor} cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1.5 py-0.5 rounded transition-colors" onclick="startEditGoal(${goal.id})" title="Click to edit budget">${formatTime(goal.todayMinutes)} / ${goal.max_minutes} min</span>
                <span id="goal-edit-${goal.id}" class="hidden items-center gap-1">
                  <span class="text-xs text-gray-400 dark:text-gray-500">${formatTime(goal.todayMinutes)} /</span>
                  <input type="number" value="${goal.max_minutes}" min="1" class="w-16 px-1.5 py-0.5 text-xs border border-indigo-300 dark:border-indigo-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" onblur="saveEditGoal(${goal.id})" onkeydown="onEditKeydown(event, ${goal.id})" />
                  <span class="text-xs text-gray-400 dark:text-gray-500">min</span>
                </span>
              </div>
            </div>
            <div class="relative w-full h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div class="progress-bar absolute inset-y-0 left-0 rounded-full ${barColor}" style="width: ${Math.min(pct, 100)}%"></div>
            </div>
            ${goal.exceeded
              ? `<p class="text-[11px] text-red-500 dark:text-red-400 mt-1">Exceeded by ${formatTime(goal.todayMinutes - goal.max_minutes)}</p>`
              : goal.enabled && goal.remainingMinutes > 0
                ? `<p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">${formatTime(goal.remainingMinutes)} remaining</p>`
                : !goal.enabled
                  ? `<p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Goal is disabled</p>`
                  : ''}
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" class="sr-only peer" ${goal.enabled ? 'checked' : ''} onchange="toggleGoal(${goal.id}, this.checked)" />
              <div class="w-8 h-4 bg-gray-200 dark:bg-gray-600 rounded-full peer peer-checked:bg-indigo-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
            </label>
            <button onclick="deleteGoal(${goal.id})" class="flex-shrink-0 p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all duration-150" title="Delete goal">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
        `;

        goalsList.appendChild(row);
      });
    }

    async function addGoal() {
      const domainInput = document.getElementById('goalDomainInput');
      const minutesInput = document.getElementById('goalMinutesInput');
      const errorEl = document.getElementById('goalError');

      const domain = domainInput.value.trim().toLowerCase();
      const maxMinutes = parseInt(minutesInput.value, 10);

      if (!domain) { errorEl.textContent = 'Please enter a domain name.'; errorEl.classList.remove('hidden'); return; }
      if (isNaN(maxMinutes) || maxMinutes <= 0) { errorEl.textContent = 'Please enter a valid number of minutes.'; errorEl.classList.remove('hidden'); return; }

      errorEl.classList.add('hidden');

      try {
        const response = await fetch(API_BASE + '/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, max_minutes: maxMinutes, userToken: await getUserId() }),
        });
        if (!response.ok) { const err = await response.json(); throw new Error(err.message || 'Failed to create goal'); }
        domainInput.value = '';
        minutesInput.value = '';
        await fetchGoals();
      } catch (err) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
    }

    async function deleteGoal(id) {
      try {
        const response = await fetch(await apiUrl('/goals/' + id), { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete goal');
        await fetchGoals();
      } catch (err) { console.error('[goals] Error deleting goal:', err); }
    }

    async function toggleGoal(id, enabled) {
      try {
        const response = await fetch(await apiUrl('/goals/' + id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (!response.ok) throw new Error('Failed to toggle goal');
        await fetchGoals();
      } catch (err) { console.error('[goals] Error toggling goal:', err); }
    }

    function updateTrackedDomainsList(data) {
      const datalist = document.getElementById('trackedDomains');
      if (!datalist || !data.domains) return;
      datalist.innerHTML = data.domains.map(d => `<option value="${d.domain}">`).join('');
    }

    // ─── Custom Range ──────────────────────────────────────────────────────

    function applyCustomRange() {
      const start = document.getElementById('customStartDate').value;
      const end = document.getElementById('customEndDate').value;
      if (!start || !end) return;
      if (start > end) { alert('Start date must be before end date.'); return; }
      customStartDate = start;
      customEndDate = end;
      fetchData({ silent: false });
    }

    function quickAddGoal(domain) {
      const input = document.getElementById('goalDomainInput');
      const minutesInput = document.getElementById('goalMinutesInput');
      if (!input) return;
      input.value = domain;
      const goalsSection = document.getElementById('goalsSection');
      if (goalsSection) goalsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { minutesInput?.focus(); minutesInput?.select(); }, 400);
    }

    // ─── Silent Update ──────────────────────────────────────────────────────

    function silentUpdate(data) {
      // Keep backing data in sync so "Show More" uses latest data
      window._lastDashboardData = data;
      window._lastChartData = data;

      if (isCurrentPeriod(currentDate || getTodayStr())) {
        document.getElementById('dateLabel').textContent = formatPeriodLabel(data);
        document.getElementById('dateBadge').textContent = currentPeriod === 'day' ? 'Today' : formatPeriodLabel(data);
      }

      const exportBtn = document.getElementById('exportBtn');
      if (isCurrentPeriod(currentDate || getTodayStr())) exportBtn.classList.add('hidden');
      else exportBtn.classList.remove('hidden');

      // Only animate if value changed — skips flicker when same value re-fetched
      var _tdEl = document.getElementById('totalDomains');
      if (_tdEl && parseInt(_tdEl.textContent) !== data.totalDomains) {
        animateCounter(_tdEl, data.totalDomains, '');
      } else if (_tdEl) {
        _tdEl.textContent = data.totalDomains + '';
      }
      const totalMinEl = document.getElementById('totalMinutes');
      if (totalMinEl) totalMinEl.textContent = formatTime(data.totalMinutes || 0);

      document.getElementById('topDomain').textContent = data.topDomain || '—';
      updateTopSiteFavicon(data.topDomain);
      updateDomainCount(data);

      if (data && data.domains) updateTrackedDomainsList(data);

      // Sync date picker value with current view
      const dpInput = document.getElementById('datePickerInput');
      if (dpInput) dpInput.value = currentDate || getTodayStr();

      const domainList = document.getElementById('domainList');
      const emptyState = document.getElementById('emptyState');
      const maxMinutes = getMaxMinutes(data.domains);

      if (!data.domains || data.domains.length === 0) {
        emptyState.classList.remove('hidden');
        domainList.classList.add('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      domainList.classList.remove('hidden');

      const existingRows = {};
      domainList.querySelectorAll('[data-domain]').forEach(row => {
        existingRows[row.getAttribute('data-domain')] = row;
      });

      const incomingDomains = data.domains.slice(0, visibleDomainCount).map(d => d.domain);

      Object.keys(existingRows).forEach(domain => {
        if (!incomingDomains.includes(domain)) existingRows[domain].remove();
      });

      data.domains.slice(0, visibleDomainCount).forEach((item, index) => {
        const pct = maxMinutes > 0 ? (item.totalMinutes / maxMinutes) * 100 : 0;
        if (existingRows[item.domain]) {
          const row = existingRows[item.domain];
          if (row.getAttribute('data-render-index') !== String(index)) {
            const rankEl = row.querySelector('[data-rank]');
            if (rankEl) rankEl.textContent = index + 1;
            row.setAttribute('data-render-index', index);
          }
          const timeEl = row.querySelector('[data-time]');
          if (timeEl) timeEl.textContent = formatTime(item.totalMinutes);
          const bar = row.querySelector('.progress-bar');
          if (bar) bar.style.width = pct + '%';
          domainList.appendChild(row);
        } else {
          const row = createDomainRow(item, index);
          row.setAttribute('data-render-index', index);
          const bar = row.querySelector('.progress-bar');
          if (bar) bar.setAttribute('data-target', pct);
          domainList.appendChild(row);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const b = row.querySelector('.progress-bar');
              if (b) b.style.width = pct + '%';
            });
          });
        }
      });

      // Update show-more button in silent update
      const showMoreContainer = document.getElementById('showMoreContainer');
      if (showMoreContainer) {
        if (visibleDomainCount < data.domains.length) {
          showMoreContainer.classList.remove('hidden');
          const remaining = data.domains.length - visibleDomainCount;
          document.getElementById('showMoreText').textContent = `Show ${Math.min(remaining, 10)} more (${visibleDomainCount + Math.min(remaining, 10)} of ${data.domains.length})`;
        } else {
          showMoreContainer.classList.add('hidden');
        }
      }

      // Update chart silently (only for period views with breakdown data)
      if (currentPeriod !== 'day' && data.dailyBreakdown) {
        window._lastChartData = data;
        renderDailyChart(data);
      }

      // Silently update goals only on Day view
      if (currentPeriod === 'day') fetchGoals();
    }

    // ─── Full Render ────────────────────────────────────────────────────────

    function renderDashboard(data) {
      updatePeriodButtons();

      const viewedDate = data.date || getTodayStr();
      const inCurrent = isCurrentPeriod(currentDate || getTodayStr());

      document.getElementById('dateLabel').textContent = formatPeriodLabel(data);
      document.getElementById('dateBadge').textContent = inCurrent
        ? (currentPeriod === 'day' ? 'Today' : formatPeriodLabel(data))
        : formatPeriodLabel(data);

      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      const todayBtn = document.getElementById('todayBtn');

      if (currentPeriod === '7days' || currentPeriod === '30days') {
        prevBtn.classList.add('opacity-30', 'cursor-not-allowed'); prevBtn.disabled = true;
        nextBtn.classList.add('opacity-30', 'cursor-not-allowed'); nextBtn.disabled = true;
        todayBtn.classList.add('hidden');
      } else if (currentPeriod === 'custom') {
        prevBtn.classList.add('opacity-30', 'cursor-not-allowed'); prevBtn.disabled = true;
        nextBtn.classList.add('opacity-30', 'cursor-not-allowed'); nextBtn.disabled = true;
        todayBtn.classList.remove('hidden');
      } else if (inCurrent) {
        prevBtn.classList.remove('opacity-30', 'cursor-not-allowed'); prevBtn.disabled = false;
        nextBtn.classList.add('opacity-30', 'cursor-not-allowed'); nextBtn.disabled = true;
        todayBtn.classList.add('hidden');
      } else {
        prevBtn.classList.remove('opacity-30', 'cursor-not-allowed'); prevBtn.disabled = false;
        nextBtn.classList.remove('opacity-30', 'cursor-not-allowed'); nextBtn.disabled = false;
        todayBtn.classList.remove('hidden');
      }

      document.getElementById('todayBtnLabel').textContent =
        currentPeriod === '7days' ? 'Last 7 Days' :
        currentPeriod === '30days' ? 'Last 30 Days' :
        currentPeriod === 'day' ? 'Today' :
        currentPeriod === 'custom' ? 'Today' :
        currentPeriod === 'week' ? 'This Week' : 'This Month';

      const exportBtn = document.getElementById('exportBtn');
      if (inCurrent) exportBtn.classList.add('hidden');
      else exportBtn.classList.remove('hidden');

      // Sync date picker with current viewed date
      const datePickerInput = document.getElementById('datePickerInput');
      if (datePickerInput) {
        datePickerInput.max = getTodayStr();
        datePickerInput.value = currentDate || getTodayStr();
      }

      // Animated counters
      animateCounter(document.getElementById('totalDomains'), data.totalDomains, '');
      const totalMinEl = document.getElementById('totalMinutes');
      if (totalMinEl) totalMinEl.textContent = formatTime(data.totalMinutes);

      document.getElementById('topDomain').textContent = data.topDomain || '—';
      updateTopSiteFavicon(data.topDomain);
      updateDomainCount(data);

      // Store data for show-more button access
      window._lastDashboardData = data;
      // Reset visible count on full render
      visibleDomainCount = 10;

      // Update trends badge
      const trendBadge = document.getElementById('trendBadge');
      const trendContainer = document.getElementById('trendContainer');
      if (trendBadge && trendContainer) {
        if (currentPeriod !== 'day' && currentPeriod !== 'custom' && window._lastTrendData) {
          const td = window._lastTrendData;
          trendContainer.classList.remove('hidden');
          const pct = td.totalChangePercent;
          if (pct === 0) {
            trendBadge.innerHTML = '→ 0% vs last period';
            trendBadge.className = 'text-xs font-medium text-gray-400 dark:text-gray-500';
          } else {
            const isUp = td.totalDirection === 'up';
            trendBadge.className = 'text-xs font-semibold ' + (isUp ? 'text-red-500 dark:text-red-400' : 'text-emerald-500 dark:text-emerald-400');
            trendBadge.innerHTML = (isUp ? '▲' : '▼') + ' ' + Math.abs(pct) + '% vs last period';
          }
        } else {
          trendContainer.classList.add('hidden');
        }
      }

      const seedBtn = document.getElementById('seedBtn');
      if (seedBtn) {
        if (data.allowSeed === true) seedBtn.classList.remove('hidden');
        else seedBtn.classList.add('hidden');
      }

      // Daily chart (only show for period views that have daily breakdown)
      const chartSection = document.getElementById('chartSection');
      if (currentPeriod !== 'day' && data.dailyBreakdown && data.dailyBreakdown.length > 0) {
        chartSection.style.display = 'block';
        // Store data for theme-change re-render
        window._lastChartData = data;
        // Slight delay so DOM is ready
        setTimeout(() => renderDailyChart(data), 100);
      } else {
        chartSection.style.display = 'none';
        window._lastChartData = null;
      }

      renderDomainList(data, document.getElementById('domainList'));

      // Show goals only on Day view
      const goalsSection = document.getElementById('goalsSection');
      if (currentPeriod === 'day') {
        goalsSection.style.display = 'block';
        fetchGoals();
      } else {
        goalsSection.style.display = 'none';
      }
    }

    function updateLastUpdated() {
      const now = new Date();
      document.getElementById('lastUpdated').textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // ─── Dark Mode ─────────────────────────────────────────────────────────

    function setTheme(isDark) {
      const root = document.documentElement;
      const sunIcon = document.getElementById('sunIcon');
      const moonIcon = document.getElementById('moonIcon');
      if (isDark) {
        root.classList.add('dark');
        sunIcon?.classList.add('hidden');
        moonIcon?.classList.remove('hidden');
      } else {
        root.classList.remove('dark');
        sunIcon?.classList.remove('hidden');
        moonIcon?.classList.add('hidden');
      }
      try { localStorage.setItem('lisTrackTheme', isDark ? 'dark' : 'light'); } catch (_) {}
      // Re-render chart on theme change
      if (document.getElementById('dailyChart').width > 0) {
        const data = window._lastChartData;
        if (data) renderDailyChart(data);
      }
    }

    function toggleTheme() {
      setTheme(!document.documentElement.classList.contains('dark'));
    }

    function initTheme() {
      const saved = (() => { try { return localStorage.getItem('lisTrackTheme'); } catch (_) { return null; } })();
      if (saved === 'dark') setTheme(true);
      else if (saved === 'light') setTheme(false);
      else setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    // ─── Export PDF ─────────────────────────────────────────────────────────

    async function exportPDF() {
      const exportBtn = document.getElementById('exportBtn');
      const originalHtml = exportBtn.innerHTML;
      exportBtn.disabled = true;
      exportBtn.innerHTML = `<svg class="w-4 h-4 loading-spinner" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> Generating...`;

      try {
        const element = document.getElementById('dashboardContent');
        const datePart = (currentDate || getTodayStr());
        const filename = `screen-time-${currentPeriod}-${datePart}.pdf`;

        const opt = {
          margin: [0.4, 0.4, 0.4, 0.4],
          filename,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, letterRendering: true, logging: false },
          jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        };

        await html2pdf().set(opt).from(element).save();
      } catch (err) {
        console.error('PDF export failed:', err);
        alert('Failed to export PDF. Please try again.');
      } finally {
        exportBtn.disabled = false;
        exportBtn.innerHTML = originalHtml;
      }
    }

    // ─── Seed Data ──────────────────────────────────────────────────────────

    async function seedData() {
      const btn = document.getElementById('seedBtn');
      const originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<svg class="w-4 h-4 loading-spinner" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> Generating...`;

      try {
        const response = await fetch(await apiUrl('/seed'), { method: 'POST' });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          if (response.status === 403) alert('Seed data is only available when running locally (SQLite).\nIt does not work on the production server.');
          else throw new Error(err.message || `Server returned ${response.status}`);
          return;
        }
        const result = await response.json();
        const stats = result.stats;
        alert(`Sample data generated!\n\n${stats.screenTimeRecords} screen-time records\n${stats.goals} goals\n${stats.daysGenerated} days of data`);
        await fetchData({ silent: false });
      } catch (err) {
        console.error('[seed] Error:', err);
        alert('Failed to generate sample data: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }

    // ─── Extension Detection ───────────────────────────────────────────────

    var _extensionDetected = false;

    function detectExtension() {
      if (document.documentElement.dataset.lisTrackInstalled === 'true') {
        _extensionDetected = true;
        return;
      }

      var observer = new MutationObserver(function () {
        if (document.documentElement.dataset.lisTrackInstalled === 'true') {
          _extensionDetected = true;
          document.getElementById('installBanner').classList.add('hidden');
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lis-track-installed'] });

      setTimeout(function () {
        if (!_extensionDetected) {
          let dismissed = false;
          try { dismissed = localStorage.getItem('lisTrackBannerDismissed') === 'true'; } catch (_) {}
          if (!dismissed) document.getElementById('installBanner').classList.remove('hidden');
        }
        observer.disconnect();
      }, 3000);
    }

    function dismissInstallBanner() {
      document.getElementById('installBanner').classList.add('hidden');
      try { localStorage.setItem('lisTrackBannerDismissed', 'true'); } catch (_) {}
    }

    // ─── Init & Auto-refresh ───────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
      // Close modal on Escape
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeDomainModal();
      });

      // Close modal on backdrop click
      document.getElementById('domainModal').addEventListener('click', function (e) {
        if (e.target === this) closeDomainModal();
      });

      initTheme();

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        const saved = (() => { try { return localStorage.getItem('lisTrackTheme'); } catch (_) { return null; } })();
        if (!saved) setTheme(e.matches);
      });

      const params = new URLSearchParams(window.location.search);
      const urlPeriod = params.get('period');
      const urlDate = params.get('date');
      if (urlPeriod && ['day', 'week', 'month', '7days', '30days', 'custom'].includes(urlPeriod)) currentPeriod = urlPeriod;
      if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) currentDate = urlDate;

      updatePeriodButtons();
      detectExtension();

      // Date picker: open native picker on button click
      document.getElementById('datePickerBtn').addEventListener('click', function() {
        const input = document.getElementById('datePickerInput');
        if (input.showPicker) {
          input.showPicker();
        } else {
          input.click();
        }
      });

      // Date picker: jump to selected date
      document.getElementById('datePickerInput').addEventListener('change', function(e) {
        if (e.target.value) {
          goToDate(e.target.value);
        }
      });

      fetchData({ silent: false });
      setInterval(() => fetchData({ silent: true }), 15_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fetchData({ silent: true });
      });
    });
  
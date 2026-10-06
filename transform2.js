const fs = require('fs');
let content = fs.readFileSync('public/js/dashboard.js', 'utf8');

// 1. Add state variables after 'let mvCurrentRange = "today";'
content = content.replace(
  'let mvCurrentRange = "today";',
  'let mvCurrentRange = "today";\n    let mvAbortController = null;\n    let mvLastFetchId = 0;'
);

// 2. Replace the entire Most Visited Sites Range Controls section
const oldSection = `Most Visited Sites Range Controls ────────────────────────────────────

    function setMVRange(range) {
      if (range === mvCurrentRange) return;
      mvCurrentRange = range;
      updateMVRangeButtons();
      renderMVDomainList();
    }

    function updateMVRangeButtons() {
      const ranges = ['today', 'week', 'month', 'all'];
      ranges.forEach(r => {
        const btn = document.getElementById('mv' + r.charAt(0).toUpperCase() + r.slice(1) + 'Btn');
        if (btn) {
          if (r === mvCurrentRange) {
            btn.classList.remove('bg-gray-100', 'dark:bg-gray-700', 'text-gray-500', 'dark:text-gray-400');
            btn.classList.add('bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');
            btn.setAttribute('aria-pressed', 'true');
          } else {
            btn.classList.remove('bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');
            btn.classList.add('bg-gray-100', 'dark:bg-gray-700', 'text-gray-500', 'dark:text-gray-400');
            btn.setAttribute('aria-pressed', 'false');
          }
        }
      });
      const badge = document.getElementById('mvRangeBadge');
      if (badge) {
        const label = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' }[mvCurrentRange];
        badge.textContent = label;
      }
    }

    function renderMVDomainList() {
      const list = document.getElementById('mvDomainList');
      const emptyState = document.getElementById('mvEmptyState');
      if (!list) return;

      // Placeholder: will be replaced when API integration is added
      list.innerHTML = '';
      emptyState.classList.remove('hidden');
      list.classList.add('hidden');
    }`;

const newSection = `Most Visited Sites Range Controls ────────────────────────────────────────────

    function setMVRange(range) {
      if (range === mvCurrentRange) return;
      mvCurrentRange = range;
      updateMVRangeButtons();
      fetchMVData();
    }

    async function fetchMVData() {
      const list = document.getElementById('mvDomainList');
      const emptyState = document.getElementById('mvEmptyState');
      if (!list || !emptyState) return;

      // Cancel any in-flight request to prevent stale responses overwriting newer ones
      if (mvAbortController) {
        mvAbortController.abort();
      }
      mvAbortController = new AbortController();
      const fetchId = ++mvLastFetchId;

      // Show loading state
      list.innerHTML = '';
      list.classList.add('hidden');
      emptyState.classList.add('hidden');
      const loadingHtml = \`
        <div class="px-6 py-8 text-center" id="mvLoadingState">
          <div class="inline-flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
            <svg class="w-5 h-5 loading-spinner" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Loading...</span>
          </div>
        </div>
      \`;
      list.insertAdjacentHTML('afterbegin', loadingHtml);
      list.classList.remove('hidden');

      try {
        const url = await apiUrl('/site-visits', { range: mvCurrentRange });
        const response = await fetch(url, { signal: mvAbortController.signal });

        // Ignore if a newer fetch has started
        if (fetchId !== mvLastFetchId) return;

        if (!response.ok) {
          throw new Error('Server returned ' + response.status);
        }

        const data = await response.json();

        // Validate response shape
        if (!data || !Array.isArray(data.domains)) {
          throw new Error('Invalid response format');
        }

        // Ignore if a newer fetch has started
        if (fetchId !== mvLastFetchId) return;

        renderMVDomainList(data.domains);
      } catch (err) {
        // Ignore aborted requests
        if (err.name === 'AbortError' || fetchId !== mvLastFetchId) return;

        console.error('[MV] Fetch error:', err);
        showMVError(err.message);
      }
    }

    function showMVError(message) {
      const list = document.getElementById('mvDomainList');
      const emptyState = document.getElementById('mvEmptyState');
      if (!list) return;

      list.innerHTML = '';
      emptyState.classList.add('hidden');
      list.classList.remove('hidden');

      const userMessage = message === 'Failed to fetch'
        ? 'Could not connect to the server.'
        : message;

      const errorHtml = \`
        <div class="px-6 py-8 text-center" id="mvErrorState">
          <div class="inline-flex items-center gap-2 text-red-500 dark:text-red-400 text-sm mb-2">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span>\${userMessage}</span>
          </div>
          <button onclick="fetchMVData()" class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors duration-150">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Retry
          </button>
        </div>
      \`;
      list.insertAdjacentHTML('afterbegin', errorHtml);
    }

    function renderMVDomainList(domains) {
      const list = document.getElementById('mvDomainList');
      const emptyState = document.getElementById('mvEmptyState');
      if (!list || !emptyState) return;

      // Remove any loading/error state
      const loadingEl = document.getElementById('mvLoadingState');
      const errorEl = document.getElementById('mvErrorState');
      loadingEl?.remove();
      errorEl?.remove();

      if (!domains || domains.length === 0) {
        list.innerHTML = '';
        list.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      list.classList.remove('hidden');

      // Build rows using DOM APIs (safe from XSS)
      const fragment = document.createDocumentFragment();
      domains.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'px-6 py-3 flex items-center gap-4 rank-item';
        row.setAttribute('data-domain', String(item.domain));

        // Rank
        const rankEl = document.createElement('span');
        rankEl.className = 'flex-shrink-0 w-6 text-sm font-semibold text-gray-300 dark:text-gray-600 text-right';
        rankEl.textContent = String(index + 1);
        row.appendChild(rankEl);

        // Favicon
        const favicon = document.createElement('img');
        favicon.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(String(item.domain)) + '&sz=32';
        favicon.alt = String(item.domain);
        favicon.className = 'flex-shrink-0 w-8 h-8 rounded-lg bg-gray-50 dark:bg-gray-700';
        favicon.onerror = function() { this.style.display = 'none'; this.nextElementSibling.style.display = 'flex'; };
        row.appendChild(favicon);

        // Fallback initial
        const initial = document.createElement('div');
        initial.className = 'flex-shrink-0 w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 items-center justify-center text-xs font-semibold text-gray-400 dark:text-gray-500';
        initial.style.display = 'none';
        initial.textContent = String(item.domain).charAt(0).toUpperCase();
        row.appendChild(initial);

        // Domain name
        const nameEl = document.createElement('span');
        nameEl.className = 'flex-1 min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100 truncate';
        nameEl.textContent = String(item.domain);
        row.appendChild(nameEl);

        // Visit count
        const countEl = document.createElement('span');
        countEl.className = 'flex-shrink-0 text-sm font-semibold text-gray-700 dark:text-gray-300 ml-2';
        countEl.textContent = String(item.visitCount);
        row.appendChild(countEl);

        fragment.appendChild(row);
      });

      list.innerHTML = '';
      list.appendChild(fragment);
    }`;

content = content.replace(oldSection, newSection);

fs.writeFileSync('public/js/dashboard.js', content, 'utf8');
console.log('Done');
const fs = require('fs');
const content = fs.readFileSync('public/js/dashboard.js', 'utf8');
const startIdx = content.indexOf('Most Visited Sites Range Controls');
const endIdx = content.indexOf('// ─── Period Helpers');
const exactSection = content.substring(startIdx, endIdx);

const oldSection = "Most Visited Sites Range Controls \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n    function setMVRange(range) {\n      if (range === mvCurrentRange) return;\n      mvCurrentRange = range;\n      updateMVRangeButtons();\n      renderMVDomainList();\n    }\n\n    function updateMVRangeButtons() {\n      const ranges = ['today', 'week', 'month', 'all'];\n      ranges.forEach(r => {\n        const btn = document.getElementById('mv' + r.charAt(0).toUpperCase() + r.slice(1) + 'Btn');\n        if (btn) {\n          if (r === mvCurrentRange) {\n            btn.classList.remove('bg-gray-100', 'dark:bg-gray-700', 'text-gray-500', 'dark:text-gray-400');\n            btn.classList.add('bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');\n            btn.setAttribute('aria-pressed', 'true');\n          } else {\n            btn.classList.remove('bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');\n            btn.classList.add('bg-gray-100', 'dark:bg-gray-700', 'text-gray-500', 'dark:text-gray-400');\n            btn.setAttribute('aria-pressed', 'false');\n          }\n        }\n      });\n      const badge = document.getElementById('mvRangeBadge');\n      if (badge) {\n        const label = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' }[mvCurrentRange];\n        badge.textContent = label;\n      }\n    }\n\n    function renderMVDomainList() {\n      const list = document.getElementById('mvDomainList');\n      const emptyState = document.getElementById('mvEmptyState');\n      if (!list) return;\n\n      // Placeholder: will be replaced when API integration is added\n      list.innerHTML = '';\n      emptyState.classList.remove('hidden');\n      list.classList.add('hidden');\n    }";

console.log('Exact length:', exactSection.length);
console.log('Old length:', oldSection.length);
console.log('Match:', exactSection === oldSection);

// Find first difference
for (let i = 0; i < Math.min(exactSection.length, oldSection.length); i++) {
  if (exactSection[i] !== oldSection[i]) {
    console.log('First diff at', i);
    console.log('Exact:', JSON.stringify(exactSection.substring(i, i+50)));
    console.log('Old:', JSON.stringify(oldSection.substring(i, i+50)));
    break;
  }
}
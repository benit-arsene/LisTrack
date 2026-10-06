const fs = require('fs');
let content = fs.readFileSync('public/js/dashboard.js', 'utf8');

// Add updateMVRangeButtons() and fetchMVData() after updatePeriodButtons() in DOMContentLoaded
content = content.replace(
  '      updatePeriodButtons();\n\n      // Date picker:',
  '      updatePeriodButtons();\n      updateMVRangeButtons();\n      fetchMVData();\n\n      // Date picker:'
);

fs.writeFileSync('public/js/dashboard.js', content, 'utf8');
console.log('Done');
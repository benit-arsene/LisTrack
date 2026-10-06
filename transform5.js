const fs = require('fs');
let content = fs.readFileSync('public/js/dashboard.js', 'utf8');

// Add updateMVRangeButtons() and fetchMVData() after updatePeriodButtons() in DOMContentLoaded
content = content.replace(
  'updatePeriodButtons();\r\n\r\n      // Date picker:',
  'updatePeriodButtons();\r\n      updateMVRangeButtons();\r\n      fetchMVData();\r\n\r\n      // Date picker:'
);

fs.writeFileSync('public/js/dashboard.js', content, 'utf8');
console.log('Done');
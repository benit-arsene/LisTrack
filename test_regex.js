const fs = require('fs');
const content = fs.readFileSync('public/js/background.js', 'utf8');
console.log('Test regex with backtick:', /fetch\(.*[`'"]\/api\/site-visits/.test(content));
console.log('Test simpler:', /fetch.*api\/site-visits/.test(content));
console.log('Test template literal:', /fetch\(`\$\{SERVER_URL\}\/api\/site-visits/.test(content));
console.log('Test template literal 2:', /fetch\(`.*api\/site-visits/.test(content));
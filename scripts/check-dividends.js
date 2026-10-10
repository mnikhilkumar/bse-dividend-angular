const { checkDividends } = require('../server/dividend-monitor');

checkDividends()
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error('Dividend check failed:', error);
    process.exit(1);
  });

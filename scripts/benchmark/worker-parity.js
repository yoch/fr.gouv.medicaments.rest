const bdpm = require('../../src/services/dataLoader.mts');
const vet = require('../../src/services/vetDataLoader.mts');

(async () => {
  await bdpm.loadData();
  await vet.loadVetData();
  require('../../src/app.mts').createApp().listen(0, '127.0.0.1', function () {
    console.log('__READY__' + this.address().port);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });

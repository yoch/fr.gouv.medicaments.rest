const bdpm = require('../../src/services/dataLoader');
const vet = require('../../src/services/vetDataLoader');

(async () => {
  await bdpm.loadData();
  await vet.loadVetData();
  require('../../src/app').createApp().listen(0, '127.0.0.1', function () {
    console.log('__READY__' + this.address().port);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });

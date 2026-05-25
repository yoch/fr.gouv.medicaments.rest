const { buildBdpmDatabase } = require('../services/bdpmDatabase');

function run() {
  try {
    const result = buildBdpmDatabase();
    console.log('Base SQLite BDPM reconstruite avec succès.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Erreur reconstruction base SQLite BDPM:', error.message);
    process.exitCode = 1;
  }
}

run();

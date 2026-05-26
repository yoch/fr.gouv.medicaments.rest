const { downloadDataIfNeeded } = require('../services/dataDownloader');
const { downloadVetDataIfNeeded } = require('../services/vetDataDownloader');

async function downloadInitialData() {
  try {
    console.log('Téléchargement initial BDPM...');
    await downloadDataIfNeeded();
    console.log('✓ BDPM terminé');

    console.log('Téléchargement initial vétérinaire...');
    await downloadVetDataIfNeeded();
    console.log('✓ Vétérinaire terminé');
  } catch (error) {
    console.error('Erreur téléchargement initial:', error);
    process.exit(1);
  }
}

downloadInitialData();

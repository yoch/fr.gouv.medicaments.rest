const express = require('express');
const {
  listVetCorpusPage,
  searchVet,
  searchVetPage,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum
} = require('../services/vetDataLoader');
const config = require('../config');
const { createListHandler } = require('../utils/routeHelpers');

// Annotations OpenAPI dans `veterinaires.swagger.js` (scannées par swagger-jsdoc).
require('./veterinaires.swagger');

const router = express.Router();

const listHandler = createListHandler({
  getMetadata: getVetMetadata,
  search: searchVet,
  searchPage: searchVetPage,
  listCorpusPage: listVetCorpusPage
});

router.get('/medicaments', listHandler('medicaments'));

router.get('/medicaments/:num', (req, res) => {
  const medicament = getMedicamentByNum(req.params.num);
  if (!medicament) {
    return res.status(404).json({ error: 'Médicament vétérinaire non trouvé' });
  }

  const metadata = getVetMetadata();
  res.json({
    ...medicament,
    presentations: getRelatedByNum('presentations', req.params.num, config.detailHydrateRelatedLimit),
    compositions: getRelatedByNum('compositions', req.params.num, config.detailHydrateRelatedLimit),
    temps_attente: getRelatedByNum('temps_attente', req.params.num, config.detailHydrateRelatedLimit),
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  });
});

router.get('/compositions', listHandler('compositions'));
router.get('/presentations', listHandler('presentations'));

module.exports = router;

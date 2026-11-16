import express from 'express';
import {
  listVetCorpusPage,
  searchVet,
  searchVetPage,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum
} from '../services/vetDataLoader.mts';
import config from '../config.mts';
import { createListHandler } from '../utils/routeHelpers.mts';
import { validateSearchQuery } from '../utils/validateSearchQuery.mts';

// Annotations OpenAPI dans `veterinaires.swagger.js` (scannées par swagger-jsdoc).
import './veterinaires.swagger.js';

const router = express.Router();
router.use(validateSearchQuery);

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

export default router;
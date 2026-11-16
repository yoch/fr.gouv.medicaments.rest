import express from 'express';
import {
  listVetCorpusPage,
  searchVet,
  searchVetPage,
  getVetMetadata
} from '../services/vetDataLoader.mts';
import { getVeterinaireDetailResult } from '../handlers/apiHandlers.mts';
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
  const result = getVeterinaireDetailResult(req.params.num);
  return res.status(result.status).json(result.json);
});

router.get('/compositions', listHandler('compositions'));
router.get('/presentations', listHandler('presentations'));

export default router;
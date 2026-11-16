import express from 'express';
import { createListHandler } from '../../utils/routeHelpers.mts';
import { listCorpusPage, search, searchPage, getMetadata } from '../../services/dataLoader.mts';

const listHandler = createListHandler({ getMetadata, search, searchPage, listCorpusPage });

const router = express.Router();

router.get('/specialites', listHandler('specialites'));
router.get('/presentations', listHandler('presentations'));
router.get('/compositions', listHandler('compositions'));

export default router;
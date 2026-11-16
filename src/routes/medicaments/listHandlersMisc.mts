import express from 'express';
import { createListHandler } from '../../utils/routeHelpers.mts';
import {
  listCorpusPage,
  search,
  searchPage,
  getMetadata
} from '../../services/dataLoader.mts';

const listHandler = createListHandler({ getMetadata, search, searchPage, listCorpusPage });

const router = express.Router();

router.get('/groupes-generiques', listHandler('generiques'));
router.get('/conditions', listHandler('conditions'));
router.get('/substances', listHandler('substances'));

export default router;
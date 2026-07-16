'use strict';

const express = require('express');
const { createListHandler } = require('../../utils/routeHelpers');
const {
  listCorpusPage,
  search,
  searchPage,
  getMetadata
} = require('../../services/dataLoader');

const listHandler = createListHandler({ getMetadata, search, searchPage, listCorpusPage });

const router = express.Router();

router.get('/groupes-generiques', listHandler('generiques'));
router.get('/conditions', listHandler('conditions'));
router.get('/substances', listHandler('substances'));

module.exports = router;

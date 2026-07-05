'use strict';

const express = require('express');
const { createListHandler } = require('../../utils/routeHelpers');
const { listCorpusPage, search, searchPage, getMetadata } = require('../../services/dataLoader');

const listHandler = createListHandler({ getMetadata, search, searchPage, listCorpusPage });

const router = express.Router();

router.get('/specialites', listHandler('specialites'));
router.get('/presentations', listHandler('presentations'));
router.get('/compositions', listHandler('compositions'));

module.exports = router;

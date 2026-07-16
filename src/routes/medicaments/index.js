'use strict';

const express = require('express');

// Annotations OpenAPI centralisées (scannées par swagger-jsdoc).
require('./swagger');

const router = express.Router();

router.use(require('./listHandlers'));
router.use(require('./disponibiliteHandlers'));
router.use(require('./listHandlersMisc'));
router.use(require('./avisHandlers'));
router.use(require('./detailHandlers'));
router.use(require('./searchHandler'));

// Endpoints BDPM désactivés (ex. /infos-importantes) : voir ./disabled.js
// — conservés en réserve pour réactivation, non branchés au routeur.

module.exports = router;

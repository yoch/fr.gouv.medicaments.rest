import express from 'express';
import __cjs_______utils_validateSearchQuery from '../../utils/validateSearchQuery.js';
const { validateSearchQuery } = __cjs_______utils_validateSearchQuery;

// Annotations OpenAPI centralisées (scannées par swagger-jsdoc).
import './swagger.js';

const router = express.Router();
router.use(validateSearchQuery);

import listHandlers from './listHandlers.mts';
router.use(listHandlers);
import disponibiliteHandlers from './disponibiliteHandlers.mts';
router.use(disponibiliteHandlers);
import listHandlersMisc from './listHandlersMisc.mts';
router.use(listHandlersMisc);
import avisHandlers from './avisHandlers.mts';
router.use(avisHandlers);
import detailHandlers from './detailHandlers.mts';
router.use(detailHandlers);
import searchHandler from './searchHandler.mts';
router.use(searchHandler);

// Endpoints BDPM désactivés (ex. /infos-importantes) : voir ./disabled.js
// — conservés en réserve pour réactivation, non branchés au routeur.

export default router;
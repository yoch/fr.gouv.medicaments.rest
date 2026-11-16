import express from 'express';
import { createListHandler } from '../../utils/routeHelpers.mts';
import {
  listCorpusPage,
  search,
  searchPage,
  getMetadata,
  isHasAvisLoaded,
  isMitmLoaded
} from '../../services/dataLoader.mts';

const listHandler = createListHandler({ getMetadata, search, searchPage, listCorpusPage });

const router = express.Router();

function guardedHandler(isLoaded, error) {
  return (dataType) => (req, res) => {
    if (!isLoaded()) return res.status(410).json({ error });
    return listHandler(dataType)(req, res);
  };
}

const avisHandler = guardedHandler(
  isHasAvisLoaded,
  'Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).'
);
const mitmHandler = guardedHandler(
  isMitmLoaded,
  'Les MITM ne sont pas chargés sur ce serveur (LOAD_MITM=false).'
);

router.get('/avis-smr', avisHandler('avis_smr'));
router.get('/avis-asmr', avisHandler('avis_asmr'));
router.get('/interet-therapeutique-majeur', mitmHandler('mitm'));

export default router;
'use strict';

const express = require('express');
const {
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  isHasAvisLoaded,
  DETAIL_HYDRATE_RELATED_LIMIT
} = require('../../services/dataLoader');

const router = express.Router();

router.get('/specialites/:cis', (req, res) => {
  const { cis } = req.params;
  const specialite = getSpecialiteByCis(cis);

  if (!specialite) {
    return res.status(404).json({ error: 'Spécialité non trouvée' });
  }

  const detailLimit = DETAIL_HYDRATE_RELATED_LIMIT;
  const payload = {
    ...specialite,
    presentations: getRelatedByCis('presentations', cis, detailLimit),
    compositions: getRelatedByCis('compositions', cis, detailLimit),
    conditions: getRelatedByCis('conditions', cis, detailLimit),
    generiques: getGeneriquesForCis(cis)
  };

  if (isHasAvisLoaded()) {
    payload.avis_smr = getRelatedByCis('avis_smr', cis, detailLimit);
    payload.avis_asmr = getRelatedByCis('avis_asmr', cis, detailLimit);
  }

  const metadata = getMetadata();
  payload.metadata = {
    last_updated: metadata.last_updated,
    source: metadata.source
  };

  res.json(payload);
});

module.exports = router;

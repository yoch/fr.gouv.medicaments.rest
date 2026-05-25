const express = require('express');
const {
  getVetData,
  searchVet,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum,
  filterPresentationsLinear
} = require('../services/vetDataLoader');
const { DETAIL_HYDRATE_RELATED_LIMIT } = require('../services/dataLoader');

const router = express.Router();
const MAX_LIMIT = 1000;

function paginate(data, page = 1, limit = 100) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  const paginatedData = data.slice(offset, offset + safeLimit);
  const metadata = getVetMetadata();

  return {
    data: paginatedData,
    pagination: {
      total: data.length,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(data.length / safeLimit)
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

function listHandler(dataType, defaultLimit = 100) {
  return (req, res) => {
    const { q, page = 1, limit = defaultLimit } = req.query;
    let data;

    if (dataType === 'presentations') {
      data = q ? filterPresentationsLinear(q) : getVetData('presentations');
    } else {
      data = q ? searchVet(dataType, q) : getVetData(dataType);
    }

    res.json(paginate(data, page, limit));
  };
}

router.get('/medicaments', listHandler('medicaments'));

router.get('/medicaments/:num', (req, res) => {
  const medicament = getMedicamentByNum(req.params.num);
  if (!medicament) {
    return res.status(404).json({ error: 'Médicament vétérinaire non trouvé' });
  }

  const metadata = getVetMetadata();
  res.json({
    ...medicament,
    presentations: getRelatedByNum('presentations', req.params.num, DETAIL_HYDRATE_RELATED_LIMIT),
    compositions: getRelatedByNum('compositions', req.params.num, DETAIL_HYDRATE_RELATED_LIMIT),
    temps_attente: getRelatedByNum('temps_attente', req.params.num, DETAIL_HYDRATE_RELATED_LIMIT),
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  });
});

router.get('/compositions', listHandler('compositions'));
router.get('/presentations', listHandler('presentations'));

module.exports = router;

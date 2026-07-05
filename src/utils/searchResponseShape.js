const MAX_SUMMARY_PRESENTATIONS = 3;

function extractSubstances(compositions, isVet) {
  const seen = new Set();
  const result = [];

  for (const comp of compositions || []) {
    if (isVet) {
      const denomination = comp.substance;
      if (!denomination) continue;
      const dosage = [comp.quantite, comp.unite].filter(Boolean).join(' ').trim();
      const key = `${denomination}\0${dosage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { denomination };
      if (dosage) entry.dosage = dosage;
      result.push(entry);
    } else {
      const denomination = comp.denomination_substance;
      if (!denomination) continue;
      const key = `${denomination}\0${comp.dosage || ''}\0${comp.nature_composant || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        denomination,
        dosage: comp.dosage || undefined,
        nature: comp.nature_composant || undefined
      });
    }
  }

  return result;
}

function shapeHumanPresentation(p) {
  const out = { libelle: p.libelle };
  if (p.cip13) out.cip13 = p.cip13;
  if (p.taux_remboursement) out.taux_remboursement = p.taux_remboursement;
  if (p.etat_commercialisation) out.etat_commercialisation = p.etat_commercialisation;
  if (p.prix_public) out.prix_public = p.prix_public;
  return out;
}

function shapeVetPresentation(p) {
  const out = { libelle: p.libelle };
  if (p.gtin) out.gtin = p.gtin;
  if (p.conditions_delivrance && p.conditions_delivrance.length > 0) {
    out.conditions_delivrance = p.conditions_delivrance;
  }
  return out;
}

function shapeHumanSummary(hit) {
  const presentations = hit.presentations || [];
  const summaryPresentations = presentations
    .slice(0, MAX_SUMMARY_PRESENTATIONS)
    .map(shapeHumanPresentation);

  const shaped = {
    type: hit.type,
    cis: hit.cis,
    denomination: hit.denomination,
    match_quality: hit.match_quality,
    ...(hit.match_via && { match_via: hit.match_via }),
    ...(hit.criteria_match && { criteria_match: hit.criteria_match }),
    forme_pharma: hit.forme_pharma,
    voies_admin: hit.voies_admin,
    titulaire: hit.titulaire,
    commercialisation: hit.commercialisation,
    surveillance_renforcee: hit.surveillance_renforcee,
    url_bdpm: hit.url_bdpm,
    substances: extractSubstances(hit.compositions, false),
    presentations_count: presentations.length,
    presentations: summaryPresentations
  };

  return shaped;
}

function shapeVetSummary(hit) {
  const presentations = hit.presentations || [];
  const summaryPresentations = presentations
    .slice(0, MAX_SUMMARY_PRESENTATIONS)
    .map(shapeVetPresentation);

  const shaped = {
    type: hit.type,
    num: hit.num,
    nom: hit.nom,
    match_quality: hit.match_quality,
    ...(hit.match_via && { match_via: hit.match_via }),
    ...(hit.criteria_match && { criteria_match: hit.criteria_match }),
    titulaire: hit.titulaire,
    forme_pharmaceutique: hit.forme_pharmaceutique,
    statut_amm: hit.statut_amm,
    lien_rcp: hit.lien_rcp,
    substances: extractSubstances(hit.compositions, true),
    presentations_count: presentations.length,
    presentations: summaryPresentations
  };

  if (hit.codes_atcvet && hit.codes_atcvet.length > 0) {
    shaped.codes_atcvet = hit.codes_atcvet;
  }
  if (hit.especes && hit.especes.length > 0) {
    shaped.especes = hit.especes;
  }

  return shaped;
}

function normalizeDetail(detail) {
  const value = (detail || 'full').toLowerCase();
  if (value === 'summary' || value === 'full') return value;
  return 'full';
}

function shapeSearchHit(hit, options = {}) {
  const detail = normalizeDetail(options.detail);
  if (detail === 'full') {
    return hit;
  }
  if (hit.type === 'medicament_veterinaire') {
    return shapeVetSummary(hit);
  }
  return shapeHumanSummary(hit);
}

function shapeSearchResults(results, options = {}) {
  return results.map((hit) => shapeSearchHit(hit, options));
}

module.exports = {
  shapeSearchHit,
  shapeSearchResults,
  normalizeDetail,
  extractSubstances
};

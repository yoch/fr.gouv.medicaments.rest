const { extractSubstances } = require('./searchResponseShape');

const VIA_LABELS = {
  cis: 'CIS',
  num: 'NUM',
  denomination: 'dénomination',
  presentation: 'présentation',
  composition: 'composition'
};

function formatSubstanceEntry(s) {
  const parts = [s.denomination];
  if (s.dosage) parts.push(s.dosage);
  if (s.nature) parts.push(`(${s.nature})`);
  return parts.join(' ');
}

function getSubstances(hit) {
  const isVet = hit.type === 'medicament_veterinaire';
  if (hit.substances && hit.substances.length > 0) return hit.substances;
  if (hit.compositions && hit.compositions.length > 0) {
    return extractSubstances(hit.compositions, isVet);
  }
  return null;
}

function formatSubstances(substances) {
  if (!substances || substances.length === 0) return null;
  return substances.map(formatSubstanceEntry).join(', ');
}

function formatMatchLine(hit) {
  const quality = hit.match_quality || '—';
  if (!hit.match_via) {
    return `- Match: ${quality}`;
  }
  const viaLabel = VIA_LABELS[hit.match_via] || hit.match_via;
  return `- Match: ${quality} (sur ${viaLabel})`;
}

function formatHumanPresentationLine(p) {
  const parts = [p.libelle];
  if (p.cip13) parts.push(`CIP13 ${p.cip13}`);
  if (p.taux_remboursement) parts.push(`remb. ${p.taux_remboursement}`);
  if (p.etat_commercialisation) parts.push(p.etat_commercialisation);
  if (p.prix_public) parts.push(`prix ${p.prix_public}`);
  return parts.join(' — ');
}

function formatVetPresentationLine(p) {
  const parts = [p.libelle];
  if (p.gtin) parts.push(`GTIN ${p.gtin}`);
  if (p.conditions_delivrance && p.conditions_delivrance.length > 0) {
    parts.push(p.conditions_delivrance.join(', '));
  }
  return parts.join(' — ');
}

function appendPresentationBullets(lines, hit, formatLine) {
  const count = hit.presentations_count ?? (hit.presentations || []).length;
  const items = hit.presentations || [];
  if (count === 0) return;

  const headerSuffix = count > items.length ? `, ${items.length} affichées` : '';
  lines.push(`- Présentations (${count})${headerSuffix} :`);
  for (const p of items) {
    lines.push(`  - ${formatLine(p)}`);
  }
  if (count > items.length) {
    lines.push(`  - _… et ${count - items.length} autre(s)_`);
  }
}

function renderHumanHit(hit, index) {
  const lines = [
    `## ${index}. ${hit.denomination} — CIS ${hit.cis}`,
    formatMatchLine(hit)
  ];

  const formeParts = [];
  if (hit.forme_pharma) formeParts.push(hit.forme_pharma);
  if (hit.voies_admin) formeParts.push(`voie ${hit.voies_admin}`);
  if (hit.titulaire) formeParts.push(`titulaire ${hit.titulaire}`);
  if (formeParts.length > 0) {
    lines.push(`- Forme: ${formeParts.join(' · ')}`);
  }

  const statusParts = [];
  if (hit.commercialisation) statusParts.push(hit.commercialisation);
  if (hit.surveillance_renforcee) {
    statusParts.push(`surveillance renforcée ${hit.surveillance_renforcee}`);
  }
  if (statusParts.length > 0) {
    lines.push(`- ${statusParts.join(' · ')}`);
  }

  const substances = formatSubstances(getSubstances(hit));
  if (substances) lines.push(`- Substances: ${substances}`);

  appendPresentationBullets(lines, hit, formatHumanPresentationLine);

  if (hit.url_bdpm) lines.push(`- Fiche: ${hit.url_bdpm}`);

  return lines.join('\n');
}

function renderVetHit(hit, index) {
  const lines = [
    `## ${index}. ${hit.nom} — NUM ${hit.num}`,
    formatMatchLine(hit)
  ];

  const metaParts = [];
  if (hit.forme_pharmaceutique) metaParts.push(hit.forme_pharmaceutique);
  if (hit.titulaire) metaParts.push(`titulaire ${hit.titulaire}`);
  if (hit.statut_amm) metaParts.push(hit.statut_amm);
  if (metaParts.length > 0) {
    lines.push(`- ${metaParts.join(' · ')}`);
  }

  if (hit.codes_atcvet && hit.codes_atcvet.length > 0) {
    lines.push(`- ATCvet: ${hit.codes_atcvet.join(', ')}`);
  }
  if (hit.especes && hit.especes.length > 0) {
    lines.push(`- Espèces: ${hit.especes.join(', ')}`);
  }

  const substances = formatSubstances(getSubstances(hit));
  if (substances) lines.push(`- Substances: ${substances}`);

  appendPresentationBullets(lines, hit, formatVetPresentationLine);

  if (hit.lien_rcp) lines.push(`- RCP: ${hit.lien_rcp}`);

  return lines.join('\n');
}

function renderSearchMarkdown(data, pagination, searchMeta) {
  const query = searchMeta?.query || '';
  const total = pagination?.total ?? data.length;
  const page = pagination?.page ?? 1;
  const shown = data.length;

  const header = [
    `# BDPM — recherche « ${query} »`,
    `${shown} résultat${shown > 1 ? 's' : ''} (${total} au total) · page ${page}`,
    ''
  ];

  const body = data.map((hit, i) => {
    if (hit.type === 'medicament_veterinaire') {
      return renderVetHit(hit, i + 1);
    }
    return renderHumanHit(hit, i + 1);
  });

  if (body.length === 0) {
    body.push('_Aucun résultat._');
  }

  return [...header, ...body].join('\n\n');
}

function normalizeFormat(format) {
  const value = (format || 'json').toLowerCase();
  if (value === 'markdown' || value === 'json') return value;
  return 'json';
}

module.exports = {
  renderSearchMarkdown,
  normalizeFormat,
  formatMatchLine,
  formatSubstances,
  getSubstances
};

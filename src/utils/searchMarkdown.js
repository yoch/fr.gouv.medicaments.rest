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

const CRITERION_STATUS_FORMATTERS = {
  matched: (key) => `${key} ✓`,
  expanded: (key) => `${key} ≈ (expanded)`,
  contradicted: (key) => `${key} ✗ (contradicted)`,
  unknown: (key) => `${key} ? (unknown — non vérifiable)`,
  unsupported: (key) => `${key} ! (unsupported — non pris en charge)`
};

function formatCriteriaLine(hit) {
  const statusMap = hit.criteria_status;
  if (statusMap && typeof statusMap === 'object') {
    const requestedEntries = Object.entries(statusMap).filter(
      ([, status]) => status && status !== 'not_requested'
    );
    if (requestedEntries.length === 0) return null;

    const allMatched = requestedEntries.every(([, status]) => status === 'matched');
    if (allMatched) {
      return `- Critères: ${requestedEntries.map(([key]) => key).join(', ')} ✓`;
    }

    const formatted = requestedEntries.map(([key, status]) => {
      const formatter = CRITERION_STATUS_FORMATTERS[status];
      return formatter ? formatter(key) : `${key}: ${status}`;
    });

    const hasContradiction = requestedEntries.some(([, status]) => status === 'contradicted');
    if (hasContradiction) {
      return `- Critères (⚠️ contradiction — demande partiellement insatisfaite): ${formatted.join(', ')}`;
    }

    const hasIncomplete = requestedEntries.some(
      ([, status]) => status === 'unknown' || status === 'unsupported'
    );
    if (hasIncomplete) {
      return `- Critères (ℹ️ vérification incomplète): ${formatted.join(', ')}`;
    }

    return `- Critères: ${formatted.join(', ')}`;
  }

  const match = hit.criteria_match;
  if (!match) return null;
  const satisfied = Object.entries(match)
    .filter(([, ok]) => ok)
    .map(([key]) => key);
  if (satisfied.length === 0) return null;
  return `- Critères: ${satisfied.join(', ')} ✓`;
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

  const criteriaLine = formatCriteriaLine(hit);
  if (criteriaLine) lines.push(criteriaLine);

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

  const criteriaLine = formatCriteriaLine(hit);
  if (criteriaLine) lines.push(criteriaLine);

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

function formatSearchWarningsBlock(searchMeta) {
  const warnings = [];
  const conflicts =
    searchMeta?.parsed?.conflicts || searchMeta?.conflicts || searchMeta?.query_conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    for (const c of conflicts) {
      const retained =
        c.retained ??
        c.explicit ??
        searchMeta?.parsed?.[c.field] ??
        searchMeta?.criteria?.[c.field] ??
        '';
      warnings.push(
        `- ⚠️ Conflit de critère (${c.field}) : paramètre explicite « ${c.explicit} » prioritaire sur le texte « ${c.parsed} » (retenu : « ${retained} »)`
      );
    }
  }

  const unsupportedCriteria =
    searchMeta?.safety?.unsupported_criteria || searchMeta?.parsed?.unsupported_criteria;
  if (Array.isArray(unsupportedCriteria) && unsupportedCriteria.length > 0) {
    for (const u of unsupportedCriteria) {
      const label = u.field || u.source || 'critère';
      const detail = u.value ? ` « ${u.value} »` : '';
      const reason = u.reason || u.type || 'unsupported';
      warnings.push(`- ⚠️ Contrainte non prise en charge (${label})${detail} : \`${reason}\``);
    }
  }

  return warnings.length > 0 ? warnings.join('\n') : null;
}

function renderSearchMarkdown(data, pagination, searchMeta) {
  const query = searchMeta?.query || '';
  const total = pagination?.total ?? data.length;
  const page = pagination?.page ?? 1;
  const shown = data.length;

  const header = [
    `# BDPM — recherche « ${query} »`,
    `${shown} résultat${shown > 1 ? 's' : ''} (${total} au total) · page ${page}`
  ];

  const warningsBlock = formatSearchWarningsBlock(searchMeta);
  if (warningsBlock) {
    header.push(warningsBlock);
  }
  header.push('');

  const body = data.map((hit, i) => {
    if (hit.type === 'medicament_veterinaire') {
      return renderVetHit(hit, i + 1);
    }
    return renderHumanHit(hit, i + 1);
  });

  if (body.length === 0) {
    if (searchMeta?.abstained) {
      const reason =
        searchMeta.abstain_reason ||
        searchMeta.safety?.intent ||
        'unsupported_query_intent';
      body.push(
        `> ⚠️ **Abstention de recherche** (\`abstained=true\`, raison : \`${reason}\`) — Requête hors périmètre déterministe du référentiel BDPM/ANMV (aucune recherche exécutée ; différent de « aucun médicament trouvé »).`
      );
    } else {
      body.push('_Aucun résultat._');
    }
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
  formatCriteriaLine,
  formatMatchLine,
  formatSubstances,
  getSubstances
};

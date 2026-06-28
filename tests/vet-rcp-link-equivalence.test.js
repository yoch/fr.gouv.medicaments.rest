const fs = require('fs');
const path = require('path');
const { scanVetProductsXml } = require('./helpers/scanVetProductsXml');
const { buildLienRcpFromNom, ANMV_RCP_URL_PREFIX } = require('../src/services/vetDataLoader');

const FIXTURE_XML = path.join(__dirname, 'fixtures/veterinaires/amm-vet-fixture.xml');

/** Ordre de recherche du corpus complet (à rafraîchir périodiquement, voir README). */
function resolveFullProductsXmlPath() {
  const candidates = [
    process.env.VET_RCP_EQUIVALENCE_XML,
    path.join(__dirname, 'fixtures/veterinaires/amm-vet-fr-v2-v.xml'),
    path.join(__dirname, '../data/veterinaires/amm-vet-fr-v2-v.xml')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/** ANMV encode parfois des espaces doubles en `++` dans `<lien-rcp>` alors que `<nom>` n'en a qu'un (flexible-xml-parser 1.4+ les préserve). */
function normalizeRcpLinkForCompare(url) {
  return String(url).replace(/\++/g, '+');
}

/**
 * @param {string} xmlPath
 * @param {{ minWithLien?: number, maxFailuresShown?: number }} [options]
 */
async function collectRcpLinkMismatches(xmlPath, options = {}) {
  const minWithLien = options.minWithLien ?? 1;
  const maxFailuresShown = options.maxFailuresShown ?? 5;
  const mismatches = [];
  let withLien = 0;
  let withoutLien = 0;
  let majWithoutLien = 0;

  await scanVetProductsXml(xmlPath, (fields) => {
    const { nom, lien_rcp_xml, maj_rcp_xml, num } = fields;
    if (!lien_rcp_xml) {
      withoutLien++;
      if (maj_rcp_xml) majWithoutLien++;
      return;
    }
    withLien++;
    const rebuilt = buildLienRcpFromNom(nom);
    if (normalizeRcpLinkForCompare(rebuilt) !== normalizeRcpLinkForCompare(lien_rcp_xml)) {
      mismatches.push({ num, nom, expected: lien_rcp_xml, got: rebuilt });
    }
  });

  if (withLien < minWithLien) {
    return {
      ok: false,
      reason: `seulement ${withLien} <lien-rcp> (attendu ≥ ${minWithLien})`,
      withLien,
      withoutLien,
      majWithoutLien,
      mismatches: []
    };
  }

  if (mismatches.length > 0) {
    const sample = mismatches
      .slice(0, maxFailuresShown)
      .map(
        (m) =>
          `  num=${m.num} nom=${JSON.stringify(m.nom)}\n    XML: ${m.expected}\n    reconstruit: ${m.got}`
      )
      .join('\n');
    const suffix =
      mismatches.length > maxFailuresShown
        ? `\n  … et ${mismatches.length - maxFailuresShown} autre(s)`
        : '';
    return {
      ok: false,
      reason: `${mismatches.length} lien(s) non équivalent(s):\n${sample}${suffix}`,
      withLien,
      withoutLien,
      majWithoutLien,
      mismatches
    };
  }

  return { ok: true, withLien, withoutLien, majWithoutLien, mismatches: [] };
}

describe('Équivalence lien_rcp ANMV (XML source ↔ reconstruction depuis nom)', () => {
  it('tous les <lien-rcp> de la fixture correspondent à buildLienRcpFromNom(nom)', async () => {
    const result = await collectRcpLinkMismatches(FIXTURE_XML, { minWithLien: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.withLien).toBeGreaterThanOrEqual(1);
    for (const m of result.mismatches) {
      expect(m.got).toBe(m.expected);
    }
  });

  it('les liens fixture utilisent le préfixe ANMV attendu', async () => {
    await scanVetProductsXml(FIXTURE_XML, ({ lien_rcp_xml }) => {
      if (!lien_rcp_xml) return;
      expect(lien_rcp_xml.startsWith(ANMV_RCP_URL_PREFIX)).toBe(true);
    });
  });

  const fullXmlPath = resolveFullProductsXmlPath();
  const describeFull = fullXmlPath ? describe : describe.skip;

  describeFull(`corpus complet (${fullXmlPath || 'fichier absent'})`, () => {
    it('chaque <lien-rcp> du XML = buildLienRcpFromNom(nom)', async () => {
      const result = await collectRcpLinkMismatches(fullXmlPath, {
        minWithLien: 2800,
        maxFailuresShown: 8
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.withLien).toBeGreaterThanOrEqual(2800);
    }, 180000);

    it('maj-rcp présent implique un lien-rcp dans le XML source', async () => {
      const result = await collectRcpLinkMismatches(fullXmlPath, { minWithLien: 2800 });
      expect(result.majWithoutLien).toBe(0);
    }, 180000);
  });
});

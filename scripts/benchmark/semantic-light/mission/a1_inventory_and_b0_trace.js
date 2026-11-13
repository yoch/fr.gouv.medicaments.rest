'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');

const config = require('../../../../src/config');
const { loadData, getBdpmCorpusStats } = require('../../../../src/services/dataLoader');
const { loadVetData, getVetCorpusStats } = require('../../../../src/services/vetDataLoader');
const { executeHybridSearchPage } = require('../../../../src/services/searchOrchestrator');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');
const { parseDosageTokens } = require('../../../../src/utils/structuredSearchCriteria');
const medicamentRoutes = require('../../../../src/routes/medicaments');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function summarizeLengths(items, getter) {
  const chars = [];
  const tokens = [];
  let nonEmpty = 0;
  for (const item of items) {
    const val = getter(item);
    const str = Array.isArray(val) ? val.join(' ') : String(val || '');
    if (str.trim()) {
      nonEmpty++;
      chars.push(str.length);
      tokens.push(str.trim().split(/\s+/).length);
    }
  }
  chars.sort((a, b) => a - b);
  tokens.sort((a, b) => a - b);
  return {
    total: items.length,
    nonEmpty,
    pctNonEmpty: items.length ? Number(((nonEmpty / items.length) * 100).toFixed(1)) : 0,
    chars: { p50: percentile(chars, 0.5), p95: percentile(chars, 0.95), max: chars[chars.length - 1] || 0 },
    tokens: { p50: percentile(tokens, 0.5), p95: percentile(tokens, 0.95), max: tokens[tokens.length - 1] || 0 }
  };
}

function sha256File(filepath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filepath));
  return hash.digest('hex');
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/medicaments', medicamentRoutes);

  const memStart = process.memoryUsage();
  const tLoadStart = process.hrtime.bigint();
  await loadData();
  const tBdpmDone = process.hrtime.bigint();
  await loadVetData();
  const tVetDone = process.hrtime.bigint();
  const memLoaded = process.memoryUsage();

  const { corpus: bdpm } = getBdpmCorpusStats();
  const { corpus: vet } = getVetCorpusStats();

  // Snapshot fingerprints
  const bdpmMetaPath = path.join(config.dataDir, 'meta.json');
  const vetMetaPath = path.join(config.vetDataDir, 'meta.json');
  const bdpmMeta = fs.existsSync(bdpmMetaPath) ? JSON.parse(fs.readFileSync(bdpmMetaPath, 'utf8')) : {};
  const vetMeta = fs.existsSync(vetMetaPath) ? JSON.parse(fs.readFileSync(vetMetaPath, 'utf8')) : {};

  // Analyze BDPM compositions, substances, SA/FT, dosages, formes, voies
  const compByCis = new Map();
  const uniqueSubNames = new Set();
  const uniqueSubCodes = new Set();
  const saFtLinks = new Map(); // saCode -> Set<ftCode>
  let compWithDosage = 0;
  let compParseableDosage = 0;

  for (const c of bdpm.compositions) {
    if (!compByCis.has(c.cis)) compByCis.set(c.cis, []);
    compByCis.get(c.cis).push(c);
    if (c.code_substance) uniqueSubCodes.add(c.code_substance);
    if (c.denomination_substance) uniqueSubNames.add(normalizeSearchText(c.denomination_substance));
    if (c.dosage && c.dosage.trim()) {
      compWithDosage++;
      if (parseDosageTokens(c.dosage).length > 0) compParseableDosage++;
    }
  }

  let specsWithCompo = 0;
  let monoSaCis = 0;
  let multiSaCis = 0;
  const maxSaDist = new Map();
  const uniqueFormes = new Set();
  const uniqueVoies = new Set();
  let specsCommercialised = 0;
  let specsWithoutVoie = 0;
  let specsWithoutForme = 0;
  const cisSet = new Set(bdpm.specialites.map((s) => s.cis));

  for (const s of bdpm.specialites) {
    if (s.commercialisation === 'Commercialisée') specsCommercialised++;
    if (s.forme_pharma) uniqueFormes.add(normalizeSearchText(s.forme_pharma));
    else specsWithoutForme++;
    if (s.voies_admin) {
      for (const v of String(s.voies_admin).split(';')) {
        const nv = normalizeSearchText(v);
        if (nv) uniqueVoies.add(nv);
      }
    } else {
      specsWithoutVoie++;
    }

    const comps = compByCis.get(s.cis) || [];
    if (comps.length > 0) specsWithCompo++;

    // Count distinct active substances (SA; fallback FT if no SA) and SA/FT within same numero_ordre
    const byOrder = new Map();
    const activeSet = new Set();
    for (const c of comps) {
      const ord = c.numero_ordre || '0';
      if (!byOrder.has(ord)) byOrder.set(ord, []);
      byOrder.get(ord).push(c);
      if (c.nature_composant === 'SA' && c.denomination_substance) {
        activeSet.add(normalizeSearchText(c.denomination_substance));
      }
    }
    if (activeSet.size === 0) {
      for (const c of comps) {
        if (c.denomination_substance) activeSet.add(normalizeSearchText(c.denomination_substance));
      }
    }
    for (const group of byOrder.values()) {
      const sas = group.filter((g) => g.nature_composant === 'SA');
      const fts = group.filter((g) => g.nature_composant === 'FT');
      for (const sa of sas) {
        for (const ft of fts) {
          const k = normalizeSearchText(sa.denomination_substance);
          if (!saFtLinks.has(k)) saFtLinks.set(k, new Set());
          saFtLinks.get(k).add(normalizeSearchText(ft.denomination_substance));
        }
      }
    }
    if (activeSet.size === 1) monoSaCis++;
    else if (activeSet.size > 1) multiSaCis++;
    maxSaDist.set(activeSet.size, (maxSaDist.get(activeSet.size) || 0) + 1);
  }

  const generCis = new Set(bdpm.generiques.map((g) => g.cis).filter((c) => cisSet.has(c)));
  const mitmCis = new Set(bdpm.mitm.map((m) => m.cis).filter((c) => cisSet.has(c)));
  const condCis = new Set(bdpm.conditions.map((c) => c.cis).filter((c) => cisSet.has(c)));
  const ruptCis = new Set(bdpm.ruptures.map((r) => r.cis).filter((c) => cisSet.has(c)));

  const presPerCis = new Map();
  for (const p of bdpm.presentations) {
    presPerCis.set(p.cis, (presPerCis.get(p.cis) || 0) + 1);
  }
  const presCounts = [...presPerCis.values()].sort((a, b) => a - b);

  // ANMV inventory
  const vetFormes = new Set();
  const vetEspeces = new Set();
  const vetAtc = new Set();
  const vetSubs = new Set();
  for (const m of vet.medicaments) {
    if (m.forme_pharmaceutique) vetFormes.add(normalizeSearchText(m.forme_pharmaceutique));
    for (const e of m.especes || []) vetEspeces.add(normalizeSearchText(e));
    for (const c of m.codes_atcvet || []) vetAtc.add(c);
  }
  for (const c of vet.compositions) {
    if (c.substance) vetSubs.add(normalizeSearchText(c.substance));
  }

  // Real sample B0 HTTP & orchestrator trace
  const sampleQueries = [
    { label: 'exact_name', q: 'doliprane' },
    { label: 'name_plus_dose_space', q: 'doliprane 1000 mg' },
    { label: 'natural_mixed_unit_conv', q: 'Doliprane 1 g comprimé' },
    { label: 'natural_glued_accent', q: 'esoméprazole 40mg' },
    { label: 'natural_name_forme', q: 'Hexamidine collyre' },
    { label: 'natural_dci_voie', q: 'méthotrexate per os' },
    { label: 'natural_brand_forme', q: 'Cerulyse spray' },
    { label: 'brand_with_digit', q: 'MAG 2 100 mg' },
    { label: 'multi_sub_mixed', q: 'amoxicilline acide clavulanique 1 g' },
    { label: 'microgram_symbol', q: 'levothyroxine 25 µg' },
    { label: 'vet_auto_species', q: 'meloxicam chien' },
    { label: 'vet_brand', q: 'SULTRIAN 100' },
    { label: 'typo', q: 'dolipranr' },
    { label: 'structured_baseline', q: 'doliprane', criteria: { dosage: '1 g', forme: 'comprimé' } }
  ];

  const traces = [];
  for (const tc of sampleQueries) {
    const t0 = process.hrtime.bigint();
    const orchRes = executeHybridSearchPage(tc.q, tc.source || 'auto', 1, 5, tc.criteria || {});
    const t1 = process.hrtime.bigint();

    let url = `/api/medicaments/search?q=${encodeURIComponent(tc.q)}&limit=5`;
    if (tc.criteria?.dosage) url += `&dosage=${encodeURIComponent(tc.criteria.dosage)}`;
    if (tc.criteria?.forme) url += `&forme=${encodeURIComponent(tc.criteria.forme)}`;
    const t2 = process.hrtime.bigint();
    const httpRes = await request(app).get(url);
    const t3 = process.hrtime.bigint();

    traces.push({
      label: tc.label,
      q: tc.q,
      criteria: tc.criteria || null,
      orchMs: Number(t1 - t0) / 1e6,
      httpMs: Number(t3 - t2) / 1e6,
      httpStatus: httpRes.statusCode,
      total: orchRes.total,
      searchMeta: orchRes.search,
      top3: (httpRes.body.data || []).slice(0, 3).map((d) => ({
        type: d.type,
        id: d.cis || d.num,
        name: d.denomination || d.nom,
        match_quality: d.match_quality,
        match_via: d.match_via,
        criteria_match: d.criteria_match || null
      }))
    });
  }

  const report = {
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dataDir: config.dataDir,
      vetDataDir: config.vetDataDir,
      configFlags: {
        loadHasAvis: config.loadHasAvis,
        loadMitm: config.loadMitm,
        corpusLightProfile: config.corpusLightProfile,
        searchHydrateRelatedLimit: config.searchHydrateRelatedLimit
      }
    },
    snapshot: {
      bdpmMeta,
      vetMeta,
      cisBdpmSha256: sha256File(path.join(config.dataDir, 'CIS_bdpm.txt')),
      vetXmlSha256: fs.existsSync(path.join(config.vetDataDir, config.vetProductsFile))
        ? sha256File(path.join(config.vetDataDir, config.vetProductsFile))
        : null
    },
    loadTimingMs: {
      bdpmMs: Math.round(Number(tBdpmDone - tLoadStart) / 1e6),
      vetMs: Math.round(Number(tVetDone - tBdpmDone) / 1e6),
      totalMs: Math.round(Number(tVetDone - tLoadStart) / 1e6)
    },
    memoryMb: {
      start: {
        rss: Math.round((memStart.rss / 1048576) * 10) / 10,
        heapUsed: Math.round((memStart.heapUsed / 1048576) * 10) / 10,
        external: Math.round((memStart.external / 1048576) * 10) / 10,
        arrayBuffers: Math.round((memStart.arrayBuffers / 1048576) * 10) / 10
      },
      afterLoad: {
        rss: Math.round((memLoaded.rss / 1048576) * 10) / 10,
        heapUsed: Math.round((memLoaded.heapUsed / 1048576) * 10) / 10,
        external: Math.round((memLoaded.external / 1048576) * 10) / 10,
        arrayBuffers: Math.round((memLoaded.arrayBuffers / 1048576) * 10) / 10
      }
    },
    bdpmInventory: {
      counts: Object.fromEntries(Object.entries(bdpm).map(([k, v]) => [k, v.length])),
      fieldProfiles: {
        specialites_denomination: summarizeLengths(bdpm.specialites, (r) => r.denomination),
        specialites_forme_pharma: summarizeLengths(bdpm.specialites, (r) => r.forme_pharma),
        specialites_voies_admin: summarizeLengths(bdpm.specialites, (r) => r.voies_admin),
        presentations_libelle: summarizeLengths(bdpm.presentations, (r) => r.libelle),
        compositions_substance: summarizeLengths(bdpm.compositions, (r) => r.denomination_substance),
        generiques_libelle_groupe: summarizeLengths(bdpm.generiques, (r) => r.libelle_groupe)
      },
      coverageAndRelations: {
        specialitesCommercialised: specsCommercialised,
        specialitesWithCompositions: specsWithCompo,
        specialitesWithoutForme: specsWithoutForme,
        specialitesWithoutVoie: specsWithoutVoie,
        uniqueFormesNormalized: uniqueFormes.size,
        uniqueVoiesNormalized: uniqueVoies.size,
        uniqueSubstanceCodes: uniqueSubCodes.size,
        uniqueSubstanceNamesNormalized: uniqueSubNames.size,
        saToFtLinksCount: saFtLinks.size,
        monoSubstanceCis: monoSaCis,
        multiSubstanceCis: multiSaCis,
        activeSubstancesPerCisDist: Object.fromEntries([...maxSaDist.entries()].sort((a, b) => a[0] - b[0])),
        compositionsWithDosage: compWithDosage,
        compositionsWithParseableDosage: compParseableDosage,
        cisInGeneriques: generCis.size,
        cisInMitm: mitmCis.size,
        cisInConditions: condCis.size,
        cisInRuptures: ruptCis.size,
        presentationsPerCis: {
          p50: percentile(presCounts, 0.5),
          p95: percentile(presCounts, 0.95),
          max: presCounts[presCounts.length - 1] || 0
        }
      }
    },
    anmvInventory: {
      counts: Object.fromEntries(Object.entries(vet).map(([k, v]) => [k, v.length])),
      uniqueFormesNormalized: vetFormes.size,
      uniqueEspecesNormalized: vetEspeces.size,
      uniqueAtcvetCodes: vetAtc.size,
      uniqueSubstanceNamesNormalized: vetSubs.size,
      fieldProfiles: {
        vet_nom: summarizeLengths(vet.medicaments, (r) => r.nom),
        vet_forme: summarizeLengths(vet.medicaments, (r) => r.forme_pharmaceutique),
        vet_especes: summarizeLengths(vet.medicaments, (r) => r.especes),
        vet_presentations: summarizeLengths(vet.presentations, (r) => r.libelle)
      }
    },
    b0Traces: traces
  };

  const outPath = path.join(__dirname, 'a1_report.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

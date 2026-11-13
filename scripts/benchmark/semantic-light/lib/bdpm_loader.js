'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeText } = require('./text_utils');

function resolveMainRepoRoot() {
  const localRoot = path.resolve(__dirname, '../../../..');
  if (fs.existsSync(path.join(localRoot, 'data', 'CIS_bdpm.txt'))) {
    return localRoot;
  }
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: localRoot,
      encoding: 'utf8',
    }).trim();
    const resolvedGit = path.resolve(localRoot, commonDir);
    const parent = path.dirname(resolvedGit);
    if (fs.existsSync(path.join(parent, 'data', 'CIS_bdpm.txt'))) {
      return parent;
    }
  } catch (_) {
    // Fallback below
  }
  throw new Error('Impossible de localiser data/CIS_bdpm.txt (ni localement ni via git-common-dir)');
}

const SALT_WORDS = new Set([
  'chlorhydrate', 'dichlorhydrate', 'bromhydrate', 'maleate', 'hemimaleate',
  'tartrate', 'bitartrate', 'citrate', 'fumarate', 'hemifumarate', 'mesilate',
  'besilate', 'tosilate', 'sulfate', 'phosphate', 'disodique', 'monosodique',
  'sodique', 'potassique', 'calcique', 'magnesien', 'sodium', 'potassium',
  'calcium', 'sel', 'base', 'anhydre', 'monohydrate', 'monohydrat', 'dihydrate',
  'trihydrate', 'trihydratee', 'hemihydrate', 'hemihydratee', 'ester',
  'acetate', 'diacetate', 'succinate', 'hemisuccinate', 'gluconate',
  'lactate', 'oxalate', 'benzoate', 'nitrate', 'propionate', 'valerate',
  'butyrate', 'pamoate', 'embonate', 'dipropionate', 'furoate', 'palmitate',
  'stearate', 'bromure', 'chlorure', 'de', 'd', 'du', 'des', 'et', 'pour',
  'preparations', 'homeopathiques', 'teinture', 'mere', 'extrait', 'sec',
  'fluide', 'huile', 'essentielle', 'solution', 'aqueuse', 'poudre'
]);

function canonicalizeSubstance(rawSub) {
  // Replace parentheses instead of deleting content inside, so inverted BDPM labels
  // like "SODIUM (BICARBONATE DE)" or "ACETYLSALICYLIQUE (ACIDE)" keep their active stem.
  const s = normalizeText(rawSub).replace(/[()]/g, ' ');
  const toks = s
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !SALT_WORDS.has(t) && !/^\d+$/.test(t));
  if (toks.length === 0) {
    return normalizeText(rawSub).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Normalize "X acide" -> "acide X" so "ACETYLSALICYLIQUE (ACIDE)" matches "ACIDE ACETYLSALICYLIQUE"
  if (toks.length >= 2 && toks[toks.length - 1] === 'acide') {
    toks.pop();
    toks.unshift('acide');
  }
  return toks.join(' ');
}

function cleanRcpBoilerplate(text) {
  return String(text || '')
    .replace(/voir rubrique\s*\d+(?:\.\d+)?/gi, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRcpSections(mdText) {
  const sec41 = mdText.match(/#+\s*4\.1\.?[^\n]*\n([\s\S]*?)(?=\n#+\s*4\.[2-9]|\n#+\s*[56]\.|$)/i);
  const sec43 = mdText.match(/#+\s*4\.3\.?[^\n]*\n([\s\S]*?)(?=\n#+\s*4\.[4-9]|\n#+\s*[56]\.|$)/i);
  const sec46 = mdText.match(/#+\s*4\.6\.?[^\n]*\n([\s\S]*?)(?=\n#+\s*4\.[7-9]|\n#+\s*[56]\.|$)/i);
  const sec48 = mdText.match(/#+\s*4\.8\.?[^\n]*\n([\s\S]*?)(?=\n#+\s*4\.9|\n#+\s*[56]\.|$)/i);
  const clsMatch = mdText.match(/Classe pharmacoth[ée]rapeutique\s*[:\-]?\s*([^\n]+)/i);
  const atcMatch = mdText.match(/code\s+ATC\s*[:\-]?\s*([A-Z]\d{2}[A-Z]{0,2}\d{0,2})/i);

  let classePharm = clsMatch ? clsMatch[1].trim() : '';
  classePharm = classePharm.replace(/,?\s*code\s+ATC\s*[:\-]?\s*[A-Z0-9]+\.?/gi, '').trim();

  return {
    rcp41: sec41 ? cleanRcpBoilerplate(sec41[1]) : '',
    rcp43: sec43 ? cleanRcpBoilerplate(sec43[1]) : '',
    rcp46: sec46 ? cleanRcpBoilerplate(sec46[1]) : '',
    rcp48: sec48 ? cleanRcpBoilerplate(sec48[1]).slice(0, 3500) : '',
    classePharm,
    atcCode: atcMatch ? atcMatch[1].toUpperCase() : '',
  };
}

const BRAND_STOP = new Set([
  'acide', 'chlorhydrate', 'solution', 'comprime', 'gelule', 'pommade', 'creme',
  'sirop', 'gouttes', 'spray', 'poudre', 'eau', 'huile', 'solute', 'vaccin',
  'serum', 'teinture', 'extrait', 'alcool', 'bicarbonate', 'chlorure', 'sulfate',
  'gluconate', 'citrate', 'phosphate', 'calcium', 'magnesium', 'potassium',
  'sodium', 'zinc', 'fer', 'vitamine', 'complexe', 'elixir', 'baume', 'tisane',
  'oxygene', 'azote', 'glucose', 'fructose', 'lidocaine', 'adrenaline',
  'hydrocortisone', 'prednisolone', 'paracetamol', 'ibuprofene', 'amoxicilline'
]);

function loadBdpmRigorousCorpus({ includeRcp48 = true } = {}) {
  const repoRoot = resolveMainRepoRoot();
  const dataDir = path.join(repoRoot, 'data');
  const rcpDir = path.join(repoRoot, 'rcp_md');

  // 1. CIS_bdpm.txt
  const docs = [];
  const docByCis = new Map();
  const specLines = fs.readFileSync(path.join(dataDir, 'CIS_bdpm.txt'), 'utf8').split(/\r?\n/);
  for (const line of specLines) {
    if (!line) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    const cis = p[0].trim();
    if (!cis || docByCis.has(cis)) continue;
    const doc = {
      id: docs.length,
      cis,
      denomination: p[1].trim(),
      forme_pharma: p[2].trim(),
      voie: p[3].trim(),
      statut_amm: p[4].trim(),
      etat_commercialisation: p[6].trim(),
      is_commercialisee: /^Commercialis/i.test(p[6].trim()),
      titulaire: (p[10] || '').trim(),
      substances_raw: [],
      canonical_subs: [],
      sub_sig: '',
      gener_group_id: null,
      gener_label: '',
      gener_type: null,
      cpd_list: [],
      is_hospital: false,
      is_prescription: false,
      smr_str: '',
      atc_code: '',
      classe_pharm: '',
      rcp_41: '',
      rcp_43: '',
      rcp_46: '',
      rcp_48: '',
    };
    docs.push(doc);
    docByCis.set(cis, doc);
  }

  // 2. CIS_COMPO_bdpm.txt (unify substance code synonyms + prefer FT per (cis, link_num), fallback SA)
  const compoRawRows = [];
  const subCodeLabels = new Map(); // code_sub -> best label (preferring parent-free label)
  const compoLines = fs.readFileSync(path.join(dataDir, 'CIS_COMPO_bdpm.txt'), 'utf8').split(/\r?\n/);
  for (const line of compoLines) {
    if (!line) continue;
    const p = line.split('\t');
    if (p.length < 8) continue;
    const cis = p[0].trim();
    if (!docByCis.has(cis)) continue;
    const codeSub = p[2].trim();
    const sub = p[3].trim();
    const nature = p[6].trim();
    const link = p[7].trim() || '1';
    if (!sub) continue;
    compoRawRows.push({ cis, codeSub, sub, nature, link });

    if (codeSub) {
      const prev = subCodeLabels.get(codeSub);
      if (!prev) {
        subCodeLabels.set(codeSub, sub);
      } else {
        const prevHasParen = prev.includes('(');
        const curHasParen = sub.includes('(');
        if ((prevHasParen && !curHasParen) || (prevHasParen === curHasParen && sub.length < prev.length)) {
          subCodeLabels.set(codeSub, sub);
        }
      }
    }
  }

  const compoLinks = new Map(); // cis -> Map<link, { FT: [], SA: [], allRaw: [] }>
  for (const row of compoRawRows) {
    const unifiedSub = (row.codeSub && subCodeLabels.get(row.codeSub)) || row.sub;
    let byLink = compoLinks.get(row.cis);
    if (!byLink) {
      byLink = new Map();
      compoLinks.set(row.cis, byLink);
    }
    let entry = byLink.get(row.link);
    if (!entry) {
      entry = { FT: [], SA: [], allRaw: [] };
      byLink.set(row.link, entry);
    }
    entry.allRaw.push(row.sub);
    if (row.nature === 'FT') entry.FT.push(unifiedSub);
    else entry.SA.push(unifiedSub);
  }

  for (const [cis, byLink] of compoLinks) {
    const doc = docByCis.get(cis);
    const rawSet = new Set();
    const canonSet = new Set();
    for (const entry of byLink.values()) {
      for (const r of entry.allRaw) rawSet.add(r);
      const chosen = entry.FT.length > 0 ? entry.FT : entry.SA;
      for (const c of chosen) {
        const canon = canonicalizeSubstance(c);
        if (canon) canonSet.add(canon);
      }
    }
    doc.substances_raw = [...rawSet];
    doc.canonical_subs = [...canonSet].sort();
    doc.sub_sig = doc.canonical_subs.join(' + ');
  }

  // 3. CIS_GENER_bdpm.txt
  const princepsByGroup = new Map();
  const generLines = fs.readFileSync(path.join(dataDir, 'CIS_GENER_bdpm.txt'), 'utf8').split(/\r?\n/);
  for (const line of generLines) {
    if (!line) continue;
    const p = line.split('\t');
    if (p.length < 4) continue;
    const gid = p[0].trim();
    const label = p[1].trim();
    const cis = p[2].trim();
    const gtype = p[3].trim();
    const doc = docByCis.get(cis);
    if (!doc) continue;
    doc.gener_group_id = gid;
    doc.gener_label = label;
    doc.gener_type = gtype;
    if (gtype === '0') {
      const arr = princepsByGroup.get(gid) || [];
      arr.push(doc.denomination);
      princepsByGroup.set(gid, arr);
    }
  }

  // 4. CIS_CPD_bdpm.txt
  const cpdPath = path.join(dataDir, 'CIS_CPD_bdpm.txt');
  if (fs.existsSync(cpdPath)) {
    for (const line of fs.readFileSync(cpdPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const p = line.split('\t');
      if (p.length < 2) continue;
      const doc = docByCis.get(p[0].trim());
      if (!doc) continue;
      const cond = p[1].trim();
      doc.cpd_list.push(cond);
      if (/hospitalier/i.test(cond)) doc.is_hospital = true;
      if (/liste i|liste ii|stup[ée]fiant|prescription/i.test(cond)) doc.is_prescription = true;
    }
  }

  // 5. CIS_HAS_SMR_bdpm.txt
  const smrByCis = new Map();
  const smrPath = path.join(dataDir, 'CIS_HAS_SMR_bdpm.txt');
  if (fs.existsSync(smrPath)) {
    for (const line of fs.readFileSync(smrPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const p = line.split('\t');
      if (p.length < 6) continue;
      const cis = p[0].trim();
      if (!docByCis.has(cis)) continue;
      let txt = p[5].replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
      if (!txt || /insuffisant/i.test(p[4])) continue;
      if (/est important dans l.indication de l.AMM/i.test(txt)) continue;
      let set = smrByCis.get(cis);
      if (!set) {
        set = new Set();
        smrByCis.set(cis, set);
      }
      if (set.size < 3) set.add(txt.slice(0, 350));
    }
    for (const [cis, set] of smrByCis) {
      docByCis.get(cis).smr_str = [...set].join(' | ');
    }
  }

  // 6. CIS_MITM.txt (ATC fallback)
  const mitmPath = path.join(dataDir, 'CIS_MITM.txt');
  if (fs.existsSync(mitmPath)) {
    for (const line of fs.readFileSync(mitmPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const p = line.split('\t');
      if (p.length < 2) continue;
      const doc = docByCis.get(p[0].trim());
      if (doc && p[1].trim()) {
        doc.atc_code = p[1].trim().toUpperCase();
      }
    }
  }

  // 7. RCP markdown files (rcp_md/*.md) — clean separation of 4.1 / 4.3 / 4.6 / 4.8 / 5.1
  if (fs.existsSync(rcpDir)) {
    for (const fname of fs.readdirSync(rcpDir)) {
      if (!fname.endsWith('.md')) continue;
      const cis = fname.slice(0, -3);
      const doc = docByCis.get(cis);
      if (!doc) continue;
      const md = fs.readFileSync(path.join(rcpDir, fname), 'utf8');
      const sec = parseRcpSections(md);
      doc.rcp_41 = sec.rcp41;
      doc.rcp_43 = sec.rcp43;
      doc.rcp_46 = sec.rcp46;
      doc.rcp_48 = includeRcp48 ? sec.rcp48 : '';
      doc.classe_pharm = sec.classePharm;
      if (sec.atcCode) doc.atc_code = sec.atcCode;
    }
  }

  // 8. Automatic Brand -> Canonical Substance(s) mapping from CIS_bdpm x CIS_COMPO (NO manual lexicon!)
  // Handles mono- AND bi/tri-substance brands like DOLIPRANE -> [paracetamol], AUGMENTIN -> [amoxicilline, clavulanique]
  const brandSigCounts = new Map(); // brandToken -> Map<subSig, count>
  const brandIndivCounts = new Map(); // brandToken -> Map<canonSub, docCount>
  const brandTotals = new Map();
  for (const doc of docs) {
    if (doc.canonical_subs.length === 0 || doc.canonical_subs.length > 3) continue;
    const head = normalizeText(doc.denomination.split(',')[0]);
    const toks = head.match(/[a-z0-9]+/g);
    if (!toks || toks.length === 0) continue;
    const brand = toks[0];
    if (brand.length < 4 || /^\d+$/.test(brand) || BRAND_STOP.has(brand)) continue;
    // Do not map generic DCI name to itself
    const allSubWords = new Set(doc.canonical_subs.join(' ').split(/\s+/));
    if (allSubWords.has(brand)) continue;

    brandTotals.set(brand, (brandTotals.get(brand) || 0) + 1);
    let m = brandSigCounts.get(brand);
    if (!m) {
      m = new Map();
      brandSigCounts.set(brand, m);
    }
    m.set(doc.sub_sig, (m.get(doc.sub_sig) || 0) + 1);

    let ind = brandIndivCounts.get(brand);
    if (!ind) {
      ind = new Map();
      brandIndivCounts.set(brand, ind);
    }
    for (const s of new Set(doc.canonical_subs)) {
      ind.set(s, (ind.get(s) || 0) + 1);
    }
  }

  const brandToCanonSubs = new Map(); // brandToken -> { subSig, subs: string[], ratio }
  for (const [brand, counts] of brandSigCounts) {
    const total = brandTotals.get(brand);
    let bestSig = '';
    let bestCount = 0;
    for (const [sig, c] of counts) {
      if (c > bestCount) {
        bestSig = sig;
        bestCount = c;
      }
    }
    const ratio = bestCount / total;
    if (bestSig && ratio >= 0.7) {
      brandToCanonSubs.set(brand, {
        subSig: bestSig,
        subs: bestSig.split(' + ').filter(Boolean),
        count: bestCount,
        total,
        ratio,
      });
    } else {
      // Fallback for brands sharing one core molecule across salt/combo variants (e.g. SPASFON, DAFALGAN)
      const ind = brandIndivCounts.get(brand);
      const dominantSubs = [];
      for (const [sub, c] of ind) {
        if (c / total >= 0.8) dominantSubs.push(sub);
      }
      dominantSubs.sort();
      if (dominantSubs.length > 0) {
        brandToCanonSubs.set(brand, {
          subSig: dominantSubs.join(' + '),
          subs: dominantSubs,
          count: Math.round(total * 0.8),
          total,
          ratio: 0.8,
        });
      }
    }
  }

  // Also map ATC -> dominant classes/substances & sub_sig -> docs
  const docsBySubSig = new Map();
  for (const doc of docs) {
    if (!doc.sub_sig) continue;
    const arr = docsBySubSig.get(doc.sub_sig) || [];
    arr.push(doc.id);
    docsBySubSig.set(doc.sub_sig, arr);
  }

  return {
    repoRoot,
    dataDir,
    docs,
    docByCis,
    princepsByGroup,
    brandToCanonSubs,
    docsBySubSig,
  };
}

module.exports = {
  resolveMainRepoRoot,
  canonicalizeSubstance,
  loadBdpmRigorousCorpus,
};

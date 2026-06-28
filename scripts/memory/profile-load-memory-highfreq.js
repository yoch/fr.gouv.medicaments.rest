#!/usr/bin/env node
/**
 * Profil mémoire haute fréquence pendant loadData / loadVetData.
 * Pas de GC entre échantillons → pic RSS réaliste.
 *
 * Usage:
 *   node --expose-gc scripts/memory/profile-load-memory-highfreq.js
 *   PROFILE_SAMPLE_MS=100 PROFILE_VET=1 node --expose-gc scripts/memory/profile-load-memory-highfreq.js
 *   PROFILE_OUT=tmp/vet-mem.json node --expose-gc scripts/memory/profile-load-memory-highfreq.js
 *
 * Env:
 *   PROFILE_SAMPLE_MS — intervalle (défaut 200 = 5/s)
 *   PROFILE_VET — 0 pour BDPM seul
 *   PROFILE_BDPM — 0 pour vet seul (après gc baseline)
 *   PROFILE_GC_BASELINE — true pour gc avant baseline uniquement
 *   PROFILE_OUT — fichier JSON (optionnel)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { gcBeforeMeasure } = require('../../src/utils/loadGc');
const {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks
} = require('../../src/utils/memorySampler');

const PROFILE_SAMPLE_MS = parseInt(process.env.PROFILE_SAMPLE_MS || '200', 10);
const PROFILE_VET = process.env.PROFILE_VET !== '0';
const PROFILE_BDPM = process.env.PROFILE_BDPM !== '0';
const PROFILE_OUT = process.env.PROFILE_OUT || '';
const LOAD_HAS_AVIS = process.env.LOAD_HAS_AVIS !== 'false';

function windowPeak(samples, t0, t1) {
  let peak = { rss_mb: 0, heapUsed_mb: 0, t_ms: 0 };
  for (const s of samples) {
    if (s.t_ms < t0 || s.t_ms > t1) continue;
    if (s.rss_mb > peak.rss_mb) peak = { rss_mb: s.rss_mb, heapUsed_mb: s.heapUsed_mb, t_ms: s.t_ms };
    else if (s.rss_mb === peak.rss_mb && s.heapUsed_mb > peak.heapUsed_mb) {
      peak.heapUsed_mb = s.heapUsed_mb;
    }
  }
  return peak;
}

function markTime(marks, phase) {
  const m = marks.find((x) => x.phase === phase);
  return m ? m.t_ms : null;
}

async function main() {
  const sampler = createMemorySampler({
    intervalMs: PROFILE_SAMPLE_MS,
    gcBeforeSample: false
  });

  const meta = {
    node: process.version,
    PROFILE_SAMPLE_MS,
    PROFILE_VET,
    PROFILE_BDPM,
    LOAD_HAS_AVIS,
    note: 'Échantillons sans GC — pics RSS exploitables'
  };
  console.log(JSON.stringify(meta, null, 2));

  if (process.env.PROFILE_GC_BASELINE === 'true') {
    gcBeforeMeasure('baseline');
  }
  sampler.mark('baseline');

  installLoadMemoryMarks(sampler);
  sampler.start();

  try {
    if (PROFILE_BDPM) {
      const { loadData } = require('../../src/services/dataLoader');
      await loadData();
    }

    if (PROFILE_VET) {
      const { loadVetData } = require('../../src/services/vetDataLoader');
      await loadVetData();
    }
  } finally {
    sampler.stop();
    uninstallLoadMemoryMarks();
  }

  const samples = sampler.getSamples();
  const marks = sampler.getMarks();
  const summary = sampler.summarize();

  const phases = {};
  const vetStream = markTime(marks, 'vet_stream_done');
  const vetMedStart = markTime(marks, 'vet_index_medicaments_start');
  const vetMedDone = markTime(marks, 'vet_index_medicaments_done');
  const vetCompStart = markTime(marks, 'vet_index_compositions_start');
  const vetCompDone = markTime(marks, 'vet_index_compositions_done');

  if (vetStream != null && vetMedStart != null) {
    phases.vet_cache_only_stream = windowPeak(samples, vetStream - 50, vetMedStart);
  }
  if (vetMedStart != null && vetMedDone != null) {
    phases.vet_index_medicaments = windowPeak(samples, vetMedStart, vetMedDone);
  }
  if (vetCompStart != null && vetCompDone != null) {
    phases.vet_index_compositions = windowPeak(samples, vetCompStart, vetCompDone);
  }

  const bdpmStart = markTime(marks, 'bdpm_start');
  const bdpmDone = markTime(marks, 'bdpm_done');
  if (bdpmStart != null && bdpmDone != null) {
    phases.bdpm_full = windowPeak(samples, bdpmStart, bdpmDone);
  }

  const report = { meta, summary, phases, marks };

  console.log('\n=== RÉSUMÉ ===');
  console.log(JSON.stringify({ summary, phases }, null, 2));

  console.log('\n=== MARQUEURS (phases) ===');
  console.log('| t (ms) | phase | rss (Mo) | heap (Mo) |');
  console.log('|--------|-------|----------|-----------|');
  for (const m of marks) {
    const extra = m.medicaments != null ? ` med=${m.medicaments}` : '';
    const extra2 = m.compositions != null ? ` comp=${m.compositions}` : '';
    console.log(
      `| ${m.t_ms} | ${m.phase} | ${m.rss_mb} | ${m.heapUsed_mb} |${extra}${extra2}`
    );
  }

  console.log('\n=== ÉCHANTILLONS (1 ligne / ~' + PROFILE_SAMPLE_MS + 'ms, tronqué) ===');
  const step = Math.max(1, Math.floor(samples.length / 40));
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    const tag = s.phase ? ` [${s.phase}]` : '';
    console.log(`  t=${String(s.t_ms).padStart(6)}ms  rss=${s.rss_mb}  heap=${s.heapUsed_mb}${tag}`);
  }

  if (PROFILE_OUT) {
    const outPath = path.resolve(PROFILE_OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ...report, samples }, null, 2));
    console.log('\nÉcrit:', outPath, `(${samples.length} échantillons)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

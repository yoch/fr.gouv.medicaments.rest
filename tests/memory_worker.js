/**
 * Worker chargé par memory_peak_harness.js — émet des phases JSON sur stdout.
 */
const { loadData, search } = require('../src/services/dataLoader');
const { loadVetData } = require('../src/services/vetDataLoader');
const { executeHybridSearch } = require('../src/services/searchOrchestrator');
const {
  markMemoryPhase,
  resetMemoryPhases,
  snapshotProcessMemory,
  maybeGc
} = require('../src/utils/memoryProfile');

function emit(phase, extra = {}) {
  const payload = {
    type: 'phase',
    phase,
    memory: snapshotProcessMemory(),
    ...extra
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runSearchWorkload() {
  const queries = ['doliprane', 'paracetamol', '60234100', 'pfizer', 'amoxicilline'];
  for (const q of queries) {
    search('specialites', q);
    search('presentations', q);
    search('compositions', q);
    executeHybridSearch(q, 'mixed');
  }
}

async function main() {
  const scenario = process.env.MEMORY_SCENARIO || 'boot';
  resetMemoryPhases();
  emit('before_load');

  await loadData();
  emit('after_bdpm_load');
  maybeGc('after_bdpm');

  if (process.env.MEMORY_SKIP_VET !== 'true') {
    await loadVetData();
    emit('after_vet_load');
    maybeGc('after_vet');
  }

  await runSearchWorkload();
  emit('after_search_workload');

  if (scenario === 'refresh') {
    await loadData();
    emit('after_refresh_bdpm');
    maybeGc('after_refresh_bdpm');
    if (process.env.MEMORY_SKIP_VET !== 'true') {
      await loadVetData();
      emit('after_refresh_vet');
    }
  }

  emit('done', { phases: require('../src/utils/memoryProfile').getMemoryPhases() });
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});

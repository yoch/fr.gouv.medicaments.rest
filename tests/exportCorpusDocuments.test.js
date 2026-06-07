'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportCorpusDocuments } = require('../src/utils/exportCorpusDocuments');
const { buildIndexDocument } = require('../src/utils/corpusStore');
const { miniSearchIndexConfig } = require('../src/utils/miniSearchIndexConfig');
const { FrozenMiniSearch } = require('@yoch/frozenminisearch');

describe('exportCorpusDocuments', () => {
  let outDir;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-export-'));
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('écrit du JSONL indexable par FrozenMiniSearch.fromDocuments', () => {
    const fields = ['denomination'];
    const rows = [{ denomination: 'DOLIPRANE 500 mg' }, { denomination: 'EFFERALGAN 1000 mg' }];
    const indexOptions = miniSearchIndexConfig(fields);

    const manifest = exportCorpusDocuments(
      [
        {
          type: 'specialites',
          rows,
          toDocument: (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
          indexOptions
        }
      ],
      outDir,
      'test',
      { source: 'fixture' }
    );

    expect(manifest.format).toBe('corpus-jsonl-v1');
    expect(manifest.datasets.specialites.documentCount).toBe(2);

    const jsonlPath = path.join(outDir, 'test_specialites.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const documents = lines.map((line) => JSON.parse(line));

    expect(documents).toEqual([
      { id: 0, denomination: 'DOLIPRANE 500 mg' },
      { id: 1, denomination: 'EFFERALGAN 1000 mg' }
    ]);

    const index = FrozenMiniSearch.fromDocuments(documents, manifest.datasets.specialites.indexOptions);
    expect(index.search('doliprane').map((r) => r.id)).toEqual([0]);
  });
});

const MiniSearch = require('minisearch');

// Mock data similar to real data for testing score ranges
const data = [
    { id: 1, denomination: 'SPASFON LYOC 160 mg, lyophilisat oral' },
    { id: 2, denomination: 'SPASFON, comprimé enrobé' },
    { id: 3, denomination: 'CODOLIPRANE 500 mg/30 mg, comprimé' },
    { id: 4, denomination: 'DOLIPRANE 1000 mg, comprimé' },
    { id: 5, denomination: 'PARACETAMOL SANDOZ 1 g, comprimé' },
    { id: 6, denomination: 'COQUELUSEDAL PARACETAMOL 500 mg, suppositoire' },
];

const miniSearch = new MiniSearch({
    fields: ['denomination'],
    storeFields: ['denomination'],
    processTerm: (term) => term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    searchOptions: {
        processTerm: (term) => term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
        prefix: true,
        fuzzy: 0.2
    }
});

miniSearch.addAll(data);

console.log('--- Raw Scores Analysis ---');
['spasfon', 'doliprane', 'paracetamol'].forEach(q => {
    console.log(`Query: "${q}"`);
    miniSearch.search(q).forEach(r => {
        console.log(`  [${r.score.toFixed(4)}] ${r.denomination}`);
    });
});

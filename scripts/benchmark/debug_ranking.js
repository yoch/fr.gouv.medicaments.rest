const MiniSearch = require('minisearch');

const data = [
    { id: 1, denomination: 'SPASFON LYOC 160 mg, lyophilisat oral' },
    { id: 2, denomination: 'SPASFON LYOC 80 mg, lyophilisat oral' },
    { id: 3, denomination: 'SPASFON, comprimé enrobé' },
    { id: 4, denomination: 'SPASFON, solution injectable en ampoule' },
    { id: 5, denomination: 'CODOLIPRANE 500 mg/30 mg, comprimé' },
    { id: 6, denomination: 'DOLIPRANE 1000 mg, comprimé' },
    { id: 7, denomination: 'DOLIPRANE 500 mg, gélule' },
    { id: 8, denomination: 'COQUELUSEDAL PARACETAMOL 500 mg, suppositoire' },
    { id: 9, denomination: 'PARACETAMOL SANDOZ 1 g, comprimé' }, // Should this be before Coquelusedal? Probably.
];

const miniSearch = new MiniSearch({
    fields: ['denomination'],
    storeFields: ['denomination'],
    processTerm: (term) => term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    searchOptions: {
        processTerm: (term) => term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    }
});

miniSearch.addAll(data);

function test(query, label, options) {
    console.log(`\n--- Test: ${label} (Query: "${query}") ---`);
    const results = miniSearch.search(query, options);
    results.forEach(r => console.log(`[${r.score.toFixed(2)}] ${r.denomination}`));
}

// 1. Current configuration (hypothesized)
test('spasfon', 'Current Config (Prefix + Fuzzy)', { prefix: true, fuzzy: 0.2 });

// 2. Exact match boost attempt
// Strategy: combine exact match (high boost) with prefix/fuzzy (low boost)
test('spasfon', 'Boost Exact Match strategy', {
    combineWith: 'OR',
    queries: [
        { term: 'spasfon', boost: 10, fuzzy: false, prefix: false }, // Exact match
        { term: 'spasfon', boost: 1, fuzzy: 0.2, prefix: true }      // Broad match
    ]
});

test('doliprane', 'Current Config for Doliprane', { prefix: true, fuzzy: 0.2 });
test('doliprane', 'Boost Exact Match strategy', {
    combineWith: 'OR',
    queries: [
        { term: 'doliprane', boost: 10, fuzzy: false, prefix: false },
        { term: 'doliprane', boost: 1, fuzzy: 0.2, prefix: true }
    ]
});

test('paracetamol', 'Current Config for Paracetamol', { prefix: true, fuzzy: 0.2 });
test('paracetamol', 'Boost Exact Match strategy', {
    combineWith: 'OR',
    queries: [
        { term: 'paracetamol', boost: 10, fuzzy: false, prefix: false },
        { term: 'paracetamol', boost: 1, fuzzy: 0.2, prefix: true }
    ]
});

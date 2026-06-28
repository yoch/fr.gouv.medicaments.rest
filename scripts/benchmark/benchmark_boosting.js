const http = require('http');
const fs = require('fs');

const BASE_URL = 'http://localhost:8080/api/medicaments';
const SEARCH_BACKEND = process.env.SEARCH_BACKEND || 'minisearch';
const OUTPUT_FILE = process.env.BENCHMARK_OUTPUT || `benchmark_boosting_${SEARCH_BACKEND}.json`;

// Tests ciblés pour évaluer l'impact du boosting
const TEST_CASES = [
    {
        route: '/specialites',
        query: 'pfizer',
        description: 'Recherche par titulaire (devrait être moins prioritaire)'
    },
    {
        route: '/specialites',
        query: 'comprimé',
        description: 'Recherche par forme_pharma (devrait être moins prioritaire)'
    },
    {
        route: '/specialites',
        query: 'doliprane',
        description: 'Recherche par denomination (devrait rester prioritaire)'
    },
    {
        route: '/specialites',
        query: '61266250',
        description: 'Recherche par CIS (nouveau champ indexé)'
    },
    {
        route: '/presentations',
        query: 'migraine',
        description: 'Recherche par indication (nouveau champ indexé)'
    },
    {
        route: '/interet-therapeutique-majeur',
        query: 'N02BE01',
        description: 'Recherche par code ATC (nouveau champ indexé)'
    }
];

async function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function runBoostingBenchmark() {
    console.log('=== BENCHMARK APRÈS BOOSTING ===\n');
    const results = {};

    for (const testCase of TEST_CASES) {
        console.log(`\n📊 ${testCase.description}`);
        console.log(`Query: "${testCase.query}" sur ${testCase.route}\n`);

        try {
            const start = performance.now();
            const response = await fetchUrl(`${BASE_URL}${testCase.route}?q=${encodeURIComponent(testCase.query)}&limit=5`);
            const duration = performance.now() - start;

            const key = `${testCase.route}_${testCase.query}`;
            results[key] = {
                description: testCase.description,
                backend: SEARCH_BACKEND,
                duration_ms: duration,
                count: response.pagination ? response.pagination.total : response.data?.length || 0,
                top_results: response.data ? response.data.slice(0, 5).map(i => ({
                    name: i.denomination || i.libelle || i.texte_affichage || 'N/A',
                    cis: i.cis || 'N/A',
                    match_quality: i.match_quality || null,
                    forme: i.forme_pharma || 'N/A',
                    titulaire: i.titulaire || 'N/A',
                    code_atc: i.code_atc || undefined
                })) : []
            };

            console.log(`Résultats: ${results[key].count} total (${duration.toFixed(2)}ms)`);
            results[key].top_results.forEach((item, idx) => {
                console.log(`  ${idx + 1}. ${item.name}`);
                if (item.code_atc) console.log(`     Code ATC: ${item.code_atc}`);
            });
        } catch (e) {
            console.error(`Erreur: ${e.message}`);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n\n✅ Résultats sauvegardés dans ${OUTPUT_FILE}`);
}

runBoostingBenchmark();

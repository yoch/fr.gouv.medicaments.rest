const http = require('http');
const fs = require('fs');

const BASE_URL = 'http://localhost:8080/api/medicaments';
const SEARCH_BACKEND = process.env.SEARCH_BACKEND || 'minisearch';
const OUTPUT_FILE = process.env.BENCHMARK_OUTPUT || `benchmark_results_${SEARCH_BACKEND}.json`;
const TERMS = [
    'doliprane',
    'amoxicilline',
    'paracetamol',
    'paracétamol', // Accent test
    'efferalgan',
    'spasfon',
    'dolipranr',
    '60234100'
];

const ROUTES = [
    '/specialites',
    '/search' // Global search
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

async function runBenchmark() {
    const results = {};

    for (const term of TERMS) {
        results[term] = {};
        for (const route of ROUTES) {
            const start = performance.now();
            try {
                const response = await fetchUrl(`${BASE_URL}${route}?q=${encodeURIComponent(term)}&limit=5`);
                const duration = performance.now() - start;
                results[term][route] = {
                    backend: SEARCH_BACKEND,
                    duration_ms: duration,
                    count: response.pagination ? response.pagination.total : response.data.length,
                    top_results: response.data ? response.data.map(i => ({
                        label: i.denomination || i.libelle || i.nom || 'N/A',
                        cis: i.cis || null,
                        match_quality: i.match_quality || null
                    })).slice(0, 3) : []
                };
                console.log(`Fetched ${term} on ${route}: ${duration.toFixed(2)}ms`);
            } catch (e) {
                console.error(`Error fetching ${term} on ${route}:`, e.message);
            }
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

runBenchmark();

const http = require('http');
const fs = require('fs');

const BASE_URL = 'http://localhost:8080/api/medicaments';
const TERMS = [
    'doliprane',
    'amoxicilline',
    'paracetamol',
    'paracétamol', // Accent test
    'efferalgan',
    'spasfon'
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
                    duration_ms: duration,
                    count: response.pagination ? response.pagination.total : response.data.length,
                    top_results: response.data ? response.data.map(i => i.denomination || i.libelle || 'N/A').slice(0, 3) : []
                };
                console.log(`Fetched ${term} on ${route}: ${duration.toFixed(2)}ms`);
            } catch (e) {
                console.error(`Error fetching ${term} on ${route}:`, e.message);
            }
        }
    }

    fs.writeFileSync('benchmark_results_after.json', JSON.stringify(results, null, 2));
    console.log('Results saved to benchmark_results_after.json');
}

runBenchmark();

const http = require('http');

const BASE_URL = 'http://localhost:8080/api/medicaments';

// Tests pour analyser l'impact potentiel du boosting
const TEST_CASES = [
    {
        query: 'doliprane',
        description: 'Match exact dans denomination vs titulaire (SANOFI DOLIPRANE)'
    },
    {
        query: 'pfizer',
        description: 'Recherche par titulaire - devrait-il être moins prioritaire ?'
    },
    {
        query: 'comprimé',
        description: 'Recherche par forme_pharma - très générique'
    },
    {
        query: 'paracetamol arrow',
        description: 'Multi-termes: substance + titulaire'
    },
    {
        query: 'spasfon lyoc',
        description: 'Nom commercial + forme (lyophilisat)'
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

async function analyzeBoostingPotential() {
    console.log('=== ANALYSE DU POTENTIEL DE BOOSTING ===\n');

    for (const testCase of TEST_CASES) {
        console.log(`\n📊 Test: ${testCase.description}`);
        console.log(`Query: "${testCase.query}"\n`);

        try {
            const response = await fetchUrl(`${BASE_URL}/specialites?q=${encodeURIComponent(testCase.query)}&limit=5`);

            console.log(`Résultats (${response.pagination.total} total):`);
            response.data.forEach((item, idx) => {
                console.log(`  ${idx + 1}. ${item.denomination}`);
                console.log(`     Forme: ${item.forme_pharma || 'N/A'}`);
                console.log(`     Titulaire: ${item.titulaire || 'N/A'}`);
            });
        } catch (e) {
            console.error(`Erreur: ${e.message}`);
        }
    }

    console.log('\n\n=== ANALYSE TERMINÉE ===');
    console.log('\nQuestions à se poser:');
    console.log('1. Les matchs dans "denomination" sont-ils toujours plus pertinents ?');
    console.log('2. Les matchs dans "titulaire" polluent-ils les résultats ?');
    console.log('3. Les matchs dans "forme_pharma" sont-ils trop génériques ?');
}

analyzeBoostingPotential();

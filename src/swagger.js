const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'API Base de Données Publique des Médicaments',
            version: '1.0.0',
            description: 'API REST pour accéder aux données officielles des médicaments en France (BDPM).',
            contact: {
                name: 'Yoch Melka',
                url: 'https://github.com/yoch/fr.gouv.medicaments.rest'
            },
            license: {
                name: 'MIT',
                url: 'https://opensource.org/licenses/MIT'
            }
        },
        servers: [
            {
                url: 'https://bdpm.galiensante.fr/api',
                description: 'Serveur de production'
            }
        ],
        components: {
            schemas: {
                Medicament: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string', description: 'Code Identifiant de Spécialité' },
                        denomination: { type: 'string', description: 'Nom du médicament' },
                        forme_pharma: { type: 'string', description: 'Forme pharmaceutique' },
                        voies_admin: { type: 'string', description: 'Voies d\'administration' },
                        statut_amm: { type: 'string', description: 'Statut de l\'AMM' },
                        type_amm: { type: 'string', description: 'Type de procédure AMM' },
                        commercialisation: { type: 'string', description: 'État de commercialisation' },
                        date_amm: { type: 'string', description: 'Date d\'AMM' },
                        titulaire: { type: 'string', description: 'Titulaire de l\'AMM' },
                        surveillance_renforcee: { type: 'string', description: 'Surveillance renforcée' }
                    }
                },
                Presentation: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        cip7: { type: 'string', description: 'Code CIP7' },
                        libelle: { type: 'string', description: 'Libellé de la présentation' },
                        statut_admin: { type: 'string' },
                        etat_commercialisation: { type: 'string' },
                        date_declaration: { type: 'string' },
                        cip13: { type: 'string', description: 'Code CIP13' },
                        agrement_collectivite: { type: 'string' },
                        taux_remboursement: { type: 'string' },
                        prix_medicament: { type: 'string' },
                        prix_public: { type: 'string' },
                        honoraires: { type: 'string' },
                        indications: { type: 'string' }
                    }
                },
                AvisSMR: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        has_dossier: { type: 'string' },
                        motif_evaluation: { type: 'string' },
                        date_avis: { type: 'string' },
                        valeur_smr: { type: 'string' },
                        libelle_smr: { type: 'string' }
                    }
                },
                AvisASMR: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        has_dossier: { type: 'string' },
                        motif_evaluation: { type: 'string' },
                        date_avis: { type: 'string' },
                        valeur_asmr: { type: 'string' },
                        libelle_asmr: { type: 'string' }
                    }
                },
                GroupeGenerique: {
                    type: 'object',
                    properties: {
                        id_groupe: { type: 'string' },
                        libelle_groupe: { type: 'string' },
                        cis: { type: 'string' },
                        type_generique: { type: 'string' },
                        numero_ordre: { type: 'string' }
                    }
                },
                GroupeGeneriqueDetail: {
                    type: 'object',
                    properties: {
                        id_groupe: { type: 'string' },
                        libelle_groupe: { type: 'string' },
                        items: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/GroupeGenerique' }
                        }
                    }
                },
                Condition: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        condition: { type: 'string' }
                    }
                },
                Disponibilite: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        cip13: { type: 'string' },
                        code_statut: { type: 'string' },
                        libelle_statut: { type: 'string' },
                        date_debut: { type: 'string' },
                        date_mise_a_jour: { type: 'string' },
                        date_remise_dispo: { type: 'string' },
                        lien_ansm: { type: 'string' }
                    }
                },
                MITM: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        code_atc: { type: 'string' },
                        denomination: { type: 'string' },
                        lien_fi: { type: 'string' }
                    }
                },
                InfoImportante: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        date_debut: { type: 'string' },
                        date_fin: { type: 'string' },
                        texte_affichage: { type: 'string' }
                    }
                },
                Substance: {
                    type: 'object',
                    properties: {
                        code: { type: 'string' },
                        denomination: { type: 'string' },
                        medicaments_count: { type: 'integer' }
                    }
                },
                Composition: {
                    type: 'object',
                    properties: {
                        cis: { type: 'string' },
                        element_pharmaceutique: { type: 'string' },
                        code_substance: { type: 'string' },
                        denomination_substance: { type: 'string' },
                        dosage: { type: 'string' },
                        reference_dosage: { type: 'string' },
                        nature_composant: { type: 'string' }
                    }
                },
                Pagination: {
                    type: 'object',
                    properties: {
                        total: { type: 'integer' },
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                        pages: { type: 'integer' }
                    }
                },
                ApiResponse: {
                    type: 'object',
                    properties: {
                        data: {
                            type: 'array',
                            items: { type: 'object' }
                        },
                        pagination: { $ref: '#/components/schemas/Pagination' },
                        metadata: {
                            type: 'object',
                            properties: {
                                last_updated: { type: 'string', format: 'date-time' },
                                source: { type: 'string' }
                            }
                        }
                    }
                }
            }
        }
    },
    apis: ['./src/routes/*.js'], // Path to the API docs
};

const specs = swaggerJsdoc(options);
module.exports = specs;

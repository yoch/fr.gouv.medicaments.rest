'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');

const bdpmState = require('../src/services/bdpm/state');
const vetState = require('../src/services/vet/state');
const medicamentRoutes = require('../src/routes/medicaments');
const { executeHybridSearchPage } = require('../src/services/searchOrchestrator');
const {
  ROUNDING_TOLERANCE_RATIO,
  executeExperimentalSearchPage,
  evaluateEntityCriteria,
  matchFormeCriterion,
  matchVoieCriterion,
  detectTextDosageBasis,
  resolveCandidateDosageBasis,
  isNonComparableConcentrationBasis,
  hasConvertedConcentrationMatch
} = require('../src/search/experimentalSearch');
const { parseStructuredQuery } = require('../src/search/structuredQueryParser');
const { analyzeQuerySafetyAndIntent } = require('../src/search/queryIntentGuard');
const { parseDosageTokens } = require('../src/utils/structuredSearchCriteria');
const {
  parseReferenceBasis,
  getTaxonomyVocab,
  getConceptStore,
  hasTaxonomyCached,
  hasConceptStoreCached,
  warmExperimentalSearch,
  onCorpusCleared,
  onCorpusLoaded,
  resetConceptStoreCache
} = require('../src/search/conceptStore');
const { BDPM_INDEX_SPECS, VET_INDEX_SPECS } = require('../src/search/indexSpecs');
const { miniSearchIndexConfig } = require('../src/utils/miniSearchIndexConfig');
const { buildFrozenIndexFromRows } = require('../src/utils/frozenMiniSearch');
const { clearCorpus, buildKeyIndex, buildIndexDocument } = require('../src/utils/corpusStore');

function makeRow(obj) {
  return Object.assign(Object.create({
    toJSON() {
      return { ...this };
    }
  }), obj);
}

function seedSyntheticCorpora() {
  bdpmState.reset();
  vetState.reset();
  resetConceptStoreCache();
  for (const k of Object.keys(bdpmState.corpus)) clearCorpus(bdpmState.corpus[k]);
  for (const k of Object.keys(vetState.corpus)) clearCorpus(vetState.corpus[k]);

  const specialites = [
    makeRow({ cis: '60234100', denomination: 'DOLIPRANE 1000 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60234101', denomination: 'DOLIPRANE 1000 mg, comprimé effervescent sécable', forme_pharma: 'comprimé effervescent(e)', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60234102', denomination: 'DOLIPRANE 500 mg, gélule', forme_pharma: 'gélule', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60904643', denomination: 'CODOLIPRANE 500 mg/30 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '66053338', denomination: 'AUGMENTIN 1 g/125 mg ADULTES, poudre pour suspension buvable en sachet-dose', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'GSK' }),
    makeRow({ cis: '61111111', denomination: 'AMOXICILLINE BIOGARAN 1 g, comprimé dispersible', forme_pharma: 'comprimé dispersible', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'BIOGARAN' }),
    makeRow({ cis: '61111112', denomination: 'AMOXICILLINE SANDOZ 500 mg/5 ml, poudre pour suspension buvable', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SANDOZ' }),
    makeRow({ cis: '69999999', denomination: 'IBUPROFENE ARROW 400 mg, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '62222222', denomination: 'MAG 2 100 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'COOPER' }),
    makeRow({ cis: '63333333', denomination: 'HEXAMIDINE 0,1 POUR CENT, collyre en solution', forme_pharma: 'collyre en solution', voies_admin: 'ophtalmique', commercialisation: 'Commercialisée', titulaire: 'BIOCODEX' }),
    makeRow({ cis: '64444444', denomination: 'METHOTREXATE BELLON 2,5 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SANOFI' }),
    makeRow({ cis: '64444445', denomination: 'METOJECT 10 mg/0,4 ml, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'sous-cutanée', commercialisation: 'Commercialisée', titulaire: 'MEDAC' }),
    makeRow({ cis: '65555555', denomination: 'CERULYSE 5 POUR CENT, solution pour instillation auriculaire', forme_pharma: 'solution pour instillation auriculaire', voies_admin: 'auriculaire', commercialisation: 'Commercialisée', titulaire: 'CHAUVIN' }),
    makeRow({ cis: '66666666', denomination: 'ESOMEPRAZOLE ZENTIVA 40 mg, gélule gastro-résistante', forme_pharma: 'gélule gastro-résistante', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ZENTIVA' }),
    makeRow({ cis: '67777771', denomination: 'TAGAMET 200 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Non commercialisée', titulaire: 'GSK' }),
    makeRow({ cis: '67777772', denomination: 'CIMETIDINE EG 200 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'EG' }),
    makeRow({ cis: '68100001', denomination: 'KETOPROFENE BIOGARAN 2,5 %, gel', forme_pharma: 'gel', voies_admin: 'cutanée', commercialisation: 'Commercialisée', titulaire: 'BIOGARAN' }),
    makeRow({ cis: '68100002', denomination: 'KETOPROFENE SANDOZ 100 mg, gélule', forme_pharma: 'gélule', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SANDOZ' }),
    makeRow({ cis: '68100003', denomination: 'KETOPROFENE TEVA LP 200 mg, comprimé à libération prolongée', forme_pharma: 'comprimé à libération prolongée', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'TEVA' }),
    makeRow({ cis: '68200001', denomination: 'LIDOCAINE AGUETTANT 10 mg/ml, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'intratumorale', commercialisation: 'Commercialisée', titulaire: 'AGUETTANT' }),
    makeRow({ cis: '68200002', denomination: 'LIDOCAINE ZENTIVA 2 %, solution buccale', forme_pharma: 'solution buccale', voies_admin: 'cutanée;orale;sublinguale', commercialisation: 'Commercialisée', titulaire: 'ZENTIVA' }),
    makeRow({ cis: '68200003', denomination: 'LIDOCAINE RENAUDIN 5 mg/ml, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'sous-cutanée', commercialisation: 'Commercialisée', titulaire: 'RENAUDIN' }),
    makeRow({ cis: '68200004', denomination: 'LIDOCAINE BIOGARAN 5 %, gel', forme_pharma: 'gel', voies_admin: 'cutanée', commercialisation: 'Commercialisée', titulaire: 'BIOGARAN' }),
    makeRow({ cis: '68200005', denomination: 'LIDOCAINE PATCH ET GEL 5 %, dispositif', forme_pharma: 'patch et gel', voies_admin: 'cutanée', commercialisation: 'Commercialisée', titulaire: 'MEDA' }),
    makeRow({ cis: '67104999', denomination: 'VITAMINE B1 ARROW CONSEIL 250 mg, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '60565134', denomination: 'VITAMINE B1 B6 BAYER, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'BAYER' }),
    makeRow({ cis: '66742764', denomination: 'VITAMINE B6 ARROW CONSEIL 250 mg, comprimé quadrisécable', forme_pharma: 'comprimé quadrisécable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '69139714', denomination: 'VITAMINE PP AGUETTANT 500 mg/5 mL, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'intramusculaire;intraveineuse', commercialisation: 'Commercialisée', titulaire: 'AGUETTANT' }),
    makeRow({ cis: '63718901', denomination: 'HOMEOGENE 9, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale;sublinguale', commercialisation: 'Commercialisée', titulaire: 'BOIRON' }),
    makeRow({ cis: '61982231', denomination: 'HOMEOGENE 46, comprimé orodispersible', forme_pharma: 'comprimé orodispersible', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'BOIRON' }),
    makeRow({ cis: '69000020', denomination: 'HULIO 20 mg, solution injectable en seringue préremplie', forme_pharma: 'solution injectable', voies_admin: 'sous-cutanée', commercialisation: 'Commercialisée', titulaire: 'VIATRIS' }),
    makeRow({ cis: '69000040', denomination: 'HULIO 40 mg, solution injectable en seringue préremplie', forme_pharma: 'solution injectable', voies_admin: 'sous-cutanée', commercialisation: 'Commercialisée', titulaire: 'VIATRIS' }),
    makeRow({ cis: '69000005', denomination: 'ROSUVASTATINE ARROW 5 mg, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '69000010', denomination: 'ROSUVASTATINE ARROW 10 mg, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '69000101', denomination: 'DRILL SANS SUCRE ANIS MENTHE, pastille', forme_pharma: 'pastille', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'PIERRE FABRE' }),
    makeRow({ cis: '69000102', denomination: 'MAGNESIE SAN PELLEGRINO SANS ANIS 90 %, poudre pour suspension buvable', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SAN PELLEGRINO' }),
    makeRow({ cis: '69000103', denomination: 'MAGNESIE SAN PELLEGRINO ANISEE 90 %, poudre pour suspension buvable', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SAN PELLEGRINO' }),
    makeRow({ cis: '69000201', denomination: 'CHLORURE DE SODIUM LAVOISIER 0,9 %, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'intraveineuse', commercialisation: 'Commercialisée', titulaire: 'LAVOISIER' }),
    makeRow({ cis: '69000301', denomination: 'SULFATE DE MAGNESIUM RENAUDIN 15 %, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'intraveineuse', commercialisation: 'Commercialisée', titulaire: 'RENAUDIN' }),
    makeRow({ cis: '69000302', denomination: 'SOLUTION EXEMPLE 2 %, solution buvable', forme_pharma: 'solution buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'EXEMPLE' }),
    makeRow({ cis: '69000303', denomination: 'ALCOOL MODIFIE 70 % (v/v), solution pour application cutanée', forme_pharma: 'solution pour application cutanée', voies_admin: 'cutanée', commercialisation: 'Commercialisée', titulaire: 'COOPER' }),
    makeRow({ cis: '69000304', denomination: 'ECONAZOLE EXEMPLE 1 %, émulsion pour application cutanée', forme_pharma: 'émulsion pour application', voies_admin: 'cutanée', commercialisation: 'Commercialisée', titulaire: 'EXEMPLE' }),
    makeRow({ cis: '69000305', denomination: 'LIDOCAINE AMP 50 mg/5 ml, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'intraveineuse', commercialisation: 'Commercialisée', titulaire: 'AGUETTANT' })
  ];

  const presentations = [
    makeRow({ cis: '60234100', cip7: '3595583', cip13: '3400935955838', libelle: 'plaquette(s) PVC-Aluminium de 8 comprimé(s)', indications: '' }),
    makeRow({ cis: '65555555', cip7: '3019991', cip13: '3400930199916', libelle: '1 flacon(s) en verre jaune(brun) de 10 ml avec compte-gouttes', indications: '' }),
    makeRow({ cis: '69000301', cip7: '3099001', cip13: '3400930990018', libelle: '10 ampoule(s) en verre de 10 ml', indications: '' }),
    makeRow({ cis: '69000305', cip7: '3099005', cip13: '3400930990056', libelle: '10 ampoule(s) en verre de 5 ml', indications: '' })
  ];

  const compositions = [
    makeRow({ cis: '60234100', designation_element: 'comprimé', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '1000 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60234102', designation_element: 'gélule', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '74765', denomination_substance: 'PHOSPHATE DE CODÉINE', dosage: '30 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '05248', denomination_substance: 'AMOXICILLINE ANHYDRE', dosage: '1000 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '29442', denomination_substance: 'CLAVULANATE DE POTASSIUM', dosage: '', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '93286', denomination_substance: 'ACIDE CLAVULANIQUE', dosage: '125,00 mg', nature_composant: 'FT', numero_ordre: '2' }),
    makeRow({ cis: '61111111', designation_element: 'comprimé', code_substance: '05248', denomination_substance: 'AMOXICILLINE ANHYDRE', dosage: '1000 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '61111111', designation_element: 'comprimé', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61111112', designation_element: 'poudre', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '500 mg/5 ml', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69999999', designation_element: 'comprimé', code_substance: '01234', denomination_substance: 'IBUPROFÈNE', dosage: '400 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '64444444', designation_element: 'comprimé', code_substance: '03333', denomination_substance: 'MÉTHOTREXATE', dosage: '2,5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '66666666', designation_element: 'gélule', code_substance: '17407', denomination_substance: 'ÉSOMÉPRAZOLE', dosage: '40 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '66666666', designation_element: 'gélule', code_substance: '61112', denomination_substance: 'ÉSOMÉPRAZOLE MAGNÉSIQUE TRIHYDRATÉ', dosage: '44,5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '67777771', designation_element: 'comprimé', code_substance: '04444', denomination_substance: 'CIMÉTIDINE', dosage: '200 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '67777772', designation_element: 'comprimé', code_substance: '04444', denomination_substance: 'CIMÉTIDINE', dosage: '200 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68100001', designation_element: 'gel', code_substance: '05551', denomination_substance: 'KÉTOPROFÈNE', dosage: '2,5 %', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68100002', designation_element: 'gélule', code_substance: '05551', denomination_substance: 'KÉTOPROFÈNE', dosage: '100 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68100003', designation_element: 'comprimé', code_substance: '05551', denomination_substance: 'KÉTOPROFÈNE', dosage: '200 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68200001', designation_element: 'solution', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '10 mg/ml', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68200002', designation_element: 'solution', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '2 %', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68200003', designation_element: 'solution', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '5 mg/ml', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68200004', designation_element: 'gel', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '5 %', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '68200005', designation_element: 'patch', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '5 %', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '67104999', designation_element: 'comprimé', code_substance: '07001', denomination_substance: 'CHLORHYDRATE DE THIAMINE', dosage: '250 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60565134', designation_element: 'comprimé', code_substance: '07001', denomination_substance: 'CHLORHYDRATE DE THIAMINE', dosage: '250 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60565134', designation_element: 'comprimé', code_substance: '07002', denomination_substance: 'CHLORHYDRATE DE PYRIDOXINE', dosage: '250 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '66742764', designation_element: 'comprimé', code_substance: '07002', denomination_substance: 'CHLORHYDRATE DE PYRIDOXINE', dosage: '250 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69139714', designation_element: 'solution', code_substance: '07003', denomination_substance: 'NICOTINAMIDE', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000020', designation_element: 'solution', code_substance: '07010', denomination_substance: 'ADALIMUMAB', dosage: '20 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000040', designation_element: 'solution', code_substance: '07010', denomination_substance: 'ADALIMUMAB', dosage: '40 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000005', designation_element: 'comprimé', code_substance: '07020', denomination_substance: 'ROSUVASTATINE', dosage: '5 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '69000010', designation_element: 'comprimé', code_substance: '07020', denomination_substance: 'ROSUVASTATINE', dosage: '10 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '69000201', designation_element: 'solution', code_substance: '07030', denomination_substance: 'CHLORURE DE SODIUM', dosage: '0,9 g', reference_dosage: '100 ml de solution', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000301', designation_element: 'solution', code_substance: '07040', denomination_substance: 'SULFATE DE MAGNÉSIUM HEPTAHYDRATÉ', dosage: '0,15 g', reference_dosage: '1 ml de solution', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000302', designation_element: 'solution', code_substance: '07050', denomination_substance: 'SUBSTANCE EXEMPLE', dosage: '2 %', reference_dosage: '', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000303', designation_element: 'solution', code_substance: '07060', denomination_substance: 'ÉTHANOL', dosage: '70 ml', reference_dosage: '100 ml', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000304', designation_element: 'émulsion', code_substance: '07070', denomination_substance: 'NITRATE D’ÉCONAZOLE', dosage: '1 g', reference_dosage: '100 g d’émulsion', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69000305', designation_element: 'solution', code_substance: '05552', denomination_substance: 'LIDOCAÏNE', dosage: '50 mg', reference_dosage: '5 ml de solution', nature_composant: 'SA', numero_ordre: '1' })
  ];

  const generiques = [
    makeRow({ id_groupe: '900', libelle_groupe: 'CIMÉTIDINE 200 mg - TAGAMET 200 mg', cis: '67777771', type_generique: '0', numero_ordre: '1' }),
    makeRow({ id_groupe: '900', libelle_groupe: 'CIMÉTIDINE 200 mg - TAGAMET 200 mg', cis: '67777772', type_generique: '1', numero_ordre: '2' })
  ];

  const mitm = [
    makeRow({ cis: '64444444', code_atc: 'L01BA01', denomination: 'METHOTREXATE BELLON 2,5 mg', lien_fi: '' })
  ];

  bdpmState.corpus.specialites.push(...specialites);
  bdpmState.corpus.presentations.push(...presentations);
  bdpmState.corpus.compositions.push(...compositions);
  bdpmState.corpus.generiques.push(...generiques);
  bdpmState.corpus.mitm.push(...mitm);

  for (const type of ['specialites', 'presentations', 'compositions', 'generiques', 'mitm']) {
    const spec = BDPM_INDEX_SPECS[type];
    bdpmState.searchIndexes[type] = buildFrozenIndexFromRows(
      bdpmState.corpus[type],
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
  }
  bdpmState.cisIndexes = {
    specialitesByCis: buildKeyIndex(bdpmState.corpus.specialites, 'cis', { unique: true }),
    presentationsByCis: buildKeyIndex(bdpmState.corpus.presentations, 'cis'),
    compositionsByCis: buildKeyIndex(bdpmState.corpus.compositions, 'cis'),
    avisSmrByCis: new Map(),
    avisAsmrByCis: new Map(),
    conditionsByCis: new Map(),
    generiquesByCis: buildKeyIndex(bdpmState.corpus.generiques, 'cis'),
    generiquesByGroupe: buildKeyIndex(bdpmState.corpus.generiques, 'id_groupe'),
    rupturesByCis: new Map()
  };

  // Corpus vétérinaire synthétique (méloxicam humain vs METACAM chien)
  const vetMeds = [
    makeRow({ num: '0000101', nom: 'METACAM 1,5 MG/ML SUSPENSION BUVABLE POUR CHIENS', forme_pharmaceutique: 'Suspension buvable', statut_amm: 'Autorisation active', codes_atcvet: ['QM01AC06'], especes: ['Chien'] })
  ];
  const vetComps = [
    makeRow({ num: '0000101', substance: 'Méloxicam', quantite: '1.5', unite: 'mg/ml' })
  ];
  bdpmState.corpus.specialites.push(
    makeRow({ cis: '68888888', denomination: 'MELOXICAM TEVA 15 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'TEVA' })
  );
  // Re-index bdpm specialites after adding MELOXICAM TEVA
  {
    const spec = BDPM_INDEX_SPECS.specialites;
    bdpmState.searchIndexes.specialites = buildFrozenIndexFromRows(
      bdpmState.corpus.specialites,
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
    bdpmState.cisIndexes.specialitesByCis = buildKeyIndex(bdpmState.corpus.specialites, 'cis', { unique: true });
  }

  vetState.corpus.medicaments.push(...vetMeds);
  vetState.corpus.compositions.push(...vetComps);
  for (const type of ['medicaments', 'compositions']) {
    const spec = VET_INDEX_SPECS[type];
    vetState.searchIndexes[type] = buildFrozenIndexFromRows(
      vetState.corpus[type],
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
  }
  vetState.numIndexes = {
    medicamentsByNum: buildKeyIndex(vetState.corpus.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(vetState.corpus.compositions, 'num'),
    presentationsByNum: new Map()
  };
}

describe('structuredQueryParser & experimentalSearch (B1/B2)', () => {
  beforeAll(() => {
    seedSyntheticCorpora();
  });

  afterAll(() => {
    bdpmState.reset();
    vetState.reset();
    resetConceptStoreCache();
    for (const k of Object.keys(bdpmState.corpus)) clearCorpus(bdpmState.corpus[k]);
    for (const k of Object.keys(vetState.corpus)) clearCorpus(vetState.corpus[k]);
  });

  describe('parseStructuredQuery invariants', () => {
    it('préserve les chiffres de marque sans unité (MAG 2 100 mg, VITAMINE D3)', () => {
      const mag = parseStructuredQuery('MAG 2 100 mg');
      expect(mag.nameQuery).toBe('mag 2');
      expect(mag.effectiveCriteria.dosage).toBe('100 mg');

      const vit = parseStructuredQuery('VITAMINE D3 100 000 UI');
      expect(vit.nameQuery).toBe('vitamine d3');
      expect(vit.effectiveCriteria.dosage).toBe('100000 ui');
    });

    it('détache les dosages collés sans toucher aux concentrations non unitaires', () => {
      const esom = parseStructuredQuery('esoméprazole40mg');
      expect(esom.nameQuery).toBe('esomeprazole');
      expect(esom.effectiveCriteria.dosage).toBe('40 mg');

      const conc = parseStructuredQuery('metoject 10 mg/0,4 ml');
      expect(conc.effectiveCriteria.dosage).toBe('10 mg/0.4 ml');
      expect(conc.nameQuery).toBe('metoject');
    });

    it('route les codes numériques et ATC sans altération', () => {
      const cis = parseStructuredQuery('60234100');
      expect(cis.kind).toBe('exact_code');
      expect(cis.code).toEqual({ kind: 'numeric_code', code: '60234100' });

      const atc = parseStructuredQuery('L01BA01');
      expect(atc.kind).toBe('exact_code');
      expect(atc.code).toEqual({ kind: 'atc_code', code: 'L01BA01' });
    });

    it('donne la priorité aux paramètres explicites et signale les conflits', () => {
      const parsed = parseStructuredQuery('Doliprane 1 g comprimé', {
        dosage: '500 mg',
        forme: 'gélule'
      }, getConceptStore().taxonomy);
      expect(parsed.effectiveCriteria.dosage).toBe('500 mg');
      expect(parsed.effectiveCriteria.forme).toBe('gélule');
      expect(parsed.conflicts).toHaveLength(2);
    });

    it('n active les alias galéniques qu en mode B2 (useAliases=true)', () => {
      const b1 = parseStructuredQuery('méthotrexate per os', {}, null, { useAliases: false });
      expect(b1.effectiveCriteria.voie).toBeNull();
      expect(b1.nameQuery).toBe('methotrexate per os');

      const b2 = parseStructuredQuery('méthotrexate per os', {}, null, { useAliases: true });
      expect(b2.effectiveCriteria.voie).toBe('orale');
      expect(b2.nameQuery).toBe('methotrexate');

      const oosClinical = parseStructuredQuery('quel sirop contre toux seche', {}, null, { useAliases: true });
      expect(oosClinical.nameQuery).toContain('quel');
      expect(oosClinical.nameQuery).toContain('contre');

      const weight = parseStructuredQuery('douleur adulte 70 kg', {}, null, { useAliases: true });
      expect(weight.effectiveCriteria.dosage).toBeNull();
      expect(weight.nameQuery).toContain('70');
      expect(weight.nameQuery).toContain('kg');

      const concKg = parseStructuredQuery('amoxicilline 12,5 mg/kg', {}, null, { useAliases: true });
      expect(concKg.effectiveCriteria.dosage).toBe('12.5 mg/kg');
    });

    it('détecte négations, multi-exclusions, poids patient et propriétés RCP (A1)', () => {
      const n1 = executeExperimentalSearchPage('sans acide acétylsalicylique', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n1.total).toBe(0);
      expect(n1.search.abstained).toBe(true);
      expect(n1.search.safety.negation.excluded).toEqual(['acide acetylsalicylique']);

      const n2 = executeExperimentalSearchPage('sans paracétamol ni ibuprofène', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n2.total).toBe(0);
      expect(n2.search.abstained).toBe(true);
      expect(n2.search.safety.negation.excluded).toEqual(['paracetamol', 'ibuprofene']);

      const n3 = executeExperimentalSearchPage('pas de paracétamol', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n3.total).toBe(0);
      expect(n3.search.abstained).toBe(true);
      expect(n3.search.safety.negation.excluded).toEqual(['paracetamol']);

      const w = executeExperimentalSearchPage('douleur adulte 70 kg', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(w.search.parsed.dosage).toBeNull();
      expect(w.search.parsed.patient_weight).toBe('70 kg');
      expect(w.search.parsed.pediatric_inferred).toBe(false);

      const gPos = executeExperimentalSearchPage('médicaments contre-indiqués pendant la grossesse', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gPos.total).toBe(0);
      expect(gPos.search.abstained).toBe(true);
      expect(gPos.search.safety.clinical_property.polarity).toBe('contraindication');

      const gNeg = executeExperimentalSearchPage('non contre-indiqué pendant la grossesse', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gNeg.total).toBe(0);
      expect(gNeg.search.abstained).toBe(true);
      expect(gNeg.search.safety.clinical_property.polarity).toBe('negated_contraindication');

      const mix = executeExperimentalSearchPage('sans conservateur ni paraben', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(mix.total).toBe(0);
      expect(mix.search.abstained).toBe(true);
      expect(mix.search.parsed.verbatim_qualifiers).toEqual(['sans conservateur']);
      expect(mix.search.safety.negation.excluded).toEqual(['paraben']);

      const okQual = executeExperimentalSearchPage('sans sucre', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(okQual.search.abstained).toBe(false);
      expect(okQual.search.parsed.verbatim_qualifiers).toEqual(['sans sucre']);
    });
  });

  describe('executeExperimentalSearchPage (B1 structured vs B2 concepts)', () => {
    it('retrouve Doliprane 1 g comprimé, esoméprazole 40mg, Hexamidine collyre dès B1', () => {
      const doli = executeExperimentalSearchPage('Doliprane 1 g comprimé', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(doli.results[0].cis).toBe('60234100');
      expect(doli.results[0].criteria_match).toEqual({ dosage: true, forme: true, voie: false });

      const esom = executeExperimentalSearchPage('esoméprazole 40mg', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(esom.results[0].cis).toBe('66666666');

      const hex = executeExperimentalSearchPage('Hexamidine collyre', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(hex.results[0].cis).toBe('63333333');
    });

    it('gère per os, spray, multi-substances SA/FT, générique et vet chien en mode concepts (B2)', () => {
      const mtx = executeExperimentalSearchPage('méthotrexate per os', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(mtx.results[0].cis).toBe('64444444');

      const cerulyse = executeExperimentalSearchPage('Cerulyse spray', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(cerulyse.results[0].cis).toBe('65555555');

      const augmentin = executeExperimentalSearchPage('amoxicilline acide clavulanique 1 g', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(augmentin.results[0].cis).toBe('66053338');

      const genTagamet = executeExperimentalSearchPage('générique tagamet', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(genTagamet.results[0].cis).toBe('67777772');

      const vetMelox = executeExperimentalSearchPage('meloxicam chien', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(vetMelox.results[0].type).toBe('medicament_veterinaire');
      expect(vetMelox.results[0].num).toBe('0000101');
    });

    it('préfère la mono-substance à dosage identique sur paracetamol 500 mg (B2)', () => {
      const res = executeExperimentalSearchPage('paracetamol 500 mg', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(res.results[0].cis).toBe('60234102');
    });

    it('ne retourne jamais de faux positif exact sur code inexistant ni de faux dosage sur impossible', () => {
      const missingCis = executeExperimentalSearchPage('99999999', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(missingCis.total).toBe(0);

      const impossibleDose = executeExperimentalSearchPage('doliprane 5000 mg', 'auto', 1, 5, {}, { mode: 'concepts' });
      if (impossibleDose.results.length > 0) {
        expect(impossibleDose.results[0].criteria_match.dosage).toBe(false);
      }
    });
  });

  describe('HTTP route opt-in /api/medicaments/search', () => {
    const app = express();
    app.use('/api/medicaments', medicamentRoutes);

    it('laisse le comportement par défaut (B0) intact et active mode=structured|concepts sur opt-in', async () => {
      const b0ViaHttp = await request(app).get('/api/medicaments/search?q=Doliprane%201%20g%20comprim%C3%A9');
      expect(b0ViaHttp.statusCode).toBe(200);
      expect(b0ViaHttp.body.search.mode).toBeUndefined();
      const b0Direct = executeHybridSearchPage('Doliprane 1 g comprimé', undefined, 1, 50, {});
      expect(b0ViaHttp.body.pagination.total).toBe(b0Direct.total);

      const b2ViaHttp = await request(app).get('/api/medicaments/search?q=Cerulyse%20spray&mode=concepts');
      expect(b2ViaHttp.statusCode).toBe(200);
      expect(b2ViaHttp.body.search.mode).toBe('concepts');
      expect(b2ViaHttp.body.data[0].cis).toBe('65555555');

      const badMode = await request(app).get('/api/medicaments/search?q=doliprane&mode=unknown');
      expect(badMode.statusCode).toBe(400);
    });

    it('§1 : applique la précédence stricte de forme=comprimé sur "amoxicilline sirop" sans fuite d’altFormeTokens', async () => {
      const parsed = parseStructuredQuery('amoxicilline sirop', { forme: 'comprimé' }, getTaxonomyVocab(), { useAliases: true });
      expect(parsed.effectiveCriteria.forme).toBe('comprimé');
      expect(parsed.effectiveCriteria.altFormeTokens).toEqual([]);
      expect(parsed.conflicts).toEqual([{ field: 'forme', explicit: 'comprimé', parsed: 'sirop' }]);

      const resp = await request(app).get('/api/medicaments/search?q=amoxicilline%20sirop&forme=comprim%C3%A9&mode=concepts');
      expect(resp.statusCode).toBe(200);
      expect(resp.body.data[0].cis).toBe('61111111');
      expect(resp.body.data[0].criteria_match).toEqual({ dosage: false, forme: true, voie: false });
      expect(resp.body.data[0].criteria_status).toEqual({
        dosage: 'not_requested',
        forme: 'matched',
        voie: 'not_requested'
      });

      const susp = resp.body.data.find((d) => d.cis === '61111112');
      expect(susp).toBeDefined();
      expect(susp.criteria_match.forme).toBe(false);
      expect(susp.criteria_status.forme).toBe('contradicted');
    });

    it('§1 : distingue correspondance exacte vs expansion de rappel (spray/collyre/partial) et vérifie evaluateEntityCriteria', async () => {
      const resp = await request(app).get('/api/medicaments/search?q=Cerulyse%20spray&mode=concepts&detail=summary');
      expect(resp.statusCode).toBe(200);
      expect(resp.body.data[0].cis).toBe('65555555');
      expect(resp.body.data[0].criteria_match.forme).toBe(false);
      expect(resp.body.data[0].criteria_status.forme).toBe('expanded');

      const ophtParsed = parseStructuredQuery('collyre yeux', {}, getTaxonomyVocab(), { useAliases: true });
      const ophtNoVoie = evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'collyre en solution', normVoie: '', normPresText: '', normDenom: 'collyre' },
        ophtParsed,
        { useAliases: true }
      );
      expect(ophtNoVoie.criteria_match.voie).toBe(false);
      expect(ophtNoVoie.criteria_status.voie).toBe('expanded');
    });

    it('§1 : rejette/marque unsupported sur voie="non orale" et étend le garde-fou grossesse/compatibilité via HTTP', async () => {
      const parsedNeg = parseStructuredQuery('amoxicilline', { voie: 'non orale' }, getTaxonomyVocab(), { useAliases: true });
      const directEval = evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'comprime', normVoie: 'orale', normPresText: '', normDenom: 'amoxicilline' },
        parsedNeg,
        { useAliases: true }
      );
      expect(directEval.criteria_match.voie).toBe(false);
      expect(directEval.criteria_status.voie).toBe('unsupported');

      for (const m of ['structured', 'concepts']) {
        const resNegVoie = await request(app).get(`/api/medicaments/search?q=amoxicilline&voie=non%20orale&mode=${m}`);
        expect(resNegVoie.statusCode).toBe(200);
        expect(resNegVoie.body.pagination.total).toBe(0);
        expect(resNegVoie.body.data).toEqual([]);
        expect(resNegVoie.body.search.abstained).toBe(true);
        expect(resNegVoie.body.search.safety.supported).toBe(false);
        expect(resNegVoie.body.search.safety.unsupported_criteria).toHaveLength(1);
        expect(resNegVoie.body.search.safety.unsupported_criteria[0].field).toBe('voie');
      }

      for (const query of ['ibuprofene compatible grossesse', 'ibuprofene enceinte', 'paracetamol allaitement']) {
        const resClin = await request(app).get(`/api/medicaments/search?q=${encodeURIComponent(query)}&mode=concepts`);
        expect(resClin.statusCode).toBe(200);
        expect(resClin.body.pagination.total).toBe(0);
        expect(resClin.body.search.abstained).toBe(true);
        expect(resClin.body.search.safety.clinical_property.detected).toBe(true);
      }
    });

    it('§5 : ne matérialise pas ConceptStore sur mode=structured ni sur requêtes rejetées / codes numériques, mais invalide après rechargement', () => {
      resetConceptStoreCache();
      expect(hasConceptStoreCached()).toBe(false);

      const b1 = executeExperimentalSearchPage('Doliprane 1 g comprimé', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(b1.results[0].cis).toBe('60234100');
      expect(b1.results[0].criteria_status.dosage).toBe('matched');
      expect(hasConceptStoreCached()).toBe(false);

      const rejected = executeExperimentalSearchPage('ibuprofene enceinte', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(rejected.search.abstained).toBe(true);
      expect(hasConceptStoreCached()).toBe(false);

      const numCode = executeExperimentalSearchPage('60234100', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(numCode.results[0].cis).toBe('60234100');
      expect(hasConceptStoreCached()).toBe(false);

      const gen = executeExperimentalSearchPage('générique tagamet', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gen.results[0].cis).toBe('67777772');
      expect(hasConceptStoreCached()).toBe(true);

      const store1 = getConceptStore();
      bdpmState.cisIndexes = { ...bdpmState.cisIndexes };
      const store2 = getConceptStore();
      expect(store2).not.toBe(store1);
    });

    it('P1 unité + HTTP route->parse->ranking->JSON : évite faux positifs sous-chaîne sur forme/voie et gère voies multivaluées', async () => {
      // 1. Unitaires evaluateEntityCriteria : positif & négatif (useAliases false/true)
      for (const useAliases of [false, true]) {
        const pGel = parseStructuredQuery('ketoprofene', { forme: 'gel' }, getTaxonomyVocab(), { useAliases });
        const evGel = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'gel', normVoie: 'cutanee', normPresText: '', normDenom: 'ketoprofene' },
          pGel,
          { useAliases }
        );
        expect(evGel.criteria_match.forme).toBe(true);
        expect(evGel.criteria_status.forme).toBe('matched');

        const evGelule = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'gelule', normVoie: 'orale', normPresText: '', normDenom: 'ketoprofene' },
          pGel,
          { useAliases }
        );
        expect(evGelule.criteria_match.forme).toBe(false);
        expect(evGelule.criteria_status.forme).toBe('contradicted');

        const pSolInj = parseStructuredQuery('lidocaine', { forme: 'solution injectable' }, getTaxonomyVocab(), { useAliases });
        const evSolBuv = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'solution buvable', normVoie: 'orale', normPresText: '', normDenom: 'lidocaine' },
          pSolInj,
          { useAliases }
        );
        expect(evSolBuv.criteria_match.forme).toBe(false);
        expect(evSolBuv.criteria_status.forme).toBe('contradicted');

        const pComprime = parseStructuredQuery('doliprane', { forme: 'comprime' }, getTaxonomyVocab(), { useAliases });
        const evCompresse = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'compresse', normVoie: 'cutanee', normPresText: '', normDenom: 'compresse' },
          pComprime,
          { useAliases }
        );
        expect(evCompresse.criteria_match.forme).toBe(false);
        expect(evCompresse.criteria_status.forme).toBe('contradicted');

        // Formes composées ('patch et gel' ; 'comprime a sucer ou a croquer')
        const evPatchEtGel = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'patch et gel', normVoie: 'cutanee', normPresText: '', normDenom: 'lidocaine' },
          pGel,
          { useAliases }
        );
        expect(evPatchEtGel.criteria_match.forme).toBe(true);
        expect(evPatchEtGel.criteria_status.forme).toBe('matched');

        const pSucer = parseStructuredQuery('pastille', { forme: 'comprime a sucer' }, getTaxonomyVocab(), { useAliases });
        const evSucerOuCroquer = evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'comprime a sucer ou a croquer', normVoie: 'orale', normPresText: '', normDenom: 'pastille' },
          pSucer,
          { useAliases }
        );
        expect(evSucerOuCroquer.criteria_match.forme).toBe(true);
        expect(evSucerOuCroquer.criteria_status.forme).toBe('matched');

        // Voies : sous-chaîne interdite (orale != intratumorale, cutanee != sous-cutanee), multivalué matched
        const pOrale = parseStructuredQuery('lidocaine', { voie: 'orale' }, getTaxonomyVocab(), { useAliases });
        expect(evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'solution injectable', normVoie: 'intratumorale', normPresText: '', normDenom: 'lidocaine' },
          pOrale,
          { useAliases }
        )).toMatchObject({ criteria_match: { voie: false }, criteria_status: { voie: 'contradicted' } });

        expect(evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'solution buccale', normVoie: 'cutanee;orale;sublinguale', normPresText: '', normDenom: 'lidocaine' },
          pOrale,
          { useAliases }
        )).toMatchObject({ criteria_match: { voie: true }, criteria_status: { voie: 'matched' } });

        const pCutanee = parseStructuredQuery('lidocaine', { voie: 'cutanée' }, getTaxonomyVocab(), { useAliases });
        expect(evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'solution injectable', normVoie: 'sous-cutanee', normPresText: '', normDenom: 'lidocaine' },
          pCutanee,
          { useAliases }
        )).toMatchObject({ criteria_match: { voie: false }, criteria_status: { voie: 'contradicted' } });

        const pSousCutanee = parseStructuredQuery('lidocaine', { voie: 'sous-cutanée' }, getTaxonomyVocab(), { useAliases });
        expect(evaluateEntityCriteria(
          { denomDosages: [], compoDosages: [], normForme: 'solution injectable', normVoie: 'sous-cutanee', normPresText: '', normDenom: 'lidocaine' },
          pSousCutanee,
          { useAliases }
        )).toMatchObject({ criteria_match: { voie: true }, criteria_status: { voie: 'matched' } });
      }

      // Précédence explicite supprime altFormes implicites et tranche en faveur du paramètre explicite
      const overriddenForme = parseStructuredQuery('ketoprofene gelule', { forme: 'gel' }, getTaxonomyVocab(), { useAliases: true });
      expect(overriddenForme.conflicts.some((c) => c.field === 'forme')).toBe(true);
      expect(evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'gelule', normVoie: 'orale', normPresText: '', normDenom: 'ketoprofene' },
        overriddenForme,
        { useAliases: true }
      )).toMatchObject({ criteria_match: { forme: false }, criteria_status: { forme: 'contradicted' } });

      // 2. Chaîne complète HTTP route -> parser -> ranking -> JSON (detail=full & detail=summary, B1 & B2)
      for (const [mode, detail] of [['concepts', 'full'], ['structured', 'summary']]) {
        const resGel = await request(app).get(`/api/medicaments/search?q=ketoprofene&forme=gel&mode=${mode}&detail=${detail}`);
        expect(resGel.statusCode).toBe(200);
        expect(resGel.body.data.length).toBeGreaterThanOrEqual(2);
        expect(resGel.body.data[0].cis).toBe('68100001');
        expect(resGel.body.data[0].criteria_match).toEqual({ dosage: false, forme: true, voie: false });
        expect(resGel.body.data[0].criteria_status.forme).toBe('matched');
        if (detail === 'full') {
          expect(Array.isArray(resGel.body.data[0].compositions)).toBe(true);
        } else {
          expect(resGel.body.data[0].compositions).toBeUndefined();
        }
        const geluleHit = resGel.body.data.find((d) => d.cis === '68100002');
        expect(geluleHit).toBeDefined();
        expect(geluleHit.criteria_match.forme).toBe(false);
        expect(geluleHit.criteria_status.forme).toBe('contradicted');

        const resOrale = await request(app).get(`/api/medicaments/search?q=lidocaine&voie=orale&mode=${mode}&detail=${detail}`);
        expect(resOrale.statusCode).toBe(200);
        expect(resOrale.body.data[0].cis).toBe('68200002');
        expect(resOrale.body.data[0].criteria_match.voie).toBe(true);
        expect(resOrale.body.data[0].criteria_status.voie).toBe('matched');
        const intraHit = resOrale.body.data.find((d) => d.cis === '68200001');
        expect(intraHit).toBeDefined();
        expect(intraHit.criteria_match.voie).toBe(false);
        expect(intraHit.criteria_status.voie).toBe('contradicted');

        const resCut = await request(app).get(`/api/medicaments/search?q=lidocaine&voie=cutan%C3%A9e&mode=${mode}&detail=${detail}`);
        expect(resCut.statusCode).toBe(200);
        expect(['68200004', '68200005']).toContain(resCut.body.data[0].cis);
        expect(resCut.body.data[0].criteria_match.voie).toBe(true);
        expect(resCut.body.data[0].criteria_status.voie).toBe('matched');
        const scHit = resCut.body.data.find((d) => d.cis === '68200003');
        expect(scHit).toBeDefined();
        expect(scHit.criteria_match.voie).toBe(false);
        expect(scHit.criteria_status.voie).toBe('contradicted');
      }

      // 3. Non-régression B0 explicite sur la même route sans opt-in mode
      const b0Gel = await request(app).get('/api/medicaments/search?q=ketoprofene&forme=gel');
      expect(b0Gel.statusCode).toBe(200);
      expect(b0Gel.body.search.mode).toBeUndefined();
      expect(b0Gel.body.data[0].criteria_status).toBeUndefined();
    });

    it('Calibration B2 : qualifiants "sans arome/sulfites/anis", conversion concentration (g/ml <-> mg/ml <-> %) et forme+voie combinées', () => {
      for (const q of ['movicol sans arome', 'xylocaine sans conservateur', 'lidocaine sans sulfites', 'granules sans anis']) {
        const parsed = parseStructuredQuery(q, {}, getTaxonomyVocab(), { useAliases: true });
        const safety = analyzeQuerySafetyAndIntent(q, parsed, {});
        expect(safety.supported).toBe(true);
        expect(safety.negation.detected).toBe(false);
        expect(safety.verbatimQualifiers.length).toBeGreaterThanOrEqual(1);
      }

      // Forme 'émulsion cutanée' satisfaite par forme='émulsion pour application' + voie='cutanée' en mode concepts
      const pEmul = parseStructuredQuery('econazole', { forme: 'émulsion cutanée' }, getTaxonomyVocab(), { useAliases: true });
      const evEmul = evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'emulsion pour application', normVoie: 'cutanee', normPresText: '', normDenom: 'econazole' },
        pEmul,
        { useAliases: true }
      );
      expect(evEmul.criteria_match.forme).toBe(true);
      expect(evEmul.criteria_status.forme).toBe('matched');

      // Conversion de concentration en mode concepts : 1.5g/10ml <-> 150 mg/ml et 15 % ; 0.2 % <-> 2 mg/ml
      const pMag = parseStructuredQuery('magnesium sulfate', { dosage: '1.5g/10ml', forme: 'solution injectable' }, getTaxonomyVocab(), { useAliases: true });
      const evMag150 = evaluateEntityCriteria(
        {
          denomDosages: parseDosageTokens('SULFATE DE MAGNESIUM 150 mg/ml'),
          compoDosages: [],
          normForme: 'solution injectable',
          normVoie: 'intraveineuse',
          normPresText: '',
          normDenom: 'sulfate de magnesium 150 mg ml'
        },
        pMag,
        { useAliases: true }
      );
      expect(evMag150.criteria_status.dosage).toBe('expanded');

      const evMag15Pct = evaluateEntityCriteria(
        {
          denomination: 'SULFATE DE MAGNESIUM 15 % (0,15 g/ml)',
          denomDosages: parseDosageTokens('SULFATE DE MAGNESIUM 15 % (0,15 g/ml)'),
          compoDosages: [],
          compoConcentrationBasis: 'mass_volume',
          compoConcMgMl: 150,
          presVolumesMl: [10],
          normForme: 'solution injectable',
          normVoie: 'intraveineuse',
          normPresText: '10 ampoules de 10 ml',
          normDenom: 'sulfate de magnesium 15 pour cent'
        },
        pMag,
        { useAliases: true }
      );
      expect(evMag15Pct.criteria_status.dosage).toBe('expanded');

      // Pourcentage explicite m/v vs mg/ml -> expanded ; pourcentage nu sans preuve m/v -> unknown
      const pChxExplicitMv = parseStructuredQuery('chlorhexidine', { dosage: '0.2 % (m/v)' }, getTaxonomyVocab(), { useAliases: true });
      const evChxMv = evaluateEntityCriteria(
        {
          denomination: 'CHLORHEXIDINE 2 mg/ml',
          denomDosages: parseDosageTokens('CHLORHEXIDINE 2 mg/ml'),
          compoDosages: [],
          normForme: 'solution pour bain de bouche',
          normVoie: 'buccale',
          normPresText: '',
          normDenom: 'chlorhexidine 2 mg ml'
        },
        pChxExplicitMv,
        { useAliases: true }
      );
      expect(evChxMv.criteria_status.dosage).toBe('expanded');

      const pChxBarePct = parseStructuredQuery('chlorhexidine', { dosage: '0.2 %' }, getTaxonomyVocab(), { useAliases: true });
      const evChxBare = evaluateEntityCriteria(
        {
          denomination: 'CHLORHEXIDINE 2 mg/ml',
          denomDosages: parseDosageTokens('CHLORHEXIDINE 2 mg/ml'),
          compoDosages: [],
          normForme: 'solution pour bain de bouche',
          normVoie: 'buccale',
          normPresText: '',
          normDenom: 'chlorhexidine 2 mg ml'
        },
        pChxBarePct,
        { useAliases: true }
      );
      expect(evChxBare.criteria_match.dosage).toBe(false);
      expect(evChxBare.criteria_status.dosage).toBe('unknown');
    });

    it('§5 Audit : garde-fous concentrations (% m/m vs mg/ml, mg/g, UI/mg, mg/kg, multi-substances), clauses "sans <X>" contiguës et tokens courts/numériques', () => {
      // 1. % m/m (gel, crème, pommade, poudre) vs mg/mL -> non comparable ('unknown'), jamais matched ni expanded
      for (const semiSolidForme of ['gel', 'creme', 'pommade', 'poudre pour application cutanee']) {
        const p25MgMl = parseStructuredQuery('ketoprofene', { dosage: '25 mg/ml' }, getTaxonomyVocab(), { useAliases: true });
        const evSemi = evaluateEntityCriteria(
          {
            denomination: 'KETOPROFENE BIOGARAN 2,5 %, ' + semiSolidForme,
            denomDosages: parseDosageTokens('KETOPROFENE BIOGARAN 2,5 %'),
            compoDosages: [],
            normForme: semiSolidForme,
            normVoie: 'cutanee',
            normPresText: '',
            normDenom: 'ketoprofene biogaran 2 5 pour cent',
            distinctActiveCount: 1
          },
          p25MgMl,
          { useAliases: true }
        );
        expect(evSemi.criteria_match.dosage).toBe(false);
        expect(evSemi.criteria_status.dosage).toBe('unknown');
      }

      // 2. Ratios non comparables : mg/g, UI/mg, mg/kg -> 'unknown', jamais matched
      for (const ratioDosage of ['10 mg/g', '100 UI/mg', '12.5 mg/kg']) {
        const pRatio = parseStructuredQuery('hydrocortisone', { dosage: ratioDosage }, getTaxonomyVocab(), { useAliases: true });
        const evRatio = evaluateEntityCriteria(
          {
            denomination: 'HYDROCORTISONE 10 mg, comprimé',
            denomDosages: parseDosageTokens('10 mg'),
            compoDosages: [],
            normForme: 'comprime',
            normVoie: 'orale',
            normPresText: '',
            normDenom: 'hydrocortisone 10 mg comprime',
            distinctActiveCount: 1
          },
          pRatio,
          { useAliases: true }
        );
        expect(evRatio.criteria_match.dosage).toBe(false);
        expect(evRatio.criteria_status.dosage).toBe('unknown');
      }

      // 3. Multi-substances : interdire toute conversion croisée M mg / V mL -> mg/mL
      const pMulti = parseStructuredQuery('amoxicilline', { dosage: '100 mg/ml' }, getTaxonomyVocab(), { useAliases: true });
      const evMulti = evaluateEntityCriteria(
        {
          denomination: 'AMOXICILLINE ACIDE CLAVULANIQUE 500 mg/62,5 mg/5 ml',
          denomDosages: [{ amount: 500, unit: 'mg' }, { amount: 5, unit: 'ml' }],
          compoDosages: [],
          normForme: 'suspension buvable',
          normVoie: 'orale',
          normPresText: '',
          normDenom: 'amoxicilline acide clavulanique',
          distinctActiveCount: 2
        },
        pMulti,
        { useAliases: true }
      );
      expect(evMulti.criteria_match.dosage).toBe(false);
      expect(evMulti.criteria_status.dosage).toBe('contradicted');

      // 4. Clauses "sans <X>" contiguës vs sac-de-mots ("SANS SUCRE ANIS MENTHE" et "ANISEE" rejetés sur "sans anis")
      const magSansAnis = executeExperimentalSearchPage('Magnesie sans anis', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(magSansAnis.total).toBe(1);
      expect(magSansAnis.results[0].cis).toBe('69000102');

      const pastilleSansAnis = executeExperimentalSearchPage('pastille sans anis', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(pastilleSansAnis.results.some((r) => r.cis === '69000101')).toBe(false);

      const sansAlcool = executeExperimentalSearchPage('bain de bouche sans alcool', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(sansAlcool.total).toBe(0);
      expect(sansAlcool.search.abstained).toBe(true);

      // 5. Tokens courts / numériques discriminants (vitamine B1 vs B6 vs PP, homeogene 9 vs 46, HULIO 40 vs 20, rosuvastatine 5 vs 10)
      const vitB1 = executeExperimentalSearchPage('vitamine B1', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(vitB1.results[0].cis).toBe('67104999');
      expect(vitB1.results.some((r) => r.cis === '69139714')).toBe(false);

      const vitB1Dose500 = executeExperimentalSearchPage('vitamine B1', 'auto', 1, 5, { dosage: '500mg' }, { mode: 'concepts' });
      expect(vitB1Dose500.results[0].cis).toBe('67104999');
      expect(vitB1Dose500.results.some((r) => r.cis === '69139714')).toBe(false);

      const vitB6 = executeExperimentalSearchPage('vitamine B6', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(vitB6.results[0].cis).toBe('66742764');
      expect(vitB6.results.some((r) => r.cis === '67104999')).toBe(false);

      const homeo9 = executeExperimentalSearchPage('homeogene 9', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(homeo9.total).toBe(1);
      expect(homeo9.results[0].cis).toBe('63718901');

      const hulio40 = executeExperimentalSearchPage('HULIO 40', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(hulio40.total).toBe(1);
      expect(hulio40.results[0].cis).toBe('69000040');

      const rosu5 = executeExperimentalSearchPage('rosuvastatine 5', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(rosu5.total).toBe(1);
      expect(rosu5.results[0].cis).toBe('69000005');

      // 6. Contre-ions primaires conservés (chlorure de sodium)
      const nacl = executeExperimentalSearchPage('chlorure de sodium 0,9 %', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(nacl.results[0].cis).toBe('69000201');
      expect(nacl.results[0].criteria_match.dosage).toBe(true);
    });

    it('§2.1 : pourcentages de base inconnue, v/v, m/m, m/v source CIS_COMPO, reconstitution, débit, volume de présentation différent et tolérance d’arrondi (1e-6)', async () => {
      // 1. Pourcentage de base inconnue dans une solution buvable vs mg/mL -> 'unknown' (unitaire + HTTP)
      const p20MgMl = parseStructuredQuery('solution exemple', { dosage: '20 mg/ml' }, getTaxonomyVocab(), { useAliases: true });
      const evUnknownSol = evaluateEntityCriteria(
        {
          denomination: 'SOLUTION EXEMPLE 2 %, solution buvable',
          denomDosages: parseDosageTokens('SOLUTION EXEMPLE 2 %'),
          compoDosages: parseDosageTokens('2 %'),
          compoConcentrationBasis: null,
          compoConcMgMl: null,
          presVolumesMl: [],
          normForme: 'solution buvable',
          normVoie: 'orale',
          normPresText: '',
          normDenom: 'solution exemple 2 pour cent',
          distinctActiveCount: 1
        },
        p20MgMl,
        { useAliases: true }
      );
      expect(evUnknownSol.criteria_match.dosage).toBe(false);
      expect(evUnknownSol.criteria_status.dosage).toBe('unknown');

      const httpUnknownSol = await request(app).get('/api/medicaments/search?q=solution%20exemple&dosage=20%20mg/ml&mode=concepts');
      expect(httpUnknownSol.statusCode).toBe(200);
      const hitUnknownSol = httpUnknownSol.body.data.find((d) => d.cis === '69000302');
      expect(hitUnknownSol).toBeDefined();
      expect(hitUnknownSol.criteria_match.dosage).toBe(false);
      expect(hitUnknownSol.criteria_status.dosage).toBe('unknown');

      // 2. Pourcentage explicitement volume/volume (70 % v/v, 70 ml / 100 ml) vs mg/mL -> 'unknown'
      const p700MgMl = parseStructuredQuery('alcool modifie', { dosage: '700 mg/ml' }, getTaxonomyVocab(), { useAliases: true });
      const evVv = evaluateEntityCriteria(
        {
          denomination: 'ALCOOL MODIFIE 70 % (v/v), solution pour application cutanée',
          denomDosages: parseDosageTokens('ALCOOL MODIFIE 70 % (v/v)'),
          compoDosages: parseDosageTokens('70 ml'),
          compoConcentrationBasis: 'volume_volume',
          compoConcMgMl: null,
          presVolumesMl: [],
          normForme: 'solution pour application cutanee',
          normVoie: 'cutanee',
          normPresText: '',
          normDenom: 'alcool modifie 70 pour cent v v',
          distinctActiveCount: 1
        },
        p700MgMl,
        { useAliases: true }
      );
      expect(evVv.criteria_match.dosage).toBe(false);
      expect(evVv.criteria_status.dosage).toBe('unknown');

      const httpVv = await request(app).get('/api/medicaments/search?q=alcool%20modifie&dosage=700%20mg/ml&mode=concepts');
      expect(httpVv.statusCode).toBe(200);
      const hitVv = httpVv.body.data.find((d) => d.cis === '69000303');
      expect(hitVv).toBeDefined();
      expect(hitVv.criteria_match.dosage).toBe(false);
      expect(hitVv.criteria_status.dosage).toBe('unknown');

      // 3. Base masse/volume connue via CIS_COMPO (0,15 g pour 1 ml + présentation 10 ml) -> 'expanded' sur 1.5g/10ml et 150 mg/ml
      const httpMv = await request(app).get('/api/medicaments/search?q=sulfate%20de%20magnesium&dosage=1.5g/10ml&forme=solution%20injectable&mode=concepts');
      expect(httpMv.statusCode).toBe(200);
      const hitMv = httpMv.body.data.find((d) => d.cis === '69000301');
      expect(hitMv).toBeDefined();
      expect(hitMv.criteria_match.dosage).toBe(false);
      expect(hitMv.criteria_status.dosage).toBe('expanded');

      // 4. Base masse/masse établie par CIS_COMPO (1 g pour 100 g d'émulsion) vs 10 mg/mL -> 'unknown'
      const httpMm = await request(app).get('/api/medicaments/search?q=econazole%20exemple&dosage=10%20mg/ml&mode=concepts');
      expect(httpMm.statusCode).toBe(200);
      const hitMm = httpMm.body.data.find((d) => d.cis === '69000304');
      expect(hitMm).toBeDefined();
      expect(hitMm.criteria_match.dosage).toBe(false);
      expect(hitMm.criteria_status.dosage).toBe('unknown');

      // 5. Concentration après reconstitution et débit de libération (/24h) -> 'unknown'
      const pReconst = parseStructuredQuery('poudre exemple', { dosage: '10 mg/ml' }, getTaxonomyVocab(), { useAliases: true });
      const evReconst = evaluateEntityCriteria(
        {
          denomination: 'POUDRE EXEMPLE 1 %, solution après reconstitution',
          denomDosages: parseDosageTokens('POUDRE EXEMPLE 1 %'),
          compoDosages: parseDosageTokens('1 g'),
          compoConcentrationBasis: 'reconstituted_concentration',
          compoConcMgMl: null,
          presVolumesMl: [],
          normForme: 'poudre pour solution buvable',
          normVoie: 'orale',
          normPresText: '',
          normDenom: 'poudre exemple 1 pour cent solution apres reconstitution',
          distinctActiveCount: 1
        },
        pReconst,
        { useAliases: true }
      );
      expect(evReconst.criteria_match.dosage).toBe(false);
      expect(evReconst.criteria_status.dosage).toBe('unknown');

      const pRelease = parseStructuredQuery('patch exemple 2 mg/24h', {}, getTaxonomyVocab(), { useAliases: true });
      const evRelease = evaluateEntityCriteria(
        {
          denomination: 'PATCH EXEMPLE 2 mg, comprimé',
          denomDosages: parseDosageTokens('2 mg'),
          compoDosages: parseDosageTokens('2 mg'),
          normForme: 'comprime',
          normVoie: 'orale',
          normPresText: '',
          normDenom: 'patch exemple 2 mg',
          distinctActiveCount: 1
        },
        pRelease,
        { useAliases: true }
      );
      expect(evRelease.criteria_match.dosage).toBe(false);
      expect(evRelease.criteria_status.dosage).toBe('unknown');

      // 6. Même concentration (10 mg/ml) mais quantité totale / volume de présentation différent (100 mg/10 ml vs 50 mg/5 ml) -> 'contradicted'
      const p100In10 = parseStructuredQuery('lidocaine', { dosage: '100 mg/10 ml' }, getTaxonomyVocab(), { useAliases: true });
      const ev50In5 = evaluateEntityCriteria(
        {
          denomination: 'LIDOCAINE AMP 50 mg/5 ml, solution injectable',
          denomDosages: parseDosageTokens('LIDOCAINE AMP 50 mg/5 ml'),
          compoDosages: parseDosageTokens('50 mg'),
          compoConcentrationBasis: 'mass_volume',
          compoConcMgMl: 10,
          presVolumesMl: [5],
          normForme: 'solution injectable',
          normVoie: 'intraveineuse',
          normPresText: '10 ampoules en verre de 5 ml',
          normDenom: 'lidocaine amp 50 mg 5 ml',
          distinctActiveCount: 1
        },
        p100In10,
        { useAliases: true }
      );
      expect(ev50In5.criteria_match.dosage).toBe(false);
      expect(ev50In5.criteria_status.dosage).toBe('contradicted');

      const httpDiffVol = await request(app).get('/api/medicaments/search?q=lidocaine%20amp&dosage=100%20mg/10%20ml&mode=concepts');
      expect(httpDiffVol.statusCode).toBe(200);
      const hitDiffVol = httpDiffVol.body.data.find((d) => d.cis === '69000305');
      expect(hitDiffVol).toBeDefined();
      expect(hitDiffVol.criteria_match.dosage).toBe(false);
      expect(hitDiffVol.criteria_status.dosage).toBe('contradicted');

      // 7. Tolérance d’arrondi numérique stricte (1e-6) : 99 mg != 100 mg (pas d'équivalence pharmacologique à 2 %)
      expect(ROUNDING_TOLERANCE_RATIO).toBe(1e-6);
      expect(parseReferenceBasis('1 ml de solution')).toEqual({ kind: 'volume_ml', amount: 1 });
      expect(parseReferenceBasis('100 g de gel')).toEqual({ kind: 'mass_mg', amount: 100000 });
      expect(parseReferenceBasis('100 ml de solution reconstituée')).toEqual({ kind: 'reconstituted_concentration', amount: null });
      expect(detectTextDosageBasis('2 %', parseDosageTokens('2 %'))).toBe('percent_unspecified');
      expect(detectTextDosageBasis('2 % (m/v)', parseDosageTokens('2 %'))).toBe('mass_volume');
      expect(detectTextDosageBasis('70 % (v/v)', parseDosageTokens('70 %'))).toBe('volume_volume');
      expect(resolveCandidateDosageBasis('SULFATE 15 %', parseDosageTokens('15 %'), {
        distinctActiveCount: 1,
        compoConcentrationBasis: 'mass_volume',
        compoConcMgMl: 150
      })).toBe('mass_volume');
      expect(isNonComparableConcentrationBasis('20 mg/ml', parseDosageTokens('20 mg/ml'), parseDosageTokens('2 %'), {
        denomination: 'SOLUTION 2 %',
        distinctActiveCount: 1,
        compoConcentrationBasis: null
      })).toBe(true);
      expect(hasConvertedConcentrationMatch(
        parseDosageTokens('150 mg/ml'),
        parseDosageTokens('15 %'),
        {
          rawRequested: '150 mg/ml',
          record: {
            denomination: 'SULFATE DE MAGNESIUM 15 %',
            distinctActiveCount: 1,
            compoConcentrationBasis: 'mass_volume',
            compoConcMgMl: 150
          }
        }
      )).toBe(true);

      const p100Mg = parseStructuredQuery('exemple', { dosage: '100 mg' }, getTaxonomyVocab(), { useAliases: true });
      const ev99Mg = evaluateEntityCriteria(
        {
          denomination: 'EXEMPLE 99 mg, comprimé',
          denomDosages: parseDosageTokens('99 mg'),
          compoDosages: parseDosageTokens('99 mg'),
          normForme: 'comprime',
          normVoie: 'orale',
          normPresText: '',
          normDenom: 'exemple 99 mg',
          distinctActiveCount: 1
        },
        p100Mg,
        { useAliases: true }
      );
      expect(ev99Mg.criteria_match.dosage).toBe(false);
      expect(ev99Mg.criteria_status.dosage).toBe('contradicted');
    });

    it('§2.2 : assistance forme + voie conserve l’identité de la voie complète et rejette "solution injectable" + "sous-cutanée" pour "solution cutanée"', async () => {
      expect(matchFormeCriterion('solution cutanée', 'solution injectable', { useAliases: true, normVoie: 'sous-cutanee' })).toEqual({
        matched: false,
        status: 'contradicted',
        boost: -1.5
      });
      expect(matchVoieCriterion(['cutanee'], 'sous-cutanee', 'solution injectable', { useAliases: true })).toEqual({
        matched: false,
        status: 'contradicted',
        boost: -1.5
      });
      const pSolCut = parseStructuredQuery('lidocaine', { forme: 'solution cutanée' }, getTaxonomyVocab(), { useAliases: true });

      // Contre-exemple 1 : forme candidate = 'solution injectable', voie candidate = 'sous-cutanée' -> contradicted
      const evSolInjSc = evaluateEntityCriteria(
        {
          denomDosages: [],
          compoDosages: [],
          normForme: 'solution injectable',
          normVoie: 'sous-cutanee',
          normPresText: '',
          normDenom: 'lidocaine renaudin 5 mg ml solution injectable'
        },
        pSolCut,
        { useAliases: true }
      );
      expect(evSolInjSc.criteria_match.forme).toBe(false);
      expect(evSolInjSc.criteria_status.forme).toBe('contradicted');

      // Contre-exemple 2 : même avec voie multivaluée incluant 'cutanée', 'solution injectable' garde un qualifiant galénique contradictoire ('injectable')
      const evSolInjMulti = evaluateEntityCriteria(
        {
          denomDosages: [],
          compoDosages: [],
          normForme: 'solution injectable',
          normVoie: 'cutanee;sous-cutanee',
          normPresText: '',
          normDenom: 'lidocaine injectable'
        },
        pSolCut,
        { useAliases: true }
      );
      expect(evSolInjMulti.criteria_match.forme).toBe(false);
      expect(evSolInjMulti.criteria_status.forme).toBe('contradicted');

      // Contre-exemple 3 : forme générique 'solution pour application' mais voie 'sous-cutanée' -> contradicted (car sous-cutanée != cutanée)
      const evSolAppSc = evaluateEntityCriteria(
        {
          denomDosages: [],
          compoDosages: [],
          normForme: 'solution pour application',
          normVoie: 'sous-cutanee',
          normPresText: '',
          normDenom: 'solution'
        },
        pSolCut,
        { useAliases: true }
      );
      expect(evSolAppSc.criteria_match.forme).toBe(false);
      expect(evSolAppSc.criteria_status.forme).toBe('contradicted');

      // Cas positifs conservés : 'émulsion pour application' + voie 'cutanée' (et voie multivaluée 'cutanée;orale') pour 'émulsion cutanée'
      const pEmulCut = parseStructuredQuery('econazole', { forme: 'émulsion cutanée' }, getTaxonomyVocab(), { useAliases: true });
      for (const candidateVoie of ['cutanee', 'cutanee;orale']) {
        const evEmulPos = evaluateEntityCriteria(
          {
            denomDosages: [],
            compoDosages: [],
            normForme: 'emulsion pour application',
            normVoie: candidateVoie,
            normPresText: '',
            normDenom: 'econazole'
          },
          pEmulCut,
          { useAliases: true }
        );
        expect(evEmulPos.criteria_match.forme).toBe(true);
        expect(evEmulPos.criteria_status.forme).toBe('matched');
      }

      // Vérification HTTP B1/B2 sur le statut de satisfaction (et B0 inchangé)
      for (const mode of ['structured', 'concepts']) {
        const httpSolCut = await request(app).get(`/api/medicaments/search?q=lidocaine&forme=solution%20cutan%C3%A9e&mode=${mode}`);
        expect(httpSolCut.statusCode).toBe(200);
        const scInjectable = httpSolCut.body.data.find((d) => d.cis === '68200003');
        expect(scInjectable).toBeDefined();
        expect(scInjectable.criteria_match.forme).toBe(false);
        expect(scInjectable.criteria_status.forme).toBe('contradicted');
      }

      const httpEmulPos = await request(app).get('/api/medicaments/search?q=econazole%20exemple&forme=%C3%A9mulsion%20cutan%C3%A9e&mode=concepts');
      expect(httpEmulPos.statusCode).toBe(200);
      expect(httpEmulPos.body.data[0].cis).toBe('69000304');
      expect(httpEmulPos.body.data[0].criteria_match.forme).toBe(true);
      expect(httpEmulPos.body.data[0].criteria_status.forme).toBe('matched');

      const httpB0SolCut = await request(app).get('/api/medicaments/search?q=lidocaine&forme=solution%20cutan%C3%A9e');
      expect(httpB0SolCut.statusCode).toBe(200);
      expect(httpB0SolCut.body.search.mode).toBeUndefined();
      const b0ScInjectable = httpB0SolCut.body.data.find((d) => d.cis === '68200003');
      expect(b0ScInjectable).toBeDefined();
      expect(b0ScInjectable.criteria_match.forme).toBe(true);
      expect(b0ScInjectable.criteria_status).toBeUndefined();
    });

    it('§3 : préchauffage explicite (warmExperimentalSearch) et cohérence après vidage / rechargement du corpus', () => {
      resetConceptStoreCache();
      expect(hasTaxonomyCached()).toBe(false);
      expect(hasConceptStoreCached()).toBe(false);

      // mode=legacy : ne préchauffe ni taxonomie ni ConceptStore
      expect(warmExperimentalSearch('legacy')).toEqual({
        mode: 'legacy',
        taxonomyWarmed: false,
        conceptStoreWarmed: false
      });
      expect(hasTaxonomyCached()).toBe(false);
      expect(hasConceptStoreCached()).toBe(false);

      // mode=structured : préchauffe uniquement la taxonomie
      expect(warmExperimentalSearch('structured')).toEqual({
        mode: 'structured',
        taxonomyWarmed: true,
        conceptStoreWarmed: false
      });
      expect(hasTaxonomyCached()).toBe(true);
      expect(hasConceptStoreCached()).toBe(false);

      // mode=concepts : préchauffe taxonomie + ConceptStore hors de la première requête
      expect(warmExperimentalSearch('concepts')).toEqual({
        mode: 'concepts',
        taxonomyWarmed: true,
        conceptStoreWarmed: true
      });
      expect(hasTaxonomyCached()).toBe(true);
      expect(hasConceptStoreCached()).toBe(true);
      const prevStore = getConceptStore();

      // Vidage du corpus -> libération immédiate des structures en cache
      onCorpusCleared();
      expect(hasTaxonomyCached()).toBe(false);
      expect(hasConceptStoreCached()).toBe(false);

      // Rechargement avec mode=concepts -> reconstruction cohérente hors requête
      onCorpusLoaded('concepts');
      expect(hasTaxonomyCached()).toBe(true);
      expect(hasConceptStoreCached()).toBe(true);
      expect(getConceptStore()).not.toBe(prevStore);
    });

    it('§1 PR#8 : garanties B1/B2 conservées en format=markdown (detail=full/summary) : positif strict, contradiction (vitamines B1 500mg / B6 10mg), expanded, unknown, unsupported, conflits et abstention vs vide ordinaire', async () => {
      // 1. Positif strict (detail=full et detail=summary)
      for (const detail of ['full', 'summary']) {
        const posJson = await request(app).get(
          `/api/medicaments/search?q=doliprane&dosage=1000%20mg&forme=comprim%C3%A9&mode=concepts&format=json&detail=${detail}`
        );
        expect(posJson.statusCode).toBe(200);
        expect(posJson.body.data[0].cis).toBe('60234100');
        expect(posJson.body.data[0].criteria_status).toEqual({
          dosage: 'matched',
          forme: 'matched',
          voie: 'not_requested'
        });

        const posMd = await request(app).get(
          `/api/medicaments/search?q=doliprane&dosage=1000%20mg&forme=comprim%C3%A9&mode=concepts&format=markdown&detail=${detail}`
        );
        expect(posMd.statusCode).toBe(200);
        expect(posMd.headers['content-type']).toMatch(/text\/markdown/);
        expect(posMd.text).toContain('## 1. DOLIPRANE 1000 mg, comprimé — CIS 60234100');
        expect(posMd.text).toContain('- Critères: dosage, forme ✓');
        expect(posMd.text).not.toContain('not_requested');
      }

      // 2. Contradiction explicite de dosage sur les deux demandes de vitamines (B1 500mg -> 250 mg ; B6 10 mg -> 250 mg)
      for (const detail of ['full', 'summary']) {
        const b1Json = await request(app).get(
          `/api/medicaments/search?q=vitamine%20B1&dosage=500mg&mode=concepts&format=json&detail=${detail}`
        );
        expect(b1Json.statusCode).toBe(200);
        expect(b1Json.body.data[0].cis).toBe('67104999');
        expect(b1Json.body.data[0].criteria_match.dosage).toBe(false);
        expect(b1Json.body.data[0].criteria_status.dosage).toBe('contradicted');

        const b1Md = await request(app).get(
          `/api/medicaments/search?q=vitamine%20B1&dosage=500mg&mode=concepts&format=markdown&detail=${detail}`
        );
        expect(b1Md.statusCode).toBe(200);
        expect(b1Md.text).toContain('## 1. VITAMINE B1 ARROW CONSEIL 250 mg, comprimé pelliculé — CIS 67104999');
        expect(b1Md.text).toContain(
          '- Critères (⚠️ contradiction — demande partiellement insatisfaite): dosage ✗ (contradicted)'
        );
        expect(b1Md.text).not.toContain('- Critères: dosage ✓');

        const b6Json = await request(app).get(
          `/api/medicaments/search?q=vitamine%20b6&dosage=10%20mg&mode=concepts&format=json&detail=${detail}`
        );
        expect(b6Json.statusCode).toBe(200);
        expect(b6Json.body.data[0].cis).toBe('66742764');
        expect(b6Json.body.data[0].criteria_match.dosage).toBe(false);
        expect(b6Json.body.data[0].criteria_status.dosage).toBe('contradicted');

        const b6Md = await request(app).get(
          `/api/medicaments/search?q=vitamine%20b6&dosage=10%20mg&mode=concepts&format=markdown&detail=${detail}`
        );
        expect(b6Md.statusCode).toBe(200);
        expect(b6Md.text).toContain('## 1. VITAMINE B6 ARROW CONSEIL 250 mg, comprimé quadrisécable — CIS 66742764');
        expect(b6Md.text).toContain(
          '- Critères (⚠️ contradiction — demande partiellement insatisfaite): dosage ✗ (contradicted)'
        );
      }

      // 3. États expanded, unknown et unsupported en Markdown
      const expandedMd = await request(app).get(
        '/api/medicaments/search?q=sulfate%20de%20magnesium&dosage=150%20mg/ml&mode=concepts&format=markdown&detail=summary'
      );
      expect(expandedMd.statusCode).toBe(200);
      expect(expandedMd.text).toContain('SULFATE DE MAGNESIUM RENAUDIN 15 %');
      expect(expandedMd.text).toContain('- Critères: dosage ≈ (expanded)');

      const unknownMd = await request(app).get(
        '/api/medicaments/search?q=solution%20exemple&dosage=20%20mg/ml&mode=concepts&format=markdown&detail=summary'
      );
      expect(unknownMd.statusCode).toBe(200);
      expect(unknownMd.text).toContain('SOLUTION EXEMPLE 2 %');
      expect(unknownMd.text).toContain(
        '- Critères (ℹ️ vérification incomplète): dosage ? (unknown — non vérifiable)'
      );
      expect(unknownMd.text).not.toContain('contradicted');

      const unsupportedMd = await request(app).get(
        '/api/medicaments/search?q=doliprane&dosage=faible%20dose&mode=structured&format=markdown&detail=summary'
      );
      expect(unsupportedMd.statusCode).toBe(200);
      expect(unsupportedMd.text).toContain(
        '- Critères (ℹ️ vérification incomplète): dosage ! (unsupported — non pris en charge)'
      );

      // 4. Conflit entre q et paramètre explicite avec priorité retenue visible en Markdown
      const conflictMd = await request(app).get(
        '/api/medicaments/search?q=doliprane%201000%20mg&dosage=500%20mg&mode=concepts&format=markdown&detail=summary'
      );
      expect(conflictMd.statusCode).toBe(200);
      expect(conflictMd.text).toContain(
        '- ⚠️ Conflit de critère (dosage) : paramètre explicite « 500 mg » prioritaire sur le texte « 1000 mg » (retenu : « 500 mg »)'
      );
      expect(conflictMd.text).toContain('## 1. DOLIPRANE 500 mg, gélule — CIS 60234102');

      // 5. Abstention explicite avec raison vs recherche vide ordinaire
      const abstainedMd = await request(app).get(
        '/api/medicaments/search?q=paracetamol%20pendant%20la%20grossesse&mode=concepts&format=markdown'
      );
      expect(abstainedMd.statusCode).toBe(200);
      expect(abstainedMd.text).toContain('Abstention de recherche');
      expect(abstainedMd.text).toContain('abstained=true');
      expect(abstainedMd.text).toContain('clinical_rcp_property_not_indexed');
      expect(abstainedMd.text).not.toContain('_Aucun résultat._');

      const abstainedCritMd = await request(app).get(
        '/api/medicaments/search?q=doliprane&forme=non%20injectable&mode=structured&format=markdown'
      );
      expect(abstainedCritMd.statusCode).toBe(200);
      expect(abstainedCritMd.text).toContain(
        '- ⚠️ Contrainte non prise en charge (forme) « non injectable » : `negation_in_explicit_criterion`'
      );
      expect(abstainedCritMd.text).toContain('Abstention de recherche');
      expect(abstainedCritMd.text).toContain('explicit_criterion_negation_not_supported');
      expect(abstainedCritMd.text).not.toContain('_Aucun résultat._');

      const ordinaryEmptyMd = await request(app).get(
        '/api/medicaments/search?q=medicament_totalement_inexistant_xyz&mode=concepts&format=markdown'
      );
      expect(ordinaryEmptyMd.statusCode).toBe(200);
      expect(ordinaryEmptyMd.text).toContain('_Aucun résultat._');
      expect(ordinaryEmptyMd.text).not.toContain('Abstention de recherche');

      // 6. Contrat B0 (mode=legacy / défaut) strictement préservé
      const b0Md = await request(app).get(
        '/api/medicaments/search?q=doliprane&dosage=1000%20mg&forme=comprim%C3%A9&format=markdown&detail=summary'
      );
      expect(b0Md.statusCode).toBe(200);
      expect(b0Md.text).toContain('- Critères: dosage, forme ✓');
      expect(b0Md.text).not.toContain('contradiction');
    });

    it('§4 PR#8 : mode=structured (B1) fonctionne via HTTP sans imposer ni matérialiser ConceptStore', async () => {
      resetConceptStoreCache();
      expect(hasTaxonomyCached()).toBe(false);
      expect(hasConceptStoreCached()).toBe(false);

      const res = await request(app).get(
        '/api/medicaments/search?q=doliprane&dosage=1000%20mg&forme=comprim%C3%A9&mode=structured'
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.search.mode).toBe('structured');
      expect(res.body.data[0].cis).toBe('60234100');
      expect(res.body.data[0].criteria_status.dosage).toBe('matched');
      expect(hasTaxonomyCached()).toBe(true);
      expect(hasConceptStoreCached()).toBe(false);
    });
  });
});

describe('cycle réel warmup → rechargement → invalidation/reconstruction (BDPM + ANMV)', () => {
  const savedEnv = { ...process.env };
  let tempDataDir;

  beforeEach(() => {
    jest.resetModules();
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdpm-warmup-cycle-'));
    fs.writeFileSync(
      path.join(tempDataDir, 'CIS_bdpm.txt'),
      [
        '60234100\tDOLIPRANE 1000 mg, comprimé\tcomprimé\torale\tAMM\tProc\tCommercialisée\t01/01/2000\t\t\tOPELLA\tNon',
        '60234102\tDOLIPRANE 500 mg, gélule\tgélule\torale\tAMM\tProc\tCommercialisée\t01/01/2000\t\t\tOPELLA\tNon'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDataDir, 'CIS_CIP_bdpm.txt'),
      '60234100\t3595583\tplaquette PVC aluminium de 8 comprimés\tPrésentation active\tCommercialisée\t01/01/2000\t3400935955838\toui\t65 %\t2,18\t2,18\t0\t',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDataDir, 'CIS_COMPO_bdpm.txt'),
      '60234100\tcomprimé\t02202\tPARACÉTAMOL\t1000 mg\tun comprimé\tSA\t1',
      'utf8'
    );
    fs.writeFileSync(path.join(tempDataDir, 'CIS_GENER_bdpm.txt'), '1\tPARACETAMOL 1000 mg\t60234100\t0\t1', 'utf8');
    fs.writeFileSync(path.join(tempDataDir, 'CIS_CPD_bdpm.txt'), '60234100\tsans prescription médicale', 'utf8');
    fs.writeFileSync(path.join(tempDataDir, 'CIS_CIP_Dispo_Spec.txt'), '', 'utf8');

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
    jest.resetModules();
    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
      tempDataDir = null;
    }
  });

  async function bootWithWarmup(warmupMode) {
    process.env = {
      ...savedEnv,
      DATA_DIR: tempDataDir,
      VET_DATA_DIR: path.join(__dirname, 'fixtures/veterinaires'),
      VET_PRODUCTS_FILE: 'amm-vet-fixture.xml',
      VET_DICT_FILE: 'amm-vet-d-fixture.xml',
      LOAD_HAS_AVIS: 'false',
      LOAD_MITM: 'false'
    };
    if (warmupMode === undefined) delete process.env.SEARCH_WARMUP_MODE;
    else process.env.SEARCH_WARMUP_MODE = warmupMode;

    const { loadData } = require('../src/services/dataLoader');
    const { loadVetData } = require('../src/services/vetDataLoader');
    const conceptStore = require('../src/search/conceptStore');
    const { createApp } = require('../src/app');

    await loadData();
    await loadVetData();
    const app = createApp();
    return { app, loadData, loadVetData, conceptStore };
  }

  it('par défaut legacy : /config expose search_warmup_mode=legacy, aucun ConceptStore préchauffé, invalidation au rechargement, mais modes B1/B2 appelables à la demande', async () => {
    const ctx = await bootWithWarmup(undefined);
    try {
      const cfg = await request(ctx.app).get('/config');
      expect(cfg.statusCode).toBe(200);
      expect(cfg.body.search_warmup_mode).toBe('legacy');
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(false);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);

      // Recherche par défaut (B0 legacy) sans altérer les caches B1/B2
      const b0 = await request(ctx.app).get('/api/medicaments/search?q=doliprane');
      expect(b0.statusCode).toBe(200);
      expect(b0.body.search.mode).toBeUndefined();
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(false);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);

      // Appel explicite ?mode=structured (B1) alors que SEARCH_WARMUP_MODE=legacy : n'impose pas ConceptStore
      const b1 = await request(ctx.app).get('/api/medicaments/search?q=doliprane&dosage=1000%20mg&mode=structured');
      expect(b1.statusCode).toBe(200);
      expect(b1.body.search.mode).toBe('structured');
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);

      // Appel explicite ?mode=concepts (B2) : reste autorisé et matérialise ConceptStore à la demande
      const b2 = await request(ctx.app).get('/api/medicaments/search?q=sultrian&source=auto&mode=concepts');
      expect(b2.statusCode).toBe(200);
      expect(b2.body.search.mode).toBe('concepts');
      expect(b2.body.data[0].num).toBe('0452300');
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(true);

      // Rechargement en mode warmup=legacy : invalide les caches précédents et ne préchauffe pas à nouveau
      await ctx.loadData();
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(false);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);
    } finally {
      ctx.app.locals.dispose?.();
    }
  });

  it('avec SEARCH_WARMUP_MODE=structured : préchauffe la taxonomie sans ConceptStore et la reconstruit au rechargement BDPM/ANMV', async () => {
    const ctx = await bootWithWarmup('structured');
    try {
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);
      const taxInitial = ctx.conceptStore.getTaxonomyVocab();

      await ctx.loadData();
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);
      const taxAfterBdpm = ctx.conceptStore.getTaxonomyVocab();
      expect(taxAfterBdpm).not.toBe(taxInitial);

      await ctx.loadVetData();
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);
      expect(ctx.conceptStore.getTaxonomyVocab()).not.toBe(taxAfterBdpm);

      // B1 HTTP utilise la taxonomie préchauffée sans jamais exiger ConceptStore
      const b1 = await request(ctx.app).get('/api/medicaments/search?q=doliprane&mode=structured');
      expect(b1.statusCode).toBe(200);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(false);
    } finally {
      ctx.app.locals.dispose?.();
    }
  });

  it('avec SEARCH_WARMUP_MODE=concepts : préchauffe ConceptStore, invalide l ancienne génération et reconstruit avec les nouvelles données après rechargement', async () => {
    const ctx = await bootWithWarmup('concepts');
    try {
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(true);
      const storeBeforeBdpmReload = ctx.conceptStore.getConceptStore();
      expect(storeBeforeBdpmReload.bdpmByCis.has('69999888')).toBe(false);

      // Met à jour le corpus BDPM sur disque avant rechargement
      fs.appendFileSync(
        path.join(tempDataDir, 'CIS_bdpm.txt'),
        '\n69999888\tRELOADTEST 500 mg, comprimé\tcomprimé\torale\tAMM\tProc\tCommercialisée\t01/01/2000\t\t\tTESTLAB\tNon',
        'utf8'
      );

      await ctx.loadData();
      expect(ctx.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(true);
      const storeAfterBdpmReload = ctx.conceptStore.getConceptStore();
      expect(storeAfterBdpmReload).not.toBe(storeBeforeBdpmReload);
      expect(storeAfterBdpmReload.bdpmByCis.has('69999888')).toBe(true);

      const reloadedHit = await request(ctx.app).get('/api/medicaments/search?q=reloadtest&mode=concepts');
      expect(reloadedHit.statusCode).toBe(200);
      expect(reloadedHit.body.data[0].cis).toBe('69999888');

      await ctx.loadVetData();
      expect(ctx.conceptStore.hasConceptStoreCached()).toBe(true);
      expect(ctx.conceptStore.getConceptStore()).not.toBe(storeAfterBdpmReload);
    } finally {
      ctx.app.locals.dispose?.();
    }
  });

  it('distingue rollback fonctionnel (retour mode=legacy conserve ConceptStore en RAM) et rollback ressource (libération au rechargement warmup=legacy vs persistance warmup=concepts)', async () => {
    const ctxLegacy = await bootWithWarmup('legacy');
    try {
      const b2 = await request(ctxLegacy.app).get('/api/medicaments/search?q=doliprane&mode=concepts');
      expect(b2.statusCode).toBe(200);
      expect(b2.body.search.mode).toBe('concepts');
      expect(ctxLegacy.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctxLegacy.conceptStore.hasConceptStoreCached()).toBe(true);

      // Rollback fonctionnel : bascule client vers mode=legacy -> comportement B0 immédiat, mais RAM B2 toujours allouée
      const b0AfterRollback = await request(ctxLegacy.app).get('/api/medicaments/search?q=doliprane&mode=legacy');
      expect(b0AfterRollback.statusCode).toBe(200);
      expect(b0AfterRollback.body.search.mode).toBeUndefined();
      expect(ctxLegacy.conceptStore.hasTaxonomyCached()).toBe(true);
      expect(ctxLegacy.conceptStore.hasConceptStoreCached()).toBe(true);

      // Rollback ressources avec SEARCH_WARMUP_MODE=legacy : onCorpusCleared + rechargement (ou reset) libère le cache B2
      await ctxLegacy.loadData();
      expect(ctxLegacy.conceptStore.hasTaxonomyCached()).toBe(false);
      expect(ctxLegacy.conceptStore.hasConceptStoreCached()).toBe(false);
    } finally {
      ctxLegacy.app.locals.dispose?.();
    }

    jest.resetModules();

    // Si SEARCH_WARMUP_MODE=concepts est actif au process, un rechargement seul reconstruit ConceptStore
    const ctxConcepts = await bootWithWarmup('concepts');
    try {
      expect(ctxConcepts.conceptStore.hasConceptStoreCached()).toBe(true);
      const b0Call = await request(ctxConcepts.app).get('/api/medicaments/search?q=doliprane&mode=legacy');
      expect(b0Call.statusCode).toBe(200);
      expect(b0Call.body.search.mode).toBeUndefined();

      await ctxConcepts.loadData();
      expect(ctxConcepts.conceptStore.hasConceptStoreCached()).toBe(true);

      // Libération explicite en maintenance / arrêt
      ctxConcepts.conceptStore.resetConceptStoreCache();
      expect(ctxConcepts.conceptStore.hasTaxonomyCached()).toBe(false);
      expect(ctxConcepts.conceptStore.hasConceptStoreCached()).toBe(false);
    } finally {
      ctxConcepts.app.locals.dispose?.();
    }
  });
});

'use strict';

/**
 * Schéma CSV CIS_CIP_bdpm.txt (13 colonnes gouv) — ne pas confondre avec
 * corpusLightProfile (champs omis en RAM en profil allégé).
 */
const DOLIPRANE_8CP_TSV =
  '60234100\t3595583\tplaquette(s) thermoformée(s) PVC-aluminium de 8  comprimé(s)\t' +
  'Présentation active\tDéclaration de commercialisation\t02/01/2003\t3400935955838\t' +
  'oui\t65%\t1,16\t2,18\t1,02\t';

const DOLIPRANE_8CP_JSON = {
  cis: '60234100',
  cip7: '3595583',
  libelle: 'plaquette(s) thermoformée(s) PVC-aluminium de 8  comprimé(s)',
  statut_admin: 'Présentation active',
  etat_commercialisation: 'Déclaration de commercialisation',
  date_declaration: '02/01/2003',
  cip13: '3400935955838',
  agrement_collectivite: 'oui',
  taux_remboursement: '65%',
  prix_medicament: '1,16',
  prix_public: '2,18',
  honoraires: '1,02'
};

const DOLIPRANE_CIS = '60234100';
const DOLIPRANE_CIP13 = '3400935955838';
const DOLIPRANE_CIP7 = '3595583';

/** Schéma raccourci erroné introduit par 7766624 (10 colonnes) — ne doit pas revenir. */
const REGRESSED_PRESENTATION_FIELDS = [
  'cis', 'cip7', 'libelle', 'etat_commercialisation', 'cip13',
  'taux_remboursement', 'prix_medicament', 'prix_public', 'honoraires', 'indications'
];

module.exports = {
  DOLIPRANE_8CP_TSV,
  DOLIPRANE_8CP_JSON,
  DOLIPRANE_CIS,
  DOLIPRANE_CIP13,
  DOLIPRANE_CIP7,
  REGRESSED_PRESENTATION_FIELDS,
  EXPECTED_PRESENTATION_COLUMN_COUNT: 13
};

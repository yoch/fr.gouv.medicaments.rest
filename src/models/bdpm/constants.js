'use strict';

const BDPM_MEDICAMENT_BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/medicament';

function bdpmExtraitUrl(cis) {
  return `${BDPM_MEDICAMENT_BASE_URL}/${cis}/extrait`;
}

module.exports = {
  BDPM_MEDICAMENT_BASE_URL,
  bdpmExtraitUrl
};

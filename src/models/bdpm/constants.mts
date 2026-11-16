const BDPM_MEDICAMENT_BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/medicament';

function bdpmExtraitUrl(cis: string): string {
  return `${BDPM_MEDICAMENT_BASE_URL}/${cis}/extrait`;
}

export {
  BDPM_MEDICAMENT_BASE_URL,
  bdpmExtraitUrl
};

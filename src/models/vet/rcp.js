'use strict';

const ANMV_RCP_URL_PREFIX = 'http://www.ircp.anmv.anses.fr/rcp.aspx?NomMedicament=';

function buildLienRcpFromNom(nom) {
  if (!nom) return '';
  const param = encodeURIComponent(String(nom).trim())
    .replace(/%20/g, '+')
    .replace(/%[0-9a-f]{2}/gi, (hex) => hex.toLowerCase());
  return `${ANMV_RCP_URL_PREFIX}${param}`;
}

module.exports = {
  ANMV_RCP_URL_PREFIX,
  buildLienRcpFromNom
};

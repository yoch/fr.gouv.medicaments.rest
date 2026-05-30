'use strict';

/** Chaîne CSV/XML normalisée pour stockage corpus (vide si absent). */
function cell(value) {
  if (value == null || value === '') return '';
  return value;
}

/** Objet API : omet les chaînes vides, garde les nombres (y compris 0) et tableaux non vides. */
function jsonFromEntries(entries) {
  const obj = {};
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    if (value == null || value === '') continue;
    if (typeof value === 'number') {
      obj[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) obj[key] = value;
      continue;
    }
    obj[key] = value;
  }
  return obj;
}

module.exports = {
  cell,
  jsonFromEntries
};

'use strict';

/** Partage le travail en cours ; un échec libère aussi le prochain appel. */
function singleFlight(task) {
  let pending = null;
  return (...args) => {
    if (!pending) {
      pending = Promise.resolve().then(() => task(...args)).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

module.exports = { singleFlight };

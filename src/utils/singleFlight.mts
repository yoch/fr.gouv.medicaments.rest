/** Partage le travail en cours ; un échec libère aussi le prochain appel. */
function singleFlight<Args extends unknown[], Result>(
  task: (...args: Args) => Promise<Result> | Result
): (...args: Args) => Promise<Result> {
  let pending: Promise<Result> | null = null;
  return (...args: Args): Promise<Result> => {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => task(...args))
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

export { singleFlight };

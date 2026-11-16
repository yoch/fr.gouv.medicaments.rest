import type { Options, SearchOptions } from '@yoch/frozenminisearch';
import { miniSearchOptions } from './searchRanking.mts';

function miniSearchIndexConfig(
  fields: string[],
  boost: Record<string, number> | null = null
): Options<Record<string, unknown>> {
  const searchOptions: SearchOptions = boost
    ? { ...miniSearchOptions.searchOptions, boost }
    : { ...miniSearchOptions.searchOptions };

  return {
    fields,
    storeFields: [],
    tokenize: miniSearchOptions.tokenize,
    processTerm: miniSearchOptions.processTerm,
    searchOptions
  };
}

export {
  miniSearchIndexConfig
};

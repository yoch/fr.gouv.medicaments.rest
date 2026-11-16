import { miniSearchOptions } from './searchRanking.mts';

function miniSearchIndexConfig(fields: string[], boost: Record<string, number> | null = null) {
  const indexConfig: Record<string, unknown> & { searchOptions: Record<string, unknown> } = {
    fields,
    storeFields: [],
    ...miniSearchOptions,
    searchOptions: { ...miniSearchOptions.searchOptions }
  };
  if (boost) indexConfig.searchOptions.boost = boost;
  return indexConfig;
}

export {
miniSearchIndexConfig
};
#!/usr/bin/env node
/**
 * Charge le graphe modules du load-and-hold sans lancer loadData().
 * Sert à mesurer RssAnon / mmap du bytecode hors corpus.
 */
'use strict';

require('../../src/config.mts');
require('../../src/utils/frozenMiniSearch.mts');
require('../../src/services/dataLoader.mts');
require('../../src/services/vetDataLoader.mts');
require('@yoch/frozenminisearch');

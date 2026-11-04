#!/usr/bin/env node
/**
 * Charge le graphe modules du load-and-hold sans lancer loadData().
 * Sert à mesurer RssAnon / mmap du bytecode hors corpus.
 */
'use strict';

require('../../src/config');
require('../../src/utils/frozenMiniSearch');
require('../../src/services/dataLoader');
require('../../src/services/vetDataLoader');
require('@yoch/frozenminisearch');

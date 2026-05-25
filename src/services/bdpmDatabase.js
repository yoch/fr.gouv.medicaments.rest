const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'bdpm.sqlite');

const BDPM_FILES = {
  specialites: {
    filename: 'CIS_bdpm.txt',
    columns: [
      'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
      'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
      'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
    ]
  },
  presentations: {
    filename: 'CIS_CIP_bdpm.txt',
    columns: [
      'cis', 'cip7', 'libelle', 'statut_admin', 'etat_commercialisation',
      'date_declaration', 'cip13', 'agrement_collectivite', 'taux_remboursement',
      'prix_medicament', 'prix_public', 'honoraires', 'indications'
    ]
  },
  compositions: {
    filename: 'CIS_COMPO_bdpm.txt',
    columns: [
      'cis', 'designation_element', 'code_substance', 'denomination_substance',
      'dosage', 'reference_dosage', 'nature_composant', 'numero_ordre'
    ]
  },
  avis_smr: {
    filename: 'CIS_HAS_SMR_bdpm.txt',
    columns: ['cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_smr', 'libelle_smr']
  },
  avis_asmr: {
    filename: 'CIS_HAS_ASMR_bdpm.txt',
    columns: ['cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_asmr', 'libelle_asmr']
  },
  generiques: {
    filename: 'CIS_GENER_bdpm.txt',
    columns: ['id_groupe', 'libelle_groupe', 'cis', 'type_generique', 'numero_ordre']
  },
  conditions: {
    filename: 'CIS_CPD_bdpm.txt',
    columns: ['cis', 'condition']
  },
  ruptures: {
    filename: 'CIS_CIP_Dispo_Spec.txt',
    columns: [
      'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
      'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
    ]
  },
  mitm: {
    filename: 'CIS_MITM.txt',
    columns: ['cis', 'code_atc', 'denomination', 'lien_fi']
  }
};

const SCHEMA_VERSION = 1;

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseFile(filepath, columns) {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, { encoding: 'utf8' });

  try {
    return parse(content, {
      delimiter: '\t',
      columns,
      skip_empty_lines: true,
      trim: true,
      quote: false,
      escape: false,
      relax_quotes: true,
      relax_column_count: true
    });
  } catch (error) {
    const lines = content.split('\n');
    const records = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const values = line.split('\t');
      const record = {};
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]] = values[i] || '';
      }
      records.push(record);
    }
    return records;
  }
}

function openDb(dbPath) {
  return new Database(dbPath);
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_files (
      filename TEXT PRIMARY KEY,
      downloaded_at TEXT,
      checked_at TEXT,
      hash TEXT,
      source TEXT,
      encoding TEXT
    );

    CREATE TABLE IF NOT EXISTS specialites (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      denomination TEXT,
      forme_pharma TEXT,
      voies_admin TEXT,
      statut_amm TEXT,
      type_amm TEXT,
      commercialisation TEXT,
      date_amm TEXT,
      statut_bdm TEXT,
      num_autorisation_euro TEXT,
      titulaire TEXT,
      surveillance_renforcee TEXT
    );

    CREATE TABLE IF NOT EXISTS presentations (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      cip7 TEXT,
      libelle TEXT,
      statut_admin TEXT,
      etat_commercialisation TEXT,
      date_declaration TEXT,
      cip13 TEXT,
      agrement_collectivite TEXT,
      taux_remboursement TEXT,
      prix_medicament TEXT,
      prix_public TEXT,
      honoraires TEXT,
      indications TEXT
    );

    CREATE TABLE IF NOT EXISTS compositions (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      designation_element TEXT,
      code_substance TEXT,
      denomination_substance TEXT,
      dosage TEXT,
      reference_dosage TEXT,
      nature_composant TEXT,
      numero_ordre TEXT
    );

    CREATE TABLE IF NOT EXISTS avis_smr (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      has_dossier TEXT,
      motif_evaluation TEXT,
      date_avis TEXT,
      valeur_smr TEXT,
      libelle_smr TEXT
    );

    CREATE TABLE IF NOT EXISTS avis_asmr (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      has_dossier TEXT,
      motif_evaluation TEXT,
      date_avis TEXT,
      valeur_asmr TEXT,
      libelle_asmr TEXT
    );

    CREATE TABLE IF NOT EXISTS generiques (
      row_index INTEGER PRIMARY KEY,
      id_groupe TEXT,
      libelle_groupe TEXT,
      cis TEXT,
      type_generique TEXT,
      numero_ordre TEXT
    );

    CREATE TABLE IF NOT EXISTS conditions (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      condition TEXT
    );

    CREATE TABLE IF NOT EXISTS ruptures (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      cip13 TEXT,
      code_statut TEXT,
      libelle_statut TEXT,
      date_debut TEXT,
      date_mise_a_jour TEXT,
      date_remise_dispo TEXT,
      lien_ansm TEXT
    );

    CREATE TABLE IF NOT EXISTS mitm (
      row_index INTEGER PRIMARY KEY,
      cis TEXT,
      code_atc TEXT,
      denomination TEXT,
      lien_fi TEXT
    );

    CREATE TABLE IF NOT EXISTS substances (
      row_index INTEGER PRIMARY KEY,
      code TEXT,
      denomination TEXT,
      medicaments_count INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_specialites_cis ON specialites(cis);
    CREATE INDEX IF NOT EXISTS idx_presentations_cis ON presentations(cis);
    CREATE INDEX IF NOT EXISTS idx_presentations_cip7 ON presentations(cip7);
    CREATE INDEX IF NOT EXISTS idx_presentations_cip13 ON presentations(cip13);
    CREATE INDEX IF NOT EXISTS idx_compositions_cis ON compositions(cis);
    CREATE INDEX IF NOT EXISTS idx_compositions_code_substance ON compositions(code_substance);
    CREATE INDEX IF NOT EXISTS idx_avis_smr_cis ON avis_smr(cis);
    CREATE INDEX IF NOT EXISTS idx_avis_asmr_cis ON avis_asmr(cis);
    CREATE INDEX IF NOT EXISTS idx_generiques_cis ON generiques(cis);
    CREATE INDEX IF NOT EXISTS idx_generiques_id_groupe ON generiques(id_groupe);
    CREATE INDEX IF NOT EXISTS idx_conditions_cis ON conditions(cis);
    CREATE INDEX IF NOT EXISTS idx_ruptures_cis ON ruptures(cis);
    CREATE INDEX IF NOT EXISTS idx_ruptures_cip13 ON ruptures(cip13);
    CREATE INDEX IF NOT EXISTS idx_mitm_cis ON mitm(cis);
    CREATE INDEX IF NOT EXISTS idx_substances_code ON substances(code);

    CREATE VIRTUAL TABLE IF NOT EXISTS specialites_fts USING fts5(
      cis,
      denomination,
      forme_pharma,
      titulaire,
      row_index UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS presentations_fts USING fts5(
      cis,
      cip7,
      cip13,
      libelle,
      indications,
      row_index UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS compositions_fts USING fts5(
      cis,
      denomination_substance,
      dosage,
      row_index UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

function clearData(db) {
  db.exec(`
    DELETE FROM source_files;
    DELETE FROM specialites;
    DELETE FROM presentations;
    DELETE FROM compositions;
    DELETE FROM avis_smr;
    DELETE FROM avis_asmr;
    DELETE FROM generiques;
    DELETE FROM conditions;
    DELETE FROM ruptures;
    DELETE FROM mitm;
    DELETE FROM substances;
    DELETE FROM specialites_fts;
    DELETE FROM presentations_fts;
    DELETE FROM compositions_fts;
  `);
}

function loadMetadata(metaFilePath) {
  if (!fs.existsSync(metaFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
  } catch (error) {
    return {};
  }
}

function insertSourceFiles(db, metadata) {
  const insert = db.prepare(`
    INSERT INTO source_files (filename, downloaded_at, checked_at, hash, source, encoding)
    VALUES (@filename, @downloaded_at, @checked_at, @hash, @source, @encoding)
  `);
  for (const [filename, value] of Object.entries(metadata || {})) {
    if (!value || typeof value !== 'object') continue;
    insert.run({
      filename,
      downloaded_at: value.downloadedAt || null,
      checked_at: value.checkedAt || null,
      hash: value.hash || null,
      source: value.source || null,
      encoding: value.encoding || null
    });
  }
}

function insertRows(db, table, rows, columns) {
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  const insert = db.prepare(`
    INSERT INTO ${table} (row_index, ${columns.join(', ')})
    VALUES (@row_index, ${placeholders})
  `);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    insert.run({
      row_index: i,
      ...row
    });
  }
}

function rebuildSubstances(rows) {
  const substancesMap = new Map();
  for (const comp of rows) {
    if (!comp.code_substance || !comp.denomination_substance) continue;
    if (!substancesMap.has(comp.code_substance)) {
      substancesMap.set(comp.code_substance, {
        code: comp.code_substance,
        denomination: comp.denomination_substance,
        medicaments_count: 0
      });
    }
    substancesMap.get(comp.code_substance).medicaments_count += 1;
  }
  return Array.from(substancesMap.values());
}

function insertFtsRows(db, tableName, rows) {
  if (tableName === 'specialites_fts') {
    const statement = db.prepare(`
      INSERT INTO specialites_fts (cis, denomination, forme_pharma, titulaire, row_index)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      statement.run(
        normalizeSearchText(row.cis),
        normalizeSearchText(row.denomination),
        normalizeSearchText(row.forme_pharma),
        normalizeSearchText(row.titulaire),
        row.row_index
      );
    }
    return;
  }

  if (tableName === 'presentations_fts') {
    const statement = db.prepare(`
      INSERT INTO presentations_fts (cis, cip7, cip13, libelle, indications, row_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      statement.run(
        normalizeSearchText(row.cis),
        normalizeSearchText(row.cip7),
        normalizeSearchText(row.cip13),
        normalizeSearchText(row.libelle),
        normalizeSearchText(row.indications),
        row.row_index
      );
    }
    return;
  }

  if (tableName === 'compositions_fts') {
    const statement = db.prepare(`
      INSERT INTO compositions_fts (cis, denomination_substance, dosage, row_index)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of rows) {
      statement.run(
        normalizeSearchText(row.cis),
        normalizeSearchText(row.denomination_substance),
        normalizeSearchText(row.dosage),
        row.row_index
      );
    }
  }
}

function populateDatabase(db, dataDir, metadata) {
  const parsedData = {};
  for (const [table, config] of Object.entries(BDPM_FILES)) {
    const filepath = path.join(dataDir, config.filename);
    parsedData[table] = parseFile(filepath, config.columns);
  }

  const substances = rebuildSubstances(parsedData.compositions);
  parsedData.substances = substances;

  const tx = db.transaction(() => {
    clearData(db);
    insertSourceFiles(db, metadata);
    for (const [table, config] of Object.entries(BDPM_FILES)) {
      insertRows(db, table, parsedData[table], config.columns);
    }
    insertRows(db, 'substances', parsedData.substances, ['code', 'denomination', 'medicaments_count']);

    insertFtsRows(db, 'specialites_fts', parsedData.specialites.map((row, row_index) => ({ ...row, row_index })));
    insertFtsRows(db, 'presentations_fts', parsedData.presentations.map((row, row_index) => ({ ...row, row_index })));
    insertFtsRows(db, 'compositions_fts', parsedData.compositions.map((row, row_index) => ({ ...row, row_index })));

    db.prepare(`
      INSERT OR REPLACE INTO db_meta (key, value) VALUES ('schema_version', @schema_version)
    `).run({ schema_version: String(SCHEMA_VERSION) });

    db.prepare(`
      INSERT OR REPLACE INTO db_meta (key, value) VALUES ('generated_at', @generated_at)
    `).run({ generated_at: new Date().toISOString() });
  });

  tx();

  return {
    counts: Object.fromEntries(Object.entries(parsedData).map(([k, v]) => [k, v.length]))
  };
}

function buildBdpmDatabase({
  dbPath = DEFAULT_DB_PATH,
  dataDir = DATA_DIR,
  metaFilePath = META_FILE
} = {}) {
  const targetDir = path.dirname(dbPath);
  fs.mkdirSync(targetDir, { recursive: true });
  const tempPath = `${dbPath}.tmp`;
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });

  const metadata = loadMetadata(metaFilePath);
  const db = openDb(tempPath);
  try {
    createSchema(db);
    const stats = populateDatabase(db, dataDir, metadata);
    db.pragma('wal_checkpoint(FULL)');
    db.close();

    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.renameSync(tempPath, dbPath);
    return { dbPath, ...stats };
  } catch (error) {
    db.close();
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function isDatabaseUsable(dbPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = openDb(dbPath);
    const version = db.prepare(`SELECT value FROM db_meta WHERE key = 'schema_version'`).pluck().get();
    const hasSpecialites = db.prepare('SELECT COUNT(*) FROM specialites').pluck().get() > 0;
    db.close();
    return version === String(SCHEMA_VERSION) && hasSpecialites;
  } catch (error) {
    return false;
  }
}

function loadDataFromDatabase(dbPath = DEFAULT_DB_PATH) {
  const db = openDb(dbPath);
  try {
    const readAll = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY row_index ASC`).all();
    const toDataRows = (rows) => rows.map(({ row_index, ...rest }) => rest);

    const data = {
      specialites: toDataRows(readAll('specialites')),
      presentations: toDataRows(readAll('presentations')),
      compositions: toDataRows(readAll('compositions')),
      avis_smr: toDataRows(readAll('avis_smr')),
      avis_asmr: toDataRows(readAll('avis_asmr')),
      generiques: toDataRows(readAll('generiques')),
      conditions: toDataRows(readAll('conditions')),
      ruptures: toDataRows(readAll('ruptures')),
      mitm: toDataRows(readAll('mitm')),
      substances: toDataRows(readAll('substances'))
    };

    const lastUpdated = db.prepare(`
      SELECT COALESCE(MAX(downloaded_at), MAX(checked_at)) AS last_updated
      FROM source_files
    `).get()?.last_updated;

    return {
      data,
      metadata: {
        last_updated: lastUpdated || new Date().toISOString(),
        source: 'base de données publique des médicaments - gouv.fr'
      }
    };
  } finally {
    db.close();
  }
}

const LEAN_MEMORY_TABLES = [
  'specialites',
  'avis_smr',
  'avis_asmr',
  'generiques',
  'conditions',
  'ruptures',
  'mitm',
  'substances'
];

let persistentDb = null;
let persistentDbPath = null;
const stmtCache = new Map();

function getPersistentDb(dbPath = DEFAULT_DB_PATH) {
  if (persistentDb && persistentDbPath === dbPath) return persistentDb;
  if (persistentDb) {
    persistentDb.close();
    persistentDb = null;
    stmtCache.clear();
  }
  persistentDb = openDb(dbPath);
  persistentDbPath = dbPath;
  persistentDb.pragma('journal_mode = WAL');
  return persistentDb;
}

function closePersistentDb() {
  if (persistentDb) {
    persistentDb.close();
    persistentDb = null;
    persistentDbPath = null;
    stmtCache.clear();
  }
}

function cachedStmt(db, sql) {
  let stmt = stmtCache.get(sql);
  if (stmt) return stmt;
  stmt = db.prepare(sql);
  stmtCache.set(sql, stmt);
  return stmt;
}

function queryFts(dbPath, sql, params = []) {
  const db = getPersistentDb(dbPath);
  return cachedStmt(db, sql).all(...params);
}

function loadDataFromDatabaseLean(dbPath = DEFAULT_DB_PATH) {
  const db = openDb(dbPath);
  try {
    const readAll = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY row_index ASC`).all();
    const toDataRows = (rows) => rows.map(({ row_index, ...rest }) => rest);
    const data = {
      specialites: [],
      presentations: [],
      compositions: [],
      avis_smr: [],
      avis_asmr: [],
      generiques: [],
      conditions: [],
      ruptures: [],
      mitm: [],
      substances: []
    };

    for (const table of LEAN_MEMORY_TABLES) {
      data[table] = toDataRows(readAll(table));
    }

    const lastUpdated = db.prepare(`
      SELECT COALESCE(MAX(downloaded_at), MAX(checked_at)) AS last_updated
      FROM source_files
    `).get()?.last_updated;

    return {
      data,
      metadata: {
        last_updated: lastUpdated || new Date().toISOString(),
        source: 'base de données publique des médicaments - gouv.fr'
      }
    };
  } finally {
    db.close();
  }
}

function getTableRowsByIndices(table, indices, dbPath = DEFAULT_DB_PATH) {
  if (!indices.length) return [];
  const db = getPersistentDb(dbPath);
  const sql = `SELECT * FROM ${table} WHERE row_index = ? LIMIT 1`;
  const stmt = cachedStmt(db, sql);
  const results = [];
  for (const idx of indices) {
    const row = stmt.get(idx);
    if (row) {
      const { row_index, ...rest } = row;
      results.push(rest);
    }
  }
  return results;
}

function getRowsByCis(table, cis, dbPath = DEFAULT_DB_PATH) {
  const db = getPersistentDb(dbPath);
  const sql = `SELECT * FROM ${table} WHERE cis = ? ORDER BY row_index ASC`;
  return cachedStmt(db, sql).all(cis).map(({ row_index, ...rest }) => rest);
}

function getSpecialiteRowByCis(cis, dbPath = DEFAULT_DB_PATH) {
  const db = getPersistentDb(dbPath);
  const row = cachedStmt(db, 'SELECT * FROM specialites WHERE cis = ? LIMIT 1').get(cis);
  if (!row) return undefined;
  const { row_index, ...rest } = row;
  return rest;
}

function getDefaultDbPath() {
  return DEFAULT_DB_PATH;
}

module.exports = {
  SCHEMA_VERSION,
  BDPM_FILES,
  LEAN_MEMORY_TABLES,
  normalizeSearchText,
  buildBdpmDatabase,
  isDatabaseUsable,
  loadDataFromDatabase,
  loadDataFromDatabaseLean,
  queryFts,
  getPersistentDb,
  closePersistentDb,
  getTableRowsByIndices,
  getRowsByCis,
  getSpecialiteRowByCis,
  getDefaultDbPath
};

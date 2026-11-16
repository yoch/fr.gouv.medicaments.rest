'use strict';

const { stripTypeScriptTypes } = require('node:module');
const babel = require('@babel/core');
const t = require('@babel/types');
const {
  rewriteModuleStatementsAndPrepareHeader,
  ensureStatementsHoisted,
  buildNamespaceInitStatements,
  wrapInterop,
  isModule
} = require('@babel/helper-module-transforms');

function esmToCjsPlugin() {
  return {
    visitor: {
      Program: {
        exit(path) {
          if (!isModule(path)) return;
          const { meta, headers } = rewriteModuleStatementsAndPrepareHeader(path, {
            exportName: 'exports',
            loose: false,
            strict: false,
            strictMode: true,
            allowTopLevelThis: true,
            noInterop: false,
            importInterop: 'babel'
          });
          for (const [source, metadata] of meta.source) {
            const loadExpr = t.callExpression(t.identifier('require'), [t.stringLiteral(source)]);
            headers.push(
              t.variableDeclaration('var', [
                t.variableDeclarator(
                  t.identifier(metadata.name),
                  wrapInterop(path, loadExpr, metadata.interop) || loadExpr
                )
              ])
            );
            headers.push(...buildNamespaceInitStatements(meta, metadata, false));
          }
          ensureStatementsHoisted(headers);
          path.unshiftContainer('body', headers);
        }
      }
    }
  };
}

const crypto = require('node:crypto');
const fs = require('node:fs');

const TRANSFORMER_VERSION = crypto
  .createHash('sha256')
  .update(fs.readFileSync(__filename))
  .digest('hex');

module.exports = {
  getCacheKey(sourceText, sourcePath, options) {
    return crypto
      .createHash('sha256')
      .update(TRANSFORMER_VERSION)
      .update(sourceText)
      .update(sourcePath)
      .update(String(options?.configString || ''))
      .digest('hex');
  },
  process(sourceText, sourcePath) {
    const js = stripTypeScriptTypes(sourceText, { mode: 'strip' });
    const res = babel.transformSync(js, {
      filename: sourcePath,
      plugins: [esmToCjsPlugin],
      configFile: false,
      babelrc: false
    });
    return { code: res.code };
  }
};

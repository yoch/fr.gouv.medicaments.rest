import { SaxesParser } from 'saxes';

/** Prod : ignore RCP volumineux et lien-rcp (URL reconstruite depuis nom + maj-rcp). Voir docs/VET_XML_PARSER_PHASES.md. */
const VET_SKIP_PRODUCT_TAGS: readonly string[] = ['paragraphes-rcp', 'lien-rcp'];

/** Tests scan RCP : garde lien-rcp pour équivalence avec le XML source. */
const VET_SKIP_SCAN_TAGS: readonly string[] = ['paragraphes-rcp'];

const PRODUCT_TAG = 'medicinal-product';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface VetProductBlockParser {
  skipTags: Set<string>;
}

interface XmlStackNode {
  name: string;
  children: Record<string, unknown> | null;
  text: string;
}

function createVetProductBlockParser(
  skipTags: readonly string[] = VET_SKIP_PRODUCT_TAGS
): VetProductBlockParser {
  return { skipTags: new Set(skipTags) };
}

const defaultProductParser = createVetProductBlockParser();

function addChild(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (UNSAFE_KEYS.has(key)) return;
  if (!Object.hasOwn(obj, key)) obj[key] = value;
  else if (Array.isArray(obj[key])) (obj[key] as unknown[]).push(value);
  else obj[key] = [obj[key], value];
}

// saxes découpe le texte dans la chaîne du bloc. Sous V8, une sous-chaîne d'au
// moins 13 caractères référence sa chaîne parente : sans copie, chaque valeur
// gardée dans le corpus retiendrait tout le bloc XML (~18 Mo sur le corpus ANMV).
// La concaténation puis le slice forcent V8 à recopier dans une chaîne propre.
function leafText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length < 13 ? normalized : ` ${normalized}`.slice(1);
}

/**
 * Parse un bloc `<medicinal-product>…</medicinal-product>` en objet compact :
 * une balise feuille donne son texte (espaces normalisés, sans conversion de
 * type), une balise répétée donne un tableau.
 */
function parseProductBlock(
  blockXml: string,
  parser: VetProductBlockParser
): Record<string, unknown> | null {
  if (!parser) {
    throw new Error('parseProductBlock: parser requis (ex. defaultProductParser)');
  }
  const { skipTags } = parser;
  const xml = new SaxesParser();
  const stack: XmlStackNode[] = [];
  let skipDepth = 0;
  const result: { root: { name: string; value: unknown } | null } = { root: null };

  const onText = (text: string): void => {
    if (skipDepth === 0 && stack.length > 0) stack[stack.length - 1].text += text;
  };
  xml.on('opentag', ({ name }) => {
    if (skipDepth > 0 || skipTags.has(name)) {
      skipDepth++;
      return;
    }
    stack.push({ name, children: null, text: '' });
  });
  xml.on('text', onText);
  xml.on('cdata', onText);
  xml.on('closetag', () => {
    if (skipDepth > 0) {
      skipDepth--;
      return;
    }
    const node = stack.pop();
    if (!node) return;
    const value = node.children ?? leafText(node.text);
    const parent = stack[stack.length - 1];
    if (parent) addChild((parent.children ??= {}), node.name, value);
    else result.root = { name: node.name, value };
  });
  xml.write(blockXml).close();

  const product = result.root?.name === PRODUCT_TAG ? result.root.value : null;
  if (!product || typeof product !== 'object') return null;
  const rec = product as Record<string, unknown>;
  if (!rec.num || !rec.nom) return null;
  return rec;
}

export {
  VET_SKIP_PRODUCT_TAGS,
  VET_SKIP_SCAN_TAGS,
  createVetProductBlockParser,
  defaultProductParser,
  parseProductBlock
};

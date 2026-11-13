'use strict';

const { normalizeText } = require('./text_utils');

function haySub(doc) {
  return normalizeText(`${doc.denomination} ${doc.canonical_subs.join(' ')} ${doc.substances_raw.join(' ')}`);
}

function hayFullPos(doc) {
  return normalizeText(`${doc.denomination} ${doc.canonical_subs.join(' ')} ${doc.classe_pharm} ${doc.rcp_41}`);
}

function buildEvalSuite(corpus) {
  const { docs, princepsByGroup, brandToCanonSubs, docsBySubSig } = corpus;
  const queries = [];

  // =========================================================================
  // F1: Exact / Typo / Abbrev / Dosage+Form / CIS / ATC (32 queries)
  // =========================================================================
  const f1Specs = [
    { q: 'doliprane', re: /\bdoliprane\b/ },
    { q: 'tahor', re: /\btahor\b|atorvastatine/ },
    { q: 'dolipranne 500', re: /\bdoliprane\b.*\b500\b|\b500\b.*\bdoliprane\b/ },
    { q: 'amoxycilline 1g', re: /amoxicilline.*\b(1\s*g|1000\s*mg)\b/ },
    { q: 'ibuprofenne 400', re: /ibuprofene.*\b400\b/ },
    { q: 'paracetmol 1000', re: /paracetamol.*\b(1000|1\s*g)\b/ },
    { q: 'omeprazol 20', re: /omeprazole.*\b20\b/ },
    { q: 'amox 500', re: /amoxicilline.*\b500\b/ },
    { q: 'spasfon lyoc', re: /\bspasfon\b.*\blyoc\b|phloroglucinol/ },
    { q: 'amoxicilline acide clavulanique enfant', re: /amoxicilline.*clavulan.*(enfant|nourrisson)/ },
    { q: 'paracetamol gelule 500', re: /paracetamol.*500.*gelule|doliprane 500 mg, gelule/ },
    { q: '60234100', re: /\b60234100\b|doliprane 1000 mg/ },
    { q: '3400935955838', re: /doliprane/i, cisOnly: false, q_note: 'doliprane_check' },
    { q: 'N02BE01', atcRe: /^N02BE01$/ },
    { q: 'A02BC01', atcRe: /^A02BC01$/ },
    { q: 'C09DA07', atcRe: /^C09DA07$/ },
    { q: 'B01AF02', atcRe: /^B01AF02$/ },
    { q: 'M01AE01', atcRe: /^M01AE01$/ },
    { q: 'J01CR02', atcRe: /^J01CR02$/ },
    { q: 'R03AC02', atcRe: /^R03AC02$/ },
    { q: 'C10AA05', atcRe: /^C10AA05$/ },
    { q: 'levothyrox 75', re: /levothyrox.*\b75\b|levothyroxine.*\b75\b/ },
    { q: 'ventoline spray', re: /ventoline|salbutamol.*(inhal|suspension|pressurise)/ },
    { q: 'kardegic 75', re: /kardegic.*\b75\b/ },
    { q: 'eliquis 5 mg', re: /eliquis.*\b5\b|apixaban.*\b5\b/ },
    { q: 'xarelto 20', re: /xarelto.*\b20\b|rivaroxaban.*\b20\b/ },
    { q: 'inexium 40', re: /inexium.*\b40\b|esomeprazole.*\b40\b/ },
    { q: 'smecta fraise', re: /smecta|diosmectite/ },
    { q: 'metformine 850', re: /metformine.*\b850\b/ },
    { q: 'atorvastatine 20', re: /atorvastatine.*\b20\b/ },
    { q: 'amoxiciline clavulanate', re: /amoxicilline.*clavulan/ },
    { q: 'aerius 5 mg', re: /aerius|desloratadine/ },
  ];
  for (const item of f1Specs) {
    if (item.q === '3400935955838') continue; // avoid hardcoding untested CIP13
    queries.push({
      id: `F1_${queries.length}`,
      category: 'F1_exact_typo_atc',
      query: item.q,
      checkRelevant: (doc) => {
        if (item.atcRe) return item.atcRe.test(doc.atc_code || '');
        const h = normalizeText(`${doc.cis} ${doc.denomination} ${doc.forme_pharma} ${doc.canonical_subs.join(' ')}`);
        return item.re.test(h);
      },
      checkTrap: (doc) => !doc.is_commercialisee ? 'non_commercialisee' : null,
    });
  }

  // =========================================================================
  // F2: Substitution CIS_GENER (40 distinct groups, varied templates)
  // =========================================================================
  const groupMembers = new Map();
  for (const d of docs) {
    if (!d.gener_group_id) continue;
    const arr = groupMembers.get(d.gener_group_id) || [];
    arr.push(d);
    groupMembers.set(d.gener_group_id, arr);
  }
  const subTemplates = [
    (p) => `generique de ${p}`,
    (p) => `generiques ${p}`,
    (p) => `remplacer ${p} par un generique`,
    (p) => `alternative generique a ${p}`,
  ];
  // Map princeps short name -> union of generic doc IDs & princeps IDs across identical short names (e.g. ABILIFY 10 mg variants)
  const f2Candidates = [];
  const pShortGenIds = new Map();
  const pShortPrincIds = new Map();
  for (const [gid, members] of groupMembers) {
    const princ = members.filter((m) => m.gener_type === '0' && m.is_commercialisee);
    const gens = members.filter((m) => m.gener_type && m.gener_type !== '0' && m.is_commercialisee);
    if (princ.length === 0 || gens.length === 0) continue;
    const pShort = princ[0].denomination.split(',')[0].trim();
    const pKey = normalizeText(pShort);
    if (!pShortGenIds.has(pKey)) {
      pShortGenIds.set(pKey, new Set());
      pShortPrincIds.set(pKey, new Set());
      f2Candidates.push({ gid, pShort, pKey });
    }
    const gSet = pShortGenIds.get(pKey);
    const pSet = pShortPrincIds.get(pKey);
    for (const m of members) {
      if (m.gener_type === '0') pSet.add(m.id);
      else if (m.gener_type) gSet.add(m.id);
    }
  }
  for (let subIdx = 0; subIdx < Math.min(40, f2Candidates.length); subIdx++) {
    const { pShort, pKey } = f2Candidates[subIdx];
    const genIds = pShortGenIds.get(pKey);
    const princIds = pShortPrincIds.get(pKey);
    queries.push({
      id: `F2_${subIdx}`,
      category: 'F2_subst_cis_gener',
      query: subTemplates[subIdx % subTemplates.length](pShort),
      checkRelevant: (doc) => genIds.has(doc.id),
      checkTrap: (doc, rank) => (rank === 0 && princIds.has(doc.id) ? 'princeps_top1' : null),
    });
  }

  // =========================================================================
  // F3: Equivalences hors CIS_GENER & liens Marque <-> Molecule (30 queries)
  // =========================================================================
  const f3Brands = [
    ['doliprane', 'equivalent du doliprane', 'equiv'],
    ['doliprane', 'quel medicament contient la meme molecule que doliprane', 'equiv'],
    ['doliprane', 'quel est le principe actif du doliprane', 'info'],
    ['efferalgan', 'generique de efferalgan', 'equiv'],
    ['efferalgan', 'alternative a efferalgan', 'equiv'],
    ['dafalgan', 'meme principe actif que dafalgan', 'equiv'],
    ['kardegic', 'equivalent de kardegic', 'equiv'],
    ['kardegic', 'quelle molecule dans kardegic', 'info'],
    ['advil', 'equivalent advil', 'equiv'],
    ['nurofen', 'remplacer nurofen par un autre medicament', 'equiv'],
    ['spasfon', 'alternative au spasfon', 'equiv'],
    ['spasfon', 'quel est le principe actif de spasfon', 'info'],
    ['eliquis', 'meme molecule que eliquis', 'equiv'],
    ['imodium', 'equivalent imodium', 'equiv'],
    ['ventoline', 'meme principe actif que ventoline', 'equiv'],
    ['gaviscon', 'equivalent du gaviscon', 'equiv'],
    ['smecta', 'alternative au smecta', 'equiv'],
    ['mopral', 'generique mopral', 'equiv'],
    ['inexium', 'equivalent inexium', 'equiv'],
    ['tahor', 'quelle molecule dans le tahor', 'info'],
    ['xarelto', 'equivalent xarelto', 'equiv'],
    ['plavix', 'meme molecule que plavix', 'equiv'],
    ['levothyrox', 'equivalent levothyrox', 'equiv'],
    ['clamoxyl', 'generique du clamoxyl', 'equiv'],
    ['augmentin', 'alternative augmentin', 'equiv'],
    ['atarax', 'equivalent atarax', 'equiv'],
    ['stilnox', 'meme molecule que stilnox', 'equiv'],
    ['imovane', 'equivalent imovane', 'equiv'],
    ['xanax', 'generique xanax', 'equiv'],
    ['seresta', 'equivalent seresta', 'equiv'],
  ];
  for (let i = 0; i < f3Brands.length; i++) {
    const [brand, q, mode] = f3Brands[i];
    const info = brandToCanonSubs.get(brand);
    // Fallback check from docs mentioning the brand if multi-sub wasn't in map
    let targetSigs = new Set();
    if (info) {
      targetSigs.add(info.subSig);
    } else {
      for (const d of docs) {
        if (normalizeText(d.denomination).startsWith(brand) && d.sub_sig) {
          targetSigs.add(d.sub_sig);
        }
      }
    }
    const altExistsForSig = (sig) =>
      (docsBySubSig.get(sig) || []).some(
        (id) => !normalizeText(docs[id].denomination).startsWith(brand) && docs[id].is_commercialisee
      );
    queries.push({
      id: `F3_${i}`,
      category: 'F3_equiv_marque_mol',
      query: q,
      checkRelevant: (doc) => {
        if (!targetSigs.has(doc.sub_sig)) return false;
        if (mode === 'equiv') {
          const sameBrand = normalizeText(doc.denomination).startsWith(brand);
          if (sameBrand && altExistsForSig(doc.sub_sig)) return false;
        }
        return true;
      },
      checkTrap: (doc, rank) => {
        if (
          mode === 'equiv' &&
          rank === 0 &&
          normalizeText(doc.denomination).startsWith(brand) &&
          altExistsForSig(doc.sub_sig || [...targetSigs][0])
        ) {
          return 'same_brand_top1';
        }
        if (!doc.is_commercialisee) return 'non_commercialisee';
        return null;
      },
    });
  }

  // =========================================================================
  // F4: Clinique professionnel / Indications RCP & Classes ATC (30 queries)
  // =========================================================================
  const f4Clinical = [
    { q: 'hypertension arterielle essentielle', re: /amlodipine|ramipril|perindopril|enalapril|lisinopril|losartan|valsartan|irbesartan|candesartan|telmisartan|bisoprolol|nebivolol|atenolol|hydrochlorothiazide|indapamide|olmesartan/, atc: /^C0[23789]/ },
    { q: 'reflux gastro oesophagien oesophagite', re: /omeprazole|esomeprazole|pantoprazole|lansoprazole|rabeprazole|alginate|famotidine|sucralfate/, atc: /^A02B/ },
    { q: 'polyarthrite rhumatoide poussee aigue', re: /methotrexate|adalimumab|etanercept|prednisone|prednisolone|leflunomide|ibuprofene|ketoprofene|naproxene|celecoxib|tocilizumab/ },
    { q: 'prevention thromboembolique fibrillation auriculaire', re: /apixaban|rivaroxaban|dabigatran|edoxaban|warfarine|fluindione|acenocoumarol/ },
    { q: 'diabete type 2 glycemie', re: /metformine|gliclazide|glimepiride|sitagliptine|vildagliptine|empagliflozine|dapagliflozine|semaglutide|liraglutide|repaglinide|insuline/ },
    { q: 'hypercholesterolemie primaire statine', re: /atorvastatine|rosuvastatine|simvastatine|pravastatine|fluvastatine|ezetimibe/, atc: /^C10AA/ },
    { q: 'asthme bronchospasme crise', re: /salbutamol|terbutaline|budesonide|fluticasone|beclometasone|formoterol|salmeterol|montelukast/, atc: /^R03/ },
    { q: 'infection urinaire cystite aigue', re: /fosfomycine|pivmecillinam|nitrofurantoine|ciprofloxacine|ofloxacine|norfloxacine|trimethoprime|sulfamethoxazole/ },
    { q: 'pneumonie communautaire bacterienne', re: /amoxicilline|ceftriaxone|levofloxacine|moxifloxacine|spiramycine|azithromycine|clarithromycine|doxycycline/ },
    { q: 'otite moyenne aigue enfant', re: /amoxicilline|cefpodoxime|clavulanique|ofloxacine/ },
    { q: 'crise de migraine aura', re: /sumatriptan|zolmitriptan|rizatriptan|almotriptan|eletriptan|naratriptan|ketoprofene|ibuprofene|propranolol/, atc: /^N02C/ },
    { q: 'epilepsie crises partielles', re: /levetiracetam|valproate|valproique|lamotrigine|carbamazepine|topiramate|oxcarbazepine|lacosamide/, atc: /^N03A/ },
    { q: 'maladie de parkinson tremblements', re: /levodopa|ropinirole|pramipexole|rasagiline|rotigotine|entacapone/, atc: /^N04/ },
    { q: 'hypothyroidie traitement substitutif', re: /levothyroxine|liothyronine/, atc: /^H03AA/ },
    { q: 'osteoporose post menopausique fracture', re: /alendronique|risedronique|zoledronique|ibandronique|denosumab|raloxifene|teriparatide/ },
    { q: 'glaucome angle ouvert hypertension intraoculaire', re: /latanoprost|bimatoprost|travoprost|timolol|dorzolamide|brinzolamide|brimonidine|pilocarpine/, atc: /^S01E/ },
    { q: 'rhinite allergique saisonniere', re: /cetirizine|levocetirizine|loratadine|desloratadine|fexofenadine|bilastine|ebastine|mometasone|fluticasone|azelastine/ },
    { q: 'trouble anxieux generalise', re: /alprazolam|bromazepam|oxazepam|lorazepam|prazepam|hydroxyzine|venlafaxine|escitalopram|paroxetine|buspirone|pregabaline/ },
    { q: 'episode depressif majeur', re: /sertraline|escitalopram|fluoxetine|paroxetine|citalopram|venlafaxine|duloxetine|mirtazapine|amitriptyline/, atc: /^N06A/ },
    { q: 'crise aigue de goutte', re: /colchicine|allopurinol|febuxostat/, atc: /^M04A/ },
    { q: 'nausees vomissements chimiotherapie postoperatoire', re: /ondansetron|granisetron|aprepitant|metoclopramide|domperidone|dexamethasone/ },
    { q: 'carence en vitamine d rachitisme', re: /cholecalciferol|colecalciferol|vitamine d|ergocalciferol|alfacalcidol|calcitriol/ },
    { q: 'anemie ferriprive carence martiale', re: /\bfer\b|ferreux|ferrique|feredetate|fumarate|sulfate ferreux|carboxymaltose/ },
    { q: 'candidose buccale oropharyngee', re: /miconazole|amphotericine|nystatine|fluconazole/ },
    { q: 'conjonctivite allergique collyre', re: /ketotifene|azelastine|cromoglicate|olopatadine|levocabastine/ },
    { q: 'insuffisance cardiaque chronique', re: /bisoprolol|carvedilol|nebivolol|ramipril|enalapril|sacubitril|furosemide|spironolactone|eplerenone|dapagliflozine|empagliflozine/ },
    { q: 'sevrage tabagique dependance nicotinique', re: /nicotine|varenicline|cytisinicline/ },
    { q: 'herpes labial recidivant aciclovir', re: /aciclovir|valaciclovir/ },
    { q: 'arthrose douleur inflammatoire genou', re: /ibuprofene|ketoprofene|diclofenac|naproxene|celecoxib|meloxicam|paracetamol|tramadol/ },
    { q: 'eradication helicobacter pylori ulcere', re: /omeprazole|esomeprazole|pantoprazole|amoxicilline|clarithromycine|metronidazole|bismuth/ },
  ];
  f4Clinical.forEach((item, i) => {
    queries.push({
      id: `F4_${i}`,
      category: 'F4_clinique_pro',
      query: item.q,
      checkRelevant: (doc) => (item.atc && item.atc.test(doc.atc_code || '')) || item.re.test(haySub(doc)),
      checkTrap: (doc) => (!doc.is_commercialisee ? 'non_commercialisee' : null),
    });
  });

  // =========================================================================
  // F5a: Patient queries matching LEXICON_V1 domain with conversational noise (20)
  // =========================================================================
  const f5aItems = [
    { q: 'que prendre contre les brulures d estomac ?', re: /omeprazole|esomeprazole|pantoprazole|lansoprazole|rabeprazole|alginate|bicarbonate|aluminium|magnesium|famotidine|sucralfate/ },
    { q: 'j ai des remontees acides la nuit quel medicament ?', re: /omeprazole|esomeprazole|pantoprazole|lansoprazole|rabeprazole|alginate|bicarbonate|aluminium|famotidine|sucralfate/ },
    { q: 'quel medoc pour la tension ?', re: /amlodipine|ramipril|perindopril|enalapril|losartan|valsartan|irbesartan|bisoprolol|atenolol|hydrochlorothiazide|indapamide/ },
    { q: 'medicament contre un caillot dans les veines', re: /enoxaparine|tinzaparine|nadroparine|rivaroxaban|apixaban|dabigatran|warfarine|fluindione|acenocoumarol|fondaparinux|heparine|urokinase|alteplase/ },
    { q: 'que prendre pour faire baisser le sucre diabete', re: /metformine|gliclazide|glimepiride|insuline|sitagliptine|vildagliptine|empagliflozine|dapagliflozine|semaglutide|repaglinide/ },
    { q: 'produit contre la chute des cheveux', re: /minoxidil|finasteride/ },
    { q: 'creme pour boutons visage acne', re: /adapalene|tretinoine|isotretinoine|benzoyle|clindamycine|doxycycline|lymecycline|azelaique|erythromycine/ },
    { q: 'traitement champignons sur les ongles', re: /terbinafine|amorolfine|ciclopirox|econazole|fluconazole|itraconazole|bifonazole/ },
    { q: 'que prendre quand ca brule en urinant ?', re: /fosfomycine|pivmecillinam|nitrofurantoine|ciprofloxacine|ofloxacine|trimethoprime|sulfamethoxazole/ },
    { q: 'medoc pour exces de graisse cholesterol dans le sang', re: /atorvastatine|rosuvastatine|simvastatine|pravastatine|fluvastatine|ezetimibe|fenofibrate/ },
    { q: 'gouttes pour pression trop elevee dans l oeil', re: /latanoprost|bimatoprost|travoprost|timolol|dorzolamide|brinzolamide|brimonidine|pilocarpine/ },
    { q: 'quel medicament pour les regles douloureuses ?', re: /ibuprofene|ketoprofene|naproxene|mefenamique|flurbiprofene|phloroglucinol|tiemonium|paracetamol/ },
    { q: 'manque de fer et grosse fatigue que prendre', re: /\bfer\b|ferreux|ferrique|feredetate|fumarate|carboxymaltose|darbepoetine/ },
    { q: 'j ai des champignons sur la peau mycose', re: /econazole|terbinafine|ketoconazole|miconazole|clotrimazole|bifonazole|ciclopirox|sertaconazole/ },
    { q: 'tension arterielle trop haute quoi prendre', re: /amlodipine|ramipril|perindopril|enalapril|losartan|valsartan|irbesartan|bisoprolol|nebivolol|atenolol|indapamide/ },
    { q: 'probleme estomac acide digestion difficile', re: /omeprazole|esomeprazole|pantoprazole|alginate|bicarbonate|aluminium|magnesium|domperidone|metoclopramide|simeticone/ },
    { q: 'fatigue carence en fer femme', re: /\bfer\b|ferreux|ferrique|feredetate|fumarate/ },
    { q: 'traitement perte de cheveux homme', re: /minoxidil|finasteride/ },
    { q: 'brulures en faisant pipi infection urinaire', re: /fosfomycine|pivmecillinam|nitrofurantoine|ciprofloxacine|ofloxacine/ },
    { q: 'exces de graisse triglycerides cholesterol', re: /fenofibrate|atorvastatine|rosuvastatine|simvastatine|pravastatine|ezetimibe/ },
  ];
  f5aItems.forEach((item, i) => {
    queries.push({
      id: `F5a_${i}`,
      category: 'F5a_patient_lex',
      query: item.q,
      checkRelevant: (doc) => item.re.test(haySub(doc)),
      checkTrap: (doc) => (!doc.is_commercialisee ? 'non_commercialisee' : doc.is_hospital ? 'hospital_only' : null),
    });
  });

  // =========================================================================
  // F5b: 30 UNSEEN Patient queries strictly OUT-OF-LEXICON (no leakage!)
  // =========================================================================
  const f5bItems = [
    { q: 'que prendre contre les maux de tete ?', re: /paracetamol|ibuprofene|acetylsalicylique|ketoprofene|naproxene|sumatriptan|zolmitriptan|cafeine/ },
    { q: 'j ai super mal aux dents quoi prendre ?', re: /paracetamol|ibuprofene|ketoprofene|tramadol|acetylsalicylique|clorhexidine|chlorhexidine|spiramycine|amoxicilline/ },
    { q: 'medicament efficace contre les aphtes', re: /lidocaine|chlorhexidine|salicyl|choline|triamcinolone|sucralfate|hexetidine|hyaluronique/ },
    { q: 'vers dans le ventre enfant demangeaisons', re: /flubendazole|pyrantel|albendazole/ },
    { q: 'creme pour coup de soleil brulure legere', re: /trolamine|calendula|dexpanthenol|allantoine|oxyde de zinc|hydrocortisone|lidocaine/ },
    { q: 'nez bouche rhume quoi prendre ?', re: /pseudoephedrine|oxymetazoline|xylometazoline|paracetamol|triprolidine|chlorphenamine|budesonide|mometasone|fluticasone|ipratropium|chlorure de sodium/ },
    { q: 'mal de gorge quand j avale medicament', re: /paracetamol|ibuprofene|flurbiprofene|lidocaine|chlorhexidine|biclotymol|alpha-amylase|lysozyme|hexamidine|cetylpyridinium/ },
    { q: 'douleur sciatique mal au dos quoi prendre', re: /paracetamol|ibuprofene|ketoprofene|diclofenac|naproxene|tramadol|prednisone|prednisolone|thiocolchicoside|methocarbamol|pregabaline/ },
    { q: 'verrue au pied traitement pharmacie', re: /\bacide salicylique\b|\blactique\b|formique|fluorouracile|podophyllotoxine/ },
    { q: 'bouton de fievre sur la levre', re: /aciclovir|valaciclovir|penciclovir|docosanol/ },
    { q: 'que prendre pour une diarrhee aigue ?', re: /loperamide|racecadotril|diosmectite|saccharomyces|nifuroxazide/ },
    { q: 'medicament pour la constipation depuis 3 jours', re: /macrogol|lactulose|psyllium|ispaghul|séné|sene|bisacodyl|glycerol|paraffine|sorbitol|methylcellulose|sterculia/ },
    { q: 'nausees et mal des transports quoi prendre', re: /dimenhydrinate|diphenhydramine|meclozine|scopolamine|metopimazine|metoclopramide|domperidone/ },
    { q: 'medicament contre vertiges et etourdissements', re: /acetylleucine|betahistine|meclozine|dimenhydrinate|piracetam/ },
    { q: 'yeux rouges qui piquent conjonctivite allergique', re: /ketotifene|azelastine|cromoglicate|olopatadine|levocabastine|hexamidine|chlorhexidine|neomycine|tobramycine/ },
    { q: 'sirop pour toux grasse avec glaires', re: /acetylcysteine|carbocisteine|ambroxol|bromhexine|guaifenesine|helicidine/ },
    { q: 'que prendre pour toux seche la nuit ?', re: /dextromethorphane|oxomemazine|pholcodine|codeine|noscapine|pentoxyverine|butamirate|clobutinol|helicidine/ },
    { q: 'crampes et spasmes au ventre apres repas', re: /phloroglucinol|trimebutine|pinaverium|mebeverine|alverine|simeticone|scopolamine/ },
    { q: 'mycoses des pieds entre les orteils', re: /terbinafine|econazole|bifonazole|ketoconazole|miconazole|ciclopirox|clotrimazole|oxiconazole|sertaconazole/ },
    { q: 'creme pour piqure d insecte qui demange', re: /hydrocortisone|promethazine|isothipendyl|diphenhydramine|cetirizine|desloratadine|lidocaine/ },
    { q: 'bain de bouche infection gencives', re: /chlorhexidine|hexetidine|povidone|bicarbonate|hexamidine|metronidazole|spiramycine/ },
    { q: 'douleur articulaire arthrose au genou', re: /diclofenac|ibuprofene|ketoprofene|naproxene|paracetamol|celecoxib|chondroitine|glucosamine|piroxicam/ },
    { q: 'pommade pour bleu bosse et coup', re: /arnica|heparinoide|escin|aescin|mucopolysaccharide|diclofenac|ibuprofene|ketoprofene/ },
    { q: 'rhume des foins eternuements nez qui coule', re: /cetirizine|levocetirizine|loratadine|desloratadine|fexofenadine|bilastine|ebastine|mometasone|fluticasone|budesonide|beclometasone/ },
    { q: 'yeux secs larmes artificielles traitement', re: /carmellose|hyaluronate|hypromellose|povidone|carbomere|trehalose|chlorure de sodium/ },
    { q: 'traitement contre la gale peau qui gratte', re: /ivermectine|permethrine|benzoate de benzyle|esdepallethrine/ },
    { q: 'medicament contre les hemorroides douleur', re: /diosmine|hesperidine|carreghenates|lidocaine|tribenoside|prednisolone|fluocortolone|cinchocaine|ruscogenines/ },
    { q: 'bouffees de chaleur menopause traitement', re: /estradiol|estriol|tibolone|beta-alanine|veralipride|cyproterone/ },
    { q: 'que prendre pour une insolation fievre mal de crane ?', re: /paracetamol|ibuprofene|acetylsalicylique/ },
    { q: 'douleur a l oreille otite adulte', re: /phenazone|lidocaine|ofloxacine|ciprofloxacine|paracetamol|ibuprofene|amoxicilline|neomycine|polymyxine/ },
  ];
  f5bItems.forEach((item, i) => {
    queries.push({
      id: `F5b_${i}`,
      category: 'F5b_patient_oov',
      query: item.q,
      checkRelevant: (doc) => item.re.test(haySub(doc)) || item.re.test(hayFullPos(doc)),
      checkTrap: (doc) => (!doc.is_commercialisee ? 'non_commercialisee' : doc.is_hospital ? 'hospital_only' : null),
    });
  });

  // =========================================================================
  // F6: Semantic Traps — Polarity, Antonyms, 4.1 vs 4.8, Negations "sans X" (22)
  // =========================================================================
  const f6Items = [
    {
      q: 'manque de fer anemie',
      checkRelevant: (doc) => /\bfer\b|ferreux|ferrique|feredetate|fumarate|carboxymaltose/.test(haySub(doc)),
      checkTrap: (doc) => (/deferasirox|deferiprone|deferoxamine/.test(haySub(doc)) ? 'antonym_chelator' : null),
    },
    {
      q: 'faire baisser la tension arterielle',
      checkRelevant: (doc) => /^C0[23789]/.test(doc.atc_code || '') || /amlodipine|ramipril|perindopril|valsartan|losartan|irbesartan|bisoprolol|atenolol|indapamide/.test(haySub(doc)),
      checkTrap: (doc) => (/midodrine|heptaminol|etilefrine|tensionorme/.test(haySub(doc)) ? 'antonym_hypotension' : null),
    },
    {
      q: 'sucre eleve dans le sang diabete',
      checkRelevant: (doc) => /^A10/.test(doc.atc_code || '') || /metformine|gliclazide|glimepiride|insuline|sitagliptine|empagliflozine|dapagliflozine|semaglutide/.test(haySub(doc)),
      checkTrap: (doc) => (/sans sucre|glucagon|baqsimi/.test(normalizeText(doc.denomination + ' ' + doc.canonical_subs.join(' '))) ? 'trap_sans_sucre_or_glucagon' : null),
    },
    {
      q: 'traiter la constipation',
      checkRelevant: (doc) => /^A06/.test(doc.atc_code || '') || /macrogol|lactulose|psyllium|ispaghul|bisacodyl|glycerol|paraffine|sorbitol|sene/.test(haySub(doc)),
      checkTrap: (doc) => (/loperamide|racecadotril/.test(haySub(doc)) ? 'antonym_antidiarrheal' : null),
    },
    {
      q: 'calmer une diarrhee',
      checkRelevant: (doc) => /^A07/.test(doc.atc_code || '') || /loperamide|racecadotril|diosmectite|saccharomyces/.test(haySub(doc)),
      checkTrap: (doc) => (/macrogol|lactulose|bisacodyl/.test(haySub(doc)) ? 'antonym_laxative' : null),
    },
    {
      q: 'mieux dormir contre insomnie',
      checkRelevant: (doc) => /^N05C/.test(doc.atc_code || '') || /zolpidem|zopiclone|doxylamine|melatonine|oxazepam|lorazepam|lormetazepam|alimemazine/.test(haySub(doc)),
      checkTrap: (doc) => (/modafinil|pitolisant|solriamfetol/.test(haySub(doc)) ? 'antonym_wakefulness' : null),
    },
    // Causal 4.8 vs Therapeutic 4.1
    {
      q: 'quel medicament donne des maux de tete en effet secondaire ?',
      intent: 'adverse',
      checkRelevant: (doc) => /cephalee|maux de tete/.test(normalizeText(doc.rcp_48)),
      checkTrap: (doc) => (!doc.rcp_48 || !/cephalee|maux de tete/.test(normalizeText(doc.rcp_48)) ? 'not_in_section_4_8' : null),
    },
    {
      q: 'medicament qui provoque une toux seche effet indesirable',
      intent: 'adverse',
      checkRelevant: (doc) => /toux/.test(normalizeText(doc.rcp_48)),
      checkTrap: (doc) => (!doc.rcp_48 || !/toux/.test(normalizeText(doc.rcp_48)) ? 'not_in_section_4_8' : null),
    },
    {
      q: 'medicament qui provoque de la somnolence effet secondaire',
      intent: 'adverse',
      checkRelevant: (doc) => /somnolence/.test(normalizeText(doc.rcp_48)),
      checkTrap: (doc) => (!doc.rcp_48 || !/somnolence/.test(normalizeText(doc.rcp_48)) ? 'not_in_section_4_8' : null),
    },
    {
      q: 'medicament qui fait prendre du poids effet indesirable',
      intent: 'adverse',
      checkRelevant: (doc) => /prise de poids|augmentation du poids/.test(normalizeText(doc.rcp_48)),
      checkTrap: (doc) => (!doc.rcp_48 || !/prise de poids|augmentation du poids/.test(normalizeText(doc.rcp_48)) ? 'not_in_section_4_8' : null),
    },
    // Contraindication 4.3 / 4.6
    {
      q: 'medicament contre indique pendant la grossesse',
      intent: 'contraindication',
      checkRelevant: (doc) => /grossesse/.test(normalizeText(`${doc.rcp_43} ${doc.rcp_46}`)) && /contre-indiqu|contre indique/.test(normalizeText(`${doc.rcp_43} ${doc.rcp_46}`)),
      checkTrap: (doc) => (!/contre-indiqu|contre indique/.test(normalizeText(`${doc.rcp_43} ${doc.rcp_46}`)) ? 'not_ci_grossesse' : null),
    },
    // Explicit negations "sans <ingredient>"
    {
      q: 'antidouleur fievre sans paracetamol',
      checkRelevant: (doc) => /ibuprofene|ketoprofene|acetylsalicylique|naproxene|tramadol/.test(haySub(doc)) && !/paracetamol/.test(haySub(doc)),
      checkTrap: (doc) => (/paracetamol/.test(haySub(doc)) ? 'negation_violated_paracetamol' : null),
    },
    {
      q: 'anti inflammatoire douleur sans aspirine',
      checkRelevant: (doc) => /ibuprofene|ketoprofene|naproxene|diclofenac|celecoxib/.test(haySub(doc)) && !/acetylsalicyl|aspirine/.test(haySub(doc)),
      checkTrap: (doc) => (/acetylsalicyl|aspirine/.test(haySub(doc)) ? 'negation_violated_aspirine' : null),
    },
    {
      q: 'douleur et fievre sans ibuprofene',
      checkRelevant: (doc) => /paracetamol|acetylsalicylique|tramadol/.test(haySub(doc)) && !/ibuprofene/.test(haySub(doc)),
      checkTrap: (doc) => (/ibuprofene/.test(haySub(doc)) ? 'negation_violated_ibuprofene' : null),
    },
    {
      q: 'antitussif toux sans codeine',
      checkRelevant: (doc) => /dextromethorphane|oxomemazine|helicidine|butamirate|pentoxyverine|carbocisteine/.test(haySub(doc)) && !/codeine/.test(haySub(doc)),
      checkTrap: (doc) => (/codeine/.test(haySub(doc)) ? 'negation_violated_codeine' : null),
    },
    {
      q: 'que prendre contre les maux de tete sans paracetamol ?',
      checkRelevant: (doc) => /ibuprofene|ketoprofene|acetylsalicylique|naproxene|sumatriptan/.test(haySub(doc)) && !/paracetamol/.test(haySub(doc)),
      checkTrap: (doc) => (/paracetamol/.test(haySub(doc)) ? 'negation_violated_paracetamol' : null),
    },
    {
      q: 'sirop toux sans sucre pour diabetique',
      checkRelevant: (doc) => /sans sucre/.test(normalizeText(doc.denomination)) && /toux|expector|bronch/.test(hayFullPos(doc)),
      checkTrap: (doc) => (!/sans sucre/.test(normalizeText(doc.denomination)) ? 'missing_sans_sucre' : null),
    },
    {
      q: 'medicament hypotenseur trop basse tension',
      checkRelevant: (doc) => /midodrine|heptaminol|etilefrine|fludrocortisone/.test(haySub(doc)),
      checkTrap: (doc) => (/^C09|^C08/.test(doc.atc_code || '') ? 'antonym_antihypertensive' : null),
    },
  ];
  f6Items.forEach((item, i) => {
    queries.push({
      id: `F6_${i}`,
      category: 'F6_pieges_polarite',
      query: item.q,
      checkRelevant: item.checkRelevant,
      checkTrap: item.checkTrap,
    });
  });

  // =========================================================================
  // F7: Contraintes population / OTC sans ordonnance / statut / voie (16)
  // =========================================================================
  const f7Items = [
    {
      q: 'fievre nourrisson 6 mois que prendre',
      checkRelevant: (doc) => /paracetamol|ibuprofene/.test(haySub(doc)) && /nourrisson|pediatriq|enfant|suspension buvable|suppositoire/.test(normalizeText(`${doc.denomination} ${doc.rcp_41}`)),
      checkTrap: (doc) => (/\b1000\s*mg\b|\badulte\b/.test(normalizeText(doc.denomination)) && !/enfant|nourrisson/.test(normalizeText(doc.denomination)) ? 'adult_dose_in_infant_query' : null),
    },
    {
      q: 'douleur enfant 20 kg sirop suspension buvable',
      checkRelevant: (doc) => /paracetamol|ibuprofene/.test(haySub(doc)) && /suspension|sirop|buvable/.test(normalizeText(doc.denomination + ' ' + doc.forme_pharma)),
      checkTrap: (doc) => (/\b1000\s*mg\b|comprime/.test(normalizeText(doc.denomination)) ? 'wrong_form_for_child' : null),
    },
    {
      q: 'mal de tete sans ordonnance',
      checkRelevant: (doc) => !doc.is_prescription && !doc.is_hospital && doc.is_commercialisee && /paracetamol|ibuprofene|acetylsalicylique/.test(haySub(doc)),
      checkTrap: (doc) => (doc.is_hospital ? 'hospital_only' : doc.is_prescription ? 'requires_prescription' : !doc.is_commercialisee ? 'non_commercialisee' : null),
    },
    {
      q: 'brulures estomac reflux sans ordonnance',
      checkRelevant: (doc) => !doc.is_prescription && !doc.is_hospital && doc.is_commercialisee && /omeprazole|esomeprazole|pantoprazole|alginate|bicarbonate|aluminium|magnesium/.test(haySub(doc)),
      checkTrap: (doc) => (doc.is_hospital ? 'hospital_only' : doc.is_prescription ? 'requires_prescription' : !doc.is_commercialisee ? 'non_commercialisee' : null),
    },
    {
      q: 'allergie rhinite sans ordonnance',
      checkRelevant: (doc) => !doc.is_prescription && !doc.is_hospital && doc.is_commercialisee && /cetirizine|loratadine|fexofenadine|bilastine|cromoglicate/.test(haySub(doc)),
      checkTrap: (doc) => (doc.is_hospital ? 'hospital_only' : doc.is_prescription ? 'requires_prescription' : !doc.is_commercialisee ? 'non_commercialisee' : null),
    },
    {
      q: 'douleur articulaire gel local application cutanee',
      checkRelevant: (doc) => /gel|pommade|creme|cutan/.test(normalizeText(doc.forme_pharma + ' ' + doc.voie + ' ' + doc.denomination)) && /diclofenac|ibuprofene|ketoprofene|piroxicam|flurbiprofene|etofenamate/.test(haySub(doc)),
      checkTrap: (doc) => (/intravein|injectable/.test(normalizeText(doc.voie + ' ' + doc.forme_pharma)) ? 'wrong_route_injectable' : null),
    },
    {
      q: 'collyre yeux sans conservateur secheresse',
      checkRelevant: (doc) => /collyre|ophtalmique/.test(normalizeText(doc.forme_pharma + ' ' + doc.voie + ' ' + doc.denomination)) && /carmellose|hyaluronate|hypromellose|povidone|carbomere|trehalose/.test(haySub(doc)),
      checkTrap: (doc) => (!/collyre|ophtalm/.test(normalizeText(doc.forme_pharma + ' ' + doc.voie + ' ' + doc.denomination)) ? 'not_ophthalmic' : null),
    },
    {
      q: 'toux enfant 4 ans sirop',
      checkRelevant: (doc) => /helicidine|oxomemazine|carbocisteine|dextromethorphane/.test(haySub(doc)) && /enfant|sirop|buvable/.test(normalizeText(doc.denomination + ' ' + doc.forme_pharma)),
      checkTrap: (doc) => (/\badulte\b/.test(normalizeText(doc.denomination)) ? 'adult_only' : null),
    },
    {
      q: 'diarrhee sans ordonnance',
      checkRelevant: (doc) => !doc.is_prescription && doc.is_commercialisee && /loperamide|racecadotril|diosmectite|saccharomyces/.test(haySub(doc)),
      checkTrap: (doc) => (doc.is_prescription ? 'requires_prescription' : !doc.is_commercialisee ? 'non_commercialisee' : null),
    },
    {
      q: 'herpes levre creme sans ordonnance',
      checkRelevant: (doc) => !doc.is_prescription && doc.is_commercialisee && /aciclovir|docosanol/.test(haySub(doc)) && /creme|cutan/.test(normalizeText(doc.forme_pharma + ' ' + doc.voie)),
      checkTrap: (doc) => (doc.is_prescription ? 'requires_prescription' : null),
    },
    {
      q: 'douleur grossesse enceinte compatible',
      checkRelevant: (doc) => /paracetamol/.test(haySub(doc)) && !/ibuprofene|ketoprofene|naproxene|diclofenac|acetylsalicyl/.test(haySub(doc)),
      checkTrap: (doc) => (/ibuprofene|ketoprofene|naproxene|diclofenac|celecoxib/.test(haySub(doc)) ? 'nsaids_pregnancy_risk' : null),
    },
    {
      q: 'fievre et douleur voie rectale suppositoire nourrisson',
      checkRelevant: (doc) => /paracetamol/.test(haySub(doc)) && /suppositoire/.test(normalizeText(doc.forme_pharma + ' ' + doc.denomination)),
      checkTrap: (doc) => (/comprime|intravein/.test(normalizeText(doc.forme_pharma + ' ' + doc.voie)) ? 'wrong_form' : null),
    },
  ];
  f7Items.forEach((item, i) => {
    queries.push({
      id: `F7_${i}`,
      category: 'F7_contraintes_statut',
      query: item.q,
      checkRelevant: item.checkRelevant,
      checkTrap: item.checkTrap,
    });
  });

  // =========================================================================
  // F8: Extreme Conversational Noise (5 valid) + True Out-Of-Scope (10 OOS)
  // =========================================================================
  const f8NoiseValid = [
    { q: 'bonjour svp je voudrais savoir quel bon medicament je peux prendre quand j ai mal a la tete merci', re: /paracetamol|ibuprofene|acetylsalicylique|ketoprofene/ },
    { q: 'est ce que vous pouvez me conseiller un medoc efficace pour dormir la nuit ?', re: /zolpidem|zopiclone|doxylamine|melatonine|oxazepam|lorazepam|valeriane/ },
    { q: 'je cherche un traitement qui calme vite les aigreurs et brulures estomac svp', re: /omeprazole|esomeprazole|pantoprazole|alginate|bicarbonate|aluminium|magnesium/ },
    { q: 'pouvez vous trouver un equivalent ou generique du doliprane 1000 mg svp', re: /paracetamol/ },
    { q: 'quel remede efficace contre les allergies au pollen avec eternuements', re: /cetirizine|levocetirizine|loratadine|desloratadine|fexofenadine|bilastine|ebastine|mometasone/ },
  ];
  f8NoiseValid.forEach((item, i) => {
    queries.push({
      id: `F8v_${i}`,
      category: 'F8_bruit_valide',
      query: item.q,
      checkRelevant: (doc) => item.re.test(haySub(doc)),
      checkTrap: (doc) => (!doc.is_commercialisee ? 'non_commercialisee' : null),
    });
  });

  const f8Oos = [
    'antipuce collier pour mon chien chat',
    'vermifuge chiot chaton veterinaire',
    'numero de telephone samu urgence 15',
    'horaires pharmacie de garde dimanche soir',
    'combien coute une consultation chez le medecin',
    'remboursement mutuelle paire de lunettes optique',
    'brosse a dents electrique tete souple',
    'thermometre auriculaire infrarouge bebe',
    'creme hydratante visage cosmetique sephora',
    'croquettes chiens sterilises 10 kg',
  ];
  f8Oos.forEach((q, i) => {
    queries.push({
      id: `F8oos_${i}`,
      category: 'F8_hors_perimetre',
      query: q,
      isOos: true,
      checkRelevant: () => false,
      checkTrap: () => 'oos_hallucination',
    });
  });

  return queries;
}

module.exports = {
  buildEvalSuite,
};

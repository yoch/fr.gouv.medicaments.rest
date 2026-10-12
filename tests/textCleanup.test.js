'use strict';

const { cleanText } = require('../src/utils/textCleanup');

describe('cleanText', () => {
  it('renvoie la même chaîne quand il n’y a rien à corriger', () => {
    const value = 'DOLIPRANE 1000 mg, comprimé';
    expect(cleanText(value)).toBe(value);
    expect(cleanText('Johnson & Johnson <5 kg')).toBe('Johnson & Johnson <5 kg');
    expect(cleanText('')).toBe('');
    expect(cleanText(undefined)).toBeUndefined();
  });

  it('remplace <br> par un saut de ligne et garde les paragraphes', () => {
    expect(cleanText('dans les cas suivants :<br><br>- Asthme<br/>- Crises<br />fin'))
      .toBe('dans les cas suivants :\n\n- Asthme\n- Crises\nfin');
    expect(cleanText('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('convertit exposants et indices, sans coller les chiffres', () => {
    expect(cleanText('IMUKIN 2 x 10<sup>6</sup> UI')).toBe('IMUKIN 2 x 10⁶ UI');
    expect(cleanText('H<sub>2</sub>O')).toBe('H₂O');
    expect(cleanText('note<sup>a</sup>')).toBe('notea');
  });

  it('supprime les autres balises', () => {
    expect(cleanText('<p>5,45 mg')).toBe('5,45 mg');
    expect(cleanText('60DH</p>')).toBe('60DH');
    expect(cleanText('<a href="https://x">lien</a> et <b>gras</b>')).toBe('lien et gras');
  });

  it('décode les entités, y compris doublement encodées', () => {
    expect(cleanText('C &amp; H GENERICS')).toBe('C & H GENERICS');
    expect(cleanText('hamster &gt;80%')).toBe('hamster >80%');
    expect(cleanText('L&RSQUO;ARYLSULFATASE')).toBe("L'ARYLSULFATASE");
    expect(cleanText('fen&ecirc;tre &#233; &#xE9;')).toBe('fenêtre é é');
    expect(cleanText('&lt;br&gt;texte')).toBe('texte');
    expect(cleanText('&inconnu;')).toBe('&inconnu;');
  });

  it('corrige les caractères Windows-1252 décodés en Latin-1', () => {
    expect(cleanText('l\u0092absence')).toBe("l'absence");
    expect(cleanText('Compte tenu :<br>\u0095 de la démonstration')).toBe('Compte tenu :\n• de la démonstration');
    expect(cleanText('200 mg \u0096 CORDARONE \u0085')).toBe('200 mg – CORDARONE …');
    expect(cleanText('a\u0081b')).toBe('ab');
  });

  it('remplace ¿ par une apostrophe dans les élisions seulement', () => {
    expect(cleanText('de l¿enfant, qu¿il, jusqu¿à, D¿ACTIVATION')).toBe("de l'enfant, qu'il, jusqu'à, D'ACTIVATION");
    expect(cleanText('et de ¿niveaux')).toBe('et de ¿niveaux');
  });

  it('remplace ¿ par une puce en début de ligne', () => {
    expect(cleanText('cas suivants :<br><br>¿ Hyperaldostéronisme')).toBe('cas suivants :\n\n• Hyperaldostéronisme');
    expect(cleanText('-3,5 points, ¿ : -7,6 points')).toBe('-3,5 points, ¿ : -7,6 points');
  });

  it('restitue les autres caractères perdus en ¿ quand ils sont identifiables', () => {
    expect(cleanText('inflammation de l¿¿il')).toBe("inflammation de l'œil");
    expect(cleanText('un ¿dème maculaire')).toBe('un œdème maculaire');
    expect(cleanText('711+3A¿G, 3849+10kbC¿T.')).toBe('711+3A>G, 3849+10kbC>T.');
    expect(cleanText('Prenant en compte¿:')).toBe('Prenant en compte :');
    expect(cleanText('•¿chez le nourrisson')).toBe('• chez le nourrisson');
  });

  it('uniformise les apostrophes typographiques', () => {
    expect(cleanText('l’enfant')).toBe("l'enfant");
  });

  it('transforme le tiret conditionnel en début de ligne en puce', () => {
    expect(cleanText('Compte tenu :<br>\u00ad de l\u0092absence')).toBe("Compte tenu :\n- de l'absence");
    expect(cleanText('défini par :<br>\u00ad- un échec')).toBe('défini par :\n- un échec');
    expect(cleanText('anti\u00adcorps')).toBe('anticorps');
  });

  it('remplace les caractères de contrôle', () => {
    expect(cleanText('vaso\u0002occlusives')).toBe('vaso-occlusives');
    expect(cleanText('a \u0002 b')).toBe('a b');
  });

  it('normalise les espaces', () => {
    expect(cleanText('ARGININE\u00a0 2,5 mg')).toBe('ARGININE 2,5 mg');
    expect(cleanText('30  gélule(s)\tx')).toBe('30 gélule(s) x');
    expect(cleanText('BETAGAN 0,5 % , collyre')).toBe('BETAGAN 0,5 %, collyre');
    expect(cleanText('optimisé . ou')).toBe('optimisé. ou');
    expect(cleanText('525 ,000')).toBe('525,000');
    expect(cleanText('(cf. 5 .2)')).toBe('(cf. 5.2)');
    expect(cleanText('en sachet ,est important')).toBe('en sachet, est important');
    expect(cleanText('pré-remplie .Vaccin')).toBe('pré-remplie. Vaccin');
    expect(cleanText('hématopoïétiques .•en association')).toBe('hématopoïétiques. •en association');
    expect(cleanText('quotidien).  ; JOURNAL')).toBe('quotidien). ; JOURNAL');
    expect(cleanText('ligne 1 \r\n  ligne 2')).toBe('ligne 1\nligne 2');
  });
});

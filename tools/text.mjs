/**
 * Lisibilite des noms venant du client.
 *
 * Les clients Ragnarok embarquent leurs libelles dans la langue d'origine —
 * coreen le plus souvent — y compris dans des fichiers portant un suffixe de
 * langue. Un nom qu'on ne peut pas lire n'aide personne : mieux vaut le
 * detecter et proposer autre chose que l'afficher tel quel.
 */

/** Hangul, kana, ideogrammes : tout ce qui n'est pas de l'alphabet latin. */
const CJK = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿]/

export function isReadableName(name) {
  return typeof name === 'string' && name.length > 0 && !CJK.test(name)
}

/** Part de noms lisibles dans un echantillon. */
export function readableRatio(names) {
  const sample = names.slice(0, 400).filter((n) => typeof n === 'string' && n)
  if (!sample.length) return 0
  return sample.filter(isReadableName).length / sample.length
}

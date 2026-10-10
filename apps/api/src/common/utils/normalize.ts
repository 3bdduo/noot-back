/**
 * Search normalisation: Arabic letters are folded so users find products regardless of
 * hamza forms, taa marbuta, alef maqsura or diacritics. Latin text is lower-cased.
 */
export function normalizeSearch(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel + tatweel
    .replace(/[آأإٱ]/g, 'ا') // alef variants -> alef
    .replace(/ى/g, 'ي') // alef maqsura -> yaa
    .replace(/ة/g, 'ه') // taa marbuta -> haa
    .replace(/[ؤ]/g, 'و') // waw hamza -> waw
    .replace(/[ئ]/g, 'ي') // yaa hamza -> yaa
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // arabic-indic digits
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // persian digits
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(input: string): string {
  return normalizeSearch(input)
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

import type { Locale } from '@nb/shared';

export interface WithLocale {
  locale: string;
}

/** Picks the translation for `locale`, falling back to the other language, then the first available. */
export function pickTranslation<T extends WithLocale>(
  translations: T[] | undefined | null,
  locale: Locale,
): T | undefined {
  if (!translations || translations.length === 0) return undefined;
  return (
    translations.find((t) => t.locale === locale) ??
    translations.find((t) => t.locale === 'ar') ??
    translations.find((t) => t.locale === 'en') ??
    translations[0]
  );
}

/** Flattens `translations` of an entity into the localized fields (id/locale excluded). */
export function localize<T extends { translations?: WithLocale[] }>(
  entity: T,
  locale: Locale,
  fields: string[],
): Omit<T, 'translations'> & Record<string, any> {
  const { translations, ...rest } = entity as any;
  const tr = pickTranslation(translations as WithLocale[], locale) as any;
  const out: Record<string, any> = { ...rest };
  for (const f of fields) out[f] = tr?.[f] ?? null;
  return out as any;
}

/**
 * The catalogue of CTA banners a post can end with.
 *
 * The ids are what the public site's BlogCtaBanner (ghlprime-updated) renders
 * from — each one is a framing of the same "hire GHL Prime" call to action,
 * chosen to suit the post's angle. The copy lives with the component; this
 * file is only the list a dropdown and a validator need, so it stays free of
 * anything visual.
 *
 * ADDING A VARIANT: add an entry here and a matching key in the site's
 * BlogCtaBanner VARIANTS map. An id here that the site does not know renders
 * as the general banner rather than nothing.
 */

export type CtaVariantMeta = {
  id: string
  /** Shown in the dropdown. */
  label: string
  /** The one-line "why you'd pick this" under the label. */
  hint: string
}

export const CTA_VARIANTS: readonly CtaVariantMeta[] = [
  { id: 'none', label: 'No banner', hint: 'End the post with no call to action at all.' },
  {
    id: 'general',
    label: 'Hire a dedicated GoHighLevel team',
    hint: 'The default: GHL Prime builds, automates and supports your agency’s GoHighLevel setup.',
  },
  {
    id: 'automation',
    label: 'Want this automated?',
    hint: 'For workflow and automation posts: we build and run the exact kind of workflow the post covers.',
  },
  {
    id: 'support',
    label: 'Need a team who handles this?',
    hint: 'For setup, troubleshooting and support posts: 24/7 white-label GoHighLevel support.',
  },
  {
    id: 'ai_agents',
    label: 'Curious what an AI agent could do here?',
    hint: 'For AI and voice posts: AI agents built and deployed inside GoHighLevel.',
  },
]

export const CTA_VARIANT_IDS: string[] = CTA_VARIANTS.map((variant) => variant.id)

/** The banner a post gets when nobody chose one, and when a stored id is unknown. */
export const DEFAULT_CTA_VARIANT = 'general'

/**
 * A CHOICE rather than a banner: "pick one of the real banners at random,
 * per post". Storable on a topic, a schedule or the pinned default; resolved
 * to a real id at the moment a post is written (resolveCtaVariant), so a
 * whole queue does not share one banner picked once.
 */
export const RANDOM_CTA_VARIANT = 'random'

/** The real banners a random pick may land on — everything but "none". */
const RANDOMISABLE = CTA_VARIANTS.filter((variant) => variant.id !== 'none').map((variant) => variant.id)

export function pickRandomCtaVariant(): string {
  return RANDOMISABLE[Math.floor(Math.random() * RANDOMISABLE.length)] ?? DEFAULT_CTA_VARIANT
}

/** A real banner id, or the default for anything unknown. Never "random". */
export function normalizeCtaVariant(value: unknown): string {
  if (typeof value === 'string' && CTA_VARIANT_IDS.includes(value)) return value
  return DEFAULT_CTA_VARIANT
}

/** A storable choice: a real banner id, or "random". The default for anything unknown. */
export function normalizeCtaChoice(value: unknown): string {
  if (value === RANDOM_CTA_VARIANT) return RANDOM_CTA_VARIANT
  return normalizeCtaVariant(value)
}

/** Turn a stored choice into the banner a specific post ends with. */
export function resolveCtaVariant(choice: string): string {
  return choice === RANDOM_CTA_VARIANT ? pickRandomCtaVariant() : normalizeCtaVariant(choice)
}

export function ctaVariantMeta(id: string): CtaVariantMeta | undefined {
  return CTA_VARIANTS.find((variant) => variant.id === id)
}

// Inspired-by national kits for the IIHF men's top 10 (World Ranking, June 2026).
// No federation crests or manufacturer marks: colourways, stripes, wordmarks and
// flag patches are drawn procedurally. Drop official artwork into `crestUrl`
// (front chest graphic, transparent PNG/SVG) for internal demos.

export type FlagPattern =
  | { kind: 'swiss' }
  | { kind: 'nordic'; field: string; cross: string; border?: string }
  | { kind: 'horizontal'; bands: string[]; ratios?: number[] }
  | { kind: 'czech' }
  | { kind: 'leaf' }
  | { kind: 'stars-stripes' }
  | { kind: 'slovak' }

export type WordmarkStyle = 'arch' | 'diagonal' | 'straight'

export interface Jersey {
  rank: number
  code: string
  country: string
  title: string
  wordmark: string
  wordmarkStyle: WordmarkStyle
  /** Body colour. */
  base: string
  /** Main hem/sleeve stripe. */
  stripe: string
  /** Thin pinstripe either side of the main stripe. */
  pinstripe: string
  /** Shoulder yoke colour, `null` for none. */
  yoke: string | null
  /** Lettering / numbers fill and outline. */
  text: string
  textOutline: string
  flag: FlagPattern
  /** Optional official chest graphic, replaces the procedural wordmark when set. */
  crestUrl?: string
  price: string
}

export const JERSEYS: Jersey[] = [
  {
    rank: 1,
    code: 'SUI',
    country: 'Switzerland',
    title: 'Switzerland Home 2026',
    wordmark: 'SUISSE',
    wordmarkStyle: 'arch',
    base: '#d52b1e',
    stripe: '#ffffff',
    pinstripe: '#1a1a1a',
    yoke: null,
    text: '#ffffff',
    textOutline: '#1a1a1a',
    flag: { kind: 'swiss' },
    price: '€140',
  },
  {
    rank: 2,
    code: 'CAN',
    country: 'Canada',
    title: 'Canada Home 2026',
    wordmark: 'CANADA',
    wordmarkStyle: 'arch',
    base: '#c8102e',
    stripe: '#111111',
    pinstripe: '#ffffff',
    yoke: '#111111',
    text: '#ffffff',
    textOutline: '#111111',
    flag: { kind: 'leaf' },
    price: '€150',
  },
  {
    rank: 3,
    code: 'USA',
    country: 'United States',
    title: 'USA Home 2026',
    wordmark: 'USA',
    wordmarkStyle: 'diagonal',
    base: '#1d4fa3',
    stripe: '#ffffff',
    pinstripe: '#c8102e',
    yoke: null,
    text: '#ffffff',
    textOutline: '#c8102e',
    flag: { kind: 'stars-stripes' },
    price: '€150',
  },
  {
    rank: 4,
    code: 'FIN',
    country: 'Finland',
    title: 'Finland Home 2026',
    wordmark: 'SUOMI',
    wordmarkStyle: 'straight',
    base: '#f4f6f8',
    stripe: '#0a2a66',
    pinstripe: '#0a2a66',
    yoke: '#0a2a66',
    text: '#0a2a66',
    textOutline: '#f4f6f8',
    flag: { kind: 'nordic', field: '#ffffff', cross: '#0a2a66' },
    price: '€140',
  },
  {
    rank: 5,
    code: 'SWE',
    country: 'Sweden',
    title: 'Sweden Home 2026',
    wordmark: 'SVERIGE',
    wordmarkStyle: 'arch',
    base: '#f7c600',
    stripe: '#004b93',
    pinstripe: '#004b93',
    yoke: '#004b93',
    text: '#004b93',
    textOutline: '#f7c600',
    flag: { kind: 'nordic', field: '#006aa7', cross: '#fecc00' },
    price: '€140',
  },
  {
    rank: 6,
    code: 'CZE',
    country: 'Czechia',
    title: 'Czechia Home 2026',
    wordmark: 'ČESKO',
    wordmarkStyle: 'diagonal',
    base: '#f2f2f2',
    stripe: '#d7141a',
    pinstripe: '#11457e',
    yoke: null,
    text: '#11457e',
    textOutline: '#d7141a',
    flag: { kind: 'czech' },
    price: '€130',
  },
  {
    rank: 7,
    code: 'GER',
    country: 'Germany',
    title: 'Germany Home 2026',
    wordmark: 'DEUTSCHLAND',
    wordmarkStyle: 'straight',
    base: '#141414',
    stripe: '#dd0000',
    pinstripe: '#ffce00',
    yoke: null,
    text: '#ffffff',
    textOutline: '#dd0000',
    flag: { kind: 'horizontal', bands: ['#000000', '#dd0000', '#ffce00'] },
    price: '€130',
  },
  {
    rank: 8,
    code: 'SVK',
    country: 'Slovakia',
    title: 'Slovakia Home 2026',
    wordmark: 'SLOVENSKO',
    wordmarkStyle: 'arch',
    base: '#0b4ea2',
    stripe: '#ffffff',
    pinstripe: '#ee1c25',
    yoke: '#ffffff',
    text: '#ffffff',
    textOutline: '#ee1c25',
    flag: { kind: 'slovak' },
    price: '€120',
  },
  {
    rank: 9,
    code: 'LAT',
    country: 'Latvia',
    title: 'Latvia Home 2026',
    wordmark: 'LATVIJA',
    wordmarkStyle: 'straight',
    base: '#9e3039',
    stripe: '#ffffff',
    pinstripe: '#ffffff',
    yoke: null,
    text: '#ffffff',
    textOutline: '#5c1a20',
    flag: { kind: 'horizontal', bands: ['#9e3039', '#ffffff', '#9e3039'], ratios: [2, 1, 2] },
    price: '€120',
  },
  {
    rank: 10,
    code: 'DEN',
    country: 'Denmark',
    title: 'Denmark Home 2026',
    wordmark: 'DANMARK',
    wordmarkStyle: 'arch',
    base: '#c8102e',
    stripe: '#ffffff',
    pinstripe: '#ffffff',
    yoke: '#ffffff',
    text: '#ffffff',
    textOutline: '#7a0a1c',
    flag: { kind: 'nordic', field: '#c8102e', cross: '#ffffff' },
    price: '€120',
  },
]

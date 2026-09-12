const CLAIM_DEFINITIONS = [
  { key: '75+ years', label: '75+ years', pattern: /\b75\s*\+?\s*years?\b/i },
  { key: 'museum quality', label: 'museum quality', pattern: /\bmuseum[ -]quality\b/i },
  { key: 'waterproof', label: 'waterproof', pattern: /\bwaterproof\b/i },
  { key: 'uv resistant', label: 'UV-resistant', pattern: /\buv[ -]resistant\b/i },
  { key: 'archival ink', label: 'archival inks', pattern: /\barchival\s+inks?\b/i },
  { key: 'handmade', label: 'handmade', pattern: /\bhand[ -]?made\b/i },
  { key: 'fade resistant', label: 'fade-resistant', pattern: /\bfade[ -]resistant\b/i },
  { key: 'lasting quality', label: 'lasting quality', pattern: /\b(?:long[ -]lasting quality|lasting quality)\b/i },
  { key: 'guarantee', label: 'guarantee', pattern: /\b(?:guarantee|guaranteed|warranty)\b/i },
  { key: 'made to order', label: 'made to order', pattern: /\b(?:made|printed|produced)\s+to\s+order\b/i },
  {
    key: 'shipping promise',
    label: 'shipping promise',
    pattern: /\b(?:(?:free|worldwide|tracked|fast|express)\s+(?:worldwide\s+)?shipping|ships?\s+within|delivery\s+(?:within|in))\b/i
  },
  {
    key: 'processing time',
    label: 'processing time',
    pattern: /\b\d+\s*(?:-|–|—|to)\s*\d+\s*(?:business|working)?\s*days?\b/i
  },
  { key: 'safe arrival', label: 'safe arrival', pattern: /\bsafe arrival\b/i }
];

export function detectUnverifiedClaims(text) {
  const source = String(text || '');
  return CLAIM_DEFINITIONS
    .filter((claim) => claim.pattern.test(source))
    .map(({ key, label }) => ({ key, label }));
}

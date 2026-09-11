const CLAIM_DEFINITIONS = [
  { key: '75+ years', label: '75+ years', pattern: /\b75\s*\+?\s*years?\b/i },
  { key: 'museum quality', label: 'museum quality', pattern: /\bmuseum[ -]quality\b/i },
  { key: 'waterproof', label: 'waterproof', pattern: /\bwaterproof\b/i },
  { key: 'uv resistant', label: 'UV-resistant', pattern: /\buv[ -]resistant\b/i },
  { key: 'archival ink', label: 'archival inks', pattern: /\barchival\s+inks?\b/i },
  { key: 'handmade', label: 'handmade', pattern: /\bhand[ -]?made\b/i }
];

export function detectUnverifiedClaims(text) {
  const source = String(text || '');
  return CLAIM_DEFINITIONS
    .filter((claim) => claim.pattern.test(source))
    .map(({ key, label }) => ({ key, label }));
}

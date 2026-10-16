/** Tag colours a server can wear (tab stripe, sidebar dot, cards). */
export const SERVER_COLORS: Record<string, { label: string; hex: string }> = {
  blood: { label: 'Blood', hex: '#e5485a' },
  gold: { label: 'Gold', hex: '#e9b65a' },
  vblood: { label: 'V Blood', hex: '#b06cf0' },
  sky: { label: 'Sky', hex: '#38bdf8' },
  violet: { label: 'Violet', hex: '#a78bfa' },
  ember: { label: 'Ember', hex: '#f97316' },
  moss: { label: 'Moss', hex: '#84cc16' },
  stone: { label: 'Stone', hex: '#94a3b8' },
};

export function serverColor(c: string | undefined) {
  return SERVER_COLORS[c ?? 'blood']?.hex ?? SERVER_COLORS.blood.hex;
}

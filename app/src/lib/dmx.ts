import { Channel, ChannelType, Fixture } from '../types';

export const channelTypeLabels: Record<ChannelType, string> = {
  dimmer: 'Intensité', red: 'Rouge', green: 'Vert', blue: 'Bleu', white: 'Blanc', amber: 'Ambre', uv: 'UV',
  strobe: 'Strobe', pan: 'Pan', tilt: 'Tilt', speed: 'Vitesse', fog: 'Fumée', fan: 'Ventilateur',
  pattern: 'Motif / Gobo', color: 'Couleur (macro)', mode: 'Mode / Programme', generic: 'Autre',
};

export const categoryLabels: Record<Fixture['category'], string> = {
  par: 'PAR LED', bar: 'Barre LED', wash: 'Wash', moving: 'Lyre', strobe: 'Strobe',
  fog: 'Machine à fumée', laser: 'Laser', other: 'Autre',
};

export const categoryIcons: Record<Fixture['category'], string> = {
  par: 'spotlight', bar: 'led-strip-variant', wash: 'spotlight-beam', moving: 'robot-industrial',
  strobe: 'flash', fog: 'weather-fog', laser: 'laser-pointer', other: 'lightbulb-outline',
};

/** What a set of channels lets the user do, in plain words. */
export function capabilities(channels: Channel[]): string[] {
  const has = (t: ChannelType) => channels.some((c) => c.type === t);
  const out: string[] = [];
  if (has('dimmer')) out.push('Intensité');
  const rgb = has('red') && has('green') && has('blue');
  if (rgb) out.push('Couleurs RVB');
  if (has('white')) out.push('Blanc');
  if (has('amber')) out.push('Ambre');
  if (has('uv')) out.push('UV');
  if (has('color')) out.push('Couleurs préréglées');
  if (has('strobe')) out.push('Strobe');
  if (has('pan') || has('tilt')) out.push('Mouvement');
  if (has('pattern')) out.push('Motifs');
  if (has('fog')) out.push('Fumée');
  if (has('fan')) out.push('Ventilateur');
  if (has('mode')) out.push('Programmes');
  if (has('speed')) out.push('Vitesse');
  return out;
}

/** First free DMX address with room for `count` channels. */
export function nextFreeAddress(fixtures: Fixture[], count: number, ignoreId?: string): number {
  const used = new Uint8Array(513);
  fixtures.forEach((f) => {
    if (f.id === ignoreId) return;
    for (let i = 0; i < f.channels.length; i++) if (f.address + i <= 512) used[f.address + i] = 1;
  });
  for (let start = 1; start + count - 1 <= 512; start++) {
    let free = true;
    for (let i = 0; i < count && free; i++) free = !used[start + i];
    if (free) return start;
  }
  return 1;
}

/** Fixtures sharing DMX channels with the given range. Identical fixtures may do so on purpose. */
export function overlapping(fixtures: Fixture[], address: number, count: number, ignoreId?: string): Fixture[] {
  return fixtures.filter(
    (f) => f.id !== ignoreId && address < f.address + f.channels.length && f.address < address + count,
  );
}

export function hsvToRgb(h: number, s: number, v = 1): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, max === 0 ? 0 : d / max, max / 255];
}

/** Colour a look gives to a fixture, for the swatches of the scene timeline. */
export function lookColor(values: Record<string, number> | undefined): string | null {
  if (!values) return null;
  const white = values.white ?? 0;
  const r = Math.min(255, (values.red ?? 0) + white + (values.amber ?? 0));
  const g = Math.min(255, (values.green ?? 0) + white + (values.amber ?? 0) * 0.6);
  const b = Math.min(255, (values.blue ?? 0) + white + (values.uv ?? 0) * 0.5);
  if (r + g + b === 0) return values.dimmer ? '#E8EAEE' : null;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

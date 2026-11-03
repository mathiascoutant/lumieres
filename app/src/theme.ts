import { TextStyle } from 'react-native';

/** A monochrome interface: on a lighting console, the only colour should be the light itself. */
export const colors = {
  bg: '#07080B',
  glass: 'rgba(17,19,25,0.92)',
  surface: '#111319',
  surface2: '#1A1D25',
  surface3: '#262A34',
  border: 'rgba(255,255,255,0.08)',
  text: '#F5F6F8',
  textDim: '#AAB0BC',
  textMute: '#858C99',
  accent: '#F5F6F8',
  accentSoft: 'rgba(255,255,255,0.12)',
  onAccent: '#0B0C10',
  faderFill: 'rgba(255,255,255,0.22)',
  danger: '#FF453A',
  dangerSoft: 'rgba(255,69,58,0.16)',
  success: '#30D158',
  warning: '#FFD60A',
  scrim: 'rgba(7,8,11,0.72)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };
export const touch = 44;

export const type = {
  title: { fontSize: 22, fontWeight: '700', color: colors.text, letterSpacing: -0.4 } as TextStyle,
  heading: { fontSize: 17, fontWeight: '600', color: colors.text, letterSpacing: -0.2 } as TextStyle,
  body: { fontSize: 15, color: colors.text } as TextStyle,
  label: { fontSize: 13, fontWeight: '500', color: colors.textDim } as TextStyle,
  caption: { fontSize: 12, color: colors.textMute } as TextStyle,
  value: { fontSize: 13, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] } as TextStyle,
};

export const sceneColors = ['#FF9F0A', '#FF453A', '#FF375F', '#BF5AF2', '#5E5CE6', '#32ADE6', '#30D158', '#E5E5EA'];

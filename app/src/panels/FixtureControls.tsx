import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { channelTypeLabels, hsvToRgb, rgbToHsv } from '../lib/dmx';
import { colors, radius, space, type } from '../theme';
import { Channel, ChannelType, Fixture } from '../types';
import { Chip, Icon, Section, Slider } from '../ui';

const SWATCHES: { name: string; rgb: [number, number, number] }[] = [
  { name: 'Rouge', rgb: [255, 0, 0] },
  { name: 'Orange', rgb: [255, 90, 0] },
  { name: 'Jaune', rgb: [255, 200, 0] },
  { name: 'Vert', rgb: [0, 255, 0] },
  { name: 'Turquoise', rgb: [0, 255, 170] },
  { name: 'Cyan', rgb: [0, 200, 255] },
  { name: 'Bleu', rgb: [0, 0, 255] },
  { name: 'Violet', rgb: [120, 0, 255] },
  { name: 'Magenta', rgb: [255, 0, 180] },
  { name: 'Rose', rgb: [255, 70, 120] },
  { name: 'Blanc', rgb: [255, 255, 255] },
];

const HUE_STOPS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'] as const;
const SINGLE_COLORS: ChannelType[] = ['white', 'amber', 'uv'];
const SINGLE_TINT: Partial<Record<ChannelType, string>> = { white: '#FFFFFF', amber: '#FF9F0A', uv: '#7D5CFF' };
const CORE: ChannelType[] = ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'fog'];

interface Props {
  fixtures: Fixture[];
  /** Current value of a channel key on a fixture. */
  getValue: (fixture: Fixture, key: string) => number;
  onChange: (values: Record<string, number>) => void;
  /** Fog as a hold-to-fire button (live) rather than a level saved in a scene. */
  fogAsButton?: boolean;
}

const pct = (v: number) => `${Math.round((v / 255) * 100)} %`;

/** Controls for what the selected fixtures can actually do. Works for one or several. */
export function FixtureControls({ fixtures, getValue, onChange, fogAsButton }: Props) {
  const first = fixtures[0];
  if (!first) return null;
  const has = (t: ChannelType) => fixtures.some((f) => f.channels.some((c) => c.type === t));
  const owner = (t: ChannelType) => fixtures.find((f) => f.channels.some((c) => c.type === t));
  const channelOf = (t: ChannelType): Channel | undefined => owner(t)?.channels.find((c) => c.type === t);
  const read = (t: ChannelType) => {
    const f = owner(t);
    const c = channelOf(t);
    return f && c ? getValue(f, c.key) : 0;
  };

  const hasColor = has('red') && has('green') && has('blue');
  const lightFixture = fixtures.some((f) => f.category !== 'fog');
  const singles = SINGLE_COLORS.filter(has);

  // Channels beyond the common ones, grouped by key: their published ranges say what they do.
  const others = new Map<string, Channel>();
  fixtures.forEach((f) => f.channels.forEach((c) => {
    if (!CORE.includes(c.type) && !others.has(c.key) && !c.label.toLowerCase().includes('non utilis')) others.set(c.key, c);
  }));

  return (
    <View style={{ gap: space.lg }}>
      {lightFixture ? (
        <Slider label="Intensité" value={has('dimmer') ? read('dimmer') : getValue(first, 'dimmer')} format={pct} onChange={(v) => onChange({ dimmer: v })} />
      ) : null}
      {hasColor ? (
        <ColorControl r={read('red')} g={read('green')} b={read('blue')} hasWhite={has('white')} onChange={onChange} />
      ) : null}
      {singles.map((t) => (
        <Slider key={t} label={channelTypeLabels[t]} value={read(t)} format={pct} tint={SINGLE_TINT[t]} onChange={(v) => onChange({ [t]: v })} />
      ))}
      {has('fog') ? (
        fogAsButton ? <FogButton onChange={onChange} /> : <Slider label="Fumée" value={read('fog')} format={pct} onChange={(v) => onChange({ fog: v })} />
      ) : null}
      {[...others.values()].map((c) => {
        const f = fixtures.find((x) => x.channels.some((y) => y.key === c.key))!;
        return <ChannelControl key={c.key} channel={c} value={getValue(f, c.key)} onChange={(v) => onChange({ [c.key]: v })} />;
      })}
    </View>
  );
}

/** A channel with named ranges shows those names, since a raw number says nothing. */
function ChannelControl({ channel, value, onChange }: { channel: Channel; value: number; onChange: (v: number) => void }) {
  const ranges = (channel.ranges ?? []).filter((r) => r.label);
  const current = ranges.find((r) => value >= r.from && value <= r.to);
  return (
    <View style={{ gap: space.sm }}>
      <Slider label={channel.label || channelTypeLabels[channel.type]} value={value}
        format={(v) => String(Math.round(v))} onChange={onChange} />
      {ranges.length > 1 ? (
        <>
          {current ? <Text style={type.caption}>{current.label}</Text> : null}
          <View style={styles.wrap}>
            {ranges.slice(0, 24).map((r) => (
              <Chip key={`${r.from}-${r.to}`} label={r.label} active={current === r}
                onPress={() => onChange(Math.round((r.from + r.to) / 2))} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function ColorControl({ r, g, b, hasWhite, onChange }: {
  r: number; g: number; b: number; hasWhite: boolean; onChange: (v: Record<string, number>) => void;
}) {
  const [h, s] = rgbToHsv(r, g, b);
  // Hue is meaningless at zero saturation: remember it so the slider does not jump back to red.
  const hue = useRef(h);
  if (s > 0.02 && r + g + b > 0) hue.current = h;
  const sat = r + g + b === 0 ? 1 : s;

  const set = (nh: number, ns: number) => {
    hue.current = nh;
    const [nr, ng, nb] = hsvToRgb(nh, ns);
    onChange({ red: nr, green: ng, blue: nb });
  };
  const pick = (name: string, rgb: [number, number, number]) => {
    Haptics.selectionAsync().catch(() => {});
    const values: Record<string, number> = { red: rgb[0], green: rgb[1], blue: rgb[2] };
    if (hasWhite) values.white = name === 'Blanc' ? 255 : 0;
    onChange(values);
  };
  const [pr, pg, pb] = hsvToRgb(hue.current, 1);

  return (
    <Section title="Couleur">
      <View style={styles.swatches}>
        {SWATCHES.map((c) => {
          const active = c.rgb[0] === r && c.rgb[1] === g && c.rgb[2] === b;
          return (
            <Pressable key={c.name} accessibilityRole="button" accessibilityLabel={c.name} accessibilityState={{ selected: active }}
              onPress={() => pick(c.name, c.rgb)} style={[styles.swatch, active && styles.swatchActive]}>
              <View style={[styles.swatchFill, { backgroundColor: `rgb(${c.rgb.join(',')})` }]} />
            </Pressable>
          );
        })}
      </View>
      <Slider label="Teinte" value={hue.current} max={359} format={(v) => `${Math.round(v)}°`} gradient={HUE_STOPS} onChange={(v) => set(v, sat)} />
      <Slider label="Saturation" value={Math.round(sat * 100)} max={100} format={(v) => `${Math.round(v)} %`}
        gradient={['#ffffff', `rgb(${pr},${pg},${pb})`]} onChange={(v) => set(hue.current, v / 100)} />
    </Section>
  );
}

/** Fires only while held. The repeat is what the server's fog safety timeout waits for. */
function FogButton({ onChange }: { onChange: (v: Record<string, number>) => void }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setHeld(false);
    onChange({ fog: 0 });
  };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Maintenir pour envoyer la fumée"
      onPressIn={() => {
        setHeld(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onChange({ fog: 255 });
        timer.current = setInterval(() => onChange({ fog: 255 }), 500);
      }}
      onPressOut={stop}
      style={[styles.fog, held && { backgroundColor: colors.accent }]}
    >
      <Icon name="weather-fog" size={24} color={held ? colors.onAccent : colors.text} />
      <Text style={{ color: held ? colors.onAccent : colors.text, fontSize: 15, fontWeight: '600' }}>
        {held ? 'Fumée en cours' : 'Maintenir pour la fumée'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  swatch: { width: 46, height: 46, borderRadius: 23, padding: 3, borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { borderColor: colors.text },
  swatchFill: { flex: 1, borderRadius: 20 },
  fog: {
    minHeight: 72, borderRadius: radius.lg, backgroundColor: colors.surface2, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: space.sm,
  },
});

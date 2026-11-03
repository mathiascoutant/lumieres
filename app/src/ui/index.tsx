import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, GestureResponderEvent, KeyboardTypeOptions, LayoutChangeEvent, PanResponder, Pressable,
  StyleProp, StyleSheet, Switch, Text, TextInput, View, ViewStyle,
} from 'react-native';

import { colors, radius, space, touch, type } from '../theme';

export type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 20, color = colors.textDim }: { name: string; size?: number; color?: string }) {
  return <MaterialCommunityIcons name={name as IconName} size={size} color={color} />;
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label, icon, kind = 'secondary', onPress, disabled, loading, style, compact,
}: {
  label: string; icon?: string; kind?: ButtonKind; onPress?: () => void; disabled?: boolean; loading?: boolean;
  style?: StyleProp<ViewStyle>; compact?: boolean;
}) {
  const fg = kind === 'primary' ? colors.onAccent : kind === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && { paddingHorizontal: space.md },
        kind === 'primary' && { backgroundColor: colors.accent },
        kind === 'secondary' && { backgroundColor: colors.surface3 },
        kind === 'danger' && { backgroundColor: colors.dangerSoft },
        pressed && { opacity: 0.72 },
        disabled && { opacity: 0.42 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Text numberOfLines={1} style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon, label, onPress, color = colors.text, active, size = 22, style, disabled,
}: {
  icon: string; label: string; onPress?: () => void; color?: string; active?: boolean; size?: number;
  style?: StyleProp<ViewStyle>; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        active && { backgroundColor: colors.accentSoft },
        pressed && { backgroundColor: colors.surface3 },
        disabled && { opacity: 0.35 },
        style,
      ]}
    >
      <Icon name={icon} size={size} color={active ? colors.accent : color} />
    </Pressable>
  );
}

export function Chip({
  label, active, onPress, icon, dot, onLongPress, tone,
}: {
  label: string; active?: boolean; onPress?: () => void; icon?: string; dot?: string; onLongPress?: () => void;
  tone?: 'included';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.chip,
        tone === 'included' && { borderColor: colors.textMute },
        active && { backgroundColor: colors.accent, borderColor: colors.accent },
        pressed && { opacity: 0.72 },
      ]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      {icon ? <Icon name={icon} size={16} color={active ? colors.onAccent : colors.textDim} /> : null}
      <Text numberOfLines={1} style={{ color: active ? colors.onAccent : colors.text, fontSize: 14, fontWeight: '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Field({
  label, value, onChangeText, placeholder, keyboardType, helper, error, onEndEditing, autoFocus, clear,
}: {
  label: string; value: string; onChangeText: (t: string) => void; placeholder?: string;
  keyboardType?: KeyboardTypeOptions; helper?: string; error?: string; onEndEditing?: () => void; autoFocus?: boolean;
  clear?: boolean;
}) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={type.label}>{label}</Text>
      <View>
        <TextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          onEndEditing={onEndEditing}
          placeholder={placeholder}
          placeholderTextColor={colors.textMute}
          keyboardType={keyboardType}
          autoCorrect={false}
          autoCapitalize="none"
          autoFocus={autoFocus}
          returnKeyType="done"
          keyboardAppearance="dark"
          style={[styles.input, error ? { borderColor: colors.danger } : null, clear && value ? { paddingRight: touch } : null]}
        />
        {clear && value ? (
          <IconButton icon="close-circle" label="Effacer" size={18} color={colors.textMute} onPress={() => onChangeText('')} style={{ position: 'absolute', right: 0, top: 0 }} />
        ) : null}
      </View>
      {error ? <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text> : helper ? <Text style={type.caption}>{helper}</Text> : null}
    </View>
  );
}

export function ToggleRow({ label, helper, value, onChange }: { label: string; helper?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        {helper ? <Text style={type.caption}>{helper}</Text> : null}
      </View>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
    </View>
  );
}

export function Segmented<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string; icon?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && { backgroundColor: colors.surface3 }]}
          >
            {o.icon ? <Icon name={o.icon} size={16} color={active ? colors.accent : colors.textDim} /> : null}
            <Text numberOfLines={1} style={{ color: active ? colors.text : colors.textDim, fontSize: 13, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Plus / minus control with a typed value, for numbers needing precision such as a DMX address. */
export function Stepper({
  label, value, min, max, step = 1, onChange, format, helper,
}: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
  format?: (v: number) => string; helper?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const commit = () => {
    const n = parseFloat(text.replace(',', '.'));
    if (Number.isNaN(n)) setText(String(value));
    else onChange(clamp(n));
  };
  return (
    <View style={{ gap: space.xs }}>
      <Text style={type.label}>{label}</Text>
      <View style={styles.stepper}>
        <IconButton icon="minus" label={`Diminuer ${label}`} disabled={value <= min} onPress={() => onChange(clamp(value - step))} />
        {format ? (
          <Text style={[type.value, styles.stepperValue]}>{format(value)}</Text>
        ) : (
          <TextInput
            accessibilityLabel={label}
            value={text}
            onChangeText={setText}
            onEndEditing={commit}
            keyboardType="decimal-pad"
            keyboardAppearance="dark"
            selectTextOnFocus
            style={[type.value, styles.stepperValue, { fontSize: 16 }]}
          />
        )}
        <IconButton icon="plus" label={`Augmenter ${label}`} disabled={value >= max} onPress={() => onChange(clamp(value + step))} />
      </View>
      {helper ? <Text style={type.caption}>{helper}</Text> : null}
    </View>
  );
}

/**
 * Wide fader with its label inside, easy to use without looking. A vertical swipe stays
 * with the scrolling panel behind it: the fader only takes over once the finger clearly
 * moves sideways, and a tap jumps. Colour faders (gradient) have a thin track and a thumb.
 */
export function Slider({
  label, value, min = 0, max = 255, step = 1, onChange, onEnd, format, gradient, tint, compact,
}: {
  label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void;
  onEnd?: (v: number) => void; format?: (v: number) => string; gradient?: readonly string[]; tint?: string; compact?: boolean;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const latest = useRef({ value, min, max, step, onChange, onEnd, width: 1, start: 0, last: value });
  Object.assign(latest.current, { value, min, max, step, onChange, onEnd });

  const update = (raw: number) => {
    const p = latest.current;
    const v = Math.min(p.max, Math.max(p.min, Math.round(raw / p.step) * p.step));
    if (v !== p.last) {
      p.last = v;
      setLocal(v);
      p.onChange(v);
    }
  };

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 5 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
    onPanResponderGrant: () => {
      latest.current.start = latest.current.value;
      latest.current.last = latest.current.value;
    },
    onPanResponderMove: (_, g) => {
      const p = latest.current;
      update(p.start + (g.dx / p.width) * (p.max - p.min));
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: () => {
      latest.current.onEnd?.(latest.current.last);
      setLocal(null);
    },
    onPanResponderTerminate: () => setLocal(null),
  }), []);

  const shown = local ?? value;
  const ratio = max > min ? Math.min(1, Math.max(0, (shown - min) / (max - min))) : 0;
  const text = format ? format(shown) : `${Math.round(ratio * 100)} %`;
  const onLayout = (e: LayoutChangeEvent) => { latest.current.width = Math.max(1, e.nativeEvent.layout.width); };
  const onTap = (e: GestureResponderEvent) => {
    const p = latest.current;
    p.last = p.value;
    update(p.min + (e.nativeEvent.locationX / p.width) * (p.max - p.min));
    p.onEnd?.(p.last);
    setLocal(null);
  };

  return (
    <View style={{ gap: space.xs }} accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const delta = (max - min) / 20;
        const next = Math.min(max, Math.max(min, value + (e.nativeEvent.actionName === 'increment' ? delta : -delta)));
        onChange(next);
        onEnd?.(next);
      }}>
      {gradient ? (
        <View style={styles.sliderHead}>
          <Text numberOfLines={1} style={[type.label, { flex: 1 }]}>{label}</Text>
          <Text style={type.value}>{text}</Text>
        </View>
      ) : null}
      <View {...responder.panHandlers} onLayout={onLayout}>
        {gradient ? (
          <Pressable onPress={onTap} style={styles.colorHit}>
            <View pointerEvents="none" style={styles.colorTrack}>
              <LinearGradient colors={gradient as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
            </View>
            <View pointerEvents="none" style={[styles.colorThumb, { left: `${ratio * 100}%` }]} />
          </Pressable>
        ) : (
          <Pressable onPress={onTap} style={[styles.fader, compact && { height: 40 }]}>
            <View pointerEvents="none" style={[styles.faderFill, { width: `${ratio * 100}%` }, tint ? { backgroundColor: tint, opacity: 0.55 } : null]} />
            <View pointerEvents="none" style={[styles.faderEdge, { left: `${ratio * 100}%` }]} />
            <View pointerEvents="none" style={styles.faderText}>
              <Text numberOfLines={1} style={styles.faderLabel}>{label}</Text>
              <Text style={styles.faderValue}>{text}</Text>
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function EmptyState({ icon, title, text, children }: { icon: string; title: string; text?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={36} color={colors.textMute} />
      <Text style={[type.heading, { textAlign: 'center' }]}>{title}</Text>
      {text ? <Text style={[type.body, { color: colors.textDim, textAlign: 'center' }]}>{text}</Text> : null}
      {children}
    </View>
  );
}

export function Notice({ tone = 'info', icon, children }: { tone?: 'info' | 'warning' | 'danger'; icon?: string; children: ReactNode }) {
  const color = tone === 'danger' ? colors.danger : tone === 'warning' ? colors.warning : colors.textDim;
  return (
    <View style={[styles.notice, tone === 'danger' && { backgroundColor: colors.dangerSoft }]}>
      <Icon name={icon ?? (tone === 'info' ? 'information-outline' : 'alert-outline')} size={18} color={color} />
      <Text style={{ flex: 1, color: tone === 'info' ? colors.textDim : color, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 46, paddingHorizontal: space.xl, borderRadius: radius.pill, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: space.sm,
  },
  iconButton: { width: touch, height: touch, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  chip: {
    minHeight: 40, paddingHorizontal: space.lg, borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent',
    backgroundColor: colors.surface2, flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 280,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  card: { backgroundColor: colors.surface2, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  input: {
    minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', backgroundColor: colors.surface2,
    color: colors.text, fontSize: 16, paddingHorizontal: space.lg,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface2, borderRadius: radius.pill, padding: 3, gap: 2 },
  segment: {
    flex: 1, minHeight: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 5, paddingHorizontal: 6,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: radius.pill },
  stepperValue: { flex: 1, textAlign: 'center', paddingVertical: 8, color: colors.text },
  sliderHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fader: { height: 48, borderRadius: radius.md, backgroundColor: colors.surface2, overflow: 'hidden', justifyContent: 'center' },
  faderFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.faderFill },
  faderEdge: { position: 'absolute', top: 10, bottom: 10, width: 3, marginLeft: -5, borderRadius: 2, backgroundColor: colors.text },
  faderText: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, gap: space.md },
  faderLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '500' },
  faderValue: { color: colors.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  colorHit: { height: 40, justifyContent: 'center' },
  colorTrack: { height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: colors.surface3 },
  colorThumb: {
    position: 'absolute', width: 28, height: 28, borderRadius: 14, marginLeft: -14, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.lg },
  notice: { flexDirection: 'row', gap: space.sm, backgroundColor: colors.surface2, borderRadius: radius.md, padding: space.md },
});

import { ExpoWebGLRenderingContext, GLView } from 'expo-gl';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, GestureResponderEvent, LayoutChangeEvent, PanResponder, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '../lib/api';
import { dmxFrame, useApp } from '../lib/store';
import { colors, radius, space, touch } from '../theme';
import { Icon } from '../ui';
import { StageRenderer, ViewPreset } from './StageRenderer';

const VIEWS: { key: ViewPreset; label: string; icon: string }[] = [
  { key: 'front', label: 'Face', icon: 'theater' },
  { key: 'top', label: 'Haut', icon: 'arrow-collapse-down' },
  { key: 'left', label: 'Gauche', icon: 'rotate-left' },
  { key: 'right', label: 'Droite', icon: 'rotate-right' },
];

const MIN_FRAME_MS = 20;
const IDLE_RATIO = 0.6;

// The picture is drawn below screen resolution when needed, then scaled up: every pixel runs
// the whole lighting shader, and a scene full of soft light loses little from it.
const MAX_BUFFER_PIXELS = 2_000_000;
const SLOW_FRAME_MS = 70;
const FRAMES_TO_JUDGE = 6;
const SCALE_STEP = 0.7;
const MIN_SCALE = 0.5;
/** Kept between mounts: a device found too slow once stays at the resolution it can draw. */
let adaptiveScale = 1;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pending'; x: number; y: number; hit: string | null; t: number }
  | { kind: 'orbit'; x: number; y: number }
  | { kind: 'drag'; id: string }
  | { kind: 'pinch'; dist: number; cx: number; cy: number };

export interface StageInsets { top: number; left: number; right: number; bottom: number }
const NO_INSETS: StageInsets = { top: 0, left: 0, right: 0, bottom: 0 };

/** The 3D view: everything shown comes from the DMX values actually sent out. */
export function StageView({ insets = NO_INSETS }: { insets?: StageInsets }) {
  const rendererRef = useRef<StageRenderer | null>(null);
  const raf = useRef<number | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layout = useRef({ w: 1, h: 1, pageX: 0, pageY: 0 });
  const container = useRef<React.ComponentRef<typeof View>>(null);
  const remount = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<Gesture>({ kind: 'none' });
  const labelPos = useRef(new Animated.ValueXY({ x: -200, y: -200 })).current;
  const [glKey, setGlKey] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(adaptiveScale);
  const costs = useRef<number[]>([]);
  const [activeView, setActiveView] = useState<ViewPreset>('front');

  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const fixtures = useApp((s) => s.fixtures);
  const stage = useApp((s) => s.stage);
  const selected = fixtures.find((f) => f.id === selection[0]);

  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  useEffect(() => { rendererRef.current?.setInsets(insets); }, [insets.top, insets.left, insets.right, insets.bottom]);
  useEffect(() => { if (stage) rendererRef.current?.setStage(stage); }, [stage]);
  useEffect(() => { rendererRef.current?.setFixtures(fixtures); }, [fixtures]);
  useEffect(() => { rendererRef.current?.setSelection(selection); }, [selection]);
  const stopLoop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    if (idle.current !== null) clearTimeout(idle.current);
  };
  useEffect(() => stopLoop, []);

  /** Lowers the resolution when the last frames were all too slow. */
  const watchCost = (cost: number) => {
    const recent = costs.current;
    recent.push(cost);
    if (recent.length < FRAMES_TO_JUDGE) return;
    const slow = recent.every((c) => c > SLOW_FRAME_MS);
    recent.length = 0;
    if (slow && adaptiveScale > MIN_SCALE) {
      adaptiveScale = Math.max(MIN_SCALE, adaptiveScale * SCALE_STEP);
      setScale(adaptiveScale);
    }
  };

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    stopLoop();
    const view = rendererRef.current?.saveView();
    const renderer = new StageRenderer(gl);
    rendererRef.current = renderer;
    renderer.setSize(layout.current.w, layout.current.h);
    renderer.setInsets(insetsRef.current);
    const state = useApp.getState();
    if (state.stage) renderer.setStage(state.stage);
    renderer.setFixtures(state.fixtures);
    renderer.setSelection(state.selection);
    if (view) renderer.restoreView(view);

    const loop = (time: number) => {
      const started = Date.now();
      renderer.render(time, dmxFrame);
      const id = useApp.getState().selection[0];
      const at = id ? renderer.screenOf(id) : null;
      if (at?.visible) labelPos.setValue({ x: at.x, y: at.y });
      else labelPos.setValue({ x: -200, y: -200 });

      // The controls come first: however slow the GPU, the JS thread keeps time for touches.
      const cost = Date.now() - started;
      watchCost(cost);
      if (cost < MIN_FRAME_MS) raf.current = requestAnimationFrame(loop);
      else idle.current = setTimeout(() => { raf.current = requestAnimationFrame(loop); }, cost * IDLE_RATIO);
    };
    raf.current = requestAnimationFrame(loop);
  }, [labelPos]);

  // The drawing buffer has the size the view had when the context was created, so a
  // rotation or a split change gets a new context instead of a stretched picture.
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const previous = layout.current;
    layout.current = { ...previous, w: width, h: height };
    container.current?.measureInWindow((x, y) => { layout.current.pageX = x; layout.current.pageY = y; });
    if (!size) setSize({ w: width, h: height });
    else if (Math.abs(previous.w - width) > 1 || Math.abs(previous.h - height) > 1) {
      // Debounced: dragging the divider must not rebuild the context at every pixel.
      if (remount.current) clearTimeout(remount.current);
      remount.current = setTimeout(() => {
        setSize({ w: width, h: height });
        setGlKey((k) => k + 1);
      }, 180);
    }
  };

  const touchPos = (e: GestureResponderEvent) => {
    const t = e.nativeEvent;
    return { x: t.pageX - layout.current.pageX, y: t.pageY - layout.current.pageY };
  };

  const moveFixture = (id: string, x: number, y: number) => {
    const placement = rendererRef.current?.dragTo(id, x, y);
    const state = useApp.getState();
    const fixture = state.fixtures.find((f) => f.id === id);
    if (placement && fixture) state.localFixture({ ...fixture, placement });
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { x, y } = touchPos(e);
      gesture.current = { kind: 'pending', x, y, hit: rendererRef.current?.pick(x, y) ?? null, t: Date.now() };
    },
    onPanResponderMove: (e) => {
      const r = rendererRef.current;
      if (!r) return;
      const touches = e.nativeEvent.touches;
      if (touches.length >= 2) {
        const [a, b] = touches;
        const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
        const cx = (a.pageX + b.pageX) / 2;
        const cy = (a.pageY + b.pageY) / 2;
        const g = gesture.current;
        if (g.kind === 'pinch') {
          r.zoomBy(dist / Math.max(1, g.dist));
          r.panBy(cx - g.cx, cy - g.cy);
        }
        gesture.current = { kind: 'pinch', dist, cx, cy };
        return;
      }
      const { x, y } = touchPos(e);
      const g = gesture.current;
      if (g.kind === 'pending') {
        if (Math.hypot(x - g.x, y - g.y) < 7) return;
        const state = useApp.getState();
        if (state.tool === 'place' && g.hit) {
          state.select([g.hit]);
          Haptics.selectionAsync().catch(() => {});
          gesture.current = { kind: 'drag', id: g.hit };
        } else {
          gesture.current = { kind: 'orbit', x: g.x, y: g.y };
        }
      }
      const current = gesture.current;
      if (current.kind === 'orbit') {
        r.orbit(x - current.x, y - current.y);
        gesture.current = { kind: 'orbit', x, y };
      } else if (current.kind === 'drag') {
        moveFixture(current.id, x, y);
      }
    },
    onPanResponderRelease: () => {
      const g = gesture.current;
      gesture.current = { kind: 'none' };
      const state = useApp.getState();
      if (g.kind === 'pending') {
        // A tap selects, or clears the selection when it lands on nothing.
        state.select(g.hit ? [g.hit] : []);
        if (g.hit) Haptics.selectionAsync().catch(() => {});
      } else if (g.kind === 'drag') {
        const fixture = state.fixtures.find((f) => f.id === g.id);
        if (fixture) {
          api.updateFixture(fixture).catch((err) => useApp.setState({ error: err.message }));
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      }
    },
    onPanResponderTerminate: () => { gesture.current = { kind: 'none' }; },
  }), []);

  const setView = (v: ViewPreset) => {
    setActiveView(v);
    rendererRef.current?.setPreset(v);
  };

  const toggleTool = () => useApp.getState().set({ tool: tool === 'place' ? 'view' : 'place' });

  return (
    <View ref={container} style={styles.root} onLayout={onLayout}>
      {size ? (() => {
        const density = PixelRatio.get();
        const fit = Math.min(1, Math.sqrt(MAX_BUFFER_PIXELS / (size.w * size.h * density * density)));
        const s = fit * scale;
        const w = size.w * s;
        const h = size.h * s;
        return (
          <GLView
            key={`${glKey}-${s}`}
            style={{
              position: 'absolute', left: 0, top: 0, width: w, height: h,
              transform: [{ translateX: (size.w - w) / 2 }, { translateY: (size.h - h) / 2 }, { scale: 1 / s }],
            }}
            onContextCreate={onContextCreate}
            msaaSamples={s === 1 ? 4 : 0}
          />
        );
      })() : null}
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} accessibilityLabel="Vue 3D de la scène" />

      {selected ? (
        <Animated.View pointerEvents="none" style={[styles.label, { transform: labelPos.getTranslateTransform() }]}>
          <Text numberOfLines={1} style={styles.labelText}>{selection.length > 1 ? `${selection.length} appareils` : selected.name}</Text>
        </Animated.View>
      ) : null}

      <View style={[styles.views, { top: insets.top + space.sm, right: insets.right + space.md }]} pointerEvents="box-none">
        {VIEWS.map((v) => (
          <Pressable key={v.key} accessibilityRole="button" accessibilityLabel={`Vue ${v.label}`} accessibilityState={{ selected: activeView === v.key }}
            onPress={() => setView(v.key)} style={[styles.viewButton, activeView === v.key && styles.viewActive]}>
            <Text style={[styles.viewText, activeView === v.key && { color: colors.text }]}>{v.label}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Déplacer les appareils" accessibilityState={{ selected: tool === 'place' }}
        onPress={toggleTool} style={[styles.place, { bottom: insets.bottom + space.md, right: insets.right + space.md }, tool === 'place' && styles.placeOn]}>
        <Icon name="cursor-move" size={18} color={tool === 'place' ? colors.onAccent : colors.text} />
        <Text style={{ color: tool === 'place' ? colors.onAccent : colors.text, fontSize: 13, fontWeight: '600' }}>
          {tool === 'place' ? 'Placement actif' : 'Placer'}
        </Text>
      </Pressable>

      {tool === 'place' ? (
        <View pointerEvents="none" style={[styles.hint, { left: insets.left + space.md, bottom: insets.bottom + space.md + 8 }]}>
          <Text style={styles.hintText}>Glisse un appareil sur le LT3, le T ou le sol</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050608', overflow: 'hidden' },
  label: {
    position: 'absolute', left: 0, top: 0, marginTop: 22, marginLeft: -60, width: 120, alignItems: 'center',
  },
  labelText: {
    color: colors.onAccent, backgroundColor: colors.accent, fontSize: 11, fontWeight: '700', paddingHorizontal: 6,
    paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  views: {
    position: 'absolute', flexDirection: 'row', backgroundColor: colors.scrim,
    borderRadius: radius.pill, padding: 3,
  },
  viewButton: { minHeight: 36, minWidth: 48, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  viewActive: { backgroundColor: 'rgba(255,255,255,0.16)' },
  viewText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  place: {
    position: 'absolute', minHeight: touch, paddingHorizontal: space.lg,
    borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.scrim,
  },
  placeOn: { backgroundColor: colors.accent },
  hint: { position: 'absolute', backgroundColor: colors.scrim, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6, maxWidth: '58%' },
  hintText: { color: colors.text, fontSize: 13 },
});

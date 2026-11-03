import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { lookColor } from './lib/dmx';
import { PanelWidth, useLayout } from './lib/layout';
import { control, Tab, useApp } from './lib/store';
import { FixturesPanel } from './panels/FixturesPanel';
import { LivePanel } from './panels/LivePanel';
import { ScenesPanel } from './panels/ScenesPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { StageView } from './stage/StageView';
import { colors, radius, space, touch, type } from './theme';
import { Scene } from './types';
import { Button, Icon, Slider } from './ui';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'fixtures', label: 'Appareils', icon: 'spotlight' },
  { key: 'live', label: 'Live', icon: 'tune-variant' },
  { key: 'scenes', label: 'Scènes', icon: 'movie-open-outline' },
  { key: 'settings', label: 'Réglages', icon: 'cog-outline' },
];

const MIN_STAGE_RATIO = 0.24;
const MAX_STAGE_RATIO = 0.72;
const GUTTER = space.md;
const TOP_BAR = 56;
const DOCK = 76;

export function Shell() {
  const { tablet, landscape } = useLayout();
  if (tablet) return <TabletShell />;
  return landscape ? <PhoneLandscape /> : <PhonePortrait />;
}

function usePanel() {
  const tab = useApp((s) => s.tab);
  const loaded = useApp((s) => s.loaded);
  return !loaded ? <Connecting /> : <ActivePanel tab={tab} />;
}

/**
 * Tablet: the stage fills the screen and everything floats above it. A wide panel in
 * landscape, the same panel above the stage in portrait, and a dock always within reach.
 */
function TabletShell() {
  const { width, height, landscape } = useLayout();
  const insets = useSafeAreaInsets();
  const panel = usePanel();
  const tab = useApp((s) => s.tab);
  const set = useApp((s) => s.set);
  const [collapsed, setCollapsed] = useState(false);
  const [ratio, setRatio] = useState(0.5);

  const top = insets.top + GUTTER + TOP_BAR + GUTTER;
  const bottom = Math.max(insets.bottom, GUTTER) + DOCK + GUTTER;
  const left = Math.max(insets.left, GUTTER);
  const right = Math.max(insets.right, GUTTER);
  const available = height - top - bottom;

  const panelWidth = landscape ? Math.min(480, Math.max(400, width * 0.36)) : width - left - right;
  const panelHeight = landscape ? available : Math.round(available * ratio);
  const stageInsets = collapsed
    ? { top, left: 0, right: 0, bottom }
    : landscape
      ? { top, left: left + panelWidth + GUTTER, right: 0, bottom }
      : { top: top + panelHeight + GUTTER, left: 0, right: 0, bottom };

  // Touching the current tab again hides the panel, to look at the stage.
  const onTab = (key: Tab) => {
    if (key === tab) setCollapsed(!collapsed);
    else {
      setCollapsed(false);
      set({ tab: key });
    }
  };

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill}><StageView insets={stageInsets} /></View>

      <View pointerEvents="box-none" style={[styles.topBar, { top: insets.top + GUTTER, left, right }]}>
        <Text style={styles.brand}>Lumières</Text>
        <View style={styles.floatingNav}>
          {TABS.map((t) => (
            <Pressable key={t.key} accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: tab === t.key && !collapsed }}
              onPress={() => onTab(t.key)} style={[styles.navItem, tab === t.key && !collapsed && styles.navItemActive]}>
              <Icon name={t.icon} size={18} color={tab === t.key && !collapsed ? colors.onAccent : colors.textDim} />
              <Text style={[styles.navText, tab === t.key && !collapsed && { color: colors.onAccent }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.topRight}><StatusPills /></View>
      </View>

      {!collapsed ? (
        <PanelWidth.Provider value={panelWidth}>
          <View style={[styles.floatingPanel, { top, left, width: panelWidth, height: panelHeight }]}>{panel}</View>
        </PanelWidth.Provider>
      ) : null}
      {!collapsed && !landscape ? (
        <View style={{ position: 'absolute', top: top + panelHeight - 2, left: 0, right: 0 }}>
          <Divider height={available} ratio={ratio} invert={false} onChange={setRatio} />
        </View>
      ) : null}

      <View style={[styles.dock, { left, right, bottom: Math.max(insets.bottom, GUTTER), height: DOCK }]}>
        <BlackoutButton />
        <View style={{ width: Math.min(280, width * 0.24) }}>
          <MasterFader />
        </View>
        <View style={styles.dockDivider} />
        <ScenePads />
      </View>
      <Toast top={insets.top + GUTTER + TOP_BAR + GUTTER} />
      <DisconnectedBanner top={insets.top + GUTTER + TOP_BAR} />
    </View>
  );
}

/** Phone upright: controls on top, the stage underneath with a movable divider. */
function PhonePortrait() {
  const { width, height } = useLayout();
  const insets = useSafeAreaInsets();
  const panel = usePanel();
  const tab = useApp((s) => s.tab);
  const set = useApp((s) => s.set);
  const [ratio, setRatio] = useState(0.38);

  return (
    <View style={styles.root}>
      <View style={{ paddingTop: insets.top + space.xs, paddingHorizontal: GUTTER, paddingBottom: space.sm }}>
        <View style={styles.phoneTabs}>
          {TABS.map((t) => (
            <Pressable key={t.key} accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: tab === t.key }}
              onPress={() => set({ tab: t.key })} style={[styles.phoneTab, tab === t.key && styles.navItemActive]}>
              <Icon name={t.icon} size={18} color={tab === t.key ? colors.onAccent : colors.textDim} />
              <Text numberOfLines={1} style={[styles.phoneTabText, tab === t.key && { color: colors.onAccent }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <DisconnectedBanner />
      <PanelWidth.Provider value={width}>
        <View style={{ flex: 1 }}>{panel}</View>
      </PanelWidth.Provider>
      <Divider height={height} ratio={ratio} invert onChange={setRatio} />
      <View style={styles.phoneBar}>
        <BlackoutButton compact />
        <View style={{ flex: 1 }}><MasterFader compact /></View>
        <PlayingChip />
      </View>
      <View style={{ height: Math.round(height * ratio) }}><StageView /></View>
      <View style={{ height: insets.bottom, backgroundColor: colors.bg }} />
      <Toast top={insets.top + 64} />
    </View>
  );
}

/** Phone on its side: rail, panel, then the stage. Height is what is scarce here. */
function PhoneLandscape() {
  const { width } = useLayout();
  const insets = useSafeAreaInsets();
  const panel = usePanel();
  const tab = useApp((s) => s.tab);
  const set = useApp((s) => s.set);
  const panelWidth = Math.min(Math.max(300, width * 0.42), 420);

  return (
    <View style={[styles.root, { flexDirection: 'row' }]}>
      <View style={[styles.rail, { paddingLeft: insets.left, paddingTop: insets.top + space.xs, paddingBottom: Math.max(insets.bottom, space.xs) }]}>
        {TABS.map((t) => (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: tab === t.key }}
            onPress={() => set({ tab: t.key })} style={[styles.railButton, tab === t.key && styles.navItemActive]}>
            <Icon name={t.icon} size={20} color={tab === t.key ? colors.onAccent : colors.textDim} />
            <Text numberOfLines={1} style={[styles.railText, tab === t.key && { color: colors.onAccent }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ width: panelWidth, paddingTop: insets.top, backgroundColor: colors.surface }}>
        <DisconnectedBanner />
        <PanelWidth.Provider value={panelWidth}>
          <View style={{ flex: 1 }}>{panel}</View>
        </PanelWidth.Provider>
      </View>
      <View style={{ flex: 1 }}>
        <View style={[styles.phoneBar, { paddingTop: insets.top + space.xs, paddingRight: Math.max(insets.right, space.sm) }]}>
          <BlackoutButton compact />
          <View style={{ flex: 1 }}><MasterFader compact /></View>
          <PlayingChip />
        </View>
        <View style={{ flex: 1 }}><StageView /></View>
      </View>
      <Toast top={insets.top + 64} />
    </View>
  );
}

function ActivePanel({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'fixtures': return <FixturesPanel />;
    case 'live': return <LivePanel />;
    case 'scenes': return <ScenesPanel />;
    case 'settings': return <SettingsPanel />;
  }
}

function Connecting() {
  const connection = useApp((s) => s.connection);
  const set = useApp((s) => s.set);
  return (
    <View style={styles.connecting}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[type.body, { textAlign: 'center', color: colors.textDim }]}>
        {connection === 'offline' ? 'Serveur injoignable. Vérifie qu\'il tourne et que tu es sur le même Wi-Fi.' : 'Connexion au serveur…'}
      </Text>
      {connection === 'offline' ? <Button compact label="Changer l'adresse du serveur" onPress={() => set({ loaded: true, tab: 'settings' })} /> : null}
    </View>
  );
}

function Toast({ top }: { top: number }) {
  const error = useApp((s) => s.error);
  const set = useApp((s) => s.set);
  // Errors reach the user wherever they are, and clear on their own.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => set({ error: null }), 5000);
    return () => clearTimeout(t);
  }, [error]);
  if (!error) return null;
  return (
    <Pressable onPress={() => set({ error: null })} style={[styles.toast, { top }]}>
      <Text style={styles.toastText}>{error}</Text>
    </Pressable>
  );
}

function DisconnectedBanner({ top }: { top?: number }) {
  const connection = useApp((s) => s.connection);
  const loaded = useApp((s) => s.loaded);
  if (connection === 'online' || !loaded) return null;
  return (
    <View style={[styles.banner, top !== undefined && styles.bannerFloating, top !== undefined && { top }]}>
      <Icon name="lan-disconnect" size={16} color={colors.onAccent} />
      <Text style={styles.bannerText}>Serveur déconnecté, reconnexion en cours</Text>
    </View>
  );
}

function StatusPills() {
  const status = useApp((s) => s.status);
  const online = !!status?.output.online;
  return (
    <View accessibilityLabel={online ? 'Passerelle DMX connectée' : 'Passerelle DMX non détectée'} style={styles.statusPill}>
      <View style={[styles.statusDot, { backgroundColor: online ? colors.success : colors.warning }]} />
      <Text style={styles.statusText}>{online ? 'DMX connecté' : 'DMX non détecté'}</Text>
    </View>
  );
}

function BlackoutButton({ compact }: { compact?: boolean }) {
  const blackout = useApp((s) => !!s.status?.blackout);
  const toggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    control.blackout(!blackout);
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={blackout ? 'Rallumer, blackout actif' : 'Blackout : tout couper'} accessibilityState={{ selected: blackout }}
      onPress={toggle} style={[styles.blackout, compact && styles.blackoutCompact, blackout && { backgroundColor: colors.danger }]}>
      <Icon name="power" size={20} color={blackout ? '#fff' : colors.danger} />
      {compact ? null : <Text style={{ color: blackout ? '#fff' : colors.danger, fontSize: 14, fontWeight: '700' }}>{blackout ? 'Rallumer' : 'Blackout'}</Text>}
    </Pressable>
  );
}

function MasterFader({ compact }: { compact?: boolean }) {
  const master = useApp((s) => s.status?.master ?? 1);
  return <Slider compact={compact} label="Master" value={master} min={0} max={1} step={0.01} onChange={(v) => control.master(v)} />;
}

function PlayingChip() {
  const playback = useApp((s) => s.status?.playback);
  const scenes = useApp((s) => s.scenes);
  const online = useApp((s) => !!s.status?.output.online);
  const scene = playback ? scenes.find((x) => x.id === playback.sceneId) : undefined;
  if (playback && scene) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Arrêter ${scene.name}`} onPress={() => control.stop()} style={styles.playingChip}>
        <Icon name="stop" size={18} color={scene.color} />
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{scene.name}</Text>
      </Pressable>
    );
  }
  return <View accessibilityLabel={online ? 'Passerelle DMX connectée' : 'Passerelle DMX non détectée'} style={[styles.statusDot, { backgroundColor: online ? colors.success : colors.warning, marginHorizontal: 6 }]} />;
}

/** The scenes, one touch away during the show. */
function ScenePads() {
  const scenes = useApp((s) => s.scenes);
  const playback = useApp((s) => s.status?.playback);
  const set = useApp((s) => s.set);
  if (scenes.length === 0) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Créer une scène" onPress={() => set({ tab: 'scenes' })} style={styles.noScene}>
        <Icon name="plus" size={18} />
        <Text style={type.label}>Crée une scène pour la lancer d'ici</Text>
      </Pressable>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.pads}>
      {scenes.map((scene) => <ScenePad key={scene.id} scene={scene} playing={playback?.sceneId === scene.id} progress={playback?.sceneId === scene.id ? playback : undefined} />)}
    </ScrollView>
  );
}

function ScenePad({ scene, playing, progress }: {
  scene: Scene; playing: boolean; progress?: { stepIndex: number; stepCount: number; stepElapsedMs: number; stepDurationMs: number };
}) {
  const stops = scene.steps.map((s) => Object.values(s.looks).map(lookColor).find(Boolean) ?? null).filter(Boolean) as string[];
  const gradient = stops.length >= 2 ? stops : [stops[0] ?? scene.color, stops[0] ?? scene.color];
  const fraction = progress ? (progress.stepIndex + Math.min(1, progress.stepElapsedMs / Math.max(1, progress.stepDurationMs))) / Math.max(1, progress.stepCount) : 0;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={playing ? `Arrêter ${scene.name}` : `Lancer ${scene.name}`} accessibilityState={{ selected: playing }}
      onPress={() => (playing ? control.stop() : control.play(scene.id))}
      style={({ pressed }) => [styles.pad, playing && styles.padPlaying, pressed && { opacity: 0.8 }]}>
      <LinearGradient colors={gradient as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[StyleSheet.absoluteFill, { opacity: playing ? 0.9 : 0.35 }]} />
      <Icon name={playing ? 'stop' : 'play'} size={16} color="#fff" />
      <Text numberOfLines={1} style={styles.padText}>{scene.name}</Text>
      {playing ? <View style={[styles.padProgress, { width: `${fraction * 100}%` }]} /> : null}
    </Pressable>
  );
}

function Divider({ height, ratio, invert, onChange }: { height: number; ratio: number; invert: boolean; onChange: (r: number) => void }) {
  const start = useRef(ratio);
  const latest = useRef({ ratio, height, onChange, invert });
  latest.current = { ratio, height, onChange, invert };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { start.current = latest.current.ratio; },
    onPanResponderMove: (_, g) => {
      const { invert: up, height: h } = latest.current;
      const next = start.current + (up ? -g.dy : g.dy) / h;
      latest.current.onChange(Math.min(MAX_STAGE_RATIO, Math.max(MIN_STAGE_RATIO, next)));
    },
  }), []);
  return (
    <View {...responder.panHandlers} accessibilityLabel="Redimensionner la vue 3D" style={styles.divider}>
      <View style={styles.dividerGrip} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { position: 'absolute', height: TOP_BAR, flexDirection: 'row', alignItems: 'center' },
  brand: { flex: 1, color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  topRight: { flex: 1, alignItems: 'flex-end' },
  floatingNav: { flexDirection: 'row', backgroundColor: colors.glass, borderRadius: radius.pill, padding: 4, gap: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  navItem: { minHeight: touch, paddingHorizontal: space.lg, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  navItemActive: { backgroundColor: colors.accent },
  navText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, height: touch, paddingHorizontal: space.lg, borderRadius: radius.pill,
    backgroundColor: colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.textDim, fontSize: 13, fontWeight: '500' },
  floatingPanel: {
    position: 'absolute', backgroundColor: colors.glass, borderRadius: radius.xl, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  dock: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, backgroundColor: colors.glass,
    borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  dockDivider: { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: colors.border },
  pads: { gap: space.sm, alignItems: 'center', paddingRight: space.sm },
  pad: {
    height: 52, minWidth: 120, maxWidth: 220, paddingHorizontal: space.lg, borderRadius: radius.md, overflow: 'hidden', flexDirection: 'row',
    alignItems: 'center', gap: space.sm, backgroundColor: colors.surface2,
  },
  padPlaying: { borderWidth: 2, borderColor: colors.text },
  padText: { color: '#fff', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  padProgress: { position: 'absolute', left: 0, bottom: 0, height: 3, backgroundColor: '#fff' },
  noScene: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch },
  blackout: {
    height: 52, paddingHorizontal: space.lg, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center',
    gap: space.sm, backgroundColor: colors.dangerSoft,
  },
  blackoutCompact: { height: 40, width: 48, paddingHorizontal: 0, justifyContent: 'center' },
  phoneTabs: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3 },
  phoneTab: { flex: 1, minHeight: 40, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 2 },
  phoneTabText: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
  phoneBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm, backgroundColor: colors.bg },
  playingChip: { height: 40, maxWidth: '32%', paddingHorizontal: space.md, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface2 },
  rail: { backgroundColor: colors.bg, alignItems: 'center', gap: space.xs, paddingHorizontal: 6 },
  railButton: { width: 64, minHeight: 50, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.md },
  railText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
  divider: { height: 18, alignItems: 'center', justifyContent: 'center' },
  dividerGrip: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.surface3 },
  banner: { flexDirection: 'row', gap: space.sm, alignItems: 'center', backgroundColor: colors.warning, paddingHorizontal: space.md, paddingVertical: 6 },
  bannerFloating: { position: 'absolute', alignSelf: 'center', borderRadius: radius.pill, paddingHorizontal: space.lg },
  bannerText: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  toast: {
    position: 'absolute', alignSelf: 'center', backgroundColor: colors.danger, borderRadius: radius.md,
    padding: space.md, marginHorizontal: space.lg, maxWidth: 520,
  },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  connecting: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
});

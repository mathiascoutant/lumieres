import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../lib/api';
import { lookColor } from '../lib/dmx';
import { useColumns } from '../lib/layout';
import { control, useApp } from '../lib/store';
import { colors, radius, sceneColors, space, type } from '../theme';
import { Fixture, Look, Scene, Step } from '../types';
import { Button, Chip, EmptyState, Field, Icon, IconButton, Notice, Section, Slider, Stepper, ToggleRow } from '../ui';
import { FixtureControls } from './FixtureControls';

export function ScenesPanel() {
  const route = useApp((s) => s.sceneRoute);
  const set = useApp((s) => s.set);
  if (route.name === 'edit') return <SceneEditor id={route.id} onClose={() => set({ sceneRoute: { name: 'list' } })} />;
  return <SceneList />;
}

const seconds = (ms: number) => {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
};

const newId = () => Math.random().toString(36).slice(2, 10);

function newStep(index: number, looks: Look = {}): Step {
  return { id: newId(), name: `Étape ${index + 1}`, durationMs: 5000, fadeMs: 500, looks };
}

function SceneList() {
  const scenes = useApp((s) => s.scenes);
  const playback = useApp((s) => s.status?.playback ?? null);
  const set = useApp((s) => s.set);
  const fixtures = useApp((s) => s.fixtures);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { itemWidth } = useColumns(170);

  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      const scene = await api.createScene({
        name: clean, color: sceneColors[scenes.length % sceneColors.length], loop: true, steps: [newStep(0)],
      });
      useApp.getState().localScene(scene);
      setName('');
      setCreating(false);
      set({ sceneRoute: { name: 'edit', id: scene.id } });
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Scènes</Text>
      {creating ? (
        <View style={{ gap: space.sm }}>
          <Field label="Nom de la scène" value={name} onChangeText={setName} placeholder="ex. Repas" autoFocus />
          <View style={styles.pair}>
            <Button style={{ flex: 1 }} label="Annuler" onPress={() => setCreating(false)} />
            <Button style={{ flex: 1 }} kind="primary" label="Créer" disabled={!name.trim()} onPress={create} />
          </View>
        </View>
      ) : (
        <Button kind="primary" icon="plus" label="Nouvelle scène" onPress={() => setCreating(true)} />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {scenes.length === 0 && !creating ? (
        <EmptyState icon="movie-open-outline" title="Pas encore de scène"
          text={fixtures.length ? 'Crée « Repas » par exemple : bleu 5 secondes, puis vert, et ainsi de suite.' : 'Ajoute tes appareils, puis crée « Repas » par exemple : bleu 5 secondes, puis vert.'} />
      ) : null}

      <View style={styles.padGrid}>
        {scenes.map((scene) => {
          const playing = playback?.sceneId === scene.id;
          const total = scene.steps.reduce((sum, st) => sum + st.durationMs, 0);
          const stops = scene.steps.map(stepColor).filter(Boolean) as string[];
          const gradient = stops.length >= 2 ? stops : [stops[0] ?? scene.color, stops[0] ?? scene.color];
          const fraction = playing && playback
            ? (playback.stepIndex + Math.min(1, playback.stepElapsedMs / Math.max(1, playback.stepDurationMs))) / Math.max(1, playback.stepCount)
            : 0;
          return (
            <Pressable key={scene.id} accessibilityRole="button" accessibilityLabel={playing ? `Arrêter ${scene.name}` : `Lancer ${scene.name}`}
              onPress={() => (playing ? control.stop() : control.play(scene.id))}
              style={({ pressed }) => [styles.pad, { width: itemWidth }, playing && styles.padPlaying, pressed && { opacity: 0.85 }]}>
              <LinearGradient colors={gradient as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { opacity: playing ? 1 : 0.7 }]} />
              <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.72)']} style={StyleSheet.absoluteFill} />
              <View style={styles.padTop}>
                <View style={styles.padPlay}><Icon name={playing ? 'stop' : 'play'} size={22} color="#fff" /></View>
                <IconButton icon="pencil-outline" size={18} color="#fff" label={`Modifier ${scene.name}`} onPress={() => set({ sceneRoute: { name: 'edit', id: scene.id } })} />
              </View>
              <View>
                <Text numberOfLines={1} style={styles.padTitle}>{scene.name}</Text>
                <Text numberOfLines={1} style={styles.padInfo}>
                  {playing && playback
                    ? (playback.finished ? 'Dernière étape maintenue' : `Étape ${playback.stepIndex + 1} sur ${playback.stepCount}`)
                    : `${scene.steps.length} étape${scene.steps.length > 1 ? 's' : ''} · ${seconds(total)}${scene.loop ? ' · boucle' : ''}`}
                </Text>
              </View>
              {playing ? <View style={[styles.padProgress, { width: `${fraction * 100}%` }]} /> : null}
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function stepColor(step: Step): string | null {
  for (const id of Object.keys(step.looks)) {
    const c = lookColor(step.looks[id]);
    if (c) return c;
  }
  return null;
}

function SceneEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const scene = useApp((s) => s.scenes.find((x) => x.id === id));
  const fixtures = useApp((s) => s.fixtures);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const playing = useApp((s) => s.status?.playback?.sceneId === id);
  const liveStep = useApp((s) => (s.status?.playback?.sceneId === id ? s.status.playback.stepIndex : null));
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Scene | null>(null);

  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const toSave = pending.current;
    pending.current = null;
    if (toSave) api.updateScene(toSave).then(() => setError(null)).catch((e) => setError(e.message));
  };

  useEffect(() => {
    if (!scene) onClose();
  }, [!scene]);

  // Leaving the editor saves what is pending and gives the lights back.
  useEffect(() => () => {
    flush();
    control.preview(null);
  }, []);

  const step = scene?.steps[Math.min(stepIndex, (scene?.steps.length ?? 1) - 1)];

  // The lights show the step being edited, unless the whole scene is being tested.
  useEffect(() => {
    if (step && !playing) control.preview(step.looks);
  }, [step, playing]);

  useEffect(() => {
    if (liveStep !== null) setStepIndex(liveStep);
  }, [liveStep]);

  if (!scene || !step) return null;

  const change = (next: Scene) => {
    useApp.getState().localScene(next);
    pending.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 350);
  };
  const changeStep = (patch: Partial<Step>) => {
    change({ ...scene, steps: scene.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s)) });
  };
  const addStep = () => {
    const index = scene.steps.length;
    // Starts from the previous step: changing one colour is the usual next move.
    change({ ...scene, steps: [...scene.steps, newStep(index, JSON.parse(JSON.stringify(step.looks)))] });
    setStepIndex(index);
  };
  const removeStep = () => {
    if (scene.steps.length <= 1) return;
    change({ ...scene, steps: scene.steps.filter((s) => s.id !== step.id) });
    setStepIndex(Math.max(0, stepIndex - 1));
  };
  const moveStep = (by: number) => {
    const steps = [...scene.steps];
    const i = steps.indexOf(step);
    if (i + by < 0 || i + by >= steps.length) return;
    steps.splice(i, 1);
    steps.splice(i + by, 0, step);
    change({ ...scene, steps });
    setStepIndex(i + by);
  };
  const remove = () => Alert.alert('Supprimer cette scène ?', scene.name, [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Supprimer', style: 'destructive', onPress: () => {
      pending.current = null;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      api.deleteScene(id).then(onClose).catch((e) => setError(e.message));
    } },
  ]);
  const test = () => {
    if (playing) {
      control.stop();
      return;
    }
    flush();
    // Saved first, so the server plays what is on screen.
    setTimeout(() => control.play(id, stepIndex), 120);
  };

  const inStep = (f: Fixture) => !!step.looks[f.id];
  const selected = fixtures.filter((f) => selection.includes(f.id));

  const getValue = (f: Fixture, key: string) => {
    const v = step.looks[f.id]?.[key];
    if (v !== undefined) return v;
    if (key === 'dimmer') return 255;
    return f.channels.find((c) => c.key === key)?.default ?? 0;
  };
  const onValues = (values: Record<string, number>) => {
    const looks: Look = { ...step.looks };
    selected.forEach((f) => { looks[f.id] = { ...looks[f.id], ...values }; });
    changeStep({ looks });
  };
  const toggleFixture = (f: Fixture) => {
    if (selection.includes(f.id)) select(selection.filter((x) => x !== f.id));
    else {
      select([...selection, f.id]);
      if (!inStep(f)) changeStep({ looks: { ...step.looks, [f.id]: {} } });
    }
  };
  const selectAll = () => {
    const looks: Look = { ...step.looks };
    fixtures.forEach((f) => { looks[f.id] = looks[f.id] ?? {}; });
    changeStep({ looks });
    select(fixtures.map((f) => f.id));
  };
  const removeSelected = () => {
    const looks: Look = { ...step.looks };
    selection.forEach((fid) => delete looks[fid]);
    changeStep({ looks });
    select([]);
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <IconButton icon="arrow-left" label="Retour aux scènes" onPress={onClose} />
        <Text numberOfLines={1} style={[type.title, { flex: 1 }]}>{scene.name}</Text>
        <Button compact kind={playing ? 'danger' : 'primary'} icon={playing ? 'stop' : 'play'} label={playing ? 'Arrêter' : 'Tester'} onPress={test} />
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Section title={`Étapes (${scene.steps.length})`}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timeline}>
          {scene.steps.map((s, i) => {
            const active = s.id === step.id;
            const live = liveStep === i;
            return (
              <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={`${s.name}, ${seconds(s.durationMs)}`} accessibilityState={{ selected: active }}
                onPress={() => { setStepIndex(i); if (playing) control.stop(); }}
                style={[styles.stepCard, active && { borderColor: colors.accent }]}>
                <View style={[styles.stepColor, { backgroundColor: stepColor(s) ?? colors.surface3 }]}>
                  {live ? <Icon name="play" size={18} color="#fff" /> : null}
                </View>
                <Text numberOfLines={1} style={[type.caption, { color: colors.text }]}>{s.name}</Text>
                <Text style={type.caption}>{seconds(s.durationMs)}</Text>
              </Pressable>
            );
          })}
          <Pressable accessibilityRole="button" accessibilityLabel="Ajouter une étape" onPress={addStep} style={[styles.stepCard, styles.addStep]}>
            <Icon name="plus" size={24} color={colors.accent} />
            <Text style={type.caption}>Ajouter</Text>
          </Pressable>
        </ScrollView>
      </Section>

      <View style={styles.pair}>
        <View style={{ flex: 1 }}>
          <Stepper label="Durée (s)" value={step.durationMs / 1000} min={0.5} max={600} step={0.5}
            onChange={(v) => changeStep({ durationMs: v * 1000, fadeMs: Math.min(step.fadeMs, v * 1000) })} />
        </View>
        <View style={{ flex: 1 }}>
          <Stepper label="Fondu (s)" value={step.fadeMs / 1000} min={0} max={step.durationMs / 1000} step={0.5}
            onChange={(v) => changeStep({ fadeMs: v * 1000 })} />
        </View>
      </View>

      <Section title="Appareils de cette étape" right={<Button compact kind="ghost" label="Tous" onPress={selectAll} />}>
        {fixtures.length === 0 ? <Text style={type.caption}>Aucun appareil pour l'instant.</Text> : null}
        <View style={styles.chips}>
          {fixtures.map((f) => (
            <Chip key={f.id} label={f.name} active={selection.includes(f.id)} tone={inStep(f) ? 'included' : undefined}
              dot={lookColor(step.looks[f.id]) ?? undefined} onPress={() => toggleFixture(f)} />
          ))}
        </View>
        <Text style={type.caption}>Les appareils non touchés restent éteints pendant cette étape.</Text>
      </Section>

      {selected.length > 0 ? (
        <>
          <FixtureControls fixtures={selected} getValue={getValue} onChange={onValues} />
          <Button compact icon="close" label="Retirer de cette étape" onPress={removeSelected} />
        </>
      ) : null}

      <Section title="Étape">
        <Field label="Nom de l'étape" value={step.name} onChangeText={(name) => changeStep({ name })} />
        <View style={styles.pair}>
          <Button compact style={{ flex: 1 }} icon="arrow-left" label="Avant" disabled={stepIndex === 0} onPress={() => moveStep(-1)} />
          <Button compact style={{ flex: 1 }} icon="arrow-right" label="Après" disabled={stepIndex >= scene.steps.length - 1} onPress={() => moveStep(1)} />
        </View>
        {scene.steps.length > 1 ? <Button compact kind="danger" icon="trash-can-outline" label="Supprimer l'étape" onPress={removeStep} /> : null}
      </Section>

      <Section title="Scène">
        <Field label="Nom de la scène" value={scene.name} onChangeText={(name) => change({ ...scene, name })} />
        <ToggleRow label="Tourner en boucle" helper={scene.loop ? 'Repart de la première étape.' : "S'arrête sur la dernière étape."} value={scene.loop} onChange={(loop) => change({ ...scene, loop })} />
        <View style={styles.colors}>
          {sceneColors.map((c) => (
            <Pressable key={c} accessibilityRole="button" accessibilityLabel={`Couleur de la scène ${c}`} accessibilityState={{ selected: scene.color === c }}
              onPress={() => change({ ...scene, color: c })} style={[styles.colorDot, scene.color === c && { borderColor: colors.text }]}>
              <View style={{ flex: 1, borderRadius: 14, backgroundColor: c }} />
            </Pressable>
          ))}
        </View>
        <Button kind="danger" icon="trash-can-outline" label="Supprimer la scène" onPress={remove} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, width: '100%', maxWidth: 720, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginLeft: -space.md },
  pair: { flexDirection: 'row', gap: space.md },
  list: { padding: space.lg, gap: space.md },
  padGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  pad: { height: 148, borderRadius: radius.lg, overflow: 'hidden', padding: space.md, justifyContent: 'space-between', backgroundColor: colors.surface2 },
  padPlaying: { borderWidth: 2, borderColor: colors.text },
  padTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginRight: -space.sm, marginTop: -space.xs },
  padPlay: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  padTitle: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  padInfo: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 2 },
  padProgress: { position: 'absolute', left: 0, bottom: 0, height: 4, backgroundColor: '#fff' },
  timeline: { gap: space.sm, paddingVertical: 2 },
  stepCard: {
    width: 108, padding: space.sm, gap: 4, borderRadius: radius.md, backgroundColor: colors.surface2,
    borderWidth: 2, borderColor: 'transparent',
  },
  stepColor: { height: 48, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  addStep: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', borderColor: colors.border },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  colorDot: { width: 40, height: 40, padding: 4, borderRadius: 20, borderWidth: 2, borderColor: 'transparent' },
});

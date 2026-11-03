import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../lib/api';
import { capabilities, categoryIcons, categoryLabels, nextFreeAddress, overlapping } from '../lib/dmx';
import { fixtureColor, useColumns, useTick } from '../lib/layout';
import { useApp } from '../lib/store';
import { defaultAim, trussBars } from '../stage/geometry';
import { colors, radius, space, type } from '../theme';
import { Fixture, Mount } from '../types';
import { Button, EmptyState, Field, Icon, IconButton, Notice, Section, Segmented, Slider, Stepper } from '../ui';
import { AddFixture } from './AddFixture';
import { ChannelListEditor } from './ChannelListEditor';
import { DetectPanel } from './DetectPanel';

export function FixturesPanel() {
  const route = useApp((s) => s.fixtureRoute);
  const set = useApp((s) => s.set);
  if (route.name === 'detect') return <DetectPanel startScan={route.scan} />;
  if (route.name === 'add') {
    // A fixture picked from the detection returns there, to add the next one.
    const back = route.detected ? { name: 'detect', scan: false } as const : { name: 'list' } as const;
    return <AddFixture detected={route.detected} onClose={() => set({ fixtureRoute: back })} />;
  }
  if (route.name === 'edit') return <FixtureEditor id={route.id} onClose={() => set({ fixtureRoute: { name: 'list' } })} />;
  return <FixtureList />;
}

function FixtureList() {
  const fixtures = useApp((s) => s.fixtures);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const set = useApp((s) => s.set);
  const { itemWidth } = useColumns(260);
  useTick(300);
  const add = () => set({ fixtureRoute: { name: 'add' } });
  const detect = () => set({ fixtureRoute: { name: 'detect', scan: true } });

  if (fixtures.length === 0) {
    return (
      <EmptyState icon="spotlight-beam" title="Ajoute ton premier appareil" text="Lance une détection sur le câble DMX, ou scanne son code-barres, ou tape son modèle.">
        <Button kind="primary" icon="access-point" label="Détecter les appareils" onPress={detect} />
        <Button icon="plus" label="Ajouter à la main" onPress={add} />
      </EmptyState>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.titleRow}>
        <Text style={type.title}>Appareils</Text>
        <Text style={type.label}>{fixtures.length}</Text>
      </View>
      <View style={styles.actions}>
        <Button style={{ flex: 1 }} kind="primary" icon="access-point" label="Détecter" onPress={detect} />
        <Button style={{ flex: 1 }} icon="plus" label="Ajouter" onPress={add} />
      </View>
      <View style={styles.grid}>
        {fixtures.map((f) => {
          const clash = overlapping(fixtures, f.address, f.channels.length, f.id).length > 0;
          const active = selection.includes(f.id);
          const light = fixtureColor(f);
          return (
            <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={`${f.name}, adresse ${f.address}`}
              onPress={() => select([f.id])}
              style={({ pressed }) => [styles.card, { width: itemWidth }, active && styles.cardActive, pressed && { opacity: 0.8 }]}>
              <View style={[styles.lamp, light ? { backgroundColor: light, shadowColor: light, shadowOpacity: 0.9 } : null]}>
                <Icon name={categoryIcons[f.category]} size={20} color={light ? '#0B0C10' : colors.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.cardTitle}>{f.name}</Text>
                <Text numberOfLines={1} style={type.caption}>
                  DMX {f.channels.length > 1 ? `${f.address}–${f.address + f.channels.length - 1}` : f.address}{f.mode ? ` · ${f.mode}` : ''}
                </Text>
              </View>
              {clash ? <Icon name="alert-outline" size={18} color={colors.warning} /> : null}
              <IconButton icon="pencil-outline" size={18} color={colors.textDim} label={`Modifier ${f.name}`} onPress={() => { select([f.id]); set({ fixtureRoute: { name: 'edit', id: f.id } }); }} />
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const MOUNTS: { value: Mount; label: string }[] = [
  { value: 'tbar-left', label: 'T gauche' },
  { value: 'truss', label: 'Barre LT3' },
  { value: 'tbar-right', label: 'T droit' },
  { value: 'floor', label: 'Sol' },
];

function FixtureEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const fixture = useApp((s) => s.fixtures.find((f) => f.id === id));
  const fixtures = useApp((s) => s.fixtures);
  const stage = useApp((s) => s.stage);
  const localFixture = useApp((s) => s.localFixture);
  const [error, setError] = useState<string | null>(null);
  const [showChannels, setShowChannels] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!fixture) onClose(); // deleted, possibly from another device
  }, [!fixture]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  if (!fixture || !stage) return null;

  /** Applied at once in the 3D view, written shortly after the last change. */
  const change = (next: Fixture) => {
    localFixture(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateFixture(next).then(() => setError(null)).catch((e) => setError(e.message));
    }, 350);
  };
  const place = (p: Partial<Fixture['placement']>) => change({ ...fixture, placement: { ...fixture.placement, ...p } });

  const setMount = (mount: Mount) => {
    const bar = trussBars(stage).find((b) => b.mount === mount);
    const wasFloor = fixture.placement.mount === 'floor';
    const aim = wasFloor !== (mount === 'floor') ? defaultAim(mount, fixture.category) : {};
    if (bar) place({ mount, x: (bar.xMin + bar.xMax) / 2, z: bar.z, ...aim });
    else place({ mount, x: stage.truss.x, z: stage.truss.z + 0.8, ...aim });
  };

  const remove = () => Alert.alert('Supprimer cet appareil ?', `${fixture.name} sera aussi retiré de toutes les scènes.`, [
    { text: 'Annuler', style: 'cancel' },
    {
      text: 'Supprimer', style: 'destructive',
      onPress: () => api.deleteFixture(id).then(onClose).catch((e) => setError(e.message)),
    },
  ]);

  const p = fixture.placement;
  const bar = trussBars(stage).find((b) => b.mount === p.mount);
  const clash = overlapping(fixtures, fixture.address, fixture.channels.length, id);
  const caps = capabilities(fixture.channels);

  return (
    <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <IconButton icon="arrow-left" label="Retour" onPress={onClose} />
        <Text numberOfLines={1} style={[type.title, { flex: 1 }]}>{fixture.name}</Text>
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Field label="Nom" value={fixture.name} onChangeText={(name) => change({ ...fixture, name })} />
      <Text style={type.caption}>
        {categoryLabels[fixture.category]}{fixture.model && fixture.model !== fixture.name ? ` · ${fixture.model}` : ''}{caps.length ? ` · ${caps.join(', ')}` : ''}
      </Text>

      <Stepper label={`Adresse DMX (${fixture.channels.length} canaux)`} value={fixture.address} min={1} max={513 - fixture.channels.length}
        onChange={(address) => change({ ...fixture, address })} />
      {clash.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Notice tone="warning">Canaux partagés avec {clash.map((f) => f.name).join(', ')}.</Notice>
          <Button compact label="Prendre la prochaine adresse libre" onPress={() => change({ ...fixture, address: nextFreeAddress(fixtures, fixture.channels.length, id) })} />
        </View>
      ) : null}

      <Section title="Emplacement">
        <Segmented options={MOUNTS} value={p.mount} onChange={setMount} />
        {bar ? (
          <Slider label="Position sur la barre" value={p.x} min={bar.xMin} max={bar.xMax} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(x) => place({ x })} />
        ) : (
          <>
            <Slider label="Gauche / droite" value={p.x} min={-stage.roomWidth / 2 + 0.3} max={stage.roomWidth / 2 - 0.3} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(x) => place({ x })} />
            <Slider label="Profondeur" value={p.z} min={0.3} max={stage.roomLength - 0.3} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(z) => place({ z })} />
          </>
        )}
        <Text style={type.caption}>Tu peux aussi activer « Placer » dans la vue 3D et le glisser au doigt.</Text>
      </Section>

      <Section title="Orientation">
        <Slider label="Inclinaison" value={p.tilt} min={0} max={180} format={(v) => `${Math.round(v)}°`} onChange={(tilt) => place({ tilt })} />
        <Slider label="Rotation" value={p.pan} min={-90} max={90} format={(v) => `${Math.round(v)}°`} onChange={(pan) => place({ pan })} />
        {fixture.category !== 'fog' && fixture.category !== 'laser' ? (
          <Slider label="Ouverture du faisceau" value={fixture.beamAngle} min={4} max={120} format={(v) => `${Math.round(v)}°`} onChange={(beamAngle) => change({ ...fixture, beamAngle })} />
        ) : null}
      </Section>

      {showChannels ? (
        <ChannelListEditor channels={fixture.channels} onChange={(channels) => { if (channels.length) change({ ...fixture, channels }); }} />
      ) : (
        <Button compact icon="format-list-numbered" label={`Voir les ${fixture.channels.length} canaux`} onPress={() => setShowChannels(true)} />
      )}

      <Button kind="danger" icon="trash-can-outline" label="Supprimer l'appareil" onPress={remove} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md },
  form: { padding: space.lg, gap: space.md, width: '100%', maxWidth: 720, alignSelf: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginLeft: -space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  card: {
    backgroundColor: colors.surface2, borderRadius: radius.lg, paddingLeft: space.md, paddingRight: space.xs, minHeight: 68,
    flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderColor: 'transparent',
  },
  cardActive: { borderColor: colors.text },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  lamp: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface3,
    shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0,
  },
});

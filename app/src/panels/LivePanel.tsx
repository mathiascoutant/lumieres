import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { fixtureColor, useColumns } from '../lib/layout';
import { control, dmxFrame, sendLive, useApp } from '../lib/store';
import { colors, space, type } from '../theme';
import { Fixture } from '../types';
import { Button, Chip, EmptyState } from '../ui';
import { FixtureControls } from './FixtureControls';

export function LivePanel() {
  const fixtures = useApp((s) => s.fixtures);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const liveIds = useApp((s) => s.status?.liveIds ?? []);
  const sceneId = useApp((s) => s.status?.playback?.sceneId);
  const set = useApp((s) => s.set);
  const { wide } = useColumns(300);

  // What the user set by hand. Anything else shows the DMX value really going out.
  const touched = useRef<Record<string, Record<string, number>>>({});
  const [, redraw] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => redraw((n) => n + 1), 400);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { touched.current = {}; }, [sceneId]);

  if (fixtures.length === 0) {
    return (
      <EmptyState icon="tune-variant" title="Aucun appareil à piloter" text="Ajoute d'abord tes appareils pour les contrôler ici.">
        <Button kind="primary" icon="plus" label="Ajouter un appareil" onPress={() => set({ tab: 'fixtures', fixtureRoute: { name: 'list' } })} />
      </EmptyState>
    );
  }

  const selected = fixtures.filter((f) => selection.includes(f.id));
  const getValue = (f: Fixture, key: string) => {
    const manual = touched.current[f.id]?.[key];
    if (manual !== undefined) return manual;
    const i = f.channels.findIndex((c) => c.key === key);
    if (i >= 0) return dmxFrame[f.address - 1 + i] ?? 0;
    return key === 'dimmer' ? 255 : 0;
  };
  const onChange = (values: Record<string, number>) => {
    const ids = selected.map((f) => f.id);
    ids.forEach((id) => { touched.current[id] = { ...touched.current[id], ...values }; });
    sendLive(ids, values);
    redraw((n) => n + 1);
  };
  const release = () => {
    touched.current = {};
    control.release();
    redraw((n) => n + 1);
  };
  const toggle = (id: string) => select(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
  const allSelected = selected.length === fixtures.length;

  const picker = (
    <View style={{ gap: space.md }}>
      <View style={styles.head}>
        <Text style={type.title}>Live</Text>
        <Button compact kind="ghost" label={allSelected ? 'Aucun' : 'Tous'} onPress={() => select(allSelected ? [] : fixtures.map((f) => f.id))} />
      </View>
      <View style={styles.chips}>
        {fixtures.map((f) => (
          <Chip key={f.id} label={f.name} active={selection.includes(f.id)} dot={fixtureColor(f) ?? colors.surface3} onPress={() => toggle(f.id)} />
        ))}
      </View>
      {liveIds.length > 0 ? <Button compact icon="undo-variant" label="Rendre la main à la scène" onPress={release} /> : null}
    </View>
  );

  const controls = selected.length > 0 ? (
    <FixtureControls fixtures={selected} getValue={getValue} onChange={onChange} fogAsButton />
  ) : (
    <Text style={[type.body, { color: colors.textDim }]}>Touche un appareil dans la liste ou dans la vue 3D.</Text>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <ScrollView style={styles.sideColumn} contentContainerStyle={styles.content}>{picker}</ScrollView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>{controls}</ScrollView>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {picker}
      {controls}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sideColumn: { flex: 0.8, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
});

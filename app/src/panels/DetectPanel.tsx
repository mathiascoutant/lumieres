import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { colors, radius, space, type } from '../theme';
import { DetectedDevice, DetectionReport } from '../types';
import { Button, EmptyState, Icon, IconButton, Notice, Section } from '../ui';

const POLL_MS = 800;
/** A scan on a healthy line takes seconds. Past this, the gateway is not answering as it should. */
const GIVE_UP_MS = 90_000;

export function deviceTitle(d: DetectedDevice): string {
  const name = [d.manufacturer, d.model].filter(Boolean).join(' ');
  return name || d.label || 'Appareil sans nom';
}

/** Asks the DMX line which fixtures are there, then offers to add them. */
export function DetectPanel({ startScan }: { startScan: boolean }) {
  const set = useApp((s) => s.set);
  const fixtures = useApp((s) => s.fixtures);
  const [report, setReport] = useState<DetectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);
  const alive = useRef(true);

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const poll = async () => {
    try {
      const next = await api.detectedDevices();
      if (!alive.current) return;
      setReport(next);
      setError(null);
      if (next.state !== 'scanning') return;
      if (Date.now() - started.current > GIVE_UP_MS) {
        setError("La recherche ne se termine pas. Vérifie le câble DMX, puis relance-la.");
        return;
      }
      timer.current = setTimeout(poll, POLL_MS);
    } catch (e: any) {
      if (alive.current) setError(e.message);
    }
  };

  const scan = async () => {
    stopPolling();
    setError(null);
    setReport({ state: 'scanning', truncated: false, devices: [] });
    started.current = Date.now();
    try {
      await api.startDetection();
      if (alive.current) poll();
    } catch (e: any) {
      if (alive.current) {
        setReport(null);
        setError(e.message);
      }
    }
  };

  useEffect(() => {
    alive.current = true;
    // Coming back from adding a fixture shows the same results: no need to scan again.
    if (startScan) scan();
    else {
      started.current = Date.now();
      poll();
    }
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, []);

  const back = () => set({ fixtureRoute: { name: 'list' } });
  const addByHand = () => set({ fixtureRoute: { name: 'add' } });
  const add = (detected: DetectedDevice) => set({ fixtureRoute: { name: 'add', detected } });

  const scanning = report?.state === 'scanning';
  const devices = report?.devices ?? [];
  // Follows deletions and additions made while this panel is open.
  const addedId = (d: DetectedDevice) => fixtures.find((f) => f.rdmUid === d.uid)?.id;
  const toAdd = devices.filter((d) => !addedId(d));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <IconButton icon="arrow-left" label="Retour" onPress={back} />
        <Text numberOfLines={1} style={[type.title, { flex: 1 }]}>Appareils détectés</Text>
      </View>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {scanning ? (
        <View style={styles.scanning}>
          <ActivityIndicator color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={type.body}>Recherche sur la ligne DMX…</Text>
            <Text style={type.caption}>Quelques lumières peuvent clignoter pendant la recherche.</Text>
          </View>
        </View>
      ) : null}

      {devices.length > 0 ? (
        <Section title={scanning ? `Trouvés pour l'instant (${devices.length})` : `${devices.length} appareil${devices.length > 1 ? 's' : ''} trouvé${devices.length > 1 ? 's' : ''}`}>
          {devices.map((d) => {
            const added = !!addedId(d);
            return (
              <Pressable key={d.uid} accessibilityRole="button" accessibilityLabel={`${deviceTitle(d)}, adresse ${d.address}`}
                disabled={added} onPress={() => add(d)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}>
                <Icon name={d.match ? 'check-decagram-outline' : 'help-circle-outline'} size={22} color={d.match ? colors.success : colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={type.body}>{deviceTitle(d)}</Text>
                  <Text numberOfLines={2} style={type.caption}>
                    {d.address ? `DMX ${d.address}–${d.address + Math.max(d.footprint, 1) - 1}` : 'Sans adresse'}
                    {d.personalityName ? ` · ${d.personalityName}` : ''}
                    {!d.match && !added ? ' · Fiche à choisir' : ''}
                  </Text>
                </View>
                {added ? <Text style={styles.added}>Déjà ajouté</Text> : <Text style={styles.addLabel}>Ajouter</Text>}
              </Pressable>
            );
          })}
        </Section>
      ) : null}

      {report?.truncated ? (
        <Notice tone="warning">La recherche s'est arrêtée avant la fin : il peut manquer des appareils. Vérifie le câble et le bouchon de fin de ligne.</Notice>
      ) : null}

      {!scanning && report?.state === 'done' && devices.length === 0 ? (
        <EmptyState icon="access-point-off" title="Aucun appareil n'a répondu"
          text="Seuls les appareils compatibles RDM peuvent répondre, et un splitter DMX classique bloque leurs réponses. Ajoute les autres à la main." />
      ) : null}

      {!scanning && devices.length > 0 ? (
        <Notice>Les appareils sans RDM n'apparaissent pas ici, même s'ils fonctionnent très bien : ajoute-les à la main.</Notice>
      ) : null}

      {!scanning && report && toAdd.length === 0 && devices.length > 0 ? (
        <Button kind="primary" icon="check" label="Terminé" onPress={back} />
      ) : null}
      <Button icon="plus" label="Ajouter à la main" onPress={addByHand} />
      <Button icon="refresh" label={report ? 'Relancer la recherche' : 'Lancer la recherche'} disabled={scanning} onPress={scan} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md , width: '100%', maxWidth: 720, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginLeft: -space.md },
  scanning: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.surface2, borderRadius: radius.sm, padding: space.md },
  row: {
    backgroundColor: colors.surface2, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 56,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
  },
  added: { color: colors.textMute, fontSize: 13, fontWeight: '500' },
  addLabel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
});

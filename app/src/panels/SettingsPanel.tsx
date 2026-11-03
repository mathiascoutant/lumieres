import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, getServerUrl, setServerUrl } from '../lib/api';
import { useColumns } from '../lib/layout';
import { connect, useApp } from '../lib/store';
import { colors, space, type } from '../theme';
import { Stage } from '../types';
import { Button, Card, Field, Icon, Notice, Section, Slider, Stepper } from '../ui';

const meters = (v: number) => `${v.toFixed(1)} m`;

export function SettingsPanel() {
  const status = useApp((s) => s.status);
  const stage = useApp((s) => s.stage);
  const settings = useApp((s) => s.settings);
  const connection = useApp((s) => s.connection);
  const set = useApp((s) => s.set);
  const [server, setServer] = useState(getServerUrl());
  const [target, setTarget] = useState(settings.artnetTarget);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { itemWidth } = useColumns(320, space.xl);
  const column = { width: itemWidth };

  useEffect(() => setTarget(settings.artnetTarget), [settings.artnetTarget]);

  const changeStage = (patch: Partial<Stage>) => {
    if (!stage) return;
    const next = { ...stage, ...patch };
    set({ stage: next });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.saveStage(next).then(() => setError(null)).catch((e) => setError(e.message));
    }, 350);
  };
  const changeTruss = (patch: Partial<Stage['truss']>) => stage && changeStage({ truss: { ...stage.truss, ...patch } });

  const applyServer = async () => {
    await setServerUrl(server);
    setServer(getServerUrl());
    connect();
  };
  const saveDmx = (universe = settings.universe) => {
    api.saveSettings({ artnetTarget: target.trim(), universe }).then(() => setError(null)).catch((e) => setError(e.message));
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[type.title, { width: '100%' }]}>Réglages</Text>
      {error ? <View style={{ width: '100%' }}><Notice tone="danger">{error}</Notice></View> : null}

      <View style={column}><Section title="État du système">
        <Card>
          <StatusRow ok={connection === 'online'} label="Serveur" detail={connection === 'online' ? getServerUrl() : 'Déconnecté, nouvel essai en cours'} />
          <StatusRow ok={!!status?.output.online} label="Passerelle DMX"
            detail={status?.output.online ? `${status.output.nodeName} (${status.output.nodeIp})` : status ? `Non détectée, envoi vers : ${status.output.target}` : 'Inconnu'} />
          <StatusRow ok={!!status?.db.connected} label="Base MongoDB"
            detail={status?.db.connected ? (status.db.pending ? `${status.db.pending} modification(s) à écrire` : 'Synchronisée') : `Hors ligne, copie locale utilisée${status?.db.pending ? `, ${status.db.pending} en attente` : ''}`} />
        </Card>
      </Section></View>

      <View style={column}><Section title="Serveur">
        <Field label="Adresse du serveur" value={server} onChangeText={setServer} keyboardType="url" placeholder="http://192.168.1.10:8080" />
        <Button compact label="Se connecter" onPress={applyServer} />
      </Section></View>

      <View style={column}><Section title="Sortie DMX (Art-Net)">
        <Field label="Adresse IP de la passerelle" value={target} onChangeText={setTarget} onEndEditing={() => saveDmx()} keyboardType="numbers-and-punctuation"
          placeholder="Automatique" helper="Laisse vide : la carte ESP32 est détectée toute seule sur le réseau." />
        <Stepper label="Univers" value={settings.universe} min={0} max={15} onChange={(u) => saveDmx(u)} helper="Doit être le même sur la carte ESP32 (0 par défaut)." />
      </Section></View>

      {stage ? (
        <>
          <View style={column}><Section title="Structure BoomTone DJ LT3">
            <Slider label="Hauteur de la barre" value={stage.truss.height} min={1.5} max={4} step={0.1} format={meters} onChange={(height) => changeTruss({ height })} />
            <Slider label="Position gauche / droite" value={stage.truss.x} min={-stage.stageWidth / 2 + 1.5} max={stage.stageWidth / 2 - 1.5} step={0.1} format={meters} onChange={(x) => changeTruss({ x })} />
            <Slider label="Distance au fond de scène" value={stage.truss.z} min={0.5} max={Math.max(0.6, stage.stageDepth - 0.5)} step={0.1} format={meters} onChange={(z) => changeTruss({ z })} />
            <Text style={type.caption}>Barre centrale de 3 m, deux pieds à T, 4 m et 40 kg maximum en charge selon le fabricant.</Text>
          </Section></View>

          <View style={column}><Section title="Scène">
            <Slider label="Largeur" value={stage.stageWidth} min={4} max={Math.min(20, stage.roomWidth)} step={0.5} format={meters} onChange={(stageWidth) => changeStage({ stageWidth })} />
            <Slider label="Profondeur" value={stage.stageDepth} min={2} max={10} step={0.5} format={meters} onChange={(stageDepth) => changeStage({ stageDepth })} />
            <Slider label="Hauteur du plateau" value={stage.stageHeight} min={0} max={1.5} step={0.1} format={meters} onChange={(stageHeight) => changeStage({ stageHeight })} />
          </Section></View>

          <View style={column}><Section title="Salle">
            <Slider label="Largeur" value={stage.roomWidth} min={8} max={30} step={0.5} format={meters} onChange={(roomWidth) => changeStage({ roomWidth })} />
            <Slider label="Longueur" value={stage.roomLength} min={10} max={50} step={0.5} format={meters} onChange={(roomLength) => changeStage({ roomLength })} />
            <Slider label="Hauteur" value={stage.roomHeight} min={3} max={12} step={0.5} format={meters} onChange={(roomHeight) => changeStage({ roomHeight })} />
            <Slider label="Lumière de la salle" value={stage.houseLights} min={0} max={1} step={0.01} onChange={(houseLights) => changeStage({ houseLights })} />
          </Section></View>
        </>
      ) : null}
    </ScrollView>
  );
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <View style={styles.row}>
      <Icon name={ok ? 'check-circle' : 'alert-circle-outline'} size={20} color={ok ? colors.success : colors.warning} />
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        <Text style={type.caption}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
});

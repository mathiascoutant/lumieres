import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../lib/api';
import {
  capabilities, categoryIcons, categoryLabels, channelTypeLabels, nextFreeAddress, overlapping,
} from '../lib/dmx';
import { useApp } from '../lib/store';
import { placementForNew } from '../stage/geometry';
import { colors, radius, space, type } from '../theme';
import { BarcodeResult, CatalogDetails, CatalogEntry, Category, Channel, DetectedDevice, Fixture, Placement, Profile } from '../types';
import { Button, Chip, Field, Icon, IconButton, Notice, Section, Stepper } from '../ui';
import { ChannelListEditor } from './ChannelListEditor';

const ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'] as const;

/** What will be created, wherever it came from. */
interface Draft {
  name: string;
  model: string;
  ref: string;
  category: Category;
  beamAngle: number;
  channels: Channel[];
  modes?: CatalogDetails['modes'];
  modeIndex: number;
}

type Step = { name: 'find' } | { name: 'manual' } | { name: 'configure'; draft: Draft };

function draftFromProfile(p: Profile): Draft {
  return {
    name: p.name.split(' (')[0], model: '', ref: '', category: p.category, beamAngle: p.beamAngle,
    channels: p.channels, modeIndex: 0,
  };
}

const simplify = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The mode to start from: the one a detected fixture is set to, otherwise the fullest one. */
function startingMode(modes: CatalogDetails['modes'], detected?: DetectedDevice): number {
  if (detected) {
    const same = modes.findIndex((m) => m.channels.length === detected.footprint);
    if (same >= 0) return same;
  }
  return modes.reduce((best, m, i, all) => (m.channels.length > all[best].channels.length ? i : best), 0);
}

export function AddFixture({ onClose, detected }: { onClose: () => void; detected?: DetectedDevice }) {
  const [step, setStep] = useState<Step>({ name: 'find' });
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  // Identified once: going back from the next screen must not reopen the same sheet.
  const autoOpen = useRef(detected?.match ?? null);

  if (step.name === 'configure') {
    return <Configure draft={step.draft} detected={detected} onBack={() => setStep({ name: 'find' })} onDone={onClose} />;
  }
  if (step.name === 'manual') {
    return <ManualChoice onBack={() => setStep({ name: 'find' })} onChoose={(draft) => setStep({ name: 'configure', draft })} />;
  }
  return (
    <FindProduct
      onClose={onClose}
      detected={detected}
      autoOpen={autoOpen}
      scannedCode={scannedCode}
      setScannedCode={setScannedCode}
      onFound={(details) => {
        const modeIndex = startingMode(details.modes, detected);
        const draft: Draft = {
          name: details.name, model: details.name, ref: details.ref, category: details.category, beamAngle: details.beamAngle,
          modes: details.modes, modeIndex, channels: details.modes[modeIndex].channels,
        };
        setStep({ name: 'configure', draft });
      }}
      onManual={() => setStep({ name: 'manual' })}
      onGeneric={(profile) => setStep({ name: 'configure', draft: draftFromProfile(profile) })}
    />
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton icon="arrow-left" label="Retour" onPress={onBack} />
      <Text numberOfLines={1} style={[type.title, { flex: 1 }]}>{title}</Text>
    </View>
  );
}

function FindProduct({
  onClose, onFound, onManual, onGeneric, scannedCode, setScannedCode, detected, autoOpen,
}: {
  onClose: () => void; onFound: (d: CatalogDetails) => void; onManual: () => void; onGeneric: (p: Profile) => void;
  scannedCode: string | null; setScannedCode: (c: string | null) => void;
  detected?: DetectedDevice; autoOpen: React.RefObject<CatalogEntry | null>;
}) {
  const [query, setQuery] = useState(() => (detected ? [detected.manufacturer, detected.model].filter(Boolean).join(' ') : ''));
  const [results, setResults] = useState<CatalogEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scan, setScan] = useState<BarcodeResult | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const requestId = useRef(0);

  // Debounced search; a late answer to an older query is ignored.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      if (!scan?.matches.length) setResults(null);
      setSearching(false);
      return;
    }
    const id = ++requestId.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchCatalog(q)
        .then((list) => { if (id === requestId.current) { setResults(list); setError(null); } })
        .catch((e) => { if (id === requestId.current) setError(e.message); })
        .finally(() => { if (id === requestId.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const openEntry = async (entry: CatalogEntry) => {
    setOpening(entry.ref);
    setError(null);
    try {
      const details = await api.catalogDetails(entry.ref);
      // The next scan of this box finds the product straight away, even offline.
      if (scannedCode) api.linkBarcode(scannedCode, entry.ref, entry.name).catch(() => {});
      onFound(details);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setOpening(null);
    }
  };

  useEffect(() => {
    const entry = autoOpen.current;
    if (entry) {
      autoOpen.current = null;
      openEntry(entry);
    }
  }, []);

  const onScanned = async (code: string) => {
    setScanOpen(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setScannedCode(code);
    setScan(null);
    setError(null);
    setSearching(true);
    try {
      const res = await api.scanBarcode(code);
      setScan(res);
      setResults(res.matches);
      if (res.matches.length === 1) await openEntry(res.matches[0]);
      else if (res.product && res.matches.length === 0) setQuery(`${res.product.brand} ${res.product.model}`.trim());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  const profiles = useApp((s) => s.profiles);
  const typed = simplify(query.trim());
  const generic = typed.length >= 3 ? profiles.filter((p) => simplify(p.name).includes(typed)) : [];
  const exact = results?.filter((r) => r.exact) ?? [];
  const close = results?.filter((r) => !r.exact) ?? [];

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <PanelHeader title="Ajouter un appareil" onBack={onClose} />

      {detected ? (
        <Notice icon="access-point">
          Détecté à l'adresse {detected.address || '?'} ({detected.footprint} canaux). {detected.manufacturer || detected.model
            ? "Choisis sa fiche pour obtenir le détail de ses canaux."
            : "Il ne donne pas son nom : scanne-le ou tape son modèle."}
        </Notice>
      ) : null}
      {opening && detected ? <ActivityIndicator color={colors.accent} /> : null}

      <Button kind="primary" icon="barcode-scan" label="Scanner le code-barres" onPress={() => setScanOpen(true)} />

      {scannedCode && scan && (
        scan.matches.length > 0 ? (
          <Notice icon="barcode">Code {scannedCode}{scan.product ? ` : ${scan.product.title}` : ''}</Notice>
        ) : scan.product ? (
          <Notice tone="warning">
            Code reconnu ({scan.product.title}), mais sans fiche DMX à ce nom. Corrige le modèle ci-dessous : ton choix sera retenu pour ce code.
          </Notice>
        ) : (
          <Notice tone="warning">
            Code {scannedCode} inconnu des bases de produits. Tape le modèle ci-dessous : ton choix sera retenu pour le prochain scan.
          </Notice>
        )
      )}

      <Field
        label="Ou tape le modèle exact"
        value={query}
        onChangeText={setQuery}
        placeholder="ex. BoomTone SilentPAR 7x10W 6in1"
        helper="La marque et le modèle, comme sur l'étiquette de l'appareil."
        clear
      />

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {searching ? <ActivityIndicator color={colors.accent} /> : null}

      {generic.length > 0 ? (
        <Section title="Modèles génériques">
          {generic.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={p.name} onPress={() => onGeneric(p)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}>
              <Icon name={categoryIcons[p.category]} color={colors.textDim} />
              <Text style={[type.body, { flex: 1 }]}>{p.name}</Text>
              <Icon name="chevron-right" />
            </Pressable>
          ))}
        </Section>
      ) : null}

      {exact.length > 0 ? (
        <Section title={`Résultats (${exact.length})`}>
          {exact.map((r) => <ResultRow key={r.ref} entry={r} loading={opening === r.ref} onPress={() => openEntry(r)} />)}
        </Section>
      ) : null}
      {close.length > 0 ? (
        <Section title={exact.length ? 'Modèles proches' : 'Pas de modèle exact, les plus proches'}>
          {close.map((r) => <ResultRow key={r.ref} entry={r} loading={opening === r.ref} onPress={() => openEntry(r)} />)}
        </Section>
      ) : null}

      {results && results.length === 0 && generic.length === 0 && !searching && query.trim().length >= 2 ? (
        <Notice tone="warning">Aucune fiche DMX pour « {query.trim()} ». Essaie sans la marque, ou seulement le début du modèle.</Notice>
      ) : null}

      <View style={styles.manual}>
        <Text style={type.caption}>Modèle absent des catalogues ?</Text>
        <Button compact icon="file-document-edit-outline" label="Le créer d'après sa notice" onPress={onManual} />
      </View>

      <BarcodeScanner visible={scanOpen} onClose={() => setScanOpen(false)} onCode={onScanned} />
    </ScrollView>
  );
}

function ResultRow({ entry, onPress, loading }: { entry: CatalogEntry; onPress: () => void; loading: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={entry.name} disabled={loading} onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}>
      <Text style={[type.body, { flex: 1 }]}>{entry.name}</Text>
      {loading ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="chevron-right" />}
    </Pressable>
  );
}

function BarcodeScanner({ visible, onClose, onCode }: { visible: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const handled = useRef(false);

  useEffect(() => {
    if (visible) {
      handled.current = false;
      if (permission && !permission.granted && permission.canAskAgain) requestPermission();
    }
  }, [visible, permission?.granted]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" supportedOrientations={[...ORIENTATIONS]} onRequestClose={onClose}>
      <View style={styles.scanner}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return; // the camera reports the same code many times per second
              handled.current = true;
              onCode(data);
            }}
          />
        ) : (
          <View style={styles.scanDenied}>
            <Icon name="camera-off-outline" size={36} color={colors.textMute} />
            <Text style={[type.body, { textAlign: 'center' }]}>
              L'accès à la caméra est nécessaire pour scanner. Autorise-le dans les réglages d'Expo Go, ou tape le modèle.
            </Text>
            {permission?.canAskAgain ? <Button kind="primary" label="Autoriser la caméra" onPress={requestPermission} /> : null}
          </View>
        )}
        {permission?.granted ? (
          <View pointerEvents="none" style={styles.scanFrameWrap}>
            <View style={styles.scanFrame} />
            <Text style={styles.scanHint}>Vise le code-barres sur l'appareil ou son carton</Text>
          </View>
        ) : null}
        <Button label="Fermer" icon="close" onPress={onClose} style={[styles.scanClose, { top: insets.top + space.md }]} />
      </View>
    </Modal>
  );
}

/** Templates and blank list, for fixtures found in no catalog. */
function ManualChoice({ onBack, onChoose }: { onBack: () => void; onChoose: (d: Draft) => void }) {
  const profiles = useApp((s) => s.profiles);
  const choose = (p: Profile) => onChoose(draftFromProfile(p));
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PanelHeader title="Créer d'après la notice" onBack={onBack} />
      <Notice>Choisis le modèle le plus proche : tu ajusteras ensuite les canaux pour coller au tableau DMX de la notice.</Notice>
      {profiles.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={p.name} onPress={() => choose(p)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}>
          <Icon name={categoryIcons[p.category]} color={colors.accent} />
          <Text style={[type.body, { flex: 1 }]}>{p.name}</Text>
          <Icon name="chevron-right" />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Configure({ draft, detected, onBack, onDone }: { draft: Draft; detected?: DetectedDevice; onBack: () => void; onDone: () => void }) {
  const fixtures = useApp((s) => s.fixtures);
  const stage = useApp((s) => s.stage);
  const [name, setName] = useState(draft.name);
  const [modeIndex, setModeIndex] = useState(draft.modeIndex);
  const [channels, setChannels] = useState<Channel[]>(draft.channels);
  const [quantity, setQuantity] = useState(1);
  const [address, setAddress] = useState(() => detected?.address || nextFreeAddress(fixtures, draft.channels.length));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<number | null>(null);

  const chooseMode = (i: number) => {
    setModeIndex(i);
    const next = draft.modes![i].channels;
    setChannels(next);
    if (!detected?.address) setAddress(nextFreeAddress(fixtures, next.length));
    setOpenChannel(null);
  };

  const footprint = channels.length * quantity;
  const clash = overlapping(fixtures, address, footprint);
  const beyond = address + footprint - 1 > 512;
  const caps = capabilities(channels);
  const mode = draft.modes?.[modeIndex];

  const add = async () => {
    if (!stage) return;
    setSaving(true);
    setError(null);
    try {
      const taken: Placement[] = fixtures.map((f) => f.placement);
      const list: Omit<Fixture, 'id'>[] = Array.from({ length: quantity }, (_, i) => {
        const placement = placementForNew(stage, draft.category, taken);
        taken.push(placement);
        return {
        name: quantity > 1 ? `${name} ${i + 1}` : name,
        model: draft.model,
        mode: mode?.name ?? '',
        ref: draft.ref,
        rdmUid: detected?.uid,
        category: draft.category,
        address: address + i * channels.length,
        channels,
        beamAngle: draft.beamAngle,
        placement,
        };
      });
      const created = await api.createFixtures(list);
      useApp.getState().select(created.map((f) => f.id));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <PanelHeader title={draft.name} onBack={onBack} />

      <View style={styles.identity}>
        <Icon name={categoryIcons[draft.category]} size={22} color={colors.accent} />
        <Text style={type.label}>{categoryLabels[draft.category]}</Text>
        {draft.ref ? <Text style={type.caption}>Fiche {draft.ref.startsWith('ofl') ? 'Open Fixture Library' : 'QLC+'}</Text> : null}
      </View>

      {caps.length > 0 ? (
        <Section title="Ce que tu peux piloter">
          <View style={styles.wrap}>
            {caps.map((c) => <View key={c} style={styles.cap}><Text style={styles.capText}>{c}</Text></View>)}
          </View>
        </Section>
      ) : null}

      {draft.modes && draft.modes.length > 1 ? (
        <Section title="Mode DMX de l'appareil">
          <View style={styles.wrap}>
            {draft.modes.map((m, i) => (
              <Chip key={`${m.name}-${i}`} label={m.name.includes(String(m.channels.length)) ? m.name : `${m.name} · ${m.channels.length} canaux`} active={i === modeIndex} onPress={() => chooseMode(i)} />
            ))}
          </View>
        </Section>
      ) : null}

      {draft.ref ? (
        <Section title={`Canaux (${channels.length})`}>
          {channels.map((c, i) => (
            <View key={`${c.key}-${i}`}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Canal ${i + 1}, ${c.label}`} disabled={!c.ranges?.length}
                onPress={() => setOpenChannel(openChannel === i ? null : i)} style={styles.channelRow}>
                <Text style={styles.channelNum}>{i + 1}</Text>
                <Text numberOfLines={1} style={[type.body, { flex: 1 }]}>{c.label}</Text>
                <Text style={type.caption}>{channelTypeLabels[c.type]}</Text>
                {c.ranges?.length ? <Icon name={openChannel === i ? 'chevron-up' : 'chevron-down'} size={18} /> : null}
              </Pressable>
              {openChannel === i ? (
                <View style={styles.ranges}>
                  {c.ranges!.map((r) => (
                    <View key={`${r.from}-${r.to}`} style={styles.rangeRow}>
                      <Text style={styles.rangeValue}>{r.from}–{r.to}</Text>
                      <Text style={[type.caption, { flex: 1, color: colors.textDim }]}>{r.label}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ))}
        </Section>
      ) : (
        <ChannelListEditor channels={channels} onChange={(c) => { setChannels(c); }} />
      )}

      <Field label="Nom" value={name} onChangeText={setName} />
      <View style={styles.pair}>
        <View style={{ flex: 1 }}><Stepper label="Adresse DMX" value={address} min={1} max={512} onChange={setAddress} /></View>
        {detected ? null : <View style={{ flex: 1 }}><Stepper label="Quantité" value={quantity} min={1} max={32} onChange={setQuantity} /></View>}
      </View>

      {beyond ? <Notice tone="danger">Ça dépasse le canal 512 : baisse l'adresse ou la quantité.</Notice> : null}
      {clash.length > 0 ? (
        <Notice tone="warning">
          Canaux déjà utilisés par {clash.map((f) => f.name).join(', ')}. Ces appareils réagiront ensemble.
        </Notice>
      ) : null}
      {detected && detected.footprint > 0 && channels.length !== detected.footprint ? (
        <Notice tone="warning">
          L'appareil annonce {detected.footprint} canaux, cette fiche en a {channels.length}. Choisis le bon mode, sinon il réagira mal.
        </Notice>
      ) : null}
      {detected && address === detected.address ? (
        <Notice icon="access-point">Adresse lue sur l'appareil{detected.personalityName ? `, réglé en ${detected.personalityName}` : ''}.</Notice>
      ) : (
        <Notice>
          Sur l'appareil, règle l'adresse {address}{mode ? ` et le mode ${mode.name}` : ''}{quantity > 1 ? `, puis ${channels.length} de plus pour chaque suivant` : ''}.
        </Notice>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Button kind="primary" icon="plus" label={quantity > 1 ? `Ajouter les ${quantity} appareils` : "Ajouter l'appareil"}
        onPress={add} loading={saving} disabled={beyond || !name.trim() || channels.length === 0} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg , width: '100%', maxWidth: 720, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginLeft: -space.md },
  row: {
    minHeight: 48, backgroundColor: colors.surface2, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
  },
  manual: { alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cap: { backgroundColor: colors.accentSoft, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 5 },
  capText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  channelRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  channelNum: { width: 26, color: colors.textMute, fontSize: 13, fontVariant: ['tabular-nums'] },
  ranges: { paddingLeft: 34, paddingVertical: space.sm, gap: 4 },
  rangeRow: { flexDirection: 'row', gap: space.sm },
  rangeValue: { width: 62, color: colors.textMute, fontSize: 12, fontVariant: ['tabular-nums'] },
  pair: { flexDirection: 'row', gap: space.md },
  scanner: { flex: 1, backgroundColor: '#000' },
  scanDenied: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  scanFrameWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: space.md },
  scanFrame: { width: '74%', maxWidth: 420, aspectRatio: 2.2, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.md },
  scanHint: { color: '#fff', fontSize: 14, backgroundColor: colors.scrim, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, overflow: 'hidden' },
  scanClose: { position: 'absolute', right: space.lg },
});

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { channelTypeLabels } from '../lib/dmx';
import { colors, radius, space, type } from '../theme';
import { Channel, ChannelType } from '../types';
import { Button, Icon, IconButton, Section } from '../ui';

const TYPES = Object.keys(channelTypeLabels) as ChannelType[];
const ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'] as const;
const REST: Partial<Record<ChannelType, number>> = { pan: 128, tilt: 128 };

/** Keys follow the role of each channel, which is how scenes and controls address them. */
function withKeys(channels: Channel[]): Channel[] {
  const used = new Set<string>();
  return channels.map((c, i) => {
    let key: string = c.type === 'generic' ? `generic_${i + 1}` : c.type;
    for (let n = 2; used.has(key); n++) key = `${c.type}_${n}`;
    used.add(key);
    return { ...c, key };
  });
}

/** Channel table, to match a fixture's DMX manual line by line. */
export function ChannelListEditor({ channels, onChange }: { channels: Channel[]; onChange: (c: Channel[]) => void }) {
  const [picking, setPicking] = useState<number | null>(null);
  const update = (next: Channel[]) => onChange(withKeys(next));
  const patch = (i: number, p: Partial<Channel>) => update(channels.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, by: number) => {
    const next = [...channels];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c);
    update(next);
  };

  return (
    <Section title={`Canaux (${channels.length})`}>
      {channels.map((c, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.num}>{i + 1}</Text>
          <View style={{ flex: 1, gap: 4 }}>
            <TextInput
              accessibilityLabel={`Nom du canal ${i + 1}`}
              value={c.label}
              onChangeText={(label) => patch(i, { label })}
              placeholderTextColor={colors.textMute}
              keyboardAppearance="dark"
              style={styles.label}
            />
            <Pressable accessibilityRole="button" accessibilityLabel={`Fonction du canal ${i + 1} : ${channelTypeLabels[c.type]}`} onPress={() => setPicking(i)} style={styles.type}>
              <Text style={type.caption}>{channelTypeLabels[c.type]}</Text>
              <Icon name="chevron-down" size={14} color={colors.textMute} />
            </Pressable>
          </View>
          <IconButton icon="arrow-up" label="Monter" size={18} disabled={i === 0} onPress={() => move(i, -1)} />
          <IconButton icon="arrow-down" label="Descendre" size={18} disabled={i === channels.length - 1} onPress={() => move(i, 1)} />
          <IconButton icon="close" label="Supprimer le canal" size={18} color={colors.danger} onPress={() => update(channels.filter((_, j) => j !== i))} />
        </View>
      ))}
      <Button compact icon="plus" label="Ajouter un canal" onPress={() => update([...channels, { key: '', type: 'generic', label: 'Canal', default: 0 }])} />

      <Modal visible={picking !== null} transparent animationType="fade" supportedOrientations={[...ORIENTATIONS]} onRequestClose={() => setPicking(null)}>
        <Pressable style={styles.scrim} accessibilityLabel="Fermer" onPress={() => setPicking(null)}>
          <View style={styles.sheet}>
            <ScrollView>
              {TYPES.map((t) => (
                <Pressable key={t} accessibilityRole="button" accessibilityLabel={channelTypeLabels[t]}
                  onPress={() => {
                    if (picking !== null) patch(picking, { type: t, label: channelTypeLabels[t], default: REST[t] ?? 0 });
                    setPicking(null);
                  }}
                  style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface3 }]}>
                  <Text style={type.body}>{channelTypeLabels[t]}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: colors.surface2, borderRadius: radius.sm, paddingLeft: space.sm, paddingVertical: 4 },
  num: { width: 24, color: colors.textMute, fontSize: 13, fontVariant: ['tabular-nums'] },
  label: { color: colors.text, fontSize: 15, paddingVertical: 2, minHeight: 28 },
  type: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 22, alignSelf: 'flex-start' },
  scrim: { flex: 1, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet: { backgroundColor: colors.surface2, borderRadius: radius.lg, width: '100%', maxWidth: 360, maxHeight: '88%', paddingVertical: space.sm },
  option: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg },
});

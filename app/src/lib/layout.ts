import { createContext, useContext, useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';

import { readOutput, indexChannels, FixtureOutput } from '../stage/fixtureModel';
import { space } from '../theme';
import { Fixture } from '../types';
import { dmxFrame } from './store';

export function useLayout() {
  const { width, height } = useWindowDimensions();
  return { width, height, landscape: width > height, tablet: Math.min(width, height) >= 600 };
}

/** Width of the panel showing the current screen: its grids adapt to it, not to the device. */
export const PanelWidth = createContext(360);

export function useColumns(minItemWidth: number, gap: number = space.md) {
  const width = useContext(PanelWidth);
  const inner = width - space.lg * 2 - 2; // the panel's own border takes up to a point on each side
  const columns = Math.max(1, Math.floor((inner + gap) / (minItemWidth + gap)));
  return { columns, itemWidth: Math.floor((inner - gap * (columns - 1)) / columns), wide: width >= 640 };
}

const output: FixtureOutput = { r: 0, g: 0, b: 0, intensity: 0, pan: 0, tilt: 0, fog: 0, pattern: 0, speed: 0, hasMotion: false };

/** The colour a fixture is really emitting right now, null when it is dark. */
export function fixtureColor(f: Fixture): string | null {
  readOutput(f, indexChannels(f), dmxFrame, Date.now() / 1000, output);
  if (f.category === 'fog') return output.fog > 0.01 ? '#E5E5EA' : null;
  if (output.intensity < 0.02) return null;
  const to255 = (v: number) => Math.round(Math.min(1, v) * 255);
  return `rgb(${to255(output.r)},${to255(output.g)},${to255(output.b)})`;
}

/** Re-renders regularly, for what follows the DMX output. */
export function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

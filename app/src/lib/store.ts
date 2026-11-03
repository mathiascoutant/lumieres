import { create } from 'zustand';

import { DetectedDevice, Fixture, Look, Profile, Scene, Settings, Stage, Status } from '../types';
import { api, socketUrl } from './api';

export type Tab = 'fixtures' | 'live' | 'scenes' | 'settings';
export type Tool = 'view' | 'place';
export type Connection = 'connecting' | 'online' | 'offline';
export type FixtureRoute =
  | { name: 'list' }
  | { name: 'add'; detected?: DetectedDevice }
  | { name: 'detect'; scan: boolean }
  | { name: 'edit'; id: string };
export type SceneRoute = { name: 'list' } | { name: 'edit'; id: string };

interface AppState {
  connection: Connection;
  loaded: boolean;
  error: string | null;
  fixtures: Fixture[];
  scenes: Scene[];
  profiles: Profile[];
  stage: Stage | null;
  settings: Settings;
  status: Status | null;
  selection: string[];
  tab: Tab;
  tool: Tool;
  fixtureRoute: FixtureRoute;
  sceneRoute: SceneRoute;
  set: (partial: Partial<AppState>) => void;
  select: (ids: string[]) => void;
  localFixture: (f: Fixture) => void;
  localScene: (s: Scene) => void;
}

export const useApp = create<AppState>((set) => ({
  connection: 'connecting',
  loaded: false,
  error: null,
  fixtures: [],
  scenes: [],
  profiles: [],
  stage: null,
  settings: { artnetTarget: '', universe: 0 },
  status: null,
  selection: [],
  tab: 'fixtures',
  tool: 'view',
  fixtureRoute: { name: 'list' },
  sceneRoute: { name: 'list' },
  set: (partial) => set(partial),
  select: (ids) => set({ selection: ids }),
  localFixture: (f) => set((s) => ({ fixtures: upsert(s.fixtures, [f], byAddress) })),
  localScene: (scene) => set((s) => ({ scenes: upsert(s.scenes, [scene], byName) })),
}));

const byAddress = (a: Fixture, b: Fixture) => a.address - b.address || a.id.localeCompare(b.id);
const byName = (a: Scene, b: Scene) => a.name.localeCompare(b.name);

function upsert<T extends { id: string }>(list: T[], items: T[], compare: (a: T, b: T) => number): T[] {
  const ids = new Set(items.map((i) => i.id));
  return [...list.filter((i) => !ids.has(i.id)), ...items].sort(compare);
}

/** The last DMX universe received. Read by the 3D loop, outside of React on purpose. */
export const dmxFrame = new Uint8Array(512);

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let stopped = false;
let pendingLive = new Map<string, { ids: string[]; values: Record<string, number> }>();
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreview: Look | null | undefined;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

export async function reloadAll() {
  const data = await api.bootstrap();
  useApp.setState({
    fixtures: data.fixtures, scenes: data.scenes, profiles: data.profiles,
    stage: data.stage, settings: data.settings, loaded: true, error: null,
  });
}

/** Opens the realtime link, and reconnects for as long as the app runs. */
export function connect() {
  stopped = false;
  disconnectSocket();
  useApp.setState({ connection: 'connecting' });
  const socket = new WebSocket(socketUrl());
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    attempt = 0;
    useApp.setState({ connection: 'online' });
    reloadAll().catch((e) => useApp.setState({ error: e.message }));
  };
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') handleMessage(JSON.parse(event.data));
    else dmxFrame.set(new Uint8Array(event.data as ArrayBuffer).subarray(0, 512));
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    useApp.setState({ connection: 'offline', status: null });
    if (!stopped) {
      attempt += 1;
      retry = setTimeout(connect, Math.min(1000 * attempt, 5000));
    }
  };
  socket.onerror = () => socket.close();
}

function disconnectSocket() {
  if (retry) clearTimeout(retry);
  retry = null;
  const old = ws;
  ws = null;
  old?.close();
}

export function disconnect() {
  stopped = true;
  disconnectSocket();
}

function handleMessage(m: any) {
  switch (m.type) {
    case 'status':
      useApp.setState({ status: m });
      break;
    case 'fixtures':
      useApp.setState((s) => {
        let list = s.fixtures;
        if (m.upsert) list = upsert(list, m.upsert, byAddress);
        if (m.delete) list = list.filter((f) => !m.delete.includes(f.id));
        return { fixtures: list, selection: s.selection.filter((id) => list.some((f) => f.id === id)) };
      });
      break;
    case 'scenes':
      useApp.setState((s) => {
        let list = s.scenes;
        if (m.upsert) list = upsert(list, m.upsert, byName);
        if (m.delete) list = list.filter((x) => !m.delete.includes(x.id));
        return { scenes: list };
      });
      break;
    case 'profiles':
      useApp.setState({ profiles: m.profiles });
      break;
    case 'stage':
      useApp.setState({ stage: m.stage });
      break;
    case 'settings':
      useApp.setState({ settings: m.settings });
      break;
    case 'reload':
      reloadAll().catch(() => {});
      break;
    case 'error':
      useApp.setState({ error: m.message });
      break;
  }
}

function send(message: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function flushLive() {
  liveTimer = null;
  pendingLive.forEach(({ ids, values }) => send({ type: 'live', ids, values }));
  pendingLive = new Map();
}

/** Sends live values, coalesced so a slider drag cannot flood the connection. */
export function sendLive(ids: string[], values: Record<string, number>) {
  if (ids.length === 0) return;
  const key = ids.join(',');
  const entry = pendingLive.get(key);
  pendingLive.set(key, { ids, values: { ...entry?.values, ...values } });
  if (!liveTimer) liveTimer = setTimeout(flushLive, 30);
}

export const control = {
  release: (ids?: string[]) => send({ type: 'release', ids: ids ?? [] }),
  master: (value: number) => send({ type: 'master', value }),
  blackout: (on: boolean) => send({ type: 'blackout', on }),
  play: (id: string, step = 0) => send({ type: 'play', id, step }),
  stop: () => send({ type: 'stop' }),
  preview(look: Look | null) {
    pendingPreview = look;
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      send({ type: 'preview', look: pendingPreview ?? null });
    }, 40);
  },
};

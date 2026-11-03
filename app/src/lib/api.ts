import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import {
  BarcodeResult, CatalogDetails, CatalogEntry, DetectionReport, Fixture, Profile, Scene, Settings, Stage,
} from '../types';

const STORAGE_KEY = 'serverUrl';
const DEFAULT_PORT = 8080;

let baseUrl = guessServerUrl();

// In development the server runs on the machine serving the JS bundle.
function guessServerUrl(): string {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || 'localhost'}:${DEFAULT_PORT}`;
}

export async function loadServerUrl(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved) baseUrl = saved;
  } catch {
    // The guessed address still works when storage is unavailable.
  }
  return baseUrl;
}

export function getServerUrl(): string {
  return baseUrl;
}

export async function setServerUrl(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, '');
  baseUrl = /^https?:\/\//.test(clean) ? clean : `http://${clean}`;
  await AsyncStorage.setItem(STORAGE_KEY, baseUrl);
}

export function socketUrl(): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Serveur injoignable (${baseUrl}). Vérifie qu'il tourne et que tu es sur le même Wi-Fi.`);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Erreur serveur (${response.status})`);
  return data as T;
}

export interface Bootstrap {
  fixtures: Fixture[];
  scenes: Scene[];
  profiles: Profile[];
  stage: Stage;
  settings: Settings;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  createFixtures: (list: Omit<Fixture, 'id'>[]) => request<Fixture[]>('/api/fixtures', 'POST', list),
  updateFixture: (f: Fixture) => request<Fixture>(`/api/fixtures/${f.id}`, 'PUT', f),
  deleteFixture: (id: string) => request<void>(`/api/fixtures/${id}`, 'DELETE'),
  createScene: (s: Omit<Scene, 'id'>) => request<Scene>('/api/scenes', 'POST', s),
  updateScene: (s: Scene) => request<Scene>(`/api/scenes/${s.id}`, 'PUT', s),
  deleteScene: (id: string) => request<void>(`/api/scenes/${id}`, 'DELETE'),
  createProfile: (p: Omit<Profile, 'id' | 'builtin'>) => request<Profile>('/api/profiles', 'POST', p),
  saveStage: (s: Stage) => request<Stage>('/api/stage', 'PUT', s),
  saveSettings: (s: Settings) => request<Settings>('/api/settings', 'PUT', s),
  searchCatalog: (q: string) => request<CatalogEntry[]>(`/api/catalog/search?q=${encodeURIComponent(q)}`),
  catalogDetails: (ref: string) => request<CatalogDetails>(`/api/catalog/details?ref=${encodeURIComponent(ref)}`),
  startDetection: () => request<void>('/api/detection/scan', 'POST'),
  detectedDevices: () => request<DetectionReport>('/api/detection/devices'),
  scanBarcode: (code: string) => request<BarcodeResult>(`/api/catalog/barcode/${encodeURIComponent(code)}`),
  linkBarcode: (code: string, ref: string, name: string) =>
    request<unknown>(`/api/catalog/barcode/${encodeURIComponent(code)}`, 'PUT', { ref, name }),
};

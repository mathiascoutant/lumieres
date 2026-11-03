export type ChannelType =
  | 'dimmer' | 'red' | 'green' | 'blue' | 'white' | 'amber' | 'uv' | 'strobe' | 'pan' | 'tilt'
  | 'speed' | 'fog' | 'fan' | 'pattern' | 'color' | 'mode' | 'generic';

export type Category = 'par' | 'bar' | 'wash' | 'moving' | 'strobe' | 'fog' | 'laser' | 'other';
export type Mount = 'truss' | 'tbar-left' | 'tbar-right' | 'floor';

export interface ChannelRange {
  from: number;
  to: number;
  label: string;
  kind?: 'open' | 'closed' | 'strobe';
}

export interface Channel {
  key: string;
  type: ChannelType;
  label: string;
  default: number;
  ranges?: ChannelRange[];
}

export interface Placement {
  mount: Mount;
  x: number;
  z: number;
  tilt: number;
  pan: number;
}

export interface Fixture {
  id: string;
  name: string;
  model: string;
  mode: string;
  ref: string;
  rdmUid?: string;
  category: Category;
  address: number;
  channels: Channel[];
  beamAngle: number;
  placement: Placement;
}

export interface Profile {
  id: string;
  name: string;
  category: Category;
  channels: Channel[];
  beamAngle: number;
  builtin: boolean;
}

export type Look = Record<string, Record<string, number>>;

export interface Step {
  id: string;
  name: string;
  durationMs: number;
  fadeMs: number;
  looks: Look;
}

export interface Scene {
  id: string;
  name: string;
  color: string;
  loop: boolean;
  steps: Step[];
}

export interface Stage {
  roomWidth: number;
  roomLength: number;
  roomHeight: number;
  stageWidth: number;
  stageDepth: number;
  stageHeight: number;
  houseLights: number;
  truss: { x: number; z: number; height: number; width: number };
}

export interface Settings {
  artnetTarget: string;
  universe: number;
}

export interface Status {
  master: number;
  blackout: boolean;
  playback: {
    sceneId: string;
    stepIndex: number;
    stepCount: number;
    stepElapsedMs: number;
    stepDurationMs: number;
    finished: boolean;
  } | null;
  liveIds: string[];
  preview: boolean;
  output: { online: boolean; nodeIp: string; nodeName: string; target: string };
  db: { connected: boolean; pending: number };
}

export interface CatalogEntry {
  ref: string;
  name: string;
  exact: boolean;
}

export interface CatalogMode {
  name: string;
  channels: Channel[];
}

export interface CatalogDetails {
  ref: string;
  name: string;
  manufacturer: string;
  model: string;
  category: Category;
  beamAngle: number;
  modes: CatalogMode[];
}

export interface BarcodeResult {
  code: string;
  product: { title: string; brand: string; model: string } | null;
  matches: CatalogEntry[];
}

export interface DetectedDevice {
  uid: string;
  manufacturer: string;
  model: string;
  label: string;
  personalityName: string;
  address: number;
  footprint: number;
  personality: number;
  personalityCount: number;
  match: CatalogEntry | null;
  fixtureId: string;
}

export interface DetectionReport {
  state: 'idle' | 'scanning' | 'done';
  truncated: boolean;
  devices: DetectedDevice[];
}

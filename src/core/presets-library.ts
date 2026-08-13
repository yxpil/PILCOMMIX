// 内置预设库:旧版精调音色(从旧版 WebView2 localStorage 提取,共 8 个)
// 启动时由 seedBuiltinPresets() 全量导入用户预设列表(按名称去重)
import type { WaveType } from "./wave";

export interface PresetParams {
  waveType: WaveType;
  oscWave: OscillatorType;
  oscCount: number;
  detuneCents: number;
  filterKind: BiquadFilterType;
  cutoffHz: number;
  resonanceQ: number;
  cutoffEnvHz: number;
  cutoffEnvMs: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  volume: number;
  reverb: number;
  harmonics: number;
  monoMode: boolean;
  pan: number;
  vibratoRate: number;
  vibratoDepth: number;
  pianoDecayScale: number;
  pianoDetuneCents: number;
  pianoNoiseLevel: number;
  pianoBright: number;
  dripRatio: number;
  dripTimeMs: number;
  dripDecayMs: number;
  wtPos: number;
  wtLfoRate: number;
  wtLfoDepth: number;
  wtSlots: WaveType[];
  velCurve: number[];
  velMin: number;
  velPower: number;
}

export interface LibraryPreset {
  name: string;
  params: PresetParams;
}

const DEFAULT_WT_SLOTS: WaveType[] = ["sine", "triangle", "square", "saw", "dx7", "harp", "guzheng", "custom"];

export const PRESET_LIBRARY: LibraryPreset[] = [
  {
    name: "糖果世界",
    params: {
      waveType: "sine", oscWave: "sawtooth", oscCount: 1, detuneCents: 8,
      filterKind: "lowpass", cutoffHz: 1319, resonanceQ: 2.47,
      cutoffEnvHz: 1197, cutoffEnvMs: 198,
      attack: 0, decay: 0.282, sustain: 0.06, release: 0.667,
      volume: 0.43, reverb: 0.98, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "回忆口哨",
    params: {
      waveType: "triangle", oscWave: "square", oscCount: 2, detuneCents: 8,
      filterKind: "lowpass", cutoffHz: 1319, resonanceQ: 2.47,
      cutoffEnvHz: 1986, cutoffEnvMs: 198,
      attack: 0.067, decay: 0.226, sustain: 0.27, release: 0.349,
      volume: 0.28, reverb: 0.98, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "回忆计量器",
    params: {
      waveType: "square", oscWave: "sawtooth", oscCount: 1, detuneCents: 8,
      filterKind: "lowpass", cutoffHz: 1319, resonanceQ: 2.47,
      cutoffEnvHz: 1197, cutoffEnvMs: 198,
      attack: 0, decay: 0.282, sustain: 0.33, release: 0.667,
      volume: 0.3, reverb: 0.98, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "绿色记忆",
    params: {
      waveType: "saw", oscWave: "sine", oscCount: 2, detuneCents: 8,
      filterKind: "lowpass", cutoffHz: 11525, resonanceQ: 3.76,
      cutoffEnvHz: 1986, cutoffEnvMs: 198,
      attack: 0.067, decay: 0, sustain: 0.64, release: 1.185,
      volume: 0.1, reverb: 0.18, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "旧的赛博舞台",
    params: {
      waveType: "saw", oscWave: "sawtooth", oscCount: 8, detuneCents: 2,
      filterKind: "highpass", cutoffHz: 50, resonanceQ: 3.41,
      cutoffEnvHz: 1427, cutoffEnvMs: 260,
      attack: 0.173, decay: 0.12, sustain: 0.15, release: 1.048,
      volume: 0.07, reverb: 0.35, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "漫步青云",
    params: {
      waveType: "triangle", oscWave: "sawtooth", oscCount: 8, detuneCents: 22,
      filterKind: "highpass", cutoffHz: 50, resonanceQ: 3.41,
      cutoffEnvHz: 1427, cutoffEnvMs: 260,
      attack: 0.928, decay: 0.473, sustain: 0.49, release: 1.048,
      volume: 0.42, reverb: 0.35, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "歌剧院幽灵",
    params: {
      waveType: "triangle", oscWave: "sawtooth", oscCount: 3, detuneCents: 12,
      filterKind: "highpass", cutoffHz: 5070, resonanceQ: 6.06,
      cutoffEnvHz: 1914, cutoffEnvMs: 543,
      attack: 0.702, decay: 0.466, sustain: 0.84, release: 1.831,
      volume: 0.48, reverb: 1, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 6.12, vibratoDepth: 1,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
  {
    name: "似是雨",
    params: {
      waveType: "sine", oscWave: "sawtooth", oscCount: 1, detuneCents: 8,
      filterKind: "lowpass", cutoffHz: 1025, resonanceQ: 8.71,
      cutoffEnvHz: 1197, cutoffEnvMs: 376,
      attack: 0, decay: 0.55, sustain: 0, release: 1.566,
      volume: 0.24, reverb: 0.98, harmonics: 32,
      monoMode: false, pan: 0, vibratoRate: 3, vibratoDepth: 0,
      pianoDecayScale: 1.17, pianoDetuneCents: 4, pianoNoiseLevel: 0.56, pianoBright: 1,
      dripRatio: 4, dripTimeMs: 150, dripDecayMs: 160,
      wtPos: 0.3, wtLfoRate: 0, wtLfoDepth: 0, wtSlots: DEFAULT_WT_SLOTS,
      velCurve: [0, 0.25, 0.5, 0.75, 1], velMin: 0.02, velPower: 3,
    },
  },
];

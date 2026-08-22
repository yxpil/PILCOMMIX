// Rust 音频引擎桥接:所有发声/调度/录音走 Rust(cpal 原生),WebView2 只做 UI
// 治"TS 版本卡死":音频不再依赖 Web Audio 的 JS 节点图与 rAF 循环
import { invoke } from "@tauri-apps/api/core";

// 参数数值限制表(与 Rust 端 EngineParams::sanitize 一致):
// JS 侧先行拦截,防止 0/NaN/Inf/越界值传入 Rust 内核导致音频流崩溃。
// 特别地 resonance_q 下限 0.1:Rust Biquad alpha=sinw/(2Q),Q=0 除零 → NaN → 崩溃。
const PARAM_LIMITS: Record<string, [number, number]> = {
  volume: [0, 2],
  attack: [0.001, 30], decay: [0.001, 30], sustain: [0, 1], release: [0.001, 30],
  harmonics: [1, 32], osc_count: [1, 8], detune_cents: [0, 1200],
  cutoff_hz: [20, 19000], resonance_q: [0.1, 30],
  cutoff_env_hz: [-19000, 19000], cutoff_env_ms: [0, 5000],
  pan: [-1, 1], vibrato_rate: [0, 100], vibrato_depth: [0, 1],
  piano_decay_scale: [0.5, 2.5], piano_detune_cents: [0, 100],
  piano_noise_level: [0, 1], piano_bright: [0.5, 2],
  drip_ratio: [2, 10], drip_time_ms: [50, 500], drip_decay_ms: [100, 1000],
  wt_pos: [0, 1], wt_lfo_rate: [0, 100], wt_lfo_depth: [0, 1],
  portamento_ms: [0, 10000],
  filter_env_hz: [-19000, 19000], filter_env_a: [0.001, 30], filter_env_d: [0.001, 30],
  filter_env_s: [0, 1], filter_env_r: [0.001, 30],
  mod_lfo_rate: [0, 100], mod_lfo_depth: [0, 1],
  key_track: [0, 1], vel_track: [0, 1], sub_level: [0, 1],
  gain: [0, 2], note_jitter: [0, 1],
  grain_size_ms: [10, 500], grain_density: [5, 200], grain_spread: [0, 200],
  grain_random: [0, 1], grain_size_end: [10, 500], grain_density_end: [5, 200],
  grain_env_ms: [0, 3000], grain_env_exp: [-3, 3],
};

// 单值限制:NaN/Inf 回退到下限,其余 clamp 到 [lo, hi]
function clampParam(key: string, value: number): number {
  const lim = PARAM_LIMITS[key];
  if (!lim) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return lim[0];
  return Math.min(lim[1], Math.max(lim[0], value));
}

// 整组参数限制:遍历所有数值字段(未知 key 原样保留)
function sanitizeParams(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "number") out[k] = clampParam(k, v);
  }
  return out;
}

export const ra = {
  // 音频健康检查:返回采样时钟;停滞 = 流失效(待机唤醒后 cpal 流挂起)
  audioHealth: (): Promise<number> => invoke("audio_health"),
  // 重启音频流(停旧建新,待机恢复用)
  audioRestart: async (): Promise<void> => {
    try { await invoke("audio_stop"); } catch { /* ignore */ }
    try { await invoke("audio_start"); } catch { /* ignore */ }
  },
  audioStart: () => invoke("audio_start"),
  audioStop: () => invoke("audio_stop"),
  noteOn: (ch: number, midi: number, vel: number) => invoke("note_on", { ch, midi, vel }),
  noteOff: (ch: number, midi: number) => invoke("note_off", { ch, midi }),
  allOff: (ch: number) => invoke("all_notes_off", { ch }),
  // 整组音色参数(字段与 captureParams 驼峰一致,Rust EngineParams serde 直收;先经数值限制)
  setEngineParams: (ch: number, params: unknown) => invoke("set_engine_params", { ch, params: sanitizeParams(params) }),
  setParam: (ch: number, key: string, value: number) => invoke("set_param", { ch, key, value: clampParam(key, value) }),
  setWtSlots: (ch: number, slots: string[]) => invoke("set_wt_slots", { ch, slots }),
  // Rust 端 Vec<(f32,f32)> 序列化要求 [x,y] 数组
  setCustomAnchors: (ch: number, anchors: { x: number; y: number }[]) =>
    invoke("set_custom_anchors", { ch, anchors: anchors.map((a) => [a.x, a.y]) }),
  setBend: (ch: number, semitones: number) => invoke("set_bend", { ch, semitones }),
  setSustain: (ch: number, on: boolean) => invoke("set_sustain", { ch, on }),
  setSostenuto: (ch: number, on: boolean) => invoke("set_sostenuto", { ch, on }),
  setSoft: (ch: number, on: boolean) => invoke("set_soft", { ch, on }),
  setMaster: (key: string, value: number) => invoke("set_master", { key, value }),
  setSampleRate: (hz: number) => invoke("set_sample_rate", { hz }),
  recordStart: () => invoke("record_start"),
  recordStop: (): Promise<number[]> => invoke("record_stop"),
  smfPlay: (b64: string) => invoke("smf_play", { bytesBase64: b64 }),
  smfStop: () => invoke("smf_stop"),
  // WAV 导入 / 试听
  openWav: (): Promise<[string, string]> => invoke("open_wav"),
  openMidi: (): Promise<[string, string]> => invoke("open_midi"),
  wavPlay: (b64: string) => invoke("wav_play", { bytesBase64: b64 }),
  wavStop: () => invoke("wav_stop"),
  // 自动扒谱 + 音色匹配(返回 JSON 字符串)
  analyzeWav: (b64: string): Promise<string> => invoke("analyze_wav", { bytesBase64: b64 }),
  // .plspmid 超高密度格式(32 轨,密度 4 倍)
  plspmidEncode: (notesJson: string, tonesJson: string, bpm: number, beatsPerBar: number): Promise<string> =>
    invoke("plspmid_encode", { notesJson, tonesJson, bpm, beatsPerBar }),
  plspmidOpen: (): Promise<[string, string]> => invoke("plspmid_open"),
  plspmidSave: (b64: string) => invoke("plspmid_save", { bytesBase64: b64 }),
  plspmidPlay: (b64: string) => invoke("plspmid_play", { bytesBase64: b64 }),
  // .PILMU 多轨音乐工程(主格式:多条 MIDI/plspmid/WAV/MP3 + 拖拽编辑)
  openMp3: (): Promise<[string, string]> => invoke("open_mp3"),
  pilmuOpen: (): Promise<[string, string]> => invoke("pilmu_open"),
  pilmuSave: (b64: string) => invoke("pilmu_save", { bytesBase64: b64 }),
  pilmuBuild: (manifestJson: string, resources: [string, string][]): Promise<string> =>
    invoke("pilmu_build", { manifestJson, resources }),
  pilmuExtract: (b64: string): Promise<[string, [string, string][]]> => invoke("pilmu_extract", { bytesBase64: b64 }),
  pilmuPlay: (b64: string) => invoke("pilmu_play", { bytesBase64: b64 }),
  // 节拍器(Rust 采样级 click)
  metroSet: (running: boolean, bpm: number, volume: number) =>
    invoke("metro_set", { running, bpm, volume }),
  // 琶音器(Rust 采样级调度)
  arpSet: (running: boolean, notes: number[], bpm: number, direction: string, octaves: number) =>
    invoke("arp_set", { running, notes, bpm, direction, octaves }),
  // 通道音量/静音
  setChannel: (ch: number, gain: number, mute: boolean) =>
    invoke("set_channel", { ch, gain, mute }),
  // 力度曲线(Rust 统一应用;anchors 转 [x,y] 数组)
  setVelCurve: (anchors: { x: number; y: number }[], velMin: number, velPower: number) =>
    invoke("set_vel_curve", { anchors: anchors.map((a) => [a.x, a.y]), velMin, velPower }),
  // 智能优化(自动频谱整形)
  setSmartOpt: (enabled: boolean, strength: number) =>
    invoke("set_smart_opt", { enabled, strength }),
};

// base64(字节数组) → 字符串,供 smf_play 用
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

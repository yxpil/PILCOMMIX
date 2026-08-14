// Rust 音频引擎桥接:所有发声/调度/录音走 Rust(cpal 原生),WebView2 只做 UI
// 治"TS 版本卡死":音频不再依赖 Web Audio 的 JS 节点图与 rAF 循环
import { invoke } from "@tauri-apps/api/core";

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
  // 整组音色参数(字段与 captureParams 驼峰一致,Rust EngineParams serde 直收)
  setEngineParams: (ch: number, params: unknown) => invoke("set_engine_params", { ch, params }),
  setParam: (ch: number, key: string, value: number) => invoke("set_param", { ch, key, value }),
  setWtSlots: (ch: number, slots: string[]) => invoke("set_wt_slots", { ch, slots }),
  // Rust 端 Vec<(f32,f32)> 序列化要求 [x,y] 数组
  setCustomAnchors: (ch: number, anchors: { x: number; y: number }[]) =>
    invoke("set_custom_anchors", { ch, anchors: anchors.map((a) => [a.x, a.y]) }),
  setBend: (ch: number, semitones: number) => invoke("set_bend", { ch, semitones }),
  setSustain: (ch: number, on: boolean) => invoke("set_sustain", { ch, on }),
  setMaster: (key: string, value: number) => invoke("set_master", { key, value }),
  setSampleRate: (hz: number) => invoke("set_sample_rate", { hz }),
  recordStart: () => invoke("record_start"),
  recordStop: (): Promise<number[]> => invoke("record_stop"),
  smfPlay: (b64: string) => invoke("smf_play", { bytesBase64: b64 }),
  smfStop: () => invoke("smf_stop"),
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

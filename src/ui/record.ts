// 录制:音频 WAV + MIDI SMF、录音轨道波形
import { invoke } from "@tauri-apps/api/core";
import { engine, midiRec, recStart, setRecStart } from "../core/store";
import { buildSmf } from "../core/smf";
import { $id, toast } from "./dom";
export let mediaRecorder: MediaRecorder | null = null;
export let recChunks: Blob[] = [];
export let recTimer: number | null = null;
export let audioRecording = false;

// 录音轨道:录音时在底部画实时波形(替代映射提示框)
export const trackWrap = $id("track-wrap");
export const trackCanvas = $id("track-canvas") as HTMLCanvasElement;
export let trackRaf = 0;

export function resizeTrackCanvas() {
  const r = trackCanvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const dpr = window.devicePixelRatio || 1;
  trackCanvas.width = Math.max(100, Math.round(r.width * dpr));
  trackCanvas.height = Math.max(40, Math.round(r.height * dpr));
}

export function drawTrackLoop() {
  const w = trackCanvas.width, h = trackCanvas.height;
  if (w === 0 || h === 0) { trackRaf = requestAnimationFrame(drawTrackLoop); return; }
  const ctx = trackCanvas.getContext("2d")!;
  const data = new Uint8Array(engine.analyser.fftSize);
  engine.analyser.getByteTimeDomainData(data);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#95d5b2";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * w;
    const y = mid + ((data[i] - 128) / 128) * (h / 2 - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  trackRaf = requestAnimationFrame(drawTrackLoop);
}

$id("btn-record").addEventListener("click", async () => {
  if (!audioRecording) {
    await engine.resume();
    midiRec.start();
    recChunks = [];
    setRecStart(performance.now());
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    mediaRecorder = new MediaRecorder(engine.recorderDest.stream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.start();
    audioRecording = true;
    $id("btn-record").classList.add("recording");
    ($id("btn-record").querySelector("span") as HTMLElement).textContent = "停止";
    // 显示录音轨道,隐藏映射提示
    trackWrap.style.display = "block";
    trackWrap.classList.add("recording");
    $id("keymap-hint").style.display = "none";
    resizeTrackCanvas();
    drawTrackLoop();
    recTimer = window.setInterval(() => {
      const s = Math.floor((performance.now() - recStart) / 1000);
      const t = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      $id("rec-time").textContent = t;
      // 底部录音机时长同步
      const tt = $id("track-time");
      if (tt) tt.textContent = t;
    }, 200);
  } else {
    await stopRecording();
  }
});

export async function stopRecording() {
  if (!mediaRecorder) return;
  audioRecording = false;
  midiRec.stop();
  $id("btn-record").classList.remove("recording");
  ($id("btn-record").querySelector("span") as HTMLElement).textContent = "录音";
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $id("rec-time").textContent = "--:--";
  // 停止波形循环,面板保留最后画面
  cancelAnimationFrame(trackRaf);
  trackWrap.classList.remove("recording");
  $id("keymap-hint").style.display = "";
  const done = new Promise<void>((res) => {
    mediaRecorder!.onstop = () => res();
    mediaRecorder!.stop();
  });
  await done;

  try {
    const blob = new Blob(recChunks, { type: "audio/webm" });
    if (blob.size === 0) { toast("录音为空"); return; }
    const buf = await blob.arrayBuffer();
    const audioBuf = await engine.ctx.decodeAudioData(buf);
    const wav = audioBufferToWav(audioBuf);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await invoke<string>("save_recording", {
      bytes: Array.from(new Uint8Array(wav)),
      suggestedName: `COMMIX-录音-${stamp}.wav`,
    });
    toast("录音已保存: " + path.split(/[\\/]/).pop());
  } catch (err) {
    console.error(err);
    toast("录音保存失败: " + String(err).slice(0, 60));
  }
}

export function audioBufferToWav(buf: AudioBuffer): ArrayBuffer {
  const ch = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const data = new Int16Array(len * ch);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, src[i]));
      data[i * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  const hdr = new ArrayBuffer(44);
  const dv = new DataView(hdr);
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + data.byteLength, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, data.byteLength, true);
  const out = new Uint8Array(hdr.byteLength + data.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(data.buffer), hdr.byteLength);
  return out.buffer;
}

// MIDI 文件保存(SMF format 0, division 480)
$id("btn-save-midi").addEventListener("click", async () => {
  if (midiRec.events.length === 0) { toast("没有录制的音符"); return; }
  try {
    const smf = buildSmf(midiRec.events);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await invoke<string>("save_midi", {
      bytes: Array.from(new Uint8Array(smf)),
      suggestedName: `COMMIX-MIDI-${stamp}.mid`,
    });
    toast("MIDI 已保存: " + path.split(/[\\/]/).pop());
  } catch (err) {
    toast("MIDI 保存失败: " + String(err).slice(0, 60));
  }
});



// ============ 控制面板 ============

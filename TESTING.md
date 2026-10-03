# COMMIX (PILCOMMIX) 测试说明
- 测试完成：是（2026-10-04）
- 测试日期：2026-10-04
- 测试内容：单元新增 7（audio/fft 零谱/DC/正弦峰值 bin/补零 4、audio/metro 默认态 1、audio/wav 畸形输入注入 2）；既有跨模块集成 pipeline（WAV→扒谱 transcribe→音色 match_tone→.plspmid 编解码）；注入 2（截断 WAV、channels=0 优雅返回 Err 不 panic）；钩子 0（事件链由既有 full_pipeline 往返测试覆盖）。本地 cargo test --lib 共 90 passed。
- 运行命令：cd src-tauri; cargo test --lib（需先建最小 ../dist/index.html 占位）
- 测试框架：Rust #[cfg(test)]
- 模型：豆包（Doubao）生成

Rust 端是 Tauri 应用，crate 位于 `src-tauri/`（包名 `commix`），核心是音频合成/扒谱引擎
（`src-tauri/src/audio/`）。测试全部为 lib 内 `#[cfg(test)]`（纯音频数学与解析，不依赖 GUI/音频设备）。

## 运行命令

```powershell
cd src-tauri
cargo test --lib
```

> **前置说明**：`tauri::generate_context!()` 在编译期要求 `frontendDist = "../dist"` 存在。
> 本仓库不提交前端产物（`dist/` 在 .gitignore）。在本机跑测试前，先在仓库根建一个最小占位
> `dist/index.html`（一行 HTML 即可），使 context 宏通过；该占位不会被 git 跟踪。
> 正式环境用 `npm install; npm run build` 生成真实 `dist/`。

## 覆盖清单

### 既有测试（本次未改动，约 83 个）
- `waves.rs`：波表形状 RMS、预设波形有界、锚点线性插值、粒子纹理。
- `wav.rs`：PCM16 解析、立体声→单声道平均、正弦周期提取、噪声降级归一化、
  **端到端 pipeline**（WAV→扒谱 transcribe→音色 match_tone→.plspmid 编码/解码）。
- `analyze.rs`：D4→E4 旋律检测、旋律序列时序。
- `voice.rs / engine.rs / smart.rs / arp.rs / dsp.rs / tone_match.rs / smart / wt_tests`：
  复音与偷声、力度包络、限幅器、声道增益/静音、琶音器事件、智能优化链、波表位置频谱。

### 本次新增
**单元测试（7 个）**
- `audio/fft.rs`（4）：零输入→零谱；直流→bin0 全局峰；整周期正弦→峰值落在正确 bin；
  短输入补零不 panic。
- `audio/metro.rs`（1）：节拍器默认状态（120BPM/0.5 音量/停止）。
- `audio/wav.rs` 注入测试（2）：
  - `rejects_truncated_and_malformed_wav_without_panic`：过短输入、声明超长块的截断 WAV
    → 优雅返回 `Err`，不 panic。
  - `rejects_zero_channels_or_samplerate`：channels=0 → `Err("WAV 参数非法")`。

## 注入测试

本仓库的不可信输入面是**音频文件解析**（用户打开的 WAV/OGG/MP3/MIDI）。
`parse_wav` 对畸形/截断/参数非法输入全部返回 `Result::Err`（中文错误信息给前端），
绝不 panic 或越界读。新增的 2 个注入测试即验证此行为。
其余格式（ogg/mp3/smf）由 lewton/minimp3/自写 SMF 解析，同样以 `Result` 错误传播。

## 钩子 / 事件

音频引擎的“事件链”是扒谱→音色匹配→编码（见 `wav.rs::full_pipeline_wav_to_plspmid`）：
该跨模块集成测试验证 transcribe 产出的音符能被 tone_match 逐轨消费、再被 plspmid
完整保留（音符数、力度非零、track<32、tick 单调递增）——任一环节丢失数据即断言失败。

## 预期结果

`cargo test --lib` → **90 passed; 0 failed**。

# COMMIX v0.5.1

修复补丁版本:彻底解决共振(Q)调到 0 导致程序崩溃的问题,并为 Rust/JS 内核层全部参数加上数值限制,任何极端参数值(0/NaN/越界)都不会再让音频引擎崩溃。

## 修复

- **共振 0 崩溃(核心修复)**:Biquad 滤波器系数 `alpha = sinw / (2Q)` 在 Q=0 时除零产生 NaN,音频流直接崩溃。现已对 Q 做 0.1~30 限制(0.1 等效无共振),并改用 clamp 后的值计算系数;NaN/±Inf 自动回退到边界
- **Rust 内核全参数数值限制**:`EngineParams` 新增 `sanitize()` 校验,40+ 数值字段(截止频率/ADSR/共振/LFO/滤波包络/粒子/DX 全系列)全部 clamp 到安全范围;`new()`/`set_params()` 整组灌入(预设、Tauri 命令、VST 宿主参数)强制校验
- **NaN panic 修复**:`set_param` 原 `clamp` 遇 NaN 会 panic,全部改为 `max/min` 链
- **JS 桥接层拦截**:`rust-audio.ts` 对 JS→Rust 全部参数统一限制,MIDI CC 共振映射加下限 0.1;JS 引擎 `sanitizeParams()` 兜底

## 安装

下载 `COMMIX_0.5.1_x64-setup.exe` 安装即可(WebView2 运行时系统自带)。

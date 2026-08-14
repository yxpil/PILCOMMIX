// ============================================================
// 节拍器状态(音频线程采样级调度)
// ============================================================
// 调度方式:AudioBus::metro_schedule() 每渲染块检查一次,
// 到拍点(next_sample)时:
//   - 重拍(第 1 拍,accent=true)用 1760Hz,普通拍 1175Hz
//   - 触发 60ms 衰减短音(metro_click_left 递减,在 AudioBus 渲染循环
//     末尾叠加到输出——注意叠加发生在录音捕获(push)之后,
//     保证节拍器声音不进录音文件)
//   - 拍点事件经 beat_emit 通道发前端(节拍指示灯闪烁)
//
// BPM/音量由前端节拍选项卡滑块实时设置(metro_set 命令)。

/// 节拍器状态
pub struct MetroState {
    /// 开关(前端"启动/停止"按钮)
    pub running: bool,
    /// 速度 BPM(40-240,默认 120)
    pub bpm: f32,
    /// 音量 0-1(默认 0.5)
    pub volume: f32,
    /// 已响拍数(第 4 拍为重拍,4/4 拍循环)
    pub beat: u32,
    /// 下一拍点的绝对采样时刻(采样级精确)
    pub next_sample: u64,
}

impl Default for MetroState {
    fn default() -> Self {
        Self { running: false, bpm: 120.0, volume: 0.5, beat: 0, next_sample: 0 }
    }
}

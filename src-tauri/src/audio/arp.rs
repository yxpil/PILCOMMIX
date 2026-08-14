// ============================================================
// 琶音器状态(音频线程采样级调度)
// ============================================================
// 与 TS 前端分工:前端维护"当前按住哪些音符"(heldNotes,来自
// 键盘/鼠标/MIDI 输入),按方向/速度实时同步到 Rust(arp_set);
// Rust 音频线程按八分音符步进,把琶音 NoteOn/NoteOff 注入 pending
// 事件队列(与 SMF 播放同一队列),采样级精确,杜绝 rAF 抖动。
//
// 方向(direction):
//   0 = 上行   1 = 下行   2 = 上下往返   3 = 随机
// 步进:每步一个八分音符(60/bpm/2),按住音符越多循环越丰富;
// octaves:跨八度循环次数(1-4),每轮循环整体 +12 音分位移。
//
// 注意:琶音事件固定注入通道 0(与实时演奏统一主通道的语义一致)。

/// 琶音器状态
pub struct ArpState {
    /// 开关(前端"启动/停止"或 MIDI 键盘 ARP 按钮联动)
    pub running: bool,
    /// 当前按住音符集合(前端实时同步;排序后按方向取步进)
    pub notes: Vec<u8>,
    /// 速度 BPM(20-400,默认 120)
    pub bpm: f32,
    /// 方向:0=up 1=down 2=updown 3=random
    pub direction: u8,
    /// 跨八度数 1-4
    pub octaves: u8,
    /// 当前步进序号(决定取哪个音符/哪个八度)
    pub step: u32,
    /// 下一步的绝对采样时刻
    pub next_sample: u64,
}

impl Default for ArpState {
    fn default() -> Self {
        Self { running: false, notes: Vec::new(), bpm: 120.0, direction: 0, octaves: 1, step: 0, next_sample: 0 }
    }
}

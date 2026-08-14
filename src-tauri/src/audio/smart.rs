// ============================================================
// 智能优化(自动频谱整形)
// ============================================================
// 解决的问题:
//   部分音色"某一频段往死里加" → 该频段能量占比异常 → 饱和失真,
//   且增益拉到最小仍失真(失真发生在 EQ/驱动前置环节,主增益无法消除)。
// 方案:
//   在输出频谱上实时统计 4 个频带的能量占比,过载频段(占比 > 45%)
//   自动按强度衰减(每 23ms 最多 0.8dB,上限 -12dB);分布恢复均衡
//   (占比 < 35%)后缓慢回升到 0dB。用 4 个动态 peaking EQ 实现,
//   接在手动三频段 EQ 之后、混响/延迟之前。
//
// 频带划分(采样率 44100/48000/49096 通用):
//   带0 低频   < 300Hz      (中心 200Hz)
//   带1 中低频 300-1.2kHz   (中心 800Hz)
//   带2 中高频 1.2-5kHz     (中心 3.2kHz)
//   带3 高频   > 5kHz       (中心 10kHz)
// 检测信号取自 FFT 幅度谱(256 点 → 128 bin,每 ~23ms 分析一次,
// 由 AudioBus 在 scope 事件节拍处调用 analyze)。
//
// 状态输出(gains)随 scope 事件尾部(4 个 f32)发给前端,
// "智能优化"选项卡实时显示各频带的自动衰减值。

use super::dsp;

/// 智能频谱整形器:4 频带动态 peaking EQ + 能量占比检测
pub struct SmartOpt {
    /// 总开关(前端"智能优化"选项卡)
    pub enabled: bool,
    /// 优化强度 0-1:控制衰减/回升速度(滑块,默认 60%)
    pub strength: f32,
    /// 当前各带衰减 dB(≤0,实时显示用;随 scope 事件发给前端)
    pub gains: [f32; 4],
    /// 4 个动态 peaking EQ(200 / 800 / 3.2k / 10kHz,Q=0.7)
    eq: [dsp::Biquad; 4],
    /// 上次实际应用到 EQ 的增益(避免每 23ms 重复 update 系数)
    applied: [f32; 4],
}

impl SmartOpt {
    /// 创建整形器:4 个 peaking EQ 初始 0dB(直通)
    pub fn new() -> Self {
        Self {
            enabled: false,
            strength: 0.6,
            gains: [0.0; 4],
            applied: [0.0; 4],
            eq: [dsp::Biquad::new(2, 200.0, 0.7), dsp::Biquad::new(2, 800.0, 0.7),
                 dsp::Biquad::new(2, 3200.0, 0.7), dsp::Biquad::new(2, 10000.0, 0.7)],
        }
    }

    /// 开关/强度设置;关闭时清零所有衰减并复位 EQ(直通)
    pub fn set(&mut self, enabled: bool, strength: f32) {
        self.enabled = enabled;
        self.strength = strength.clamp(0.0, 1.0);
        if !enabled {
            self.gains = [0.0; 4];
            self.apply_gains();
        }
    }

    /// 把当前目标增益同步到 EQ 系数(只在变化超过 0.01dB 时更新,
    /// 避免音频线程频繁重算 Biquad 系数)
    pub fn apply_gains(&mut self) {
        for i in 0..4 {
            if (self.gains[i] - self.applied[i]).abs() > 0.01 {
                self.applied[i] = self.gains[i];
                self.eq[i].gain_db = self.gains[i];
                self.eq[i].update(self.eq[i].freq, 0.7);
            }
        }
    }

    /// 逐样本处理(音频渲染链:drive → 手动EQ → 智能整形 → 混响/延迟)
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        if !self.enabled { return x; }
        let mut y = x;
        for i in 0..4 { y = self.eq[i].next(y); }
        y
    }

    /// 频谱分析(每 ~23ms 调用一次):按各带能量占比调整衰减
    /// - bands: 4 个频带的能量(线性,来自 FFT 幅度平方)
    /// - total: 总能量(静音时不动作,防止对无信号状态误调)
    pub fn analyze(&mut self, bands: [f32; 4], total: f32) {
        if !self.enabled { return; }
        if total < 1e-5 { return; }   // 静音不动作
        let s = self.strength;
        for i in 0..4 {
            let ratio = bands[i] / total.max(1e-6);
            if ratio > 0.45 {
                // 该带主导(过载)→ 按强度衰减,每 23ms 最多 0.8dB,上限 -12dB
                self.gains[i] = (self.gains[i] - 0.8 * s).max(-12.0);
            } else if ratio < 0.35 {
                // 分布均衡 → 缓慢回升(每 23ms +0.3dB,上限 0dB)
                self.gains[i] = (self.gains[i] + 0.3 * s).min(0.0);
            }
        }
        self.apply_gains();
    }
}

// ============================================================
// FFT 频谱分析(示波器 + 智能优化共用)
// ============================================================
// 迭代 radix-2 FFT,输入 256 点 → 输出 128 个幅度 bin。
// 用途:
//   1. 示波器选项卡的频谱显示(scope 事件携带 128 个幅度)
//   2. 智能优化(SmartOpt)的频带能量检测
//
// 关键点:Hann 窗。
//   矩形窗(无窗)在信号频率非 bin 整数倍时,旁瓣只衰减约 -13dB,
//   会污染整个高频区——实测纯正弦也能算出 94% 的"假谐波",
//   导致频谱显示底噪虚高、智能优化频带检测误判。
//   加 Hann 窗后旁瓣衰减到约 -31dB(纯正弦假谐波从 0.94 → 0.014)。
//
// 幅度归一化:mag[i] = |X[i]| / n,Hann 窗的相干增益 0.5 使幅度减半,
// 但各 bin 相对关系正确(显示/检测只看相对值,不做额外补偿)。

/// 256 点 → 128 bin 幅度谱(带 Hann 窗)
/// 输入 x 至少 n 个样本(音频线程取 post-drive 缓冲);n 必须是 2 的幂
pub fn fft_magnitudes(x: &[f32], n: usize) -> Vec<f32> {
    let mut re: Vec<f64> = vec![0.0; n];
    let mut im: Vec<f64> = vec![0.0; n];

    // Hann 窗 + 拷贝输入(超出输入长度的部分补零)
    for i in 0..n.min(x.len()) {
        let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
        re[i] = x[i] as f64 * w;
    }

    // 位反转重排(标准迭代 FFT 第一步)
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    // 蝶形运算:len 从 2 翻倍到 n,每层 half 对旋转因子
    let mut len = 2usize;
    while len <= n {
        let ang = -std::f64::consts::TAU / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut i = 0usize;
        while i < n {
            // 当前块内的旋转因子逐次递推(w^k,避免每点重算三角函数)
            let (mut cwr, mut cwi) = (1.0f64, 0.0f64);
            for k in 0..half {
                let vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
                let vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
                re[i + k + half] = re[i + k] - vr;
                im[i + k + half] = im[i + k] - vi;
                re[i + k] += vr;
                im[i + k] += vi;
                let ncwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = ncwr;
            }
            i += len;
        }
        len <<= 1;
    }

    // 幅度谱(只取正频率前一半;除以 n 归一化)
    let mut mag = vec![0.0f32; n / 2];
    for i in 0..n / 2 {
        mag[i] = ((re[i] * re[i] + im[i] * im[i]) as f32).sqrt() / n as f32;
    }
    mag
}

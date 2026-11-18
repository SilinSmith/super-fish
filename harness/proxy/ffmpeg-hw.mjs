/**
 * 核显解码策略（按 2026-11-14 实测结果分路径选择）。
 *
 * 三条硬解路线，各有适用面：
 *   qsv   —— 帧全程留在显存（-hwaccel_output_format qsv），缩放用 scale_qsv，
 *            最后 hwdownload 一次。用于场景检测这类必须全帧解码的任务。
 *   d3d11 —— 只硬解、逐帧下载回内存。关键优点是它认 -skip_frame nokey，
 *            可以只解码关键帧（QSV 解码器会忽略该参数，退化成全帧）。
 *   off   —— 纯软解，兜底。
 *
 * 开关：QQ_FFMPEG_HWACCEL=qsv|d3d11|off（默认开；off 可整体退回软解）。
 * 实测：720p 低码率下，全 GPU 链比软解慢约 3~4 倍，但 CPU 占用只有 1/6；
 *       关键帧提取用 d3d11 + skip_frame 与软解同量级，且不占 CPU 解码。
 */
export const HW_MODE = (process.env.QQ_FFMPEG_HWACCEL ?? 'on').trim().toLowerCase();
export const HW_ON = HW_MODE !== 'off';
export const QSV_ARGS = ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'];
export const D3D_ARGS = ['-hwaccel', 'd3d11va'];

let announced = false;

/** 每个进程只打一行，用来确认这轮跑的到底是核显还是软解。 */
export function announceHw() {
    if (announced) return;
    announced = true;
    console.log('[硬解] 模式=' + (HW_ON ? '核显开（失败回落软解，可用 QQ_FFMPEG_HWACCEL=off 关闭）' : 'off（纯软解）'));
}

/** 把硬解参数插到 -i 之前；没有 -i 就原样返回。 */
export function withHwAccel(args, hwArgs = QSV_ARGS) {
    const at = args.indexOf('-i');
    if (at < 0) return [...args];
    return [...args.slice(0, at), ...hwArgs, ...args.slice(at)];
}

export function hwFailureText(error) {
    const raw = String(error?.stderr ?? error?.message ?? error ?? '');
    return raw.trim().split(/\r?\n/u).filter(Boolean).slice(-2).join(' | ').slice(0, 300);
}

/** 回退日志：哪个文件、什么原因、回落到软解。必须每次都有。 */
export function logHwFallback(file, label, error) {
    console.log('[硬解回退] ' + label + ' file=' + file + ' 原因=' + hwFailureText(error) + ' → 回落软解');
}

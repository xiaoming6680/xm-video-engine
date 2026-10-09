// 项目设置（每个项目改这一个文件）。引擎（src/engine）和渲染脚本（scripts/render*.ts）都从这里读，
// 所以这里只能写常量，不能用浏览器 API 或 import.meta.glob。时间都是「歌曲秒」（audio/ 和 data/ 里的时间轴）。

/** 逻辑画布：场景按这个尺寸排版（`?scale=2` 时输出两倍分辨率）。横版 1920×1080，竖版（抖音）1080×1920。 */
export const W = 1920;
export const H = 1080;

/** 视频在歌里的起止（秒）。VIDEO_END 为 null 时到歌曲结尾。 */
export const VIDEO_START = 0;
export const VIDEO_END: number | null = null;

/** 歌曲音频，相对项目根目录（预览播放和导出都用它）。 */
export const AUDIO = 'audio/song.wav';

/** 导出的默认文件名（相对项目根目录）。 */
export const OUT = 'out/film.mp4';

/**
 * 导出时的音频处理（ffmpeg -af 滤镜链）。null = 原样。
 * 母带很响时可用：'volume=-3dB,alimiter=limit=0.84:attack=1:release=50:level=false'（再加淡入淡出）。
 */
export const AUDIO_FILTER: string | null = null;

/** 你的署名：角落水印（场景返回 post.watermark > 0 时才显示）和 tools/cover_title.py 封面底部的「BY …」都用它。空 = 不署名。 */
export const CREDIT = '';

/**
 * 额外字体：public/fonts/ 下的文件，family 是 Canvas2D 里用的名字。文件不存在时只警告、不阻止启动。
 * 例：系统里的苹方、华文行楷是商业字体，只放在自己项目里用，不进基础引擎。
 *   { family: 'PingFang-500', file: 'PingFang-Medium.ttf' }, { family: 'STXingkai', file: 'STXingkai.ttf' }
 */
export const EXTRA_FONTS: { family: string; file: string; features?: string }[] = [];

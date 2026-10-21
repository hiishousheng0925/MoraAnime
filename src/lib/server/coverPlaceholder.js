/**
 * 各来源的「无图」占位图。它们是合法的图片、内容也不小，按「是不是图片 + 够不够大」
 * 判断会被当成真封面缓存下来 —— 体检时 data/covers 里 53 部不同的番共用同一张 no_pic，
 * anime-planet 的季节默认图也各有 8、9 张。
 *
 * 两道识别：URL 一眼能认出来的不去抓；URL 认不出、抓回来内容是已知占位图的按 md5 认。
 */
import { createHash } from 'node:crypto';

const URLS = [
  /anime-offline-database\/master\/pics\/no_pic/,          // AOD：no_pic.png / no_pic_thumbnail.png
  /anime-planet\.com\/images\/anime\/default\//,           // anime-planet：default-anime-<季节>.png
  /anisearch\.com\/images\/anime\/cover\/(?:hentai|ecchi)\.v\d/,   // anisearch：成人向统一占位
  /anilistcdn\/media\/anime\/cover\/\w+\/default\.jpg/     // anilist：default.jpg
];

/** data/covers 里实测到的占位图内容（md5） */
const MD5 = new Set([
  'f4fa3547a8483eb46aac7c50b5bc4def',   // AOD no_pic.png
  '1d771053c5726dc01c5d9d0e14f445d8',   // anime-planet default-anime-spring
  '74152db1b1b8925897340d123c8bfbda',   // anime-planet default-anime-summer
  'a911a54f436b5516210616f0e8daa8fb',   // anisearch hentai
  'b5d8ac99123810feea167c7995710d16'    // anisearch ecchi
]);

export const isPlaceholderUrl = (u) => !!u && URLS.some((re) => re.test(u));
export const isPlaceholderBuf = (buf) => MD5.has(createHash('md5').update(buf).digest('hex'));

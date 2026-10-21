/**
 * 手工校正的中文名（issue #14）。
 *
 * 这几条在 Bangumi 上对不上条目（bgm_id 为空），中文名是早年模糊匹配留下的、属于另一部作品的；
 * 自动规则修不了（清掉中文名的规则会误伤大量正确的系列名，见 #14 的讨论），只能逐条手修。
 * 每日同步（ingest-bgm.js 收尾）都会再套一遍：哪天重灌库、或别的脚本又写回错名字，第二天自己改回来。
 * 某条以后匹配上了 Bangumi（bgm_id 不再为空）就不再碰它 —— 那时以 Bangumi 为准。
 *
 * 加条目前先确认：id 是 anime.id（番单挂在它上面、不会变），名字查过出处。
 */
import { segment } from './text.js';

export const CN_MANUAL = [
  // 原「排球少年！！垃圾场决战」= 2024 年的剧场版；这条是 2015 年的两部总集篇剧场版
  { id: 10313, cn: '排球少年！！剧场版总集篇 结束与开始 / 胜者与败者' },
  // 原「约会大作战」= 本篇 TV；这条是外传剧场版《DATE A BULLET》（2020，两部）
  { id: 6652, cn: '约会大作战 赤黑新章 DATE A BULLET' },
  // 原「吸血鬼幸存者」= 2022 年的游戏改编；这条是手冢治虫的《バンパイヤ》（1968，虫制作，真人+动画）
  { id: 37674, cn: '吸血鬼（手冢治虫，1968）' },
  // 原「猫和老鼠（1965年电视版）」；这条是 2021 年华纳的电影（日本 2021-03-19 上映）
  { id: 36083, cn: '猫和老鼠（2021 电影）' }
];

/** @returns {number} 实际改了几条（已经是对的就不动，跑第二次是 0） */
export function applyCnManual(db) {
  const get = db.prepare('SELECT id, title, title_ja, title_cn, bgm_id FROM anime WHERE id = ?');
  const upd = db.prepare('UPDATE anime SET title_cn = ? WHERE id = ?');
  // 别名来源记成 'manual'：src='bgm' 只放 Bangumi 给的中文名（e2e 有不变式守着），不能混进去
  const delAlias = db.prepare("DELETE FROM anime_alias WHERE anime_id = ? AND src = 'manual'");
  const insAlias = db.prepare(`INSERT INTO anime_alias (anime_id, alias, has_kana, is_cjk, src)
    SELECT ?, ?, 0, 1, 'manual' WHERE NOT EXISTS (SELECT 1 FROM anime_alias WHERE anime_id = ? AND alias = ?)`);
  const names = db.prepare("SELECT group_concat(alias, ' ') a FROM anime_alias WHERE anime_id = ?");
  const delFts = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
  const insFts = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
  const hasAlias = db.prepare("SELECT 1 FROM anime_alias WHERE anime_id = ? AND src = 'manual' AND alias = ?");
  let n = 0;
  for (const { id, cn } of CN_MANUAL) {
    const a = get.get(id);
    // 别名也要在：AOD 月度全量灌库会清掉 src <> 'bgm' 的别名（ingest-aod.js），名字对、别名没了也得补回去
    if (!a || a.bgm_id || (a.title_cn === cn && hasAlias.get(id, cn))) continue;
    upd.run(cn, id);
    delAlias.run(id);
    insAlias.run(id, cn, id, cn);
    // 中文名进了搜索索引，改完必须重建这一行，否则按新名字搜不到
    delFts.run(id);
    insFts.run(id, segment([a.title, a.title_ja, cn, names.get(id).a].filter(Boolean).join(' ')));
    n++;
  }
  return n;
}

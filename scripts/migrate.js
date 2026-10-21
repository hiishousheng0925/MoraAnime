/**
 * 跑一遍 schema 迁移。启动服务前必须先跑。
 *
 * ⚠️ 为什么需要它：应用本身从不调 initSchema（getDb 只开连接），
 * 迁移只在某个脚本跑的时候才顺带执行。于是「代码里加了一列 → 部署 →
 * 下一次定时同步之前」这段时间里，应用会因为缺列直接 500。
 * 实测：saved_filter.is_default 加进 MIGRATIONS 后，测试站的 dev.db 没这列，
 * /catalog 全部 500。
 */
import { getDb, initSchema, DB_PATH } from '../src/lib/server/db.js';
import { backfillCompletedEpisodes, backfillTouchedVague } from '../src/lib/server/queries/user.js';
import { applyCnManual } from '../src/lib/server/cnManual.js';
import { normStudio, STUDIO_NORM_VERSION } from '../src/lib/server/text.js';

const db = getDb();
initSchema(db);
// 数据回填：历史上快速标记建的「看完」记录没补集数（详情页「未填」+ 空进度条，
// 而统计按全集算）。逻辑放在 queries/user.js，写入路径和回填路径共用一套规则。
const filled = backfillCompletedEpisodes();
// 快速标记建的记录被用户打过分 / 改过的，清掉 is_vague（否则「撤销上一批」会把它删掉）
const untagged = backfillTouchedVague();
// 手工校正的中文名（#14）：发布 / 重启时就生效，不必等第二天的同步。已经是对的就不动
const cnFixed = applyCnManual(db);
// 公司名归一规则改了（#109：8-bit / 8 bit / 8bit 合并、去变音符号）→ 重算存着的 studio_norm，按版本号只跑一次
let studioRenorm = 0;
const sv = +(db.prepare("SELECT value FROM meta WHERE key = 'studio_norm_v'").get()?.value ?? 1);
if (sv < STUDIO_NORM_VERSION) {
  const upd = db.prepare('UPDATE anime_studio SET studio_norm = ? WHERE rowid = ?');
  db.exec('BEGIN');
  for (const r of db.prepare('SELECT rowid, studio, studio_norm FROM anime_studio').all()) {
    const n = normStudio(r.studio);
    if (n !== r.studio_norm) { upd.run(n, r.rowid); studioRenorm++; }
  }
  // 筛选器选项缓存里存的是旧归一名和旧写法，作废掉让它按新规则重建（不删的话目录下拉还是 Olm / 8-Bit 三家）
  db.exec("DELETE FROM facet_cache");
  db.prepare("INSERT INTO meta (key, value) VALUES ('studio_norm_v', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(STUDIO_NORM_VERSION));
  db.exec('COMMIT');
}

const cols = (t) => db.prepare(`SELECT count(*) c FROM pragma_table_info(?)`).get(t).c;
console.log(`✔ schema 已就位 ${DB_PATH}`);
console.log(`  anime ${cols('anime')} 列 · saved_filter ${cols('saved_filter')} 列`);
if (filled) console.log(`  回填「看完」集数 ${filled} 条`);
if (cnFixed) console.log(`  手工校正中文名 ${cnFixed} 条`);
if (studioRenorm) console.log(`  公司名重新归一 ${studioRenorm} 条`);
if (untagged) console.log(`  清掉已被改过的快速标记记录的 is_vague ${untagged} 条`);

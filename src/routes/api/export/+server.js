import { exportData, exportCsv } from '$lib/server/backup.js';

// 下载文件名带品牌：桌面客户端导出的叫 MoraAnime-…（2026-10-22 审查）
const BRAND = process.env.J_ANIME_BRAND || 'j-anime';

export function GET({ url }) {
  const fmt = url.searchParams.get('format') ?? 'json';
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'csv') {
    return new Response(exportCsv(), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${BRAND}-${stamp}.csv"`
      }
    });
  }
  return new Response(JSON.stringify(exportData(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${BRAND}-backup-${stamp}.json"`
    }
  });
}

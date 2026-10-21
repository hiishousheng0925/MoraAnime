import { exportData, exportCsv } from '$lib/server/backup.js';

export function GET({ url }) {
  const fmt = url.searchParams.get('format') ?? 'json';
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'csv') {
    return new Response(exportCsv(), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="j-anime-${stamp}.csv"`
      }
    });
  }
  return new Response(JSON.stringify(exportData(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="j-anime-backup-${stamp}.json"`
    }
  });
}

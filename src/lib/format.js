/**
 * 显示层格式化。
 * 标题回退顺序：中文名 → 罗马字/英文名 → 日文原名。
 * 罗马字排在假名前 —— 「Bocchi the Rock! 2」对中文读者比「ぼっち・ざ・ろっく！2」可读得多。
 */
export const dispTitle = (a) => a?.title_cn || a?.title || a?.title_ja || '(无标题)';

/** 副标题：显示还没被主标题用掉的那个名字 */
export function subTitle(a) {
  const main = dispTitle(a);
  for (const t of [a?.title_ja, a?.title]) if (t && t !== main) return t;
  return null;
}

export const yearText = (a) => a?.year ?? '年份未知';

/** 制作公司名的展示化：库里存的是全小写（"a-1 pictures"、"j.c.staff"），
 *  按字母段首字母大写 —— 点和连字符后面也要跟着大写；带变音符号的字母算在词里（#109：原来「DōGa KōBō」） */
export const titleCase = (s) =>
  // 撇号算词内（Brain's 不是 Brain'S）；数字开头的词不动（1st 不是 1St）
  String(s ?? '').replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, (w) => (/\p{L}/u.test(w[0]) ? w[0].toUpperCase() + w.slice(1) : w));

/**
 * 官方写法不是「首字母大写」的公司（#109：原来显示成 Olm / Dle / Tms / Mappa）。
 * 源数据全是小写，缩写认不出来，只能列表；没列到的照常首字母大写
 */
const STUDIO_CASE = [
  [/\bOlm\b/g, 'OLM'], [/\bDle\b/g, 'DLE'], [/\bTms\b/g, 'TMS'], [/\bMappa\b/g, 'MAPPA'], [/\bShaft\b/g, 'SHAFT'],
  [/\bUfotable\b/g, 'ufotable'], [/\bCloverworks\b/g, 'CloverWorks'], [/\bJ\.\s?C\.\s?Staff\b/g, 'J.C.Staff'],
  [/\bP\.A\.\s?Works\b/g, 'P.A.Works'], [/\bC2c\b/g, 'C2C'], [/\b8[\s-]?Bit\b/g, '8bit'], [/\bWit Studio\b/g, 'WIT Studio'],
  [/\bCygamespictures\b/g, 'CygamesPictures'], [/\bLidenfilms\b/g, 'LIDENFILMS'], [/\bTnk\b/g, 'TNK'],
  [/\bSanzigen\b/g, 'SANZIGEN'], [/\bGainax\b/g, 'GAINAX'], [/\bTrigger\b/g, 'TRIGGER'], [/\bZexcs\b/g, 'ZEXCS'],
  [/\bAic\b/g, 'AIC'], [/\bGonzo\b/g, 'GONZO'], [/\bXebec\b/g, 'XEBEC'], [/\bBones\b/g, 'BONES'],
  [/\bSilver Link\.?/g, 'SILVER LINK.'], [/^Feel\.?$/g, 'feel.'], [/\bStudio Voln\b/g, 'Studio VOLN'],
  [/\bStudio 3hz\b/g, 'Studio 3Hz'], [/\bEngi\b/g, 'ENGI'], [/\bNaz\b/g, 'NAZ'], [/\bPa Works\b/g, 'P.A.Works'], [/^Eightbit$/g, '8bit'],
  [/\bArms\b/g, 'ARMS'], [/\bIlca\b/g, 'ILCA'], [/\bAcgt\b/g, 'ACGT'], [/\bAppp\b/g, 'APPP'], [/\bTcj\b/g, 'TCJ'],
  [/\bSignal\.Md\b/g, 'Signal.MD'], [/\bEmt\b/g, 'EMT'], [/\bDmm\.Futureworks\b/g, 'DMM.futureworks'], [/\bBn\b/g, 'BN'],
  [/\bIms\b/g, 'IMS'], [/\bTyo\b/g, 'TYO'], [/\bHal\b/g, 'HAL']
];

/** 公司名展示化：去掉 "co., ltd." 这类后缀噪音，再按字母段首字母大写，最后套官方写法。
 *  不能直接美化 studio_norm —— norm 把标点去掉了（j.c.staff → "j c staff"） */
export const dispStudio = (s) => {
  // 后缀可能叠着出现（「8bit corp, inc.」），去到没有为止
  let t = String(s ?? '').trim(), prev;
  do { prev = t; t = t.replace(/[,\s]*\b(co\.?,?\s*ltd\.?|inc\.?|k\.k\.|ltd\.?|llc|corp\.?)\.?$/i, '').trim(); } while (t !== prev);
  t = titleCase(t);
  for (const [re, v] of STUDIO_CASE) t = t.replace(re, v);
  return t;
};

/**
 * 分集标题：只要中文（主人 2026-10-19「不要日文」）。有中文标题用中文；
 * 没有时原标题若带假名（日文）就不显示，纯英文 / 数字的（「THE BLADE」）照常显示。
 */
const KANA = /[぀-ヿㇰ-ㇿ]/;
export const epTitle = (e) => e?.name_cn || (e?.name && !KANA.test(e.name) ? e.name : '');

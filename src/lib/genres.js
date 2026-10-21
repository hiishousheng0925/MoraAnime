/**
 * 中文题材 → 标签映射（人工整理）。英文的是 AOD 标签，中文的是 Bangumi 用户标签（#2：
 * 换数据源后 bgm 条目只带 bgm 标签；只写进跟题材对得上的那些，见 scripts/ingest-bgm.js）。
 *
 * 为什么要映射：AOD 的原始 tag 有大量非题材噪音
 * （japanese production 11496、present、place、earth、asia、tropes、cgi…），
 * 而且同义词分裂（sci-fi / science fiction / science-fiction / sci fi 四种写法）。
 * 直接拿 top tags 当「题材」筛选很难用，所以做一层收敛。
 * 下面每个 tag 都已在库里实测存在。
 */
export const GENRES = [
  // 常见大类
  ['动作',     ['action', 'fighting', '战斗', '动作']],
  ['冒险',     ['adventure', '冒险']],
  ['喜剧',     ['comedy', '喜剧']],
  ['搞笑',     ['slapstick', 'parody', 'gag', '搞笑', '吐槽', '恶搞']],
  ['剧情',     ['drama', '剧情']],
  ['爱情',     ['romance', 'love triangle', '恋爱', '纯爱']],
  ['奇幻',     ['fantasy', '奇幻', '玄幻']],
  ['科幻',     ['sci-fi', 'science fiction', 'science-fiction', 'sci fi', 'speculative fiction', '科幻', 'SF']],
  ['日常治愈', ['slice of life', 'iyashikei', '日常', '治愈', '治愈系']],
  ['校园',     ['school', 'school life', 'high school', '校园']],
  ['青春',     ['coming of age', 'seinen', '青春']],
  ['热血',     ['shounen', '热血']],
  ['悬疑',     ['suspense', 'thriller', 'mystery', '悬疑']],
  ['推理',     ['detective', 'mystery', 'police', '推理']],
  ['惊悚',     ['thriller', 'psychological', '惊悚', '猎奇']],
  ['恐怖',     ['horror', 'gore', '恐怖']],
  ['悲剧',     ['tragedy', '致郁', '悲剧']],
  // 设定 / 题材
  ['异世界',   ['isekai', '异世界', '穿越']],
  ['魔法',     ['magic', 'magical girl', '魔法', '魔法少女']],
  ['神魔',     ['demons', 'gods', 'mythology', 'supernatural', '神魔', '超能力']],
  ['机战',     ['mecha', 'robot', 'super robot', '机战', '萝卜', '高达']],
  ['格斗',     ['martial arts', 'super power', '格斗']],
  ['武侠',     ['wuxia', 'swordplay', '武侠']],
  ['战争',     ['war', 'military', '战争']],
  ['历史',     ['historical', '历史']],
  ['太空',     ['space', 'space opera', '宇宙', '太空']],
  ['灾难',     ['disaster', 'survival', 'post-apocalyptic', 'apocalypse', '末日', '生存']],
  ['犯罪',     ['crime', 'organized crime', 'yakuza', '犯罪']],
  ['社会',     ['social commentary', '社会']],
  ['职场',     ['workplace', 'work life', 'office', '职场']],
  ['西部',     ['western', '西部']],
  // 兴趣向
  ['竞技',     ['sports', 'competition', 'tournament', '运动', '竞技', '体育']],
  ['音乐',     ['music', 'band', '音乐']],
  ['歌舞',     ['dance', 'musical', '歌舞']],
  ['偶像',     ['idol', '偶像']],
  ['美食',     ['food', 'cooking', 'gourmet', '美食']],
  ['游戏',     ['game', 'video game', '游戏']],
  // 受众 / 关系向
  ['少年',     ['shounen', '少年向']],
  ['少女',     ['shoujo', '少女向']],
  ['青年向',   ['seinen', '青年向']],
  ['女性向',   ['josei', '女性向']],
  ['乙女向',   ['reverse harem', 'otome game', '乙女向']],
  ['后宫',     ['harem', '后宫']],
  ['百合',     ['yuri', 'girls love', 'shoujo ai', '百合']],
  ['耽美',     ['yaoi', 'boys love', 'shounen ai', '耽美', 'BL', '腐']],
  ['美少女',   ['cute girls doing cute things', 'cgdct', 'moe', 'bishoujo', '萌', '美少女']],
  ['萝莉',     ['loli', 'lolicon', '萝莉']],
  ['卖肉',     ['ecchi', 'fan service', 'fanservice', '卖肉', '肉番']],
  ['亲子',     ['kids', 'family friendly', '子供向', '亲子']],
  ['成长',     ['coming of age', '励志', '成长']],
  ['短片',     ['shorts', 'short episodes', '短片', '泡面番', '泡面']]
];

export const GENRE_MAP = Object.fromEntries(GENRES);
export const GENRE_NAMES = GENRES.map(([n]) => n);


/**
 * 非题材噪音标签 —— 详情页不显示这些。
 * AOD 的 tag 混了大量元数据式标签（产地、时代、地点、载体、制作方式），
 * 对「这部番讲什么」毫无帮助。
 */
export const TAG_NOISE = new Set([
  'japanese production', 'present', 'place', 'time', 'earth', 'asia', 'japan',
  'manga', 'based on a manga', 'based on a 4-koma manga', '4-koma manga',
  'original work', 'tropes', 'cgi', 'mixed media', 'live-action imagery',
  'short episodes', 'shorts', 'meta', 'awards', 'newtype anime award',
  'anime', 'television', 'animation', 'other', 'real-world location',
  'colour coded', 'character driven', 'primarily female cast', 'primarily male cast',
  'predominantly female cast', 'predominantly male cast', 'primarily teen cast',
  'primarily adult cast', 'primarily child cast', 'female protagonist',
  'male protagonist', 'non-human protagonists', 'ensemble cast',
  'based on a light novel', 'based on a game', 'based on a novel',
  'based on a visual novel', 'based on a web novel', 'novel', 'light novel',
  'game', 'video game', 'seasonal', 'sequel', 'prequel', 'spin-off',
  'no dialogue', 'silent', 'episodic', 'anthology', 'compilation'
]);

/** 英文 tag → 中文题材名（反查表，用于详情页把标签显示成中文） */
export const TAG_TO_GENRE = (() => {
  const m = {};
  for (const [cn, tags] of GENRES) for (const t of tags) m[t] = cn;
  return m;
})();

/**
 * NSFW 判定。
 *
 * ⚠️ 文档原方案用 AniList 的 `isAdult`，但新主源 AOD 没有这个字段。
 * 改用标签后又发现：**标签体系描述的是剧情内容，不是分级**。
 * 实测 `pornography` / `rape` / `incest` / `bdsm` / `ecchi` / `harem` 这些
 * 大量出现在主流 TV 番上（无职转生、刀剑神域、斩服少女、游戏人生…），
 * 用它们判定会把 4000+ 部正常番误杀。
 *
 * 唯一可靠的是 `hentai`：1721 条中 92% 是 OVA，仅 5 条 TV，
 * 且没有任何高人气条目（最高收藏 585），交叉验证无误标。
 * 另加 `18 restricted`（22 条，明确的分级标记）。
 */
export const NSFW_TAGS = ['hentai', '18 restricted'];
// bgm 侧不靠标签判：直接用 Archive 的 nsfw 标记（anime.bgm_nsfw，见 scripts/mark-nsfw.js）

'use strict';

/* デモ用のサンプルノート（memos.json の形）と、設定（登録するタグ・タグボタンのセット）。
 * 「午前の集中が続かない」という課題のまわりに、主張・根拠・反論・原因・続きの関連線でつながったメモと、
 * 関係の無いメモ（買い物・読みたい本）、領域、Dendritic Extension（順路と枝）、未配置の棚を置く。
 * 日付は作った日（now）から数日〜3週間前に散らす（今日の1枚・足あとの見え方が自然になるように）。 */

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function buildSample(now = new Date()) {
  const ago = (days, hours = 0) => new Date(now.getTime() - (days * 24 + hours) * 3600 * 1000).toISOString();
  let nextComment = 900;
  const comment = (text, days, parentId) => ({ id: id(nextComment++), text, createdAt: ago(days), ...(parentId ? { parentId } : {}) });
  const memo = (n, text, days, extra = {}) => ({
    id: id(n), text, createdAt: ago(days, 3), updatedAt: ago(days), likedLevel: 0, liked: false, bookmarked: false, comments: [], ...extra,
  });

  const c1 = comment('2週目から効果が出はじめた気がする', 9);
  const memos = {
    '0,0': memo(1, '課題：午前中の集中が続かない\n10時を過ぎると手が止まりがち', 21, { tags: ['課題'], likedLevel: 1, liked: true }),
    '1,0': memo(2, '主張：朝の散歩は午前の集中力を上げる', 18, {
      tags: ['仮説', '健康'], likedLevel: 2, liked: true, bookmarked: true,
      comments: [c1, comment('天気の影響も分けて見ておく', 8, c1.id), comment('次は歩く時間を 10分 と 20分 で比べたい', 3)],
    }),
    '2,0': memo(3, '根拠：歩いた日は午前の作業が2割はかどった\n3週間の記録（12日分）より。歩かなかった日との比較', 12, { tags: ['記録'], comments: [comment('記録は「作業できた時間」を 15 分単位で', 11)] }),
    '2,-1': memo(4, '根拠：朝の光を浴びると体内時計が整い、日中の眠気が減るという研究がある', 15, { tags: ['文献'] }),
    '1,-1': memo(5, '反論：雨の日や寒い日は続かない\n実際、雨の週は 2 日しか歩けなかった', 10, { tags: ['課題'] }),
    '3,-1': memo(6, '雨の日は室内でストレッチ 10 分に置き換える', 7, { tags: ['対策'] }),
    '0,1': memo(7, '原因：起きてすぐスマホを見ると、そのまま 30 分過ぎてしまう', 16, { tags: ['課題'] }),
    '-1,1': memo(8, '対策：起きてから 30 分はスマホを別の部屋に置く', 14, { tags: ['対策'], likedLevel: 1, liked: true }),
    '1,1': memo(9, '睡眠の質との関係も調べたい', 9),
    '2,1': memo(10, 'コーヒーは散歩のあとに飲むほうが効く？', 6, { comments: [comment('明日から試す', 5)] }),
    '-1,0': memo(11, '記録のつけ方：作業できた時間を 15 分単位で、毎日 12 時に', 13, { tags: ['記録'] }),
    '3,0': memo(12, '週末は少し遠回りして公園まで歩く', 4),
    '0,-1': memo(13, '起きたら窓を開けて光を入れる', 11, { tags: ['対策'] }),
    '-3,2': memo(14, '買い物：卵・牛乳・コーヒー豆', 2),
    '-2,2': memo(15, '読みたい本：『習慣の科学』\n図書館で予約済み', 5, { tags: ['読書'] }),
  };
  const link = (a, b, kind, days, label) => ({ a: id(a), b: id(b), createdAt: ago(days), ...(kind ? { kind } : {}), ...(label ? { label } : {}) });
  const links = [
    link(3, 2, 'support', 12, '記録'),
    link(4, 2, 'support', 15),
    link(5, 2, 'against', 10),
    link(5, 6, 'next', 7),
    link(2, 1, 'related', 18, '対策の案'),
    link(7, 1, 'cause', 16),
    link(7, 8, 'next', 14),
    link(2, 9, 'related', 9),
    link(2, 10, 'related', 6),
    link(11, 3, 'related', 13),
    link(2, 12, 'next', 4),
  ];
  const store = {
    version: 2,
    camera: { x: 230, y: 30, zoom: 0.72 },
    memos,
    links,
    regions: [{ id: 'walk', name: '朝の散歩', keys: ['1,0', '2,0', '2,-1', '1,-1', '3,-1'], color: '#1d9bf0' }],
    dendrites: [
      { id: 'routine', name: '朝のルーティン', color: '#f91880', steps: [id(8), id(13), id(2), id(10)] },
      { id: 'rainy', name: '雨の日', color: '#a78bfa', parentId: 'routine', at: 2, steps: [id(5), id(6)] },
    ],
    shelf: [
      memo(20, '夜のルーティンも同じように考えてみる', 1),
      memo(21, '同僚に散歩の話をしたら、昼休みに試すとのこと', 0),
    ],
  };
  const tags = [
    { name: '仮説', color: '#1d9bf0', uses: 6 },
    { name: '記録', color: '#00ba7c', uses: 5 },
    { name: '文献', color: '#a78bfa', uses: 3 },
    { name: '課題', color: '#f4212e', uses: 4 },
    { name: '対策', color: '#f59e0b', uses: 4 },
    { name: '健康', color: '#14b8a6', uses: 2 },
    { name: '読書', color: '#eab308', uses: 1 },
  ];
  // タグボタンのセット（枠は 9 つ。ハニカムでは最初の 6 つ）
  const tagSets = [
    { id: 'study', name: '研究', tags: ['仮説', '記録', '文献', '課題', '対策', '健康', '', '', ''] },
    { id: 'life', name: '生活', tags: ['読書', '健康', '対策', '', '', '', '', '', ''] },
  ];
  return { name: '午前の集中ノート', store, settings: { tags, tagSets, tagSetActive: 'study' } };
}

module.exports = { buildSample, id };

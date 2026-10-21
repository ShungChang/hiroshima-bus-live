export const SOURCE_URL = 'https://www.bus-kyo.or.jp/gtfs-open-data';
const mobusta = (id, name, color) => ({
  id: String(id), name, color,
  static: `https://ajt-mobusta-gtfs.mcapps.jp/static/${id}/current_data.zip`,
  feeds: Object.fromEntries(Object.entries({vehicles:'vehicle_position', trips:'trip_updates', alerts:'alerts'})
    .map(([key, file]) => [key, `https://ajt-mobusta-gtfs.mcapps.jp/realtime/${id}/${file}.bin`]))
});
const vision = (id, name, color) => ({id,name,color,
  static: `https://bus-vision.jp/gtfs_v2/${id}/gtfsFeed`,
  feeds: Object.fromEntries(Object.entries({vehicles:'vpos',trips:'trip',alerts:'alrt'})
    .map(([key, file]) => [key, `https://bus-vision.jp/realtime/${id}_${file}_update_v2.bin`]))
});
export const PROVIDERS = [
  mobusta(8,'広島電鉄','#087e71'), mobusta(9,'広島バス','#c53d52'),
  mobusta(10,'広島交通（広交観光・井原線含む）','#2864bd'), mobusta(11,'芸陽バス','#9a5900'),
  mobusta(12,'備北交通','#7755b0'), mobusta(15,'JRバス中国','#007d9d'),
  mobusta(13,'エイチ・ディー西広島（ボン・バス）','#d14c16'), mobusta(14,'フォーブル','#735343'),
  mobusta(17,'ささき観光（おおのハートバス）','#a93d85'),
  {...mobusta(18,'呉市生活バス','#3b6385'),note:'一部路線はリアルタイム配信の対象外です。'},
  mobusta(19,'廿日市市自主運行バス','#5a7124'), mobusta(54,'朝日交通 阿戸熊野線（阿戸線）','#8c5155'),
  mobusta(53,'おのみちバス','#7b6417'),
  {id:'etajima',name:'江田島バス',color:'#176d90',static:'https://gtfs-st.busit.jp/api/etajimabus',
    feeds:{trips:'https://gtfs-rt.busit.jp/api/Etajimabus/TripUpdates'},note:'公式ページのリアルタイム配信はTripUpdateのみ。地図上の車両位置は表示できません。'},
  vision('chugokubus','中国バス','#b04d4f'), vision('tomotetsubus','鞆鉄道','#6954a1'),
  vision('ikasabus','井笠バスカンパニー','#437d35')
];
export const PROVIDER_MAP = new Map(PROVIDERS.map(p=>[p.id,p]));

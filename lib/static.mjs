import { inflateRawSync } from 'node:zlib';
const MAX_EXPANDED=96*1024*1024;
export function parseCSV(text){
  const rows=[];let row=[],value='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(value);value='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}
    else value+=ch;
  }
  if(quoted)throw Error('CSVの引用符が閉じていません');
  if(value||row.length){row.push(value);rows.push(row);}
  const header=rows.shift()??[];
  return rows.map(r=>Object.fromEntries(header.map((h,i)=>[h,r[i]??''])));
}
export function unzipSelected(input,wanted=new Set(['routes.txt','trips.txt','stops.txt','feed_info.txt'])){
  const b=Buffer.from(input);let end=-1;
  for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(b.readUInt32LE(p)===0x06054b50){end=p;break;}
  if(end<0)throw Error('ZIPファイルではありません');
  const count=b.readUInt16LE(end+10);let p=b.readUInt32LE(end+16),expanded=0;const result={};
  for(let n=0;n<count;n++){
    if(p+46>b.length||b.readUInt32LE(p)!==0x02014b50)throw Error('不正なZIPディレクトリ');
    const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),size=b.readUInt32LE(p+20),uncompressed=b.readUInt32LE(p+24);
    const len=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),offset=b.readUInt32LE(p+42);
    const name=b.subarray(p+46,p+46+len).toString('utf8').split('/').pop();p+=46+len+extra+comment;
    if(!wanted.has(name))continue;
    expanded+=uncompressed;if(expanded>MAX_EXPANDED)throw Error('展開後のGTFSが大きすぎます');
    if(flags&1)throw Error('暗号化ZIPは使用できません');
    if(offset+30>b.length||b.readUInt32LE(offset)!==0x04034b50)throw Error('不正なZIPエントリー');
    const start=offset+30+b.readUInt16LE(offset+26)+b.readUInt16LE(offset+28);
    if(start+size>b.length)throw Error('ZIPが途中で切れています');
    const raw=b.subarray(start,start+size);
    const content=method===0?raw:method===8?inflateRawSync(raw,{maxOutputLength:MAX_EXPANDED}):null;
    if(!content)throw Error('未対応のZIP圧縮方式');
    if(content.length!==uncompressed)throw Error('ZIPの展開サイズが一致しません');
    result[name]=new TextDecoder('utf-8',{fatal:true}).decode(content);
  }
  return result;
}
export function staticIndex(bytes){
  const files=unzipSelected(bytes);if(!files['routes.txt']||!files['trips.txt']||!files['stops.txt'])throw Error('routes/trips/stops.txt が揃っていません');
  const index=(name,key,fields)=>Object.fromEntries(parseCSV(files[name]).filter(r=>r[key]).map(r=>[r[key],Object.fromEntries(fields.map(f=>[f,r[f]]))]));
  return {
    routes:index('routes.txt','route_id',['route_short_name','route_long_name','route_color']),
    trips:index('trips.txt','trip_id',['route_id','trip_headsign','trip_short_name','direction_id']),
    stops:index('stops.txt','stop_id',['stop_name','stop_lat','stop_lon']),
    feedInfo:files['feed_info.txt']?parseCSV(files['feed_info.txt']):[]
  };
}

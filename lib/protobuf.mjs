// GTFS Realtime v2 subset. Unknown fields are skipped for forward compatibility.
// Field numbers: https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
const S = (name,type='string',repeated=false) => ({name,type,repeated});
const SCHEMA = {
  feed:{1:S('header','header'),2:S('entity','entity',true)},
  header:{1:S('version'),2:S('incrementality','uint'),3:S('timestamp','uint')},
  entity:{1:S('id'),2:S('isDeleted','bool'),3:S('tripUpdate','tripUpdate'),4:S('vehicle','vehicle'),5:S('alert','alert')},
  trip:{1:S('tripId'),2:S('startTime'),3:S('startDate'),4:S('scheduleRelationship','uint'),5:S('routeId'),6:S('directionId','uint')},
  descriptor:{1:S('id'),2:S('label'),3:S('licensePlate')},
  position:{1:S('latitude','float'),2:S('longitude','float'),3:S('bearing','float'),4:S('odometer','double'),5:S('speed','float')},
  vehicle:{1:S('trip','trip'),2:S('position','position'),3:S('currentStopSequence','uint'),4:S('currentStatus','uint'),5:S('timestamp','uint'),6:S('congestionLevel','uint'),7:S('stopId'),8:S('vehicle','descriptor'),9:S('occupancyStatus','uint')},
  tripUpdate:{1:S('trip','trip'),2:S('stopTimeUpdate','stopTimeUpdate',true),3:S('vehicle','descriptor'),4:S('timestamp','uint'),5:S('delay','int32')},
  stopTimeUpdate:{1:S('stopSequence','uint'),2:S('arrival','event'),3:S('departure','event'),4:S('stopId'),5:S('scheduleRelationship','uint')},
  event:{1:S('delay','int32'),2:S('time','uint'),3:S('uncertainty','int32')},
  alert:{1:S('activePeriod','period',true),2:S('communicationPeriod','period',true),3:S('impactPeriod','period',true),5:S('informedEntity','selector',true),6:S('cause','uint'),7:S('effect','uint'),8:S('url','translated'),10:S('headerText','translated'),11:S('descriptionText','translated'),14:S('severityLevel','uint')},
  period:{1:S('start','uint'),2:S('end','uint')},
  selector:{1:S('agencyId'),2:S('routeId'),3:S('routeType','int32'),4:S('trip','trip'),5:S('stopId'),6:S('directionId','uint')},
  translated:{1:S('translation','translation',true)}, translation:{1:S('text'),2:S('language')}
};
class Reader {
  constructor(bytes){this.b=bytes;this.p=0;this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
  require(n){if(n<0||this.p+n>this.b.length)throw Error('途中で切れたProtocol Bufferです');}
  varint(){let v=0n;for(let i=0;i<10;i++){this.require(1);const b=this.b[this.p++];if(i===9&&b>1)throw Error('不正なvarint');v|=BigInt(b&127)<<BigInt(7*i);if(!(b&128))return v;}throw Error('varintが長すぎます');}
  bytes(){const n=Number(this.varint());if(!Number.isSafeInteger(n))throw Error('不正な長さ');this.require(n);const b=this.b.subarray(this.p,this.p+n);this.p+=n;return b;}
  skip(w){if(w===0){this.varint();return;}if(w===2){this.bytes();return;}const n=w===1?8:w===5?4:0;if(!n)throw Error('未対応のwire type');this.require(n);this.p+=n;}
}
function message(bytes,schema,depth=0){
  if(depth>16)throw Error('メッセージが深すぎます');
  const r=new Reader(bytes),out={};
  while(r.p<bytes.length){
    const tag=Number(r.varint()),field=tag>>>3,w=tag&7;
    if(!field)throw Error('不正なfield number');
    const f=SCHEMA[schema][field];if(!f){r.skip(w);continue;}
    const expected=['uint','int32','bool'].includes(f.type)?0:f.type==='float'?5:f.type==='double'?1:2;
    if(w!==expected)throw Error(`field ${field} のwire typeが不正です`);
    let v;
    if(w===0){const n=r.varint();v=f.type==='bool'?n!==0n:f.type==='int32'?Number(BigInt.asIntN(32,n)):Number(n);if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('整数精度の上限を超えています');}
    else if(w===5||w===1){const n=w===5?4:8;r.require(n);v=w===5?r.view.getFloat32(r.p,true):r.view.getFloat64(r.p,true);r.p+=n;}
    else {const b=r.bytes();v=f.type==='string'?new TextDecoder().decode(b):message(b,f.type,depth+1);}
    if(f.repeated)(out[f.name]??=[]).push(v);else out[f.name]=v;
  }
  return out;
}
export function decodeFeed(bytes){
  const f=message(bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),'feed');
  if(!f.header?.version)throw Error('GTFS Realtimeのヘッダーがありません');
  f.entity??=[];return f;
}
export function translated(value){const t=value?.translation??[];return (t.find(x=>/^ja(?:-|$)/i.test(x.language??''))??t[0])?.text??'';}
export function applyFeed(previous,feed){
  const items=feed.header.incrementality===1?new Map(previous):new Map();
  for(const entity of feed.entity){if(!entity.id)continue;if(entity.isDeleted)items.delete(entity.id);else items.set(entity.id,entity);}
  return items;
}

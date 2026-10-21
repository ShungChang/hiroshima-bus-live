import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFeed,applyFeed} from '../lib/protobuf.mjs';
import {ResourceCache} from '../lib/cache.mjs';
import {parseCSV,staticIndex} from '../lib/static.mjs';
import {findUpdate,delayInfo,delayText,freshness,activeAlert,makeRows} from '../public/model.mjs';
import {createHandler} from '../server.mjs';
import {deflateRawSync} from 'node:zlib';

// Wire fixtures are constructed independently of the production schema.
const join=(...xs)=>Buffer.concat(xs);
function vint(value){let n=BigInt.asUintN(64,BigInt(value));const bytes=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);}
const uint=(f,n)=>join(vint(f*8),vint(n));
const bytes=(f,b)=>join(vint(f*8+2),vint(b.length),b);
const str=(f,s)=>bytes(f,Buffer.from(s));
const float=(f,n)=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return join(vint(f*8+5),b);};
const trip=str(1,'trip-A');
function fixtureFeed({timestamp=1800000000,incrementality=0,deleted=false}={}){
  const header=join(str(1,'2.0'),uint(2,incrementality),uint(3,timestamp));
  const pos=join(float(1,34.4),float(2,132.46));
  const vehicle=join(bytes(1,trip),bytes(2,pos),uint(3,3),uint(5,timestamp),uint(9,2));
  const update=join(bytes(1,trip),uint(4,timestamp),uint(5,-120));
  return join(bytes(1,header),bytes(2,deleted?join(str(1,'v1'),uint(2,1)):join(str(1,'v1'),bytes(4,vehicle))),bytes(2,join(str(1,'t1'),bytes(3,update))),uint(9001,42));
}
test('real wire format: coordinates, 10-byte negative int32, occupancy, and unknown extension',()=>{
  const f=decodeFeed(fixtureFeed());assert.equal(f.header.timestamp,1800000000);assert.equal(f.entity[1].tripUpdate.delay,-120);
  assert.equal(f.entity[0].vehicle.occupancyStatus,2);assert.ok(Math.abs(f.entity[0].vehicle.position.latitude-34.4)<0.00001);
  assert.throws(()=>decodeFeed(fixtureFeed().subarray(0,8)),/切れ/);assert.throws(()=>decodeFeed(Buffer.from([0])),/field/);
});
test('full and differential snapshots remove deleted vehicles and clear omitted entities on full update',()=>{
  const full=decodeFeed(fixtureFeed()),map=applyFeed(null,full);assert.equal(map.size,2);
  const diff=decodeFeed(fixtureFeed({incrementality:1,deleted:true}));assert.equal(applyFeed(map,diff).has('v1'),false);
  assert.equal(applyFeed(map,{header:{incrementality:0},entity:[]}).size,0);
});
test('concurrent cache users share one request; failures also wait 15 seconds and preserve last good data',async()=>{
  let now=0,calls=0;const cache=new ResourceCache({clock:()=>now});
  const load=async()=>{calls++;return 'good';};
  await Promise.all([cache.get('a',load),cache.get('a',load)]);assert.equal(calls,1);
  now=14999;await cache.get('a',load);assert.equal(calls,1);
  now=15000;const fail=async()=>{calls++;throw Error('offline');};
  const failed=await cache.get('a',fail);assert.equal(failed.value,'good');assert.equal(failed.error,'offline');
  now=29999;await cache.get('a',fail);assert.equal(calls,2);
  now=30000;await cache.get('a',load);assert.equal(calls,3);
});
test('trip identity respects operating day, departure time, and ambiguous matches',()=>{
  const yesterday={trip:{tripId:'A',startDate:'20261020',startTime:'25:00:00'}};
  const today={trip:{tripId:'A',startDate:'20261021',startTime:'25:00:00'}};
  assert.equal(findUpdate({trip:today.trip},[yesterday,today]),today);
  assert.equal(findUpdate({trip:{tripId:'A'}},[yesterday,today]),null);
  assert.equal(findUpdate({trip:{tripId:'A',startDate:'20261021'}},[yesterday]),null);
  assert.equal(findUpdate({trip:{tripId:'A'}},[{trip:{tripId:'A',routeId:'1'}},{trip:{tripId:'A',routeId:'2'}}]),null);
});
test('absent delay remains unknown, negative delay is early, and next-stop predictions take precedence',()=>{
  assert.equal(delayInfo({}).seconds,null);assert.equal(delayText(delayInfo({delay:0})),'定刻');assert.equal(delayText(delayInfo({delay:-120})),'2分早発');
  const update={delay:30,stopTimeUpdate:[{stopSequence:2,arrival:{delay:800}},{stopSequence:3,arrival:{delay:180}}]};
  assert.equal(delayInfo(update,3).seconds,180);assert.equal(delayInfo(update,3).label,'次停留所予測');
  assert.equal(delayInfo({trip:{scheduleRelationship:3}}).label,'運休');
});
test('data freshness distinguishes unknown, stale, and future timestamps',()=>{
  assert.equal(freshness(null,100),'unknown');assert.equal(freshness(9,100),'stale');assert.equal(freshness(10,100),'fresh');assert.equal(freshness(131,100),'clock');
});
test('alert display periods use communication_period when supplied and have an exclusive end',()=>{
  assert.equal(activeAlert({},100),true);assert.equal(activeAlert({activePeriod:[{start:90,end:100}]},100),false);
  assert.equal(activeAlert({activePeriod:[{start:200}],communicationPeriod:[{start:90,end:110}]},100),true);
});
test('missing measurement timestamps and request failures cannot become fresh normal-operation badges',()=>{
  const provider={id:'8',name:'test'};const feed={status:'ok',timestamp:100,entities:[{id:'v',vehicle:{trip:{tripId:'A'},position:{latitude:34,longitude:132}}}]};
  let r=makeRows(provider,{feeds:{vehicles:feed}},undefined,100)[0];assert.equal(r.freshness,'unknown');assert.equal(r.delay.seconds,null);
  r=makeRows(provider,{requestError:'offline',feeds:{vehicles:feed}},undefined,100)[0];assert.equal(r.feedError,true);
});
test('CSV handles BOM, quoted commas, escaped quotes, CRLF, and embedded newline',()=>{
  assert.deepEqual(parseCSV('\uFEFFid,name\r\n1,"a,b"\r\n2,"a""b\nc"\r\n'),[{id:'1',name:'a,b'},{id:'2',name:'a"b\nc'}]);assert.throws(()=>parseCSV('a\n"oops'));
});
function zip(entries){
  const locals=[],central=[];let offset=0;
  for(const[name,text]of Object.entries(entries)){
    const filename=Buffer.from(name),content=Buffer.from(text),compressed=deflateRawSync(content);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(filename.length,26);
    locals.push(local,filename,compressed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(8,10);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(content.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);central.push(c,filename);offset+=local.length+filename.length+compressed.length;
  }
  const dir=join(...central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return join(...locals,dir,end);
}
test('compressed static GTFS produces route/trip/stop index, including ZIP subfolders',()=>{
  const input=zip({'data/routes.txt':'route_id,route_long_name\nr1,広島駅線\n','data/trips.txt':'trip_id,route_id,trip_headsign\nt1,r1,広島駅\n','data/stops.txt':'stop_id,stop_name\ns1,本通\n'});
  const result=staticIndex(input);assert.equal(result.routes.r1.route_long_name,'広島駅線');assert.equal(result.trips.t1.trip_headsign,'広島駅');assert.equal(result.stops.s1.stop_name,'本通');
  assert.throws(()=>staticIndex(Buffer.from('bad zip')),/ZIP/);
});
test('HTTP handler integration: live response, shared upstream reads, exact-origin CORS, error cache, and allowlisted routes',async()=>{
  let calls=0,fail=false,now=1800000000000;
  const handler=createHandler({clock:()=>now,allowedOrigin:'https://shungchang.github.io',fetchImpl:async url=>{
    calls++;assert.ok(url.startsWith('https://ajt-mobusta-gtfs.mcapps.jp/realtime/8/'));if(fail)throw Error('mock offline');return new Response(fixtureFeed());
  }});
  // Exercise the real HTTP handler with an in-memory transport; no network is needed.
  async function request(url,origin){
    const headers=new Headers();let status,body='';
    await handler({url,method:'GET',headers:{origin}},{
      setHeader:(k,v)=>headers.set(k,v),
      writeHead:(s,h)=>{status=s;for(const[k,v]of Object.entries(h))headers.set(k,v);},
      end:content=>{body=content?.toString()??'';}
    });return {status,headers,json:async()=>JSON.parse(body),text:async()=>body};
  }
  const fetchLive=()=>request('/api/live/8','https://shungchang.github.io');
  const [a,b]=await Promise.all([fetchLive(),fetchLive()]);assert.equal(calls,3);assert.equal(a.headers.get('access-control-allow-origin'),'https://shungchang.github.io');
  const data=await a.json();await b.json();assert.equal(data.feeds.vehicles.entities.length,2);assert.equal(data.feeds.vehicles.status,'ok');
  now+=15000;fail=true;const stale=await(await fetchLive()).json();assert.equal(stale.feeds.vehicles.status,'cached');assert.equal(calls,6);
  await fetchLive();assert.equal(calls,6);
  const denied=await request('/api/live/evil');assert.equal(denied.status,404);assert.equal(calls,6);
  const page=await request('/');assert.match(await page.text(),/ひろしま/);
  const cors=await request('/api/health','https://other.example');assert.equal(cors.headers.get('access-control-allow-origin'),null);
});

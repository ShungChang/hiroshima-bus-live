import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {PROVIDERS,PROVIDER_MAP,SOURCE_URL} from './lib/providers.mjs';
import {decodeFeed,applyFeed} from './lib/protobuf.mjs';
import {staticIndex} from './lib/static.mjs';
import {ResourceCache} from './lib/cache.mjs';

export function createHandler({fetchImpl=fetch,clock=Date.now,allowedOrigin=process.env.ALLOWED_ORIGIN??''}={}){
  const realtime=new ResourceCache({clock}),metadata=new ResourceCache({ttl:6*3600*1000,errorTtl:60000,clock});
  const root=fileURLToPath(new URL('./public/',import.meta.url));
  let active=0;const waiters=[];
  async function limited(fn){if(active>=4)await new Promise(r=>waiters.push(r));else active++;try{return await fn();}finally{const next=waiters.shift();if(next)next();else active--;}}
  async function download(url,max){return limited(async()=>{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'HiroshimaBusLive/0.1 (+https://www.bus-kyo.or.jp/gtfs-open-data)'}});
    if(!response.ok)throw Error(`配信元 HTTP ${response.status}`);
    if(Number(response.headers.get('content-length'))>max)throw Error('配信データが大きすぎます');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>max)throw Error('配信データが大きすぎます');chunks.push(chunk);}
    return Buffer.concat(chunks);
  });}
  async function feed(provider,type){
    if(!provider.feeds[type])return {supported:false};
    const r=await realtime.get(`${provider.id}/${type}`,async previous=>{
      const decoded=decodeFeed(await download(provider.feeds[type],12*1024*1024));
      if(![undefined,0,1].includes(decoded.header.incrementality))throw Error('未対応のincrementality');
      if(previous?.timestamp&&decoded.header.timestamp&&decoded.header.timestamp<previous.timestamp)throw Error('配信時刻が前回より古いため更新を保留');
      // A differential feed requires an earlier full dataset; do not present an incomplete snapshot as complete.
      if(decoded.header.incrementality===1&&!previous)throw Error('差分フィードの初期全量データがありません');
      return {timestamp:decoded.header.timestamp??null,entities:applyFeed(previous?.entities,decoded)};
    });
    return {supported:true,status:r.error?(r.value?'cached':'error'):'ok',error:r.error,receivedAt:r.updatedAt,
      timestamp:r.value?.timestamp??null,entities:r.value?[...r.value.entities.values()]:[]};
  }
  return async(req,res)=>{
    const origin=req.headers.origin;
    if(allowedOrigin&&origin===allowedOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, OPTIONS'});res.end();return;}
      if(req.method!=='GET'&&req.method!=='HEAD'){json(405,{error:'GETのみ対応'});return;}
      if(url.pathname==='/api/health'){json(200,{ok:true,serverTime:clock(),pollIntervalMs:15000});return;}
      if(url.pathname==='/api/providers'){json(200,{providers:PROVIDERS.map(({id,name,color,note,feeds})=>({id,name,color,note,capabilities:Object.keys(feeds)})),source:SOURCE_URL});return;}
      const api=url.pathname.match(/^\/api\/(live|static)\/([a-z0-9]+)$/);
      if(api){
        const p=PROVIDER_MAP.get(api[2]);if(!p){json(404,{error:'未登録の事業者'});return;}
        if(api[1]==='live'){
          const entries=await Promise.all(['vehicles','trips','alerts'].map(async type=>[type,await feed(p,type)]));
          json(200,{providerId:p.id,serverTime:clock(),feeds:Object.fromEntries(entries)});
        }else{
          const r=await metadata.get(p.id,async()=>staticIndex(await download(p.static,48*1024*1024)));
          json(r.value?200:502,{...r.value,receivedAt:r.updatedAt,error:r.error});
        }return;
      }
      if(url.pathname.startsWith('/api/')){json(404,{error:'不明なAPI'});return;}
      const files={'/':'index.html','/index.html':'index.html','/app.mjs':'app.mjs','/model.mjs':'model.mjs','/styles.css':'styles.css'};
      const name=files[url.pathname];if(!name){json(404,{error:'Not found'});return;}
      const content=await readFile(path.join(root,name));
      const type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript';
      res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json(500,{error:e.message});else res.end();}
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=Number(process.env.PORT??8787),host=process.env.HOST??'127.0.0.1';
  http.createServer(createHandler()).listen(port,host,()=>console.log(`Hiroshima Bus Live: http://${host}:${port}`));
}

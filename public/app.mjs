import {makeRows,delayText,activeAlert,textOf,freshness} from './model.mjs';
const $=id=>document.getElementById(id),INTERVAL=15000;
let apiBase='';try{apiBase=localStorage.getItem('hiroshima-bus-api')??'';}catch{}
let providers=[],snapshots=new Map(),metadata=new Map(),pendingMeta=new Set(),rows=[],filtered=[],selectedId='',paused=false,busy=false,generation=0,nextDue=0,lastEnd=0,timer,abort;
let map,markers=new Map(),hasFit=false;
const stamp=t=>t?new Date(t*1000).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'時刻不明';
function el(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function setStatus(text,ok=false){$('status').textContent=text;$('status-dot').className=ok?'ok':'error';}
async function api(path,signal){
  const response=await fetch(`${apiBase}${path}`,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),cache:'no-store',credentials:'omit'});
  const type=response.headers.get('content-type')??'';
  if(!type.includes('application/json'))throw Error('データ取得サーバーに接続できません。接続設定を確認してください。');
  const data=await response.json();if(!response.ok)throw Error(data.error??`HTTP ${response.status}`);return data;
}
function selectedProviders(){return $('operator').value==='all'?providers:providers.filter(p=>p.id===$('operator').value);}
function initMap(){
  if(!window.L){$('map-error').hidden=false;return;}
  map=L.map('map',{zoomControl:false}).setView([34.395,132.46],12);L.control.zoom({position:'topright'}).addTo(map);
  const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  let failures=0;tiles.on('tileerror',()=>{if(++failures>5)$('map-error').hidden=false;});tiles.on('tileload',()=>{$('map-error').hidden=true;failures=0;});
}
async function catalog(signal){
  const data=await api('/api/providers',signal);providers=data.providers;
  const previous=$('operator').value;const fragment=document.createDocumentFragment();
  fragment.append(new Option('すべての事業者（17事業者）','all'));
  for(const p of providers)fragment.append(new Option(p.name,p.id));
  $('operator').replaceChildren(fragment);$('operator').value=providers.some(p=>p.id===previous)||previous==='all'?previous:'8';
}
async function refresh(){
  if(busy||paused||document.hidden)return;
  busy=true;const token=generation;abort=new AbortController();const signal=abort.signal;
  setStatus('データ取得中');
  try{
    if(!providers.length)await catalog(signal);
    const chosen=selectedProviders();
    $('provider-note').textContent=chosen.map(p=>p.note).filter(Boolean).join(' ');
    // Limit simultaneous providers; the server also limits upstream concurrency.
    const queue=[...chosen];
    await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
      while(queue.length){const p=queue.shift();
        try{
          const data=await api(`/api/live/${p.id}`,signal);if(token!==generation)return;
          snapshots.set(p.id,{...data,clientReceivedAt:Date.now()});render();
          // Metadata is independent of live positions. Failure must not suppress live vehicles.
          if(!metadata.has(p.id)&&!pendingMeta.has(p.id)){
            pendingMeta.add(p.id);
            api(`/api/static/${p.id}`,signal).then(m=>{if(token===generation){metadata.set(p.id,{...m,expiresAt:Date.now()+6*3600*1000,...(m.error?{retryAt:Date.now()+60000}:{})});render();}})
              .catch(e=>{if(!signal.aborted&&token===generation){metadata.set(p.id,{error:e.message,retryAt:Date.now()+60000});render();}})
              .finally(()=>pendingMeta.delete(p.id));
          }
        }catch(e){if(signal.aborted)return;if(token===generation){const old=snapshots.get(p.id);snapshots.set(p.id,{...old,requestError:e.message});}}
      }
    }));
    if(token!==generation)return;
    const successful=chosen.filter(p=>Object.values(snapshots.get(p.id)?.feeds??{}).some(f=>f.status==='ok'));
    const issues=chosen.some(p=>snapshots.get(p.id)?.requestError||Object.values(snapshots.get(p.id)?.feeds??{}).some(f=>f.supported&&f.status!=='ok'));
    const ageOK=chosen.some(p=>Object.values(snapshots.get(p.id)?.feeds??{}).some(f=>f.status==='ok'&&freshness(f.timestamp)==='fresh'));
    setStatus(paused?'更新を一時停止':successful.length?(issues?'一部の取得に失敗':ageOK?'自動更新中':'取得済み・鮮度に注意'):'接続・配信を確認',!paused&&successful.length>0&&!issues&&ageOK);
    $('last-fetch').textContent=`確認 ${new Date().toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false})} JST`;
    for(const [id,m]of metadata)if((m.retryAt&&Date.now()>m.retryAt)||(m.expiresAt&&Date.now()>m.expiresAt))metadata.delete(id);
    render();
  }catch(e){if(!signal.aborted&&token===generation){setStatus('接続できません');$('feed-status').textContent=e.message;$('vehicles').replaceChildren(el('div','データ取得サーバーが未接続です。「接続設定」からURLを確認してください。','empty'));}}
  finally{busy=false;lastEnd=Date.now();nextDue=lastEnd+INTERVAL;if(token!==generation&&!paused&&!document.hidden)refresh();else schedule();}
}
function schedule(){clearTimeout(timer);if(!paused&&!document.hidden)timer=setTimeout(refresh,Math.max(0,nextDue-Date.now()));}
function stateClass(r){return r.freshness!=='fresh'||r.feedError?'stale':r.delay.seconds===null||r.delayStale?'unknown':r.delay.seconds>=180?'late':'';}
function badgeText(r){if(r.freshness!=='fresh'||r.feedError)return r.freshness==='stale'?'古い位置情報':r.freshness==='clock'?'配信時刻を確認':r.feedError?'取得失敗・前回値':'時刻不明';return `${delayText(r.delay)}${r.delayStale&&r.delay.seconds!==null?'（更新に注意）':''}`;}
function render(){
  const chosen=selectedProviders(),now=Date.now()/1000;
  rows=chosen.flatMap(p=>makeRows(p,snapshots.get(p.id),metadata.get(p.id),now));
  // Recalculate data ages on every render, including while acquisition is failing.
  const query=$('search').value.trim().toLocaleLowerCase(),filter=$('filter').value;
  filtered=rows.filter(r=>!query||[r.routeName,r.routeLong,r.headsign,r.vehicleName,r.tripId,r.stopName,r.provider.name].join(' ').toLocaleLowerCase().includes(query))
    .filter(r=>filter==='position'?r.hasPosition:filter==='delay'?r.delay.seconds>=180&&!r.delayStale&&r.freshness==='fresh'&&!r.feedError:filter==='stale'?r.freshness!=='fresh'||r.feedError:true)
    .sort((a,b)=>(b.delayStale?0:b.delay.seconds??0)-(a.delayStale?0:a.delay.seconds??0));
  $('position-count').textContent=rows.filter(r=>r.hasPosition).length;
  $('delay-count').textContent=rows.filter(r=>r.delay.seconds>=180&&!r.delayStale&&r.freshness==='fresh'&&!r.feedError).length;
  $('result-count').textContent=`${filtered.length} 件`;
  $('map-subtitle').textContent=`位置取得 ${rows.filter(r=>r.hasPosition).length} 台 · 15秒以上の間隔で更新`;
  const errors=[];
  for(const p of chosen){
    const s=snapshots.get(p.id);if(s?.requestError)errors.push(`${p.name}：${s.requestError}`);
    for(const [kind,f] of Object.entries(s?.feeds??{})){
      const label={vehicles:'車両位置',trips:'便情報',alerts:'お知らせ'}[kind];
      if(f.error)errors.push(`${p.name} / ${label}：${f.error}${f.receivedAt?'（前回取得分）':''}`);
      else if(f.supported&&f.status==='ok'&&freshness(f.timestamp,now)!=='fresh')errors.push(`${p.name} / ${label}：配信時刻 ${stamp(f.timestamp)}（古い・不明な情報に注意）`);
    }
    if(metadata.get(p.id)?.error)errors.push(`${p.name}：路線・停留所名の読込に失敗。IDを表示しています。`);
    const end=metadata.get(p.id)?.feedInfo?.[0]?.feed_end_date;
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date()).replaceAll('-','');
    if(end&&end<today)errors.push(`${p.name}：静的データの有効期間が終了（${end}）。路線・行先名に注意。`);
  }
  $('feed-status').replaceChildren(...errors.map(t=>el('div',t)));
  const list=document.createDocumentFragment();
  for(const r of filtered.slice(0,300)){
    const button=el('button',undefined,`vehicle-row${selectedId===r.id?' selected':''}`);button.type='button';
    if(chosen.length>1)button.append(el('div',r.provider.name,'operator-name'));
    const top=el('div',undefined,'row-main');top.append(el('span',r.routeName,'route'),el('span',badgeText(r),`badge ${stateClass(r)}`));button.append(top);
    button.append(el('div',r.headsign?`→ ${r.headsign}`:r.tripId?`便ID：${r.tripId}`:'行先情報なし','row-detail'));
    if(r.stopName)button.append(el('div',`停留所：${r.stopName}`,'row-detail'));
    const sub=el('div',undefined,'row-sub');sub.append(el('span',r.vehicleName),el('span',`${r.hasPosition?'位置あり':'位置配信なし'} · ${stamp(r.timestamp)}`));button.append(sub);
    button.addEventListener('click',()=>selectRow(r));list.append(button);
  }
  if(filtered.length>300)list.append(el('div',`先頭300件を表示しています。検索で絞り込めます。`,'empty'));
  if(!filtered.length)list.append(el('div',rows.length?'条件に一致する車両・便がありません。':'取得できた車両・便はありません。運行時間外・配信対象外・取得失敗の場合があります。','empty'));
  $('vehicles').replaceChildren(list);renderMap();renderAlerts(chosen,now);
}
function popup(r){
  const div=el('div');div.append(el('div',r.provider.name,'operator-name'),el('div',r.routeName,'popup-title'),el('div',r.headsign?`→ ${r.headsign}`:`便ID：${r.tripId}`));
  for(const t of [r.vehicleName,`${badgeText(r)}${r.delay.seconds!==null?` / ${r.delay.label}`:''}`,r.stopName?`停留所：${r.stopName}`:'',`${r.timestampSource} ${stamp(r.timestamp)} JST`,r.metadataMissing?'路線名未取得：IDで表示中':''])if(t)div.append(el('div',t,'popup-detail'));
  return div;
}
function renderMap(){
  if(!map)return;
  const visible=new Set();
  for(const r of filtered.filter(r=>r.hasPosition)){
    visible.add(r.id);let marker=markers.get(r.id);
    const pin=el('div','B',`bus-pin ${stateClass(r)}`);
    const icon=L.divIcon({className:'',html:pin,iconSize:[30,30],iconAnchor:[15,30],popupAnchor:[0,-28]});
    if(!marker){marker=L.marker([r.lat,r.lon],{icon,title:`${r.provider.name} ${r.routeName}`,keyboard:true}).addTo(map);marker.on('click',()=>{selectedId=r.id;});markers.set(r.id,marker);}else{marker.setLatLng([r.lat,r.lon]);marker.setIcon(icon);}
    if(marker.getPopup())marker.setPopupContent(popup(r));else marker.bindPopup(popup(r));
  }
  for(const [id,m]of markers)if(!visible.has(id)){m.remove();markers.delete(id);}
  if(!hasFit&&markers.size){fit();hasFit=true;}
}
function fit(){if(!map)return;const positions=filtered.filter(r=>r.hasPosition).map(r=>[r.lat,r.lon]);if(positions.length)map.fitBounds(L.latLngBounds(positions),{padding:[40,100],maxZoom:15});}
function selectRow(r){selectedId=r.id;if(r.hasPosition&&map){map.setView([r.lat,r.lon],Math.max(map.getZoom(),15));markers.get(r.id)?.openPopup();}render();}
function renderAlerts(chosen,now){
  const alerts=[];let failures=false;
  for(const p of chosen){const f=snapshots.get(p.id)?.feeds?.alerts;if(!f||f.status==='error'||f.status==='cached')failures=true;
    for(const e of f?.entities??[])if(e.alert&&activeAlert(e.alert,now))alerts.push({p,alert:e.alert,stale:f.status!=='ok'||freshness(f.timestamp,now)!=='fresh'});
  }
  $('alert-count').textContent=alerts.length;const fragment=document.createDocumentFragment();
  for(const {p,alert,stale}of alerts){
    const d=el('details',undefined,'alert-item');d.append(el('summary',`${p.name}${stale?'（更新に注意）':''}：${textOf(alert.headerText)||'運行情報'}`),el('p',textOf(alert.descriptionText)||'詳細テキストなし'));
    const href=textOf(alert.url);try{const u=new URL(href);if(['https:','http:'].includes(u.protocol)){const a=el('a','詳細を確認');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';d.append(a);}}catch{}
    fragment.append(d);
  }
  if(!alerts.length)fragment.append(el('span',failures?'取得できたお知らせはありません。一部事業者の取得失敗・未配信を含みます。':'配信データに有効なお知らせはありません。正常運行を保証するものではありません。'));
  $('alerts').replaceChildren(fragment);
}
function changeSelection(){generation++;abort?.abort();hasFit=false;lastEnd=0;nextDue=0;render();if(!busy)refresh();}
$('operator').addEventListener('change',changeSelection);
$('search').addEventListener('input',render);$('filter').addEventListener('change',render);$('fit').addEventListener('click',fit);
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'更新を再開':'一時停止';$('pause').setAttribute('aria-pressed',String(paused));if(paused){clearTimeout(timer);setStatus('更新を一時停止');}else schedule();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);}else{render();schedule();}});
$('settings').addEventListener('click',()=>{$('api-url').value=apiBase;$('settings-error').textContent='';$('settings-dialog').showModal();});
$('cancel-settings').addEventListener('click',()=>$('settings-dialog').close());
$('settings-form').addEventListener('submit',event=>{
  event.preventDefault();const value=$('api-url').value.trim().replace(/\/+$/,'');
  try{if(value){const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('認証情報・クエリを含まないHTTP(S) URLを指定してください。');if(location.protocol==='https:'&&u.protocol!=='https:')throw Error('HTTPSの画面からはHTTPSのサーバーURLを指定してください。');}
    apiBase=value;try{localStorage.setItem('hiroshima-bus-api',value);}catch{}
    providers=[];snapshots.clear();metadata.clear();$('settings-dialog').close();changeSelection();
  }catch(e){$('settings-error').textContent=e.message;}
});
setInterval(()=>{
  $('countdown').textContent=paused?'一時停止中':document.hidden?'画面非表示・停止中':busy?'取得中…':`次の取得 ${Math.max(0,Math.ceil((nextDue-Date.now())/1000))}秒`;
},1000);
setInterval(()=>{if(rows.length)render();},15000);
initMap();refresh();

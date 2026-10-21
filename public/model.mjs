export function freshness(timestamp,now=Date.now()/1000){
  if(!Number.isFinite(timestamp)||timestamp<=0)return 'unknown';
  const age=now-timestamp;return age< -30?'clock':age>90?'stale':'fresh';
}
const key=t=>[t?.tripId??'',t?.startDate??'',t?.startTime??''].join('|');
export function findUpdate(vehicle,updates){
  const trip=vehicle.trip;if(!trip?.tripId)return null;
  const candidates=updates.filter(u=>u.trip?.tripId===trip.tripId&&
    ['startDate','startTime','routeId','directionId'].every(f=>trip[f]===undefined||u.trip[f]===undefined||trip[f]===u.trip[f]));
  const exact=candidates.filter(u=>key(u.trip)===key(trip));
  return exact.length===1?exact[0]:candidates.length===1?candidates[0]:null;
}
export function delayInfo(update,sequence,now=Date.now()/1000){
  if(!update)return {seconds:null,label:'遅延情報なし'};
  if(update.trip?.scheduleRelationship===3)return {seconds:null,label:'運休'};
  if(update.trip?.scheduleRelationship===7)return {seconds:null,label:'削除便'};
  const stops=(update.stopTimeUpdate??[]).filter(s=>s.scheduleRelationship!==1&&s.scheduleRelationship!==2);
  const ordered=[...stops].sort((a,b)=>(a.stopSequence??Infinity)-(b.stopSequence??Infinity));
  const next=sequence!==undefined?ordered.find(s=>s.stopSequence>=sequence):ordered.find(s=>(s.departure?.time??s.arrival?.time??0)>=now);
  const predicted=next?.arrival?.delay??next?.departure?.delay;
  if(Number.isFinite(predicted))return {seconds:predicted,label:'次停留所予測',stopId:next.stopId};
  if(Number.isFinite(update.delay))return {seconds:update.delay,label:'便の遅延',stopId:next?.stopId};
  return {seconds:null,label:'遅延情報なし',stopId:next?.stopId};
}
export function delayText(info){
  if(info.seconds===null)return info.label;
  if(info.seconds===0)return '定刻';
  const min=Math.abs(info.seconds)/60;
  return `${min<1?'1分未満':`${Math.round(min)}分`}${info.seconds>0?'遅れ':'早発'}`;
}
export function textOf(value){const t=value?.translation??[];return (t.find(x=>/^ja(?:-|$)/i.test(x.language??''))??t[0])?.text??'';}
export function activeAlert(alert,now=Date.now()/1000){
  const periods=alert.communicationPeriod?.length?alert.communicationPeriod:alert.activePeriod;
  return !periods?.length||periods.some(p=>(p.start===undefined||p.start<=now)&&(p.end===undefined||now<p.end));
}
export function makeRows(provider,live,meta={},now=Date.now()/1000){
  const feeds=live?.feeds??{},updates=(feeds.trips?.entities??[]).map(e=>e.tripUpdate).filter(Boolean),used=new Set();
  const vehicles=(feeds.vehicles?.entities??[]).filter(e=>e.vehicle).map(e=>{
    const v=e.vehicle,u=findUpdate(v,updates);if(u)used.add(u);
    return make(e.id,v,u,feeds.vehicles,v.timestamp??feeds.vehicles?.timestamp,v.timestamp?'車両測位':'フィード配信（測位時刻不明）');
  });
  const withoutPosition=updates.filter(u=>!used.has(u)).map((u,i)=>make(`trip-${key(u.trip)}-${i}`,{trip:u.trip,vehicle:u.vehicle},u,feeds.trips,u.timestamp??feeds.trips?.timestamp,u.timestamp?'便情報更新':'フィード配信（便の更新時刻不明）'));
  return [...vehicles,...withoutPosition];
  function make(entityId,v,u,feed,timestamp,timestampSource){
    const trip=v.trip??u?.trip??{},staticTrip=meta.trips?.[trip.tripId]??{},routeId=trip.routeId??staticTrip.route_id;
    const route=meta.routes?.[routeId]??{},stopId=v.stopId??delayInfo(u,v.currentStopSequence,now).stopId;
    const lat=v.position?.latitude,lon=v.position?.longitude;
    const hasPosition=Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180&&!(lat===0&&lon===0);
    const ageState=hasPosition&&!v.timestamp?'unknown':freshness(timestamp,now);
    const updateTimestamp=u?.timestamp??feeds.trips?.timestamp;
    const delay=delayInfo(u,v.currentStopSequence,now);
    return {id:`${provider.id}:${entityId}`,provider,entityId,tripId:trip.tripId??'',routeId:routeId??'',
      routeName:route.route_short_name||route.route_long_name||routeId||'路線情報なし',
      routeLong:route.route_long_name??'',headsign:staticTrip.trip_headsign||'',
      vehicleName:v.vehicle?.label||v.vehicle?.licensePlate||v.vehicle?.id||'車両名なし',
      stopName:meta.stops?.[stopId]?.stop_name||stopId||'',
      lat,lon,hasPosition,timestamp:timestamp??null,timestampSource,
      freshness:ageState,feedError:Boolean(live?.requestError)||feed?.status!=='ok',delay,delayStale:Boolean(live?.requestError)||freshness(updateTimestamp,now)!=='fresh'||feeds.trips?.status!=='ok',
      occupancy:v.occupancyStatus??null,schedule:trip.scheduleRelationship??u?.trip?.scheduleRelationship??0,
      metadataMissing:!meta.trips?.[trip.tripId]};
  }
}

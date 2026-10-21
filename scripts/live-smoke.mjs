// Optional network smoke check. Fetches Hiroden's three realtime feeds once each.
import {createHandler} from '../server.mjs';
const handler=createHandler();
async function request(url){
  let body,status;await handler({url,method:'GET',headers:{}},{setHeader(){},writeHead(s){status=s;},end(b){body=b;}});
  if(status!==200)throw Error(`HTTP ${status}: ${body}`);return JSON.parse(body);
}
const live=await request('/api/live/8');
const report={checkedAt:new Date().toISOString(),operator:'広島電鉄',feeds:{}};
for(const [type,f]of Object.entries(live.feeds)){
  report.feeds[type]={status:f.status,timestamp:f.timestamp,entities:f.entities.length,error:f.error};
  if(f.status!=='ok')process.exitCode=1;
}
report.validPositions=live.feeds.vehicles.entities.filter(e=>Number.isFinite(e.vehicle?.position?.latitude)&&Number.isFinite(e.vehicle?.position?.longitude)).length;
const metadata=await request('/api/static/8');
report.static={routes:Object.keys(metadata.routes).length,trips:Object.keys(metadata.trips).length,stops:Object.keys(metadata.stops).length};
if(!report.static.routes||!report.static.trips||!report.static.stops)process.exitCode=1;
console.log(JSON.stringify(report,null,2));
if(process.env.GITHUB_STEP_SUMMARY){const {appendFile}=await import('node:fs/promises');await appendFile(process.env.GITHUB_STEP_SUMMARY,`## Live GTFS smoke check\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n`);}

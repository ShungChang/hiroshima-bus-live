// Coalesces concurrent requests. TTL runs from completion, including failures.
export class ResourceCache {
  constructor({ttl=15000,errorTtl=ttl,clock=Date.now}={}){this.ttl=ttl;this.errorTtl=errorTtl;this.clock=clock;this.entries=new Map();}
  async get(key,loader){
    let e=this.entries.get(key);
    if(e?.pending)return e.pending;
    if(e&&this.clock()<e.next)return this.result(e);
    e??={value:null,updatedAt:null,error:null};this.entries.set(key,e);
    e.pending=(async()=>{
      try{e.value=await loader(e.value);e.updatedAt=this.clock();e.error=null;}
      catch(error){e.error=error.message;}
      finally{e.next=this.clock()+(e.error?this.errorTtl:this.ttl);e.pending=null;}
      return this.result(e);
    })();
    return e.pending;
  }
  result(e){return {value:e.value,updatedAt:e.updatedAt,error:e.error};}
}

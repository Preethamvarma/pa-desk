'use strict';
// PA Desk cloud adapter: browser-only Supabase Auth + PostgREST client.
// Publishable/anon key is public. NEVER embed service_role/secret keys here.
window.PADeskCloud = (() => {
  const cfg = window.PA_DESK_CONFIG || {};
  const url = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  const key = String(cfg.supabasePublishableKey || '');
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && (key.startsWith('sb_publishable_') || key.startsWith('eyJ'));
  const sessionKey = 'paDesk.auth.v2';
  const cacheKey = uid => `paDesk.cloud.cache.v2.${uid}`;
  const queueKey = uid => `paDesk.cloud.queue.v2.${uid}`;
  let session = null, busy = false, deferred = null, handlers = null, snapshot = [], status = 'local';
  const clone = value => JSON.parse(JSON.stringify(value));
  function read(keyName, fallback) { try { const x=JSON.parse(localStorage.getItem(keyName)||'null'); return x===null?fallback:x; } catch { return fallback; } }
  function write(keyName,value) { localStorage.setItem(keyName,JSON.stringify(value)); }
  const user = () => session?.user || null;
  const active = () => !!user();
  function report(next, details='') { status=next; handlers?.onState?.({configured,active:active(),user:user(),status,details,localCount:handlers?.localCount?.()||0}); }
  function fail(e) { report('error',e.message||String(e)); handlers?.onError?.(e.message||String(e)); }
  function apiError(response,body) { const e=new Error(body?.msg||body?.message||body?.error_description||body?.error||`Server returned ${response.status}`);e.status=response.status;return e; }
  async function request(path,{method='GET',body=null,auth=true,prefer=''}={}) {
    if(!configured) throw Error('Cloud service is not configured.');
    if(auth && session && session.expires_at*1000 < Date.now()+60000) await refreshToken();
    const headers = {'apikey':key,'Content-Type':'application/json'};
    if(auth&&session?.access_token) headers.Authorization=`Bearer ${session.access_token}`;
    if(prefer)headers.Prefer=prefer;
    const response=await fetch(`${url}${path}`,{method,headers,body:body===null?undefined:JSON.stringify(body),cache:'no-store'});
    const data=await response.text();let result=null;try {result=data?JSON.parse(data):null;}catch{result={message:data};}
    if(!response.ok)throw apiError(response,result);
    return result;
  }
  async function refreshToken() {
    if(!session?.refresh_token) throw Error('Sign in again to resume cloud syncing.');
    const response=await fetch(`${url}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{'apikey':key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token}),cache:'no-store'});
    const body=await response.json();if(!response.ok||!body.access_token)throw apiError(response,body);
    const previousUser=session.user; session={...body,user:body.user||previousUser,expires_at:Math.floor(Date.now()/1000)+(body.expires_in||3600)};
    write(sessionKey,session);return session;
  }
  function cacheTasks(next) { if(!active())return; snapshot=clone(next);write(cacheKey(user().id),next); }
  function queue() { return read(queueKey(user().id),{}); }
  function setQueue(q) {write(queueKey(user().id),q);}
  function activate(sess) {
    session={...sess,expires_at:sess.expires_at||Math.floor(Date.now()/1000)+(sess.expires_in||3600)};
    write(sessionKey,session);
    const saved=read(cacheKey(user().id),[]);snapshot=Array.isArray(saved)?saved:[];
    handlers.onData(clone(snapshot)); report('connecting');
    sync();
  }
  function setLocal() {session=null;snapshot=[];localStorage.removeItem(sessionKey);handlers?.onLocal?.();report(configured?'signed-out':'unconfigured');}
  async function start(h) {
    handlers=h;
    if(!configured){report('unconfigured');return;}
    const previous=read(sessionKey,null);
    if(!previous?.access_token||!previous?.user?.id){report('signed-out');return;}
    session=previous;
    if(!navigator.onLine){activate(previous);report('offline');return;}
    try {await refreshToken();activate(session);} catch(e) {
      if([400,401,403].includes(e.status))setLocal();
      else {activate(previous);report('offline','Using cached data. Cloud connection unavailable.');}
    }
  }
  async function signIn(email,password) {
    const data=await request('/auth/v1/token?grant_type=password',{method:'POST',auth:false,body:{email,password}});
    if(!data?.access_token||!data?.user?.id) throw Error('No session returned. Verify your email and try again.');
    activate(data);
  }
  async function signUp(email,password) {
    const data=await request('/auth/v1/signup',{method:'POST',auth:false,body:{email,password}});
    if(data?.access_token&&data?.user?.id){activate(data);return 'Account created and signed in.';}
    return 'Account request received. If required, check your email for confirmation, then sign in.';
  }
  async function signOut() {
    if(session?.access_token){try{await request('/auth/v1/logout',{method:'POST'});}catch{ /* Always remove local session. */ }}
    setLocal();
  }
  function saveChanges(next) {
    if(!active())return false;
    try {
      const old=new Map(snapshot.map(t=>[t.id,t]));const updated=new Map(next.map(t=>[t.id,t]));
      const pending=queue();
      for(const [id,record] of updated){if(!old.has(id)||JSON.stringify(old.get(id))!==JSON.stringify(record))pending[id]={kind:'upsert',data:record,revision:crypto.randomUUID?.()||String(Date.now()+Math.random())};}
      for(const id of old.keys()){if(!updated.has(id))pending[id]={kind:'delete',revision:crypto.randomUUID?.()||String(Date.now()+Math.random())};}
      // Queue before caching; after a reload, outgoing changes are still available.
      setQueue(pending);cacheTasks(next);report(navigator.onLine?'pending':'offline');
      window.clearTimeout(deferred);deferred=window.setTimeout(sync,450);
      return true;
    }catch(e){fail(e);return false;}
  }
  async function sync() {
    if(!active()||busy)return;
    if(!navigator.onLine){report('offline');return;}
    const uid=user().id;busy=true;report('syncing');
    try {
      // Upload local changes BEFORE pulling the authoritative server list.
      const pending=queue();
      for(const [id,operation] of Object.entries(pending)){
        if(!active()||user().id!==uid)return;
        if(operation.kind==='upsert') await request('/rest/v1/pa_tasks?on_conflict=id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{id,owner_id:uid,data:operation.data}});
        else await request(`/rest/v1/pa_tasks?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(uid)}`,{method:'DELETE'});
        const nowQueue=queue(); if(nowQueue[id]?.revision===operation.revision){delete nowQueue[id];setQueue(nowQueue);}
      }
      const remote=await request(`/rest/v1/pa_tasks?owner_id=eq.${encodeURIComponent(uid)}&select=data&limit=5000`);
      if(!active()||user().id!==uid)return;
      const incoming=Array.isArray(remote)?remote.map(row=>row.data).filter(t=>t&&typeof t.id==='string'):[];
      // Changes made during the pull must not be overwritten. Replay unsent edits.
      const merged=new Map(incoming.map(t=>[t.id,t]));
      for(const [id,operation] of Object.entries(queue())) {if(operation.kind==='delete')merged.delete(id);else merged.set(id,operation.data);}
      const next=[...merged.values()];cacheTasks(next);handlers.onData(clone(next));
      report(Object.keys(queue()).length?'pending':'synced');
    } catch(e) {
      if([400,401,403].includes(e.status)){setLocal();handlers?.onError?.('Session expired. Please sign in again.');}
      else fail(e);
    } finally {
      busy=false;
      if(active()&&user().id===uid&&Object.keys(queue()).length&&status==='pending')window.setTimeout(sync,1500);
    }
  }
  function importLocal() {
    if(!active()) throw Error('Sign in to import browser-only tasks.');
    const previous=handlers.getLegacyTasks();const known=new Set(snapshot.map(t=>t.id));
    const additions=previous.filter(t=>!known.has(t.id));
    if(!additions.length)return 0;
    const merged=[...snapshot,...additions];handlers.onData(clone(merged));saveChanges(merged);return additions.length;
  }
  window.addEventListener('online',()=>{if(active())sync();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())sync();});
  window.addEventListener('focus',()=>{if(active())sync();});
  setInterval(()=>{if(active())sync();},25000);
  return {start,signIn,signUp,signOut,saveChanges,sync,importLocal,user,active,configured};
})();

'use strict';

// PA Desk v2 — browser-only local mode with optional authenticated cloud sync.
const STORAGE_KEY = 'paDesk.tasks.v1';
const ALERT_KEY = 'paDesk.alerts.v1';
const TYPES = { reminder:'Reminder', event:'Event / Function', handover:'File handover', followup:'Follow-up', task:'Other task' };
const FILTER_TITLES = { all:'Your worklist', today:'Due today', overdue:'Overdue work', upcoming:'Upcoming work', inbox:'Unscheduled work', done:'Completed work' };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id = () => (globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const pad = n => String(n).padStart(2,'0');
const localInput = date => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const localDate = date => localInput(date).slice(0,10);
const dateFromLocal = text => text ? new Date(text) : null;
const sameDay = (a,b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysFromNow = n => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+n); return d; };
// The event date and alert date are independent. The actionable date for an event
// is its explicit advance reminder; the occurrence stays on eventDate.
const dueDate = t => (t.type==='event' ? t.reminderAt : t.dueAt) ? dateFromLocal(t.type==='event'?t.reminderAt:t.dueAt) : null;
const occurrenceDate = t => t.eventDate ? dateFromLocal(`${t.eventDate}T${t.eventTime||'12:00'}`) : (t.dueAt?dateFromLocal(t.dueAt):null);
const dayBeforeAt5 = dateText => { const d=new Date(`${dateText}T12:00`); if(!validDate(d))return ''; d.setDate(d.getDate()-1); return `${localDate(d)}T17:00`; };
const validLocalDate = x => { if(!/^\d{4}-\d\d-\d\d$/.test(x||''))return false;const d=new Date(x+'T12:00');return validDate(d)&&localDate(d)===x; };
const validLocalTime = x => /^([01]\d|2[0-3]):[0-5]\d$/.test(x||'');
const validLocalDateTime = x => /^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d$/.test(x||'') && validLocalDate(x.slice(0,10)) && validDate(dateFromLocal(x));
const validDate = d => d instanceof Date && !Number.isNaN(d.valueOf());

let tasks = loadTasks();
let installPrompt = null;
let cloudInfo = {status:'local',details:''};
let alertLog = loadAlerts();
let filter = 'all';
let query = '';
let serviceWorkerRegistration = null;
let previouslyFocused = null;

function loadTasks() {
  try { const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(data) ? data.filter(isTaskLike).map(normalizeTask) : []; }
  catch { return []; }
}
function loadAlerts() { try { const data=JSON.parse(localStorage.getItem(ALERT_KEY)||'{}'); return data && typeof data==='object' && !Array.isArray(data) ? data : {}; } catch { return {}; } }
function isTaskLike(t) { return t && typeof t === 'object' && typeof t.title === 'string' && t.title.trim() !== ''; }
function normalizeTask(t) {
  const isEvent = t.type==='event';
  const eventDate = isEvent ? (validLocalDate(t.eventDate)?t.eventDate:(validLocalDateTime(t.dueAt)?t.dueAt.slice(0,10):(validLocalDate(t.dateHint)?t.dateHint:null))) : null;
  const eventTime = isEvent ? (validLocalTime(t.eventTime)?t.eventTime:(validLocalDateTime(t.dueAt)?t.dueAt.slice(11):null)) : null;
  const reminderAt = isEvent ? (validLocalDateTime(t.reminderAt)?t.reminderAt:(eventDate?dayBeforeAt5(eventDate):null)) : null;
  return {
    id: String(t.id||id()), title: String(t.title).slice(0,500),
    type: TYPES[t.type] ? t.type : 'task', dueAt: !isEvent && validLocalDateTime(t.dueAt) ? t.dueAt : null,
    eventDate, eventTime, reminderAt,
    dateHint: validLocalDate(t.dateHint) ? t.dateHint : eventDate,
    person: String(t.person||'').slice(0,150), place: String(t.place||'').slice(0,200),
    priority: ['low','normal','high'].includes(t.priority) ? t.priority : 'normal',
    advance: [0,5,15,30,60,1440].includes(Number(t.advance)) ? Number(t.advance) : 30,
    repeat: isEvent?'none':(['none','daily','weekly','monthly'].includes(t.repeat) ? t.repeat : 'none'),
    notes: String(t.notes||'').slice(0,2000),
    done: Boolean(t.done), createdAt: t.createdAt || new Date().toISOString(),
    completedAt: t.completedAt||null
  };
}
function store() {
  if(window.PADeskCloud?.active()) return window.PADeskCloud.saveChanges(tasks);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); updateCloudUI(); return true; }
  catch (error) { toast('Could not save. Browser storage may be full or disabled. Export a backup.', 'error'); return false; }
}
function todayStatus(t, now=new Date()) {
  if (t.done) return 'done';
  const d=dueDate(t);
  if (!validDate(d)) return 'inbox';
  if (d < now) return 'overdue';
  if (sameDay(d,now)) return 'today';
  return 'upcoming';
}
function selectFilter(next) {
  filter = next;
  $$('.nav-item, .tab').forEach(el => { const selected=el.dataset.filter===next; el.classList.toggle('active',selected); if(el.classList.contains('nav-item')) el.setAttribute('aria-current', selected?'page':'false'); });
  $('#listTitle').textContent=FILTER_TITLES[next];
  renderList();
}
function typeGuess(raw) {
  const s=raw.toLowerCase();
  if (/hand\s*over|handover|give\s+(?:the\s+)?file|send\s+(?:the\s+)?file|deliver\s+(?:the\s+)?file|file\s+to\b/.test(s)) return 'handover';
  if (/follow[\s-]?up|check\s+(?:with|on)|get\s+(?:an?\s+)?update|status\s+of/.test(s)) return 'followup';
  if (/marriage|wedding|birthday|function|meeting|ceremony|inauguration|event|appointment|reception|conference/.test(s)) return 'event';
  if (/remind|remember|call\s+back/.test(s)) return 'reminder';
  return 'task';
}
function extractSchedule(raw) {
  let d = null;
  const input=raw.trim().toLowerCase();
  const startOfDay=daysFromNow(0);
  if (/\bday\s+after\s+tomorrow\b/.test(input)) d=daysFromNow(2);
  else if (/\btomorrow\b/.test(input)) d=daysFromNow(1);
  else if (/\btoday\b/.test(input)) d=daysFromNow(0);
  else {
    const iso=input.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    const india=input.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
    if(iso) d=new Date(+iso[1],+iso[2]-1,+iso[3]);
    else if(india) d=new Date(+india[3],+india[2]-1,+india[1]);
    else {
      const dow=input.match(/\b(?:(next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
      if(dow){const day=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(dow[2]);let distance=(day-startOfDay.getDay()+7)%7;if(distance===0) distance=7;d=daysFromNow(distance);}
    }
  }
  // Reject impossible dates (e.g. 31/02/2026) rather than quietly moving to March.
  const iso=input.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const india=input.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  if(iso && d && (+iso[2]!==d.getMonth()+1 || +iso[3]!==d.getDate())) d=null;
  if(india && d && (+india[2]!==d.getMonth()+1 || +india[1]!==d.getDate())) d=null;
  let hours=null, mins=null;
  // 6 PM, 6:30 pm, 11 a.m. / 17:45; never interpret ambiguous "at 6" as 6 AM.
  const ampm=input.match(/\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  const military=!ampm && input.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if(ampm){hours=+ampm[1] % 12 + (ampm[3][0]==='p'?12:0);mins=+(ampm[2]||0);}
  else if(military){hours=+military[1];mins=+military[2];}
  return {dueAt:d && hours!==null?`${localDate(d)}T${pad(hours)}:${pad(mins)}`:null, dateHint:d?localDate(d):null};
}
function createQuick(e) {
  e.preventDefault();
  const raw=$('#quickText').value.trim(); if(!raw) return;
  const schedule=extractSchedule(raw);
  const guessedType=typeGuess(raw);
  const isEvent=guessedType==='event'&&schedule.dateHint;
  const task=normalizeTask({id:id(),title:raw,type:guessedType,...schedule,
    ...(isEvent?{eventDate:schedule.dateHint,eventTime:schedule.dueAt?.slice(11)||null,reminderAt:dayBeforeAt5(schedule.dateHint),dueAt:null}:{}),
    advance:30,priority:'normal',repeat:'none',done:false,createdAt:new Date().toISOString()});
  tasks.unshift(task);if(!store()){tasks.shift();return;}
  $('#quickText').value='';render();
  toast(isEvent?`Event saved. Reminder set for ${formatTime(task.reminderAt)}.`:schedule.dueAt?'Instruction saved with a reminder time.':'Instruction captured in Unscheduled. Add a time to receive an alert.',(isEvent||schedule.dueAt)?'success':'warning');
}
function openModal(existing=null){
  previouslyFocused=document.activeElement;
  $('#modalHeading').textContent=existing?'Edit task':'Create a task';
  $('#taskSaveBtn').textContent=existing?'Save changes':'Save task';
  $('#taskId').value=existing?.id||'';
  $('#taskTitle').value=existing?.title||'';
  $('#taskType').value=existing?.type||'reminder';
  $('#taskPriority').value=existing?.priority||'normal';
  $('#taskDateTime').value=existing?.dueAt||'';
  $('#taskEventDate').value=existing?.eventDate||'';
  $('#taskEventTime').value=existing?.eventTime||'';
  $('#taskEventReminder').value=existing?.reminderAt||'';
  $('#taskEventReminder').dataset.touched=existing?'true':'false';
  $('#taskAdvance').value=String(existing?.advance??30);
  $('#taskPerson').value=existing?.person||'';
  $('#taskRepeat').value=existing?.repeat||'none';
  $('#taskLocation').value=existing?.place||'';
  $('#taskNotes').value=existing?.notes||'';
  changeTaskType();
  $('#dateHintHelp').textContent=existing?.dateHint && !existing.dueAt ? `Mentioned date: ${existing.dateHint}. Choose a time; no time will be assumed.` : 'Leave empty to keep in Unscheduled.';
  $('#modalBackdrop').hidden=false;
  document.body.style.overflow='hidden';$('#taskTitle').focus();
}
function closeModal(){ $('#modalBackdrop').hidden=true; document.body.style.overflow=''; previouslyFocused?.focus?.(); }
function changeTaskType(){
  const isEvent=$('#taskType').value==='event';
  $$('.event-fields').forEach(el=>el.hidden=!isEvent);
  $$('.ordinary-fields').forEach(el=>el.hidden=isEvent);
  $('#taskEventDate').required=isEvent;
  $('#taskEventReminder').required=isEvent;
  $('#taskRepeat').disabled=isEvent;
  if(isEvent && $('#taskEventDate').value && !$('#taskEventReminder').value)updateDefaultEventReminder();
}
function updateDefaultEventReminder(){
  if($('#taskEventReminder').dataset.touched==='true')return;
  const eventDate=$('#taskEventDate').value;
  $('#taskEventReminder').value=validLocalDate(eventDate)?dayBeforeAt5(eventDate):'';
}
function formatTime(value){
  const d=dateFromLocal(value);
  return validDate(d)?d.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'not set';
}
function saveModal(e){
  e.preventDefault();const title=$('#taskTitle').value.trim();if(!title)return;
  const taskId=$('#taskId').value;
  const old=tasks.find(t=>t.id===taskId);
  const isEvent=$('#taskType').value==='event';
  const dueAt=isEvent?null:($('#taskDateTime').value||null);
  const eventDate=isEvent?$('#taskEventDate').value:null;
  const eventTime=isEvent?($('#taskEventTime').value||null):null;
  const reminderAt=isEvent?($('#taskEventReminder').value||null):null;
  if(dueAt && !validLocalDateTime(dueAt)){toast('Please enter a valid reminder date and time.','error');return;}
  if(isEvent && (!validLocalDate(eventDate) || !validLocalDateTime(reminderAt) || (eventTime&&!validLocalTime(eventTime)))){toast('Set a valid event date and advance reminder date/time.','error');return;}
  if(isEvent && reminderAt >= `${eventDate}T${eventTime||'23:59'}`){toast('Choose a reminder before the event, not on or after it.','error');return;}
  const t=normalizeTask({ id:taskId||id(), title, type:$('#taskType').value, priority:$('#taskPriority').value, dueAt, eventDate,eventTime,reminderAt,
    dateHint: isEvent?eventDate:(dueAt?dueAt.slice(0,10):old?.dateHint||null), advance:+$('#taskAdvance').value,
    person:$('#taskPerson').value.trim(), repeat:isEvent?'none':$('#taskRepeat').value, place:$('#taskLocation').value.trim(), notes:$('#taskNotes').value.trim(),
    done:old?.done||false, createdAt:old?.createdAt||new Date().toISOString(), completedAt:old?.completedAt||null });
  if(old){tasks=tasks.map(x=>x.id===old.id?t:x);}else{tasks.unshift(t);}
  if(!store())return;closeModal();render();toast(old?'Task updated.':'Task saved.');
}
function formatDue(t){
  if(t.type==='event') {
    const event=validLocalDate(t.eventDate)?new Date(`${t.eventDate}T12:00`):null;
    const when=event ? event.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})+(t.eventTime?` at ${new Date(`${t.eventDate}T${t.eventTime}`).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`:' (time not specified)') : 'date missing';
    return `Event: ${when} · Remind: ${formatTime(t.reminderAt)}`;
  }
  const d=dueDate(t);
  if(!validDate(d))return t.dateHint?`Date noted: ${new Date(`${t.dateHint}T12:00`).toLocaleDateString(undefined,{day:'numeric',month:'short'})} · time not set`:'Date and time not set';
  const date = sameDay(d,new Date()) ? 'Today' : sameDay(d,daysFromNow(1)) ? 'Tomorrow' : d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  return `${date}, ${d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`;
}
function filteredTasks() {
  const now=new Date(); const q=query.toLowerCase();
  return tasks.filter(t=>{
    const status=todayStatus(t,now);
    let allowed=false;
    switch(filter){
      case 'all': allowed=!t.done; break;
      case 'today': allowed=status==='today' || (status==='overdue' && sameDay(dueDate(t),now));break;
      case 'overdue': allowed=status==='overdue';break;
      case 'upcoming': allowed=status==='upcoming';break;
      case 'inbox': allowed=status==='inbox';break;
      case 'done': allowed=status==='done';break;
    }
    return allowed && (!q || [t.title,t.person,t.notes,t.place,TYPES[t.type]].join(' ').toLowerCase().includes(q));
  }).sort((a,b)=>{
    if(a.done!==b.done)return a.done?1:-1;
    const ad=dueDate(a),bd=dueDate(b);
    if(ad && bd)return ad-bd;
    if(ad)return -1;if(bd)return 1;
    if(a.priority!==b.priority)return (a.priority==='high'?-1:0)-(b.priority==='high'?-1:0);
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}
function renderList(){
  const list=$('#taskList');
  const display=filteredTasks();
  if(!display.length){
    const message=tasks.length===0?'Start by typing an instruction in Quick capture, or add a detailed task.':'No tasks match this view. Try another filter or add a new instruction.';
    list.innerHTML=`<div class="empty-state"><span class="empty-symbol">✧</span><strong>${tasks.length?'All clear here':'Your desk is ready'}</strong><p>${message}</p></div>`;
    return;
  }
  const now=new Date();
  list.innerHTML=display.map(t=>{
    const status=todayStatus(t,now);
    const dateClass=status==='overdue'?'meta-overdue':status==='inbox'?'meta-inbox':'';
    const extra=t.notes?`<p class="task-notes">${safe(t.notes)}</p>`:'';
    const person=t.person?`<span>♧ ${safe(t.person)}</span>`:'';
    const place=t.place?`<span>⌖ ${safe(t.place)}</span>`:'';
    return `<article class="task-card ${safe(status)} ${t.priority==='high'?'high':''} ${t.done?'completed':''}" data-id="${safe(t.id)}">
      <input type="checkbox" class="task-check" data-action="toggle" aria-label="${t.done?'Mark incomplete':'Mark complete'}: ${safe(t.title)}" ${t.done?'checked':''} />
      <div class="task-main"><div class="task-topline"><span class="type-chip ${safe(t.type)}">${safe(TYPES[t.type])}</span>${t.priority==='high'?'<span class="priority-chip">⚑ High priority</span>':''}${t.repeat!=='none'?`<span class="priority-chip">↻ ${safe(t.repeat)}</span>`:''}</div>
      <h3 class="task-title">${safe(t.title)}</h3>
      <div class="task-meta"><span class="${dateClass}">◷ ${safe(formatDue(t))}</span>${person}${place}</div>${extra}
      <div class="task-actions"><button type="button" class="mini-btn important" data-action="edit">✎ Edit</button>${!t.done && dueDate(t)?`<button type="button" class="mini-btn" data-action="snooze">◷ Snooze 10m</button><button type="button" class="mini-btn" data-action="calendar">▤ Google Calendar${t.type==='event'?' (event only)':''}</button><button type="button" class="mini-btn" data-action="ics">↓ .ics${t.type==='event'?' + reminder':''}</button>`:''}<button type="button" class="mini-btn danger" data-action="delete">✕ Delete</button></div></div>
    </article>`;
  }).join('');
}
function renderStats(){
  const now=new Date(); const open=tasks.filter(t=>!t.done);
  const overdue=open.filter(t=>dueDate(t) && dueDate(t)<now).length;
  const today=open.filter(t=>dueDate(t)&&sameDay(dueDate(t),now)).length;
  const upcoming=open.filter(t=>dueDate(t)&&dueDate(t)>now&&!sameDay(dueDate(t),now)).length;
  const inbox=open.filter(t=>!t.dueAt).length;
  const done=tasks.filter(t=>t.done).length;
  for(const [key,value] of Object.entries({all:open.length,today,overdue,upcoming,inbox,done})) {const el=$(`#nav-${key}`);if(el)el.textContent=value;}
  for(const [key,value] of Object.entries({Overdue:overdue,Today:today,Upcoming:upcoming,Inbox:inbox}))$(`#stat${key}`).textContent=value;
}
function renderNext(){
  const upcoming=tasks.filter(t=>!t.done&&dueDate(t)&&dueDate(t)>new Date()).sort((a,b)=>dueDate(a)-dueDate(b)).slice(0,3);
  $('#nextList').innerHTML=upcoming.length?upcoming.map(t=>{
    const d=dueDate(t);
    return `<div class="next-item"><div class="next-indicator"><strong>${d.toLocaleDateString(undefined,{day:'2-digit'})}</strong>${d.toLocaleDateString(undefined,{month:'short'}).toUpperCase()}</div><div class="next-details"><strong>${safe(t.title)}</strong><small>${t.type==='event'?'Reminder: ':''}${d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}${t.person?' · '+safe(t.person):''}</small></div></div>`;
  }).join(''):'<p class="no-next">No upcoming reminders yet. New scheduled tasks will appear here.</p>';
}
function render(){renderStats();renderList();renderNext();}
function nextRecurringDue(t){
  const date=dueDate(t);if(!validDate(date))return null;
  const current=new Date();let count=0;
  if(t.repeat==='monthly') {
    const originalDay=date.getDate();
    do {
      count++;
      const year=date.getFullYear(),month=date.getMonth();
      const maxDay=new Date(year,month+2,0).getDate();
      const next=new Date(year,month+1,Math.min(originalDay,maxDay),date.getHours(),date.getMinutes());
      date.setTime(next.valueOf());
    } while(date<=current && count<500);
  } else {
    do { count++; date.setDate(date.getDate()+(t.repeat==='daily'?1:7)); } while(date<=current && count<500);
  }
  return count<=500?localInput(date):null;
}
function toggleTask(t){
  if(t.done){t.done=false;t.completedAt=null;}
  else {t.done=true;t.completedAt=new Date().toISOString();if(t.repeat!=='none'&&dueDate(t)){const next=nextRecurringDue(t);if(next){tasks.push({...t,id:id(),dueAt:next,dateHint:next.slice(0,10),done:false,completedAt:null,createdAt:new Date().toISOString()});toast('Task completed. Next recurring reminder scheduled.');}}}
  if(store())render();
}
function handleTaskClick(e){
  const button=e.target.closest('[data-action]');if(!button)return;
  const card=button.closest('[data-id]');if(!card)return;
  const t=tasks.find(t=>t.id===card.dataset.id);if(!t)return;
  const action=button.dataset.action;
  if(action==='toggle') return; // Checkboxes are handled on 'change' only.
  if(action==='edit'){openModal(t);return;}
  if(action==='delete'){
    if(!confirm(`Delete “${t.title}”? This cannot be undone unless you have a backup.`))return;
    tasks=tasks.filter(x=>x.id!==t.id);if(store())render();toast('Task deleted.');return;
  }
  if(action==='snooze'){
    const d=new Date(Date.now()+10*60*1000);if(t.type==='event')t.reminderAt=localInput(d);else {t.dueAt=localInput(d);t.dateHint=localDate(d);}
    if(store()){render();toast('Snoozed until '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})+'. Calendar events do not update automatically.');}return;
  }
  if(action==='calendar') {if(t.type==='event')toast('Google Calendar link adds the event only. Use .ics + reminder for the separate advance alert.','warning');window.open(googleCalendarUrl(t),'_blank','noopener,noreferrer');return;}
  if(action==='ics'){downloadICS([t],`pa-desk-${t.id.slice(0,8)}.ics`);return;}
}
function calendarDetails(t){return [TYPES[t.type],t.type==='event'?`Event date: ${t.eventDate}${t.eventTime?' '+t.eventTime:''}`:null,t.type==='event'?`PA Desk advance reminder: ${formatTime(t.reminderAt)}`:null,t.person?`Person: ${t.person}`:null,t.place?`Venue / reference: ${t.place}`:null,t.notes||null,'Created with PA Desk. Note: editing this task does not update this calendar event.'].filter(Boolean).join('\n');}
function googleCalendarUrl(t){
  const start=t.type==='event'?occurrenceDate(t):dueDate(t);
  const end=new Date(start.getTime()+(t.type==='event'?60:15)*60000);
  const utc=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const allDay=t.type==='event'&&!t.eventTime;
  const endDay=new Date(start);endDay.setDate(endDay.getDate()+1);
  const basicDay=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const dates=allDay?`${basicDay(start)}/${basicDay(endDay)}`:`${utc(start)}/${utc(end)}`;
  const params=new URLSearchParams({action:'TEMPLATE',text:t.title,dates,details:calendarDetails(t)});
  if(t.place) params.set('location',t.place);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
const icsEscape=text=>String(text||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
const icsUTC=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
function icsText(selected){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//PA Desk//Reminder Manager v2//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  const valarm=title=>['BEGIN:VALARM','TRIGGER:PT0M','ACTION:DISPLAY',`DESCRIPTION:${icsEscape(title)}`,'END:VALARM'];
  for(const t of selected){
    const start=t.type==='event'?occurrenceDate(t):dueDate(t);
    if(!validDate(start))continue;
    const isAllDay=t.type==='event'&&!t.eventTime;
    const end=new Date(start);
    const basic=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    if(isAllDay)end.setDate(end.getDate()+1);else end.setMinutes(end.getMinutes()+(t.type==='event'?60:15));
    lines.push('BEGIN:VEVENT',`UID:${t.id}@pa-desk.local`,`DTSTAMP:${icsUTC(new Date())}`);
    if(isAllDay)lines.push(`DTSTART;VALUE=DATE:${basic(start)}`,`DTEND;VALUE=DATE:${basic(end)}`);
    else lines.push(`DTSTART:${icsUTC(start)}`,`DTEND:${icsUTC(end)}`);
    lines.push(`SUMMARY:${icsEscape(t.title)}`,`DESCRIPTION:${icsEscape(calendarDetails(t))}`);
    if(t.place)lines.push(`LOCATION:${icsEscape(t.place)}`);
    if(t.type!=='event'){
      if(t.advance>0)lines.push('BEGIN:VALARM',`TRIGGER:-PT${t.advance}M`,'ACTION:DISPLAY',`DESCRIPTION:${icsEscape(t.title)}`,'END:VALARM');
      lines.push(...valarm(t.title));
    }
    lines.push('END:VEVENT');
    // Separate real calendar entry at the exact chosen advance alert time.
    // This is not dependent on the event's time of day or the calendar's default alarm.
    if(t.type==='event'&&validLocalDateTime(t.reminderAt)){
      const alarmDate=dateFromLocal(t.reminderAt);const alarmEnd=new Date(alarmDate.getTime()+5*60000);
      lines.push('BEGIN:VEVENT',`UID:${t.id}-advance@pa-desk.local`,`DTSTAMP:${icsUTC(new Date())}`,`DTSTART:${icsUTC(alarmDate)}`,`DTEND:${icsUTC(alarmEnd)}`,`SUMMARY:${icsEscape(`REMINDER: ${t.title}`)}`,`DESCRIPTION:${icsEscape(`Upcoming event: ${t.eventDate}${t.eventTime?' '+t.eventTime:''}`)}`,...valarm(`Reminder: ${t.title}`),'END:VEVENT');
    }
  }
  return lines.concat(['END:VCALENDAR','']).join('\r\n');
}
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function downloadICS(items,name='pa-desk-calendar.ics'){
  const valid=items.filter(t=>dueDate(t) && !t.done);
  if(!valid.length){toast('No active scheduled tasks to export.','warning');return;}
  download(icsText(valid),name,'text/calendar;charset=utf-8');toast(`${valid.length} calendar item(s) exported. Import the file into your calendar and check alarm settings.`);
}
function exportBackup(){
  download(JSON.stringify({app:'PA Desk',version:2,exportedAt:new Date().toISOString(),tasks},null,2),`pa-desk-backup-${localDate(new Date())}.json`,'application/json');toast('Backup downloaded. Store it securely.');
}
async function importBackup(e){
  const file=e.target.files?.[0];if(!file)return;
  try{
    if(file.size>5*1024*1024)throw Error('Backup is too large (maximum 5 MB).');
    const json=JSON.parse(await file.text());
    if(json.app!=='PA Desk'||!Array.isArray(json.tasks)||json.tasks.length>20000||!json.tasks.every(isTaskLike))throw Error('This is not a valid PA Desk backup.');
    if(!confirm(`Restore ${json.tasks.length} tasks from this backup? This will REPLACE ${tasks.length} task(s)${window.PADeskCloud?.active()?' IN YOUR CLOUD ACCOUNT (and sync deletion to other devices)':' stored in this browser'}. Export a backup first.`))return;
    tasks=json.tasks.map(normalizeTask);
    if(store()){render();toast(`${tasks.length} tasks restored successfully.`);}
  }catch(err){toast(`Could not restore: ${err.message}`,'error');}
  finally{$('#importFile').value='';}
}
function toast(message,type='success'){
  const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('#toastStack').prepend(el);
  setTimeout(()=>el.remove(),6500);
}
async function getServiceWorker(){
  if(!('serviceWorker' in navigator)||!window.isSecureContext)return null;
  try{serviceWorkerRegistration=serviceWorkerRegistration||await navigator.serviceWorker.register('./sw.js');return serviceWorkerRegistration;}
  catch(e){return null;}
}
async function notifySystem(title,body){
  if(!('Notification' in window)||Notification.permission!=='granted')return false;
  try{
    const registration=await getServiceWorker();
    if(registration?.showNotification){await registration.showNotification(title,{body,icon:'./icon.svg',badge:'./icon.svg',tag:`pa-desk-${Date.now()}`});return true;}
    new Notification(title,{body,icon:'./icon.svg'});return true;
  }catch{return false;}
}
async function enableNotifications(){
  if(!('Notification' in window)){toast('Your browser does not support web notifications. Use a calendar instead.','warning');return;}
  if(!window.isSecureContext){toast('Open the HTTPS GitHub Pages link to enable alerts.','warning');return;}
  try{
    const answer=await Notification.requestPermission();
    if(answer==='granted'){
      await getServiceWorker();$('#enableAlertsBtn').textContent='✓ Alerts enabled';
      toast('Notifications enabled while PA Desk is running. For closed-app reminders, use a calendar.');
    }else toast('Notification permission was not granted. You can still use Calendar exports.','warning');
  }catch{toast('Your browser could not enable notifications.','warning');}
}
async function testNotification(){
  if(!('Notification' in window)||Notification.permission!=='granted'){toast('First press Enable alerts and allow notifications.','warning');return;}
  const success=await notifySystem('PA Desk: test reminder','Browser notifications are working while this app is open.');
  toast(success?'Test notification sent.':'Could not show a system alert. Check browser notification settings.',success?'success':'warning');
}
function checkReminders(){
  const now=Date.now();let changed=false;
  // Browser timers do not work reliably once all app tabs/windows have been closed.
  for(const t of tasks){
    const due=dueDate(t);if(t.done||!validDate(due))continue;
    const moments=[{key:'due',when:due.getTime(),label:t.type==='event'?'Event reminder':'Due now'}];
    if(t.type!=='event' && t.advance>0)moments.unshift({key:'early',when:due.getTime()-t.advance*60000,label:'Upcoming reminder'});
    for(const m of moments){
      const alertId=`${t.id}|${t.type==='event'?t.reminderAt:t.dueAt}|${m.key}`;
      if(alertLog[alertId])continue;
      const elapsed=now-m.when;
      // Notify only within 10 minutes of the alert point; past work is shown in Overdue.
      if(elapsed>=0 && elapsed<=10*60*1000){
        alertLog[alertId]=new Date().toISOString();changed=true;
        notifySystem(`PA Desk • ${m.label}`, `${t.title}${t.person?' — '+t.person:''}`);
        toast(`${m.label}: ${t.title}`,'warning');
      }
    }
  }
  if(changed){
    // Cap historical alert log growth.
    const entries=Object.entries(alertLog);
    if(entries.length>2000)alertLog=Object.fromEntries(entries.slice(-1000));
    try{localStorage.setItem(ALERT_KEY,JSON.stringify(alertLog));}catch{}
  }
}
function init(){
  $('#headerDate').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  if('Notification' in window && Notification.permission==='granted')$('#enableAlertsBtn').textContent='✓ Alerts enabled';
  $('#quickForm').addEventListener('submit',createQuick);
  $('#taskType').addEventListener('change',changeTaskType);
  $('#taskEventDate').addEventListener('change',updateDefaultEventReminder);
  $('#taskEventReminder').addEventListener('input',()=>{$('#taskEventReminder').dataset.touched='true';});
  $('#accountBtn').addEventListener('click',()=>{$('#authBackdrop').hidden=false;updateCloudUI();});
  $('#manageAccountBtn').addEventListener('click',()=>$('#accountBtn').click());
  $('#closeAuthBtn').addEventListener('click',()=>{$('#authBackdrop').hidden=true;});
  $('#authBackdrop').addEventListener('mousedown',e=>{if(e.target.id==='authBackdrop')$('#authBackdrop').hidden=true;});
  $('#authForm').addEventListener('submit',handleSignIn);
  $('#registerBtn').addEventListener('click',handleSignUp);
  $('#signOutBtn').addEventListener('click',handleSignOut);
  $('#syncNowBtn').addEventListener('click',()=>window.PADeskCloud.sync());
  $('#importLegacyBtn').addEventListener('click',importLegacyTasks);
  $('#installBtn').addEventListener('click',installApp);
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installBtn').hidden=false;});
  window.addEventListener('appinstalled',()=>{$('#installBtn').hidden=true;installPrompt=null;});
  $('#newTaskBtn').addEventListener('click',()=>openModal());
  $('#mobileNewBtn').addEventListener('click',()=>openModal());
  $('#taskForm').addEventListener('submit',saveModal);
  $('#closeModalBtn').addEventListener('click',closeModal);
  $('#cancelModalBtn').addEventListener('click',closeModal);
  $('#modalBackdrop').addEventListener('mousedown',e=>{if(e.target.id==='modalBackdrop')closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#modalBackdrop').hidden)closeModal();});
  $('#taskList').addEventListener('click',handleTaskClick);
  $('#taskList').addEventListener('change',e=>{if(e.target.matches('.task-check')){const t=tasks.find(x=>x.id===e.target.closest('[data-id]')?.dataset.id);if(t)toggleTask(t);}});
  $$('.nav-item, .tab, .stat-card').forEach(button=>button.addEventListener('click',()=>selectFilter(button.dataset.filter)));
  $('#searchInput').addEventListener('input',e=>{query=e.target.value.trim();renderList();});
  $('#exportBtn').addEventListener('click',exportBackup);
  $('#calendarExportBtn').addEventListener('click',()=>downloadICS(tasks));
  $('#importBtn').addEventListener('click',()=>$('#importFile').click());
  $('#importFile').addEventListener('change',importBackup);
  $('#enableAlertsBtn').addEventListener('click',enableNotifications);
  $('#testAlertBtn').addEventListener('click',testNotification);
  render();
  window.PADeskCloud.start({
    onData:next=>{tasks=next.filter(isTaskLike).map(normalizeTask);render();updateCloudUI();},
    onLocal:()=>{tasks=loadTasks();render();updateCloudUI();},
    onState:state=>{cloudInfo=state;updateCloudUI();},onError:message=>toast(`Sync error: ${message}`,'error'),
    localCount:()=>loadTasks().length,getLegacyTasks:()=>loadTasks()
  });
  updateCloudUI();
  getServiceWorker();
  checkReminders();
  setInterval(()=>{renderStats();renderNext();if(filter!=='done')renderList();checkReminders();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){render();checkReminders();}});
}
async function handleSignIn(e){
  e.preventDefault();const email=$('#authEmail').value.trim();const password=$('#authPassword').value;
  $('#authSubmit').disabled=true;
  try{await window.PADeskCloud.signIn(email,password);$('#authPassword').value='';$('#authBackdrop').hidden=true;toast('Signed in. Your cloud tasks will load shortly.');}
  catch(err){toast(`Sign-in failed: ${err.message}`,'error');}
  finally{$('#authSubmit').disabled=false;}
}
async function handleSignUp(){
  const email=$('#authEmail').value.trim();const password=$('#authPassword').value;
  if(!email||password.length<8){toast('Enter your email and a password of at least 8 characters.','warning');return;}
  $('#registerBtn').disabled=true;
  try{const message=await window.PADeskCloud.signUp(email,password);toast(message);$('#authPassword').value='';}
  catch(err){toast(`Could not create account: ${err.message}`,'error');}
  finally{$('#registerBtn').disabled=false;}
}
async function handleSignOut(){await window.PADeskCloud.signOut();toast('Signed out. Browser-only tasks are now displayed.');}
function importLegacyTasks(){
  if(!window.PADeskCloud.active())return;
  const count=loadTasks().length;if(!count)return;
  if(!confirm(`Copy up to ${count} previously saved browser-only tasks into this cloud account? Existing cloud tasks will be retained.`))return;
  try{const n=window.PADeskCloud.importLocal();toast(n?`${n} browser task(s) queued for cloud syncing.`:'No new tasks to import.');updateCloudUI();}
  catch(e){toast(e.message,'error');}
}
async function installApp(){
  if(!installPrompt){toast('On Android Chrome: open the browser menu and choose Install app or Add to Home screen.','warning');return;}
  const prompt=installPrompt;installPrompt=null;await prompt.prompt();$('#installBtn').hidden=true;
}
function updateCloudUI(){
  const cloud=window.PADeskCloud;
  if(!cloud)return;
  const active=cloud.active();const configured=cloud.configured;
  const account=cloud.user();
  const label=active?`☁ ${account.email||'Signed in'}`:configured?'☁ Sign in to sync':'☁ Set up cloud sync';
  $('#accountBtn').textContent=label;
  const state=$('#syncState');
  const storedLocal=loadTasks().length;
  if(active){
    const texts={synced:'All changes synced to cloud.',syncing:'Syncing tasks across devices…',pending:'Changes saved locally; cloud sync pending.',offline:'Offline — changes will sync after reconnecting.',error:'Cloud connection error — check internet, account, or database setup.',connecting:'Connecting to cloud…'};
    state.textContent=texts[cloudInfo.status]||'Cloud account connected. Changes sync when online.';
    $('#authStatus').textContent=`Signed in as ${account.email||'your account'}. Cloud sync runs automatically.`;
  } else {
    state.textContent=configured?'Browser-only mode. Sign in for cross-device access.':'Browser-only mode. Configure Supabase in config.js to enable cross-device syncing.';
    $('#authStatus').textContent=configured?'Sign in with the same account on all browsers and phones.':'Cloud sync is not yet configured. Follow the setup instructions in README.md.';
  }
  $('#authForm').hidden=!configured||active;
  $('#registerBtn').hidden=!configured||active;
  $('#signOutBtn').hidden=!active;
  $('#syncNowBtn').hidden=!active;
  $('#importLegacyBtn').hidden=!active||storedLocal===0;
  $('#importLegacyBtn').textContent=`↑ Import ${storedLocal} browser-only task(s)`;
  $('#sidebarStorage').textContent=active?'ACCOUNT SYNC • BACKED UP IN CLOUD':'BROWSER-ONLY • NOT SYNCED';
  $('#backupNotice').textContent=active?'Tasks sync through your private cloud account. Download backups for extra safety.':'Tasks are saved only in this browser. Sign in to sync across devices.';
  $('#syncBadge').textContent=active?'● Cloud':'○ Local';
}
init();

// Expose a read-only development interface for local automated QA; not user data APIs.
window.PADeskQA = Object.freeze({extractSchedule,typeGuess,icsText,formatDue,dayBeforeAt5,validLocalDateTime});

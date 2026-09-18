(async function(){
  const $=id=>document.getElementById(id);
  const status=$('appStatus');
  const busy=$('busyOverlay');
  const busyText=$('busyText');
  const wfoSelect=$('wfoSelect');
  const groupControls=$('groupControls');
  const mapBadge=$('mapBadge');
  const cursorReadout=$('cursorReadout');
  const hoverReadout=$('hoverReadout');
  const toolsDrawer=$('toolsDrawer');
  const toolsDrawerToggle=$('toolsDrawerToggle');
  const toolsCloseBtn=$('toolsCloseBtn');
  const beamToolPanel=$('beamToolPanel');
  const scanToolPanel=$('scanToolPanel');
  const beamToolTab=$('beamToolTab');
  const scanToolTab=$('scanToolTab');
  const selectedRadarBeam=$('selectedRadarBeam');
  const beamTargetReadout=$('beamTargetReadout');
  const strategyRadarStatus=$('strategyRadarStatus');
  const strategyRisk=$('strategyRisk');
  const strategyTargetInfo=$('strategyTargetInfo');
  const strategyRecommendation=$('strategyRecommendation');
  const strategyReferenceBody=$('strategyReferenceBody');
  const mapUI=new RadarMap('map');

  let radarCatalog,wfoCatalog,backups,currentWfo=null,groups=[],activeMode='local',localBounds=null,renderToken=0,currentMosaic=null;
  let selectedRadar=null,strategyTarget=null,activeToolTab='beam';

  function showBusy(t){busyText.textContent=t;busy.classList.remove('hidden')}
  function hideBusy(){busy.classList.add('hidden')}
  function setStatus(t){status.textContent=t}

  async function loadJson(p){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    try{
      const r=await fetch(p,{cache:'no-cache',signal:controller.signal});
      if(!r.ok)throw new Error(`${p} returned HTTP ${r.status}`);
      return await r.json();
    }finally{clearTimeout(timer)}
  }

  function mergedRadar(id,office){
    const base=radarCatalog.radars[id];
    if(!base)throw new Error(`Radar ${id} is referenced by ${office.id} but missing from radar_catalog.json`);
    const override=(office.radar_overrides||{})[id]||{};
    return{id,...base,...override,color:override.color||base.color||'#3887be'};
  }

  function officeGroup(officeId,role,label){
    const office=wfoCatalog.wfos[officeId];
    if(!office)return null;
    const officeForMerge={...office,id:officeId};
    const radars=(office.radars||[]).map(id=>mergedRadar(id,officeForMerge));
    return{key:`${role}:${officeId}`,role,label,officeId,officeName:office.name,enabled:true,radars,radarEnabled:new Map(radars.map(r=>[r.id,true]))};
  }

  function buildGroups(wfo){
    const out=[officeGroup(wfo,'home','Home Office')];
    const b=backups[wfo]||{};
    if(b.primary)out.push(officeGroup(b.primary,'primary','Primary Backup'));
    if(b.secondary)out.push(officeGroup(b.secondary,'secondary','Secondary Backup'));
    if(b.tertiary)out.push(officeGroup(b.tertiary,'tertiary','Tertiary Backup'));
    return out.filter(Boolean);
  }

  function activeRadars(){
    const byId=new Map();
    for(const g of groups){
      if(!g.enabled)continue;
      for(const r of g.radars)if(g.radarEnabled.get(r.id))byId.set(r.id,r);
    }
    return[...byId.values()];
  }

  function coverageBounds(radars){
    if(!radars.length)return null;
    let s=90,n=-90,w=180,e=-180;
    for(const r of radars){
      const latPad=(r.range_nm*1.15078)/69;
      const lonPad=latPad/Math.max(.28,Math.cos(r.lat*Math.PI/180));
      s=Math.min(s,r.lat-latPad);n=Math.max(n,r.lat+latPad);w=Math.min(w,r.lon-lonPad);e=Math.max(e,r.lon+lonPad);
    }
    return L.latLngBounds([s,w],[n,e]);
  }

  function renderGroupControls(){
    groupControls.innerHTML='';
    for(const g of groups){
      const card=document.createElement('div');card.className='group-card';
      const head=document.createElement('div');head.className='group-head';
      head.innerHTML=`<input type="checkbox" ${g.enabled?'checked':''}><div><div class="group-title">${g.officeId} — ${g.officeName}</div><div class="group-role">${g.label}</div></div><div class="group-count">${g.radars.length} radars</div>`;
      const gb=head.querySelector('input');gb.addEventListener('change',async()=>{g.enabled=gb.checked;await recalc()});card.appendChild(head);
      const details=document.createElement('details');details.className='group-details';
      const summary=document.createElement('summary');summary.textContent='Show individual radars';details.appendChild(summary);
      for(const r of g.radars){
        const row=document.createElement('label');row.className='radar-row';
        row.innerHTML=`<input type="checkbox" ${g.radarEnabled.get(r.id)?'checked':''}><span class="swatch" style="background:${r.color}"></span><span>${r.id}</span><span class="radar-meta">${r.lowest_tilt_deg.toFixed(1)}° • ${r.range_nm} nmi</span>`;
        row.querySelector('input').addEventListener('change',async e=>{g.radarEnabled.set(r.id,e.target.checked);await recalc()});
        details.appendChild(row);
      }
      card.appendChild(details);groupControls.appendChild(card);
    }
  }


  function escapeHtml(value){
    return String(value==null?'':value)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }

  function setDrawerOpen(open){
    toolsDrawer.classList.toggle('open',!!open);
    toolsDrawerToggle.classList.toggle('drawer-open',!!open);
    toolsDrawerToggle.setAttribute('aria-expanded',open?'true':'false');
  }

  function setToolTab(tab){
    activeToolTab=tab==='scan'?'scan':'beam';
    const scan=activeToolTab==='scan';
    beamToolTab.classList.toggle('active',!scan);
    scanToolTab.classList.toggle('active',scan);
    beamToolTab.setAttribute('aria-selected',scan?'false':'true');
    scanToolTab.setAttribute('aria-selected',scan?'true':'false');
    beamToolPanel.classList.toggle('hidden',scan);
    scanToolPanel.classList.toggle('hidden',!scan);
    scanToolPanel.setAttribute('aria-hidden',scan?'false':'true');
  }

  function renderStrategyReference(){
    strategyReferenceBody.innerHTML=ScanningStrategy.QUICK_REFERENCE
      .map(item=>'<div class="strategy-ref-row"><strong>'+escapeHtml(item.term)+':</strong> '+escapeHtml(item.text)+'</div>')
      .join('');
  }

  function renderStrategySegment(rec){
    const seg=rec&&rec.segment;
    if(!seg)return '<span class="soft">No recommendation rule found.</span>';
    const blocks=[];
    if(seg.primary&&seg.primary.length){
      blocks.push('<div class="strategy-option">'+seg.primary.map(line=>'<div class="strategy-line">'+escapeHtml(line)+'</div>').join('')+'</div>');
    }
    if(seg.options&&seg.options.length){
      for(const opt of seg.options){
        blocks.push(
          '<div class="strategy-option">'+
            '<div class="strategy-option-title">'+escapeHtml(opt.label)+'</div>'+
            (opt.lines||[]).map(line=>'<div class="strategy-line">'+escapeHtml(line)+'</div>').join('')+
          '</div>'
        );
      }
    }
    return blocks.join('');
  }

  function activeRadarById(id){
    return activeRadars().find(r=>r.id===id)||null;
  }

  function handleRadarSelect(radar){
    selectedRadar=radar;
    mapUI.setSelectedRadar(radar.id);
    setDrawerOpen(true);
    renderToolReadouts();
  }

  function setTargetPoint(latlng){
    strategyTarget=L.latLng(latlng.lat,latlng.lng);
    const color=ScanningStrategy.RISK_COLORS[strategyRisk.value]||'#ff2d2d';
    mapUI.setTarget(strategyTarget,color);
    renderToolReadouts();
  }

  function clearToolSelection(){
    selectedRadar=null;
    strategyTarget=null;
    mapUI.setSelectedRadar(null);
    mapUI.clearTarget();
    renderToolReadouts();
  }

  function renderToolReadouts(){
    if(!selectedRadar){
      selectedRadarBeam.innerHTML='Click a radar dot on the map.';
      beamTargetReadout.innerHTML='Select a radar, then click the map to compare that radar with the lowest beam available from the active WFO radar set.';
      strategyRadarStatus.classList.remove('strategy-unavailable');
      strategyRadarStatus.innerHTML='Click a WSR-88D radar dot on the map.';
      strategyTargetInfo.innerHTML='Click a WSR-88D radar, then click a target point on the map.';
      strategyRecommendation.innerHTML='No target selected.';
      return;
    }

    const network=selectedRadar.network||'';
    selectedRadarBeam.innerHTML=
      '<strong>'+escapeHtml(selectedRadar.id)+'</strong> — '+escapeHtml(selectedRadar.name||'')+
      '<br><span class="soft">'+escapeHtml(network)+' • '+selectedRadar.lowest_tilt_deg.toFixed(1)+'° • '+selectedRadar.range_nm+' nmi</span>';

    if(strategyTarget){
      const best=currentMosaic&&$('mosaicToggle').checked
        ?BeamEngine.sampleMosaic(currentMosaic,strategyTarget.lat,strategyTarget.lng)
        :BeamEngine.bestRadarAt(strategyTarget.lat,strategyTarget.lng,activeRadars());
      const selectedHeight=BeamEngine.radarValueAt(strategyTarget.lat,strategyTarget.lng,selectedRadar);
      const distanceNm=BeamEngine.haversineMeters(selectedRadar.lat,selectedRadar.lon,strategyTarget.lat,strategyTarget.lng)/1852;
      const bestLine=best
        ?'<strong>'+Math.round(best.height_ft).toLocaleString()+' ft ARL</strong> — '+escapeHtml(best.radar.id)
        :'<span class="soft">No active radar coverage</span>';
      const selectedLine=selectedHeight==null
        ?'<span class="soft">Outside '+escapeHtml(selectedRadar.id)+' configured range</span>'
        :'<strong>'+Math.round(selectedHeight).toLocaleString()+' ft ARL</strong>';

      beamTargetReadout.innerHTML=
        '<div><span class="soft">Target:</span> '+strategyTarget.lat.toFixed(3)+', '+strategyTarget.lng.toFixed(3)+'</div>'+
        '<div style="margin-top:6px"><span class="soft">Lowest active beam:</span> '+bestLine+'</div>'+
        '<div><span class="soft">'+escapeHtml(selectedRadar.id)+' beam:</span> '+selectedLine+' <span class="soft">('+distanceNm.toFixed(1)+' nmi)</span></div>';
    }else{
      beamTargetReadout.innerHTML='Click the map to set a target and compare <strong>'+escapeHtml(selectedRadar.id)+'</strong> with the lowest active beam.';
    }

    if(network!=='NEXRAD'){
      strategyRadarStatus.classList.add('strategy-unavailable');
      strategyRadarStatus.innerHTML=
        '<strong>'+escapeHtml(selectedRadar.id)+'</strong> — '+escapeHtml(network)+
        '<br><span class="soft">Scanning-strategy recommendations are only available for WSR-88D/NEXRAD sites.</span>';
      strategyTargetInfo.innerHTML='Select a WSR-88D radar dot to use the scanning-strategy tool.';
      strategyRecommendation.innerHTML='<span class="soft">Not applicable to this radar type.</span>';
      return;
    }

    strategyRadarStatus.classList.remove('strategy-unavailable');
    strategyRadarStatus.innerHTML=
      '<strong>'+escapeHtml(selectedRadar.id)+'</strong> — '+escapeHtml(selectedRadar.name||'')+
      '<br><span class="soft">'+selectedRadar.lowest_tilt_deg.toFixed(1)+'° lowest tilt</span>';

    if(!strategyTarget){
      strategyTargetInfo.innerHTML='Click a target point on the map to calculate distance and the recommended strategy.';
      strategyRecommendation.innerHTML='No target selected.';
      return;
    }

    const distanceNm=BeamEngine.haversineMeters(selectedRadar.lat,selectedRadar.lon,strategyTarget.lat,strategyTarget.lng)/1852;
    const rec=ScanningStrategy.recommendation(strategyRisk.value,distanceNm);
    strategyTargetInfo.innerHTML=
      '<div><strong>'+distanceNm.toFixed(1)+' nmi</strong> from '+escapeHtml(selectedRadar.id)+'</div>'+
      '<div class="soft">'+strategyTarget.lat.toFixed(3)+', '+strategyTarget.lng.toFixed(3)+' • '+escapeHtml(rec.label)+'</div>';
    strategyRecommendation.innerHTML=renderStrategySegment(rec);
  }

  async function recalc(){
    const token=++renderToken;
    const radars=activeRadars();
    if(selectedRadar&&!radars.some(r=>r.id===selectedRadar.id)){
      clearToolSelection();
    }
    mapUI.setSites(radars,$('sitesToggle').checked);
    if(selectedRadar)mapUI.setSelectedRadar(selectedRadar.id);
    if(!localBounds||!radars.length){currentMosaic=null;mapUI.setMosaicVisible(false);setStatus(radars.length?'Ready':'No radars selected');return}
    if(!$('mosaicToggle').checked){mapUI.setMosaicVisible(false);currentMosaic=null;setStatus(`${currentWfo} • ${radars.length} active radars`);return}

    const calcBounds=coverageBounds(radars);
    showBusy(`Calculating ${radars.length} active radars…`);setStatus('Calculating…');
    try{
      const result=await BeamEngine.computeMosaic(calcBounds,radars,{width:600,maxHeight:500,opacity:.54,onProgress:(p,id)=>{if(token===renderToken)busyText.textContent=`Calculating beam mosaic… ${Math.round(p*100)}% (${id})`}});
      if(token!==renderToken)return;
      currentMosaic=result;
      mapUI.setMosaic(result.dataUrl,calcBounds,true);
      setStatus(`${currentWfo} • ${radars.length} active radars`);
    }finally{if(token===renderToken)hideBusy()}
  }

  async function selectWfo(wfo){
    currentWfo=wfo;mapBadge.textContent=wfo;
    const office=wfoCatalog.wfos[wfo];$('officeSubtitle').textContent=office.description||office.name;
    clearToolSelection();
    groups=buildGroups(wfo);
    for(const g of groups)g.enabled=g.role==='home';
    renderGroupControls();
    const home=groups.find(g=>g.role==='home');localBounds=coverageBounds(home.radars);
    if(activeMode==='local')mapUI.showLocal(localBounds);else mapUI.showConus(office.center);
    await recalc();
  }

  function setGroupPreset(mode){
    for(const g of groups)g.enabled=mode==='all'||(mode==='home'&&g.role==='home')||(mode==='backups'&&g.role!=='home');
    renderGroupControls();recalc();
  }

  function setViewMode(mode){
    activeMode=mode;$('localViewBtn').classList.toggle('active',mode==='local');$('conusViewBtn').classList.toggle('active',mode==='conus');
    const office=wfoCatalog.wfos[currentWfo];mode==='local'?mapUI.showLocal(localBounds):mapUI.showConus(office.center);
  }

  function updateCursor(latlng,originalEvent){
    const radars=activeRadars();
    const rasterSample=currentMosaic&&$('mosaicToggle').checked?BeamEngine.sampleMosaic(currentMosaic,latlng.lat,latlng.lng):null;
    const best=rasterSample||BeamEngine.bestRadarAt(latlng.lat,latlng.lng,radars);
    const coord=`${latlng.lat.toFixed(3)}, ${latlng.lng.toFixed(3)}`;
    let detail;
    if(best){
      detail=`<strong>${Math.round(best.height_ft).toLocaleString()} ft ARL</strong> — ${best.radar.id}`;
    }else detail=`<span class="soft">No selected radar coverage</span>`;
    cursorReadout.innerHTML=`<div>${coord}</div><div>${detail}</div>`;
    hoverReadout.innerHTML=`<div class="hover-coord">${coord}</div><div>${detail}</div>`;
    hoverReadout.classList.remove('hidden');
    if(originalEvent){
      const rect=mapUI.map.getContainer().getBoundingClientRect();let left=originalEvent.clientX-rect.left+16;let top=originalEvent.clientY-rect.top+16;
      const width=hoverReadout.offsetWidth||245,height=hoverReadout.offsetHeight||82;
      if(left+width>rect.width-8)left=Math.max(8,left-width-30);if(top+height>rect.height-8)top=Math.max(8,top-height-30);
      hoverReadout.style.left=`${left}px`;hoverReadout.style.top=`${top}px`;
    }
  }

  try{
    showBusy('Loading national radar catalogs…');
    [radarCatalog,wfoCatalog,backups]=await Promise.all([loadJson('./catalogs/radar_catalog.json'),loadJson('./catalogs/wfo_catalog.json'),loadJson('./catalogs/backup_assignments.json')]);
    mapUI.initReferenceLayers();
    for(const id of ['mosaicToggle','sitesToggle','allCwaToggle','referenceToggle'])$(id).checked=true;
    const selectable=Object.entries(wfoCatalog.wfos).filter(([,v])=>v.selectable);
    for(const[id,info]of selectable){const o=document.createElement('option');o.value=id;o.textContent=`${id} — ${info.name}`;wfoSelect.appendChild(o)}
    wfoSelect.addEventListener('change',()=>selectWfo(wfoSelect.value));
    $('allGroupsBtn').addEventListener('click',()=>setGroupPreset('all'));$('homeOnlyBtn').addEventListener('click',()=>setGroupPreset('home'));$('backupsOnlyBtn').addEventListener('click',()=>setGroupPreset('backups'));
    $('localViewBtn').addEventListener('click',()=>setViewMode('local'));$('conusViewBtn').addEventListener('click',()=>setViewMode('conus'));
    $('mosaicToggle').addEventListener('change',()=>$('mosaicToggle').checked?recalc():mapUI.setMosaicVisible(false));
    $('sitesToggle').addEventListener('change',e=>mapUI.setSitesVisible(e.target.checked));
    $('allCwaToggle').addEventListener('change',e=>mapUI.setAllCwaVisible(e.target.checked));
    $('referenceToggle').addEventListener('change',e=>mapUI.setReferenceVisible(e.target.checked));
    $('mrmsToggle').addEventListener('change',e=>mapUI.setMrmsVisible(e.target.checked));
    $('warningsToggle').addEventListener('change',e=>mapUI.setWarningsVisible(e.target.checked));

    mapUI.setRadarSelectHandler(handleRadarSelect);
    mapUI.map.on('click',e=>{if(selectedRadar)setTargetPoint(e.latlng)});
    toolsDrawerToggle.addEventListener('click',()=>setDrawerOpen(true));
    toolsCloseBtn.addEventListener('click',()=>setDrawerOpen(false));
    beamToolTab.addEventListener('click',()=>setToolTab('beam'));
    scanToolTab.addEventListener('click',()=>setToolTab('scan'));
    strategyRisk.addEventListener('change',()=>{
      if(strategyTarget){
        const color=ScanningStrategy.RISK_COLORS[strategyRisk.value]||'#ff2d2d';
        mapUI.setTarget(strategyTarget,color);
      }
      renderToolReadouts();
    });
    renderStrategyReference();
    setToolTab('beam');
    setDrawerOpen(true);
    renderToolReadouts();

    mapUI.map.on('mousemove',e=>updateCursor(e.latlng,e.originalEvent));
    mapUI.map.getContainer().addEventListener('mouseleave',()=>hoverReadout.classList.add('hidden'));
    mapUI.setReferenceVisible($('referenceToggle').checked);mapUI.setAllCwaVisible($('allCwaToggle').checked);
    const def=wfoCatalog.default_wfo||selectable[0]?.[0];wfoSelect.value=def;await selectWfo(def);
  }catch(e){
    console.error(e);hideBusy();setStatus('Startup error');
    const msg=e?.name==='AbortError'?'A startup request timed out. Refresh the page to retry.':e.message;
    alert(`Startup error: ${msg}`);
  }
})();

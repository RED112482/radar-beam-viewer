(function(){
  const REF_FS='https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/FeatureServer';
  const WARN_BASE='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/0';
  const MRMS_IMAGE_SERVICE='https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer';
  const MRMS_IMAGE_EXPORT=MRMS_IMAGE_SERVICE+'/exportImage';
  const MRMS_MAP_EXPORT='https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';

  async function fetchJsonWithTimeout(url,timeoutMs=7000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await fetch(url,{signal:controller.signal,cache:'no-cache'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }finally{clearTimeout(timer)}
  }

  function warningStyle(feature){
    const p=feature?.properties||{};
    const key=`${p.phenom||''},${p.sig||''}`;
    const colors={'TO,W':'#ff3b30','SV,W':'#ffe600','FF,W':'#4caf50','MA,W':'#ff9f0a','SQ,W':'#d62da0'};
    const color=colors[key]||'#ff5ea8';
    return{color,weight:2.2,opacity:.95,fillColor:color,fillOpacity:.10};
  }

  class RadarMap{
    constructor(divId){
      this.map=L.map(divId,{zoomControl:true,preferCanvas:true,minZoom:3});

      this.map.createPane('beamPane');this.map.getPane('beamPane').style.zIndex=240;this.map.getPane('beamPane').style.pointerEvents='none';
      this.map.createPane('mrmsPane');this.map.getPane('mrmsPane').style.zIndex=270;this.map.getPane('mrmsPane').style.pointerEvents='none';
      this.map.createPane('referencePane');this.map.getPane('referencePane').style.zIndex=420;this.map.getPane('referencePane').style.pointerEvents='none';
      this.map.createPane('cwaPane');this.map.getPane('cwaPane').style.zIndex=430;this.map.getPane('cwaPane').style.pointerEvents='none';
      this.map.createPane('warningPane');this.map.getPane('warningPane').style.zIndex=460;
      this.map.createPane('toolPane');this.map.getPane('toolPane').style.zIndex=490;

      this.baseLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        maxZoom:18,attribution:'&copy; OpenStreetMap contributors',className:'dark-osm'
      }).addTo(this.map);

      this.stateLayer=L.geoJSON(null,{pane:'referencePane',style:{color:'#ffffff',weight:1.25,opacity:.88,fillOpacity:0},interactive:false});
      this.countyLayer=L.geoJSON(null,{pane:'referencePane',style:{color:'#ffffff',weight:.55,opacity:.52,fillOpacity:0},interactive:false});
      this.referenceLayer=L.layerGroup([this.stateLayer,this.countyLayer]).addTo(this.map);
      this.allCwaLayer=L.geoJSON(null,{pane:'cwaPane',style:{color:'#ff3b30',weight:2.35,opacity:.94,fillOpacity:0},interactive:false});

      this.map.setView([37.8,-96.5],4);
      this.mosaic=null;this.mrmsLayer=null;this.siteLayer=L.layerGroup().addTo(this.map);
      this.siteMarkers=new Map();this.radarSelectHandler=null;this.selectedRadarId=null;this.selectedRadarPulse=null;this.targetMarker=null;
      this.warningLayer=L.geoJSON(null,{
        pane:'warningPane',style:warningStyle,interactive:false,
        onEachFeature:(feature,layer)=>{const p=feature.properties||{};const label=p.prod_type||`${p.phenom||''}.${p.sig||''}`;layer.bindTooltip(`<strong>${label}</strong>${p.wfo?`<br>WFO ${p.wfo}`:''}`,{sticky:true})}
      });

      this.referenceEnabled=true;this.allCwaEnabled=false;this.warningEnabled=false;this.mrmsEnabled=false;
      this._warningTimer=null;this._warningInterval=null;this._mrmsTimer=null;this._mrmsLatestTime=null;this._mrmsCheckInFlight=false;this._referenceTimer=null;this._warningKey='';this._referenceKey='';this._allCwasLoaded=false;
      this.map.on('moveend',()=>{
        if(this.referenceEnabled)this._scheduleReferenceRefresh();
        if(this.warningEnabled)this._maybeRefreshWarnings();
        if(this.mrmsEnabled)this._refreshMrms(this._mrmsLatestTime);
      });
    }

    async initReferenceLayers(){this._refreshReference(true)}

    _referenceSimplify(){
      const z=this.map.getZoom();
      if(z<=4)return .05;
      if(z<=6)return .02;
      if(z<=8)return .008;
      return .003;
    }

    _scheduleReferenceRefresh(force=false){
      clearTimeout(this._referenceTimer);
      this._referenceTimer=setTimeout(()=>this._refreshReference(force),180);
    }

    async _fetchLayerPage(layerId,b,offset,maxOffset){
      const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const q=new URLSearchParams({
        where:'1=1',geometry:geom,geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects',
        outFields:'objectid',returnGeometry:'true',outSR:'4326',maxAllowableOffset:String(maxOffset),geometryPrecision:'4',
        resultOffset:String(offset),resultRecordCount:'2000',f:'geojson'
      });
      return fetchJsonWithTimeout(`${REF_FS}/${layerId}/query?${q.toString()}`,7000);
    }

    async _fetchPagedLayer(layerId,b,maxOffset,maxPages=3){
      const features=[];
      for(let page=0;page<maxPages;page++){
        const d=await this._fetchLayerPage(layerId,b,page*2000,maxOffset);
        const batch=d?.features||[];
        features.push(...batch);
        if(batch.length<2000)break;
      }
      return{type:'FeatureCollection',features};
    }

    async _refreshReference(force=false){
      if(!this.referenceEnabled)return;
      const b=this.map.getBounds();
      const key=[this.map.getZoom(),b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map((v,i)=>i?Number(v).toFixed(1):v).join(',');
      if(!force&&key===this._referenceKey)return;
      this._referenceKey=key;
      const simplify=this._referenceSimplify();
      try{
        const [states,counties]=await Promise.all([
          this._fetchPagedLayer(3,b,simplify,1),
          this._fetchPagedLayer(2,b,simplify,3)
        ]);
        if(!this.referenceEnabled)return;
        this.stateLayer.clearLayers();this.stateLayer.addData(states);
        this.countyLayer.clearLayers();this.countyLayer.addData(counties);
      }catch(e){console.warn('State/county reference layer skipped/failed',e)}
    }

    async _loadAllCwas(){
      if(this._allCwasLoaded)return;
      const q=new URLSearchParams({
        where:'1=1',outFields:'cwa',returnGeometry:'true',outSR:'4326',maxAllowableOffset:'.02',geometryPrecision:'4',f:'geojson'
      });
      try{
        const d=await fetchJsonWithTimeout(`${REF_FS}/1/query?${q.toString()}`,7000);
        this.allCwaLayer.clearLayers();this.allCwaLayer.addData(d);this._allCwasLoaded=true;
      }catch(e){console.warn('All-CWA layer skipped/failed',e)}
    }

    async setAllCwaVisible(show){
      this.allCwaEnabled=show;
      if(show){await this._loadAllCwas();if(this.allCwaEnabled&&!this.map.hasLayer(this.allCwaLayer))this.allCwaLayer.addTo(this.map)}
      else if(this.map.hasLayer(this.allCwaLayer))this.map.removeLayer(this.allCwaLayer);
    }

    setReferenceVisible(show){
      this.referenceEnabled=show;
      if(show){if(!this.map.hasLayer(this.referenceLayer))this.referenceLayer.addTo(this.map);this._refreshReference(true)}
      else if(this.map.hasLayer(this.referenceLayer))this.map.removeLayer(this.referenceLayer);
    }

    showConus(center){this.map.setView([center.lat,center.lon],4)}
    showLocal(bounds){this.map.fitBounds(bounds,{padding:[24,24],maxZoom:7})}

    setMosaic(dataUrl,bounds,visible=true){
      if(this.mosaic)this.map.removeLayer(this.mosaic);
      this.mosaic=L.imageOverlay(dataUrl,bounds,{opacity:1,interactive:false,pane:'beamPane',className:'beam-raster'});
      if(visible)this.mosaic.addTo(this.map);
    }
    setMosaicVisible(show){if(!this.mosaic)return;if(show&&!this.map.hasLayer(this.mosaic))this.mosaic.addTo(this.map);if(!show&&this.map.hasLayer(this.mosaic))this.map.removeLayer(this.mosaic)}

    setSites(radars,show=true){
      this.siteLayer.clearLayers();
      this.siteMarkers.clear();
      for(const r of radars){
        const selected=r.id===this.selectedRadarId;
        const m=L.circleMarker([r.lat,r.lon],{
          pane:'markerPane',
          radius:selected?8:5.5,
          color:selected?'#ffe66d':'#ffffff',
          weight:selected?3:2,
          fillColor:r.color,
          fillOpacity:1,
          opacity:1
        });
        m.bindTooltip(`<strong>${r.id}</strong><br>${r.name||''}<br>${r.network||''}<br>${r.lowest_tilt_deg.toFixed(1)}° • ${r.range_nm} nmi`,{direction:'top'});
        m.on('click',evt=>{
          L.DomEvent.stopPropagation(evt);
          if(this.radarSelectHandler)this.radarSelectHandler(r);
        });
        m.addTo(this.siteLayer);
        this.siteMarkers.set(r.id,m);
      }
      this.setSitesVisible(show);
    }

    setRadarSelectHandler(handler){this.radarSelectHandler=typeof handler==='function'?handler:null}

    setSelectedRadar(id){
      this.selectedRadarId=id||null;
      let selectedMarker=null;
      for(const [rid,m] of this.siteMarkers.entries()){
        const selected=rid===this.selectedRadarId;
        m.setRadius(selected?8:5.5);
        m.setStyle({
          color:selected?'#ffe66d':'#ffffff',
          weight:selected?3:2
        });
        if(selected)selectedMarker=m;
      }

      if(this.selectedRadarPulse&&this.map.hasLayer(this.selectedRadarPulse)){
        this.map.removeLayer(this.selectedRadarPulse);
      }
      this.selectedRadarPulse=null;

      if(selectedMarker){
        const icon=L.divIcon({
          className:'',
          html:'<div class="radar-pulse-icon"><div class="radar-pulse-ring radar-pulse-ring-a"></div><div class="radar-pulse-ring radar-pulse-ring-b"></div></div>',
          iconSize:[72,72],
          iconAnchor:[36,36]
        });
        this.selectedRadarPulse=L.marker(selectedMarker.getLatLng(),{
          pane:'toolPane',
          icon,
          interactive:false,
          keyboard:false
        }).addTo(this.map);
      }
    }

    setTarget(latlng,color='#ff2d2d'){
      const icon=L.divIcon({
        className:'',
        html:`<div class="strategy-target-icon" style="--target-color:${color}"><div class="strategy-target-pulse"></div><div class="strategy-target-ring"></div></div>`,
        iconSize:[34,34],
        iconAnchor:[17,17]
      });
      if(!this.targetMarker){
        this.targetMarker=L.marker(latlng,{pane:'toolPane',icon,interactive:false}).addTo(this.map);
      }else{
        this.targetMarker.setLatLng(latlng);
        this.targetMarker.setIcon(icon);
      }
    }

    clearTarget(){
      if(this.targetMarker&&this.map.hasLayer(this.targetMarker))this.map.removeLayer(this.targetMarker);
      this.targetMarker=null;
    }

    setSitesVisible(show){if(show&&!this.map.hasLayer(this.siteLayer))this.siteLayer.addTo(this.map);if(!show&&this.map.hasLayer(this.siteLayer))this.map.removeLayer(this.siteLayer)}

    async setMrmsVisible(show){
      this.mrmsEnabled=show;
      if(show){
        await this._checkMrmsForUpdate(true);
        clearInterval(this._mrmsTimer);
        // Poll much faster than the source cadence so a newly published
        // 5-minute MRMS frame appears promptly even if the map is stationary.
        this._mrmsTimer=setInterval(()=>this._checkMrmsForUpdate(false),45000);
      }else{
        clearInterval(this._mrmsTimer);this._mrmsTimer=null;
        this._mrmsLatestTime=null;
        this._mrmsCheckInFlight=false;
        if(this.mrmsLayer&&this.map.hasLayer(this.mrmsLayer))this.map.removeLayer(this.mrmsLayer);
        this.mrmsLayer=null;
      }
    }

    async _checkMrmsForUpdate(force=false){
      if(!this.mrmsEnabled||this._mrmsCheckInFlight)return;
      this._mrmsCheckInFlight=true;
      try{
        const meta=await fetchJsonWithTimeout(`${MRMS_IMAGE_SERVICE}?f=pjson&_=${Date.now()}`,7000);
        const extent=meta?.timeInfo?.timeExtent;
        const latest=Array.isArray(extent)&&Number.isFinite(Number(extent[1]))?Number(extent[1]):null;
        if(force||latest==null||latest!==this._mrmsLatestTime){
          this._mrmsLatestTime=latest;
          this._refreshMrms(latest);
        }
      }catch(e){
        console.warn('MRMS latest-time check failed; refreshing image directly',e);
        if(force||!this.mrmsLayer)this._refreshMrms(null);
      }finally{
        this._mrmsCheckInFlight=false;
      }
    }

    _refreshMrms(latestTime=null){
      if(!this.mrmsEnabled)return;
      const b=this.map.getBounds(),size=this.map.getSize();
      const width=Math.max(400,Math.min(1600,Math.round(size.x)));
      const height=Math.max(300,Math.min(1400,Math.round(size.y)));
      const bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',');
      const stamp=Date.now();
      const timeArg=Number.isFinite(Number(latestTime))?`&time=${encodeURIComponent(String(latestTime))}`:'';
      const urls=[
        `${MRMS_IMAGE_EXPORT}?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=png32&transparent=true&f=image${timeArg}&_=${stamp}`,
        `${MRMS_MAP_EXPORT}?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=${width},${height}&layers=show%3A3&format=png32&transparent=true&f=image&_=${stamp}`
      ];

      const tryUrl=(index)=>{
        if(!this.mrmsEnabled||index>=urls.length)return;
        const next=L.imageOverlay(urls[index],b,{opacity:.66,interactive:false,pane:'mrmsPane'});
        next.once('load',()=>{
          if(!this.mrmsEnabled){
            if(this.map.hasLayer(next))this.map.removeLayer(next);
            return;
          }
          if(this.mrmsLayer&&this.mrmsLayer!==next&&this.map.hasLayer(this.mrmsLayer))this.map.removeLayer(this.mrmsLayer);
          this.mrmsLayer=next;
        });
        next.once('error',()=>{
          if(this.map.hasLayer(next))this.map.removeLayer(next);
          console.warn(`MRMS source ${index+1} failed; trying fallback`);
          tryUrl(index+1);
        });
        next.addTo(this.map);
      };
      tryUrl(0);
    }

    async setWarningsVisible(show){
      this.warningEnabled=show;
      if(show){
        if(!this.map.hasLayer(this.warningLayer))this.warningLayer.addTo(this.map);
        await this._refreshWarnings(true);
        clearInterval(this._warningInterval);
        this._warningInterval=setInterval(()=>this._refreshWarnings(true),300000);
      }else{
        clearInterval(this._warningInterval);this._warningInterval=null;
        this.warningLayer.clearLayers();
        if(this.map.hasLayer(this.warningLayer))this.map.removeLayer(this.warningLayer);
      }
    }
    _maybeRefreshWarnings(force=false){clearTimeout(this._warningTimer);this._warningTimer=setTimeout(()=>this._refreshWarnings(force),220)}
    async _refreshWarnings(force=false){
      if(!this.warningEnabled)return;
      const b=this.map.getBounds();const key=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(1)).join(',');
      if(!force&&key===this._warningKey)return;this._warningKey=key;
      const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const q=new URLSearchParams({
        where:'1=1',
        geometry:geom,
        geometryType:'esriGeometryEnvelope',
        inSR:'4326',
        spatialRel:'esriSpatialRelIntersects',
        outFields:'prod_type,phenom,sig,wfo,event,expiration',
        returnGeometry:'true',
        outSR:'4326',
        geometryPrecision:'5',
        resultRecordCount:'4000',
        f:'geojson'
      });
      try{
        const d=await fetchJsonWithTimeout(`${WARN_BASE}/query?${q.toString()}`,8000);
        if(!this.warningEnabled)return;
        this.warningLayer.clearLayers();
        this.warningLayer.addData(d);
      }catch(e){console.warn('Warning polygons skipped/failed',e)}
    }
  }
  window.RadarMap=RadarMap;
})();

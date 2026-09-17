(function(){
  const REF_FS='https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/FeatureServer';
  const WARN_BASE='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/FeatureServer/0';
  const MRMS_EXPORT='https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';

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

      this.map.createPane('mrmsPane');this.map.getPane('mrmsPane').style.zIndex=220;this.map.getPane('mrmsPane').style.pointerEvents='none';
      this.map.createPane('beamPane');this.map.getPane('beamPane').style.zIndex=240;this.map.getPane('beamPane').style.pointerEvents='none';
      this.map.createPane('referencePane');this.map.getPane('referencePane').style.zIndex=420;this.map.getPane('referencePane').style.pointerEvents='none';
      this.map.createPane('cwaPane');this.map.getPane('cwaPane').style.zIndex=430;this.map.getPane('cwaPane').style.pointerEvents='none';
      this.map.createPane('warningPane');this.map.getPane('warningPane').style.zIndex=460;

      this.baseLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        maxZoom:18,attribution:'&copy; OpenStreetMap contributors',className:'dark-osm'
      }).addTo(this.map);

      this.stateLayer=L.geoJSON(null,{pane:'referencePane',style:{color:'#ffffff',weight:1.25,opacity:.88,fillOpacity:0},interactive:false});
      this.countyLayer=L.geoJSON(null,{pane:'referencePane',style:{color:'#ffffff',weight:.55,opacity:.52,fillOpacity:0},interactive:false});
      this.referenceLayer=L.layerGroup([this.stateLayer,this.countyLayer]).addTo(this.map);
      this.allCwaLayer=L.geoJSON(null,{pane:'cwaPane',style:{color:'#ff3b30',weight:1.5,opacity:.92,fillOpacity:0},interactive:false});

      this.map.setView([37.8,-96.5],4);
      this.mosaic=null;this.mrmsLayer=null;this.siteLayer=L.layerGroup().addTo(this.map);
      this.warningLayer=L.geoJSON(null,{
        pane:'warningPane',style:warningStyle,
        onEachFeature:(feature,layer)=>{const p=feature.properties||{};const label=p.prod_type||`${p.phenom||''}.${p.sig||''}`;layer.bindTooltip(`<strong>${label}</strong>${p.wfo?`<br>WFO ${p.wfo}`:''}`,{sticky:true})}
      });

      this.referenceEnabled=true;this.allCwaEnabled=false;this.warningEnabled=false;this.mrmsEnabled=false;
      this._warningTimer=null;this._mrmsTimer=null;this._referenceTimer=null;this._warningKey='';this._referenceKey='';this._allCwasLoaded=false;
      this.map.on('moveend',()=>{
        if(this.referenceEnabled)this._scheduleReferenceRefresh();
        if(this.warningEnabled)this._maybeRefreshWarnings();
        if(this.mrmsEnabled)this._refreshMrms();
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
      for(const r of radars){
        const m=L.circleMarker([r.lat,r.lon],{pane:'markerPane',radius:5.5,color:'#ffffff',weight:2,fillColor:r.color,fillOpacity:1,opacity:1});
        m.bindTooltip(`<strong>${r.id}</strong><br>${r.name||''}<br>${r.lowest_tilt_deg.toFixed(1)}° • ${r.range_nm} nmi`,{direction:'top'});m.addTo(this.siteLayer);
      }
      this.setSitesVisible(show);
    }
    setSitesVisible(show){if(show&&!this.map.hasLayer(this.siteLayer))this.siteLayer.addTo(this.map);if(!show&&this.map.hasLayer(this.siteLayer))this.map.removeLayer(this.siteLayer)}

    async setMrmsVisible(show){
      this.mrmsEnabled=show;
      if(show){this._refreshMrms();clearInterval(this._mrmsTimer);this._mrmsTimer=setInterval(()=>this._refreshMrms(),300000)}
      else{clearInterval(this._mrmsTimer);this._mrmsTimer=null;if(this.mrmsLayer){this.map.removeLayer(this.mrmsLayer);this.mrmsLayer=null}}
    }
    _refreshMrms(){
      if(!this.mrmsEnabled)return;
      const b=this.map.getBounds(),size=this.map.getSize();
      const width=Math.max(400,Math.min(1400,Math.round(size.x))),height=Math.max(300,Math.min(1200,Math.round(size.y)));
      const bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',');
      const url=`${MRMS_EXPORT}?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=png32&transparent=true&f=image&_=${Date.now()}`;
      const next=L.imageOverlay(url,b,{opacity:.58,interactive:false,pane:'mrmsPane'});
      next.once('load',()=>{if(this.mrmsLayer&&this.mrmsLayer!==next&&this.map.hasLayer(this.mrmsLayer))this.map.removeLayer(this.mrmsLayer);this.mrmsLayer=next});
      next.addTo(this.map);if(!this.mrmsLayer)this.mrmsLayer=next;
    }

    async setWarningsVisible(show){
      this.warningEnabled=show;
      if(show){if(!this.map.hasLayer(this.warningLayer))this.warningLayer.addTo(this.map);await this._refreshWarnings(true)}
      else{this.warningLayer.clearLayers();if(this.map.hasLayer(this.warningLayer))this.map.removeLayer(this.warningLayer)}
    }
    _maybeRefreshWarnings(force=false){clearTimeout(this._warningTimer);this._warningTimer=setTimeout(()=>this._refreshWarnings(force),220)}
    async _refreshWarnings(force=false){
      if(!this.warningEnabled)return;
      const b=this.map.getBounds();const key=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(1)).join(',');
      if(!force&&key===this._warningKey)return;this._warningKey=key;
      const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const u=`${WARN_BASE}/query?where=1%3D1&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=prod_type,phenom,sig,wfo,event,expiration&returnGeometry=true&outSR=4326&f=geojson`;
      try{const d=await fetchJsonWithTimeout(u,6500);if(!this.warningEnabled)return;this.warningLayer.clearLayers();this.warningLayer.addData(d)}catch(e){console.warn('Warning polygons skipped/failed',e)}
    }
  }
  window.RadarMap=RadarMap;
})();

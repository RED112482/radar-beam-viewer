(function(){
  const REF_BASE='https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/FeatureServer';
  const WARN_BASE='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/FeatureServer/0';
  const MRMS_EXPORT='https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';

  async function fetchJsonWithTimeout(url,timeoutMs=7000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await fetch(url,{signal:controller.signal,cache:'no-cache'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }finally{
      clearTimeout(timer);
    }
  }

  function warningStyle(feature){
    const p=feature?.properties||{};
    const key=`${p.phenom||''},${p.sig||''}`;
    const colors={
      'TO,W':'#ff3b30',
      'SV,W':'#ffe600',
      'FF,W':'#4caf50',
      'MA,W':'#ff9f0a',
      'SQ,W':'#d62da0'
    };
    const color=colors[key]||'#ff5ea8';
    return{color,weight:2.2,opacity:.95,fillColor:color,fillOpacity:.10};
  }

  class RadarMap{
    constructor(divId){
      this.map=L.map(divId,{zoomControl:true,preferCanvas:true,minZoom:3});

      this.map.createPane('mrmsPane');
      this.map.getPane('mrmsPane').style.zIndex=220;
      this.map.getPane('mrmsPane').style.pointerEvents='none';

      this.map.createPane('beamPane');
      this.map.getPane('beamPane').style.zIndex=240;
      this.map.getPane('beamPane').style.pointerEvents='none';

      this.map.createPane('referencePane');
      this.map.getPane('referencePane').style.zIndex=420;
      this.map.getPane('referencePane').style.pointerEvents='none';

      this.map.createPane('warningPane');
      this.map.getPane('warningPane').style.zIndex=460;

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
        maxZoom:18,
        subdomains:'abcd',
        attribution:'&copy; OpenStreetMap contributors &copy; CARTO'
      }).addTo(this.map);

      this.map.setView([37.8,-96.5],4);

      this.mosaic=null;
      this.mrmsLayer=null;
      this.siteLayer=L.layerGroup().addTo(this.map);
      this.cwaLayer=L.geoJSON(null,{
        pane:'referencePane',
        style:{color:'#57e3ff',weight:2.4,opacity:1,fillOpacity:0}
      }).addTo(this.map);
      this.stateLayer=L.geoJSON(null,{
        pane:'referencePane',
        style:{color:'#ffffff',weight:1.25,opacity:.82,fillOpacity:0}
      }).addTo(this.map);
      this.countyLayer=L.geoJSON(null,{
        pane:'referencePane',
        style:{color:'#ffffff',weight:.55,opacity:.48,fillOpacity:0}
      }).addTo(this.map);
      this.allCwaLayer=L.geoJSON(null,{
        pane:'referencePane',
        style:{color:'#dbe8f5',weight:.75,opacity:.62,fillOpacity:0}
      });
      this.warningLayer=L.geoJSON(null,{
        pane:'warningPane',
        style:warningStyle,
        onEachFeature:(feature,layer)=>{
          const p=feature.properties||{};
          const label=p.prod_type||`${p.phenom||''}.${p.sig||''}`;
          layer.bindTooltip(`<strong>${label}</strong>${p.wfo?`<br>WFO ${p.wfo}`:''}`,{sticky:true});
        }
      });

      this.countyEnabled=true;
      this.allCwaEnabled=false;
      this.warningEnabled=false;
      this.mrmsEnabled=false;
      this._countyTimer=null;
      this._warningTimer=null;
      this._mrmsTimer=null;
      this._countyKey='';
      this._warningKey='';

      this.map.on('moveend',()=>{
        this._maybeRefreshCounties();
        if(this.warningEnabled)this._maybeRefreshWarnings();
        if(this.mrmsEnabled)this._refreshMrms();
      });
    }

    async initReferenceLayers(){
      try{
        const u=`${REF_BASE}/3/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
        const d=await fetchJsonWithTimeout(u,6000);
        this.stateLayer.addData(d);
      }catch(e){
        console.warn('State layer skipped/failed',e);
      }
    }

    async setOfficeCwa(wfo){
      this.cwaLayer.clearLayers();
      try{
        const u=`${REF_BASE}/1/query?where=${encodeURIComponent(`cwa='${wfo}'`)}&outFields=cwa&returnGeometry=true&outSR=4326&f=geojson`;
        const d=await fetchJsonWithTimeout(u,6000);
        this.cwaLayer.addData(d);
        return this.cwaLayer.getBounds().isValid()?this.cwaLayer.getBounds():null;
      }catch(e){
        console.warn('CWA layer skipped/failed',e);
        return null;
      }
    }

    async loadAllCwas(){
      if(this.allCwaLayer.getLayers().length)return;
      try{
        const u=`${REF_BASE}/1/query?where=1%3D1&outFields=cwa&returnGeometry=true&outSR=4326&f=geojson`;
        const d=await fetchJsonWithTimeout(u,7000);
        this.allCwaLayer.addData(d);
      }catch(e){
        console.warn('All-CWA layer skipped/failed',e);
      }
    }

    async setAllCwaVisible(show){
      this.allCwaEnabled=show;
      if(show){
        await this.loadAllCwas();
        if(this.allCwaEnabled&&!this.map.hasLayer(this.allCwaLayer))this.allCwaLayer.addTo(this.map);
      }else if(this.map.hasLayer(this.allCwaLayer)){
        this.map.removeLayer(this.allCwaLayer);
      }
    }

    showConus(center){
      this.map.setView([center.lat,center.lon],4);
    }

    showLocal(bounds){
      this.map.fitBounds(bounds,{padding:[24,24],maxZoom:7});
    }

    setMosaic(dataUrl,bounds,visible=true){
      if(this.mosaic)this.map.removeLayer(this.mosaic);
      this.mosaic=L.imageOverlay(dataUrl,bounds,{
        opacity:1,
        interactive:false,
        pane:'beamPane'
      });
      if(visible)this.mosaic.addTo(this.map);
    }

    setMosaicVisible(show){
      if(!this.mosaic)return;
      if(show&&!this.map.hasLayer(this.mosaic))this.mosaic.addTo(this.map);
      if(!show&&this.map.hasLayer(this.mosaic))this.map.removeLayer(this.mosaic);
    }

    setSites(radars,show=true){
      this.siteLayer.clearLayers();
      for(const r of radars){
        const m=L.circleMarker([r.lat,r.lon],{
          pane:'markerPane',
          radius:5.5,
          color:'#ffffff',
          weight:2,
          fillColor:r.color,
          fillOpacity:1,
          opacity:1
        });
        m.bindTooltip(
          `<strong>${r.id}</strong><br>${r.name||''}<br>${r.lowest_tilt_deg.toFixed(1)}° • ${r.range_nm} nmi`,
          {direction:'top'}
        );
        m.addTo(this.siteLayer);
      }
      this.setSitesVisible(show);
    }

    setSitesVisible(show){
      if(show&&!this.map.hasLayer(this.siteLayer))this.siteLayer.addTo(this.map);
      if(!show&&this.map.hasLayer(this.siteLayer))this.map.removeLayer(this.siteLayer);
    }

    setCwaVisible(show){
      if(show&&!this.map.hasLayer(this.cwaLayer))this.cwaLayer.addTo(this.map);
      if(!show&&this.map.hasLayer(this.cwaLayer))this.map.removeLayer(this.cwaLayer);
    }

    setStateVisible(show){
      if(show&&!this.map.hasLayer(this.stateLayer))this.stateLayer.addTo(this.map);
      if(!show&&this.map.hasLayer(this.stateLayer))this.map.removeLayer(this.stateLayer);
    }

    setCountyVisible(show){
      this.countyEnabled=show;
      if(!show)this.countyLayer.clearLayers();
      else this._maybeRefreshCounties(true);
    }

    async setMrmsVisible(show){
      this.mrmsEnabled=show;
      if(show){
        this._refreshMrms();
        clearInterval(this._mrmsTimer);
        this._mrmsTimer=setInterval(()=>this._refreshMrms(),300000);
      }else{
        clearInterval(this._mrmsTimer);
        this._mrmsTimer=null;
        if(this.mrmsLayer){
          this.map.removeLayer(this.mrmsLayer);
          this.mrmsLayer=null;
        }
      }
    }

    _refreshMrms(){
      if(!this.mrmsEnabled)return;
      const b=this.map.getBounds();
      const size=this.map.getSize();
      const width=Math.max(400,Math.min(1400,Math.round(size.x)));
      const height=Math.max(300,Math.min(1200,Math.round(size.y)));
      const bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',');
      const url=`${MRMS_EXPORT}?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=png32&transparent=true&f=image&_=${Date.now()}`;
      const next=L.imageOverlay(url,b,{
        opacity:.58,
        interactive:false,
        pane:'mrmsPane'
      });
      next.once('load',()=>{
        if(this.mrmsLayer&&this.mrmsLayer!==next&&this.map.hasLayer(this.mrmsLayer))this.map.removeLayer(this.mrmsLayer);
        this.mrmsLayer=next;
      });
      next.addTo(this.map);
      if(!this.mrmsLayer)this.mrmsLayer=next;
    }

    async setWarningsVisible(show){
      this.warningEnabled=show;
      if(show){
        if(!this.map.hasLayer(this.warningLayer))this.warningLayer.addTo(this.map);
        await this._refreshWarnings(true);
      }else{
        this.warningLayer.clearLayers();
        if(this.map.hasLayer(this.warningLayer))this.map.removeLayer(this.warningLayer);
      }
    }

    _maybeRefreshWarnings(force=false){
      clearTimeout(this._warningTimer);
      this._warningTimer=setTimeout(()=>this._refreshWarnings(force),220);
    }

    async _refreshWarnings(force=false){
      if(!this.warningEnabled)return;
      const b=this.map.getBounds();
      const key=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(1)).join(',');
      if(!force&&key===this._warningKey)return;
      this._warningKey=key;
      const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const u=`${WARN_BASE}/query?where=1%3D1&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=prod_type,phenom,sig,wfo,event,expiration&returnGeometry=true&outSR=4326&f=geojson`;
      try{
        const d=await fetchJsonWithTimeout(u,6500);
        if(!this.warningEnabled)return;
        this.warningLayer.clearLayers();
        this.warningLayer.addData(d);
      }catch(e){
        console.warn('Warning polygons skipped/failed',e);
      }
    }

    _maybeRefreshCounties(force=false){
      if(!this.countyEnabled||this.map.getZoom()<6){
        this.countyLayer.clearLayers();
        this._countyKey='';
        return;
      }
      clearTimeout(this._countyTimer);
      this._countyTimer=setTimeout(()=>this._refreshCounties(force),180);
    }

    async _refreshCounties(force=false){
      const b=this.map.getBounds();
      const key=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(1)).join(',');
      if(!force&&key===this._countyKey)return;
      this._countyKey=key;
      const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const u=`${REF_BASE}/2/query?where=1%3D1&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
      try{
        const d=await fetchJsonWithTimeout(u,6000);
        this.countyLayer.clearLayers();
        this.countyLayer.addData(d);
      }catch(e){
        console.warn('County layer skipped/failed',e);
      }
    }
  }

  window.RadarMap=RadarMap;
})();

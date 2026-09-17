(function(){
  const REF_BASE='https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/FeatureServer';

  async function fetchJsonWithTimeout(url, timeoutMs=7000){
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

  class RadarMap{
    constructor(divId){
      this.map=L.map(divId,{zoomControl:true,preferCanvas:true,minZoom:3});
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:16,attribution:'&copy; OpenStreetMap contributors'}).addTo(this.map);
      this.map.setView([37.8,-96.5],4);
      this.mosaic=null;
      this.siteLayer=L.layerGroup().addTo(this.map);
      this.cwaLayer=L.geoJSON(null,{style:{color:'#131a22',weight:2.2,fillOpacity:0}}).addTo(this.map);
      this.stateLayer=L.geoJSON(null,{style:{color:'#5c6672',weight:1.1,opacity:.75,fillOpacity:0}}).addTo(this.map);
      this.countyLayer=L.geoJSON(null,{style:{color:'#7c8794',weight:.6,opacity:.62,fillOpacity:0}}).addTo(this.map);
      this.allCwaLayer=L.geoJSON(null,{style:{color:'#5e6c7a',weight:.65,opacity:.5,fillOpacity:0}});
      this.countyEnabled=true;
      this._countyTimer=null;
      this._countyKey='';
      this.map.on('moveend',()=>this._maybeRefreshCounties());
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

    async showConus(center){
      this.loadAllCwas();
      if(!this.map.hasLayer(this.allCwaLayer))this.allCwaLayer.addTo(this.map);
      this.map.setView([center.lat,center.lon],4);
    }

    showLocal(bounds){
      if(this.map.hasLayer(this.allCwaLayer))this.map.removeLayer(this.allCwaLayer);
      this.map.fitBounds(bounds,{padding:[24,24],maxZoom:7});
    }

    setMosaic(dataUrl,bounds,visible=true){
      if(this.mosaic)this.map.removeLayer(this.mosaic);
      this.mosaic=L.imageOverlay(dataUrl,bounds,{opacity:1,interactive:false,zIndex:250});
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
        const m=L.circleMarker([r.lat,r.lon],{radius:5,color:'#fff',weight:2,fillColor:r.color,fillOpacity:1,opacity:1});
        m.bindTooltip(`<strong>${r.id}</strong><br>${r.name||''}<br>${r.lowest_tilt_deg.toFixed(1)}° • ${r.range_nm} nmi`,{direction:'top'});
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

    setCountyVisible(show){
      this.countyEnabled=show;
      if(!show)this.countyLayer.clearLayers();
      else this._maybeRefreshCounties(true);
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

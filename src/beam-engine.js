(function(){
  const EARTH_RADIUS_M=6371000;
  const EFFECTIVE_EARTH_M=EARTH_RADIUS_M*(4/3);
  const FT_PER_M=3.280839895;
  const M_PER_NM=1852;
  const MAX_MERCATOR_LAT=85.05112878;

  function toRad(v){return v*Math.PI/180}
  function mercatorY(latDeg){
    const lat=Math.max(-MAX_MERCATOR_LAT,Math.min(MAX_MERCATOR_LAT,latDeg));
    const phi=toRad(lat);
    return Math.log(Math.tan(Math.PI/4+phi/2));
  }
  function inverseMercatorY(y){
    return (2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;
  }

  function haversineMeters(lat1,lon1,lat2,lon2){
    const p1=toRad(lat1),p2=toRad(lat2),dp=p2-p1,dl=toRad(lon2-lon1);
    const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*EARTH_RADIUS_M*Math.asin(Math.min(1,Math.sqrt(a)));
  }

  function beamHeightFt(rangeM,tiltDeg){
    if(rangeM<=0)return 0;
    const theta=toRad(tiltDeg);
    const h=Math.sqrt(
      rangeM*rangeM+
      EFFECTIVE_EARTH_M*EFFECTIVE_EARTH_M+
      2*rangeM*EFFECTIVE_EARTH_M*Math.sin(theta)
    )-EFFECTIVE_EARTH_M;
    return h*FT_PER_M;
  }

  function radarValueAt(lat,lon,radar){
    const d=haversineMeters(lat,lon,radar.lat,radar.lon);
    if(d>radar.range_nm*M_PER_NM)return null;
    return beamHeightFt(d,radar.lowest_tilt_deg);
  }

  function bestRadarAt(lat,lon,radars){
    let best=null;
    for(const radar of radars){
      const d=haversineMeters(lat,lon,radar.lat,radar.lon);
      if(d>radar.range_nm*M_PER_NM)continue;
      const h=beamHeightFt(d,radar.lowest_tilt_deg);
      if(!best||h<best.height_ft)best={radar,height_ft:h,distance_nm:d/M_PER_NM};
    }
    return best;
  }

  function nearestRadarAt(lat,lon,radars){
    let nearest=null;
    for(const radar of radars){
      const d=haversineMeters(lat,lon,radar.lat,radar.lon);
      if(!nearest||d<nearest.distance_m)nearest={radar,distance_m:d,distance_nm:d/M_PER_NM};
    }
    return nearest;
  }

  function parseHex(hex){
    const h=hex.replace('#','');
    return[
      parseInt(h.slice(0,2),16),
      parseInt(h.slice(2,4),16),
      parseInt(h.slice(4,6),16)
    ];
  }

  function mixRgb(a,b,t){
    const q=Math.max(0,Math.min(1,t));
    return[
      Math.round(a[0]+(b[0]-a[0])*q),
      Math.round(a[1]+(b[1]-a[1])*q),
      Math.round(a[2]+(b[2]-a[2])*q)
    ];
  }

  // Preserve each radar's assigned hue while using brightness as a visual
  // proxy for beam height: low ARL = lighter, high ARL = darker.
  function heightShadedRgb(baseRgb,heightFt,maxHeightFt=18000){
    const t=Math.max(0,Math.min(1,heightFt/maxHeightFt));
    const curved=Math.pow(t,.72);
    if(curved<=.5){
      const towardWhite=((.5-curved)/.5)*.58;
      return mixRgb(baseRgb,[255,255,255],towardWhite);
    }
    const towardBlack=((curved-.5)/.5)*.48;
    return mixRgb(baseRgb,[0,0,0],towardBlack);
  }

  async function computeMosaic(bounds,radars,opts={}){
    const targetWidth=opts.width||620;
    const maxHeight=opts.maxHeight||520;
    const opacity=opts.opacity==null?.52:opts.opacity;
    const west=bounds.getWest(),east=bounds.getEast(),south=bounds.getSouth(),north=bounds.getNorth();
    const aspect=Math.max(.25,Math.min(4,(north-south)/Math.max(.001,east-west)));
    const width=targetWidth;
    const height=Math.max(180,Math.min(maxHeight,Math.round(width*aspect)));
    const count=width*height;
    const minHeight=new Float32Array(count);
    const winner=new Int16Array(count);
    minHeight.fill(Infinity);
    winner.fill(-1);

    const lonRads=new Float64Array(width);
    for(let x=0;x<width;x++)lonRads[x]=toRad(west+((x+.5)/width)*(east-west));

    // Leaflet stretches ImageOverlay rows linearly in Web Mercator, not
    // linearly in latitude. Generate the beam raster on that same row
    // geometry so displayed color cells and cursor samples line up exactly.
    const northMerc=mercatorY(north),southMerc=mercatorY(south);
    const latRads=new Float64Array(height),cosLats=new Float64Array(height);
    for(let y=0;y<height;y++){
      const my=northMerc-((y+.5)/height)*(northMerc-southMerc);
      latRads[y]=toRad(inverseMercatorY(my));
      cosLats[y]=Math.cos(latRads[y]);
    }

    for(let r=0;r<radars.length;r++){
      const radar=radars[r];
      const rLat=toRad(radar.lat),rLon=toRad(radar.lon),cosRLat=Math.cos(rLat);
      const maxRangeM=radar.range_nm*M_PER_NM;
      const lonSinSq=new Float64Array(width);
      for(let x=0;x<width;x++){
        const q=Math.sin((lonRads[x]-rLon)/2);
        lonSinSq[x]=q*q;
      }
      for(let y=0;y<height;y++){
        const p=Math.sin((latRads[y]-rLat)/2);
        const latTerm=p*p,cosProd=cosLats[y]*cosRLat,row=y*width;
        for(let x=0;x<width;x++){
          const a=Math.min(1,latTerm+cosProd*lonSinSq[x]);
          const d=2*EARTH_RADIUS_M*Math.asin(Math.sqrt(a));
          if(d>maxRangeM)continue;
          const h=beamHeightFt(d,radar.lowest_tilt_deg);
          const idx=row+x;
          if(h<minHeight[idx]){
            minHeight[idx]=h;
            winner[idx]=r;
          }
        }
      }

      // Anchor the radar-origin cell to exactly 0 ft ARL. This matches the
      // operational convention used by the earlier precomputed-grid builder.
      const x0=Math.floor(((radar.lon-west)/(east-west))*width);
      const radarMerc=mercatorY(radar.lat);
      const y0=Math.floor(((northMerc-radarMerc)/(northMerc-southMerc))*height);
      if(x0>=0&&x0<width&&y0>=0&&y0<height){
        const idx=y0*width+x0;
        if(0<minHeight[idx]){
          minHeight[idx]=0;
          winner[idx]=r;
        }
      }

      if(opts.onProgress)opts.onProgress((r+1)/radars.length,radar.id);
      await new Promise(resolve=>setTimeout(resolve,0));
    }

    const canvas=document.createElement('canvas');
    canvas.width=width;
    canvas.height=height;
    const ctx=canvas.getContext('2d');
    const image=ctx.createImageData(width,height);
    const colorCache=radars.map(r=>parseHex(r.color||'#3887be'));
    const alpha=Math.round(opacity*255);
    const shadeMaxFt=opts.shadeMaxFt||18000;

    for(let i=0;i<count;i++){
      const ri=winner[i];
      if(ri<0)continue;
      const[rr,gg,bb]=heightShadedRgb(colorCache[ri],minHeight[i],shadeMaxFt),p=i*4;
      image.data[p]=rr;
      image.data[p+1]=gg;
      image.data[p+2]=bb;
      image.data[p+3]=alpha;
    }
    ctx.putImageData(image,0,0);

    return{
      dataUrl:canvas.toDataURL('image/png'),
      width,height,minHeight,winner,radars,
      west,east,south,north
    };
  }

  // Read the exact cell used to draw the mosaic. This is intentionally
  // different from recomputing at the raw mouse coordinate: it guarantees
  // the hover radar/height agrees with the colored raster cell on screen.
  function sampleMosaic(result,lat,lon){
    if(!result)return null;
    const {west,east,south,north,width,height,winner,minHeight,radars}=result;
    if(lon<west||lon>east||lat<south||lat>north)return null;
    const northMerc=mercatorY(north),southMerc=mercatorY(south);
    const pointMerc=mercatorY(lat);
    let x=Math.floor(((lon-west)/(east-west))*width);
    let y=Math.floor(((northMerc-pointMerc)/(northMerc-southMerc))*height);
    x=Math.max(0,Math.min(width-1,x));
    y=Math.max(0,Math.min(height-1,y));
    const idx=y*width+x;
    const ri=winner[idx];
    if(ri<0||!Number.isFinite(minHeight[idx]))return null;
    const cellLon=west+((x+.5)/width)*(east-west);
    const cellMerc=northMerc-((y+.5)/height)*(northMerc-southMerc);
    const cellLat=inverseMercatorY(cellMerc);
    return{
      radar:radars[ri],
      height_ft:minHeight[idx],
      x,y,index:idx,
      cell_lat:cellLat,
      cell_lon:cellLon
    };
  }

  window.BeamEngine={
    beamHeightFt,
    radarValueAt,
    bestRadarAt,
    nearestRadarAt,
    haversineMeters,
    computeMosaic,
    sampleMosaic,
    heightShadedRgb
  };
})();

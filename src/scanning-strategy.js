(function(){
  const RISK_LABELS={
    TOR:"Tornadoes / Supercell / QLCS",
    HAIL:"Hail",
    RAIN:"Heavy Rain / Flooding",
    WIND:"Damaging Wind",
    MICRO:"Summer Microbursts",
    WINTER:"Winter / Sensitive",
    LAND:"Landspouts / Waterspouts"
  };

  const RISK_COLORS={
    TOR:"#ff2d2d",
    HAIL:"#39ff14",
    RAIN:"#0b6b2b",
    WIND:"#2f7bff",
    MICRO:"#ff9f1a",
    WINTER:"#00e5ff",
    LAND:"#ff4dff"
  };

  // Preserved from the user's Radar Scanning Strategy tool.
  const RULES={
    TOR:[
      {min:0,max:50,primary:[
        "Primary: VCP 212 + MRLE 4, 3, or 2",
        "(No MPDA with MRLE)"
      ]},
      {min:50,max:60,options:[
        {label:"Option A",lines:[
          "VCP 212 + MRLE 4, 3, or 2",
          "(No MPDA with MRLE)"
        ]},
        {label:"Option B",lines:[
          "VCP 212 + SAILS 2 or 3",
          "If velocity quality is limiting: VCP 212 + SAILS 2–3 + Add MPDA"
        ]}
      ]},
      {min:60,max:1000,primary:[
        "Primary: VCP 212 + SAILS 2 or 3",
        "If velocity integrity is the fight: VCP 212 + SAILS 2–3 + Add MPDA",
        "If it’s a broad, mature QLCS / widespread high-V and you want MPDA “always on”: VCP 112 + SAILS 1 (MPDA built-in; note SAILS is limited to 1 in 112)"
      ]}
    ],
    HAIL:[
      {min:0,max:80,primary:[
        "Primary: VCP 212 + SAILS 1",
        "If velocity integrity matters (rotating storms / meso trends): VCP 212 + SAILS 1 + Add MPDA"
      ]},
      {min:80,max:100,options:[
        {label:"Option A",lines:[
          "VCP 212 + SAILS 1",
          "If velocity quality is limiting: Add MPDA"
        ]},
        {label:"Option B",lines:[
          "VCP 212 + MRLE 4, 3, or 2 (no MPDA)"
        ]}
      ]},
      {min:100,max:1000,primary:[
        "Primary: VCP 212 + MRLE 4, 3, or 2",
        "(No MPDA)"
      ]}
    ],
    RAIN:[
      {min:0,max:1000,primary:[
        "Primary (widespread heavy rain / training / stratiform-dominant): VCP 215 + MRLE 3–4",
        "If deep convection is mixed in / severe possible: VCP 212 + MRLE 3–4",
        "If you need more frequent low-level snapshots for short-fuse flash flood messaging: VCP 212 + SAILS 1",
        "If embedded meso / line-end vortices / RIJ diagnostics matter: VCP 212 + SAILS + Add MPDA (only if you choose SAILS)"
      ]}
    ],
    WIND:[
      {min:0,max:60,options:[
        {label:"Option A (cold pool / near-sfc wind evolution)",lines:[
          "VCP 212 + SAILS 2–3",
          "If velocity quality is limiting (noisy/dealiased): Add MPDA"
        ]},
        {label:"Option B (RIJ / structure interrogation)",lines:[
          "VCP 212 + MRLE 3–4 (no MPDA)"
        ]}
      ]},
      {min:60,max:1000,primary:[
        "Primary: VCP 212 + SAILS 2–3",
        "If it’s a mature/fast QLCS and velocity integrity is critical: Add MPDA",
        "If it’s truly widespread high-V with velocity integrity as the mission: VCP 112 + SAILS 1"
      ]}
    ],
    MICRO:[
      {min:0,max:40,options:[
        {label:"Option A",lines:["VCP 212 + SAILS 1"]},
        {label:"Option B",lines:[
          "VCP 212 + SAILS 2–3 (better for pulse storms / fast collapse signatures)",
          "If you’re specifically fighting velocity quality (less common for microbursts, but possible in noisy regimes): Add MPDA (only with SAILS)"
        ]}
      ]},
      {min:40,max:80,primary:[
        "Primary: VCP 212 + SAILS 1",
        "If you need more low-level cadence: VCP 212 + SAILS 2"
      ]},
      {min:80,max:1000,primary:[
        "Primary: VCP 212 + MRLE 2–4 (no MPDA)"
      ]}
    ],
    WINTER:[
      {min:0,max:1000,primary:[
        "Primary (most sensitive long-pulse clear-air/light stratiform/snow): VCP 34 + SAILS 1",
        "Alternative (low-level overlap, still sensitive): VCP 35 + SAILS 1"
      ]}
    ],
    LAND:[
      {min:0,max:10,primary:[
        "Primary: VCP 212 + MRLE 4, 3, or 2 (no MPDA)"
      ]},
      {min:10,max:20,options:[
        {label:"Option A",lines:[
          "VCP 212 + MRLE 4, 3, or 2 (no MPDA)"
        ]},
        {label:"Option B",lines:[
          "VCP 212 + SAILS 2 or 3",
          "If velocity quality is the limiter and you chose SAILS: Add MPDA"
        ]}
      ]},
      {min:20,max:1000,primary:[
        "Primary: VCP 212 + SAILS 2 or 3",
        "If velocity integrity becomes important and you’re using SAILS: Add MPDA"
      ]}
    ]
  };

  const QUICK_REFERENCE=[
    {term:"SAILS",text:"Adds supplemental lowest-elevation scans within a volume. VCP 212 supports up to 3; VCPs 34/35/112/215 support 1."},
    {term:"MRLE",text:"Rescans the lowest 2–4 elevations midway through a volume. Do not use with SAILS."},
    {term:"MPDA",text:"Multi-PRF velocity dealiasing. Built into VCP 112; can be added to 212/215. Not used with MRLE."},
    {term:"VCP 212",text:"Fast precipitation VCP for rapidly evolving convection and severe storms."},
    {term:"VCP 215",text:"General precipitation VCP with strong vertical coverage and reflectivity quality."},
    {term:"VCP 112",text:"Precipitation VCP for widespread high velocities; MPDA is built in."},
    {term:"VCP 34 / 35",text:"Clear-air/light-precipitation VCPs; 34 emphasizes sensitivity, while 35 is faster/default clear-air."}
  ];

  function pickSegment(riskKey,nm){
    const segs=RULES[riskKey]||[];
    if(!segs.length)return null;
    for(const seg of segs)if(nm>=seg.min&&nm<seg.max)return seg;
    return segs[segs.length-1];
  }

  function recommendation(riskKey,nm){
    return{riskKey,label:RISK_LABELS[riskKey]||riskKey,distance_nm:nm,segment:pickSegment(riskKey,nm)};
  }

  window.ScanningStrategy={
    RULES,RISK_LABELS,RISK_COLORS,QUICK_REFERENCE,pickSegment,recommendation
  };
})();

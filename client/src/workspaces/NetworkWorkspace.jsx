import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Crosshair,
  CloudRain,
  Sun,
  Siren,
  Clock,
  CheckCircle2,
  Trash2,
  ChevronRight,
} from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import {
  ZONE_LIST,
  zoneLabel,
  controllerLabel,
  classifyJunctionStatus,
  classifyLinkSpeed,
  useTheme,
  fmtNum,
  fmtInt,
  fmtSigned,
  fmtClockTime,
} from '../utils/semantics';
import { StatusGlyph, StatusPill } from '../components/StatusPill';
import { JunctionDetailView } from '../components/JunctionDetailView';
import { getCorridorRoadWaypoints } from '../utils/roadWaypoints';
import { DEFAULT_JUNCTIONS_META } from '../shared/wire.js';

const BENGALURU_CENTER = [12.976, 77.622];
const DEFAULT_ZOOM = 12;
const BENGALURU_BOUNDS = [
  [12.905, 77.528],
  [13.048, 77.716],
];

const QUICK_SCENARIOS = [
  { id: 'pm-peak', label: 'PM Peak (18:30 IST)' },
  { id: 'am-peak', label: 'AM Peak (09:00 IST)' },
  { id: 'pm-stalled-silkboard', label: 'PM Peak + Silk Board Stall' },
  { id: 'monsoon-pm-peak', label: 'Monsoon PM Peak' },
  { id: 'ambulance-corridor', label: 'Ambulance Green Corridor' },
];

const METRIC_KEY_LABELS = {
  avgSpeedKmph: 'Avg Speed (km/h)',
  maxQueueLengthM: 'Max Queue (m)',
  degreeOfSaturation: 'Saturation (v/c)',
  congestionScore: 'Congestion Score',
  totalFlowVehiclesPerMin: 'Total Flow (veh/m)',
  stalledVehicle: 'Stalled Vehicle',
  ambulancePreemption: 'Emergency Responder',
};

function humanizeAlertText(text) {
  if (!text) return '';
  let out = String(text);
  for (const [k, label] of Object.entries(METRIC_KEY_LABELS)) {
    out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), label);
  }
  return out;
}

function buildMarkerSvg(statusInfo, isSelected, isDark, { maxQueueM = 0, activeDir = null, inIntergreen = false } = {}) {
  const discFill = isDark ? '#0e1116' : '#ffffff';
  const qNorm = Math.max(0, Math.min(1, Number(maxQueueM || 0) / 140));
  const ringR = 9.5 + qNorm * 5.0;
  const stroke = isSelected ? (isDark ? '#ffffff' : '#1d4ed8') : statusInfo.ringHex;
  const strokeW = isSelected ? Math.max(2.6, 1.8 + qNorm * 2.0) : 1.6 + qNorm * 2.1;

  let innerGlyph = `<circle cx="19" cy="19" r="3.8" fill="${statusInfo.hex}" />`;
  if (statusInfo.shape === 'triangle') {
    innerGlyph = `<polygon points="19,14 24,23 14,23" fill="${statusInfo.hex}" />`;
  } else if (statusInfo.shape === 'octagon') {
    innerGlyph = `<polygon points="16.5,14 21.5,14 24,16.5 24,21.5 21.5,24 16.5,24 14,21.5 14,16.5" fill="${statusInfo.hex}" />`;
  } else if (statusInfo.shape === 'cross') {
    innerGlyph = `<path d="M17.5 14h3v3.5H24v3h-3.5V24h-3v-3.5H14v-3h3.5z" fill="${statusInfo.hex}" />`;
  }

  let phasePip = '';
  const rimOffsets = {
    N: [19, 19 - ringR],
    E: [19 + ringR, 19],
    S: [19, 19 + ringR],
    W: [19 - ringR, 19],
  };
  if (activeDir && rimOffsets[activeDir]) {
    const [px, py] = rimOffsets[activeDir];
    const phaseColor = inIntergreen ? '#f59e0b' : isDark ? '#22c55e' : '#16a34a';
    phasePip = `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.7" fill="${phaseColor}" stroke="${discFill}" stroke-width="1.2" />`;
  }

  const selectionHalo = isSelected
    ? `<circle cx="19" cy="19" r="${(ringR + 2.8).toFixed(1)}" fill="none" stroke="${isDark ? '#38bdf8' : '#1d4ed8'}" stroke-width="1.3" stroke-dasharray="3 2" />`
    : '';

  return `
    <svg width="36" height="36" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg">
      ${selectionHalo}
      <circle cx="19" cy="19" r="${ringR.toFixed(1)}" fill="${discFill}" fill-opacity="0.92" stroke="${stroke}" stroke-width="${strokeW.toFixed(2)}" />
      ${innerGlyph}
      ${phasePip}
    </svg>
  `;
}

function DualLineSparkline({ series, isDark }) {
  if (!series || series.length < 2) {
    return (
      <div className="h-16 flex items-center justify-center text-[11px] text-ink-muted console-inset">
        Collecting twin samples for trajectory...
      </div>
    );
  }

  const width = 320;
  const height = 64;
  const padX = 4;
  const padY = 6;
  const vals = series.flatMap((p) => [p.liveAvg, p.baseAvg]);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(0.5, maxV - minV);

  const toX = (idx) => padX + (idx / Math.max(1, series.length - 1)) * (width - padX * 2);
  const toY = (v) => padY + (1 - (v - minV) / span) * (height - padY * 2);

  const livePts = series.map((p, i) => `${toX(i).toFixed(1)},${toY(p.liveAvg).toFixed(1)}`).join(' ');
  const basePts = series.map((p, i) => `${toX(i).toFixed(1)},${toY(p.baseAvg).toFixed(1)}`).join(' ');

  const liveStroke = isDark ? '#60a5fa' : '#1d4ed8';
  const baseStroke = isDark ? '#94a3b8' : '#475569';

  return (
    <div className="console-inset p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-14 overflow-visible"
        role="img"
        aria-label="Counterfactual delay comparison trend: adaptive vs Webster fixed-time baseline"
      >
        <polyline
          fill="none"
          stroke={baseStroke}
          strokeWidth="2"
          strokeDasharray="5 3"
          points={basePts}
        />
        <polyline
          fill="none"
          stroke={liveStroke}
          strokeWidth="2"
          points={livePts}
        />
      </svg>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-ink-muted">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-accent inline-block" />
            Adaptive live
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-t-2 border-dashed border-ink-secondary inline-block" />
            Fixed-TOD base
          </span>
        </div>
        <span className="font-mono tabular-nums text-[9.5px] text-ink-muted">
          {fmtNum(minV, 1)}–{fmtNum(maxV, 1)} s/veh
        </span>
      </div>
    </div>
  );
}

export function NetworkWorkspace({
  devices,
  selectedZone,
  onZoneChange,
  selectedJunctionId,
  onOpenJunction,
  onCloseJunction,
}) {
  const {
    latestByDevice,
    counterfactual,
    alerts,
    setAlerts,
    stats,
    simMeta,
    setSimMeta,
    activeCorridorTrip,
    corridorGiveway,
    corridorOfficerAlert,
    preemptedJunctions,
  } = useSocket();
  const { user } = useAuth();
  const { isDark } = useTheme();
  const isOperatorPlus =
    !user?.anonymous &&
    (user?.role === 'admin' ||
      user?.role === 'operator' ||
      user?.persona === 'admin' ||
      user?.persona === 'supervisor' ||
      user?.persona === 'south-operator' ||
      user?.persona === 'east-operator');
  const isAdmin = user?.role === 'admin' || user?.persona === 'admin' || user?.persona === 'supervisor';
  const isAmbulanceDriver = user?.role === 'ambulance';
  const isOfficer = user?.role === 'operator' || user?.persona?.includes('operator');

  const [simState, setSimState] = useState(null);
  const [scenariosList, setScenariosList] = useState(QUICK_SCENARIOS);
  const [quickBusy, setQuickBusy] = useState(false);
  const [corridorAvoidJams, setCorridorAvoidJams] = useState(true);
  const [corridorDispatching, setCorridorDispatching] = useState(false);
  const [cfSnapshot, setCfSnapshot] = useState(null);
  const [cfHistory, setCfHistory] = useState([]);
  const [alertFilter, setAlertFilter] = useState('all');
  const [alertError, setAlertError] = useState('');
  const [resolvingId, setResolvingId] = useState(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );

  useEffect(() => {
    const onResize = () => setIsDesktopViewport(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const tileLayerRef = useRef(null);
  const refLayerRef = useRef(null);
  const linkLayerRef = useRef(null);
  const markerLayerRef = useRef(null);
  const emergencyLayerRef = useRef(null);
  const markerInstancesRef = useRef(new Map());
  const linkInstancesRef = useRef(new Map());

  // Sync /api/sim/state + initial /api/sim/counterfactual periodically
  const fetchSimOverview = useCallback(async () => {
    try {
      const [sRes, cRes] = await Promise.all([
        api.getSimState().catch(() => null),
        api.getCounterfactual().catch(() => null),
      ]);
      if (sRes?.junctions) setSimState(sRes);
      if (cRes && cRes.live && cRes.baseline) {
        setCfSnapshot(cRes);
      }
    } catch {
      // Transient polling errors are safe to ignore
    }
  }, []);

  useEffect(() => {
    fetchSimOverview();
    const t = setInterval(fetchSimOverview, 3000);
    return () => clearInterval(t);
  }, [fetchSimOverview]);

  useEffect(() => {
    let alive = true;
    api
      .getScenarios()
      .then((res) => {
        if (!alive) return;
        if (Array.isArray(res?.scenarios) && res.scenarios.length > 0) {
          setScenariosList(res.scenarios);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleDispatchCorridor = useCallback(async () => {
    if (corridorDispatching) return;
    setCorridorDispatching(true);
    try {
      if (!localStorage.getItem('hp_token') && !user?.anonymous) {
        try {
          const loginRes = await api.demoLogin('admin');
          if (loginRes?.token) {
            localStorage.setItem('hp_token', loginRes.token);
          }
        } catch (_) {}
      }

      const res = await fetch('/api/corridor/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('hp_token') || ''}`,
        },
        body: JSON.stringify({
          vehicleId: 'AMB-BLR-01',
          startJunctionId: 'JNC-BLR-008',
          destinationJunctionId: 'JNC-BLR-004',
          durationSeconds: 75,
          avoidJams: corridorAvoidJams,
        }),
      });
      if (res.ok) {
        await fetchSimOverview();
      } else {
        const simRes = await api.applyScenario('ambulance-corridor');
        if (simRes?.state) {
          setSimState(simRes.state);
        } else {
          await fetchSimOverview();
        }
      }
    } catch (err) {
      console.warn('[NetworkWorkspace] Corridor dispatch fallback:', err.message);
      try {
        const simRes = await api.applyScenario('ambulance-corridor');
        if (simRes?.state) setSimState(simRes.state);
        else fetchSimOverview();
      } catch (_) {}
    } finally {
      setCorridorDispatching(false);
    }
  }, [corridorDispatching, corridorAvoidJams, fetchSimOverview]);

  const handleQuickScenario = useCallback(
    async (scenarioId) => {
      if (!scenarioId || quickBusy) return;
      setQuickBusy(true);
      try {
        if (!localStorage.getItem('hp_token') && !user?.anonymous) {
          try {
            const loginRes = await api.demoLogin('admin');
            if (loginRes?.token) {
              localStorage.setItem('hp_token', loginRes.token);
            }
          } catch (_) {}
        }

        const res = await api.applyScenario(scenarioId);
        if (res?.success) {
          const m = res.meta || res;
          setSimMeta((prev) => ({
            ...prev,
            scenario: m.scenario ?? prev?.scenario,
            scenarioLabel: m.scenarioLabel ?? prev?.scenarioLabel,
            simClockIst: m.simClockIst ?? prev?.simClockIst,
            simStartNote: m.simStartNote ?? null,
            simSpeed: m.simSpeed ?? prev?.simSpeed,
          }));
          if (res.state?.junctions) {
            setSimState(res.state);
          } else {
            fetchSimOverview();
          }
        }
      } catch (err) {
        console.warn('[NetworkWorkspace] Error applying scenario:', err.message);
        if (scenarioId === 'ambulance-corridor') {
          await handleDispatchCorridor();
        }
      } finally {
        setQuickBusy(false);
      }
    },
    [quickBusy, setSimMeta, fetchSimOverview, handleDispatchCorridor]
  );

  const handleQuickSpeed = useCallback(
    async (speedVal) => {
      if (quickBusy || !isAdmin) return;
      setQuickBusy(true);
      try {
        const res = await api.setSimSpeed(speedVal);
        if (res?.success) {
          setSimMeta((prev) => ({
            ...prev,
            simSpeed: res.simSpeed ?? speedVal,
          }));
        }
      } catch {
        // Admin-only control
      } finally {
        setQuickBusy(false);
      }
    },
    [quickBusy, isAdmin, setSimMeta]
  );

  const activeCf = counterfactual?.live && counterfactual?.baseline ? counterfactual : cfSnapshot;

  // Record sparkline history as new cf updates arrive (monotonically keyed by elapsedSec)
  useEffect(() => {
    if (!activeCf?.live || !activeCf?.baseline) return;
    const elapsed = Number(activeCf.elapsedSec) || 0;
    const liveAvg = Number(activeCf.live.avgDelayPerVehSec);
    const baseAvg = Number(activeCf.baseline.avgDelayPerVehSec);
    if (!Number.isFinite(liveAvg) || !Number.isFinite(baseAvg)) return;

    setCfHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].elapsed === elapsed) {
        return prev;
      }
      return [...prev.slice(-39), { elapsed, liveAvg, baseAvg }];
    });
  }, [activeCf]);

  // Unified junction list combining canonical metadata + devices + /api/sim/state + real-time socket frames
  const mergedJunctions = useMemo(() => {
    const byId = new Map();
    for (const meta of DEFAULT_JUNCTIONS_META) {
      byId.set(meta.junctionId, {
        junctionId: meta.junctionId,
        deviceId: meta.junctionId,
        name: meta.name,
        zoneId: meta.zoneId,
        location: meta.location,
      });
    }
    for (const d of devices || []) {
      const jId = d.junctionId || d.deviceId;
      if (jId) {
        const prev = byId.get(jId) || {};
        byId.set(jId, { ...prev, ...d, junctionId: jId, deviceId: jId, location: d.location || prev.location });
      }
    }
    for (const sj of simState?.junctions || []) {
      const prev = byId.get(sj.junctionId) || {};
      byId.set(sj.junctionId, { ...prev, ...sj, deviceId: sj.junctionId, location: sj.location || prev.location });
    }
    for (const [jId, live] of Object.entries(latestByDevice || {})) {
      const prev = byId.get(jId) || {};
      byId.set(jId, {
        ...prev,
        ...live,
        junctionId: jId,
        deviceId: jId,
        name: live.junctionName || prev.name || jId,
        location: live.location || prev.location,
        zoneId: live.zoneId || prev.zoneId,
        metrics: live.metrics || prev.metrics,
        data: { ...(prev.data || {}), ...(live.data || {}) },
        describe: prev.describe,
        controller: live.data?.control?.controller || prev.controller,
      });
    }
    return Array.from(byId.values());
  }, [devices, simState, latestByDevice]);

  const visibleJunctions = useMemo(() => {
    if (!selectedZone || selectedZone === 'all') return mergedJunctions;
    return mergedJunctions.filter((j) => j.zoneId === selectedZone);
  }, [mergedJunctions, selectedZone]);

  // Initialize Leaflet map instance once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: BENGALURU_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
      preferCanvas: false,
    });
    const initW = mapContainerRef.current.clientWidth || 0;
    map.fitBounds(BENGALURU_BOUNDS, {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, initW < 640 ? 96 : 64],
      maxZoom: 13,
      animate: false,
    });

    linkLayerRef.current = L.layerGroup().addTo(map);
    emergencyLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    let lastW = initW;
    const resizeObs = new ResizeObserver((entries) => {
      const w = entries?.[0]?.contentRect?.width ?? (mapContainerRef.current?.clientWidth || 0);
      map.invalidateSize({ animate: false });
      if (Math.abs(w - lastW) > 60 && w > 0) {
        lastW = w;
        map.fitBounds(BENGALURU_BOUNDS, {
          paddingTopLeft: [24, 24],
          paddingBottomRight: [24, w < 640 ? 96 : 64],
          maxZoom: 13,
          animate: false,
        });
      }
    });
    resizeObs.observe(mapContainerRef.current);

    return () => {
      resizeObs.disconnect();
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      refLayerRef.current = null;
      linkLayerRef.current = null;
      emergencyLayerRef.current = null;
      markerLayerRef.current = null;
      markerInstancesRef.current.clear();
      linkInstancesRef.current.clear();
    };
  }, []);

  // Switch ArcGIS World Dark / Light Gray Canvas tile layers cleanly when theme toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const baseUrl = isDark
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';

    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    if (refLayerRef.current) {
      map.removeLayer(refLayerRef.current);
      refLayerRef.current = null;
    }

    tileLayerRef.current = L.tileLayer(baseUrl, {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      maxNativeZoom: 16,
      maxZoom: 19,
    }).addTo(map);

    tileLayerRef.current.bringToBack();
  }, [isDark]);

  // Render corridors, emergency paths, and signal-ring junction markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !linkLayerRef.current || !markerLayerRef.current || !emergencyLayerRef.current) {
      return;
    }

    const posById = new Map();
    const junctionById = new Map();
    for (const j of mergedJunctions) {
      junctionById.set(j.junctionId, j);
      const lat = Number(j.location?.latitude ?? j.location?.lat);
      const lng = Number(j.location?.longitude ?? j.location?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        posById.set(j.junctionId, [lat, lng]);
      }
    }

    // 1. Corridor links colored by bottleneck (worst directional speed) per undirected segment
    const corridorGroups = new Map();
    for (const lnk of simState?.corridors || []) {
      const fromPos = posById.get(lnk.fromJunction);
      const toPos = posById.get(lnk.toJunction);
      if (!fromPos || !toPos) continue;
      const jFrom = junctionById.get(lnk.fromJunction);
      const jTo = junctionById.get(lnk.toJunction);
      const showBoth =
        !selectedZone ||
        selectedZone === 'all' ||
        jFrom?.zoneId === selectedZone ||
        jTo?.zoneId === selectedZone;
      if (!showBoth) continue;

      const pairKey = [lnk.fromJunction, lnk.toJunction].sort().join('::');
      const jToSpd = Number(jTo?.metrics?.avgSpeedKmph ?? jTo?.avgSpeedKmph);
      const jFromSpd = Number(jFrom?.metrics?.avgSpeedKmph ?? jFrom?.avgSpeedKmph);
      const fallbackSpeed = Number.isFinite(jToSpd) ? jToSpd : jFromSpd;
      const linkSpeed = Number.isFinite(Number(lnk.speedKmph)) ? Number(lnk.speedKmph) : fallbackSpeed;
      const linkVc = Number.isFinite(Number(lnk.vOverC)) ? Number(lnk.vOverC) : 0;

      const entry = corridorGroups.get(pairKey) || {
        fromPos,
        toPos,
        fromId: lnk.fromJunction,
        toId: lnk.toJunction,
        corridor: lnk.corridor,
        worstSpeed: Infinity,
        bestSpeed: 0,
        speeds: [],
        worstVc: 0,
        dirs: [],
      };
      entry.speeds.push(linkSpeed);
      if (linkSpeed < entry.worstSpeed || (linkSpeed === entry.worstSpeed && linkVc > entry.worstVc)) {
        entry.worstSpeed = linkSpeed;
        entry.worstVc = linkVc;
      }
      if (linkSpeed > entry.bestSpeed) {
        entry.bestSpeed = linkSpeed;
      }
      entry.dirs.push(
        `${jFrom?.name || lnk.fromJunction} → ${jTo?.name || lnk.toJunction}: ${
          Number.isFinite(linkSpeed) ? `${fmtNum(linkSpeed, 1)} km/h` : '—'
        }${linkVc > 0 ? ` (v/c ${fmtNum(linkVc, 2)})` : ''}`
      );
      corridorGroups.set(pairKey, entry);
    }

    const activeLinkKeys = new Set();
    for (const [pairKey, group] of corridorGroups.entries()) {
      activeLinkKeys.add(pairKey);
      // Distinct 3-tier corridor speed calculation:
      // If either direction suffers severe bottleneck (< 15 km/h), show corridor as RED bottleneck
      // If free-flow bypass (both directions >= 24 km/h and best >= 25 km/h), show corridor as GREEN bypass
      // Otherwise, show active arterial as YELLOW
      let linkSpeed;
      if (group.worstSpeed < 15) {
        linkSpeed = group.worstSpeed;
      } else if (group.worstSpeed >= 24 && group.bestSpeed >= 25) {
        linkSpeed = group.bestSpeed;
      } else {
        linkSpeed = group.speeds.length > 1 ? (group.worstSpeed + group.bestSpeed) / 2 : group.worstSpeed;
      }
      if (!Number.isFinite(linkSpeed)) linkSpeed = 25;
      const speedStyle = classifyLinkSpeed(linkSpeed, isDark);
      const tooltipText = `${group.corridor} · ${group.dirs.join(' | ')}`;
      const roadPath = getCorridorRoadWaypoints(group.fromId, group.toId, group.fromPos, group.toPos);
      const pathKey = roadPath.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';');

      let linkEntry = linkInstancesRef.current.get(pairKey);
      if (!linkEntry) {
        const poly = L.polyline(roadPath, {
          color: speedStyle.hex,
          weight: speedStyle.weight,
          dashArray: speedStyle.dashArray,
          opacity: speedStyle.opacity,
        })
          .bindTooltip(tooltipText, {
            className: 'mp-tooltip',
            sticky: true,
          })
          .addTo(linkLayerRef.current);
        linkInstancesRef.current.set(pairKey, { poly, lastColor: speedStyle.hex, lastTooltip: tooltipText, lastPathKey: pathKey });
      } else {
        if (!linkLayerRef.current.hasLayer(linkEntry.poly)) {
          linkLayerRef.current.addLayer(linkEntry.poly);
        }
        if (linkEntry.lastColor !== speedStyle.hex) {
          linkEntry.poly.setStyle({
            color: speedStyle.hex,
            weight: speedStyle.weight,
            dashArray: speedStyle.dashArray,
            opacity: speedStyle.opacity,
          });
          linkEntry.lastColor = speedStyle.hex;
        }
        if (linkEntry.lastTooltip !== tooltipText) {
          linkEntry.poly.setTooltipContent(tooltipText);
          linkEntry.lastTooltip = tooltipText;
        }
        if (linkEntry.lastPathKey !== pathKey) {
          linkEntry.poly.setLatLngs(roadPath);
          linkEntry.lastPathKey = pathKey;
        }
      }
    }
    for (const [key, entry] of linkInstancesRef.current.entries()) {
      if (!activeLinkKeys.has(key)) {
        linkLayerRef.current.removeLayer(entry.poly);
        linkInstancesRef.current.delete(key);
      }
    }

    // 2. Active emergency responder routes (snapped to arterial street curves)
    emergencyLayerRef.current.clearLayers();
    const activeList = (simState?.activeEmergencies?.length
      ? simState.activeEmergencies
      : activeCorridorTrip
        ? [activeCorridorTrip]
        : []);

    for (const em of activeList) {
      const pathIds = (em.path || em.route || []).filter((id) => posById.has(id));
      const fullPathPts = [];
      for (let i = 0; i < pathIds.length - 1; i++) {
        const segPts = getCorridorRoadWaypoints(
          pathIds[i],
          pathIds[i + 1],
          posById.get(pathIds[i]),
          posById.get(pathIds[i + 1])
        );
        if (i === 0) {
          fullPathPts.push(...segPts);
        } else {
          fullPathPts.push(...segPts.slice(1));
        }
      }
      if (fullPathPts.length >= 2) {
        // Outer glowing green wave
        L.polyline(fullPathPts, {
          color: '#10b981',
          weight: 7,
          opacity: 0.4,
        }).addTo(emergencyLayerRef.current);

        // Core green corridor
        L.polyline(fullPathPts, {
          color: '#34d399',
          weight: 4,
          opacity: 0.95,
        }).addTo(emergencyLayerRef.current);
      }
      const pts = pathIds.map((id) => posById.get(id)).filter(Boolean);
      const legIdx = Math.max(0, Math.min(pts.length - 1, em.legIndex ?? 0));
      const fallbackPos = pts[legIdx];
      const ambPos =
        typeof em.latitude === 'number' && typeof em.longitude === 'number'
          ? [em.latitude, em.longitude]
          : fallbackPos;

      if (ambPos) {
        const ambIcon = L.divIcon({
          className: 'mp-ambulance-marker',
          html: `
            <div style="position:relative;display:flex;align-items:center;justify-content:center;">
              <div style="position:absolute;width:28px;height:28px;border-radius:50%;background:rgba(16,185,129,0.45);animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;"></div>
              <div style="position:relative;background:#059669;color:#ffffff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:9999px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.4);border:1.5px solid #a7f3d0;display:flex;align-items:center;gap:4px;white-space:nowrap;font-family:monospace;">
                <span>🚑</span>
                <span>${em.vehicleId || em.id || 'AMB-BLR-01'}</span>
                <span style="font-size:9.5px;color:#d1fae5;">(${em.speedKmph || 48}km/h)</span>
              </div>
            </div>
          `,
          iconSize: [110, 26],
          iconAnchor: [55, 13],
        });

        L.marker(ambPos, { icon: ambIcon, zIndexOffset: 2500 })
          .bindTooltip(
            `Emergency Responder ${em.vehicleId || em.id || 'AMB-BLR-01'} • Speed: ${em.speedKmph || 48} km/h • Next: ${em.nextJunctionId || 'Jayadeva'} • Preempt: ${em.preempt !== false ? 'ACTIVE' : 'Passive'}`,
            { className: 'mp-tooltip' }
          )
          .addTo(emergencyLayerRef.current);
      }
    }

    // 3. Signal-ring junction glyphs (cached in-place to prevent hover cursor glitching)
    const activeMarkerIds = new Set();
    for (const j of visibleJunctions) {
      const pos = posById.get(j.junctionId);
      if (!pos) continue;
      activeMarkerIds.add(j.junctionId);

      const info = classifyJunctionStatus(j, isDark);
      const isSelected = selectedJunctionId === j.junctionId;
      const qM = j.metrics?.maxQueueLengthM ?? j.maxQueueLengthM;
      const spd = j.metrics?.avgSpeedKmph ?? j.avgSpeedKmph;
      const ctrl = j.describe?.activeController || j.data?.control?.activeController || j.controller;
      const activeDir = j.data?.control?.activeDir || j.control?.activeDir || j.activeDir || null;
      const inIntergreen = Boolean(j.data?.control?.inIntergreen ?? j.control?.inIntergreen ?? j.inIntergreen);

      const svgHtml = buildMarkerSvg(info, isSelected, isDark, {
        maxQueueM: qM,
        activeDir,
        inIntergreen,
      });

      const phaseStr = activeDir ? ` · Phase ${activeDir}${inIntergreen ? ' (amber)' : ''}` : '';
      const tooltipHtml = `<div class="space-y-0.5">
          <div style="font-weight:600">${j.name || j.junctionId}</div>
          <div style="font-family:JetBrains Mono,monospace;font-size:10px">
            ${info.label} · Q ${fmtInt(qM)}m · ${fmtNum(spd, 1)} km/h · ${controllerLabel(ctrl)}${phaseStr}
          </div>
        </div>`;

      let entry = markerInstancesRef.current.get(j.junctionId);
      if (!entry) {
        const icon = L.divIcon({
          className: '',
          html: svgHtml,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
        const marker = L.marker(pos, { icon });
        marker.bindTooltip(tooltipHtml, { className: 'mp-tooltip', direction: 'top', offset: [0, -14] });
        marker.on('click', () => {
          onOpenJunction(j.junctionId);
        });
        marker.addTo(markerLayerRef.current);
        markerInstancesRef.current.set(j.junctionId, { marker, lastHtml: svgHtml, lastTooltip: tooltipHtml });
      } else {
        if (!markerLayerRef.current.hasLayer(entry.marker)) {
          markerLayerRef.current.addLayer(entry.marker);
        }
        if (entry.lastHtml !== svgHtml) {
          entry.marker.setIcon(L.divIcon({
            className: '',
            html: svgHtml,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
          }));
          entry.lastHtml = svgHtml;
        }
        if (entry.lastTooltip !== tooltipHtml) {
          entry.marker.setTooltipContent(tooltipHtml);
          entry.lastTooltip = tooltipHtml;
        }
        entry.marker.setLatLng(pos);
      }
    }

    for (const [id, entry] of markerInstancesRef.current.entries()) {
      if (!activeMarkerIds.has(id)) {
        markerLayerRef.current.removeLayer(entry.marker);
        markerInstancesRef.current.delete(id);
      }
    }
  }, [
    mergedJunctions,
    visibleJunctions,
    simState,
    selectedZone,
    selectedJunctionId,
    isDark,
    onOpenJunction,
  ]);

  // Network-level live KPIs derived purely from stream/state
  const networkKpis = useMemo(() => {
    const speeds = visibleJunctions
      .map((j) => Number(j.metrics?.avgSpeedKmph ?? j.avgSpeedKmph))
      .filter((v) => Number.isFinite(v));
    const queues = visibleJunctions
      .map((j) => Number(j.metrics?.maxQueueLengthM ?? j.maxQueueLengthM))
      .filter((v) => Number.isFinite(v));

    const meanSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
    const maxQueue = queues.length > 0 ? Math.max(...queues) : null;
    const gridlockCount = visibleJunctions.filter(
      (j) => classifyJunctionStatus(j, isDark).key === 'gridlock'
    ).length;

    return { meanSpeed, maxQueue, gridlockCount };
  }, [visibleJunctions, isDark]);

  // Filtered live alerts
  const visibleAlerts = useMemo(() => {
    const list = (alerts || []).filter((a) => {
      if (selectedZone && selectedZone !== 'all' && a.zoneId && a.zoneId !== selectedZone) {
        return false;
      }
      if (alertFilter === 'all') return true;
      return a.severity === alertFilter;
    });
    return list.slice(0, 40);
  }, [alerts, selectedZone, alertFilter]);

  const handleResolveAlert = async (e, alertId) => {
    e.stopPropagation();
    setResolvingId(alertId);
    setAlertError('');
    try {
      await api.resolveAlert(alertId);
      setAlerts((prev) => prev.map((a) => (a.alertId === alertId ? { ...a, resolved: true } : a)));
    } catch (err) {
      setAlertError(err?.message || 'Failed to resolve alert');
    } finally {
      setResolvingId(null);
    }
  };

  const handleClearResolved = async () => {
    setAlertError('');
    try {
      await api.clearResolvedAlerts();
      setAlerts((prev) => prev.filter((a) => !a.resolved));
    } catch (err) {
      setAlertError(err?.message || 'Failed to clear resolved alerts');
    }
  };

  const selectedJunctionObj = useMemo(
    () => mergedJunctions.find((j) => j.junctionId === selectedJunctionId) || null,
    [mergedJunctions, selectedJunctionId]
  );

  // Close drawer on Escape key
  useEffect(() => {
    if (!selectedJunctionId) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCloseJunction();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedJunctionId, onCloseJunction]);

  const weatherActive = Boolean(simState?.weather?.active);
  const emergencyCount = simState?.activeEmergencies?.length || 0;

  return (
    <div className="flex flex-col lg:flex-row lg:h-[calc(100vh-52px)] lg:overflow-hidden">
      {/* Left/Primary Corridor Map Canvas */}
      <div className="flex-1 flex flex-col min-w-0 min-h-[420px] lg:min-h-0">
        {/* Map Context Bar */}
        <div className="px-3 py-2 border-b border-hairline bg-surface flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full" role="group" aria-label="Zone filter">
            <button
              type="button"
              onClick={() => onZoneChange('all')}
              className={`px-2 py-1 rounded text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                selectedZone === 'all'
                  ? 'bg-accent text-accent-contrast border-accent'
                  : 'bg-inset text-ink-secondary border-hairline hover:text-ink-primary'
              }`}
            >
              All Zones ({mergedJunctions.length})
            </button>
            {ZONE_LIST.map((z) => {
              const active = selectedZone === z;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => onZoneChange(z)}
                  className={`px-2 py-1 rounded text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'bg-accent text-accent-contrast border-accent'
                      : 'bg-inset text-ink-secondary border-hairline hover:text-ink-primary'
                  }`}
                >
                  {zoneLabel(z)}
                </button>
              );
            })}
          </div>

          {/* Live Physics State Pills */}
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-ink-secondary">
            {simState?.todPeriod?.label && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-hairline bg-inset">
                <Clock className="w-3 h-3 text-ink-muted" />
                <span>{simState.todPeriod.label}</span>
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${
                weatherActive
                  ? 'border-signal-emergency/40 bg-signal-emergency/15 text-signal-emergency'
                  : 'border-hairline bg-inset'
              }`}
            >
              {weatherActive ? <CloudRain className="w-3 h-3" /> : <Sun className="w-3 h-3 text-ink-muted" />}
              <span>
                {weatherActive
                  ? simState?.weather?.capacityFactor !== undefined
                    ? `Monsoon (${fmtNum(simState.weather.capacityFactor, 2)}x cap)`
                    : 'Monsoon'
                  : 'Dry'}
              </span>
            </span>
            {emergencyCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-signal-emergency/40 bg-signal-emergency/15 text-signal-emergency">
                <Siren className="w-3 h-3" />
                <span>{emergencyCount} En-route</span>
              </span>
            )}
            <label
              className="inline-flex items-center gap-1"
              title={
                user?.anonymous
                  ? 'Read-only mode: Switch to Admin or Operator to change simulation scenarios'
                  : 'Switch realistic Bengaluru traffic scenario across both CRN twins'
              }
            >
              <select
                aria-label="Traffic scenario preset"
                value={simMeta?.scenario || simState?.scenario || 'pm-peak'}
                disabled={user?.anonymous || quickBusy}
                onChange={(e) => handleQuickScenario(e.target.value)}
                className="px-1.5 py-0.5 rounded border border-hairline bg-inset text-ink-primary font-mono text-[11px] disabled:opacity-60 cursor-pointer"
              >
                {scenariosList.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={user?.anonymous || corridorDispatching || (simState?.activeEmergencies?.length > 0) || Boolean(activeCorridorTrip)}
              onClick={handleDispatchCorridor}
              title={
                user?.anonymous
                  ? 'Read-only mode: Switch to Admin or Operator to dispatch emergency corridors'
                  : 'Dispatch Emergency Responder Green Corridor from Hebbal Flyover (008) to Jayadeva Hospital (004)'
              }
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 font-mono text-[11px] font-semibold transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span>🚑</span>
              <span>{(simState?.activeEmergencies?.length > 0) || Boolean(activeCorridorTrip) ? 'Corridor Active' : 'Dispatch Corridor'}</span>
            </button>
            {isAdmin && (
              <div className="inline-flex items-center rounded border border-hairline bg-inset overflow-hidden" role="group" aria-label="Simulation clock speed">
                {[1, 2, 5].map((spd) => {
                  const activeSpd = Number(simMeta?.simSpeed || 1) === spd;
                  return (
                    <button
                      key={`map-spd-${spd}`}
                      type="button"
                      disabled={quickBusy}
                      onClick={() => handleQuickSpeed(spd)}
                      className={`px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                        activeSpd
                          ? 'bg-accent text-accent-contrast font-semibold'
                          : 'text-ink-secondary hover:text-ink-primary'
                      }`}
                    >
                      {spd}x
                    </button>
                  );
                })}
              </div>
            )}
            {simState?.simTime && (
              <span className="text-ink-muted">{fmtClockTime(simState.simTime)}</span>
            )}
          </div>
        </div>

        {/* Role-Specific Tactical & Public Banners */}
        {(() => {
          const activeEm = (simState?.activeEmergencies?.[0] || activeCorridorTrip || null);
          const isAmbulanceActive = Boolean(activeEm);
          const hasOfficerAlert = Boolean(corridorOfficerAlert) || (isOfficer && isAmbulanceActive && preemptedJunctions?.size > 0);

          return (
            <>
              {/* 1. Ambulance Driver Live Navigation HUD */}
              {(isAmbulanceDriver || isAmbulanceActive) && activeEm && (
                <div className="px-3 py-2 bg-emerald-950/90 border-b border-emerald-500/30 flex flex-wrap items-center justify-between gap-3 text-emerald-100 text-xs backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded bg-emerald-500/20 text-emerald-400 font-bold animate-pulse text-sm">🚑</span>
                    <div>
                      <div className="font-semibold text-emerald-300 flex items-center gap-1.5 font-mono">
                        <span>PRIORITY CORRIDOR: Hebbal (008) ➔ Jayadeva (004)</span>
                        <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                          {activeEm.isDynamicRerouted ? 'DYNAMIC BYPASS' : 'GREEN WAVE LOCKED'}
                        </span>
                      </div>
                      <div className="text-[11px] text-emerald-400/80">
                        {activeEm.rerouteReason || 'Incoming approaches locked GREEN to flush queues naturally ahead of transit.'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 font-mono text-[11px]">
                    <div>
                      <span className="text-emerald-400/70">Next: </span>
                      <span className="font-semibold text-emerald-200">{activeEm.nextJunctionId || 'Jayadeva (004)'}</span>
                    </div>
                    <div>
                      <span className="text-emerald-400/70">ETA: </span>
                      <span className="font-semibold text-emerald-200">{activeEm.etaToNextSec ?? 12}s</span>
                    </div>
                    <div>
                      <span className="text-emerald-400/70">Speed: </span>
                      <span className="font-semibold text-emerald-200">{activeEm.speedKmph || 48} km/h</span>
                    </div>
                    <div className="w-24 bg-emerald-950 rounded-full h-2 border border-emerald-500/30 overflow-hidden">
                      <div
                        className="bg-emerald-400 h-full transition-all duration-300"
                        style={{ width: `${activeEm.progressPct || 0}%` }}
                      />
                    </div>
                    <span className="font-bold text-emerald-300">{activeEm.progressPct || 0}%</span>
                  </div>
                </div>
              )}

              {/* 2. BTP Officer Tactical Alert Banner */}
              {isOfficer && hasOfficerAlert && (
                <div className="px-3 py-1.5 bg-amber-950/90 border-b border-amber-500/40 flex items-center justify-between text-amber-200 text-xs backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400 font-bold">👮 BTP TACTICAL ALERT:</span>
                    <span>
                      {corridorOfficerAlert?.message ||
                        `Emergency Corridor active at assigned junction. Priority signals set to GREEN on approach to flush queue. Hold cross-traffic.`}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-amber-400 font-bold px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40">
                    HOLD CROSS-TRAFFIC
                  </span>
                </div>
              )}

              {/* 3. Citizen / Public Traffic Advisory Notice */}
              {!isAmbulanceDriver && !isOfficer && isAmbulanceActive && (
                <div className="px-3 py-1 bg-cyan-950/80 border-b border-cyan-500/30 flex items-center justify-between text-cyan-200 text-[11px] backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400">ℹ️</span>
                    <span>
                      {corridorGiveway?.message ||
                        `Traffic Advisory: Emergency vehicle transit active (Hebbal ➔ Jayadeva). Ahead signals automatically turn GREEN to clear queues naturally.`}
                    </span>
                  </div>
                  <span className="text-cyan-400/80 font-mono text-[10px]">
                    Normal dynamic AI cycle resumes immediately after vehicle passage
                  </span>
                </div>
              )}
            </>
          );
        })()}

        {/* Interactive Bengaluru Leaflet Canvas */}
        <div className="relative h-[430px] lg:h-auto lg:flex-1 bg-ground">
          <div ref={mapContainerRef} className="w-full h-full min-h-[420px] lg:min-h-0" />

          {/* Accessible Map Legend (Junction Glyphs/Rings/Phase + Link Speed Bands) */}
          <div className="absolute bottom-3 left-3 z-[400] console-panel px-2.5 py-1.5 space-y-1 text-[10px] max-w-[calc(100%-24px)]">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {[
                { shape: 'circle', label: 'Flow', hex: isDark ? '#10b981' : '#047857' },
                { shape: 'triangle', label: 'Heavy', hex: isDark ? '#f59e0b' : '#92400e' },
                { shape: 'octagon', label: 'Gridlock', hex: isDark ? '#f97316' : '#9a3412' },
                { shape: 'cross', label: 'Emergency', hex: isDark ? '#38bdf8' : '#0369a1' },
              ].map((item) => (
                <span key={item.label} className="inline-flex items-center gap-1 text-ink-primary">
                  <StatusGlyph shape={item.shape} color={item.hex} size={9} />
                  <span>{item.label}</span>
                </span>
              ))}
              <span className="text-ink-muted">· Ring size = Q ·</span>
              <span className="inline-flex items-center gap-1 text-ink-secondary">
                <span className="inline-block w-2 h-2 rounded-full bg-[#22c55e]" aria-hidden="true" />
                <span>Green phase dir</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-ink-secondary font-mono">
              <span className="font-sans text-ink-muted">Link speed:</span>
              {[
                { label: '>=25 (Flow)', hex: isDark ? '#10b981' : '#047857' },
                { label: '15-24 (Moderate)', hex: isDark ? '#eab308' : '#b45309' },
                { label: '<15 km/h (Congested)', hex: isDark ? '#ef4444' : '#b91c1c' },
              ].map((band) => (
                <span key={band.label} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block w-3.5 h-1 rounded-sm"
                    style={{ backgroundColor: band.hex }}
                    aria-hidden="true"
                  />
                  <span>{band.label}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Recenter Control */}
          <button
            type="button"
            onClick={() => {
              const w = mapContainerRef.current?.clientWidth || 640;
              mapRef.current?.fitBounds(BENGALURU_BOUNDS, {
                paddingTopLeft: [24, 24],
                paddingBottomRight: [24, w < 640 ? 96 : 64],
                maxZoom: 13,
                animate: false,
              });
            }}
            title="Reset map bounds to Bengaluru corridors"
            aria-label="Reset map view"
            className="absolute top-3 right-3 z-[400] min-w-[36px] min-h-[36px] flex items-center justify-center console-panel p-2 text-ink-secondary hover:text-ink-primary transition-colors"
          >
            <Crosshair className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Right Rail: City KPIs, Counterfactual Panel, Live Alerts */}
      <aside className="w-full lg:w-[390px] xl:w-[420px] shrink-0 border-t lg:border-t-0 lg:border-l border-hairline bg-surface flex flex-col lg:h-full overflow-y-auto">
        {/* City KPIs (city room) */}
        <section className="p-3.5 border-b border-hairline">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-ink-primary">Network KPIs (City Room)</h2>
            <span className="text-[11px] font-mono tabular-nums text-ink-muted">
              {stats?.ingestRate ? `${fmtInt(stats.ingestRate)} ev/s` : 'Connected'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="console-inset px-2.5 py-2">
              <div className="text-[11px] text-ink-muted">Throughput</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-ink-primary mt-0.5">
                {activeCf?.live?.throughputVeh !== undefined
                  ? `${fmtInt(activeCf.live.throughputVeh)} veh`
                  : '—'}
              </div>
            </div>
            <div className="console-inset px-2.5 py-2">
              <div className="text-[11px] text-ink-muted">Mean speed</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-ink-primary mt-0.5">
                {networkKpis.meanSpeed !== null ? `${fmtNum(networkKpis.meanSpeed, 1)} km/h` : '—'}
              </div>
            </div>
            <div className="console-inset px-2.5 py-2">
              <div className="text-[11px] text-ink-muted">Peak queue</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-ink-primary mt-0.5">
                {networkKpis.maxQueue !== null ? `${fmtInt(networkKpis.maxQueue)} m` : '—'}
              </div>
            </div>
            <div className="console-inset px-2.5 py-2">
              <div className="text-[11px] text-ink-muted">Gridlock / Alerts</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-ink-primary mt-0.5">
                {fmtInt(networkKpis.gridlockCount)} / {fmtInt(visibleAlerts.filter((a) => !a.resolved).length)}
              </div>
            </div>
          </div>
        </section>

        {/* Counterfactual Panel (Honesty rule #2: Required fixed-time reference framing) */}
        <section className="p-3.5 border-b border-hairline space-y-2.5">
          {(() => {
            const liveAvg = Number(activeCf?.live?.avgDelayPerVehSec);
            const baseAvg = Number(activeCf?.baseline?.avgDelayPerVehSec);
            const delayDeltaPct =
              Number.isFinite(liveAvg) && Number.isFinite(baseAvg) && baseAvg > 0
                ? ((liveAvg - baseAvg) / baseAvg) * 100
                : null;
            return (
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-xs font-semibold text-ink-primary">Adaptive vs Fixed-Time</h2>
                  <p className="text-[11px] text-ink-muted">
                    vs Webster-tuned fixed-time plan, same simulated arrivals
                  </p>
                </div>
                {delayDeltaPct !== null && (
                  <span
                    data-testid="cf-delay-delta-badge"
                    title="Negative = live adaptive delay is lower than shadow fixed-time baseline"
                    className={`px-2 py-0.5 rounded border font-mono tabular-nums text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                      delayDeltaPct <= 0
                        ? 'border-signal-flow/40 bg-signal-flow/15 text-signal-flow'
                        : 'border-signal-heavy/40 bg-signal-heavy/15 text-signal-heavy'
                    }`}
                  >
                    Delay vs baseline: {fmtSigned(delayDeltaPct, 1, '%')}
                  </span>
                )}
              </div>
            );
          })()}

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="console-inset px-2.5 py-2">
              <div className="text-[10px] text-ink-muted">Delay saved</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-ink-primary mt-0.5">
                {activeCf?.delaySavedVehHours !== undefined
                  ? `${fmtSigned(activeCf.delaySavedVehHours, 2)} veh·h`
                  : '—'}
              </div>
            </div>
            <div className="console-inset px-2.5 py-2">
              <div className="text-[10px] text-ink-muted">Avg delay (Live / Base)</div>
              <div className="font-mono tabular-nums text-xs font-semibold text-ink-primary mt-1">
                {activeCf?.live
                  ? `${fmtNum(activeCf.live.avgDelayPerVehSec, 1)} / ${fmtNum(activeCf.baseline.avgDelayPerVehSec, 1)} s`
                  : '—'}
              </div>
            </div>
          </div>

          <DualLineSparkline series={cfHistory} isDark={isDark} />

          {activeCf?.emergency?.trips > 0 && (
            <div className="text-[11px] font-mono tabular-nums text-signal-emergency flex items-center justify-between px-2 py-1 rounded border border-signal-emergency/30 bg-signal-emergency/10">
              <span>Emergency transit saved</span>
              <span>{fmtSigned(activeCf.emergency.timeSavedSec, 1, 's')}</span>
            </div>
          )}
        </section>

        {/* Live Alerts List */}
        <section className="p-3.5 flex-1 flex flex-col min-h-[260px]">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-xs font-semibold text-ink-primary">
              Alerts ({visibleAlerts.filter((a) => !a.resolved).length} open)
            </h2>
            <div className="flex items-center gap-1">
              {['all', 'critical', 'warning'].map((sev) => (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setAlertFilter(sev)}
                  className={`px-2 py-0.5 rounded text-[10px] capitalize border ${
                    alertFilter === sev
                      ? 'bg-accent text-accent-contrast border-accent'
                      : 'bg-inset text-ink-secondary border-hairline hover:text-ink-primary'
                  }`}
                >
                  {sev}
                </button>
              ))}
              <button
                type="button"
                onClick={handleClearResolved}
                title="Clear resolved alerts"
                aria-label="Clear resolved alerts"
                className="p-1 rounded border border-hairline bg-inset text-ink-muted hover:text-ink-primary"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {alertError && (
            <div role="alert" className="mb-2 px-2 py-1 rounded border border-signal-gridlock/40 bg-signal-gridlock/10 text-[11px] text-signal-gridlock">
              {alertError}
            </div>
          )}

          <div className="space-y-1.5 overflow-y-auto flex-1 pr-0.5">
            {visibleAlerts.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-muted console-inset">
                No active anomalies in selected scope.
              </div>
            ) : (
              (isDesktopViewport || showAllAlerts ? visibleAlerts : visibleAlerts.slice(0, 5)).map((item) => {
                const jId = item.junctionId || item.deviceId;
                const sev = item.severity || 'info';
                const sevShape = sev === 'critical' ? 'octagon' : sev === 'warning' ? 'triangle' : 'cross';
                const sevHex =
                  sev === 'critical'
                    ? isDark ? '#f97316' : '#9a3412'
                    : sev === 'warning'
                      ? isDark ? '#f59e0b' : '#92400e'
                      : isDark ? '#38bdf8' : '#0369a1';
                return (
                  <div
                    key={item.alertId || item._id}
                    onClick={() => jId && onOpenJunction(jId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && jId) {
                        e.preventDefault();
                        onOpenJunction(jId);
                      }
                    }}
                    className={`p-2.5 rounded border transition-colors cursor-pointer ${
                      item.resolved
                        ? 'border-hairline bg-inset/50 opacity-60'
                        : 'border-hairline bg-inset hover:border-hairlineStrong'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span
                        className={`inline-flex items-center gap-1.5 font-mono uppercase font-semibold ${
                          sev === 'critical'
                            ? 'text-signal-gridlock'
                            : sev === 'warning'
                              ? 'text-signal-heavy'
                              : 'text-signal-emergency'
                        }`}
                      >
                        <StatusGlyph shape={sevShape} color={sevHex} size={8} />
                        <span>{sev}</span>
                      </span>
                      <span className="font-mono tabular-nums text-ink-muted">
                        {fmtClockTime(item.timestamp)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs font-medium text-ink-primary flex items-center justify-between gap-1">
                      <span className="truncate">{humanizeAlertText(item.title)}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    </div>
                    <p className="text-[11px] text-ink-secondary line-clamp-2 mt-0.5">
                      {humanizeAlertText(item.message)}
                    </p>
                    <div className="mt-2 pt-1.5 border-t border-hairline flex items-center justify-between text-[10px]">
                      <span className="font-mono text-ink-muted">{jId}</span>
                      {item.resolved ? (
                        <span className="inline-flex items-center gap-1 text-signal-flow">
                          <CheckCircle2 className="w-3 h-3" /> Resolved
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={resolvingId === item.alertId}
                          onClick={(e) => handleResolveAlert(e, item.alertId)}
                          className="px-2 py-0.5 rounded border border-hairline bg-surface hover:border-hairlineStrong text-ink-secondary hover:text-ink-primary"
                        >
                          {resolvingId === item.alertId ? 'Resolving...' : 'Resolve'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {!isDesktopViewport && visibleAlerts.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllAlerts((prev) => !prev)}
                className="w-full py-1.5 rounded border border-hairline bg-inset text-xs font-medium text-accent-ink hover:border-hairlineStrong"
              >
                {showAllAlerts ? 'Show top 5 alerts' : `Show all ${visibleAlerts.length} alerts`}
              </button>
            )}
          </div>
        </section>
      </aside>

      {/* Slide-over Junction Detail Drawer */}
      {selectedJunctionId && (
        <div
          className="fixed inset-0 z-[1100] flex justify-end bg-black/45"
          onClick={onCloseJunction}
          role="dialog"
          aria-modal="true"
          aria-label={`Junction detail drawer for ${selectedJunctionId}`}
        >
          <div
            className="w-full max-w-4xl h-full bg-ground border-l border-hairline overflow-y-auto p-4 sm:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <JunctionDetailView
              junctionId={selectedJunctionId}
              initialSimJunction={selectedJunctionObj}
              isDrawer
              onClose={onCloseJunction}
              onControllerUpdated={fetchSimOverview}
            />
          </div>
        </div>
      )}
    </div>
  );
}

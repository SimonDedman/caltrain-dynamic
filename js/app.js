// Caltrain Live - Dynamic Caltrain Schedule PWA
// Uses GTFS static data + optional 511.org real-time API

(function () {
  'use strict';

  // ── State ──
  const state = {
    direction: 'northbound',
    scheduleType: 'weekday',
    data: null,
    nearestStationIdx: -1,
    betweenStations: null, // { fromIdx, toIdx, fraction }
    userLat: null,
    userLon: null,
    watchId: null,
    apiKey: '',
    realtimeDelays: {},
    nextTrain: null,
    nowColIdx: -1,
    selectedStationIdx: -1,
  };

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const dom = {};

  function cacheDom() {
    dom.clock = $('#clock');
    dom.thead = $('#timetable-head');
    dom.tbody = $('#timetable-body');
    dom.wrapper = $('#timetable-wrapper');
    dom.loading = $('#loading');
    dom.scheduleBadge = $('#schedule-badge');
    dom.stationBadge = $('#station-badge');
    dom.stationName = $('#nearest-station-name');
    dom.rtBadge = $('#realtime-badge');
    dom.banner = $('#next-train-banner');
    dom.bannerNum = $('#banner-train-num');
    dom.bannerTime = $('#banner-train-time');
    dom.bannerDest = $('#banner-train-dest');
    dom.bannerScroll = $('#banner-scroll-btn');
    dom.settingsOverlay = $('#settings-overlay');
    dom.apiKeyInput = $('#api-key-input');
    dom.locationToggle = $('#location-toggle');
    dom.posMarker = $('#position-marker');
    dom.main = $('#main');
  }

  // ── Utilities ──
  function timeToMinutes(timeStr) {
    if (!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  function formatTime12(timeStr) {
    if (!timeStr) return '—';
    let [h, m] = timeStr.split(':').map(Number);
    if (h >= 24) h -= 24;
    const ampm = h >= 12 ? 'p' : 'a';
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hour12}:${String(m).padStart(2, '0')}${ampm}`;
  }

  function nowMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Data Loading ──
  async function loadData() {
    try {
      const resp = await fetch('data/schedule.json');
      state.data = await resp.json();
      return true;
    } catch (e) {
      console.error('Failed to load schedule data:', e);
      dom.loading.innerHTML =
        '<p style="color:#E31837;font-weight:600">Failed to load schedule data. Please refresh.</p>';
      return false;
    }
  }

  // ── Schedule Type Detection ──
  function detectScheduleType() {
    const now = new Date();
    const day = now.getDay();
    // TODO: Check holiday calendar_dates
    state.scheduleType = day === 0 || day === 6 ? 'weekend' : 'weekday';
    dom.scheduleBadge.textContent =
      state.scheduleType === 'weekend' ? 'Weekend' : 'Weekday';
  }

  // ── Timetable Rendering ──
  function getTrains() {
    const sched = state.data[state.scheduleType];
    if (!sched) return [];
    return sched[state.direction] || [];
  }

  function getStationOrder() {
    const stations = state.data.stations;
    // Southbound: north to south (as-is)
    // Northbound: south to north (reversed)
    if (state.direction === 'northbound') {
      return stations.map((s, i) => ({ ...s, origIdx: i })).reverse();
    }
    return stations.map((s, i) => ({ ...s, origIdx: i }));
  }

  function getFirstStopMinutes(train) {
    // For sorting/finding: get the first stop time for this train in travel order
    const stations = getStationOrder();
    for (const s of stations) {
      const t = train.times[s.origIdx];
      if (t) return timeToMinutes(t);
    }
    return 9999;
  }

  function getLastStopMinutes(train) {
    const stations = getStationOrder();
    for (let i = stations.length - 1; i >= 0; i--) {
      const t = train.times[stations[i].origIdx];
      if (t) return timeToMinutes(t);
    }
    return 9999;
  }

  function renderTimetable() {
    const trains = getTrains();
    const stations = getStationOrder();
    const current = nowMinutes();

    if (!trains.length) {
      dom.thead.innerHTML = '';
      dom.tbody.innerHTML =
        '<tr><td style="padding:40px;text-align:center;color:#9BA1A8">No trains for this schedule.</td></tr>';
      return;
    }

    // Route type labels & CSS classes
    const typeInfo = {
      L: { label: 'Local', cls: 'train-local' },
      T: { label: 'Limited', cls: 'train-limited' },
      X: { label: 'Express', cls: 'train-express' },
      S: { label: 'S.County', cls: 'train-south' },
    };

    // Legend
    const legendHtml = `<div class="legend">
      <span class="legend-item"><span class="legend-dot" style="background:var(--local-bg)"></span>Local</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--limited-bg)"></span>Limited</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--express-bg)"></span>Express</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--south-bg)"></span>S.County</span>
    </div>`;

    // Determine "now" column: first train whose last stop hasn't departed yet
    state.nowColIdx = -1;
    for (let i = 0; i < trains.length; i++) {
      const lastMin = getLastStopMinutes(trains[i]);
      if (lastMin >= current) {
        state.nowColIdx = i;
        break;
      }
    }

    // Build header
    let headHtml = '<tr><th>Station</th>';
    for (let i = 0; i < trains.length; i++) {
      const t = trains[i];
      const info = typeInfo[t.type] || typeInfo.L;
      const isPast = getLastStopMinutes(t) < current;
      const isNow = i === state.nowColIdx;
      let cls = info.cls;
      if (isPast) cls += ' past-train';
      if (isNow) cls += ' now-col';
      headHtml += `<th class="${cls}">
        ${t.num}
        <span class="train-type-label">${info.label}</span>
      </th>`;
    }
    headHtml += '</tr>';
    dom.thead.innerHTML = headHtml;

    // Build body
    let bodyHtml = '';
    for (const station of stations) {
      const isNearest = station.origIdx === state.nearestStationIdx;
      let rowCls = isNearest ? ' class="nearest-station"' : '';
      bodyHtml += `<tr${rowCls} data-station-idx="${station.origIdx}">`;
      bodyHtml += `<td>${station.name}</td>`;

      for (let i = 0; i < trains.length; i++) {
        const time = trains[i].times[station.origIdx];
        const isPast = getLastStopMinutes(trains[i]) < current;
        const isNow = i === state.nowColIdx;
        let cls = [];
        if (!time) cls.push('no-stop');
        if (isPast) cls.push('past-train');
        if (isNow) cls.push('now-col');

        // Show real-time delay if available
        const delay = getDelay(trains[i].num, station.origIdx);
        let display = time ? formatTime12(time) : '—';
        let delayHtml = '';
        if (delay && time) {
          const delayMin = Math.round(delay / 60);
          if (delayMin > 0) {
            delayHtml = `<span style="color:var(--red);font-size:10px;display:block">+${delayMin}m</span>`;
          }
        }

        bodyHtml += `<td class="${cls.join(' ')}">${display}${delayHtml}</td>`;
      }
      bodyHtml += '</tr>';
    }
    dom.tbody.innerHTML = bodyHtml;

    // Insert legend before table if not present
    const existing = dom.wrapper.querySelector('.legend');
    if (existing) existing.remove();
    dom.wrapper.insertAdjacentHTML('afterbegin', legendHtml);

    // Re-apply selected station highlight
    if (state.selectedStationIdx >= 0) {
      const selRow = dom.tbody.querySelector(
        `tr[data-station-idx="${state.selectedStationIdx}"]`
      );
      if (selRow) selRow.classList.add('selected-station');
    }

    // Update next train banner
    updateNextTrainBanner(trains, stations, current);

    // Position marker
    updatePositionMarker();
  }

  // ── Timetable Interaction (click to highlight/circle) ──
  function setupTimetableInteraction() {
    dom.tbody.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      const tr = td.closest('tr');
      if (!tr) return;

      const stationIdx = parseInt(tr.dataset.stationIdx, 10);

      // Click on station name (first column) → toggle row highlight
      if (td === tr.cells[0]) {
        // Deselect previous
        const prev = dom.tbody.querySelector('tr.selected-station');
        if (prev) prev.classList.remove('selected-station');

        // Toggle: if clicking the same station, just deselect
        if (state.selectedStationIdx === stationIdx) {
          state.selectedStationIdx = -1;
        } else {
          state.selectedStationIdx = stationIdx;
          tr.classList.add('selected-station');
        }
        return;
      }

      // Click on a time cell → toggle circle on it
      if (td.classList.contains('no-stop')) return;
      td.classList.toggle('circled');
    });
  }

  // ── Next Train Banner ──
  function updateNextTrainBanner(trains, stations, current) {
    if (state.nearestStationIdx < 0) {
      dom.banner.classList.add('hidden');
      document.body.style.setProperty('--banner-height', '0px');
      return;
    }

    // Find next train from nearest station
    let nextTrain = null;
    let nextTime = null;
    for (const train of trains) {
      const time = train.times[state.nearestStationIdx];
      if (!time) continue;
      const min = timeToMinutes(time);
      if (min >= current) {
        nextTrain = train;
        nextTime = time;
        break;
      }
    }

    if (!nextTrain) {
      dom.banner.classList.add('hidden');
      document.body.style.setProperty('--banner-height', '0px');
      return;
    }

    state.nextTrain = nextTrain;

    // Determine destination (last stop)
    const orderedStations = getStationOrder();
    let dest = '';
    for (let i = orderedStations.length - 1; i >= 0; i--) {
      if (nextTrain.times[orderedStations[i].origIdx]) {
        dest = orderedStations[i].name;
        break;
      }
    }

    const typeNames = { L: 'Local', T: 'Limited', X: 'Express', S: 'S.County' };
    dom.bannerNum.textContent = `#${nextTrain.num}`;
    dom.bannerTime.textContent = formatTime12(nextTime);
    dom.bannerDest.textContent = `${typeNames[nextTrain.type] || 'Local'} → ${dest}`;
    dom.banner.classList.remove('hidden');
    document.body.style.setProperty('--banner-height', '52px');
  }

  // ── Auto-scroll ──
  function scrollToNow() {
    const trains = getTrains();
    if (!trains.length) return;

    // Find the column to scroll to
    let targetColIdx = state.nowColIdx >= 0 ? state.nowColIdx : 0;
    // Back up 2 columns so user can see context
    targetColIdx = Math.max(0, targetColIdx - 2);

    const headerCells = dom.thead.querySelectorAll('th');
    const targetCell = headerCells[targetColIdx + 1]; // +1 for station column

    // Find nearest station row for vertical scroll
    let targetRow = null;
    if (state.nearestStationIdx >= 0) {
      targetRow = dom.tbody.querySelector(
        `tr[data-station-idx="${state.nearestStationIdx}"]`
      );
    }

    if (targetCell) {
      const wrapperRect = dom.wrapper.getBoundingClientRect();
      const cellRect = targetCell.getBoundingClientRect();

      // Horizontal scroll
      const scrollLeft =
        dom.wrapper.scrollLeft +
        cellRect.left -
        wrapperRect.left -
        parseInt(getComputedStyle(document.documentElement).getPropertyValue('--station-col-width')) -
        20;

      // Vertical scroll
      let scrollTop = 0;
      if (targetRow) {
        const rowRect = targetRow.getBoundingClientRect();
        scrollTop =
          dom.wrapper.scrollTop +
          rowRect.top -
          wrapperRect.top -
          wrapperRect.height / 3;
      }

      dom.wrapper.scrollTo({
        left: Math.max(0, scrollLeft),
        top: Math.max(0, scrollTop),
        behavior: 'smooth',
      });
    }
  }

  // ── Geolocation ──
  function findNearestStation() {
    if (!state.userLat || !state.data) return;

    const stations = state.data.stations;
    let minDist = Infinity;
    let nearestIdx = -1;

    for (let i = 0; i < stations.length; i++) {
      const dist = haversineDistance(
        state.userLat,
        state.userLon,
        stations[i].lat,
        stations[i].lon
      );
      if (dist < minDist) {
        minDist = dist;
        nearestIdx = i;
      }
    }

    // Only set if within 8km of a station (reasonable for Caltrain corridor)
    if (minDist < 8000) {
      state.nearestStationIdx = nearestIdx;
      dom.stationBadge.classList.remove('hidden');
      dom.stationName.textContent = stations[nearestIdx].name;

      // Detect between-stations
      detectBetweenStations();
    } else {
      state.nearestStationIdx = -1;
      dom.stationBadge.classList.add('hidden');
      state.betweenStations = null;
    }
  }

  function detectBetweenStations() {
    if (!state.userLat || !state.data) return;

    const stations = state.data.stations;
    const userLat = state.userLat;
    const userLon = state.userLon;

    // Find the two closest stations
    const distances = stations.map((s, i) => ({
      idx: i,
      dist: haversineDistance(userLat, userLon, s.lat, s.lon),
    }));
    distances.sort((a, b) => a.dist - b.dist);

    const closest = distances[0];
    const secondClosest = distances[1];

    // Only show between-stations if user is far enough from the closest station
    // and the two closest stations are adjacent
    if (closest.dist > 200 && Math.abs(closest.idx - secondClosest.idx) === 1) {
      const fromIdx = Math.min(closest.idx, secondClosest.idx);
      const toIdx = Math.max(closest.idx, secondClosest.idx);

      // Calculate fraction between the two stations
      const totalDist = haversineDistance(
        stations[fromIdx].lat,
        stations[fromIdx].lon,
        stations[toIdx].lat,
        stations[toIdx].lon
      );

      const fromDist = haversineDistance(
        userLat,
        userLon,
        stations[fromIdx].lat,
        stations[fromIdx].lon
      );

      const fraction = Math.min(1, Math.max(0, fromDist / totalDist));

      state.betweenStations = { fromIdx, toIdx, fraction };
    } else {
      state.betweenStations = null;
    }
  }

  function updatePositionMarker() {
    if (!state.betweenStations) {
      dom.posMarker.classList.add('hidden');
      return;
    }

    const { fromIdx, toIdx, fraction } = state.betweenStations;

    // Find the rows for these stations
    const fromRow = dom.tbody.querySelector(`tr[data-station-idx="${fromIdx}"]`);
    const toRow = dom.tbody.querySelector(`tr[data-station-idx="${toIdx}"]`);

    if (!fromRow || !toRow) {
      dom.posMarker.classList.add('hidden');
      return;
    }

    const fromRect = fromRow.getBoundingClientRect();
    const toRect = toRow.getBoundingClientRect();
    const wrapperRect = dom.wrapper.getBoundingClientRect();

    // Interpolate vertical position
    const fromTop = fromRow.offsetTop + fromRow.offsetHeight / 2;
    const toTop = toRow.offsetTop + toRow.offsetHeight / 2;
    const markerTop = fromTop + (toTop - fromTop) * fraction;

    dom.posMarker.style.top = `${markerTop}px`;
    dom.posMarker.classList.remove('hidden');
  }

  function setupGeolocation() {
    // Check if location was previously enabled
    const locationEnabled = localStorage.getItem('caltrain_location') === 'true';
    if (locationEnabled) {
      startWatchingPosition();
    }
    updateLocationToggle();
  }

  function startWatchingPosition() {
    if (!navigator.geolocation) {
      console.warn('Geolocation not available');
      return;
    }

    if (state.watchId !== null) return;

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.userLat = pos.coords.latitude;
        state.userLon = pos.coords.longitude;
        const prevNearest = state.nearestStationIdx;
        findNearestStation();

        // Re-render if station changed
        if (prevNearest !== state.nearestStationIdx) {
          renderTimetable();
          scrollToNow();
        } else {
          updatePositionMarker();
        }
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 15000,
      }
    );

    localStorage.setItem('caltrain_location', 'true');
    updateLocationToggle();
  }

  function stopWatchingPosition() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    state.nearestStationIdx = -1;
    state.betweenStations = null;
    state.userLat = null;
    state.userLon = null;
    dom.stationBadge.classList.add('hidden');
    dom.posMarker.classList.add('hidden');
    localStorage.setItem('caltrain_location', 'false');
    updateLocationToggle();
    renderTimetable();
  }

  function updateLocationToggle() {
    const on = state.watchId !== null;
    dom.locationToggle.textContent = on ? 'Disable Location' : 'Enable Location';
    dom.locationToggle.classList.toggle('active', on);
  }

  // ── Real-time API (511.org) ──
  function getDelay(trainNum, stationIdx) {
    const key = `${trainNum}_${stationIdx}`;
    return state.realtimeDelays[key] || null;
  }

  async function fetchRealtimeData() {
    if (!state.apiKey) return;

    try {
      // Use 511.org Stop Monitoring API for real-time departures
      // This is a SIRI endpoint that returns JSON
      const url = `https://api.511.org/transit/StopMonitoring?api_key=${encodeURIComponent(state.apiKey)}&agency=CT&format=json`;

      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('Real-time API error:', resp.status);
        return;
      }

      const data = await resp.json();
      processRealtimeData(data);
      dom.rtBadge.classList.remove('hidden');
    } catch (e) {
      // CORS or network error
      console.warn('Real-time fetch failed (CORS or network):', e.message);
      // Try using Trip Updates endpoint as fallback
      tryTripUpdates();
    }
  }

  async function tryTripUpdates() {
    try {
      const url = `https://api.511.org/Transit/TripUpdates?api_key=${encodeURIComponent(state.apiKey)}&agency=CT&format=json`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      processTripUpdates(data);
      dom.rtBadge.classList.remove('hidden');
    } catch (e) {
      console.warn('Trip updates fetch failed:', e.message);
    }
  }

  function processRealtimeData(data) {
    try {
      const deliveries =
        data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || [];
      state.realtimeDelays = {};

      for (const visit of deliveries) {
        const call = visit?.MonitoredVehicleJourney?.MonitoredCall;
        if (!call) continue;

        const delay = call?.DepartureStatus === 'delayed'
          ? (call?.ExpectedDepartureTime && call?.AimedDepartureTime
            ? (new Date(call.ExpectedDepartureTime) - new Date(call.AimedDepartureTime)) / 1000
            : 60)
          : 0;

        if (delay > 0) {
          const trainRef = visit?.MonitoredVehicleJourney?.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || '';
          const stopRef = call?.StopPointRef || '';
          // Map to our data structure if possible
          state.realtimeDelays[`${trainRef}_${stopRef}`] = delay;
        }
      }
    } catch (e) {
      console.warn('Error processing real-time data:', e);
    }
  }

  function processTripUpdates(data) {
    try {
      const entities = data?.entity || [];
      state.realtimeDelays = {};

      for (const entity of entities) {
        const tripUpdate = entity?.tripUpdate;
        if (!tripUpdate) continue;

        const tripId = tripUpdate.trip?.tripId || '';
        const stopTimeUpdates = tripUpdate.stopTimeUpdate || [];

        for (const stu of stopTimeUpdates) {
          const delay = stu.departure?.delay || stu.arrival?.delay || 0;
          if (delay > 0) {
            const stopId = stu.stopId || '';
            state.realtimeDelays[`${tripId}_${stopId}`] = delay;
          }
        }
      }
    } catch (e) {
      console.warn('Error processing trip updates:', e);
    }
  }

  function startRealtimePolling() {
    if (!state.apiKey) return;
    fetchRealtimeData();
    // Poll every 30 seconds (within 60/hour rate limit)
    setInterval(() => {
      fetchRealtimeData().then(() => renderTimetable());
    }, 30000);
  }

  // ── Clock ──
  function updateClock() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    dom.clock.textContent = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  // ── Settings ──
  function setupSettings() {
    // Load saved API key
    state.apiKey = localStorage.getItem('caltrain_apikey') || '';
    dom.apiKeyInput.value = state.apiKey;

    // Settings button
    $('#settings-btn').addEventListener('click', () => {
      dom.settingsOverlay.classList.remove('hidden');
    });

    // Close settings
    $('#settings-close').addEventListener('click', () => {
      dom.settingsOverlay.classList.add('hidden');
      saveSettings();
    });

    // Click outside to close
    dom.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === dom.settingsOverlay) {
        dom.settingsOverlay.classList.add('hidden');
        saveSettings();
      }
    });

    // Location toggle
    dom.locationToggle.addEventListener('click', () => {
      if (state.watchId !== null) {
        stopWatchingPosition();
      } else {
        startWatchingPosition();
      }
    });

    // Refresh data button
    $('#refresh-data-btn').addEventListener('click', async () => {
      const btn = $('#refresh-data-btn');
      btn.textContent = 'Checking...';
      btn.disabled = true;
      try {
        const resp = await fetch('data/schedule.json', { cache: 'reload' });
        state.data = await resp.json();
        renderTimetable();
        btn.textContent = 'Data is up to date';
      } catch (e) {
        btn.textContent = 'Update failed';
      }
      setTimeout(() => {
        btn.textContent = 'Check for Updates';
        btn.disabled = false;
      }, 3000);
    });
  }

  function saveSettings() {
    const newKey = dom.apiKeyInput.value.trim();
    if (newKey !== state.apiKey) {
      state.apiKey = newKey;
      localStorage.setItem('caltrain_apikey', newKey);
      if (newKey) {
        startRealtimePolling();
      } else {
        dom.rtBadge.classList.add('hidden');
        state.realtimeDelays = {};
        renderTimetable();
      }
    }
  }

  // ── Tab switching ──
  function setupTabs() {
    $$('.direction-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.direction-tabs .tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.direction = tab.dataset.dir;
        renderTimetable();
        // Brief delay to let DOM update, then scroll
        requestAnimationFrame(() => scrollToNow());
      });
    });
  }

  // ── Banner scroll button ──
  function setupBanner() {
    dom.bannerScroll.addEventListener('click', () => {
      scrollToNow();
    });
  }

  // ── PWA Install Prompt ──
  let deferredPrompt = null;

  function setupPWA() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;

      // Show install banner if not dismissed
      if (localStorage.getItem('caltrain_install_dismissed') !== 'true') {
        showInstallPrompt();
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  function showInstallPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'install-prompt';
    prompt.innerHTML = `
      <span class="install-prompt-text">Add Caltrain Live to your home screen</span>
      <button class="install-btn" id="install-accept">Install</button>
      <button class="dismiss-btn" id="install-dismiss">Later</button>
    `;
    document.body.appendChild(prompt);

    prompt.querySelector('#install-accept').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') {
          prompt.remove();
        }
        deferredPrompt = null;
      }
    });

    prompt.querySelector('#install-dismiss').addEventListener('click', () => {
      prompt.remove();
      localStorage.setItem('caltrain_install_dismissed', 'true');
    });
  }

  // ── Periodic refresh ──
  function startPeriodicRefresh() {
    // Update clock every second
    setInterval(updateClock, 1000);

    // Re-render timetable every minute (to update "now" column)
    setInterval(() => {
      renderTimetable();
    }, 60000);
  }

  // ── Adjust header height ──
  function measureHeader() {
    const header = $('#header');
    const height = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--header-height', `${height}px`);
  }

  // ── Initialize ──
  async function init() {
    cacheDom();
    updateClock();
    detectScheduleType();
    setupTabs();
    setupSettings();
    setupBanner();
    setupPWA();
    measureHeader();

    window.addEventListener('resize', measureHeader);

    const loaded = await loadData();
    if (!loaded) return;

    dom.loading.classList.add('hidden');
    renderTimetable();
    setupTimetableInteraction();
    setupGeolocation();

    // Start real-time if API key is stored
    if (state.apiKey) {
      startRealtimePolling();
    }

    startPeriodicRefresh();

    // Initial scroll after a brief delay
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToNow());
    });
  }

  // Go!
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

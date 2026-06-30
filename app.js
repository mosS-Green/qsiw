/* ═══════════════════════════════════════════════════════════════
   QSI Dashboard PWA — Core Client Logic
   ═══════════════════════════════════════════════════════════════ */

// Initialize global session state
window.qsiSession = {
  data: null,
  fileName: '',
  selectedMonth: new Date().getMonth(), // 0-11
  selectedYear: new Date().getFullYear(),
  pmQHourData: null, // Cache { visits, approvedWir }
  pmQHourHolidays: parseInt(localStorage.getItem('qsi_pmqhour_holidays')) || 0,
  tncp: parseInt(localStorage.getItem('qsi_tncp')) || 0, // Total NCs Closed Previously
  fncp: parseInt(localStorage.getItem('qsi_fncp')) || 0, // Fatal/Critical NCs Closed Previously
  tgBotToken: localStorage.getItem('qsi_tg_bot_token') || '',
  tgChatId: localStorage.getItem('qsi_tg_chat_id') || '',
  lastMetrics: null
};

// PM Q-hour API config constants
const PM_QHOUR_QTARGET = 25;
const PM_QHOUR_API_BASE = 'https://quality.godrejproperties.com:8092/api/api/PMCheck';
const PM_QHOUR_REGION_ID = '5045';
const PM_QHOUR_PROJECT_ID = '76';
const PM_QHOUR_USER_ID = '28044';

// Allowed creators list for Panel 1 (preserved double spaces)
const ALLOWED_CREATORS = new Set([
  "Abdul  Mannan",
  "Md Rahbar Zamir",
  "Neeraj  Kumar",
  "Nilendra Mishra",
  "Sandeep Saini",
  "Ashish Saini",
  "Ankur Saxena",
  "Kartik Mittal",
  "Beekam Chandra Yadav"
]);

// ── Service Worker Registration ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('ServiceWorker registered with scope:', reg.scope);
    } catch (err) {
      console.error('ServiceWorker registration failed:', err);
    }
  });
}

// ── Connection Status Handling ───────────────────────────────
function updateOnlineStatus() {
  const offlineBanner = document.getElementById('offline-banner');
  if (offlineBanner) {
    if (navigator.onLine) {
      offlineBanner.classList.add('hidden');
    } else {
      offlineBanner.classList.remove('hidden');
    }
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ── Toast Snackbar Notification Helper ────────────────────────
function showSnackbar(text, duration = 3000) {
  const snackbar = document.getElementById('snackbar');
  const snackbarText = document.getElementById('snackbar-text');
  if (snackbar && snackbarText) {
    snackbarText.textContent = text;
    snackbar.classList.remove('hidden');
    setTimeout(() => {
      snackbar.classList.add('hidden');
    }, duration);
  }
}

// ── Helper to calculate percentage without rounding up to 100 ─
function safePercent(part, total) {
  if (total <= 0) return 0;
  if (part >= total) return Math.round((part / total) * 100);
  const p = Math.round((part / total) * 100);
  return p >= 100 ? 99 : p;
}

// ── Helper to count working days (Mon-Fri) ────────────────────
function countWorkingDays(fromDate, toDate) {
  let count = 0;
  const d = new Date(fromDate);
  while (d <= toDate) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ── Helper to format date for PM Check API ────────────────────
function formatDateForAPI(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Fetch PM Q-hour API Data ──────────────────────────────────
async function fetchPMQHourData(fromDate, toDate) {
  const from = formatDateForAPI(fromDate);
  const to = formatDateForAPI(toDate);
  try {
    const [visitRes, wirRes] = await Promise.all([
      fetch(`${PM_QHOUR_API_BASE}/PMCHourVisitData?fromDate=${from}&toDate=${to}&RegionId=${PM_QHOUR_REGION_ID}&ProjectId=${PM_QHOUR_PROJECT_ID}&userId=${PM_QHOUR_USER_ID}`),
      fetch(`${PM_QHOUR_API_BASE}/WirApprovedDashborad?fromDate=${from}&toDate=${to}&RegionId=${PM_QHOUR_REGION_ID}&ProjectId=${PM_QHOUR_PROJECT_ID}&userId=${PM_QHOUR_USER_ID}`)
    ]);
    const visitJson = await visitRes.json();
    const wirJson = await wirRes.json();
    const visits = (visitJson?.data?.[0]) ? visitJson.data[0].count : 0;
    const approvedWir = (wirJson?.data?.[0]) ? wirJson.data[0].approvedWirCount : 0;
    return { visits, approvedWir, fetched: true };
  } catch (err) {
    console.error('PM Q-hour API fetch failed:', err);
    return { visits: 0, approvedWir: 0, fetched: false, error: err.message };
  }
}

// ── Fetch Pinned Report File from Telegram Bot API ─────────────
async function loadFileFromTelegram() {
  const token = window.qsiSession.tgBotToken.trim();
  const chatId = window.qsiSession.tgChatId.trim();

  if (!token || !chatId) {
    showTelegramConfigOverlay();
    return;
  }

  showSnackbar('Fetching latest pinned message from Telegram…', 4000);

  try {
    // 1. Get Chat details to retrieve the latest pinned message ID
    const chatRes = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${chatId}`);
    const chatData = await chatRes.json();

    if (!chatData.ok) {
      throw new Error(chatData.description || 'Failed to fetch chat details.');
    }

    const pinnedMessage = chatData.result?.pinned_message;
    if (!pinnedMessage) {
      throw new Error('No pinned message found in this chat/channel.');
    }

    const documentInfo = pinnedMessage.document;
    if (!documentInfo) {
      throw new Error('The pinned message does not contain a file attachment.');
    }

    const fileId = documentInfo.file_id;
    const fileName = documentInfo.file_name;

    // 2. Call getFile to retrieve the downloadable path
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();

    if (!fileData.ok) {
      throw new Error(fileData.description || 'Failed to retrieve file download path.');
    }

    const filePath = fileData.result.file_path;

    // 3. Fetch the actual file contents (Excel / JSON)
    const downloadRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    const arrayBuffer = await downloadRes.arrayBuffer();

    // 4. Parse using SheetJS or JSON
    let parsedData = [];
    if (fileName.toLowerCase().endsWith('.json')) {
      const decodedText = new TextDecoder().decode(arrayBuffer);
      parsedData = JSON.parse(decodedText);
    } else {
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      parsedData = convertRowsToObjects(sheetRows);
    }

    // Save in session
    window.qsiSession.data = parsedData;
    window.qsiSession.fileName = `Telegram: ${fileName}`;
    showSnackbar('✅ Successfully loaded pinned report file from Telegram!');
    
    // Refresh view
    renderActiveScreen();

    // Auto-refresh PM Q-hour API
    triggerPMQHourRefresh();

  } catch (err) {
    console.error('Telegram load failed:', err);
    showSnackbar(`❌ Telegram Load Error: ${err.message}`, 5000);
  }
}

// Convert Excel Sheet 2D array to object rows
function convertRowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  
  // Find the header row by searching for key header labels
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const row = rows[i] || [];
    const hasKeywords = row.some(cell => {
      if (!cell) return false;
      const str = cell.toString().toLowerCase();
      return str.includes('created on') || str.includes('nc id') || str.includes('status');
    });
    if (hasKeywords) {
      headerRowIndex = i;
      break;
    }
  }
  
  const headers = rows[headerRowIndex].map(h => h ? h.toString().trim() : '');
  const objects = [];
  
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    
    const obj = {};
    headers.forEach((header, colIdx) => {
      if (header) {
        obj[header] = row[colIdx] !== undefined ? row[colIdx] : '';
      }
    });
    objects.push(obj);
  }
  return objects;
}

// ── PM Q-hour Calculations ────────────────────────────────────
function calculatePMQHourMetrics(metrics) {
  const monthIdx = window.qsiSession.selectedMonth;
  const year = window.qsiSession.selectedYear;

  // Period: 26th prevMON to 25th currMON
  let prevMonthIdx = monthIdx - 1;
  let prevYear = year;
  if (prevMonthIdx < 0) { prevMonthIdx = 11; prevYear--; }
  const fullPeriodStart = new Date(prevYear, prevMonthIdx, 26);
  const fullPeriodEnd = new Date(year, monthIdx, 25);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(23, 59, 59, 999);
  const consideredEnd = yesterday > fullPeriodEnd ? fullPeriodEnd : yesterday;
  const consideredStart = new Date(fullPeriodStart);

  const holidays = window.qsiSession.pmQHourHolidays || 0;

  const totalWorkingDaysFull = countWorkingDays(fullPeriodStart, fullPeriodEnd);
  const workingDaysConsidered = countWorkingDays(consideredStart, consideredEnd);
  const effectiveWorkingDays = Math.max(0, workingDaysConsidered - holidays);

  const apiData = window.qsiSession.pmQHourData || { visits: 0, approvedWir: 0, fetched: false };

  const proRataWir = totalWorkingDaysFull > 0
    ? Math.round((PM_QHOUR_QTARGET / totalWorkingDaysFull) * effectiveWorkingDays * 100) / 100
    : 0;

  const visitPercent = safePercent(apiData.visits, effectiveWorkingDays);
  const wirPercent = safePercent(apiData.approvedWir, proRataWir);

  // Ratings calculation matching exactly the desktop rules
  const proRataFor = (qt) => totalWorkingDaysFull > 0 ? (qt / totalWorkingDaysFull) * effectiveWorkingDays : 0;
  let rating = 1;
  if (visitPercent >= 100 && apiData.approvedWir >= proRataFor(25)) rating = 5;
  else if (visitPercent >= 100 && apiData.approvedWir >= proRataFor(20)) rating = 4;
  else if (visitPercent >= 100 && apiData.approvedWir >= proRataFor(15)) rating = 3;
  else if (visitPercent >= 90 && apiData.approvedWir >= proRataFor(10)) rating = 2;

  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtShort = d => `${d.getDate()} ${monthsShort[d.getMonth()]}`;

  return {
    rating,
    visits: apiData.visits,
    approvedWir: apiData.approvedWir,
    effectiveWorkingDays,
    workingDaysConsidered,
    totalWorkingDaysFull,
    proRataWir,
    visitPercent,
    wirPercent,
    holidays,
    fetched: apiData.fetched,
    error: apiData.error,
    consideredPeriod: `${fmtShort(consideredStart)} – ${fmtShort(consideredEnd)}`,
    fullPeriod: `${fmtShort(fullPeriodStart)} – ${fmtShort(fullPeriodEnd)}`
  };
}

// Rating color mapping
function ratingColor(r) {
  if (r >= 5) return '#1b5e20';
  if (r >= 4) return '#2e7d32';
  if (r >= 3) return '#e65100';
  if (r >= 2) return '#f57f17';
  return '#b71c1c';
}

// ── QSI Calculations (Core Metrics Parser) ────────────────────
function calculateQSMetrics() {
  const data = window.qsiSession.data || [];
  const year = window.qsiSession.selectedYear;
  const monthIdx = window.qsiSession.selectedMonth;

  let prevYear = year;
  let prevMonthIdx = monthIdx - 1;
  if (prevMonthIdx < 0) {
    prevMonthIdx = 11;
    prevYear -= 1;
  }

  // Define Reference Date Ranges
  const startDate = new Date(prevYear, prevMonthIdx, 26, 0, 0, 0, 0);
  const endDate = new Date(year, monthIdx, 25, 23, 59, 59, 999);
  const prevEndDate = new Date(prevYear, prevMonthIdx, 25, 23, 59, 59, 999);

  // Date parser helper
  function parseDateStr(str) {
    if (!str) return null;
    const parts = str.toString().trim().split('/');
    if (parts.length === 3) {
      const p0 = parseInt(parts[0], 10);
      const p1 = parseInt(parts[1], 10);
      const p2 = parseInt(parts[2], 10);
      if (p0 > 12) {
        return new Date(p2, p1 - 1, p0); // D/M/YYYY
      } else {
        return new Date(p2, p0 - 1, p1); // M/D/YYYY
      }
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  let panel1Total = 0;
  let panel1NCs = [];
  let panel1Rows = [];

  let panel2CreatedBeforePrev = 0;
  let panel2ApprovedBeforePrev = 0;
  let panel2Approved = 0;

  let panel2FCCreatedBeforePrev = 0;
  let panel2FCApprovedBeforePrev = 0;
  let panel2FCApproved = 0;

  let countAgeGt30 = 0;
  let countAge15To30 = 0;
  let countAge7To15 = 0;
  let countAgeLt7 = 0;
  let panel3Total = 0;

  let sequenceViolationCount = 0;
  let openNCsCount = 0;
  let openNCsData = [];

  let panel2NCs = [];
  let panel2DetailNCs = [];
  let complianceCount = 0;
  let complianceNCs = [];

  data.forEach(row => {
    const createdStr = row["Created On"] || row["Date Of Creation"] || "";
    const updatedStr = row["Updated On"] || row["Date of Resolution"] || "";
    const statusVal = (row["Status"] || "").toString().trim();
    const statusLower = statusVal.toLowerCase();
    const severityLower = (row["NC Severity Name"] || row["Severity"] || "").toString().toLowerCase();
    const creatorVal = (row["NC created By"] || row["Updated By"] || "").toString().trim();
    const descVal = (row["NC"] || row["Description"] || "").toString().toLowerCase();

    const createdDate = parseDateStr(createdStr);
    const updatedDate = parseDateStr(updatedStr);

    // Sequence Violations (contains substring 'sequence violation')
    if (descVal.includes('sequence violation')) {
      sequenceViolationCount++;
    }

    // Compliance NCs (status is 'compliance')
    if (statusLower === 'compliance') {
      complianceCount++;
      complianceNCs.push(row);
    }

    // Open NCs (Added or Rejected status)
    if (statusLower === 'added' || statusLower.includes('reject')) {
      openNCsCount++;
      openNCsData.push(row);
    }

    if (!createdDate) return;

    // Panel 1: Created within current month period by allowed quality staff
    if (createdDate >= startDate && createdDate <= endDate) {
      if (ALLOWED_CREATORS.has(creatorVal)) {
        panel1Total++;
        panel1NCs.push(createdDate);
        panel1Rows.push(row);
      }
    }

    // Panel 2: Discipline (NCs outstanding on 25th prevMonth)
    if (createdDate <= prevEndDate) {
      panel2CreatedBeforePrev++;
      const isApproved = statusLower === 'approved';
      const isFatalOrCritical = severityLower === 'fatal' || severityLower === 'critical';

      if (isFatalOrCritical) {
        panel2FCCreatedBeforePrev++;
      }

      // Approved before the current reporting period started
      if (isApproved && updatedDate && updatedDate <= prevEndDate) {
        panel2ApprovedBeforePrev++;
        if (isFatalOrCritical) {
          panel2FCApprovedBeforePrev++;
        }
      }

      // All currently approved
      if (isApproved) {
        panel2Approved++;
        panel2NCs.push(row);
        if (isFatalOrCritical) {
          panel2FCApproved++;
        }
      }

      // Outstanding detail breakdown (Added & Rejected)
      if (statusLower === 'added' || statusLower === 'rejected') {
        panel2DetailNCs.push(row);
        panel2NCs.push(row);
      }
    }

    // Panel 3: Promptness (Age distribution of approved NCs updated on or after 26th prevMonth)
    if (updatedDate && updatedDate >= startDate) {
      const isApproved = statusLower === 'approved';
      if (isApproved) {
        panel3Total++;
        let age = parseInt(row["Age Of NC(Days)"] || row["Age"], 10);
        if (isNaN(age)) age = 0;

        if (age > 30) {
          countAgeGt30++;
        } else if (age > 15 && age <= 30) {
          countAge15To30++;
        } else if (age > 7 && age <= 15) {
          countAge7To15++;
        } else {
          countAgeLt7++;
        }
      }
    }
  });

  // Calculate Week-wise breakdown (dynamic splits)
  const weeks = [];
  let currentStart = new Date(startDate);
  while (currentStart <= endDate) {
    let currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + 6);
    if (currentEnd > endDate) {
      currentEnd = new Date(endDate);
    }
    weeks.push({
      start: new Date(currentStart),
      end: new Date(currentEnd)
    });
    currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() + 1);
  }

  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const panel1Weeks = weeks.map((w, idx) => {
    const count = panel1NCs.filter(d => d >= w.start && d <= w.end).length;
    const fmt = d => `${d.getDate()} ${monthsShort[d.getMonth()]}`;
    return {
      label: `Week ${idx + 1}`,
      range: `${fmt(w.start)} – ${fmt(w.end)}`,
      count
    };
  });

  // Panel 2 Metrics
  const panel2Total = panel2CreatedBeforePrev - panel2ApprovedBeforePrev;
  const panel2ApprovedInPeriod = panel2Approved - panel2ApprovedBeforePrev;
  const panel2FatalCriticalTotal = panel2FCCreatedBeforePrev - panel2FCApprovedBeforePrev;
  const panel2FatalCriticalApprovedInPeriod = panel2FCApproved - panel2FCApprovedBeforePrev;

  // Previously Closed adjustments (Manual Inputs)
  const tncp = window.qsiSession.tncp || 0;
  const fncp = window.qsiSession.fncp || 0;
  const adjPanel2Total = panel2Total + tncp;
  const adjPanel2Approved = panel2ApprovedInPeriod + tncp;
  const adjPanel2FCTotal = panel2FatalCriticalTotal + fncp;
  const adjPanel2FCApproved = panel2FatalCriticalApprovedInPeriod + fncp;

  // Panel 2 percentage
  const discOverallPct = safePercent(adjPanel2Approved, adjPanel2Total);
  const discFCPct = safePercent(adjPanel2FCApproved, adjPanel2FCTotal);
  const effectiveFCPct = adjPanel2FCTotal === 0 ? 100 : discFCPct;

  // ── Ratings Calculations ────────────────────────────────────
  
  // 1. Red is Good Rating (Daily pro-rata out of target 450)
  const rigTotalDays = Math.round((endDate - startDate) / 86400000) + 1;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const rigConsideredEnd = yesterday > endDate ? endDate : yesterday;
  const rigConsideredDays = Math.round((rigConsideredEnd - startDate) / 86400000) + 1;
  const proRataRig = (target) => rigTotalDays > 0 ? (target / rigTotalDays) * rigConsideredDays : 0;

  let ratingRig = 1;
  if (panel1Total >= proRataRig(450)) ratingRig = 5;
  else if (panel1Total >= proRataRig(360)) ratingRig = 4;
  else if (panel1Total >= proRataRig(281)) ratingRig = 3;
  else if (panel1Total >= proRataRig(230)) ratingRig = 2;

  // 2. Discipline Rating
  let ratingDiscipline = 1;
  if (discOverallPct >= 100 && effectiveFCPct >= 100) ratingDiscipline = 5;
  else if (discOverallPct >= 98 && effectiveFCPct >= 100) ratingDiscipline = 4;
  else if (discOverallPct >= 95 && effectiveFCPct >= 100) ratingDiscipline = 3;
  else if (discOverallPct >= 90 && effectiveFCPct >= 95) ratingDiscipline = 2;

  // 3. Promptness Rating
  let ratingPromptness = 1;
  if (panel3Total === 0) {
    ratingPromptness = 5;
  } else {
    const pTotal = panel3Total;
    const pLt7 = countAgeLt7;
    const pLt15 = countAgeLt7 + countAge7To15;
    const pLt30 = countAgeLt7 + countAge7To15 + countAge15To30;
    const pct7 = pLt7 / pTotal;
    const pct15 = pLt15 / pTotal;
    const pct30 = pLt30 / pTotal;
    
    if (pct15 === 1) {
      ratingPromptness = 4 + pct7;
    } else if (pct30 === 1) {
      ratingPromptness = 3;
    } else if (pct30 >= 0.8) {
      ratingPromptness = 2;
    }
  }
  ratingPromptness = Math.round(ratingPromptness * 10) / 10;

  // 4. Sequence Violation Rating
  let ratingSequence = 1;
  if (sequenceViolationCount === 0) ratingSequence = 5;
  else if (sequenceViolationCount === 1) ratingSequence = 4;
  else if (sequenceViolationCount === 2) ratingSequence = 3;
  else if (sequenceViolationCount === 3) ratingSequence = 2;
  else ratingSequence = 1;

  // Top ageing open NCs
  const openNCs = data.filter(row => {
    const status = (row["Status"] || "").toString().trim().toLowerCase();
    return status !== 'approved';
  });
  const ageGroups = {};
  openNCs.forEach(row => {
    const age = parseInt(row["Age Of NC(Days)"] || row["Age"], 10) || 0;
    if (!ageGroups[age]) ageGroups[age] = 0;
    ageGroups[age]++;
  });
  const topAges = Object.entries(ageGroups)
    .map(([age, count]) => ({ age: parseInt(age), count }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 3);

  // Dynamic weekly targets distribution
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = 450;

  const panel1WeeksWithTargets = panel1Weeks.map((w, idx) => {
    return { ...w, weekStart: weeks[idx].start, weekEnd: weeks[idx].end };
  });

  const lastWeekIdx = panel1WeeksWithTargets.length - 1;
  let passedWeekTotal = 0;
  
  panel1WeeksWithTargets.forEach((w, idx) => {
    if (idx === lastWeekIdx) {
      w.weekTarget = 0;
      w.isPassed = w.weekEnd < today;
      w.isCurrent = !w.isPassed && w.weekStart <= today;
      return;
    }

    if (w.weekEnd < today) {
      w.isPassed = true;
      w.isCurrent = false;
      w.weekTarget = w.count; // Locked
      passedWeekTotal += w.count;
    } else {
      w.isPassed = false;
      w.isCurrent = w.weekStart <= today;
    }
  });

  const remainingBalance = Math.max(0, target - passedWeekTotal);
  let totalRemainingDays = 0;
  const futureWeekDays = [];
  
  panel1WeeksWithTargets.forEach((w, idx) => {
    if (idx === lastWeekIdx || w.isPassed) {
      futureWeekDays.push(0);
      return;
    }
    const weekEffectiveStart = w.isCurrent ? today : w.weekStart;
    const daysInWeek = Math.max(0, Math.round((w.weekEnd - weekEffectiveStart) / 86400000) + 1);
    futureWeekDays.push(daysInWeek);
    totalRemainingDays += daysInWeek;
  });

  panel1WeeksWithTargets.forEach((w, idx) => {
    if (idx === lastWeekIdx || w.isPassed) return;
    if (totalRemainingDays > 0) {
      w.weekTarget = Math.round((remainingBalance / totalRemainingDays) * futureWeekDays[idx]);
    } else {
      w.weekTarget = 0;
    }
  });

  return {
    currMONName: monthsFull[monthIdx] + " " + year,
    prevMONName: monthsFull[prevMonthIdx] + " " + prevYear,
    currMONShort: monthsShort[monthIdx],
    prevMONShort: monthsShort[prevMonthIdx],
    panel1Total,
    panel1Balance: 450 - panel1Total,
    panel1Weeks: panel1WeeksWithTargets,
    panel1Rows,
    panel2Total: adjPanel2Total,
    panel2Approved: adjPanel2Approved,
    panel2Percent: discOverallPct,
    panel2FatalCriticalTotal: adjPanel2FCTotal,
    panel2FatalCriticalApproved: adjPanel2FCApproved,
    panel2FatalCriticalPercent: discFCPct,
    panel2RawTotal: panel2Total,
    panel2RawApproved: panel2ApprovedInPeriod,
    panel2RawFCTotal: panel2FatalCriticalTotal,
    panel2RawFCApproved: panel2FatalCriticalApprovedInPeriod,
    panel3Total,
    countAgeGt30,
    countAge15To30,
    countAge7To15,
    countAgeLt7,
    sequenceViolationCount,
    panel2NCs,
    panel2DetailNCs,
    complianceCount,
    complianceNCs,
    openNCsCount,
    openNCsData,
    topAges,
    // Ratings
    ratingRig,
    ratingDiscipline,
    ratingPromptness,
    ratingSequence
  };
}

// ── Refresh Q-hour Data manually/automatically ───────────────
async function triggerPMQHourRefresh() {
  const refreshBtn = document.getElementById('btn-pmqhour-refresh');
  if (refreshBtn) {
    const icon = refreshBtn.querySelector('.material-icons-round');
    if (icon) icon.style.animation = 'spin 1s linear infinite';
    refreshBtn.disabled = true;
  }

  const monthIdx = window.qsiSession.selectedMonth;
  const year = window.qsiSession.selectedYear;
  let prevMonthIdx = monthIdx - 1;
  let prevYear = year;
  if (prevMonthIdx < 0) { prevMonthIdx = 11; prevYear--; }
  const fromDate = new Date(prevYear, prevMonthIdx, 26);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const toDate = yesterday > new Date(year, monthIdx, 25) ? new Date(year, monthIdx, 25) : yesterday;

  const data = await fetchPMQHourData(fromDate, toDate);
  window.qsiSession.pmQHourData = data;
  
  if (refreshBtn) {
    const icon = refreshBtn.querySelector('.material-icons-round');
    if (icon) icon.style.animation = '';
    refreshBtn.disabled = false;
  }

  renderActiveScreen();
}

// ── Native Sharing & Copy to Clipboard ─────────────────────────
function shareElementAsImage(element, nameHint) {
  showSnackbar('Generating high-quality image…', 3000);

  html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    logging: false,
    onclone: function(clonedDoc) {
      // Inline styles to guarantee accurate capture formatting
      clonedDoc.querySelectorAll('*').forEach(clonedEl => {
        const cs = clonedEl.ownerDocument.defaultView.getComputedStyle(clonedEl);
        clonedEl.style.fontFamily = cs.fontFamily || 'Inter, sans-serif';
        clonedEl.style.fontSize = cs.fontSize;
        clonedEl.style.fontWeight = cs.fontWeight;
        clonedEl.style.color = cs.color;
        clonedEl.style.letterSpacing = cs.letterSpacing;
        clonedEl.style.lineHeight = cs.lineHeight;
        clonedEl.style.backgroundColor = cs.backgroundColor;
        clonedEl.style.borderColor = cs.borderColor;
      });
      // Force correct font ligatures on material icons
      clonedDoc.querySelectorAll('.material-icons-round').forEach(icon => {
        const cs = icon.ownerDocument.defaultView.getComputedStyle(icon);
        icon.style.fontFamily = '"Material Icons Round"';
        icon.style.fontSize = cs.fontSize;
        icon.style.fontFeatureSettings = '"liga"';
      });
    }
  }).then(canvas => {
    return new Promise((resolve) => {
      canvas.toBlob(blob => resolve(blob), 'image/png');
    });
  }).then(async (blob) => {
    const file = new File([blob], `${nameHint || 'capture'}.png`, { type: 'image/png' });

    // Try Web Share API (Primary strategy for Android / PWAs)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'QSI Report Share',
          text: `Check out this captured view for: ${nameHint || 'QSI Metric'}`
        });
        showSnackbar('✅ Shared successfully!');
      } catch (shareErr) {
        // If aborted or failed, fall back
        console.warn('Sharing aborted, falling back to clipboard.', shareErr);
        fallbackCopyToClipboard(blob);
      }
    } else {
      // Fallback: Clipboard or File Download
      fallbackCopyToClipboard(blob, nameHint);
    }
  }).catch(err => {
    console.error('Capture failed:', err);
    showSnackbar('❌ Capture failed: ' + err.message);
  });
}

function fallbackCopyToClipboard(blob, nameHint) {
  if (navigator.clipboard && window.ClipboardItem) {
    const item = new ClipboardItem({ 'image/png': blob });
    navigator.clipboard.write([item]).then(() => {
      showSnackbar('✅ Copied as image to clipboard!');
    }).catch(err => {
      console.warn('Clipboard write failed:', err);
      fallbackDownload(blob, nameHint);
    });
  } else {
    fallbackDownload(blob, nameHint);
  }
}

function fallbackDownload(blob, nameHint) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nameHint || 'capture'}_${Date.now()}.png`;
  a.click();
  URL.revokeObjectURL(url);
  showSnackbar('✅ Downloaded as PNG file!');
}

// ── Screen Rendering Methods ──────────────────────────────────

function renderActiveScreen() {
  const hash = window.location.hash || '#/qsi-dashboard';
  const container = document.getElementById('screen-container');

  if (!container) return;

  if (hash.startsWith('#/qsi-detail/')) {
    const type = hash.replace('#/qsi-detail/', '');
    renderDetailScreen(container, type);
  } else {
    renderDashboardScreen(container);
  }
}

// 1. Dashboard Main View Screen
function renderDashboardScreen(container) {
  if (!window.qsiSession.data) {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; text-align:center; padding:32px">
        <div class="card-elevated" style="max-width:500px; padding:40px; display:flex; flex-direction:column; align-items:center; gap:20px">
          <span class="material-icons-round" style="font-size:72px; color:var(--md-primary)">analytics</span>
          <h2 class="headline-small" style="font-weight:600">QSi Dashboard</h2>
          <p class="body-medium" style="color:var(--md-on-surface-variant)">Select a month and import a quality NC report spreadsheet (Excel or JSON) to view key Quality Status Indicators.</p>
          
          <div class="flex-col gap-12 w-full">
            <button class="btn btn-filled w-full" id="btn-load-local-file">
              <span class="material-icons-round">upload_file</span>
              <span>Load Local File</span>
            </button>
            <button class="btn btn-outlined w-full" id="btn-load-tg-file">
              <span class="material-icons-round">telegram</span>
              <span>Load Pinned File via Telegram</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Local file loader fallback
    container.querySelector('#btn-load-local-file').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx,.xls,.json';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        showSnackbar('Parsing spreadsheet…');
        const reader = new FileReader();
        reader.onload = evt => {
          try {
            const arrayBuffer = evt.target.result;
            let parsed = [];
            if (file.name.toLowerCase().endsWith('.json')) {
              const text = new TextDecoder().decode(arrayBuffer);
              parsed = JSON.parse(text);
            } else {
              const workbook = XLSX.read(arrayBuffer, { type: 'array' });
              const sheetName = workbook.SheetNames[0];
              const worksheet = workbook.Sheets[sheetName];
              const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
              parsed = convertRowsToObjects(sheetRows);
            }
            window.qsiSession.data = parsed;
            window.qsiSession.fileName = file.name;
            showSnackbar('✅ Report file parsed successfully!');
            renderActiveScreen();
            triggerPMQHourRefresh();
          } catch (err) {
            showSnackbar('❌ Parsing Error: ' + err.message);
          }
        };
        reader.readAsArrayBuffer(file);
      };
      input.click();
    });

    container.querySelector('#btn-load-tg-file').addEventListener('click', loadFileFromTelegram);
    return;
  }

  // Calculate session metrics
  const metrics = calculateQSMetrics();
  window.qsiSession.lastMetrics = metrics;
  
  const pm = calculatePMQHourMetrics(metrics);
  const qsiInputScore = ((metrics.ratingRig * 5) + (metrics.ratingDiscipline * 5) + (metrics.ratingPromptness * 5) + (pm.rating * 10) + (metrics.ratingSequence * 5)) / 30;

  container.innerHTML = `
    <div class="screen-padded" style="padding-top:16px">
      <div style="display:flex; flex-direction:column; gap:24px">
        <!-- Dashboard Summary Header -->
        <div class="card-filled" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px">
          <div>
            <div class="label-small" style="font-weight:700; color:var(--md-on-surface-variant)">REPORTING PERIOD</div>
            <div class="headline-small" style="font-weight:800; color:var(--md-primary)">
              ${metrics.currMONName} (26 ${metrics.prevMONShort} – 25 ${metrics.currMONShort})
            </div>
          </div>
          <div style="text-align:center">
            <div class="label-small" style="font-weight:700; color:var(--md-on-surface-variant)">QSI INPUT SCORE</div>
            <div class="display-medium" style="font-weight:900; color:var(--md-primary)">
              ${qsiInputScore.toFixed(2)} <span class="title-medium" style="color:var(--md-on-surface-variant)">/ 5</span>
            </div>
          </div>
          <div style="text-align:right">
            <div class="label-small" style="font-weight:700; color:var(--md-on-surface-variant)">ACTIVE REPORT</div>
            <div class="body-medium" style="font-weight:700; color:var(--md-on-surface); font-family:monospace">
              ${window.qsiSession.fileName}
            </div>
          </div>
        </div>

        <!-- Metric Grid -->
        <div class="dashboard-grid">
          
          <!-- Panel 1: Red is Good -->
          <div class="card-elevated" id="panel-red-is-good" style="display:flex; flex-direction:column; gap:12px">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:var(--md-primary); font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:#c62828">check_circle</span>
                <span>1. Red is Good</span>
              </h3>
              <div style="display:flex; align-items:center; gap:8px">
                <button class="icon-btn copy-img-btn" data-target="panel-red-is-good" title="Share/Copy Panel">
                  <span class="material-icons-round" style="font-size:18px">share</span>
                </button>
                <span class="label-large" style="background:#ffebee; color:#c62828; padding:4px 10px; border-radius:var(--radius-sm); font-weight:700">Target: 450</span>
              </div>
            </div>
            
            <div style="background:linear-gradient(135deg, ${ratingColor(metrics.ratingRig)}11, ${ratingColor(metrics.ratingRig)}22); padding:14px; border-radius:var(--radius-md); border:1px solid ${ratingColor(metrics.ratingRig)}44; display:flex; justify-content:space-between; align-items:center">
              <span class="label-small" style="color:var(--md-on-surface-variant)">RATING</span>
              <div class="display-small" style="font-weight:900; color:${ratingColor(metrics.ratingRig)}">${metrics.ratingRig}/5</div>
            </div>
            
            <div style="display:flex; gap:24px; align-items:center; margin-top:8px">
              <div style="flex:1">
                <div class="display-small" style="font-weight:800; color:#c62828">${metrics.panel1Total}</div>
                <div class="label-small" style="color:var(--md-on-surface-variant); margin-top:4px">TOTAL NCs CREATED</div>
              </div>
              <div style="width:2px; height:50px; background:var(--md-outline-variant)"></div>
              <div style="flex:1.2">
                <div class="title-large" style="font-weight:800; color:${metrics.panel1Balance >= 0 ? 'var(--status-complete-text)' : '#c62828'}">
                  ${metrics.panel1Balance >= 0 ? `+${metrics.panel1Balance} (Left)` : metrics.panel1Balance}
                </div>
                <div class="label-small" style="color:var(--md-on-surface-variant); margin-top:4px">BALANCE REMAINING</div>
              </div>
            </div>

            <div class="progress-bar" style="margin-top:8px">
              <div class="fill" style="width:${Math.min(100, (metrics.panel1Total / 450) * 100)}%; background:#c62828"></div>
            </div>

            <!-- Weekly Split breakdown -->
            <div style="margin-top:12px">
              <div class="label-medium" style="color:var(--md-on-surface-variant); margin-bottom:8px">WEEK-WISE BREAKDOWN:</div>
              <div style="display:flex; flex-direction:column; gap:6px">
                ${metrics.panel1Weeks.map((w, idx) => {
                  const isLast = idx === metrics.panel1Weeks.length - 1;
                  const metTarget = w.count >= w.weekTarget;
                  const countColor = isLast ? 'var(--md-on-surface-variant)' : (metTarget ? '#1b5e20' : '#c62828');
                  const bgColor = w.isPassed ? (metTarget ? 'rgba(27,94,32,0.04)' : 'rgba(198,40,40,0.04)') : 'var(--md-surface-container-low)';
                  const statusIcon = w.isPassed ? (metTarget ? '✓' : '✗') : (w.isCurrent ? '●' : '');
                  return `
                    <div class="week-row ${w.isCurrent ? 'current' : ''}" style="background:${bgColor}">
                      <div class="flex-col">
                        <span class="body-medium" style="font-weight:700">${statusIcon ? statusIcon + ' ' : ''}${w.label}${isLast ? ' (Buffer)' : ''}</span>
                        <span class="body-small" style="color:var(--md-on-surface-variant)">(${w.range})</span>
                      </div>
                      <div class="flex items-center gap-4">
                        <span class="title-medium" style="font-weight:800; color:${countColor}">${w.count}</span>
                        ${!isLast ? `<span class="label-small" style="color:var(--md-on-surface-variant)">/ ${w.weekTarget}</span>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>

          <!-- Panel 2: Discipline -->
          <div class="card-elevated" id="panel-discipline" style="display:flex; flex-direction:column; gap:12px; cursor:pointer" onclick="window.location.hash = '#/qsi-detail/discipline'">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:var(--md-primary); font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:var(--status-complete-text)">gavel</span>
                <span>2. Discipline</span>
              </h3>
              <button class="icon-btn copy-img-btn" data-target="panel-discipline" title="Share/Copy Panel" onclick="event.stopPropagation()">
                <span class="material-icons-round" style="font-size:18px">share</span>
              </button>
            </div>
            <p class="body-small" style="color:var(--md-on-surface-variant); margin-top:-4px">
              NC approval rates for issues created on or before 25th of ${metrics.prevMONName}, updated on or after 26th.
            </p>

            <div style="background:linear-gradient(135deg, ${ratingColor(metrics.ratingDiscipline)}11, ${ratingColor(metrics.ratingDiscipline)}22); padding:14px; border-radius:var(--radius-md); border:1px solid ${ratingColor(metrics.ratingDiscipline)}44; display:flex; justify-content:space-between; align-items:center">
              <span class="label-small" style="color:var(--md-on-surface-variant)">RATING</span>
              <div class="display-small" style="font-weight:900; color:${ratingColor(metrics.ratingDiscipline)}">${metrics.ratingDiscipline}/5</div>
            </div>

            <!-- Overall App -->
            <div style="background:var(--md-surface-container-low); padding:12px; border-radius:var(--radius-md); display:flex; justify-content:space-between; align-items:center; border:1px solid var(--md-outline-variant)">
              <div>
                <span class="label-small" style="color:var(--md-on-surface-variant)">OVERALL NC APPROVALS</span>
                <div class="title-large" style="font-weight:800; margin-top:4px">${metrics.panel2Approved} / ${metrics.panel2Total}</div>
              </div>
              <span class="headline-medium" style="font-weight:800; color:var(--status-complete-text)">${metrics.panel2Percent}%</span>
            </div>

            <!-- Fatal & Critical App -->
            <div style="background:var(--md-surface-container-low); padding:12px; border-radius:var(--radius-md); display:flex; justify-content:space-between; align-items:center; border:1px solid var(--md-outline-variant)">
              <div>
                <span class="label-small" style="color:var(--md-on-surface-variant)">FATAL & CRITICAL ONLY</span>
                <div class="title-large" style="font-weight:800; margin-top:4px">${metrics.panel2FatalCriticalApproved} / ${metrics.panel2FatalCriticalTotal}</div>
              </div>
              <span class="headline-medium" style="font-weight:800; color:var(--md-error)">${metrics.panel2FatalCriticalPercent}%</span>
            </div>

            <!-- Manual adjustments -->
            <div style="background:var(--md-surface-container-low); padding:12px; border-radius:var(--radius-md); border:1px solid var(--md-outline-variant); display:flex; flex-direction:column; gap:8px" onclick="event.stopPropagation()">
              <span class="label-small" style="color:var(--md-on-surface-variant)">PREVIOUSLY CLOSED (MANUAL INPUTS)</span>
              <div class="flex gap-12">
                <div style="flex:1; display:flex; align-items:center; gap:6px">
                  <label class="label-small" style="white-space:nowrap">TNCP:</label>
                  <input type="number" id="input-tncp" value="${window.qsiSession.tncp}" min="0" style="width:100%; height:32px; border:1px solid var(--md-outline-variant); border-radius:var(--radius-sm); text-align:center; font-weight:700">
                </div>
                <div style="flex:1; display:flex; align-items:center; gap:6px">
                  <label class="label-small" style="white-space:nowrap">FNCP:</label>
                  <input type="number" id="input-fncp" value="${window.qsiSession.fncp}" min="0" style="width:100%; height:32px; border:1px solid var(--md-outline-variant); border-radius:var(--radius-sm); text-align:center; font-weight:700">
                </div>
              </div>
            </div>

            <!-- Compliance Subpanel navigation link -->
            <div class="compliance-subpanel" onclick="event.stopPropagation(); window.location.hash = '#/qsi-detail/compliance'">
              <div style="display:flex; align-items:center; gap:12px">
                <div style="width:40px; height:40px; border-radius:var(--radius-sm); background:linear-gradient(135deg, #1565c0, #0d47a1); display:flex; align-items:center; justify-content:center; flex-shrink:0">
                  <span class="material-icons-round" style="color:#fff; font-size:20px">verified</span>
                </div>
                <div style="flex:1">
                  <div class="label-small" style="color:var(--md-on-surface-variant)">COMPLIANCE STATUS</div>
                  <div class="title-medium" style="font-weight:700; color:#0d47a1">Compliance</div>
                </div>
                <div style="text-align:right; padding-right:8px">
                  <div class="title-large" style="font-weight:800; color:#1565c0">${metrics.complianceCount}</div>
                  <span class="label-small">NCs</span>
                </div>
                <span class="material-icons-round" style="color:var(--md-outline)">chevron_right</span>
              </div>
            </div>
          </div>

          <!-- Panel 3: Promptness -->
          <div class="card-elevated" id="panel-promptness" style="display:flex; flex-direction:column; gap:12px">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:var(--md-primary); font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:var(--md-tertiary)">schedule</span>
                <span>3. Promptness</span>
              </h3>
              <button class="icon-btn copy-img-btn" data-target="panel-promptness" title="Share/Copy Panel">
                <span class="material-icons-round" style="font-size:18px">share</span>
              </button>
            </div>
            <p class="body-small" style="color:var(--md-on-surface-variant); margin-top:-4px">
              Age distribution of 'Approved' NCs updated on or after 26th of ${metrics.prevMONName}.
            </p>

            <div style="background:linear-gradient(135deg, ${ratingColor(metrics.ratingPromptness)}11, ${ratingColor(metrics.ratingPromptness)}22); padding:14px; border-radius:var(--radius-md); border:1px solid ${ratingColor(metrics.ratingPromptness)}44; display:flex; justify-content:space-between; align-items:center">
              <span class="label-small" style="color:var(--md-on-surface-variant)">RATING</span>
              <div class="display-small" style="font-weight:900; color:${ratingColor(metrics.ratingPromptness)}">${metrics.ratingPromptness}/5</div>
            </div>

            <!-- Age Brackets -->
            <div style="display:flex; flex-direction:column; gap:10px; margin-top:8px">
              ${renderAgeBracketRow("Age > 30 days", metrics.countAgeGt30, metrics.panel3Total, "#b71c1c")}
              ${renderAgeBracketRow("15 < Age <= 30 days", metrics.countAge15To30, metrics.panel3Total, "#e65100")}
              ${renderAgeBracketRow("7 < Age <= 15 days", metrics.countAge7To15, metrics.panel3Total, "#f57f17")}
              ${renderAgeBracketRow("Age <= 7 days", metrics.countAgeLt7, metrics.panel3Total, "#1b5e20")}
            </div>

            <div style="margin-top:8px; border-top:1px solid var(--md-outline-variant); padding-top:12px; display:flex; justify-content:space-between">
              <span class="label-large" style="color:var(--md-on-surface-variant)">Total Approved in Period</span>
              <span class="label-large" style="font-weight:800; color:var(--md-primary)">${metrics.panel3Total}</span>
            </div>

            <!-- Top Ageing Open NCs Warning -->
            ${metrics.topAges && metrics.topAges.length > 0 ? `
              <div style="margin-top:12px; border-top:2px solid #e65100; padding-top:12px">
                <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px">
                  <span class="material-icons-round" style="color:#e65100; font-size:18px">warning</span>
                  <span class="label-medium" style="color:#e65100; font-weight:700">TOP AGEING OPEN NCs</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px">
                  ${metrics.topAges.map(a => `
                    <div class="flex justify-between items-center" style="padding:8px 12px; background:rgba(230,81,0,0.06); border-radius:var(--radius-sm); border-left:3px solid ${a.age >= 26 ? '#b71c1c' : '#e65100'}">
                      <span class="body-medium" style="font-weight:700; color:${a.age >= 26 ? '#b71c1c' : '#e65100'}">${a.age >= 26 ? '⚠ ' : ''}${a.age} days</span>
                      <span class="body-medium" style="font-weight:800; color:#e65100">${a.count} NCs</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>

          <!-- Panel 4: PM Q-hour -->
          <div class="card-elevated" id="panel-pmqhour" style="display:flex; flex-direction:column; gap:12px">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:var(--md-primary); font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:#6a1b9a">access_time</span>
                <span>4. PM Q-hour</span>
              </h3>
              <div style="display:flex; align-items:center; gap:6px">
                <button class="icon-btn" id="btn-pmqhour-refresh" title="Refresh API data">
                  <span class="material-icons-round" style="font-size:18px">refresh</span>
                </button>
                <button class="icon-btn copy-img-btn" data-target="panel-pmqhour" title="Share/Copy Panel">
                  <span class="material-icons-round" style="font-size:18px">share</span>
                </button>
              </div>
            </div>
            <div class="body-small" style="color:var(--md-on-surface-variant); margin-top:-4px">
              Period: <strong>${pm.consideredPeriod}</strong> | Target: <strong>${PM_QHOUR_QTARGET}</strong>
            </div>

            ${!pm.fetched ? `
              <div style="text-align:center; padding:20px; color:var(--md-on-surface-variant)">
                <span class="material-icons-round" style="font-size:40px; display:block; margin-bottom:8px; color:var(--md-outline-variant)">cloud_off</span>
                <div class="body-medium">Q-hour API data not loaded</div>
                <button class="btn btn-outlined" id="btn-pmqhour-refresh-empty" style="margin-top:12px">Fetch API Data</button>
              </div>
            ` : `
              <div style="background:linear-gradient(135deg, ${ratingColor(pm.rating)}11, ${ratingColor(pm.rating)}22); padding:14px; border-radius:var(--radius-md); border:1px solid ${ratingColor(pm.rating)}44; display:flex; justify-content:space-between; align-items:center">
                <span class="label-small" style="color:var(--md-on-surface-variant)">RATING</span>
                <div class="display-small" style="font-weight:900; color:${ratingColor(pm.rating)}">${pm.rating}/5</div>
              </div>

              <!-- Metric counters -->
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
                <div style="background:var(--md-surface-container-low); padding:10px 14px; border-radius:var(--radius-md); border:1px solid var(--md-outline-variant)">
                  <span class="label-small" style="color:var(--md-on-surface-variant)">VISITS</span>
                  <div class="title-large" style="font-weight:800; margin-top:4px">${pm.visits} / ${pm.effectiveWorkingDays}</div>
                  <div class="body-small" style="color:${pm.visitPercent >= 100 ? '#1b5e20' : pm.visitPercent >= 90 ? '#e65100' : '#b71c1c'}; font-weight:700; margin-top:2px">${pm.visitPercent}%</div>
                </div>
                <div style="background:var(--md-surface-container-low); padding:10px 14px; border-radius:var(--radius-md); border:1px solid var(--md-outline-variant)">
                  <span class="label-small" style="color:var(--md-on-surface-variant)">APPROVED WIRs</span>
                  <div class="title-large" style="font-weight:800; margin-top:4px">${pm.approvedWir} / ${pm.proRataWir.toFixed(1)}</div>
                  <div class="body-small" style="color:${pm.wirPercent >= 100 ? '#1b5e20' : '#b71c1c'}; font-weight:700; margin-top:2px">${pm.wirPercent}% of pro-rata</div>
                </div>
              </div>

              <!-- Holidays configuration -->
              <div style="background:var(--md-surface-container-low); padding:10px 14px; border-radius:var(--radius-md); border:1px solid var(--md-outline-variant); display:flex; justify-content:space-between; align-items:center">
                <div class="flex-col">
                  <span class="label-small" style="color:var(--md-on-surface-variant)">LEAVES / HOLIDAYS</span>
                  <span class="body-small" style="color:var(--md-on-surface-variant)">Reduces working days (${pm.workingDaysConsidered}d → ${pm.effectiveWorkingDays}d)</span>
                </div>
                <div class="flex items-center gap-8">
                  <button class="icon-btn" id="btn-pm-minus" style="width:28px; height:28px; border:1px solid var(--md-outline-variant)">
                    <span class="material-icons-round" style="font-size:16px">remove</span>
                  </button>
                  <span class="title-medium" style="font-weight:800; min-width:24px; text-align:center">${pm.holidays}</span>
                  <button class="icon-btn" id="btn-pm-plus" style="width:28px; height:28px; border:1px solid var(--md-outline-variant)">
                    <span class="material-icons-round" style="font-size:16px">add</span>
                  </button>
                </div>
              </div>
            `}
          </div>

          <!-- Panel 5: Sequence Violations -->
          <div class="card-elevated" id="panel-sequence" style="display:flex; flex-direction:column; gap:12px; background:#fffde7">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:#b26a00; font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:#b26a00">report_problem</span>
                <span>5. Sequence Violation</span>
              </h3>
              <button class="icon-btn copy-img-btn" data-target="panel-sequence" title="Share/Copy Panel">
                <span class="material-icons-round" style="font-size:18px">share</span>
              </button>
            </div>

            <div style="background:linear-gradient(135deg, ${ratingColor(metrics.ratingSequence)}11, ${ratingColor(metrics.ratingSequence)}22); padding:14px; border-radius:var(--radius-md); border:1px solid ${ratingColor(metrics.ratingSequence)}44; display:flex; justify-content:space-between; align-items:center">
              <span class="label-small" style="color:var(--md-on-surface-variant)">RATING</span>
              <div class="display-small" style="font-weight:900; color:${ratingColor(metrics.ratingSequence)}">${metrics.ratingSequence}/5</div>
            </div>

            <div style="display:flex; align-items:center; justify-content:center; flex:1; min-height:100px">
              <div style="text-align:center">
                <div class="display-small" style="font-weight:900; color:#b26a00">${metrics.sequenceViolationCount}</div>
                <div class="title-small" style="color:var(--md-on-surface); margin-top:8px">Sequence Violations Detected</div>
                <p class="body-small" style="color:var(--md-on-surface-variant); margin-top:4px">Counts occurrences of 'sequence violation' in Description column</p>
              </div>
            </div>
          </div>

          <!-- Panel 6: Open NCs -->
          <div class="card-elevated" id="panel-open-ncs" style="display:flex; flex-direction:column; gap:12px; cursor:pointer" onclick="window.location.hash = '#/qsi-detail/open-ncs'">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3 class="title-large" style="color:#e65100; font-weight:700; display:flex; align-items:center; gap:8px">
                <span class="material-icons-round" style="color:#e65100">warning_amber</span>
                <span>Open NCs</span>
              </h3>
              <button class="icon-btn copy-img-btn" data-target="panel-open-ncs" title="Share/Copy Panel" onclick="event.stopPropagation()">
                <span class="material-icons-round" style="font-size:18px">share</span>
              </button>
            </div>

            <div style="display:flex; align-items:center; justify-content:center; flex:1; min-height:120px">
              <div style="text-align:center">
                <div class="display-large" style="font-weight:900; color:#e65100; line-height:1">${metrics.openNCsCount}</div>
                <div class="title-small" style="color:var(--md-on-surface); margin-top:8px">Total Open NCs</div>
                <p class="body-small" style="color:var(--md-on-surface-variant); margin-top:4px">All currently outstanding Added & Rejected NCs</p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

  // Bind Event Listeners
  const rigInput = container.querySelector('#input-tncp');
  const fcInput = container.querySelector('#input-fncp');
  if (rigInput) {
    rigInput.addEventListener('change', e => {
      const val = Math.max(0, parseInt(e.target.value) || 0);
      window.qsiSession.tncp = val;
      localStorage.setItem('qsi_tncp', val);
      renderDashboardScreen(container);
    });
  }
  if (fcInput) {
    fcInput.addEventListener('change', e => {
      const val = Math.max(0, parseInt(e.target.value) || 0);
      window.qsiSession.fncp = val;
      localStorage.setItem('qsi_fncp', val);
      renderDashboardScreen(container);
    });
  }

  // Bind copy-as-image/share buttons
  container.querySelectorAll('.copy-img-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const targetId = btn.dataset.target;
      const targetEl = container.querySelector(`#${targetId}`);
      if (targetEl) {
        shareElementAsImage(targetEl, targetId);
      }
    });
  });

  // Bind PM Q-hour interactive triggers
  const refreshBtn = container.querySelector('#btn-pmqhour-refresh');
  const refreshEmptyBtn = container.querySelector('#btn-pmqhour-refresh-empty');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerPMQHourRefresh);
  if (refreshEmptyBtn) refreshEmptyBtn.addEventListener('click', triggerPMQHourRefresh);

  const minusBtn = container.querySelector('#btn-pm-minus');
  const plusBtn = container.querySelector('#btn-pm-plus');
  if (minusBtn) {
    minusBtn.addEventListener('click', () => {
      window.qsiSession.pmQHourHolidays = Math.max(0, window.qsiSession.pmQHourHolidays - 1);
      localStorage.setItem('qsi_pmqhour_holidays', window.qsiSession.pmQHourHolidays);
      renderDashboardScreen(container);
    });
  }
  if (plusBtn) {
    plusBtn.addEventListener('click', () => {
      window.qsiSession.pmQHourHolidays += 1;
      localStorage.setItem('qsi_pmqhour_holidays', window.qsiSession.pmQHourHolidays);
      renderDashboardScreen(container);
    });
  }
}

function renderAgeBracketRow(label, count, total, color) {
  const pct = safePercent(count, total);
  return `
    <div>
      <div class="flex justify-between items-center" style="margin-bottom:4px">
        <span class="body-medium" style="font-weight:600">${label}</span>
        <span class="body-medium" style="font-weight:700; color:${color}">${count} (${pct}%)</span>
      </div>
      <div class="progress-bar">
        <div class="fill" style="width:${pct}%; background:${color}"></div>
      </div>
    </div>
  `;
}

// 2. Detail Grid Pivot View Screen
let ageFilter = 'all';

function renderDetailScreen(container, detailType) {
  const metrics = window.qsiSession.lastMetrics;

  if (!metrics) {
    container.innerHTML = `
      <div class="screen-padded" style="text-align:center; padding-top:48px">
        <span class="material-icons-round" style="font-size:64px; color:var(--md-outline)">info</span>
        <p class="title-medium" style="margin-top:16px">No metrics data loaded. Please import a file on the dashboard first.</p>
        <button class="btn btn-filled" style="margin-top:16px" onclick="window.location.hash = '#/qsi-dashboard'">Go to Dashboard</button>
      </div>
    `;
    return;
  }

  let ncRows = [];
  let title = '';
  let iconName = '';
  let iconColor = '';

  if (detailType === 'compliance') {
    ncRows = metrics.complianceNCs || [];
    title = 'Compliance — Contractor Breakdown';
    iconName = 'verified';
    iconColor = '#1565c0';
  } else if (detailType === 'open-ncs') {
    ncRows = metrics.openNCsData || [];
    title = 'Open NCs — Added & Rejected';
    iconName = 'warning_amber';
    iconColor = '#e65100';
  } else {
    // Default: Discipline
    ncRows = metrics.panel2DetailNCs || metrics.panel2NCs || [];
    title = 'Discipline — Contractor Breakdown';
    iconName = 'gavel';
    iconColor = 'var(--status-complete-text)';
  }

  function getFilteredRows() {
    if (ageFilter === 'gt20') return ncRows.filter(r => (parseInt(r["Age Of NC(Days)"] || r["Age"], 10) || 0) > 20);
    if (ageFilter === 'gt35') return ncRows.filter(r => (parseInt(r["Age Of NC(Days)"] || r["Age"], 10) || 0) > 35);
    if (ageFilter === 'lte20') return ncRows.filter(r => (parseInt(r["Age Of NC(Days)"] || r["Age"], 10) || 0) <= 20);
    return ncRows;
  }

  function buildPivotTree(rows) {
    const tree = {};
    rows.forEach(row => {
      const contractor = (row["Contractor Name"] || row["Contractor"] || "Unknown").toString().trim();
      const tower = (row["Tower"] || "Common").toString().trim().replace(/[\r\n]+/g, '');
      const age = parseInt(row["Age Of NC(Days)"] || row["Age"], 10) || 0;
      const nc = (row["NC"] || row["Description"] || "Unknown").toString().trim();
      const ncId = row["NC ID"] || row["Sr No."] || "N/A";

      if (!tree[contractor]) tree[contractor] = {};
      if (!tree[contractor][tower]) tree[contractor][tower] = {};
      if (!tree[contractor][tower][age]) tree[contractor][tower][age] = {};
      if (!tree[contractor][tower][age][nc]) tree[contractor][tower][age][nc] = [];
      tree[contractor][tower][age][nc].push(ncId);
    });
    return tree;
  }

  function countTreeNodes(node) {
    if (Array.isArray(node)) return node.length;
    let count = 0;
    for (const key in node) {
      count += countTreeNodes(node[key]);
    }
    return count;
  }

  function getAgeClass(age) {
    if (age >= 26) return 'age-critical';
    if (age > 20) return 'age-danger';
    return '';
  }

  function drawDetailView() {
    const filtered = getFilteredRows();
    const tree = buildPivotTree(filtered);
    const contractors = Object.keys(tree).sort();

    container.innerHTML = `
      <div class="screen-padded" style="padding-top:12px">
        <!-- Header Nav Bar -->
        <div class="qsi-detail-bar">
          <button class="back-btn" id="btn-detail-back">
            <span class="material-icons-round" style="font-size:18px">arrow_back</span>
            <span>Dashboard</span>
          </button>
          <div style="width:1px; height:24px; background:var(--md-outline-variant)"></div>
          <div class="flex items-center gap-8">
            <span class="material-icons-round" style="color:${iconColor}; font-size:24px">${iconName}</span>
            <span class="title-large" style="font-weight:700; color:${iconColor}">${title}</span>
          </div>
          <span class="label-medium" style="background:var(--md-surface-container-high); padding:3px 12px; border-radius:var(--radius-full)">${filtered.length} NCs</span>
        </div>

        <!-- Filter Chips -->
        <div class="qsi-detail-filters">
          <span class="label-small" style="color:var(--md-on-surface-variant); font-weight:700">Filter by Age:</span>
          <button class="chip qsi-filter-btn ${ageFilter === 'all' ? 'selected' : ''}" data-filter="all">All</button>
          <button class="chip qsi-filter-btn ${ageFilter === 'lte20' ? 'selected' : ''}" data-filter="lte20">≤ 20 days</button>
          <button class="chip qsi-filter-btn ${ageFilter === 'gt20' ? 'selected' : ''}" data-filter="gt20">> 20 days</button>
          <button class="chip qsi-filter-btn ${ageFilter === 'gt35' ? 'selected' : ''}" data-filter="gt35">> 35 days</button>
        </div>

        <!-- Pivot Masonry Grid -->
        ${contractors.length === 0 ? `
          <div style="text-align:center; padding:48px; color:var(--md-on-surface-variant)">
            <span class="material-icons-round" style="font-size:48px; display:block; margin-bottom:12px">filter_list_off</span>
            No NCs match the selected filter.
          </div>
        ` : `
          <div class="qsi-detail-masonry">
            ${contractors.map(contractor => {
              const towers = tree[contractor];
              const towerKeys = Object.keys(towers).sort();
              const contractorTotal = countTreeNodes(towers);
              return `
                <div class="pivot-contractor-card">
                  <!-- L0: Contractor Header -->
                  <div class="pivot-level-header pivot-l0" data-toggle="section">
                    <div class="flex items-center gap-8">
                      <span class="material-icons-round pivot-chevron" style="font-size:18px">expand_more</span>
                      <span class="material-icons-round" style="font-size:18px; color:var(--md-primary)">business</span>
                      <span class="title-small" style="font-weight:700">${contractor}</span>
                    </div>
                    <div class="flex items-center gap-8" onclick="event.stopPropagation()">
                      <span class="label-large" style="font-weight:700; color:var(--md-primary)">${contractorTotal}</span>
                      <button class="icon-btn copy-card-btn" title="Share/Copy Contractor Card">
                        <span class="material-icons-round" style="font-size:16px">share</span>
                      </button>
                    </div>
                  </div>
                  
                  <div class="pivot-children pivot-body">
                    ${towerKeys.map(tower => {
                      const ages = towers[tower];
                      const ageKeys = Object.keys(ages).map(Number).sort((a,b) => b - a);
                      const towerTotal = countTreeNodes(ages);
                      return `
                        <div>
                          <!-- L1: Tower Header -->
                          <div class="pivot-level-header pivot-l1" data-toggle="section">
                            <div class="flex items-center gap-8">
                              <span class="material-icons-round pivot-chevron" style="font-size:16px">expand_more</span>
                              <span class="material-icons-round" style="font-size:16px; color:var(--md-tertiary)">apartment</span>
                              <span class="body-medium" style="font-weight:600">${tower}</span>
                            </div>
                            <span class="label-medium" style="color:var(--md-on-surface-variant)">${towerTotal}</span>
                          </div>
                          
                          <div class="pivot-children">
                            ${ageKeys.map(age => {
                              const ncs = ages[age];
                              const ncKeys = Object.keys(ncs).sort();
                              const ageTotal = countTreeNodes(ncs);
                              const ageCls = getAgeClass(age);
                              return `
                                <div class="${ageCls}">
                                  <!-- L2: Age Bracket Header -->
                                  <div class="pivot-level-header pivot-l2" data-toggle="section">
                                    <div class="flex items-center gap-8">
                                      <span class="material-icons-round pivot-chevron" style="font-size:14px">expand_more</span>
                                      ${age >= 26 ? '<span class="material-icons-round age-critical-icon">warning</span>' : ''}
                                      <span class="material-icons-round" style="font-size:14px">schedule</span>
                                      <span class="body-small" style="font-weight:700">${age} days</span>
                                    </div>
                                    <span class="label-small">${ageTotal}</span>
                                  </div>
                                  
                                  <div class="pivot-children">
                                    ${ncKeys.map(ncDesc => {
                                      const ids = ncs[ncDesc];
                                      return `
                                        <div>
                                          <!-- L3: NC Description Header -->
                                          <div class="pivot-level-header pivot-l3" data-toggle="section">
                                            <div class="flex items-center gap-8" style="flex:1; min-width:0">
                                              <span class="material-icons-round pivot-chevron" style="font-size:12px">chevron_right</span>
                                              <span class="body-small nc-desc">${ncDesc}</span>
                                            </div>
                                            <span class="label-small" style="flex-shrink:0; margin-left:8px">${ids.length}</span>
                                          </div>
                                          
                                          <div class="pivot-children" style="display:none">
                                            ${ids.map(id => `
                                              <div class="pivot-leaf" data-nc-id="${id}">
                                                <span class="material-icons-round" style="font-size:12px; color:var(--md-outline)">tag</span>
                                                <span class="nc-id-link" style="color:var(--md-primary); cursor:pointer; font-weight:700" title="Double click to view full details">${id}</span>
                                              </div>
                                            `).join('')}
                                          </div>
                                        </div>
                                      `;
                                    }).join('')}
                                  </div>
                                </div>
                              `;
                            }).join('')}
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

    // Bind Back nav trigger
    container.querySelector('#btn-detail-back').addEventListener('click', () => {
      window.location.hash = '#/qsi-dashboard';
    });

    // Bind age filters
    container.querySelectorAll('.qsi-filter-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        ageFilter = btn.dataset.filter;
        drawDetailView();
      });
    });

    // Bind copy/share buttons on Contractor Cards
    container.querySelectorAll('.copy-card-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const card = btn.closest('.pivot-contractor-card');
        const contractorName = card?.querySelector('.title-small')?.textContent?.trim() || 'Contractor';
        if (card) {
          shareElementAsImage(card, `Contractor_${contractorName.replace(/\s+/g, '_')}`);
        }
      });
    });
  }

  // Collapsible accordion triggers using Event Delegation (binds once)
  if (!container._hasDetailListeners) {
    container._hasDetailListeners = true;
    container.addEventListener('click', e => {
      // Ignore clicks on action buttons
      if (e.target.closest('.copy-card-btn') || e.target.closest('.icon-btn')) return;

      const header = e.target.closest('[data-toggle="section"]');
      if (!header || !container.contains(header)) return;

      const children = header.nextElementSibling;
      if (children && children.classList.contains('pivot-children')) {
        const isHidden = children.style.display === 'none';
        children.style.display = isHidden ? '' : 'none';

        const chevron = header.querySelector('.pivot-chevron');
        if (chevron) {
          chevron.style.transform = isHidden ? '' : 'rotate(-90deg)';
          chevron.textContent = isHidden ? 'expand_more' : 'chevron_right';
        }
      }
    });

    // Double-click NC ID to show floating info dialog
    container.addEventListener('dblclick', e => {
      const ncLink = e.target.closest('.nc-id-link');
      if (!ncLink) return;
      const leaf = ncLink.closest('.pivot-leaf');
      const ncId = leaf?.dataset.ncId;
      if (!ncId) return;

      e.stopPropagation();

      const rawData = window.qsiSession.data || [];
      const ncRow = rawData.find(r => String(r["NC ID"] || r["Sr No."]) === String(ncId));
      if (ncRow) {
        showNCDetailWindow(ncRow);
      }
    });
  }

  drawDetailView();
}

// ── NC Details Modal Popup window ──────────────────────────────
function showNCDetailWindow(nc) {
  const overlay = document.createElement('div');
  overlay.className = 'nc-detail-overlay';

  const status = (nc["Status"] || "Unknown").toString().trim();
  const statusLower = status.toLowerCase();
  const statusClass = statusLower === 'approved' ? 'approved' :
                      statusLower === 'added' ? 'added' :
                      statusLower.includes('reject') ? 'rejected' :
                      statusLower.includes('compliance') ? 'compliance' : '';
  const age = nc["Age Of NC(Days)"] || nc["Age"] || 'N/A';
  const severity = (nc["NC Severity Name"] || nc["Severity"] || "Major").toString().trim();
  const severityColor = severity.toLowerCase() === 'fatal' ? '#b71c1c' :
                        severity.toLowerCase() === 'critical' ? '#e65100' :
                        severity.toLowerCase() === 'major' ? '#f57f17' : 'var(--md-on-surface)';

  const field = (label, val) => {
    const cleanVal = val !== null && val !== undefined && String(val).trim() !== '' ? String(val).trim() : '—';
    return `
      <div class="nc-detail-field">
        <div class="nc-detail-label">${label}</div>
        <div class="nc-detail-value">${cleanVal}</div>
      </div>
    `;
  };

  const fieldDesc = (label, val) => {
    const cleanVal = val !== null && val !== undefined && String(val).trim() !== '' ? String(val).trim() : '—';
    return `
      <div class="nc-detail-field">
        <div class="nc-detail-label">${label}</div>
        <div class="nc-detail-value description">${cleanVal}</div>
      </div>
    `;
  };

  // Safe extract of Telegram/Drive HYPERLINK formulae
  const extractPhotoUrl = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    if (!s || s === ' ' || s === '—') return null;
    const match = s.match(/HYPERLINK\("([^"]+)"\)/i);
    if (match && match[1]) return match[1].trim();
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    return null;
  };

  const photos = [
    { label: "NC Photo 1", url: extractPhotoUrl(nc["NC Photo 1"]) },
    { label: "NC Photo 2", url: extractPhotoUrl(nc["NC Photo 2"]) },
    { label: "Compliance Photo 1", url: extractPhotoUrl(nc["Compliance Photo 1"]) },
    { label: "Compliance Photo 2", url: extractPhotoUrl(nc["Compliance Photo 2"]) }
  ].filter(p => p.url);

  overlay.innerHTML = `
    <div class="nc-detail-window">
      <div class="nc-detail-header">
        <div class="flex items-center gap-12">
          <span class="material-icons-round" style="color:var(--md-primary); font-size:28px">description</span>
          <div>
            <div class="title-large" style="font-weight:800">NC #${nc["NC ID"] || nc["Sr No."] || 'N/A'}</div>
            <div class="flex items-center gap-8" style="margin-top:4px">
              <span class="nc-status-badge ${statusClass}">${status}</span>
              <span class="label-medium" style="font-weight:700; color:${severityColor}">${severity}</span>
              <span class="label-medium" style="color:var(--md-on-surface-variant)">${age} days</span>
            </div>
          </div>
        </div>
        <button class="icon-btn" id="btn-nc-close" style="width:36px; height:36px">
          <span class="material-icons-round" style="font-size:22px">close</span>
        </button>
      </div>

      <div class="nc-detail-body">
        <!-- Identity -->
        <div class="nc-detail-group">
          <div class="nc-detail-group-title">Identity</div>
          ${field("NC ID", nc["NC ID"] || nc["Sr No."])}
          ${field("NC Type", nc["NC Type"])}
          ${field("Status", status)}
          ${field("Age (Days)", age)}
          ${field("NC Severity", severity)}
        </div>

        <!-- Location -->
        <div class="nc-detail-group">
          <div class="nc-detail-group-title">Location</div>
          ${field("Project", nc["Project"])}
          ${field("Phase", nc["Phase"])}
          ${field("Tower", nc["Tower"])}
          ${field("Floor", nc["Floor"])}
          ${field("Flat", nc["Flat"])}
        </div>

        <!-- Details -->
        <div class="nc-detail-group">
          <div class="nc-detail-group-title">Details</div>
          ${field("Contractor", nc["Contractor Name"] || nc["Contractor"])}
          ${field("Activity", nc["Activity Name"] || nc["Activity"])}
          ${fieldDesc("NC Description", nc["NC"] || nc["Description"])}
          ${fieldDesc("NC Comments", nc["NC Comments"])}
        </div>

        <!-- Cause & Action -->
        <div class="nc-detail-group">
          <div class="nc-detail-group-title">Cause & Action</div>
          ${field("Nature of Occurrence", nc["Nature Of Occurance"])}
          ${fieldDesc("Root Cause", nc["Root Cause"])}
          ${fieldDesc("Corrective Action", nc["Corrective Action"])}
        </div>

        <!-- People -->
        <div class="nc-detail-group">
          <div class="nc-detail-group-title">People & Dates</div>
          ${field("Created By", nc["NC created By"] || nc["Created By"])}
          ${field("Created On", nc["Created On"])}
          ${field("Updated By", nc["Updated By"])}
          ${field("Updated On", nc["Updated On"])}
          ${field("Tower Incharge", nc["TowerIncharge"])}
        </div>

        <!-- Photos & Links -->
        ${photos.length > 0 ? `
          <div class="nc-detail-group">
            <div class="nc-detail-group-title">Photos & Hyperlinks</div>
            <div style="display:flex; flex-direction:column; gap:8px">
              ${photos.map(p => `
                <div class="flex items-center gap-8">
                  <span class="material-icons-round" style="color:var(--md-primary); font-size:18px">link</span>
                  <a href="${p.url}" target="_blank" style="font-weight:600; font-size:0.9rem">${p.label} (Click to open)</a>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close triggers
  overlay.querySelector('#btn-nc-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  const escHandler = e => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

// ── Modals & Configuration Dialogs UI ────────────────────────

// 1. Month / Year Selector Dialog
function showConfigDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  overlay.innerHTML = `
    <div class="dialog">
      <div class="dialog-title">
        <span>Reporting Period Config</span>
        <button class="icon-btn" id="btn-cfg-close"><span class="material-icons-round">close</span></button>
      </div>
      <div class="dialog-content">
        <p class="body-medium" style="color:var(--md-on-surface-variant)">Select the reporting month (currMON) and year. You can also reconfigure Telegram credentials.</p>
        
        <div class="flex gap-12">
          <div class="form-group" style="flex:1.5">
            <label>Reporting Month</label>
            <select id="sel-cfg-month">
              ${months.map((m, idx) => `<option value="${idx}" ${idx === window.qsiSession.selectedMonth ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="flex:1">
            <label>Year</label>
            <select id="sel-cfg-year">
              ${years.map(y => `<option value="${y}" ${y === window.qsiSession.selectedYear ? 'selected' : ''}>${y}</option>`).join('')}
            </select>
          </div>
        </div>

        <button class="btn btn-outlined w-full" id="btn-cfg-edit-tg" style="margin-top:10px">
          <span class="material-icons-round">settings</span>
          <span>Edit Telegram Credentials</span>
        </button>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-text" id="btn-cfg-cancel">Cancel</button>
        <button class="btn btn-filled" id="btn-cfg-save">Save Period</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#btn-cfg-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#btn-cfg-cancel').addEventListener('click', () => overlay.remove());
  
  overlay.querySelector('#btn-cfg-edit-tg').addEventListener('click', () => {
    overlay.remove();
    showTelegramConfigOverlay();
  });

  overlay.querySelector('#btn-cfg-save').addEventListener('click', () => {
    window.qsiSession.selectedMonth = parseInt(overlay.querySelector('#sel-cfg-month').value, 10);
    window.qsiSession.selectedYear = parseInt(overlay.querySelector('#sel-cfg-year').value, 10);
    
    overlay.remove();
    renderActiveScreen();
    
    // Auto-fetch fresh API data for new period if data already loaded
    if (window.qsiSession.data) {
      triggerPMQHourRefresh();
    }
  });
}

// 2. Telegram Bot Configuration Modal Overlay
function showTelegramConfigOverlay() {
  const overlay = document.getElementById('tg-config-overlay');
  const botTokenInput = document.getElementById('tg-bot-token');
  const chatIdInput = document.getElementById('tg-chat-id');
  const errorMsg = document.getElementById('tg-config-error');

  if (!overlay || !botTokenInput || !chatIdInput) return;

  // Initialize input fields with local storage credentials
  botTokenInput.value = window.qsiSession.tgBotToken;
  chatIdInput.value = window.qsiSession.tgChatId;
  if (errorMsg) errorMsg.classList.add('hidden');

  overlay.classList.remove('hidden');

  const closeOverlay = () => overlay.classList.add('hidden');

  document.getElementById('btn-tg-close').onclick = closeOverlay;
  document.getElementById('btn-tg-cancel').onclick = closeOverlay;

  document.getElementById('btn-tg-save').onclick = () => {
    const token = botTokenInput.value.trim();
    const chat = chatIdInput.value.trim();

    if (!token || !chat) {
      if (errorMsg) {
        errorMsg.textContent = 'Both fields are required to establish connection.';
        errorMsg.classList.remove('hidden');
      }
      return;
    }

    // Save locally
    window.qsiSession.tgBotToken = token;
    window.qsiSession.tgChatId = chat;
    localStorage.setItem('qsi_tg_bot_token', token);
    localStorage.setItem('qsi_tg_chat_id', chat);

    closeOverlay();
    
    // Automatically trigger fetch
    loadFileFromTelegram();
  };
}

// ── Application Initialization ───────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Bind general click triggers
  const configBtn = document.getElementById('btn-config-dialog');
  if (configBtn) configBtn.onclick = showConfigDialog;

  // Hide initial loading screen
  const loader = document.getElementById('initial-loading');
  if (loader) loader.classList.add('hidden');

  // Handle Hash routing
  window.addEventListener('hashchange', renderActiveScreen);
  
  // Set initial status banner
  updateOnlineStatus();

  // Initial draw
  renderActiveScreen();
});

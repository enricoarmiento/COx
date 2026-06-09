// Clinical COx Dashboard Application Logic - Pure Manual & CSV Ingestion

// --- Supabase Config ---
const supabaseUrl = "https://nciaamszrerqtjpvutts.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jaWFhbXN6cmVycXRqcHZ1dHRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzE4NDAsImV4cCI6MjA5NjU0Nzg0MH0.izKqq1xNAtD9UaGFKup21SQKJb-IWnzpqsc2RGGk3xw";
let supabaseClient = null;

try {
    if (typeof supabase !== 'undefined' && supabase.createClient) {
        supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);
    } else if (window.supabase && window.supabase.createClient) {
        supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
    }
} catch (err) {
    console.error("Errore durante l'inizializzazione di Supabase:", err);
}

// --- Patient State ---
let patients = {
    "letto_1": null,
    "letto_2": null,
    "letto_3": null,
    "letto_4": null,
    "letto_5": null,
    "letto_6": null
};
let activeBedId = "letto_1";

// Registration modal temporary state
let selectedRegBedId = null;

// Chart Instances
let chartTimeline = null;
let chartScatter = null;
let chartBins = null;

// --- Initialize App ---
document.addEventListener("DOMContentLoaded", async () => {
    initCharts();
    loadActiveBedIdFromLocalStorage();
    await loadDataFromSupabase();
});

function loadActiveBedIdFromLocalStorage() {
    try {
        const storedActiveBed = localStorage.getItem("cox_clinical_active_bed_v1");
        if (storedActiveBed && ["letto_1", "letto_2", "letto_3", "letto_4", "letto_5", "letto_6"].includes(storedActiveBed)) {
            activeBedId = storedActiveBed;
        } else {
            activeBedId = "letto_1";
        }
    } catch (e) {
        console.error("Errore nel caricamento del letto attivo da LocalStorage:", e);
        activeBedId = "letto_1";
    }
}

async function loadDataFromSupabase() {
    if (!supabaseClient) {
        console.error("Supabase non inizializzato. Uso LocalStorage come fallback.");
        loadFromLocalStorage();
        renderBedsGrid();
        loadActivePatient();
        return;
    }
    
    try {
        // 1. Load local data first to merge it
        loadFromLocalStorage();
        
        // 2. Query Supabase beds
        const { data: bedsData, error: bedsError } = await supabaseClient
            .from('beds')
            .select('id, patient_name, patient_surname')
            .order('id');
            
        if (bedsError) throw bedsError;
        
        const defaultBeds = ['letto_1', 'letto_2', 'letto_3', 'letto_4', 'letto_5', 'letto_6'];
        
        if (!bedsData || bedsData.length === 0) {
            // DB is completely unseeded. Let's seed beds and upload local data.
            console.log("Database beds table is empty. Seeding beds and migrating local data...");
            
            const bedsPayload = defaultBeds.map(id => {
                const localPat = patients[id];
                return {
                    id: id,
                    patient_name: localPat ? localPat.name : null,
                    patient_surname: localPat ? localPat.surname : null
                };
            });
            
            const { error: seedError } = await supabaseClient
                .from('beds')
                .insert(bedsPayload);
                
            if (seedError) throw seedError;
            
            // Upload local measurements
            for (const id of defaultBeds) {
                const localPat = patients[id];
                if (localPat && localPat.averages10s && localPat.averages10s.length > 0) {
                    const measPayload = localPat.averages10s.map(m => ({
                        bed_id: id,
                        map: m.MAP,
                        scto2: m.SctO2,
                        cox: m.COx,
                        timestamp_s: m.timestampS
                    }));
                    
                    const { error: measErr } = await supabaseClient
                        .from('measurements')
                        .insert(measPayload);
                        
                    if (measErr) {
                        console.error(`Errore nella migrazione delle misure per ${id}:`, measErr);
                    }
                }
            }
        } else {
            // DB has beds. Let's merge local data with DB.
            console.log("Database beds table is initialized. Merging local data with DB...");
            
            // Map DB beds by ID for easy lookup
            const dbBedsMap = {};
            bedsData.forEach(b => {
                dbBedsMap[b.id] = b;
            });
            
            for (const id of defaultBeds) {
                const dbBed = dbBedsMap[id];
                const localPat = patients[id];
                
                if (dbBed) {
                    if (dbBed.patient_name || dbBed.patient_surname) {
                        // DB is the source of truth if it has a patient
                        patients[id] = {
                            name: dbBed.patient_name || "",
                            surname: dbBed.patient_surname || "",
                            averages10s: [] // Will load measurements below if it's activeBedId
                        };
                    } else if (localPat) {
                        // DB has NO patient, but local has patient. Let's upload to DB!
                        console.log(`Uploading local patient for ${id} to Supabase...`);
                        const { error: updErr } = await supabaseClient
                            .from('beds')
                            .update({ patient_name: localPat.name, patient_surname: localPat.surname })
                            .eq('id', id);
                            
                        if (updErr) throw updErr;
                            
                        // Also upload their local measurements
                        if (localPat.averages10s && localPat.averages10s.length > 0) {
                            const measPayload = localPat.averages10s.map(m => ({
                                bed_id: id,
                                map: m.MAP,
                                scto2: m.SctO2,
                                cox: m.COx,
                                timestamp_s: m.timestampS
                            }));
                            const { error: measErr } = await supabaseClient
                                .from('measurements')
                                .insert(measPayload);
                            if (measErr) {
                                console.error(`Errore nella migrazione delle misure per ${id}:`, measErr);
                            }
                        }
                    } else {
                        patients[id] = null;
                    }
                } else {
                    // Bed row missing from DB? Let's upsert it
                    const { error: upsErr } = await supabaseClient
                        .from('beds')
                        .upsert({
                            id: id,
                            patient_name: localPat ? localPat.name : null,
                            patient_surname: localPat ? localPat.surname : null
                        });
                    if (upsErr) throw upsErr;
                }
            }
        }
        
        // 5. Load measurements for the active bed if it has a patient
        if (patients[activeBedId] !== null) {
            const { data: measData, error: measError } = await supabaseClient
                .from('measurements')
                .select('map, scto2, cox, timestamp_s')
                .eq('bed_id', activeBedId)
                .order('timestamp_s', { ascending: true });
                
            if (measError) throw measError;
            
            if (measData) {
                patients[activeBedId].averages10s = measData.map(m => ({
                    MAP: m.map,
                    SctO2: m.scto2,
                    COx: m.cox,
                    timestampS: m.timestamp_s
                }));
            }
        }
        
        // Sync local storage with merged database state
        saveToLocalStorage();
        renderBedsGrid();
        loadActivePatient();
    } catch (e) {
        console.error("Errore durante il caricamento da Supabase:", e);
        loadFromLocalStorage();
        renderBedsGrid();
        loadActivePatient();
    }
}

async function loadActiveBedMeasurements() {
    if (!supabaseClient || patients[activeBedId] === null) return;
    try {
        const { data: measData, error } = await supabaseClient
            .from('measurements')
            .select('map, scto2, cox, timestamp_s')
            .eq('bed_id', activeBedId)
            .order('timestamp_s', { ascending: true });
            
        if (error) throw error;
        
        if (measData) {
            patients[activeBedId].averages10s = measData.map(m => ({
                MAP: m.map,
                SctO2: m.scto2,
                COx: m.cox,
                timestampS: m.timestamp_s
            }));
        }
    } catch (e) {
        console.error("Errore nel caricamento delle misurazioni del letto attivo:", e);
    }
}

// --- LocalStorage Persistence ---
function saveToLocalStorage() {
    try {
        localStorage.setItem("cox_clinical_patients_v1", JSON.stringify(patients));
        localStorage.setItem("cox_clinical_active_bed_v1", activeBedId);
    } catch (e) {
        console.error("Errore durante il salvataggio in LocalStorage:", e);
    }
}

function loadFromLocalStorage() {
    try {
        const storedPatients = localStorage.getItem("cox_clinical_patients_v1");
        const storedActiveBed = localStorage.getItem("cox_clinical_active_bed_v1");
        
        if (storedPatients) {
            patients = JSON.parse(storedPatients);
        } else {
            // Keep all beds empty (null) initially for real clinical use
            patients = {
                "letto_1": null,
                "letto_2": null,
                "letto_3": null,
                "letto_4": null,
                "letto_5": null,
                "letto_6": null
            };
        }
        
        if (storedActiveBed && patients[storedActiveBed] !== undefined) {
            activeBedId = storedActiveBed;
        } else {
            activeBedId = "letto_1";
        }
    } catch (e) {
        console.error("Errore durante il caricamento da LocalStorage:", e);
    }
}

// --- Mathematical Helper: Pearson Correlation ---
function pearsonCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return null;
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += x[i];
        sumY += y[i];
        sumXY += x[i] * y[i];
        sumX2 += x[i] * x[i];
        sumY2 += y[i] * y[i];
    }
    
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    
    if (den < 1e-9) return null; // undefined correlation due to lack of signal variance
    return num / den;
}

// Recalculates rolling COx for the entire dataset of a patient
function calculateAllCOx(patient) {
    const data = patient.averages10s;
    const len = data.length;
    const minCorrelationPoints = 5; // Minimum points to calculate correlation
    
    for (let i = 0; i < len; i++) {
        if (i >= minCorrelationPoints - 1) {
            // Dynamic window size from minCorrelationPoints up to 30
            const currentWindow = Math.min(30, i + 1);
            const windowData = data.slice(i - currentWindow + 1, i + 1);
            const maps = windowData.map(d => d.MAP);
            const scto2s = windowData.map(d => d.SctO2);
            data[i].COx = pearsonCorrelation(maps, scto2s);
        } else {
            data[i].COx = null;
        }
    }
}

// Calculates rolling COx index for the latest point in averages10s
function calculateCOxForLastPointOfPatient(patient) {
    const len = patient.averages10s.length;
    const data = patient.averages10s;
    const newAverage = data[len - 1];
    const minCorrelationPoints = 5;
    
    if (len >= minCorrelationPoints) {
        const windowSize = Math.min(30, len);
        const windowData = data.slice(len - windowSize);
        const maps = windowData.map(d => d.MAP);
        const scto2s = windowData.map(d => d.SctO2);
        newAverage.COx = pearsonCorrelation(maps, scto2s);
    } else {
        newAverage.COx = null;
    }
}

// Recalculates MAP bins and identifies optimal MAP
function recalculateOptimalMAPForPatient(patient) {
    const data = patient.averages10s;
    const validEpochs = data.filter(d => d.COx !== null);
    const totalValid = validEpochs.length;
    
    if (totalValid === 0) {
        patient.optimalBin = null;
        patient.optimalMAP = null;
        if (patient === patients[activeBedId]) {
            optimalBin = null;
            optimalMAP = null;
            window.currentBinSummary = null;
        }
        return;
    }
    
    // Define bins from 50 to 130 in steps of 5 mmHg
    const binSize = 5;
    const bins = {};
    for (let start = 50; start < 130; start += binSize) {
        const end = start + binSize;
        bins[`${start}-${end}`] = { sumCOx: 0, count: 0, start, end };
    }
    
    validEpochs.forEach(epoch => {
        const map = epoch.MAP;
        for (const key in bins) {
            const b = bins[key];
            if (map >= b.start && map < b.end) {
                b.sumCOx += epoch.COx;
                b.count++;
                break;
            }
        }
    });
    
    let bestBinKey = null;
    let minAvgCOx = Infinity;
    const binSummary = [];
    
    for (const key in bins) {
        const b = bins[key];
        const percentage = (b.count / totalValid) * 100;
        const avgCOx = b.count > 0 ? b.sumCOx / b.count : null;
        
        binSummary.push({
            key,
            avgCOx,
            percentage,
            count: b.count,
            start: b.start,
            end: b.end
        });
        
        // Exclude bins with < 1% data
        if (percentage >= 1.0 && avgCOx !== null) {
            if (avgCOx < minAvgCOx) {
                minAvgCOx = avgCOx;
                bestBinKey = key;
            }
        }
    }
    
    // Fallback if no bin satisfies 1% data filter
    if (bestBinKey === null) {
        let maxCount = -1;
        for (const item of binSummary) {
            if (item.count > maxCount && item.avgCOx !== null) {
                maxCount = item.count;
                bestBinKey = item.key;
            }
        }
    }
    
    if (bestBinKey !== null) {
        const bestBin = bins[bestBinKey];
        patient.optimalBin = bestBinKey;
        patient.optimalMAP = (bestBin.start + bestBin.end) / 2.0;
    } else {
        patient.optimalBin = null;
        patient.optimalMAP = null;
    }
    
    // Sync globals if this patient is currently active
    if (patient === patients[activeBedId]) {
        optimalBin = patient.optimalBin;
        optimalMAP = patient.optimalMAP;
        window.currentBinSummary = binSummary;
    }
}

// --- Bed Navigation & Grid Renderer ---
function renderBedsGrid() {
    // 1. Desktop sidebar container
    const container = document.getElementById("beds-grid-container");
    if (container) {
        container.innerHTML = "";
    }
    
    // 2. Mobile horizontal row container
    const mobileContainer = document.getElementById("mobile-beds-switcher");
    if (mobileContainer) {
        mobileContainer.innerHTML = "";
    }
    
    // 3. Topbar Patient Dropdown List container
    const dropdownContainer = document.getElementById("patient-dropdown-list");
    if (dropdownContainer) {
        dropdownContainer.innerHTML = "";
    }
    
    const handleKeyPress = (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.target.click();
        }
    };
    
    Object.keys(patients).forEach((bedId, index) => {
        const p = patients[bedId];
        const num = index + 1;
        
        // Render desktop button
        if (container) {
            const btn = document.createElement("div");
            btn.className = `bed-button`;
            btn.setAttribute("role", "button");
            btn.setAttribute("tabindex", "0");
            if (p !== null) {
                btn.classList.add("occupied");
            }
            if (bedId === activeBedId) {
                btn.classList.add("selected");
            }
            btn.onclick = () => selectBed(bedId);
            btn.onkeydown = handleKeyPress;
            
            let bedHtml = `
                <span class="bed-icon">${p !== null ? '🛌' : '🛏️'}</span>
                <span class="bed-label">Letto ${num}</span>
            `;
            if (p !== null) {
                bedHtml += `
                    <span class="bed-status">${p.name} ${p.surname}</span>
                    <span class="bed-delete-btn" onclick="event.stopPropagation(); deletePatient('${bedId}')" title="Dimetti Paziente">✕</span>
                `;
            } else {
                bedHtml += `<span class="bed-status">Libero</span>`;
            }
            
            btn.innerHTML = bedHtml;
            container.appendChild(btn);
        }
        
        // Render mobile pill button
        if (mobileContainer) {
            const mobBtn = document.createElement("div");
            mobBtn.className = `mobile-bed-btn`;
            mobBtn.setAttribute("role", "button");
            mobBtn.setAttribute("tabindex", "0");
            if (p !== null) {
                mobBtn.classList.add("occupied");
            }
            if (bedId === activeBedId) {
                mobBtn.classList.add("selected");
            }
            mobBtn.onclick = () => selectBed(bedId);
            mobBtn.onkeydown = handleKeyPress;
            
            let mobHtml = `
                <span class="mob-bed-icon">${p !== null ? '🛌' : '🛏️'}</span>
                <span class="mob-bed-num">Letto ${num}</span>
                <span class="mob-bed-status">${p !== null ? p.name : 'Libero'}</span>
            `;
            if (p !== null) {
                mobHtml += `
                    <span class="mobile-bed-delete-btn" onclick="event.stopPropagation(); deletePatient('${bedId}')" title="Dimetti Paziente">✕</span>
                `;
            }
            
            mobBtn.innerHTML = mobHtml;
            mobileContainer.appendChild(mobBtn);
        }
        
        // Render dropdown item
        if (dropdownContainer) {
            const dropBtn = document.createElement("div");
            dropBtn.className = `patient-dropdown-item`;
            dropBtn.setAttribute("role", "button");
            dropBtn.setAttribute("tabindex", "0");
            if (bedId === activeBedId) {
                dropBtn.classList.add("active");
            }
            dropBtn.onclick = (e) => {
                e.stopPropagation();
                selectBed(bedId);
                closePatientDropdown();
            };
            dropBtn.onkeydown = handleKeyPress;
            
            let dropHtml = `
                <span class="drop-bed-num">Letto ${num}</span>
                <span class="drop-patient-name">${p !== null ? `${p.name} ${p.surname}` : 'Libero'}</span>
            `;
            if (p !== null) {
                dropHtml += `
                    <span class="drop-delete-btn" onclick="event.stopPropagation(); deletePatient('${bedId}')" title="Dimetti Paziente">🗑️</span>
                `;
            } else {
                dropHtml += `
                    <span class="drop-status-dot"></span>
                `;
            }
            
            dropBtn.innerHTML = dropHtml;
            dropdownContainer.appendChild(dropBtn);
        }
    });
}

async function selectBed(bedId) {
    const patient = patients[bedId];
    if (patient === null) {
        openRegistrationModal(bedId);
    } else {
        activeBedId = bedId;
        try {
            localStorage.setItem("cox_clinical_active_bed_v1", activeBedId);
        } catch (e) {}
        
        await loadActiveBedMeasurements();
        renderBedsGrid();
        loadActivePatient();
        closeSidebar();
    }
}

function loadActivePatient() {
    const p = patients[activeBedId];
    const headerBed = document.getElementById("header-bed-num");
    const headerName = document.getElementById("header-patient-name");
    const statusBadge = document.getElementById("status-badge");
    const recordCountLabel = document.getElementById("record-count-label");
    
    const quickActionsContainer = document.getElementById("mobile-quick-actions");
    const fileActionsContainer = document.getElementById("mobile-file-actions");
    
    if (p === null) {
        headerBed.textContent = activeBedId.replace("letto_", "");
        headerName.textContent = "Nessun Paziente";
        
        statusBadge.textContent = "Letto Libero";
        statusBadge.className = "status-badge paused";
        recordCountLabel.textContent = "Misure: 0";
        
        updateMetricsUI(0, 0, true);
        clearCharts();
        
        // Mobile layout updates
        if (quickActionsContainer) {
            quickActionsContainer.innerHTML = `
                <div class="mobile-empty-state">
                    <p>Letto ${activeBedId.replace("letto_", "")} è attualmente libero.</p>
                    <button class="btn-primary" onclick="openRegistrationModal('${activeBedId}')" style="width: 100%; max-width: 300px;">
                        <span>＋</span> Registra Paziente
                    </button>
                </div>
            `;
        }
        if (fileActionsContainer) {
            fileActionsContainer.style.display = "none";
        }
    } else {
        headerBed.textContent = activeBedId.replace("letto_", "");
        headerName.textContent = `${p.name} ${p.surname}`;
        
        statusBadge.textContent = "Paziente Reale";
        statusBadge.className = "status-badge";
        
        const count = p.averages10s.length;
        recordCountLabel.textContent = `Misure: ${count}`;
        
        recalculateOptimalMAPForPatient(p);
        
        if (count > 0) {
            const last = p.averages10s[count - 1];
            updateMetricsUI(last.MAP, last.SctO2);
        } else {
            updateMetricsUI(0, 0, true);
        }
        updateChartsData();
        
        // Mobile layout updates
        if (quickActionsContainer) {
            quickActionsContainer.innerHTML = `
                <div class="mobile-ingestion-form">
                    <h4>Inserimento Rapido Letto ${activeBedId.replace("letto_", "")}</h4>
                    <div class="manual-input-row">
                        <input type="number" id="input-map-mobile" class="text-input" placeholder="MAP" min="30" max="180" style="flex: 1; width: auto;">
                        <input type="number" id="input-scto2-mobile" class="text-input" placeholder="SctO2" min="10" max="100" style="flex: 1; width: auto;">
                    </div>
                    <button class="btn-primary" onclick="addManualMeasurement(true)" style="margin-top: 0.5rem; width: 100%;">Aggiungi Misura</button>
                </div>
            `;
        }
        if (fileActionsContainer) {
            fileActionsContainer.style.display = "flex";
            fileActionsContainer.innerHTML = `
                <div class="mobile-csv-row" style="justify-content: center;">
                    <button class="btn-danger btn-sm" onclick="clearManualData()" style="width: 100%; max-width: 300px;">🗑️ Svuota Dati</button>
                </div>
            `;
        }
    }
}

// --- Patient Registration Modal ---
function openRegistrationModal(bedId) {
    selectedRegBedId = bedId;
    const bedNum = bedId.replace("letto_", "");
    document.getElementById("register-modal-bed-label").textContent = `Letto ospedaliero numero ${bedNum}`;
    document.getElementById("reg-name").value = "";
    document.getElementById("reg-surname").value = "";
    
    document.getElementById("register-modal").style.display = "flex";
}

function closeRegistrationModal() {
    document.getElementById("register-modal").style.display = "none";
    selectedRegBedId = null;
}

async function submitPatientRegistration() {
    const name = document.getElementById("reg-name").value.trim();
    const surname = document.getElementById("reg-surname").value.trim();
    
    if (name === "" || surname === "") {
        alert("Inserisci sia il nome che il cognome del paziente.");
        return;
    }
    
    patients[selectedRegBedId] = {
        name: name,
        surname: surname,
        averages10s: []
    };
    
    activeBedId = selectedRegBedId;
    try {
        localStorage.setItem("cox_clinical_active_bed_v1", activeBedId);
    } catch (e) {}
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('beds')
                .upsert({
                    id: selectedRegBedId,
                    patient_name: name,
                    patient_surname: surname
                });
            if (error) throw error;
        } catch (e) {
            console.error("Errore nel salvataggio del paziente su Supabase:", e);
        }
    }
    saveToLocalStorage();
    
    renderBedsGrid();
    closeRegistrationModal();
    loadActivePatient();
    closeSidebar();
}

async function deletePatient(bedId) {
    const p = patients[bedId];
    if (p === null) return;
    
    const confirmDischarge = confirm(`Vuoi dimettere il paziente ${p.name} ${p.surname} dal Letto ${bedId.replace("letto_", "")}? Tutti i suoi dati verranno eliminati.`);
    if (confirmDischarge) {
        patients[bedId] = null;
        
        if (supabaseClient) {
            try {
                const { error: bedError } = await supabaseClient
                    .from('beds')
                    .update({ patient_name: null, patient_surname: null })
                    .eq('id', bedId);
                if (bedError) throw bedError;
                
                const { error: measError } = await supabaseClient
                    .from('measurements')
                    .delete()
                    .eq('bed_id', bedId);
                if (measError) throw measError;
            } catch (e) {
                console.error("Errore durante la dimissione da Supabase:", e);
            }
        }
        saveToLocalStorage();
        
        renderBedsGrid();
        loadActivePatient();
    }
}

// --- Manual Ingestion ---
async function addManualMeasurement(isMobile = false) {
    const p = patients[activeBedId];
    if (p === null) {
        alert("Nessun paziente registrato in questo letto. Registrane uno prima di inserire dati.");
        return;
    }
    
    const suffix = isMobile ? "-mobile" : "";
    const inputMap = document.getElementById("input-map" + suffix);
    const inputScto2 = document.getElementById("input-scto2" + suffix);
    const mapVal = parseFloat(inputMap.value);
    const scto2Val = parseFloat(inputScto2.value);
    
    if (isNaN(mapVal) || isNaN(scto2Val)) {
        alert("Inserisci valori numerici validi.");
        return;
    }
    
    if (mapVal < 30 || mapVal > 180 || scto2Val < 10 || scto2Val > 100) {
        alert("Valori fuori scala biologica. Inserisci MAP tra 30-180 mmHg e SctO2 tra 10-100%.");
        return;
    }
    
    const nextIndex = p.averages10s.length + 1;
    const newAverage = {
        MAP: mapVal,
        SctO2: scto2Val,
        COx: null,
        timestampS: nextIndex
    };
    
    p.averages10s.push(newAverage);
    calculateCOxForLastPointOfPatient(p);
    recalculateOptimalMAPForPatient(p);
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('measurements')
                .insert({
                    bed_id: activeBedId,
                    map: mapVal,
                    scto2: scto2Val,
                    cox: newAverage.COx,
                    timestamp_s: nextIndex
                });
            if (error) throw error;
        } catch (e) {
            console.error("Errore nel salvataggio della misura su Supabase:", e);
        }
    }
    saveToLocalStorage();
    
    document.getElementById("record-count-label").textContent = `Misure: ${p.averages10s.length}`;
    
    updateMetricsUI(mapVal, scto2Val);
    updateChartsData();
    
    inputMap.value = "";
    inputScto2.value = "";
}

async function clearManualData() {
    const p = patients[activeBedId];
    if (p === null) return;
    
    const confirmClear = confirm(`Vuoi cancellare tutte le misurazioni del paziente ${p.name} ${p.surname}?`);
    if (confirmClear) {
        p.averages10s = [];
        
        if (supabaseClient) {
            try {
                const { error } = await supabaseClient
                    .from('measurements')
                    .delete()
                    .eq('bed_id', activeBedId);
                if (error) throw error;
            } catch (e) {
                console.error("Errore nella cancellazione dei dati su Supabase:", e);
            }
        }
        saveToLocalStorage();
        
        loadActivePatient();
    }
}

// --- CSV Import/Export ---
function importCSVFile(event) {
    const p = patients[activeBedId];
    if (p === null) {
        alert("Nessun paziente registrato in questo letto. Registrane uno prima di importare dati.");
        return;
    }
    
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        parseAndLoadCSV(text);
    };
    reader.readAsText(file);
    event.target.value = "";
}

function parseAndLoadCSV(text) {
    const p = patients[activeBedId];
    if (p === null) return;
    
    const lines = text.split(/\r?\n/);
    if (lines.length <= 1) {
        alert("Il file CSV sembra vuoto.");
        return;
    }
    
    const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
    const mapIndex = headers.indexOf("MAP");
    const scto2Index = headers.indexOf("SCTO2");
    
    if (mapIndex === -1 || scto2Index === -1) {
        alert("Intestazioni non trovate. Il CSV deve contenere le colonne 'MAP' e 'SctO2'.");
        return;
    }
    
    const rawPoints = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        
        const cols = line.split(',');
        const mapVal = parseFloat(cols[mapIndex]);
        const scto2Val = parseFloat(cols[scto2Index]);
        
        if (!isNaN(mapVal) && !isNaN(scto2Val)) {
            rawPoints.push({ MAP: mapVal, SctO2: scto2Val });
        }
    }
    
    if (rawPoints.length === 0) {
        alert("Nessun dato valido trovato nel CSV.");
        return;
    }
    
    // Reset existing patient data
    p.averages10s = [];
    
    // Check if the data is high-frequency and ask the user if they want to downsample
    if (rawPoints.length > 2000) {
        const confirmDownsample = confirm(
            `Il file caricato contiene ${rawPoints.length} righe.\n` +
            `Sembra essere un tracciato ad alta frequenza (es. ogni 2 secondi).\n\n` +
            `Vuoi effettuare il downsampling automatico a medie di 10 secondi (raggruppando ogni 5 punti) per calcolare correttamente il COx ed evitare rallentamenti dei grafici?`
        );
        if (confirmDownsample) {
            let counter = 0;
            for (let i = 0; i < rawPoints.length; i += 5) {
                const chunk = rawPoints.slice(i, i + 5);
                const avgMAP = chunk.reduce((sum, pt) => sum + pt.MAP, 0) / chunk.length;
                const avgSctO2 = chunk.reduce((sum, pt) => sum + pt.SctO2, 0) / chunk.length;
                counter++;
                p.averages10s.push({
                    MAP: avgMAP,
                    SctO2: avgSctO2,
                    COx: null,
                    timestampS: counter
                });
            }
        } else {
            // Load raw data directly
            rawPoints.forEach((pt, index) => {
                p.averages10s.push({
                    MAP: pt.MAP,
                    SctO2: pt.SctO2,
                    COx: null,
                    timestampS: index + 1
                });
            });
        }
    } else {
        // Load normally
        rawPoints.forEach((pt, index) => {
            p.averages10s.push({
                MAP: pt.MAP,
                SctO2: pt.SctO2,
                COx: null,
                timestampS: index + 1
            });
        });
    }
    
    // Recalculate rolling COx dynamically across the imported dataset
    calculateAllCOx(p);
    recalculateOptimalMAPForPatient(p);
    
    saveToLocalStorage();
    loadActivePatient();
    
    alert(`Caricate ${p.averages10s.length} misurazioni per il paziente ${p.name} ${p.surname}.`);
}

function exportCSVFile() {
    const p = patients[activeBedId];
    if (p === null || p.averages10s.length === 0) {
        alert("Nessun dato da esportare.");
        return;
    }
    
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "MAP,SctO2,COx,Index\n";
    
    p.averages10s.forEach(row => {
        const map = row.MAP.toFixed(2);
        const scto2 = row.SctO2.toFixed(2);
        const cox = row.COx !== null ? row.COx.toFixed(4) : "";
        const time = row.timestampS;
        csvContent += `${map},${scto2},${cox},${time}\n`;
    });
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `dati_cox_letto_${activeBedId.replace("letto_", "")}_${p.surname}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- Chart.js Initialization ---
function initCharts() {
    const ctxTimeline = document.getElementById("chart-timeline").getContext("2d");
    chartTimeline = new Chart(ctxTimeline, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'MAP (mmHg)',
                    data: [],
                    borderColor: '#0284c7',
                    backgroundColor: 'rgba(2, 132, 199, 0.1)',
                    borderWidth: 2,
                    yAxisID: 'yMAP',
                    pointRadius: 3
                },
                {
                    label: 'SctO2 (%)',
                    data: [],
                    borderColor: '#7c3aed',
                    backgroundColor: 'rgba(124, 58, 237, 0.05)',
                    borderWidth: 2,
                    yAxisID: 'ySctO2',
                    pointRadius: 3
                },
                {
                    label: 'MAP Ottimale (mmHg)',
                    data: [],
                    borderColor: '#059669',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    yAxisID: 'yMAP',
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: {
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#64748b' }
                },
                yMAP: {
                    type: 'linear',
                    position: 'left',
                    min: 40,
                    max: 130,
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#0284c7' },
                    title: { display: true, text: 'MAP (mmHg)', color: '#0284c7', font: { weight: 'bold' } }
                },
                ySctO2: {
                    type: 'linear',
                    position: 'right',
                    min: 30,
                    max: 95,
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#7c3aed' },
                    title: { display: true, text: 'SctO2 (%)', color: '#7c3aed', font: { weight: 'bold' } }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });

    const ctxScatter = document.getElementById("chart-scatter").getContext("2d");
    chartScatter = new Chart(ctxScatter, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Misurazioni',
                    data: [],
                    backgroundColor: 'rgba(71, 85, 105, 0.25)',
                    pointRadius: 4
                },
                {
                    label: 'Trend Autoregolativo',
                    data: [],
                    borderColor: '#dc2626',
                    borderWidth: 2,
                    type: 'line',
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: {
                    min: 45,
                    max: 125,
                    title: { display: true, text: 'MAP (mmHg)', color: '#475569' },
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#64748b' }
                },
                y: {
                    min: 35,
                    max: 95,
                    title: { display: true, text: 'SctO2 (%)', color: '#475569' },
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#64748b' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });

    const ctxBins = document.getElementById("chart-bins").getContext("2d");
    chartBins = new Chart(ctxBins, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: [],
                borderColor: 'rgba(15, 23, 42, 0.8)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: {
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#64748b', rotation: 30 }
                },
                y: {
                    min: -0.4,
                    max: 0.8,
                    title: { display: true, text: 'COx Medio', color: '#475569' },
                    grid: { color: 'rgba(148, 163, 184, 0.12)' },
                    ticks: { color: '#64748b' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

// --- Metrics & Charts Updates ---
function updateMetricsUI(map, scto2, forceEmpty = false) {
    const p = patients[activeBedId];
    if (p === null || forceEmpty) {
        document.getElementById("metric-map").textContent = "--";
        document.getElementById("metric-scto2").textContent = "--";
        document.getElementById("metric-cox").textContent = "--";
        document.getElementById("metric-cox-desc").textContent = "Nessun dato.";
        document.getElementById("metric-optmap").textContent = "--";
        document.getElementById("metric-timeunder").textContent = "--";
        return;
    }
    
    document.getElementById("metric-map").textContent = map.toFixed(1);
    document.getElementById("metric-scto2").textContent = scto2.toFixed(1);
    
    const count = p.averages10s.length;
    const lastAverage = p.averages10s[count - 1];
    
    if (lastAverage && lastAverage.COx !== null) {
        const cox = lastAverage.COx;
        const coxCard = document.getElementById("metric-cox");
        coxCard.textContent = cox.toFixed(3);
        
        const desc = document.getElementById("metric-cox-desc");
        if (cox < 0.1) {
            coxCard.className = "card-value text-green";
            desc.innerHTML = "<span style='color: #059669;'>● Autoregolazione Attiva</span>";
        } else {
            coxCard.className = "card-value text-red";
            desc.innerHTML = "<span style='color: #dc2626;'>▲ Relazione Passiva</span>";
        }
    } else {
        document.getElementById("metric-cox").textContent = "Calcolo...";
        document.getElementById("metric-cox-desc").textContent = `Inseriti ${count}/5 punti...`;
    }
    
    const optMapCard = document.getElementById("metric-optmap");
    if (p.optimalMAP !== null) {
        optMapCard.textContent = `${p.optimalMAP.toFixed(0)} ± 2.5`;
    } else {
        optMapCard.textContent = "Calcolo...";
    }
    
    const timeUnderCard = document.getElementById("metric-timeunder");
    if (p.optimalMAP !== null) {
        const totalEpochs = p.averages10s.length;
        const underCount = p.averages10s.filter(d => d.MAP < p.optimalMAP).length;
        const pct = (underCount / totalEpochs) * 100;
        timeUnderCard.textContent = `${pct.toFixed(1)}%`;
    } else {
        timeUnderCard.textContent = "--";
    }
}

function updateChartsData() {
    const p = patients[activeBedId];
    if (p === null) {
        clearCharts();
        return;
    }
    
    // 1. Timeline Chart (Last 50 points)
    const displayWindow = p.averages10s.slice(-50);
    const timelineLabels = displayWindow.map(d => `Misura ${d.timestampS}`);
    
    const maps = displayWindow.map(d => d.MAP);
    const scto2s = displayWindow.map(d => d.SctO2);
    const optLines = displayWindow.map(() => p.optimalMAP);
    
    chartTimeline.data.labels = timelineLabels;
    chartTimeline.data.datasets[0].data = maps;
    chartTimeline.data.datasets[1].data = scto2s;
    chartTimeline.data.datasets[2].data = optLines;
    chartTimeline.update();
    
    // 2. Scatter Plot (Last 1000 points)
    const scatterWindow = p.averages10s.slice(-1000);
    const scatterPoints = scatterWindow.map(d => ({ x: d.MAP, y: d.SctO2 }));
    chartScatter.data.datasets[0].data = scatterPoints;
    
    if (scatterPoints.length > 5) {
        const xs = scatterPoints.map(p => p.x);
        const ys = scatterPoints.map(p => p.y);
        
        let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
        const count = scatterPoints.length;
        for (let i = 0; i < count; i++) {
            sumX += xs[i];
            sumY += ys[i];
            sumXX += xs[i] * xs[i];
            sumXY += xs[i] * ys[i];
        }
        
        const m = (count * sumXY - sumX * sumY) / (count * sumXX - sumX * sumX);
        const q = (sumY - m * sumX) / count;
        
        const minX = 45;
        const maxX = 125;
        const minY = m * minX + q;
        const maxY = m * maxX + q;
        
        chartScatter.data.datasets[1].data = [
            { x: minX, y: minY },
            { x: maxX, y: maxY }
        ];
    } else {
        chartScatter.data.datasets[1].data = [];
    }
    chartScatter.update();
    
    // 3. Bin Chart (Bar)
    if (window.currentBinSummary) {
        const labels = [];
        const data = [];
        const bgColors = [];
        
        window.currentBinSummary.forEach(item => {
            labels.push(item.key);
            data.push(item.avgCOx !== null ? item.avgCOx : 0);
            
            if (item.key === p.optimalBin) {
                bgColors.push('#059669'); // Optimal MAP bin (Green)
            } else if (item.percentage < 1.0) {
                bgColors.push('rgba(148, 163, 184, 0.2)'); // Excluded bins (<1% data)
            } else if (item.avgCOx !== null && item.avgCOx < 0.1) {
                bgColors.push('#0284c7'); // Active zone (blue)
            } else {
                bgColors.push('#dc2626'); // Passive zone (red)
            }
        });
        
        chartBins.data.labels = labels;
        chartBins.data.datasets[0].data = data;
        chartBins.data.datasets[0].backgroundColor = bgColors;
        chartBins.update();
    }
}

function clearCharts() {
    if (chartTimeline && chartScatter && chartBins) {
        chartTimeline.data.labels = [];
        chartTimeline.data.datasets[0].data = [];
        chartTimeline.data.datasets[1].data = [];
        chartTimeline.data.datasets[2].data = [];
        chartTimeline.update();
        
        chartScatter.data.datasets[0].data = [];
        chartScatter.data.datasets[1].data = [];
        chartScatter.update();
        
        chartBins.data.labels = [];
        chartBins.data.datasets[0].data = [];
        chartBins.update();
    }
}

// --- Dynamic Scientific Accordion ---
function toggleInfoPanel() {
    const content = document.getElementById("info-panel-content");
    const icon = document.getElementById("info-toggle-icon");
    if (content.style.display === "none") {
        content.style.display = "block";
        icon.textContent = "▲ Comprimi";
    } else {
        content.style.display = "none";
        icon.textContent = "▼ Espandi";
    }
}

// --- Mobile Sidebar Helper Functions ---
function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");
    if (sidebar && backdrop) {
        sidebar.classList.toggle("open");
        backdrop.classList.toggle("active");
    }
}

function closeSidebar() {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");
    if (sidebar && backdrop) {
        sidebar.classList.remove("open");
        backdrop.classList.remove("active");
    }
}

// --- Patient Dropdown Helper Functions ---
function togglePatientDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById("patient-dropdown-list");
    if (dropdown) {
        dropdown.classList.toggle("show");
    }
}

function closePatientDropdown() {
    const dropdown = document.getElementById("patient-dropdown-list");
    if (dropdown) {
        dropdown.classList.remove("show");
    }
}

// Close dropdown when clicking anywhere on document
document.addEventListener("click", () => {
    closePatientDropdown();
});
